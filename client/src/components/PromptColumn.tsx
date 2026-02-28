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
  const [rejectFeedback, setRejectFeedback] = useState("");
  const [showRejectInput, setShowRejectInput] = useState(false);
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

  const handleReject = () => {
    if (!rejectFeedback.trim()) return;
    onReject(rejectFeedback);
    setShowRejectInput(false);
    setRejectFeedback("");
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
        <div className="iteration-history">
          <div className="iteration-history-label">ITERATIONS</div>
          {projectData.iterations.map((iter) => {
            const isActive = viewingIterationRunId
              ? viewingIterationRunId === iter.runId
              : iter.runId === projectData.currentRunId;
            const isCurrent = iter.runId === projectData.currentRunId;

            return (
              <div
                key={iter.runId}
                className={`iteration-item ${isActive ? "active" : ""}`}
                onClick={() => {
                  if (isCurrent) {
                    onViewLatest();
                  } else {
                    onViewIteration(iter.runId);
                  }
                }}
              >
                <span className="iteration-badge">v{iter.iterationNumber}</span>
                <span className="iteration-prompt">{iter.prompt.slice(0, 60)}{iter.prompt.length > 60 ? "..." : ""}</span>
                <span className={`iteration-status iteration-status-${iter.status}`}>
                  {iter.status === "completed" ? (
                    iter.workspaceStatus === "running" ? "live" : "done"
                  ) : iter.status === "running" ? "..." : iter.status === "failed" ? "fail" : ""}
                </span>
              </div>
            );
          })}
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
        <div className="approval-controls">
          <div className="approval-label">Approval Required</div>
          {!showRejectInput ? (
            <div className="approval-buttons">
              <button className="approve-btn" onClick={onApprove}>
                Approve
              </button>
              <button
                className="reject-btn"
                onClick={() => setShowRejectInput(true)}
              >
                Reject
              </button>
            </div>
          ) : (
            <div className="reject-input-area">
              <textarea
                className="reject-textarea"
                placeholder="Explain what should change..."
                value={rejectFeedback}
                onChange={(e) => setRejectFeedback(e.target.value)}
                rows={3}
              />
              <div className="approval-buttons">
                <button className="reject-submit-btn" onClick={handleReject}>
                  Submit
                </button>
                <button
                  className="reject-cancel-btn"
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
