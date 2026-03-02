import { useState, useEffect } from "react";

interface ProjectSummary {
  id: string;
  name: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  iterations: Array<{
    prompt: string;
    iterationNumber: number;
  }>;
  currentRunId: string | null;
}

interface ProjectsListProps {
  onSelectProject: (projectId: string) => void;
}

const statusColors: Record<string, string> = {
  building: "#3b82f6",
  active: "#4ade80",
  stopped: "#64748b",
  failed: "#f87171",
};

const statusLabels: Record<string, string> = {
  building: "Building",
  active: "Running",
  stopped: "Stopped",
  failed: "Failed",
};

function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

async function renameProject(projectId: string, newName: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export default function ProjectsList({ onSelectProject }: ProjectsListProps) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    const fetchProjects = async () => {
      try {
        const res = await fetch("/api/projects");
        if (res.ok) {
          const data = await res.json();
          setProjects(data);
        }
      } catch {
      } finally {
        setLoading(false);
      }
    };

    fetchProjects();
    const interval = setInterval(fetchProjects, 5000);
    return () => clearInterval(interval);
  }, []);

  const startEditing = (e: React.MouseEvent, project: ProjectSummary) => {
    e.stopPropagation();
    setEditingId(project.id);
    setEditValue(project.name);
  };

  const commitRename = async (projectId: string) => {
    const trimmed = editValue.trim();
    if (!trimmed) {
      setEditingId(null);
      return;
    }
    const success = await renameProject(projectId, trimmed);
    if (success) {
      setProjects(prev => prev.map(p => p.id === projectId ? { ...p, name: trimmed } : p));
    }
    setEditingId(null);
  };

  const handleDelete = async (e: React.MouseEvent, projectId: string) => {
    e.stopPropagation();
    if (confirmDeleteId === projectId) {
      try {
        const res = await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
        if (res.ok) {
          setProjects(prev => prev.filter(p => p.id !== projectId));
        }
      } catch {}
      setConfirmDeleteId(null);
    } else {
      setConfirmDeleteId(projectId);
      setTimeout(() => setConfirmDeleteId(prev => prev === projectId ? null : prev), 3000);
    }
  };

  const handleEditKeyDown = (e: React.KeyboardEvent, projectId: string) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitRename(projectId);
    } else if (e.key === "Escape") {
      setEditingId(null);
    }
  };

  if (loading) {
    return (
      <div className="projects-list-container">
        <div className="projects-list-header">
          <h2 className="projects-list-title">Projects</h2>
        </div>
        <div className="projects-empty">Loading...</div>
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="projects-list-container">
        <div className="projects-list-header">
          <h2 className="projects-list-title">Projects</h2>
        </div>
        <div className="projects-empty">
          <div className="projects-empty-icon">+</div>
          <div className="projects-empty-text">No projects yet</div>
          <div className="projects-empty-hint">Start a new build to create your first project.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="projects-list-container">
      <div className="projects-list-header">
        <h2 className="projects-list-title">Projects</h2>
        <span className="projects-count">{projects.length}</span>
      </div>
      <div className="projects-grid">
        {projects.map((project) => (
          <div
            key={project.id}
            className="project-card"
            onClick={() => editingId !== project.id && onSelectProject(project.id)}
          >
            <div className="project-card-header">
              {editingId === project.id ? (
                <input
                  className="project-card-name-input"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => handleEditKeyDown(e, project.id)}
                  onBlur={() => commitRename(project.id)}
                  onClick={(e) => e.stopPropagation()}
                  autoFocus
                />
              ) : (
                <span className="project-card-name" title="Double-click to rename" onDoubleClick={(e) => startEditing(e, project)}>
                  <span className="project-card-name-text">{project.name}</span>
                  <button className="project-card-edit-btn" onClick={(e) => startEditing(e, project)} title="Rename project">&#9998;</button>
                </span>
              )}
              <span
                className="project-card-status"
                style={{ color: statusColors[project.status] || "#64748b" }}
              >
                <span
                  className="project-card-status-dot"
                  style={{ background: statusColors[project.status] || "#64748b" }}
                />
                {statusLabels[project.status] || project.status}
              </span>
            </div>
            <div className="project-card-prompt">
              {project.iterations[0]?.prompt.slice(0, 120) || ""}
              {(project.iterations[0]?.prompt.length || 0) > 120 ? "..." : ""}
            </div>
            <div className="project-card-footer">
              <span className="project-card-version">v{project.iterations.length}</span>
              <span className="project-card-footer-right">
                <button
                  className={`project-card-delete-btn ${confirmDeleteId === project.id ? "project-card-delete-confirm" : ""}`}
                  onClick={(e) => handleDelete(e, project.id)}
                  title={confirmDeleteId === project.id ? "Click again to confirm" : "Delete project"}
                >
                  {confirmDeleteId === project.id ? "Confirm?" : "\u2715"}
                </button>
                <span className="project-card-time">{timeAgo(project.updatedAt)}</span>
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
