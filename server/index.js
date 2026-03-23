
const express = require("express");
const path = require("path");
const brain = require("./memory/brain");
const publishManager = require("./publish/manager");

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3001;

app.use(express.json());
// ---------------------------------------------------------------------------
// Wildcard subdomain proxy — *.forge-os.ai → Render service
// ---------------------------------------------------------------------------
app.use(async (req, res, next) => {
  // ... (the rest of the file is the same until the dashboard routes)
});
// Auth gate removed — no authentication required


app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ... (the rest of the file is the same until the dashboard routes)

// ── Dashboard Constants ───────────────────────────────────────────────────────
const RENDER_SERVICE_ID = "srv-d6h2rt56ubrc73duanfg";
const FORGEOS_HOST = process.env.BASE_DOMAIN || "forge-os.ai";

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
    ? fetch('https://api.render.com/v1/services/' + RENDER_SERVICE_ID, {
        headers: { 'Authorization': 'Bearer ' + renderKey, 'Accept': 'application/json' }
      }).then(function(r) {
        if (r.status === 200) {
          return r.json().then(function(parsed) {
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
            return { state: state, name: name, updatedAt: updatedAt };
          });
        }
        return { state: 'error', name: 'ForgeOS', updatedAt: null };
      }).catch(function(e) {
        return { state: 'unreachable', name: 'ForgeOS', updatedAt: null };
      })
    : Promise.resolve({ state: 'no-key', name: 'ForgeOS', updatedAt: null });

  var forgePromise = fetch('https://' + FORGEOS_HOST + '/api/health', {
      headers: { 'Accept': 'application/json' }
    }).then(function(r) {
      return { alive: r.status === 200, latencyMs: null };
    }).catch(function() {
      return { alive: false, latencyMs: null };
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

  fetch('https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/commits?per_page=20', {
    headers: ghHeaders
  }).then(function(r) {
    if (r.status === 403 || r.status === 429) {
      var rateSuffix = r.status === 403 ? ' (rate limit — add GITHUB_TOKEN)' : ' (rate limited)';
      return res.json({ ok: false, error: 'GitHub ' + r.status + rateSuffix, builds: [] });
    }
    if (r.status === 401) {
      return res.json({ ok: false, error: 'GitHub 401 — token invalid or missing', builds: [] });
    }
    if (r.status !== 200) {
      return res.json({ ok: false, error: 'GitHub responded ' + r.status, builds: [] });
    }
    return r.json().then(function(commits) {
      if (!Array.isArray(commits)) {
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
      res.json({ ok: true, builds: builds });
    });
  }).catch(function(e) {
    res.json({ ok: false, error: e.message, builds: [] });
  });
});

// ── Dashboard: Render Deploy Logs ─────────────────────────────────────────────
app.get('/api/dashboard/logs', function(req, res) {
  res.set('Cache-Control', 'no-store');
  var key = process.env.RENDER_API_KEY || '';
  if (!key) return res.json({ ok: false, error: 'RENDER_API_KEY not set', lines: [] });

  fetch('https://api.render.com/v1/services/' + RENDER_SERVICE_ID, {
    headers: { 'Authorization': 'Bearer ' + key, 'Accept': 'application/json' }
  }).then(function(serviceRes) {
    if (serviceRes.status !== 200) {
      return res.json({ ok: false, error: 'Could not fetch service info: ' + serviceRes.status, lines: [] });
    }
    return serviceRes.json().then(function(service) {
      var ownerId = service.ownerId || '';
      if (!ownerId) {
        return res.json({ ok: false, error: 'Could not determine ownerId from service', lines: [] });
      }

      var logsPath = '/v1/logs?ownerId=' + encodeURIComponent(ownerId) +
                     '&resource=' + encodeURIComponent(RENDER_SERVICE_ID) +
                     '&limit=40&direction=backward';

      return fetch('https://api.render.com' + logsPath, {
        headers: { 'Authorization': 'Bearer ' + key, 'Accept': 'application/json' }
      }).then(function(r) {
        if (r.status !== 200) {
          return r.text().then(function(body) {
            return res.json({ ok: false, error: 'Render logs API returned ' + r.status + ': ' + body.slice(0, 200), lines: [] });
          });
        }
        return r.json().then(function(parsed) {
          var logArray = (parsed && parsed.logs) ? parsed.logs : [];
          var lines = logArray.map(function(entry) {
            return entry.message || '';
          }).filter(function(m) { return m.length > 0; });

          res.json({ ok: true, lines: lines });
        });
      });
    });
  }).catch(function(e) {
    res.json({ ok: false, error: e.message, lines: [] });
  });
});

app.post("/api/dashboard/redeploy", async (_req, res) => {
  try {
    const r = await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/deploys`, {
      method: "POST", body: JSON.stringify({ clearCache: false }),
      headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, Accept: "application/json", "Content-Type": "application/json" }
    });
    const data = await r.json();
    res.json({ ok: r.ok, deploy: data });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});
