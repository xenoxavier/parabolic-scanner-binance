'use strict';
// Feature extraction and dump scoring - BINANCE VERSION.
//
// This is NOT a port of Gate's rules. Binance publishes no market-wide
// liquidation feed (/fapi/v1/allForceOrders now 404s; the only liquidation
// endpoint left is account-scoped, useless as a signal) - the single
// strongest feature Gate's scanner has does not exist here. Every rule below
// was independently measured on Binance's own data instead of assumed to
// transfer.
//
// EVERY threshold and lift comes from one measurement: 30 days of real
// Binance 1h data, 37,620 observations across 57 USDT perps, outcome = "did
// price fall 10% within the next 12h". Base rate 3.1% (train 2.2% / test
// 4.0% - the halves differ 1.9x, so treat cross-half agreement as the bar to
// clear, not either number alone). Symbols split odd/even into train and
// test, each half scored against ITS OWN base rate.
// Reproduce with: node dump-study.cjs --symbols=60
//
// Two findings replicated Gate's exactly, independently measured - real
// confidence in both studies, not one confirming the other by construction:
//
//  1. Open interest is the signal in EITHER direction. Rising OI (a
//     parabola still building) and falling OI (one unwinding) both precede
//     dumps; +30%+/24h measured 10.38x/6.30x, <-10%/24h measured 1.74x/1.74x.
//
//  2. Taker ratio is ANTI-predictive at the extremes. taker < 0.85 measured
//     0.48x/0.62x here - BELOW base rate, not above, matching Gate's
//     0.83x/0.68x finding on the same bucket. Only the neutral 0.95-1.2 band
//     is elevated. Do NOT score a low taker ratio as bearish - a sell-heavy
//     taker flow LOOKS like liquidation pressure and measures the opposite.
//     That is the exact mistake an earlier standalone script (liq-proxy.cjs)
//     made before this study existed; do not repeat it here.

const IND = require('./indicators.cjs');

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const pct = (a, b) => (a != null && b) ? +(((a - b) / b) * 100).toFixed(3) : null;

// Open interest, taker ratio and funding from one stats() series. No
// liquidation fields - binance.cjs never returns them, they do not exist.
function statMetrics(stats) {
  const f = {};
  if (!Array.isArray(stats) || !stats.length) return f;
  const s = stats[stats.length - 1];
  f.oiUsd = s.oiUsd;
  f.lsrTaker = s.lsrTaker;
  f.fundingRate = s.fundingRate;
  f.fundingPct = s.fundingRate != null ? +(s.fundingRate * 100).toFixed(4) : null;
  const at = k => stats[stats.length - 1 - k]?.oiUsd;
  f.oiChg1 = pct(s.oiUsd, at(1));
  f.oiChg6 = pct(s.oiUsd, at(6));
  f.oiChg24 = pct(s.oiUsd, at(24));
  f.statRows = stats.length;
  return f;
}

// ── features ───────────────────────────────────────────────────────────────
// All computed from the PRECEDING window only, same discipline as Gate's.
function features(bars, stats) {
  const f = {};
  if (Array.isArray(bars) && bars.length >= 25) {
    const c = bars[bars.length - 1].c;
    f.price = c;
    f.ret4 = pct(c, bars[bars.length - 5]?.c);
    f.ret24 = pct(c, bars[bars.length - 25]?.c);
    const look = bars.slice(-168);
    const high = Math.max(...look.map(b => b.h).filter(Number.isFinite));
    f.high7d = high;
    f.distFromHigh = high > 0 ? +(((c - high) / high) * 100).toFixed(3) : null;
    const vols = bars.slice(-25, -1).map(b => b.quote ?? b.v).filter(Number.isFinite);
    const meanVol = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
    const lastVol = bars[bars.length - 1].quote ?? bars[bars.length - 1].v;
    f.volSurge = meanVol > 0 && Number.isFinite(lastVol) ? +(lastVol / meanVol).toFixed(2) : null;
    const ta = IND.compute(bars);
    f.rsi14 = ta.rsi;
    f.atrPct = ta.atrPct;
    f.adx = ta.adx;
    f.trend = ta.trend;
    f.volPct = ta.volPct;
    f.bars = bars.length;
  }
  if (Array.isArray(stats) && stats.length) Object.assign(f, statMetrics(stats));
  return f;
}

// Uniform metrics for one timeframe. Kept for structural parity with Gate's
// module (server/dashboard code paths expect it to exist); this scanner
// currently only ever calls it with 1h bars - see scanner.cjs for why the
// faster views were left out of this first version.
function tfMetrics(bars) {
  if (!Array.isArray(bars) || bars.length < 26) return null;
  const c = bars[bars.length - 1].c;
  const back = n => bars[bars.length - 1 - n]?.c;
  const chg = n => { const p = back(n); return p ? +(((c - p) / p) * 100).toFixed(2) : null; };
  const win = bars.slice(-168);
  const high = Math.max(...win.map(b => b.h).filter(Number.isFinite));
  const low = Math.min(...win.map(b => b.l).filter(Number.isFinite));
  const vols = bars.slice(-25, -1).map(b => b.quote ?? b.v).filter(Number.isFinite);
  const mean = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
  const lastVol = bars[bars.length - 1].quote ?? bars[bars.length - 1].v;
  const ta = IND.compute(bars);
  return {
    chg1: chg(1), chg4: chg(4), chg6: chg(6), chg24: chg(24),
    rsi: ta.rsi, atrPct: ta.atrPct, adx: ta.adx, trend: ta.trend, volPct: ta.volPct,
    volSurge: mean > 0 && Number.isFinite(lastVol) ? +(lastVol / mean).toFixed(2) : null,
    distFromHigh: high > 0 ? +(((c - high) / high) * 100).toFixed(2) : null,
    distFromLow: low > 0 ? +(((c - low) / low) * 100).toFixed(2) : null,
    bars: bars.length
  };
}

function aggregate(bars, n) {
  if (!Array.isArray(bars) || bars.length < n) return [];
  const out = [];
  for (let end = bars.length; end - n >= 0; end -= n) {
    const g = bars.slice(end - n, end);
    out.unshift({
      t: g[0].t, o: g[0].o, c: g[g.length - 1].c,
      h: Math.max(...g.map(x => x.h)), l: Math.min(...g.map(x => x.l)),
      v: g.reduce((a, x) => a + (x.v || 0), 0),
      quote: g.reduce((a, x) => a + (x.quote || 0), 0)
    });
  }
  return out;
}

// Who is in control, from open interest against price. DESCRIPTIVE only,
// not scored - same as Gate's (this is OI-vs-price, not liquidation-derived,
// so it needed no re-measurement to stay valid here).
function control(chgPct, oiChgPct, dead = 1) {
  if (chgPct == null || oiChgPct == null) return null;
  const p = Math.abs(chgPct) < dead ? 0 : Math.sign(chgPct);
  const o = Math.abs(oiChgPct) < dead ? 0 : Math.sign(oiChgPct);
  if (!p && !o) return { state: 'QUIET', who: 'neither', why: 'price and open interest both flat' };
  if (p >= 0 && o > 0) return { state: 'LONGS_BUILDING', who: 'longs',
    why: 'price up on rising open interest - new longs entering' };
  if (p < 0 && o > 0) return { state: 'SHORTS_BUILDING', who: 'shorts',
    why: 'price down on rising open interest - new shorts entering' };
  if (p > 0 && o < 0) return { state: 'SHORT_SQUEEZE', who: 'shorts covering',
    why: 'price up on FALLING open interest - covering, not real buying' };
  if (p < 0 && o < 0) return { state: 'LONGS_CAPITULATING', who: 'longs exiting',
    why: 'price down on falling open interest - longs closing out' };
  return { state: 'QUIET', who: 'neither', why: 'no clear direction' };
}

// ── tiers ──────────────────────────────────────────────────────────────────
// Every rule below is a SINGLE measured condition, not a combination -
// dump-study.cjs only tested single features, so tiers are NOT built from a
// joint-stack rule the way Gate's PRIME is (ret24>=30 AND stackScore>=70,
// itself measured as one combined condition). Do not add a combined rule
// here without measuring that specific combination on Binance data first -
// that would manufacture confidence never actually measured, the same
// mistake Gate's file warns against for a different shortcut.
//
// Tier boundaries are this run's test-half lift: PRIME >= 6x, IMMINENT
// 2.5-6x, DANGER 1.5-2.5x, WARNING 1.2-1.5x. Chosen after seeing the
// numbers, not a rule fixed in advance - a re-run (dump-study.cjs measures
// a trailing 30-day window, so results drift) may shuffle which bucket a
// borderline rule lands in. Re-run periodically and expect this file to move.
function stackScore(f) {
  // Kept for dashboard/UI compatibility (dashboard.html reads it) - purely a
  // display heuristic, NOT used by any tier rule below. No joint-stack
  // combination has been measured on Binance data yet.
  let s = 0;
  if (f.ret24 != null) {
    if (f.ret24 >= 50) s += 20; else if (f.ret24 >= 30) s += 10;
    if (f.ret24 >= 80) s += 15;
  }
  if (f.rsi14 != null) {
    if (f.rsi14 >= 80) s += 20; else if (f.rsi14 >= 70) s += 10;
  }
  if (f.fundingPct != null && f.fundingPct > 0.01) s += 10;
  if (f.volSurge != null && f.volSurge >= 2.0) s += 12;
  if (f.distFromHigh != null && f.distFromHigh < -10) s += 15;
  if (f.oiChg24 != null && Math.abs(f.oiChg24) > 10) s += 15;
  return Math.min(100, Math.round(s));
}

// PRIME is now a JOINT condition, not 4 independent either/or paths - user
// call (2026-09-07), after real cards showed OI-only or distFromHigh-only
// coins hitting PRIME with price barely moving (or even down: PONS at
// ret24=-10.4%, OI+213%). ret24>=30% is now a REQUIRED gate, combined with
// at least one of the other three signals. This IS a new combination that
// was not individually measured - each piece was validated alone (see
// lifts below) but not jointly like this until validate-tiers.cjs was run
// against it directly on the real 37,620-row dataset. Re-run that script
// after touching this rule; do not trust it on the individual lifts alone.
const RULES = [
  // Measured directly via validate-tiers.cjs after this joint rule was
  // written (2026-09-07): n=204 train / 256 test, 55.08% test dump rate vs
  // 3.99% base - 13.81x, clearing the CI comfortably. Requiring BOTH
  // signals together roughly DOUBLED the precision of the old OR-based
  // PRIME (26.44%/6.63x) at the cost of firing far less often (n dropped
  // from 1112 to 256) - exactly the tradeoff asked for.
  { tier: 'PRIME', lift: '14.80x/13.81x', why: '24h move +30%+ AND (OI +30%+/24h OR 20%+ below 7d high OR violent 4h move)',
    test: f => f.ret24 != null && f.ret24 >= 30 && (
      (f.oiChg24 != null && f.oiChg24 > 30) ||
      (f.distFromHigh != null && f.distFromHigh < -20) ||
      (f.ret4 != null && f.ret4 > 5)
    ) },

  { tier: 'IMMINENT', lift: '8.39x/4.78x', why: 'violent 4h move down (< -5%)',
    test: f => f.ret4 != null && f.ret4 < -5 },
  { tier: 'IMMINENT', lift: '4.28x/3.20x', why: 'open interest +5%+ in 6h',
    test: f => f.oiChg6 != null && f.oiChg6 > 5 },
  { tier: 'IMMINENT', lift: '3.36x/2.01x', why: '10-20% below the 7d high',
    test: f => f.distFromHigh != null && f.distFromHigh < -10 && f.distFromHigh >= -20 },
  { tier: 'IMMINENT', lift: '2.24x/2.81x', why: 'volume surge above 4x',
    test: f => f.volSurge != null && f.volSurge > 4 },
  { tier: 'IMMINENT', lift: '2.52x/2.18x', why: 'RSI 80+',
    test: f => f.rsi14 != null && f.rsi14 >= 80 },

  { tier: 'DANGER', lift: '2.74x/1.98x', why: '24h move +5..20%',
    test: f => f.ret24 != null && f.ret24 > 5 && f.ret24 <= 20 },
  { tier: 'DANGER', lift: '3.34x/1.92x', why: 'open interest +10..30% in 24h',
    test: f => f.oiChg24 != null && f.oiChg24 > 10 && f.oiChg24 <= 30 },
  { tier: 'DANGER', lift: '1.74x/1.74x', why: 'open interest unwinding (< -10% in 24h)',
    test: f => f.oiChg24 != null && f.oiChg24 < -10 },
  { tier: 'DANGER', lift: '2.55x/1.66x', why: 'RSI 70-80',
    test: f => f.rsi14 != null && f.rsi14 >= 70 && f.rsi14 < 80 },
  { tier: 'DANGER', lift: '1.78x/1.73x', why: 'taker ratio in the neutral 0.95-1.05 band',
    test: f => f.lsrTaker != null && f.lsrTaker >= 0.95 && f.lsrTaker < 1.05 },

  { tier: 'WARNING', lift: '1.34x/1.32x', why: 'taker ratio 1.05-1.2',
    test: f => f.lsrTaker != null && f.lsrTaker >= 1.05 && f.lsrTaker < 1.2 },
  { tier: 'WARNING', lift: '1.97x/1.64x', why: 'volume surge 2-4x',
    test: f => f.volSurge != null && f.volSurge >= 2 && f.volSurge <= 4 },
  { tier: 'WARNING', lift: '1.45x/1.36x', why: 'funding rate 0.01-0.05%',
    test: f => f.fundingPct != null && f.fundingPct >= 0.01 && f.fundingPct < 0.05 }
];

const RANK = { PRIME: 4, IMMINENT: 3, DANGER: 2, WARNING: 1, QUIET: 0 };

// Conditions measured BELOW the base rate on both halves - evidence AGAINST
// a dump, suppresses the tier rather than just failing to raise it. Same
// discipline as Gate's dampeners, different numbers.
const DAMPENERS = [
  { lift: '0.21x/0.33x', why: 'flat 24h move (-5%..5%)',
    test: f => f.ret24 != null && Math.abs(f.ret24) < 5 },
  { lift: '0.14x/0.48x', why: 'open interest flat-to-down (-10%..0% in 24h)',
    test: f => f.oiChg24 != null && f.oiChg24 >= -10 && f.oiChg24 <= 0 },
  // The exact anti-predictive-extreme finding this file's header warns
  // about. A low taker ratio LOOKS bearish (sell-dominant flow) and
  // measures the opposite - do not let this dampener be "corrected" away.
  { lift: '0.48x/0.62x low · 0.46x/0.55x high', why: 'taker ratio at an extreme (<0.85 or >=1.2)',
    test: f => f.lsrTaker != null && (f.lsrTaker < 0.85 || f.lsrTaker >= 1.2) }
];

function grade(f) {
  const matched = RULES.filter(r => { try { return r.test(f); } catch (_) { return false; } });
  const damp = DAMPENERS.filter(d => { try { return d.test(f); } catch (_) { return false; } });

  let tier = 'QUIET';
  for (const m of matched) if (RANK[m.tier] > RANK[tier]) tier = m.tier;

  // Dampeners cost ONE tier no matter how many fire, same reasoning as
  // Gate's: the tier rules are individually-measured 6-8x-lift conditions;
  // stacking multiple weak dampeners to cancel one would be evidence never
  // jointly measured. Cannot rescue a QUIET, cannot veto entirely.
  if (damp.length && RANK[tier] > 0) {
    tier = ['QUIET', 'WARNING', 'DANGER', 'IMMINENT', 'PRIME'][RANK[tier] - 1];
  }

  // Score ranks WITHIN a tier only - not a probability. Driven by the
  // strongest rule that fired plus a small per-rule bonus, same shape as
  // Gate's (summing lifts saturates the cap almost immediately and
  // double-counts correlated features like oiChg24/ret24).
  const lifts = matched.map(m => parseFloat(m.lift.split('/')[1])).filter(Number.isFinite);
  let score = 0;
  if (lifts.length) score = (Math.max(...lifts) - 1) * 10 + (lifts.length - 1) * 3;
  for (const d of damp) score -= 15;

  const notes = [];
  if (f.lsrTaker != null && (f.lsrTaker < 0.85 || f.lsrTaker >= 1.2)) {
    notes.push(`taker ${f.lsrTaker.toFixed(2)} is an EXTREME - measured 0.46-0.62x here, ` +
               `i.e. dumps are LESS likely. Not scored as bearish.`);
  }

  return {
    tier,
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasons: matched.map(m => `${m.why} (${m.lift})`),
    dampeners: damp.map(d => `${d.why} (${d.lift})`),
    notes,
    ruleCount: matched.length
  };
}

module.exports = { features, grade, stackScore, tfMetrics, statMetrics, control, aggregate, RULES, DAMPENERS };
