import { useState } from "react";

type StageStatus = "pending" | "running" | "passed" | "blocked" | "failed";

interface Stage {
  id: string;
  label: string;
  status: StageStatus;
}

const defaultStages: Stage[] = [
  { id: "planner", label: "Planner", status: "pending" },
  { id: "reviewer", label: "Reviewer", status: "pending" },
  { id: "policy", label: "Policy", status: "pending" },
  { id: "human", label: "Human", status: "pending" },
  { id: "executor", label: "Executor", status: "pending" },
];

export default function PromptColumn() {
  const [prompt, setPrompt] = useState("");
  const stages = defaultStages;

  return (
    <div className="prompt-column">
      <div className="prompt-input-area">
        <textarea
          className="prompt-textarea"
          placeholder="Describe what you want to build..."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={6}
        />
        <button className="prompt-run-btn">Run Build</button>
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

      <div className="prompt-meta">
        <div className="meta-row">
          <span className="meta-label">Last run</span>
          <span className="meta-value">&mdash;</span>
        </div>
        <div className="meta-row">
          <span className="meta-label">Status</span>
          <span className="meta-value meta-idle">Idle</span>
        </div>
      </div>
    </div>
  );
}
