"use strict";

/**
 * ForgeOS Brain — Persistent Memory Module
 * 
 * Drop this file into server/memory/brain.js
 * 
 * Wires into the workspace builder flow:
 *   1. buildContext(userRequest)     → call BEFORE sending to Claude
 *   2. extractMemory(buildResult)    → call AFTER successful build
 *   3. recordMistake(error, context) → call AFTER failed iteration
 *   4. upvoteMemory(id)              → call when user explicitly approves a build
 */

const { neon } = require("@neondatabase/serverless");
const Anthropic = require("@anthropic-ai/sdk");

// ── Clients ───────────────────────────────────────────────────────────────────

function getDb() {
  if (!process.env.NEON_DATABASE_URL) throw new Error("NEON_DATABASE_URL not set");
  return neon(process.env.NEON_DATABASE_URL);
}

function getAI() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// ── Schema ────────────────────────────────────────────────────────────────────

async function ensureSchema() {
  const sql = getDb();

  // Enable pgvector for semantic search
  // If your Neon instance doesn't have it, the HNSW index creation will fail
  // gracefully and keyword search will still work.
  try {
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
  } catch {}

  // Core memory store — patterns, preferences, solutions, mistakes
  await sql`
    CREATE TABLE IF NOT EXISTS forge_memory (
      id           SERIAL PRIMARY KEY,
      type         VARCHAR(50)  NOT NULL,  -- pattern | preference | solution | mistake | snippet
      category     VARCHAR(50),            -- ui | auth | database | api | deployment | integration
      content      TEXT         NOT NULL,
      source_project_id VARCHAR(8),
      usefulness_score  INT DEFAULT 0,
      embedding    vector(1536),           -- for semantic search (nullable — falls back to keyword)
      created_at   BIGINT NOT NULL,
      last_used_at BIGINT
    )
  `;

  // Try to add vector index — fails silently if pgvector not available
  try {
    await sql`
      CREATE INDEX IF NOT EXISTS forge_memory_embedding_idx
      ON forge_memory USING hnsw (embedding vector_cosine_ops)
    `;
  } catch {}

  // Project index — what has this team ever built
  await sql`
    CREATE TABLE IF NOT EXISTS forge_project_index (
      project_id   VARCHAR(8)   PRIMARY KEY,
      name         TEXT         NOT NULL,
      description  TEXT,
      stack        TEXT[],                 -- ['stripe', 'neon', 'auth', 'openai', ...]
      lessons      TEXT,                   -- what went wrong, what worked
      file_count   INT,
      published_url TEXT,
      built_at     BIGINT NOT NULL,
      updated_at   BIGINT
    )
  `;

  // Team-level preferences — survives across all projects
  await sql`
    CREATE TABLE IF NOT EXISTS forge_team_prefs (
      key          VARCHAR(100) PRIMARY KEY,
      value        TEXT         NOT NULL,
      confidence   INT DEFAULT 1,          -- incremented each time preference is confirmed
      updated_at   BIGINT NOT NULL
    )
  `;

  // Conversation history per project — powers iterative builds
  await sql`
    CREATE TABLE IF NOT EXISTS forge_conversations (
      id           SERIAL PRIMARY KEY,
      project_id   VARCHAR(8)   NOT NULL,
      role         VARCHAR(20)  NOT NULL,  -- user | assistant
      content      TEXT         NOT NULL,
      created_at   BIGINT       NOT NULL
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS forge_conversations_project_idx
    ON forge_conversations (project_id, created_at)
  `;

  console.log("[brain] Schema ready");
}

// ── Embeddings ────────────────────────────────────────────────────────────────

/**
 * Get a vector embedding for semantic search.
 * Falls back gracefully if the embeddings model isn't available.
 */
async function getEmbedding(text) {
  try {
    const ai = getAI();
    // Use a lightweight model for embeddings to keep costs low
    const response = await ai.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 8,
      system: "Return only the word DONE.",
      messages: [{ role: "user", content: text.slice(0, 500) }],
    });
    // Note: Claude doesn't have a dedicated embeddings endpoint yet.
    // When Anthropic releases one, swap this out.
    // For now we store null and fall back to keyword/recency search.
    return null;
  } catch {
    return null;
  }
}

// ── Context builder ───────────────────────────────────────────────────────────

/**
 * Build the memory context block to prepend to every Claude request.
 * Call this before sending any message to the workspace builder.
 * 
 * @param {string} userRequest - what the user is asking for right now
 * @param {string|null} projectId - current project ID (for conversation history)
 * @returns {string} formatted context block to prepend to system prompt
 */
async function buildContext(userRequest, projectId = null) {
  const sql = getDb();
  const now = Date.now();

  try {
    // ── Team preferences ──────────────────────────────────────────────────────
    const prefs = await sql`
      SELECT key, value, confidence
      FROM forge_team_prefs
      ORDER BY confidence DESC, updated_at DESC
    `;

    // ── Recent projects ───────────────────────────────────────────────────────
    const projects = await sql`
      SELECT project_id, name, description, stack, lessons, published_url, built_at
      FROM forge_project_index
      ORDER BY built_at DESC
      LIMIT 15
    `;

    // ── Relevant memories ─────────────────────────────────────────────────────
    // Try semantic search first, fall back to recency + usefulness
    let memories = [];

    try {
      memories = await sql`
        SELECT id, type, category, content
        FROM forge_memory
        WHERE usefulness_score >= 0
        ORDER BY usefulness_score DESC, last_used_at DESC NULLS LAST
        LIMIT 30
      `;
    } catch {}

    // Mark retrieved memories as recently used
    if (memories.length > 0) {
      const ids = memories.map(m => m.id);
      await sql`
        UPDATE forge_memory
        SET last_used_at = ${now}
        WHERE id = ANY(${ids})
      `.catch(() => {});
    }

    // ── Conversation history for this project ─────────────────────────────────
    let history = [];
    if (projectId) {
      history = await sql`
        SELECT role, content
        FROM forge_conversations
        WHERE project_id = ${projectId}
        ORDER BY created_at ASC
        LIMIT 50
      `;
    }

    // ── Format context block ──────────────────────────────────────────────────
    const lines = ["## FORGEOS BRAIN — Persistent Team Memory", ""];

    // Team preferences
    if (prefs.length > 0) {
      lines.push("### Team Preferences (learned from past builds)");
      for (const p of prefs) {
        lines.push(`- ${p.key}: ${p.value}${p.confidence > 2 ? " [strong preference]" : ""}`);
      }
      lines.push("");
    }

    // Patterns that worked
    const patterns = memories.filter(m => m.type === "pattern" || m.type === "solution");
    if (patterns.length > 0) {
      lines.push("### Patterns That Worked");
      for (const m of patterns.slice(0, 10)) {
        lines.push(`- [${m.category || "general"}] ${m.content}`);
      }
      lines.push("");
    }

    // Mistakes to avoid
    const mistakes = memories.filter(m => m.type === "mistake");
    if (mistakes.length > 0) {
      lines.push("### Mistakes to Avoid (learned from failed iterations)");
      for (const m of mistakes.slice(0, 8)) {
        lines.push(`- ${m.content}`);
      }
      lines.push("");
    }

    // Reusable snippets
    const snippets = memories.filter(m => m.type === "snippet");
    if (snippets.length > 0) {
      lines.push("### Reusable Code Patterns");
      for (const m of snippets.slice(0, 5)) {
        lines.push(`- [${m.category || "general"}] ${m.content}`);
      }
      lines.push("");
    }

    // Project index
    if (projects.length > 0) {
      lines.push("### Previously Built Projects");
      for (const p of projects) {
        const stack = Array.isArray(p.stack) ? p.stack.join(", ") : p.stack || "";
        const url = p.published_url ? ` → ${p.published_url}` : "";
        lines.push(`- ${p.name}: ${p.description || "no description"}${stack ? ` [${stack}]` : ""}${url}`);
        if (p.lessons) lines.push(`  lessons: ${p.lessons}`);
      }
      lines.push("");
    }

    // Conversation history
    if (history.length > 0) {
      lines.push("### This Project's Build History");
      for (const msg of history) {
        const label = msg.role === "user" ? "User" : "Claude";
        lines.push(`${label}: ${msg.content.slice(0, 200)}${msg.content.length > 200 ? "..." : ""}`);
      }
      lines.push("");
    }

    lines.push("---");
    lines.push("Use the above to inform this build. Apply learned preferences automatically.");
    lines.push("Reference previous projects when relevant. Avoid documented mistakes.");
    lines.push("");

    return lines.join("\n");

  } catch (err) {
    // Memory is enhancement, not requirement — never block a build
    console.error("[brain] buildContext failed:", err.message);
    return "";
  }
}

// ── Memory extraction ─────────────────────────────────────────────────────────

/**
 * Extract and store memory after a successful build.
 * Call this after the workspace runner confirms APP RUNNING.
 * 
 * @param {object} opts
 * @param {string} opts.projectId
 * @param {string} opts.projectName
 * @param {string} opts.userRequest    - original plain English request
 * @param {string} opts.buildSummary   - Claude's summary field from the build
 * @param {Array}  opts.files          - files array from the build output
 * @param {string|null} opts.publishedUrl
 */
async function extractMemory({ projectId, projectName, userRequest, buildSummary, files, publishedUrl = null }) {
  const sql = getDb();
  const ai = getAI();
  const now = Date.now();

  try {
    // Ask Claude to analyze the build and extract structured memory
    const fileList = files.map(f => f.path).join(", ");
    const serverContent = files.find(f => f.path === "server.js")?.content?.slice(0, 3000) || "";

    const response = await ai.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      system: `You are a memory extraction system for ForgeOS. 
Analyze completed builds and extract reusable knowledge.
Return ONLY valid JSON. No markdown fences. No prose.`,
      messages: [{
        role: "user",
        content: `Analyze this ForgeOS build and extract memory.

User requested: ${userRequest}
Build summary: ${buildSummary}
Files built: ${fileList}
Server.js excerpt: ${serverContent}

Return JSON:
{
  "description": "one sentence what this app does",
  "stack": ["list", "of", "technologies", "used"],
  "patterns": [
    "reusable architectural pattern worth remembering"
  ],
  "mistakes_avoided": [
    "anything that was done correctly that often goes wrong"
  ],
  "preferences_inferred": [
    { "key": "preference_name", "value": "preference_value" }
  ],
  "snippets": [
    { "category": "auth|database|api|ui|deployment", "content": "reusable pattern description" }
  ],
  "lessons": "one sentence about what worked or what to do differently"
}`
      }]
    });

    let extracted;
    try {
      let text = response.content[0].text;
      if (text.includes("```")) {
        text = text.replace(/^```(?:json)?\s*/m, "").replace(/\s*```$/m, "");
      }
      const firstBrace = text.search(/[{[]/);
      if (firstBrace > 0) text = text.slice(firstBrace);
      extracted = JSON.parse(text);
    } catch (parseErr) {
      console.error("[brain] Failed to parse memory extraction:", parseErr.message);
      // Store minimal record and move on
      extracted = {
        description: buildSummary,
        stack: [],
        patterns: [],
        mistakes_avoided: [],
        preferences_inferred: [],
        snippets: [],
        lessons: null,
      };
    }

    // ── Store project index entry ─────────────────────────────────────────────
    await sql`
      INSERT INTO forge_project_index
        (project_id, name, description, stack, lessons, file_count, published_url, built_at, updated_at)
      VALUES
        (${projectId}, ${projectName}, ${extracted.description},
         ${extracted.stack}, ${extracted.lessons || null},
         ${files.length}, ${publishedUrl}, ${now}, ${now})
      ON CONFLICT (project_id) DO UPDATE SET
        description  = ${extracted.description},
        stack        = ${extracted.stack},
        lessons      = ${extracted.lessons || null},
        file_count   = ${files.length},
        published_url = COALESCE(${publishedUrl}, forge_project_index.published_url),
        updated_at   = ${now}
    `;

    // ── Store patterns ────────────────────────────────────────────────────────
    for (const pattern of (extracted.patterns || [])) {
      if (!pattern || pattern.length < 10) continue;
      await sql`
        INSERT INTO forge_memory (type, category, content, source_project_id, created_at)
        VALUES ('pattern', 'general', ${pattern}, ${projectId}, ${now})
      `;
    }

    // ── Store snippets ────────────────────────────────────────────────────────
    for (const snippet of (extracted.snippets || [])) {
      if (!snippet?.content || snippet.content.length < 10) continue;
      await sql`
        INSERT INTO forge_memory (type, category, content, source_project_id, created_at)
        VALUES ('snippet', ${snippet.category || 'general'}, ${snippet.content}, ${projectId}, ${now})
      `;
    }

    // ── Store/update team preferences ─────────────────────────────────────────
    for (const pref of (extracted.preferences_inferred || [])) {
      if (!pref?.key || !pref?.value) continue;
      await sql`
        INSERT INTO forge_team_prefs (key, value, confidence, updated_at)
        VALUES (${pref.key}, ${pref.value}, 1, ${now})
        ON CONFLICT (key) DO UPDATE SET
          value      = ${pref.value},
          confidence = forge_team_prefs.confidence + 1,
          updated_at = ${now}
      `;
    }

    console.log(`[brain] Memory extracted for project ${projectId}: ${extracted.stack?.join(", ")}`);
    return extracted;

  } catch (err) {
    console.error("[brain] extractMemory failed:", err.message);
    // Non-fatal — build succeeded, memory extraction is bonus
  }
}

// ── Mistake recording ─────────────────────────────────────────────────────────

/**
 * Record a mistake after a failed build iteration.
 * Call this when the runner reports APP FAILED or the auditor rejects.
 * 
 * @param {string} errorDescription - what went wrong
 * @param {string} category         - ui | auth | database | api | deployment
 * @param {string|null} projectId
 */
async function recordMistake(errorDescription, category = "general", projectId = null) {
  const sql = getDb();
  const now = Date.now();

  try {
    // Don't store duplicate mistakes
    const existing = await sql`
      SELECT id FROM forge_memory
      WHERE type = 'mistake'
      AND content = ${errorDescription}
      LIMIT 1
    `;

    if (existing.length > 0) {
      // Mistake already known — increment usefulness to surface it more
      await sql`
        UPDATE forge_memory
        SET usefulness_score = usefulness_score + 1,
            last_used_at = ${now}
        WHERE id = ${existing[0].id}
      `;
    } else {
      await sql`
        INSERT INTO forge_memory
          (type, category, content, source_project_id, usefulness_score, created_at)
        VALUES
          ('mistake', ${category}, ${errorDescription}, ${projectId}, 1, ${now})
      `;
    }

    console.log(`[brain] Mistake recorded: ${errorDescription.slice(0, 80)}`);
  } catch (err) {
    console.error("[brain] recordMistake failed:", err.message);
  }
}

// ── Conversation history ──────────────────────────────────────────────────────

/**
 * Append a message to the conversation history for a project.
 * Call after every user message and every Claude response.
 */
async function appendConversation(projectId, role, content) {
  const sql = getDb();
  try {
    await sql`
      INSERT INTO forge_conversations (project_id, role, content, created_at)
      VALUES (${projectId}, ${role}, ${content}, ${Date.now()})
    `;
  } catch (err) {
    console.error("[brain] appendConversation failed:", err.message);
  }
}

/**
 * Get full conversation history for a project.
 * Returns array of { role, content } ready to pass to Claude messages array.
 */
async function getConversation(projectId, limit = 50) {
  const sql = getDb();
  try {
    const rows = await sql`
      SELECT role, content
      FROM forge_conversations
      WHERE project_id = ${projectId}
      ORDER BY created_at ASC
      LIMIT ${limit}
    `;
    return rows.map(r => ({ role: r.role, content: r.content }));
  } catch {
    return [];
  }
}

// ── Memory management ─────────────────────────────────────────────────────────

/**
 * Upvote a memory entry — call when user approves a build or explicitly
 * says something worked well. Surfaces that memory more prominently.
 */
async function upvoteMemory(memoryId) {
  const sql = getDb();
  await sql`
    UPDATE forge_memory
    SET usefulness_score = usefulness_score + 2,
        last_used_at = ${Date.now()}
    WHERE id = ${memoryId}
  `;
}

/**
 * Get a summary of what the brain currently knows.
 * Useful for a "Brain" tab in the ForgeOS cockpit.
 */
async function getBrainSummary() {
  const sql = getDb();
  try {
    const [memoryCounts] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE type = 'pattern')    AS patterns,
        COUNT(*) FILTER (WHERE type = 'mistake')    AS mistakes,
        COUNT(*) FILTER (WHERE type = 'snippet')    AS snippets,
        COUNT(*) FILTER (WHERE type = 'preference') AS preferences
      FROM forge_memory
    `;

    const [projectCount] = await sql`SELECT COUNT(*) AS total FROM forge_project_index`;
    const [prefCount]    = await sql`SELECT COUNT(*) AS total FROM forge_team_prefs`;

    const topMistakes = await sql`
      SELECT content, usefulness_score
      FROM forge_memory
      WHERE type = 'mistake'
      ORDER BY usefulness_score DESC
      LIMIT 5
    `;

    const recentProjects = await sql`
      SELECT name, description, stack, published_url
      FROM forge_project_index
      ORDER BY built_at DESC
      LIMIT 5
    `;

    return {
      totals: {
        projects:    parseInt(projectCount.total),
        preferences: parseInt(prefCount.total),
        patterns:    parseInt(memoryCounts.patterns),
        mistakes:    parseInt(memoryCounts.mistakes),
        snippets:    parseInt(memoryCounts.snippets),
      },
      topMistakes,
      recentProjects,
    };
  } catch (err) {
    console.error("[brain] getBrainSummary failed:", err.message);
    return null;
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

async function updatePublishedUrl(projectId, projectName, publishedUrl) {
  const sql = getDb();
  const now = Date.now();
  try {
    await sql`
      INSERT INTO forge_project_index
        (project_id, name, description, stack, lessons, file_count, published_url, built_at, updated_at)
      VALUES
        (${projectId}, ${projectName}, NULL, NULL, NULL, 0, ${publishedUrl}, ${now}, ${now})
      ON CONFLICT (project_id) DO UPDATE SET
        published_url = ${publishedUrl},
        updated_at    = ${now}
    `;
    console.log(`[brain] Published URL recorded for ${projectId}: ${publishedUrl}`);
  } catch (err) {
    console.error("[brain] updatePublishedUrl failed:", err.message);
  }
}

module.exports = {
  ensureSchema,
  buildContext,
  extractMemory,
  recordMistake,
  appendConversation,
  getConversation,
  upvoteMemory,
  getBrainSummary,
  updatePublishedUrl,
};
