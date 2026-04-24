"use strict";

const { v4: uuidv4 } = require("uuid");
const { neon } = require("@neondatabase/serverless");

const dbUrl = process.env.NEON_DATABASE_URL;
if (!dbUrl) {
  console.error("NEON_DATABASE_URL is not set — project persistence is disabled");
}
const sql = dbUrl ? neon(dbUrl) : null;

const projects = new Map();
let loadPromise = null;

// ── Schema ────────────────────────────────────────────────────────────────────
// v2: no iterations table, no run_snapshots table, no current_run_id column.
// Git history IS the iteration model. Render IS the runtime.

async function ensureSchema() {
  if (!sql) return;
  try {
    await sql`CREATE TABLE IF NOT EXISTS projects (
      id VARCHAR(8) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      project_history TEXT
    )`;

    await sql`CREATE TABLE IF NOT EXISTS project_env_vars (
      id SERIAL PRIMARY KEY,
      project_id VARCHAR(8) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      key VARCHAR(255) NOT NULL,
      value TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      UNIQUE(project_id, key)
    )`;

    // v2 migration: drop dead v1 tables if they exist
    // Safe — CASCADE handles any remaining FK refs
    await sql`DROP TABLE IF EXISTS run_snapshots CASCADE`;
    await sql`DROP TABLE IF EXISTS iterations CASCADE`;

    // v2 migration: drop dead columns from projects if they exist
    await sql`ALTER TABLE projects DROP COLUMN IF EXISTS current_run_id`;

    // Repo Access Protocol binding: project can be bound to a repo_access skill
    // so Files/Commits/Chat target that external repo instead of apps/<slug>.
    await sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS repo_access_skill_id INTEGER`;

    console.log("[projects] Schema v2 ready");
  } catch (err) {
    console.error("[projects] Schema error:", err.message);
  }
}

// ── Load from DB ──────────────────────────────────────────────────────────────

async function loadFromDb() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    if (!sql) return;
    try {
      await ensureSchema();
      const rows = await sql`SELECT * FROM projects ORDER BY updated_at DESC`;
      for (const row of rows) {
        projects.set(row.id, {
          id: row.id,
          name: row.name,
          status: row.status,
          createdAt: Number(row.created_at),
          updatedAt: Number(row.updated_at),
          repoAccessSkillId: row.repo_access_skill_id ? Number(row.repo_access_skill_id) : null,
        });
      }
      console.log(`[projects] Loaded ${rows.length} projects`);
    } catch (err) {
      console.error("[projects] Failed to load from DB:", err.message);
      loadPromise = null;
    }
  })();
  return loadPromise;
}

// ── Name generation ───────────────────────────────────────────────────────────

function generateProjectName(prompt) {
  const cleaned = prompt.replace(/[^a-zA-Z0-9\s]/g, "").trim();
  const words = cleaned.split(/\s+/).slice(0, 5);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

async function createProject(prompt, opts = {}) {
  await loadFromDb();
  const id = uuidv4().slice(0, 8);
  const name = generateProjectName(prompt);
  const now = Date.now();
  const repoAccessSkillId = opts.repoAccessSkillId ? Number(opts.repoAccessSkillId) : null;
  const project = { id, name, status: "active", createdAt: now, updatedAt: now, repoAccessSkillId };

  if (sql) {
    await sql`INSERT INTO projects (id, name, status, created_at, updated_at, repo_access_skill_id)
      VALUES (${id}, ${name}, ${"active"}, ${now}, ${now}, ${repoAccessSkillId})`;
  }

  projects.set(id, project);
  return project;
}

async function setRepoAccessSkill(projectId, skillId) {
  await loadFromDb();
  const project = projects.get(projectId);
  if (!project) return null;
  const normalized = skillId === null || skillId === undefined || skillId === "" ? null : Number(skillId);
  project.repoAccessSkillId = normalized;
  project.updatedAt = Date.now();
  if (sql) {
    try {
      await sql`UPDATE projects SET repo_access_skill_id = ${normalized}, updated_at = ${project.updatedAt} WHERE id = ${projectId}`;
    } catch (err) {
      console.error("[projects] Failed to set repo_access_skill_id:", err.message);
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

function getAllProjectsSync() {
  return Array.from(projects.values()).sort((a, b) => b.updatedAt - a.updatedAt);
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
      console.error("[projects] Failed to rename:", err.message);
    }
  }
  return project;
}

async function updateProjectStatus(projectId, status) {
  await loadFromDb();
  const project = projects.get(projectId);
  if (!project) return;
  project.status = status;
  project.updatedAt = Date.now();
  if (sql) {
    try {
      await sql`UPDATE projects SET status = ${status}, updated_at = ${project.updatedAt} WHERE id = ${projectId}`;
    } catch (err) {
      console.error("[projects] Failed to update status:", err.message);
    }
  }
}

async function deleteProject(projectId) {
  await loadFromDb();
  const project = projects.get(projectId);
  if (!project) return false;

  if (sql) {
    try {
      // project_env_vars cascade-deletes via FK
      // forge_conversations are separate — brain handles them
      await sql`DELETE FROM projects WHERE id = ${projectId}`;
    } catch (err) {
      console.error("[projects] Failed to delete from DB:", err.message);
      return false;
    }
  }

  projects.delete(projectId);
  return true;
}

// ── Env vars ──────────────────────────────────────────────────────────────────

async function getEnvVars(projectId) {
  if (!sql) return [];
  try {
    const rows = await sql`SELECT key, value, created_at FROM project_env_vars
      WHERE project_id = ${projectId} ORDER BY key ASC`;
    return rows.map((r) => ({ key: r.key, value: r.value, createdAt: Number(r.created_at) }));
  } catch (err) {
    console.error("[projects] Failed to get env vars:", err.message);
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
    console.error("[projects] Failed to set env var:", err.message);
    return false;
  }
}

async function deleteEnvVar(projectId, key) {
  if (!sql) return false;
  try {
    await sql`DELETE FROM project_env_vars WHERE project_id = ${projectId} AND key = ${key}`;
    return true;
  } catch (err) {
    console.error("[projects] Failed to delete env var:", err.message);
    return false;
  }
}

async function getEnvVarsAsObject(projectId) {
  const vars = await getEnvVars(projectId);
  const obj = {};
  for (const v of vars) obj[v.key] = v.value;
  return obj;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  createProject,
  getProject,
  getAllProjects,
  getAllProjectsSync,
  renameProject,
  updateProjectStatus,
  deleteProject,
  setRepoAccessSkill,
  getEnvVars,
  setEnvVar,
  deleteEnvVar,
  getEnvVarsAsObject,
};
