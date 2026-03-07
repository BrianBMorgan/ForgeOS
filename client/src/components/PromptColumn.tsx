import { useState, useRef, useEffect } from "react";
import type { RunData, ProjectData, ChatMessage } from "../App";

type StageStatus = "pending" | "running" | "passed" | "blocked" | "failed";

interface Stage {
  id: string;
  label: string;
  short: string;
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

const STAGE_MAP: { id: string; keys: string[]; label: string; short: string; icon: string }[] = [
  { id: "prompt",  keys: [],          label: "Prompt",  short: "In",    icon: "❯" },
  { id: "brain",   keys: [],          label: "Brain",   short: "Mem",   icon: "◉" },
  { id: "builder", keys: ["builder"], label: "Builder", short: "Build", icon: "⚡" },
  { id: "render",  keys: [],          label: "Render",  short: "Live",  icon: "◧" },
  { id: "publish", keys: [],          label: "Publish", short: "Ship",  icon: "▲" },
];

interface PipelineStage extends Stage {
  icon: string;
}

function deriveStages(runData: RunData | null): PipelineStage[] {
  if (!runData) {
    return STAGE_MAP.map((s) => ({ id: s.id, label: s.label, short: s.short, icon: s.icon, status: "pending" as StageStatus }));
  }

  const builderStage = runData.stages?.builder;
  const builderStatus = builderStage?.status as string | undefined;
  const isRunning = runData.status === "running";
  const isCompleted = runData.status === "completed";
  const isFailed = runData.status === "failed";

  return STAGE_MAP.map((s) => {
    let status: StageStatus = "pending";

    switch (s.id) {
      case "prompt":
        status = runData ? "passed" : "pending";
        break;
      case "brain":
        if (builderStatus === "running" || builderStatus === "passed") status = "passed";
        else if (isRunning) status = "running";
        break;
      case "builder":
        if (builderStatus === "passed") status = "passed";
        else if (builderStatus === "running") status = "running";
        else if (builderStatus === "failed") status = "failed";
        break;
      case "render":
        if (isCompleted) status = "passed";
        else if (builderStatus === "passed" && isRunning) status = "running";
        else if (isFailed && builderStatus === "passed") status = "failed";
        break;
      case "publish":
        status = "pending";
        break;
    }

    return { id: s.id, label: s.label, short: s.short, icon: s.icon, status };
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

interface SkillOption {
  id: number;
  name: string;
  slug: string;
  description: string;
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [skillOptions, setSkillOptions] = useState<SkillOption[]>([]);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashPos, setSlashPos] = useState(-1);

  useEffect(() => {
    (window as unknown as Record<string, unknown>).__forgeSetPrompt = (text: string) => {
      setPrompt((prev) => (prev ? prev + "\n" + text : text));
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
    };
    (window as unknown as Record<string, unknown>).__forgeRunBuild = (text: string) => {
      if (!text || !text.trim()) return;
      onRunBuild(text.trim());
    };
    return () => {
      delete (window as unknown as Record<string, unknown>).__forgeSetPrompt;
      delete (window as unknown as Record<string, unknown>).__forgeRunBuild;
    };
  }, [onRunBuild]);

  const stages = deriveStages(runData);
  const isRunning = runData?.status === "running";
  const isAwaitingApproval = runData?.status === "awaiting-approval";
  const isViewingHistory = !!viewingIterationRunId;

  const isProjectView = !isNewProject && projectData;
  const hasIterations = projectData && projectData.iterations.length > 0;
  const canIterate = isProjectView && (runData?.status === "completed" || runData?.status === "failed");
  const hasChatHistory = chatMessages.length > 0;

  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [chatMessages]);

  useEffect(() => {
    fetch("/api/skills").then(r => r.json()).then(data => {
      const skills = (data.skills || []).map((s: { id: number; name: string; description: string }) => ({
        id: s.id,
        name: s.name,
        slug: s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""),
        description: s.description || "",
      }));
      setSkillOptions(skills);
    }).catch(() => {});
  }, []);

  const filteredSkills = slashQuery !== null
    ? skillOptions.filter(s =>
        s.slug.includes(slashQuery.toLowerCase()) || s.name.toLowerCase().includes(slashQuery.toLowerCase())
      ).slice(0, 8)
    : [];

  const handlePromptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setPrompt(val);

    const cursorPos = e.target.selectionStart;
    const textBeforeCursor = val.slice(0, cursorPos);
    const slashMatch = textBeforeCursor.match(/\/([a-z0-9-]*)$/i);
    if (slashMatch) {
      setSlashQuery(slashMatch[1]);
      setSlashPos(cursorPos - slashMatch[0].length);
      setSlashIndex(0);
    } else {
      setSlashQuery(null);
      setSlashPos(-1);
    }
  };

  const insertSkill = (skill: SkillOption) => {
    if (slashPos < 0) return;
    const cursorPos = textareaRef.current?.selectionStart || prompt.length;
    const before = prompt.slice(0, slashPos);
    const after = prompt.slice(cursorPos);
    const inserted = `/${skill.slug} `;
    const newPrompt = before + inserted + after;
    setPrompt(newPrompt);
    setSlashQuery(null);
    setSlashPos(-1);
    setTimeout(() => {
      if (textareaRef.current) {
        const pos = before.length + inserted.length;
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(pos, pos);
      }
    }, 0);
  };

  const handleSubmit = () => {
    if (!prompt.trim() || isRunning || chatLoading) return;
    if (isProjectView) {
      onSendChat(prompt);
    } else {
      onRunBuild(prompt);
    }
    setPrompt("");
    setSlashQuery(null);
    setSlashPos(-1);
  };

  const handleBuildFromSuggestion = (suggestion: string) => {
    onRunBuild(suggestion);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashQuery !== null && filteredSkills.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((prev) => Math.min(prev + 1, filteredSkills.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        insertSkill(filteredSkills[slashIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashQuery(null);
        setSlashPos(-1);
        return;
      }
    }
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

      {!(isProjectView && !isViewingHistory && hasChatHistory) && <div className="prompt-column-spacer" />}

      {!isViewingHistory && (
        <div className="prompt-input-area">
          <div className="prompt-textarea-wrap">
            {slashQuery !== null && filteredSkills.length > 0 && (
              <div className="slash-dropdown">
                {filteredSkills.map((skill, i) => (
                  <div
                    key={skill.id}
                    className={`slash-option${i === slashIndex ? " active" : ""}`}
                    onMouseDown={(e) => { e.preventDefault(); insertSkill(skill); }}
                    onMouseEnter={() => setSlashIndex(i)}
                  >
                    <span className="slash-option-name">/{skill.slug}</span>
                    {skill.description && <span className="slash-option-desc">{skill.description}</span>}
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={textareaRef}
              className="prompt-textarea"
              placeholder={
                isProjectView
                  ? "Ask a question or type / for skills..."
                  : "Describe what you want to build..."
              }
              value={prompt}
              onChange={handlePromptChange}
              onKeyDown={handleKeyDown}
              rows={isProjectView ? 3 : 6}
              disabled={isRunning || chatLoading}
            />
          </div>
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

      <div className="pipeline">
        <div className="pipeline-label">PIPELINE</div>
        <div className="pipeline-stages">
          {stages.map((stage, i) => (
            <div key={stage.id} className="pipeline-stage">
              <div className={`stage-node ${stage.status}`}>
                <span className="stage-icon">{stage.icon}</span>
              </div>
              <span className="stage-label"><span className="stage-label-full">{stage.label}</span><span className="stage-label-short">{stage.short}</span></span>
              {i < stages.length - 1 && <div className={`stage-connector ${stage.status === "passed" ? "stage-connector-passed" : ""}`} />}
            </div>
          ))}
        </div>
      </div>

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
        {runData?.tokenUsage && (
          <div className="token-usage-section">
            <div className="meta-row token-usage-header">
              <span className="meta-label">Tokens</span>
              <span className="meta-value token-total">{runData.tokenUsage.totals.totalTokens.toLocaleString()}</span>
            </div>
            <div className="token-breakdown">
              <div className="token-row">
                <span className="token-label">Prompt</span>
                <span className="token-val">{runData.tokenUsage.totals.promptTokens.toLocaleString()}</span>
              </div>
              <div className="token-row">
                <span className="token-label">Completion</span>
                <span className="token-val">{runData.tokenUsage.totals.completionTokens.toLocaleString()}</span>
              </div>
              {runData.tokenUsage.totals.totalTokens > 0 && (
                <div className="token-row token-cost">
                  <span className="token-label">Est. Cost</span>
                  <span className="token-val">${((runData.tokenUsage.totals.promptTokens * 2.5 / 1_000_000) + (runData.tokenUsage.totals.completionTokens * 10 / 1_000_000)).toFixed(4)}</span>
                </div>
              )}
              <div className="token-stages">
                {Object.entries(runData.tokenUsage.stages).map(([stage, data]: [string, any]) => (
                  <div className="token-stage-row" key={stage}>
                    <span className="token-stage-name">{stage}</span>
                    <span className="token-stage-val">{data.totalTokens.toLocaleString()} ({data.calls} call{data.calls !== 1 ? "s" : ""})</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
