const http = require("http");
const { prompts } = require("./prompts");
const { analyzeExecutorOutput } = require("./analyzer");
const { createLogger, logProgress, RESULTS_DIR } = require("./logger");
const {
  createRun,
  executePipeline,
  handleApproval,
  getRun,
} = require("../pipeline/runner");
const workspace = require("../workspace/manager");

const TIMEOUT_MS = 120000;
const DELAY_BETWEEN_MS = 5000;
const POLL_INTERVAL_MS = 2000;

let stressTestState = {
  running: false,
  currentPromptId: null,
  completed: 0,
  total: 0,
  results: [],
  startedAt: null,
  finishedAt: null,
};

function getStressTestStatus() {
  return { ...stressTestState };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pollRunStatus(runId, targetStatuses, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const run = getRun(runId);
      if (!run) {
        resolve({ status: "not_found", run: null });
        return;
      }
      if (targetStatuses.includes(run.status)) {
        resolve({ status: run.status, run });
        return;
      }
      if (Date.now() - start > timeoutMs) {
        resolve({ status: "timeout", run });
        return;
      }
      setTimeout(check, POLL_INTERVAL_MS);
    };
    check();
  });
}

async function healthCheck(port) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({ status: "fail", statusCode: null, bodySnippet: "Timeout" });
    }, 5000);

    const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        clearTimeout(timeout);
        resolve({
          status: res.statusCode >= 200 && res.statusCode < 400 ? "pass" : "fail",
          statusCode: res.statusCode,
          bodySnippet: body.substring(0, 500),
        });
      });
    });

    req.on("error", (err) => {
      clearTimeout(timeout);
      resolve({ status: "fail", statusCode: null, bodySnippet: err.message });
    });
  });
}

function collectStageTiming(run) {
  const stages = {};
  for (const [name, data] of Object.entries(run.stages || {})) {
    stages[name] = {
      status: data.status,
      hasOutput: !!data.output,
    };
  }
  return stages;
}

async function runSinglePrompt(promptDef) {
  const startTime = Date.now();
  const result = {
    promptId: promptDef.id,
    runId: null,
    category: promptDef.category,
    prompt: promptDef.prompt,
    expectedFeatures: promptDef.expectedFeatures,
    stages: {},
    executorOutput: null,
    installResult: null,
    startResult: null,
    healthCheck: null,
    violations: null,
    violationScore: null,
    totalDuration: 0,
    finalStatus: "unknown",
    error: null,
  };

  const run = createRun(promptDef.prompt);
  result.runId = run.id;

  const logger = createLogger(promptDef.id, run.id);
  logger.logRunStart(promptDef.prompt, promptDef.category);

  try {
    logger.logStageStart("pipeline");
    executePipeline(run.id);

    const pipelineResult = await pollRunStatus(
      run.id,
      ["awaiting-approval", "completed", "failed"],
      TIMEOUT_MS
    );

    if (pipelineResult.status === "timeout") {
      result.finalStatus = "timeout";
      result.error = "Pipeline timed out before reaching approval";
      result.stages = collectStageTiming(pipelineResult.run);
      logger.logStageEnd("pipeline", "timeout", Date.now() - startTime);
      logger.logFinalStatus(result.finalStatus, Date.now() - startTime);
      logger.logRunEnd();
      return result;
    }

    if (pipelineResult.status === "failed") {
      result.finalStatus = "fail_plan";
      result.error = pipelineResult.run?.error || "Pipeline failed during planning";
      result.stages = collectStageTiming(pipelineResult.run);
      logger.logStageEnd("pipeline", "failed", Date.now() - startTime);
      logger.logFinalStatus(result.finalStatus, Date.now() - startTime);
      logger.logRunEnd();
      return result;
    }

    logger.logStageEnd("pipeline", "passed", Date.now() - startTime);

    if (pipelineResult.status === "awaiting-approval") {
      logger.logStageStart("auto-approve");
      handleApproval(run.id);
      logger.logStageEnd("auto-approve", "passed");

      const execResult = await pollRunStatus(
        run.id,
        ["completed", "failed"],
        TIMEOUT_MS
      );

      if (execResult.status === "timeout") {
        result.finalStatus = "timeout";
        result.error = "Execution timed out after approval";
        result.stages = collectStageTiming(execResult.run);
        logger.logFinalStatus(result.finalStatus, Date.now() - startTime);
        logger.logRunEnd();
        return result;
      }
    }

    const finalRun = getRun(run.id);
    result.stages = collectStageTiming(finalRun);

    const executorOutput = finalRun.stages?.executor?.output;
    if (executorOutput) {
      result.executorOutput = {
        fileCount: executorOutput.files?.length || 0,
        filePaths: (executorOutput.files || []).map((f) => f.path),
        installCommand: executorOutput.installCommand,
        startCommand: executorOutput.startCommand,
        port: executorOutput.port,
        implementationSummary: executorOutput.implementationSummary,
      };

      logger.saveExecutorOutput(executorOutput);
      logger.saveFilesSnapshot(executorOutput.files || []);

      const analysis = analyzeExecutorOutput(executorOutput);
      result.violations = analysis.violations;
      result.violationScore = analysis.score;
      logger.logViolations(analysis.violations);
    }

    const ws = finalRun.workspace;
    if (ws) {
      if (ws.status === "install-failed") {
        result.finalStatus = "fail_install";
        result.installResult = { success: false, error: ws.error };
        result.error = ws.error;
      } else if (ws.status === "start-failed") {
        result.finalStatus = "fail_start";
        result.startResult = { success: false, error: ws.error };
        result.error = ws.error;
      } else if (ws.status === "running" && ws.port) {
        result.installResult = { success: true };
        result.startResult = { success: true };

        logger.logStageStart("health-check");
        const hc = await healthCheck(ws.port);
        result.healthCheck = hc;
        logger.logHealthCheck(hc);
        logger.logStageEnd("health-check", hc.status === "pass" ? "passed" : "failed");

        if (hc.status === "pass") {
          if (result.violations && result.violations.length > 0) {
            result.finalStatus = "pass_with_violations";
          } else {
            result.finalStatus = "pass";
          }
        } else {
          result.finalStatus = "fail_health";
          result.error = `Health check failed: HTTP ${hc.statusCode}`;
        }
      } else {
        result.finalStatus = "fail_start";
        result.error = `Unexpected workspace status: ${ws.status}`;
      }

      const wsLogs = workspace.getWorkspaceLogs(run.id);
      if (wsLogs) {
        logger.saveWorkspaceLogs(wsLogs.install, wsLogs.app);
        result.installResult = result.installResult || {};
        result.installResult.logSnippet = (wsLogs.install || "").slice(-500);
        result.startResult = result.startResult || {};
        result.startResult.logSnippet = (wsLogs.app || "").slice(-500);
      }
    } else if (finalRun.status === "failed") {
      result.finalStatus = "fail_plan";
      result.error = finalRun.error;
    }
  } catch (err) {
    result.finalStatus = "error";
    result.error = err.message || String(err);
    logger.logError("runner", err.message || String(err));
  }

  result.totalDuration = Date.now() - startTime;
  logger.logFinalStatus(result.finalStatus, result.totalDuration);
  logger.logRunEnd();

  return result;
}

async function runStressTest(options = {}) {
  if (stressTestState.running) {
    throw new Error("Stress test already running");
  }

  const { promptIds, delayBetweenMs = DELAY_BETWEEN_MS } = options;

  let testPrompts = prompts;
  if (promptIds && promptIds.length > 0) {
    testPrompts = prompts.filter((p) => promptIds.includes(p.id));
  }

  stressTestState = {
    running: true,
    currentPromptId: null,
    completed: 0,
    total: testPrompts.length,
    results: [],
    startedAt: Date.now(),
    finishedAt: null,
  };

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ForgeOS Stress Test — ${testPrompts.length} prompts`);
  console.log(`${"=".repeat(60)}\n`);

  for (let i = 0; i < testPrompts.length; i++) {
    const promptDef = testPrompts[i];
    stressTestState.currentPromptId = promptDef.id;

    logProgress(i, testPrompts.length, promptDef.id);

    try {
      await workspace.stopAllApps();
      await workspace.forceKillPort(4000);
      await sleep(1000);
      await workspace.forceKillPort(4000);
      await sleep(1000);

      let portFree = false;
      for (let check = 0; check < 5; check++) {
        try {
          require("child_process").execSync("fuser 4000/tcp 2>/dev/null", { timeout: 2000 });
          await workspace.forceKillPort(4000);
          await sleep(500);
        } catch {
          portFree = true;
          break;
        }
      }
      if (!portFree) {
        console.log(`  ⚠️  WARNING: Port 4000 still in use before ${promptDef.id}`);
      }
    } catch {}

    const result = await runSinglePrompt(promptDef);
    stressTestState.results.push(result);
    stressTestState.completed = i + 1;

    if (i < testPrompts.length - 1) {
      console.log(`  ⏳ Waiting ${delayBetweenMs / 1000}s before next prompt...`);
      await sleep(delayBetweenMs);
    }
  }

  try {
    await workspace.stopAllApps();
    await workspace.forceKillPort(4000);
  } catch {}

  stressTestState.running = false;
  stressTestState.currentPromptId = null;
  stressTestState.finishedAt = Date.now();

  logProgress(testPrompts.length, testPrompts.length, null);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Stress Test Complete`);
  console.log(`  Duration: ${((stressTestState.finishedAt - stressTestState.startedAt) / 1000).toFixed(1)}s`);
  console.log(`${"=".repeat(60)}\n`);

  return stressTestState.results;
}

module.exports = {
  runStressTest,
  getStressTestStatus,
};
