"use strict";

const fs = require("fs");
const path = require("path");
const GITHUB_PUSH_TIMEOUT_MS = 30_000;
const PUBLISHED_DIR = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "published") : path.join(__dirname, "..", "..", "published");

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

/** @type {Map<string, AppState>} */
const publishedApps = new Map();

let publishLock = false;

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

let db = null;

async function getDb() {
  if (db) return db;
  if (!process.env.NEON_DATABASE_URL) return null;
  const { neon } = require("@neondatabase/serverless");
  db = neon(process.env.NEON_DATABASE_URL);
  return db;
}

async function ensureSchema() {
  const sql = await getDb();
  if (!sql) return;
  await sql`
    CREATE TABLE IF NOT EXISTS published_apps (
      id           SERIAL PRIMARY KEY,
      project_id   VARCHAR(8)   NOT NULL UNIQUE,
      slug         VARCHAR(255) NOT NULL UNIQUE,
      port         INT,
      status       VARCHAR(20)  DEFAULT 'stopped',
      start_command  TEXT,
      install_command TEXT,
      build_command  TEXT,
      published_at BIGINT,
      updated_at   BIGINT
    )
  `;
  // One-time forward migration: add build_command if this table predates it.
  // Safe to run on every startup — IF NOT EXISTS is a no-op once applied.
  await sql`
    ALTER TABLE published_apps
      ADD COLUMN IF NOT EXISTS build_command TEXT
  `.catch(() => {});
}

async function saveToDb(app) {
  const sql = await getDb();
  if (!sql) return;
  const now = Date.now();
  await sql`
    INSERT INTO published_apps
      (project_id, slug, port, status, start_command, install_command,
       build_command, published_at, updated_at, render_service_id, render_url)
    VALUES
      (${app.projectId}, ${app.slug}, ${app.port}, ${app.status},
       ${app.startCommand}, ${app.installCommand}, ${app.buildCommand ?? null},
       ${app.publishedAt}, ${now}, ${app.renderServiceId ?? null}, ${app.renderUrl ?? null})
    ON CONFLICT (project_id) DO UPDATE SET
      slug              = ${app.slug},
      port              = ${app.port},
      status            = ${app.status},
      start_command     = ${app.startCommand},
      install_command   = ${app.installCommand},
      build_command     = ${app.buildCommand ?? null},
      render_service_id = ${app.renderServiceId ?? null},
      render_url        = ${app.renderUrl ?? null},
      updated_at        = ${now}
  `;
}

// ---------------------------------------------------------------------------
// Slug generation
// ---------------------------------------------------------------------------

function generateSlug(name) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 60);
  return slug || "app";
}

// ---------------------------------------------------------------------------
// Environment variable helpers
// ---------------------------------------------------------------------------

// Keys always sourced from the platform — project env cannot override these.

/**
 * Build the full env for a published app process.
 *
 * Merge order (last wins):
 *   1. Platform-controlled keys (PORT, DATABASE_URL, …)
 *   2. Global default env vars from settings
 *   3. Project-specific env vars
 *
 * process.env is NOT spread wholesale — only specific platform keys are
 * forwarded so that ForgeOS host secrets do not bleed into published apps
 * and so that project-level vars genuinely take precedence.
 */
async function getMergedEnv(projectId) {
  let globalDefaults = {};
  let projectEnv = {};

  try {
    const settingsManager = require("../settings/manager");
    const defaultEnvSetting = await settingsManager.getSetting("default_env_vars");
    if (Array.isArray(defaultEnvSetting?.vars)) {
      for (const v of defaultEnvSetting.vars) {
        if (v.key) globalDefaults[v.key] = v.value || "";
      }
    }
    const secrets = await settingsManager.getSecretsAsObject();
    if (secrets) globalDefaults = { ...globalDefaults, ...secrets };
  } catch {}

  if (projectId) {
    try {
      const projectManager = require("../projects/manager");
      projectEnv = await projectManager.getEnvVarsAsObject(projectId);
    } catch {}
  }

  // Project vars override global defaults
  return { ...globalDefaults, ...projectEnv };
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

async function publishProject(projectId) {
  if (publishLock) throw new Error("Another publish is in progress. Please wait.");
  publishLock = true;
  try {
    return await _doPublish(projectId);
  } finally {
    publishLock = false;
  }
}

async function _doPublish(projectId) {
  const projectManager = require("../projects/manager");
  const project = await projectManager.getProject(projectId);
  if (!project) throw new Error("Project not found");

  const { currentRunId } = project;
  if (!currentRunId) throw new Error("No build to publish — run a build first");

  const workspaceDir = path.join(process.env.DATA_DIR || path.join(__dirname, "..", ".."), "workspaces", currentRunId);
  if (!fs.existsSync(workspaceDir)) throw new Error("Workspace files not found");

  // ---- Slug resolution ----
  const sql = await getDb();
  const baseSlug = generateSlug(project.name);
  let slug = baseSlug;

  if (sql) {
    const [existing] = await sql`
      SELECT slug, render_service_id, render_url FROM published_apps WHERE project_id = ${projectId}
    `;
    if (existing) {
      slug = existing.slug;
    } else {
      const [conflict] = await sql`
        SELECT slug FROM published_apps
        WHERE slug = ${baseSlug} AND project_id != ${projectId}
      `;
      if (conflict) slug = baseSlug + "-" + projectId;
    }
  }

  // ---- Resolve commands ----
  let startCommand = "npm start";
  let installCommand = "npm install";
  let buildCommand = null;

  try {
    const { getRun } = require("../pipeline/runner");
    const run = await getRun(currentRunId);
    const out = run?.stages?.builder?.output || run?.stages?.executor?.output;
    if (out?.startCommand)   startCommand   = out.startCommand;
    if (out?.installCommand) installCommand = out.installCommand;
    if (out?.buildCommand)   buildCommand   = out.buildCommand;
  } catch {}

  try {
    const pkgPath = path.join(workspaceDir, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (!buildCommand && pkg.scripts?.build) buildCommand = "npm run build";
      if (pkg.scripts?.start) startCommand = "npm start";
    }
  } catch {}

  // ---- Get GitHub settings ----
  const settingsManager = require("../settings/manager");
  const githubSettings = await settingsManager.getSetting("github");
  if (!githubSettings?.repo) throw new Error("GitHub repo not configured in Settings — required for Render deployment");

  // ---- Push app files to dedicated GitHub branch ----
  const { pushToAppBranch } = require("./github");
  let branchResult;
  try {
    branchResult = await pushToAppBranch(githubSettings.repo, slug, workspaceDir);
  } catch (err) {
    throw new Error(`GitHub push failed: ${err.message}`);
  }

  const mergedEnv = await getMergedEnv(projectId);

// Ensure Global Secrets are included (getMergedEnv may miss them if settings DB init fails)
try {
  const settingsManager = require("../settings/manager");
  const secrets = await settingsManager.getSecretsAsObject();
  if (secrets && Object.keys(secrets).length > 0) {
    Object.assign(mergedEnv, secrets);
  }
} catch (err) {
  console.warn("[publish] Could not load Global Secrets for env:", err.message);
}

  // ---- Create or redeploy Render service ----
  const renderApi = require("./render-api");
  let renderServiceId = null;
  let renderUrl = null;

  if (sql) {
    const [existing] = await sql`SELECT render_service_id, render_url FROM published_apps WHERE project_id = ${projectId}`;
    if (existing?.render_service_id) {
      renderServiceId = existing.render_service_id;
      renderUrl = existing.render_url;
    }
  }

  if (renderServiceId) {
    try {
      await renderApi.updateServiceEnv(renderServiceId, mergedEnv);
      await renderApi.redeployService(renderServiceId);
    } catch (err) {
      throw new Error(`Render redeploy failed: ${err.message}`);
    }
  } else {
    try {
      const result = await renderApi.createService({
        slug,
        repoPath: githubSettings.repo,
        branch: `apps/${slug}`,
        envVars: mergedEnv,
        startCommand,
        buildCommand,
      });
      renderServiceId = result.serviceId;
      renderUrl = result.serviceUrl;
    } catch (err) {
      // If service already exists, find it and redeploy instead
      if (err.message.includes("already in use")) {
        const services = await renderApi.listServices();
        const existing = services.find(s => s.slug === slug);
        if (existing) {
          renderServiceId = existing.serviceId;
          renderUrl = existing.url;
          await renderApi.updateServiceEnv(renderServiceId, mergedEnv);
          await renderApi.redeployService(renderServiceId);
        } else {
          throw new Error(`Render service creation failed: ${err.message}`);
        }
      } else {
        throw new Error(`Render service creation failed: ${err.message}`);
      }
    }
  }

  // ---- Save to DB ----
  const app = {
    projectId,
    slug,
    port: null,
    status: "deploying",
    startCommand,
    installCommand,
    buildCommand,
    publishedAt: Date.now(),
    renderServiceId,
    renderUrl,
  };
  publishedApps.set(projectId, app);
  await saveToDb(app);

  console.log(`[publish] Published ${project.name} to Render: ${renderUrl}`);
  return { slug, port: null, status: "deploying", renderUrl, renderServiceId };
}

// ---------------------------------------------------------------------------
// Unpublish
// ---------------------------------------------------------------------------

async function unpublishProject(projectId) {
  // Await full process teardown before touching the filesystem
  publishedApps.delete(projectId);

  const publishDir = path.join(PUBLISHED_DIR, projectId);
  if (fs.existsSync(publishDir)) {
    fs.rmSync(publishDir, { recursive: true, force: true });
  }

  const sql = await getDb();
  if (sql) {
    await sql`DELETE FROM published_apps WHERE project_id = ${projectId}`;
  }

  console.log(`[publish] Unpublished project ${projectId}`);
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

async function restorePublishedApps() {
  const sql = await getDb();
  if (!sql) return;
  await ensureSchema();
  const rows = await sql`SELECT * FROM published_apps`;
  for (const row of rows) {
    await _restoreOne(row).catch((err) => {
      console.error(`[publish] Failed to restore ${row.slug}: ${err.message}`);
    });
  }
}

async function _restoreOne(row) {
  // Apps are now deployed as Render services — just restore the in-memory record
  if (!row.render_service_id) {
    // Old-style app with no Render service — skip
    console.log(`[publish] Skipping restore for ${row.slug} — no Render service`);
    return;
  }
  const app = {
    projectId: row.project_id,
    slug: row.slug,
    port: null,
    status: row.status || "deploying",
    process: null,
    startCommand:   row.start_command   || "npm start",
    installCommand: row.install_command || "npm install",
    buildCommand:   row.build_command   || null,
    publishedAt: Number(row.published_at),
    renderServiceId: row.render_service_id,
    renderUrl: row.render_url,
    logs: "",
  };
  publishedApps.set(row.project_id, app);
  console.log(`[publish] Restored ${row.slug} → ${row.render_url}`);
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

function getPublishedApp(projectId) {
  const app = publishedApps.get(projectId);
  if (!app) return null;
  return {
    projectId: app.projectId,
    slug: app.slug,
    port: app.port,
    status: app.status,
    publishedAt: app.publishedAt,
    renderUrl: app.renderUrl || null,
    renderServiceId: app.renderServiceId || null,
    logs: app.logs?.slice(-5000) || "",
  };
}

function getPublishedAppBySlug(slug) {
  for (const [, app] of publishedApps) {
    if (app.slug === slug) return app;
  }
  return null;
}

function listPublishedApps() {
  const apps = [];
  for (const [, app] of publishedApps) {
    apps.push({
      projectId: app.projectId,
      slug: app.slug,
      port: app.port,
      status: app.status,
      publishedAt: app.publishedAt,
    });
  }
  return apps;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

async function exportProject(projectId) {
  const projectManager = require("../projects/manager");
  const project = await projectManager.getProject(projectId);
  if (!project) throw new Error("Project not found");

  const { currentRunId } = project;
  if (!currentRunId) throw new Error("No build to export");

  const workspaceDir = path.join(process.env.DATA_DIR || path.join(__dirname, "..", ".."), "workspaces", currentRunId);
  if (!fs.existsSync(workspaceDir)) throw new Error("Workspace files not found");

  const slug = generateSlug(project.name);
  const zipPath = path.join("/tmp", `${slug}-export.zip`);

  try { fs.unlinkSync(zipPath); } catch {}

  // Use execFileSync (not execSync) to avoid shell interpolation of paths.
  // Arguments are passed as an array — no shell metacharacter risk.
  const { execFileSync } = require("child_process");
  execFileSync(
    "zip",
    ["-r", zipPath, ".", "-x", "node_modules/*", ".git/*"],
    { cwd: workspaceDir, timeout: 30_000 }
  );

  return { zipPath, filename: `${slug}.zip` };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  ensureSchema,
  publishProject,
  unpublishProject,
  getPublishedApp,
  getPublishedAppBySlug,
  listPublishedApps,
  restorePublishedApps,
  exportProject,
  generateSlug,
};