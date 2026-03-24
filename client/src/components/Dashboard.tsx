import { useState, useEffect, useCallback } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface StatusData {
  ok: boolean;
  credentials?: Record<string, boolean>;
  render?: { state: string; name: string; updatedAt: string | null };
  forge?: { alive: boolean; latencyMs: number | null };
  timestamp?: string;
  error?: string;
}

interface Build {
  sha: string;
  message: string;
  author: string;
  date: string | null;
  url: string | null;
}

interface MemoryCategory {
  category: string;
  count: number;
}

interface MemoryData {
  ok: boolean;
  stats?: { total: number };
  categories?: MemoryCategory[];
  topMemories?: { content: string; upvotes: number }[];
  error?: string;
}

interface LogData {
  ok: boolean;
  lines?: string[];
  error?: string;
}

interface UsageData {
  ok: boolean;
  totals?: { inputTokens: number; outputTokens: number; costUsd: number };
  byModel?: { model: string; inputTokens: number; outputTokens: number; costUsd: number; calls: number }[];
  error?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function StatusBadge({ state }: { state: string }) {
  const live = state === "live" || state === "not_suspended" || state === "available" || state === "running";
  const bad = state === "suspended" || state === "deactivated" || state === "unavailable" || state === "error" || state === "unreachable";
  const cls = live ? "dash-badge dash-badge-green" : bad ? "dash-badge dash-badge-red" : "dash-badge dash-badge-yellow";
  return <span className={cls}><span className="dash-dot-pulse" />{state.toUpperCase()}</span>;
}

// ── Dashboard component ───────────────────────────────────────────────────────

export default function Dashboard() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [memory, setMemory] = useState<MemoryData | null>(null);
  const [logs, setLogs] = useState<LogData | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string>("");
  const [redeploying, setRedeploying] = useState(false);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);

  const loadStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/dashboard/status");
      setStatus(await r.json());
    } catch { setStatus({ ok: false, error: "Network error" }); }
  }, []);

  const loadBuilds = useCallback(async () => {
    try {
      const r = await fetch("/api/dashboard/builds");
      const d = await r.json();
      setBuilds(d.builds || []);
    } catch { setBuilds([]); }
  }, []);

  const loadMemory = useCallback(async () => {
    try {
      const r = await fetch("/api/dashboard/memory");
      setMemory(await r.json());
    } catch { setMemory({ ok: false, error: "Network error" }); }
  }, []);

  const loadLogs = useCallback(async () => {
    try {
      const r = await fetch("/api/dashboard/logs");
      setLogs(await r.json());
    } catch { setLogs({ ok: false, error: "Network error" }); }
  }, []);

  const loadUsage = useCallback(async () => {
    try {
      const r = await fetch("/api/dashboard/usage");
      setUsage(await r.json());
    } catch { setUsage({ ok: false, error: "Network error" }); }
  }, []);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([loadStatus(), loadBuilds(), loadMemory(), loadLogs(), loadUsage()]);
    setLastUpdated(new Date().toTimeString().slice(0, 8));
    setLoading(false);
  }, [loadStatus, loadBuilds, loadMemory, loadLogs, loadUsage]);

  useEffect(() => {
    refreshAll();
    const interval = setInterval(refreshAll, 30000);
    return () => clearInterval(interval);
  }, [refreshAll]);

  const handleRedeploy = async () => {
    setRedeploying(true);
    try {
      await fetch("/api/dashboard/redeploy", { method: "POST" });
      setTimeout(refreshAll, 4000);
    } finally {
      setRedeploying(false);
    }
  };

  // ── Credential checks ──────────────────────────────────────────────────────
  const creds = status?.credentials || {};
  const credKeys = Object.keys(creds);
  const credSetCount = credKeys.filter(k => creds[k]).length;
  const allCredsSet = credSetCount === credKeys.length && credKeys.length > 0;
  const missingCreds = credKeys.filter(k => !creds[k]);

  // ── Render state ───────────────────────────────────────────────────────────
  const renderState = status?.render?.state || "unknown";
  // ── Brain state ────────────────────────────────────────────────────────────
  const brainTotal = memory?.stats?.total || 0;
  const brainOnline = memory?.ok === true;
  const memCategories = memory?.categories || [];
  const maxCatCount = Math.max(...memCategories.map(c => c.count), 1);

  // ── Log lines ──────────────────────────────────────────────────────────────
  const logLines = logs?.lines || [];

  return (
    <div className="dash-container">

      {/* Header */}
      <div className="dash-header">
        <div>
          <h2 className="dash-title">Mission Control</h2>
          <span className="dash-subtitle">{lastUpdated ? `Updated ${lastUpdated}` : "Loading..."}</span>
        </div>
        <div className="dash-header-actions">
          <button className="dash-btn dash-btn-ghost" onClick={refreshAll} disabled={loading}>
            {loading ? "Refreshing…" : "↻ Refresh"}
          </button>
          <button className="dash-btn dash-btn-primary" onClick={handleRedeploy} disabled={redeploying}>
            {redeploying ? "Deploying…" : "⚡ Redeploy"}
          </button>
        </div>
      </div>

      {/* KPI Status Row */}
      <div className="dash-kpi-row">

        <div className="dash-kpi-card">
          <div className="dash-kpi-label">ForgeOS Production</div>
          <div className="dash-kpi-value">
            {status?.forge?.alive
              ? <span className="dash-badge dash-badge-green"><span className="dash-dot-pulse" />LIVE</span>
              : <span className="dash-badge dash-badge-red"><span className="dash-dot-pulse" />UNREACHABLE</span>}
          </div>
          <div className="dash-kpi-sub">
            {status?.forge?.latencyMs ? `${status.forge.latencyMs}ms` : status?.forge ? "online" : "—"}
          </div>
        </div>

        <div className="dash-kpi-card">
          <div className="dash-kpi-label">Render Service</div>
          <div className="dash-kpi-value">
            {status?.render
              ? <StatusBadge state={renderState} />
              : <span className="dash-badge dash-badge-gray">—</span>}
          </div>
          <div className="dash-kpi-sub">
            {status?.render?.updatedAt ? timeAgo(status.render.updatedAt) : "—"}
          </div>
        </div>

        <div className="dash-kpi-card">
          <div className="dash-kpi-label">Credentials</div>
          <div className="dash-kpi-value">
            {credKeys.length > 0
              ? allCredsSet
                ? <span className="dash-badge dash-badge-green"><span className="dash-dot-pulse" />ALL SET</span>
                : <span className="dash-badge dash-badge-yellow"><span className="dash-dot-pulse" />{credSetCount}/{credKeys.length} SET</span>
              : <span className="dash-badge dash-badge-gray">—</span>}
          </div>
          <div className="dash-kpi-sub">
            {missingCreds.length ? `missing: ${missingCreds.join(", ")}` : "all credentials present"}
          </div>
        </div>

        <div className="dash-kpi-card">
          <div className="dash-kpi-label">Brain</div>
          <div className="dash-kpi-value">
            {memory
              ? brainOnline
                ? <span className="dash-badge dash-badge-green"><span className="dash-dot-pulse" />ONLINE</span>
                : <span className="dash-badge dash-badge-red">OFFLINE</span>
              : <span className="dash-badge dash-badge-gray">—</span>}
          </div>
          <div className="dash-kpi-sub">{brainTotal > 0 ? `${brainTotal} records` : "—"}</div>
        </div>

      </div>

      {/* Main grid */}
      <div className="dash-grid">

        {/* Recent Commits */}
        <div className="dash-panel">
          <div className="dash-panel-header">
            <span className="dash-panel-title">Recent Commits</span>
            <span className="dash-panel-count">{builds.length > 0 ? `${builds.length} commits` : ""}</span>
          </div>
          <div className="dash-builds-list">
            {builds.length === 0
              ? <div className="dash-empty">Loading commits…</div>
              : builds.slice(0, 12).map((b, i) => (
                <div key={i} className="dash-build-row">
                  <code className="dash-build-sha">{b.sha}</code>
                  <span className="dash-build-msg">{b.message}</span>
                  <span className="dash-build-meta">
                    {b.author} {b.date ? `· ${timeAgo(b.date)}` : ""}
                  </span>
                </div>
              ))
            }
          </div>
        </div>

        {/* Right column: Memory + Logs */}
        <div className="dash-right-col">

          {/* Brain Memory */}
          <div className="dash-panel">
            <div className="dash-panel-header">
              <span className="dash-panel-title">Brain Memory</span>
              <span className="dash-panel-count">{brainTotal > 0 ? `${brainTotal} total` : ""}</span>
            </div>
            <div className="dash-memory-body">
              {!memory
                ? <div className="dash-empty">Loading…</div>
                : !memory.ok
                  ? <div className="dash-empty dash-error">{memory.error}</div>
                  : memCategories.length === 0
                    ? <div className="dash-empty">No data</div>
                    : <>
                        <div className="dash-mem-total">Memory breakdown</div>
                        {memCategories.map((cat, i) => {
                          const pct = Math.round((cat.count / maxCatCount) * 100);
                          return (
                            <div key={i} className="dash-mem-row">
                              <div className="dash-mem-cat">{cat.category}</div>
                              <div className="dash-mem-bar-wrap">
                                <div className="dash-mem-bar" style={{ width: `${pct}%` }} />
                              </div>
                              <div className="dash-mem-count">{cat.count}</div>
                            </div>
                          );
                        })}
                      </>
              }
            </div>
          </div>

          {/* Render Logs */}
          <div className="dash-panel dash-panel-logs">
            <div className="dash-panel-header">
              <span className="dash-panel-title">Render Logs</span>
              <span className="dash-panel-count">{logLines.length > 0 ? `${logLines.length} lines` : ""}</span>
            </div>
            <div className="dash-log-body">
              {!logs
                ? <div className="dash-empty">Loading…</div>
                : !logs.ok || logLines.length === 0
                  ? <div className="dash-empty">{logs.error || "No logs"}</div>
                  : logLines.map((line, i) => {
                      const cls = /error/i.test(line) ? "dash-log-err"
                        : /warn/i.test(line) ? "dash-log-warn"
                        : /info|start|listen|deploy/i.test(line) ? "dash-log-info"
                        : "";
                      return <div key={i} className={`dash-log-line ${cls}`}>{line}</div>;
                    })
              }
            </div>
          </div>

          {/* Usage & Cost */}
          <div className="dash-panel">
            <div className="dash-panel-header">
              <span className="dash-panel-title">Anthropic Usage</span>
              <span className="dash-panel-count">
                {usage?.totals ? `$${usage.totals.costUsd.toFixed(4)}` : ""}
              </span>
            </div>
            <div className="dash-usage-body">
              {!usage
                ? <div className="dash-empty">Loading…</div>
                : !usage.ok
                  ? <div className="dash-empty dash-error">{usage.error}</div>
                  : <>
                      <div className="dash-usage-totals">
                        <div className="dash-usage-stat">
                          <div className="dash-usage-val">{(usage.totals?.inputTokens ?? 0).toLocaleString()}</div>
                          <div className="dash-usage-lbl">Input tokens</div>
                        </div>
                        <div className="dash-usage-stat">
                          <div className="dash-usage-val">{(usage.totals?.outputTokens ?? 0).toLocaleString()}</div>
                          <div className="dash-usage-lbl">Output tokens</div>
                        </div>
                        <div className="dash-usage-stat dash-usage-cost">
                          <div className="dash-usage-val">${(usage.totals?.costUsd ?? 0).toFixed(4)}</div>
                          <div className="dash-usage-lbl">Total cost</div>
                        </div>
                      </div>
                      {(usage.byModel || []).map((m, i) => (
                        <div key={i} className="dash-usage-row">
                          <div className="dash-usage-model">{m.model.replace("claude-", "").replace("-4-5", "").replace("-4-6", "")}</div>
                          <div className="dash-usage-calls">{m.calls} calls</div>
                          <div className="dash-usage-tokens">{((m.inputTokens + m.outputTokens) / 1000).toFixed(1)}k tok</div>
                          <div className="dash-usage-price">${m.costUsd.toFixed(4)}</div>
                        </div>
                      ))}
                      {(!usage.byModel || usage.byModel.length === 0) &&
                        <div className="dash-empty">No usage yet — start a build</div>}
                    </>
              }
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
