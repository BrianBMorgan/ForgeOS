"use strict";
const path = require("path");

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
    CREATE TABLE IF NOT EXISTS project_assets (
      id          SERIAL PRIMARY KEY,
      project_id  VARCHAR(8) NOT NULL,
      filename    VARCHAR(255) NOT NULL,
      mimetype    VARCHAR(100) NOT NULL,
      size_bytes  INT NOT NULL,
      content     TEXT NOT NULL,
      created_at  BIGINT NOT NULL
    )
  `;
}

async function saveAsset(projectId, filename, mimetype, sizeBytes, content) {
  const sql = await getDb();
  if (!sql) throw new Error("No database connection");
  const now = Date.now();
  const [row] = await sql`
    INSERT INTO project_assets (project_id, filename, mimetype, size_bytes, content, created_at)
    VALUES (${projectId}, ${filename}, ${mimetype}, ${sizeBytes}, ${content}, ${now})
    ON CONFLICT DO NOTHING
    RETURNING id, filename, mimetype, size_bytes, created_at
  `;
  // If conflict (same filename), update instead
  if (!row) {
    const [updated] = await sql`
      UPDATE project_assets SET
        content = ${content},
        size_bytes = ${sizeBytes},
        mimetype = ${mimetype},
        created_at = ${now}
      WHERE project_id = ${projectId} AND filename = ${filename}
      RETURNING id, filename, mimetype, size_bytes, created_at
    `;
    return updated;
  }
  return row;
}

async function getAsset(projectId, filename) {
  const sql = await getDb();
  if (!sql) return null;
  const [row] = await sql`
    SELECT * FROM project_assets
    WHERE project_id = ${projectId} AND filename = ${filename}
  `;
  return row || null;
}

async function listAssets(projectId) {
  const sql = await getDb();
  if (!sql) return [];
  return await sql`
    SELECT id, project_id, filename, mimetype, size_bytes, created_at
    FROM project_assets
    WHERE project_id = ${projectId}
    ORDER BY created_at DESC
  `;
}

async function deleteAsset(projectId, filename) {
  const sql = await getDb();
  if (!sql) return;
  await sql`
    DELETE FROM project_assets
    WHERE project_id = ${projectId} AND filename = ${filename}
  `;
}

async function getAssetsContext(projectId) {
  const assets = await listAssets(projectId);
  if (!assets.length) return null;
  return assets.map(a => ({
    filename: a.filename,
    mimetype: a.mimetype,
    sizeBytes: a.size_bytes,
    accessUrl: `/api/projects/${projectId}/assets/${encodeURIComponent(a.filename)}`,
  }));
}

module.exports = {
  ensureSchema,
  saveAsset,
  getAsset,
  listAssets,
  deleteAsset,
  getAssetsContext,
};
