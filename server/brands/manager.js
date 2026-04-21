"use strict";

// ── Brand Profiles ────────────────────────────────────────────────────────────
// A Brand is a reusable design + voice profile scraped from a live website.
// Projects associate with brands many-to-many via forge_project_brands.
// At chat time, every brand linked to a project has its profile concatenated
// and injected into Frank's system prompt as "## BRAND PROFILES".
//
// Storage: Neon. The profile markdown lives in the DB so it's editable,
// shareable across projects, and doesn't pollute app branches.

const { neon } = require("@neondatabase/serverless");

const dbUrl = process.env.NEON_DATABASE_URL;
const sql = dbUrl ? neon(dbUrl) : null;

// ── Schema ────────────────────────────────────────────────────────────────────

async function ensureSchema() {
  if (!sql) return;
  try {
    await sql`CREATE TABLE IF NOT EXISTS forge_brands (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      urls JSONB NOT NULL DEFAULT '[]'::jsonb,
      profile TEXT DEFAULT '',
      last_scraped_at BIGINT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )`;

    // Many-to-many join. project_id stays VARCHAR(8) to match projects.id.
    // ON DELETE CASCADE on both sides keeps the table self-cleaning.
    await sql`CREATE TABLE IF NOT EXISTS forge_project_brands (
      project_id VARCHAR(8) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      brand_id   INTEGER    NOT NULL REFERENCES forge_brands(id) ON DELETE CASCADE,
      created_at BIGINT     NOT NULL,
      PRIMARY KEY (project_id, brand_id)
    )`;

    await sql`CREATE INDEX IF NOT EXISTS forge_project_brands_brand_idx
      ON forge_project_brands (brand_id)`;
  } catch (err) {
    console.error("[brands] Schema error:", err.message);
  }
}

// ── CRUD (brands) ─────────────────────────────────────────────────────────────

function toBrand(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    urls: Array.isArray(row.urls) ? row.urls : [],
    profile: row.profile || "",
    lastScrapedAt: row.last_scraped_at ? Number(row.last_scraped_at) : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

async function getAllBrands() {
  if (!sql) return [];
  await ensureSchema();
  try {
    const rows = await sql`SELECT * FROM forge_brands ORDER BY name ASC`;
    return rows.map(toBrand);
  } catch (err) {
    console.error("[brands] getAllBrands failed:", err.message);
    return [];
  }
}

async function getBrand(id) {
  if (!sql) return null;
  await ensureSchema();
  try {
    const rows = await sql`SELECT * FROM forge_brands WHERE id = ${id}`;
    return toBrand(rows[0]);
  } catch (err) {
    console.error("[brands] getBrand failed:", err.message);
    return null;
  }
}

async function createBrand({ name, urls, profile }) {
  if (!sql) return null;
  await ensureSchema();
  const now = Date.now();
  const urlsJson = JSON.stringify(Array.isArray(urls) ? urls : []);
  try {
    const rows = await sql`INSERT INTO forge_brands
      (name, urls, profile, created_at, updated_at)
      VALUES (${name}, ${urlsJson}::jsonb, ${profile || ""}, ${now}, ${now})
      RETURNING *`;
    return toBrand(rows[0]);
  } catch (err) {
    console.error("[brands] createBrand failed:", err.message);
    return null;
  }
}

async function updateBrand(id, { name, urls, profile, lastScrapedAt }) {
  if (!sql) return null;
  await ensureSchema();
  const now = Date.now();
  try {
    const existing = await getBrand(id);
    if (!existing) return null;
    const newName = name ?? existing.name;
    const newUrls = JSON.stringify(urls ?? existing.urls);
    const newProfile = profile ?? existing.profile;
    const newLastScraped = lastScrapedAt ?? existing.lastScrapedAt;
    const rows = await sql`UPDATE forge_brands
      SET name = ${newName},
          urls = ${newUrls}::jsonb,
          profile = ${newProfile},
          last_scraped_at = ${newLastScraped},
          updated_at = ${now}
      WHERE id = ${id}
      RETURNING *`;
    return toBrand(rows[0]);
  } catch (err) {
    console.error("[brands] updateBrand failed:", err.message);
    return null;
  }
}

async function deleteBrand(id) {
  if (!sql) return false;
  await ensureSchema();
  try {
    await sql`DELETE FROM forge_brands WHERE id = ${id}`;
    return true;
  } catch (err) {
    console.error("[brands] deleteBrand failed:", err.message);
    return false;
  }
}

// ── Project ↔ Brand associations ──────────────────────────────────────────────

async function getBrandIdsForProject(projectId) {
  if (!sql || !projectId) return [];
  await ensureSchema();
  try {
    const rows = await sql`SELECT brand_id FROM forge_project_brands
      WHERE project_id = ${projectId} ORDER BY brand_id ASC`;
    return rows.map(r => r.brand_id);
  } catch (err) {
    console.error("[brands] getBrandIdsForProject failed:", err.message);
    return [];
  }
}

async function getBrandsForProject(projectId) {
  if (!sql || !projectId) return [];
  await ensureSchema();
  try {
    const rows = await sql`SELECT b.*
      FROM forge_brands b
      JOIN forge_project_brands pb ON pb.brand_id = b.id
      WHERE pb.project_id = ${projectId}
      ORDER BY b.name ASC`;
    return rows.map(toBrand);
  } catch (err) {
    console.error("[brands] getBrandsForProject failed:", err.message);
    return [];
  }
}

async function setBrandsForProject(projectId, brandIds) {
  if (!sql || !projectId) return [];
  await ensureSchema();
  const ids = Array.isArray(brandIds)
    ? Array.from(new Set(brandIds.map(Number).filter(n => Number.isInteger(n) && n > 0)))
    : [];
  const now = Date.now();
  try {
    await sql`DELETE FROM forge_project_brands WHERE project_id = ${projectId}`;
    for (const bid of ids) {
      await sql`INSERT INTO forge_project_brands (project_id, brand_id, created_at)
        VALUES (${projectId}, ${bid}, ${now})
        ON CONFLICT DO NOTHING`;
    }
    return ids;
  } catch (err) {
    console.error("[brands] setBrandsForProject failed:", err.message);
    return [];
  }
}

async function getProjectsForBrand(brandId) {
  if (!sql) return [];
  await ensureSchema();
  try {
    const rows = await sql`SELECT project_id FROM forge_project_brands
      WHERE brand_id = ${brandId}`;
    return rows.map(r => r.project_id);
  } catch (err) {
    console.error("[brands] getProjectsForBrand failed:", err.message);
    return [];
  }
}

// ── Scraper ───────────────────────────────────────────────────────────────────
// Fetches URLs, strips noise, asks Claude to distill a brand profile.
// Tracks usage in forge_usage (same pattern as the chat handler).

function stripHtml(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, "[svg]")
    .replace(/<!--[\s\S]*?-->/g, "");
}

async function fetchUrlHtml(url) {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "ForgeOS-BrandScraper/1.0" },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { url, ok: false, status: res.status, html: "" };
    const html = await res.text();
    const stripped = stripHtml(html);
    const capped = stripped.length > 40000 ? stripped.slice(0, 40000) + "\n[...truncated]" : stripped;
    return { url, ok: true, status: res.status, html: capped };
  } catch (err) {
    return { url, ok: false, status: 0, html: "", error: err.message };
  }
}

const SCRAPE_PROMPT = `You are extracting a Brand Profile from one or more scraped web pages. Produce a single markdown document with this exact structure — do not omit sections, do not invent new top-level sections, and use real HTML inside the code fences (not escaped).

# Brand Profile: <Brand Name>

Scraped from:
- <url 1>
- <url 2>
Last updated: <use the exact date from the user message>

## Colors
- Primary: #xxxxxx
- Background: #xxxxxx
- Text (body): #xxxxxx
- Text (heading): #xxxxxx
- Accent: #xxxxxx
- Border: #xxxxxx

## Typography
- Display: "Font Name", fallback-stack
- Body: "Font Name", fallback-stack
- Scale: h1 XXpx, h2 XXpx, h3 XXpx, body XXpx

## Nav (verbatim HTML)
\`\`\`html
<nav>...the actual nav block from the page...</nav>
\`\`\`

## Footer (verbatim HTML)
\`\`\`html
<footer>...the actual footer block...</footer>
\`\`\`

## Container Pattern
\`\`\`html
<section class="..."><div class="container">...</div></section>
\`\`\`
Max width: XXXpx. Padding: XXpx vertical, XXpx horizontal.

## Patterns to Preserve
- bullet list of defining design choices (border-radius, uppercase nav, button style, spacing rhythm, etc.)

## Patterns to Avoid
- bullet list of things that would feel off-brand

## Voice
Two or three sentences describing tone (formal vs casual, sentence length, contractions, jargon level). Base this on the longest content block in the sources if available.

## Example Snippet
> one short verbatim passage from the site (2-3 sentences) to anchor the voice.

Rules:
- Output ONLY the markdown document. No preamble. No code fences around the whole thing.
- If a value is genuinely unknowable from the sources, write "unknown" rather than inventing.
- Copy nav/footer/container HTML verbatim from the source — do not rewrite or simplify.
- Infer the brand name from the page title, logo alt text, or copyright line.`;

async function callAnthropic(systemPrompt, userContent, anthropicKey) {
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic.default({ apiKey: anthropicKey });
  const resp = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 8000,
    system: systemPrompt,
    messages: [{ role: "user", content: userContent }],
  });
  const text = resp.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  const inputTokens = resp.usage?.input_tokens || 0;
  const outputTokens = resp.usage?.output_tokens || 0;
  // claude-opus-4-7: $5/M input, $25/M output
  const cost = (inputTokens / 1_000_000) * 5 + (outputTokens / 1_000_000) * 25;
  return { text, inputTokens, outputTokens, cost };
}

async function recordUsage({ inputTokens, outputTokens, cost, projectId }) {
  if (!sql) return;
  try {
    await sql`INSERT INTO forge_usage (model, input_tokens, output_tokens, cost_usd, project_id, created_at)
      VALUES (${"claude-opus-4-7"}, ${inputTokens}, ${outputTokens}, ${cost}, ${projectId || null}, ${Date.now()})`;
  } catch (err) {
    console.error("[brands] recordUsage failed:", err.message);
  }
}

async function scrapeProfile({ name, urls, anthropicKey }) {
  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    throw new Error("At least one URL is required");
  }
  if (!anthropicKey) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }

  const fetched = await Promise.all(urls.slice(0, 3).map(fetchUrlHtml));
  const successful = fetched.filter((f) => f.ok && f.html);
  if (successful.length === 0) {
    const errs = fetched.map((f) => `${f.url}: ${f.error || "HTTP " + f.status}`).join("; ");
    throw new Error("All URL fetches failed: " + errs);
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const blocks = successful.map((f, i) => `### Source ${i + 1}: ${f.url}\n\n${f.html}`).join("\n\n---\n\n");
  const userContent = `Brand name hint: ${name || "(infer from the pages)"}\nToday's date (use this verbatim in the "Last updated" field): ${today}\n\nScraped pages:\n\n${blocks}`;

  const { text, inputTokens, outputTokens, cost } = await callAnthropic(SCRAPE_PROMPT, userContent, anthropicKey);
  await recordUsage({ inputTokens, outputTokens, cost, projectId: null });

  return {
    profile: text.trim(),
    fetchedUrls: successful.map((f) => f.url),
    failedUrls: fetched.filter((f) => !f.ok).map((f) => ({ url: f.url, error: f.error || "HTTP " + f.status })),
    tokens: { input: inputTokens, output: outputTokens, cost },
  };
}

module.exports = {
  ensureSchema,
  getAllBrands,
  getBrand,
  createBrand,
  updateBrand,
  deleteBrand,
  getBrandIdsForProject,
  getBrandsForProject,
  setBrandsForProject,
  getProjectsForBrand,
  scrapeProfile,
};
