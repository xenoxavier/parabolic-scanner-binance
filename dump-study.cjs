'use strict';
// What actually precedes a dump? A 30-day study on real Binance data.
//
// Deliberately NOT built on our own recordings: those cover 11 usable days chosen
// by an outage, stored no OHLC, and ran a stale price feed for most of it. Binance
// keeps 30 days of historical open interest and taker ratio, which is precisely the
// window in question, so the study is done on primary data instead.
//
// Method: for every hour of every symbol, build features from the PRECEDING window
// only, then look forward to see whether a dump followed. Split odd/even by symbol
// so nothing is scored on the coins it was selected on.
//
// Usage: node dump-study.cjs [--symbols=60] [--drop=10] [--horizon=12]

const fs = require('fs');
const path = require('path');

const arg = (n, d) => {
  const a = process.argv.find(x => x.startsWith(`--${n}=`));
  return a ? Number(a.split('=')[1]) : d;
};
const N_SYMBOLS = arg('symbols', 60);
const DUMP_PCT = arg('drop', 10);       // a "dump" = falling this much...
const HORIZON_H = arg('horizon', 12);   // ...within this many hours
const CACHE = path.join(__dirname, 'data', 'study-cache');
if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
      if (r.status === 429 || r.status === 418) { await sleep(2000 * (i + 1)); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch (_) { await sleep(500 * (i + 1)); }
  }
  return null;
}

// Cache to disk: the study gets re-run while tuning thresholds and there is no
// reason to re-pull 30 days of history each time.
async function cached(key, fn) {
  const f = path.join(CACHE, key.replace(/[^a-z0-9._-]/gi, '_') + '.json');
  if (fs.existsSync(f)) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {}
  }
  const v = await fn();
  if (v) { try { fs.writeFileSync(f, JSON.stringify(v)); } catch (_) {} }
  return v;
}

const FAPI = 'https://fapi.binance.com';

async function topSymbols(n) {
  const t = await getJson(`${FAPI}/fapi/v1/ticker/24hr`);
  if (!Array.isArray(t)) return [];
  return t.filter(x => /USDT$/.test(x.symbol) && !/^(BTC|ETH)DOM/.test(x.symbol))
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, n).map(x => x.symbol);
}

// 1h klines for 30 days = 720 bars, one call.
const klines = sym => cached(`k_${sym}`, () =>
  getJson(`${FAPI}/fapi/v1/klines?symbol=${sym}&interval=1h&limit=720`));

// openInterestHist and takerlongshortRatio cap at 500 rows, so 30 days of 1h needs
// two calls stitched together.
async function series(sym, endpoint) {
  return cached(`${endpoint}_${sym}`, async () => {
    const a = await getJson(`${FAPI}/futures/data/${endpoint}?symbol=${sym}&period=1h&limit=500`);
    if (!Array.isArray(a) || !a.length) return null;
    const firstTs = a[0].timestamp;
    const b = await getJson(`${FAPI}/futures/data/${endpoint}?symbol=${sym}&period=1h&limit=500&endTime=${firstTs - 1}`);
    return (Array.isArray(b) ? b : []).concat(a);
  });
}

const fundingHist = sym => cached(`fund_${sym}`, () =>
  getJson(`${FAPI}/fapi/v1/fundingRate?symbol=${sym}&limit=1000`));

// Nearest value at or before ts, from a timestamped series.
function atOrBefore(rows, tsKey, valKey, ts) {
  if (!rows || !rows.length) return null;
  let lo = 0, hi = rows.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = Number(rows[mid][tsKey]);
    if (t <= ts) { best = rows[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  if (!best) return null;
  const v = Number(best[valKey]);
  return Number.isFinite(v) ? v : null;
}

function rsi(closes, n = 14) {
  if (closes.length < n + 1) return null;
  let g = 0, l = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch > 0) g += ch; else l -= ch;
  }
  const ag = g / n, al = l / n;
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function build(sym, k, oi, tk, fund) {
  const rows = [];
  const closes = k.map(x => +x[4]);
  const highs = k.map(x => +x[2]);
  const lows = k.map(x => +x[3]);
  const vols = k.map(x => +x[7]);          // quote volume
  const ts = k.map(x => +x[0]);

  for (let i = 48; i < k.length - HORIZON_H; i++) {
    const c = closes[i];
    if (!c) continue;

    // ── forward outcome: worst fall in the next HORIZON_H hours ──
    let worst = 0;
    for (let j = i + 1; j <= i + HORIZON_H; j++) {
      const mv = ((lows[j] - c) / c) * 100;
      if (mv < worst) worst = mv;
    }

    // ── features, from bar i backwards only ──
    const ret = (h) => ((c - closes[i - h]) / closes[i - h]) * 100;
    const volAvg = vols.slice(i - 24, i).reduce((a, b) => a + b, 0) / 24;
    const hi48 = Math.max(...highs.slice(i - 48, i + 1));
    const oiNow = atOrBefore(oi, 'timestamp', 'sumOpenInterestValue', ts[i]);
    const oi6 = atOrBefore(oi, 'timestamp', 'sumOpenInterestValue', ts[i] - 6 * 3600000);
    const oi24 = atOrBefore(oi, 'timestamp', 'sumOpenInterestValue', ts[i] - 24 * 3600000);

    rows.push({
      sym, ts: ts[i],
      dumped: worst <= -DUMP_PCT ? 1 : 0,
      worst: +worst.toFixed(2),
      f: {
        ret1: +ret(1).toFixed(2),
        ret4: +ret(4).toFixed(2),
        ret24: +ret(24).toFixed(2),
        ret48: +ret(48).toFixed(2),
        rsi14: rsi(closes.slice(0, i + 1)),
        volSurge: volAvg ? +(vols[i] / volAvg).toFixed(2) : null,
        distFromHigh: +(((c - hi48) / hi48) * 100).toFixed(2),
        oiChg6: (oiNow && oi6) ? +(((oiNow - oi6) / oi6) * 100).toFixed(2) : null,
        oiChg24: (oiNow && oi24) ? +(((oiNow - oi24) / oi24) * 100).toFixed(2) : null,
        taker: atOrBefore(tk, 'timestamp', 'buySellRatio', ts[i]),
        funding: (() => {
          const v = atOrBefore(fund, 'fundingTime', 'fundingRate', ts[i]);
          return v == null ? null : +(v * 100).toFixed(4);
        })()
      }
    });
  }
  return rows;
}

function wilson(k, n) {
  if (!n) return [0, 0];
  const p = k / n, z = 1.96, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const m = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, c - m), Math.min(1, c + m)];
}

const BUCKETS = {
  ret24: [['< -20%', v => v < -20], ['-20..-5', v => v >= -20 && v < -5], ['-5..5', v => v >= -5 && v <= 5],
          ['5..20', v => v > 5 && v <= 20], ['20..50', v => v > 20 && v <= 50], ['> 50%', v => v > 50]],
  ret4:  [['< -5%', v => v < -5], ['-5..-1', v => v >= -5 && v < -1], ['-1..1', v => v >= -1 && v <= 1],
          ['1..5', v => v > 1 && v <= 5], ['> 5%', v => v > 5]],
  rsi14: [['< 30', v => v < 30], ['30-50', v => v >= 30 && v < 50], ['50-70', v => v >= 50 && v < 70],
          ['70-80', v => v >= 70 && v < 80], ['>= 80', v => v >= 80]],
  volSurge: [['< 0.5x', v => v < 0.5], ['0.5-1', v => v >= 0.5 && v < 1], ['1-2', v => v >= 1 && v < 2],
             ['2-4', v => v >= 2 && v < 4], ['> 4x', v => v >= 4]],
  oiChg24: [['< -10', v => v < -10], ['-10..0', v => v >= -10 && v <= 0], ['0..10', v => v > 0 && v <= 10],
            ['10..30', v => v > 10 && v <= 30], ['> 30', v => v > 30]],
  oiChg6: [['< -5', v => v < -5], ['-5..0', v => v >= -5 && v <= 0], ['0..5', v => v > 0 && v <= 5], ['> 5', v => v > 5]],
  taker: [['< 0.85', v => v < 0.85], ['0.85-0.95', v => v >= 0.85 && v < 0.95], ['0.95-1.05', v => v >= 0.95 && v < 1.05],
          ['1.05-1.2', v => v >= 1.05 && v < 1.2], ['>= 1.2', v => v >= 1.2]],
  funding: [['< 0', v => v < 0], ['0-0.01', v => v >= 0 && v < 0.01], ['0.01-0.05', v => v >= 0.01 && v < 0.05],
            ['>= 0.05', v => v >= 0.05]],
  distFromHigh: [['< -20%', v => v < -20], ['-20..-10', v => v >= -20 && v < -10],
                 ['-10..-3', v => v >= -10 && v < -3], ['-3..0', v => v >= -3]]
};

(async () => {
  console.log(`\nDUMP STUDY · last 30 days · real Binance 1h data`);
  console.log(`a "dump" = falling ${DUMP_PCT}% within ${HORIZON_H}h\n`);
  const syms = await topSymbols(N_SYMBOLS);
  console.log(`  universe: top ${syms.length} USDT perps by 24h volume`);

  let rows = [];
  let done = 0;
  let lastWeight = '?';
  for (const sym of syms) {
    const k = await klines(sym);
    if (!Array.isArray(k) || k.length < 200) { done++; continue; }
    const [oi, tk, fund] = [await series(sym, 'openInterestHist'),
                            await series(sym, 'takerlongshortRatio'),
                            await fundingHist(sym)];
    rows = rows.concat(build(sym, k, oi || [], tk || [], fund || []));
    done++;
    if (done % 10 === 0) {
      try {
        const r = await fetch(`${FAPI}/fapi/v1/ping`, { signal: AbortSignal.timeout(8000) });
        lastWeight = r.headers.get('x-mbx-used-weight-1m') || lastWeight;
      } catch (_) {}
    }
    process.stdout.write(`\r  fetched ${done}/${syms.length}  rows ${rows.length}  weight ${lastWeight}/2400    `);
    // Pacing matters: the live scanner and OI app already burn ~1500 of the 2400
    // weight-per-minute budget on this IP. Each symbol here costs ~10 weight, so
    // 2s spacing caps the study at ~300/min and leaves the production services
    // their headroom. Cached responses make re-runs free.
    await sleep(2000);
  }
  console.log('');

  const base = rows.filter(r => r.dumped).length / rows.length;
  const symList = [...new Set(rows.map(r => r.sym))].sort();
  const inTrain = r => symList.indexOf(r.sym) % 2 === 0;
  const rowsTr = rows.filter(inTrain), rowsTe = rows.filter(r => !inTrain(r));
  const rate = a => a.length ? a.filter(r => r.dumped).length / a.length : 0;
  // Each half is scored against ITS OWN base rate. A pooled denominator makes
  // every lift wrong the moment the halves differ in volatility, and with ~20
  // symbols a half, one violent coin is enough to make them differ.
  const baseTr = rate(rowsTr), baseTe = rate(rowsTe);

  console.log(`  observations ${rows.length} across ${symList.length} symbols`);
  console.log(`  BASE RATE: ${(base * 100).toFixed(1)}% of hours are followed by a ${DUMP_PCT}% fall within ${HORIZON_H}h`);
  console.log(`             (train ${(baseTr * 100).toFixed(1)}% / test ${(baseTe * 100).toFixed(1)}%)`);
  const skew = baseTr && baseTe ? Math.max(baseTr / baseTe, baseTe / baseTr) : Infinity;
  if (skew > 1.5) {
    console.log(`  ⚠ halves differ ${skew.toFixed(1)}x - the split is unbalanced, ` +
                `treat cross-half agreement as weak evidence`);
  }
  console.log('');

  console.log('  feature / bucket        n(train)  lift   n(test)  lift   (vs own half base)');
  for (const [feat, buckets] of Object.entries(BUCKETS)) {
    let printed = false;
    for (const [label, test] of buckets) {
      const sel = a => a.filter(r => r.f[feat] != null && test(r.f[feat]));
      const tr = sel(rowsTr), te = sel(rowsTe);
      if (tr.length < 200 || te.length < 200) continue;
      const pTr = rate(tr), pTe = rate(te);
      const [lo] = wilson(te.filter(r => r.dumped).length, te.length);
      const mark = (lo > baseTe && pTr > baseTr) ? ' **' : (pTe < baseTe && pTr < baseTr ? '  x' : '');
      if (!printed) { console.log(`  ${feat}`); printed = true; }
      console.log(`    ${label.padEnd(18)} ${String(tr.length).padStart(6)} ${(pTr / baseTr).toFixed(2).padStart(5)}x  ` +
                  `${String(te.length).padStart(6)} ${(pTe / baseTe).toFixed(2).padStart(5)}x` +
                  `   ${(pTr * 100).toFixed(1)}% / ${(pTe * 100).toFixed(1)}%${mark}`);
    }
  }
  console.log('\n  ** = test CI clears the base rate and train agrees   x = below base on both\n');
  fs.writeFileSync(path.join(__dirname, 'data', 'dump-study-rows.json'), JSON.stringify(rows));
  console.log(`  raw rows saved for combination testing\n`);
})();
