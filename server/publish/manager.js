"use strict";

const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");
const net = require("net");

const PUBLISHED_DIR = path.join(__dirname, "..", "..", "published");
const PORT_RANGE_START = 4100;
const PORT_RANGE_END = 4199;
const LOG_MAX_BYTES = 50_000;
const LOG_TAIL_BYTES = 30_000;
const STARTUP_GRACE_MS = 3_000;
const RESTORE_STARTUP_GRACE_MS = 2_000;
const SIGKILL_TIMEOUT_MS = 5_000;
const GITHUB_PUSH_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

/** @type {Map<string, AppState>} */
const publishedApps = new Map();

/**
 * Ports that have been claimed by getNextFreePort() but whose process has not
 * yet bound the socket. Prevents concurrent allocations from returning the
 * same port during restore or rapid publish sequences.
 * @type {Set<number>}
 */
const reservedPorts = new Set();

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
       build_command, published_at, updated_at)
    VALUES
      (${app.projectId}, ${app.slug}, ${app.port}, ${app.status},
       ${app.startCommand}, ${app.installCommand}, ${app.buildCommand ?? null},
       ${app.publishedAt}, ${now})
    ON CONFLICT (project_id) DO UPDATE SET
      slug            = ${app.slug},
      port            = ${app.port},
      status          = ${app.status},
      start_command   = ${app.startCommand},
      install_command = ${app.installCommand},
      build_command   = ${app.buildCommand ?? null},
      updated_at      = ${now}
  `;
}

// ---------------------------------------------------------------------------
// File system helpers
// ---------------------------------------------------------------------------

function ensurePublishedDir() {
  fs.mkdirSync(PUBLISHED_DIR, { recursive: true });
}

function copyDirectory(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    // Skip node_modules AND .git — no reason to publish git history
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function collectJsFiles(dir, files = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(full, files);
    } else if (/\.(js|ts|mjs|cjs)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
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
// Port management
// ---------------------------------------------------------------------------

/**
 * Finds and *reserves* the next free port in the publish range.
 * The reservation is held in `reservedPorts` until the caller releases it
 * via releasePort(). This prevents concurrent calls from racing to the same
 * port before any process has bound the socket.
 */
function getNextFreePort() {
  return new Promise((resolve, reject) => {
    // Ports currently in active use (process running) OR reserved (starting)
    const unavailable = new Set(reservedPorts);
    for (const [, app] of publishedApps) {
      if (app.port && (app.status === "running" || app.status === "starting")) {
        unavailable.add(app.port);
      }
    }

    function tryPort(port) {
      if (port > PORT_RANGE_END) {
        reject(new Error("No free ports available in the publish range (4100–4199)"));
        return;
      }
      if (unavailable.has(port)) {
        tryPort(port + 1);
        return;
      }
      const server = net.createServer();
      server.once("error", () => tryPort(port + 1));
      server.once("listening", () => {
        server.close(() => {
          reservedPorts.add(port); // hold reservation until process binds
          resolve(port);
        });
      });
      server.listen(port, "127.0.0.1");
    }

    tryPort(PORT_RANGE_START);
  });
}

/** Release a port reservation after the process has bound (or failed). */
function releasePort(port) {
  reservedPorts.delete(port);
}

function forceKillPort(port) {
  try { execSync(`fuser -k ${port}/tcp 2>/dev/null || true`); } catch {}
  try { execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`); } catch {}
}

// ---------------------------------------------------------------------------
// Port patching
// ---------------------------------------------------------------------------

function patchHardcodedPort(dir) {
  for (const filePath of collectJsFiles(dir)) {
    let content;
    try { content = fs.readFileSync(filePath, "utf8"); } catch { continue; }
    // Skip files that already read from env
    if (/process\.env\.PORT/.test(content)) continue;

    let patched = content;
    patched = patched.replace(
      /(const|let|var)\s+(PORT|port)\s*=\s*(\d{3,5})\s*;/g,
      "$1 $2 = process.env.PORT || $3;"
    );
    patched = patched.replace(
      /\.listen\(\s*(\d{3,5})\s*,/g,
      ".listen(process.env.PORT || $1,"
    );
    patched = patched.replace(
      /\.listen\(\s*(\d{3,5})\s*\)/g,
      ".listen(process.env.PORT || $1)"
    );
    if (patched !== content) {
      try { fs.writeFileSync(filePath, patched, "utf8"); } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Command helpers
// ---------------------------------------------------------------------------

function resolveStartCommand(dir, startCommand) {
  if (startCommand === "npm start" || startCommand === "npm run start") {
    try {
      const pkgPath = path.join(dir, "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        const script = pkg.scripts?.start;
        if (script && /^node\s+\S+/.test(script)) return script;
      }
    } catch {}
  }
  return startCommand;
}

function validateCommand(cmd) {
  const parts = cmd.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) throw new Error("Empty command");
  return parts;
}

// ---------------------------------------------------------------------------
// Environment variable helpers
// ---------------------------------------------------------------------------

// Keys always sourced from the platform — project env cannot override these.
const RESERVED_ENV_KEYS = new Set([
  "PORT", "DATABASE_URL", "NEON_AUTH_JWKS_URL", "JWT_SECRET",
  "NODE_ENV", "HOME", "PATH", "TERM",
]);

function cleanDatabaseUrl(url) {
  if (!url) return url;
  return url.replace(/\?.*$/, "") + "?sslmode=require";
}

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
function buildProcessEnv(port, mergedCustomEnv) {
  // Strip any reserved keys that snuck into the merged custom env
  const safeCustom = { ...mergedCustomEnv };
  for (const k of RESERVED_ENV_KEYS) delete safeCustom[k];

  return {
    // Minimal host passthrough needed for Node.js to function
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    TERM: process.env.TERM || "xterm",
    // Platform-controlled
    NODE_ENV: "production",
    PORT: String(port),
    ...(process.env.NEON_DATABASE_URL
      ? { DATABASE_URL: cleanDatabaseUrl(process.env.NEON_DATABASE_URL) }
      : {}),
    ...(process.env.NEON_AUTH_JWKS_URL
      ? { NEON_AUTH_JWKS_URL: process.env.NEON_AUTH_JWKS_URL }
      : {}),
    // Project/global custom env — lowest precedence for reserved keys,
    // but this spread comes after so project values win for non-reserved keys
    ...safeCustom,
  };
}

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
// Process lifecycle
// ---------------------------------------------------------------------------

/**
 * Attach stdout/stderr log buffering to a child process.
 * Caps total log size at LOG_MAX_BYTES, keeping the most recent LOG_TAIL_BYTES.
 */
function attachLogs(proc, app) {
  const handler = (d) => {
    app.logs += d.toString();
    if (app.logs.length > LOG_MAX_BYTES) {
      app.logs = app.logs.slice(-LOG_TAIL_BYTES);
    }
  };
  proc.stdout.on("data", handler);
  proc.stderr.on("data", handler);
}

/**
 * Kill a child process gracefully: SIGTERM first, then SIGKILL after
 * SIGKILL_TIMEOUT_MS, then force-kill the port.
 * Returns a Promise that resolves when the process has exited (or was already
 * gone), so callers can await full teardown before touching the filesystem.
 */
function killProcess(proc, port) {
  return new Promise((resolve) => {
    if (!proc || proc.killed) {
      if (port) forceKillPort(port);
      return resolve();
    }

    const cleanup = () => {
      if (port) forceKillPort(port);
      resolve();
    };

    proc.once("close", cleanup);

    try { proc.kill("SIGTERM"); } catch {}

    const forceTimer = setTimeout(() => {
      try { if (!proc.killed) proc.kill("SIGKILL"); } catch {}
    }, SIGKILL_TIMEOUT_MS);

    // Don't let this timer keep the event loop alive
    if (forceTimer.unref) forceTimer.unref();
  });
}

/**
 * Stop a running published app and await full process exit.
 * Safe to call when no process is running.
 */
async function stopPublishedApp(projectId) {
  const app = publishedApps.get(projectId);
  if (!app) return;

  app.status = "stopped";
  const proc = app.process;
  app.process = null;

  await killProcess(proc, app.port);
  if (app.port) releasePort(app.port);
}

// ---------------------------------------------------------------------------
// npm install helper (shared between publish and restore)
// ---------------------------------------------------------------------------

async function runInstall(installCommand, dir, logTarget) {
  const parts = validateCommand(installCommand);
  await new Promise((resolve, reject) => {
    const proc = spawn(parts[0], parts.slice(1), {
      cwd: dir,
      env: { HOME: process.env.HOME, PATH: process.env.PATH, NODE_ENV: "production" },
    });
    let output = "";
    proc.stdout.on("data", (d) => { output += d.toString(); });
    proc.stderr.on("data", (d) => { output += d.toString(); });
    proc.on("close", (code) => {
      if (logTarget) logTarget.logs += output;
      if (code === 0) resolve();
      else reject(new Error(`Install failed with exit code ${code}\n${output.slice(-2000)}`));
    });
    proc.on("error", reject);
  });
}

async function runBuild(buildCommand, dir, logTarget) {
  const parts = validateCommand(buildCommand);
  await new Promise((resolve, reject) => {
    const proc = spawn(parts[0], parts.slice(1), {
      cwd: dir,
      env: { HOME: process.env.HOME, PATH: process.env.PATH, NODE_ENV: "production" },
    });
    let output = "";
    proc.stdout.on("data", (d) => { output += d.toString(); });
    proc.stderr.on("data", (d) => { output += d.toString(); });
    proc.on("close", (code) => {
      if (logTarget) logTarget.logs += output;
      if (code === 0) resolve();
      else reject(new Error(`Build failed with exit code ${code}\n${output.slice(-2000)}`));
    });
    proc.on("error", reject);
  });
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

  const workspaceDir = path.join(__dirname, "..", "..", "workspaces", currentRunId);
  if (!fs.existsSync(workspaceDir)) throw new Error("Workspace files not found");

  // ---- Slug resolution ----
  const sql = await getDb();
  const baseSlug = generateSlug(project.name);
  let slug = baseSlug;

  if (sql) {
    const [existing] = await sql`
      SELECT slug FROM published_apps WHERE project_id = ${projectId}
    `;
    if (existing) {
      slug = existing.slug; // preserve slug across re-publishes
    } else {
      const [conflict] = await sql`
        SELECT slug FROM published_apps
        WHERE slug = ${baseSlug} AND project_id != ${projectId}
      `;
      if (conflict) slug = baseSlug + "-" + projectId;
    }
  }

  // ---- Stop any existing process and await its exit ----
  await stopPublishedApp(projectId);

  // ---- Copy workspace files ----
  ensurePublishedDir();
  const publishDir = path.join(PUBLISHED_DIR, projectId);
  if (fs.existsSync(publishDir)) {
    fs.rmSync(publishDir, { recursive: true, force: true });
  }
  copyDirectory(workspaceDir, publishDir);
  patchHardcodedPort(publishDir);

  // ---- Resolve commands from executor output ----
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

  // Cross-check package.json for build script
  try {
    const pkgPath = path.join(publishDir, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (!buildCommand && pkg.scripts?.build) buildCommand = "npm run build";
    }
  } catch {}

  // ---- Create app state entry ----
  const app = {
    projectId,
    slug,
    dir: publishDir,
    port: null,
    status: "installing",
    process: null,
    startCommand,
    installCommand,
    buildCommand,
    publishedAt: Date.now(),
    logs: "",
  };
  publishedApps.set(projectId, app);

  // ---- Install ----
  try {
    await runInstall(installCommand, publishDir, app);
  } catch (err) {
    app.status = "failed";
    app.logs += `\nInstall failed: ${err.message}`;
    await saveToDb(app).catch(() => {});
    throw err;
  }

  // ---- Optional build step ----
  if (buildCommand) {
    app.status = "building";
    app.logs += `\n--- Build: ${buildCommand} ---\n`;
    try {
      await runBuild(buildCommand, publishDir, app);
    } catch (err) {
      app.status = "failed";
      app.logs += `\nBuild failed: ${err.message}`;
      await saveToDb(app).catch(() => {});
      throw err;
    }
  }

  // ---- Allocate port ----
  let assignedPort;
  try {
    assignedPort = await getNextFreePort();
  } catch (err) {
    app.status = "failed";
    app.logs += `\nPort allocation failed: ${err.message}`;
    await saveToDb(app).catch(() => {});
    throw err;
  }
  app.port = assignedPort;
  app.status = "starting";

  // ---- Spawn ----
  const mergedEnv = await getMergedEnv(projectId);
  const resolvedCmd = resolveStartCommand(publishDir, startCommand);
  const cmdParts = validateCommand(resolvedCmd);
  const processEnv = buildProcessEnv(assignedPort, mergedEnv);

  const proc = spawn(cmdParts[0], cmdParts.slice(1), {
    cwd: publishDir,
    env: processEnv,
  });

  app.process = proc;
  attachLogs(proc, app);

  proc.on("close", (code) => {
    releasePort(assignedPort);
    app.process = null;
    if (app.status !== "stopped") {
      app.status = "failed";
      app.logs += `\nProcess exited with code ${code}`;
      saveToDb(app).catch(() => {});
    }
  });

  proc.on("error", (err) => {
    releasePort(assignedPort);
    app.process = null;
    app.status = "failed";
    app.logs += `\nProcess error: ${err.message}`;
    saveToDb(app).catch(() => {});
  });

  // ---- Startup health check ----
  await new Promise((r) => setTimeout(r, STARTUP_GRACE_MS));

  if (!app.process || app.process.killed) {
    app.status = "failed";
    await saveToDb(app).catch(() => {});
    throw new Error(
      `App failed to stay running after ${STARTUP_GRACE_MS}ms.\n` +
      app.logs.slice(-1000)
    );
  }

  app.status = "running";
  await saveToDb(app);

  // ---- GitHub push (best-effort, non-blocking on publish success) ----
  let github = null;
  let githubError = null;
  try {
    const settingsManager = require("../settings/manager");
    const githubSettings = await settingsManager.getSetting("github");
    if (githubSettings?.repo && githubSettings?.autoPush !== false) {
      app.logs += "\n--- Pushing to GitHub ---\n";
      const { pushProjectToGitHub } = require("./github");

      // Enforce a hard timeout so a hung GitHub push can't block indefinitely
      const pushResult = await Promise.race([
        pushProjectToGitHub(
          githubSettings.repo,
          slug,
          publishDir,
          `[ForgeOS] Publish ${project.name} (${slug})`
        ),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("GitHub push timed out after 30s")),
            GITHUB_PUSH_TIMEOUT_MS
          )
        ),
      ]);

      app.logs += `Pushed ${pushResult.filesCount} files to GitHub\nCommit: ${pushResult.commitUrl}\n`;
      github = pushResult;
      console.log(`[publish] Pushed ${project.name} to GitHub: ${pushResult.commitUrl}`);
    }
  } catch (err) {
    githubError = err.message;
    app.logs += `\nGitHub push failed: ${err.message}\n`;
    console.warn(`[publish] GitHub push failed for ${project.name}: ${err.message}`);
  }

  console.log(`[publish] Published ${project.name} at /apps/${slug} (port ${assignedPort})`);
  return { slug, port: assignedPort, status: app.status, github, githubError };
}

// ---------------------------------------------------------------------------
// Unpublish
// ---------------------------------------------------------------------------

async function unpublishProject(projectId) {
  // Await full process teardown before touching the filesystem
  await stopPublishedApp(projectId);
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
    await _restoreOne(row, sql).catch((err) => {
      console.error(`[publish] Failed to restore ${row.slug}: ${err.message}`);
    });
  }
}

async function _restoreOne(row, sql) {
  const publishDir = path.join(PUBLISHED_DIR, row.project_id);

  // ---- Rebuild files from DB snapshot if directory is missing ----
  if (!fs.existsSync(publishDir)) {
    console.log(`[publish] Published files missing for ${row.slug}, rebuilding from snapshot…`);

    const projectManager = require("../projects/manager");
    const project = await projectManager.getProject(row.project_id);
    if (!project?.currentRunId) {
      console.warn(`[publish] No current run for ${row.slug} — marking failed`);
      await sql`UPDATE published_apps SET status = 'failed' WHERE project_id = ${row.project_id}`;
      return;
    }

    const { getRun } = require("../pipeline/runner");
    const run = await getRun(project.currentRunId);
    const builderOut = run?.stages?.builder?.output;
    const executorOut = run?.stages?.executor?.output;
    const files = builderOut?.files || executorOut?.files;

    if (!Array.isArray(files) || files.length === 0) {
      console.warn(`[publish] No build snapshot for ${row.slug} — marking failed`);
      await sql`UPDATE published_apps SET status = 'failed' WHERE project_id = ${row.project_id}`;
      return;
    }

    fs.mkdirSync(publishDir, { recursive: true });
    for (const file of files) {
      if (!file.path || file.content == null) continue;
      const filePath = path.join(publishDir, file.path);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, file.content);
    }
    console.log(`[publish] Rebuilt ${row.slug} from snapshot (${files.length} files)`);

    // Files were just written — node_modules don't exist. Install now.
    patchHardcodedPort(publishDir);
    const installCommand = row.install_command || "npm install";
    try {
      await runInstall(installCommand, publishDir, null);
      console.log(`[publish] Installed dependencies for ${row.slug}`);
    } catch (err) {
      console.error(`[publish] Dependency install failed for ${row.slug}: ${err.message}`);
      await sql`UPDATE published_apps SET status = 'failed' WHERE project_id = ${row.project_id}`;
      return;
    }
  } else {
    // Directory exists — still patch in case it's a fresh deploy image
    patchHardcodedPort(publishDir);
  }

  // ---- Allocate port ----
  let assignedPort;
  try {
    assignedPort = await getNextFreePort();
  } catch (err) {
    console.error(`[publish] No free port for ${row.slug}: ${err.message}`);
    await sql`UPDATE published_apps SET status = 'failed' WHERE project_id = ${row.project_id}`;
    return;
  }

  const app = {
    projectId: row.project_id,
    slug: row.slug,
    dir: publishDir,
    port: assignedPort,
    status: "starting",
    process: null,
    startCommand:   row.start_command   || "npm start",
    installCommand: row.install_command || "npm install",
    buildCommand:   row.build_command   || null,
    publishedAt: row.published_at,
    logs: "",
  };
  publishedApps.set(row.project_id, app);

  // ---- Spawn ----
  const mergedEnv = await getMergedEnv(row.project_id);
  const resolvedCmd = resolveStartCommand(publishDir, app.startCommand);
  const cmdParts = validateCommand(resolvedCmd);
  const processEnv = buildProcessEnv(assignedPort, mergedEnv);

  const proc = spawn(cmdParts[0], cmdParts.slice(1), {
    cwd: publishDir,
    env: processEnv,
  });

  app.process = proc;
  attachLogs(proc, app);

  proc.on("close", (code) => {
    releasePort(assignedPort);
    app.process = null;
    if (app.status !== "stopped") {
      app.status = "failed";
      app.logs += `\nProcess exited with code ${code}`;
      saveToDb(app).catch(() => {});
    }
  });

  proc.on("error", (err) => {
    releasePort(assignedPort);
    app.process = null;
    app.status = "failed";
    app.logs += `\nProcess error: ${err.message}`;
    saveToDb(app).catch(() => {});
  });

  await new Promise((r) => setTimeout(r, RESTORE_STARTUP_GRACE_MS));

  if (!app.process || app.process.killed) {
    app.status = "failed";
    console.error(`[publish] ${row.slug} exited during startup:\n${app.logs.slice(-500)}`);
    await saveToDb(app).catch(() => {});
    return;
  }

  app.status = "running";
  await saveToDb(app);
  console.log(`[publish] Restored ${row.slug} on port ${assignedPort}`);
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

  const workspaceDir = path.join(__dirname, "..", "..", "workspaces", currentRunId);
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