'use strict';
// Can we capture more of the move without giving the winners back?
//
// The fixed -15% target banks 38% of the average available fall (-16.9% median).
// Everything tried so far to capture more did WORSE: holding to 48h captured 26%,
// a plain 5% trailing stop captured -2%. This tests the variants not yet tried.
//
// The key difference from the earlier trailing test: an ARMED trail. A trail that
// is live from entry whipsaws out on the constant 5% bounces. One that only
// switches on after the trade is already well ahead cannot do that - by then the
// move it would be protecting has actually happened.
//
// Same honest rules: first touch bar by bar, a bar spanning both levels counts as
// the STOP, stops beyond liquidation are skipped, 0.1% round-trip fees.
//
// Usage: node runner-study.cjs [--lev=5]

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
    .map(x => ({ t: +x.t * 1000, h: +x.h, l: +x.l, c: +x.c }))
    .sort((a, b) => a.t - b.t);
  const i0 = k.findIndex(x => x.t >= ep.startTs);
  if (i0 < 0 || i0 + 6 >= k.length) continue;
  const fwd = k.slice(i0 + 1, i0 + 49);
  if (fwd.length < 6) continue;
  paths.push({ sym: ep.sym, entry: k[i0].c, fwd });
}

const up = (b, e) => ((b.h - e) / e) * 100;   // adverse for a short
const dn = (b, e) => ((b.l - e) / e) * 100;   // favourable for a short

/**
 * target      fixed take-profit, or 0 for none
 * stop        initial stop
 * armAt       trail only switches on once price is this far in our favour
 * trailBy     once armed, exit if price retraces this much off the low
 * tightenAfterH / tightenTo   stop narrows to `tightenTo` after N hours
 * maxH        give up after this many hours
 */
function run({ target = 15, stop = 15, armAt = 0, trailBy = 0, tightenAfterH = 0, tightenTo = 0, maxH = 48 }) {
  if (stop >= LIQ) return null;
  let pnl = 0, w = 0, l = 0, o = 0;
  const caps = [];
  for (const p of paths) {
    const bars = p.fwd.slice(0, maxH);
    // Best that was ever available, to measure how much each rule captured.
    let best = 0;
    bars.forEach(b => { const d = dn(b, p.entry); if (d < best) best = d; });

    let low = p.entry, armed = false, out = null, curStop = stop;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (tightenAfterH && i >= tightenAfterH) curStop = Math.min(curStop, tightenTo);

      // Stop first - a bar spanning both levels must not be assumed favourable.
      if (up(b, p.entry) >= curStop) { out = -curStop; break; }

      if (b.l < low) low = b.l;
      const fav = ((p.entry - low) / p.entry) * 100;
      if (armAt && !armed && fav >= armAt) armed = true;

      // Armed trail: exit when price rallies trailBy off the running low.
      if (armed && trailBy) {
        const rally = ((b.h - low) / low) * 100;
        if (rally >= trailBy) { out = ((p.entry - low * (1 + trailBy / 100)) / p.entry) * 100; break; }
      }
      if (target && dn(b, p.entry) <= -target) { out = target; break; }
    }
    if (out == null) {
      const last = bars[bars.length - 1].c;
      out = ((p.entry - last) / p.entry) * 100;
      o++;
    } else if (out > 0) w++; else l++;
    pnl += MARGIN * LEV * (out / 100) - MARGIN * LEV * FEE;
    if (best < 0) caps.push((out / -best) * 100);
  }
  const med = a => a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0;
  return { pnl, w, l, o, n: paths.length, per: pnl / paths.length, capture: med(caps) };
}

const fmt = r => r
  ? String(r.w).padStart(4) + String(r.l).padStart(7) +
    ('  $' + r.pnl.toFixed(2)).padStart(10) + ('  $' + r.per.toFixed(2)).padStart(9) +
    ('  ' + r.capture.toFixed(0) + '%').padStart(9)
  : '   untradeable at this leverage';

console.log(`\nRUNNER STUDY · ${paths.length} PRIME episodes · ${LEV}x · liq +${LIQ.toFixed(1)}%`);
console.log('Median best available move: -16.9%. Current rule banks 38% of it.\n');
console.log('                                       wins losses     total  per trade   capture');
console.log('   BASELINE  -15% target, +15% stop' + fmt(run({})));

console.log('\n  A. ARMED TRAIL - only switches on once already ahead');
for (const arm of [8, 10, 12]) {
  for (const by of [3, 5]) {
    console.log(`   arm at -${arm}%, trail ${by}%`.padEnd(38) + fmt(run({ target: 0, armAt: arm, trailBy: by })));
  }
}

console.log('\n  B. ARMED TRAIL + a far target as a backstop');
for (const arm of [10, 12]) {
  for (const by of [3, 5]) {
    console.log(`   arm -${arm}%, trail ${by}%, target -25%`.padEnd(38) +
      fmt(run({ target: 25, armAt: arm, trailBy: by })));
  }
}

console.log('\n  C. BIGGER TARGET, same stop');
for (const t of [15, 20, 25, 30]) {
  console.log(`   target -${t}%`.padEnd(38) + fmt(run({ target: t })));
}

console.log('\n  D. STOP THAT TIGHTENS WITH TIME');
for (const [h, to] of [[12, 8], [12, 5], [24, 8]]) {
  console.log(`   +15% stop, tighten to +${to}% after ${h}h`.padEnd(38) +
    fmt(run({ tightenAfterH: h, tightenTo: to })));
}

console.log('\n  capture = share of the best available fall actually banked (median)');
console.log('  30 episodes. A winner here is a candidate to forward-test, not an answer.\n');
