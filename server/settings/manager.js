const { neon } = require("@neondatabase/serverless");

const dbUrl = process.env.NEON_DATABASE_URL;
const sql = dbUrl ? neon(dbUrl) : null;

const DEFAULTS = {
  model_config: {
    plannerModel: "claude-sonnet-4-5-20250514",
    reviewerModel: "claude-haiku-3-5-20241022",
    chatModel: "claude-haiku-3-5-20241022",
    plannerTemp: 0.7,
    reviewerTemp: 0.2,
  },
  auto_approve: {
    enabled: false,
    maxRiskLevel: "low",
  },
  default_env_vars: {
    vars: [],
  },
  workspace_limits: {
    portRangeStart: 4000,
    portRangeEnd: 4099,
    maxConcurrentApps: 5,
    logRetention: 2000,
  },
  github: {
    repo: "BrianBMorgan/ForgeOS",
    autoPush: true,
  },
  allowed_tech_stack: {
    allowed: [
      "express",
      "@neondatabase/serverless",
      "@anthropic-ai/sdk",
      "uuid",
      "cors",
      "cookie-parser",
      "body-parser",
      "multer",
      "nodemailer",
      "node-cron",
      "ws",
      "socket.io",
      "marked",
      "cheerio",
      "axios",
      "node-fetch",
    ],
    banned: [
      "react",
      "vue",
      "angular",
      "next",
      "nuxt",
      "svelte",
      "bcrypt",
      "jsonwebtoken",
      "dotenv",
      "typescript",
      "webpack",
      "vite",
      "rollup",
      "parcel",
      "esbuild",
      "tailwindcss",
      "openai",
    ],
  },
};

let initialized = false;

async function ensureSchema() {
  if (!sql) return;
  try {
    await sql`CREATE TABLE IF NOT EXISTS global_settings (
      key VARCHAR(255) PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at BIGINT NOT NULL
    )`;
    await sql`CREATE TABLE IF NOT EXISTS global_secrets (
      id SERIAL PRIMARY KEY,
      key VARCHAR(255) UNIQUE NOT NULL,
      value TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )`;
    await sql`CREATE TABLE IF NOT EXISTS skills (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT DEFAULT '',
      instructions TEXT NOT NULL,
      tags TEXT DEFAULT '',
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )`;
  } catch (err) {
    console.error("Failed to create settings schema:", err.message);
  }
}

async function seedDefaults() {
  if (!sql || initialized) return;
  initialized = true;
  await ensureSchema();
  const now = Date.now();
  for (const [key, value] of Object.entries(DEFAULTS)) {
    try {
      const existing = await sql`SELECT key FROM global_settings WHERE key = ${key}`;
      if (existing.length === 0) {
        await sql`INSERT INTO global_settings (key, value, updated_at) VALUES (${key}, ${JSON.stringify(value)}, ${now})`;
      }
    } catch (err) {
      console.error(`Failed to seed setting ${key}:`, err.message);
    }
  }
}

async function getSetting(key) {
  if (!sql) return DEFAULTS[key] || null;
  await seedDefaults();
  try {
    const rows = await sql`SELECT value FROM global_settings WHERE key = ${key}`;
    if (rows.length === 0) return DEFAULTS[key] || null;
    return rows[0].value;
  } catch (err) {
    console.error("Failed to get setting:", err.message);
    return DEFAULTS[key] || null;
  }
}

async function setSetting(key, value) {
  if (!sql) return false;
  await seedDefaults();
  const now = Date.now();
  try {
    await sql`INSERT INTO global_settings (key, value, updated_at)
      VALUES (${key}, ${JSON.stringify(value)}, ${now})
      ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(value)}, updated_at = ${now}`;
    return true;
  } catch (err) {
    console.error("Failed to set setting:", err.message);
    return false;
  }
}

async function getAllSettings() {
  if (!sql) return { ...DEFAULTS };
  await seedDefaults();
  try {
    const rows = await sql`SELECT key, value FROM global_settings`;
    const result = { ...DEFAULTS };
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  } catch (err) {
    console.error("Failed to get all settings:", err.message);
    return { ...DEFAULTS };
  }
}

async function getAllSecretKeys() {
  if (!sql) return [];
  await seedDefaults();
  try {
    const rows = await sql`SELECT key FROM global_secrets ORDER BY key ASC`;
    return rows.map((r) => r.key);
  } catch (err) {
    console.error("Failed to get secret keys:", err.message);
    return [];
  }
}

async function getSecret(key) {
  if (!sql) return null;
  await seedDefaults();
  try {
    const rows = await sql`SELECT value FROM global_secrets WHERE key = ${key}`;
    return rows.length > 0 ? rows[0].value : null;
  } catch (err) {
    console.error("Failed to get secret:", err.message);
    return null;
  }
}

async function setSecret(key, value) {
  if (!sql) return false;
  await seedDefaults();
  const now = Date.now();
  try {
    await sql`INSERT INTO global_secrets (key, value, created_at)
      VALUES (${key}, ${value}, ${now})
      ON CONFLICT (key) DO UPDATE SET value = ${value}, created_at = ${now}`;
    return true;
  } catch (err) {
    console.error("Failed to set secret:", err.message);
    return false;
  }
}

async function deleteSecret(key) {
  if (!sql) return false;
  await seedDefaults();
  try {
    await sql`DELETE FROM global_secrets WHERE key = ${key}`;
    return true;
  } catch (err) {
    console.error("Failed to delete secret:", err.message);
    return false;
  }
}

async function getSecretsAsObject() {
  if (!sql) return {};
  await seedDefaults();
  try {
    const rows = await sql`SELECT key, value FROM global_secrets`;
    const obj = {};
    for (const r of rows) obj[r.key] = r.value;
    return obj;
  } catch (err) {
    console.error("Failed to get secrets as object:", err.message);
    return {};
  }
}

async function createSkill({ name, description, instructions, tags }) {
  if (!sql) return null;
  await seedDefaults();
  const now = Date.now();
  const tagsStr = Array.isArray(tags) ? tags.join(",") : (tags || "");
  try {
    const rows = await sql`INSERT INTO skills (name, description, instructions, tags, created_at, updated_at)
      VALUES (${name}, ${description || ""}, ${instructions}, ${tagsStr}, ${now}, ${now})
      RETURNING id`;
    return { id: rows[0].id, name, description: description || "", instructions, tags: tagsStr, createdAt: now, updatedAt: now };
  } catch (err) {
    console.error("Failed to create skill:", err.message);
    return null;
  }
}

async function updateSkill(id, { name, description, instructions, tags }) {
  if (!sql) return false;
  await seedDefaults();
  const now = Date.now();
  const tagsStr = Array.isArray(tags) ? tags.join(",") : (tags || "");
  try {
    await sql`UPDATE skills SET name = ${name}, description = ${description || ""}, instructions = ${instructions}, tags = ${tagsStr}, updated_at = ${now} WHERE id = ${id}`;
    return true;
  } catch (err) {
    console.error("Failed to update skill:", err.message);
    return false;
  }
}

async function deleteSkill(id) {
  if (!sql) return false;
  await seedDefaults();
  try {
    await sql`DELETE FROM skills WHERE id = ${id}`;
    return true;
  } catch (err) {
    console.error("Failed to delete skill:", err.message);
    return false;
  }
}

async function getSkill(id) {
  if (!sql) return null;
  await seedDefaults();
  try {
    const rows = await sql`SELECT * FROM skills WHERE id = ${id}`;
    if (rows.length === 0) return null;
    const r = rows[0];
    return { id: r.id, name: r.name, description: r.description, instructions: r.instructions, tags: r.tags, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) };
  } catch (err) {
    console.error("Failed to get skill:", err.message);
    return null;
  }
}

async function getAllSkills() {
  if (!sql) return [];
  await seedDefaults();
  try {
    const rows = await sql`SELECT * FROM skills ORDER BY name ASC`;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      instructions: r.instructions,
      tags: r.tags,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    }));
  } catch (err) {
    console.error("Failed to get all skills:", err.message);
    return [];
  }
}

module.exports = {
  getSetting,
  setSetting,
  getAllSettings,
  getAllSecretKeys,
  getSecret,
  setSecret,
  deleteSecret,
  getSecretsAsObject,
  createSkill,
  updateSkill,
  deleteSkill,
  getSkill,
  getAllSkills,
  DEFAULTS,
};
