const express = require("express");
const path = require("path");
// ARCHIVED: Multi-stage pipeline (Planner→Reviewer→PolicyGate→Approval→Executor→Auditor)
// Original code preserved in server/pipeline_archive/
const {
  getRun,
  getRunSync,
  getAllRuns,
  createRun,
} = require("./pipeline/runner");
const { buildAndDeploy } = require("./builder");
const workspace = require("./workspace/manager");
const { mountMcp } = require("./mcp/handler");
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
  delete fetchHeaders["accept-encoding"];
  fetchHeaders["accept-encoding"] = "identity";
  fetchHeaders["content-type"] = req.headers["content-type"] || "application/json";

  try {
    const response = await fetch(targetUrl.toString(), {
      method: req.method,
      headers: fetchHeaders,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : JSON.stringify(req.body),
      duplex: "half",
    });
    res.status(response.status);
    for (const [key, value] of response.headers.entries()) {
      if (!["transfer-encoding", "connection"].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    }
    const body = await response.arrayBuffer();
    res.end(Buffer.from(body));
  } catch (err) {
    console.error(`[subdomain proxy] Error proxying ${slug}:`, err.message);
    res.status(502).send("Bad Gateway");
  }
});
// Auth gate removed — no authentication required

mountMcp(app);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/runs", (req, res) => {
  const { prompt } = req.body;
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "Prompt is required" });
  }

  const run = createRun(prompt.trim());

  buildAndDeploy(run).catch((err) => {
    console.error(`[builder] Error for run ${run.id}:`, err);
  });

  res.status(201).json({ id: run.id, status: run.status });
});

app.get("/api/runs", (_req, res) => {
  const runs = getAllRuns();
  res.json(runs);
});

app.get("/api/runs/:id", async (req, res) => {
  const run = await getRun(req.params.id);
  if (!run) {
    return res.status(404).json({ error: "Run not found" });
  }
  const liveWs = workspace.getWorkspaceStatus(run.id);
  if (liveWs) {
    run.workspace = { status: liveWs.status, port: liveWs.port, error: liveWs.error };
    workspace.touchActivity(run.id);
  }
  res.json(run);
});

app.get("/api/runs/:id/logs", (req, res) => {
  const opts = {};
  if (req.query.since) opts.since = parseInt(req.query.since);
  if (req.query.level) opts.level = req.query.level.split(",");
  if (req.query.source) opts.source = req.query.source;
  if (req.query.search) opts.search = req.query.search;
  if (req.query.limit) opts.limit = parseInt(req.query.limit);
  const logs = workspace.getWorkspaceLogs(req.params.id, opts);
  const status = workspace.getWorkspaceStatus(req.params.id);
  if (status) workspace.touchActivity(req.params.id);
  res.json({ logs, status });
});

app.get("/api/runs/:id/files", (req, res) => {
  try {
    const files = workspace.listWorkspaceFiles(req.params.id);
    res.json({ files });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.get("/api/runs/:id/file", (req, res) => {
  const { path: filePath } = req.query;
  if (!filePath) return res.status(400).json({ error: "path query param required" });
  try {
    const content = workspace.readWorkspaceFile(req.params.id, filePath);
    res.json({ content });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.get("/api/runs/:id/file/search", (req, res) => {
  const { text } = req.query;
  if (!text || text.trim().length < 2) return res.json({ results: [] });
  try {
    const results = workspace.searchWorkspaceFiles(req.params.id, text);
    res.json({ results });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.patch("/api/runs/:id/file", async (req, res) => {
  const { path: filePath, content } = req.body;
  if (!filePath || content === undefined) {
    return res.status(400).json({ error: "path and content required" });
  }
  try {
    workspace.writeWorkspaceFile(req.params.id, filePath, content);
    // Restart app so changes take effect
    const wsStatus = workspace.getWorkspaceStatus(req.params.id);
    if (wsStatus?.status === "running") {
      workspace.restartApp(req.params.id).catch(() => {});
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/runs/:id/exec", async (req, res) => {
  const { command } = req.body;
  if (!command || typeof command !== "string") {
    return res.status(400).json({ error: "Command is required" });
  }
  const runId = req.params.id;
  let ws = workspace.getWorkspaceStatus(runId);
  if (!ws || ws.status !== "running") {
    const run = await getRun(runId);
    const execOutput = run?.stages?.executor?.output || run?.stages?.builder?.output;
    if (run && run.status === "completed" && execOutput?.startCommand) {
      let wakeEnv = {};
      try {
        const ds = await settingsManager.getSetting("default_env_vars");
        if (ds?.vars && Array.isArray(ds.vars)) for (const v of ds.vars) { if (v.key) wakeEnv[v.key] = v.value || ""; }
        wakeEnv = { ...wakeEnv, ...(await settingsManager.getSecretsAsObject()) };
      } catch {}
      const allProjects = await projectManager.getAllProjects();
      const proj = allProjects.find(p => p.currentRunId === runId);
      if (proj) try { wakeEnv = { ...wakeEnv, ...(await projectManager.getEnvVarsAsObject(proj.id)) }; } catch {}
      const wakeResult = await workspace.restoreWorkspace(runId, execOutput.startCommand, execOutput.port || 4000, wakeEnv);
      if (wakeResult.success) {
        run.workspace = { status: "running", port: wakeResult.port, error: null };
        if (proj) await projectManager.updateProjectStatus(proj.id, "active");
        console.log(`Auto-woke workspace ${runId} for shell command`);
      } else {
        return res.json({ exitCode: 1, stdout: "", stderr: "Failed to wake workspace: " + wakeResult.error });
      }
    } else {
      return res.json({ exitCode: 1, stdout: "", stderr: "Workspace not found" });
    }
  }
  workspace.touchActivity(runId);
  const result = await workspace.execCommand(runId, command.trim());
  res.json(result);
});

// ARCHIVED: approve/reject routes (pipeline disconnected)
app.post("/api/runs/:id/approve", async (req, res) => {
  res.status(501).json({ error: "Pipeline archived. Approval flow not active." });
});

app.post("/api/runs/:id/reject", async (req, res) => {
  res.status(501).json({ error: "Pipeline archived. Rejection flow not active." });
});

const projectManager = require("./projects/manager");

app.post("/api/projects", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "Prompt is required" });
  }

  const project = await projectManager.createProject(prompt.trim());
  const run = createRun(prompt.trim(), { projectId: project.id, iterationNumber: 1 });
  await projectManager.addIteration(project.id, run.id, prompt.trim(), 1);

  buildAndDeploy(run).catch((err) => {
    console.error(`[builder] Error for project ${project.id}, run ${run.id}:`, err);
    projectManager.updateProjectStatus(project.id, "failed");
  });

  res.status(201).json({ id: project.id, runId: run.id, name: project.name });
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

  let currentRun = project.currentRunId ? await getRun(project.currentRunId) : null;
  const liveWs = project.currentRunId ? workspace.getWorkspaceStatus(project.currentRunId) : null;
  if (!currentRun && liveWs) {
    const { createRun, saveRunSnapshot } = require("./pipeline/runner");
    currentRun = createRun(project.name || "Restored", { projectId: project.id });
    currentRun.id = project.currentRunId;
    currentRun.status = "completed";
    currentRun.stages.executor = { status: "passed", output: { startCommand: liveWs.lastStartCommand || "npm start", port: liveWs.port || 4000 } };
    currentRun.workspace = { status: liveWs.status, port: liveWs.port, error: liveWs.error };
    saveRunSnapshot(currentRun).catch(() => {});
  } else if (currentRun) {
    if (liveWs) {
      currentRun.workspace = { status: liveWs.status, port: liveWs.port, error: liveWs.error };
    } else if (currentRun.status === "completed" && currentRun.workspace?.status === "running") {
      currentRun.workspace = { status: "stopped", port: null, error: null };
    }
    if (currentRun.status === "running" || currentRun.status === "awaiting-approval") {
      await projectManager.updateProjectStatus(project.id, "building");
    } else if (currentRun.status === "failed") {
      await projectManager.updateProjectStatus(project.id, "failed");
    } else if (currentRun.status === "completed") {
      if (currentRun.workspace?.status === "running") {
        await projectManager.updateProjectStatus(project.id, "active");
      } else if (currentRun.workspace?.status === "install-failed" || currentRun.workspace?.status === "start-failed" || currentRun.workspace?.status === "build-failed") {
        await projectManager.updateProjectStatus(project.id, "failed");
      } else {
        await projectManager.updateProjectStatus(project.id, "stopped");
      }
    }
  }

  const iterations = await Promise.all(project.iterations.map(async (iter) => {
    const iterRun = await getRun(iter.runId);
    return {
      ...iter,
      status: iterRun?.status || "unknown",
      workspaceStatus: iterRun?.workspace?.status || null,
    };
  }));

  res.json({ ...project, iterations, currentRun });
});

app.post("/api/projects/:id/plan", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "Prompt is required" });
  }

  const project = await projectManager.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const { generatePlan } = require("./plan/manager");
  const lastRunId = project.currentRunId;
  const existingFiles = lastRunId ? projectManager.captureCurrentFiles(lastRunId) : [];

  try {
    const plan = await generatePlan(prompt.trim(), existingFiles);
    res.json({ plan });
  } catch (err) {
    console.error("[plan] Error generating plan:", err.message);
    res.status(500).json({ error: "Failed to generate plan" });
  }
});

app.post("/api/projects/:id/iterate", async (req, res) => {
  const { prompt, approvedPlan } = req.body;
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "Prompt is required" });
  }

  const project = await projectManager.getProject(req.params.id);
  if (!project) {
    return res.status(404).json({ error: "Project not found" });
  }

  const chatMgr = require("./chat/manager");
  chatMgr.clearBuildSuggestions(req.params.id).catch(() => {});

  const lastRunId = project.currentRunId;
  const existingFiles = lastRunId ? projectManager.captureCurrentFiles(lastRunId) : [];

  // Stop existing workspace before starting new build — prevents EADDRINUSE on iteration
  if (lastRunId) {
    const wsStatus = workspace.getWorkspaceStatus(lastRunId);
    if (wsStatus && (wsStatus.status === "running" || wsStatus.status === "starting")) {
      await workspace.stopApp(lastRunId);
    }
  }

  const iterationNumber = project.iterations.length + 1;

  const run = createRun(prompt.trim(), {
    projectId: project.id,
    iterationNumber,
    existingFiles,
    approvedPlan: approvedPlan || null,
  });
  await projectManager.addIteration(project.id, run.id, prompt.trim(), iterationNumber);

  buildAndDeploy(run).catch((err) => {
    console.error(`[builder] Error for project ${project.id}, iteration ${iterationNumber}:`, err);
    projectManager.updateProjectStatus(project.id, "failed");
  });

  res.status(201).json({ runId: run.id, iterationNumber });
});

app.post("/api/projects/:id/stop", async (req, res) => {
  const project = await projectManager.getProject(req.params.id);
  if (!project) {
    return res.status(404).json({ error: "Project not found" });
  }

  if (project.currentRunId) {
    await workspace.stopApp(project.currentRunId);
    const run = await getRun(project.currentRunId);
    if (run && run.workspace) {
      run.workspace.status = "stopped";
    }
  }
  await projectManager.stopProject(req.params.id);
  res.json({ status: "stopped" });
});

app.post("/api/projects/:id/restart", async (req, res) => {
  const project = await projectManager.getProject(req.params.id);
  if (!project) {
    return res.status(404).json({ error: "Project not found" });
  }
  if (!project.currentRunId) {
    return res.status(400).json({ error: "No active run to restart" });
  }

  try {
    let globalDefaults = {};
    let globalSecrets = {};
    try {
      const defaultEnvSetting = await settingsManager.getSetting("default_env_vars");
      if (defaultEnvSetting?.vars && Array.isArray(defaultEnvSetting.vars)) {
        for (const v of defaultEnvSetting.vars) {
          if (v.key) globalDefaults[v.key] = v.value || "";
        }
      }
      globalSecrets = await settingsManager.getSecretsAsObject();
    } catch {}
    const projectEnv = await projectManager.getEnvVarsAsObject(req.params.id);
    const customEnv = { ...globalDefaults, ...globalSecrets, ...projectEnv };
    let run = await getRun(project.currentRunId);
    const wsStatus = workspace.getWorkspaceStatus(project.currentRunId);

    const startCmd = run?.stages?.executor?.output?.startCommand
      || run?.stages?.builder?.output?.startCommand
      || "npm start";
    const port = run?.stages?.executor?.output?.port
      || run?.stages?.builder?.output?.port
      || 4000;

    let result;
    if (!wsStatus || !wsStatus.lastStartCommand) {
      result = await workspace.restoreWorkspace(project.currentRunId, startCmd, port, customEnv);
    } else {
      result = await workspace.restartApp(project.currentRunId, customEnv);
    }
    if (result.success) {
      if (!run) {
        const { createRun, saveRunSnapshot } = require("./pipeline/runner");
        run = createRun(project.name || "Restarted", { projectId: project.id });
        run.id = project.currentRunId;
        run.status = "completed";
        run.stages.executor = { status: "passed", output: { startCommand: startCmd, port: result.port } };
        run.workspace = { status: "running", port: result.port, error: null };
        saveRunSnapshot(run).catch(() => {});
      } else {
        run.workspace = { status: "running", port: result.port, error: null };
      }
      await projectManager.updateProjectStatus(req.params.id, "active");
      res.json({ status: "restarted", port: result.port });
    } else {
      if (run && run.workspace) {
        run.workspace.status = "start-failed";
        run.workspace.error = result.error;
      }
      res.status(500).json({ error: result.error });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    const chatManager = require("./chat/manager");
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

const chatManager = require("./chat/manager");

app.post("/api/projects/:id/chat", async (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "Message is required" });
  }

  const project = await projectManager.getProject(req.params.id);
  if (!project) {
    return res.status(404).json({ error: "Project not found" });
  }

  try {
    const response = await chatManager.chat(req.params.id, message.trim());
    res.json(response);
  } catch (err) {
    console.error("Chat error:", err.message);
    res.status(500).json({ error: `Chat failed: ${err.message}` });
  }
});

app.get("/api/projects/:id/chat", async (req, res) => {
  try {
    const project = await projectManager.getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

    const history = await chatManager.getChatHistory(req.params.id);
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

const http = require("http");

function rewriteLocationHeader(headers, basePath) {
  if (headers.location && typeof headers.location === "string") {
    const loc = headers.location;
    if (loc.startsWith("/") && !loc.startsWith(basePath)) {
      headers.location = basePath + loc;
    }
  }
  return headers;
}

function rewriteHtmlForProxy(html, basePath) {
  html = html.replace(/(href|src|action|formaction)=(["'])\/((?!\/)[^"']*)\2/gi, (match, attr, quote, path) => {
    if (path.startsWith(basePath.slice(1))) return match;
    return `${attr}=${quote}${basePath}/${path}${quote}`;
  });
  html = html.replace(/(srcset)=(["'])([^"']+)\2/gi, (match, attr, quote, value) => {
    const rewritten = value.replace(/(^|,\s*)\/((?!\/)[^\s,]+)/g, (m, prefix, p) => {
      if (p.startsWith(basePath.slice(1))) return m;
      return `${prefix}${basePath}/${p}`;
    });
    return `${attr}=${quote}${rewritten}${quote}`;
  });

  html = html.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (match, attrs, cssBody) => {
    const rewritten = rewriteCssForProxy(cssBody, basePath);
    return `<style${attrs}>${rewritten}</style>`;
  });

  const fetchPatch = `<script>(function(){var B="${basePath}";function rw(u){return typeof u==="string"&&u.startsWith("/")&&!u.startsWith(B)?B+u:u}var _f=window.fetch;window.fetch=function(u,o){if(typeof u==="string"){u=rw(u)}else if(u instanceof Request){var nu=rw(u.url);if(nu!==u.url)u=new Request(nu,u)}return _f.call(this,u,o)};var _o=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){if(typeof u==="string")u=rw(u);return _o.apply(this,arguments)};var _h=window.history;if(_h&&_h.pushState){var _ps=_h.pushState.bind(_h);_h.pushState=function(s,t,u){if(typeof u==="string")u=rw(u);return _ps(s,t,u)};var _rs=_h.replaceState.bind(_h);_h.replaceState=function(s,t,u){if(typeof u==="string")u=rw(u);return _rs(s,t,u)}}})();</script>`;

  const inspectorScript = "<script>(function(){\n  var active=false;\n  var overlay=null;\n  var lastEl=null;\n  function sel(el){\n    var parts=[];var e=el;\n    for(var i=0;i<4&&e&&e!==document.body;i++){\n      var s=e.tagName.toLowerCase();\n      if(e.id)s+='#'+e.id;\n      else if(e.className&&typeof e.className==='string')s+='.'+e.className.trim().split(/\\s+/).join('.');\n      parts.unshift(s);e=e.parentElement;\n    }\n    return parts.join(' > ');\n  }\n  function trim(s,n){return s&&s.length>n?s.slice(0,n)+'…':s||'';}\n  function show(el){\n    if(!overlay){overlay=document.createElement('div');overlay.style.cssText='position:fixed;pointer-events:none;outline:2px solid #3b82f6;outline-offset:1px;background:rgba(59,130,246,0.08);z-index:2147483647;transition:all 0.05s';document.body.appendChild(overlay);}\n    var r=el.getBoundingClientRect();\n    overlay.style.top=r.top+'px';overlay.style.left=r.left+'px';\n    overlay.style.width=r.width+'px';overlay.style.height=r.height+'px';\n    overlay.style.display='block';\n  }\n  function hide(){if(overlay)overlay.style.display='none';}\n  function onMove(e){if(!active)return;var el=document.elementFromPoint(e.clientX,e.clientY);if(el&&el!==overlay){lastEl=el;show(el);}}\n  function onClick(e){\n    if(!active)return;\n    e.preventDefault();e.stopPropagation();\n    var el=lastEl||e.target;\n    var oh=el.outerHTML||'';\n    var tc=(el.textContent||'').trim();\n    window.parent.postMessage({type:'forge:inspect:selection',outerHTML:trim(oh,600),textContent:trim(tc,200),selector:sel(el)},'*');\n  }\n  window.addEventListener('message',function(e){\n    if(e.data&&e.data.type==='forge:inspect:activate'){active=true;document.body.style.cursor='crosshair';}\n    if(e.data&&e.data.type==='forge:inspect:deactivate'){active=false;hide();document.body.style.cursor='';}\n  });\n  document.addEventListener('mousemove',onMove,true);\n  document.addEventListener('click',onClick,true);\n})();</script>";
  if (html.includes("<head")) {
    html = html.replace(/<head([^>]*)>/i, `<head$1>${fetchPatch}${inspectorScript}`);
  } else if (html.includes("<html")) {
    html = html.replace(/<html([^>]*)>/i, `<html$1>${fetchPatch}${inspectorScript}`);
  } else {
    html = fetchPatch + inspectorScript + html;
  }

  return html;
}

function rewriteCssForProxy(css, basePath) {
  return css.replace(/url\(\s*(["']?)\/((?!\/|data:)[^"')]+)\1\s*\)/gi, (match, quote, urlPath) => {
    if (urlPath.startsWith(basePath.slice(1))) return match;
    return `url(${quote}${basePath}/${urlPath}${quote})`;
  });
}

app.use("/preview/:runId", async (req, res) => {
  // Pass ForgeOS global API routes through — don't forward to workspace app
  if (req.path.startsWith("/api/assets")) {
    req.url = req.path;
    return app._router.handle(req, res, () => res.status(404).json({ error: "Not found" }));
  }

  const runId = req.params.runId;

  let status = workspace.getWorkspaceStatus(runId);

  if (!status || status.status !== "running" || !status.port) {
    const run = await getRun(runId);
    const execOutput = run?.stages?.executor?.output || run?.stages?.builder?.output;
    if (run && run.status === "completed" && execOutput?.startCommand) {
      let wakeEnv = {};
      try {
        const defaultEnvSetting = await settingsManager.getSetting("default_env_vars");
        if (defaultEnvSetting?.vars && Array.isArray(defaultEnvSetting.vars)) {
          for (const v of defaultEnvSetting.vars) {
            if (v.key) wakeEnv[v.key] = v.value || "";
          }
        }
        const secrets = await settingsManager.getSecretsAsObject();
        wakeEnv = { ...wakeEnv, ...secrets };
      } catch {}
      const allProjects = await projectManager.getAllProjects();
      const project = allProjects.find(p => p.currentRunId === runId);
      if (project) {
        try {
          const projEnv = await projectManager.getEnvVarsAsObject(project.id);
          wakeEnv = { ...wakeEnv, ...projEnv };
        } catch {}
      }
      const result = await workspace.restoreWorkspace(
        runId, execOutput.startCommand, execOutput.port || 4000, wakeEnv
      );
      if (result.success) {
        run.workspace = { status: "running", port: result.port, error: null };
        if (project) await projectManager.updateProjectStatus(project.id, "active");
        console.log(`Auto-woke workspace ${runId} on port ${result.port}`);
        status = workspace.getWorkspaceStatus(runId);
      } else {
        return res.status(503).json({ error: "Failed to wake workspace: " + result.error });
      }
    } else {
      return res.status(503).json({ error: "App not running" });
    }
  }

  workspace.touchActivity(runId);

  const basePath = `/preview/${runId}`;
  let targetPath = req.originalUrl;
  if (targetPath.startsWith(basePath)) {
    targetPath = targetPath.slice(basePath.length) || "/";
  }
  if (!targetPath.startsWith("/")) targetPath = "/" + targetPath;

  const bodyBuffer = (req.body !== undefined && req.body !== null)
    ? Buffer.from(JSON.stringify(req.body))
    : null;

  const fwdHeaders = { ...req.headers, host: `127.0.0.1:${status.port}` };
  delete fwdHeaders["accept-encoding"];
  if (bodyBuffer) {
    fwdHeaders["content-length"] = String(bodyBuffer.length);
  }

  const options = {
    hostname: "127.0.0.1",
    port: status.port,
    path: targetPath,
    method: req.method,
    headers: fwdHeaders,
  };

  const proxyReq = http.request(options, (proxyRes) => {
    const contentType = (proxyRes.headers["content-type"] || "").toLowerCase();
    const isHtml = contentType.includes("text/html");
    const isCss = contentType.includes("text/css");

    if (isHtml || isCss) {
      const chunks = [];
      proxyRes.on("data", (chunk) => chunks.push(chunk));
      proxyRes.on("end", () => {
        let body = Buffer.concat(chunks).toString("utf-8");
        if (isHtml) {
          body = rewriteHtmlForProxy(body, basePath);
        } else {
          body = rewriteCssForProxy(body, basePath);
        }
        const headers = { ...proxyRes.headers };
        rewriteLocationHeader(headers, basePath);
        headers["cache-control"] = "no-cache, no-store, must-revalidate";
        headers["pragma"] = "no-cache";
        headers["expires"] = "0";
        headers["content-length"] = String(Buffer.byteLength(body, "utf-8"));
        delete headers["content-encoding"];
        res.writeHead(proxyRes.statusCode, headers);
        res.end(body);
      });
    } else {
      const headers = { ...proxyRes.headers };
      rewriteLocationHeader(headers, basePath);
      headers["cache-control"] = "no-cache, no-store, must-revalidate";
      headers["pragma"] = "no-cache";
      headers["expires"] = "0";
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
    }
  });

  proxyReq.on("error", () => {
    if (!res.headersSent) res.status(502).json({ error: "Preview app not reachable" });
  });

  if (bodyBuffer) {
    proxyReq.end(bodyBuffer);
  } else {
    req.pipe(proxyReq);
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

const fs_startup = require("fs");
const DATA_ROOT = process.env.DATA_DIR || path.join(__dirname, "..");
const dirs_to_ensure = [
  path.join(DATA_ROOT, "workspaces"),
  path.join(DATA_ROOT, "published"),
];
for (const d of dirs_to_ensure) {
  if (!fs_startup.existsSync(d)) {
    fs_startup.mkdirSync(d, { recursive: true });
    console.log(`[startup] Created directory: ${d}`);
  }
}

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`ForgeOS server running on port ${PORT}`);

  try {
    const allProjects = await projectManager.getAllProjects();
    const activeProjects = allProjects.filter(
      (p) => (p.status === "active" || p.status === "building") && p.currentRunId
    );
    if (activeProjects.length > 0) {
      console.log(`Auto-restoring ${activeProjects.length} workspace(s) from database...`);
      for (const project of activeProjects) {
        try {
          const run = await getRun(project.currentRunId);
          const startCmd = run?.stages?.executor?.output?.startCommand
            || run?.stages?.builder?.output?.startCommand || null;
          const port = run?.stages?.executor?.output?.port
            || run?.stages?.builder?.output?.port || 4000;

          let globalDefaults = {};
          let globalSecrets = {};
          try {
            const defaultEnvSetting = await settingsManager.getSetting("default_env_vars");
            if (defaultEnvSetting?.vars && Array.isArray(defaultEnvSetting.vars)) {
              for (const v of defaultEnvSetting.vars) {
                if (v.key) globalDefaults[v.key] = v.value || "";
              }
            }
            globalSecrets = await settingsManager.getSecretsAsObject();
          } catch {}
          const projectEnv = await projectManager.getEnvVarsAsObject(project.id);
          const customEnv = { ...globalDefaults, ...globalSecrets, ...projectEnv };

          const result = await workspace.restoreWorkspace(project.currentRunId, startCmd, port, customEnv);
          if (result.success) {
            await projectManager.updateProjectStatus(project.id, "active");
            if (run && run.workspace) {
              run.workspace.status = "running";
              run.workspace.port = result.port;
            }
            console.log(`  "${project.name}" restored and running on port ${result.port}`);
          } else {
            await projectManager.updateProjectStatus(project.id, "stopped");
            console.log(`  "${project.name}" restore failed: ${result.error} — marked stopped`);
          }
        } catch (err) {
          await projectManager.updateProjectStatus(project.id, "stopped");
          console.log(`  "${project.name}" restore error: ${err.message} — marked stopped`);
        }
      }
    }
  } catch (err) {
    console.error("Workspace restoration error:", err.message);
  }

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
    const runtimeBackup = require("./workspace/runtime-backup");
    runtimeBackup.startPeriodicBackup(() => {
      const allWs = [];
      const projects = projectManager.getAllProjectsSync ? projectManager.getAllProjectsSync() : [];
      for (const p of projects) {
        if ((p.status === "active" || p.status === "building") && p.currentRunId) {
          allWs.push(p.currentRunId);
        }
      }
      return allWs;
    });
    console.log("[runtime-backup] Periodic backup started (every 5 minutes)");
  } catch (err) {
    console.error("Runtime backup setup error:", err.message);
  }
});
