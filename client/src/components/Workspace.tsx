import { useState } from "react";

interface Tab {
  id: string;
  label: string;
  description: string;
}

const defaultTabs: Tab[] = [
  { id: "plan", label: "Plan", description: "View the structured build plan produced by the Planner agent." },
  { id: "review", label: "Review", description: "Reviewer findings, security flags, and approval status." },
  { id: "diff", label: "Diff", description: "File-level diff viewer for proposed changes." },
  { id: "render", label: "Render", description: "Live preview of the deployed application." },
  { id: "shell", label: "Shell", description: "Terminal output and log stream." },
  { id: "db", label: "DB", description: "Database viewer — tables, queries, and schema." },
  { id: "publish", label: "Publish", description: "Deployment controls, domains, and promotion workflow." },
];

export default function Workspace() {
  const [activeTab, setActiveTab] = useState("plan");

  const current = defaultTabs.find((t) => t.id === activeTab);

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
      <div className="tab-panel">
        {current && (
          <div className="panel-placeholder">
            <div className="panel-title">{current.label}</div>
            <div className="panel-desc">{current.description}</div>
          </div>
        )}
      </div>
    </div>
  );
}
