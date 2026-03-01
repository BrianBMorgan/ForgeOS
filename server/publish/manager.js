const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");
const net = require("net");

const PUBLISHED_DIR = path.join(__dirname, "..", "..", "published");
const PORT_RANGE_START = 4100;
const PORT_RANGE_END = 4199;

const publishedApps = new Map();

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
  await sql`CREATE TABLE IF NOT EXISTS published_apps (
    id SERIAL PRIMARY KEY,
    project_id VARCHAR(8) NOT NULL UNIQUE,
    slug VARCHAR(255) NOT NULL UNIQUE,
    port INT,
    status VARCHAR(20) DEFAULT 'stopped',
    start_command TEXT,
    install_command TEXT,
    published_at BIGINT,
    updated_at BIGINT
  )`;
}

function ensurePublishedDir() {
  if (!fs.existsSync(PUBLISHED_DIR)) {
    fs.mkdirSync(PUBLISHED_DIR, { recursive: true });
  }
}

function generateSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 60) || "app";
}

function getNextFreePort() {
  return new Promise((resolve, reject) => {
    const usedPorts = new Set();
    for (const [, app] of publishedApps) {
      if (app.port && app.status === "running") usedPorts.add(app.port);
    }
    function tryPort(port) {
      if (port > PORT_RANGE_END) {
        reject(new Error("No free ports in published range"));
        return;
      }
      if (usedPorts.has(port)) {
        tryPort(port + 1);
        return;
      }
      const server = net.createServer();
      server.once("error", () => tryPort(port + 1));
      server.once("listening", () => {
        server.close(() => resolve(port));
      });
      server.listen(port, "127.0.0.1");
    }
    tryPort(PORT_RANGE_START);
  });
}

function forceKillPort(port) {
  try { execSync(`fuser -k ${port}/tcp 2>/dev/null || true`); } catch {}
  try { execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`); } catch {}
}

function patchHardcodedPort(dir) {
  try {
    const files = collectJsFiles(dir);
    for (const filePath of files) {
      let content;
      try { content = fs.readFileSync(filePath, "utf8"); } catch { continue; }
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
        fs.writeFileSync(filePath, patched, "utf8");
      }
    }
  } catch {}
}

function collectJsFiles(dir, files = []) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        collectJsFiles(full, files);
      } else if (/\.(js|ts|mjs|cjs)$/.test(entry.name)) {
        files.push(full);
      }
    }
  } catch {}
  return files;
}

function resolveStartCommand(dir, startCommand) {
  if (startCommand === "npm start" || startCommand === "npm run start") {
    try {
      const pkgPath = path.join(dir, "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        const script = pkg.scripts?.start;
        if (script && /^node\s+\S+/.test(script)) {
          return script;
        }
      }
    } catch {}
  }
  return startCommand;
}

function validateCommand(cmd) {
  const parts = cmd.split(/\s+/).filter(Boolean);
  if (parts.length === 0) throw new Error("Empty command");
  return parts;
}

function cleanDatabaseUrl(url) {
  if (!url) return url;
  return url.replace(/\?.*$/, "") + "?sslmode=require";
}

function getPublishedEnv(customEnv = {}) {
  const RESERVED = ["PORT", "DATABASE_URL", "NEON_AUTH_JWKS_URL", "JWT_SECRET", "NODE_ENV", "HOME", "PATH", "TERM"];
  const filtered = { ...customEnv };
  for (const k of RESERVED) delete filtered[k];
  const env = { ...filtered };
  if (process.env.NEON_DATABASE_URL) {
    env.DATABASE_URL = cleanDatabaseUrl(process.env.NEON_DATABASE_URL);
  }
  if (process.env.NEON_AUTH_JWKS_URL) {
    env.NEON_AUTH_JWKS_URL = process.env.NEON_AUTH_JWKS_URL;
  }
  env.JWT_SECRET = "forgeos-published-app-secret-" + Date.now();
  return env;
}

let publishLock = false;

async function getMergedEnv(projectId) {
  let globalDefaults = {};
  let projectEnv = {};
  try {
    const settingsManager = require("../settings/manager");
    const defaultEnvSetting = await settingsManager.getSetting("default_env_vars");
    if (defaultEnvSetting?.vars && Array.isArray(defaultEnvSetting.vars)) {
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
  return { ...globalDefaults, ...projectEnv };
}

function copyDirectory(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

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
  const project = projectManager.getProject(projectId);
  if (!project) throw new Error("Project not found");

  const currentRunId = project.currentRunId;
  if (!currentRunId) throw new Error("No build to publish — run a build first");

  const workspaceDir = path.join(__dirname, "..", "..", "workspaces", currentRunId);
  if (!fs.existsSync(workspaceDir)) throw new Error("Workspace files not found");

  const sql = await getDb();
  const slug = generateSlug(project.name);

  let existingSlug = slug;
  if (sql) {
    const existing = await sql`SELECT slug FROM published_apps WHERE project_id = ${projectId}`;
    if (existing.length > 0) {
      existingSlug = existing[0].slug;
    } else {
      const conflicts = await sql`SELECT slug FROM published_apps WHERE slug = ${slug} AND project_id != ${projectId}`;
      if (conflicts.length > 0) {
        existingSlug = slug + "-" + projectId;
      }
    }
  }

  await stopPublishedApp(projectId);

  ensurePublishedDir();
  const publishDir = path.join(PUBLISHED_DIR, projectId);
  if (fs.existsSync(publishDir)) {
    fs.rmSync(publishDir, { recursive: true, force: true });
  }

  copyDirectory(workspaceDir, publishDir);
  patchHardcodedPort(publishDir);

  let startCommand = "npm start";
  let installCommand = "npm install";
  try {
    const { getRun } = require("../pipeline/runner");
    const run = await getRun(currentRunId);
    if (run?.stages?.executor?.output?.startCommand) {
      startCommand = run.stages.executor.output.startCommand;
    }
    if (run?.stages?.executor?.output?.installCommand) {
      installCommand = run.stages.executor.output.installCommand;
    }
  } catch {}
  try {
    const pkgPath = path.join(publishDir, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg.scripts?.start && startCommand === "npm start") {
        startCommand = "npm start";
      }
    }
  } catch {}

  const app = {
    projectId,
    slug: existingSlug,
    dir: publishDir,
    port: null,
    status: "installing",
    process: null,
    startCommand,
    installCommand,
    publishedAt: Date.now(),
    logs: "",
  };
  publishedApps.set(projectId, app);

  try {
    const parts = validateCommand(installCommand);
    await new Promise((resolve, reject) => {
      const proc = spawn(parts[0], parts.slice(1), {
        cwd: publishDir,
        env: { ...process.env, NODE_ENV: "production" },
      });
      let output = "";
      proc.stdout.on("data", (d) => { output += d.toString(); });
      proc.stderr.on("data", (d) => { output += d.toString(); });
      proc.on("close", (code) => {
        app.logs += output;
        if (code === 0) resolve();
        else reject(new Error("Install failed with code " + code));
      });
      proc.on("error", reject);
    });
  } catch (err) {
    app.status = "failed";
    app.logs += "\nInstall failed: " + err.message;
    await saveToDb(app);
    throw err;
  }

  let assignedPort;
  try {
    assignedPort = await getNextFreePort();
  } catch {
    assignedPort = PORT_RANGE_START;
    forceKillPort(assignedPort);
  }
  app.port = assignedPort;

  const mergedEnv = await getMergedEnv(projectId);
  const resolvedCmd = resolveStartCommand(publishDir, startCommand);
  const cmdParts = validateCommand(resolvedCmd);

  const proc = spawn(cmdParts[0], cmdParts.slice(1), {
    cwd: publishDir,
    env: {
      ...process.env,
      PORT: String(assignedPort),
      NODE_ENV: "production",
      ...getPublishedEnv(mergedEnv),
    },
  });

  app.process = proc;
  app.status = "starting";

  proc.stdout.on("data", (d) => {
    app.logs += d.toString();
    if (app.logs.length > 50000) app.logs = app.logs.slice(-30000);
  });
  proc.stderr.on("data", (d) => {
    app.logs += d.toString();
    if (app.logs.length > 50000) app.logs = app.logs.slice(-30000);
  });
  proc.on("close", (code) => {
    if (app.status !== "stopped") {
      app.status = "failed";
      app.logs += `\nProcess exited with code ${code}`;
      saveToDb(app).catch(() => {});
    }
    app.process = null;
  });
  proc.on("error", (err) => {
    app.status = "failed";
    app.logs += `\nProcess error: ${err.message}`;
    saveToDb(app).catch(() => {});
  });

  await new Promise((resolve) => setTimeout(resolve, 3000));

  if (app.process && !app.process.killed) {
    app.status = "running";
  }

  await saveToDb(app);

  console.log(`[publish] Published ${project.name} at /apps/${existingSlug} (port ${assignedPort})`);
  return { slug: existingSlug, port: assignedPort, status: app.status };
}

async function saveToDb(app) {
  const sql = await getDb();
  if (!sql) return;
  const now = Date.now();
  await sql`INSERT INTO published_apps (project_id, slug, port, status, start_command, install_command, published_at, updated_at)
    VALUES (${app.projectId}, ${app.slug}, ${app.port}, ${app.status}, ${app.startCommand}, ${app.installCommand}, ${app.publishedAt}, ${now})
    ON CONFLICT (project_id) DO UPDATE SET
      slug = ${app.slug},
      port = ${app.port},
      status = ${app.status},
      start_command = ${app.startCommand},
      install_command = ${app.installCommand},
      updated_at = ${now}`;
}

async function stopPublishedApp(projectId) {
  const app = publishedApps.get(projectId);
  if (app?.process) {
    app.status = "stopped";
    try { app.process.kill("SIGTERM"); } catch {}
    setTimeout(() => {
      try { if (app.process && !app.process.killed) app.process.kill("SIGKILL"); } catch {}
    }, 3000);
    if (app.port) forceKillPort(app.port);
  }
}

async function unpublishProject(projectId) {
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

async function restorePublishedApps() {
  const sql = await getDb();
  if (!sql) return;

  await ensureSchema();
  const rows = await sql`SELECT * FROM published_apps`;

  for (const row of rows) {
    const publishDir = path.join(PUBLISHED_DIR, row.project_id);
    if (!fs.existsSync(publishDir)) {
      console.log(`[publish] Skipping restore for ${row.slug} — files missing`);
      continue;
    }

    let assignedPort;
    try {
      assignedPort = await getNextFreePort();
    } catch {
      console.log(`[publish] No free port for ${row.slug}`);
      continue;
    }

    const app = {
      projectId: row.project_id,
      slug: row.slug,
      dir: publishDir,
      port: assignedPort,
      status: "starting",
      process: null,
      startCommand: row.start_command || "npm start",
      installCommand: row.install_command || "npm install",
      publishedAt: row.published_at,
      logs: "",
    };
    publishedApps.set(row.project_id, app);

    patchHardcodedPort(publishDir);
    const mergedEnv = await getMergedEnv(row.project_id);
    const resolvedCmd = resolveStartCommand(publishDir, app.startCommand);

    try {
      const cmdParts = validateCommand(resolvedCmd);
      const proc = spawn(cmdParts[0], cmdParts.slice(1), {
        cwd: publishDir,
        env: {
          ...process.env,
          PORT: String(assignedPort),
          NODE_ENV: "production",
          ...getPublishedEnv(mergedEnv),
        },
      });

      app.process = proc;
      proc.stdout.on("data", (d) => {
        app.logs += d.toString();
        if (app.logs.length > 50000) app.logs = app.logs.slice(-30000);
      });
      proc.stderr.on("data", (d) => {
        app.logs += d.toString();
        if (app.logs.length > 50000) app.logs = app.logs.slice(-30000);
      });
      proc.on("close", (code) => {
        if (app.status !== "stopped") {
          app.status = "failed";
          saveToDb(app).catch(() => {});
        }
        app.process = null;
      });
      proc.on("error", () => {
        app.status = "failed";
        saveToDb(app).catch(() => {});
      });

      await new Promise((r) => setTimeout(r, 2000));
      if (app.process && !app.process.killed) {
        app.status = "running";
        await saveToDb(app);
        console.log(`[publish] Restored ${row.slug} on port ${assignedPort}`);
      }
    } catch (err) {
      app.status = "failed";
      console.log(`[publish] Failed to restore ${row.slug}: ${err.message}`);
    }
  }
}

async function exportProject(projectId) {
  const projectManager = require("../projects/manager");
  const project = projectManager.getProject(projectId);
  if (!project) throw new Error("Project not found");

  const currentRunId = project.currentRunId;
  if (!currentRunId) throw new Error("No build to export");

  const workspaceDir = path.join(__dirname, "..", "..", "workspaces", currentRunId);
  if (!fs.existsSync(workspaceDir)) throw new Error("Workspace files not found");

  const slug = generateSlug(project.name);
  const zipPath = path.join("/tmp", `${slug}-export.zip`);

  try { fs.unlinkSync(zipPath); } catch {}

  execSync(`cd "${workspaceDir}" && zip -r "${zipPath}" . -x "node_modules/*" ".git/*"`, {
    timeout: 30000,
  });

  return { zipPath, filename: `${slug}.zip` };
}

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
