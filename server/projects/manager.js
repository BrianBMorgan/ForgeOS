const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");
const { neon } = require("@neondatabase/serverless");

const WORKSPACES_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, "..", ".."), "workspaces");

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
    await sql`CREATE TABLE IF NOT EXISTS run_snapshots (
      id VARCHAR(255) PRIMARY KEY,
      data JSONB NOT NULL,
      created_at BIGINT NOT NULL
    )`;
    await sql`CREATE TABLE IF NOT EXISTS project_env_vars (
      id SERIAL PRIMARY KEY,
      project_id VARCHAR(8) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      key VARCHAR(255) NOT NULL,
      value TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      UNIQUE(project_id, key)
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

async function renameProject(projectId, newName) {
  await loadFromDb();
  const project = projects.get(projectId);
  if (!project) return null;
  project.name = newName;
  project.updatedAt = Date.now();
  if (sql) {
    try {
      await sql`UPDATE projects SET name = ${newName}, updated_at = ${project.updatedAt} WHERE id = ${projectId}`;
    } catch (err) {
      console.error("Failed to persist rename:", err.message);
    }
  }
  return project;
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

async function deleteProject(projectId) {
  await loadFromDb();
  const project = projects.get(projectId);
  if (!project) return false;

  if (project.currentRunId) {
    try {
      const workspace = require("../workspace/manager");
      workspace.stopApp(project.currentRunId);
    } catch {}
  }

  if (sql) {
    try {
      await sql`DELETE FROM chat_messages WHERE project_id = ${projectId}`;
      await sql`DELETE FROM project_env_vars WHERE project_id = ${projectId}`;
      const iters = await sql`SELECT run_id FROM iterations WHERE project_id = ${projectId}`;
      for (const iter of iters) {
        if (iter.run_id) {
          await sql`DELETE FROM run_snapshots WHERE id = ${iter.run_id}`;
        }
      }
      await sql`DELETE FROM iterations WHERE project_id = ${projectId}`;
      await sql`DELETE FROM projects WHERE id = ${projectId}`;
    } catch (err) {
      console.error("Failed to delete project from DB:", err.message);
      return false;
    }
  }

  projects.delete(projectId);
  return true;
}

async function getEnvVars(projectId) {
  if (!sql) return [];
  try {
    const rows = await sql`SELECT key, value, created_at FROM project_env_vars WHERE project_id = ${projectId} ORDER BY key ASC`;
    return rows.map((r) => ({ key: r.key, value: r.value, createdAt: Number(r.created_at) }));
  } catch (err) {
    console.error("Failed to get env vars:", err.message);
    return [];
  }
}

async function setEnvVar(projectId, key, value) {
  if (!sql) return false;
  const now = Date.now();
  try {
    await sql`INSERT INTO project_env_vars (project_id, key, value, created_at)
      VALUES (${projectId}, ${key}, ${value}, ${now})
      ON CONFLICT (project_id, key) DO UPDATE SET value = ${value}, created_at = ${now}`;
    return true;
  } catch (err) {
    console.error("Failed to set env var:", err.message);
    return false;
  }
}

async function deleteEnvVar(projectId, key) {
  if (!sql) return false;
  try {
    await sql`DELETE FROM project_env_vars WHERE project_id = ${projectId} AND key = ${key}`;
    return true;
  } catch (err) {
    console.error("Failed to delete env var:", err.message);
    return false;
  }
}

async function getEnvVarsAsObject(projectId) {
  const vars = await getEnvVars(projectId);
  const obj = {};
  for (const v of vars) {
    obj[v.key] = v.value;
  }
  return obj;
}

function getAllProjectsSync() {
  return Array.from(projects.values()).sort((a, b) => b.updatedAt - a.updatedAt);
}

async function deleteIteration(projectId, runId) {
  await loadFromDb();
  const project = projects.get(projectId);
  if (!project) return { ok: false, error: 'Project not found' };

  const iterIndex = project.iterations.findIndex((i) => i.runId === runId);
  if (iterIndex === -1) return { ok: false, error: 'Iteration not found' };

  if (sql) {
    try {
      await sql`DELETE FROM run_snapshots WHERE id = ${runId}`;
      await sql`DELETE FROM iterations WHERE project_id = ${projectId} AND run_id = ${runId}`;
    } catch (err) {
      console.error('Failed to delete iteration from DB:', err.message);
      return { ok: false, error: err.message };
    }
  }

  // Remove from in-memory iterations array
  project.iterations.splice(iterIndex, 1);

  // If this was the currentRunId, roll back to the previous iteration
  if (project.currentRunId === runId) {
    const prev = project.iterations[project.iterations.length - 1];
    project.currentRunId = prev ? prev.runId : null;
    if (sql) {
      try {
        await sql`UPDATE projects SET current_run_id = ${project.currentRunId} WHERE id = ${projectId}`;
      } catch (err) {
        console.error('Failed to update currentRunId after iteration delete:', err.message);
      }
    }
  }

  return { ok: true, currentRunId: project.currentRunId };
}

async function restoreIteration(projectId, runId) {
  await loadFromDb();
  const project = projects.get(projectId);
  if (!project) return { ok: false, error: 'Project not found' };

  const iter = project.iterations.find(i => i.runId === runId);
  if (!iter) return { ok: false, error: 'Iteration not found' };

  // Load snapshot — fail fast before touching anything if missing
  let snapshot = null;
  if (sql) {
    try {
      const rows = await sql`SELECT data FROM run_snapshots WHERE id = ${runId}`;
      if (rows.length > 0) snapshot = rows[0].data;
    } catch (err) {
      return { ok: false, error: 'Failed to load snapshot: ' + err.message };
    }
  }
  if (!snapshot) return { ok: false, error: 'No snapshot saved for this iteration — cannot restore' };

  const builderStage = snapshot.stages && snapshot.stages.builder && snapshot.stages.builder.output;
  const files = builderStage && builderStage.files;
  if (!files || files.length === 0) return { ok: false, error: 'Snapshot contains no files' };

  const installCommand = builderStage.installCommand;
  const startCommand = builderStage.startCommand || 'node server.js';
  const port = builderStage.port || 4000;

  const workspace = require('../workspace/manager');
  const runner = require('../pipeline/runner');
  const settingsManager = require('../settings/manager');

  let globalDefaults = {};
  let globalSecrets = {};
  let projectEnv = {};
  try {
    const defaultEnvSetting = await settingsManager.getSetting('default_env_vars');
    if (defaultEnvSetting && defaultEnvSetting.vars && Array.isArray(defaultEnvSetting.vars)) {
      for (const v of defaultEnvSetting.vars) {
        if (v.key) globalDefaults[v.key] = v.value || '';
      }
    }
    globalSecrets = await settingsManager.getSecretsAsObject();
  } catch {}
  try { projectEnv = await getEnvVarsAsObject(projectId); } catch {}
  const customEnv = { ...globalDefaults, ...globalSecrets, ...projectEnv };

  try {
    // Stop only this project's current app — don't kill other projects' workspaces
    if (project.currentRunId) {
      try { await workspace.stopApp(project.currentRunId); } catch {}
    }
    workspace.createWorkspace(runId);
    workspace.writeFiles(runId, files);
    if (installCommand) {
      const installResult = await workspace.installDeps(runId, installCommand, customEnv);
      if (!installResult.success) return { ok: false, error: 'Install failed: ' + installResult.error };
    }
    const startResult = await workspace.startApp(runId, startCommand, port, customEnv);
    if (!startResult.success) return { ok: false, error: 'Start failed: ' + startResult.error };

    // Register run in memory so the UI can poll its status
    const restoredRun = await runner.loadAndRegisterRun(runId);
    if (restoredRun) {
      const wsStatus = workspace.getWorkspaceStatus(runId);
      if (wsStatus) restoredRun.workspace = wsStatus;
    }
  } catch (err) {
    return { ok: false, error: 'Restore failed: ' + err.message };
  }

  // Update project currentRunId
  project.currentRunId = runId;
  if (sql) {
    try {
      await sql`UPDATE projects SET current_run_id = ${runId} WHERE id = ${projectId}`;
    } catch (err) {
      console.error('Failed to persist restored currentRunId:', err.message);
    }
  }

  return { ok: true, currentRunId: runId };
}

module.exports = {
  createProject,
  addIteration,
  captureCurrentFiles,
  updateProjectStatus,
  renameProject,
  deleteProject,
  deleteIteration,
  restoreIteration,
  getProject,
  getAllProjects,
  getAllProjectsSync,
  stopProject,
  getEnvVars,
  setEnvVar,
  deleteEnvVar,
  getEnvVarsAsObject,
};

