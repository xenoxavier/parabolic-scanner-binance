'use strict';
// Candlestick chart as a PNG, drawn for Discord alerts.
//
// Tree Capital posts a chart image when a human types `fc <coin> 1h`. We cannot
// trigger it - it ignores messages from bots, and our webhook is a bot - so we
// draw our own. The data is already here: the scanner pulls Gate klines every
// refresh anyway.
//
// Uses @napi-rs/canvas: prebuilt binaries, no cairo or system libraries to
// install, which is why it is preferred over node-canvas here.

const { createCanvas } = require('@napi-rs/canvas');

const T = {
  bg: '#0e1219',
  panel: '#131924',
  grid: '#1e2634',
  text: '#e8ecf3',
  dim: '#75839a',
  up: '#3ecf8e',
  down: '#ff6168',
  target: '#3ecf8e',
  stop: '#ff6168',
  entry: '#8b9bff',
  frame: '#2a3444'
};

const fmtPrice = v => {
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 1) return v.toFixed(3);
  if (a >= 0.01) return v.toFixed(4);
  if (a >= 0.0001) return v.toFixed(6);
  return v.toPrecision(3);
};

/**
 * candles  [{t,o,h,l,c,v}] oldest first
 * opts     { symbol, interval, tier, levels, width, height }
 * returns  PNG Buffer
 */
function render(candles, opts = {}) {
  const W = opts.width || 900;
  const H = opts.height || 480;
  const PAD = { l: 14, r: 78, t: 40, b: 26 };
  // Volume gets its own strip at the bottom rather than being drawn over the
  // price series, where it hides the candles it is supposed to explain.
  const volH = Math.round((H - PAD.t - PAD.b) * 0.18);
  const plotH = H - PAD.t - PAD.b - volH - 8;
  const plotW = W - PAD.l - PAD.r;

  const c = createCanvas(W, H);
  const x = c.getContext('2d');

  x.fillStyle = T.bg;
  x.fillRect(0, 0, W, H);

  const rows = (candles || []).filter(k => Number.isFinite(k.c));
  if (rows.length < 2) {
    x.fillStyle = T.dim;
    x.font = '16px sans-serif';
    x.fillText('not enough data', PAD.l, H / 2);
    return c.toBuffer('image/png');
  }

  // Price range includes the trade levels, so a stop sitting off-screen cannot
  // silently vanish from the picture.
  let lo = Math.min(...rows.map(k => k.l));
  let hi = Math.max(...rows.map(k => k.h));
  const L = opts.levels;
  if (L) {
    // Only the lines actually drawn widen the range; including the target would
    // stretch the axis for something no longer shown.
    for (const v of [L.entry, L.stop]) {
      if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    }
  }
  const span = (hi - lo) || hi || 1;
  lo -= span * 0.04; hi += span * 0.04;
  const yOf = p => PAD.t + plotH - ((p - lo) / (hi - lo)) * plotH;

  const maxVol = Math.max(...rows.map(k => k.v || 0), 1);
  const volY = PAD.t + plotH + 8;
  const step = plotW / rows.length;
  const bw = Math.max(1.5, Math.min(9, step * 0.62));

  // grid + right-hand price axis
  x.strokeStyle = T.grid;
  x.lineWidth = 1;
  x.font = '11px monospace';
  for (let i = 0; i <= 5; i++) {
    const p = lo + ((hi - lo) * i) / 5;
    const y = Math.round(yOf(p)) + 0.5;
    x.beginPath(); x.moveTo(PAD.l, y); x.lineTo(PAD.l + plotW, y); x.stroke();
    x.fillStyle = T.dim;
    x.fillText(fmtPrice(p), PAD.l + plotW + 7, y + 4);
  }

  // candles + volume
  rows.forEach((k, i) => {
    const cx = PAD.l + i * step + step / 2;
    const up = k.c >= k.o;
    const col = up ? T.up : T.down;

    x.strokeStyle = col;
    x.lineWidth = 1;
    x.beginPath();
    x.moveTo(Math.round(cx) + 0.5, yOf(k.h));
    x.lineTo(Math.round(cx) + 0.5, yOf(k.l));
    x.stroke();

    const yo = yOf(k.o), yc = yOf(k.c);
    const top = Math.min(yo, yc);
    const hgt = Math.max(1, Math.abs(yc - yo));
    x.fillStyle = col;
    x.fillRect(cx - bw / 2, top, bw, hgt);

    const vh = ((k.v || 0) / maxVol) * volH;
    x.globalAlpha = 0.5;
    x.fillRect(cx - bw / 2, volY + volH - vh, bw, vh);
    x.globalAlpha = 1;
  });

  // trade levels
  if (L) {
    const line = (price, colour, label) => {
      if (!Number.isFinite(price)) return;
      const y = Math.round(yOf(price)) + 0.5;
      x.save();
      x.strokeStyle = colour;
      x.setLineDash([5, 4]);
      x.lineWidth = 1.2;
      x.beginPath(); x.moveTo(PAD.l, y); x.lineTo(PAD.l + plotW, y); x.stroke();
      x.restore();
      x.fillStyle = colour;
      x.font = 'bold 10px monospace';
      const t = `${label} ${fmtPrice(price)}`;
      const w = x.measureText(t).width + 8;
      x.globalAlpha = 0.9;
      x.fillRect(PAD.l + 2, y - 13, w, 12);
      x.globalAlpha = 1;
      x.fillStyle = T.bg;
      x.fillText(t, PAD.l + 6, y - 4);
    };
    // Target line removed on request - it crowded the plot and pushed the price
    // range wider than the actual candles, squashing them. Entry and stop are
    // the two that matter while a position is open.
    line(L.entry, T.entry, 'ENTRY');
    line(L.stop, T.stop, 'STOP');
  }

  // last price marker on the axis
  const last = rows[rows.length - 1].c;
  const ly = Math.round(yOf(last)) + 0.5;
  x.fillStyle = rows[rows.length - 1].c >= rows[rows.length - 1].o ? T.up : T.down;
  x.fillRect(PAD.l + plotW + 2, ly - 8, PAD.r - 6, 16);
  x.fillStyle = T.bg;
  x.font = 'bold 11px monospace';
  x.fillText(fmtPrice(last), PAD.l + plotW + 7, ly + 4);

  // header
  x.fillStyle = T.text;
  x.font = 'bold 15px sans-serif';
  x.fillText(`${opts.symbol || ''}  ·  ${opts.interval || '1h'}  ·  GATE`, PAD.l, 22);
  if (opts.tier) {
    const tw = x.measureText(opts.tier).width;
    x.fillStyle = opts.tier === 'PRIME' ? '#8e0d18' : '#d1373c';
    x.fillRect(W - PAD.r - tw - 30, 8, tw + 18, 18);
    x.fillStyle = '#fff';
    x.font = 'bold 11px sans-serif';
    x.fillText(opts.tier, W - PAD.r - tw - 21, 21);
  }

  // time axis: a few dates along the bottom
  x.fillStyle = T.dim;
  x.font = '10px monospace';
  const marks = 5;
  for (let i = 0; i < marks; i++) {
    const idx = Math.floor((rows.length - 1) * (i / (marks - 1)));
    const d = new Date(rows[idx].t);
    const lbl = `${d.getUTCDate()}/${d.getUTCMonth() + 1} ${String(d.getUTCHours()).padStart(2, '0')}h`;
    const px = PAD.l + idx * step + step / 2;
    x.fillText(lbl, Math.min(Math.max(px - 18, PAD.l), PAD.l + plotW - 40), H - 8);
  }

  x.strokeStyle = T.frame;
  x.lineWidth = 1;
  x.strokeRect(0.5, 0.5, W - 1, H - 1);

  return c.toBuffer('image/png');
}

module.exports = { render };
