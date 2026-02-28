import { useState, useRef, useEffect } from "react";
import type { RunData, ProjectData, ChatMessage } from "../App";

type StageStatus = "pending" | "running" | "passed" | "blocked" | "failed";

interface Stage {
  id: string;
  label: string;
  status: StageStatus;
}

interface PromptColumnProps {
  runData: RunData | null;
  projectData: ProjectData | null;
  isNewProject: boolean;
  onRunBuild: (prompt: string) => void;
  onApprove: () => void;
  onReject: (feedback: string) => void;
  onViewIteration: (runId: string) => void;
  viewingIterationRunId: string | null;
  onViewLatest: () => void;
  chatMessages: ChatMessage[];
  onSendChat: (message: string) => void;
  chatLoading: boolean;
}

const STAGE_MAP: { id: string; keys: string[]; label: string }[] = [
  { id: "planner", keys: ["planner", "revise_p2", "revise_p3"], label: "Planner" },
  { id: "reviewer", keys: ["reviewer_p1", "reviewer_p2", "reviewer_p3"], label: "Reviewer" },
  { id: "policy", keys: ["policy_gate"], label: "Policy" },
  { id: "human", keys: ["human_approval"], label: "Human" },
  { id: "executor", keys: ["executor"], label: "Executor" },
  { id: "auditor", keys: ["auditor"], label: "Auditor" },
];

function deriveStages(runData: RunData | null): Stage[] {
  if (!runData) {
    return STAGE_MAP.map((s) => ({ id: s.id, label: s.label, status: "pending" as StageStatus }));
  }

  return STAGE_MAP.map((stageGroup) => {
    const statuses = stageGroup.keys
      .map((k) => runData.stages[k]?.status)
      .filter(Boolean);

    let status: StageStatus = "pending";
    if (statuses.includes("running")) {
      status = "running";
    } else if (statuses.includes("failed")) {
      status = "failed";
    } else if (statuses.includes("blocked")) {
      status = "blocked";
    } else if (statuses.some((s) => s === "passed")) {
      status = "passed";
    }

    return { id: stageGroup.id, label: stageGroup.label, status };
  });
}

function getLatestStageOutput(runData: RunData | null, keys: string[]): Record<string, unknown> | null {
  if (!runData) return null;
  for (const key of keys) {
    const stage = runData.stages[key];
    if (stage?.output && typeof stage.output === "object") return stage.output as Record<string, unknown>;
  }
  return null;
}

function ApprovalModal({
  runData,
  onApprove,
  onReject,
}: {
  runData: RunData | null;
  onApprove: () => void;
  onReject: (feedback: string) => void;
}) {
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [rejectFeedback, setRejectFeedback] = useState("");

  const plan = getLatestStageOutput(runData, ["revise_p3", "revise_p2", "planner"]);
  const review = getLatestStageOutput(runData, ["reviewer_p3", "reviewer_p2", "reviewer_p1"]);
  const policyGate = runData?.stages?.policy_gate?.output as Record<string, unknown> | null;

  const projectName = (plan?.projectName as string) || "Unnamed Project";
  const template = (plan?.template as string) || "";
  const modules = (plan?.modules as string[]) || [];
  const apiEndpoints = (plan?.apiEndpoints as { method: string; route: string; purpose: string }[]) || [];
  const uiPages = (plan?.uiPages as { route: string; purpose: string }[]) || [];
  const dbTables = (plan?.database as { required: boolean; tables: { name: string; purpose: string }[] })?.tables || [];
  const dbRequired = (plan?.database as { required: boolean })?.required || false;
  const envVars = (plan?.environmentVariables as string[]) || [];
  const risks = (plan?.risks as string[]) || [];
  const backgroundWorkers = (plan?.backgroundWorkers as { name: string; purpose: string }[]) || [];
  const dataFlows = (plan?.dataFlows as string[]) || [];
  const acceptanceCriteria = (plan?.acceptanceCriteria as string[]) || [];

  const riskLevel = (review?.riskLevel as string) || "unknown";
  const reviewSummary = (review?.summary as string) || "";
  const securityConcerns = (review?.securityConcerns as string[]) || [];
  const architecturalConcerns = (review?.architecturalConcerns as string[]) || [];
  const requiredChanges = (review?.withRequiredChanges as { issue: string; whyItMatters: string; requiredFix: string }[]) || [];

  const policyReason = (policyGate?.reason as string) || "";

  const handleReject = () => {
    if (!rejectFeedback.trim()) return;
    onReject(rejectFeedback);
    setShowRejectInput(false);
    setRejectFeedback("");
  };

  const riskClass = riskLevel === "high" ? "risk-high" : riskLevel === "medium" ? "risk-medium" : riskLevel === "low" ? "risk-low" : "risk-unknown";

  return (
    <div className="approval-overlay">
      <div className="approval-modal">
        <div className="approval-modal-header">
          <div className="approval-modal-icon">!</div>
          <div>
            <div className="approval-modal-title">Approval Required</div>
            <div className="approval-modal-subtitle">
              The agent is ready to build. Review the plan below.
            </div>
          </div>
        </div>

        <div className="approval-modal-body">
          <div className="approval-summary-row">
            <span className="approval-label-text">Project</span>
            <span className="approval-value-text">{projectName}</span>
          </div>
          {template && (
            <div className="approval-summary-row">
              <span className="approval-label-text">Template</span>
              <span className="approval-value-text">{template.replace(/-/g, " ")}</span>
            </div>
          )}
          <div className="approval-summary-row">
            <span className="approval-label-text">Risk Level</span>
            <span className={`approval-risk-badge ${riskClass}`}>{riskLevel}</span>
          </div>

          {reviewSummary && (
            <div className="approval-section">
              <div className="approval-section-title">Reviewer Summary</div>
              <p className="approval-section-text">{reviewSummary}</p>
            </div>
          )}

          {policyReason && (
            <div className="approval-section">
              <div className="approval-section-title">Why Approval is Needed</div>
              <p className="approval-section-text">{policyReason}</p>
            </div>
          )}

          {apiEndpoints.length > 0 && (
            <div className="approval-section">
              <div className="approval-section-title">API Endpoints ({apiEndpoints.length})</div>
              <ul className="approval-list">
                {apiEndpoints.map((ep, i) => (
                  <li key={i}>
                    <code>{ep.method} {ep.route}</code> — {ep.purpose}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {uiPages.length > 0 && (
            <div className="approval-section">
              <div className="approval-section-title">UI Pages ({uiPages.length})</div>
              <ul className="approval-list">
                {uiPages.map((pg, i) => (
                  <li key={i}>
                    <code>{pg.route}</code> — {pg.purpose}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {dbRequired && dbTables.length > 0 && (
            <div className="approval-section">
              <div className="approval-section-title">Database Tables ({dbTables.length})</div>
              <ul className="approval-list">
                {dbTables.map((t, i) => (
                  <li key={i}>
                    <code>{t.name}</code> — {t.purpose}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {modules.length > 0 && (
            <div className="approval-section">
              <div className="approval-section-title">Packages</div>
              <div className="approval-tags">
                {modules.map((m, i) => (
                  <span key={i} className="approval-tag">{m}</span>
                ))}
              </div>
            </div>
          )}

          {envVars.length > 0 && (
            <div className="approval-section">
              <div className="approval-section-title">Environment Variables</div>
              <div className="approval-tags">
                {envVars.map((v, i) => (
                  <span key={i} className="approval-tag env-tag">{v}</span>
                ))}
              </div>
            </div>
          )}

          {risks.length > 0 && (
            <div className="approval-section">
              <div className="approval-section-title">Risks</div>
              <ul className="approval-list risk-list">
                {risks.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )}

          {securityConcerns.length > 0 && (
            <div className="approval-section">
              <div className="approval-section-title">Security Concerns</div>
              <ul className="approval-list risk-list">
                {securityConcerns.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}

          {architecturalConcerns.length > 0 && (
            <div className="approval-section">
              <div className="approval-section-title">Architectural Concerns</div>
              <ul className="approval-list risk-list">
                {architecturalConcerns.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}

          {requiredChanges.length > 0 && (
            <div className="approval-section">
              <div className="approval-section-title">Required Changes</div>
              <ul className="approval-list risk-list">
                {requiredChanges.map((rc, i) => (
                  <li key={i}>
                    <strong>{rc.issue}</strong> — {rc.requiredFix}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {backgroundWorkers.length > 0 && (
            <div className="approval-section">
              <div className="approval-section-title">Background Workers</div>
              <ul className="approval-list">
                {backgroundWorkers.map((w, i) => (
                  <li key={i}>
                    <code>{w.name}</code> — {w.purpose}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {dataFlows.length > 0 && (
            <div className="approval-section">
              <div className="approval-section-title">Data Flows</div>
              <ul className="approval-list">
                {dataFlows.map((df, i) => (
                  <li key={i}>{df}</li>
                ))}
              </ul>
            </div>
          )}

          {acceptanceCriteria.length > 0 && (
            <div className="approval-section">
              <div className="approval-section-title">Acceptance Criteria</div>
              <ul className="approval-list">
                {acceptanceCriteria.map((ac, i) => (
                  <li key={i}>{ac}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="approval-modal-footer">
          {!showRejectInput ? (
            <div className="approval-modal-actions">
              <button className="approval-modal-approve" onClick={onApprove}>
                Approve Build
              </button>
              <button
                className="approval-modal-reject"
                onClick={() => setShowRejectInput(true)}
              >
                Reject
              </button>
            </div>
          ) : (
            <div className="approval-modal-reject-area">
              <textarea
                className="approval-modal-textarea"
                placeholder="Explain what should change..."
                value={rejectFeedback}
                onChange={(e) => setRejectFeedback(e.target.value)}
                rows={3}
                autoFocus
              />
              <div className="approval-modal-actions">
                <button className="approval-modal-reject-submit" onClick={handleReject}>
                  Submit Rejection
                </button>
                <button
                  className="approval-modal-reject-cancel"
                  onClick={() => {
                    setShowRejectInput(false);
                    setRejectFeedback("");
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function PromptColumn({
  runData,
  projectData,
  isNewProject,
  onRunBuild,
  onApprove,
  onReject,
  onViewIteration,
  viewingIterationRunId,
  onViewLatest,
  chatMessages,
  onSendChat,
  chatLoading,
}: PromptColumnProps) {
  const [prompt, setPrompt] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);

  const stages = deriveStages(runData);
  const isRunning = runData?.status === "running";
  const isAwaitingApproval = runData?.status === "awaiting-approval";
  const isViewingHistory = !!viewingIterationRunId;

  const isProjectView = !isNewProject && projectData;
  const hasIterations = projectData && projectData.iterations.length > 0;
  const canIterate = isProjectView && runData?.status === "completed" && runData?.workspace?.status === "running";
  const hasChatHistory = chatMessages.length > 0;

  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [chatMessages]);

  const handleSubmit = () => {
    if (!prompt.trim() || isRunning || chatLoading) return;
    if (isProjectView) {
      onSendChat(prompt);
    } else {
      onRunBuild(prompt);
    }
    setPrompt("");
  };

  const handleBuildFromSuggestion = (suggestion: string) => {
    onRunBuild(suggestion);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="prompt-column">
      {isProjectView && (
        <div className="project-header-bar">
          <div className="project-header-name">{projectData.name}</div>
          <div className="project-header-status">
            <span
              className="project-status-dot"
              style={{
                background:
                  projectData.status === "active" ? "#4ade80" :
                  projectData.status === "building" ? "#3b82f6" :
                  projectData.status === "failed" ? "#f87171" : "#64748b"
              }}
            />
            {projectData.status === "active" ? "Running" :
             projectData.status === "building" ? "Building" :
             projectData.status === "failed" ? "Failed" : "Stopped"}
          </div>
        </div>
      )}

      {hasIterations && (
        <div className="iteration-dropdown-bar">
          <div className="iteration-dropdown-label">ITERATION</div>
          <select
            className="iteration-dropdown-select"
            value={viewingIterationRunId || projectData.currentRunId || ""}
            onChange={(e) => {
              const selected = e.target.value;
              if (selected === projectData.currentRunId) {
                onViewLatest();
              } else {
                onViewIteration(selected);
              }
            }}
          >
            {projectData.iterations.map((iter) => {
              const isCurrent = iter.runId === projectData.currentRunId;
              const statusLabel = iter.status === "completed"
                ? (isCurrent && iter.workspaceStatus === "running" ? "live" : "done")
                : iter.status === "running" ? "running" : iter.status === "failed" ? "failed" : "";
              return (
                <option key={iter.runId} value={iter.runId}>
                  v{iter.iterationNumber}{isCurrent ? " (latest)" : ""} — {iter.prompt.slice(0, 50)}{iter.prompt.length > 50 ? "..." : ""} [{statusLabel}]
                </option>
              );
            })}
          </select>
        </div>
      )}

      {isViewingHistory && (
        <div className="viewing-history-banner">
          Viewing past iteration
          <button className="viewing-history-btn" onClick={onViewLatest}>Back to latest</button>
        </div>
      )}

      {isProjectView && !isViewingHistory && hasChatHistory && (
        <div className="chat-thread">
          {chatMessages.map((msg, i) => (
            <div key={i} className={`chat-message chat-${msg.role}`}>
              <div className="chat-role">{msg.role === "user" ? "You" : "Forge"}</div>
              <div className="chat-content">{msg.content}</div>
              {msg.suggestBuild && msg.buildSuggestion && (
                <button
                  className="chat-build-btn"
                  onClick={() => handleBuildFromSuggestion(msg.buildSuggestion!)}
                  disabled={isRunning || chatLoading || !canIterate}
                >
                  Build this change
                </button>
              )}
            </div>
          ))}
          {chatLoading && (
            <div className="chat-message chat-assistant">
              <div className="chat-role">Forge</div>
              <div className="chat-content chat-thinking">Thinking...</div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>
      )}

      {!isViewingHistory && (
        <div className="prompt-input-area">
          <textarea
            className="prompt-textarea"
            placeholder={
              isProjectView
                ? "Ask a question or describe a change..."
                : "Describe what you want to build..."
            }
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={isProjectView ? 3 : 6}
            disabled={isRunning || chatLoading}
          />
          <div className="prompt-actions">
            {isProjectView && canIterate && (
              <button
                className="prompt-build-btn"
                onClick={() => {
                  if (prompt.trim()) {
                    onRunBuild(prompt);
                    setPrompt("");
                  }
                }}
                disabled={isRunning || chatLoading || !prompt.trim()}
              >
                Build
              </button>
            )}
            <button
              className="prompt-run-btn"
              onClick={handleSubmit}
              disabled={isRunning || chatLoading || !prompt.trim()}
            >
              {isRunning ? "Running..." : chatLoading ? "Thinking..." : isProjectView ? "Send" : "Run Build"}
            </button>
          </div>
        </div>
      )}

      {isRunning && (
        <div className="pipeline">
          <div className="pipeline-label">PIPELINE</div>
          <div className="pipeline-stages">
            {stages.map((stage, i) => (
              <div key={stage.id} className="pipeline-stage">
                <div className={`stage-dot ${stage.status}`} />
                <span className="stage-label">{stage.label}</span>
                {i < stages.length - 1 && <div className="stage-connector" />}
              </div>
            ))}
          </div>
        </div>
      )}

      {!isRunning && !isProjectView && (
        <div className="pipeline">
          <div className="pipeline-label">PIPELINE</div>
          <div className="pipeline-stages">
            {stages.map((stage, i) => (
              <div key={stage.id} className="pipeline-stage">
                <div className={`stage-dot ${stage.status}`} />
                <span className="stage-label">{stage.label}</span>
                {i < stages.length - 1 && <div className="stage-connector" />}
              </div>
            ))}
          </div>
        </div>
      )}

      {isAwaitingApproval && !isViewingHistory && (
        <ApprovalModal
          runData={runData}
          onApprove={onApprove}
          onReject={onReject}
        />
      )}

      <div className="prompt-meta">
        <div className="meta-row">
          <span className="meta-label">Last run</span>
          <span className="meta-value">
            {runData ? new Date(runData.createdAt).toLocaleTimeString() : "--"}
          </span>
        </div>
        <div className="meta-row">
          <span className="meta-label">Status</span>
          <span className={`meta-value meta-${runData?.status || "idle"}`}>
            {runData
              ? runData.status === "completed"
                ? "Completed"
                : runData.status === "failed"
                  ? "Failed"
                  : runData.status === "awaiting-approval"
                    ? "Awaiting Approval"
                    : "Running"
              : "Idle"}
          </span>
        </div>
        {runData?.iterationNumber && (
          <div className="meta-row">
            <span className="meta-label">Iteration</span>
            <span className="meta-value">v{runData.iterationNumber}</span>
          </div>
        )}
      </div>
    </div>
  );
}
