import { useState, useEffect, useCallback } from "react";
import "./Dashboard.css";

interface ServiceStatus {
  ok: boolean;
  credentials?: Record<string, boolean>;
  render?: { state: string; name: string; updatedAt: string };
  forge?: { alive: boolean; latencyMs: number };
  service?: { name: string; status: string; branch: string; updatedAt: string };
  checks?: Record<string, boolean>;
  timestamp?: string;
  error?: string;
}

interface Build {
  sha: string;
  message: string;
  author: string;
  date: string;
  url: string;
}

interface MemoryStats {
  ok: boolean;
  stats?: { total: number };
  categories?: { category: string; count: number }[];
  topMemories?: { content: string; upvotes: number }[];
  error?: string;
}

interface LogData {
  ok: boolean;
  lines?: string[];
  error?: string;
}

export default function Dashboard() {
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [memory, setMemory] = useState<MemoryStats | null>(null);
  const [logs, setLogs] = useState<LogData | null>(null);
  
  const [loadingBuilds, setLoadingBuilds] = useState(true);
  const [loadingMemory, setLoadingMemory] = useState(true);
  const [loadingLogs, setLoadingLogs] = useState(true);
  
  const [redeploying, setRedeploying] = useState(false);
  const [refreshingLogs, setRefreshingLogs] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard/status");
      setStatus(await res.json());
    } catch (e) {
      console.error("Dashboard status error:", e);
    }
  }, []);

  const loadBuilds = useCallback(async () => {
    setLoadingBuilds(true);
    try {
      const res = await fetch("/api/dashboard/builds");
      const data = await res.json();
      setBuilds(data.commits || data.builds || []);
    } catch (e) {
      console.error("Dashboard builds error:", e);
    } finally {
      setLoadingBuilds(false);
    }
  }, []);

  const loadMemory = useCallback(async () => {
    setLoadingMemory(true);
    try {
      const res = await fetch("/api/brain"); // Wait, original ForgeOS has /api/brain
      const data = await res.json();
      
      const totals = data.totals || {};
      const total = (totals.projects || 0) + (totals.preferences || 0) + (totals.patterns || 0) +
                    (totals.mistakes || 0) + (totals.snippets || 0);

      const categories = [
        { category: 'patterns',    count: totals.patterns    || 0 },
        { category: 'preferences', count: totals.preferences || 0 },
        { category: 'snippets',    count: totals.snippets    || 0 },
        { category: 'mistakes',    count: totals.mistakes    || 0 },
        { category: 'projects',    count: totals.projects    || 0 }
      ].filter(c => c.count > 0);

      setMemory({ ok: true, stats: { total }, categories, topMemories: data.topMistakes || [] });
    } catch (e) {
      console.error("Dashboard memory error:", e);
      setMemory({ ok: false, error: "Failed to load brain" });
    } finally {
      setLoadingMemory(false);
    }
  }, []);

  const loadLogs = useCallback(async () => {
    setLoadingLogs(true);
    try {
      // ForgeOS might not have /api/dashboard/logs yet. We will call it anyway, it will return 404 or data.
      const res = await fetch("/api/dashboard/logs");
      if (res.ok) {
        const data = await res.json();
        setLogs(data);
      } else {
        setLogs({ ok: false, error: "Logs unavailable in ForgeOS v2" });
      }
    } catch (e) {
      setLogs({ ok: false, error: "Failed to fetch logs" });
    } finally {
      setLoadingLogs(false);
      setRefreshingLogs(false);
    }
  }, []);

  const refreshAll = useCallback(() => {
    loadStatus();
    loadBuilds();
    loadMemory();
    loadLogs();
  }, [loadStatus, loadBuilds, loadMemory, loadLogs]);

  useEffect(() => {
    refreshAll();
    const interval = setInterval(refreshAll, 30000);
    return () => clearInterval(interval);
  }, [refreshAll]);

  const handleRedeploy = async () => {
    setRedeploying(true);
    try {
      const res = await fetch("/api/dashboard/redeploy", { method: "POST" });
      const data = await res.json();
      if (data.ok) { setTimeout(loadStatus, 3000); }
    } finally {
      setRedeploying(false);
    }
  };
  
  const handleRefreshLogs = () => {
    setRefreshingLogs(true);
    loadLogs();
  };

  // Status computation matching Mission Control exactly
  let forgeBadge = <span className="mc-badge mc-badge-gray"><span className="mc-dot"></span>LOADING</span>;
  let forgeSub = "\u00A0";
  if (status?.forge) {
    if (status.forge.alive) {
      forgeBadge = <span className="mc-badge mc-badge-green"><span className="mc-dot"></span>LIVE</span>;
      forgeSub = status.forge.latencyMs ? `${status.forge.latencyMs}ms` : "online";
    } else {
      forgeBadge = <span className="mc-badge mc-badge-red"><span className="mc-dot"></span>UNREACHABLE</span>;
      forgeSub = "ping failed";
    }
  }

  let renderBadge = <span className="mc-badge mc-badge-gray"><span className="mc-dot"></span>LOADING</span>;
  let renderSub = "\u00A0";
  if (status?.render) {
    const rState = status.render.state;
    if (rState === "live" || rState === "not_suspended" || rState === "available" || status?.service?.status === "live" || status?.service?.status === "running") {
      renderBadge = <span className="mc-badge mc-badge-green"><span className="mc-dot"></span>LIVE</span>;
    } else if (rState === "no-key") {
      renderBadge = <span className="mc-badge mc-badge-gray">NO KEY</span>;
    } else if (rState === "suspended" || rState === "deactivated" || rState === "unavailable") {
      renderBadge = <span className="mc-badge mc-badge-red"><span className="mc-dot"></span>{rState.toUpperCase()}</span>;
    } else if (rState === "deploying" || rState === "build_in_progress" || status?.service?.status === "deploying") {
      renderBadge = <span className="mc-badge mc-badge-yellow"><span className="mc-dot"></span>DEPLOYING</span>;
    } else {
      renderBadge = <span className="mc-badge mc-badge-yellow"><span className="mc-dot"></span>{rState?.toUpperCase() || status?.service?.status?.toUpperCase() || "UNKNOWN"}</span>;
    }
    
    // Support the older endpoint structure too (from current Dashboard.tsx)
    const updatedAt = status.render.updatedAt || status?.service?.updatedAt;
    if (updatedAt) {
      const diff = (Date.now() - new Date(updatedAt).getTime()) / 1000;
      if (diff < 60) renderSub = Math.round(diff) + "s ago";
      else if (diff < 3600) renderSub = Math.round(diff / 60) + "m ago";
      else if (diff < 86400) renderSub = Math.round(diff / 3600) + "h ago";
      else renderSub = Math.round(diff / 86400) + "d ago";
    }
  }

  let credsBadge = <span className="mc-badge mc-badge-gray"><span className="mc-dot"></span>LOADING</span>;
  let credsSub = "\u00A0";
  const creds = status?.credentials || status?.checks;
  if (creds) {
    const keys = Object.keys(creds);
    const setCount = keys.filter(k => creds[k]).length;
    if (setCount === keys.length) {
      credsBadge = <span className="mc-badge mc-badge-green"><span className="mc-dot"></span>ALL SET</span>;
    } else {
      credsBadge = <span className="mc-badge mc-badge-yellow"><span className="mc-dot"></span>{setCount}/{keys.length} SET</span>;
    }
    const missing = keys.filter(k => !creds[k]);
    credsSub = missing.length ? "missing: " + missing.join(", ") : "all credentials present";
  }

  let brainBadge = <span className="mc-badge mc-badge-gray"><span className="mc-dot"></span>LOADING</span>;
  let brainSub = "\u00A0";
  if (memory?.stats) {
    brainBadge = <span className="mc-badge mc-badge-green"><span className="mc-dot"></span>ONLINE</span>;
    brainSub = `${memory.stats.total || 0} records`;
  } else if (memory && !memory.ok) {
    brainBadge = <span className="mc-badge mc-badge-red">ERROR</span>;
    brainSub = memory.error || "unavailable";
  }

  const maxMemCount = memory?.categories?.reduce((max, c) => Math.max(max, c.count), 0) || 0;

  return (
    <div className="mc-dashboard">
      <div className="mc-status-row">
        <div className="mc-status-card">
          <div className="mc-sc-label">ForgeOS Production</div>
          <div className="mc-sc-value">{forgeBadge}</div>
          <div className="mc-sc-sub">{forgeSub}</div>
        </div>
        <div className="mc-status-card">
          <div className="mc-sc-label">Render Service</div>
          <div className="mc-sc-value">{renderBadge}</div>
          <div className="mc-sc-sub">{renderSub}</div>
        </div>
        <div className="mc-status-card">
          <div className="mc-sc-label">Credentials</div>
          <div className="mc-sc-value">{credsBadge}</div>
          <div className="mc-sc-sub">{credsSub}</div>
        </div>
        <div className="mc-status-card">
          <div className="mc-sc-label">Brain DB</div>
          <div className="mc-sc-value">{brainBadge}</div>
          <div className="mc-sc-sub">{brainSub}</div>
        </div>
      </div>

      <div className="mc-main-area">
        <div className="mc-panel-header">
          <span className="mc-panel-title">Recent Commits — ForgeOS</span>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <span className="mc-panel-live"><span className="mc-panel-live-dot"></span>Live</span>
            <span className="mc-panel-count">{builds.length ? `${builds.length} commits` : ""}</span>
          </div>
        </div>
        <div className="mc-builds-list">
          {loadingBuilds ? (
            <div className="mc-loading-row"><div className="mc-spinner"></div>Fetching commits…</div>
          ) : builds.length > 0 ? (
            builds.map((b, i) => {
              let diff = "";
              if (b.date) {
                 const d = (Date.now() - new Date(b.date).getTime()) / 1000;
                 if (d < 60) diff = Math.round(d) + "s ago";
                 else if (d < 3600) diff = Math.round(d / 60) + "m ago";
                 else if (d < 86400) diff = Math.round(d / 3600) + "h ago";
                 else diff = Math.round(d / 86400) + "d ago";
              }
              return (
                <a key={i} className="mc-build-row" href={b.url || "#"} target="_blank" rel="noopener noreferrer">
                  <div className="mc-build-sha">{b.sha?.slice(0, 7) || "?"}</div>
                  <div className="mc-build-info">
                    <div className="mc-build-message">{b.message?.split("\n")[0]?.slice(0, 90) || "(no message)"}</div>
                    <div className="mc-build-meta">{b.author || "unknown"} &middot; {diff}</div>
                  </div>
                </a>
              );
            })
          ) : (
            <div className="mc-empty-state"><div className="mc-es-icon">📦</div><div className="mc-es-text">No commits found</div></div>
          )}
        </div>
      </div>

      <div className="mc-sidebar">
        <div className="mc-memory-section">
          <div className="mc-panel-header">
            <span className="mc-panel-title">Brain Memory</span>
            <span className="mc-panel-count">{memory?.stats?.total ? `${memory.stats.total} memories` : ""}</span>
          </div>
          <div className="mc-memory-body">
            {loadingMemory ? (
              <div className="mc-loading-row"><div className="mc-spinner"></div>Loading…</div>
            ) : memory?.categories?.length ? (
              <>
                <div className="mc-mem-total">Memory breakdown</div>
                {memory.categories.map((cat, i) => {
                  const pct = maxMemCount > 0 ? Math.round((cat.count / maxMemCount) * 100) : 0;
                  return (
                    <div key={i} className="mc-mem-stat-row">
                      <div className="mc-mem-cat">{cat.category || "uncategorized"}</div>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <div className="mc-mem-bar-wrap"><div className="mc-mem-bar" style={{ width: `${pct}%` }}></div></div>
                        <div className="mc-mem-count">{cat.count}</div>
                      </div>
                    </div>
                  );
                })}
              </>
            ) : (
              <div className="mc-empty-state"><div className="mc-es-text">No data</div></div>
            )}
          </div>
        </div>
        <div className="mc-actions-section">
          <div className="mc-actions-title">Quick Actions</div>
          <div className="mc-actions-grid">
            <button className="mc-action-btn" onClick={handleRedeploy} disabled={redeploying}>
              <span className="mc-ab-icon">🚀</span>
              <span className="mc-ab-label">{redeploying ? "Deploying\u2026" : "Redeploy"}</span>
            </button>
            <button className="mc-action-btn" onClick={handleRefreshLogs} disabled={refreshingLogs}>
              <span className="mc-ab-icon">📋</span>
              <span className="mc-ab-label">Fetch Logs</span>
            </button>
            <a className="mc-action-btn mc-action-link" href="https://github.com/BrianBMorgan/ForgeOS" target="_blank" rel="noopener noreferrer">
              <span className="mc-ab-icon">📦</span><span className="mc-ab-label">GitHub Repo</span>
            </a>
            <a className="mc-action-btn mc-action-link" href="https://forge-os.ai" target="_blank" rel="noopener noreferrer">
              <span className="mc-ab-icon">🌐</span><span className="mc-ab-label">ForgeOS Live</span>
            </a>
          </div>
        </div>
      </div>

      <div className="mc-log-section">
        <div className="mc-panel-header">
          <span className="mc-panel-title">Render Logs</span>
          <span className="mc-panel-count">{logs?.lines?.length ? `${logs.lines.length} lines` : ""}</span>
        </div>
        <div className="mc-log-body">
          {loadingLogs ? (
            <div className="mc-loading-row"><div className="mc-spinner"></div>Loading logs…</div>
          ) : logs?.lines?.length ? (
            logs.lines.map((line, i) => {
              let cls = "mc-log-line";
              if (/error/i.test(line)) cls += " err";
              else if (/warn/i.test(line)) cls += " warn";
              else if (/info|start|listen|deploy/i.test(line)) cls += " info";
              return <div key={i} className={cls}>{line}</div>;
            })
          ) : (
            <div className="mc-empty-state"><div className="mc-es-text">{logs?.error || "No logs"}</div></div>
          )}
        </div>
      </div>
    </div>
  );
}
