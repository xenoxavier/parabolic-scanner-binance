'use strict';
// Validates the FULL grade() function - tiers, hysteresis-free single-poll
// grades, dampeners, everything - against the raw rows dump-study.cjs
// already collected and saved. The earlier study only measured individual
// features in isolation; this checks what the actual combined tier logic
// would have produced, and what really happened afterward. Same odd/even
// symbol train/test split as the original study, so this is not scored on
// data it was built from.

const fs = require('fs');
const path = require('path');
const SCORE = require('./score.cjs');

const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'dump-study-rows.json'), 'utf8'));

function toFeatures(r) {
  return {
    ret4: r.f.ret4, ret24: r.f.ret24, oiChg6: r.f.oiChg6, oiChg24: r.f.oiChg24,
    rsi14: r.f.rsi14, volSurge: r.f.volSurge, distFromHigh: r.f.distFromHigh,
    lsrTaker: r.f.taker, fundingPct: r.f.funding
  };
}

const graded = rows.map(r => ({ ...r, tier: SCORE.grade(toFeatures(r)).tier }));

const symList = [...new Set(graded.map(r => r.sym))].sort();
const inTrain = r => symList.indexOf(r.sym) % 2 === 0;
const tr = graded.filter(inTrain), te = graded.filter(r => !inTrain(r));
const rate = a => a.length ? a.filter(r => r.dumped).length / a.length : 0;
const baseTr = rate(tr), baseTe = rate(te);

function wilson(k, n) {
  if (!n) return [0, 0];
  const p = k / n, z = 1.96, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const m = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, c - m), Math.min(1, c + m)];
}

console.log(`\nFULL grade() VALIDATION - the joint combination, not isolated features`);
console.log(`base rate: train ${(baseTr * 100).toFixed(2)}% / test ${(baseTe * 100).toFixed(2)}%\n`);
console.log('tier      n(train)  rate    lift    n(test)  rate    lift   95% CI (test)');

const RANK = { PRIME: 4, IMMINENT: 3, DANGER: 2, WARNING: 1, QUIET: 0 };
for (const tier of ['PRIME', 'IMMINENT', 'DANGER', 'WARNING', 'QUIET']) {
  const trT = tr.filter(r => r.tier === tier), teT = te.filter(r => r.tier === tier);
  if (!trT.length && !teT.length) continue;
  const pTr = rate(trT), pTe = rate(teT);
  const [lo, hi] = wilson(teT.filter(r => r.dumped).length, teT.length);
  const mark = teT.length >= 50 && lo > baseTe ? '  ** clears base' : '';
  console.log(
    `${tier.padEnd(9)} ${String(trT.length).padStart(7)}  ${(pTr * 100).toFixed(2).padStart(5)}%  ${(pTr / (baseTr || 1)).toFixed(2).padStart(5)}x  ` +
    `${String(teT.length).padStart(6)}  ${(pTe * 100).toFixed(2).padStart(5)}%  ${(pTe / (baseTe || 1)).toFixed(2).padStart(5)}x  ` +
    `[${(lo * 100).toFixed(1)}-${(hi * 100).toFixed(1)}%]${mark}`
  );
}
console.log('\n** = test-half lower CI bound clears the test base rate (n>=50)\n');

// Also: does PRIME/IMMINENT actually rank ABOVE DANGER/WARNING in real dump
// rate, i.e. is the tier ordering itself correct, not just "elevated vs base"?
console.log('Monotonicity check (does higher tier = higher real dump rate, test half):');
const order = ['QUIET', 'WARNING', 'DANGER', 'IMMINENT', 'PRIME'];
let prev = null;
for (const t of order) {
  const p = rate(te.filter(r => r.tier === t));
  const n = te.filter(r => r.tier === t).length;
  const cmp = prev == null ? '' : (p >= prev ? '  OK (>= previous)' : '  *** OUT OF ORDER');
  console.log(`  ${t.padEnd(9)} n=${String(n).padStart(6)}  ${(p * 100).toFixed(2)}%${cmp}`);
  prev = p;
}
