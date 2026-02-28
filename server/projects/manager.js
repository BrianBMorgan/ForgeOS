const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");

const WORKSPACES_DIR = path.join(__dirname, "..", "..", "workspaces");

const projects = new Map();

function createProject(prompt) {
  const id = uuidv4().slice(0, 8);
  const name = generateProjectName(prompt);
  const project = {
    id,
    name,
    status: "building",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    iterations: [],
    currentRunId: null,
  };
  projects.set(id, project);
  return project;
}

function generateProjectName(prompt) {
  const cleaned = prompt.replace(/[^a-zA-Z0-9\s]/g, "").trim();
  const words = cleaned.split(/\s+/).slice(0, 5);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

function addIteration(projectId, runId, prompt, iterationNumber) {
  const project = projects.get(projectId);
  if (!project) return null;

  project.iterations.push({
    runId,
    prompt,
    iterationNumber,
    createdAt: Date.now(),
  });
  project.currentRunId = runId;
  project.updatedAt = Date.now();
  project.status = "building";
  return project;
}

function captureCurrentFiles(runId) {
  const wsDir = path.join(WORKSPACES_DIR, runId);
  if (!fs.existsSync(wsDir)) return [];

  const files = [];
  const SKIP_DIRS = new Set(["node_modules", ".git", ".cache", "dist", "build"]);
  const SKIP_FILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);
  const MAX_FILE_SIZE = 50 * 1024;

  function walk(dir, prefix) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (SKIP_FILES.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > MAX_FILE_SIZE) continue;
          const content = fs.readFileSync(fullPath, "utf-8");
          files.push({ path: relPath, content });
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  walk(wsDir, "");
  return files;
}

function updateProjectStatus(projectId, status) {
  const project = projects.get(projectId);
  if (!project) return;
  project.status = status;
  project.updatedAt = Date.now();
}

function getProject(projectId) {
  return projects.get(projectId) || null;
}

function getAllProjects() {
  return Array.from(projects.values()).sort((a, b) => b.updatedAt - a.updatedAt);
}

function stopProject(projectId) {
  const project = projects.get(projectId);
  if (!project) return null;
  project.status = "stopped";
  project.updatedAt = Date.now();
  return project;
}

module.exports = {
  createProject,
  addIteration,
  captureCurrentFiles,
  updateProjectStatus,
  getProject,
  getAllProjects,
  stopProject,
};
