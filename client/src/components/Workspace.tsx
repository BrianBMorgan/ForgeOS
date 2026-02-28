import { useState, useEffect, useRef } from "react";
import type { RunData } from "../App";

interface Tab {
  id: string;
  label: string;
  description: string;
}

const defaultTabs: Tab[] = [
  { id: "plan", label: "Plan", description: "View the structured build plan produced by the Planner agent." },
  { id: "review", label: "Review", description: "Reviewer findings, security flags, and approval status." },
  { id: "diff", label: "Diff", description: "Changes between original and revised plan." },
  { id: "render", label: "Render", description: "Implementation spec and build output." },
  { id: "shell", label: "Shell", description: "Terminal output and log stream." },
  { id: "db", label: "DB", description: "Database viewer — tables, queries, and schema." },
  { id: "publish", label: "Publish", description: "Deployment controls, domains, and promotion workflow." },
];

interface WorkspaceProps {
  runData: RunData | null;
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

function RenderTab({ runData }: { runData: RunData | null }) {
  const executorOutput = runData?.stages?.executor?.output;

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
  const fileStructure = (exec.fileStructure || []) as FileEntry[];
  const envVars = (exec.environmentVariables || []) as string[];
  const dbSchema = exec.databaseSchema as string | null;
  const buildTasks = (exec.buildTasks || []) as BuildTask[];
  const treeEntries = parseFileTree(fileStructure);

  return (
    <div className="render-content">
      {summary && (
        <div className="render-section">
          <div className="render-section-label">Implementation Summary</div>
          <div className="render-summary">{summary}</div>
        </div>
      )}

      {treeEntries.length > 0 && (
        <div className="render-section">
          <div className="render-section-label">File Structure</div>
          <div className="file-tree">
            {treeEntries.map((entry, i) => (
              <div
                key={i}
                className="file-tree-entry"
                style={{ paddingLeft: `${entry.depth * 1.25 + 0.5}rem` }}
              >
                <span className="file-tree-icon">
                  {entry.isDir ? "📁" : "📄"}
                </span>
                <span className="file-tree-name">{entry.name}</span>
                <span className="file-tree-purpose">{entry.purpose}</span>
              </div>
            ))}
          </div>
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

export default function Workspace({ runData }: WorkspaceProps) {
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
      case "diff":
        return <DiffTab runData={runData} />;
      case "render":
        return <RenderTab runData={runData} />;
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
