const path = require("path");
const { v4: uuidv4 } = require("uuid");

const { neon } = require("@neondatabase/serverless");

const dbUrl = process.env.NEON_DATABASE_URL;
const sql = dbUrl ? neon(dbUrl) : null;
const runs = new Map();

const BANNED_MODULES = ["openai"];
const BANNED_ENV_VARS = ["OPENAI_API_KEY", "API_SECRET_KEY"];

function sanitizePlannerOutput(plan) {
  if (!plan) return;
  if (Array.isArray(plan.modules)) {
    const before = plan.modules.length;
    plan.modules = plan.modules.filter(m => {
      const lower = m.toLowerCase();
      if (BANNED_MODULES.some(b => lower === b || lower.startsWith(b + "/"))) {
        console.warn(`[pipeline] Stripped banned module "${m}" from plan — replacing with @anthropic-ai/sdk`);
        return false;
      }
      return true;
    });
    if (before !== plan.modules.length && !plan.modules.includes("@anthropic-ai/sdk")) {
      plan.modules.push("@anthropic-ai/sdk");
    }
  }
  if (Array.isArray(plan.environmentVariables)) {
    const hadBanned = plan.environmentVariables.some(v => BANNED_ENV_VARS.includes(v));
    plan.environmentVariables = plan.environmentVariables.filter(v => !BANNED_ENV_VARS.includes(v));
    if (hadBanned && !plan.environmentVariables.includes("ANTHROPIC_API_KEY")) {
      plan.environmentVariables.push("ANTHROPIC_API_KEY");
      console.warn("[pipeline] Replaced banned AI key var with ANTHROPIC_API_KEY in plan");
    }
  }
}

function makeRunSnapshot(run) {
  const snapshot = { ...run };
  delete snapshot.existingFiles;
  return snapshot;
}

async function saveRunSnapshot(run) {
  if (!sql) return;
  try {
    const snapshot = makeRunSnapshot(run);
    const now = Date.now();
    await sql`INSERT INTO run_snapshots (id, data, created_at) VALUES (${run.id}, ${JSON.stringify(snapshot)}, ${now}) ON CONFLICT (id) DO UPDATE SET data = ${JSON.stringify(snapshot)}, created_at = ${now}`;
  } catch (err) {
    console.error("Failed to save run snapshot:", err.message);
  }
}

async function loadRunSnapshot(runId) {
  if (!sql) return null;
  try {
    const rows = await sql`SELECT data FROM run_snapshots WHERE id = ${runId}`;
    if (rows.length > 0) {
      return rows[0].data;
    }
  } catch (err) {
    console.error("Failed to load run snapshot:", err.message);
  }
  return null;
}

async function loadSkillsContext() {
  try {
    const settingsManager = require("../settings/manager");
    const skills = await settingsManager.getAllSkills();
    if (skills.length === 0) return "";
    const lines = skills.map((s) => `### ${s.name}\n${s.description ? s.description + "\n" : ""}${s.instructions}`);
    return "\n\n--- SKILLS LIBRARY ---\nThe following skills are available. Reference and apply them when relevant to the build:\n\n" + lines.join("\n\n");
  } catch {
    return "";
  }
}

function createRun(prompt, context) {
  const id = uuidv4().slice(0, 8);
  const run = {
    id,
    prompt,
    status: "running",
    currentStage: "executor",
    stages: {},
    error: null,
    createdAt: Date.now(),
    projectId: context?.projectId || null,
    iterationNumber: context?.iterationNumber || 1,
    existingFiles: context?.existingFiles || null,
  };
  runs.set(id, run);
  return run;
}

function updateStage(run, stageName, status, output = null) {
  const stage = { status, output };
  if (output && output._rawOutput) {
    stage.rawOutput = output._rawOutput;
    delete output._rawOutput;
  }
  run.stages[stageName] = stage;
  if (status === "running") {
    run.currentStage = stageName;
  }
}

async function buildAndRun(run, executorOutput) {
  const workspace = require("../workspace/manager");
  const projectManager = require("../projects/manager");

  run.workspace = { status: "writing-files", port: null, error: null };

  let globalDefaults = {};
  let globalSecrets = {};
  let projectEnv = {};
  try {
    const settingsManager = require("../settings/manager");
    const defaultEnvSetting = await settingsManager.getSetting("default_env_vars");
    if (defaultEnvSetting?.vars && Array.isArray(defaultEnvSetting.vars)) {
      for (const v of defaultEnvSetting.vars) {
        if (v.key) globalDefaults[v.key] = v.value || "";
      }
    }
    globalSecrets = await settingsManager.getSecretsAsObject();
  } catch (err) {
    console.error("Failed to load global settings/secrets:", err.message);
  }
  if (run.projectId) {
    try {
      projectEnv = await projectManager.getEnvVarsAsObject(run.projectId);
    } catch (err) {
      console.error("Failed to load project env vars:", err.message);
    }
  }
  const customEnv = { ...globalDefaults, ...globalSecrets, ...projectEnv };

  try {
    await workspace.stopAllApps();
    workspace.forceKillPort(executorOutput.port || 4000);

    workspace.createWorkspace(run.id);
    workspace.writeFiles(run.id, executorOutput.files);
    run.workspace.status = "files-written";

    if (executorOutput.installCommand) {
      run.workspace.status = "installing";
      const installResult = await workspace.installDeps(
        run.id,
        executorOutput.installCommand,
        customEnv
      );
      if (!installResult.success) {
        run.workspace.status = "install-failed";
        run.workspace.error = installResult.error;
        if (run.status !== "failed") run.status = "completed";
        return;
      }
    }

    run.workspace.status = "installed";

    const shouldStart = executorOutput.startCommand || workspace.isStaticSite(path.join(process.env.DATA_DIR || path.join(__dirname, "..", ".."), "workspaces", run.id));
    if (shouldStart) {
      run.workspace.status = "starting";
      const startResult = await workspace.startApp(
        run.id,
        executorOutput.startCommand || null,
        executorOutput.port || 4000,
        customEnv
      );
      if (startResult.success) {
        run.workspace.status = "running";
        run.workspace.port = startResult.port;
        await performHealthCheck(run, workspace);
      } else {
        run.workspace.status = "start-failed";
        run.workspace.error = startResult.error;
        captureStartupLogs(run, workspace);
      }
    }

    if (run.status !== "failed") run.status = "completed";
  } catch (err) {
    run.workspace.status = "build-failed";
    run.workspace.error = err.message;
    if (run.status !== "failed") run.status = "completed";
  }
}

async function performHealthCheck(run, workspace) {
  const port = run.workspace.port;
  if (!port) return;

  await new Promise(resolve => setTimeout(resolve, 3000));

  try {
    const http = require("http");
    const result = await new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/`, { timeout: 5000 }, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          resolve({ httpStatus: res.statusCode, responseSize: body.length, healthy: res.statusCode >= 200 && res.statusCode < 400 });
        });
      });
      req.on("error", (err) => {
        resolve({ httpStatus: null, responseSize: 0, healthy: false, error: err.message });
      });
      req.on("timeout", () => {
        req.destroy();
        resolve({ httpStatus: null, responseSize: 0, healthy: false, error: "timeout" });
      });
    });

    let startupLogs = "";
    try {
      const logData = workspace.getWorkspaceLogs(run.id, { maxEntries: 30 });
      if (logData) {
        const appLog = (logData.app || "").trim();
        if (appLog) startupLogs = appLog.slice(-2000);
      }
    } catch {}

    run.healthCheck = {
      httpStatus: result.httpStatus,
      responseSize: result.responseSize,
      healthy: result.healthy,
      startupLogs: startupLogs || null,
      checkedAt: Date.now(),
    };

    if (!result.healthy) {
      console.log(`[health-check] FAILED for run ${run.id}: HTTP ${result.httpStatus || "no-response"} — ${result.error || ""}`);
    } else {
      console.log(`[health-check] OK for run ${run.id}: HTTP ${result.httpStatus}, ${result.responseSize} bytes`);
    }
  } catch (err) {
    run.healthCheck = { httpStatus: null, responseSize: 0, healthy: false, startupLogs: null, error: err.message, checkedAt: Date.now() };
    console.error("[health-check] Error:", err.message);
  }
}

function captureStartupLogs(run, workspace) {
  try {
    const logData = workspace.getWorkspaceLogs(run.id, { maxEntries: 30 });
    if (logData) {
      const appLog = (logData.app || "").trim();
      if (appLog) {
        run.healthCheck = {
          httpStatus: null,
          responseSize: 0,
          healthy: false,
          startupLogs: appLog.slice(-2000),
          checkedAt: Date.now(),
        };
      }
    }
  } catch {}
}

async function getRun(runId) {
  const memRun = runs.get(runId);
  if (memRun) return memRun;
  const snapshot = await loadRunSnapshot(runId);
  if (snapshot) {
    runs.set(runId, snapshot);
  }
  return snapshot;
}

function getRunSync(runId) {
  return runs.get(runId) || null;
}

function getAllRuns() {
  return Array.from(runs.values()).sort((a, b) => b.createdAt - a.createdAt);
}

module.exports = {
  createRun,
  getRun,
  getRunSync,
  getAllRuns,
  saveRunSnapshot,
  buildAndRun,
  updateStage,
  loadSkillsContext,
  sanitizePlannerOutput,
};