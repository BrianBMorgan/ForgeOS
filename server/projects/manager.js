const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");
const { neon } = require("@neondatabase/serverless");

const WORKSPACES_DIR = path.join(__dirname, "..", "..", "workspaces");

const dbUrl = process.env.NEON_DATABASE_URL;
if (!dbUrl) {
  console.error("NEON_DATABASE_URL is not set — project persistence is disabled");
}
const sql = dbUrl ? neon(dbUrl) : null;

const projects = new Map();
let loadPromise = null;

async function ensureSchema() {
  if (!sql) return;
  try {
    await sql`CREATE TABLE IF NOT EXISTS projects (
      id VARCHAR(8) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'building',
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      current_run_id VARCHAR(255)
    )`;
    await sql`CREATE TABLE IF NOT EXISTS iterations (
      id SERIAL PRIMARY KEY,
      project_id VARCHAR(8) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      run_id VARCHAR(255) NOT NULL,
      prompt TEXT NOT NULL,
      iteration_number INT NOT NULL,
      created_at BIGINT NOT NULL
    )`;
  } catch (err) {
    console.error("Failed to ensure schema:", err.message);
  }
}

async function loadFromDb() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    if (!sql) return;
    try {
      await ensureSchema();
      const rows = await sql`SELECT * FROM projects ORDER BY updated_at DESC`;
      for (const row of rows) {
        const iterRows = await sql`SELECT * FROM iterations WHERE project_id = ${row.id} ORDER BY iteration_number ASC`;
        const project = {
          id: row.id,
          name: row.name,
          status: row.status,
          createdAt: Number(row.created_at),
          updatedAt: Number(row.updated_at),
          currentRunId: row.current_run_id,
          iterations: iterRows.map((ir) => ({
            runId: ir.run_id,
            prompt: ir.prompt,
            iterationNumber: ir.iteration_number,
            createdAt: Number(ir.created_at),
          })),
        };
        projects.set(project.id, project);
      }
      console.log(`Loaded ${rows.length} projects from database`);
    } catch (err) {
      console.error("Failed to load projects from database:", err.message);
      loadPromise = null;
    }
  })();
  return loadPromise;
}

function generateProjectName(prompt) {
  const cleaned = prompt.replace(/[^a-zA-Z0-9\s]/g, "").trim();
  const words = cleaned.split(/\s+/).slice(0, 5);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

async function createProject(prompt) {
  await loadFromDb();
  const id = uuidv4().slice(0, 8);
  const name = generateProjectName(prompt);
  const now = Date.now();
  const project = {
    id,
    name,
    status: "building",
    createdAt: now,
    updatedAt: now,
    iterations: [],
    currentRunId: null,
  };

  if (sql) {
    await sql`INSERT INTO projects (id, name, status, created_at, updated_at, current_run_id) VALUES (${id}, ${name}, ${"building"}, ${now}, ${now}, ${null})`;
  }

  projects.set(id, project);
  return project;
}

async function addIteration(projectId, runId, prompt, iterationNumber) {
  await loadFromDb();
  const project = projects.get(projectId);
  if (!project) return null;

  const now = Date.now();

  if (sql) {
    await sql`INSERT INTO iterations (project_id, run_id, prompt, iteration_number, created_at) VALUES (${projectId}, ${runId}, ${prompt}, ${iterationNumber}, ${now})`;
    await sql`UPDATE projects SET current_run_id = ${runId}, updated_at = ${now}, status = ${"building"} WHERE id = ${projectId}`;
  }

  project.iterations.push({
    runId,
    prompt,
    iterationNumber,
    createdAt: now,
  });
  project.currentRunId = runId;
  project.updatedAt = now;
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
        }
      }
    }
  }

  walk(wsDir, "");
  return files;
}

async function updateProjectStatus(projectId, status) {
  await loadFromDb();
  const project = projects.get(projectId);
  if (!project) return;
  project.status = status;
  const now = Date.now();
  project.updatedAt = now;

  if (sql) {
    try {
      await sql`UPDATE projects SET status = ${status}, updated_at = ${now} WHERE id = ${projectId}`;
    } catch (err) {
      console.error("Failed to persist status update:", err.message);
    }
  }
}

async function getProject(projectId) {
  await loadFromDb();
  return projects.get(projectId) || null;
}

async function getAllProjects() {
  await loadFromDb();
  return Array.from(projects.values()).sort((a, b) => b.updatedAt - a.updatedAt);
}

async function stopProject(projectId) {
  await loadFromDb();
  const project = projects.get(projectId);
  if (!project) return null;
  project.status = "stopped";
  const now = Date.now();
  project.updatedAt = now;

  if (sql) {
    try {
      await sql`UPDATE projects SET status = ${"stopped"}, updated_at = ${now} WHERE id = ${projectId}`;
    } catch (err) {
      console.error("Failed to persist stop:", err.message);
    }
  }

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
