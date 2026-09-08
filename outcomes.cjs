'use strict';
// Live outcome tracking.
//
// Every rule in this scanner rests on 30 episodes from a 30-day backtest across
// 39 coins. That sample is too small to resolve the questions that actually
// matter - does the +$0.53/trade hold, which coins are reliable, does stop
// distance matter - and no extra field on a card fixes that. This does: it
// records what really happens after each signal, on the live 150-coin universe,
// so in a month the answers come from measurement instead of assumption.
//
// A record opens when a coin ENTERS a tracked tier from a lower one, follows the
// price every poll, and closes on target, stop, or timeout. Closed records append
// to data/outcomes.jsonl and are never rewritten.
//
// Honest limits, so nobody over-reads the numbers later:
//   * The path is sampled at the poll interval (~30s), not tick by tick. A wick
//     that touches a level between two polls is invisible here, which biases the
//     record slightly towards NOT hitting levels.
//   * Prices are Gate `last`, so this measures the signal, not a fill. Real
//     execution pays spread and slippage on top - worse on the thin books that
//     make up half the signalling set.
//   * One open record per symbol. A coin that re-enters a tier while already
//     tracked does not open a second position.

const fs = require('fs');
const path = require('path');

const TRACK_TIERS = ['PRIME', 'IMMINENT'];
const RANK = { QUIET: 0, WARNING: 1, DANGER: 2, IMMINENT: 3, PRIME: 4 };

const CFG = {
  targetPct: 15,     // matches levelsFor() in scanner.cjs
  // Widened from 12% on 2026-09-04. patience-study.cjs over 30 backtest episodes:
  // +12% -> 14W/14L +$0.53/trade, +15% -> 16W/12L +$0.83, +18% -> 16W/11L +$0.34.
  // It matches the live failure mode too: 4 of the first 5 PRIME losses went 3-6%
  // our way before reversing into the stop - shaken out, not proven wrong.
  // Caveat kept next to the number: ~20 configs tested on 30 episodes, and $0.30
  // a trade is inside the noise for that sample.
  stopPct: 15,
  maxHours: 48,

  // Invalidation ladder. Measured over 46 PRIME episodes on the Gate cache, first
  // touch, a bar spanning both levels counted as the stop. Once price has gone X%
  // AGAINST the short, the chance it still reaches the -15% target:
  //
  //     adverse   episodes   still reach target
  //       +0         46           55%
  //       +3         37           43%
  //       +5         33           35%
  //      +10         30           31%
  //      +12         22            9%   <- 20 of 22 went on to stop out
  //
  // The odds sit flat between +5 and +10, then fall off a cliff at +12. So two
  // stages and no more: one that says the edge has halved, one that says it is
  // gone with three points still left before the stop fires.
  //
  // Caveat kept next to the number: the +12 figure rests on 22 episodes with 2
  // recoveries. The true rate is somewhere under 28%, not exactly 9%. Treat +12
  // as roughly where a signal dies, not as a precise level.
  weakenPct: 5,
  cancelPct: 12
};

// Stage of an open record, from how far price has moved against it. Ordered, so
// a record can only ever move forward through them.
const STAGES = ['open', 'weakening', 'cancel'];
function stageFor(advPct) {
  if (advPct >= CFG.cancelPct) return 'cancel';
  if (advPct >= CFG.weakenPct) return 'weakening';
  return 'open';
}

function ensure(state) {
  if (!state.outcomes) state.outcomes = {};
  // Ids of signals already written to the log. Without this an adopted record
  // that closes is adopted AGAIN on the next poll - the coin is still in the
  // tier and no longer in the open map - producing an endless stream of
  // duplicate closes for one signal.
  if (!state.outcomeDone) state.outcomeDone = [];
  return state.outcomes;
}

function markDone(state, id) {
  ensure(state);
  if (!state.outcomeDone.includes(id)) state.outcomeDone.push(id);
  // Bounded: only recent ids matter, since a track older than maxHours can no
  // longer be re-adopted anyway.
  if (state.outcomeDone.length > 500) state.outcomeDone = state.outcomeDone.slice(-500);
}

// Open a record when a coin enters a tracked tier from below. Returns the record
// or null if nothing opened.
function onTier(state, { symbol, base, tier, prevTier, price, score, stackScore, snap, now }) {
  const open = ensure(state);
  if (!TRACK_TIERS.includes(tier)) return null;
  // Entering from below only. A PRIME that decays to IMMINENT must not open a
  // second record - it is the same event, and counting it twice would inflate
  // both the sample size and any coin's apparent hit rate.
  if (prevTier && RANK[prevTier] >= RANK[tier]) return null;
  if (open[symbol]) return null;
  if (!price) return null;

  const rec = {
    id: `${symbol}-${now}`,
    symbol, base, tier,
    openedAt: now,
    entry: price,
    score: score ?? null,
    stackScore: stackScore ?? null,
    snap: snap || null,
    target: price * (1 - CFG.targetPct / 100),
    stop: price * (1 + CFG.stopPct / 100),
    // Stamped per record. The stop was widened 12% -> 15% mid-flight, and without
    // this the log would blend two different rules into one average.
    targetPct: CFG.targetPct, stopPct: CFG.stopPct,
    lowest: price, highest: price,
    lowestAt: now, highestAt: now,
    samples: 0,
    status: 'open'
  };
  open[symbol] = rec;
  return rec;
}

// Adopt signals that were already live when the process started.
//
// Records normally open on a tier ENTRY, so a restart would silently skip every
// coin mid-signal - on a busy day that is most of them, and the sample would take
// weeks to build. The track already knows the true entry price and time, so the
// record is accurate in those, but `seeded` marks it because maxFav/maxAdv only
// begin accumulating from adoption: anything the price did before that is
// invisible, which understates the best excursion. Exclude seeded records when
// measuring how much of a move a signal captured.
// `snapshotFor(symbol)` supplies the feature snapshot for an adopted record.
// Without it, every seeded record carried `snap: null` - and since a third of the
// first day's sample was seeded, including the ONLY winner, there was nothing to
// compare winners against losers with. A snapshot taken at adoption is not the
// same as one taken at the tier change (the coin has already moved), so it is
// marked `snapAtAdoption` and must not be mixed with entry snapshots when
// measuring what a signal looked like when it fired.
function adopt(state, tracked, now, snapshotFor) {
  const open = ensure(state);
  const made = [];
  for (const [symbol, tr] of Object.entries(tracked || {})) {
    if (!TRACK_TIERS.includes(tr.tier)) continue;
    if (open[symbol] || !tr.priceAtTier || !tr.tierSince) continue;
    const age = (now - tr.tierSince) / 3600000;
    if (age >= CFG.maxHours) continue;          // already past its window
    const id = `${symbol}-${tr.tierSince}`;
    if (state.outcomeDone.includes(id)) continue;   // already resolved once
    const entry = tr.priceAtTier;
    // If the price is ALREADY beyond target or stop, this signal resolved before
    // tracking began. Adopting it would record an outcome we never observed -
    // instantly "stopped" at a loss that happened in the past - and quietly
    // poison the live sample this whole file exists to build.
    const movedUp = ((tr.price - entry) / entry) * 100;
    const movedDn = ((entry - tr.price) / entry) * 100;
    if (!(movedUp < CFG.stopPct && movedDn < CFG.targetPct)) { markDone(state, id); continue; }
    open[symbol] = {
      id,
      symbol, base: symbol.replace(/USDT$/, ''),
      tier: tr.tier, openedAt: tr.tierSince, entry,
      score: tr.scoreAtTier ?? null, stackScore: null,
      snap: (typeof snapshotFor === 'function' ? snapshotFor(symbol) : null) || null,
      snapAtAdoption: true,
      target: entry * (1 - CFG.targetPct / 100),
      stop: entry * (1 + CFG.stopPct / 100),
      targetPct: CFG.targetPct, stopPct: CFG.stopPct,
      lowest: tr.price || entry, highest: tr.price || entry,
      lowestAt: now, highestAt: now,
      samples: 0, seeded: true, status: 'open'
    };
    made.push(open[symbol]);
  }
  return made;
}

// Advance every open record with the latest price. Returns records that closed.
function onPrice(state, priceOf, now, appendFile) {
  const open = ensure(state);
  const closed = [];
  const staged = [];
  for (const [symbol, rec] of Object.entries(open)) {
    const price = priceOf[symbol];
    if (!price) continue;
    rec.samples++;
    if (price < rec.lowest) { rec.lowest = price; rec.lowestAt = now; }
    if (price > rec.highest) { rec.highest = price; rec.highestAt = now; }

    // Stage is driven by the running HIGH, not the current price. A signal that
    // spiked to +13% and eased back to +8% has already been through the cliff -
    // letting it fall back to "weakening" would re-alert on the way up again.
    const advPct = ((rec.highest - rec.entry) / rec.entry) * 100;
    const next = stageFor(advPct);
    if (STAGES.indexOf(next) > STAGES.indexOf(rec.stage || 'open')) {
      rec.stage = next;
      rec.stageAt = now;
      rec.stageAdvPct = +advPct.toFixed(2);
      staged.push(rec);
    }

    const hours = (now - rec.openedAt) / 3600000;
    // Stop is checked FIRST. Between two polls the order of touches is unknowable,
    // and assuming the good one is how a backtest invents money it never made.
    let status = null, exit = null;
    if (rec.highest >= rec.stop) { status = 'stop'; exit = rec.stop; }
    else if (rec.lowest <= rec.target) { status = 'target'; exit = rec.target; }
    else if (hours >= CFG.maxHours) { status = 'expired'; exit = price; }
    if (!status) continue;

    rec.status = status;
    rec.closedAt = now;
    rec.exitPrice = exit;
    rec.hoursHeld = +hours.toFixed(2);
    // Short: profit when price falls.
    rec.pnlPct = +(((rec.entry - exit) / rec.entry) * 100).toFixed(3);
    rec.maxFavPct = +(((rec.entry - rec.lowest) / rec.entry) * 100).toFixed(3);
    rec.maxAdvPct = +(((rec.highest - rec.entry) / rec.entry) * 100).toFixed(3);
    rec.hoursToLow = +((rec.lowestAt - rec.openedAt) / 3600000).toFixed(2);
    // What the -10% study threshold would have called it, so live results stay
    // comparable with the backtest that produced the rules.
    rec.hit10 = rec.maxFavPct >= 10;

    delete open[symbol];
    markDone(state, rec.id);
    closed.push(rec);
    // A record that closes on this same poll is reported as closed, not as a
    // stage change - one event, one alert.
    const i = staged.indexOf(rec);
    if (i >= 0) staged.splice(i, 1);
    try { appendFile(JSON.stringify(rec) + '\n'); } catch (_) {}
  }
  // Kept as a property so existing callers that treat the return as an array of
  // closed records keep working unchanged.
  closed.staged = staged;
  return closed;
}

// Read the closed log. Small enough to re-read per request for a long while:
// at ~3 signals a day this is a few thousand lines a year.
function history(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

function summarise(recs) {
  const done = recs.filter(r => r.status !== 'open');
  const by = key => {
    const g = {};
    for (const r of done) { const k = r[key]; (g[k] = g[k] || []).push(r); }
    return g;
  };
  const stat = a => {
    if (!a.length) return null;
    const t = a.filter(r => r.status === 'target').length;
    const s = a.filter(r => r.status === 'stop').length;
    const e = a.filter(r => r.status === 'expired').length;
    const pnl = a.reduce((x, r) => x + (r.pnlPct || 0), 0);
    const favs = a.map(r => r.maxFavPct).filter(Number.isFinite).sort((x, y) => x - y);
    return {
      n: a.length, target: t, stop: s, expired: e,
      hit10: a.filter(r => r.hit10).length,
      hit10Pct: +(a.filter(r => r.hit10).length / a.length * 100).toFixed(1),
      winPct: +(t / a.length * 100).toFixed(1),
      totalPnlPct: +pnl.toFixed(2),
      avgPnlPct: +(pnl / a.length).toFixed(2),
      medMaxFavPct: favs.length ? favs[Math.floor(favs.length / 2)] : null
    };
  };
  const perTier = {}, perCoin = {}, perRule = {};
  for (const [k, v] of Object.entries(by('stopPct'))) perRule['stop+' + k + '%'] = stat(v);
  for (const [k, v] of Object.entries(by('tier'))) perTier[k] = stat(v);
  for (const [k, v] of Object.entries(by('base'))) perCoin[k] = stat(v);
  return { overall: stat(done), perTier, perCoin, perRule, closed: done.length };
}

module.exports = { CFG, TRACK_TIERS, STAGES, stageFor, onTier, adopt, onPrice, history, summarise, ensure, markDone };
