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

export default function ProjectsList({ onSelectProject }: ProjectsListProps) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);

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
            onClick={() => onSelectProject(project.id)}
          >
            <div className="project-card-header">
              <span className="project-card-name">{project.name}</span>
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
              <span className="project-card-time">{timeAgo(project.updatedAt)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
