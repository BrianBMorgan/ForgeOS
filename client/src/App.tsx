import React, { useState, useEffect, useCallback, useRef } from "react";
import { AppWindowMac, FileBox, Settings as SettingsIcon, LayoutDashboard } from "lucide-react";
import logo from "./ForgeOS_1772241278038.png";
import logoStacked from "./ForgeOS_Stacked.png";
import PromptColumn from "./components/PromptColumn";
import Workspace from "./components/Workspace";
import ProjectsList from "./components/ProjectsList";
import Settings from "./components/Settings";
import Assets from "./components/Assets";
import Dashboard from "./components/Dashboard";

type NavId = "projects" | "assets" | "settings" | "dashboard";

const navItems: { id: NavId; label: string; icon: React.ReactNode }[] = [
  { id: "projects", label: "Projects", icon: <AppWindowMac size={18} strokeWidth={1.5} /> },
  { id: "assets",   label: "Assets",   icon: <FileBox size={18} strokeWidth={1.5} /> },
  { id: "settings", label: "Settings", icon: <SettingsIcon size={18} strokeWidth={1.5} /> },
  { id: "dashboard", label: "Dashboard", icon: <LayoutDashboard size={18} strokeWidth={1.5} /> },
];

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolStatus?: string;
  pending?: boolean;
  approval?: { id: string; tool: string; input: Record<string, unknown>; status: "pending" | "approved" | "rejected" };
  createdAt: number;
}

export interface ProjectData {
  id: string;
  name: string;
  slug?: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
}

const API_BASE = "/api";

function App() {
  const [collapsed, setCollapsed] = useState(true);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [activeNav, setActiveNav] = useState<NavId>("projects");
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [projectData, setProjectData] = useState<ProjectData | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [injectContext, setInjectContext] = useState<string | null>(null);

  // Listen for element captures from inspect tool
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as string;
      setInjectContext(detail);
    };
    window.addEventListener("forge:inject_context", handler);
    return () => window.removeEventListener("forge:inject_context", handler);
  }, []);
  const [mobileView, setMobileView] = useState<"chat" | "workspace">("chat");
  const [isNewProjectMode, setIsNewProjectMode] = useState(false);
  const [stagedBrandIds, setStagedBrandIds] = useState<number[]>([]);

  const projectPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const sendChat = useCallback(async (message: string, attachments?: { name: string; dataUrl: string; mimeType: string }[]) => {
    let projectId = currentProjectId;
    if (!projectId) {
      try {
        const res = await fetch(`${API_BASE}/projects`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: message, brandIds: stagedBrandIds }),
        });
        const data = await res.json();
        if (!data.id) return;
        projectId = data.id;
        setCurrentProjectId(data.id);
        setIsNewProjectMode(false);
        setActiveNav("projects");
        setStagedBrandIds([]); // consumed — actual selection now lives on the project
      } catch { return; }
    }

    const now = Date.now();
    const userMsg: ChatMessage = { id: `u-${now}`, role: "user", content: message, createdAt: now };
    const pendingId = `a-${now}`;
    const pendingMsg: ChatMessage = { id: pendingId, role: "assistant", content: "", pending: true, createdAt: now + 1 };

    setChatMessages((prev) => [...prev, userMsg, pendingMsg]);
    setChatLoading(true);

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
          } else if (evt.type === "approval_required") {
            // Pause UI — show approval card on the pending message
            updatePending({ approval: { id: evt.approvalId, tool: evt.tool, input: evt.input, status: "pending" } });
          } else if (evt.type === "file_committed") {
            // A file was committed — trigger deploy poll so UI lights up when Render goes live
            window.dispatchEvent(new CustomEvent("forge:file_committed", { detail: { branch: evt.branch, commit: evt.commit } }));
          } else if (evt.type === "done") {
            updatePending({ content: evt.content || "Done.", pending: false, toolStatus: undefined });
            // Signal workspace to refresh files and commits tabs
            window.dispatchEvent(new CustomEvent("forge:build_complete"));
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
  }, [currentProjectId, setCurrentProjectId, setIsNewProjectMode, setActiveNav, stagedBrandIds]);

  // Handle approval/rejection from chat approval cards
  const handleApproval = useCallback(async (approvalId: string, approved: boolean | string) => {
    if (!currentProjectId) return;
    try {
      await fetch(`${API_BASE}/projects/${currentProjectId}/chat/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvalId, approved }),
      });
      // Update the message to reflect approval status
      setChatMessages(prev => prev.map(m =>
        m.approval?.id === approvalId
          ? { ...m, approval: { ...m.approval, status: approved ? "approved" : "rejected" } }
          : m
      ));
    } catch (err) {
      console.error("[approval] error:", err);
    }
  }, [currentProjectId]);

  const openProject = useCallback((projectId: string) => {
    setCurrentProjectId(projectId);
    setChatMessages([]);
    setIsNewProjectMode(false);
    setActiveNav("projects");
  }, []);

  // Load project data and chat history when project changes
  useEffect(() => {
    if (!currentProjectId) {
      setProjectData(null);
      setChatMessages([]);
      if (projectPollRef.current) {
        clearInterval(projectPollRef.current);
        projectPollRef.current = null;
      }
      return;
    }

    const loadChat = async () => {
      try {
        const res = await fetch(`${API_BASE}/projects/${currentProjectId}/chat`);
        if (res.ok) {
          const data: ChatMessage[] = await res.json();
          setChatMessages((prev) => {
            if (prev.some(m => m.pending)) return prev;
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
        }
      } catch {}
    };

    poll();
    projectPollRef.current = setInterval(poll, 5000);

    return () => {
      if (projectPollRef.current) {
        clearInterval(projectPollRef.current);
        projectPollRef.current = null;
      }
    };
  }, [currentProjectId]);

  const handleNewProject = () => {
    setActiveNav("projects");
    setCurrentProjectId(null);
    setProjectData(null);
    setChatMessages([]);
    setIsNewProjectMode(true);
  };

  const handleNavClick = (navId: NavId) => {
    setActiveNav(navId);
    // Preserve the open project when the user navigates away to Settings /
    // Dashboard / Assets — PromptColumn + Workspace stay mounted underneath
    // and the chat/stream is unaffected. Only reset project state if the
    // user is clicking "projects" while no project is open (i.e. they want
    // the projects list).
    if (navId === "projects" && !currentProjectId) {
      setIsNewProjectMode(false);
    }
  };

  const renderMainContent = () => {
    // Case 1: no project open and not starting a new one → show whatever nav
    // the user has selected. Settings/Dashboard/Assets get the full canvas.
    if (!currentProjectId && !isNewProjectMode) {
      if (activeNav === "settings") return <Settings />;
      if (activeNav === "dashboard") return <Dashboard />;
      if (activeNav === "assets") return <Assets />;
      return <ProjectsList onSelectProject={openProject} onNewProject={handleNewProject} />;
    }

    // Case 2: a project is open (or being created). Keep PromptColumn +
    // Workspace mounted so the stream never detonates. Overlay Settings /
    // Dashboard / Assets on top if the user navigated there; projects-nav
    // drops back to the project view.
    const overlay =
      activeNav === "settings" ? <Settings /> :
      activeNav === "dashboard" ? <Dashboard /> :
      activeNav === "assets" ? <Assets /> : null;

    return (
      <>
        <div className={`mobile-panel mobile-panel-chat ${mobileView === "chat" ? "mobile-active" : ""} ${chatCollapsed ? "chat-collapsed" : ""}`}>
          <button
            className="chat-collapse-tab"
            onClick={() => setChatCollapsed(c => !c)}
            title={chatCollapsed ? "Expand chat" : "Collapse chat"}
          >{chatCollapsed ? "›" : "‹"}</button>
          <PromptColumn
            projectData={projectData}
            isNewProject={!currentProjectId}
            chatMessages={chatMessages}
            onSendChat={sendChat}
            onApproval={handleApproval}
            chatLoading={chatLoading}
            injectContext={injectContext}
            onClearInjectContext={() => setInjectContext(null)}
          />
        </div>
        <div className={`mobile-panel mobile-panel-workspace ${mobileView === "workspace" ? "mobile-active" : ""}`}>
          <Workspace
            projectData={projectData}
            stagedBrandIds={stagedBrandIds}
            onStagedBrandIdsChange={setStagedBrandIds}
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
        {overlay && <div className="nav-overlay">{overlay}</div>}
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
          <button className="toggle" onClick={() => setCollapsed(!collapsed)}>☰</button>
          <div className="status">
            {(currentProjectId || isNewProjectMode) ? (
              <button
                className="topbar-project-back"
                onClick={() => {
                  setCurrentProjectId(null);
                  setProjectData(null);
                  setChatMessages([]);
                  setIsNewProjectMode(false);
                  setActiveNav("projects");
                }}
                title="Back to all projects"
              >
                <span className="topbar-project-back-arrow">←</span>
                <span className="topbar-project-name">{projectData?.name || "New Project"}</span>
              </button>
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
