import { useState, useEffect, useCallback, useRef } from "react";
import logo from "./ForgeOS_1772241278038.png";
import logoStacked from "./ForgeOS_Stacked.png";
import PromptColumn from "./components/PromptColumn";
import Workspace from "./components/Workspace";

import ProjectsList from "./components/ProjectsList";
import Settings from "./components/Settings";
import Assets from "./components/Assets";

type NavId = "new-project" | "projects" | "assets" | "settings";

const navItems: { id: NavId; label: string; icon: string }[] = [
  { id: "new-project", label: "New Project", icon: "+" },
  { id: "projects", label: "Projects", icon: "▶" },
  { id: "assets", label: "Assets", icon: "◈" },
  { id: "settings", label: "Settings", icon: "⚙" },
];

export interface WorkspaceStatus {
  status: string;
  port: number | null;
  error: string | null;
}

export interface TokenStageUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
}

export interface TokenUsage {
  stages: Record<string, TokenStageUsage>;
  totals: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

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
  workspace?: WorkspaceStatus;
  projectId?: string | null;
  iterationNumber?: number;
  tokenUsage?: TokenUsage;
  isSuggestion?: boolean;
  suggestionTarget?: string | null;
}

export interface IterationData {
  runId: string;
  prompt: string;
  iterationNumber: number;
  createdAt: number;
  status: string;
  workspaceStatus: string | null;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  suggestBuild: boolean;
  buildSuggestion: string | null;
  createdAt: number;
}

export interface ProjectData {
  id: string;
  name: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  iterations: IterationData[];
  currentRunId: string | null;
  currentRun: RunData | null;
}

const API_BASE = "/api";

function App() {
  const [collapsed, setCollapsed] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [activeNav, setActiveNav] = useState<NavId>("new-project");
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [projectData, setProjectData] = useState<ProjectData | null>(null);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [runData, setRunData] = useState<RunData | null>(null);
  const [viewingIterationRunId, setViewingIterationRunId] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [mobileView, setMobileView] = useState<"chat" | "workspace">("chat");
  const [pendingPlan, setPendingPlan] = useState<{ prompt: string; plan: Record<string, unknown> } | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const projectPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startProject = useCallback(async (prompt: string) => {
    const res = await fetch(`${API_BASE}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const data = await res.json();
    if (data.id) {
      setCurrentProjectId(data.id);
      setCurrentRunId(data.runId);
      setViewingIterationRunId(null);
      setActiveNav("projects");
    }
  }, []);

  const iterateProject = useCallback(async (prompt: string, options?: { skipPlan?: boolean }) => {
    if (!currentProjectId) return;

    // Build suggestions from the Chat Agent are already surgical single-file instructions —
    // skip the plan gate and fire the builder directly with the suggestion as the constraint.
    if (options?.skipPlan) {
      window.dispatchEvent(new CustomEvent("forgeos:switch-tab", { detail: "plan" }));
      const res = await fetch(`${API_BASE}/projects/${currentProjectId}/iterate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, isSuggestion: true }),
      });
      const data = await res.json();
      if (data.runId) {
        setCurrentRunId(data.runId);
        setViewingIterationRunId(null);
      }
      return;
    }

    // Normal path — run the planner first and show the approval gate.
    setPlanLoading(true);
    setPendingPlan(null);
    window.dispatchEvent(new CustomEvent("forgeos:switch-tab", { detail: "plan" }));
    try {
      const res = await fetch(`${API_BASE}/projects/${currentProjectId}/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json();
      if (data.plan) {
        setPendingPlan({ prompt, plan: data.plan });
      }
    } catch (err) {
      console.error("[plan] Failed to generate plan:", err);
    } finally {
      setPlanLoading(false);
    }
  }, [currentProjectId]);

  const approvePlan = useCallback(async () => {
    if (!currentProjectId || !pendingPlan) return;
    setPendingPlan(null);
    const res = await fetch(`${API_BASE}/projects/${currentProjectId}/iterate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: pendingPlan.prompt, approvedPlan: pendingPlan.plan }),
    });
    const data = await res.json();
    if (data.runId) {
      setCurrentRunId(data.runId);
      setViewingIterationRunId(null);
    }
  }, [currentProjectId, pendingPlan]);

  const revisePlan = useCallback(() => {
    setPendingPlan(null);
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

  const sendChat = useCallback(async (message: string) => {
    if (!currentProjectId) return;
    const userMsg: ChatMessage = { role: "user", content: message, suggestBuild: false, buildSuggestion: null, createdAt: Date.now() };
    setChatMessages((prev) => [...prev, userMsg]);
    setChatLoading(true);
    try {
      const res = await fetch(`${API_BASE}/projects/${currentProjectId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (res.ok) {
        const data: ChatMessage = await res.json();
        setChatMessages((prev) => [...prev, data]);
      } else {
        let errorMsg = "Something went wrong. Please try again.";
        try {
          const errData = await res.json();
          if (errData.error) errorMsg = errData.error;
        } catch {}
        setChatMessages((prev) => [...prev, { role: "assistant", content: errorMsg, suggestBuild: false, buildSuggestion: null, createdAt: Date.now() }]);
      }
    } catch {
      setChatMessages((prev) => [...prev, { role: "assistant", content: "Connection error. Please try again.", suggestBuild: false, buildSuggestion: null, createdAt: Date.now() }]);
    } finally {
      setChatLoading(false);
    }
  }, [currentProjectId]);

  const openProject = useCallback((projectId: string) => {
    setCurrentProjectId(projectId);
    setViewingIterationRunId(null);
    setChatMessages([]);
    setActiveNav("projects");
  }, []);

  useEffect(() => {
    if (!currentProjectId) {
      setProjectData(null);
      setCurrentRunId(null);
      setRunData(null);
      setChatMessages([]);
      return;
    }

    const loadChat = async () => {
      try {
        const res = await fetch(`${API_BASE}/projects/${currentProjectId}/chat`);
        if (res.ok) {
          const data: ChatMessage[] = await res.json();
          setChatMessages(data);
        }
      } catch {
      }
    };
    loadChat();

    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/projects/${currentProjectId}`);
        if (res.ok) {
          const data: ProjectData = await res.json();
          setProjectData(data);
          if (data.currentRunId) {
            setCurrentRunId(data.currentRunId);
          }
        }
      } catch {
      }
    };

    poll();
    projectPollRef.current = setInterval(poll, 3000);

    return () => {
      if (projectPollRef.current) {
        clearInterval(projectPollRef.current);
        projectPollRef.current = null;
      }
    };
  }, [currentProjectId]);

  useEffect(() => {
    const activeRunId = viewingIterationRunId || currentRunId;
    if (!activeRunId) {
      setRunData(null);
      return;
    }

    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/runs/${activeRunId}`);
        if (res.ok) {
          const data: RunData = await res.json();
          setRunData(data);

          if (
            !viewingIterationRunId &&
            (data.status === "completed" || data.status === "failed")
          ) {
            if (pollRef.current) {
              clearInterval(pollRef.current);
              pollRef.current = null;
            }
          }
        }
      } catch {
      }
    };

    poll();
    if (!viewingIterationRunId) {
      pollRef.current = setInterval(poll, 2000);
    }

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [currentRunId, viewingIterationRunId]);

  const refreshRunData = useCallback(async () => {
    const activeRunId = viewingIterationRunId || currentRunId;
    if (!activeRunId) return;
    try {
      const res = await fetch(`${API_BASE}/runs/${activeRunId}`);
      if (res.ok) {
        const data: RunData = await res.json();
        setRunData(data);
      }
    } catch {}
  }, [currentRunId, viewingIterationRunId]);

  const handleNavClick = (navId: NavId) => {
    setActiveNav(navId);
    if (navId === "new-project" || navId === "projects") {
      setCurrentProjectId(null);
      setCurrentRunId(null);
      setRunData(null);
      setProjectData(null);
      setViewingIterationRunId(null);
    }
  };

  const viewIteration = useCallback((runId: string) => {
    setViewingIterationRunId(runId);
  }, []);

  const viewLatest = useCallback(() => {
    setViewingIterationRunId(null);
  }, []);

  const renderMainContent = () => {
    if (activeNav === "settings") {
      return <Settings />;
    }

    if (activeNav === "assets") {
      return <Assets />;
    }

    if (activeNav === "projects" && !currentProjectId) {
      return <ProjectsList onSelectProject={openProject} />;
    }

    return (
      <>
        <div className={`mobile-panel mobile-panel-chat ${mobileView === "chat" ? "mobile-active" : ""} ${chatCollapsed ? "chat-collapsed" : ""}`}>
          <button
            className="chat-collapse-tab"
            onClick={() => setChatCollapsed(c => !c)}
            title={chatCollapsed ? "Expand chat" : "Collapse chat"}
          >{chatCollapsed ? "›" : "‹"}</button>
          <PromptColumn
            runData={runData}
            projectData={projectData}
            isNewProject={activeNav === "new-project"}
            onRunBuild={currentProjectId ? iterateProject : startProject}
            onApprove={approveRun}
            onReject={rejectRun}
            onViewIteration={viewIteration}
            viewingIterationRunId={viewingIterationRunId}
            onViewLatest={viewLatest}
            chatMessages={chatMessages}
            onSendChat={sendChat}
            chatLoading={chatLoading}
            onClearBuildSuggestions={() => setChatMessages(prev => prev.map(m => ({ ...m, suggestBuild: false })))}
          />
        </div>
        <div className={`mobile-panel mobile-panel-workspace ${mobileView === "workspace" ? "mobile-active" : ""}`}>
          <Workspace
            runData={runData}
            projectData={projectData}
            viewingIterationRunId={viewingIterationRunId}
            onRefreshRunData={refreshRunData}
            pendingPlan={pendingPlan}
            planLoading={planLoading}
            onApprovePlan={approvePlan}
            onRevisePlan={revisePlan}
          />
        </div>
        <div className="mobile-view-toggle">
          <button
            className={`mobile-toggle-btn ${mobileView === "chat" ? "active" : ""}`}
            onClick={() => setMobileView("chat")}
          >
            Chat
          </button>
          <button
            className={`mobile-toggle-btn ${mobileView === "workspace" ? "active" : ""}`}
            onClick={() => setMobileView("workspace")}
          >
            Workspace
          </button>
        </div>
      </>
    );
  };

  return (
    <div className="shell">
      <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
        <div className="logo">
          <img src={logo} alt="ForgeOS" className={`logo-img logo-wide ${collapsed ? "hidden" : ""}`} />
          <img src={logoStacked} alt="ForgeOS" className={`logo-img logo-stacked ${collapsed ? "" : "hidden"}`} />
        </div>
        <nav className="nav">
          {navItems.map((item) => (
            <div
              key={item.id}
              className={`nav-item ${activeNav === item.id ? "active" : ""}`}
              onClick={() => handleNavClick(item.id)}
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
          <div className="status">
            {projectData ? (
              <>
                <span className="topbar-project-name">{projectData.name}</span>
                <span className="topbar-separator">|</span>
              </>
            ) : null}
            System Kernel Online
          </div>
        </header>

        <div className={`content-split ${activeNav === "new-project" || (activeNav === "projects" && currentProjectId) ? "has-mobile-toggle" : ""}`}>
          {renderMainContent()}
        </div>
      </div>
    </div>
  );
}

export default App;

