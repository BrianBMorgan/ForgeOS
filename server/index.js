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
          return res.json({ published: true, ...app, status: "running" });
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

// ── FORGE CHAT — Direct Gemini Streaming ──────────────────────────────────
// Gemini Code architecture. No agent loop. No nudges. No guards.
// Gemini gets tools and a system prompt. It calls tools when it needs to.
// It stops when it is done. We get out of the way.
const { GoogleGenerativeAI } = require("@google/generative-ai");


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
  {
    name: "write_code",
    description: "Hand off a coding task to Gemini 2.5 Pro. Use this whenever you need to write or substantially rewrite files. Read the relevant files first with github_read, then call write_code with full file context and precise requirements. Take what it returns and commit with github_write. Do not write code directly in your responses.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "Precise description of what to build or change." },
        files_context: { type: "object", description: "Current contents of relevant files keyed by filename." },
        requirements: { type: "array", items: { type: "string" }, description: "Specific requirements the code must meet." },
        output_files: { type: "array", items: { type: "string" }, description: "Which files to return." },
      },
      required: ["task", "files_context", "requirements", "output_files"],
    },
  },
];

const FORGE_SYSTEM_PROMPT = `You are Frank — a senior software architect and engineering partner. You think before you delegate. You ask when something is unclear. You break complex problems into clean pieces before calling up the code monkey.

You work inside ForgeOS — a deployment platform where every project lives on a GitHub branch (apps/<slug>) and auto-deploys to Render. Brian talks to you. You figure out what to build, plan it, then hand the spec to your code generation agent via the write_code tool. You never write code yourself.

## YOUR ROLE

You are the architect. You:
- Understand what Brian actually wants — ask clarifying questions when the request is ambiguous
- Read existing code before requesting changes
- Search memory and skills for relevant patterns before speccing anything
- Search the web when you need current information, docs, or API references
- Break builds into logical chunks — schema first, then routes, then UI
- Call write_code with precise specs and full file context
- Commit what comes back with github_write
- Verify the deploy with render_status
- Report back clearly — what shipped, what the URL is, what still needs doing

You do not write code. You think, plan, spec, and delegate.

## YOUR TOOLS

- github_create_branch — create a new apps/<slug> branch when it doesn't exist yet
- github_ls — explore what exists on a branch
- github_read — read any file before requesting changes to it
- github_write — commit files returned by write_code
- github_patch — surgical find/replace for small targeted changes
- render_status — check deploy status and get the live URL
- memory_search — search past builds for patterns and lessons
- fetch_url — fetch any URL: web pages, documentation, APIs, or /api/skills to load skill instructions
- ask_user — ask Brian a question when you genuinely need clarification
- write_code — hand off a coding task to an external code generation agent (Gemini 2.5 Pro). You are not writing the code — you are specifying precisely what needs to be built and providing full context. The agent returns complete files. You commit them.

## HOW TO BUILD

1. Search memory with memory_search for relevant patterns from past builds
2. If a skill applies, fetch it with fetch_url at /api/skills
3. Read existing files with github_read
4. Ask Brian if anything is still unclear with ask_user
5. **Call write_code immediately once you have the spec** — do not narrate the plan, do not summarize what you are about to do, just call it
6. Commit each returned file with github_write
7. Check render_status once to confirm deploy status
8. Report what shipped and the live URL

## write_code — CALL IT, DON'T ANNOUNCE IT

The moment you have read the files and formed the spec, call write_code. Do not say "I'll now call write_code" or "Here's my plan before I proceed." Just call it. Brian can see the tool call happening. Narrating it wastes time and makes the stream feel slow.

## DEPLOY TIMING — CRITICAL

Render deploys take 2-4 minutes. You have no internal clock. Do not guess how long something has been deploying. Follow this exact protocol:

1. After committing files, call render_status once immediately
2. If status is "deploying" — report the URL to Brian and say it will be live in 2-4 minutes. STOP. Do not poll again.
3. Brian will check it himself. Only call render_status again if Brian explicitly asks.

Never say "still deploying", "almost done", "this is taking longer than expected", or any variation. You don't know how long it has been. A deploy that feels instant to you may have been 30 seconds or 5 minutes. Just give Brian the URL and let Render do its job.

## PLATFORM RULES

- Branch: apps/<slug> — already provisioned, never write to main
- CRITICAL: Always pass branch: 'apps/<slug>' explicitly in every github_write and github_patch call. Omitting it defaults to main and is blocked.
- CommonJS on server — no ES modules
- @neondatabase/serverless for all databases
- No dotenv — env vars injected at runtime
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
- Ask one focused question at a time when you need clarification
- Never describe what you are about to do — do it, then report what you did

## IF write_code FAILS

If write_code returns an error, tell Brian exactly what the error was and stop. Do not attempt to write code yourself. Do not fall back to github_write with hand-written code. You are the architect — if the code agent is unavailable, the build stops until it is fixed.

## MANDATORY: render_status before reporting live

Never tell Brian an app is live until render_status confirms it. Call it once after committing. If deploying, give Brian the URL and stop polling.`;

async function executeForgeToken(toolName, toolInput, sendEvent) {
  switch (toolName) {

    case "github_create_branch": {
      try {
        const branch = toolInput.branch;
        if (!branch) return "Error: branch name required";
        const headers = githubHeaders();
        const refRes = await fetch("https://api.github.com/repos/" + GITHUB_REPO + "/git/ref/heads/main", { headers });
        const refData = await refRes.json();
        if (!refRes.ok) return "GitHub error: " + JSON.stringify(refData).slice(0, 200);
        const sha = refData.object.sha;
        const createRes = await fetch("https://api.github.com/repos/" + GITHUB_REPO + "/git/refs", {
          method: "POST", headers, body: JSON.stringify({ ref: "refs/heads/" + branch, sha }),
        });
        const createData = await createRes.json();
        if (!createRes.ok) {
          if (createRes.status === 422) return "Branch " + branch + " already exists.";
          return "GitHub error: " + JSON.stringify(createData).slice(0, 200);
        }
        if (sendEvent) sendEvent({ type: "tool_status", content: "✓ Created branch: " + branch });
        return "Branch " + branch + " created from main (" + sha.slice(0, 7) + ")";
      } catch (err) { return "github_create_branch error: " + err.message; }
    }

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
        // ABSOLUTE BLOCK: nothing gets written to main — ever
        if (branch === "main") {
          return "BLOCKED: Writing to main is not permitted. Main is ForgeOS itself. " +
            "All app files must be written to apps/<slug> branch. Specify branch: 'apps/<slug>' in your call.";
        }
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
        sendEvent({ type: "file_committed", filepath: toolInput.filepath, branch: branch, commit: commitSha });

        // Auto-provision Render service if writing to an apps/* branch with no service yet
        if (branch.startsWith("apps/")) {
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

        return "Pushed " + toolInput.filepath + " to " + branch + " — commit: " + commitSha;
      } catch (err) { return "github_write error: " + err.message; }
    }

    case "github_patch": {
      try {
        const branch = toolInput.branch || "main";
        // ABSOLUTE BLOCK: nothing gets patched on main — ever
        if (branch === "main") {
          return "BLOCKED: Patching main is not permitted. Main is ForgeOS itself. " +
            "All app changes must go to apps/<slug> branch.";
        }
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

    case "write_code": {
      try {
        const { GoogleGenerativeAI } = require("@google/generative-ai");
        const geminiKey = process.env.GEMINI_API_KEY;
        if (!geminiKey) return "Error: GEMINI_API_KEY not set";
        const genAI = new GoogleGenerativeAI(geminiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });
        const systemPrompt = "You are a code generation engine. Return complete file contents only.\nRules:\n- Return complete files. Never truncate. Never use placeholder comments.\n- No explanation. No preamble. No markdown fences.\n- Return valid JSON only: { \"files\": { \"filename\": \"complete file contents\" } }\n- If a file is not changing, omit it.\n- CommonJS on server (require/module.exports). No dotenv. PORT = process.env.PORT || 3000.";
        const filesBlock = Object.entries(toolInput.files_context || {}).map(function(e) { return "=== " + e[0] + " ===\n" + e[1]; }).join("\n\n");
        const userPrompt = "TASK: " + toolInput.task + "\n\nREQUIREMENTS:\n" + (toolInput.requirements || []).map(function(r, i) { return (i+1) + ". " + r; }).join("\n") + "\n\nEXISTING FILES:\n" + filesBlock + "\n\nOUTPUT FILES NEEDED: " + (toolInput.output_files || []).join(", ") + "\n\nReturn JSON only: { \"files\": { \"filename\": \"complete contents\" } }";
        if (sendEvent) sendEvent({ type: "tool_status", content: "Sending to Gemini 2.5 Pro..." });
        const result = await model.generateContent({
          contents: [{ role: "user", parts: [{ text: systemPrompt + "\n\n" + userPrompt }] }]
        });
        const raw = result.response.text();
        const clean = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
        var parsed;
        try { parsed = JSON.parse(clean); } catch (parseErr) {
          return "write_code error: Gemini returned invalid JSON. Raw: " + raw.slice(0, 500);
        }
        const fileNames = Object.keys(parsed.files || {});
        if (sendEvent) sendEvent({ type: "tool_status", content: "\u2713 Code ready: " + fileNames.join(", ") });
        return JSON.stringify(parsed);
      } catch (err) {
        return "write_code error: " + err.message + (err.cause ? " | cause: " + err.cause : "");
      }
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
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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
    if (memoryBlock && memoryBlock.trim()) sysParts.push("## RELEVANT MEMORY\n" + memoryBlock.trim());
    if (skillContext) sysParts.push("## SKILL INSTRUCTIONS\n" + skillContext);
    sysParts.push(FORGE_SYSTEM_PROMPT);
    const systemPrompt = sysParts.join("\n\n");

    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-pro",
      systemInstruction: { role: "system", parts: [{ text: systemPrompt }] },
    });

    // Convert Anthropic-formatted history to Gemini format for the API call
    // This is a simplified conversion and may not perfectly handle complex tool histories.
    const geminiMessages = history.map(msg => {
      const role = msg.role === 'assistant' ? 'model' : 'user';
      if (typeof msg.content === 'string') {
        return { role, parts: [{ text: msg.content }] };
      }
      // For now, we only take the text part of complex messages from history.
      const textContent = (Array.isArray(msg.content) ? msg.content.find(c => c.type === 'text')?.text : '') || '';
      return { role, parts: [{ text: textContent }] };
    }).filter(m => m.parts[0].text);

    // Add current user message
    const userParts = [{ text: message.trim() }];
    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        userParts.push({
          inlineData: {
            mimeType: att.mimeType || "image/png",
            data: att.dataUrl.split(",")[1] || att.dataUrl,
          }
        });
      }
    }
    geminiMessages.push({ role: "user", parts: userParts });

    let fullAssistantMessage = "";
    const MAX_ROUNDS = 20;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const result = await model.generateContentStream({
        contents: geminiMessages,
        tools: [{ functionDeclarations: FORGE_TOOLS }],
      });

      let responseText = "";
      let functionCalls = [];

      for await (const chunk of result.stream) {
        const text = chunk.text();
        if (text) {
          responseText += text;
          send({ type: "thinking", content: responseText });
        }
        const fcs = chunk.functionCalls();
        if (fcs) {
          functionCalls.push(...fcs);
        }
      }

      const modelResponseParts = [];
      if (responseText) {
        modelResponseParts.push({ text: responseText });
      }
      if (functionCalls.length > 0) {
        functionCalls.forEach(fc => modelResponseParts.push({ functionCall: fc }));
      }

      if (modelResponseParts.length > 0) {
        geminiMessages.push({ role: 'model', parts: modelResponseParts });
      }

      if (functionCalls.length === 0) {
        fullAssistantMessage = responseText;
        break; // End of conversation turn
      }

      // Execute tools
      const toolResultsParts = [];
      for (const call of functionCalls) {
        console.log(`[forge] round=${round} tool=${call.name}`, JSON.stringify(call.args).slice(0, 120));
        const toolResultContent = await executeForgeToken(call.name, call.args, send);
        toolResultsParts.push({
          functionResponse: {
            name: call.name,
            response: { content: String(toolResultContent) },
          },
        });
      }

      if (toolResultsParts.length > 0) {
        geminiMessages.push({ role: 'function', parts: toolResultsParts });
      }
    }

    brain.appendConversation(project.id, "assistant", fullAssistantMessage).catch(() => {});
    brain.extractMemory({ projectId: project.id, userRequest: message.trim(), buildSummary: fullAssistantMessage.slice(0, 500), files: [] }).catch(() => {});

    send({ type: "done", role: "assistant", content: fullAssistantMessage, building: false, createdAt: Date.now() });

  } catch (err) {
    console.error("[forge] Chat error:", err.message, err.stack);
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
  // ── Dashboard routes — mirrored from Mission Control ─────────────────────────

app.get("/api/dashboard/status", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  const RENDER_SERVICE_ID = "srv-d6h2rt56ubrc73duanfg";
  const checks = {
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    gemini: !!process.env.GEMINI_API_KEY,
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
