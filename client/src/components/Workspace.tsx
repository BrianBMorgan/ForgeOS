import { useState, useEffect, useRef, useCallback } from "react";
import type { RunData, ProjectData } from "../App";
import DbTab from "./DbTab";

interface Tab {
  id: string;
  label: string;
  description: string;
}

const defaultTabs: Tab[] = [
  { id: "plan", label: "Plan", description: "View the structured build plan produced by the Planner agent." },
  { id: "review", label: "Review", description: "Reviewer findings, security flags, and approval status." },
  { id: "diff", label: "Diff", description: "Changes between original and revised plan." },
  { id: "auditor", label: "Auditor", description: "Pre-deployment audit results and fixes." },
  { id: "render", label: "Render", description: "Live preview and implementation output." },
  { id: "shell", label: "Shell", description: "Terminal output and log stream." },
  { id: "db", label: "DB", description: "Database viewer — tables, queries, and schema." },
  { id: "env", label: "Env", description: "Project environment variables." },
  { id: "publish", label: "Publish", description: "Deployment controls, domains, and promotion workflow." },
];

interface WorkspaceProps {
  runData: RunData | null;
  projectData?: ProjectData | null;
  viewingIterationRunId?: string | null;
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
  const planOutput =
    runData?.stages?.revise_p3?.output ||
    runData?.stages?.revise_p2?.output ||
    runData?.stages?.planner?.output;

  if (!planOutput || typeof planOutput !== "object") {
    return (
      <div className="panel-placeholder">
        <div className="panel-title">Plan</div>
        <div className="panel-desc">
          {runData?.status === "running"
            ? "Plan is being generated..."
            : "Run a build to see the structured plan."}
        </div>
      </div>
    );
  }

  const plan = planOutput as Record<string, unknown>;

  return (
    <div className="plan-content">
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

function ReviewTab({ runData }: { runData: RunData | null }) {
  const reviewOutput =
    runData?.stages?.reviewer_p3?.output ||
    runData?.stages?.reviewer_p2?.output ||
    runData?.stages?.reviewer_p1?.output;

  if (!reviewOutput || typeof reviewOutput !== "object") {
    return (
      <div className="panel-placeholder">
        <div className="panel-title">Review</div>
        <div className="panel-desc">
          {runData?.status === "running"
            ? "Review in progress..."
            : "Run a build to see review findings."}
        </div>
      </div>
    );
  }

  const review = reviewOutput as Record<string, unknown>;

  return (
    <div className="review-content">
      <div className="review-header">
        <span className={`review-verdict ${review.approved ? "approved" : "rejected"}`}>
          {review.approved ? "APPROVED" : "CHANGES REQUIRED"}
        </span>
        <span className={`review-risk risk-${review.riskLevel}`}>
          Risk: {String(review.riskLevel || "").toUpperCase()}
        </span>
      </div>
      <div className="review-summary">{String(review.summary || "")}</div>
      {renderField("Required Changes", review.withRequiredChanges)}
      {renderField("Architectural Concerns", review.architecturalConcerns)}
      {renderField("Security Concerns", review.securityConcerns)}
      {renderField("Overengineering Concerns", review.overengineeringConcerns)}
    </div>
  );
}

function AuditorTab({ runData }: { runData: RunData | null }) {
  const auditorOutput = runData?.stages?.auditor?.output as Record<string, unknown> | null;

  if (!auditorOutput || typeof auditorOutput !== "object") {
    return (
      <div className="panel-placeholder">
        <div className="panel-title">Auditor</div>
        <div className="panel-desc">
          {runData?.stages?.auditor?.status === "running"
            ? "Auditing executor output..."
            : "Run a build to see audit results."}
        </div>
      </div>
    );
  }

  const issues = (auditorOutput.issues || []) as Array<Record<string, unknown>>;
  const fixApplied = auditorOutput.fixApplied as boolean | undefined;
  const originalIssueCount = auditorOutput.originalIssueCount as number | undefined;

  return (
    <div className="review-content">
      <div className="review-header">
        <span className={`review-verdict ${auditorOutput.approved ? "approved" : "rejected"}`}>
          {auditorOutput.approved ? "AUDIT PASSED" : "ISSUES FOUND"}
        </span>
        {fixApplied && (
          <span className="review-verdict approved" style={{ marginLeft: 8 }}>
            FIX APPLIED ({originalIssueCount} issue{originalIssueCount !== 1 ? "s" : ""} corrected)
          </span>
        )}
      </div>
      <div className="review-summary">{String(auditorOutput.summary || "")}</div>
      {issues.length > 0 && (
        <div className="review-section">
          <div className="review-section-title">
            {fixApplied ? "Issues Found & Fixed" : "Issues"}
          </div>
          {issues.map((issue, i) => (
            <div key={i} className="review-item" style={{ borderLeft: `3px solid ${issue.severity === "critical" ? "#ef4444" : issue.severity === "high" ? "#f59e0b" : "#3b82f6"}` }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: issue.severity === "critical" ? "#ef4444" : issue.severity === "high" ? "#f59e0b" : "#3b82f6" }}>
                  {String(issue.severity)}
                </span>
                <span style={{ fontSize: 12, color: "#94a3b8" }}>{String(issue.rule)}</span>
                {issue.file && <span style={{ fontSize: 11, color: "#64748b" }}>{String(issue.file)}</span>}
              </div>
              <div style={{ fontSize: 13, color: "#e2e8f0", marginBottom: 4 }}>{String(issue.description)}</div>
              <div style={{ fontSize: 12, color: "#22c55e" }}>Fix: {String(issue.fix)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DiffTab({ runData }: { runData: RunData | null }) {
  const original = runData?.stages?.planner?.output as Record<string, unknown> | null;
  const revised =
    (runData?.stages?.revise_p3?.output ||
      runData?.stages?.revise_p2?.output) as Record<string, unknown> | null;

  if (!original || !revised) {
    return (
      <div className="panel-placeholder">
        <div className="panel-title">Diff</div>
        <div className="panel-desc">
          {runData?.status === "running"
            ? "Waiting for revision..."
            : "Run a build to compare original and revised plans."}
        </div>
      </div>
    );
  }

  return (
    <div className="diff-content">
      <div className="diff-columns">
        <div className="diff-column">
          <div className="diff-column-header">Original Plan</div>
          <pre className="diff-json">{JSON.stringify(original, null, 2)}</pre>
        </div>
        <div className="diff-column">
          <div className="diff-column-header">Revised Plan</div>
          <pre className="diff-json">{JSON.stringify(revised, null, 2)}</pre>
        </div>
      </div>
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
  const executorOutput = runData?.stages?.executor?.output;
  const ws = runData?.workspace;

  const previewRunData = liveRunData || runData;
  const previewWs = previewRunData?.workspace;

  if (!executorOutput || typeof executorOutput !== "object") {
    const isRunning = runData?.status === "running";
    const isAwaiting = runData?.status === "awaiting-approval";
    const hasPlan = runData?.stages?.planner?.status === "passed";

    let message = "Run a build to generate an implementation spec.";
    if (isRunning) {
      message = "Pipeline is running...";
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

  const exec = executorOutput as Record<string, unknown>;
  const summary = exec.implementationSummary as string | undefined;
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
              src={`/preview/${previewRunData.id}/`}
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

function ShellTab({ runData }: { runData: RunData | null }) {
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

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
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
      const res = await fetch(`/api/projects/${projectId}/env`);
      const data = await res.json();
      setEnvVars(data.envVars || []);
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

export default function Workspace({ runData, projectData, viewingIterationRunId }: WorkspaceProps) {
  const [activeTab, setActiveTab] = useState("plan");
  const prevExecutorStatus = useRef<string | undefined>(undefined);

  useEffect(() => {
    const currentStatus = runData?.stages?.executor?.status;
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
      case "review":
        return <ReviewTab runData={runData} />;
      case "auditor":
        return <AuditorTab runData={runData} />;
      case "diff":
        return <DiffTab runData={runData} />;
      case "render":
        return <RenderTab runData={runData} />;
      case "shell":
        return <ShellTab runData={runData} />;
      case "db":
        return <DbTab />;
      case "env":
        return <EnvTab projectId={projectData?.id || null} />;
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
