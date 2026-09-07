'use strict';
// Standalone parabolic dump scanner - BINANCE FORK of the Gate.io original.
//
// Forked rather than parameterized: Gate's contract_stats bundles OI, taker
// ratio, top-trader positioning AND liquidation volume in one call; Binance
// needs separate endpoints for a subset of that and publishes no market-wide
// liquidation feed at all (confirmed directly - /fapi/v1/allForceOrders now
// 404s). Sharing one scanner across both would mean either the Gate version
// loses its best-measured signal, or the Binance version pretends to have
// data it doesn't. See binance.cjs and score.cjs for what changed and why.
//
// STANDALONE. This process reads no other service on this machine.
//
// It is a SCANNER ONLY: it ranks and records. It opens no positions and holds
// no ledger. Entangling the two is how a tier filter meant for tracking silently
// controlled what got recorded, leaving 60% of trades with no price series.
//
// Detection rules live in score.cjs, every one carrying the train/test lift it
// was measured at on 30 days of real Binance data. Port 8805.

const fs = require('fs');
const path = require('path');
const BINANCE = require('./binance.cjs');
const SCORE = require('./score.cjs');
const OUT = require('./outcomes.cjs');
const NOTIFY = require('./notify.cjs');

const CONFIG = {
  // Live price for everything: one call, so it can run often and cheaply.
  pollMs: parseInt(process.env.POLL_MS || '30000', 10),
  // Klines and contract_stats are 1h-granularity - refetching them every 30s would
  // burn the rate limit to re-read identical numbers.
  refreshMs: parseInt(process.env.REFRESH_MS || '300000', 10),
  // Matches dump-study.cjs's default universe (60) - the tier thresholds in
  // score.cjs were measured on exactly this set of symbols. Raising this
  // scans coins the study never covered; their thresholds are an
  // extrapolation, not a measurement, until re-validated at the new size.
  universeSize: parseInt(process.env.UNIVERSE || '60', 10),
  // Defaults to the universe size. When these two disagreed, the extra symbols
  // were fetched every refresh and then silently dropped before grading.
  maxTracked: parseInt(process.env.MAX_TRACKED || process.env.UNIVERSE || '60', 10),
  trackHours: parseFloat(process.env.TRACK_HOURS || '24'),
  // Spacing between per-symbol calls. Each symbol costs 4 Binance calls
  // (klines + OI hist + taker ratio + funding), roughly 8 weight. 60 symbols
  // x 300ms is ~18s of wall time inside a 5 minute refresh window - well
  // inside Binance's 2400-weight-per-minute budget with room for the study
  // tool and other local scripts to run alongside it.
  spacingMs: parseInt(process.env.SPACING_MS || '300', 10),
  barMs: parseInt(process.env.BAR_MS || '300000', 10)
};

const DATA = path.join(__dirname, 'data');
const BARS = path.join(DATA, 'bars');
const TICKS = path.join(DATA, 'ticks');
const STATE_FILE = path.join(DATA, 'state.json');
const EVENTS = path.join(DATA, 'events.jsonl');
const OUTCOMES = path.join(DATA, 'outcomes.jsonl');
for (const d of [DATA, BARS, TICKS]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const logEvent = e => { try { fs.appendFileSync(EVENTS, JSON.stringify({ ts: Date.now(), ...e }) + '\n'); } catch (_) {} };
const sleep = ms => new Promise(r => setTimeout(r, ms));

let state = readJson(STATE_FILE, { tracked: {}, generatedAt: 0 });
if (!state.tracked) state.tracked = {};
const saveState = () => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (_) {} };

// Per-symbol analysis, refreshed on the slow loop.
const analysis = {};
let universeList = [];
let universeFiltered = false;
let universeVolumes = new Map();
let rankedByBoth = false;
let lastRefresh = 0;
let pollErrors = [];

const noteError = (source, e) => {
  pollErrors.push({ ts: Date.now(), source, error: String(e?.message || e) });
  pollErrors = pollErrors.filter(x => Date.now() - x.ts < 86400000);
  logEvent({ type: 'poll_error', source, error: String(e?.message || e) });
};

// ── our own 5m bar record ──────────────────────────────────────────────────
// Gate's 1h klines drive the indicators; these finer bars are our own kept
// record, flushed on bucket close so a restart loses at most one partial bar.
const openBars = {};
function pushTick(sym, ts, price) {
  const bucket = Math.floor(ts / CONFIG.barMs) * CONFIG.barMs;
  const b = openBars[sym];
  if (!b || b.t !== bucket) {
    if (b) {
      try {
        fs.appendFileSync(path.join(BARS, `${sym}.jsonl`),
          JSON.stringify({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, n: b.n }) + '\n');
      } catch (_) {}
    }
    openBars[sym] = { t: bucket, o: price, h: price, l: price, c: price, n: 1 };
    return;
  }
  b.c = price;
  if (price > b.h) b.h = price;
  if (price < b.l) b.l = price;
  b.n++;
}

// Trade levels for a SHORT, anchored to the price at which the tier fired.
//
// From exit-study.cjs over 30 PRIME episodes: median best available move -16.9%,
// median time to the low 16h. A fixed -15% target beat every "smart" exit tested
// - longs-liquidated, liquidation spikes, OI flattening, RSI oversold - and
// trailing stops were actively worse, whipsawing out on the 5% bounces these
// coins make constantly.
//
// The +12% stop is not risk appetite, it is the only side of the grid that stays
// inside the liquidation price at a survivable leverage. At 10x a short liquidates
// at +9.5% and 57% of PRIME episodes touched that BEFORE the target. At 5x
// liquidation sits at +19%, which leaves room for a real stop.
//
// CAVEAT, and it belongs beside the numbers: one configuration out of 60 tested on
// 30 episodes. That is the shape of an overfit result. Candidate levels to
// forward-test, not a validated system.
// Stop widened 12% -> 15% on 2026-09-04, see outcomes.cjs CFG for the evidence.
// At 5x liquidation sits at +19%, so a 15% stop leaves 4% of room. At 10x it is
// untradeable - liquidation is +9.5%, inside the stop.
const TRADE = { targetPct: 15, stopPct: 15, refLeverage: 5, holdHours: 48 };

function levelsFor(entry, price) {
  if (!entry || !price) return null;
  const target = entry * (1 - TRADE.targetPct / 100);
  const stop = entry * (1 + TRADE.stopPct / 100);
  const liq = lev => entry * (1 + ((100 / lev) * 0.95) / 100);
  const moved = ((entry - price) / entry) * 100;   // positive = short in profit
  return {
    entry: +entry.toPrecision(6),
    target: +target.toPrecision(6),
    stop: +stop.toPrecision(6),
    targetPct: TRADE.targetPct, stopPct: TRADE.stopPct,
    liq5x: +liq(5).toPrecision(6),
    liq10x: +liq(10).toPrecision(6),
    movedPct: +moved.toFixed(2),
    progressPct: +Math.max(0, Math.min(100, (moved / TRADE.targetPct) * 100)).toFixed(1),
    hitTarget: price <= target,
    hitStop: price >= stop
  };
}

// One snapshot shape for both the tier-entry path and the adoption path. When
// these were written separately, adopted records carried no features at all.
function snapOf(f, vol, tier) {
  if (!f) return null;
  return {
    ret24: f.ret24, ret4: f.ret4, oiChg24: f.oiChg24, oiChg6: f.oiChg6,
    // No liq fields - Binance has no liquidation feed. Deliberately absent
    // rather than present-and-always-null, so a record's shape itself says
    // which scanner produced it.
    rsi14: f.rsi14, volSurge: f.volSurge, distFromHigh: f.distFromHigh,
    atrPct: f.atrPct, adx: f.adx, volPct: f.volPct,
    oiUsd: f.oiUsd, lsrTaker: f.lsrTaker,
    fundingPct: f.fundingPct,
    stackScore: SCORE.stackScore(f),
    control: SCORE.control(f.ret24, f.oiChg24),
    binVol: vol ? vol.binVol : null,
    tierAtOpen: tier || null
  };
}

// How far the headline thresholds are from firing, so a row that is NOT
// signalling still says something. `pct` is progress toward the threshold (0-1)
// and `need` is the human-readable remainder.
function gapsToFire(f) {
  const g = [];
  const add = (label, cur, thr, unit) => {
    if (cur == null) return;
    const prog = Math.max(0, Math.min(1, cur / thr));
    g.push({
      label,
      met: cur >= thr,
      pct: +prog.toFixed(3),
      need: cur >= thr ? null : +(thr - cur).toFixed(1),
      cur: +cur.toFixed(1), thr, unit
    });
  };
  add('OI 24h', f.oiChg24, 30, '%');
  add('24h move', f.ret24, 20, '%');
  add('4h move', f.ret4, 5, '%');
  if (f.distFromHigh != null) add('off high', -f.distFromHigh, 20, '%');
  add('RSI', f.rsi14, 80, '');
  return g;
}

// ── slow loop: universe + per-symbol features ──────────────────────────────
async function refresh(tickerRows) {
  const u = await BINANCE.universe(CONFIG.universeSize, tickerRows);
  universeList = u.symbols;
  universeFiltered = u.filtered;
  universeVolumes = u.volumes || new Map();
  rankedByBoth = Boolean(u.rankedByBoth);
  if (!u.filtered) {
    // Worth shouting about: without the PERPETUAL filter the universe fills
    // with dated delivery contracts, which behave nothing like the perps
    // this scans (they expire, carry no funding rate).
    logEvent({ type: 'universe_unfiltered', size: u.symbols.length });
  }

  let ok = 0;
  for (const contract of universeList) {
    try {
      // Only 1h, native. Gate's version also carries 1m/5m/15m context views,
      // but those were explicitly "display only, never scored" there too -
      // dropped here to keep each symbol at 2 external calls (klines + stats,
      // stats itself fans out to OI/taker/funding inside binance.cjs) instead
      // of 8, which matters more on Binance's tighter weight budget than it
      // did against Gate's.
      const [bars, stats] = await Promise.all([
        BINANCE.klines(contract), BINANCE.stats(contract)
      ]);
      if (!bars.length) continue;
      const f = SCORE.features(bars, stats);
      // 4h is derived from the 1h series rather than fetched - free, and it
      // can never disagree with the 1h data the tiers are computed from.
      // No 1d view: 220 hourly bars only make 9 daily ones, too few for RSI
      // or ADX, and a daily read sits outside the 12h horizon the rules were
      // measured on.
      const bars4h = SCORE.aggregate(bars, 4);
      const withStats = (price, st) => {
        if (!price) return null;
        const m = Object.assign({}, price, SCORE.statMetrics(st));
        m.control = SCORE.control(m.chg24, m.oiChg24);
        return m;
      };
      // h4's own OI/taker context is display-only (same discipline as Gate's
      // fast views) - the tiers always read the 1h `f` above, never this.
      const tf = {
        h1: withStats(SCORE.tfMetrics(bars), stats),
        h4: withStats(SCORE.tfMetrics(bars4h), stats)
      };
      const oiOf = a => (a || []).slice(-40).map(r => Math.round(r.oiUsd)).filter(Number.isFinite);
      const oiSparks = { h1: oiOf(stats), h4: oiOf(stats) };
      // Sparkline points: the chart renders 64px wide, so more than ~48
      // points are bytes that cannot become pixels. 6 significant digits
      // for the same reason.
      const sig = v => Number.isFinite(v) ? +v.toPrecision(6) : null;
      const sparkOf = b => b.slice(-48).map(x => sig(x.c)).filter(v => v != null);
      const sparks = { h1: sparkOf(bars), h4: sparkOf(bars4h) };
      const oiSpark = stats.slice(-48).map(r => Math.round(r.oiUsd)).filter(Number.isFinite);
      analysis[contract] = { f, sparks, oiSpark, oiSparks, tf, at: Date.now() };
      ok++;
    } catch (e) {
      noteError('binance:' + contract, e);
    }
    await sleep(CONFIG.spacingMs);
  }
  lastRefresh = Date.now();
  logEvent({ type: 'refresh', symbols: universeList.length, ok, filtered: u.filtered });
  return ok;
}

// ── fast loop: live price + grading ────────────────────────────────────────
async function poll() {
  let rows = [];
  try {
    rows = await BINANCE.tickers();
  } catch (e) {
    noteError('binance:tickers', e);
    return;
  }

  const priceOf = {};
  for (const r of rows) priceOf[r.contract] = num(r.last) ?? num(r.mark_price);

  if (!lastRefresh || Date.now() - lastRefresh > CONFIG.refreshMs) {
    try { await refresh(rows); } catch (e) { noteError('gate:refresh', e); }
  }

  const now = Date.now();
  const out = [];
  for (const contract of universeList.slice(0, CONFIG.maxTracked)) {
    const a = analysis[contract];
    if (!a) continue;
    const price = priceOf[contract] ?? a.f.price;
    if (!price) continue;

    // Live price supersedes the last closed hourly bar, so the tier reflects now
    // rather than up to an hour ago.
    const vol = universeVolumes.get(contract) || null;
    const f = { ...a.f, price };
    if (f.high7d > 0) f.distFromHigh = +(((price - f.high7d) / f.high7d) * 100).toFixed(3);

    const g = SCORE.grade(f);

    let tr = state.tracked[contract];
    if (!tr || now - tr.firstSeen > CONFIG.trackHours * 3600000) {
      tr = state.tracked[contract] = { symbol: contract, firstSeen: now, alertPrice: price, samples: 0 };
      if (g.tier !== 'QUIET') logEvent({ type: 'track_started', symbol: contract, price, tier: g.tier });
    }
    tr.samples++;
    tr.lastSeen = now;
    tr.price = price;
    tr.changeFromAlertPct = +(((price - tr.alertPrice) / tr.alertPrice) * 100).toFixed(3);

    // Tier transitions. The two questions a scanner has to answer about a live
    // signal are "how long has this been firing" and "what has price done since
    // it started" - without the second, a stale IMMINENT looks identical to a
    // fresh one. Both need the price captured at the moment the tier changed.
    const RK = { QUIET: 0, WARNING: 1, DANGER: 2, IMMINENT: 3, PRIME: 4 };
    const fromTier = tr.tier || null;

    // HYSTERESIS. A coin sitting exactly on a threshold crosses it every poll:
    // coin "4" went DANGER->PRIME->DANGER->PRIME inside 90 seconds, which fired
    // an alert each time and would have churned positions too. A new tier must
    // now hold for CONFIRM_POLLS consecutive polls before it is committed.
    // Raising a tier still needs confirmation, so an alert is never sent on a
    // single noisy reading.
    const CONFIRM_POLLS = 3;
    let committed = g.tier;
    if (g.tier !== fromTier) {
      if (tr.pendingTier === g.tier) tr.pendingCount = (tr.pendingCount || 0) + 1;
      else { tr.pendingTier = g.tier; tr.pendingCount = 1; }
      // Not yet confirmed - hold the old tier for another poll.
      if (tr.pendingCount < CONFIRM_POLLS) committed = fromTier || g.tier;
      else { tr.pendingTier = null; tr.pendingCount = 0; }
    } else {
      tr.pendingTier = null; tr.pendingCount = 0;
    }
    g.tier = committed;

    if (fromTier !== g.tier) {
      tr.prevTier = fromTier;
      tr.tier = g.tier;
      tr.tierSince = now;
      tr.priceAtTier = price;
      tr.scoreAtTier = g.score;
      tr.history = (tr.history || []).concat([{ t: now, from: fromTier, to: g.tier, price }]).slice(-12);
      if (fromTier) logEvent({ type: 'tier_change', symbol: contract, from: fromTier, to: g.tier, price, score: g.score });
      // Start tracking the real outcome of this signal.
      const rec = OUT.onTier(state, {
        symbol: contract, base: contract.replace(/USDT$/, ''),
        tier: g.tier, prevTier: fromTier, price,
        score: g.score, stackScore: SCORE.stackScore(f),
        snap: snapOf(f, vol, g.tier),
        now
      });
      if (rec) logEvent({ type: 'outcome_open', symbol: contract, tier: g.tier, entry: price });
    }
    // A track restored from disk, or one created above, has no tier baseline yet.
    if (!tr.tierSince) { tr.tierSince = now; tr.priceAtTier = price; tr.scoreAtTier = g.score; }
    // Peak severity reached in this track's life, so a coin that spiked to
    // IMMINENT and relaxed still reads differently from one that never did.
    // Seeded from the tier it was ALREADY holding, not just the new one - a track
    // restored from disk before this field existed would otherwise record a peak
    // lower than a tier it demonstrably held a moment ago.
    // Remember the most recent PRIME/IMMINENT episode and track price against it.
    // A PRIME lasts a few hours; when it decays the coin slides down the list and
    // is effectively gone. But a decayed PRIME still reaches -10% about 41% of the
    // time against a 6% base, so it is worth keeping visible - just never dressed
    // up as a fresh entry, because entering after decay measured 60% -> 41% with
    // roughly half the move already gone.
    if (g.tier === 'PRIME' || g.tier === 'IMMINENT') {
      if (tr.lastHighTier !== g.tier || !tr.lastHighAt) {
        tr.lastHighTier = g.tier;
        tr.lastHighAt = tr.tierSince || now;
        tr.lastHighPrice = tr.priceAtTier || price;
        tr.lowSinceHigh = price;
        tr.highSinceHigh = price;
      }
    }
    if (tr.lastHighAt) {
      if (tr.lowSinceHigh == null || price < tr.lowSinceHigh) tr.lowSinceHigh = price;
      if (tr.highSinceHigh == null || price > tr.highSinceHigh) tr.highSinceHigh = price;
      // Drop it once it is older than the outcome window, so the section and the
      // resolved log always describe the same set of signals.
      if (now - tr.lastHighAt > 48 * 3600000) {
        delete tr.lastHighTier; delete tr.lastHighAt; delete tr.lastHighPrice;
        delete tr.lowSinceHigh; delete tr.highSinceHigh;
      }
    }

    // prevTier is included because a transition recorded in an EARLIER process
    // run leaves no fromTier to see on this one - without it a restart forgets
    // that the coin ever held the higher tier.
    const seen = [tr.peakTier, fromTier, tr.prevTier, g.tier]
      .concat((tr.history || []).map(h => h.to));
    for (const t of seen) {
      if (t && (!tr.peakTier || RK[t] > RK[tr.peakTier])) { tr.peakTier = t; tr.peakAt = now; }
    }

    pushTick(contract, now, price);

    const s = {
      symbol: contract,
      base: contract.replace(/USDT$/, ''),
      price,
      tier: g.tier,
      dumpScore: g.score,
      reasons: g.reasons,
      dampeners: g.dampeners,
      notes: g.notes,
      changeFromAlertPct: tr.changeFromAlertPct,
      elapsedMin: +((now - tr.firstSeen) / 60000).toFixed(1),
      ret4: f.ret4, ret24: f.ret24,
      distFromHigh: f.distFromHigh,
      oiChg6: f.oiChg6, oiChg24: f.oiChg24, oiUsd: f.oiUsd,
      // No liq fields - Binance has no liquidation feed. See binance.cjs.
      lsrTaker: f.lsrTaker,
      rsi14: f.rsi14, volSurge: f.volSurge,
      fundingPct: f.fundingPct,
      atrPct: f.atrPct, adx: f.adx, trend: f.trend, volPct: f.volPct,
      high7d: f.high7d,
      // ATR's practical use: size the stop to the coin instead of a constant.
      suggestedStopPct: f.atrPct != null ? +(f.atrPct * 2).toFixed(2) : null,
      // How far each headline rule is from firing. This is what makes a QUIET row
      // worth reading: "needs +8% more OI" is information, a blank row is not.
      gaps: gapsToFire(f),
      // The corrected tamad-scanner stack. Exposed so a card can show how close
      // it sits to the PRIME threshold of 70, not just whether it crossed it.
      stackScore: SCORE.stackScore(f),
      // Candidate short levels, anchored to the price when the tier fired.
      levels: g.tier === 'QUIET' ? null : levelsFor(tr.priceAtTier, price),
      // The most recent high-tier episode, kept for 48h after it decays.
      // `decayed` is the flag the UI needs: still worth reading, not a new entry.
      wasHigh: tr.lastHighAt ? {
        tier: tr.lastHighTier,
        at: tr.lastHighAt,
        agoSec: Math.round((now - tr.lastHighAt) / 1000),
        price: tr.lastHighPrice,
        changeSincePct: tr.lastHighPrice
          ? +(((price - tr.lastHighPrice) / tr.lastHighPrice) * 100).toFixed(2) : null,
        bestPct: tr.lastHighPrice && tr.lowSinceHigh != null
          ? +(((tr.lastHighPrice - tr.lowSinceHigh) / tr.lastHighPrice) * 100).toFixed(2) : null,
        worstPct: tr.lastHighPrice && tr.highSinceHigh != null
          ? +(((tr.highSinceHigh - tr.lastHighPrice) / tr.lastHighPrice) * 100).toFixed(2) : null,
        decayed: RK[g.tier] < RK[tr.lastHighTier]
      } : null,
      // Per-timeframe context. Tiers stay 1h-derived; this only changes what the
      // dashboard displays.
      tf: a.tf || null,
      oiSparks: a.oiSparks || null,
      // One series per timeframe. There is deliberately no separate `spark`
      // field: it was a byte-identical copy of sparks.h1 and cost ~15KB gzipped
      // per poll to say the same thing twice.
      sparks: a.sparks || null,
      oiSpark: a.oiSpark || [],
      // Signal age and what price has done since it fired.
      tierSince: tr.tierSince,
      tierAgeSec: Math.round((now - tr.tierSince) / 1000),
      prevTier: tr.prevTier || null,
      peakTier: tr.peakTier || null,
      priceAtTier: tr.priceAtTier ?? null,
      // The payoff question: is this signal working? Negative means price has
      // fallen since the tier fired, which for a dump signal is a hit.
      changeSinceTierPct: tr.priceAtTier
        ? +(((price - tr.priceAtTier) / tr.priceAtTier) * 100).toFixed(3) : null,
      scoreAtTier: tr.scoreAtTier ?? null,
      scoreDelta: tr.scoreAtTier != null ? g.score - tr.scoreAtTier : null,
      history: tr.history || [],
      trackAgeSec: Math.round((now - tr.firstSeen) / 1000),
      binVol: vol ? vol.binVol : null,
      barCount: f.bars, statRows: f.statRows,
      dataAgeSec: Math.round((now - a.at) / 1000),
      ts: now
    };
    try { fs.appendFileSync(path.join(TICKS, `${contract}.jsonl`), JSON.stringify(s) + '\n'); } catch (_) {}
    out.push(s);
  }

  for (const [sym, tr] of Object.entries(state.tracked)) {
    if (now - tr.lastSeen > 2 * 3600000) delete state.tracked[sym];
  }

  // Adopt anything already mid-signal (a restart, or the first run after this
  // feature shipped), then advance every open outcome on the freshest prices we
  // have, before the state
  // is written, so a restart never loses a resolution.
  // Adopted records get a snapshot from the live analysis cache, so a seeded
  // signal is still usable for comparing winners against losers later.
  const adopted = OUT.adopt(state, state.tracked, now, sym => {
    const a = analysis[sym];
    return a ? snapOf(a.f, universeVolumes.get(sym), state.tracked[sym]?.tier) : null;
  });
  if (adopted.length) logEvent({ type: 'outcome_adopted', n: adopted.length,
    symbols: adopted.map(r => r.symbol) });
  const closed = OUT.onPrice(state, priceOf, now, line => fs.appendFileSync(OUTCOMES, line));
  for (const r of closed) {
    logEvent({ type: 'outcome_closed', symbol: r.symbol, status: r.status,
               pnlPct: r.pnlPct, maxFavPct: r.maxFavPct, hoursHeld: r.hoursHeld });
    console.log(`  [outcome] ${r.base} ${r.tier} -> ${r.status}  ` +
      `P&L ${r.pnlPct > 0 ? '+' : ''}${r.pnlPct}%  best ${r.maxFavPct}%  ${r.hoursHeld}h`);
  }

  const RANK = { PRIME: 4, IMMINENT: 3, DANGER: 2, WARNING: 1, QUIET: 0 };
  out.sort((a, b) => (RANK[b.tier] - RANK[a.tier]) || (b.dumpScore - a.dumpScore));

  // Alert on coins that just entered a watched tier. Runs after `out` is built
  // so the alert carries the same levels and evidence the dashboard shows.
  try { NOTIFY.notifyEntries(state, out, logEvent); } catch (e) { noteError('webhook', e); }

  state.generatedAt = now;
  state.candidates = out;
  state.universeFiltered = universeFiltered;
  state.rankedByBoth = rankedByBoth;
  state.openOutcomes = Object.keys(OUT.ensure(state)).length;
  state.pollErrors24h = pollErrors.length;
  // When the hourly features were last pulled and when they are next due, so the
  // dashboard can say how fresh the numbers are rather than implying every field
  // is as live as the price.
  state.lastRefresh = lastRefresh;
  state.nextRefreshAt = lastRefresh + CONFIG.refreshMs;
  saveState();

  const by = t => out.filter(x => x.tier === t).length;
  console.log(`[${new Date().toLocaleTimeString()}] universe=${universeList.length} ` +
    `imminent=${by('IMMINENT')} danger=${by('DANGER')} warning=${by('WARNING')} ` +
    `top=${out[0]?.symbol || '-'}:${out[0]?.dumpScore ?? '-'}`);
}

async function main() {
  console.log('Parabolic Scanner (Binance fork) starting');
  console.log(`  source   : Binance USDM futures ${BINANCE.F}`);
  console.log(`  universe : top ${CONFIG.universeSize} USDT perps by 24h volume`);
  console.log(`  filter   : exchangeInfo contractType=PERPETUAL (excludes dated delivery contracts)`);
  console.log(`  price    : every ${CONFIG.pollMs / 1000}s · features every ${CONFIG.refreshMs / 60000}min`);
  console.log('  rules    : measured on Binance OI + taker + price data, not liquidation - see score.cjs');
  console.log('  no local service is contacted');
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await poll(); } catch (e) { noteError('poll', e); }
    finally { running = false; }
  };
  await tick();
  setInterval(tick, CONFIG.pollMs);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { CONFIG, state };
