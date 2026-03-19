import { useState, useEffect, useCallback, useRef } from "react";
import logo from "./ForgeOS_1772241278038.png";
import logoStacked from "./ForgeOS_Stacked.png";
import PromptColumn from "./components/PromptColumn";
import Workspace from "./components/Workspace";

import ProjectsList from "./components/ProjectsList";
import Settings from "./components/Settings";
import Assets from "./components/Assets";

type NavId = "projects" | "assets" | "settings";

const navItems: { id: NavId; label: string; icon: string }[] = [
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
  id: string;              // stable unique id — never used for filtering logic
  role: "user" | "assistant";
  content: string;
  toolStatus?: string;
  pending?: boolean;       // true while streaming — replaces isLive
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
  const [collapsed, setCollapsed] = useState(true);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [activeNav, setActiveNav] = useState<NavId>("projects");
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [projectData, setProjectData] = useState<ProjectData | null>(null);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [runData, setRunData] = useState<RunData | null>(null);
  const [viewingIterationRunId, setViewingIterationRunId] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [mobileView, setMobileView] = useState<"chat" | "workspace">("chat");

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const projectPollRef = useRef<ReturnType<typeof setInterval> | null>(null);



  const sendChat = useCallback(async (message: string, attachments?: {name: string; dataUrl: string; mimeType: string}[]) => {
    // New project flow — create project first, then send as first chat turn
    let projectId = currentProjectId;
    if (!projectId) {
      try {
        const res = await fetch(`${API_BASE}/projects`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: message }),
        });
        const data = await res.json();
        if (!data.id) return;
        projectId = data.id;
        setCurrentProjectId(data.id);
        setCurrentRunId(null);
        setViewingIterationRunId(null);
        setActiveNav("projects");
      } catch { return; }
    }

    const now = Date.now();
    const userMsg: ChatMessage = { id: `u-${now}`, role: "user", content: message, createdAt: now };
    const pendingId = `a-${now}`;
    const pendingMsg: ChatMessage = { id: pendingId, role: "assistant", content: "", pending: true, createdAt: now + 1 };

    // Append user message and pending assistant bubble — they never get deleted
    setChatMessages((prev) => [...prev, userMsg, pendingMsg]);
    setChatLoading(true);

    // Helper: update the pending bubble in place by id
    const updatePending = (patch: Partial<ChatMessage>) => {
      setChatMessages((prev) => prev.map(m => m.id === pendingId ? { ...m, ...patch } : m));
    };

    try {
      const res = await fetch(`${API_BASE}/projects/${projectId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, skillContext: "", attachments: attachments || [] }),
      });

      if (!res.ok || !res.body) {
        updatePending({ content: "Something went wrong. Please try again.", pending: false });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";

        for (const part of parts) {
          if (!part.startsWith("data: ")) continue;
          let evt: any;
          try { evt = JSON.parse(part.slice(6)); } catch { continue; }

          if (evt.type === "thinking") {
            const text = (evt.content || "").trim();
            if (text.length > 10) updatePending({ content: text });
          } else if (evt.type === "tool_status") {
            updatePending({ toolStatus: evt.content });
          } else if (evt.type === "agent_message") {
            updatePending({ content: evt.content });
          } else if (evt.type === "run_created") {
            setCurrentRunId(evt.runId);
            setViewingIterationRunId(null);
            setActiveNav("projects");
            updatePending({ content: "Installing and starting app..." });
          } else if (evt.type === "done") {
            // Finalize the pending bubble — mark it done, set final content
            updatePending({ content: evt.content || "Done.", pending: false, toolStatus: undefined });
            if (evt.building && evt.runId) {
              setCurrentRunId(evt.runId);
              setViewingIterationRunId(null);
              setActiveNav("projects");
            }
          } else if (evt.type === "error") {
            updatePending({ content: evt.error || "Something went wrong.", pending: false });
          }
        }
      }
    } catch {
      updatePending({ content: "Connection error. Please try again.", pending: false });
    } finally {
      setChatLoading(false);
    }
  }, [currentProjectId, setCurrentProjectId, setCurrentRunId, setViewingIterationRunId, setActiveNav]);

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
          setChatMessages((prev) => {
            // Never overwrite a live session
            if (prev.some(m => m.pending)) return prev;
            // Stable unique ids for history — never collide with pending bubble ids
            const base = Date.now() - data.length * 1000;
            return data.map((m: any, idx: number) => ({
              id: `h-${base + idx}`,
              role: m.role as "user" | "assistant",
              content: m.content || "",
              createdAt: base + idx,
            }));
          });
        }
      } catch {}
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

  const handleNewProject = () => {
    setActiveNav("projects");
    setCurrentProjectId(null);
    setCurrentRunId(null);
    setRunData(null);
    setProjectData(null);
    setViewingIterationRunId(null);
  };

  const handleNavClick = (navId: NavId) => {
    setActiveNav(navId);
    if (navId === "projects") {
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

  const restoreIteration = useCallback(async (runId: string) => {
    if (!currentProjectId) return;
    const res = await fetch(`/api/projects/${currentProjectId}/restore/${runId}`, { method: "POST" });
    const data = await res.json();
    if (data.currentRunId) {
      setCurrentRunId(data.currentRunId);
      setViewingIterationRunId(null);
    }
  }, [currentProjectId]);

  const renderMainContent = () => {
    if (activeNav === "settings") {
      return <Settings />;
    }

    if (activeNav === "assets") {
      return <Assets />;
    }

    if (activeNav === "projects" && !currentProjectId) {
      return <ProjectsList onSelectProject={openProject} onNewProject={handleNewProject} />;
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
            isNewProject={!currentProjectId}
            onViewIteration={viewIteration}
            viewingIterationRunId={viewingIterationRunId}
            onViewLatest={viewLatest}
            onRestoreIteration={restoreIteration}
            chatMessages={chatMessages}
            onSendChat={sendChat}
            chatLoading={chatLoading}
          />
        </div>
        <div className={`mobile-panel mobile-panel-workspace ${mobileView === "workspace" ? "mobile-active" : ""}`}>
          <Workspace
            runData={runData}
            projectData={projectData}
            viewingIterationRunId={viewingIterationRunId}
            onRefreshRunData={refreshRunData}
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
              <span className="topbar-project-name">{projectData.name}</span>
            ) : null}
          </div>
        </header>

        <div className={`content-split ${activeNav === "projects" && currentProjectId ? "has-mobile-toggle" : ""}`}>
          {renderMainContent()}
        </div>
      </div>
    </div>
  );
}

export default App;



