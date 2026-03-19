"use strict";

const { neon } = require("@neondatabase/serverless");
const Anthropic = require("@anthropic-ai/sdk");

function getDb() {
  if (!process.env.NEON_DATABASE_URL) throw new Error("NEON_DATABASE_URL not set");
  return neon(process.env.NEON_DATABASE_URL);
}

function getAI() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

const EMBED_MODEL = "voyage-code-3";
const EMBED_DIM = 1024;

async function ensureSchema() {
  const sql = getDb();

  try {
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
  } catch {}

  await sql`
    CREATE TABLE IF NOT EXISTS forge_memory (
      id           SERIAL PRIMARY KEY,
      type         VARCHAR(50)  NOT NULL,
      category     VARCHAR(50),
      content      TEXT         NOT NULL,
      source_project_id VARCHAR(8),
      usefulness_score  INT DEFAULT 0,
      embedding    vector(1024),
      created_at   BIGINT NOT NULL,
      last_used_at BIGINT
    )
  `;

  try {
    await sql`
      CREATE INDEX IF NOT EXISTS forge_memory_embedding_idx
      ON forge_memory USING hnsw (embedding vector_cosine_ops)
    `;
  } catch {}

  await sql`
    CREATE TABLE IF NOT EXISTS forge_project_index (
      project_id   VARCHAR(8)   PRIMARY KEY,
      name         TEXT         NOT NULL,
      description  TEXT,
      stack        TEXT[],
      lessons      TEXT,
      file_count   INT,
      published_url TEXT,
      embedding    vector(1024),
      built_at     BIGINT NOT NULL,
      updated_at   BIGINT
    )
  `;

  try {
    await sql`
      CREATE INDEX IF NOT EXISTS forge_project_index_embedding_idx
      ON forge_project_index USING hnsw (embedding vector_cosine_ops)
    `;
  } catch {}

  await sql`
    CREATE TABLE IF NOT EXISTS forge_team_prefs (
      key          VARCHAR(100) PRIMARY KEY,
      value        TEXT         NOT NULL,
      confidence   INT DEFAULT 1,
      updated_at   BIGINT NOT NULL
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS forge_conversations (
      id           SERIAL PRIMARY KEY,
      project_id   VARCHAR(8)   NOT NULL,
      role         VARCHAR(20)  NOT NULL,
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

async function generateEmbedding(text) {
  const apiKey = process.env.VOYAGERAI_API_KEY;
  if (!apiKey) return null;

  try {
    const truncated = text.slice(0, 8000);
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EMBED_MODEL,
        input: [truncated],
        input_type: "document",
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error(`[brain] Voyage API error ${res.status}: ${errText.slice(0, 200)}`);
      return null;
    }

    const data = await res.json();
    const vec = data?.data?.[0]?.embedding;
    if (!vec || vec.length !== EMBED_DIM) {
      console.error(`[brain] Unexpected embedding dimension: ${vec?.length}`);
      return null;
    }
    return vec;
  } catch (err) {
    console.error("[brain] generateEmbedding failed:", err.message);
    return null;
  }
}

async function generateQueryEmbedding(text) {
  const apiKey = process.env.VOYAGERAI_API_KEY;
  if (!apiKey) return null;

  try {
    const truncated = text.slice(0, 8000);
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EMBED_MODEL,
        input: [truncated],
        input_type: "query",
      }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

function vecToSql(vec) {
  return `[${vec.join(",")}]`;
}

async function buildContext(userRequest, projectId = null) {
  const sql = getDb();
  const now = Date.now();

  try {
    const prefs = await sql`
      SELECT key, value, confidence
      FROM forge_team_prefs
      ORDER BY confidence DESC, updated_at DESC
    `;

    const projects = await sql`
      SELECT project_id, name, description, stack, lessons, published_url, built_at
      FROM forge_project_index
      ORDER BY built_at DESC
      LIMIT 15
    `;

    let memories = [];
    const queryVec = await generateQueryEmbedding(userRequest);

    if (queryVec) {
      try {
        const vecStr = vecToSql(queryVec);
        memories = await sql`
          SELECT id, type, category, content,
                 1 - (embedding <=> ${vecStr}::vector) AS similarity
          FROM forge_memory
          WHERE embedding IS NOT NULL
            AND usefulness_score >= 0
          ORDER BY embedding <=> ${vecStr}::vector
          LIMIT 20
        `;
      } catch (err) {
        console.error("[brain] Semantic search failed, falling back:", err.message);
      }
    }

    if (memories.length === 0) {
      try {
        memories = await sql`
          SELECT id, type, category, content, 0 AS similarity
          FROM forge_memory
          WHERE usefulness_score >= 0
          ORDER BY usefulness_score DESC, last_used_at DESC NULLS LAST
          LIMIT 30
        `;
      } catch {}
    }

    if (memories.length > 0) {
      const ids = memories.map(m => m.id);
      await sql`
        UPDATE forge_memory
        SET last_used_at = ${now}
        WHERE id = ANY(${ids})
      `.catch(() => {});
    }

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

    const lines = ["## FORGEOS BRAIN — Persistent Team Memory", ""];

    if (prefs.length > 0) {
      lines.push("### Team Preferences (learned from past builds)");
      for (const p of prefs) {
        lines.push(`- ${p.key}: ${p.value}${p.confidence > 2 ? " [strong preference]" : ""}`);
      }
      lines.push("");
    }

    const patterns = memories.filter(m => m.type === "pattern" || m.type === "solution");
    if (patterns.length > 0) {
      lines.push("### Patterns That Worked");
      for (const m of patterns.slice(0, 20)) {
        const sim = m.similarity > 0 ? ` (relevance: ${(m.similarity * 100).toFixed(0)}%)` : "";
        lines.push(`- [${m.category || "general"}] ${m.content}${sim}`);
      }
      lines.push("");
    }

    const mistakes = memories.filter(m => m.type === "mistake");
    if (mistakes.length > 0) {
      lines.push("### Mistakes to Avoid (learned from failed iterations)");
      for (const m of mistakes.slice(0, 15)) {
        lines.push(`- ${m.content}`);
      }
      lines.push("");
    }

    const snippets = memories.filter(m => m.type === "snippet");
    if (snippets.length > 0) {
      lines.push("### Reusable Code Patterns");
      for (const m of snippets.slice(0, 10)) {
        lines.push(`- [${m.category || "general"}] ${m.content}`);
      }
      lines.push("");
    }

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
    console.error("[brain] buildContext failed:", err.message);
    return "";
  }
}

async function extractMemory({ projectId, projectName, userRequest, buildSummary, files, publishedUrl = null }) {
  const sql = getDb();
  const ai = getAI();
  const now = Date.now();

  try {
    const fileList = files.map(f => f.path).join(", ");
    const serverContent = files.find(f => f.path === "server.js")?.content || "";

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

    const projectText = `${projectName}: ${extracted.description || ""}. Stack: ${(extracted.stack || []).join(", ")}. Lessons: ${extracted.lessons || "none"}`;
    const projectVec = await generateEmbedding(projectText);

    await sql`
      INSERT INTO forge_project_index
        (project_id, name, description, stack, lessons, file_count, published_url, embedding, built_at, updated_at)
      VALUES
        (${projectId}, ${projectName}, ${extracted.description},
         ${extracted.stack}, ${extracted.lessons || null},
         ${files.length}, ${publishedUrl},
         ${projectVec ? vecToSql(projectVec) : null}::vector,
         ${now}, ${now})
      ON CONFLICT (project_id) DO UPDATE SET
        description  = ${extracted.description},
        stack        = ${extracted.stack},
        lessons      = ${extracted.lessons || null},
        file_count   = ${files.length},
        published_url = COALESCE(${publishedUrl}, forge_project_index.published_url),
        embedding    = ${projectVec ? vecToSql(projectVec) : null}::vector,
        updated_at   = ${now}
    `;

    for (const pattern of (extracted.patterns || [])) {
      if (!pattern || pattern.length < 10) continue;
      const vec = await generateEmbedding(pattern);
      await sql`
        INSERT INTO forge_memory (type, category, content, source_project_id, embedding, created_at)
        VALUES ('pattern', 'general', ${pattern}, ${projectId}, ${vec ? vecToSql(vec) : null}::vector, ${now})
      `;
    }

    for (const snippet of (extracted.snippets || [])) {
      if (!snippet?.content || snippet.content.length < 10) continue;
      const vec = await generateEmbedding(`${snippet.category}: ${snippet.content}`);
      await sql`
        INSERT INTO forge_memory (type, category, content, source_project_id, embedding, created_at)
        VALUES ('snippet', ${snippet.category || 'general'}, ${snippet.content}, ${projectId}, ${vec ? vecToSql(vec) : null}::vector, ${now})
      `;
    }

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
  }
}

async function recordMistake(errorDescription, category = "general", projectId = null) {
  const sql = getDb();
  const now = Date.now();

  try {
    const existing = await sql`
      SELECT id FROM forge_memory
      WHERE type = 'mistake'
      AND content = ${errorDescription}
      LIMIT 1
    `;

    if (existing.length > 0) {
      await sql`
        UPDATE forge_memory
        SET usefulness_score = usefulness_score + 1,
            last_used_at = ${now}
        WHERE id = ${existing[0].id}
      `;
    } else {
      const vec = await generateEmbedding(`mistake: ${errorDescription}`);
      await sql`
        INSERT INTO forge_memory
          (type, category, content, source_project_id, usefulness_score, embedding, created_at)
        VALUES
          ('mistake', ${category}, ${errorDescription}, ${projectId}, 1, ${vec ? vecToSql(vec) : null}::vector, ${now})
      `;
    }

    console.log(`[brain] Mistake recorded: ${errorDescription.slice(0, 80)}`);
  } catch (err) {
    console.error("[brain] recordMistake failed:", err.message);
  }
}

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

// Returns the last 10 turns. If there are older turns beyond the window,
// summarizes them into a project history block and stores it on the project,
// then trims the DB rows so they don't accumulate unbounded.
async function getConversation(projectId, limit = 10) {
  const sql = getDb();
  try {
    const rows = await sql`
      SELECT id, role, content
      FROM forge_conversations
      WHERE project_id = ${projectId}
      ORDER BY created_at ASC
    `;

    if (rows.length <= limit) {
      return rows.map(r => ({ role: r.role, content: r.content }));
    }

    // There are turns beyond the window — summarize the overflow and trim
    const overflow = rows.slice(0, rows.length - limit);
    const window = rows.slice(rows.length - limit);

    await summarizeAndTrimConversation(projectId, overflow, sql);

    return window.map(r => ({ role: r.role, content: r.content }));
  } catch {
    return [];
  }
}

async function summarizeAndTrimConversation(projectId, overflowRows, sql) {
  const ai = getAI();
  try {
    const transcript = overflowRows
      .map(r => `${r.role.toUpperCase()}: ${r.content}`)
      .join("\n\n");

    const response = await ai.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      system: `You are a project history summarizer for ForgeOS.
Compress a conversation transcript into a concise project history entry.
Focus on: what was built or changed, key decisions made, errors encountered, and outcomes.
Return ONLY a plain text paragraph. No JSON. No markdown. No headers.`,
      messages: [{
        role: "user",
        content: `Summarize this ForgeOS project conversation into a brief history entry:\n\n${transcript}`,
      }]
    });

    const summary = response.content[0].text.trim();

    // Append to existing project_history in DB
    await sql`
      UPDATE projects
      SET project_history = COALESCE(project_history || E'\n\n' || ${summary}, ${summary}),
          updated_at = ${Date.now()}
      WHERE id = ${projectId}
    `;

    // Trim overflow rows from DB
    const overflowIds = overflowRows.map(r => r.id);
    await sql`
      DELETE FROM forge_conversations
      WHERE id = ANY(${overflowIds}::int[])
    `;

    console.log(`[brain] Summarized ${overflowRows.length} turns into project history for ${projectId}`);
  } catch (err) {
    console.error("[brain] summarizeAndTrimConversation failed:", err.message);
  }
}

async function getProjectHistory(projectId) {
  const sql = getDb();
  try {
    const rows = await sql`
      SELECT project_history FROM projects WHERE id = ${projectId}
    `;
    return rows[0]?.project_history || null;
  } catch {
    return null;
  }
}

// Called after any build failure (build-failed, install-failed, start-failed).
// Uses haiku to extract a structured failure memory entry for Brain.
async function extractFailureMemory({ projectId, prompt, errorMessage, failureStage }) {
  const ai = getAI();
  const now = Date.now();
  try {
    const response = await ai.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system: `You are a failure analysis system for ForgeOS.
Analyze a failed build and extract a reusable lesson.
Return ONLY valid JSON. No markdown fences. No prose.`,
      messages: [{
        role: "user",
        content: `A ForgeOS build failed. Extract a lesson.

Stage: ${failureStage}
User prompt: ${prompt.slice(0, 200)}
Error: ${errorMessage.slice(0, 300)}

Return JSON:
{
  "lesson": "one sentence — what went wrong and how to avoid it",
  "category": "build|deployment|dependency|syntax|runtime"
}`,
      }]
    });

    let parsed;
    try {
      let text = response.content[0].text;
      if (text.includes("```")) text = text.replace(/^```(?:json)?\s*/m, "").replace(/\s*```$/m, "");
      const firstBrace = text.search(/[{[]/);
      if (firstBrace > 0) text = text.slice(firstBrace);
      parsed = JSON.parse(text);
    } catch {
      parsed = { lesson: `${failureStage} failure: ${errorMessage.slice(0, 150)}`, category: "build" };
    }

    await recordMistake(parsed.lesson, parsed.category || "build", projectId);
    console.log(`[brain] Failure memory extracted (${failureStage}): ${parsed.lesson.slice(0, 80)}`);
  } catch (err) {
    console.error("[brain] extractFailureMemory failed:", err.message);
  }
}

async function upvoteMemory(memoryId) {
  const sql = getDb();
  await sql`
    UPDATE forge_memory
    SET usefulness_score = usefulness_score + 2,
        last_used_at = ${Date.now()}
    WHERE id = ${memoryId}
  `;
}

async function getBrainSummary() {
  const sql = getDb();
  try {
    const [memoryCounts] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE type = 'pattern')    AS patterns,
        COUNT(*) FILTER (WHERE type = 'mistake')    AS mistakes,
        COUNT(*) FILTER (WHERE type = 'snippet')    AS snippets,
        COUNT(*) FILTER (WHERE type = 'preference') AS preferences,
        COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS embedded
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
        embedded:    parseInt(memoryCounts.embedded),
      },
      topMistakes,
      recentProjects,
    };
  } catch (err) {
    console.error("[brain] getBrainSummary failed:", err.message);
    return null;
  }
}

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
  extractFailureMemory,
  recordMistake,
  appendConversation,
  getConversation,
  getProjectHistory,
  upvoteMemory,
  getBrainSummary,
  updatePublishedUrl,
};

