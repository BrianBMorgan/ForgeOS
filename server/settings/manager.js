const { neon } = require("@neondatabase/serverless");

const dbUrl = process.env.NEON_DATABASE_URL;
const sql = dbUrl ? neon(dbUrl) : null;

const DEFAULTS = {
  default_env_vars: {
    vars: [],
  },
  github: {
    repo: "BrianBMorgan/ForgeOS",
    autoPush: true,
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

    // Skill type: 'standard' (default) or 'repo_access'.
    // Repo-access skills carry repo_owner, repo_name, repo_branch and a
    // reference to a vault secret holding the PAT (repo_token_secret_key).
    // The actual token is stored in global_secrets, never in this table.
    await sql`ALTER TABLE skills ADD COLUMN IF NOT EXISTS skill_type VARCHAR(32) NOT NULL DEFAULT 'standard'`;
    await sql`ALTER TABLE skills ADD COLUMN IF NOT EXISTS repo_owner VARCHAR(255)`;
    await sql`ALTER TABLE skills ADD COLUMN IF NOT EXISTS repo_name VARCHAR(255)`;
    await sql`ALTER TABLE skills ADD COLUMN IF NOT EXISTS repo_branch VARCHAR(255) DEFAULT 'main'`;
    await sql`ALTER TABLE skills ADD COLUMN IF NOT EXISTS repo_token_secret_key VARCHAR(255)`;
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
  let sqlConn = sql;
  if (!sqlConn && process.env.NEON_DATABASE_URL) {
    sqlConn = neon(process.env.NEON_DATABASE_URL);
  }
  if (!sqlConn) return {};
  await seedDefaults();
  try {
    const rows = await sqlConn`SELECT key, value FROM global_secrets`;
    const obj = {};
    for (const r of rows) obj[r.key] = r.value;
    return obj;
  } catch (err) {
    console.error("Failed to get secrets as object:", err.message);
    return {};
  }
}

function normalizeSkill(r) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    instructions: r.instructions,
    tags: r.tags,
    skillType: r.skill_type || "standard",
    repoOwner: r.repo_owner || null,
    repoName: r.repo_name || null,
    repoBranch: r.repo_branch || null,
    repoTokenSecretKey: r.repo_token_secret_key || null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

async function createSkill({ name, description, instructions, tags, skillType, repoOwner, repoName, repoBranch, repoToken }) {
  if (!sql) return null;
  await seedDefaults();
  const now = Date.now();
  const tagsStr = Array.isArray(tags) ? tags.join(",") : (tags || "");
  const type = skillType === "repo_access" ? "repo_access" : "standard";
  try {
    const rows = await sql`INSERT INTO skills
      (name, description, instructions, tags, skill_type, repo_owner, repo_name, repo_branch, created_at, updated_at)
      VALUES (${name}, ${description || ""}, ${instructions || ""}, ${tagsStr}, ${type},
              ${repoOwner || null}, ${repoName || null}, ${repoBranch || null},
              ${now}, ${now})
      RETURNING id`;
    const id = rows[0].id;
    let repoTokenSecretKey = null;
    if (type === "repo_access" && repoToken) {
      repoTokenSecretKey = `REPO_TOKEN_${id}`;
      await setSecret(repoTokenSecretKey, repoToken);
      await sql`UPDATE skills SET repo_token_secret_key = ${repoTokenSecretKey} WHERE id = ${id}`;
    }
    return {
      id, name, description: description || "", instructions: instructions || "", tags: tagsStr,
      skillType: type, repoOwner: repoOwner || null, repoName: repoName || null,
      repoBranch: repoBranch || null, repoTokenSecretKey,
      createdAt: now, updatedAt: now,
    };
  } catch (err) {
    console.error("Failed to create skill:", err.message);
    return null;
  }
}

async function updateSkill(id, { name, description, instructions, tags, skillType, repoOwner, repoName, repoBranch, repoToken }) {
  if (!sql) return false;
  await seedDefaults();
  const now = Date.now();
  const tagsStr = Array.isArray(tags) ? tags.join(",") : (tags || "");
  try {
    // Build the update as a single statement — only set columns the caller supplied.
    // Neon's tagged-template driver doesn't love dynamic SQL, so we do it by fetching
    // current row, overlaying new values, and writing the merged row.
    const rows = await sql`SELECT * FROM skills WHERE id = ${id}`;
    if (rows.length === 0) return false;
    const cur = rows[0];
    const merged = {
      name: name ?? cur.name,
      description: description ?? cur.description,
      instructions: instructions ?? cur.instructions,
      tags: tags !== undefined ? tagsStr : cur.tags,
      skill_type: skillType ?? cur.skill_type ?? "standard",
      repo_owner: repoOwner !== undefined ? (repoOwner || null) : cur.repo_owner,
      repo_name: repoName !== undefined ? (repoName || null) : cur.repo_name,
      repo_branch: repoBranch !== undefined ? (repoBranch || null) : cur.repo_branch,
    };
    await sql`UPDATE skills SET
      name = ${merged.name},
      description = ${merged.description},
      instructions = ${merged.instructions},
      tags = ${merged.tags},
      skill_type = ${merged.skill_type},
      repo_owner = ${merged.repo_owner},
      repo_name = ${merged.repo_name},
      repo_branch = ${merged.repo_branch},
      updated_at = ${now}
      WHERE id = ${id}`;
    // If caller rotated the token, re-store it in the vault under the same key
    if (repoToken !== undefined && repoToken !== null && repoToken !== "") {
      const key = cur.repo_token_secret_key || `REPO_TOKEN_${id}`;
      await setSecret(key, repoToken);
      if (!cur.repo_token_secret_key) {
        await sql`UPDATE skills SET repo_token_secret_key = ${key} WHERE id = ${id}`;
      }
    }
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
    const rows = await sql`SELECT repo_token_secret_key FROM skills WHERE id = ${id}`;
    const tokenKey = rows[0]?.repo_token_secret_key;
    await sql`DELETE FROM skills WHERE id = ${id}`;
    if (tokenKey) {
      try { await deleteSecret(tokenKey); } catch {}
    }
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
    return normalizeSkill(rows[0]);
  } catch (err) {
    console.error("Failed to get skill:", err.message);
    return null;
  }
}

// Return the resolved PAT for a repo_access skill. Returns null if the
// skill is not a repo_access skill, or has no token set, or sql is unavailable.
async function getSkillRepoToken(id) {
  const skill = await getSkill(id);
  if (!skill || skill.skillType !== "repo_access" || !skill.repoTokenSecretKey) return null;
  try {
    return await getSecret(skill.repoTokenSecretKey);
  } catch {
    return null;
  }
}

async function getAllSkills() {
  if (!sql) return [];
  await seedDefaults();
  try {
    const rows = await sql`SELECT * FROM skills ORDER BY name ASC`;
    return rows.map(normalizeSkill);
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
  getSkillRepoToken,
  getAllSkills,
  DEFAULTS,
};
