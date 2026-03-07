const fs = require("fs");
const path = require("path");

const WORKSPACES_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, "..", ".."), "workspaces");
const BACKUP_INTERVAL_MS = 5 * 60 * 1000;

const IGNORE_PATTERNS = [
  "node_modules",
  ".git",
  "__static_server.js",
  ".DS_Store",
  "package-lock.json",
];

const MAX_FILE_SIZE = 5 * 1024 * 1024;

let sql = null;

async function initDb() {
  if (sql) return sql;
  const dbUrl = process.env.NEON_DATABASE_URL;
  if (!dbUrl) return null;
  const { neon } = require("@neondatabase/serverless");
  sql = neon(dbUrl);
  await sql`CREATE TABLE IF NOT EXISTS runtime_file_backups (
    id SERIAL PRIMARY KEY,
    run_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    content TEXT NOT NULL,
    size_bytes INTEGER DEFAULT 0,
    is_binary BOOLEAN DEFAULT false,
    updated_at BIGINT NOT NULL,
    UNIQUE(run_id, file_path)
  )`;
  return sql;
}

function shouldIgnore(filePath) {
  return IGNORE_PATTERNS.some((p) => filePath.includes(p));
}

function getExecutorFiles(runId) {
  try {
    const { getRunSync } = require("../pipeline/runner");
    const run = getRunSync(runId);
    if (!run) return new Set();
    const files = run.stages?.executor?.output?.files;
    if (!files || !Array.isArray(files)) return new Set();
    return new Set(files.map((f) => f.path));
  } catch {
    return new Set();
  }
}

function scanRuntimeFiles(wsDir, runId) {
  const executorFiles = getExecutorFiles(runId);
  const runtimeFiles = [];

  function walk(dir, rel) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;

      if (shouldIgnore(relPath)) continue;

      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else if (entry.isFile()) {
        if (!executorFiles.has(relPath)) {
          try {
            const stat = fs.statSync(fullPath);
            if (stat.size > MAX_FILE_SIZE) continue;
            runtimeFiles.push({ path: relPath, fullPath, size: stat.size });
          } catch {}
        }
      }
    }
  }

  walk(wsDir, "");
  return runtimeFiles;
}

async function backupRuntimeFiles(runId) {
  const db = await initDb();
  if (!db) return;

  const wsDir = path.join(WORKSPACES_DIR, runId);
  if (!fs.existsSync(wsDir)) return;

  const runtimeFiles = scanRuntimeFiles(wsDir, runId);
  if (runtimeFiles.length === 0) return;

  const now = Date.now();
  let backed = 0;

  for (const file of runtimeFiles) {
    try {
      const raw = fs.readFileSync(file.fullPath);
      const isBinary = raw.some((b) => b === 0);
      const content = isBinary ? raw.toString("base64") : raw.toString("utf8");

      await db`INSERT INTO runtime_file_backups (run_id, file_path, content, size_bytes, is_binary, updated_at)
        VALUES (${runId}, ${file.path}, ${content}, ${file.size}, ${isBinary}, ${now})
        ON CONFLICT (run_id, file_path)
        DO UPDATE SET content = ${content}, size_bytes = ${file.size}, is_binary = ${isBinary}, updated_at = ${now}`;
      backed++;
    } catch (err) {
      console.error(`[runtime-backup] Failed to backup ${file.path} for ${runId}:`, err.message);
    }
  }

  if (backed > 0) {
    console.log(`[runtime-backup] Backed up ${backed} runtime file(s) for workspace ${runId}`);
  }
}

async function restoreRuntimeFiles(runId) {
  const db = await initDb();
  if (!db) return 0;

  const wsDir = path.join(WORKSPACES_DIR, runId);
  if (!fs.existsSync(wsDir)) return 0;

  try {
    const rows = await db`SELECT file_path, content, is_binary FROM runtime_file_backups WHERE run_id = ${runId}`;
    let restored = 0;

    for (const row of rows) {
      try {
        const filePath = path.join(wsDir, row.file_path);
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        if (row.is_binary) {
          fs.writeFileSync(filePath, Buffer.from(row.content, "base64"));
        } else {
          fs.writeFileSync(filePath, row.content);
        }
        restored++;
      } catch (err) {
        console.error(`[runtime-backup] Failed to restore ${row.file_path}:`, err.message);
      }
    }

    if (restored > 0) {
      console.log(`[runtime-backup] Restored ${restored} runtime file(s) for workspace ${runId}`);
    }
    return restored;
  } catch (err) {
    console.error(`[runtime-backup] Restore failed for ${runId}:`, err.message);
    return 0;
  }
}

async function cleanupBackups(runId) {
  const db = await initDb();
  if (!db) return;
  try {
    await db`DELETE FROM runtime_file_backups WHERE run_id = ${runId}`;
  } catch {}
}

function startPeriodicBackup(getActiveRunIds) {
  setInterval(async () => {
    try {
      const runIds = getActiveRunIds();
      for (const runId of runIds) {
        await backupRuntimeFiles(runId);
      }
    } catch (err) {
      console.error("[runtime-backup] Periodic backup error:", err.message);
    }
  }, BACKUP_INTERVAL_MS);
}

module.exports = {
  backupRuntimeFiles,
  restoreRuntimeFiles,
  cleanupBackups,
  startPeriodicBackup,
};
