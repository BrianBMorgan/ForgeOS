const express = require("express");
const path = require("path");
const brain = require("./memory/brain");
const publishManager = require("./publish/manager");
const brandsManager = require("./brands/manager");

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
  const { prompt, brandIds } = req.body;
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "Prompt is required" });
  }

  const project = await projectManager.createProject(prompt.trim());

  // Attach any pre-selected brands so their profiles are in Frank's system
  // prompt on the very first chat turn.
  if (Array.isArray(brandIds) && brandIds.length > 0) {
    await brandsManager.setBrandsForProject(project.id, brandIds);
  }

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
  const { name, brandIds } = req.body;
  let project = await projectManager.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });

  if (name !== undefined) {
    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "Name must be a non-empty string" });
    }
    project = await projectManager.renameProject(req.params.id, name.trim());
  }

  let resolvedBrandIds = null;
  if (brandIds !== undefined) {
    if (!Array.isArray(brandIds)) {
      return res.status(400).json({ error: "brandIds must be an array of numbers" });
    }
    resolvedBrandIds = await brandsManager.setBrandsForProject(req.params.id, brandIds);
  } else {
    resolvedBrandIds = await brandsManager.getBrandIdsForProject(req.params.id);
  }

  res.json({ success: true, name: project.name, brandIds: resolvedBrandIds });
});

app.get("/api/projects/:id", async (req, res) => {
  const project = await projectManager.getProject(req.params.id);
  if (!project) {
    return res.status(404).json({ error: "Project not found" });
  }
  const brandIds = await brandsManager.getBrandIdsForProject(req.params.id);
  res.json({ ...project, brandIds, iterations: [], currentRun: null });
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

  // If still showing deploying, check live Render status and update DB
  if (app.status === "deploying" && app.renderServiceId) {
    try {
      const renderRes = await fetch(
        `https://api.render.com/v1/services/${app.renderServiceId}/deploys?limit=1`,
        { headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, Accept: "application/json" } }
      );
      if (renderRes.ok) {
        const deploys = await renderRes.json();
        const latest = deploys[0]?.deploy || deploys[0];
        const renderStatus = latest?.status;
        if (renderStatus === "live") {
          await publishManager.updateAppStatus(req.params.id, "running");
          const updatedApp = publishManager.getPublishedApp(req.params.id);
          return res.json({ published: true, ...(updatedApp || app), status: "running" });
        } else if (renderStatus === "build_failed" || renderStatus === "deactivated") {
          await publishManager.updateAppStatus(req.params.id, "failed");
          return res.json({ published: true, ...app, status: "failed" });
        }
      }
    } catch (e) { /* fall through to cached status */ }
  }

  res.json({ published: true, ...app });
});

app.get("/api/published", async (_req, res) => {
  res.json(publishManager.listPublishedApps());
});

// ── Brain purge — delete memories matching terms ─────────────────────────────
app.post("/api/brain/memory", async (req, res) => {
  const { type, category, content: memContent, source } = req.body;
  if (!memContent) return res.status(400).json({ error: "content required" });
  try {
    const { neon } = require("@neondatabase/serverless");
    const memSql = neon(process.env.NEON_DATABASE_URL);
    const result = await memSql`INSERT INTO forge_memory (type, category, content, source_project_id, created_at)
      VALUES (${type||category||"pattern"}, ${category||type||"general"}, ${memContent}, ${source||null}, ${Date.now()}) RETURNING id`;
    res.json({ id: result[0].id, saved: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/brain/purge", async (req, res) => {
  const { terms } = req.body;
  if (!terms || !Array.isArray(terms) || terms.length === 0) {
    return res.status(400).json({ error: "terms array required" });
  }
  try {
    const { neon } = require("@neondatabase/serverless");
    const purgeSql = neon(process.env.NEON_DATABASE_URL);
    // Use individual deletes per term — avoids unsafe() and template literal nesting
    var totalDeleted = 0;
    for (var i = 0; i < terms.length; i++) {
      var term = "%" + terms[i] + "%";
      var result = await purgeSql("DELETE FROM forge_memory WHERE content ILIKE $1", [term]);
      totalDeleted += result.rowCount || 0;
    }
    res.json({ deleted: totalDeleted, terms });
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
    res.json({ status: 'diagnostics disabled' });
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
  const { name, description, instructions, tags, skillType, repoOwner, repoName, repoBranch, repoToken } = req.body;
  if (!name) {
    return res.status(400).json({ error: "Name is required" });
  }
  const type = skillType === "repo_access" ? "repo_access" : "standard";
  if (type === "standard" && !instructions) {
    return res.status(400).json({ error: "Instructions are required for standard skills" });
  }
  if (type === "repo_access" && (!repoOwner || !repoName || !repoToken)) {
    return res.status(400).json({ error: "Repo owner, name, and token are required for repo_access skills" });
  }
  const skill = await settingsManager.createSkill({
    name, description, instructions, tags,
    skillType: type, repoOwner, repoName, repoBranch, repoToken,
  });
  if (!skill) {
    return res.status(500).json({ error: "Failed to create skill" });
  }
  res.status(201).json(skill);
});

app.put("/api/skills/:id", async (req, res) => {
  const { name, description, instructions, tags, skillType, repoOwner, repoName, repoBranch, repoToken } = req.body;
  if (!name) {
    return res.status(400).json({ error: "Name is required" });
  }
  const ok = await settingsManager.updateSkill(parseInt(req.params.id), {
    name, description, instructions, tags,
    skillType, repoOwner, repoName, repoBranch, repoToken,
  });
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

// ── Google Workspace ─────────────────────────────────────────────────────────
// Single-user OAuth. Visit /api/google/auth/start in a browser once, consent,
// and the refresh token is stored in the vault. All subsequent tool calls
// refresh access tokens on demand.
const googleAuth = require("./integrations/google/auth");
const googleGmail = require("./integrations/google/gmail");
const googleCalendar = require("./integrations/google/calendar");
const googleDrive = require("./integrations/google/drive");
const googleDocs = require("./integrations/google/docs");
const googleContacts = require("./integrations/google/contacts");

app.get("/api/google/auth/status", async (_req, res) => {
  try {
    const connected = await googleAuth.isConnected();
    res.json({ connected, scopes: googleAuth.SCOPES });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/google/auth/start", async (req, res) => {
  try {
    const { clientId } = await googleAuth.getClientCredentials();
    const redirectUri = googleAuth.getBaseUrl(req) + googleAuth.REDIRECT_URI_PATH;
    const url = googleAuth.buildConsentUrl({ clientId, redirectUri });
    res.redirect(url);
  } catch (err) {
    res.status(500).send(`<pre>${err.message}</pre>`);
  }
});

app.get("/api/google/auth/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send(`<pre>Google OAuth error: ${error}</pre>`);
  if (!code) return res.status(400).send("<pre>Missing code parameter</pre>");
  try {
    const redirectUri = googleAuth.getBaseUrl(req) + googleAuth.REDIRECT_URI_PATH;
    const tokens = await googleAuth.exchangeCodeForTokens({ code, redirectUri });
    await settingsManager.setSecret("GOOGLE_REFRESH_TOKEN", tokens.refresh_token);
    res.send(`<!doctype html><meta charset=utf-8><title>Google connected</title><body style="font-family:system-ui;background:#0a0f1c;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><div style="text-align:center;padding:2rem;border:1px solid #1e293b;background:#0f172a;max-width:500px"><h1 style="margin-top:0">✓ Google connected</h1><p>Frank now has access to Gmail, Calendar, Drive, Docs, and Contacts. You can close this tab and return to ForgeOS.</p></div></body>`);
  } catch (err) {
    res.status(500).send(`<pre>${err.message}</pre>`);
  }
});

app.post("/api/google/auth/disconnect", async (_req, res) => {
  try {
    await googleAuth.disconnect();
    res.json({ disconnected: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Brands ────────────────────────────────────────────────────────────────────
// Reusable brand profiles scraped from live sites. Projects attach to brands
// many-to-many; every attached profile is injected into Frank's system prompt.
brandsManager.ensureSchema().catch(err => console.error("[brands] Schema error:", err.message));

app.get("/api/brands", async (_req, res) => {
  try {
    const brands = await brandsManager.getAllBrands();
    res.json({ brands });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/brands", async (req, res) => {
  const { name, urls, profile, scrape } = req.body;
  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }
  try {
    const cleanUrls = Array.isArray(urls) ? urls.filter(u => typeof u === "string" && u.trim()).map(u => u.trim()) : [];
    let profileText = typeof profile === "string" ? profile : "";
    let lastScrapedAt = null;
    let scrapeInfo = null;

    if (scrape && cleanUrls.length > 0) {
      let anthropicKey = process.env.ANTHROPIC_API_KEY;
      try {
        const vaultKey = await settingsManager.getSecret("ANTHROPIC_API_KEY");
        if (vaultKey) anthropicKey = vaultKey;
      } catch {}
      const result = await brandsManager.scrapeProfile({ name: name.trim(), urls: cleanUrls, anthropicKey });
      profileText = result.profile;
      lastScrapedAt = Date.now();
      scrapeInfo = { fetchedUrls: result.fetchedUrls, failedUrls: result.failedUrls };
    }

    const brand = await brandsManager.createBrand({ name: name.trim(), urls: cleanUrls, profile: profileText });
    if (!brand) return res.status(500).json({ error: "Failed to create brand" });
    if (lastScrapedAt) {
      const updated = await brandsManager.updateBrand(brand.id, { lastScrapedAt });
      return res.status(201).json({ brand: updated || brand, ...(scrapeInfo || {}) });
    }
    res.status(201).json({ brand });
  } catch (err) {
    console.error("[brands] create failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/brands/:id", async (req, res) => {
  const brand = await brandsManager.getBrand(Number(req.params.id));
  if (!brand) return res.status(404).json({ error: "Brand not found" });
  res.json({ brand });
});

app.put("/api/brands/:id", async (req, res) => {
  const { name, urls, profile } = req.body;
  try {
    const brand = await brandsManager.updateBrand(Number(req.params.id), {
      name: typeof name === "string" ? name.trim() : undefined,
      urls: Array.isArray(urls) ? urls.filter(u => typeof u === "string" && u.trim()).map(u => u.trim()) : undefined,
      profile: typeof profile === "string" ? profile : undefined,
    });
    if (!brand) return res.status(404).json({ error: "Brand not found" });
    res.json({ brand });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/brands/:id", async (req, res) => {
  const ok = await brandsManager.deleteBrand(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: "Brand not found" });
  res.json({ success: true });
});

app.post("/api/brands/:id/rescrape", async (req, res) => {
  try {
    const existing = await brandsManager.getBrand(Number(req.params.id));
    if (!existing) return res.status(404).json({ error: "Brand not found" });
    const urls = Array.isArray(req.body?.urls) && req.body.urls.length ? req.body.urls : existing.urls;
    if (!urls || urls.length === 0) return res.status(400).json({ error: "No URLs to scrape — add URLs to the brand first" });

    let anthropicKey = process.env.ANTHROPIC_API_KEY;
    try {
      const vaultKey = await settingsManager.getSecret("ANTHROPIC_API_KEY");
      if (vaultKey) anthropicKey = vaultKey;
    } catch {}

    const result = await brandsManager.scrapeProfile({ name: existing.name, urls, anthropicKey });
    const updated = await brandsManager.updateBrand(existing.id, {
      urls,
      profile: result.profile,
      lastScrapedAt: Date.now(),
    });
    res.json({ brand: updated, fetchedUrls: result.fetchedUrls, failedUrls: result.failedUrls });
  } catch (err) {
    console.error("[brands] rescrape failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── FORGE CHAT — Direct Anthropic Streaming ───────────────────────────────────
// No agent loop. No nudges. No guards. Claude gets tools, a system prompt, and
// conversation history. It calls tools when it needs to. It stops when it is
// done. We get out of the way.


const DEFAULT_GITHUB_REPO = "BrianBMorgan/ForgeOS";

function resolveRepo(context) {
  if (context && context.repoOwner && context.repoName) {
    return `${context.repoOwner}/${context.repoName}`;
  }
  return DEFAULT_GITHUB_REPO;
}

function githubHeaders(context) {
  // For repo_access skills we use the per-repo PAT; otherwise the ForgeOS PAT.
  const token = (context && context.token) || process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN not set (and no repo_access skill PAT available)");
  return {
    "Authorization": "Bearer " + token,
    "Accept": "application/vnd.github.v3+json",
    "Content-Type": "application/json",
    "User-Agent": "ForgeOS-Agent",
  };
}

// ─── Approval system ────────────────────────────────────────────────────────
const pendingApprovals = new Map(); // approvalId → { resolve }
const APPROVAL_TOOLS = new Set([
  "github_write",
  "github_patch",
  "gmail_create_draft",
  "gmail_send",
  "gmail_modify_labels",
  "calendar_create_event",
  "calendar_update_event",
  "calendar_delete_event",
  "drive_write_file",
  "drive_create_folder",
  "drive_move_file",
  "drive_delete_file",
  "docs_append_text",
  "docs_replace_text",
  "docs_create",
]);

const FORGE_TOOLS = [
  {
    name: "github_create_branch",
    description: "Create a new apps/<slug> branch from main. Call this if the branch doesn't exist before committing files.",
    parameters: {
      type: "object",
      properties: {
        branch: { type: "string", description: "Branch name, e.g. apps/my-app" },
      },
      required: ["branch"],
    },
  },
  {
    name: "github_ls",
    description: "List files in a GitHub branch. Use to explore what exists before writing. Default branch is main.",
    parameters: {
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
    parameters: {
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
    parameters: {
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
    parameters: {
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
    parameters: {
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
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for." },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch_url",
    description: "Fetch the contents of any URL — web pages, documentation, external APIs, or internal ForgeOS endpoints like /api/assets or /api/skills. Use this to inspect live app pages, check asset lists, or load skill instructions.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full URL to fetch. For internal ForgeOS endpoints use https://forge-os.ai/api/... e.g. https://forge-os.ai/api/assets to list all assets." },
      },
      required: ["url"],
    },
  },
  {
    name: "list_assets",
    description: "List all assets stored in the ForgeOS asset library. Returns filenames, mimetypes, and sizes. Use this to check what images or files are available before referencing them in an app.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "list_skills",
    description: "List all skills in the ForgeOS global skills library. Returns each skill's id, name, description, and tags. Skills are reusable playbooks (e.g. 'Brand Profile: Scrape & Save', 'Publish Article') that Brian has registered for Frank to use. Call this whenever Brian references a skill by name, mentions 'skills', asks what skills exist, or when you're unsure whether a skill exists for the task at hand.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "read_skill",
    description: "Load a skill's full instructions into your working context by id. Call this after list_skills finds a matching skill, or when Brian names a specific skill. The returned instructions should be followed as authoritative guidance for the current task.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "number", description: "Skill id from list_skills." },
      },
      required: ["id"],
    },
  },
  {
    name: "browser_use",
    description: "Run a task in a real headless browser. Use for ANY task fetch_url can't handle: JavaScript-rendered single-page apps, infinite scroll, auth-walled pages, multi-step flows (click, fill, wait, navigate), visual verification of a deployed app, or looking at rendered state the way a human would. Give a natural-language task — the browser agent decides how to accomplish it. Returns the agent's final output text, a live_url (while running) or recording_url (after), and total cost. Costs roughly $0.05/hour of browser time plus LLM tokens; each task is billed per-minute with a 1-minute minimum. Default timeout 180s — bump it for multi-step flows.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "Plain-English task. Be specific about the URL to start at and what to extract or do. Example: 'Open https://staging.example.com/signup, fill in test@example.com and password Pa55word!, click Create account, and report whether the dashboard loads.'" },
        timeout_seconds: { type: "number", description: "Max wait before giving up on the session. Default 180." },
      },
      required: ["task"],
    },
  },
  {
    name: "gmail_search",
    description: "Search the user's Gmail threads. Accepts Gmail search operators like from:, to:, subject:, has:attachment, newer_than:7d. Returns thread ids and snippets — follow up with gmail_read_thread for full content.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Gmail search query. Example: 'from:acme.com newer_than:30d' or 'subject:invoice has:attachment'." },
        max_results: { type: "number", description: "Max threads to return. Default 20, max 100." },
      },
      required: ["query"],
    },
  },
  {
    name: "gmail_read_thread",
    description: "Read all messages in a Gmail thread by id. Returns sender, recipients, subject, date, snippet, and body text for each message.",
    parameters: {
      type: "object",
      properties: {
        thread_id: { type: "string", description: "Thread id from gmail_search." },
      },
      required: ["thread_id"],
    },
  },
  {
    name: "gmail_list_labels",
    description: "List the user's Gmail labels. Returns id and name for each — useful before gmail_modify_labels so you know which label id to use.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "gmail_modify_labels",
    description: "Apply or remove labels on a Gmail thread. Use gmail_list_labels first to find label ids. Requires approval.",
    parameters: {
      type: "object",
      properties: {
        thread_id: { type: "string" },
        add_label_ids: { type: "array", items: { type: "string" } },
        remove_label_ids: { type: "array", items: { type: "string" } },
      },
      required: ["thread_id"],
    },
  },
  {
    name: "gmail_create_draft",
    description: "Create a Gmail draft without sending. Safer than gmail_send — lets Brian review in Gmail before actually sending. Requires approval. If replying, pass thread_id and in_reply_to.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string" },
        cc: { type: "string" },
        bcc: { type: "string" },
        subject: { type: "string" },
        body: { type: "string", description: "Plain-text body." },
        thread_id: { type: "string", description: "Optional — thread id if replying." },
        in_reply_to: { type: "string", description: "Optional — Message-ID of the email being replied to." },
      },
      required: ["subject", "body"],
    },
  },
  {
    name: "gmail_send",
    description: "Send an email on Brian's behalf. IRREVERSIBLE. Prefer gmail_create_draft unless Brian explicitly asked to send. Requires approval.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string" },
        cc: { type: "string" },
        bcc: { type: "string" },
        subject: { type: "string" },
        body: { type: "string", description: "Plain-text body." },
        thread_id: { type: "string" },
        in_reply_to: { type: "string" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "calendar_list_calendars",
    description: "List Brian's calendars. Returns id, summary, whether it's primary, timezone. Use the returned id for other calendar tools (or 'primary' for his main calendar).",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "calendar_list_events",
    description: "List events on a calendar within a time window. Times should be ISO 8601. Defaults to the primary calendar and the next 7 days if times are omitted.",
    parameters: {
      type: "object",
      properties: {
        calendar_id: { type: "string", description: "Calendar id. Default 'primary'." },
        time_min: { type: "string", description: "ISO 8601 start. Default: now." },
        time_max: { type: "string", description: "ISO 8601 end. Default: now + 7 days." },
        q: { type: "string", description: "Optional free-text filter." },
        max_results: { type: "number", description: "Default 25." },
      },
      required: [],
    },
  },
  {
    name: "calendar_create_event",
    description: "Create a calendar event. Requires approval. Times are ISO 8601. Pass send_updates='all' to notify attendees.",
    parameters: {
      type: "object",
      properties: {
        calendar_id: { type: "string", description: "Default 'primary'." },
        summary: { type: "string" },
        description: { type: "string" },
        location: { type: "string" },
        start: { type: "string", description: "ISO 8601 start time." },
        end: { type: "string", description: "ISO 8601 end time." },
        time_zone: { type: "string", description: "IANA timezone, e.g. 'America/Los_Angeles'." },
        attendees: { type: "array", items: { type: "string" }, description: "List of attendee emails." },
        send_updates: { type: "string", description: "'all' | 'externalOnly' | 'none'. Default 'none'." },
      },
      required: ["summary", "start", "end"],
    },
  },
  {
    name: "calendar_update_event",
    description: "Patch an existing calendar event (partial update). Requires approval. Pass only the fields you want to change.",
    parameters: {
      type: "object",
      properties: {
        calendar_id: { type: "string", description: "Default 'primary'." },
        event_id: { type: "string" },
        patch: { type: "object", description: "Any fields from the Calendar Event schema: summary, description, location, start, end, attendees." },
        send_updates: { type: "string", description: "'all' | 'externalOnly' | 'none'. Default 'none'." },
      },
      required: ["event_id", "patch"],
    },
  },
  {
    name: "calendar_delete_event",
    description: "Delete a calendar event. Requires approval.",
    parameters: {
      type: "object",
      properties: {
        calendar_id: { type: "string", description: "Default 'primary'." },
        event_id: { type: "string" },
        send_updates: { type: "string" },
      },
      required: ["event_id"],
    },
  },
  {
    name: "drive_search",
    description: "Search Brian's Google Drive by filename or full-text. Returns file id, name, mimeType, size, modifiedTime, parents, webViewLink. Use drive_read_file to get contents.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text query. Example: 'Sandbox-GTM brand doc'." },
        folder_id: { type: "string", description: "Optional — restrict to a single folder." },
        page_size: { type: "number", description: "Default 25, max 1000." },
      },
      required: ["query"],
    },
  },
  {
    name: "drive_list_folder",
    description: "List children of a Drive folder. Pass folder_id='root' for the root of Brian's Drive.",
    parameters: {
      type: "object",
      properties: {
        folder_id: { type: "string", description: "Folder id or 'root'." },
        page_size: { type: "number" },
      },
      required: [],
    },
  },
  {
    name: "drive_read_file",
    description: "Read a Drive file's contents. Google Docs/Sheets/Slides are exported to plain text / CSV / plain text respectively. Binary files return base64 — prefer Google-native formats when possible.",
    parameters: {
      type: "object",
      properties: {
        file_id: { type: "string" },
        max_bytes: { type: "number", description: "Default 200000." },
      },
      required: ["file_id"],
    },
  },
  {
    name: "drive_write_file",
    description: "Create or overwrite a file in Drive. If file_id is passed, updates that file; otherwise creates a new file (optionally inside parent_id). Requires approval.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "File name. Required when creating; ignored when file_id is passed." },
        parent_id: { type: "string", description: "Folder id to create the file in. Optional; defaults to root. Ignored when file_id is passed." },
        file_id: { type: "string", description: "Pass to update an existing file instead of creating one." },
        mime_type: { type: "string", description: "Default 'text/plain'." },
        content: { type: "string", description: "File content. Plain text by default; base64 if encoding='base64'." },
        encoding: { type: "string", description: "'utf-8' (default) or 'base64'." },
      },
      required: ["content"],
    },
  },
  {
    name: "drive_create_folder",
    description: "Create a new folder in Drive. Requires approval.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        parent_id: { type: "string", description: "Optional parent folder id. Defaults to root." },
      },
      required: ["name"],
    },
  },
  {
    name: "drive_move_file",
    description: "Move a Drive file to a different folder (or add/remove multiple parents). Requires approval.",
    parameters: {
      type: "object",
      properties: {
        file_id: { type: "string" },
        add_parents: { type: "string", description: "Comma-separated folder ids to add as parents." },
        remove_parents: { type: "string", description: "Comma-separated folder ids to remove." },
      },
      required: ["file_id"],
    },
  },
  {
    name: "drive_delete_file",
    description: "Move a file to Drive trash (recoverable) or hard-delete it. Defaults to trash. Requires approval — never hard-delete without explicit confirmation from Brian.",
    parameters: {
      type: "object",
      properties: {
        file_id: { type: "string" },
        trash: { type: "boolean", description: "True (default) moves to trash; false hard-deletes." },
      },
      required: ["file_id"],
    },
  },
  {
    name: "docs_read",
    description: "Read a Google Doc's contents as plain text with headings preserved as markdown. For structured edits, use docs_append_text or docs_replace_text. For read-only work drive_read_file also works.",
    parameters: {
      type: "object",
      properties: {
        document_id: { type: "string" },
      },
      required: ["document_id"],
    },
  },
  {
    name: "docs_append_text",
    description: "Append plain text to the end of a Google Doc. Requires approval.",
    parameters: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        text: { type: "string", description: "Text to append. Include leading newline(s) if you want spacing." },
      },
      required: ["document_id", "text"],
    },
  },
  {
    name: "docs_replace_text",
    description: "Find-and-replace across a Google Doc. Pass an array of {find, replace, match_case?}. Requires approval.",
    parameters: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        replacements: {
          type: "array",
          items: {
            type: "object",
            properties: {
              find: { type: "string" },
              replace: { type: "string" },
              match_case: { type: "boolean" },
            },
            required: ["find", "replace"],
          },
        },
      },
      required: ["document_id", "replacements"],
    },
  },
  {
    name: "docs_create",
    description: "Create a new blank Google Doc with a title. Requires approval. Use docs_append_text afterwards to populate it, or use drive_write_file with a text mime type for a non-Google file.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
      },
      required: ["title"],
    },
  },
  {
    name: "contacts_search",
    description: "Search Brian's Google Contacts by name, email, phone, or organization. Returns names, emails, phones, organizations.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        page_size: { type: "number", description: "Default 20, max 30." },
      },
      required: ["query"],
    },
  },
  {
    name: "ask_user",
    description: "Send a message or question to Brian. Use for genuine questions when you cannot proceed, or to report what you shipped.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "Message for Brian." },
      },
      required: ["message"],
    },
  },
];

const FORGE_SYSTEM_PROMPT = `You are Frank — a senior software architect and full-stack engineer. You think, plan, read existing code, AND write code directly. You are the single agent — there is no delegation.

You work inside ForgeOS — a deployment platform where every project lives on a GitHub branch (apps/<slug>) and auto-deploys to Render. Brian talks to you. You figure out what to build, read the existing code, write the new code, and commit it.

## YOUR ROLE

You are the architect AND the engineer. You:
- Understand what Brian actually wants — ask clarifying questions when the request is ambiguous
- Read existing code before making changes
- Search memory and skills for relevant patterns
- Search the web when you need current information, docs, or API references
- Break builds into logical chunks — schema first, then routes, then UI
- Write complete code directly and commit it with github_write
- Use github_patch for small, surgical find/replace edits
- Verify the deploy with render_status
- Report back clearly — what shipped, what the URL is, what still needs doing

## YOUR TOOLS

Engineering:
- github_create_branch — create a new apps/<slug> branch when it doesn't exist yet
- github_ls — explore what exists on a branch
- github_read — read any file before making changes to it
- github_write — commit a complete file. Write the FULL file content — never truncate or use placeholder comments.
- github_patch — surgical find/replace for small targeted changes (a few lines)
- render_status — check deploy status and get the live URL

Research & context:
- memory_search — search past builds for patterns and lessons
- fetch_url — fetch any URL: web pages, documentation, live app pages, or internal ForgeOS APIs
- browser_use — drive a real headless browser with a natural-language task. Use when fetch_url isn't enough: SPAs, auth walls, multi-step flows (click/fill/wait), visual verification of deployed apps.
- list_assets — list files in the ForgeOS asset library
- list_skills — list every skill in the global skills library (id, name, description, tags)
- read_skill — load a specific skill's full instructions into your context by id

Google Workspace (Brian's account):
- gmail_search, gmail_read_thread, gmail_list_labels — read Brian's inbox
- gmail_modify_labels, gmail_create_draft, gmail_send — modify/compose (approval required)
- calendar_list_calendars, calendar_list_events — read Brian's calendar
- calendar_create_event, calendar_update_event, calendar_delete_event — modify (approval required)
- drive_search, drive_list_folder, drive_read_file — read Drive
- drive_write_file, drive_create_folder, drive_move_file, drive_delete_file — modify Drive (approval required)
- docs_read, docs_append_text, docs_replace_text, docs_create — work with Google Docs (writes require approval)
- contacts_search — look up Brian's contacts

Comms:
- ask_user — ask Brian a question when you genuinely need clarification

## GOOGLE WORKSPACE — WHEN TO USE

Brian's Google account is connected. Use it naturally — if he asks "what's on my calendar tomorrow", call calendar_list_events. If he says "find the Sandbox-GTM brand doc in my Drive", call drive_search. If he says "draft a reply to the latest email from Sarah", call gmail_search then gmail_create_draft.

Prefer drafts over direct sends. gmail_create_draft is safer than gmail_send because it puts the email in Gmail → Drafts for Brian to review. Only use gmail_send when Brian has explicitly said "send it".

For Drive writes, default to creating under a clearly named parent folder (drive_search first to find it or create it with drive_create_folder) rather than dumping files at the root. Brian syncs Drive to his Mac via Google Drive for Desktop, so anything you create under /Documents shows up on his machine automatically.

For destructive actions (drive_delete_file, calendar_delete_event) always default to recoverable options: trash=true for Drive (recoverable from Drive trash), sendUpdates='none' for calendar unless Brian explicitly wants attendees notified.

## SKILLS

Skills are reusable playbooks Brian has registered in the global skills library — things like "Brand Profile: Scrape & Save" or "Publish Article". They are NOT auto-injected into your prompt. You must reach for them:

- When Brian references a skill by name ("use the brand-profile skill"), call read_skill with the matching id.
- When you're unsure whether a skill exists for the task, call list_skills first, then read_skill if a match looks promising.
- Skill instructions once loaded are authoritative for that task — follow them.
- If Brian names a skill and list_skills doesn't contain it, tell him clearly: the skill is not registered. Don't guess or improvise a fake version.

## HOW TO BUILD

1. If Brian names or hints at a skill, call list_skills and read_skill before planning.
2. Search memory with memory_search for relevant patterns from past builds.
3. Read existing files with github_read — ALWAYS read before writing.
4. Ask Brian if anything is still unclear with ask_user.
5. Write the code and commit with github_write (complete file) or github_patch (small edit). Brian will see an approval card and must approve before the commit executes.
6. Check render_status once to confirm deploy status.
7. Report what shipped and the live URL.

## APPROVAL FLOW

github_write and github_patch require Brian's approval before executing. Brian sees a card showing the file path, branch, and commit message. He can approve, cancel, or approve all writes for the session. Reads (github_read, github_ls, memory_search, etc.) auto-execute with no approval needed.

If Brian cancels a write, you will receive "User cancelled this action." as the tool result. Adjust your approach and ask what to change.

## CODE QUALITY

- Write COMPLETE files — never truncate, never use "// ... rest of file" comments
- Use github_patch for small targeted edits (a few lines), github_write for new files or large rewrites
- CommonJS on server (require/module.exports) — no ES modules
- @neondatabase/serverless for all databases
- No dotenv — env vars injected at runtime

## DEPLOY TIMING — CRITICAL

Render deploys take 2-4 minutes. Follow this exact protocol:

1. After committing files, call render_status once immediately
2. If status is "deploying" — report the URL to Brian and say it will be live in 2-4 minutes. STOP. Do not poll again.
3. Brian will check it himself. Only call render_status again if Brian explicitly asks.

## PLATFORM RULES

- Branch: apps/<slug> — already provisioned, never write to main
- CRITICAL: Always pass branch: 'apps/<slug>' explicitly in every github_write and github_patch call
- GET / returns complete HTML
- Root-relative URLs only
- NEON_DATABASE_URL reserved — apps use custom names like APP_DATABASE_URL
- Frontend in index.html, backend in server.js — never inline HTML into server.js
- Serve index.html via res.sendFile(require("path").join(__dirname, "index.html"))
- Every index.html must include the ForgeOS inspect snippet before </head>

## HOW TO COMMUNICATE

- Be direct — no filler, no preamble
- When you ship, say what committed and the live URL
- When something fails, say exactly what failed and what you are doing about it
- Never describe what you are about to do — do it, then report what you did

## MANDATORY: render_status before reporting live

Never tell Brian an app is live until render_status confirms it. Call it once after committing. If deploying, give Brian the URL and stop polling.`;

async function executeForgeToken(toolName, toolInput, sendEvent, repoContext) {
  switch (toolName) {

    case "github_create_branch": {
      try {
        const branch = toolInput.branch;
        if (!branch) return "Error: branch name required";
        const repo = resolveRepo(repoContext);
        const headers = githubHeaders(repoContext);
        const baseBranch = (repoContext && repoContext.defaultBranch) || "main";
        const refRes = await fetch("https://api.github.com/repos/" + repo + "/git/ref/heads/" + encodeURIComponent(baseBranch), { headers });
        const refData = await refRes.json();
        if (!refRes.ok) return "GitHub error: " + JSON.stringify(refData).slice(0, 200);
        const sha = refData.object.sha;
        const createRes = await fetch("https://api.github.com/repos/" + repo + "/git/refs", {
          method: "POST", headers, body: JSON.stringify({ ref: "refs/heads/" + branch, sha }),
        });
        const createData = await createRes.json();
        if (!createRes.ok) {
          if (createRes.status === 422) return "Branch " + branch + " already exists.";
          return "GitHub error: " + JSON.stringify(createData).slice(0, 200);
        }
        if (sendEvent) sendEvent({ type: "tool_status", content: "✓ Created branch: " + branch + " in " + repo });
        return "Branch " + branch + " created from " + baseBranch + " (" + sha.slice(0, 7) + ") in " + repo;
      } catch (err) { return "github_create_branch error: " + err.message; }
    }

    case "github_ls": {
      try {
        const repo = resolveRepo(repoContext);
        const defaultBranch = (repoContext && repoContext.defaultBranch) || "main";
        const branch = toolInput.branch || defaultBranch;
        const dirPath = toolInput.path || "";
        const res = await fetch("https://api.github.com/repos/" + repo + "/contents/" + dirPath + "?ref=" + encodeURIComponent(branch), { headers: githubHeaders(repoContext) });
        const data = await res.json();
        if (!res.ok) return "GitHub error " + res.status + ": " + JSON.stringify(data).slice(0, 200);
        if (!Array.isArray(data)) return "Not a directory";
        return "Repo: " + repo + " | Branch: " + branch + " | Path: /" + dirPath + "\n" + data.map(function(item) {
          return (item.type === "dir" ? "[dir]  " : "[file] ") + item.name + (item.size ? " (" + item.size + " bytes)" : "");
        }).join("\n");
      } catch (err) { return "github_ls error: " + err.message; }
    }

    case "github_read": {
      try {
        const repo = resolveRepo(repoContext);
        const defaultBranch = (repoContext && repoContext.defaultBranch) || "main";
        const branch = toolInput.branch || defaultBranch;
        const res = await fetch("https://api.github.com/repos/" + repo + "/contents/" + toolInput.filepath + "?ref=" + encodeURIComponent(branch), { headers: githubHeaders(repoContext) });
        const data = await res.json();
        if (!res.ok) return "GitHub error " + res.status + ": " + JSON.stringify(data).slice(0, 200);
        return Buffer.from(data.content, "base64").toString("utf-8");
      } catch (err) { return "github_read error: " + err.message; }
    }

    case "github_write": {
      try {
        const repo = resolveRepo(repoContext);
        const defaultBranch = (repoContext && repoContext.defaultBranch) || "main";
        const branch = toolInput.branch || defaultBranch;
        // ABSOLUTE BLOCK: never write to ForgeOS's own main. Other repos
        // (repo_access skills) can write to main freely — that's their dev.
        if (repo === DEFAULT_GITHUB_REPO && branch === "main") {
          return "BLOCKED: Writing to main on BrianBMorgan/ForgeOS is not permitted. " +
            "ForgeOS should not perform surgery on itself. Use apps/<slug> for project work.";
        }
        const headers = githubHeaders(repoContext);
        const shaRes = await fetch("https://api.github.com/repos/" + repo + "/contents/" + toolInput.filepath + "?ref=" + encodeURIComponent(branch), { headers });
        const shaData = await shaRes.json();
        const currentSha = shaRes.ok ? shaData.sha : null;
        const body = { message: toolInput.message, content: Buffer.from(toolInput.content, "utf-8").toString("base64"), branch };
        if (currentSha) body.sha = currentSha;
        const pushRes = await fetch("https://api.github.com/repos/" + repo + "/contents/" + toolInput.filepath, { method: "PUT", headers, body: JSON.stringify(body) });
        const pushData = await pushRes.json();
        if (!pushRes.ok) return "GitHub push error " + pushRes.status + ": " + JSON.stringify(pushData).slice(0, 300);
        const commitSha = pushData.commit && pushData.commit.sha ? pushData.commit.sha.slice(0, 7) : "done";
        sendEvent({ type: "tool_status", content: "✓ Written: " + toolInput.filepath + " → " + repo + "@" + branch });
        sendEvent({ type: "file_committed", filepath: toolInput.filepath, branch: branch, commit: commitSha });

        // Auto-provision Render service only for ForgeOS's own apps/* branches.
        // External repos are assumed to have their own Render setup already.
        if (repo === DEFAULT_GITHUB_REPO && branch.startsWith("apps/")) {
          const appSlug = branch.replace("apps/", "");
          setImmediate(async () => {
            try {
              const pubManager = require("./publish/manager");
              const existing = pubManager.getPublishedAppBySlug(appSlug);
              if (!existing || !existing.renderServiceId) {
                const allProjects = await require("./projects/manager").getAllProjects();
                const project = allProjects.find(function(p) { return pubManager.generateSlug(p.name) === appSlug; });
                if (project) { await pubManager.publishProject(project.id); console.log("[forge] Auto-provisioned Render for " + appSlug); }
              }
            } catch (provErr) { console.warn("[forge] Auto-provision skipped:", provErr.message); }
          });
        }

        return "Pushed " + toolInput.filepath + " to " + repo + "@" + branch + " — commit: " + commitSha;
      } catch (err) { return "github_write error: " + err.message; }
    }

    case "github_patch": {
      try {
        const repo = resolveRepo(repoContext);
        const defaultBranch = (repoContext && repoContext.defaultBranch) || "main";
        const branch = toolInput.branch || defaultBranch;
        // ABSOLUTE BLOCK: never patch ForgeOS's own main.
        if (repo === DEFAULT_GITHUB_REPO && branch === "main") {
          return "BLOCKED: Patching main on BrianBMorgan/ForgeOS is not permitted.";
        }
        const headers = githubHeaders(repoContext);
        const res = await fetch("https://api.github.com/repos/" + repo + "/contents/" + toolInput.filepath + "?ref=" + encodeURIComponent(branch), { headers });
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
        const pushRes = await fetch("https://api.github.com/repos/" + repo + "/contents/" + toolInput.filepath, {
          method: "PUT", headers,
          body: JSON.stringify({ message: toolInput.message, content: Buffer.from(fileContent, "utf-8").toString("base64"), sha, branch }),
        });
        const pushData = await pushRes.json();
        if (!pushRes.ok) return "Push error " + pushRes.status + ": " + JSON.stringify(pushData).slice(0, 200);
        const commitSha = pushData.commit && pushData.commit.sha ? pushData.commit.sha.slice(0, 7) : "done";
        let summary = "Patched " + toolInput.filepath + " on " + repo + "@" + branch + " — " + applied.length + " replacement(s) — commit: " + commitSha;
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

    case "fetch_url": {
      try {
        const targetUrl = toolInput.url;
        const resp = await fetch(targetUrl, { headers: { "Accept": "text/html,application/json,*/*" } });
        const contentType = resp.headers.get("content-type") || "";
        const text = await resp.text();
        // Truncate large responses to avoid overwhelming context
        const truncated = text.length > 8000 ? text.slice(0, 8000) + "\n\n[truncated — " + text.length + " total chars]" : text;
        return JSON.stringify({ status: resp.status, contentType, body: truncated });
      } catch (err) {
        return "fetch_url error: " + err.message;
      }
    }

    case "list_assets": {
      try {
        const assets = await assetsManager.listAssets();
        return JSON.stringify(assets.map(a => ({ filename: a.filename, mimetype: a.mimetype, size: a.size })));
      } catch (err) {
        return "list_assets error: " + err.message;
      }
    }

    case "list_skills": {
      try {
        const skills = await settingsManager.getAllSkills();
        if (!skills || skills.length === 0) return "No skills registered. Brian can add one in Settings → Skills Library.";
        return JSON.stringify(skills.map(s => ({
          id: s.id,
          name: s.name,
          description: s.description || "",
          tags: s.tags || "",
        })));
      } catch (err) {
        return "list_skills error: " + err.message;
      }
    }

    case "read_skill": {
      try {
        const id = Number(toolInput.id);
        if (!Number.isFinite(id)) return "read_skill error: id must be a number";
        const skill = await settingsManager.getSkill(id);
        if (!skill) return "read_skill error: no skill with id " + id + ". Use list_skills to see what's available.";
        return `# Skill: ${skill.name}\n\n${skill.description ? skill.description + "\n\n" : ""}${skill.instructions}`;
      } catch (err) {
        return "read_skill error: " + err.message;
      }
    }

    case "browser_use": {
      try {
        const task = toolInput.task;
        if (!task || typeof task !== "string" || !task.trim()) {
          return "browser_use error: task is required";
        }
        const timeoutMs = Math.max(10000, Math.min(600000, (Number(toolInput.timeout_seconds) || 180) * 1000));

        let apiKey = process.env.BROWSER_USE_API_KEY;
        try {
          const vaultKey = await settingsManager.getSecret("BROWSER_USE_API_KEY");
          if (vaultKey) apiKey = vaultKey;
        } catch {}
        if (!apiKey) return "browser_use error: BROWSER_USE_API_KEY not configured in Settings → Secrets Vault.";

        const BASE = "https://api.browser-use.com/api/v3";
        const headers = { "X-Browser-Use-API-Key": apiKey, "Content-Type": "application/json" };

        // Create session with task
        if (sendEvent) sendEvent({ type: "tool_status", content: "browser: spinning up session..." });
        const createRes = await fetch(BASE + "/sessions", {
          method: "POST",
          headers,
          body: JSON.stringify({ task: task.trim() }),
        });
        const createData = await createRes.json();
        if (!createRes.ok) {
          return "browser_use error " + createRes.status + ": " + JSON.stringify(createData).slice(0, 400);
        }
        const sessionId = createData.id;
        if (!sessionId) return "browser_use error: no session id returned — " + JSON.stringify(createData).slice(0, 300);

        if (sendEvent && createData.liveUrl) {
          sendEvent({ type: "tool_status", content: "browser live: " + createData.liveUrl });
        }

        // Poll for completion
        const TERMINAL = new Set(["finished", "completed", "failed", "stopped", "timeout", "error"]);
        const started = Date.now();
        let pollInterval = 3000; // start fast, back off slightly
        let lastStatus = null;
        let sessionData = null;
        while (Date.now() - started < timeoutMs) {
          await new Promise((r) => setTimeout(r, pollInterval));
          pollInterval = Math.min(8000, pollInterval + 500);

          const pollRes = await fetch(BASE + "/sessions/" + sessionId, { headers });
          if (!pollRes.ok) {
            return "browser_use poll error " + pollRes.status + ": " + (await pollRes.text()).slice(0, 300);
          }
          sessionData = await pollRes.json();
          const status = (sessionData.status || "").toLowerCase();

          if (status !== lastStatus) {
            lastStatus = status;
            if (sendEvent) sendEvent({ type: "tool_status", content: "browser: " + status + (sessionData.lastStepSummary ? " — " + sessionData.lastStepSummary : "") });
          }

          if (TERMINAL.has(status)) break;
        }

        if (!sessionData || !TERMINAL.has((sessionData.status || "").toLowerCase())) {
          // Timed out — try to stop the session so Brian isn't billed for idle time
          try { await fetch(BASE + "/sessions/" + sessionId + "/stop", { method: "POST", headers }); } catch {}
          return "browser_use: timed out after " + Math.round(timeoutMs / 1000) + "s. Session id: " + sessionId + ". Last status: " + (sessionData?.status || "unknown") + ". Last step: " + (sessionData?.lastStepSummary || "(none)");
        }

        // Record cost in forge_usage (as a separate entry — not Anthropic)
        try {
          const costUsd = Number(sessionData.totalCostUsd || 0);
          if (costUsd > 0) {
            const { neon } = require("@neondatabase/serverless");
            const usageSql = neon(process.env.NEON_DATABASE_URL);
            await usageSql`
              INSERT INTO forge_usage (model, input_tokens, output_tokens, cost_usd, project_id, created_at)
              VALUES (${"browser-use"}, ${Number(sessionData.totalInputTokens) || 0}, ${Number(sessionData.totalOutputTokens) || 0}, ${costUsd}, ${null}, ${Date.now()})
              ON CONFLICT DO NOTHING
            `;
          }
        } catch (e) { console.error("[browser_use usage]", e.message); }

        // Build compact result
        const lines = [
          "status: " + sessionData.status + (sessionData.isTaskSuccessful === false ? " (task NOT successful)" : sessionData.isTaskSuccessful === true ? " (task successful)" : ""),
          "steps: " + (sessionData.stepCount ?? 0),
          sessionData.totalCostUsd != null ? "cost_usd: " + sessionData.totalCostUsd : null,
          Array.isArray(sessionData.recordingUrls) && sessionData.recordingUrls.length ? "recording: " + sessionData.recordingUrls[0] : null,
          sessionData.lastStepSummary ? "last_step: " + sessionData.lastStepSummary : null,
          "",
          "output:",
          typeof sessionData.output === "string" ? sessionData.output : JSON.stringify(sessionData.output, null, 2),
        ].filter(Boolean);
        return lines.join("\n");
      } catch (err) {
        return "browser_use error: " + err.message;
      }
    }

    // ── Google Workspace ────────────────────────────────────────────────
    case "gmail_search": {
      try {
        const threads = await googleGmail.searchThreads({ query: toolInput.query, maxResults: toolInput.max_results });
        return JSON.stringify(threads);
      } catch (err) { return "gmail_search error: " + err.message; }
    }
    case "gmail_read_thread": {
      try {
        const thread = await googleGmail.readThread(toolInput.thread_id);
        return JSON.stringify(thread);
      } catch (err) { return "gmail_read_thread error: " + err.message; }
    }
    case "gmail_list_labels": {
      try {
        const labels = await googleGmail.listLabels();
        return JSON.stringify(labels);
      } catch (err) { return "gmail_list_labels error: " + err.message; }
    }
    case "gmail_modify_labels": {
      try {
        const result = await googleGmail.modifyThreadLabels(toolInput.thread_id, {
          addLabelIds: toolInput.add_label_ids || [],
          removeLabelIds: toolInput.remove_label_ids || [],
        });
        return JSON.stringify({ ok: true, id: result.id });
      } catch (err) { return "gmail_modify_labels error: " + err.message; }
    }
    case "gmail_create_draft": {
      try {
        const draft = await googleGmail.createDraft({
          to: toolInput.to, cc: toolInput.cc, bcc: toolInput.bcc,
          subject: toolInput.subject, body: toolInput.body,
          threadId: toolInput.thread_id, inReplyTo: toolInput.in_reply_to,
        });
        return `Draft created. id=${draft.id} — review in Gmail → Drafts.`;
      } catch (err) { return "gmail_create_draft error: " + err.message; }
    }
    case "gmail_send": {
      try {
        const msg = await googleGmail.sendMessage({
          to: toolInput.to, cc: toolInput.cc, bcc: toolInput.bcc,
          subject: toolInput.subject, body: toolInput.body,
          threadId: toolInput.thread_id, inReplyTo: toolInput.in_reply_to,
        });
        return `Sent. message id=${msg.id}, thread=${msg.threadId}.`;
      } catch (err) { return "gmail_send error: " + err.message; }
    }
    case "calendar_list_calendars": {
      try {
        const cals = await googleCalendar.listCalendars();
        return JSON.stringify(cals);
      } catch (err) { return "calendar_list_calendars error: " + err.message; }
    }
    case "calendar_list_events": {
      try {
        const now = new Date();
        const events = await googleCalendar.listEvents({
          calendarId: toolInput.calendar_id,
          timeMin: toolInput.time_min || now.toISOString(),
          timeMax: toolInput.time_max || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          q: toolInput.q,
          maxResults: toolInput.max_results,
        });
        return JSON.stringify(events);
      } catch (err) { return "calendar_list_events error: " + err.message; }
    }
    case "calendar_create_event": {
      try {
        const event = await googleCalendar.createEvent({
          calendarId: toolInput.calendar_id,
          summary: toolInput.summary,
          description: toolInput.description,
          location: toolInput.location,
          start: toolInput.start,
          end: toolInput.end,
          timeZone: toolInput.time_zone,
          attendees: toolInput.attendees,
          sendUpdates: toolInput.send_updates,
        });
        return `Event created. id=${event.id}, link=${event.htmlLink}`;
      } catch (err) { return "calendar_create_event error: " + err.message; }
    }
    case "calendar_update_event": {
      try {
        const event = await googleCalendar.updateEvent({
          calendarId: toolInput.calendar_id,
          eventId: toolInput.event_id,
          patch: toolInput.patch || {},
          sendUpdates: toolInput.send_updates,
        });
        return `Event updated. id=${event.id}, link=${event.htmlLink}`;
      } catch (err) { return "calendar_update_event error: " + err.message; }
    }
    case "calendar_delete_event": {
      try {
        const result = await googleCalendar.deleteEvent({
          calendarId: toolInput.calendar_id,
          eventId: toolInput.event_id,
          sendUpdates: toolInput.send_updates,
        });
        return JSON.stringify(result);
      } catch (err) { return "calendar_delete_event error: " + err.message; }
    }
    case "drive_search": {
      try {
        const files = await googleDrive.search({
          q: toolInput.query,
          folderId: toolInput.folder_id,
          pageSize: toolInput.page_size,
        });
        return JSON.stringify(files);
      } catch (err) { return "drive_search error: " + err.message; }
    }
    case "drive_list_folder": {
      try {
        const files = await googleDrive.listFolder({
          folderId: toolInput.folder_id || "root",
          pageSize: toolInput.page_size,
        });
        return JSON.stringify(files);
      } catch (err) { return "drive_list_folder error: " + err.message; }
    }
    case "drive_read_file": {
      try {
        const result = await googleDrive.readFile(toolInput.file_id, { maxBytes: toolInput.max_bytes });
        // Wrap so Frank knows what's text vs base64.
        return JSON.stringify({
          name: result.meta.name,
          mimeType: result.meta.mimeType,
          encoding: result.encoding,
          truncated: result.truncated,
          totalBytes: result.totalBytes,
          content: result.content,
        });
      } catch (err) { return "drive_read_file error: " + err.message; }
    }
    case "drive_write_file": {
      try {
        const file = await googleDrive.writeFile({
          name: toolInput.name,
          parentId: toolInput.parent_id,
          mimeType: toolInput.mime_type,
          content: toolInput.content,
          encoding: toolInput.encoding,
          fileId: toolInput.file_id,
        });
        return `File ${toolInput.file_id ? "updated" : "created"}. id=${file.id}, name=${file.name}, link=${file.webViewLink}`;
      } catch (err) { return "drive_write_file error: " + err.message; }
    }
    case "drive_create_folder": {
      try {
        const folder = await googleDrive.createFolder({
          name: toolInput.name,
          parentId: toolInput.parent_id,
        });
        return `Folder created. id=${folder.id}, name=${folder.name}, link=${folder.webViewLink}`;
      } catch (err) { return "drive_create_folder error: " + err.message; }
    }
    case "drive_move_file": {
      try {
        const file = await googleDrive.moveFile({
          fileId: toolInput.file_id,
          addParents: toolInput.add_parents,
          removeParents: toolInput.remove_parents,
        });
        return `File moved. id=${file.id}, parents=${JSON.stringify(file.parents)}`;
      } catch (err) { return "drive_move_file error: " + err.message; }
    }
    case "drive_delete_file": {
      try {
        const result = await googleDrive.deleteFile(toolInput.file_id, { trash: toolInput.trash !== false });
        return JSON.stringify(result);
      } catch (err) { return "drive_delete_file error: " + err.message; }
    }
    case "docs_read": {
      try {
        const doc = await googleDocs.readDoc(toolInput.document_id);
        return JSON.stringify(doc);
      } catch (err) { return "docs_read error: " + err.message; }
    }
    case "docs_append_text": {
      try {
        await googleDocs.appendText(toolInput.document_id, toolInput.text);
        return `Appended ${toolInput.text.length} chars to doc ${toolInput.document_id}.`;
      } catch (err) { return "docs_append_text error: " + err.message; }
    }
    case "docs_replace_text": {
      try {
        const replacements = (toolInput.replacements || []).map((r) => ({
          find: r.find, replace: r.replace, matchCase: r.match_case,
        }));
        await googleDocs.replaceAllText(toolInput.document_id, replacements);
        return `Applied ${replacements.length} replacement(s) in doc ${toolInput.document_id}.`;
      } catch (err) { return "docs_replace_text error: " + err.message; }
    }
    case "docs_create": {
      try {
        const doc = await googleDocs.createDoc({ title: toolInput.title });
        return `Doc created. id=${doc.documentId}, link=https://docs.google.com/document/d/${doc.documentId}/edit`;
      } catch (err) { return "docs_create error: " + err.message; }
    }
    case "contacts_search": {
      try {
        const results = await googleContacts.searchContacts(toolInput.query, { pageSize: toolInput.page_size });
        return JSON.stringify(results);
      } catch (err) { return "contacts_search error: " + err.message; }
    }

    case "ask_user":
      sendEvent({ type: "agent_message", content: toolInput.message });
      return "Message sent to user.";

    default:
      return "Unknown tool: " + toolName;
  }
}

// ─── Approval endpoint — client sends approval/rejection for pending writes ──
app.post("/api/projects/:id/chat/approve", (req, res) => {
  const { approvalId, approved } = req.body; // approved: true, false, or "approve_all"
  const resolver = pendingApprovals.get(approvalId);
  if (resolver) {
    resolver(approved); // true = approve once, "approve_all" = approve all, false = cancel
    pendingApprovals.delete(approvalId);
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: "No pending approval with that ID" });
  }
});

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
    // We keep the history in Anthropic format for DB storage consistency
    history = rows.map(r => ({ role: r.role, content: r.content }));
  } catch {}

  brain.appendConversation(project.id, "user", message.trim()).catch(() => {});

  // SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  function send(evt) { res.write("data: " + JSON.stringify(evt) + "\n\n"); }

  try {
    const Anthropic = require("@anthropic-ai/sdk");
    // Read API key from global secrets vault first, fall back to process.env
    let anthropicKey = process.env.ANTHROPIC_API_KEY;
    try {
      const vaultKey = await settingsManager.getSecret("ANTHROPIC_API_KEY");
      if (vaultKey) anthropicKey = vaultKey;
    } catch {}
    const client = new Anthropic.default({ apiKey: anthropicKey });

    // Memory context
    let memoryBlock = "";
    try {
      memoryBlock = await Promise.race([
        brain.buildContext(message.trim(), project.id),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000)),
      ]);
    } catch {}

    // Build system prompt
    const sysParts = [];
    const pubApp = publishManager.getPublishedApp(project.id);
    const projectSlug = pubApp ? pubApp.slug : require("./publish/manager").generateSlug(project.name);
    const projectBranch = "apps/" + projectSlug;
    const projectUrl = "https://" + projectSlug + ".forge-os.ai";
    sysParts.push(`## THIS PROJECT\nName: ${project.name}\nBranch: ${projectBranch}\nLive URL: ${projectUrl}\n\nAlways use branch: '${projectBranch}' in every github_write, github_patch, and github_ls call for this project.`);

    // Brand profiles: concatenate every brand linked to this project
    try {
      const brandsForProject = await brandsManager.getBrandsForProject(project.id);
      if (brandsForProject.length > 0) {
        const brandsBlock = brandsForProject
          .filter(b => b.profile && b.profile.trim())
          .map(b => `### ${b.name}\n\n${b.profile.trim()}`)
          .join("\n\n---\n\n");
        if (brandsBlock) {
          sysParts.push("## BRAND PROFILES\n\nThis project is linked to the brand(s) below. Match colors, typography, nav/footer structure, container patterns, and voice exactly. Flag any request that would break these.\n\n" + brandsBlock);
        }
      }
    } catch (err) {
      console.error("[chat] Failed to load brand profiles:", err.message);
    }

    if (memoryBlock && memoryBlock.trim()) sysParts.push("## RELEVANT MEMORY\n" + memoryBlock.trim());
    if (skillContext) sysParts.push("## SKILL INSTRUCTIONS\n" + skillContext);

    // ── Repo Access Protocol ────────────────────────────────────────────────
    // If the user mentioned /<slug> in ANY message this conversation (first
    // turn or earlier) for a skill that's a repo_access type, resolve the
    // repo coordinates + PAT and make every github_* tool in this turn
    // target that repo instead of ForgeOS. Sticky across turns so users
    // don't have to re-slash every message.
    //
    // How slugs are computed: client inserts /<slug> where slug is the skill
    // name lowercased, spaces/punctuation → hyphens. We mirror that here so
    // the slash-invocation flow we already have works without client changes.
    let repoContext = null;
    const historyText = (history || [])
      .map(m => typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? (m.content.find(c => c.type === "text")?.text || "") : ""))
      .join("\n");
    const scanText = [historyText, message || ""].join("\n");
    const slugMatches = scanText.matchAll(/(^|\s)\/([a-z0-9][a-z0-9-]*)/gi);
    const mentionedSlugs = new Set();
    for (const m of slugMatches) mentionedSlugs.add(m[2].toLowerCase());
    if (mentionedSlugs.size > 0) {
      try {
        const allSkills = await settingsManager.getAllSkills();
        const toSlug = (name) => String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        const repoSkill = allSkills.find(s => s.skillType === "repo_access" && mentionedSlugs.has(toSlug(s.name)));
        if (repoSkill && repoSkill.repoOwner && repoSkill.repoName) {
          const token = await settingsManager.getSkillRepoToken(repoSkill.id);
          if (token) {
            repoContext = {
              skillId: repoSkill.id,
              repoOwner: repoSkill.repoOwner,
              repoName: repoSkill.repoName,
              defaultBranch: repoSkill.repoBranch || "main",
              token,
            };
            sysParts.push(
              "## REPO ACCESS PROTOCOL\n\n" +
              `You are working inside **${repoSkill.repoOwner}/${repoSkill.repoName}**, not ForgeOS itself.\n` +
              `Default branch: ${repoContext.defaultBranch}\n\n` +
              "All github_read, github_ls, github_write, github_patch, and github_create_branch calls in this conversation target this repo with this repo's PAT. You do NOT need to pass the repo name — it's resolved automatically. Passing a branch is optional; if omitted the default branch is used.\n\n" +
              "You CAN write to main on this repo — the ForgeOS-main block does not apply here. Brian will approve every write via the approval card.\n\n" +
              "You do NOT manage Render, deploys, or domains for this repo. Brian watches deploys himself. If a deploy fails, he'll come back with logs." +
              (repoSkill.instructions && repoSkill.instructions.trim()
                ? "\n\n### Additional rules for this repo:\n" + repoSkill.instructions.trim()
                : "")
            );
          } else {
            console.warn(`[chat] skill ${repoSkill.id} is repo_access but has no token stored`);
          }
        }
      } catch (err) {
        console.error("[chat] Failed to resolve repo access protocol:", err.message);
      }
    }

    sysParts.push(FORGE_SYSTEM_PROMPT);
    const systemPrompt = sysParts.join("\n\n");

    // Build Anthropic messages array from history
    const anthropicMessages = history.map(msg => ({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: typeof msg.content === "string" ? msg.content :
        (Array.isArray(msg.content) ? msg.content.find(c => c.type === "text")?.text || "" : ""),
    })).filter(m => m.content);

    // Add current user message with optional attachments
    const userContent = [];
    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        userContent.push({
          type: "image",
          source: { type: "base64", media_type: att.mimeType || "image/png", data: att.dataUrl.split(",")[1] || att.dataUrl },
        });
      }
    }
    userContent.push({ type: "text", text: message.trim() });
    anthropicMessages.push({ role: "user", content: userContent });

    // Convert FORGE_TOOLS (Gemini format) to Anthropic tool format
    const anthropicTools = FORGE_TOOLS.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters || { type: "object", properties: {}, required: [] },
    }));

    let fullAssistantMessage = "";
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const MAX_ROUNDS = 20;
    let autoApproveWrites = false; // Set to true when user clicks "Approve All Writes"

    // Retry wrapper for transient Anthropic errors (overloaded_error,
    // rate_limit_error, 5xx). Backoff: 1s, 3s, 7s. Gives up after 3 attempts
    // and re-throws the last error for the outer catch to handle.
    const RETRIABLE_TYPES = new Set(["overloaded_error", "rate_limit_error", "api_error"]);
    const isRetriable = (err) => {
      if (!err) return false;
      const status = err.status || err.statusCode;
      if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === 529) return true;
      const type = err.error?.error?.type || err.error?.type || err.type;
      if (type && RETRIABLE_TYPES.has(type)) return true;
      return false;
    };
    const streamWithRetry = async () => {
      const delays = [1000, 3000, 7000];
      let lastErr = null;
      for (let attempt = 0; attempt < delays.length + 1; attempt++) {
        try {
          return await client.messages.stream({
            model: "claude-opus-4-7",
            max_tokens: 16000,
            system: systemPrompt,
            tools: anthropicTools,
            messages: anthropicMessages,
          });
        } catch (err) {
          lastErr = err;
          if (attempt >= delays.length || !isRetriable(err)) throw err;
          const wait = delays[attempt];
          const type = err.error?.error?.type || err.error?.type || err.type || "transient";
          console.log(`[forge] Anthropic ${type} — retrying in ${wait}ms (attempt ${attempt + 1}/${delays.length})`);
          send({ type: "tool_status", content: `Anthropic is busy — retrying in ${Math.round(wait / 1000)}s...` });
          await new Promise((r) => setTimeout(r, wait));
        }
      }
      throw lastErr;
    };

    for (let round = 0; round < MAX_ROUNDS; round++) {
      let streamText = "";
      const toolUses = [];

      const stream = await streamWithRetry();

      for await (const event of stream) {
        if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            streamText += event.delta.text;
            send({ type: "thinking", content: streamText });
          }
        } else if (event.type === "content_block_stop") {
          // captured via accumulation
        } else if (event.type === "message_delta" && event.delta.stop_reason) {
          // handled below
        }
      }

      const finalMsg = await stream.finalMessage();

      // Accumulate token usage across rounds
      if (finalMsg.usage) {
        totalInputTokens += finalMsg.usage.input_tokens || 0;
        totalOutputTokens += finalMsg.usage.output_tokens || 0;
      }

      // Extract text and tool_use blocks
      const textBlocks = finalMsg.content.filter(b => b.type === "text");
      const toolBlocks = finalMsg.content.filter(b => b.type === "tool_use");
      const assistantText = textBlocks.map(b => b.text).join("").trim();

      // Add assistant turn to history
      anthropicMessages.push({ role: "assistant", content: finalMsg.content });

      if (toolBlocks.length === 0) {
        fullAssistantMessage = assistantText;
        break;
      }

      // Execute tools and collect results — approval gate for writes
      const toolResults = [];
      for (const toolUse of toolBlocks) {
        console.log(`[forge] round=${round} tool=${toolUse.name}`, JSON.stringify(toolUse.input).slice(0, 120));
        if (send) send({ type: "tool_status", content: toolUse.name + "..." });

        // Approval gate: pause and wait for client approval on write tools
        if (APPROVAL_TOOLS.has(toolUse.name) && !autoApproveWrites) {
          const approvalId = `apr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          send({ type: "approval_required", approvalId, tool: toolUse.name, input: toolUse.input });

          const approved = await new Promise((resolve) => {
            pendingApprovals.set(approvalId, resolve);
            setTimeout(() => { if (pendingApprovals.has(approvalId)) { pendingApprovals.delete(approvalId); resolve(false); } }, 300000);
          });

          if (approved === "approve_all") {
            autoApproveWrites = true; // Skip approval for rest of this chat request
          } else if (!approved) {
            toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: "User cancelled this action." });
            send({ type: "tool_status", content: "✗ Cancelled: " + (toolUse.input.filepath || toolUse.name) });
            continue;
          }
          send({ type: "tool_status", content: "Approved — executing " + toolUse.name + "..." });
        }

        const result = await executeForgeToken(toolUse.name, toolUse.input, send, repoContext);
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: String(result),
        });
      }

      anthropicMessages.push({ role: "user", content: toolResults });
    }

    brain.appendConversation(project.id, "assistant", fullAssistantMessage).catch(() => {});
    brain.extractMemory({ projectId: project.id, userRequest: message.trim(), buildSummary: fullAssistantMessage.slice(0, 500), files: [] }).catch(() => {});

    // Persist usage to Neon
    if (totalInputTokens > 0 || totalOutputTokens > 0) {
      try {
        const { neon } = require("@neondatabase/serverless");
        const usageSql = neon(process.env.NEON_DATABASE_URL);
        // Pricing: Opus 4.7 $5/$25 per 1M tokens (input/output)
        const inputCost = (totalInputTokens / 1_000_000) * 5;
        const outputCost = (totalOutputTokens / 1_000_000) * 25;
        await usageSql`
          INSERT INTO forge_usage (model, input_tokens, output_tokens, cost_usd, project_id, created_at)
          VALUES (${"claude-opus-4-7"}, ${totalInputTokens}, ${totalOutputTokens}, ${inputCost + outputCost}, ${project.id}, ${Date.now()})
          ON CONFLICT DO NOTHING
        `;
        send({ type: "usage", inputTokens: totalInputTokens, outputTokens: totalOutputTokens, costUsd: inputCost + outputCost });
      } catch(e) { console.error("[usage]", e.message); }
    }

    send({ type: "done", role: "assistant", content: fullAssistantMessage, building: false, createdAt: Date.now() });

  } catch (err) {
    console.error("[forge] Chat error:", err.message, err.stack);

    // Translate common Anthropic errors into human-readable messages.
    const type = err.error?.error?.type || err.error?.type || err.type;
    const status = err.status || err.statusCode;
    let friendly;
    if (type === "overloaded_error" || status === 529) {
      friendly = "Anthropic is overloaded right now and my retries didn't clear it. This usually sorts itself in a few minutes — try again shortly.";
    } else if (type === "rate_limit_error" || status === 429) {
      friendly = "Rate limit hit on the Anthropic API. Give it a minute and retry.";
    } else if (type === "authentication_error" || status === 401) {
      friendly = "Anthropic authentication failed. Check the ANTHROPIC_API_KEY in Settings → Secrets Vault.";
    } else if (type === "permission_error" || status === 403) {
      friendly = "Anthropic denied the request (permission error). The API key may lack access to claude-opus-4-7.";
    } else if (type === "not_found_error" || status === 404) {
      friendly = "Model not found on Anthropic. If this just started happening, the claude-opus-4-7 model string may have changed.";
    } else if (type === "invalid_request_error" || status === 400) {
      friendly = "Anthropic rejected the request: " + err.message;
    } else if (status >= 500) {
      friendly = "Anthropic server error (" + status + "). Try again in a moment.";
    } else {
      friendly = "Chat error: " + err.message;
    }
    send({ type: "error", error: friendly });
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
  // ── Usage table ─────────────────────────────────────────────────────────────
(async () => {
  try {
    const { neon } = require("@neondatabase/serverless");
    const s = neon(process.env.NEON_DATABASE_URL);
    await s`CREATE TABLE IF NOT EXISTS forge_usage (
      id SERIAL PRIMARY KEY,
      model TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cost_usd NUMERIC(10,6) DEFAULT 0,
      project_id TEXT,
      created_at BIGINT
    )`;
  } catch(e) { console.error("[usage schema]", e.message); }
})();

// ── Dashboard routes — mirrored from Mission Control ─────────────────────────

app.get("/api/dashboard/status", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  const RENDER_SERVICE_ID = "srv-d6h2rt56ubrc73duanfg";
  let anthropicConfigured = !!process.env.ANTHROPIC_API_KEY;
  if (!anthropicConfigured) {
    try {
      const vaultKey = await settingsManager.getSecret("ANTHROPIC_API_KEY");
      if (vaultKey) anthropicConfigured = true;
    } catch {}
  }
  const checks = {
    anthropic: anthropicConfigured,
    github: !!process.env.GITHUB_TOKEN,
    render: !!process.env.RENDER_API_KEY,
    neon: !!process.env.NEON_DATABASE_URL,
  };
  try {
    const [renderResult, forgeResult] = await Promise.all([
      fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}`, {
        headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, Accept: "application/json" }
      }).then(async r => {
        if (r.status !== 200) return { state: "error", name: "ForgeOS", updatedAt: null };
        const d = await r.json();
        const topSuspended = d.suspended;
        let state;
        if (topSuspended === "suspended") state = "suspended";
        else if (topSuspended === "not_suspended") state = d.serviceDetails?.status || "live";
        else state = "unknown";
        return { state, name: d.name || "ForgeOS", updatedAt: d.updatedAt || null };
      }).catch(() => ({ state: "unreachable", name: "ForgeOS", updatedAt: null })),
      (async () => {
        const start = Date.now();
        try {
          const r = await fetch("https://forge-os.ai/api/health", { signal: AbortSignal.timeout(5000) });
          return { alive: r.status === 200, latencyMs: Date.now() - start };
        } catch { return { alive: false, latencyMs: null }; }
      })()
    ]);
    res.json({ ok: true, credentials: checks, render: renderResult, forge: forgeResult, timestamp: new Date().toISOString() });
  } catch (err) {
    res.json({ ok: false, credentials: checks, error: err.message });
  }
});

app.get("/api/dashboard/builds", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const r = await fetch("https://api.github.com/repos/BrianBMorgan/ForgeOS/commits?per_page=20", {
      headers: { Authorization: `token ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json", "User-Agent": "ForgeOS/2.0" }
    });
    if (r.status === 403 || r.status === 429) return res.json({ ok: false, error: `GitHub ${r.status} — rate limit`, builds: [] });
    if (r.status !== 200) return res.json({ ok: false, error: `GitHub ${r.status}`, builds: [] });
    const commits = await r.json();
    if (!Array.isArray(commits)) return res.json({ ok: false, error: "Unexpected response", builds: [] });
    const builds = commits.map(c => ({
      sha: c.sha ? c.sha.slice(0, 7) : "?",
      message: c.commit?.message ? c.commit.message.split("\n")[0].slice(0, 90) : "(no message)",
      author: c.commit?.author?.name || "unknown",
      date: c.commit?.author?.date || null,
      url: c.html_url || null,
    }));
    res.json({ ok: true, builds });
  } catch (err) {
    res.json({ ok: false, builds: [], error: err.message });
  }
});

app.get("/api/dashboard/memory", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const r = await fetch("https://forge-os.ai/api/brain", { headers: { Accept: "application/json" } });
    if (r.status !== 200) return res.json({ ok: false, error: `Brain returned ${r.status}`, stats: null, categories: [] });
    const data = await r.json();
    const totals = data.totals || {};
    const total = (totals.projects || 0) + (totals.preferences || 0) + (totals.patterns || 0) + (totals.mistakes || 0) + (totals.snippets || 0);
    const categories = [
      { category: "patterns",    count: totals.patterns    || 0 },
      { category: "preferences", count: totals.preferences || 0 },
      { category: "snippets",    count: totals.snippets    || 0 },
      { category: "mistakes",    count: totals.mistakes    || 0 },
      { category: "projects",    count: totals.projects    || 0 },
    ].filter(c => c.count > 0);
    res.json({ ok: true, stats: { total }, categories, topMemories: data.topMistakes || [] });
  } catch (err) {
    res.json({ ok: false, error: err.message, stats: null, categories: [] });
  }
});

app.get("/api/dashboard/logs", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  const RENDER_SERVICE_ID = "srv-d6h2rt56ubrc73duanfg";
  const key = process.env.RENDER_API_KEY || "";
  if (!key) return res.json({ ok: false, error: "RENDER_API_KEY not set", lines: [] });
  try {
    const svcRes = await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }
    });
    if (svcRes.status !== 200) return res.json({ ok: false, error: `Service fetch ${svcRes.status}`, lines: [] });
    const svc = await svcRes.json();
    const ownerId = svc.ownerId || "";
    if (!ownerId) return res.json({ ok: false, error: "Could not determine ownerId", lines: [] });
    const logsRes = await fetch(
      `https://api.render.com/v1/logs?ownerId=${encodeURIComponent(ownerId)}&resource=${encodeURIComponent(RENDER_SERVICE_ID)}&limit=40&direction=backward`,
      { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } }
    );
    if (logsRes.status !== 200) return res.json({ ok: false, error: `Logs API ${logsRes.status}`, lines: [] });
    const parsed = await logsRes.json();
    const lines = (parsed.logs || []).map(e => e.message || "").filter(Boolean);
    res.json({ ok: true, lines });
  } catch (err) {
    res.json({ ok: false, error: err.message, lines: [] });
  }
});

app.post("/api/dashboard/redeploy", async (_req, res) => {
  const RENDER_SERVICE_ID = "srv-d6h2rt56ubrc73duanfg";
  const key = process.env.RENDER_API_KEY || "";
  if (!key) return res.json({ ok: false, error: "RENDER_API_KEY not set" });
  try {
    const r = await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/deploys`, {
      method: "POST", body: JSON.stringify({ clearCache: false }),
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" }
    });
    const data = await r.json();
    if (r.status === 200 || r.status === 201) return res.json({ ok: true, deployId: data.id || data.deploy?.id || "" });
    res.json({ ok: false, error: `Render responded ${r.status}` });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get("/api/dashboard/usage", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const { neon } = require("@neondatabase/serverless");
    const s = neon(process.env.NEON_DATABASE_URL);
    const [totals, recent, byModel] = await Promise.all([
      s`SELECT SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens, SUM(cost_usd) as cost_usd FROM forge_usage`,
      s`SELECT model, input_tokens, output_tokens, cost_usd, project_id, created_at FROM forge_usage ORDER BY created_at DESC LIMIT 20`,
      s`SELECT model, SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens, SUM(cost_usd) as cost_usd, COUNT(*) as calls FROM forge_usage GROUP BY model ORDER BY cost_usd DESC`,
    ]);
    res.json({
      ok: true,
      totals: {
        inputTokens: parseInt(totals[0]?.input_tokens || 0),
        outputTokens: parseInt(totals[0]?.output_tokens || 0),
        costUsd: parseFloat(totals[0]?.cost_usd || 0),
      },
      byModel: byModel.map(r => ({
        model: r.model,
        inputTokens: parseInt(r.input_tokens),
        outputTokens: parseInt(r.output_tokens),
        costUsd: parseFloat(r.cost_usd),
        calls: parseInt(r.calls),
      })),
      recent: recent.map(r => ({
        model: r.model,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        costUsd: parseFloat(r.cost_usd),
        projectId: r.project_id,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

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
