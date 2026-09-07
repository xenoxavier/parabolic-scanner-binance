'use strict';
// Are we quitting too early?
//
// The first live day produced 6 PRIME signals: 1 win, 5 losses. In FOUR of the
// five losses price first moved 3-6% our way, then reversed into the +12% stop.
// That is not "the signal was wrong", it is "we were right, then shaken out".
//
// This tests three ways of being more patient, on the 30 backtest episodes where
// there are enough samples to say anything:
//
//   1. WIDER STOP     - at 5x you survive to +19%. Does +15/+18 rescue the
//                       shake-outs, or just make the losses bigger?
//   2. BREAKEVEN MOVE - after price goes N% our way, move the stop to entry.
//                       Cuts the loss to zero without capping the winner.
//   3. WAIT TO ENTER  - do not take the flag; enter only once price is already
//                       X% below it. Fewer trades, hopefully better ones.
//
// Rules kept honest throughout:
//   * First touch, bar by bar. A bar spanning both levels counts as the STOP,
//     because intrabar order is unknowable.
//   * A stop beyond the liquidation price is not tradeable and is skipped, not
//     silently capped.
//   * P&L is the raw price move on a short, then leverage, minus 0.1% round trip.
//
// Usage: node patience-study.cjs [--lev=5] [--window=48]

const fs = require('fs');
const path = require('path');
const SCORE = require('./score.cjs');

const arg = (n, d) => {
  const a = process.argv.find(x => x.startsWith(`--${n}=`));
  return a ? Number(a.split('=')[1]) : d;
};
const LEV = arg('lev', 5);
const WINDOW_H = arg('window', 48);
const MARGIN = 10, FEE = 0.001;
const LIQ = (100 / LEV) * 0.95;

const CACHE = path.join(__dirname, 'data', 'study-cache-gate');
const files = fs.readdirSync(CACHE);
const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'dump-study-rows-gate.json'), 'utf8'));
const adapt = f => Object.assign({}, f, { fundingPct: f.funding });
const isPrime = f => f && f.ret24 >= 30 && SCORE.stackScore(adapt(f)) >= 70;

const bySym = {};
rows.forEach(r => { (bySym[r.sym] = bySym[r.sym] || []).push(r); });
Object.values(bySym).forEach(a => a.sort((x, y) => x.ts - y.ts));

const eps = [];
for (const [sym, arr] of Object.entries(bySym)) {
  let cur = null;
  for (const r of arr) {
    if (isPrime(r.f)) {
      if (cur && r.ts - cur.lastTs <= 6 * 3600000) cur.lastTs = r.ts;
      else { if (cur) eps.push(cur); cur = { sym, startTs: r.ts, lastTs: r.ts }; }
    }
  }
  if (cur) eps.push(cur);
}

const paths = [];
for (const ep of eps) {
  const kf = files.find(f => f.startsWith(`k_${ep.sym}-`));
  if (!kf) continue;
  const k = JSON.parse(fs.readFileSync(path.join(CACHE, kf), 'utf8'))
    .map(x => ({ t: +x.t * 1000, o: +x.o, h: +x.h, l: +x.l, c: +x.c }))
    .sort((a, b) => a.t - b.t);
  const i0 = k.findIndex(x => x.t >= ep.startTs);
  if (i0 < 0 || i0 + 6 >= k.length) continue;
  const fwd = k.slice(i0 + 1, i0 + 1 + WINDOW_H);
  if (fwd.length < 6) continue;
  paths.push({ sym: ep.sym, flag: k[i0].c, fwd });
}

const up = (b, e) => ((b.h - e) / e) * 100;     // adverse for a short
const dn = (b, e) => ((b.l - e) / e) * 100;     // favourable for a short

// One simulation. `wait` delays entry until price is `wait`% below the flag.
// `be` moves the stop to entry once price has gone `be`% our way.
function run({ target, stop, wait = 0, be = 0 }) {
  if (stop >= LIQ) return null;               // untradeable at this leverage
  let pnl = 0, w = 0, l = 0, o = 0, skipped = 0, saved = 0;
  for (const p of paths) {
    let entry = p.flag, bars = p.fwd, entered = !wait;
    if (wait) {
      // Enter on the first bar that trades `wait`% below the flag, at that level.
      const i = bars.findIndex(b => dn(b, p.flag) <= -wait);
      if (i < 0) { skipped++; continue; }
      entry = p.flag * (1 - wait / 100);
      bars = bars.slice(i + 1);
      entered = true;
      if (!bars.length) { skipped++; continue; }
    }
    let stopAt = stop, moved = false, out = null;
    for (const b of bars) {
      // Breakeven first: if the favourable move already happened on an earlier
      // bar, the stop is already at entry when this bar's high is tested.
      if (be && !moved && dn(b, entry) <= -be) { stopAt = 0; moved = true; saved++; }
      if (up(b, entry) >= stopAt) { out = -stopAt; break; }
      if (dn(b, entry) <= -target) { out = target; break; }
    }
    if (out == null) { out = ((entry - bars[bars.length - 1].c) / entry) * 100; o++; }
    else if (out > 0) w++; else l++;
    pnl += MARGIN * LEV * (out / 100) - MARGIN * LEV * FEE;
  }
  const n = paths.length - skipped;
  return { pnl, w, l, o, n, skipped, saved };
}

const fmt = r => r
  ? String(r.w).padStart(4) + String(r.l).padStart(7) + String(r.o).padStart(6) +
    ('  $' + r.pnl.toFixed(2)).padStart(11) +
    ('  $' + (r.n ? r.pnl / r.n : 0).toFixed(2)).padStart(10) +
    (r.skipped ? '   ' + r.skipped + ' skipped' : '')
  : '   untradeable at ' + LEV + 'x';

console.log(`\nPATIENCE STUDY · ${paths.length} PRIME episodes · ${LEV}x · liquidation +${LIQ.toFixed(1)}%`);
console.log(`$${MARGIN} margin · ${FEE * 100}% round-trip fees · ${WINDOW_H}h max hold\n`);

console.log('  1. WIDER STOP                    wins  losses  open    total    per trade');
for (const stop of [8, 12, 15, 18]) {
  const r = run({ target: 15, stop });
  console.log(`   target -15%  stop +${String(stop).padEnd(2)}%          ` + fmt(r));
}

console.log('\n  2. MOVE STOP TO BREAKEVEN        wins  losses  open    total    per trade');
for (const be of [3, 5, 8]) {
  const r = run({ target: 15, stop: 12, be });
  console.log(`   stop +12%, breakeven at -${String(be).padEnd(2)}%  ` + fmt(r) +
    (r ? `   (moved ${r.saved}x)` : ''));
}

console.log('\n  3. WAIT FOR CONFIRMATION         wins  losses  open    total    per trade');
for (const wait of [0, 2, 3, 5]) {
  const r = run({ target: 15, stop: 12, wait });
  console.log(`   enter ${wait ? '-' + wait + '% below flag' : 'at the flag   '}          ` + fmt(r));
}

console.log('\n  4. BEST COMBINATIONS');
const combos = [];
for (const stop of [12, 15, 18]) {
  for (const be of [0, 3, 5]) {
    for (const wait of [0, 2, 3]) {
      const r = run({ target: 15, stop, be, wait });
      if (r) combos.push({ stop, be, wait, ...r });
    }
  }
}
combos.sort((a, b) => (b.pnl / b.n) - (a.pnl / a.n));
console.log('   stop  breakeven  wait   wins  losses    total    per trade');
combos.slice(0, 6).forEach(c => console.log(
  `   +${String(c.stop).padEnd(3)}%  ${(c.be ? '-' + c.be + '%' : 'off').padEnd(9)}  ` +
  `${(c.wait ? '-' + c.wait + '%' : 'no').padEnd(5)}  ${String(c.w).padStart(4)}` +
  `${String(c.l).padStart(7)}   ${('$' + c.pnl.toFixed(2)).padStart(9)}   ` +
  `${('$' + (c.pnl / c.n).toFixed(2)).padStart(8)}`));

console.log('\n  Baseline for comparison: 5x, -15% target, +12% stop = the live setting.');
console.log('  30 episodes is thin - a winner here is a candidate, not an answer.\n');
