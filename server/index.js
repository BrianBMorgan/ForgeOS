const express = require("express");
const path = require("path");
const {
  createRun,
  executePipeline,
  handleApproval,
  handleRejection,
  getRun,
  getRunSync,
  getAllRuns,
} = require("./pipeline/runner");
const workspace = require("./workspace/manager");
const { mountMcp } = require("./mcp/handler");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

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

  executePipeline(run.id).catch((err) => {
    console.error(`Pipeline error for run ${run.id}:`, err);
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

app.post("/api/runs/:id/exec", async (req, res) => {
  const { command } = req.body;
  if (!command || typeof command !== "string") {
    return res.status(400).json({ error: "Command is required" });
  }
  const runId = req.params.id;
  let ws = workspace.getWorkspaceStatus(runId);
  if (!ws || ws.status !== "running") {
    const run = await getRun(runId);
    if (run && run.status === "completed" && run.stages?.executor?.output?.startCommand) {
      const eo = run.stages.executor.output;
      let wakeEnv = {};
      try {
        const ds = await settingsManager.getSetting("default_env_vars");
        if (ds?.vars && Array.isArray(ds.vars)) for (const v of ds.vars) { if (v.key) wakeEnv[v.key] = v.value || ""; }
        wakeEnv = { ...wakeEnv, ...(await settingsManager.getSecretsAsObject()) };
      } catch {}
      const allProjects = await projectManager.getAllProjects();
      const proj = allProjects.find(p => p.currentRunId === runId);
      if (proj) try { wakeEnv = { ...wakeEnv, ...(await projectManager.getEnvVarsAsObject(proj.id)) }; } catch {}
      const wakeResult = await workspace.restoreWorkspace(runId, eo.startCommand, eo.port || 4000, wakeEnv);
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

app.post("/api/runs/:id/approve", async (req, res) => {
  const result = await handleApproval(req.params.id);
  if (result.error) {
    return res.status(400).json(result);
  }
  res.json(result);
});

app.post("/api/runs/:id/reject", async (req, res) => {
  const { feedback } = req.body;
  if (!feedback || typeof feedback !== "string" || !feedback.trim()) {
    return res.status(400).json({ error: "Feedback is required" });
  }

  const result = await handleRejection(req.params.id, feedback.trim());
  if (result.error) {
    return res.status(400).json(result);
  }
  res.json(result);
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

  executePipeline(run.id).catch((err) => {
    console.error(`Pipeline error for project ${project.id}, run ${run.id}:`, err);
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

  const currentRun = project.currentRunId ? await getRun(project.currentRunId) : null;
  if (currentRun) {
    const liveWs = workspace.getWorkspaceStatus(currentRun.id);
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

app.post("/api/projects/:id/iterate", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "Prompt is required" });
  }

  const project = await projectManager.getProject(req.params.id);
  if (!project) {
    return res.status(404).json({ error: "Project not found" });
  }

  const lastRunId = project.currentRunId;
  const existingFiles = lastRunId ? projectManager.captureCurrentFiles(lastRunId) : [];
  const iterationNumber = project.iterations.length + 1;

  const run = createRun(prompt.trim(), {
    projectId: project.id,
    iterationNumber,
    existingFiles,
  });
  await projectManager.addIteration(project.id, run.id, prompt.trim(), iterationNumber);

  executePipeline(run.id).catch((err) => {
    console.error(`Pipeline error for project ${project.id}, iteration ${iterationNumber}:`, err);
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
    const run = await getRun(project.currentRunId);
    const wsStatus = workspace.getWorkspaceStatus(project.currentRunId);

    let result;
    if (!wsStatus) {
      const startCmd = run?.stages?.executor?.output?.startCommand || "npm start";
      const port = run?.stages?.executor?.output?.port || 4000;
      result = await workspace.restoreWorkspace(project.currentRunId, startCmd, port, customEnv);
    } else {
      result = await workspace.restartApp(project.currentRunId, customEnv);
    }
    if (result.success) {
      if (run && run.workspace) {
        run.workspace.status = "running";
        run.workspace.port = result.port;
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

const settingsManager = require("./settings/manager");

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
    res.status(500).json({ error: "Chat failed" });
  }
});

app.get("/api/projects/:id/chat", async (req, res) => {
  const project = await projectManager.getProject(req.params.id);
  if (!project) {
    return res.status(404).json({ error: "Project not found" });
  }

  const history = await chatManager.getChatHistory(req.params.id);
  res.json(history);
});

const { runStressTest, getStressTestStatus } = require("./stress-test/runner");
const { generateReport } = require("./stress-test/report");

let latestReport = null;

app.post("/api/stress-test/start", (req, res) => {
  const status = getStressTestStatus();
  if (status.running) {
    return res.status(409).json({ error: "Stress test already running" });
  }

  const { promptIds } = req.body || {};

  runStressTest({ promptIds })
    .then((results) => {
      latestReport = generateReport(results);
      console.log("Stress test complete. Report saved.");
    })
    .catch((err) => {
      console.error("Stress test error:", err);
    });

  res.json({ started: true, total: getStressTestStatus().total });
});

app.get("/api/stress-test/status", (_req, res) => {
  res.json(getStressTestStatus());
});

app.get("/api/stress-test/results", (_req, res) => {
  if (!latestReport) {
    return res.status(404).json({ error: "No results yet" });
  }
  res.json(latestReport.report || latestReport);
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

app.use("/preview/:runId", async (req, res) => {
  const runId = req.params.runId;

  let status = workspace.getWorkspaceStatus(runId);

  if (!status || status.status !== "running" || !status.port) {
    const run = await getRun(runId);
    if (run && run.status === "completed" && run.stages?.executor?.output?.startCommand) {
      const executorOutput = run.stages.executor.output;
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
        runId, executorOutput.startCommand, executorOutput.port || 4000, wakeEnv
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

  const options = {
    hostname: "127.0.0.1",
    port: status.port,
    path: targetPath,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${status.port}` },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    const headers = { ...proxyRes.headers };
    headers["cache-control"] = "no-cache, no-store, must-revalidate";
    headers["pragma"] = "no-cache";
    headers["expires"] = "0";
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });

  proxyReq.on("error", () => {
    res.status(502).json({ error: "Preview app not reachable" });
  });

  req.pipe(proxyReq);
});

if (process.env.NODE_ENV === "production") {
  const clientDist = path.join(__dirname, "..", "client", "dist");
  app.use(express.static(clientDist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`ForgeOS server running on port ${PORT}`);

  try {
    const allProjects = await projectManager.getAllProjects();
    const activeProjects = allProjects.filter(
      (p) => (p.status === "active" || p.status === "building") && p.currentRunId
    );
    if (activeProjects.length > 0) {
      console.log(`Marking ${activeProjects.length} workspace(s) as stopped (will auto-wake on demand)...`);
      for (const project of activeProjects) {
        await projectManager.updateProjectStatus(project.id, "stopped");
        console.log(`  "${project.name}" marked stopped (will wake on first visit)`);
      }
    }
  } catch (err) {
    console.error("Workspace restoration error:", err.message);
  }
});
