import { useState } from "react";
import type { RunData } from "../App";

type StageStatus = "pending" | "running" | "passed" | "blocked" | "failed";

interface Stage {
  id: string;
  label: string;
  status: StageStatus;
}

interface PromptColumnProps {
  runData: RunData | null;
  onRunBuild: (prompt: string) => void;
  onApprove: () => void;
  onReject: (feedback: string) => void;
}

const STAGE_MAP: { id: string; keys: string[]; label: string }[] = [
  { id: "planner", keys: ["planner", "revise_p2", "revise_p3"], label: "Planner" },
  { id: "reviewer", keys: ["reviewer_p1", "reviewer_p2", "reviewer_p3"], label: "Reviewer" },
  { id: "policy", keys: ["policy_gate"], label: "Policy" },
  { id: "human", keys: ["human_approval"], label: "Human" },
  { id: "executor", keys: ["executor"], label: "Executor" },
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
  onRunBuild,
  onApprove,
  onReject,
}: PromptColumnProps) {
  const [prompt, setPrompt] = useState("");
  const [rejectFeedback, setRejectFeedback] = useState("");
  const [showRejectInput, setShowRejectInput] = useState(false);

  const stages = deriveStages(runData);
  const isRunning = runData?.status === "running";
  const isAwaitingApproval = runData?.status === "awaiting-approval";

  const handleRunBuild = () => {
    if (!prompt.trim() || isRunning) return;
    onRunBuild(prompt);
  };

  const handleReject = () => {
    if (!rejectFeedback.trim()) return;
    onReject(rejectFeedback);
    setShowRejectInput(false);
    setRejectFeedback("");
  };

  const statusText = runData
    ? runData.status === "completed"
      ? "Completed"
      : runData.status === "failed"
        ? "Failed"
        : runData.status === "awaiting-approval"
          ? "Awaiting Approval"
          : "Running"
    : "Idle";

  return (
    <div className="prompt-column">
      <div className="prompt-input-area">
        <textarea
          className="prompt-textarea"
          placeholder="Describe what you want to build..."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={6}
          disabled={isRunning}
        />
        <button
          className="prompt-run-btn"
          onClick={handleRunBuild}
          disabled={isRunning || !prompt.trim()}
        >
          {isRunning ? "Running..." : "Run Build"}
        </button>
      </div>

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

      {isAwaitingApproval && (
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
            {runData ? new Date(runData.createdAt).toLocaleTimeString() : "—"}
          </span>
        </div>
        <div className="meta-row">
          <span className="meta-label">Status</span>
          <span className={`meta-value meta-${runData?.status || "idle"}`}>
            {statusText}
          </span>
        </div>
      </div>
    </div>
  );
}
