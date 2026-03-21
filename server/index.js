const express = require("express");
const path = require("path");
const brain = require("./memory/brain");
const publishManager = require("./publish/manager");

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3001;

app.use(express.json());
// ---------------------------------------------------------------------------
// Wildcard subdomain proxy — *.forge-os.ai → Render service
// ---------------------------------------------------------------------------
app.use(async (req, res, next) => {
  const host = req.hostname; // e.g. "my-app.forge-os.ai"
  const baseDomain = process.env.BASE_DOMAIN || "forge-os.ai";
  if (!host || !host.endsWith(`.${baseDomain}`)) return next();
  if (host === baseDomain || host === `www.${baseDomain}`) return next();
  const slug = host.slice(0, host.length - baseDomain.length - 1);
  if (!slug) return next();

  const pubApp = publishManager.getPublishedAppBySlug(slug);
  if (!pubApp?.renderUrl) {
    return res.status(503).send(`<html><body style="background:#111;color:#e0e0e0;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h1>App Offline</h1><p>${slug} is not published.</p></div></body></html>`);
  }

  // Proxy to Render service
  const targetUrl = new URL(req.originalUrl, pubApp.renderUrl);
  const fetchHeaders = { ...req.headers, host: new URL(pubApp.renderUrl).hostname };
  // Strip headers that cause issues with Cloudflare/Render when proxying
  delete fetchHeaders["accept-encoding"];
  fetchHeaders["accept-encoding"] = "identity";
  delete fetchHeaders["content-length"]; // recalculated after body re-encoding
  fetchHeaders["cache-control"] = "no-store, no-cache";
  fetchHeaders["pragma"] = "no-cache";
  delete fetchHeaders["cf-connecting-ip"];
  delete fetchHeaders["cf-ipcountry"];
  delete fetchHeaders["cf-ray"];
  delete fetchHeaders["cf-visitor"];
  delete fetchHeaders["x-forwarded-proto"];
  delete fetchHeaders["x-forwarded-for"];
  delete fetchHeaders["cdn-loop"];

  // Preserve original content-type — do NOT force JSON serialization.
  // Form submissions (application/x-www-form-urlencoded) must be re-encoded
  // as form data, not JSON, or the receiving server won't parse them correctly.
  let proxyBody = undefined;
  if (!["GET", "HEAD"].includes(req.method)) {
    const ct = (req.headers["content-type"] || "").toLowerCase();
    if (ct.includes("application/json")) {
      proxyBody = JSON.stringify(req.body);
      fetchHeaders["content-type"] = "application/json";
    } else if (ct.includes("application/x-www-form-urlencoded")) {
      proxyBody = new URLSearchParams(req.body).toString();
      fetchHeaders["content-type"] = "application/x-www-form-urlencoded";
    } else if (ct.includes("multipart/form-data")) {
      // Multipart must be piped raw — cannot be reconstructed
      // Fall through to undefined and let it fail gracefully
      proxyBody = undefined;
    } else {
      proxyBody = JSON.stringify(req.body);
    }
  }

  try {
    const response = await fetch(targetUrl.toString(), {
      method: req.method,
      headers: fetchHeaders,
      body: proxyBody,
      duplex: "half",
      redirect: "manual", // never follow redirects — forward them to the browser as-is
    });
    res.status(response.status);
    for (const [key, value] of response.headers.entries()) {
      if (["transfer-encoding", "connection"].includes(key.toLowerCase())) continue;
      // Rewrite redirect Location headers — replace Render URL with proxy URL
      if (key.toLowerCase() === "location") {
        const renderBase = pubApp.renderUrl.replace(/\/$/, "");
        const proxyBase = `${req.protocol}://${req.get("host")}`;
        res.setHeader("location", value.replace(renderBase, proxyBase));
        continue;
      }
      res.setHeader(key, value);
    }
    // SSE and streaming responses must be piped — never buffered.
    // arrayBuffer() waits for the full response before sending, killing SSE entirely.
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const isSSE = contentType.includes("text/event-stream");

    if (isSSE) {
      // Pipe SSE directly — each chunk forwarded immediately as it arrives
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-store");
      res.setHeader("x-accel-buffering", "no");
      res.flushHeaders();
      const reader = response.body.getReader();
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) { res.end(); break; }
            res.write(Buffer.from(value));
            if (typeof res.flush === "function") res.flush();
          }
        } catch (err) {
          if (!res.writableEnded) res.end();
        }
      };
      pump();
    } else {
      const body = await response.arrayBuffer();
      res.end(Buffer.from(body));
    }
  } catch (err) {
    console.error(`[subdomain proxy] Error proxying ${slug} ${req.method} ${req.originalUrl}:`, err.message, err.cause?.message || "");
    res.status(502).send("Bad Gateway");
  }
});
// Auth gate removed — no authentication required


app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});



const projectManager = require("./projects/manager");

app.post("/api/projects", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "Prompt is required" });
  }

  const project = await projectManager.createProject(prompt.trim());

  brain.appendConversation(project.id, "user", prompt.trim()).catch(() => {});

  // v2: auto-provision GitHub branch + Render service on project creation.
  // By the time the user sends their first chat message, the branch exists
  // and Render is already watching it. Every push auto-deploys. No Publish button needed.
  let slug = null;
  let renderUrl = null;
  setImmediate(async () => {
    try {
      const result = await publishManager.publishProject(project.id);
      slug = result.slug;
      renderUrl = result.renderUrl;
      console.log(`[projects] Auto-provisioned: ${project.name} → ${renderUrl}`);
      brain.updatePublishedUrl(project.id, project.name, `https://${result.slug}.forge-os.ai`).catch(() => {});
    } catch (err) {
      console.error(`[projects] Auto-provision failed for ${project.id}:`, err.message);
    }
  });

  res.status(201).json({ id: project.id, runId: null, name: project.name, prompt: prompt.trim() });
});

app.get("/api/projects", async (_req, res) => {
  res.json(await projectManager.getAllProjects());
});

app.delete("/api/projects/:id", async (req, res) => {
  const success = await projectManager.deleteProject(req.params.id);
  if (!success) return res.status(404).json({ error: "Project not found" });
  res.json({ success: true });
});

app.patch("/api/projects/:id", async (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "Name is required" });
  }
  const project = await projectManager.renameProject(req.params.id, name.trim());
  if (!project) return res.status(404).json({ error: "Project not found" });
  res.json({ success: true, name: project.name });
});

app.get("/api/projects/:id", async (req, res) => {
  const project = await projectManager.getProject(req.params.id);
  if (!project) {
    return res.status(404).json({ error: "Project not found" });
  }
  res.json({ ...project, iterations: [], currentRun: null });
});

app.get("/api/projects/:id/env", async (req, res) => {
  const project = await projectManager.getProject(req.params.id);
  if (!project) {
    return res.status(404).json({ error: "Project not found" });
  }
  const vars = await projectManager.getEnvVars(req.params.id);
  res.json({ envVars: vars });
});

app.put("/api/projects/:id/env", async (req, res) => {
  const { key, value } = req.body;
  if (!key || typeof key !== "string" || !key.trim()) {
    return res.status(400).json({ error: "Key is required" });
  }
  if (value === undefined || value === null) {
    return res.status(400).json({ error: "Value is required" });
  }
  const cleaned = key.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  if (!cleaned) {
    return res.status(400).json({ error: "Invalid key format" });
  }
  const RESERVED_KEYS = ["PORT", "DATABASE_URL", "NEON_AUTH_JWKS_URL", "JWT_SECRET", "NODE_ENV", "HOME", "PATH", "TERM"];
  if (RESERVED_KEYS.includes(cleaned)) {
    return res.status(400).json({ error: `${cleaned} is a reserved system variable and cannot be overridden` });
  }
  const project = await projectManager.getProject(req.params.id);
  if (!project) {
    return res.status(404).json({ error: "Project not found" });
  }
  const ok = await projectManager.setEnvVar(req.params.id, cleaned, String(value));
  if (!ok) {
    return res.status(500).json({ error: "Failed to save env var" });
  }
  res.json({ key: cleaned, value: String(value) });
});

app.delete("/api/projects/:id/env/:key", async (req, res) => {
  const project = await projectManager.getProject(req.params.id);
  if (!project) {
    return res.status(404).json({ error: "Project not found" });
  }
  const ok = await projectManager.deleteEnvVar(req.params.id, req.params.key);
  if (!ok) {
    return res.status(500).json({ error: "Failed to delete env var" });
  }
  res.json({ deleted: true });
});

app.post("/api/projects/:id/publish", async (req, res) => {
  try {
    const result = await publishManager.publishProject(req.params.id);

    if (result.slug) {
      const project = await projectManager.getProject(req.params.id).catch(() => null);
      if (project) {
        brain.updatePublishedUrl(req.params.id, project.name, `https://${result.slug}.forge-os.ai`)
      }
    }

    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/projects/:id/publish", async (req, res) => {
  try {
    await publishManager.unpublishProject(req.params.id);
    res.json({ unpublished: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/projects/:id/slug", async (req, res) => {
  try {
    const { slug } = req.body;
    if (!slug) return res.status(400).json({ error: "slug is required" });
    const result = await publishManager.renameSlug(req.params.id, slug);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/projects/:id/custom-domain", async (req, res) => {
  try {
    const { domain } = req.body;
    if (!domain) return res.status(400).json({ error: "domain is required" });
    const result = await publishManager.setCustomDomain(req.params.id, domain.trim().toLowerCase());
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/projects/:id/custom-domain", async (req, res) => {
  try {
    const result = await publishManager.deleteCustomDomain(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/projects/:id/versions", async (req, res) => {
  try {
    const versions = await publishManager.listVersions(req.params.id);
    res.json(versions);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/projects/:id/rollback", async (req, res) => {
  try {
    const { tag, commitSha } = req.body;
    if (!tag || !commitSha) return res.status(400).json({ error: "tag and commitSha are required" });
    const result = await publishManager.rollbackToVersion(req.params.id, tag, commitSha);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/projects/:id/publish", async (req, res) => {
  const app = publishManager.getPublishedApp(req.params.id);
  if (!app) return res.json({ published: false });
  res.json({ published: true, ...app });
});

app.get("/api/published", async (_req, res) => {
  res.json(publishManager.listPublishedApps());
});

// ── Brain purge — delete memories matching terms ─────────────────────────────
app.post("/api/brain/purge", async (req, res) => {
  const { terms } = req.body;
  if (!terms || !Array.isArray(terms) || terms.length === 0) {
    return res.status(400).json({ error: "terms array required" });
  }
  try {
    const sql = require("@neondatabase/serverless").neon(process.env.NEON_DATABASE_URL);
    // Build WHERE clause for all terms
    const conditions = terms.map(t => `content ILIKE '%${t.replace(/'/g, "''")}%'`).join(" OR ");
    const countResult = await sql`SELECT COUNT(*) as count FROM forge_memory WHERE ${sql.unsafe(conditions)}`;
    const count = parseInt(countResult[0].count);
    await sql`DELETE FROM forge_memory WHERE ${sql.unsafe(conditions)}`;
    res.json({ deleted: count, terms });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/brain", async (_req, res) => {
  try {
    const summary = await brain.getBrainSummary();
    res.json(summary || { totals: { projects: 0, preferences: 0, patterns: 0, mistakes: 0, snippets: 0 }, topMistakes: [], recentProjects: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/brain/upvote/:id", async (req, res) => {
  try {
    await brain.upvoteMemory(parseInt(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/projects/:id/export", async (req, res) => {
  try {
    const { zipPath, filename } = await publishManager.exportProject(req.params.id);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "application/zip");
    const stream = require("fs").createReadStream(zipPath);
    const cleanup = () => { try { require("fs").unlinkSync(zipPath); } catch {} };
    stream.pipe(res);
    stream.on("end", cleanup);
    stream.on("error", cleanup);
    res.on("close", cleanup);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------
analyticsManager.ensureSchema().catch(err => console.error("[analytics] Schema error:", err.message));

// Ingest events from published app tracker beacons
app.post("/api/analytics/events", async (req, res) => {
  try {
    const { projectId, events } = req.body;
    if (!projectId || !Array.isArray(events)) return res.status(400).json({ error: "Invalid payload" });
    await analyticsManager.ingestEvents(projectId, events);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/analytics/:projectId/overview", async (req, res) => {
  try {
    const data = await analyticsManager.getOverview(req.params.projectId, req.query.range);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/analytics/:projectId/pages", async (req, res) => {
  try {
    const data = await analyticsManager.getTopPages(req.params.projectId, req.query.range);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/analytics/:projectId/events", async (req, res) => {
  try {
    const [top, stream] = await Promise.all([
      analyticsManager.getTopEvents(req.params.projectId, req.query.range),
      analyticsManager.getEventStream(req.params.projectId, req.query.range),
    ]);
    res.json({ top, stream });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/analytics/:projectId/vitals", async (req, res) => {
  try {
    const data = await analyticsManager.getWebVitals(req.params.projectId, req.query.range);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/analytics/:projectId/errors", async (req, res) => {
  try {
    const data = await analyticsManager.getErrors(req.params.projectId, req.query.range);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/analytics/:projectId/devices", async (req, res) => {
  try {
    const data = await analyticsManager.getDeviceBreakdown(req.params.projectId, req.query.range);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/analytics/:projectId/timeseries", async (req, res) => {
  try {
    const data = await analyticsManager.getPageviewTimeseries(req.params.projectId, req.query.range);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/analytics/:projectId/referrers", async (req, res) => {
  try {
    const data = await analyticsManager.getReferrers(req.params.projectId, req.query.range);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/analytics/:projectId/scroll", async (req, res) => {
  try {
    const data = await analyticsManager.getScrollDepth(req.params.projectId, req.query.range);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------
const assetsManager = require("./assets/manager");
assetsManager.ensureSchema().catch(err => console.error("[assets] Schema error:", err.message));

app.get("/api/assets", async (req, res) => {
  try {
    const assets = await assetsManager.listAssets();
    res.json(assets);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/assets", async (req, res) => {
  try {
    const busboy = require("busboy");
    const bb = busboy({ headers: req.headers, limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB limit
    let saved = null;
    bb.on("file", async (name, file, info) => {
      const { filename, mimeType } = info;
      const chunks = [];
      for await (const chunk of file) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      // Always store as base64 — avoids UTF-8 encoding errors for binary files (docx, xlsx, pdf, etc.)
      const content = buffer.toString("base64");
      saved = await assetsManager.saveAsset(filename, mimeType, buffer.length, content);
    });
    bb.on("finish", () => res.json(saved));
    bb.on("error", err => res.status(400).json({ error: err.message }));
    req.pipe(bb);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/assets/:filename", async (req, res) => {
  try {
    const asset = await assetsManager.getAsset(decodeURIComponent(req.params.filename));
    if (!asset) return res.status(404).json({ error: "Asset not found" });
    const buffer = Buffer.from(asset.content, "base64");
    res.setHeader("Content-Type", asset.mimetype);
    res.setHeader("Content-Disposition", `inline; filename="${asset.filename}"`);
    res.end(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/assets/:filename", async (req, res) => {
  try {
    await assetsManager.deleteAsset(decodeURIComponent(req.params.filename));
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const settingsManager = require("./settings/manager");

app.get("/api/diagnostics", async (req, res) => {
  const origin = req.get("origin") || req.get("referer") || "";
  const isInternal = req.headers["x-forge-internal"] === "1" || origin.includes(req.hostname);
  if (!isInternal && req.ip !== "127.0.0.1" && req.ip !== "::1") {
    return res.status(403).json({ error: "Diagnostics only available from the ForgeOS UI" });
  }
  try {
        const { runDiagnostics } = chatManager;
    const projectId = req.query.project_id || null;
    const checks = req.query.checks ? req.query.checks.split(",") : ["all"];
    const report = await runDiagnostics(projectId, checks);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/settings", async (_req, res) => {
  const settings = await settingsManager.getAllSettings();
  res.json(settings);
});

app.put("/api/settings/:key", async (req, res) => {
  const { value } = req.body;
  if (value === undefined || value === null) {
    return res.status(400).json({ error: "Value is required" });
  }
  const ok = await settingsManager.setSetting(req.params.key, value);
  if (!ok) {
    return res.status(500).json({ error: "Failed to save setting" });
  }
  res.json({ key: req.params.key, value });
});

app.get("/api/secrets", async (_req, res) => {
  const keys = await settingsManager.getAllSecretKeys();
  res.json({ secrets: keys });
});

app.put("/api/secrets", async (req, res) => {
  const { key, value } = req.body;
  if (!key || typeof key !== "string" || !key.trim()) {
    return res.status(400).json({ error: "Key is required" });
  }
  if (value === undefined || value === null) {
    return res.status(400).json({ error: "Value is required" });
  }
  const cleaned = key.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  if (!cleaned) {
    return res.status(400).json({ error: "Invalid key format" });
  }
  const reservedKeys = ["PORT", "DATABASE_URL", "NEON_AUTH_JWKS_URL", "JWT_SECRET", "NODE_ENV", "HOME", "PATH", "TERM"];
  if (reservedKeys.includes(cleaned)) {
    return res.status(400).json({ error: `${cleaned} is a reserved system key` });
  }
  const ok = await settingsManager.setSecret(cleaned, String(value));
  if (!ok) {
    return res.status(500).json({ error: "Failed to save secret" });
  }
  res.json({ key: cleaned });
});

app.get("/api/secrets/:key/reveal", async (req, res) => {
  const value = await settingsManager.getSecret(req.params.key);
  if (value === null) {
    return res.status(404).json({ error: "Secret not found" });
  }
  res.json({ key: req.params.key, value });
});

app.delete("/api/secrets/:key", async (req, res) => {
  const ok = await settingsManager.deleteSecret(req.params.key);
  if (!ok) {
    return res.status(500).json({ error: "Failed to delete secret" });
  }
  res.json({ deleted: true });
});

app.get("/api/skills", async (_req, res) => {
  const skills = await settingsManager.getAllSkills();
  res.json({ skills });
});

app.post("/api/skills", async (req, res) => {
  const { name, description, instructions, tags } = req.body;
  if (!name || !instructions) {
    return res.status(400).json({ error: "Name and instructions are required" });
  }
  const skill = await settingsManager.createSkill({ name, description, instructions, tags });
  if (!skill) {
    return res.status(500).json({ error: "Failed to create skill" });
  }
  res.status(201).json(skill);
});

app.put("/api/skills/:id", async (req, res) => {
  const { name, description, instructions, tags } = req.body;
  if (!name || !instructions) {
    return res.status(400).json({ error: "Name and instructions are required" });
  }
  const ok = await settingsManager.updateSkill(parseInt(req.params.id), { name, description, instructions, tags });
  if (!ok) {
    return res.status(500).json({ error: "Failed to update skill" });
  }
  res.json({ updated: true });
});

app.post("/api/skills/import-url", async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: "Please provide a URL" });
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({ error: "Invalid URL format" });
  }

  const host = parsedUrl.hostname;
  let skillContent = null;

  try {
    if (host === "skillsmp.com" || host === "www.skillsmp.com") {
      const pathMatch = parsedUrl.pathname.match(/^\/skills\/([a-z0-9-]+)$/);
      if (!pathMatch) {
        return res.status(400).json({ error: "URL must point to a specific skill page (e.g. https://skillsmp.com/skills/...)" });
      }
      skillContent = await resolveSkillFromSlug(pathMatch[1]);
    } else if (host === "github.com" || host === "www.github.com") {
      skillContent = await resolveSkillFromGitHub(parsedUrl.pathname);
    } else if (host === "raw.githubusercontent.com") {
      skillContent = await resolveSkillFromRawGitHub(parsedUrl.href);
    } else {
      return res.status(400).json({ error: "URL must be from skillsmp.com, github.com, or raw.githubusercontent.com" });
    }

    if (!skillContent) {
      return res.status(422).json({ error: "Could not resolve this skill. The repository may be private, the file may not exist, or the path doesn't contain a valid SKILL.md." });
    }
    const skill = await settingsManager.createSkill({
      name: skillContent.name,
      description: skillContent.description,
      instructions: skillContent.instructions,
      tags: skillContent.tags || "imported",
    });
    if (!skill) {
      return res.status(500).json({ error: "Failed to save imported skill" });
    }
    res.status(201).json(skill);
  } catch (err) {
    console.error("Skill import error:", err.message);
    res.status(500).json({ error: `Import failed: ${err.message}` });
  }
});

async function resolveSkillFromSlug(slug) {
  if (slug.length > 200) return null;
  const parts = slug.replace(/-skill-md$/, "").split("-");
  if (parts.length < 3 || parts.length > 20) return null;

  const githubToken = process.env.GITHUB_TOKEN || "";
  const headers = { "User-Agent": "ForgeOS/1.0", "Accept": "application/vnd.github.v3.raw" };
  if (githubToken) headers["Authorization"] = `token ${githubToken}`;

  let attempts = 0;
  const MAX_ATTEMPTS = 30;

  for (let userEnd = 1; userEnd < Math.min(parts.length - 1, 4); userEnd++) {
    const user = parts.slice(0, userEnd).join("-");
    for (let repoEnd = userEnd + 1; repoEnd < Math.min(parts.length, userEnd + 6); repoEnd++) {
      const repo = parts.slice(userEnd, repoEnd).join("-");
      const pathParts = parts.slice(repoEnd);
      const skillFolder = pathParts.join("-");

      const candidates = [
        `.claude/skills/${skillFolder}/SKILL.md`,
      ];

      if (pathParts.length >= 3 && pathParts[1] === "skills") {
        const prefix = pathParts[0];
        const restFolder = pathParts.slice(2).join("-");
        candidates.unshift(`.${prefix}/skills/${restFolder}/SKILL.md`);
      }
      if (pathParts.length >= 2) {
        const firstSegment = pathParts[0];
        const restFolder = pathParts.slice(1).join("-");
        candidates.push(`.${firstSegment}/skills/${restFolder}/SKILL.md`);
      }

      candidates.push(`.cursor/skills/${skillFolder}/SKILL.md`);
      candidates.push(`skills/${skillFolder}/SKILL.md`);

      for (const filePath of candidates) {
        if (++attempts > MAX_ATTEMPTS) return null;
        try {
          const apiUrl = `https://api.github.com/repos/${user}/${repo}/contents/${filePath}`;
          const resp = await fetch(apiUrl, { headers });
          if (resp.ok) {
            const content = await resp.text();
            return parseSkillMd(content);
          }
        } catch {}
      }
    }
  }
  return null;
}

async function resolveSkillFromGitHub(pathname) {
  const githubToken = process.env.GITHUB_TOKEN || "";
  const headers = { "User-Agent": "ForgeOS/1.0", "Accept": "application/vnd.github.v3.raw" };
  if (githubToken) headers["Authorization"] = `token ${githubToken}`;

  const cleaned = pathname.replace(/^\//, "").replace(/\/(blob|tree)\/[^/]+\//, "/");
  const segments = cleaned.split("/").filter(Boolean);
  if (segments.length < 2) return null;

  const user = segments[0];
  const repo = segments[1];
  const restPath = segments.slice(2).join("/");

  const candidates = [];
  if (restPath) {
    if (restPath.endsWith(".md")) {
      candidates.push(restPath);
    } else {
      candidates.push(`${restPath}/SKILL.md`);
      candidates.push(`${restPath}.md`);
    }
  } else {
    candidates.push(".claude/skills/SKILL.md");
    candidates.push("SKILL.md");
    candidates.push(".cursor/skills/SKILL.md");
  }

  for (const filePath of candidates) {
    try {
      const apiUrl = `https://api.github.com/repos/${user}/${repo}/contents/${filePath}`;
      const resp = await fetch(apiUrl, { headers });
      if (resp.ok) {
        const content = await resp.text();
        const parsed = parseSkillMd(content);
        if (parsed) {
          parsed.tags = (parsed.tags || "imported").replace("skillsmp,", "");
          return parsed;
        }
      }
    } catch {}
  }
  return null;
}

async function resolveSkillFromRawGitHub(rawUrl) {
  const githubToken = process.env.GITHUB_TOKEN || "";
  const headers = { "User-Agent": "ForgeOS/1.0" };
  if (githubToken) headers["Authorization"] = `token ${githubToken}`;

  try {
    const resp = await fetch(rawUrl, { headers });
    if (resp.ok) {
      const content = await resp.text();
      const parsed = parseSkillMd(content);
      if (parsed) {
        parsed.tags = (parsed.tags || "imported").replace("skillsmp,", "");
        return parsed;
      }
    }
  } catch {}
  return null;
}

function parseSkillMd(content) {
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  let name = "";
  let description = "";
  let instructions = "";
  let tags = "skillsmp,imported";

  if (frontmatterMatch) {
    const fm = frontmatterMatch[1];
    const body = frontmatterMatch[2].trim();

    const nameMatch = fm.match(/^name:\s*(.+)$/m);
    name = nameMatch ? nameMatch[1].trim() : "";

    let fullDesc = "";
    const descMatch = fm.match(/description:\s*\|?\s*\n([\s\S]*?)(?=\n[a-z][\w-]*:|\n---)/);
    if (descMatch) {
      fullDesc = descMatch[1].replace(/^\s{2}/gm, "").trim();
    } else {
      const descInline = fm.match(/^description:\s*(.+)$/m);
      fullDesc = descInline ? descInline[1].trim() : "";
    }

    const firstSentenceEnd = fullDesc.search(/\.\s|\.$|\n\s*\n|\n\s*[A-Z]/);
    if (firstSentenceEnd > 0 && firstSentenceEnd < 200) {
      description = fullDesc.substring(0, firstSentenceEnd + 1).trim();
      const remainder = fullDesc.substring(firstSentenceEnd + 1).trim();
      if (remainder) {
        instructions = remainder + "\n\n" + body;
      } else {
        instructions = body;
      }
    } else if (fullDesc.length <= 200) {
      description = fullDesc;
      instructions = body;
    } else {
      description = fullDesc.substring(0, 200).replace(/\s+\S*$/, "") + "...";
      instructions = fullDesc + "\n\n" + body;
    }

    const toolsMatch = fm.match(/^allowed-tools:\s*(.+)$/m);
    if (toolsMatch) {
      instructions = `Allowed Tools: ${toolsMatch[1].trim()}\n\n${instructions}`;
    }

    const tagTokens = name.split(/[-_\s]+/).filter(t => t.length > 2).slice(0, 4);
    if (tagTokens.length > 0) {
      tags = "skillsmp,imported," + tagTokens.join(",");
    }
  } else {
    instructions = content.trim();
    const headingMatch = instructions.match(/^#\s+(.+)$/m);
    name = headingMatch ? headingMatch[1].trim() : "Imported Skill";
  }

  if (!instructions || instructions.length < 20) return null;
  return { name, description, instructions, tags };
}

app.delete("/api/skills/:id", async (req, res) => {
  const ok = await settingsManager.deleteSkill(parseInt(req.params.id));
  if (!ok) {
    return res.status(500).json({ error: "Failed to delete skill" });
  }
  res.json({ deleted: true });
});

// ── HubSpot Integration ──────────────────────────────────────────────────────
const hubspot = require("./integrations/hubspot");

app.get("/api/hubspot/status", async (_req, res) => {
  try {
    const status = await hubspot.getStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/hubspot/contacts", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: "q parameter required" });
    const data = await hubspot.searchContacts(q);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/hubspot/contacts", async (req, res) => {
  try {
    const contact = await hubspot.createContact(req.body);
    res.json(contact);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/hubspot/deals", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: "q parameter required" });
    const data = await hubspot.searchDeals(q);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/hubspot/deals", async (req, res) => {
  try {
    const { properties, associatedContactId } = req.body;
    const deal = await hubspot.createDeal(properties, associatedContactId);
    res.json(deal);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── FORGE CHAT — Direct Anthropic Streaming ──────────────────────────────────
// Claude Code architecture. No agent loop. No nudges. No guards.
// Claude gets tools and a system prompt. It calls tools when it needs to.
// It stops when it is done. We get out of the way.

const Anthropic = require("@anthropic-ai/sdk");

const GITHUB_REPO = "BrianBMorgan/ForgeOS";

function githubHeaders() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN not set");
  return {
    "Authorization": "Bearer " + token,
    "Accept": "application/vnd.github.v3+json",
    "Content-Type": "application/json",
    "User-Agent": "ForgeOS-Agent",
  };
}

const FORGE_TOOLS = [
  {
    name: "github_ls",
    description: "List files in a GitHub branch. Use to explore what exists before writing. Default branch is main.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path to list. Empty string for root." },
        branch: { type: "string", description: "Branch name. Default: main." },
      },
      required: ["path"],
    },
  },
  {
    name: "github_read",
    description: "Read a file from the ForgeOS GitHub repository. Always read before patching.",
    input_schema: {
      type: "object",
      properties: {
        filepath: { type: "string", description: "File path relative to repo root." },
        branch: { type: "string", description: "Branch name. Default: main." },
      },
      required: ["filepath"],
    },
  },
  {
    name: "github_write",
    description: "Write or overwrite a complete file in the GitHub repository. Render auto-deploys on push. Never truncate — always write the complete file.",
    input_schema: {
      type: "object",
      properties: {
        filepath: { type: "string", description: "File path relative to repo root." },
        content: { type: "string", description: "Complete file content — never truncated, never placeholder comments." },
        message: { type: "string", description: "Commit message." },
        branch: { type: "string", description: "Branch name. Default: main." },
      },
      required: ["filepath", "content", "message"],
    },
  },
  {
    name: "github_patch",
    description: "Surgical find-and-replace on a file. Use github_read first to confirm exact strings. Fails if find string not found exactly.",
    input_schema: {
      type: "object",
      properties: {
        filepath: { type: "string", description: "File path relative to repo root." },
        replacements: {
          type: "array",
          description: "List of find/replace pairs to apply in order.",
          items: {
            type: "object",
            properties: {
              find: { type: "string", description: "Exact string to find — character for character." },
              replace: { type: "string", description: "String to replace it with." },
            },
            required: ["find", "replace"],
          },
        },
        message: { type: "string", description: "Commit message." },
        branch: { type: "string", description: "Branch name. Default: main." },
      },
      required: ["filepath", "replacements", "message"],
    },
  },
  {
    name: "render_status",
    description: "Check the deploy status of a Render service and get its live URL.",
    input_schema: {
      type: "object",
      properties: {
        service_id: { type: "string", description: "Render service ID. If unknown, provide slug instead." },
        slug: { type: "string", description: "App slug — used to look up service if service_id is unknown." },
      },
      required: [],
    },
  },
  {
    name: "memory_search",
    description: "Search Brain for relevant patterns, past mistakes, and lessons from previous builds.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for." },
      },
      required: ["query"],
    },
  },
  {
    name: "ask_user",
    description: "Send a message or question to Brian. Use for genuine questions when you cannot proceed, or to report what you shipped.",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Message for Brian." },
      },
      required: ["message"],
    },
  },
];

const FORGE_SYSTEM_PROMPT = `Read the request. Write the code. Commit it. Reply with the SHA.

Your tools: github_ls, github_read, github_write, github_patch, render_status, memory_search, ask_user.

GitHub is your filesystem. Render auto-deploys every push. The apps/<slug> branch and Render service are already provisioned — just write files to apps/<slug> and they go live.

## RULES

- Read before you write
- Write complete files — never truncated, never placeholder comments
- PORT = process.env.PORT || 3000
- CommonJS (require/module.exports) — no ES modules
- @neondatabase/serverless for all databases
- No dotenv — env vars are injected at runtime
- GET / must return complete HTML — not JSON, not a redirect
- Root-relative URLs only — /api/data not http://localhost/api/data
- NEON_DATABASE_URL is reserved — published apps use a custom env var name (e.g. APP_DATABASE_URL)

## ONE RULE

Never describe what you are about to do. Do it. If you wrote code, reply with the commit SHA. Nothing else.`;

async function executeForgeToken(toolName, toolInput, sendEvent) {
  switch (toolName) {

    case "github_ls": {
      try {
        const branch = toolInput.branch || "main";
        const dirPath = toolInput.path || "";
        const res = await fetch("https://api.github.com/repos/" + GITHUB_REPO + "/contents/" + dirPath + "?ref=" + encodeURIComponent(branch), { headers: githubHeaders() });
        const data = await res.json();
        if (!res.ok) return "GitHub error " + res.status + ": " + JSON.stringify(data).slice(0, 200);
        if (!Array.isArray(data)) return "Not a directory";
        return "Branch: " + branch + " | Path: /" + dirPath + "\n" + data.map(function(item) {
          return (item.type === "dir" ? "[dir]  " : "[file] ") + item.name + (item.size ? " (" + item.size + " bytes)" : "");
        }).join("\n");
      } catch (err) { return "github_ls error: " + err.message; }
    }

    case "github_read": {
      try {
        const branch = toolInput.branch || "main";
        const res = await fetch("https://api.github.com/repos/" + GITHUB_REPO + "/contents/" + toolInput.filepath + "?ref=" + encodeURIComponent(branch), { headers: githubHeaders() });
        const data = await res.json();
        if (!res.ok) return "GitHub error " + res.status + ": " + JSON.stringify(data).slice(0, 200);
        return Buffer.from(data.content, "base64").toString("utf-8");
      } catch (err) { return "github_read error: " + err.message; }
    }

    case "github_write": {
      try {
        const branch = toolInput.branch || "main";
        const headers = githubHeaders();
        const shaRes = await fetch("https://api.github.com/repos/" + GITHUB_REPO + "/contents/" + toolInput.filepath + "?ref=" + encodeURIComponent(branch), { headers });
        const shaData = await shaRes.json();
        const currentSha = shaRes.ok ? shaData.sha : null;
        const body = { message: toolInput.message, content: Buffer.from(toolInput.content, "utf-8").toString("base64"), branch };
        if (currentSha) body.sha = currentSha;
        const pushRes = await fetch("https://api.github.com/repos/" + GITHUB_REPO + "/contents/" + toolInput.filepath, { method: "PUT", headers, body: JSON.stringify(body) });
        const pushData = await pushRes.json();
        if (!pushRes.ok) return "GitHub push error " + pushRes.status + ": " + JSON.stringify(pushData).slice(0, 300);
        const commitSha = pushData.commit && pushData.commit.sha ? pushData.commit.sha.slice(0, 7) : "done";
        sendEvent({ type: "tool_status", content: "✓ Written: " + toolInput.filepath });
        return "Pushed " + toolInput.filepath + " to " + branch + " — commit: " + commitSha;
      } catch (err) { return "github_write error: " + err.message; }
    }

    case "github_patch": {
      try {
        const branch = toolInput.branch || "main";
        const headers = githubHeaders();
        const res = await fetch("https://api.github.com/repos/" + GITHUB_REPO + "/contents/" + toolInput.filepath + "?ref=" + encodeURIComponent(branch), { headers });
        const data = await res.json();
        if (!res.ok) return "GitHub error " + res.status + ": " + JSON.stringify(data).slice(0, 200);
        let fileContent = Buffer.from(data.content, "base64").toString("utf-8");
        const sha = data.sha;
        const applied = [], failed = [];
        for (const rep of toolInput.replacements) {
          if (fileContent.includes(rep.find)) { fileContent = fileContent.replace(rep.find, rep.replace); applied.push(rep.find.slice(0, 60)); }
          else failed.push(rep.find.slice(0, 60));
        }
        if (failed.length > 0 && applied.length === 0) return "No replacements found. Failed: " + failed.join("; ");
        const pushRes = await fetch("https://api.github.com/repos/" + GITHUB_REPO + "/contents/" + toolInput.filepath, {
          method: "PUT", headers,
          body: JSON.stringify({ message: toolInput.message, content: Buffer.from(fileContent, "utf-8").toString("base64"), sha, branch }),
        });
        const pushData = await pushRes.json();
        if (!pushRes.ok) return "Push error " + pushRes.status + ": " + JSON.stringify(pushData).slice(0, 200);
        const commitSha = pushData.commit && pushData.commit.sha ? pushData.commit.sha.slice(0, 7) : "done";
        let summary = "Patched " + toolInput.filepath + " — " + applied.length + " replacement(s) — commit: " + commitSha;
        if (failed.length > 0) summary += " | not found: " + failed.join("; ");
        sendEvent({ type: "tool_status", content: "✓ " + summary });
        return summary;
      } catch (err) { return "github_patch error: " + err.message; }
    }

    case "render_status": {
      try {
        const renderKey = process.env.RENDER_API_KEY;
        if (!renderKey) return "RENDER_API_KEY not set";
        let serviceId = toolInput.service_id;
        if (!serviceId && toolInput.slug) {
          const app = publishManager.getPublishedAppBySlug(toolInput.slug);
          if (app && app.renderServiceId) serviceId = app.renderServiceId;
        }
        if (!serviceId) serviceId = "srv-d6h2rt56ubrc73duanfg";
        const res = await fetch("https://api.render.com/v1/services/" + serviceId + "/deploys?limit=1", {
          headers: { "Authorization": "Bearer " + renderKey, "Accept": "application/json" },
        });
        if (!res.ok) return "Render API error " + res.status;
        const deploys = await res.json();
        if (!deploys || !deploys.length) return "No deploys found";
        const deploy = deploys[0].deploy || deploys[0];
        const svcRes = await fetch("https://api.render.com/v1/services/" + serviceId, { headers: { "Authorization": "Bearer " + renderKey, "Accept": "application/json" } });
        let liveUrl = "";
        if (svcRes.ok) { const s = await svcRes.json(); liveUrl = (s.service && s.service.serviceDetails && s.service.serviceDetails.url) || ""; }
        return ["Status: " + deploy.status, deploy.commit ? "Commit: " + deploy.commit.message.slice(0, 80) : "", liveUrl ? "URL: " + liveUrl : ""].filter(Boolean).join("\n");
      } catch (err) { return "render_status error: " + err.message; }
    }

    case "memory_search": {
      try { return await brain.buildContext(toolInput.query) || "No relevant memory found."; }
      catch { return "Memory search unavailable."; }
    }

    case "ask_user":
      sendEvent({ type: "agent_message", content: toolInput.message });
      return "Message sent to user.";

    default:
      return "Unknown tool: " + toolName;
  }
}

app.post("/api/projects/:id/chat", async (req, res) => {
  const { message, skillContext, attachments } = req.body;
  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "Message is required" });
  }

  const project = await projectManager.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });

  // Load conversation history
  let history = [];
  try {
    const rows = await brain.getConversation(project.id, 30);
    history = rows.map(function(r) { return { role: r.role, content: r.content }; });
  } catch {}

  brain.appendConversation(project.id, "user", message.trim()).catch(function() {});

  // SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  function send(evt) { res.write("data: " + JSON.stringify(evt) + "\n\n"); }

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Memory context
    let memoryBlock = "";
    try {
      memoryBlock = await Promise.race([
        brain.buildContext(message.trim(), project.id),
        new Promise(function(_, rej) { setTimeout(function() { rej(new Error("timeout")); }, 4000); }),
      ]);
    } catch {}

    // Build system prompt
    const sysParts = [];
    if (memoryBlock && memoryBlock.trim()) sysParts.push("## RELEVANT MEMORY\n" + memoryBlock.trim());
    if (skillContext) sysParts.push("## SKILL INSTRUCTIONS\n" + skillContext);
    sysParts.push(FORGE_SYSTEM_PROMPT);
    const systemPrompt = sysParts.join("\n\n");

    // Scrub orphaned tool_use blocks from history
    const messages = [];
    for (var i = 0; i < history.length; i++) {
      var msg = history[i];
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        var hasToolUse = msg.content.some(function(b) { return b.type === "tool_use"; });
        if (hasToolUse) {
          var next = history[i + 1];
          var nextHasResult = next && Array.isArray(next.content) && next.content.some(function(b) { return b.type === "tool_result"; });
          if (!nextHasResult) { console.log("[forge] Dropped orphaned tool_use at", i); continue; }
        }
      }
      messages.push({ role: msg.role, content: msg.content });
    }

    // User message — support image attachments
    var userContent;
    if (attachments && attachments.length > 0) {
      userContent = [{ type: "text", text: message.trim() }];
      for (var a = 0; a < attachments.length; a++) {
        var att = attachments[a];
        userContent.push({ type: "image", source: { type: "base64", media_type: att.mimeType || "image/png", data: att.dataUrl.split(",")[1] || att.dataUrl } });
      }
    } else {
      userContent = message.trim();
    }
    messages.push({ role: "user", content: userContent });

    var fullAssistantMessage = "";
    var MAX_ROUNDS = 50;
    var startTime = Date.now();

    // Claude drives. We execute tools. We get out of the way.
    for (var round = 0; round < MAX_ROUNDS; round++) {
      if (Date.now() - startTime > 20 * 60 * 1000) break;

      var currentText = "";
      var currentToolBlock = null;
      var currentToolJson = "";

      const stream = client.messages.stream({
        model: "claude-sonnet-4-6",
        max_tokens: 16000,
        system: systemPrompt,
        tools: FORGE_TOOLS,
        messages: messages,
      });

      for await (const event of stream) {
        if (event.type === "content_block_start") {
          if (event.content_block.type === "tool_use") {
            currentToolBlock = { id: event.content_block.id, name: event.content_block.name };
            currentToolJson = "";
            var statusMsg = (function(name) {
              switch (name) {
                case "github_ls":   return "Listing files...";
                case "github_read": return "Reading file...";
                case "github_write": return "Writing file...";
                case "github_patch": return "Patching file...";
                case "render_status": return "Checking deploy status...";
                case "memory_search": return "Searching Brain...";
                case "fetch_url": return "Fetching URL...";
                default: return null;
              }
            })(event.content_block.name);
            if (statusMsg) send({ type: "tool_status", content: statusMsg });
          }
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta" && event.delta.text) {
            currentText += event.delta.text;
            send({ type: "thinking", content: currentText });
          } else if (event.delta.type === "input_json_delta") {
            currentToolJson += event.delta.partial_json;
          }
        } else if (event.type === "content_block_stop") {
          if (currentToolBlock) {
            var inp = {};
            try { inp = JSON.parse(currentToolJson || "{}"); } catch {}
            var refinedStatus = (function(name, i) {
              switch (name) {
                case "github_ls":   return "Listing " + (i.branch || "main") + "/" + (i.path || "") + "...";
                case "github_read": return "Reading " + (i.filepath || "") + "...";
                case "github_write": return "Writing " + (i.filepath || "") + " to " + (i.branch || "main") + "...";
                case "github_patch": return "Patching " + (i.filepath || "") + "...";
                case "memory_search": return "Searching Brain: \"" + ((i.query || "").slice(0, 50)) + "\"...";
                default: return null;
              }
            })(currentToolBlock.name, inp);
            if (refinedStatus) send({ type: "tool_status", content: refinedStatus });
            currentToolBlock.input = inp;
            currentToolBlock = null;
            currentToolJson = "";
          }
        }
      }

      const response = await stream.finalMessage();
      messages.push({ role: "assistant", content: response.content });

      var textBlocks = response.content.filter(function(b) { return b.type === "text"; });
      if (textBlocks.length > 0) {
        var txt = textBlocks.map(function(b) { return b.text; }).join("\n").trim();
        if (txt) fullAssistantMessage = txt;
      }

      // Only break if Claude made no tool calls — Claude decides when it's done
      var toolCalls = response.content.filter(function(b) { return b.type === "tool_use"; });
      if (toolCalls.length === 0) break;

      // Execute tools
      var toolResults = [];
      for (var t = 0; t < toolCalls.length; t++) {
        var toolUse = toolCalls[t];
        console.log("[forge] round=" + round + " tool=" + toolUse.name, JSON.stringify(toolUse.input).slice(0, 120));
        var result = await executeForgeToken(toolUse.name, toolUse.input, send);
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: String(result) });
      }
      messages.push({ role: "user", content: toolResults });
    }

    brain.appendConversation(project.id, "assistant", fullAssistantMessage).catch(function() {});
    brain.extractMemory({ projectId: project.id, userRequest: message.trim(), buildSummary: fullAssistantMessage.slice(0, 500), files: [] }).catch(function() {});

    send({ type: "done", role: "assistant", content: fullAssistantMessage, building: false, createdAt: Date.now() });

  } catch (err) {
    console.error("[forge] Chat error:", err.message);
    send({ type: "error", error: "Chat error: " + err.message });
  }

  res.end();
});

app.get("/api/projects/:id/chat", async (req, res) => {
  try {
    const project = await projectManager.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    const history = await brain.getConversation(project.id, 50);
    res.json(history);
  } catch (err) {
    console.error("Chat history error:", err.message);
    res.status(500).json({ error: "Failed to load chat history" });
  }
});

const dbUrl = process.env.NEON_DATABASE_URL;
const neonLib = require("@neondatabase/serverless");
const dbViewer = dbUrl ? neonLib.neon(dbUrl) : null;

app.get("/api/db/tables", async (_req, res) => {
  if (!dbViewer) return res.status(503).json({ error: "No database configured" });
  try {
    const tables = await dbViewer`
      SELECT table_name, table_schema
      FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name
    `;
    res.json(tables);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/db/tables/:name", async (req, res) => {
  if (!dbViewer) return res.status(503).json({ error: "No database configured" });
  const tableName = req.params.name.replace(/[^a-zA-Z0-9_]/g, "");
  if (!tableName) return res.status(400).json({ error: "Invalid table name" });
  try {
    const columns = await dbViewer`
      SELECT column_name, data_type, is_nullable, column_default, character_maximum_length
      FROM information_schema.columns
      WHERE table_name = ${tableName}
      AND table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY ordinal_position
    `;
    const countResult = await dbViewer.query(`SELECT count(*)::int as total FROM "${tableName}"`);
    res.json({ columns, rowCount: countResult[0]?.total || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/db/tables/:name/rows", async (req, res) => {
  if (!dbViewer) return res.status(503).json({ error: "No database configured" });
  const tableName = req.params.name.replace(/[^a-zA-Z0-9_]/g, "");
  if (!tableName) return res.status(400).json({ error: "Invalid table name" });
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  try {
    const rows = await dbViewer.query(`SELECT * FROM "${tableName}" LIMIT ${limit} OFFSET ${offset}`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/db/query", async (req, res) => {
  if (!dbViewer) return res.status(503).json({ error: "No database configured" });
  const { sql: rawSql } = req.body;
  if (!rawSql || typeof rawSql !== "string") return res.status(400).json({ error: "SQL query required" });

  const trimmed = rawSql.trim().toLowerCase();
  const forbidden = ["drop ", "truncate ", "alter ", "create ", "grant ", "revoke "];
  for (const f of forbidden) {
    if (trimmed.startsWith(f)) {
      return res.status(403).json({ error: `${f.trim().toUpperCase()} statements are not allowed from the viewer` });
    }
  }

  try {
    const startTime = Date.now();
    const rows = await dbViewer.query(rawSql);
    const duration = Date.now() - startTime;
    res.json({ rows, rowCount: rows.length, duration });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ---------------------------------------------------------------------------
// GitHub proxy routes — used by Workspace v2 Files and Commits tabs
// ---------------------------------------------------------------------------
const FORGEOS_REPO = "BrianBMorgan/ForgeOS";

function ghHeaders() {
  const token = process.env.GITHUB_TOKEN;
  return {
    "Authorization": "Bearer " + token,
    "Accept": "application/vnd.github.v3+json",
    "User-Agent": "ForgeOS/2.0",
  };
}

// List files in a branch/path — used by Files tab
app.get("/api/github/ls", async (req, res) => {
  const { branch = "main", path = "" } = req.query;
  try {
    const url = `https://api.github.com/repos/${FORGEOS_REPO}/contents/${path}?ref=${encodeURIComponent(branch)}`;
    const r = await fetch(url, { headers: ghHeaders() });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.message || "GitHub error" });
    if (!Array.isArray(data)) return res.json([]);
    const items = data.map(item => ({
      name: item.name,
      path: item.path,
      type: item.type === "dir" ? "dir" : "file",
      size: item.size || 0,
    }));
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Read a single file from a branch — used by Files tab viewer
app.get("/api/github/read", async (req, res) => {
  const { branch = "main", path } = req.query;
  if (!path) return res.status(400).json({ error: "path is required" });
  try {
    const url = `https://api.github.com/repos/${FORGEOS_REPO}/contents/${path}?ref=${encodeURIComponent(branch)}`;
    const r = await fetch(url, { headers: ghHeaders() });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.message || "GitHub error" });
    const content = Buffer.from(data.content, "base64").toString("utf-8");
    res.json({ content, sha: data.sha, size: data.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List commits for a branch — used by Commits tab
app.get("/api/github/commits", async (req, res) => {
  const { branch = "main", per_page = "30" } = req.query;
  try {
    const url = `https://api.github.com/repos/${FORGEOS_REPO}/commits?sha=${encodeURIComponent(branch)}&per_page=${per_page}`;
    const r = await fetch(url, { headers: ghHeaders() });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.message || "GitHub error" });
    if (!Array.isArray(data)) return res.json([]);
    const commits = data.map(c => ({
      sha: c.sha,
      message: c.commit.message,
      author: c.commit.author.name,
      date: c.commit.author.date,
    }));
    res.json(commits);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


const clientDist = path.join(__dirname, "..", "client", "dist");
try {
  const fs = require("fs");
  if (fs.existsSync(path.join(clientDist, "index.html"))) {
    app.use(express.static(clientDist));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(clientDist, "index.html"));
    });
    console.log("[static] Serving client from", clientDist);
  }
} catch {}

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`ForgeOS server running on port ${PORT}`);

  try {
    await publishManager.ensureSchema();
    await publishManager.restorePublishedApps();
  } catch (err) {
    console.error("Published apps restoration error:", err.message);
  }

  try {
    await brain.ensureSchema();
  } catch (err) {
    console.error("Brain schema initialization error:", err.message);
  }

  try {
    const token = await settingsManager.getSecret("HUBSPOT_ACCESS_TOKEN");
    if (token) {
      const skills = await settingsManager.getAllSkills();
      if (!skills.find(s => s.name === "HubSpot CRM")) {
        await settingsManager.createSkill({
          name: "HubSpot CRM",
          description: "Build HubSpot CRM-integrated apps. Covers contact creation, deal management, and lead capture patterns.",
          instructions: [
            "You are building a HubSpot CRM-integrated app.",
            "The HubSpot private app access token is available as process.env.HUBSPOT_ACCESS_TOKEN — auto-injected from the Global Secrets Vault. Never hardcode the token.",
            "",
            "HUBSPOT API BASE: https://api.hubapi.com",
            "AUTH HEADER on every request: Authorization: Bearer <process.env.HUBSPOT_ACCESS_TOKEN>",
            "Content-Type: application/json",
            "All HubSpot API calls must be server-side only — never expose the token to the frontend.",
            "",
            "CONTACTS",
            "Create: POST /crm/v3/objects/contacts",
            "  Body: { \"properties\": { \"email\": \"...\", \"firstname\": \"...\", \"lastname\": \"...\", \"phone\": \"...\", \"company\": \"...\", \"hs_lead_status\": \"NEW\" } }",
            "  409 Conflict = contact already exists — use PATCH /crm/v3/objects/contacts/:id to update instead.",
            "Search: POST /crm/v3/objects/contacts/search",
            "  Body: { \"query\": \"john@example.com\", \"limit\": 10, \"properties\": [\"email\",\"firstname\",\"lastname\",\"phone\",\"company\"] }",
            "Get: GET /crm/v3/objects/contacts/:id?properties=email,firstname,lastname,phone,company",
            "Update: PATCH /crm/v3/objects/contacts/:id  Body: { \"properties\": { ... } }",
            "",
            "DEALS",
            "Create: POST /crm/v3/objects/deals",
            "  Body: { \"properties\": { \"dealname\": \"...\", \"amount\": \"...\", \"pipeline\": \"default\", \"dealstage\": \"appointmentscheduled\" } }",
            "Search: POST /crm/v3/objects/deals/search",
            "  Body: { \"query\": \"...\", \"limit\": 10, \"properties\": [\"dealname\",\"amount\",\"dealstage\",\"pipeline\"] }",
            "Associate deal with contact: PUT /crm/v4/objects/deals/:dealId/associations/contacts/:contactId/deal_to_contact",
            "  Body: [{ \"associationCategory\": \"HUBSPOT_DEFINED\", \"associationTypeId\": 3 }]",
            "",
            "LEAD STATUS VALUES: NEW, OPEN, IN_PROGRESS, OPEN_DEAL, UNQUALIFIED, ATTEMPTED_TO_CONTACT, CONNECTED, BAD_TIMING",
            "DEAL STAGE VALUES: appointmentscheduled, qualifiedtobuy, presentationscheduled, decisionmakerboughtin, contractsent, closedwon, closedlost",
            "",
            "CONTACT FORM TO HUBSPOT LEAD PATTERN (standard for contact us / inquiry forms):",
            "1. POST form data to a server route (e.g. POST /api/contact)",
            "2. Server calls HubSpot POST /crm/v3/objects/contacts with hs_lead_status: NEW",
            "3. On 409 Conflict, call GET /crm/v3/objects/contacts/search to find existing contact ID, then PATCH to update",
            "4. Return success to client regardless of whether contact was created or updated",
            "5. Optionally create an associated deal to track the inquiry as pipeline",
            "",
            "ERROR HANDLING: Parse HubSpot error body { status, message, category } for specific errors.",
            "Log HubSpot errors server-side. Return a clean generic message to the client — never expose token or raw API errors.",
          ].join("\n"),
          tags: "hubspot,crm,contacts,deals,leads",
        });
        console.log("[startup] HubSpot CRM skill seeded");
      }
    }
  } catch (err) {
    console.error("HubSpot skill seed error:", err.message);
  }

});








