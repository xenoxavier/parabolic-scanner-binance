'use strict';
// Where can entry and exit actually be tightened?
//
// Tests the knobs that are testable on the 30-day backtest. Each one is a real
// setting in ParabolicShort.py or config.json, so a result here maps to a line
// we can change.
//
// Same honest rules as every other study here:
//   * First touch, bar by bar; a bar spanning both levels counts as the STOP,
//     because intrabar order is unknowable.
//   * P&L is the raw price move on a short, then leverage, minus 0.1% round trip.
//   * A stop beyond the liquidation price is skipped, not silently capped.
//
// Usage: node tuning-study.cjs [--lev=5]

const fs = require('fs');
const path = require('path');
const SCORE = require('./score.cjs');

const arg = (n, d) => {
  const a = process.argv.find(x => x.startsWith(`--${n}=`));
  return a ? Number(a.split('=')[1]) : d;
};
const LEV = arg('lev', 5);
const MARGIN = 10, FEE = 0.001;
const LIQ = (100 / LEV) * 0.95;

const CACHE = path.join(__dirname, 'data', 'study-cache-gate');
const files = fs.readdirSync(CACHE);
const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'dump-study-rows-gate.json'), 'utf8'));
const adapt = f => Object.assign({}, f, { fundingPct: f.funding });
const stack = f => SCORE.stackScore(adapt(f));
const isPrime = f => f && f.ret24 >= 30 && stack(f) >= 70;

const bySym = {};
rows.forEach(r => { (bySym[r.sym] = bySym[r.sym] || []).push(r); });
Object.values(bySym).forEach(a => a.sort((x, y) => x.ts - y.ts));

// Episodes, with the AGE of the signal at each hour inside them - that is what
// an entry-freshness filter would actually see.
const eps = [];
for (const [sym, arr] of Object.entries(bySym)) {
  let cur = null;
  for (const r of arr) {
    if (isPrime(r.f)) {
      if (cur && r.ts - cur.lastTs <= 6 * 3600000) { cur.lastTs = r.ts; cur.rows.push(r); }
      else { if (cur) eps.push(cur); cur = { sym, startTs: r.ts, lastTs: r.ts, rows: [r] }; }
    }
  }
  if (cur) eps.push(cur);
}

const paths = [];
for (const ep of eps) {
  const kf = files.find(f => f.startsWith(`k_${ep.sym}-`));
  if (!kf) continue;
  const k = JSON.parse(fs.readFileSync(path.join(CACHE, kf), 'utf8'))
    .map(x => ({ t: +x.t * 1000, h: +x.h, l: +x.l, c: +x.c }))
    .sort((a, b) => a.t - b.t);
  const i0 = k.findIndex(x => x.t >= ep.startTs);
  if (i0 < 0 || i0 + 6 >= k.length) continue;
  const fwd = k.slice(i0 + 1, i0 + 49);
  if (fwd.length < 6) continue;
  const first = ep.rows[0].f;
  paths.push({
    sym: ep.sym, entry: k[i0].c, fwd,
    stack: stack(first),
    ret24: first.ret24,
    liq: first.liqPctOfOi,
    // Hours the signal had already been PRIME when this episode began is 0 by
    // definition; freshness is tested by entering later bars instead.
    episodeHours: ep.rows.length
  });
}

const up = (b, e) => ((b.h - e) / e) * 100;
const dn = (b, e) => ((b.l - e) / e) * 100;

// One simulation. `delayH` enters that many hours after the signal, which is how
// a stale entry actually behaves. `partialAt` banks half the position early.
function run({ target = 15, stop = 15, maxH = 48, delayH = 0, partialAt = 0, filter = null }) {
  if (stop >= LIQ) return null;
  let pnl = 0, w = 0, l = 0, o = 0, skipped = 0;
  for (const p of paths) {
    if (filter && !filter(p)) { skipped++; continue; }
    let bars = p.fwd, entry = p.entry;
    if (delayH) {
      if (bars.length <= delayH) { skipped++; continue; }
      entry = bars[delayH - 1].c;      // enter at the close delayH bars later
      bars = bars.slice(delayH);
    }
    bars = bars.slice(0, maxH);
    let banked = 0, size = 1, out = null;
    for (const b of bars) {
      if (partialAt && size === 1 && dn(b, entry) <= -partialAt) {
        banked = partialAt * 0.5; size = 0.5;   // take half off at partialAt
      }
      if (up(b, entry) >= stop) { out = banked - stop * size; break; }
      if (dn(b, entry) <= -target) { out = banked + target * size; break; }
    }
    if (out == null) {
      const last = bars.length ? bars[bars.length - 1].c : entry;
      out = banked + ((entry - last) / entry) * 100 * size;
      o++;
    } else if (out > 0) w++; else l++;
    pnl += MARGIN * LEV * (out / 100) - MARGIN * LEV * FEE;
  }
  const n = paths.length - skipped;
  return { pnl, w, l, o, n, skipped, per: n ? pnl / n : 0 };
}

const fmt = r => r
  ? String(r.n).padStart(4) + String(r.w).padStart(6) + String(r.l).padStart(7) +
    ('  $' + r.pnl.toFixed(2)).padStart(10) + ('  $' + r.per.toFixed(2)).padStart(10)
  : '   untradeable';

console.log(`\nTUNING STUDY · ${paths.length} PRIME episodes · ${LEV}x · liquidation +${LIQ.toFixed(1)}%\n`);
const base = run({});
console.log('  baseline (what runs now: -15% target, +15% stop, 48h)');
console.log('                                    n  wins losses     total   per trade');
console.log('   as configured                ' + fmt(base));

console.log('\n  1. ENTRY FRESHNESS — how much does a late entry cost?');
for (const d of [0, 1, 2, 4, 8]) {
  const r = run({ delayH: d });
  console.log(`   enter ${d === 0 ? 'immediately    ' : `${d}h after the signal`}`.padEnd(32) + fmt(r));
}

console.log('\n  2. STACK SCORE — is a higher score worth waiting for?');
for (const s of [70, 80, 90, 100]) {
  const r = run({ filter: p => p.stack >= s });
  console.log(`   stack >= ${s}`.padEnd(32) + fmt(r));
}

console.log('\n  3. HOW BIG A PUMP — does the size of the run matter?');
for (const [lo, hi, lab] of [[30, 50, '30-50%'], [50, 80, '50-80%'], [80, 1e9, '80%+']]) {
  const r = run({ filter: p => p.ret24 >= lo && p.ret24 < hi });
  console.log(`   24h run ${lab}`.padEnd(32) + fmt(r));
}

console.log('\n  4. LIQUIDATIONS AT ENTRY');
for (const [lo, lab] of [[0, 'any'], [0.2, '>= 0.2% of OI'], [1, '>= 1% of OI']]) {
  const r = run({ filter: p => (p.liq || 0) >= lo });
  console.log(`   liq ${lab}`.padEnd(32) + fmt(r));
}

console.log('\n  5. TIME STOP — median time to the low is 16h');
for (const h of [12, 16, 24, 48]) {
  const r = run({ maxH: h });
  console.log(`   give up after ${h}h`.padEnd(32) + fmt(r));
}

console.log('\n  6. PARTIAL EXIT — bank half early, let the rest run');
for (const p of [0, 5, 8, 10]) {
  const r = run({ partialAt: p });
  console.log(`   ${p === 0 ? 'no partial exit' : `take half at -${p}%`}`.padEnd(32) + fmt(r));
}

console.log('\n  30 episodes. A winner here is a candidate to forward-test, not an answer.\n');
