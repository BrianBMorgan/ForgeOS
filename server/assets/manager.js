"use strict";

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
    CREATE TABLE IF NOT EXISTS forge_assets (
      id          SERIAL PRIMARY KEY,
      filename    VARCHAR(255) NOT NULL UNIQUE,
      mimetype    VARCHAR(100) NOT NULL,
      size_bytes  INT NOT NULL,
      content     TEXT NOT NULL,
      created_at  BIGINT NOT NULL
    )
  `;
}

async function saveAsset(filename, mimetype, sizeBytes, content) {
  const sql = await getDb();
  if (!sql) throw new Error("No database connection");
  const now = Date.now();
  const [row] = await sql`
    INSERT INTO forge_assets (filename, mimetype, size_bytes, content, created_at)
    VALUES (${filename}, ${mimetype}, ${sizeBytes}, ${content}, ${now})
    ON CONFLICT (filename) DO UPDATE SET
      content    = EXCLUDED.content,
      size_bytes = EXCLUDED.size_bytes,
      mimetype   = EXCLUDED.mimetype,
      created_at = EXCLUDED.created_at
    RETURNING id, filename, mimetype, size_bytes, created_at
  `;
  return row;
}

async function getAsset(filename) {
  const sql = await getDb();
  if (!sql) return null;
  const [row] = await sql`
    SELECT * FROM forge_assets WHERE filename = ${filename}
  `;
  return row || null;
}

async function listAssets() {
  const sql = await getDb();
  if (!sql) return [];
  return await sql`
    SELECT id, filename, mimetype, size_bytes, created_at
    FROM forge_assets
    ORDER BY created_at DESC
  `;
}

async function deleteAsset(filename) {
  const sql = await getDb();
  if (!sql) return;
  await sql`DELETE FROM forge_assets WHERE filename = ${filename}`;
}

async function getAssetsContext() {
  const assets = await listAssets();
  if (!assets.length) return null;
  const lines = assets.map(a =>
    `- ${a.filename} (${a.mimetype}, ${a.size_bytes} bytes) → /api/assets/${encodeURIComponent(a.filename)}`
  );
  return `AVAILABLE GLOBAL ASSETS:\nThe following files are available via HTTP GET at their listed URLs:\n${lines.join("\n")}`;
}

module.exports = {
  ensureSchema,
  saveAsset,
  getAsset,
  listAssets,
  deleteAsset,
  getAssetsContext,
};
