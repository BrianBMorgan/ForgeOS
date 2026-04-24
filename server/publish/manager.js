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
  await sql`
    ALTER TABLE published_apps
      ADD COLUMN IF NOT EXISTS custom_domain TEXT
  `.catch(() => {});
  await sql`
    ALTER TABLE published_apps
      ADD COLUMN IF NOT EXISTS custom_domain_id TEXT
  `.catch(() => {});
  await sql`
    ALTER TABLE published_apps
      ADD COLUMN IF NOT EXISTS custom_domain_status TEXT
  `.catch(() => {});
  await sql`
    ALTER TABLE published_apps
      ADD COLUMN IF NOT EXISTS custom_domain_arecord TEXT
  `.catch(() => {});
  await sql`
    ALTER TABLE published_apps
      ADD COLUMN IF NOT EXISTS custom_domain_cname TEXT
  `.catch(() => {});
}

async function saveToDb(app) {
  const sql = await getDb();
  if (!sql) return;
  const now = Date.now();
  await sql`
    INSERT INTO published_apps
      (project_id, slug, port, status, start_command, install_command,
       build_command, published_at, updated_at, render_service_id, render_url,
       custom_domain, custom_domain_id, custom_domain_status, custom_domain_arecord, custom_domain_cname)
    VALUES
      (${app.projectId}, ${app.slug}, ${app.port}, ${app.status},
       ${app.startCommand}, ${app.installCommand}, ${app.buildCommand ?? null},
       ${app.publishedAt}, ${now}, ${app.renderServiceId ?? null}, ${app.renderUrl ?? null},
       ${app.customDomain ?? null}, ${app.customDomainId ?? null}, ${app.customDomainStatus ?? null},
       ${app.customDomainARecord ?? null}, ${app.customDomainCname ?? null})
    ON CONFLICT (project_id) DO UPDATE SET
      slug              = ${app.slug},
      port              = ${app.port},
      status            = ${app.status},
      start_command     = ${app.startCommand},
      install_command   = ${app.installCommand},
      build_command     = ${app.buildCommand ?? null},
      render_service_id = ${app.renderServiceId ?? null},
      render_url        = ${app.renderUrl ?? null},
      custom_domain     = ${app.customDomain ?? null},
      custom_domain_id  = ${app.customDomainId ?? null},
      custom_domain_status = ${app.customDomainStatus ?? null},
      custom_domain_arecord = ${app.customDomainARecord ?? null},
      custom_domain_cname = ${app.customDomainCname ?? null},
      updated_at        = ${now}
  `;
}

// ---------------------------------------------------------------------------
// Slug generation
// ---------------------------------------------------------------------------

function generateSlug(name) {
  // Skip filler words — keep only meaningful words, max 3, max 30 chars total
  const FILLER = new Set(["build","make","create","a","an","the","for","with","and","or","of","to","in","on","at","by"]);
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(w => w.length > 1 && !FILLER.has(w))
    .slice(0, 3);
  const slug = (words.length > 0 ? words : [name.toLowerCase().replace(/[^a-z0-9]/g, "").substring(0, 10)])
    .join("-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 30);
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
  console.log(`[publish] _doPublish start — projectId=${projectId}`);
  const projectManager = require("../projects/manager");
  const project = await projectManager.getProject(projectId);
  if (!project) throw new Error("Project not found");

  // v2: branch already exists — Claude pushed files to apps/<slug> directly.
  // No workspace. No currentRunId. Just resolve the slug and wire up Render.

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

  const startCommand = "npm start";
  const installCommand = "npm install";
  const buildCommand = null;

  const mergedEnv = await getMergedEnv(projectId);

// Ensure Global Secrets are included
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
        repoPath: "BrianBMorgan/ForgeOS",
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
          await renderApi.updateServiceBranch(renderServiceId, `apps/${slug}`);
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

  // ---- Tag commit for version history (branch stays alive — Render deploys from it) ----
  try {
    const { tagCommit } = require("./github");
    const tag = `apps/${slug}-v${Date.now()}`;
    await tagCommit("BrianBMorgan/ForgeOS", tag, null);
    console.log(`[publish] Tagged ${tag}`);
  } catch (err) {
    console.warn(`[publish] Could not tag branch apps/${slug}:`, err.message);
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

async function renameSlug(projectId, newSlug) {
  // Validate slug format
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(newSlug)) {
    throw new Error("Slug must be lowercase letters, numbers, and hyphens only");
  }

  const sql = await getDb();

  // Check uniqueness
  if (sql) {
    const [conflict] = await sql`
      SELECT project_id FROM published_apps
      WHERE slug = ${newSlug} AND project_id != ${projectId}
    `;
    if (conflict) throw new Error(`Slug "${newSlug}" is already in use`);
  }

  const app = publishedApps.get(projectId);
  const oldSlug = app?.slug;
  const oldServiceId = app?.renderServiceId;

  // If already published on Render, create new service and delete old
  if (oldServiceId) {
    const renderApi = require("./render-api");
    const settingsManager = require("../settings/manager");
    const githubSettings = await settingsManager.getSetting("github");
    const mergedEnv = await getMergedEnv(projectId);

    // Copy files from old branch to new branch via GitHub API (V2: no local workspaces)
    const { copyBranch } = require("./github");
    const renameBranchResult = await copyBranch(githubSettings.repo, `apps/${oldSlug}`, `apps/${newSlug}`);

    // Create new Render service
    const result = await renderApi.createService({
      slug: newSlug,
      repoPath: githubSettings.repo,
      branch: `apps/${newSlug}`,
      envVars: mergedEnv,
    });

    // Tag commit for version history (branch stays alive — Render deploys from it)
    try {
      const { tagCommit } = require("./github");
      const tag = `apps/${newSlug}-v${Date.now()}`;
      await tagCommit(githubSettings.repo, tag, renameBranchResult.commitSha);
      console.log(`[publish] Tagged ${tag}`);
    } catch (err) {
      console.warn(`[publish] Could not tag branch apps/${newSlug}:`, err.message);
    }

    // Delete old Render service
    try {
      await renderApi.deleteService(oldServiceId);
    } catch (err) {
      console.warn(`[publish] Could not delete old Render service ${oldServiceId}: ${err.message}`);
    }

    // Update in-memory state
    if (app) {
      app.slug = newSlug;
      app.renderServiceId = result.serviceId;
      app.renderUrl = result.serviceUrl;
      app.status = "deploying";
    }

    // Update DB
    if (sql) {
      await sql`
        UPDATE published_apps SET
          slug = ${newSlug},
          render_service_id = ${result.serviceId},
          render_url = ${result.serviceUrl},
          status = 'deploying'
        WHERE project_id = ${projectId}
      `;
    }

    console.log(`[publish] Renamed ${oldSlug} → ${newSlug}, new Render service: ${result.serviceUrl}`);
    return { slug: newSlug, renderUrl: result.serviceUrl, renderServiceId: result.serviceId };
  }

  // Not yet published — just update slug in DB
  if (sql) {
    await sql`UPDATE published_apps SET slug = ${newSlug} WHERE project_id = ${projectId}`;
  }
  if (app) app.slug = newSlug;

  return { slug: newSlug };
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
    customDomain: row.custom_domain || null,
    customDomainId: row.custom_domain_id || null,
    customDomainStatus: row.custom_domain_status || null,
    customDomainARecord: row.custom_domain_arecord || null,
    customDomainCname: row.custom_domain_cname || null,
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
    customDomain: app.customDomain || null,
    customDomainId: app.customDomainId || null,
    customDomainStatus: app.customDomainStatus || null,
    customDomainARecord: app.customDomainARecord || null,
    customDomainCname: app.customDomainCname || null,
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

async function setCustomDomain(projectId, domain) {
  const app = publishedApps.get(projectId);
  if (!app) throw new Error("App not published");
  if (!app.renderServiceId) throw new Error("No Render service found for this app");

  const renderApi = require("./render-api");

  // Remove existing custom domain if present
  if (app.customDomainId) {
    try {
      await renderApi.removeCustomDomain(app.renderServiceId, app.customDomainId);
    } catch (err) {
      console.warn(`[publish] Could not remove old custom domain: ${err.message}`);
    }
  }

  const result = await renderApi.addCustomDomain(app.renderServiceId, domain);

  app.customDomain = domain;
  app.customDomainId = result.id;
  app.customDomainStatus = result.status || "pending";
  app.customDomainARecord = result.aRecordTarget || null;
  app.customDomainCname = result.cnameTarget || null;

  const sql = await getDb();
  if (sql) {
    await sql`
      UPDATE published_apps SET
        custom_domain         = ${domain},
        custom_domain_id      = ${result.id},
        custom_domain_status  = ${app.customDomainStatus},
        custom_domain_arecord = ${app.customDomainARecord},
        custom_domain_cname   = ${app.customDomainCname}
      WHERE project_id = ${projectId}
    `;
  }

  return {
    domain,
    domainId: result.id,
    // Apex: use A record IP. Subdomain: use CNAME target.
    aRecord: result.aRecordTarget || null,
    cnameTarget: result.cnameTarget || null,
    status: app.customDomainStatus,
  };
}

async function deleteCustomDomain(projectId) {
  const app = publishedApps.get(projectId);
  if (!app) throw new Error("App not published");

  if (app.customDomainId && app.renderServiceId) {
    const renderApi = require("./render-api");
    try {
      await renderApi.removeCustomDomain(app.renderServiceId, app.customDomainId);
    } catch (err) {
      console.warn(`[publish] Could not remove custom domain from Render: ${err.message}`);
    }
  }

  app.customDomain = null;
  app.customDomainId = null;
  app.customDomainStatus = null;

  const sql = await getDb();
  if (sql) {
    await sql`
      UPDATE published_apps SET
        custom_domain        = NULL,
        custom_domain_id     = NULL,
        custom_domain_status = NULL
      WHERE project_id = ${projectId}
    `;
  }

  return { removed: true };
}

// ---------------------------------------------------------------------------
// Version history & rollback
// ---------------------------------------------------------------------------


async function updateAppStatus(projectId, status) {
  const { neon } = require("@neondatabase/serverless");
  const sql = neon(process.env.NEON_DATABASE_URL);
  const now = Date.now();
  if (status === "running") {
    await sql`UPDATE published_apps SET status = ${status}, published_at = ${now} WHERE project_id = ${projectId}`;
  } else {
    await sql`UPDATE published_apps SET status = ${status} WHERE project_id = ${projectId}`;
  }
  // Update in-memory cache too
  const cached = publishedApps.get(projectId);
  if (cached) {
    cached.status = status;
    if (status === "running") cached.publishedAt = now;
  }
}

// ---------------------------------------------------------------------------
// RAP-bound projects: persist an external URL in the custom_domain column
// without touching Render. The PublishTab's "Custom Domain" input writes
// here, and RenderTab reads from here for the iframe src.
// ---------------------------------------------------------------------------

async function setExternalUrl(projectId, url) {
  const { neon } = require("@neondatabase/serverless");
  const sql = neon(process.env.NEON_DATABASE_URL);
  const now = Date.now();
  const normalized = url ? String(url).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "") : null;

  // Upsert. For a RAP project there's no Render service, so we pass stub values
  // that are safe to ignore downstream. status='external' keeps it out of the
  // deploy status UI paths.
  await sql`
    INSERT INTO published_apps
      (project_id, slug, port, status, start_command, install_command, build_command,
       published_at, updated_at, render_service_id, render_url, custom_domain,
       custom_domain_id, custom_domain_status, custom_domain_arecord, custom_domain_cname)
    VALUES
      (${projectId}, ${"external-" + projectId}, ${0}, ${"external"}, ${""}, ${""}, ${null},
       ${now}, ${now}, ${null}, ${null}, ${normalized},
       ${null}, ${normalized ? "external" : null}, ${null}, ${null})
    ON CONFLICT (project_id) DO UPDATE SET
      custom_domain        = ${normalized},
      custom_domain_status = ${normalized ? "external" : null},
      updated_at           = ${now}
  `;

  // Update in-memory cache so getPublishedApp reflects the change immediately.
  const cached = publishedApps.get(projectId);
  if (cached) {
    cached.customDomain = normalized;
    cached.customDomainStatus = normalized ? "external" : null;
  } else {
    publishedApps.set(projectId, {
      projectId,
      slug: "external-" + projectId,
      status: "external",
      customDomain: normalized,
      customDomainStatus: normalized ? "external" : null,
      publishedAt: now,
    });
  }

  return { ok: true, domain: normalized };
}

module.exports = {
  ensureSchema,
  publishProject,
  unpublishProject,
  renameSlug,
  setCustomDomain,
  deleteCustomDomain,
  setExternalUrl,
  getPublishedApp,
  getPublishedAppBySlug,
  listPublishedApps,
  restorePublishedApps,
  generateSlug,
  updateAppStatus,
};