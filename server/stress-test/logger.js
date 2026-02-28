const fs = require("fs");
const path = require("path");

const RESULTS_DIR = path.join(__dirname, "..", "..", "stress-test-results");

function ensureResultsDir() {
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }
}

function timestamp() {
  return new Date().toISOString();
}

function createLogger(promptId, runId) {
  ensureResultsDir();

  const prefix = `${promptId}-${runId}`;
  const logFile = path.join(RESULTS_DIR, `${prefix}.log`);
  const executorFile = path.join(RESULTS_DIR, `${prefix}-executor.json`);
  const workspaceLogFile = path.join(RESULTS_DIR, `${prefix}-workspace.log`);
  const filesSnapshotFile = path.join(RESULTS_DIR, `${prefix}-files.json`);

  fs.writeFileSync(logFile, "", "utf-8");

  function appendLog(message) {
    const line = `[${timestamp()}] ${message}\n`;
    fs.appendFileSync(logFile, line, "utf-8");
  }

  function logStageStart(stageName) {
    const msg = `STAGE_START: ${stageName}`;
    appendLog(msg);
    console.log(`  ⏳ [${promptId}] ${stageName} started`);
  }

  function logStageEnd(stageName, status, durationMs) {
    const dur = durationMs != null ? ` (${durationMs}ms)` : "";
    const msg = `STAGE_END: ${stageName} → ${status}${dur}`;
    appendLog(msg);
    const icon = status === "passed" ? "✅" : status === "failed" ? "❌" : "⚠️";
    console.log(`  ${icon} [${promptId}] ${stageName} → ${status}${dur}`);
  }

  function logStageOutput(stageName, output) {
    appendLog(`STAGE_OUTPUT: ${stageName}\n${JSON.stringify(output, null, 2)}`);
  }

  function logError(context, error) {
    const msg = `ERROR [${context}]: ${error}`;
    appendLog(msg);
    console.error(`  ❌ [${promptId}] Error in ${context}: ${error}`);
  }

  function logInfo(message) {
    appendLog(`INFO: ${message}`);
  }

  function saveExecutorOutput(executorOutput) {
    try {
      fs.writeFileSync(executorFile, JSON.stringify(executorOutput, null, 2), "utf-8");
      appendLog(`EXECUTOR_OUTPUT saved to ${path.basename(executorFile)}`);
    } catch (err) {
      appendLog(`ERROR saving executor output: ${err.message}`);
    }
  }

  function saveWorkspaceLogs(installLog, appLog) {
    try {
      let content = "";
      if (installLog) {
        content += "=== INSTALL LOG ===\n" + installLog + "\n\n";
      }
      if (appLog) {
        content += "=== APP LOG ===\n" + appLog + "\n";
      }
      fs.writeFileSync(workspaceLogFile, content, "utf-8");
      appendLog(`WORKSPACE_LOGS saved to ${path.basename(workspaceLogFile)}`);
    } catch (err) {
      appendLog(`ERROR saving workspace logs: ${err.message}`);
    }
  }

  function saveFilesSnapshot(files) {
    try {
      fs.writeFileSync(filesSnapshotFile, JSON.stringify(files, null, 2), "utf-8");
      appendLog(`FILES_SNAPSHOT saved to ${path.basename(filesSnapshotFile)} (${files.length} files)`);
    } catch (err) {
      appendLog(`ERROR saving files snapshot: ${err.message}`);
    }
  }

  function logHealthCheck(result) {
    const msg = `HEALTH_CHECK: status=${result.status}, statusCode=${result.statusCode || "N/A"}`;
    appendLog(msg);
    if (result.bodySnippet) {
      appendLog(`HEALTH_CHECK_BODY: ${result.bodySnippet.substring(0, 500)}`);
    }
    const icon = result.status === "pass" ? "✅" : "❌";
    console.log(`  ${icon} [${promptId}] Health check: ${result.status} (HTTP ${result.statusCode || "N/A"})`);
  }

  function logViolations(violations) {
    appendLog(`VIOLATIONS: ${violations.length} found`);
    for (const v of violations) {
      appendLog(`  VIOLATION [${v.severity}] ${v.rule}: ${v.file}:${v.line} — ${v.snippet}`);
    }
    if (violations.length > 0) {
      console.log(`  ⚠️  [${promptId}] ${violations.length} violation(s) detected`);
    } else {
      console.log(`  ✅ [${promptId}] No violations`);
    }
  }

  function logFinalStatus(finalStatus, totalDuration) {
    const msg = `FINAL_STATUS: ${finalStatus} (total: ${totalDuration}ms)`;
    appendLog(msg);
    const icon = finalStatus === "pass" ? "✅" : "❌";
    console.log(`  ${icon} [${promptId}] Final: ${finalStatus} (${(totalDuration / 1000).toFixed(1)}s)`);
  }

  function logRunStart(prompt, category) {
    appendLog(`RUN_START: promptId=${promptId}, runId=${runId}, category=${category}`);
    appendLog(`PROMPT: ${prompt}`);
    console.log(`\n🔨 [${promptId}] Starting run ${runId} — category: ${category}`);
    console.log(`   Prompt: ${prompt.substring(0, 100)}${prompt.length > 100 ? "..." : ""}`);
  }

  function logRunEnd() {
    appendLog("RUN_END");
    console.log(`   [${promptId}] Run ${runId} complete\n`);
  }

  return {
    appendLog,
    logStageStart,
    logStageEnd,
    logStageOutput,
    logError,
    logInfo,
    saveExecutorOutput,
    saveWorkspaceLogs,
    saveFilesSnapshot,
    logHealthCheck,
    logViolations,
    logFinalStatus,
    logRunStart,
    logRunEnd,
  };
}

function logProgress(completed, total, currentPromptId) {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const bar = "█".repeat(Math.floor(pct / 5)) + "░".repeat(20 - Math.floor(pct / 5));
  console.log(`\n[${bar}] ${completed}/${total} (${pct}%) — Current: ${currentPromptId || "done"}`);
}

module.exports = {
  createLogger,
  logProgress,
  RESULTS_DIR,
};
