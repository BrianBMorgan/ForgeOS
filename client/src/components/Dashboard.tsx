import { useState, useEffect, useCallback } from "react";

interface ServiceStatus {
  ok: boolean;
  service?: { name: string; status: string; branch: string; updatedAt: string };
  deploys?: { status: string; createdAt: string; commit?: { message: string } }[];
  checks?: Record<string, boolean>;
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
  stats?: { total: number; topMistakes: { content: string; upvotes: number }[] };
  categories?: { category: string; count: number }[];
  error?: string;
}

export default function Dashboard() {
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [memory, setMemory] = useState<MemoryStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [redeploying, setRedeploying] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [statusRes, buildsRes, memoryRes] = await Promise.all([
        fetch("/api/dashboard/status").then(r => r.json()),
        fetch("/api/dashboard/builds").then(r => r.json()),
        fetch("/api/brain").then(r => r.json()),
      ]);
      setStatus(statusRes);
      setBuilds(buildsRes.commits || []);
      setMemory({ ok: true, stats: memoryRes });
      setLastRefresh(new Date());
    } catch (e) {
      console.error("Dashboard refresh error:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30000);
    return () => clearInterval(interval);
  }, [refresh]);

  const handleRedeploy = async () => {
    setRedeploying(true);
    try {
      const res = await fetch("/api/dashboard/redeploy", { method: "POST" });
      const data = await res.json();
      if (data.ok) { setTimeout(refresh, 3000); }
    } finally {
      setRedeploying(false);
    }
  };

  const serviceStatus = status?.service?.status || "unknown";
  const isLive = serviceStatus === "live" || serviceStatus === "running";
  const isDeploying = serviceStatus === "deploying" || serviceStatus === "build_in_progress";

  return (
    <div className="dashboard-container">
      <div className="dashboard-header">
        <div>
          <h2 className="dashboard-title">Mission Control</h2>
          <span className="dashboard-subtitle">
            {lastRefresh ? `Last updated ${lastRefresh.toLocaleTimeString()}` : "Loading..."}
          </span>
        </div>
        <div className="dashboard-actions">
          <button className="dash-btn dash-btn-secondary" onClick={refresh} disabled={loading}>
            {loading ? "Refreshing..." : "↻ Refresh"}
          </button>
          <button className="dash-btn dash-btn-primary" onClick={handleRedeploy} disabled={redeploying}>
            {redeploying ? "Deploying..." : "⚡ Redeploy"}
          </button>
        </div>
      </div>

      <div className="dashboard-grid">
        {/* Service Status */}
        <div className="dash-card">
          <div className="dash-card-title">ForgeOS Service</div>
          <div className="dash-status-row">
            <span className={`dash-dot ${isLive ? "dot-live" : isDeploying ? "dot-deploying" : "dot-offline"}`} />
            <span className="dash-status-label">
              {isLive ? "Live" : isDeploying ? "Deploying" : serviceStatus}
            </span>
          </div>
          {status?.service && (
            <div className="dash-meta">
              <div>Branch: <code>{status.service.branch}</code></div>
              <div>Updated: {new Date(status.service.updatedAt).toLocaleString()}</div>
            </div>
          )}
          <div className="dash-checks">
            {status?.checks && Object.entries(status.checks).map(([k, v]) => (
              <span key={k} className={`dash-check ${v ? "check-ok" : "check-fail"}`}>
                {v ? "✓" : "✗"} {k}
              </span>
            ))}
          </div>
        </div>

        {/* Brain Memory */}
        <div className="dash-card">
          <div className="dash-card-title">Brain Memory</div>
          {memory?.stats ? (
            <>
              <div className="dash-stat-big">{(memory.stats as any).totals?.total || "—"}</div>
              <div className="dash-stat-label">Total Memories</div>
              <div className="dash-memory-cats">
                {((memory.stats as any).topMistakes || []).slice(0, 3).map((m: any, i: number) => (
                  <div key={i} className="dash-memory-item">
                    <span className="dash-memory-badge">↑{m.upvotes}</span>
                    <span className="dash-memory-text">{m.content?.slice(0, 80)}...</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="dash-empty">Loading brain stats...</div>
          )}
        </div>

        {/* Recent Builds */}
        <div className="dash-card dash-card-wide">
          <div className="dash-card-title">Recent Commits</div>
          {builds.length > 0 ? (
            <div className="dash-builds">
              {builds.slice(0, 8).map((b, i) => (
                <div key={i} className="dash-build-row">
                  <code className="dash-sha">{b.sha?.slice(0, 7)}</code>
                  <span className="dash-build-msg">{b.message?.split("\n")[0]?.slice(0, 72)}</span>
                  <span className="dash-build-meta">{b.author} · {b.date ? new Date(b.date).toLocaleDateString() : ""}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="dash-empty">{loading ? "Loading commits..." : "No commits found"}</div>
          )}
        </div>
      </div>
    </div>
  );
}
