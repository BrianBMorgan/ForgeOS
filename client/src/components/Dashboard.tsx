
import { useEffect } from 'react';

const GITHUB_OWNER = 'BrianBMorgan';
const GITHUB_REPO = 'ForgeOS';

export default function Dashboard() {
  useEffect(() => {
    function toast(msg, type) {
      const el = document.getElementById("toast");
      if (!el) return;
      el.textContent = msg;
      el.className = "toast show " + (type === "ok" ? "toast-ok" : "toast-err");
      setTimeout(function() { el.className = "toast"; }, 4000);
    }

    function timeAgo(iso) {
      if (!iso) return "";
      const diff = (Date.now() - new Date(iso).getTime()) / 1000;
      if (diff < 60) return Math.round(diff) + "s ago";
      if (diff < 3600) return Math.round(diff / 60) + "m ago";
      if (diff < 86400) return Math.round(diff / 3600) + "h ago";
      return Math.round(diff / 86400) + "d ago";
    }

    function escHtml(s) {
      return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    let cachedBuilds = [];

    function renderBuilds(builds) {
      const list = document.getElementById("buildsList");
      const countEl = document.getElementById("buildsCount");
      if (!list || !countEl) return;
      if (!builds || !builds.length) {
        list.innerHTML = '<div class="empty-state"><div class="es-icon">📦</div><div class="es-text">No commits found</div></div>';
        return;
      }
      countEl.textContent = builds.length + " commits";
      const rows = builds.map(b => (
        '<a class="build-row" href="' + escHtml(b.url || "#") + '" target="_blank" rel="noopener">' +
        '<div class="build-sha">' + escHtml(b.sha) + '</div>' +
        '<div class="build-info">' +
        '<div class="build-message">' + escHtml(b.message) + '</div>' +
        '<div class="build-meta">' + escHtml(b.author) + ' &middot; ' + timeAgo(b.date) + '</div>' +
        '</div></a>'
      ));
      list.innerHTML = rows.join("");
    }

    function loadStatus() {
      fetch("/api/dashboard/status")
        .then(r => r.json())
        .then(d => {
          const lastUpdated = document.getElementById("lastUpdated");
          if(lastUpdated) lastUpdated.textContent = new Date().toTimeString().slice(0, 8);

          const forgeEl = document.getElementById("sc-forge");
          const forgeSub = document.getElementById("sc-forge-sub");
          if(forgeEl && forgeSub) {
            if (d.forge && d.forge.alive) {
              forgeEl.innerHTML = '<span class="badge badge-green"><span class="dot"></span>LIVE</span>';
              forgeSub.textContent = d.forge.latencyMs ? d.forge.latencyMs + "ms" : "online";
            } else {
              forgeEl.innerHTML = '<span class="badge badge-red"><span class="dot"></span>UNREACHABLE</span>';
              forgeSub.textContent = "ping failed";
            }
          }

          const renderEl = document.getElementById("sc-render");
          const renderSub = document.getElementById("sc-render-sub");
          if(renderEl && renderSub) {
            if (d.render) {
              const rState = d.render.state;
              if (rState === "live" || rState === "not_suspended" || rState === "available") {
                renderEl.innerHTML = '<span class="badge badge-green"><span class="dot"></span>LIVE</span>';
              } else if (rState === "no-key") {
                renderEl.innerHTML = '<span class="badge badge-gray">NO KEY</span>';
              } else if (rState === "suspended" || rState === "deactivated" || rState === "unavailable") {
                renderEl.innerHTML = '<span class="badge badge-red"><span class="dot"></span>' + escHtml(rState.toUpperCase()) + '</span>';
              } else {
                renderEl.innerHTML = '<span class="badge badge-yellow"><span class="dot"></span>' + escHtml(rState.toUpperCase()) + '</span>';
              }
              renderSub.textContent = d.render.updatedAt ? timeAgo(d.render.updatedAt) : "";
            }
          }

          const credsEl = document.getElementById("sc-creds");
          const credsSub = document.getElementById("sc-creds-sub");
          if(credsEl && credsSub) {
            if (d.credentials) {
              const keys = Object.keys(d.credentials);
              const setCount = keys.filter(k => d.credentials[k]).length;
              const allSet = setCount === keys.length;
              if (allSet) {
                credsEl.innerHTML = '<span class="badge badge-green"><span class="dot"></span>ALL SET</span>';
              } else {
                credsEl.innerHTML = '<span class="badge badge-yellow"><span class="dot"></span>' + setCount + "/" + keys.length + ' SET</span>';
              }
              const missing = keys.filter(k => !d.credentials[k]);
              credsSub.textContent = missing.length ? "missing: " + missing.join(", ") : "all credentials present";
            }
          }
        })
        .catch(e => {
          const forgeEl = document.getElementById("sc-forge");
          if(forgeEl) forgeEl.innerHTML = '<span class="badge badge-red">ERROR</span>';
          console.error("status error:", e);
        });
    }

    function loadBuilds() {
      fetch("/api/dashboard/builds")
        .then(r => r.json())
        .then(d => {
          const buildsList = document.getElementById("buildsList");
          const buildsCount = document.getElementById("buildsCount");
          if(!buildsList || !buildsCount) return;

          if (!d.ok) {
            buildsList.innerHTML =
              '<div class="empty-state"><div class="es-icon">📦</div><div class="es-text">' + escHtml(d.error || "Failed") + '</div></div>';
            buildsCount.textContent = "";
            return;
          }
          cachedBuilds = d.builds || [];
          renderBuilds(cachedBuilds);
        })
        .catch(e => {
          console.error("builds fetch error:", e);
          const buildsList = document.getElementById("buildsList");
          if(buildsList) buildsList.innerHTML =
            '<div class="empty-state"><div class="es-icon">⚠️</div><div class="es-text">Network error — check console</div></div>';
        });
    }

    setInterval(() => { if (cachedBuilds.length) renderBuilds(cachedBuilds); }, 60000);

    function loadMemory() {
      fetch("/api/brain")
        .then(r => r.json())
        .then(d => {
          const body = document.getElementById("memoryBody");
          const totalEl = document.getElementById("memTotal");
          const brainEl = document.getElementById("sc-brain");
          const brainSub = document.getElementById("sc-brain-sub");
          if(!body || !totalEl || !brainEl || !brainSub) return;
          
          if (!d.ok) {
            body.innerHTML = '<div class="empty-state"><div class="es-icon">🧠</div><div class="es-text">' + escHtml(d.error || "Brain unavailable") + '</div></div>';
            brainEl.innerHTML = '<span class="badge badge-red">OFFLINE</span>';
            brainSub.textContent = d.error || "";
            return;
          }

          const totals = d.totals || {};
          const total = (totals.projects || 0) + (totals.preferences || 0) + (totals.patterns || 0) + (totals.mistakes || 0) + (totals.snippets || 0);

          totalEl.textContent = total + " memories";
          brainEl.innerHTML = '<span class="badge badge-green"><span class="dot"></span>ONLINE</span>';
          brainSub.textContent = total + " records";
          if (!d.categories || !d.categories.length) {
            body.innerHTML = '<div class="empty-state"><div class="es-text">No data</div></div>';
            return;
          }
          let maxCount = 0;
          d.categories.forEach(c => {
            const count = parseInt(c.count) || 0;
            if (count > maxCount) maxCount = count;
          });

          const rows = ['<div class="mem-total">Memory breakdown</div>'];
          d.categories.forEach(cat => {
            const pct = maxCount > 0 ? Math.round((parseInt(cat.count) / maxCount) * 100) : 0;
            rows.push(
              '<div class="mem-stat-row">' +
              '<div class="mem-cat">' + escHtml(cat.category || "uncategorized") + '</div>' +
              '<div style="display:flex;align-items:center;gap:8px;">' +
              '<div class="mem-bar-wrap"><div class="mem-bar" style="width:' + pct + '%"></div></div>' +
              '<div class="mem-count">' + escHtml(String(cat.count)) + '</div>' +
              '</div></div>'
            );
          });
          body.innerHTML = rows.join("");
        })
        .catch(() => {
          const memoryBody = document.getElementById("memoryBody");
          if(memoryBody) memoryBody.innerHTML = '<div class="empty-state"><div class="es-text">Failed to load brain</div></div>';
          const scBrain = document.getElementById("sc-brain");
          if(scBrain) scBrain.innerHTML = '<span class="badge badge-red">ERROR</span>';
        });
    }

    function loadLogs() {
      const body = document.getElementById("logBody");
      if(!body) return;
      body.innerHTML = '<div class="loading-row"><div class="spinner"></div>Fetching logs…</div>';
      fetch("/api/dashboard/logs")
        .then(r => r.json())
        .then(d => {
          const logCount = document.getElementById("logCount");
          if(logCount) logCount.textContent = d.lines ? d.lines.length + " lines" : "";
          if (!d.ok || !d.lines || !d.lines.length) {
            body.innerHTML = '<div class="empty-state"><div class="es-text">' + escHtml(d.error || "No logs") + '</div></div>';
            return;
          }
          const html = d.lines.map(line => {
            let cls = "log-line";
            if (/error/i.test(line)) cls += " err";
            else if (/warn/i.test(line)) cls += " warn";
            else if (/info|start|listen|deploy/i.test(line)) cls += " info";
            return '<div class="' + cls + '">' + escHtml(line) + '</div>';
          });
          body.innerHTML = html.join("");
          body.scrollTop = body.scrollHeight;
        })
        .catch(() => {
          body.innerHTML = '<div class="empty-state"><div class="es-text">Failed to fetch logs</div></div>';
        });
    }

    function refreshAll() { loadStatus(); loadBuilds(); loadMemory(); loadLogs(); }

    const redeployBtn = document.getElementById("btnRedeploy");
    if(redeployBtn) redeployBtn.addEventListener("click", function() {
      const btn = this;
      btn.disabled = true;
      const label = btn.querySelector(".ab-label");
      if(label) label.textContent = "Deploying…";
      fetch("/api/dashboard/redeploy", { method: "POST", headers: { "Content-Type": "application/json" } })
        .then(r => r.json())
        .then(d => {
          btn.disabled = false;
          if(label) label.textContent = "Redeploy";
          if (d.ok) toast("Redeploy triggered — " + (d.deployId || ""), "ok");
          else toast("Redeploy failed: " + (d.error || "unknown"), "err");
        })
        .catch(() => {
          btn.disabled = false;
          if(label) label.textContent = "Redeploy";
          toast("Network error", "err");
        });
    });

    const refreshLogsBtn = document.getElementById("btnRefreshLogs");
    if(refreshLogsBtn) refreshLogsBtn.addEventListener("click", () => { loadLogs(); toast("Fetching logs…", "ok"); });
    
    const refreshBtn = document.getElementById("refreshBtn");
    if(refreshBtn) refreshBtn.addEventListener("click", () => { refreshAll(); toast("Dashboard refreshed", "ok"); });

    refreshAll();
    const interval = setInterval(refreshAll, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div dangerouslySetInnerHTML={{ __html: `
      <div class="shell">
        <div class="status-row" id="statusRow">
          <div class="status-card"><div class="sc-label">ForgeOS Production</div><div class="sc-value" id="sc-forge">…</div><div class="sc-sub" id="sc-forge-sub">&nbsp;</div></div>
          <div class="status-card"><div class="sc-label">Render Service</div><div class="sc-value" id="sc-render">…</div><div class="sc-sub" id="sc-render-sub">&nbsp;</div></div>
          <div class="status-card"><div class="sc-label">Credentials</div><div class="sc-value" id="sc-creds">…</div><div class="sc-sub" id="sc-creds-sub">&nbsp;</div></div>
          <div class="status-card"><div class="sc-label">Brain DB</div><div class="sc-value" id="sc-brain">…</div><div class="sc-sub" id="sc-brain-sub">&nbsp;</div></div>
        </div>
        <div class="main-area">
          <div class="panel-header">
            <span class="panel-title">Recent Commits — ${GITHUB_OWNER}/${GITHUB_REPO}</span>
            <div style="display:flex;align-items:center;gap:12px;">
              <span class="panel-live"><span class="panel-live-dot"></span>Live</span>
              <span class="panel-count" id="buildsCount"></span>
            </div>
          </div>
          <div class="builds-list" id="buildsList">
            <div class="loading-row"><div class="spinner"></div>Fetching commits…</div>
          </div>
        </div>
        <div class="sidebar">
          <div class="memory-section">
            <div class="panel-header">
              <span class="panel-title">Brain Memory</span>
              <span class="panel-count" id="memTotal"></span>
            </div>
            <div class="memory-body" id="memoryBody">
              <div class="loading-row"><div class="spinner"></div>Loading…</div>
            </div>
          </div>
          <div class="actions-section">
            <div class="actions-title">Quick Actions</div>
            <div class="actions-grid">
              <button class="action-btn" id="btnRedeploy"><span class="ab-icon">🚀</span><span class="ab-label">Redeploy</span></button>
              <button class="action-btn" id="btnRefreshLogs"><span class="ab-icon">📋</span><span class="ab-label">Fetch Logs</span></button>
              <a class="action-btn action-link" href="https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}" target="_blank" rel="noopener"><span class="ab-icon">📦</span><span class="ab-label">GitHub Repo</span></a>
              <a class="action-btn action-link" href="https://forge-os.ai" target="_blank" rel="noopener"><span class="ab-icon">🌐</span><span class="ab-label">ForgeOS Live</span></a>
            </div>
          </div>
        </div>
        <div class="log-section">
          <div class="panel-header">
            <span class="panel-title">Render Logs</span>
            <span class="panel-count" id="logCount"></span>
          </div>
          <div class="log-body" id="logBody">
            <div class="loading-row"><div class="spinner"></div>Loading logs…</div>
          </div>
        </div>
      </div>
      <div class="toast" id="toast"></div>
    ` }} />
  );
}
