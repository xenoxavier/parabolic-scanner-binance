'use strict';
// Indicators computed from the scanner's own recorded OHLC bars.
//
// These could not exist in the previous scanner: it stored only `price`, and ATR,
// ADX and Stochastic all need high/low. That gap is why evaluating an external
// strategy previously required fetching Binance klines separately.
//
// Wilder's smoothing (RMA) is used throughout, matching what TradingView's ta.atr
// and ta.dmi do, so numbers here line up with a chart rather than drifting from it.

// Wilder's moving average: first value is a simple mean, then recursive.
function rma(values, n) {
  if (values.length < n) return null;
  let acc = 0;
  for (let i = 0; i < n; i++) acc += values[i];
  let prev = acc / n;
  for (let i = n; i < values.length; i++) prev = (prev * (n - 1) + values[i]) / n;
  return prev;
}

// True Range series. Needs the previous close, so bar 0 falls back to high-low.
function trueRanges(bars) {
  const tr = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (i === 0) { tr.push(b.h - b.l); continue; }
    const pc = bars[i - 1].c;
    tr.push(Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)));
  }
  return tr;
}

// ATR in price terms, plus as a percentage of price - the percentage is what
// matters for sizing a stop, since it is comparable across coins.
function atr(bars, n = 14) {
  if (!Array.isArray(bars) || bars.length < n + 1) return null;
  const v = rma(trueRanges(bars), n);
  if (v == null) return null;
  const last = bars[bars.length - 1].c;
  return { atr: +v.toFixed(10), atrPct: last ? +((v / last) * 100).toFixed(3) : null };
}

// ta.dmi(len, len) -> +DI, -DI, ADX. ADX needs roughly 2n bars before it settles,
// so this returns null until there are enough rather than emitting a noisy value.
function adx(bars, n = 14) {
  if (!Array.isArray(bars) || bars.length < n * 2 + 1) return null;
  const plusDM = [], minusDM = [];
  for (let i = 0; i < bars.length; i++) {
    if (i === 0) { plusDM.push(0); minusDM.push(0); continue; }
    const up = bars[i].h - bars[i - 1].h;
    const dn = bars[i - 1].l - bars[i].l;
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
  }
  const tr = trueRanges(bars);

  // Walk the smoothed series so a DX history exists to average into ADX.
  const dx = [];
  let trR = null, pR = null, mR = null;
  for (let i = 0; i < bars.length; i++) {
    if (i === n - 1) {
      trR = tr.slice(0, n).reduce((a, b) => a + b, 0) / n;
      pR = plusDM.slice(0, n).reduce((a, b) => a + b, 0) / n;
      mR = minusDM.slice(0, n).reduce((a, b) => a + b, 0) / n;
    } else if (i >= n) {
      trR = (trR * (n - 1) + tr[i]) / n;
      pR = (pR * (n - 1) + plusDM[i]) / n;
      mR = (mR * (n - 1) + minusDM[i]) / n;
    } else continue;
    if (!trR) { dx.push(0); continue; }
    const pdi = 100 * pR / trR, mdi = 100 * mR / trR;
    dx.push((pdi + mdi) === 0 ? 0 : 100 * Math.abs(pdi - mdi) / (pdi + mdi));
  }
  if (dx.length < n) return null;
  const adxVal = rma(dx, n);
  if (adxVal == null) return null;

  const pdi = 100 * pR / trR, mdi = 100 * mR / trR;
  return {
    adx: +adxVal.toFixed(2),
    plusDI: +pdi.toFixed(2),
    minusDI: +mdi.toFixed(2),
    // Which side is in control, and is the trend strong enough to be worth naming.
    trend: adxVal < 20 ? 'ranging' : (pdi > mdi ? 'up' : 'down'),
    strong: adxVal >= 25
  };
}

// Realised volatility over the last n bars, annualised-ish but left per-bar so it
// stays interpretable next to atrPct.
function volatility(bars, n = 20) {
  if (!Array.isArray(bars) || bars.length < n + 1) return null;
  const rets = [];
  for (let i = bars.length - n; i < bars.length; i++) {
    const prev = bars[i - 1].c;
    if (prev) rets.push(Math.log(bars[i].c / prev));
  }
  if (rets.length < 2) return null;
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varr = rets.reduce((a, r) => a + (r - m) ** 2, 0) / (rets.length - 1);
  return +(Math.sqrt(varr) * 100).toFixed(3);
}

// Wilder RSI, matching TradingView's ta.rsi. Wilder smoothing (not a simple
// mean) is what makes the >= 80 reading here mean the same thing as the >= 80
// that measured 2.32x in the dump study.
function rsi(bars, n = 14) {
  if (!Array.isArray(bars) || bars.length < n + 1) return null;
  const closes = bars.map(b => (typeof b === 'number' ? b : b.c)).filter(Number.isFinite);
  if (closes.length < n + 1) return null;
  const gains = [], losses = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(Math.max(0, d));
    losses.push(Math.max(0, -d));
  }
  const g = rma(gains, n), l = rma(losses, n);
  if (g == null || l == null) return null;
  if (l === 0) return 100;
  return +(100 - 100 / (1 + g / l)).toFixed(2);
}

// Everything at once, with a `bars` count so a caller can tell "not enough data
// yet" apart from "computed and genuinely null".
function compute(bars, { atrLen = 14, adxLen = 14, volLen = 20, rsiLen = 14 } = {}) {
  const a = atr(bars, atrLen);
  const d = adx(bars, adxLen);
  return {
    bars: Array.isArray(bars) ? bars.length : 0,
    needBars: { atr: atrLen + 1, adx: adxLen * 2 + 1, vol: volLen + 1, rsi: rsiLen + 1 },
    atr: a ? a.atr : null,
    atrPct: a ? a.atrPct : null,
    adx: d ? d.adx : null,
    plusDI: d ? d.plusDI : null,
    minusDI: d ? d.minusDI : null,
    trend: d ? d.trend : null,
    adxStrong: d ? d.strong : null,
    volPct: volatility(bars, volLen),
    rsi: rsi(bars, rsiLen)
  };
}

module.exports = { rma, trueRanges, atr, adx, volatility, rsi, compute };
