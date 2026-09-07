'use strict';
// Webhook alerts when a coin enters a high tier.
//
// Fires on ENTRY from a lower tier only - not every poll while it sits there,
// and not when PRIME decays to IMMINENT and back. One alert per episode, or the
// phone buzzes every 5 seconds and the alert stops meaning anything.
//
// Configure in data/webhooks.json (chmod 600):
//
//   {
//     "urls": ["https://discord.com/api/webhooks/..."],
//     "tiers": ["PRIME"],
//     "enabled": true,
//     "format": "text",
//     "template": "fc {base} 1h {ret1h} oi {oiChg24} funding {funding} liq {liq}"
//   }
//
// format "text"  -> one plain line built from `template` (default)
// format "card"  -> the rich Discord embed
//
// The template is deliberately user-editable: the exact wording is a personal
// preference and changing it should not need a code edit.
//
// Discord, Slack and plain JSON endpoints are all supported - the payload shape
// is chosen from the URL. Sends are fire-and-forget: a dead webhook must never
// slow down or break a scan.

const fs = require('fs');
const path = require('path');
const GATE = require('./binance.cjs'); // name kept for minimal diff; this is binance.cjs
const CHART = require('./chart.cjs');

const CFG_FILE = path.join(__dirname, 'data', 'webhooks.json');
const STATE_KEY = 'notifiedEpisodes';
// One alert per coin per hour, whatever else happens.
const COOLDOWN_MS = 60 * 60 * 1000;

// The default is a COMMAND for another bot in the channel, not a human-readable
// line: everything except the coin is literal text that bot parses as arguments.
// Only {base} is substituted. Value placeholders like {ret1h} still exist for
// anyone who wants a readable message instead.
const DEFAULT_TEMPLATE = 'fc {base} 1h % oi funding liq';

const TIER_COLOR = { PRIME: 0x8e0d18, IMMINENT: 0xd1373c, DANGER: 0xc25c14, WARNING: 0x9a7715 };

function config() {
  try {
    const c = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
    return {
      urls: Array.isArray(c.urls) ? c.urls.filter(u => /^https?:\/\//.test(u)) : [],
      tiers: Array.isArray(c.tiers) && c.tiers.length ? c.tiers : ['PRIME'],
      enabled: c.enabled !== false,
      // Attach a candlestick PNG. Tree Capital posts one when a human types
      // `fc <coin> 1h`, but it ignores messages from bots and our webhook is a
      // bot - so we draw our own from the klines the scanner already fetches.
      chart: c.chart !== false,
      chartBars: Number.isFinite(c.chartBars) ? c.chartBars : 90,
      format: ['card', 'rich', 'text'].includes(c.format) ? c.format : 'rich',
      // Webhook messages mention nobody, and Discord mobile only pushes a
      // notification for mentions - so 11 alerts were delivered and none of them
      // buzzed the phone. Anything here is prepended as `content`.
      // Use "@everyone", "@here", "<@USER_ID>" or "<@&ROLE_ID>".
      mention: typeof c.mention === 'string' ? c.mention.trim() : '',
      template: typeof c.template === 'string' && c.template.trim()
        ? c.template : DEFAULT_TEMPLATE
    };
  } catch (_) {
    return { urls: [], tiers: ['PRIME'], enabled: false, mention: '',
             chart: true, chartBars: 90,
             format: 'rich', template: DEFAULT_TEMPLATE };
  }
}

const pctStr = v => v == null ? '—' : (v >= 0 ? '+' : '') + Number(v).toFixed(1) + '%';
const usd = v => v == null ? '—'
  : v >= 1e9 ? (v / 1e9).toFixed(1) + 'B'
  : v >= 1e6 ? (v / 1e6).toFixed(1) + 'M'
  : (v / 1e3).toFixed(0) + 'K';

// Fill a template from one candidate. Unknown placeholders are left alone rather
// than blanked, so a typo in the template is visible instead of silently eaten.
function render(template, c) {
  // 1h price change comes from the 1h timeframe block; the top-level fields are
  // 4h and 24h only.
  const h1 = (c.tf && c.tf.h1) || {};
  const vals = {
    // Lowercase: the receiving bot's commands are lowercase, and it is the form
    // the user asked for.
    base: String(c.base || '').toLowerCase(),
    BASE: c.base,
    symbol: c.symbol,
    tier: c.tier,
    price: c.price,
    ret1h: pctStr(h1.chg1),
    ret4h: pctStr(c.ret4),
    ret24h: pctStr(c.ret24),
    oiChg24: pctStr(c.oiChg24),
    oiChg6: pctStr(c.oiChg6),
    oi: usd(c.oiUsd),
    funding: c.fundingPct == null ? '—' : c.fundingPct.toFixed(3) + '%',
    liq: c.liqPctOfOi == null ? '—' : c.liqPctOfOi.toFixed(2) + '%',
    liqSkew: c.liqSkew == null ? '—' : String(c.liqSkew),
    rsi: c.rsi14 == null ? '—' : String(Math.round(c.rsi14)),
    vol: usd(c.gateVol),
    offHigh: pctStr(c.distFromHigh),
    score: c.dumpScore == null ? '—' : String(c.dumpScore),
    stack: c.stackScore == null ? '—' : String(c.stackScore),
    entry: c.levels ? c.levels.entry : '—',
    target: c.levels ? c.levels.target : '—',
    stop: c.levels ? c.levels.stop : '—'
  };
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vals ? String(vals[k]) : m));
}

function line(c, template) {
  return render(template || DEFAULT_TEMPLATE, c);
}

// Full detail as PLAIN TEXT, no embed.
//
// The user's Discord mobile client does not render embeds at all - a three-way
// test (full card / minimal embed / plain text) showed only the plain-text
// message arriving. Everything the card carried is reproduced here with Discord
// markdown, which renders identically on every client.
//
// Discord caps `content` at 2000 characters; this runs ~900.
function richText(c, levels, mention) {
  const tf = c.tf || {};
  const g = k => (tf[k] || {});
  const mins = c.tierAgeSec != null ? Math.round(c.tierAgeSec / 60) : null;
  const age = mins == null ? '—' : mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60}m`;
  const since = c.changeSinceTierPct;
  const L = [];

  L.push(`${mention ? mention + ' ' : ''}**${c.tier} — ${c.base}**  \`${c.price}\``);
  L.push(`fired **${age}** ago` +
    (since == null ? '' : ` · since then **${since >= 0 ? '+' : ''}${since.toFixed(1)}%** ` +
      (since <= -1 ? 'working' : since >= 1 ? 'against us' : '')) +
    ` · score **${c.dumpScore}**/100`);
  L.push('');

  const p = v => v == null ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}%`;
  L.push(`**Price**  1h \`${p(g('h1').chg1)}\` · 4h \`${p(c.ret4)}\` · 24h \`${p(c.ret24)}\` · ` +
    `\`${p(c.distFromHigh)}\` off 7d high`);
  L.push(`**OI**  6h \`${p(c.oiChg6)}\` · 24h \`${p(c.oiChg24)}\` · total \`${usd(c.oiUsd)}\``);
  L.push(`**Liq**  1h \`${c.liqPctOfOi == null ? '—' : c.liqPctOfOi.toFixed(2) + '%'}\` of OI · ` +
    `6h \`${c.liqPctOfOi6h == null ? '—' : c.liqPctOfOi6h.toFixed(2) + '%'}\` · ` +
    (c.liqSkew == null ? '—' : c.liqSkew >= 100 ? 'longs only' : c.liqSkew === 0 ? 'shorts only'
      : c.liqSkew < 0.5 ? 'shorts squeezed' : c.liqSkew > 2 ? 'longs hit' : 'mixed'));
  L.push(`**Flow**  funding \`${c.fundingPct == null ? '—' : c.fundingPct.toFixed(3) + '%'}\` · ` +
    `taker \`${c.lsrTaker == null ? '—' : c.lsrTaker.toFixed(2)}\` · ` +
    `L/S \`${c.lsrAccount == null ? '—' : c.lsrAccount.toFixed(2)}\``);
  L.push(`**Momentum**  RSI \`${c.rsi14 == null ? '—' : Math.round(c.rsi14)}\` · ` +
    `ATR \`${c.atrPct == null ? '—' : c.atrPct.toFixed(1) + '%'}\` · ` +
    `ADX \`${c.adx == null ? '—' : Math.round(c.adx) + (c.trend ? ' ' + c.trend : '')}\` · ` +
    `vol \`${c.volSurge == null ? '—' : c.volSurge.toFixed(1) + 'x'}\``);
  const ctl = g('h1').control;
  if (ctl) L.push(`**In control**  ${ctl.who} — ${ctl.why}`);

  if (levels) {
    L.push('');
    L.push(`**If shorting**  entry \`${levels.entry}\` · target \`${levels.target}\` (−${levels.targetPct}%) · ` +
      `stop \`${levels.stop}\` (+${levels.stopPct}%)`);
    L.push(`liq 5x \`${levels.liq5x}\` · liq 10x \`${levels.liq10x}\``);
  }

  if (c.binVol != null && c.binVol < 2e6) {
    L.push('');
    L.push(`**Thin book** — only \`${usd(c.binVol)}\` on Binance in 24h. You may not be able to size into this.`);
  }
  if (c.lsrTaker != null && (c.lsrTaker < 0.85 || c.lsrTaker >= 1.2)) {
    L.push(`_Taker ${c.lsrTaker.toFixed(2)} is an extreme — measured 0.46–0.62x, dumps are LESS likely. Not scored bearish._`);
  }
  if (c.record && c.record.n) {
    L.push(`**This coin before** — fired ${c.record.n}x, ${c.record.target} hit target, ` +
      `${c.record.stop} stopped, reached −10% in ${c.record.hit10Pct}%`);
  }
  if ((c.reasons || []).length) {
    L.push('');
    L.push('**Why it fired**');
    c.reasons.slice(0, 5).forEach(r => L.push('• ' + r));
  }
  if ((c.dampeners || []).length) {
    L.push('**Arguing against**');
    c.dampeners.slice(0, 2).forEach(r => L.push('• ' + r));
  }
  return L.join('\n').slice(0, 1990);
}

function discordBody(c, levels) {
  const tf = c.tf || {};
  const g = k => (tf[k] || {});
  const mins = c.tierAgeSec != null ? Math.round(c.tierAgeSec / 60) : null;
  const age = mins == null ? '—' : mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60}m`;
  const since = c.changeSinceTierPct;
  const p = v => v == null ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}%`;

  // FIVE fields, not thirteen.
  //
  // Discord confirmed (via ?wait=true) that it stores the embed either way - the
  // 13-field version simply did not render on the user's mobile client, while
  // smaller embeds in another server did. Packing the same numbers into a few
  // multi-line fields keeps every value and makes the embed roughly a third as
  // tall.
  const fields = [
    {
      name: 'Move',
      value:
        `1h \`${p(g('h1').chg1)}\`  4h \`${p(c.ret4)}\`  24h \`${p(c.ret24)}\`\n` +
        `\`${p(c.distFromHigh)}\` off 7d high · RSI \`${c.rsi14 == null ? '—' : Math.round(c.rsi14)}\` · ` +
        `vol \`${c.volSurge == null ? '—' : c.volSurge.toFixed(1) + 'x'}\``,
      inline: false
    },
    {
      name: 'Open interest & liquidations',
      value:
        `OI 6h \`${p(c.oiChg6)}\`  24h \`${p(c.oiChg24)}\`  total \`${usd(c.oiUsd)}\`\n` +
        `liq 1h \`${c.liqPctOfOi == null ? '—' : c.liqPctOfOi.toFixed(2) + '%'}\` · ` +
        `6h \`${c.liqPctOfOi6h == null ? '—' : c.liqPctOfOi6h.toFixed(2) + '%'}\` · ` +
        (c.liqSkew == null ? '—' : c.liqSkew >= 100 ? 'longs only' : c.liqSkew === 0 ? 'shorts only'
          : c.liqSkew < 0.5 ? 'shorts squeezed' : c.liqSkew > 2 ? 'longs hit' : 'mixed'),
      inline: false
    },
    {
      name: 'Flow',
      value:
        `funding \`${c.fundingPct == null ? '—' : c.fundingPct.toFixed(3) + '%'}\` · ` +
        `taker \`${c.lsrTaker == null ? '—' : c.lsrTaker.toFixed(2)}\` · ` +
        `L/S \`${c.lsrAccount == null ? '—' : c.lsrAccount.toFixed(2)}\`` +
        (g('h1').control ? `\nin control: **${g('h1').control.who}**` : '') +
        (c.lsrTaker != null && (c.lsrTaker < 0.85 || c.lsrTaker >= 1.2)
          ? `\n_taker is an extreme — measured 0.68–0.82x, dumps LESS likely_` : ''),
      inline: false
    }
  ];

  if (levels) {
    fields.push({
      name: 'If shorting',
      value:
        `entry \`${levels.entry}\` · target \`${levels.target}\` (−${levels.targetPct}%) · ` +
        `stop \`${levels.stop}\` (+${levels.stopPct}%)\n` +
        `liq 5x \`${levels.liq5x}\` · liq 10x \`${levels.liq10x}\`` +
        (c.binVol != null && c.binVol < 2e6
          ? `\n**thin book** — only \`${usd(c.binVol)}\` on Binance in 24h` : ''),
      inline: false
    });
  }

  if ((c.reasons || []).length) {
    fields.push({
      name: 'Why it fired',
      value: c.reasons.slice(0, 5).map(r => '• ' + r).join('\n') +
        (c.record && c.record.n
          ? `\n\n_this coin fired ${c.record.n}x before · reached −10% in ${c.record.hit10Pct}%_` : ''),
      inline: false
    });
  }

  return {
    username: 'Dump Watch',
    embeds: [{
      title: `${c.tier} — ${c.base}`,
      description: `\`${c.price}\` · fired **${age}** ago` +
        (since == null ? '' : ` · since then **${since >= 0 ? '+' : ''}${since.toFixed(1)}%**`) +
        ` · score **${c.dumpScore}**`,
      color: TIER_COLOR[c.tier] || 0x4d5fd4,
      fields,
      image: { url: 'attachment://chart.png' },
      footer: { text: 'parabolic-scanner · signal only, not advice' },
      timestamp: new Date().toISOString()
    }]
  };
}

function bodyFor(url, c, levels, cfg) {
  const conf = cfg || config();
  const txt = line(c, conf.template);
  if (conf.format === 'rich' && /discord\.com|discordapp\.com/i.test(url)) {
    return { content: richText(c, levels, conf.mention),
             allowed_mentions: { parse: ['everyone', 'users', 'roles'] } };
  }
  if (conf.format === 'card' && /discord\.com|discordapp\.com/i.test(url)) {
    const body = discordBody(c, levels);
    if (conf.mention) {
      body.content = `${conf.mention} **${c.tier}** ${c.base}`;
      // Without allowed_mentions Discord silently strips @everyone/@here from
      // webhook posts, so the ping never happens and nothing says why.
      body.allowed_mentions = { parse: ['everyone', 'users', 'roles'] };
    }
    return body;
  }
  // Plain one-liner. Discord reads `content`, Slack reads `text`; sending both
  // means one config works for either without knowing which it is.
  if (/discord\.com|discordapp\.com/i.test(url)) {
    return conf.mention
      ? { content: `${conf.mention} ${txt}`,
          allowed_mentions: { parse: ['everyone', 'users', 'roles'] } }
      : { content: txt };
  }
  if (/hooks\.slack\.com/i.test(url)) return { text: txt };
  return { event: 'tier_entered', text: txt, tier: c.tier, symbol: c.symbol,
           base: c.base, price: c.price, levels: levels || null, signal: c };
}

// Post one alert, with a chart attached when we can draw one.
//
// The chart is best-effort: if Gate is slow or the render fails, the alert still
// goes out without it. An alert that never arrives because a picture failed
// would be a much worse outcome than a plain one.
async function postAlert(url, c, cfg, logEvent) {
  const body = bodyFor(url, c, c.levels, cfg);
  let png = null;
  if (cfg.chart) {
    try {
      const k = await GATE.klines(c.symbol, cfg.chartBars, '1h');
      if (k && k.length > 5) {
        png = CHART.render(k, {
          symbol: `${c.base}USDT`, interval: '1h', tier: c.tier, levels: c.levels
        });
      }
    } catch (e) {
      if (logEvent) logEvent({ type: 'chart_failed', symbol: c.symbol, error: String(e.message || e) });
    }
  }
  if (!png) {
    // No chart - strip the attachment reference or Discord shows a broken image.
    if (body.embeds && body.embeds[0]) delete body.embeds[0].image;
    return fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000)
    });
  }
  const fd = new FormData();
  fd.append('payload_json', JSON.stringify(body));
  fd.append('files[0]', new Blob([png], { type: 'image/png' }), 'chart.png');
  return fetch(url, { method: 'POST', body: fd, signal: AbortSignal.timeout(20000) });
}

// Returns the number of alerts sent. Never throws.
async function notifyEntries(state, candidates, logEvent) {
  const cfg = config();
  if (!cfg.enabled || !cfg.urls.length) return 0;
  if (!state[STATE_KEY]) state[STATE_KEY] = [];
  const seen = state[STATE_KEY];

  let sent = 0;
  for (const c of candidates) {
    if (!cfg.tiers.includes(c.tier)) continue;
    // Keyed on the episode, not the coin: a coin that goes PRIME, decays, and
    // goes PRIME again hours later is genuinely a new signal and should alert
    // again - but the same episode must never alert twice.
    const key = `${c.symbol}-${c.tierSince}`;
    if (seen.includes(key)) continue;
    // Per-coin cooldown on top of the per-episode key. Hysteresis in the scanner
    // stops most flapping, but a coin that genuinely re-enters twice in an hour
    // is still the same story and should not buzz twice.
    const last = (state.notifiedAt || {})[c.symbol];
    if (last && Date.now() - last < COOLDOWN_MS) continue;
    seen.push(key);
    if (!state.notifiedAt) state.notifiedAt = {};
    state.notifiedAt[c.symbol] = Date.now();

    for (const url of cfg.urls) {
      // Deliberately not awaited: drawing a chart takes a second or two and a
      // scan must not wait for it.
      postAlert(url, c, cfg, logEvent).then(r => {
        if (r && !r.ok && logEvent) logEvent({ type: 'webhook_failed', symbol: c.symbol, status: r.status });
      }).catch(e => {
        if (logEvent) logEvent({ type: 'webhook_failed', symbol: c.symbol, error: String(e.message || e) });
      });
    }
    sent++;
    if (logEvent) logEvent({ type: 'webhook_sent', symbol: c.symbol, tier: c.tier, urls: cfg.urls.length });
  }
  // Bounded, or state.json grows without limit.
  if (seen.length > 500) state[STATE_KEY] = seen.slice(-500);
  return sent;
}

module.exports = { notifyEntries, config, bodyFor, postAlert, line, render, richText, DEFAULT_TEMPLATE, CFG_FILE };
