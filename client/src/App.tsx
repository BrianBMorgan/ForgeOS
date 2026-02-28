import { useState, useEffect, useCallback, useRef } from "react";
import logo from "./ForgeOS_1772241278038.png";
import PromptColumn from "./components/PromptColumn";
import Workspace from "./components/Workspace";

type NavId = "new-build" | "active-runs" | "templates" | "logs" | "settings";

const navItems: { id: NavId; label: string; icon: string }[] = [
  { id: "new-build", label: "New Build", icon: "+" },
  { id: "active-runs", label: "Active Runs", icon: "▶" },
  { id: "templates", label: "Templates", icon: "❖" },
  { id: "logs", label: "Logs", icon: "☰" },
  { id: "settings", label: "Settings", icon: "⚙" },
];

export interface RunData {
  id: string;
  prompt: string;
  status: string;
  currentStage: string;
  stages: Record<
    string,
    { status: string; output: unknown }
  >;
  error: string | null;
  createdAt: number;
}

const API_BASE = "/api";

function App() {
  const [collapsed, setCollapsed] = useState(false);
  const [activeNav, setActiveNav] = useState<NavId>("new-build");
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [runData, setRunData] = useState<RunData | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startRun = useCallback(async (prompt: string) => {
    const res = await fetch(`${API_BASE}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const data = await res.json();
    if (data.id) {
      setCurrentRunId(data.id);
    }
  }, []);

  const approveRun = useCallback(async () => {
    if (!currentRunId) return;
    await fetch(`${API_BASE}/runs/${currentRunId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
  }, [currentRunId]);

  const rejectRun = useCallback(
    async (feedback: string) => {
      if (!currentRunId) return;
      await fetch(`${API_BASE}/runs/${currentRunId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback }),
      });
    },
    [currentRunId]
  );

  useEffect(() => {
    if (!currentRunId) {
      setRunData(null);
      return;
    }

    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/runs/${currentRunId}`);
        if (res.ok) {
          const data: RunData = await res.json();
          setRunData(data);

          if (
            data.status === "completed" ||
            data.status === "failed"
          ) {
            if (pollRef.current) {
              clearInterval(pollRef.current);
              pollRef.current = null;
            }
          }
        }
      } catch {
        // silent retry
      }
    };

    poll();
    pollRef.current = setInterval(poll, 2000);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [currentRunId]);

  return (
    <div className="shell">
      <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
        <div className="logo">
          <img src={logo} alt="ForgeOS" className="logo-img" />
        </div>
        <nav className="nav">
          {navItems.map((item) => (
            <div
              key={item.id}
              className={`nav-item ${activeNav === item.id ? "active" : ""}`}
              onClick={() => setActiveNav(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
              <span className="nav-label">{item.label}</span>
            </div>
          ))}
        </nav>
      </aside>

      <div className="main-area">
        <header className="topbar">
          <button
            className="toggle"
            onClick={() => setCollapsed(!collapsed)}
          >
            ☰
          </button>
          <div className="status">System Kernel Online</div>
        </header>

        <div className="content-split">
          <PromptColumn
            runData={runData}
            onRunBuild={startRun}
            onApprove={approveRun}
            onReject={rejectRun}
          />
          <Workspace runData={runData} />
        </div>
      </div>
    </div>
  );
}

export default App;
