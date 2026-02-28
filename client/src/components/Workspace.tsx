import { useState, useEffect, useRef } from "react";
import type { RunData, ProjectData } from "../App";

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
          <div className="render-section-label">Live Preview</div>
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

function ShellTab({ runData }: { runData: RunData | null }) {
  const [logs, setLogs] = useState<{ install: string; app: string } | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!runData?.id || !runData?.workspace) return;

    const fetchLogs = async () => {
      try {
        const res = await fetch(`/api/runs/${runData.id}/logs`);
        if (res.ok) {
          const data = await res.json();
          setLogs(data.logs);
        }
      } catch {
      }
    };

    fetchLogs();
    const interval = setInterval(fetchLogs, 2000);
    return () => clearInterval(interval);
  }, [runData?.id, runData?.workspace?.status]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

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

  const hasInstallLogs = logs?.install && logs.install.trim().length > 0;
  const hasAppLogs = logs?.app && logs.app.trim().length > 0;

  return (
    <div className="shell-content">
      <div className="shell-header">
        <WorkspaceStatusBadge status={runData.workspace.status} />
        {runData.workspace.port && (
          <span className="shell-port">Port {runData.workspace.port}</span>
        )}
      </div>
      <div className="shell-log-area">
        {hasInstallLogs && (
          <>
            <div className="shell-log-label">Install Output</div>
            <pre className="shell-log-block">{logs!.install}</pre>
          </>
        )}
        {hasAppLogs && (
          <>
            <div className="shell-log-label">Application Output</div>
            <pre className="shell-log-block">{logs!.app}</pre>
          </>
        )}
        {!hasInstallLogs && !hasAppLogs && (
          <div className="shell-log-empty">
            {runData.workspace.status === "writing-files"
              ? "Writing files to workspace..."
              : runData.workspace.status === "installing"
              ? "Installing dependencies..."
              : "Waiting for output..."}
          </div>
        )}
        {runData.workspace.error && (
          <div className="shell-error">Error: {runData.workspace.error}</div>
        )}
        <div ref={logEndRef} />
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
