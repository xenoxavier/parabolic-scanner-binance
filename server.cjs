'use strict';
// API + dashboard for the standalone parabolic scanner. Read-only over the
// scanner's data directory, so restarting this never disturbs scanning.

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const OUT = require('./outcomes.cjs');
const NOTIFY = require('./notify.cjs');

const PORT = parseInt(process.env.PORT || '8805', 10);
const DATA = path.join(__dirname, 'data');
const BARS = path.join(DATA, 'bars');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };

// Five timeframes of price metrics, price sparks and OI sparks per coin runs
// ~294KB gzipped, and the client only ever displays ONE of them. `tf` trims the
// payload to the selected view; the tier fields are top-level and always sent, so
// nothing that decides a tier is affected.
function trimToTf(cands, tf) {
  if (!tf) return cands;
  return cands.map(c => {
    const o = { ...c };
    if (c.tf) o.tf = { [tf]: c.tf[tf] || null };
    if (c.sparks) o.sparks = { [tf]: c.sparks[tf] || [] };
    if (c.oiSparks) o.oiSparks = { [tf]: c.oiSparks[tf] || [] };
    return o;
  });
}

function summary(tf) {
  const st = readJson(path.join(DATA, 'state.json'), { tracked: {}, candidates: [] });
  const cands = st.candidates || [];
  const live = cands.filter(c => !c.veto);
  const vetoed = cands.filter(c => c.veto);

  let pollErrors24h = 0;
  try {
    const dayAgo = Date.now() - 86400000;
    pollErrors24h = fs.readFileSync(path.join(DATA, 'events.jsonl'), 'utf8').split('\n').filter(Boolean)
      .reduce((n, l) => { try { const e = JSON.parse(l); return n + (e.type === 'poll_error' && e.ts >= dayAgo ? 1 : 0); } catch (_) { return n; } }, 0);
  } catch (_) {}

  let barFiles = 0, barRows = 0;
  try {
    for (const f of fs.readdirSync(BARS).filter(x => x.endsWith('.jsonl'))) {
      barFiles++;
      barRows += fs.readFileSync(path.join(BARS, f), 'utf8').split('\n').filter(Boolean).length;
    }
  } catch (_) {}

  let cfg = {};
  try {
    const { CONFIG } = require('./scanner.cjs');
    cfg = { source: 'binance', universeSize: CONFIG.universeSize, barMin: CONFIG.barMs / 60000,
            maxTracked: CONFIG.maxTracked, trackHours: CONFIG.trackHours,
            refreshMin: CONFIG.refreshMs / 60000, pollErrors24h };
  } catch (_) { cfg = { pollErrors24h }; }

  // Live track record, and each coin's own history, attached to its candidate so
  // a card can show "this coin has fired 4 times, 4 dumped" without a second call.
  const hist = OUT.history(path.join(DATA, 'outcomes.jsonl'));
  const rec = OUT.summarise(hist);
  const openRecs = Object.values(st.outcomes || {});
  cands.forEach(c => {
    c.record = rec.perCoin[c.base] || null;
    const o = openRecs.find(r => r.symbol === c.symbol);
    c.tracking = o ? { openedAt: o.openedAt, entry: o.entry, tier: o.tier,
                       target: o.target, stop: o.stop } : null;
  });

  const tiers = { PRIME: 0, IMMINENT: 0, DANGER: 0, WARNING: 0, QUIET: 0 };
  cands.forEach(c => { if (tiers[c.tier] != null) tiers[c.tier]++; });

  return {
    generatedAt: st.generatedAt || 0,
    config: cfg,
    // Surfaced at the top level because the dashboard banners on both: an
    // unfiltered universe means Gate's tokenized equities may be in the list.
    universeFiltered: st.universeFiltered !== false,
    pollErrors24h,
    rankedByBoth: st.rankedByBoth === true,
    outcomes: { open: openRecs.length, ...rec },
    // The most recent resolutions, newest first - the live track record as it
    // accumulates. Capped so the payload does not grow without bound.
    recentOutcomes: hist.slice(-30).reverse().map(r => ({
      base: r.base, tier: r.tier, status: r.status, pnlPct: r.pnlPct,
      maxFavPct: r.maxFavPct, maxAdvPct: r.maxAdvPct,
      hoursHeld: r.hoursHeld, closedAt: r.closedAt, seeded: !!r.seeded
    })),
    lastRefresh: st.lastRefresh || 0,
    nextRefreshAt: st.nextRefreshAt || 0,
    totals: {
      tracked: Object.keys(st.tracked || {}).length,
      candidates: cands.length,
      barFiles, barRows
    },
    tiers,
    tf: tf || null,
    candidates: trimToTf(cands, tf)
  };
}

// The scan payload carries a 72-point price series and a 48-point OI series per
// coin, so it runs ~250KB uncompressed and the dashboard refetches every 15s -
// about 59MB/hour on a phone. It gzips to roughly a tenth of that. Pretty-printing
// it was costing another third on top for whitespace nobody reads.
function sendJson(req, res, obj, status = 200) {
  const body = Buffer.from(JSON.stringify(obj));
  const accepts = String(req.headers['accept-encoding'] || '');
  const head = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (/\bgzip\b/.test(accepts)) {
    zlib.gzip(body, (err, gz) => {
      if (err) { res.writeHead(status, head); res.end(body); return; }
      head['Content-Encoding'] = 'gzip';
      head['Content-Length'] = gz.length;
      res.writeHead(status, head);
      res.end(gz);
    });
    return;
  }
  head['Content-Length'] = body.length;
  res.writeHead(status, head);
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Full closed-outcome log, for offline analysis as the sample grows.
  if (url.pathname === '/api/outcomes') {
    const hist = OUT.history(path.join(DATA, 'outcomes.jsonl'));
    sendJson(req, res, { count: hist.length, summary: OUT.summarise(hist), records: hist });
    return;
  }
  // Freqtrade RemotePairList source. Serves the scanner's own universe in the
  // format Freqtrade expects, so the bot watches exactly the coins that are
  // ranked and graded here rather than keeping a second, drifting list.
  // Optional ?tier=PRIME,IMMINENT narrows it to coins currently signalling.
  // Fire a sample alert so a new webhook can be proven before a real signal
  // arrives - otherwise the first test is a live PRIME at 3am.
  if (url.pathname === '/api/webhook-test') {
    const cfg = NOTIFY.config();
    if (!cfg.enabled || !cfg.urls.length) {
      return sendJson(req, res, { ok: false, error: 'no webhook configured', config: cfg }, 400);
    }
    const st = readJson(path.join(DATA, 'state.json'), { candidates: [] });
    const sample = (st.candidates || [])[0];
    if (!sample) return sendJson(req, res, { ok: false, error: 'no candidates yet' }, 503);
    const fake = { ...sample, tier: 'PRIME', base: sample.base + ' (TEST)' };
    let sentTo = 0;
    for (const u of cfg.urls) {
      fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                 body: JSON.stringify(NOTIFY.bodyFor(u, fake, fake.levels)),
                 signal: AbortSignal.timeout(8000) }).catch(() => {});
      sentTo++;
    }
    return sendJson(req, res, { ok: true, sentTo, tiers: cfg.tiers });
  }
  if (url.pathname === '/api/pairlist') {
    const st = readJson(path.join(DATA, 'state.json'), { candidates: [] });
    const want = String(url.searchParams.get('tier') || '').split(',').filter(Boolean);
    let list = st.candidates || [];
    if (want.length) list = list.filter(c => want.includes(c.tier));
    sendJson(req, res, {
      pairs: list.map(c => `${c.base}/USDT:USDT`),
      refresh_period: 300
    });
    return;
  }
  if (url.pathname === '/api/scan') {
    const want = String(url.searchParams.get('tf') || '');
    const ok = ['m1', 'm5', 'm15', 'h1', 'h4'].includes(want) ? want : null;
    sendJson(req, res, summary(ok));
    return;
  }
  // Recorded OHLC for one symbol, so the bars are usable from outside.
  if (url.pathname === '/api/bars') {
    const sym = String(url.searchParams.get('symbol') || '').toUpperCase();
    const f = path.join(BARS, `${sym}.jsonl`);
    if (!sym || !fs.existsSync(f)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no bars for that symbol' })); return;
    }
    const rows = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ symbol: sym, count: rows.length, bars: rows.slice(-500) }, null, 2));
    return;
  }
  // The README, so it can be read over the tailnet without a git client.
  // Raw markdown on /readme.md; /readme renders it client-side with marked so
  // there is no server-side markdown dependency to keep the scanner standalone.
  if (url.pathname === '/readme.md') {
    const f = path.join(__dirname, 'README.md');
    if (!fs.existsSync(f)) { res.writeHead(404); res.end('README.md missing'); return; }
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(f, 'utf8'));
    return;
  }
  if (url.pathname === '/readme') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Parabolic Scanner — README</title>
<style>
  body{max-width:820px;margin:0 auto;padding:28px 20px 80px;
    font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    color:#1f2328;background:#fff}
  @media (prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}
    a{color:#4493f8}code,pre{background:#161b22!important}
    table td,table th{border-color:#30363d!important}hr{background:#30363d!important}
    blockquote{color:#9198a1;border-color:#30363d!important}}
  h1,h2,h3{line-height:1.25;margin:1.6em 0 .6em;font-weight:700}
  h1{font-size:1.9em}h2{font-size:1.45em;border-bottom:1px solid #d1d9e0;padding-bottom:.3em}
  h3{font-size:1.15em}
  a{color:#0969da;text-decoration:none}a:hover{text-decoration:underline}
  code{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
    background:#f6f8fa;padding:.2em .4em;border-radius:6px}
  pre{background:#f6f8fa;padding:14px 16px;border-radius:8px;overflow:auto}
  pre code{background:none;padding:0}
  table{border-collapse:collapse;width:100%;margin:1em 0;display:block;overflow:auto}
  table td,table th{border:1px solid #d1d9e0;padding:6px 12px}
  table th{background:rgba(128,128,128,.08)}
  blockquote{margin:1em 0;padding:0 1em;color:#59636e;border-left:.25em solid #d1d9e0}
  hr{border:0;height:1px;background:#d1d9e0;margin:2em 0}
  img{max-width:100%}
</style>
<div id="md">Loading README…</div>
<script src="https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"></script>
<script>
  fetch('/readme.md').then(r=>r.text()).then(t=>{
    document.getElementById('md').innerHTML = marked.parse(t);
  }).catch(e=>{ document.getElementById('md').textContent = 'Failed to load: '+e; });
</script>`);
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const f = path.join(__dirname, 'dashboard.html');
    if (fs.existsSync(f)) {
      // no-store, or a phone browser keeps serving a cached copy of the dashboard
      // and silently hides every UI change made since it last loaded.
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache'
      });
      res.end(fs.readFileSync(f, 'utf8'));
    } else { res.writeHead(404); res.end('dashboard.html missing'); }
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => console.log(`Parabolic Scanner dashboard on http://localhost:${PORT}`));
