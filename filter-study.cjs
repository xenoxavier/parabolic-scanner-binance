'use strict';
// Can the PRIME filter be sharpened?
//
// Runs entirely on data/dump-study-rows.json, already on disk - no exchange
// calls, so this cannot hit a rate limit.
//
// Two things prompted it:
//
//   1. `ret4 > 5%` alone measured 10.09x on the test half - HIGHER than the
//      whole PRIME rule at 9.77x. If the strongest ingredient beats the recipe,
//      the recipe is diluting it.
//
//   2. The off-high branch inside PRIME looks unstable: the -20..-10 bucket
//      scored 3.66x on train and 0.73x on test. One half says strong signal,
//      the other says worse than random.
//
// Method matches the rest of this project: odd/even symbol split, each half
// scored against ITS OWN base rate, Wilson intervals on the test half, and a
// minimum sample before any result is reported.

const fs = require('fs');
const path = require('path');

const R = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'dump-study-rows.json'), 'utf8'));
const syms = [...new Set(R.map(r => r.sym))].sort();
const inTrain = r => syms.indexOf(r.sym) % 2 === 0;
const TR = R.filter(inTrain), TE = R.filter(r => !inTrain(r));
const rate = a => a.length ? a.filter(r => r.dumped).length / a.length : 0;
const bTR = rate(TR), bTE = rate(TE);

function wilson(k, n) {
  if (!n) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [c - m, c + m];
}

const MIN_N = 40;   // below this a "lift" is just noise with a decimal point

function row(label, test) {
  const a = TR.filter(r => r.f && safe(test, r.f));
  const b = TE.filter(r => r.f && safe(test, r.f));
  if (b.length < MIN_N) {
    return console.log('   ' + label.padEnd(46) + `test n=${b.length} — too few to judge`);
  }
  const kb = b.filter(r => r.dumped).length;
  const [lo, hi] = wilson(kb, b.length);
  const lTR = rate(a) / bTR, lTE = rate(b) / bTE;
  // Both halves must agree AND the interval must clear the base rate. A single
  // impressive half is how the 13.81x claim happened.
  const solid = lo > bTE && lTR > 1;
  console.log('   ' + label.padEnd(46) +
    String(a.length).padStart(5) + ' ' + lTR.toFixed(2).padStart(6) + 'x  ' +
    String(b.length).padStart(5) + ' ' + lTE.toFixed(2).padStart(6) + 'x   [' +
    (lo * 100).toFixed(1) + '-' + (hi * 100).toFixed(1) + '%]' + (solid ? ' **' : ''));
}
const safe = (fn, f) => { try { return fn(f); } catch (_) { return false; } };

console.log(`\nFILTER STUDY · ${R.length} rows · ${syms.length} symbols`);
console.log(`base rate: train ${(bTR * 100).toFixed(2)}%  test ${(bTE * 100).toFixed(2)}%`);
const skew = Math.max(bTR / bTE, bTE / bTR);
if (skew > 1.5) {
  console.log(`WARNING: halves differ ${skew.toFixed(1)}x - cross-half agreement is weak evidence here`);
}
console.log('\n   rule                                       n(tr)   lift   n(te)   lift   95% CI (test)');

console.log('\n  ── THE CURRENT PRIME, AND ITS PARTS ──');
const cur = f => f.ret24 >= 30 && (
  (f.oiChg24 != null && f.oiChg24 > 30) ||
  (f.distFromHigh != null && f.distFromHigh < -20) ||
  (f.ret4 != null && f.ret4 > 5));
row('PRIME as shipped', cur);
row('  branch A: ret24>=30 AND oiChg24>30', f => f.ret24 >= 30 && f.oiChg24 > 30);
row('  branch B: ret24>=30 AND offHigh<-20', f => f.ret24 >= 30 && f.distFromHigh < -20);
row('  branch C: ret24>=30 AND ret4>5', f => f.ret24 >= 30 && f.ret4 > 5);
row('  the gate alone: ret24>=30', f => f.ret24 >= 30);

console.log('\n  ── DROP THE UNSTABLE OFF-HIGH BRANCH ──');
row('PRIME without branch B', f => f.ret24 >= 30 && (
  (f.oiChg24 != null && f.oiChg24 > 30) || (f.ret4 != null && f.ret4 > 5)));

console.log('\n  ── LEAD WITH ret4, THE STRONGEST FEATURE ──');
row('ret4>5 alone', f => f.ret4 > 5);
row('ret4>5 AND ret24>=30', f => f.ret4 > 5 && f.ret24 >= 30);
row('ret4>5 AND ret24>=20', f => f.ret4 > 5 && f.ret24 >= 20);
row('ret4>5 AND oiChg24>30', f => f.ret4 > 5 && f.oiChg24 > 30);
row('ret4>5 AND oiChg6>5', f => f.ret4 > 5 && f.oiChg6 > 5);
row('ret4>5 AND rsi>=70', f => f.ret4 > 5 && f.rsi14 >= 70);
row('ret4>8 alone', f => f.ret4 > 8);
row('ret4>10 alone', f => f.ret4 > 10);

console.log('\n  ── OPEN INTEREST COMBINATIONS ──');
row('oiChg24>30 alone', f => f.oiChg24 > 30);
row('oiChg24>30 AND ret24>=20', f => f.oiChg24 > 30 && f.ret24 >= 20);
row('|oiChg6|>5 AND ret24>=20', f => Math.abs(f.oiChg6) > 5 && f.ret24 >= 20);
row('oiChg6>5 AND ret4>5', f => f.oiChg6 > 5 && f.ret4 > 5);

console.log('\n  ── ADDING A THIRD CONDITION TO THE BEST PAIR ──');
row('ret4>5 + ret24>=30 + rsi>=70', f => f.ret4 > 5 && f.ret24 >= 30 && f.rsi14 >= 70);
row('ret4>5 + ret24>=30 + volSurge>2', f => f.ret4 > 5 && f.ret24 >= 30 && f.volSurge > 2);
row('ret4>5 + ret24>=30 + funding>0.01', f => f.ret4 > 5 && f.ret24 >= 30 && f.funding > 0.01);
row('ret4>5 + ret24>=30 + oiChg24>10', f => f.ret4 > 5 && f.ret24 >= 30 && f.oiChg24 > 10);

console.log('\n  ** = test interval clears the base rate AND train agrees');
console.log(`  anything under n=${MIN_N} on the test half is not reported as a result\n`);
