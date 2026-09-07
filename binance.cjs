'use strict';
// Binance USDM futures data layer - this scanner's ONLY source of market
// data, mirroring gate.cjs's exact exported interface so scanner.cjs needed
// no restructuring, just a different require.
//
// No liquidation feed exists on Binance anymore (confirmed directly, not
// assumed: /fapi/v1/allForceOrders now 404s; /fapi/v1/forceOrders is
// account-scoped only, useless for a market-wide signal). This scanner's
// tier rules were re-measured from scratch on Binance's own 30 days of OI +
// taker + price data (dump-study.cjs) rather than assuming Gate's
// liquidation-based rules transfer - see score.cjs for the numbers.

const F = 'https://fapi.binance.com';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };

async function getJson(url, { tries = 3, timeout = 20000 } = {}) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
      // 429/418 are budget problems, not broken requests - back off and retry.
      if (r.status === 429 || r.status === 418) { await sleep(1500 * (i + 1)); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (e && e.name === 'AbortError') break;
      await sleep(400 * (i + 1));
    }
  }
  if (lastErr) throw lastErr;
  throw new Error('no response');
}

// ── universe ───────────────────────────────────────────────────────────────
let _perpSet = null, _perpAt = 0;

// exchangeInfo classifies each symbol's contractType. Binance USDM lists
// PERPETUAL alongside dated CURRENT_QUARTER/NEXT_QUARTER delivery contracts -
// those expire and carry no funding rate, and would pollute a volume-ranked
// universe the same way Gate's tokenized stocks would if left unfiltered.
async function perpSymbols() {
  if (_perpSet && Date.now() - _perpAt < 3600000) return _perpSet;
  const info = await getJson(`${F}/fapi/v1/exchangeInfo`, { timeout: 20000 });
  const set = new Set();
  for (const s of (info && info.symbols) || []) {
    if (s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING') {
      set.add(s.symbol);
    }
  }
  if (set.size) { _perpSet = set; _perpAt = Date.now(); }
  return _perpSet || set;
}

// One call, every symbol: last price and 24h quote volume. Reshaped to the
// same field names gate.cjs's tickers() rows carry (`.contract`, `.last`,
// `.mark_price`, `.volume_24h_quote`), so scanner.cjs needed no changes to
// read price.
async function tickers() {
  const t = await getJson(`${F}/fapi/v1/ticker/24hr`, { timeout: 20000 });
  const rows = Array.isArray(t) ? t : [];
  return rows.map(r => ({
    contract: r.symbol,
    last: r.lastPrice,
    mark_price: r.lastPrice,
    volume_24h_quote: r.quoteVolume
  }));
}

// Top N perpetuals by 24h quote volume. No cross-exchange ranking needed -
// unlike Gate (which reads Binance volume to avoid missing coins that matter
// more there), this scanner already tracks the exchange that has the volume.
async function universe(n, tickerRows) {
  const rows = tickerRows || await tickers();
  let perps = null;
  try { perps = await perpSymbols(); } catch (_) {}

  const filtered = rows.filter(x => /USDT$/.test(x.contract) && (!perps || perps.has(x.contract)));
  const use = (perps && filtered.length) ? filtered : rows.filter(x => /USDT$/.test(x.contract));

  const scored = use
    .map(x => ({ contract: x.contract, binVol: parseFloat(x.volume_24h_quote || 0) || 0 }))
    .filter(x => x.binVol > 0)
    .sort((a, b) => b.binVol - a.binVol)
    .slice(0, n);

  return {
    filtered: Boolean(perps && filtered.length),
    rankedByBoth: false, // single-venue scanner - kept for scanner.cjs field parity only
    symbols: scored.map(x => x.contract),
    volumes: new Map(scored.map(x => [x.contract, { gateVol: x.binVol, binVol: x.binVol, rankVenue: 'binance' }]))
  };
}

// ── per-symbol series ──────────────────────────────────────────────────────

async function klines(contract, limit = 220, interval = '1h') {
  const k = await getJson(`${F}/fapi/v1/klines?symbol=${encodeURIComponent(contract)}` +
    `&interval=${encodeURIComponent(interval)}&limit=${limit}`);
  if (!Array.isArray(k)) return [];
  // [openTime, open, high, low, close, volume, closeTime, quoteVolume, ...]
  return k.map(x => ({
    t: num(x[0]), o: num(x[1]), h: num(x[2]), l: num(x[3]), c: num(x[4]),
    v: num(x[5]), quote: num(x[7])
  })).filter(x => x.c != null).sort((a, b) => a.t - b.t);
}

async function fundingRate(contract) {
  const rows = await getJson(`${F}/fapi/v1/fundingRate?symbol=${encodeURIComponent(contract)}&limit=1`)
    .catch(() => []);
  if (!Array.isArray(rows) || !rows.length) return null;
  return num(rows[rows.length - 1].fundingRate);
}

// Open interest + taker ratio + funding, stitched into one row per hour to
// match the shape score.cjs's statMetrics() reads. Deliberately NO
// liquidation fields (liqPctOfOi, liqSkew) - they do not exist on Binance
// (see this file's header) and score.cjs for this scanner never reads them.
async function stats(contract, limit = 48, interval = '1h') {
  const [oiRows, takerRows, funding] = await Promise.all([
    getJson(`${F}/futures/data/openInterestHist?symbol=${encodeURIComponent(contract)}` +
      `&period=${encodeURIComponent(interval)}&limit=${limit}`).catch(() => []),
    getJson(`${F}/futures/data/takerlongshortRatio?symbol=${encodeURIComponent(contract)}` +
      `&period=${encodeURIComponent(interval)}&limit=${limit}`).catch(() => []),
    fundingRate(contract).catch(() => null)
  ]);
  const oi = Array.isArray(oiRows) ? oiRows : [];
  // Sorted ascending so the nearest-at-or-before lookup below can binary
  // search it, same as dump-study.cjs's atOrBefore().
  const taker = (Array.isArray(takerRows) ? takerRows : [])
    .map(r => ({ t: Number(r.timestamp), ratio: num(r.buySellRatio) }))
    .filter(r => Number.isFinite(r.t))
    .sort((a, b) => a.t - b.t);

  // openInterestHist and takerlongshortRatio do NOT share a timestamp grid -
  // confirmed directly: at the same limit, taker's newest bar sits exactly
  // one hour BEHIND OI's newest bar (Binance finalizes/publishes them on
  // different schedules). An exact-timestamp match therefore always misses
  // on the newest row - which is the only row statMetrics() ever reads
  // (stats[-1]) - making lsrTaker null for every symbol, every time. Nearest
  // at-or-before fixes it: the newest OI bar gets the latest taker reading
  // available for it, off by at most the one-bar publish lag, not silently
  // absent.
  function takerAtOrBefore(ts) {
    let lo = 0, hi = taker.length - 1, best = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (taker[mid].t <= ts) { best = taker[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    return best ? best.ratio : null;
  }

  // Funding is an 8-hourly event on Binance, not per-candle like Gate
  // publishes it - the CURRENT rate is attached to every row rather than
  // trying to align historical funding events to hourly bars, since only the
  // newest row's value is ever actually read (statMetrics reads stats[-1]).
  return oi.map(r => {
    const t = Number(r.timestamp);
    return {
      t,
      oiUsd: num(r.sumOpenInterestValue),
      oi: num(r.sumOpenInterest),
      lsrTaker: takerAtOrBefore(t),
      fundingRate: funding
    };
  }).filter(x => x.t != null && x.oiUsd != null).sort((a, b) => a.t - b.t);
}

module.exports = { getJson, tickers, universe, klines, stats, fundingRate, perpSymbols, F };
