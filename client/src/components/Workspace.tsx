import { useState } from "react";
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
  { id: "render", label: "Render", description: "Live preview of the deployed application." },
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

function ExecutorTab({ runData }: { runData: RunData | null }) {
  const executorOutput = runData?.stages?.executor?.output;

  if (!executorOutput || typeof executorOutput !== "object") {
    return null;
  }

  const exec = executorOutput as Record<string, unknown>;

  return (
    <div className="plan-content">
      {renderField("Implementation Summary", exec.implementationSummary)}
      {renderField("File Structure", exec.fileStructure)}
      {renderField("Environment Variables", exec.environmentVariables)}
      {renderField("Database Schema", exec.databaseSchema)}
      {renderField("Build Tasks", exec.buildTasks)}
    </div>
  );
}

export default function Workspace({ runData }: WorkspaceProps) {
  const [activeTab, setActiveTab] = useState("plan");

  const current = defaultTabs.find((t) => t.id === activeTab);

  const renderTabContent = () => {
    switch (activeTab) {
      case "plan":
        return <PlanTab runData={runData} />;
      case "review":
        return <ReviewTab runData={runData} />;
      case "diff":
        return <DiffTab runData={runData} />;
      default:
        if (activeTab === "plan" && runData?.stages?.executor?.output) {
          return <ExecutorTab runData={runData} />;
        }
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
