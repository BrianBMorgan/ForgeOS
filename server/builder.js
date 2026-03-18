/**
 * builder.js — Install + start pipeline for ForgeOS workspaces.
 *
 * The unified agent (server/agent/forge.js) now handles all code generation.
 * This file is responsible only for:
 *   1. Taking agent-written files and wiring them into the workspace runner
 *   2. Installing dependencies
 *   3. Starting the app
 *   4. Health checking
 *   5. Snapshotting the run
 */

"use strict";

const path = require("path");
const brain = require("./memory/brain");
const { saveRunSnapshot } = require("./pipeline/runner");

async function buildAndDeploy(run) {
  const workspace = require("./workspace/manager");
  const projectManager = require("./projects/manager");
  const settingsManager = require("./settings/manager");

  run.status = "running";
  run.currentStage = "building";
  run.workspace = { status: "starting", port: null, error: null };

  // Agent pre-populates run.stages.builder with files + commands.
  // Nothing to generate — go straight to install + start.
  if (!run.agentBuild || !run.stages.builder || run.stages.builder.status !== "passed") {
    run.status = "failed";
    run.error = "No agent build output found";
    run.workspace.status = "build-failed";
    saveRunSnapshot(run).catch(() => {});
    return;
  }

  const builderOutput = run.stages.builder.output;
  console.log(`[builder] Agent build: ${(builderOutput.files || []).length} files, start: ${builderOutput.startCommand}`);

  // Load env vars
  let globalDefaults = {};
  let globalSecrets = {};
  let projectEnv = {};
  try {
    const defaultEnvSetting = await settingsManager.getSetting("default_env_vars");
    if (defaultEnvSetting?.vars && Array.isArray(defaultEnvSetting.vars)) {
      for (const v of defaultEnvSetting.vars) {
        if (v.key) globalDefaults[v.key] = v.value || "";
      }
    }
    globalSecrets = await settingsManager.getSecretsAsObject();
  } catch (err) {
    console.error("[builder] Failed to load settings/secrets:", err.message);
  }
  if (run.projectId) {
    try {
      projectEnv = await projectManager.getEnvVarsAsObject(run.projectId);
    } catch (err) {
      console.error("[builder] Failed to load project env vars:", err.message);
    }
  }
  const customEnv = { ...globalDefaults, ...globalSecrets, ...projectEnv };

  try {
    run.workspace.status = "writing-files";
    await workspace.stopAllApps();

    // Agent wrote files directly to disk — register workspace without wiping.
    // collectWorkspaceFiles already captured them into builderOutput.files.
    workspace.createWorkspace(run.id);
    workspace.writeFiles(run.id, builderOutput.files);
    run.workspace.status = "files-written";

    if (builderOutput.installCommand) {
      run.workspace.status = "installing";
      const installResult = await workspace.installDeps(run.id, builderOutput.installCommand, customEnv);
      if (!installResult.success) {
        run.workspace.status = "install-failed";
        run.workspace.error = installResult.error;
        run.status = "completed";
        brain.extractFailureMemory({
          projectId: run.projectId,
          prompt: run.prompt,
          errorMessage: installResult.error,
          failureStage: "install-failed",
        }).catch(() => {});
        saveRunSnapshot(run).catch(() => {});
        return;
      }
    }

    run.workspace.status = "installed";

    const shouldStart = builderOutput.startCommand ||
      workspace.isStaticSite(path.join(process.env.DATA_DIR || path.join(__dirname, ".."), "workspaces", run.id));

    if (shouldStart) {
      run.workspace.status = "starting";
      const startResult = await workspace.startApp(run.id, builderOutput.startCommand || null, 4000, customEnv);
      if (startResult.success) {
        run.workspace.status = "running";
        run.workspace.port = startResult.port;
        await performHealthCheck(run, workspace);
      } else {
        run.workspace.status = "start-failed";
        run.workspace.error = startResult.error;
        brain.extractFailureMemory({
          projectId: run.projectId,
          prompt: run.prompt,
          errorMessage: startResult.error,
          failureStage: "start-failed",
        }).catch(() => {});
      }
    }

    run.status = "completed";

    if (run.projectId) {
      await projectManager.setCurrentRun(run.projectId, run.id);
    }

    brain.extractMemory({
      projectId: run.projectId,
      userRequest: run.prompt,
      buildSummary: builderOutput.summary,
      files: builderOutput.files,
    }).catch(() => {});

    saveRunSnapshot(run).catch(() => {});

  } catch (err) {
    run.workspace.status = "build-failed";
    run.workspace.error = err.message;
    run.status = "completed";
    console.error("[builder] buildAndDeploy error:", err.message);
    saveRunSnapshot(run).catch(() => {});
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
        res.on("end", () => resolve({ httpStatus: res.statusCode, responseSize: body.length, healthy: res.statusCode >= 200 && res.statusCode < 400 }));
      });
      req.on("error", (err) => resolve({ httpStatus: null, responseSize: 0, healthy: false, error: err.message }));
      req.on("timeout", () => { req.destroy(); resolve({ httpStatus: null, responseSize: 0, healthy: false, error: "timeout" }); });
    });
    run.healthCheck = { httpStatus: result.httpStatus, responseSize: result.responseSize, healthy: result.healthy, checkedAt: Date.now() };
    if (result.healthy) {
      console.log(`[builder] Health check OK: HTTP ${result.httpStatus}, ${result.responseSize} bytes`);
    } else {
      console.warn(`[builder] Health check failed: HTTP ${result.httpStatus || "no-response"}`);
    }
  } catch (err) {
    console.warn("[builder] Health check error:", err.message);
  }
}

module.exports = { buildAndDeploy };
