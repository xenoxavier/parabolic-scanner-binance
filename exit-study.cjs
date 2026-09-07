'use strict';
// When is the dump over?
//
// The scanner detects entries and says nothing about exits. This measures, on the
// same 30 days of Gate data, what would actually have gotten you out near the low
// of a PRIME episode.
//
// Framing: PRIME is a SHORT signal, so a favourable move is DOWN. Entry is the
// close of the first PRIME hour. "Capture" is how much of the best available move
// a rule actually banked:
//
//     capture = realised move / best move available in the window
//
// A rule that exits at the exact low captures 100%. One that never exits captures
// whatever the window happened to end at. Capture is the honest metric here
// because a rule can look good on hit-rate while leaving most of the move behind.
//
// Usage: node exit-study.cjs [--window=48]

const fs = require('fs');
const path = require('path');
const SCORE = require('./score.cjs');

const arg = (n, d) => {
  const a = process.argv.find(x => x.startsWith(`--${n}=`));
  return a ? Number(a.split('=')[1]) : d;
};
const WINDOW_H = arg('window', 48);
const CACHE = path.join(__dirname, 'data', 'study-cache-gate');

const files = fs.readdirSync(CACHE);
const find = (pre, sym) => files.find(f => f.startsWith(`${pre}_${sym}-`) || f === `${pre}_${sym}.json`);
const load = f => { try { return JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8')); } catch (_) { return null; } };

const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'dump-study-rows-gate.json'), 'utf8'));
const adapt = f => Object.assign({}, f, { fundingPct: f.funding });
const isPrime = f => f && f.ret24 >= 30 && SCORE.stackScore(adapt(f)) >= 70;

// ── build episodes ─────────────────────────────────────────────────────────
const bySym = {};
rows.forEach(r => { (bySym[r.sym] = bySym[r.sym] || []).push(r); });
Object.values(bySym).forEach(a => a.sort((x, y) => x.ts - y.ts));

const episodes = [];
for (const [sym, arr] of Object.entries(bySym)) {
  let cur = null;
  for (const r of arr) {
    if (isPrime(r.f)) {
      if (cur && r.ts - cur.lastTs <= 6 * 3600000) { cur.lastTs = r.ts; }
      else { if (cur) episodes.push(cur); cur = { sym, startTs: r.ts, lastTs: r.ts }; }
    }
  }
  if (cur) episodes.push(cur);
}

// ── attach the forward path ────────────────────────────────────────────────
const paths = [];
for (const ep of episodes) {
  const kf = find('k', ep.sym), sf = find('stats', ep.sym);
  if (!kf) continue;
  const k = (load(kf) || []).map(x => ({
    t: +x.t * 1000, o: +x.o, h: +x.h, l: +x.l, c: +x.c, v: +x.v
  })).filter(x => Number.isFinite(x.c)).sort((a, b) => a.t - b.t);
  const st = (load(sf) || []).map(x => {
    const oi = +x.open_interest_usd;
    const ll = +(x.long_liq_usd_new ?? x.long_liq_usd ?? 0);
    const sl = +(x.short_liq_usd_new ?? x.short_liq_usd ?? 0);
    return {
      t: +x.time * 1000, oiUsd: oi,
      liqPctOfOi: oi > 0 ? ((ll + sl) / oi) * 100 : null,
      // >1 = longs being liquidated. In a dump that is the crowd capitulating,
      // which is the thing most likely to mark the low.
      liqSkew: sl > 0 ? ll / sl : (ll > 0 ? 999 : null)
    };
  }).sort((a, b) => a.t - b.t);
  const stAt = t => { let best = null; for (const s of st) { if (s.t <= t) best = s; else break; } return best; };

  const i0 = k.findIndex(x => x.t >= ep.startTs);
  if (i0 < 0 || i0 + 3 >= k.length) continue;
  const entry = k[i0].c;
  const fwd = k.slice(i0 + 1, i0 + 1 + WINDOW_H);
  if (fwd.length < 6) continue;

  // Best available move for a short = the deepest low in the window.
  let bestPct = 0, bestIdx = -1;
  fwd.forEach((b, i) => { const m = ((b.l - entry) / entry) * 100; if (m < bestPct) { bestPct = m; bestIdx = i; } });

  // RSI over the forward path, Wilder, so an oversold exit can be tested.
  const closes = k.slice(0, i0 + 1 + WINDOW_H).map(x => x.c);
  const rsiAt = i => {
    const upto = closes.slice(0, i0 + 2 + i);
    return upto.length > 20 ? SCORE.features(upto.map(c => ({ c, h: c, l: c, o: c })), []).rsi14 : null;
  };

  paths.push({ sym: ep.sym, startTs: ep.startTs, entry, fwd, bestPct, bestIdx, stAt, rsiAt });
}

// ── exit rules ─────────────────────────────────────────────────────────────
// Each returns the bar index to exit at, or null to hold to the end of window.
const RULES = {
  'hold 48h (no exit)': () => null,
  'fixed -10%': p => p.fwd.findIndex(b => ((b.l - p.entry) / p.entry) * 100 <= -10),
  'fixed -15%': p => p.fwd.findIndex(b => ((b.l - p.entry) / p.entry) * 100 <= -15),
  'fixed -20%': p => p.fwd.findIndex(b => ((b.l - p.entry) / p.entry) * 100 <= -20),
  'time: 12h': p => Math.min(11, p.fwd.length - 1),
  'time: 24h': p => Math.min(23, p.fwd.length - 1),
  'longs liquidated (skew>2)': p => p.fwd.findIndex(b => {
    const s = p.stAt(b.t); return s && s.liqSkew != null && s.liqSkew > 2;
  }),
  'liq spike >0.5% of OI': p => p.fwd.findIndex(b => {
    const s = p.stAt(b.t); return s && s.liqPctOfOi != null && s.liqPctOfOi > 0.5;
  }),
  'RSI < 30': p => p.fwd.findIndex((b, i) => { const r = p.rsiAt(i); return r != null && r < 30; }),
  'OI stops falling': p => {
    let fell = false;
    return p.fwd.findIndex(b => {
      const s = p.stAt(b.t); if (!s) return false;
      const prev = p.stAt(b.t - 3600000);
      if (!prev || !prev.oiUsd) return false;
      const d = ((s.oiUsd - prev.oiUsd) / prev.oiUsd) * 100;
      if (d < -1) fell = true;
      return fell && d > 0;
    });
  },
  // Give the move room, then bank it when it stops making new lows.
  'trail 5% off the low': p => {
    let low = p.entry;
    for (let i = 0; i < p.fwd.length; i++) {
      if (p.fwd[i].l < low) low = p.fwd[i].l;
      if (((p.fwd[i].h - low) / low) * 100 >= 5) return i;
    }
    return null;
  },
  'trail 8% off the low': p => {
    let low = p.entry;
    for (let i = 0; i < p.fwd.length; i++) {
      if (p.fwd[i].l < low) low = p.fwd[i].l;
      if (((p.fwd[i].h - low) / low) * 100 >= 8) return i;
    }
    return null;
  }
};

const med = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

console.log(`\nEXIT STUDY · when is the dump over?`);
console.log(`${paths.length} PRIME episodes · ${WINDOW_H}h forward window · entry = close of first PRIME hour`);
console.log(`median best-available move: ${med(paths.map(p => p.bestPct)).toFixed(1)}%`);
console.log(`median hours to the low:    ${med(paths.map(p => p.bestIdx + 1)).toFixed(0)}h\n`);
console.log('  exit rule                      fired   median P&L   median capture   worst');

for (const [name, fn] of Object.entries(RULES)) {
  const res = [];
  let fired = 0;
  for (const p of paths) {
    let idx = null;
    try { idx = fn(p); } catch (_) { idx = null; }
    if (idx === -1 || idx == null) idx = p.fwd.length - 1; else fired++;
    // Exit on the close of the signalling bar - the honest fill, since the low of
    // that bar is only knowable after it closes.
    const px = p.fwd[Math.min(idx, p.fwd.length - 1)].c;
    const pnl = ((p.entry - px) / p.entry) * 100;          // short: entry minus exit
    const cap = p.bestPct < 0 ? (pnl / -p.bestPct) * 100 : 0;
    res.push({ pnl, cap });
  }
  const pnls = res.map(r => r.pnl), caps = res.map(r => r.cap);
  console.log('   ' + name.padEnd(28) +
    String(fired + '/' + paths.length).padStart(7) + '  ' +
    (med(pnls) >= 0 ? '+' : '') + med(pnls).toFixed(1) + '%'.padEnd(2) +
    ('  ' + med(caps).toFixed(0) + '%').padStart(14) +
    ('  ' + Math.min.apply(null, pnls).toFixed(1) + '%').padStart(10));
}
console.log('\n  P&L is the raw price move on a short, before fees, funding and leverage.');
console.log('  Capture = share of the deepest available fall that the rule actually banked.\n');
