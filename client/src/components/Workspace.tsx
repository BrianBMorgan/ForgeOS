import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { RunData, ProjectData } from "../App";
import DbTab from "./DbTab";

interface PublishStatus {
  published: boolean;
  projectId?: string;
  slug?: string;
  port?: number;
  status?: string;
  publishedAt?: number;
  renderUrl?: string;
  logs?: string;
  github?: { commitSha?: string; commitUrl?: string; filesCount?: number };
}

function PublishTab({ projectId }: { projectId: string | null }) {
  const [pubStatus, setPubStatus] = useState<PublishStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchStatus = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/publish`);
      const data = await res.json();
      setPubStatus(data);
    } catch {
      setPubStatus({ published: false });
    }
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const [githubResult, setGithubResult] = useState<PublishStatus["github"]>(undefined);

  const handlePublish = async () => {
    if (!projectId) return;
    setPublishing(true);
    setError(null);
    setGithubResult(undefined);
    try {
      const res = await fetch(`/api/projects/${projectId}/publish`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Publish failed");
      if (data.github) setGithubResult(data.github);
      if (data.githubError) setError((prev) => (prev ? prev + " | GitHub: " + data.githubError : "GitHub push failed: " + data.githubError));
      await fetchStatus();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Publish failed");
    }
    setPublishing(false);
  };

  const handleUnpublish = async () => {
    if (!projectId) return;
    try {
      await fetch(`/api/projects/${projectId}/publish`, { method: "DELETE" });
      setConfirmUnpublish(false);
      await fetchStatus();
    } catch {
      setError("Failed to unpublish");
    }
  };

  const handleExport = () => {
    if (!projectId) return;
    window.open(`/api/projects/${projectId}/export`, "_blank");
  };

  const handleCopy = (url: string) => {
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!projectId) {
    return (
      <div className="panel-placeholder">
        <div className="panel-title">Publish</div>
        <div className="panel-desc">Create a project and run a build first.</div>
      </div>
    );
  }

  if (loading && !pubStatus) {
    return (
      <div className="panel-placeholder">
        <div className="panel-desc">Loading publish status...</div>
      </div>
    );
  }
  const isPublished = pubStatus?.published && (pubStatus.status === "running" || pubStatus.status === "deploying");
  const baseUrl = window.location.origin;
  const appUrl = pubStatus?.renderUrl || (pubStatus?.slug ? `${baseUrl}/apps/${pubStatus.slug}` : "");
  const baseUrl = window.location.origin;
  const appUrl = pubStatus?.renderUrl || (pubStatus?.slug ? `${baseUrl}/apps/${pubStatus.slug}` : "");

  return (
    <div className="pub-container">
      <div className="pub-header">
        <h2 className="pub-title">Publish</h2>
        <p className="pub-subtitle">
          {isPublished
            ? "Your app is live and publicly accessible."
            : "Publish your app to make it publicly accessible."}
        </p>
      </div>

      {error && <div className="pub-error">{error}</div>}

      {isPublished ? (
        <div className="pub-live-section">
          <div className="pub-status-row">
            <span className="pub-status-dot pub-status-running" />
            <span className="pub-status-text">Live</span>
            {pubStatus?.publishedAt && (
              <span className="pub-status-time">
                Published {new Date(pubStatus.publishedAt).toLocaleString()}
              </span>
            )}
          </div>

          <div className="pub-url-section">
            <label className="pub-url-label">Public URL</label>
            <div className="pub-url-row">
              <a href={appUrl} target="_blank" rel="noopener noreferrer" className="pub-url-link">
                {appUrl}
              </a>
              <button className="pub-copy-btn" onClick={() => handleCopy(appUrl)}>
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>

          {githubResult?.commitUrl && (
            <div className="pub-github-section">
              <label className="pub-url-label">GitHub</label>
              <div className="pub-url-row">
                <a href={githubResult.commitUrl} target="_blank" rel="noopener noreferrer" className="pub-url-link">
                  {githubResult.commitSha?.slice(0, 7)} — {githubResult.filesCount} files pushed
                </a>
              </div>
            </div>
          )}

          <div className="pub-actions">
            <button className="pub-republish-btn" onClick={handlePublish} disabled={publishing}>
              {publishing ? "Republishing..." : "Republish"}
            </button>
            <button className="pub-export-btn" onClick={handleExport}>
              Export ZIP
            </button>
            {!confirmUnpublish ? (
              <button className="pub-unpublish-btn" onClick={() => setConfirmUnpublish(true)}>
                Unpublish
              </button>
            ) : (
              <button className="pub-unpublish-confirm" onClick={handleUnpublish}>
                Confirm Unpublish
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="pub-unpublished-section">
          {pubStatus?.published && pubStatus.status === "failed" && (
            <div className="pub-failed-notice">
              Previous publish failed. Check logs and try again.
              {pubStatus.logs && (
                <pre className="pub-failed-logs">{pubStatus.logs.slice(-2000)}</pre>
              )}
            </div>
          )}
          <div className="pub-actions">
            <button className="pub-publish-btn" onClick={handlePublish} disabled={publishing}>
              {publishing ? "Publishing..." : "Publish App"}
            </button>
            <button className="pub-export-btn" onClick={handleExport}>
              Export ZIP
            </button>
          </div>
          <p className="pub-info">
            Publishing copies your latest build and serves it at a public URL.
            You can iterate on the project without affecting the published version.
          </p>
        </div>
      )}
    </div>
  );
}

interface Tab {
  id: string;
  label: string;
  description: string;
}

const defaultTabs: Tab[] = [
  { id: "plan", label: "Build", description: "Build output — summary, files, and commands." },
  { id: "render", label: "Render", description: "Live preview and implementation output." },
  { id: "shell", label: "Shell", description: "Terminal output and log stream." },
  { id: "db", label: "DB", description: "Database viewer — tables, queries, and schema." },
  { id: "env", label: "Env", description: "Project environment variables." },
  { id: "publish", label: "Publish", description: "Deployment controls, domains, and promotion workflow." },
  { id: "brain", label: "Brain", description: "Persistent team memory — patterns, preferences, and project history." },
];

interface WorkspaceProps {
  runData: RunData | null;
  projectData?: ProjectData | null;
  viewingIterationRunId?: string | null;
  onRefreshRunData?: () => void;
}

function renderField(label: string, value: unknown) {
  if (value === null || value === undefined) return null;

  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return (
      <div className="plan-field">
        <div className="plan-field-label">{label}</div>
        <div className="plan-field-list">
          {value.map((item, i) => (
            <div key={i} className="plan-field-item">
              {typeof item === "object" ? (
                <pre>{JSON.stringify(item, null, 2)}</pre>
              ) : (
                String(item)
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (typeof value === "object") {
    return (
      <div className="plan-field">
        <div className="plan-field-label">{label}</div>
        <pre className="plan-field-json">{JSON.stringify(value, null, 2)}</pre>
      </div>
    );
  }

  return (
    <div className="plan-field">
      <div className="plan-field-label">{label}</div>
      <div className="plan-field-value">{String(value)}</div>
    </div>
  );
}

function PlanTab({ runData }: { runData: RunData | null }) {
  const builderOutput = runData?.stages?.builder?.output;
  const legacyPlanOutput =
    runData?.stages?.revise_p3?.output ||
    runData?.stages?.revise_p2?.output ||
    runData?.stages?.planner?.output;

  const planOutput = builderOutput || legacyPlanOutput;

  if (!planOutput || typeof planOutput !== "object") {
    return (
      <div className="panel-placeholder">
        <div className="panel-title">Build</div>
        <div className="panel-desc">
          {runData?.status === "running"
            ? "Claude is building your app..."
            : "Run a build to get started."}
        </div>
      </div>
    );
  }

  const plan = planOutput as Record<string, unknown>;

  if (builderOutput) {
    const files = (plan.files as { path: string }[]) || [];
    const envVars = (plan.envVars as { name: string; description: string }[]) || [];
    return (
      <div className="plan-content">
        {runData?.prompt && (
          <div className="plan-user-prompt">
            <div className="plan-user-prompt-label">Prompt</div>
            <div className="plan-user-prompt-text">{runData.prompt}</div>
          </div>
        )}
        {plan.summary ? (
          <div className="plan-section">
            <div className="plan-section-title">Summary</div>
            <div className="plan-summary-text">{String(plan.summary)}</div>
          </div>
        ) : null}
        {files.length > 0 ? (
          <div className="plan-section">
            <div className="plan-section-title">Files ({files.length})</div>
            <div className="plan-files-list">
              {files.map((f, i) => (
                <div key={i} className="plan-file-item">{f.path}</div>
              ))}
            </div>
          </div>
        ) : null}
        {plan.startCommand ? (
          <div className="plan-section">
            <div className="plan-section-title">Start Command</div>
            <code className="plan-command">{String(plan.startCommand)}</code>
          </div>
        ) : null}
        {envVars.length > 0 && (
          <div className="plan-section">
            <div className="plan-section-title">Required Secrets</div>
            {envVars.map((v, i) => (
              <div key={i} className="plan-env-item">
                <code>{v.name}</code> — {v.description}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="plan-content">
      {runData?.prompt && (
        <div className="plan-user-prompt">
          <div className="plan-user-prompt-label">User Prompt</div>
          <div className="plan-user-prompt-text">{runData.prompt}</div>
        </div>
      )}
      <div className="plan-header">
        <span className="plan-project-name">{String(plan.projectName || "")}</span>
        <span className="plan-template">{String(plan.template || "")}</span>
      </div>
      {renderField("Modules", plan.modules)}
      {renderField("Database", plan.database)}
      {renderField("Environment Variables", plan.environmentVariables)}
      {renderField("API Endpoints", plan.apiEndpoints)}
      {renderField("UI Pages", plan.uiPages)}
      {renderField("Background Workers", plan.backgroundWorkers)}
      {renderField("Data Flows", plan.dataFlows)}
      {renderField("Risks", plan.risks)}
      {renderField("Acceptance Criteria", plan.acceptanceCriteria)}
    </div>
  );
}

interface FileEntry {
  path: string;
  purpose: string;
  content?: string;
}

interface BuildTask {
  order: number;
  task: string;
  details: string;
}

function parseFileTree(files: FileEntry[]) {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  return sorted.map((file) => {
    const parts = file.path.split("/");
    const depth = parts.length - 1;
    const name = parts[parts.length - 1];
    const isDir = file.path.endsWith("/");
    return { ...file, depth, name, isDir };
  });
}

function WorkspaceStatusBadge({ status }: { status: string }) {
  const labels: Record<string, string> = {
    "writing-files": "Writing files...",
    "files-written": "Files written",
    "installing": "Installing dependencies...",
    "installed": "Dependencies installed",
    "install-failed": "Install failed",
    "starting": "Starting app...",
    "running": "App running",
    "start-failed": "Failed to start",
    "stopped": "Stopped",
    "build-failed": "Build failed",
  };

  const colors: Record<string, string> = {
    "writing-files": "#3b82f6",
    "files-written": "#3b82f6",
    "installing": "#f59e0b",
    "installed": "#f59e0b",
    "install-failed": "#f87171",
    "starting": "#f59e0b",
    "running": "#4ade80",
    "start-failed": "#f87171",
    "stopped": "#64748b",
    "build-failed": "#f87171",
  };

  return (
    <span
      className="workspace-status-badge"
      style={{ color: colors[status] || "#64748b" }}
    >
      <span
        className="workspace-status-dot"
        style={{ background: colors[status] || "#64748b" }}
      />
      {labels[status] || status}
    </span>
  );
}

function RenderTab({ runData, liveRunData }: { runData: RunData | null; liveRunData?: RunData | null }) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const builderOutput = runData?.stages?.builder?.output;
  const executorOutput = runData?.stages?.executor?.output;
  const stageOutput = builderOutput || executorOutput;
  const ws = runData?.workspace;

  const previewRunData = liveRunData || runData;
  const previewWs = previewRunData?.workspace;

  const previewStamp = useMemo(() => Date.now(), [previewRunData?.id]);

  if (!stageOutput || typeof stageOutput !== "object") {
    const isRunning = runData?.status === "running";
    const isAwaiting = runData?.status === "awaiting-approval";
    const hasPlan = runData?.stages?.planner?.status === "passed";

    let message = "Run a build to see results.";
    if (isRunning) {
      message = "Building...";
    } else if (isAwaiting) {
      message = "Approve the plan to generate the implementation spec.";
    } else if (hasPlan && runData?.status !== "completed") {
      message = "Waiting for executor to complete...";
    }

    return (
      <div className="panel-placeholder">
        <div className="panel-title">Render</div>
        <div className="panel-desc">{message}</div>
      </div>
    );
  }

  const exec = stageOutput as Record<string, unknown>;
  const summary = (exec.implementationSummary || exec.summary) as string | undefined;
  const files = (exec.files || exec.fileStructure || []) as FileEntry[];
  const envVars = (exec.environmentVariables || []) as string[];
  const dbSchema = exec.databaseSchema as string | null;
  const buildTasks = (exec.buildTasks || []) as BuildTask[];
  const treeEntries = parseFileTree(files);
  const selectedFileData = files.find((f) => f.path === selectedFile);

  return (
    <div className="render-content">
      {ws && (
        <div className="render-section">
          <div className="render-section-label">
            Build Status
            <WorkspaceStatusBadge status={ws.status} />
          </div>
          {ws.error && (
            <div className="workspace-error">{ws.error}</div>
          )}
        </div>
      )}

      {previewWs?.status === "running" && previewWs.port && previewRunData?.id && (
        <div className="render-section preview-section">
          <div className="render-section-label">
            Live Preview
            <button
              className="preview-open-btn"
              onClick={() => window.open(`/preview/${previewRunData.id}/`, "_blank")}
              title="Open in new tab"
            >↗</button>
          </div>
          <div className="preview-container">
            <iframe
              key={previewRunData.id}
              src={`/preview/${previewRunData.id}/?_t=${previewStamp}`}
              className="preview-iframe"
              title="App Preview"
            />
          </div>
        </div>
      )}

      {summary && (
        <div className="render-section">
          <div className="render-section-label">Implementation Summary</div>
          <div className="render-summary">{summary}</div>
        </div>
      )}

      {treeEntries.length > 0 && (
        <div className="render-section">
          <div className="render-section-label">
            Files ({files.length})
          </div>
          <div className="file-tree">
            {treeEntries.map((entry, i) => (
              <div
                key={i}
                className={`file-tree-entry ${selectedFile === entry.path ? "selected" : ""} ${entry.content ? "clickable" : ""}`}
                style={{ paddingLeft: `${entry.depth * 1.25 + 0.5}rem` }}
                onClick={() => {
                  if (entry.content) {
                    setSelectedFile(
                      selectedFile === entry.path ? null : entry.path
                    );
                  }
                }}
              >
                <span className="file-tree-icon">
                  {entry.isDir ? "📁" : "📄"}
                </span>
                <span className="file-tree-name">{entry.name}</span>
                <span className="file-tree-purpose">{entry.purpose}</span>
              </div>
            ))}
          </div>
          {selectedFileData?.content && (
            <div className="file-content-viewer">
              <div className="file-content-header">{selectedFileData.path}</div>
              <pre className="file-content-code">{selectedFileData.content}</pre>
            </div>
          )}
        </div>
      )}

      {envVars.length > 0 && (
        <div className="render-section">
          <div className="render-section-label">Environment Variables</div>
          <div className="env-var-list">
            {envVars.map((v, i) => (
              <span key={i} className="env-var-badge">{v}</span>
            ))}
          </div>
        </div>
      )}

      {dbSchema && (
        <div className="render-section">
          <div className="render-section-label">Database Schema</div>
          <pre className="db-schema-block">{dbSchema}</pre>
        </div>
      )}

      {buildTasks.length > 0 && (
        <div className="render-section">
          <div className="render-section-label">Build Tasks</div>
          <div className="build-task-list">
            {buildTasks
              .sort((a, b) => a.order - b.order)
              .map((task) => (
                <div key={task.order} className="build-task">
                  <div className="build-task-header">
                    <span className="build-task-number">{task.order}</span>
                    <span className="build-task-indicator" />
                    <span className="build-task-name">{task.task}</span>
                  </div>
                  <div className="build-task-details">{task.details}</div>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface ShellEntry {
  id: number;
  type: "command" | "stdout" | "stderr" | "info" | "system";
  text: string;
}

interface LogEntry {
  ts: number;
  level: "info" | "warn" | "error" | "debug";
  source: "system" | "install" | "app";
  message: string;
}

type LogLevel = "info" | "warn" | "error" | "debug";

const LOG_LEVEL_COLORS: Record<LogLevel, string> = {
  info: "#3b82f6",
  warn: "#f59e0b",
  error: "#ef4444",
  debug: "#64748b",
};

const LOG_SOURCE_LABELS: Record<string, string> = {
  system: "SYS",
  install: "NPM",
  app: "APP",
};

function formatLogTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
    + "." + String(d.getMilliseconds()).padStart(3, "0");
}

function ShellTab({ runData, projectId, onRefreshRunData }: { runData: RunData | null; projectId?: string | null; onRefreshRunData?: () => void }) {
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [totalEntries, setTotalEntries] = useState(0);
  const [shellHistory, setShellHistory] = useState<ShellEntry[]>([]);
  const [cmdInput, setCmdInput] = useState("");
  const [cmdHistoryList, setCmdHistoryList] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [isExecuting, setIsExecuting] = useState(false);
  const [shellMode, setShellMode] = useState<"terminal" | "logs">("terminal");
  const [levelFilter, setLevelFilter] = useState<Set<LogLevel>>(new Set(["info", "warn", "error", "debug"]));
  const [logSearch, setLogSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const shellEndRef = useRef<HTMLDivElement>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const entryIdRef = useRef(0);

  useEffect(() => {
    if (!runData?.id || !runData?.workspace) return;
    const fetchLogs = async () => {
      try {
        const res = await fetch(`/api/runs/${runData.id}/logs`);
        if (res.ok) {
          const data = await res.json();
          if (data.logs?.entries) {
            setLogEntries(data.logs.entries);
            setTotalEntries(data.logs.totalEntries || data.logs.entries.length);
          }
        }
      } catch {}
    };
    fetchLogs();
    const interval = setInterval(fetchLogs, 2000);
    return () => clearInterval(interval);
  }, [runData?.id, runData?.workspace?.status]);

  useEffect(() => {
    if (autoScroll) logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logEntries, autoScroll]);

  useEffect(() => {
    shellEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [shellHistory]);

  useEffect(() => {
    if (runData?.id) {
      setShellHistory([]);
      setCmdHistoryList([]);
      setHistoryIndex(-1);
      setLogEntries([]);
      entryIdRef.current = 0;
    }
  }, [runData?.id]);

  const addEntry = useCallback((type: ShellEntry["type"], text: string) => {
    const id = ++entryIdRef.current;
    setShellHistory((prev) => [...prev, { id, type, text }]);
  }, []);

  const executeCommand = useCallback(async () => {
    const cmd = cmdInput.trim();
    if (!cmd || !runData?.id || isExecuting) return;

    setCmdInput("");
    setHistoryIndex(-1);
    setCmdHistoryList((prev) => {
      const filtered = prev.filter((c) => c !== cmd);
      return [cmd, ...filtered].slice(0, 50);
    });

    addEntry("command", cmd);
    setIsExecuting(true);

    try {
      const res = await fetch(`/api/runs/${runData.id}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmd }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "Server error");
        addEntry("stderr", text);
        return;
      }
      const data = await res.json();

      if (data.error) {
        addEntry("stderr", data.error);
      } else {
        if (data.stdout && data.stdout.trim()) addEntry("stdout", data.stdout);
        if (data.stderr && data.stderr.trim()) addEntry("stderr", data.stderr);
        if (!data.stdout?.trim() && !data.stderr?.trim() && data.exitCode === 0) addEntry("info", "(no output)");
        if (data.exitCode !== 0 && data.exitCode !== undefined) addEntry("info", `exit code ${data.exitCode}`);
      }
    } catch (err: unknown) {
      addEntry("stderr", `Network error: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setIsExecuting(false);
      inputRef.current?.focus();
    }
  }, [cmdInput, runData?.id, isExecuting, addEntry]);

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      setCmdInput((prev) => prev + text);
      inputRef.current?.focus();
    } catch {
      addEntry("stderr", "Clipboard access denied — try Ctrl+V directly in the input field");
    }
  }, [addEntry]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      executeCommand();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (cmdHistoryList.length > 0) {
        const next = Math.min(historyIndex + 1, cmdHistoryList.length - 1);
        setHistoryIndex(next);
        setCmdInput(cmdHistoryList[next]);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIndex > 0) {
        const next = historyIndex - 1;
        setHistoryIndex(next);
        setCmdInput(cmdHistoryList[next]);
      } else {
        setHistoryIndex(-1);
        setCmdInput("");
      }
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      setShellHistory([]);
    }
  }, [executeCommand, cmdHistoryList, historyIndex]);

  const toggleLevel = useCallback((level: LogLevel) => {
    setLevelFilter((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  }, []);

  if (!runData?.workspace) {
    return (
      <div className="panel-placeholder">
        <div className="panel-title">Shell</div>
        <div className="panel-desc">
          {runData?.status === "running"
            ? "Pipeline is running..."
            : "Run a build to see build output."}
        </div>
      </div>
    );
  }

  const workspaceDir = runData.id ? `workspaces/${runData.id}` : "";

  const filteredLogs = logEntries.filter((entry) => {
    if (!levelFilter.has(entry.level)) return false;
    if (logSearch && !entry.message.toLowerCase().includes(logSearch.toLowerCase())) return false;
    return true;
  });

  const levelCounts = logEntries.reduce((acc, e) => {
    acc[e.level] = (acc[e.level] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div className="shell-content">
      <div className="shell-header">
        <WorkspaceStatusBadge status={runData.workspace.status} />
        {runData.workspace.port && (
          <span className="shell-port">Port {runData.workspace.port}</span>
        )}
        {projectId && (
          <div className="shell-controls">
            {runData.workspace.status === "running" && (
              <>
                <button
                  className="shell-ctrl-btn shell-ctrl-restart"
                  onClick={async () => {
                    setActionLoading("restart");
                    try {
                      await fetch(`/api/projects/${projectId}/restart`, { method: "POST" });
                      await new Promise(r => setTimeout(r, 1000));
                      onRefreshRunData?.();
                    } catch {}
                    setActionLoading(null);
                  }}
                  disabled={actionLoading !== null}
                  title="Restart app"
                >
                  {actionLoading === "restart" ? "↻" : "⟳"} Restart
                </button>
                <button
                  className="shell-ctrl-btn shell-ctrl-stop"
                  onClick={async () => {
                    setActionLoading("stop");
                    try {
                      await fetch(`/api/projects/${projectId}/stop`, { method: "POST" });
                      await new Promise(r => setTimeout(r, 500));
                      onRefreshRunData?.();
                    } catch {}
                    setActionLoading(null);
                  }}
                  disabled={actionLoading !== null}
                  title="Stop app"
                >
                  ■ Stop
                </button>
              </>
            )}
            {(runData.workspace.status === "stopped" || runData.workspace.status === "start-failed") && (
              <button
                className="shell-ctrl-btn shell-ctrl-restart"
                onClick={async () => {
                  setActionLoading("restart");
                  try {
                    await fetch(`/api/projects/${projectId}/restart`, { method: "POST" });
                    await new Promise(r => setTimeout(r, 1000));
                    onRefreshRunData?.();
                  } catch {}
                  setActionLoading(null);
                }}
                disabled={actionLoading !== null}
                title="Start app"
              >
                {actionLoading === "restart" ? "↻" : "▶"} Start
              </button>
            )}
          </div>
        )}
        <div className="shell-mode-toggle">
          <button
            className={`shell-mode-btn ${shellMode === "terminal" ? "active" : ""}`}
            onClick={() => setShellMode("terminal")}
          >Terminal</button>
          <button
            className={`shell-mode-btn ${shellMode === "logs" ? "active" : ""}`}
            onClick={() => setShellMode("logs")}
          >Logs{totalEntries > 0 ? ` (${totalEntries})` : ""}</button>
        </div>
      </div>

      {shellMode === "terminal" ? (
        <div className="shell-terminal" onClick={() => inputRef.current?.focus()}>
          <div className="shell-terminal-output">
            {shellHistory.length === 0 && (
              <div className="shell-welcome">
                <span className="shell-welcome-path">{workspaceDir}</span>
                <span className="shell-welcome-hint">
                  Type commands to run in the workspace. Use Up/Down for history, Ctrl+L to clear.
                </span>
              </div>
            )}
            {shellHistory.map((entry) => (
              <div key={entry.id} className={`shell-entry shell-entry-${entry.type}`}>
                {entry.type === "command" ? (
                  <span><span className="shell-prompt">$</span> {entry.text}</span>
                ) : (
                  <pre>{entry.text}</pre>
                )}
              </div>
            ))}
            {isExecuting && (
              <div className="shell-entry shell-entry-info shell-executing">Running...</div>
            )}
            <div ref={shellEndRef} />
          </div>
          <div className="shell-input-row">
            <span className="shell-prompt">$</span>
            <input
              ref={inputRef}
              className="shell-input"
              type="text"
              value={cmdInput}
              onChange={(e) => { setCmdInput(e.target.value); setHistoryIndex(-1); }}
              onKeyDown={handleKeyDown}
              placeholder="Type a command..."
              disabled={isExecuting}
              autoFocus
              spellCheck={false}
              autoComplete="off"
            />
            <button className="shell-paste-btn" onClick={handlePaste} title="Paste from clipboard">
              Paste
            </button>
          </div>
        </div>
      ) : (
        <div className="log-viewer">
          <div className="log-toolbar">
            <div className="log-filters">
              {(["error", "warn", "info", "debug"] as LogLevel[]).map((level) => (
                <button
                  key={level}
                  className={`log-filter-btn log-filter-${level} ${levelFilter.has(level) ? "active" : ""}`}
                  onClick={() => toggleLevel(level)}
                >
                  <span className="log-filter-dot" style={{ background: LOG_LEVEL_COLORS[level] }} />
                  {level.toUpperCase()}
                  {levelCounts[level] ? <span className="log-filter-count">{levelCounts[level]}</span> : null}
                </button>
              ))}
            </div>
            <div className="log-toolbar-right">
              <input
                className="log-search"
                type="text"
                placeholder="Search logs..."
                value={logSearch}
                onChange={(e) => setLogSearch(e.target.value)}
                spellCheck={false}
              />
              <button
                className={`log-autoscroll-btn ${autoScroll ? "active" : ""}`}
                onClick={() => setAutoScroll(!autoScroll)}
                title={autoScroll ? "Auto-scroll on" : "Auto-scroll off"}
              >
                {autoScroll ? "⬇" : "⏸"}
              </button>
            </div>
          </div>
          <div className="log-entries">
            {filteredLogs.length === 0 && (
              <div className="log-empty">
                {logEntries.length === 0
                  ? runData.workspace.status === "installing"
                    ? "Installing dependencies..."
                    : runData.workspace.status === "writing-files"
                    ? "Writing files to workspace..."
                    : "No log entries yet."
                  : "No entries match current filters."}
              </div>
            )}
            {filteredLogs.map((entry, i) => (
              <div key={`${entry.ts}-${i}`} className={`log-row log-row-${entry.level}`}>
                <span className="log-ts">{formatLogTime(entry.ts)}</span>
                <span className="log-level-badge" style={{ color: LOG_LEVEL_COLORS[entry.level] }}>
                  {entry.level.toUpperCase().padEnd(5)}
                </span>
                <span className="log-source">{LOG_SOURCE_LABELS[entry.source] || entry.source}</span>
                <span className="log-msg">{entry.message}</span>
              </div>
            ))}
            {runData.workspace.error && (
              <div className="log-row log-row-error">
                <span className="log-ts">{formatLogTime(Date.now())}</span>
                <span className="log-level-badge" style={{ color: LOG_LEVEL_COLORS.error }}>ERROR</span>
                <span className="log-source">SYS</span>
                <span className="log-msg">{runData.workspace.error}</span>
              </div>
            )}
            <div ref={logEndRef} />
          </div>
        </div>
      )}
    </div>
  );
}

function EnvTab({ projectId }: { projectId: string | null }) {
  const [envVars, setEnvVars] = useState<{ key: string; value: string; createdAt: number }[]>([]);
  const [globalDefaults, setGlobalDefaults] = useState<{ key: string; value: string }[]>([]);
  const [globalSecretKeys, setGlobalSecretKeys] = useState<string[]>([]);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set());

  const fetchEnvVars = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const [envRes, settingsRes, secretsRes] = await Promise.all([
        fetch(`/api/projects/${projectId}/env`),
        fetch("/api/settings"),
        fetch("/api/secrets"),
      ]);
      const envData = await envRes.json();
      const settingsData = await settingsRes.json();
      const secretsData = await secretsRes.json();
      setEnvVars(envData.envVars || []);
      setGlobalDefaults(settingsData?.default_env_vars?.vars || []);
      setGlobalSecretKeys(secretsData?.secrets || []);
      setError(null);
    } catch {
      setError("Failed to load environment variables");
    }
    setLoading(false);
  }, [projectId]);

  useEffect(() => { fetchEnvVars(); }, [fetchEnvVars]);

  const handleAdd = async () => {
    if (!projectId || !newKey.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/env`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: newKey.trim(), value: newValue }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to save");
      } else {
        setNewKey("");
        setNewValue("");
        await fetchEnvVars();
      }
    } catch {
      setError("Failed to save environment variable");
    }
    setSaving(false);
  };

  const handleDelete = async (key: string) => {
    if (!projectId) return;
    try {
      await fetch(`/api/projects/${projectId}/env/${encodeURIComponent(key)}`, {
        method: "DELETE",
      });
      await fetchEnvVars();
    } catch {
      setError("Failed to delete environment variable");
    }
  };

  const toggleVisibility = (key: string) => {
    setVisibleKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (!projectId) {
    return (
      <div className="panel-placeholder">
        <div className="panel-title">Environment Variables</div>
        <div className="panel-desc">No project selected.</div>
      </div>
    );
  }

  return (
    <div className="env-tab">
      <div className="env-header">
        <div className="env-title">Environment Variables</div>
        <div className="env-subtitle">
          Set environment variables that will be injected into your project's runtime. Changes apply on the next build or restart.
        </div>
      </div>

      {error && <div className="env-error">{error}</div>}

      <div className="env-add-form">
        <input
          className="env-input env-key-input"
          placeholder="KEY_NAME"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
        />
        <input
          className="env-input env-value-input"
          placeholder="value"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
        />
        <button className="env-add-btn" onClick={handleAdd} disabled={saving || !newKey.trim()}>
          {saving ? "Saving..." : "Add"}
        </button>
      </div>

      {loading ? (
        <div className="env-loading">Loading...</div>
      ) : envVars.length === 0 ? (
        <div className="env-empty">No environment variables set. Add one above.</div>
      ) : (
        <div className="env-list">
          {envVars.map((v) => (
            <div className="env-row" key={v.key}>
              <span className="env-row-key">{v.key}</span>
              <span className="env-row-value">
                {visibleKeys.has(v.key) ? v.value : "••••••••"}
              </span>
              <button className="env-row-toggle" onClick={() => toggleVisibility(v.key)} title={visibleKeys.has(v.key) ? "Hide" : "Show"}>
                {visibleKeys.has(v.key) ? "◉" : "○"}
              </button>
              <button className="env-row-delete" onClick={() => handleDelete(v.key)} title="Delete">✕</button>
            </div>
          ))}
        </div>
      )}

      {(globalDefaults.length > 0 || globalSecretKeys.length > 0) && (
        <div className="env-defaults-section">
          <div className="env-defaults-title">Inherited from Global Settings</div>
          <div className="env-defaults-desc">These are injected at runtime. Project vars override globals with the same key.</div>
          <div className="env-defaults-list">
            {globalDefaults.map((v) => (
              <div className="env-default-item" key={`def-${v.key}`}>
                <span className="env-row-key">{v.key}</span>
                <span className="env-global-badge">Default</span>
                <span className="env-default-desc">{envVars.some((e) => e.key === v.key) ? "(overridden by project)" : ""}</span>
              </div>
            ))}
            {globalSecretKeys.map((key) => (
              <div className="env-default-item" key={`sec-${key}`}>
                <span className="env-row-key">{key}</span>
                <span className="env-global-badge secret">Secret</span>
                <span className="env-default-desc">{envVars.some((e) => e.key === key) ? "(overridden by project)" : ""}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="env-defaults-section">
        <div className="env-defaults-title">Auto-injected Variables</div>
        <div className="env-defaults-desc">These are always available to your project:</div>
        <div className="env-defaults-list">
          <div className="env-default-item"><span className="env-row-key">DATABASE_URL</span><span className="env-default-desc">Neon Postgres connection string</span></div>
          <div className="env-default-item"><span className="env-row-key">NEON_AUTH_JWKS_URL</span><span className="env-default-desc">Auth JWKS endpoint</span></div>
          <div className="env-default-item"><span className="env-row-key">JWT_SECRET</span><span className="env-default-desc">Generated JWT signing key</span></div>
          <div className="env-default-item"><span className="env-row-key">PORT</span><span className="env-default-desc">Assigned application port</span></div>
        </div>
      </div>
    </div>
  );
}

interface BrainData {
  totals: { projects: number; preferences: number; patterns: number; mistakes: number; snippets: number; embedded?: number };
  topMistakes: { content: string; usefulness_score: number }[];
  recentProjects: { name: string; description: string; stack: string[] | null; published_url: string | null }[];
}

function BrainTab() {
  const [data, setData] = useState<BrainData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/brain");
        if (!res.ok) throw new Error("Failed to load brain data");
        const json = await res.json();
        if (!cancelled) setData(json);
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="panel-placeholder">
        <div className="panel-title">Brain</div>
        <div className="panel-desc">Loading memory...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="panel-placeholder">
        <div className="panel-title">Brain</div>
        <div className="panel-desc">{error}</div>
      </div>
    );
  }

  if (!data) return null;

  const { totals, topMistakes, recentProjects } = data;

  return (
    <div className="brain-container">
      <div className="brain-header">
        <h2 className="brain-title">ForgeOS Brain</h2>
        <p className="brain-subtitle">Persistent team memory — learns from every build</p>
      </div>

      <div className="brain-stats-grid">
        <div className="brain-stat">
          <span className="brain-stat-value">{totals.projects}</span>
          <span className="brain-stat-label">Projects Built</span>
        </div>
        <div className="brain-stat">
          <span className="brain-stat-value">{totals.patterns}</span>
          <span className="brain-stat-label">Patterns Learned</span>
        </div>
        <div className="brain-stat">
          <span className="brain-stat-value">{totals.mistakes}</span>
          <span className="brain-stat-label">Mistakes Tracked</span>
        </div>
        <div className="brain-stat">
          <span className="brain-stat-value">{totals.preferences}</span>
          <span className="brain-stat-label">Team Preferences</span>
        </div>
        <div className="brain-stat">
          <span className="brain-stat-value">{totals.snippets}</span>
          <span className="brain-stat-label">Code Snippets</span>
        </div>
        <div className="brain-stat">
          <span className="brain-stat-value">{totals.embedded || 0}</span>
          <span className="brain-stat-label">Embeddings</span>
        </div>
      </div>

      {recentProjects.length > 0 && (
        <div className="brain-section">
          <h3 className="brain-section-title">Project Index</h3>
          <div className="brain-projects">
            {recentProjects.map((p, i) => (
              <div key={i} className="brain-project-card">
                <div className="brain-project-name">{p.name}</div>
                {p.description && <div className="brain-project-desc">{p.description}</div>}
                <div className="brain-project-meta">
                  {p.stack && p.stack.length > 0 && (
                    <div className="brain-project-stack">
                      {(Array.isArray(p.stack) ? p.stack : []).map((s, j) => (
                        <span key={j} className="brain-stack-tag">{s}</span>
                      ))}
                    </div>
                  )}
                  {p.published_url && (
                    <a href={p.published_url} target="_blank" rel="noopener noreferrer" className="brain-project-link">
                      Live
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {topMistakes.length > 0 && (
        <div className="brain-section">
          <h3 className="brain-section-title">Top Mistakes Learned</h3>
          <div className="brain-mistakes">
            {topMistakes.map((m, i) => (
              <div key={i} className="brain-mistake-item">
                <span className="brain-mistake-score">{m.usefulness_score}</span>
                <span className="brain-mistake-text">{m.content}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {totals.projects === 0 && totals.patterns === 0 && totals.mistakes === 0 && (
        <div className="brain-empty">
          <div className="brain-empty-title">Brain is empty</div>
          <div className="brain-empty-desc">
            Run your first build to start teaching ForgeOS. Every successful build extracts patterns, preferences, and reusable knowledge. Every failure teaches it what to avoid.
          </div>
        </div>
      )}
    </div>
  );
}

export default function Workspace({ runData, projectData, viewingIterationRunId, onRefreshRunData }: WorkspaceProps) {
  const [activeTab, setActiveTab] = useState("plan");
  const prevExecutorStatus = useRef<string | undefined>(undefined);

  useEffect(() => {
    const currentStatus = runData?.stages?.builder?.status || runData?.stages?.executor?.status;
    if (
      prevExecutorStatus.current !== "passed" &&
      currentStatus === "passed"
    ) {
      setActiveTab("render");
    }
    prevExecutorStatus.current = currentStatus;
  }, [runData]);

  const current = defaultTabs.find((t) => t.id === activeTab);

  const renderTabContent = () => {
    switch (activeTab) {
      case "plan":
        return <PlanTab runData={runData} />;
      case "render":
        return <RenderTab runData={runData} />;
      case "shell":
        return <ShellTab runData={runData} projectId={projectData?.id} onRefreshRunData={onRefreshRunData} />;
      case "db":
        return <DbTab />;
      case "env":
        return <EnvTab projectId={projectData?.id || null} />;
      case "publish":
        return <PublishTab projectId={projectData?.id || null} />;
      case "brain":
        return <BrainTab />;
      default:
        return (
          <div className="panel-placeholder">
            <div className="panel-title">{current?.label}</div>
            <div className="panel-desc">{current?.description}</div>
          </div>
        );
    }
  };

  return (
    <div className="workspace-container">
      {viewingIterationRunId && (
        <div className="workspace-iteration-banner">
          Viewing iteration v{runData?.iterationNumber || "?"}
        </div>
      )}
      <div className="tab-bar">
        {defaultTabs.map((tab) => (
          <button
            key={tab.id}
            className={`tab-btn ${activeTab === tab.id ? "active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="tab-panel">{renderTabContent()}</div>
    </div>
  );
}
