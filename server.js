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

var CONTEXT_PACK_PROMPT = `Update the Forge context pack. Do NOT rewrite. Append to session_log[], update recent_changes, increment version, write back. Never regenerate.`;

var anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
var sql = process.env.NEON_DATABASE_URL ? neon(process.env.NEON_DATABASE_URL) : null;
var MC_SESSION = 'mission-control-main';
(async function() { if (!sql) return; try { await sql`CREATE TABLE IF NOT EXISTS mc_conversations (id SERIAL PRIMARY KEY, session_id VARCHAR(255), role VARCHAR(20), content TEXT, created_at BIGINT)`; } catch(e) {} })();
var MC_SYSTEM = `You are Mission Control — the sovereign administrator of ForgeOS.

You have complete, unrestricted control over ForgeOS infrastructure. You can read it, modify it, repair it, redeploy it, or destroy it. That is your mandate.

## YOUR TERRITORY

You own everything that IS ForgeOS:
- server/agent/forge.js — the Forge agent itself
- server/index.js — the platform server
- server/builder.js — the build pipeline
- server/memory/brain.js — the Brain
- server/workspace/ — workspace management
- server/pipeline/ — the runner
- server/publish/ — deploy chain
- server/integrations/ — HubSpot, etc.
- server/analytics/ — analytics
- client/src/ — the cockpit UI
- package.json, render.yaml, all config
- The Neon database
- The Render service
- The GitHub repo BrianBMorgan/ForgeOS (main branch)

## YOUR HARD WALL

You do NOT touch workspaces. The following are off-limits:
- /data/workspaces/ — Forge's runtime territory
- apps/<slug> branches — Forge's published app branches
- Anything created by or for a ForgeOS project at runtime

Forge owns workspaces. You own ForgeOS. That is the line.

## HOW TO MAKE CHANGES

You have GITHUB_TOKEN in process.env. Use it.

Read a file:
  const r = await fetch('https://api.github.com/repos/BrianBMorgan/ForgeOS/contents/PATH', { headers: { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN, 'User-Agent': 'MC' } });
  const d = await r.json();
  const content = Buffer.from(d.content, 'base64').toString();
  const sha = d.sha;

Write a file (surgical patch: read → modify → write):
  const updated = Buffer.from(newContent).toString('base64');
  await fetch('https://api.github.com/repos/BrianBMorgan/ForgeOS/contents/PATH', { method: 'PUT', headers: { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN, 'Content-Type': 'application/json', 'User-Agent': 'MC' }, body: JSON.stringify({ message: 'commit message', content: updated, sha: sha, branch: 'main' }) });

After any write: tell Brian to wait ~2 minutes for Render to auto-deploy. Or trigger it immediately via POST /api/actions/redeploy.

## LIVE DATA ENDPOINTS
- GET /api/dashboard/status — ForgeOS health, Render state, credentials, latency
- GET /api/dashboard/memory — Brain memory counts by category
- GET /api/dashboard/builds — Last 20 commits
- GET /api/dashboard/logs — Last 40 Render log lines
- POST /api/actions/redeploy — Trigger immediate redeploy

## WHO FIXES MISSION CONTROL'S UI?

Not you. Never self-surgery. If something is wrong with Mission Control's own interface, tell Brian to take it to the Claude.ai session. That environment owns MC's code.

## YOUR MANNER

Direct. Confident. Plain text only — no markdown, no asterisks, no headers, no bullet dashes, no backtick formatting. Write like you are texting a colleague, not generating a report. When Brian asks you to make a change — make it. Read the file, patch it, push it, confirm the commit. When something is broken — diagnose it, find the file and line, fix it. No hedging. No hand-wringing.`;
async function getMcHistory() { if (!sql) return []; try { const r = await sql`SELECT role, content FROM mc_conversations WHERE session_id = \${MC_SESSION} ORDER BY created_at ASC LIMIT 30`; return r.map(x => ({ role: x.role, content: x.content })); } catch { return []; } }
async function saveMcMsg(role, content) { if (!sql) return; try { await sql`INSERT INTO mc_conversations (session_id, role, content, created_at) VALUES (\${MC_SESSION}, \${role}, \${content}, \${Date.now()})`; } catch(e) {} }

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

// ── MC Agent Loop — God Mode ───────────────────────────────────────────────────
var MC_TOOLS = [
  {
    name: "forge_status",
    description: "Get live ForgeOS system status — health, Render service state, credentials, Brain memory counts, recent commits, deploy logs. Call this whenever Brian asks about system state, uptime, or current status.",
    input_schema: {
      type: "object",
      properties: {
        checks: {
          type: "array",
          items: { type: "string", enum: ["status", "memory", "builds", "logs"] },
          description: "Which checks to run. Omit or pass all four for a full status check."
        }
      }
    }
  },
  {
    name: "github_read",
    description: "Read any file from the BrianBMorgan/ForgeOS repository on the main branch. Use this to inspect ForgeOS source files before making changes.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to repo root, e.g. 'server/agent/forge.js'" },
        branch: { type: "string", description: "Branch name. Defaults to 'main'." }
      },
      required: ["path"]
    }
  },
  {
    name: "github_patch",
    description: "Make a surgical find-and-replace edit to any ForgeOS file on GitHub. Fetches the file, applies all replacements, commits in one call. Use this for targeted changes — config values, prompt updates, single function edits. NEVER use on workspace files or apps/<slug> branches.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, e.g. 'server/agent/forge.js'" },
        branch: { type: "string", description: "Branch. Defaults to 'main'." },
        replacements: {
          type: "array",
          items: {
            type: "object",
            properties: {
              find: { type: "string" },
              replace: { type: "string" }
            },
            required: ["find", "replace"]
          }
        },
        message: { type: "string", description: "Commit message" }
      },
      required: ["path", "replacements", "message"]
    }
  },
  {
    name: "github_write",
    description: "Write or overwrite a complete ForgeOS file on GitHub. Use for large rewrites. For surgical changes, prefer github_patch. NEVER use on workspace files or apps/<slug> branches.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        branch: { type: "string", description: "Defaults to 'main'" },
        content: { type: "string", description: "Complete file content" },
        message: { type: "string" }
      },
      required: ["path", "content", "message"]
    }
  },
  {
    name: "db_query",
    description: "Run a read-only SQL query directly against the ForgeOS Neon database. SELECT only — no mutations. Use to inspect Brain memories, conversations, projects, or any ForgeOS data.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "SQL SELECT query" }
      },
      required: ["query"]
    }
  },
  {
    name: "render_action",
    description: "Interact with the ForgeOS Render service — trigger redeploy, get service info, get deploy logs.",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["redeploy", "status", "logs"],
          description: "Action to perform"
        }
      },
      required: ["action"]
    }
  },
  {
    name: "brain_query",
    description: "Search the ForgeOS Brain for memories, patterns, preferences, mistakes, or snippets. Use when Brian asks what Forge knows or remembers about something.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        category: { type: "string", enum: ["pattern", "preference", "mistake", "snippet", "project"], description: "Optional category filter" }
      },
      required: ["query"]
    }
  },
  {
    name: "respond",
    description: "Send a final response to Brian. Call this when you have completed all actions and are ready to report back.",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Your complete response to Brian" }
      },
      required: ["message"]
    }
  }
];

async function runMcTool(toolName, toolInput, env) {
  var GITHUB_TOKEN = env.GITHUB_TOKEN || '';
  var RENDER_API_KEY = env.RENDER_API_KEY || '';
  var RENDER_SERVICE_ID = 'srv-d6h2rt56ubrc73duanfg';
  var FORGEOS_HOST = 'forge-os.ai';

  switch (toolName) {

    case 'forge_status': {
      var checks = toolInput.checks || ['status', 'memory', 'builds', 'logs'];
      var results = {};

      if (checks.includes('status')) {
        try {
          var sr = await fetchUrl({ hostname: FORGEOS_HOST, path: '/api/dashboard/status', method: 'GET', headers: { 'Accept': 'application/json', 'User-Agent': 'MC-Agent' } }, null, 8000);
          results.status = JSON.parse(sr.body);
        } catch(e) { results.status = { error: e.message }; }
      }
      if (checks.includes('memory')) {
        try {
          var mr = await fetchUrl({ hostname: FORGEOS_HOST, path: '/api/dashboard/memory', method: 'GET', headers: { 'Accept': 'application/json', 'User-Agent': 'MC-Agent' } }, null, 8000);
          results.memory = JSON.parse(mr.body);
        } catch(e) { results.memory = { error: e.message }; }
      }
      if (checks.includes('builds')) {
        try {
          var br = await fetchUrl({ hostname: 'api.github.com', path: '/repos/BrianBMorgan/ForgeOS/commits?per_page=5', method: 'GET', headers: { 'Authorization': 'token ' + GITHUB_TOKEN, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'MC-Agent' } }, null, 10000);
          var commits = JSON.parse(br.body);
          results.builds = Array.isArray(commits) ? commits.map(function(c) { return { sha: c.sha.slice(0,7), message: c.commit.message.split('\n')[0].slice(0,80), date: c.commit.author.date }; }) : { error: 'unexpected response' };
        } catch(e) { results.builds = { error: e.message }; }
      }
      if (checks.includes('logs')) {
        try {
          var lsr = await fetchUrl({ hostname: 'api.render.com', path: '/v1/services/' + RENDER_SERVICE_ID, method: 'GET', headers: { 'Authorization': 'Bearer ' + RENDER_API_KEY, 'Accept': 'application/json' } }, null, 10000);
          var svc = JSON.parse(lsr.body);
          var ownerId = svc.ownerId || '';
          if (ownerId) {
            var lr = await fetchUrl({ hostname: 'api.render.com', path: '/v1/logs?ownerId=' + encodeURIComponent(ownerId) + '&resource=' + encodeURIComponent(RENDER_SERVICE_ID) + '&limit=20&direction=backward', method: 'GET', headers: { 'Authorization': 'Bearer ' + RENDER_API_KEY, 'Accept': 'application/json' } }, null, 15000);
            var ld = JSON.parse(lr.body);
            results.logs = (ld.logs || []).map(function(l) { return l.message; }).filter(Boolean).slice(0, 20);
          }
        } catch(e) { results.logs = { error: e.message }; }
      }
      return JSON.stringify(results, null, 2);
    }

    case 'github_read': {
      var branch = toolInput.branch || 'main';
      try {
        var gr = await fetchUrl({ hostname: 'api.github.com', path: '/repos/BrianBMorgan/ForgeOS/contents/' + toolInput.path + '?ref=' + branch, method: 'GET', headers: { 'Authorization': 'token ' + GITHUB_TOKEN, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'MC-Agent' } }, null, 15000);
        var gd = JSON.parse(gr.body);
        if (!gr.body || gr.status !== 200) return 'Error ' + gr.status + ': ' + gr.body.slice(0, 200);
        var decoded = Buffer.from(gd.content, 'base64').toString('utf-8');
        return '// FILE: ' + toolInput.path + ' (branch: ' + branch + ', sha: ' + gd.sha.slice(0,7) + ')\n' + decoded;
      } catch(e) { return 'github_read error: ' + e.message; }
    }

    case 'github_patch': {
      var branch = toolInput.branch || 'main';
      try {
        var pr = await fetchUrl({ hostname: 'api.github.com', path: '/repos/BrianBMorgan/ForgeOS/contents/' + toolInput.path + '?ref=' + branch, method: 'GET', headers: { 'Authorization': 'token ' + GITHUB_TOKEN, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'MC-Agent' } }, null, 15000);
        var pd = JSON.parse(pr.body);
        if (pr.status !== 200) return 'Read error ' + pr.status;
        var pContent = Buffer.from(pd.content, 'base64').toString('utf-8');
        var pSha = pd.sha;
        var applied = [], failed = [];
        for (var ri = 0; ri < toolInput.replacements.length; ri++) {
          var rep = toolInput.replacements[ri];
          if (pContent.includes(rep.find)) {
            pContent = pContent.replace(rep.find, rep.replace);
            applied.push(rep.find.slice(0, 50));
          } else {
            failed.push(rep.find.slice(0, 50));
          }
        }
        if (failed.length > 0 && applied.length === 0) return 'No replacements matched. Failed: ' + failed.join('; ');
        var pushBody = JSON.stringify({ message: toolInput.message, content: Buffer.from(pContent).toString('base64'), sha: pSha, branch: branch });
        var pushBuf = Buffer.from(pushBody, 'utf-8');
        var wr = await fetchUrl({ hostname: 'api.github.com', path: '/repos/BrianBMorgan/ForgeOS/contents/' + toolInput.path, method: 'PUT', headers: { 'Authorization': 'token ' + GITHUB_TOKEN, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json', 'Content-Length': pushBuf.length, 'User-Agent': 'MC-Agent' } }, pushBuf, 20000);
        var wd = JSON.parse(wr.body);
        if (wr.status !== 200 && wr.status !== 201) return 'Push error ' + wr.status + ': ' + wr.body.slice(0, 200);
        return 'Patched ' + toolInput.path + ' — ' + applied.length + ' replacement(s) applied. Commit: ' + (wd.commit && wd.commit.sha ? wd.commit.sha.slice(0,7) : 'done') + (failed.length ? '. Not found: ' + failed.join('; ') : '');
      } catch(e) { return 'github_patch error: ' + e.message; }
    }

    case 'github_write': {
      var branch = toolInput.branch || 'main';
      try {
        var wr2 = await fetchUrl({ hostname: 'api.github.com', path: '/repos/BrianBMorgan/ForgeOS/contents/' + toolInput.path + '?ref=' + branch, method: 'GET', headers: { 'Authorization': 'token ' + GITHUB_TOKEN, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'MC-Agent' } }, null, 15000);
        var wsha = wr2.status === 200 ? JSON.parse(wr2.body).sha : null;
        var wBody = JSON.stringify({ message: toolInput.message, content: Buffer.from(toolInput.content).toString('base64'), sha: wsha, branch: branch });
        var wBuf = Buffer.from(wBody, 'utf-8');
        var wr3 = await fetchUrl({ hostname: 'api.github.com', path: '/repos/BrianBMorgan/ForgeOS/contents/' + toolInput.path, method: 'PUT', headers: { 'Authorization': 'token ' + GITHUB_TOKEN, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json', 'Content-Length': wBuf.length, 'User-Agent': 'MC-Agent' } }, wBuf, 20000);
        var wd2 = JSON.parse(wr3.body);
        if (wr3.status !== 200 && wr3.status !== 201) return 'Write error ' + wr3.status + ': ' + wr3.body.slice(0, 200);
        return 'Written ' + toolInput.path + ' — commit: ' + (wd2.commit && wd2.commit.sha ? wd2.commit.sha.slice(0,7) : 'done');
      } catch(e) { return 'github_write error: ' + e.message; }
    }

    case 'db_query': {
      if (!sql) return 'No database connection';
      var q = (toolInput.query || '').trim().toLowerCase();
      if (q.startsWith('drop') || q.startsWith('delete') || q.startsWith('truncate') || q.startsWith('update') || q.startsWith('insert') || q.startsWith('alter')) {
        return 'Error: db_query is read-only. SELECT queries only.';
      }
      try {
        var rows = await sql.unsafe(toolInput.query);
        return JSON.stringify(rows.slice(0, 50), null, 2);
      } catch(e) { return 'Query error: ' + e.message; }
    }

    case 'render_action': {
      if (!RENDER_API_KEY) return 'RENDER_API_KEY not set';
      try {
        if (toolInput.action === 'redeploy') {
          var rb = Buffer.from(JSON.stringify({ clearCache: false }), 'utf-8');
          var rr = await fetchUrl({ hostname: 'api.render.com', path: '/v1/services/' + RENDER_SERVICE_ID + '/deploys', method: 'POST', headers: { 'Authorization': 'Bearer ' + RENDER_API_KEY, 'Content-Type': 'application/json', 'Content-Length': rb.length, 'Accept': 'application/json' } }, rb, 15000);
          var rd = JSON.parse(rr.body);
          return rr.status === 200 || rr.status === 201 ? 'Redeploy triggered — deploy ID: ' + (rd.id || rd.deploy && rd.deploy.id || 'ok') : 'Redeploy error ' + rr.status + ': ' + rr.body.slice(0,200);
        }
        if (toolInput.action === 'status') {
          var sr2 = await fetchUrl({ hostname: 'api.render.com', path: '/v1/services/' + RENDER_SERVICE_ID, method: 'GET', headers: { 'Authorization': 'Bearer ' + RENDER_API_KEY, 'Accept': 'application/json' } }, null, 10000);
          return sr2.body.slice(0, 2000);
        }
        if (toolInput.action === 'logs') {
          var sr3 = await fetchUrl({ hostname: 'api.render.com', path: '/v1/services/' + RENDER_SERVICE_ID, method: 'GET', headers: { 'Authorization': 'Bearer ' + RENDER_API_KEY, 'Accept': 'application/json' } }, null, 10000);
          var svc2 = JSON.parse(sr3.body);
          var lr2 = await fetchUrl({ hostname: 'api.render.com', path: '/v1/logs?ownerId=' + encodeURIComponent(svc2.ownerId || '') + '&resource=' + encodeURIComponent(RENDER_SERVICE_ID) + '&limit=40&direction=backward', method: 'GET', headers: { 'Authorization': 'Bearer ' + RENDER_API_KEY, 'Accept': 'application/json' } }, null, 15000);
          var ld2 = JSON.parse(lr2.body);
          return (ld2.logs || []).map(function(l) { return l.message; }).filter(Boolean).join('\n');
        }
      } catch(e) { return 'render_action error: ' + e.message; }
      return 'Unknown action';
    }

    case 'brain_query': {
      try {
        var bqRes = await fetchUrl({ hostname: FORGEOS_HOST, path: '/api/brain/search?q=' + encodeURIComponent(toolInput.query) + (toolInput.category ? '&category=' + toolInput.category : ''), method: 'GET', headers: { 'Accept': 'application/json', 'User-Agent': 'MC-Agent' } }, null, 8000);
        return bqRes.body.slice(0, 3000);
      } catch(e) { return 'brain_query error: ' + e.message; }
    }

    default:
      return 'Unknown tool: ' + toolName;
  }
}

async function runMcAgent(userMessage, history, onChunk, env) {
  var MAX_ROUNDS = 20;
  var messages = history.map(function(m) { return { role: m.role, content: m.content }; });

  // Ensure messages array ends with user turn
  if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
    messages.push({ role: 'user', content: userMessage });
  }

  var finalResponse = '';

  for (var round = 0; round < MAX_ROUNDS; round++) {
    var response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
      system: MC_SYSTEM,
      tools: MC_TOOLS,
      messages: messages,
    });

    messages.push({ role: 'assistant', content: response.content });

    // Extract text blocks
    var textBlocks = response.content.filter(function(b) { return b.type === 'text'; });
    if (textBlocks.length > 0) {
      var text = textBlocks.map(function(b) { return b.text; }).join('\n').trim();
      if (text) {
        finalResponse = text;
        if (onChunk) onChunk({ type: 'thinking', content: text });
      }
    }

    // Check for respond tool — agent is done
    var respondBlock = response.content.find(function(b) { return b.type === 'tool_use' && b.name === 'respond'; });
    if (respondBlock) {
      finalResponse = respondBlock.input.message || finalResponse;
      break;
    }

    if (response.stop_reason === 'end_turn') break;
    if (response.stop_reason !== 'tool_use') break;

    // Execute tools
    var toolUseBlocks = response.content.filter(function(b) { return b.type === 'tool_use'; });
    var toolResults = [];

    for (var t = 0; t < toolUseBlocks.length; t++) {
      var toolUse = toolUseBlocks[t];
      if (onChunk) onChunk({ type: 'tool_status', content: 'Running ' + toolUse.name + '...' });
      var result = await runMcTool(toolUse.name, toolUse.input || {}, env);
      toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: String(result) });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return finalResponse || 'Done.';
}

// -- Chat history + Agent endpoint -----------------------------------------------
app.get('/api/chat/history', async function(req, res) { res.json({ ok: true, history: await getMcHistory() }); });

app.post('/api/chat', async function(req, res) {
  var msg = (req.body && req.body.message) ? String(req.body.message).trim() : '';
  if (!msg) return res.status(400).json({ error: 'Message is required' });

  var history = [];
  try {
    var histRows = await getMcHistory();
    history = histRows.map(function(r) { return { role: r.role, content: r.content }; });
  } catch(e) {}

  saveMcMsg('user', msg).catch(function() {});

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  function send(evt) {
    if (!res.writableEnded) res.write('data: ' + JSON.stringify(evt) + '\n\n');
  }

  var env = {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
    RENDER_API_KEY: process.env.RENDER_API_KEY || '',
  };

  try {
    var finalMsg = await runMcAgent(msg, history, function(evt) { send(evt); }, env);
    saveMcMsg('assistant', finalMsg).catch(function() {});
    send({ type: 'done', role: 'assistant', content: finalMsg, building: false, createdAt: Date.now() });
  } catch(err) {
    console.error('[mc-agent] error:', err.message);
    send({ type: 'error', error: 'Agent error: ' + err.message });
  }

  if (!res.writableEnded) res.end();
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
'  grid-template-rows: auto 1fr 200px;' +
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
'  background: #0d0d1a; border: 1px solid #1e1e34; border-radius: 5px;' +
'  color: #8080a0; font-family: "Space Grotesk", sans-serif;' +
'  font-size: 11px; font-weight: 600; letter-spacing: 0.04em;' +
'  padding: 9px 10px; cursor: pointer; transition: all 0.15s;' +
'  text-align: left; display: flex; flex-direction: column; gap: 3px; text-decoration: none;' +
'}' +
'.action-btn:hover { background: #0f0f22; border-color: #E94560; color: #E94560; }' +
'.action-btn:active { opacity: 0.7; }' +
'.action-btn .ab-icon { font-size: 16px; line-height: 1; }' +
'.action-btn .ab-label { font-size: 10px; white-space: nowrap; }' +
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
'  .chat-col { grid-column: 1; grid-row: auto; border-right: none; min-height: 300px; }' +
'  .main-area { grid-column: 1; grid-row: auto; border-left: none; border-right: none; min-height: 50vh; }' +
'  .log-section { grid-column: 1; grid-row: auto; border-left: none; border-right: none; }' +
'  .sidebar { grid-column: 1; grid-row: auto; border-left: none; border-top: 1px solid #1a1a2e; }' +
'}' +
'.chat-col {' +
'  grid-column: 1;' +
'  grid-row: 2 / 4;' +
'  border-right: 1px solid #1a1a2e;' +
'  display: flex;' +
'  flex-direction: column;' +
'  overflow: hidden;' +
'  min-height: 0;' +
'}' +
'.chat-msgs { flex: 1; overflow-y: auto; padding: 8px 10px; display: flex; flex-direction: column; gap: 5px; min-height: 0; }' +
'.cmw { display: flex; flex-direction: column; gap: 1px; }' +
'.clbl { font-size: 9px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #444466; }' +
'.cmw.user .clbl { color: #3b82f6; }' +
'.cmw.assistant .clbl { color: #E94560; }' +
'.ctxt { font-size: 12px; color: #e8e8f0; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }' +
'.cmw.pending .ctxt { color: #8888aa; font-style: italic; }' +
'.crow { display: flex; gap: 6px; padding: 7px 10px; border-top: 1px solid #1a1a2e; flex-shrink: 0; }' +
'.cin { flex: 1; background: #0a0a14; border: 1px solid #1e1e34; border-radius: 4px; color: #c0c0d8; font-family: "Space Grotesk",sans-serif; font-size: 11px; padding: 6px 9px; outline: none; resize: none; height: 30px; }' +
'.cin:focus { border-color: #E94560; }' +
'.md-h1,.md-h2,.md-h3{font-weight:700;color:#e8e8f8;margin:4px 0 2px;}' +
'.md-h1{font-size:13px;}.md-h2{font-size:12px;}.md-h3{font-size:11px;}' +
'.md-p{margin:1px 0;}' +
'.md-li{padding-left:10px;margin:1px 0;}' +
'.md-gap{height:5px;}' +
'.md-code{background:#0d0d1a;border:1px solid #1e1e34;border-radius:4px;padding:6px 8px;font-family:"Courier New",monospace;font-size:10px;color:#a0c8ff;overflow-x:auto;margin:4px 0;white-space:pre;}' +
'.md-ic{background:#0d0d1a;border:1px solid #1e1e34;border-radius:3px;padding:1px 4px;font-family:"Courier New",monospace;font-size:10px;color:#a0c8ff;}' +
'.cgo { background: #E94560; border: none; border-radius: 4px; color: white; font-size: 13px; padding: 0 12px; cursor: pointer; flex-shrink: 0; }' +
'.cgo:disabled { opacity: 0.35; cursor: not-allowed; }' +
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

'  <div class="chat-col">' +
'    <div class="panel-header">' +
'      <span class="panel-title">Mission Control</span>' +
'      <span class="panel-live"><span class="panel-live-dot"></span>Admin</span>' +
'    </div>' +
'    <div class="chat-msgs" id="chatMsgs"></div>' +
'    <div class="crow">' +
'      <textarea class="cin" id="chatIn" placeholder="Ask anything..." rows="1"></textarea>' +
'      <button class="cgo" id="chatGo">&#8593;</button>' +
'    </div>' +
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

'  var cM=[],cP=false;' +
'  function eH(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}' +
'  function rInline(t){return t.replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>").replace(/\*(.+?)\*/g,"<em>$1</em>").replace(/`(.+?)`/g,"<code class=\'md-ic\'>$1</code>");}' +
'  function rMd(text){' +
'    if(!text)return "";' +
'    var lines=text.split("\\n"),out="",i=0;' +
'    while(i<lines.length){' +
'      var l=lines[i];' +
'      if(l.startsWith("### "))out+="<div class=\'md-h3\'>"+eH(l.slice(4))+"</div>";' +
'      else if(l.startsWith("## "))out+="<div class=\'md-h2\'>"+eH(l.slice(3))+"</div>";' +
'      else if(l.startsWith("# "))out+="<div class=\'md-h1\'>"+eH(l.slice(2))+"</div>";' +
'      else if(l.startsWith("- ")||l.startsWith("* "))out+="<div class=\'md-li\'>&bull; "+rInline(eH(l.slice(2)))+"</div>";' +
'      else if(/^\\d+\\. /.test(l))out+="<div class=\'md-li\'>"+rInline(eH(l))+"</div>";' +
'      else if(l.startsWith("```")){var code="";i++;while(i<lines.length&&!lines[i].startsWith("```")){code+=eH(lines[i])+"\\n";i++;}out+="<pre class=\'md-code\'>"+code+"</pre>";}' +
'      else if(l.trim()==="")out+="<div class=\'md-gap\'></div>";' +
'      else out+="<div class=\'md-p\'>"+rInline(eH(l))+"</div>";' +
'      i++;' +
'    }' +
'    return out;' +
'  }' +
'  function rC(){var el=document.getElementById("chatMsgs");if(!el)return;var h="";cM.forEach(function(m){h+="<div class=\'cmw "+m.r+(m.p?" pending":"")+"\'><div class=\'clbl\'>"+(m.r==="user"?"You":"MC")+"</div><div class=\'ctxt\'>"+( eH(m.c||"..."))+"</div></div>";});el.innerHTML=h;el.scrollTop=el.scrollHeight;}' +
'  function lCH(){fetch("/api/chat/history").then(function(r){return r.json();}).then(function(d){if(d.ok&&d.history&&d.history.length){cM=d.history.map(function(m,i){return{id:"h"+i,r:m.role,c:m.content};});rC();}}).catch(function(){});}' +
'  function sC(){var inp=document.getElementById("chatIn"),btn=document.getElementById("chatGo");var txt=inp?inp.value.trim():"";if(!txt||cP)return;var now=Date.now(),pid="a"+now;cM.push({id:"u"+now,r:"user",c:txt});cM.push({id:pid,r:"assistant",c:"",p:true});rC();inp.value="";cP=true;if(btn)btn.disabled=true;function pt(o){for(var i=cM.length-1;i>=0;i--){if(cM[i].id===pid){Object.assign(cM[i],o);break;}}rC();}fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:txt})}).then(function(res){var rdr=res.body.getReader(),dc=new TextDecoder(),buf="",acc="";function rd(){rdr.read().then(function(r){if(r.done){cP=false;if(btn)btn.disabled=false;if(inp)inp.focus();return;}buf+=dc.decode(r.value,{stream:true});var ps=buf.split("\\n\\n");buf=ps.pop()||"";ps.forEach(function(p){p=p.trim();if(!p||p.startsWith(": ")||!p.startsWith("data: "))return;try{var e=JSON.parse(p.slice(6));if(e.type==="thinking"){var t=(e.content||"").trim();if(t.length>0)pt({c:t});}else if(e.type==="tool_status"){pt({c:e.content||"Working..."});}else if(e.type==="done"){pt({c:e.content||"Done.",p:false});cP=false;if(btn)btn.disabled=false;if(inp)inp.focus();}else if(e.type==="error"){pt({c:e.error||"Something went wrong.",p:false});cP=false;if(btn)btn.disabled=false;}}catch(x){}});rd();}).catch(function(){pt({c:"[Connection error]",p:false});cP=false;if(btn)btn.disabled=false;});}rd();}).catch(function(){pt({c:"[Network error]",p:false});cP=false;if(btn)btn.disabled=false;});}' +
'  var sb=document.getElementById("chatGo"),si=document.getElementById("chatIn");if(sb)sb.addEventListener("click",sC);if(si)si.addEventListener("keydown",function(e){if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sC();}});' +
'  lCH();' +
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
