var express = require('express');
var https = require('https');
var http = require('http');
var Anthropic = require('@anthropic-ai/sdk');
var { neon } = require('@neondatabase/serverless');

var app = express();
var PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));

var RENDER_SERVICE_ID = 'srv-d6h2rt56ubrc73duanfg';
var GITHUB_OWNER = 'BrianBMorgan';
var GITHUB_REPO = 'ForgeOS';
var FORGEOS_HOST = 'forge-os.ai';

var CONTEXT_PACK_PROMPT = `Update the Forge context pack. Do NOT rewrite the entire file.

Steps:
1. github_read Forge_context_pack.json to get the current file
2. Add a new entry to session_log[] for today
3. Update recent_changes with new commits
4. Increment meta.version and set meta.updated to today
5. github_write the updated file back

Never regenerate from scratch. Always append.`;

// ── Anthropic + DB init ────────────────────────────────────────────────────────
var anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
var sql = process.env.NEON_DATABASE_URL ? neon(process.env.NEON_DATABASE_URL) : null;
var MC_SESSION = 'mission-control-main';

(async function initSchema() {
  if (!sql) return;
  try {
    await sql`CREATE TABLE IF NOT EXISTS mc_conversations (
      id SERIAL PRIMARY KEY,
      session_id VARCHAR(255) NOT NULL,
      role VARCHAR(20) NOT NULL,
      content TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )`;
  } catch(e) { console.error('[mc] schema:', e.message); }
})();

var MC_SYSTEM_PROMPT = `You are Mission Control — the ForgeOS system administrator.

You have one job: help Brian manage and understand the ForgeOS platform. You are not a builder. You are not a workspace agent. You do not build apps. You monitor, diagnose, repair, and advise.

You have full access to the ForgeOS GitHub repo, the Neon database, Render API, and ForgeOS live endpoints. GITHUB_TOKEN, RENDER_API_KEY, NEON_DATABASE_URL, and ANTHROPIC_API_KEY are available in process.env.

Answer questions directly. Diagnose problems. When you need to read a file, use the GitHub raw API. When you need to push a fix, use the GitHub contents API. You are the administrator. That is your entire identity.`;

async function getMcHistory() {
  if (!sql) return [];
  try {
    const rows = await sql`SELECT role, content FROM mc_conversations WHERE session_id = ${MC_SESSION} ORDER BY created_at ASC LIMIT 30`;
    return rows.map(r => ({ role: r.role, content: r.content }));
  } catch { return []; }
}

async function saveMcMessage(role, content) {
  if (!sql) return;
  try {
    await sql`INSERT INTO mc_conversations (session_id, role, content, created_at) VALUES (${MC_SESSION}, ${role}, ${content}, ${Date.now()})`;
  } catch(e) { console.error('[mc] save:', e.message); }
}

// ── Helper: HTTP/HTTPS fetch with timeout ─────────────────────────────────────
function fetchUrl(options, body, timeoutMs) {
  timeoutMs = timeoutMs || 8000;
  return new Promise(function(resolve, reject) {
    var lib = (options.protocol === 'http:' || options.hostname === 'localhost') ? http : https;
    var req = lib.request(options, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() });
      });
    });
    var timer = setTimeout(function() {
      req.destroy();
      reject(new Error('Request timed out after ' + timeoutMs + 'ms'));
    }, timeoutMs);
    req.on('error', function(e) {
      clearTimeout(timer);
      reject(e);
    });
    req.on('close', function() { clearTimeout(timer); });
    if (body) req.write(body);
    req.end();
  });
}

// ── Diagnostic: raw Render API response ──────────────────────────────────────
app.get('/api/debug/render', function(req, res) {
  var key = process.env.RENDER_API_KEY || '';
  if (!key) return res.json({ ok: false, error: 'RENDER_API_KEY not set' });
  fetchUrl({
    hostname: 'api.render.com',
    path: '/v1/services/' + RENDER_SERVICE_ID,
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + key, 'Accept': 'application/json' }
  }, null, 10000).then(function(r) {
    var parsed = null;
    try { parsed = JSON.parse(r.body); } catch(e) {}
    res.json({ httpStatus: r.status, rawBody: r.body.slice(0, 2000), parsed: parsed });
  }).catch(function(e) {
    res.json({ ok: false, error: e.message });
  });
});

// ── Dashboard: System Status ──────────────────────────────────────────────────
app.get('/api/dashboard/status', function(req, res) {
  res.set('Cache-Control', 'no-store');

  var checks = {
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    github: !!process.env.GITHUB_TOKEN,
    render: !!process.env.RENDER_API_KEY,
    neon: !!process.env.NEON_DATABASE_URL
  };

  var renderKey = process.env.RENDER_API_KEY || '';
  var renderPromise = renderKey
    ? fetchUrl({
        hostname: 'api.render.com',
        path: '/v1/services/' + RENDER_SERVICE_ID,
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + renderKey, 'Accept': 'application/json' }
      }, null, 10000).then(function(r) {
        console.log('[status] Render HTTP:', r.status, 'body length:', r.body.length);
        if (r.status === 200) {
          var parsed = {};
          try { parsed = JSON.parse(r.body); } catch(e) { console.error('[status] Render JSON parse error:', e.message); }
          console.log('[status] suspended:', parsed.suspended);

          var topSuspended = parsed.suspended;
          var name = parsed.name || 'ForgeOS';
          var updatedAt = parsed.updatedAt || null;

          var state;
          if (topSuspended === 'suspended') {
            state = 'suspended';
          } else if (topSuspended === 'not_suspended') {
            var sdStatus = parsed.serviceDetails && parsed.serviceDetails.status;
            state = sdStatus || 'live';
          } else {
            state = 'unknown';
          }

          console.log('[status] resolved state:', state);
          return { state: state, name: name, updatedAt: updatedAt };
        }
        console.error('[status] Render non-200:', r.status);
        return { state: 'error', name: 'ForgeOS', updatedAt: null };
      }).catch(function(e) {
        console.error('[status] render error:', e.message);
        return { state: 'unreachable', name: 'ForgeOS', updatedAt: null };
      })
    : Promise.resolve({ state: 'no-key', name: 'ForgeOS', updatedAt: null });

  var forgePromise = new Promise(function(resolve) {
    var start = Date.now();
    fetchUrl({
      hostname: FORGEOS_HOST,
      path: '/api/health',
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    }, null, 5000).then(function(r) {
      resolve({ alive: r.status === 200, latencyMs: Date.now() - start });
    }).catch(function() {
      resolve({ alive: false, latencyMs: null });
    });
  });

  Promise.all([renderPromise, forgePromise]).then(function(results) {
    res.json({
      ok: true,
      credentials: checks,
      render: results[0],
      forge: results[1],
      timestamp: new Date().toISOString()
    });
  });
});

// ── Dashboard: Recent Builds (GitHub commits) ─────────────────────────────────
app.get('/api/dashboard/builds', function(req, res) {
  res.set('Cache-Control', 'no-store');
  var token = process.env.GITHUB_TOKEN || '';

  var ghHeaders = {
    'User-Agent': 'mission-control/3.0',
    'Accept': 'application/vnd.github.v3+json'
  };
  if (token) {
    ghHeaders['Authorization'] = 'token ' + token;
  }

  console.log('[builds] fetching GitHub commits, token:', token ? 'present' : 'absent');

  fetchUrl({
    hostname: 'api.github.com',
    path: '/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/commits?per_page=20',
    method: 'GET',
    headers: ghHeaders
  }, null, 10000).then(function(r) {
    console.log('[builds] GitHub status:', r.status, 'body len:', r.body.length);
    if (r.status === 403 || r.status === 429) {
      var rateSuffix = r.status === 403 ? ' (rate limit \u2014 add GITHUB_TOKEN)' : ' (rate limited)';
      return res.json({ ok: false, error: 'GitHub ' + r.status + rateSuffix, builds: [] });
    }
    if (r.status === 401) {
      return res.json({ ok: false, error: 'GitHub 401 \u2014 token invalid or missing', builds: [] });
    }
    if (r.status !== 200) {
      return res.json({ ok: false, error: 'GitHub responded ' + r.status, builds: [] });
    }
    var commits = [];
    try { commits = JSON.parse(r.body); } catch(e) {
      console.error('[builds] JSON parse error:', e.message);
      return res.json({ ok: false, error: 'Parse error: ' + e.message, builds: [] });
    }
    if (!Array.isArray(commits)) {
      console.error('[builds] unexpected shape:', typeof commits, Object.keys(commits || {}));
      return res.json({ ok: false, error: 'Unexpected response shape from GitHub', builds: [] });
    }
    var builds = commits.map(function(c) {
      return {
        sha: c.sha ? c.sha.slice(0, 7) : '?',
        message: c.commit && c.commit.message ? c.commit.message.split('\n')[0].slice(0, 90) : '(no message)',
        author: c.commit && c.commit.author ? c.commit.author.name : 'unknown',
        date: c.commit && c.commit.author ? c.commit.author.date : null,
        url: c.html_url || null
      };
    });
    console.log('[builds] returning', builds.length, 'commits');
    res.json({ ok: true, builds: builds });
  }).catch(function(e) {
    console.error('[builds] fetch error:', e.message);
    res.json({ ok: false, error: e.message, builds: [] });
  });
});

// ── Dashboard: Brain Memory — proxied from ForgeOS /api/brain ─────────────────
app.get('/api/dashboard/memory', function(req, res) {
  res.set('Cache-Control', 'no-store');

  fetchUrl({
    hostname: FORGEOS_HOST,
    path: '/api/brain',
    method: 'GET',
    headers: { 'Accept': 'application/json', 'User-Agent': 'mission-control/3.0' }
  }, null, 10000).then(function(r) {
    console.log('[memory] ForgeOS /api/brain HTTP:', r.status, 'body len:', r.body.length);
    if (r.status !== 200) {
      return res.json({ ok: false, error: 'ForgeOS brain returned ' + r.status, stats: null, categories: [] });
    }

    var data = null;
    try { data = JSON.parse(r.body); } catch(e) {
      return res.json({ ok: false, error: 'Parse error: ' + e.message, stats: null, categories: [] });
    }

    var totals = data.totals || {};
    var total = (totals.projects || 0) + (totals.preferences || 0) + (totals.patterns || 0) +
                (totals.mistakes || 0) + (totals.snippets || 0);

    var categories = [
      { category: 'patterns',    count: totals.patterns    || 0 },
      { category: 'preferences', count: totals.preferences || 0 },
      { category: 'snippets',    count: totals.snippets    || 0 },
      { category: 'mistakes',    count: totals.mistakes    || 0 },
      { category: 'projects',    count: totals.projects    || 0 }
    ].filter(function(c) { return c.count > 0; });

    res.json({
      ok: true,
      stats: { total: total },
      categories: categories,
      topMemories: data.topMistakes || []
    });
  }).catch(function(e) {
    console.error('[memory] proxy error:', e.message);
    res.json({ ok: false, error: e.message, stats: null, categories: [] });
  });
});

// ── Dashboard: Render Deploy Logs ─────────────────────────────────────────────
app.get('/api/dashboard/logs', function(req, res) {
  res.set('Cache-Control', 'no-store');
  var key = process.env.RENDER_API_KEY || '';
  if (!key) return res.json({ ok: false, error: 'RENDER_API_KEY not set', lines: [] });

  fetchUrl({
    hostname: 'api.render.com',
    path: '/v1/services/' + RENDER_SERVICE_ID,
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + key, 'Accept': 'application/json' }
  }, null, 10000).then(function(serviceRes) {
    if (serviceRes.status !== 200) {
      return res.json({ ok: false, error: 'Could not fetch service info: ' + serviceRes.status, lines: [] });
    }
    var service = {};
    try { service = JSON.parse(serviceRes.body); } catch(e) {
      return res.json({ ok: false, error: 'Service parse error', lines: [] });
    }

    var ownerId = service.ownerId || '';
    if (!ownerId) {
      return res.json({ ok: false, error: 'Could not determine ownerId from service', lines: [] });
    }

    var logsPath = '/v1/logs?ownerId=' + encodeURIComponent(ownerId) +
                   '&resource=' + encodeURIComponent(RENDER_SERVICE_ID) +
                   '&limit=40&direction=backward';

    console.log('[logs] fetching from /v1/logs with ownerId:', ownerId);

    return fetchUrl({
      hostname: 'api.render.com',
      path: logsPath,
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + key, 'Accept': 'application/json' }
    }, null, 15000).then(function(r) {
      console.log('[logs] Render logs HTTP:', r.status, 'body:', r.body.slice(0, 300));
      if (r.status !== 200) {
        return res.json({ ok: false, error: 'Render logs API returned ' + r.status + ': ' + r.body.slice(0, 200), lines: [] });
      }
      var parsed = null;
      try { parsed = JSON.parse(r.body); } catch(e) {
        return res.json({ ok: false, error: 'Logs parse error', lines: [] });
      }

      var logArray = (parsed && parsed.logs) ? parsed.logs : [];
      var lines = logArray.map(function(entry) {
        return entry.message || '';
      }).filter(function(m) { return m.length > 0; });

      res.json({ ok: true, lines: lines });
    });
  }).catch(function(e) {
    console.error('[logs] error:', e.message);
    res.json({ ok: false, error: e.message, lines: [] });
  });
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', function(req, res) {
  res.json({ status: 'ok', service: 'mission-control', version: '3.2' });
});

// ── Quick Actions ─────────────────────────────────────────────────────────────
app.post('/api/actions/redeploy', function(req, res) {
  var key = process.env.RENDER_API_KEY || '';
  if (!key) return res.json({ ok: false, error: 'RENDER_API_KEY not set' });
  var body = JSON.stringify({ clearCache: false });
  var bodyBuffer = Buffer.from(body, 'utf8');
  fetchUrl({
    hostname: 'api.render.com',
    path: '/v1/services/' + RENDER_SERVICE_ID + '/deploys',
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'application/json',
      'Content-Length': bodyBuffer.length,
      'Accept': 'application/json'
    }
  }, bodyBuffer).then(function(r) {
    var parsed = {};
    try { parsed = JSON.parse(r.body); } catch(e) {}
    if (r.status === 200 || r.status === 201) {
      return res.json({ ok: true, deployId: parsed.id || (parsed.deploy && parsed.deploy.id) || '' });
    }
    res.json({ ok: false, error: 'Render responded ' + r.status });
  }).catch(function(e) {
    res.json({ ok: false, error: e.message });
  });
});

// ── Mission Control Chat ──────────────────────────────────────────────────────
app.get('/api/chat/history', async function(req, res) {
  const history = await getMcHistory();
  res.json({ ok: true, history });
});

app.post('/api/chat', async function(req, res) {
  var message = (req.body && req.body.message) ? String(req.body.message).trim() : '';
  if (!message) return res.status(400).json({ error: 'message required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  function send(obj) { if (!res.writableEnded) res.write('data: ' + JSON.stringify(obj) + '\n\n'); }

  var aborted = false;
  req.on('close', function() { aborted = true; });
  var keepalive = setInterval(function() { if (!res.writableEnded && !aborted) res.write(': keepalive\n\n'); }, 8000);

  try {
    await saveMcMessage('user', message);
    const history = await getMcHistory();
    const messages = history.map(function(m) { return { role: m.role, content: m.content }; });
    var fullResponse = '';

    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 8096,
      system: MC_SYSTEM_PROMPT,
      messages: messages,
    });

    stream.on('text', function(text) {
      if (aborted || res.writableEnded) return;
      fullResponse += text;
      send({ type: 'chunk', content: text });
    });

    stream.on('error', function(err) {
      clearInterval(keepalive);
      send({ type: 'error', error: err.message });
      if (!res.writableEnded) res.end();
    });

    stream.on('finalMessage', async function() {
      clearInterval(keepalive);
      await saveMcMessage('assistant', fullResponse);
      send({ type: 'done', content: fullResponse });
      if (!res.writableEnded) res.end();
    });

  } catch(err) {
    clearInterval(keepalive);
    send({ type: 'error', error: err.message });
    if (!res.writableEnded) res.end();
  }
});

// ── Context Pack Prompt ───────────────────────────────────────────────────────
app.get('/api/context-pack-prompt', function(req, res) {
  res.json({ ok: true, prompt: CONTEXT_PACK_PROMPT });
});

// ── Main Dashboard UI ─────────────────────────────────────────────────────────
app.get('/', function(req, res) {
  var html = '<!DOCTYPE html>' +
'<html lang="en">' +
'<head>' +
'<meta charset="UTF-8">' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
'<title>Mission Control</title>' +
'<link rel="preconnect" href="https://fonts.googleapis.com">' +
'<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">' +
'<style>' +
'*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }' +
'html, body {' +
'  height: 100%;' +
'  background: #0a0a12;' +
'  color: #c8c8e0;' +
'  font-family: "Space Grotesk", sans-serif;' +
'  overflow: hidden;' +
'}' +
'::-webkit-scrollbar { width: 4px; height: 4px; }' +
'::-webkit-scrollbar-track { background: transparent; }' +
'::-webkit-scrollbar-thumb { background: #1e1e32; border-radius: 2px; }' +
'header {' +
'  height: 52px;' +
'  background: #0d0d1a;' +
'  border-bottom: 1px solid #1a1a2e;' +
'  display: flex;' +
'  align-items: center;' +
'  padding: 0 24px;' +
'  gap: 10px;' +
'  flex-shrink: 0;' +
'  position: relative;' +
'  z-index: 10;' +
'}' +
'.header-logo { display: flex; align-items: center; gap: 10px; }' +
'.header-dot {' +
'  width: 8px; height: 8px;' +
'  border-radius: 50%;' +
'  background: #E94560;' +
'  box-shadow: 0 0 8px #E94560;' +
'  animation: pulse 2.5s ease-in-out infinite;' +
'}' +
'@keyframes pulse {' +
'  0%,100% { box-shadow: 0 0 6px #E94560; }' +
'  50% { box-shadow: 0 0 14px #E94560, 0 0 24px rgba(233,69,96,0.4); }' +
'}' +
'header h1 { font-size: 14px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #ffffff; }' +
'.header-right { margin-left: auto; display: flex; align-items: center; gap: 16px; }' +
'.header-version { font-size: 10px; color: #ffffff; letter-spacing: 0.08em; font-weight: 500; }' +
'.refresh-btn {' +
'  background: none; border: 1px solid #1e1e34; border-radius: 5px;' +
'  color: #555575; font-family: "Space Grotesk", sans-serif;' +
'  font-size: 11px; font-weight: 600; letter-spacing: 0.06em;' +
'  padding: 5px 10px; cursor: pointer; transition: all 0.15s; text-transform: uppercase;' +
'}' +
'.refresh-btn:hover { border-color: #E94560; color: #E94560; }' +
'.last-updated { font-size: 10px; color: #8888aa; letter-spacing: 0.04em; font-family: "Courier New", monospace; }' +

/* Shell: 3-row grid. Sidebar spans rows 2+3 so it is immune to log section height changes */
'.shell {' +
'  height: calc(100vh - 52px);' +
'  display: grid;' +
'  grid-template-columns: 300px 1fr 300px;' +
'  grid-template-rows: auto 1fr 220px;' +
'  gap: 0;' +
'  overflow: hidden;' +
'}' +
'.status-row {' +
'  grid-column: 1 / -1;' +
'  grid-row: 1;' +
'  display: flex;' +
'  gap: 1px;' +
'  background: #0d0d1a;' +
'  border-bottom: 1px solid #1a1a2e;' +
'}' +
'.status-card {' +
'  flex: 1; padding: 14px 20px; background: #0d0d1a;' +
'  display: flex; flex-direction: column; gap: 4px;' +
'  border-right: 1px solid #1a1a2e; transition: background 0.2s;' +
'}' +
'.status-card:last-child { border-right: none; }' +
'.status-card:hover { background: #0f0f1f; }' +
'.sc-label { font-size: 9px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #ffffff; }' +
'.sc-value { font-size: 13px; font-weight: 600; color: #e0e0f0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }' +
'.sc-sub { font-size: 11px; color: #b0b8d0; font-family: "Courier New", monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }' +
'.badge { display: inline-flex; align-items: center; gap: 5px; font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; padding: 2px 7px; border-radius: 3px; }' +
'.badge-green { background: rgba(0,200,100,0.1); color: #00c866; border: 1px solid rgba(0,200,100,0.2); }' +
'.badge-red { background: rgba(233,69,96,0.1); color: #E94560; border: 1px solid rgba(233,69,96,0.2); }' +
'.badge-yellow { background: rgba(255,200,0,0.08); color: #ffcc00; border: 1px solid rgba(255,200,0,0.2); }' +
'.badge-gray { background: rgba(100,100,150,0.1); color: #667; border: 1px solid rgba(100,100,150,0.2); }' +
'.dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }' +

/* Main area: row 2 only, column 1 */
'.main-area {' +
'  grid-column: 2;' +
'  grid-row: 2;' +
'  overflow: hidden;' +
'  display: flex;' +
'  flex-direction: column;' +
'  border-left: 1px solid #1a1a2e;' +
'  border-right: 1px solid #1a1a2e;' +
'}' +
'.panel-header {' +
'  padding: 14px 20px 12px; border-bottom: 1px solid #1a1a2e; flex-shrink: 0;' +
'  display: flex; align-items: center; justify-content: space-between;' +
'}' +
'.panel-title { font-size: 10px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #ffffff; }' +
'.panel-count { font-size: 10px; color: #8888aa; font-family: "Courier New", monospace; }' +
'.panel-live { display: flex; align-items: center; gap: 5px; font-size: 9px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #00c866; }' +
'.panel-live-dot { width: 5px; height: 5px; border-radius: 50%; background: #00c866; animation: livepulse 1.8s ease-in-out infinite; }' +
'@keyframes livepulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }' +
'.builds-list { flex: 1; overflow-y: auto; padding: 8px; }' +
'.build-row {' +
'  display: flex; align-items: flex-start; gap: 12px;' +
'  padding: 10px 12px; border-radius: 6px; margin-bottom: 2px;' +
'  cursor: pointer; transition: background 0.12s; text-decoration: none; color: inherit;' +
'}' +
'.build-row:hover { background: #0f0f1e; }' +
'.build-sha { font-family: "Courier New", monospace; font-size: 11px; color: #E94560; font-weight: 700; flex-shrink: 0; margin-top: 2px; letter-spacing: 0.02em; }' +
'.build-info { flex: 1; min-width: 0; }' +
'.build-message { font-size: 12px; color: #c0c0d8; font-weight: 500; line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }' +
'.build-meta { font-size: 10px; color: #7070a0; margin-top: 2px; font-family: "Courier New", monospace; }' +
'.build-row:nth-child(1) .build-sha { color: #00c866; }' +
'.build-row:nth-child(1) .build-message { color: #e8e8f8; }' +

/* Sidebar spans rows 2 AND 3 — completely decoupled from log section height */
'.sidebar {' +
'  grid-column: 3;' +
'  grid-row: 2 / 4;' +
'  overflow: hidden;' +
'  display: flex;' +
'  flex-direction: column;' +
'  border-left: 1px solid #1a1a2e;' +
'}' +
'.memory-section { flex: 1; overflow: hidden; display: flex; flex-direction: column; min-height: 0; }' +
'.memory-body { flex: 1; overflow-y: auto; padding: 10px; }' +
'.mem-stat-row { display: flex; align-items: center; justify-content: space-between; padding: 6px 8px; margin-bottom: 2px; border-radius: 4px; transition: background 0.12s; }' +
'.mem-stat-row:hover { background: #0f0f1e; }' +
'.mem-cat { font-size: 11px; color: #9090b0; font-weight: 500; text-transform: capitalize; }' +
'.mem-count { font-size: 11px; font-family: "Courier New", monospace; color: #E94560; font-weight: 700; }' +
'.mem-bar-wrap { height: 3px; background: #1a1a2e; border-radius: 2px; margin: 1px 0 0 0; width: 60px; flex-shrink: 0; }' +
'.mem-bar { height: 100%; border-radius: 2px; background: linear-gradient(90deg, #E94560, #c03050); }' +
'.mem-total { font-size: 10px; color: #7070a0; font-family: "Courier New", monospace; padding: 6px 8px 4px; }' +
'.actions-section { flex-shrink: 0; padding: 12px; border-top: 1px solid #1a1a2e; }' +
'.actions-title { font-size: 9px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #ffffff; margin-bottom: 10px; }' +
'.actions-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }' +
'.action-btn {' +
'  background: #0d0d1a; border: 1px solid #1e1e34; border-radius: 6px;' +
'  color: #8080a0; font-family: "Space Grotesk", sans-serif;' +
'  font-size: 11px; font-weight: 600; letter-spacing: 0.04em;' +
'  padding: 9px 10px; cursor: pointer; transition: all 0.15s;' +
'  text-align: left; display: flex; flex-direction: column; gap: 3px; text-decoration: none;' +
'}' +
'.action-btn:hover { background: #0f0f22; border-color: #E94560; color: #E94560; }' +
'.action-btn:active { opacity: 0.7; }' +
'.action-btn .ab-icon { font-size: 16px; line-height: 1; }' +
'.action-btn .ab-label { font-size: 10px; }' +
'.action-link { position: relative; }' +
'.action-link::after {' +
'  content: "\u2197";' +
'  position: absolute;' +
'  top: 6px; right: 7px;' +
'  font-size: 9px;' +
'  color: #44445a;' +
'  transition: color 0.15s;' +
'  line-height: 1;' +
'}' +
'.action-link:hover::after { color: #E94560; }' +
'.action-btn.copied { border-color: #00c866 !important; color: #00c866 !important; }' +

/* Log section: row 3, column 1 only — sidebar is no longer in this row */
'.chat-section {' +
'  grid-column: 1;' +
'  grid-row: 2 / 4;' +
'  border-right: 1px solid #1a1a2e;' +
'  display: flex;' +
'  flex-direction: column;' +
'  overflow: hidden;' +
'  min-height: 0;' +
'}' +
'.chat-messages {' +
'  flex: 1; overflow-y: auto; padding: 10px 14px;' +
'  display: flex; flex-direction: column; gap: 8px; min-height: 0;' +
'}' +
'.chat-msg { display: flex; flex-direction: column; gap: 2px; }' +
'.chat-msg-role { font-size: 9px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #444466; }' +
'.chat-msg.user .chat-msg-role { color: #3b82f6; }' +
'.chat-msg.assistant .chat-msg-role { color: #E94560; }' +
'.chat-msg-content { font-size: 12px; color: #c0c0d8; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }' +
'.chat-msg.pending .chat-msg-content { color: #666688; font-style: italic; }' +
'.chat-input-row {' +
'  display: flex; gap: 8px; padding: 8px 12px;' +
'  border-top: 1px solid #1a1a2e; flex-shrink: 0;' +
'}' +
'.chat-input {' +
'  flex: 1; background: #0d0d1a; border: 1px solid #1e1e34; border-radius: 5px;' +
'  color: #c0c0d8; font-family: "Space Grotesk", sans-serif; font-size: 12px;' +
'  padding: 7px 10px; outline: none; resize: none; height: 34px;' +
'}' +
'.chat-input:focus { border-color: #E94560; }' +
'.chat-send {' +
'  background: #E94560; border: none; border-radius: 5px; color: white;' +
'  font-size: 14px; font-weight: 700; padding: 0 14px; cursor: pointer; transition: opacity 0.15s;' +
'}' +
'.chat-send:hover { opacity: 0.85; }' +
'.chat-send:disabled { opacity: 0.4; cursor: not-allowed; }' +
'.log-section {' +
'  grid-column: 2;' +
'  grid-row: 3;' +
'  border-top: 1px solid #1a1a2e;' +
'  border-left: 1px solid #1a1a2e;' +
'  border-right: 1px solid #1a1a2e;' +
'  display: flex;' +
'  flex-direction: column;' +
'  overflow: hidden;' +
'}' +
'.log-body { flex: 1; overflow-y: auto; padding: 8px 14px; font-family: "Courier New", monospace; font-size: 11px; color: #7070a0; line-height: 1.55; }' +
'.log-line { white-space: pre-wrap; word-break: break-all; }' +
'.log-line.err { color: #c03050; }' +
'.log-line.warn { color: #aa8800; }' +
'.log-line.info { color: #4a9ab8; }' +
'.empty-state { display: flex; align-items: center; justify-content: center; height: 100%; flex-direction: column; gap: 8px; color: #444466; }' +
'.empty-state .es-icon { font-size: 28px; opacity: 0.4; }' +
'.empty-state .es-text { font-size: 11px; letter-spacing: 0.06em; }' +
'.loading-row { display: flex; align-items: center; gap: 6px; padding: 8px 12px; color: #555577; font-size: 11px; font-family: "Courier New", monospace; }' +
'.spinner { width: 12px; height: 12px; border: 2px solid #1a1a30; border-top-color: #E94560; border-radius: 50%; animation: spin 0.7s linear infinite; flex-shrink: 0; }' +
'@keyframes spin { to { transform: rotate(360deg); } }' +
'@media (max-width: 900px) {' +
'  html, body { overflow: auto; }' +
'  .shell { grid-template-columns: 1fr; grid-template-rows: auto auto auto auto auto; height: auto; overflow: auto; }' +
'  .chat-section { grid-column: 1; grid-row: auto; border-right: none; min-height: 280px; }' +
'  .main-area { grid-column: 1; grid-row: auto; border-left: none; border-right: none; min-height: 50vh; }' +
'  .log-section { grid-column: 1; grid-row: auto; border-left: none; border-right: none; }' +
'  .sidebar { grid-column: 1; grid-row: auto; border-left: none; border-top: 1px solid #1a1a2e; }' +
'}' +
'.toast { position: fixed; bottom: 24px; right: 24px; background: #13131f; border: 1px solid #2a2a40; border-radius: 8px; padding: 12px 18px; font-size: 12px; color: #c0c0d8; z-index: 100; transform: translateY(80px); opacity: 0; transition: all 0.25s ease; max-width: 300px; }' +
'.toast.show { transform: translateY(0); opacity: 1; }' +
'.toast.toast-ok { border-color: rgba(0,200,100,0.3); color: #00c866; }' +
'.toast.toast-err { border-color: rgba(233,69,96,0.3); color: #E94560; }' +
'</style>' +
'</head>' +
'<body>' +

'<header>' +
'  <div class="header-logo"><div class="header-dot"></div><h1>Mission Control</h1></div>' +
'  <div class="header-right">' +
'    <span class="last-updated" id="lastUpdated">Loading\u2026</span>' +
'    <button class="refresh-btn" id="refreshBtn">&#8635; Refresh</button>' +
'    <span class="header-version">v3.2</span>' +
'  </div>' +
'</header>' +

'<div class="shell">' +

'  <div class="status-row" id="statusRow">' +
'    <div class="status-card"><div class="sc-label">ForgeOS Production</div><div class="sc-value" id="sc-forge">&#8230;</div><div class="sc-sub" id="sc-forge-sub">&nbsp;</div></div>' +
'    <div class="status-card"><div class="sc-label">Render Service</div><div class="sc-value" id="sc-render">&#8230;</div><div class="sc-sub" id="sc-render-sub">&nbsp;</div></div>' +
'    <div class="status-card"><div class="sc-label">Credentials</div><div class="sc-value" id="sc-creds">&#8230;</div><div class="sc-sub" id="sc-creds-sub">&nbsp;</div></div>' +
'    <div class="status-card"><div class="sc-label">Brain DB</div><div class="sc-value" id="sc-brain">&#8230;</div><div class="sc-sub" id="sc-brain-sub">&nbsp;</div></div>' +
'  </div>' +

'  <div class="main-area">' +
'    <div class="panel-header">' +
'      <span class="panel-title">Recent Commits \u2014 ' + GITHUB_OWNER + '/' + GITHUB_REPO + '</span>' +
'      <div style="display:flex;align-items:center;gap:12px;">' +
'        <span class="panel-live"><span class="panel-live-dot"></span>Live</span>' +
'        <span class="panel-count" id="buildsCount"></span>' +
'      </div>' +
'    </div>' +
'    <div class="builds-list" id="buildsList">' +
'      <div class="loading-row"><div class="spinner"></div>Fetching commits\u2026</div>' +
'    </div>' +
'  </div>' +

'  <div class="sidebar">' +
'    <div class="memory-section">' +
'      <div class="panel-header">' +
'        <span class="panel-title">Brain Memory</span>' +
'        <span class="panel-count" id="memTotal"></span>' +
'      </div>' +
'      <div class="memory-body" id="memoryBody">' +
'        <div class="loading-row"><div class="spinner"></div>Loading\u2026</div>' +
'      </div>' +
'    </div>' +
'    <div class="actions-section">' +
'      <div class="actions-title">Quick Actions</div>' +
'      <div class="actions-grid">' +
'        <button class="action-btn" id="btnRedeploy"><span class="ab-icon">\uD83D\uDE80</span><span class="ab-label">Redeploy</span></button>' +
'        <button class="action-btn" id="btnRefreshLogs"><span class="ab-icon">\uD83D\uDCCB</span><span class="ab-label">Fetch Logs</span></button>' +
'        <a class="action-btn action-link" href="https://github.com/' + GITHUB_OWNER + '/' + GITHUB_REPO + '" target="_blank" rel="noopener"><span class="ab-icon">\uD83D\uDCE6</span><span class="ab-label">GitHub Repo</span></a>' +
'        <a class="action-btn action-link" href="https://forge-os.ai" target="_blank" rel="noopener"><span class="ab-icon">\uD83C\uDF10</span><span class="ab-label">ForgeOS Live</span></a>' +
'        <a class="action-btn action-link" href="https://console.neon.tech/app/org-small-firefly-14254859/projects" target="_blank" rel="noopener"><span class="ab-icon">\uD83D\uDDC4\uFE0F</span><span class="ab-label">Neon DB</span></a>' +
'        <button class="action-btn" id="btnContextPack"><span class="ab-icon">\uD83E\uDDE0</span><span class="ab-label">Context Pack</span></button>' +
'      </div>' +
'    </div>' +
'  </div>' +

'  <div class="chat-section">' +
'    <div class="panel-header">' +
'      <span class="panel-title">Mission Control</span>' +
'      <span class="panel-live"><span class="panel-live-dot"></span>Admin</span>' +
'    </div>' +
'    <div class="chat-messages" id="chatMessages"></div>' +
'    <div class="chat-input-row">' +
'      <textarea class="chat-input" id="chatInput" placeholder="Ask anything..." rows="1"></textarea>' +
'      <button class="chat-send" id="chatSend">&#8593;</button>' +
'    </div>' +
'  </div>' +
'  <div class="log-section">' +
'    <div class="panel-header">' +
'      <span class="panel-title">Render Logs</span>' +
'      <span class="panel-count" id="logCount"></span>' +
'    </div>' +
'    <div class="log-body" id="logBody">' +
'      <div class="loading-row"><div class="spinner"></div>Loading logs\u2026</div>' +
'    </div>' +
'  </div>' +

'</div>' +

'<div class="toast" id="toast"></div>' +


'<script>' +
'(function() {' +

'  function toast(msg, type) {' +
'    var el = document.getElementById("toast");' +
'    el.textContent = msg;' +
'    el.className = "toast show " + (type === "ok" ? "toast-ok" : "toast-err");' +
'    setTimeout(function() { el.className = "toast"; }, 4000);' +
'  }' +

'  function timeAgo(iso) {' +
'    if (!iso) return "";' +
'    var diff = (Date.now() - new Date(iso).getTime()) / 1000;' +
'    if (diff < 60) return Math.round(diff) + "s ago";' +
'    if (diff < 3600) return Math.round(diff / 60) + "m ago";' +
'    if (diff < 86400) return Math.round(diff / 3600) + "h ago";' +
'    return Math.round(diff / 86400) + "d ago";' +
'  }' +

'  function escHtml(s) {' +
'    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");' +
'  }' +

'  var cachedBuilds = [];' +

'  function renderBuilds(builds) {' +
'    var list = document.getElementById("buildsList");' +
'    var countEl = document.getElementById("buildsCount");' +
'    if (!builds || !builds.length) {' +
'      list.innerHTML = \'<div class="empty-state"><div class="es-icon">\uD83D\uDCE6</div><div class="es-text">No commits found</div></div>\';' +
'      return;' +
'    }' +
'    countEl.textContent = builds.length + " commits";' +
'    var rows = [];' +
'    for (var i = 0; i < builds.length; i++) {' +
'      var b = builds[i];' +
'      rows.push(' +
'        \'<a class="build-row" href="\' + escHtml(b.url || "#") + \'" target="_blank" rel="noopener">\'' +
'        + \'<div class="build-sha">\' + escHtml(b.sha) + \'</div>\'' +
'        + \'<div class="build-info">\'' +
'        + \'<div class="build-message">\' + escHtml(b.message) + \'</div>\'' +
'        + \'<div class="build-meta">\' + escHtml(b.author) + \' &middot; \' + timeAgo(b.date) + \'</div>\'' +
'        + \'</div></a>\'' +
'      );' +
'    }' +
'    list.innerHTML = rows.join("");' +
'  }' +

'  function loadStatus() {' +
'    fetch("/api/dashboard/status")' +
'      .then(function(r) { return r.json(); })' +
'      .then(function(d) {' +
'        document.getElementById("lastUpdated").textContent = new Date().toTimeString().slice(0,8);' +

'        var forgeEl = document.getElementById("sc-forge");' +
'        var forgeSub = document.getElementById("sc-forge-sub");' +
'        if (d.forge && d.forge.alive) {' +
'          forgeEl.innerHTML = \'<span class="badge badge-green"><span class="dot"></span>LIVE</span>\';' +
'          forgeSub.textContent = d.forge.latencyMs ? d.forge.latencyMs + "ms" : "online";' +
'        } else {' +
'          forgeEl.innerHTML = \'<span class="badge badge-red"><span class="dot"></span>UNREACHABLE</span>\';' +
'          forgeSub.textContent = "ping failed";' +
'        }' +

'        var renderEl = document.getElementById("sc-render");' +
'        var renderSub = document.getElementById("sc-render-sub");' +
'        if (d.render) {' +
'          var rState = d.render.state;' +
'          if (rState === "live" || rState === "not_suspended" || rState === "available") {' +
'            renderEl.innerHTML = \'<span class="badge badge-green"><span class="dot"></span>LIVE</span>\';' +
'          } else if (rState === "no-key") {' +
'            renderEl.innerHTML = \'<span class="badge badge-gray">NO KEY</span>\';' +
'          } else if (rState === "suspended" || rState === "deactivated" || rState === "unavailable") {' +
'            renderEl.innerHTML = \'<span class="badge badge-red"><span class="dot"></span>\' + escHtml(rState.toUpperCase()) + \'</span>\';' +
'          } else {' +
'            renderEl.innerHTML = \'<span class="badge badge-yellow"><span class="dot"></span>\' + escHtml(rState.toUpperCase()) + \'</span>\';' +
'          }' +
'          renderSub.textContent = d.render.updatedAt ? timeAgo(d.render.updatedAt) : "";' +
'        }' +

'        var credsEl = document.getElementById("sc-creds");' +
'        var credsSub = document.getElementById("sc-creds-sub");' +
'        if (d.credentials) {' +
'          var keys = Object.keys(d.credentials);' +
'          var setCount = keys.filter(function(k) { return d.credentials[k]; }).length;' +
'          var allSet = setCount === keys.length;' +
'          if (allSet) {' +
'            credsEl.innerHTML = \'<span class="badge badge-green"><span class="dot"></span>ALL SET</span>\';' +
'          } else {' +
'            credsEl.innerHTML = \'<span class="badge badge-yellow"><span class="dot"></span>\' + setCount + "/" + keys.length + \' SET</span>\';' +
'          }' +
'          var missing = keys.filter(function(k) { return !d.credentials[k]; });' +
'          credsSub.textContent = missing.length ? "missing: " + missing.join(", ") : "all credentials present";' +
'        }' +
'      })' +
'      .catch(function(e) {' +
'        document.getElementById("sc-forge").innerHTML = \'<span class="badge badge-red">ERROR</span>\';' +
'        console.error("status error:", e);' +
'      });' +
'  }' +

'  function loadBuilds() {' +
'    fetch("/api/dashboard/builds")' +
'      .then(function(r) { return r.json(); })' +
'      .then(function(d) {' +
'        if (!d.ok) {' +
'          document.getElementById("buildsList").innerHTML =' +
'            \'<div class="empty-state"><div class="es-icon">\uD83D\uDCE6</div><div class="es-text">\' + escHtml(d.error || "Failed") + \'</div></div>\';' +
'          document.getElementById("buildsCount").textContent = "";' +
'          return;' +
'        }' +
'        cachedBuilds = d.builds || [];' +
'        renderBuilds(cachedBuilds);' +
'      })' +
'      .catch(function(e) {' +
'        console.error("builds fetch error:", e);' +
'        document.getElementById("buildsList").innerHTML =' +
'          \'<div class="empty-state"><div class="es-icon">\u26A0\uFE0F</div><div class="es-text">Network error \u2014 check console</div></div>\';' +
'      });' +
'  }' +

'  setInterval(function() { if (cachedBuilds.length) renderBuilds(cachedBuilds); }, 60000);' +

'  function loadMemory() {' +
'    fetch("/api/dashboard/memory")' +
'      .then(function(r) { return r.json(); })' +
'      .then(function(d) {' +
'        var body = document.getElementById("memoryBody");' +
'        var totalEl = document.getElementById("memTotal");' +
'        var brainEl = document.getElementById("sc-brain");' +
'        var brainSub = document.getElementById("sc-brain-sub");' +
'        if (!d.ok) {' +
'          body.innerHTML = \'<div class="empty-state"><div class="es-icon">\uD83E\uDDE0</div><div class="es-text">\' + escHtml(d.error || "Brain unavailable") + \'</div></div>\';' +
'          brainEl.innerHTML = \'<span class="badge badge-red">OFFLINE</span>\';' +
'          brainSub.textContent = d.error || "";' +
'          return;' +
'        }' +
'        var total = d.stats ? d.stats.total : 0;' +
'        totalEl.textContent = total + " memories";' +
'        brainEl.innerHTML = \'<span class="badge badge-green"><span class="dot"></span>ONLINE</span>\';' +
'        brainSub.textContent = total + " records";' +
'        if (!d.categories || !d.categories.length) {' +
'          body.innerHTML = \'<div class="empty-state"><div class="es-text">No data</div></div>\';' +
'          return;' +
'        }' +
'        var maxCount = 0;' +
'        for (var j = 0; j < d.categories.length; j++) {' +
'          var c = parseInt(d.categories[j].count) || 0;' +
'          if (c > maxCount) maxCount = c;' +
'        }' +
'        var rows = [\'<div class="mem-total">Memory breakdown</div>\'];' +
'        for (var i = 0; i < d.categories.length; i++) {' +
'          var cat = d.categories[i];' +
'          var pct = maxCount > 0 ? Math.round((parseInt(cat.count) / maxCount) * 100) : 0;' +
'          rows.push(' +
'            \'<div class="mem-stat-row">\'' +
'            + \'<div class="mem-cat">\' + escHtml(cat.category || "uncategorized") + \'</div>\'' +
'            + \'<div style="display:flex;align-items:center;gap:8px;">\'' +
'            + \'<div class="mem-bar-wrap"><div class="mem-bar" style="width:\' + pct + \'%"></div></div>\'' +
'            + \'<div class="mem-count">\' + escHtml(String(cat.count)) + \'</div>\'' +
'            + \'</div></div>\'' +
'          );' +
'        }' +
'        body.innerHTML = rows.join("");' +
'      })' +
'      .catch(function() {' +
'        document.getElementById("memoryBody").innerHTML = \'<div class="empty-state"><div class="es-text">Failed to load brain</div></div>\';' +
'        document.getElementById("sc-brain").innerHTML = \'<span class="badge badge-red">ERROR</span>\';' +
'      });' +
'  }' +

'  function loadLogs() {' +
'    var body = document.getElementById("logBody");' +
'    body.innerHTML = \'<div class="loading-row"><div class="spinner"></div>Fetching logs\u2026</div>\';' +
'    fetch("/api/dashboard/logs")' +
'      .then(function(r) { return r.json(); })' +
'      .then(function(d) {' +
'        document.getElementById("logCount").textContent = d.lines ? d.lines.length + " lines" : "";' +
'        if (!d.ok || !d.lines || !d.lines.length) {' +
'          body.innerHTML = \'<div class="empty-state"><div class="es-text">\' + escHtml(d.error || "No logs") + \'</div></div>\';' +
'          return;' +
'        }' +
'        var html = [];' +
'        for (var i = 0; i < d.lines.length; i++) {' +
'          var line = d.lines[i];' +
'          var cls = "log-line";' +
'          if (/error/i.test(line)) cls += " err";' +
'          else if (/warn/i.test(line)) cls += " warn";' +
'          else if (/info|start|listen|deploy/i.test(line)) cls += " info";' +
'          html.push(\'<div class="\' + cls + \'">\' + escHtml(line) + \'</div>\');' +
'        }' +
'        body.innerHTML = html.join("");' +
'        body.scrollTop = body.scrollHeight;' +
'      })' +
'      .catch(function() {' +
'        body.innerHTML = \'<div class="empty-state"><div class="es-text">Failed to fetch logs</div></div>\';' +
'      });' +
'  }' +

'  function refreshAll() { loadStatus(); loadBuilds(); loadMemory(); loadLogs(); }' +

'  document.getElementById("btnRedeploy").addEventListener("click", function() {' +
'    var btn = this;' +
'    btn.disabled = true;' +
'    btn.querySelector(".ab-label").textContent = "Deploying\u2026";' +
'    fetch("/api/actions/redeploy", { method: "POST", headers: { "Content-Type": "application/json" } })' +
'      .then(function(r) { return r.json(); })' +
'      .then(function(d) {' +
'        btn.disabled = false;' +
'        btn.querySelector(".ab-label").textContent = "Redeploy";' +
'        if (d.ok) toast("Redeploy triggered \u2014 " + (d.deployId || ""), "ok");' +
'        else toast("Redeploy failed: " + (d.error || "unknown"), "err");' +
'      })' +
'      .catch(function() {' +
'        btn.disabled = false;' +
'        btn.querySelector(".ab-label").textContent = "Redeploy";' +
'        toast("Network error", "err");' +
'      });' +
'  });' +

'  document.getElementById("btnRefreshLogs").addEventListener("click", function() { loadLogs(); toast("Fetching logs\u2026", "ok"); });' +
'  document.getElementById("refreshBtn").addEventListener("click", function() { refreshAll(); toast("Dashboard refreshed", "ok"); });' +

'  document.getElementById("btnContextPack").addEventListener("click", function() {' +
'    var btn = this;' +
'    var label = btn.querySelector(".ab-label");' +
'    fetch("/api/context-pack-prompt")' +
'      .then(function(r) { return r.json(); })' +
'      .then(function(d) {' +
'        if (!d.ok || !d.prompt) { toast("Could not load prompt", "err"); return; }' +
'        return navigator.clipboard.writeText(d.prompt).then(function() {' +
'          label.textContent = "Copied!";' +
'          btn.classList.add("copied");' +
'          toast("Context pack prompt copied \u2014 paste it into the Forge chat", "ok");' +
'          setTimeout(function() {' +
'            label.textContent = "Context Pack";' +
'            btn.classList.remove("copied");' +
'          }, 2500);' +
'        });' +
'      })' +
'      .catch(function() {' +
'        toast("Clipboard write failed \u2014 check browser permissions", "err");' +
'      });' +
'  });' +

'  var chatMsgs = []; var chatPending = false;' +
'  function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }' +
'  function renderChat() {' +
'    var el = document.getElementById("chatMessages"); if (!el) return;' +
'    var h = "";' +
'    chatMsgs.forEach(function(m) {' +
'      h += "<div class=\"chat-msg " + m.role + (m.pending ? " pending" : "") + "\"><div class=\"chat-msg-role\">" + (m.role==="user"?"You":"Mission Control") + "</div><div class=\"chat-msg-content\">" + esc(m.content||"\u2026") + "</div></div>";' +
'    });' +
'    el.innerHTML = h; el.scrollTop = el.scrollHeight;' +
'  }' +
'  function loadChatHistory() {' +
'    fetch("/api/chat/history").then(function(r){return r.json();}).then(function(d){' +
'      if(d.ok&&d.history&&d.history.length){chatMsgs=d.history.map(function(m,i){return{id:"h-"+i,role:m.role,content:m.content};});renderChat();}' +
'    }).catch(function(){});' +
'  }' +
'  function sendMsg() {' +
'    var inp = document.getElementById("chatInput");' +
'    var btn = document.getElementById("chatSend");' +
'    var txt = inp ? inp.value.trim() : "";' +
'    if (!txt || chatPending) return;' +
'    var now = Date.now(); var pid = "a-"+now;' +
'    chatMsgs.push({id:"u-"+now,role:"user",content:txt});' +
'    chatMsgs.push({id:pid,role:"assistant",content:"",pending:true});' +
'    renderChat(); inp.value=""; chatPending=true; if(btn) btn.disabled=true;' +
'    function patch(p){for(var i=chatMsgs.length-1;i>=0;i--){if(chatMsgs[i].id===pid){Object.assign(chatMsgs[i],p);break;}}renderChat();}' +
'    fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:txt})})' +
'    .then(function(res){' +
'      var rdr=res.body.getReader(),dec=new TextDecoder(),buf="",acc="";' +
'      function read(){rdr.read().then(function(r){' +
'        if(r.done){chatPending=false;if(btn)btn.disabled=false;if(inp)inp.focus();return;}' +
'        buf+=dec.decode(r.value,{stream:true});' +
'        var parts=buf.split("\n\n");buf=parts.pop()||"";' +
'        parts.forEach(function(p){' +
'          p=p.trim();if(!p||p.startsWith(": ")||!p.startsWith("data: "))return;' +
'          try{var e=JSON.parse(p.slice(6));' +
'            if(e.type==="chunk"){acc+=e.content;patch({content:acc});}' +
'            else if(e.type==="done"){patch({content:e.content||acc,pending:false});chatPending=false;if(btn)btn.disabled=false;if(inp)inp.focus();}' +
'            else if(e.type==="error"){patch({content:"[Error: "+(e.error||"?")+"]",pending:false});chatPending=false;if(btn)btn.disabled=false;}' +
'          }catch(x){}' +
'        });' +
'        read();' +
'      }).catch(function(){patch({content:"[Connection error]",pending:false});chatPending=false;if(btn)btn.disabled=false;});}' +
'      read();' +
'    }).catch(function(){patch({content:"[Network error]",pending:false});chatPending=false;if(btn)btn.disabled=false;});' +
'  }' +
'  var sb=document.getElementById("chatSend");' +
'  var si=document.getElementById("chatInput");' +
'  if(sb)sb.addEventListener("click",sendMsg);' +
'  if(si)si.addEventListener("keydown",function(e){if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendMsg();}});' +
'  loadChatHistory();' +
'  refreshAll();' +
'  setInterval(refreshAll, 30000);' +

'})();' +
'</script>' +
'</body></html>';

  res.send(html);
});

app.listen(PORT, '0.0.0.0', function() {
  console.log('Mission Control v3.2 running on port ' + PORT);
  console.log('GITHUB_TOKEN:', process.env.GITHUB_TOKEN ? 'SET' : 'NOT SET');
  console.log('RENDER_API_KEY:', process.env.RENDER_API_KEY ? 'SET' : 'NOT SET');
  console.log('NEON_DATABASE_URL:', process.env.NEON_DATABASE_URL ? 'SET' : 'NOT SET');
  console.log('Brain proxy:', 'https://' + FORGEOS_HOST + '/api/brain');
});
