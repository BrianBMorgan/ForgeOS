const path = require("path");
const { v4: uuidv4 } = require("uuid");
const {
  PlannerSchema,
  ReviewerSchema,
  PolicyGateSchema,
  ExecutorSchema,
  AuditorSchema,
} = require("./schemas");
const { callStructured, getLastUsage } = require("./model-router");
const {
  PLANNER_INSTRUCTIONS,
  REVIEWER_PASS1_INSTRUCTIONS,
  PLANNER_REVISE_INSTRUCTIONS,
  REVIEWER_PASS2_INSTRUCTIONS,
  POLICY_GATE_INSTRUCTIONS,
  EXECUTOR_INSTRUCTIONS,
  PLANNER_REVISE_PASS3_INSTRUCTIONS,
  REVIEWER_PASS3_INSTRUCTIONS,
  AUDITOR_INSTRUCTIONS,
  EXECUTOR_FIX_INSTRUCTIONS,
  PLANNER_ITERATE_INSTRUCTIONS,
  EXECUTOR_ITERATE_INSTRUCTIONS,
} = require("./agents");

const { neon } = require("@neondatabase/serverless");

const { NO_TEMPERATURE_MODELS } = require("./model-router");

const dbUrl = process.env.NEON_DATABASE_URL;
const sql = dbUrl ? neon(dbUrl) : null;

let PLANNER_MODEL = "claude-sonnet-4-6";
let REVIEWER_MODEL = "claude-haiku-4-5-20251001";
let PLANNER_TEMP = 0.7;
let REVIEWER_TEMP = 0.2;

const STAGES = [
  "planner",
  "reviewer_p1",
  "revise_p2",
  "reviewer_p2",
  "policy_gate",
  "human_approval",
  "executor",
  "auditor",
];

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

async function loadModelConfig() {
  try {
    const settingsManager = require("../settings/manager");
    const config = await settingsManager.getSetting("model_config");
    if (config) {
      PLANNER_MODEL = config.plannerModel || "claude-sonnet-4-6";
      REVIEWER_MODEL = config.reviewerModel || "claude-haiku-4-5-20251001";
      PLANNER_TEMP = config.plannerTemp ?? 0.7;
      REVIEWER_TEMP = config.reviewerTemp ?? 0.2;
    }
  } catch {}
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

async function callAgent(messages, instructions, schema, model, formatName) {
  const temp = NO_TEMPERATURE_MODELS.has(model) ? undefined : (model === REVIEWER_MODEL ? REVIEWER_TEMP : PLANNER_TEMP);
  const MAX_RETRIES = 2;
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callStructured(model, instructions, messages, schema, formatName, temp);
    } catch (err) {
      lastErr = err;
      const isParseError = err.message && (err.message.includes("JSON") || err.message.includes("parse") || err.message.includes("invalid_type") || err.message.includes("expected"));
      if (isParseError && attempt < MAX_RETRIES) {
        console.warn(`[runner] Structured call attempt ${attempt + 1} failed (${err.message.substring(0, 100)}), retrying...`);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function trackUsage(run, stageName) {
  const usage = getLastUsage();
  if (!usage) return;
  if (!run.tokenUsage) run.tokenUsage = { stages: {}, totals: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  if (!run.tokenUsage.stages[stageName]) run.tokenUsage.stages[stageName] = { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
  const s = run.tokenUsage.stages[stageName];
  s.promptTokens += usage.promptTokens;
  s.completionTokens += usage.completionTokens;
  s.totalTokens += usage.totalTokens;
  s.calls += 1;
  run.tokenUsage.totals.promptTokens += usage.promptTokens;
  run.tokenUsage.totals.completionTokens += usage.completionTokens;
  run.tokenUsage.totals.totalTokens += usage.totalTokens;
}

function createRun(prompt, context) {
  const id = uuidv4().slice(0, 8);
  const run = {
    id,
    prompt,
    status: "running",
    currentStage: "planner",
    stages: {},
    error: null,
    createdAt: Date.now(),
    projectId: context?.projectId || null,
    iterationNumber: context?.iterationNumber || 1,
    existingFiles: context?.existingFiles || null,
  };

  for (const stage of STAGES) {
    run.stages[stage] = { status: "pending", output: null };
  }

  runs.set(id, run);
  return run;
}

function updateStage(run, stageName, status, output = null) {
  run.stages[stageName] = { status, output };
  if (status === "running") {
    run.currentStage = stageName;
  }
}

async function buildIterationHistory(projectId) {
  if (!sql) return "";
  try {
    const rows = await sql`
      SELECT i.iteration_number, i.prompt, i.run_id, rs.data
      FROM iterations i
      LEFT JOIN run_snapshots rs ON rs.id = i.run_id
      WHERE i.project_id = ${projectId}
      ORDER BY i.iteration_number ASC
    `;
    if (rows.length === 0) return "";

    const lines = [];
    for (const row of rows) {
      const num = row.iteration_number;
      const prompt = (row.prompt || "").slice(0, 120);
      const data = row.data;
      if (!data) {
        lines.push(`- Iter ${num}: "${prompt}" → no snapshot data`);
        continue;
      }

      const status = data.status || "unknown";
      const wsStatus = data.workspace?.status || "unknown";
      const wsError = data.workspace?.error ? ` error: ${data.workspace.error.slice(0, 200)}` : "";

      let failedStage = null;
      if (data.stages) {
        for (const [name, stage] of Object.entries(data.stages)) {
          if (stage.status === "failed") {
            failedStage = name;
            break;
          }
        }
      }

      const auditorIssues = data.stages?.auditor?.output?.issues;
      let auditorSummary = "";
      if (auditorIssues && auditorIssues.length > 0) {
        auditorSummary = ` auditor-issues: ${auditorIssues.map(i => i.description || i.rule).join("; ").slice(0, 300)}`;
      }

      const implSummary = data.stages?.executor?.output?.implementationSummary;
      let implNote = "";
      if (implSummary) {
        implNote = ` impl: "${implSummary.slice(0, 150)}"`;
      }

      const healthCheck = data.healthCheck;
      let healthNote = "";
      if (healthCheck) {
        healthNote = healthCheck.healthy
          ? ` health: OK (HTTP ${healthCheck.httpStatus})`
          : ` health: FAILED (HTTP ${healthCheck.httpStatus || "no-response"})`;
        if (healthCheck.startupLogs) {
          healthNote += ` startup-logs: ${healthCheck.startupLogs.slice(0, 200)}`;
        }
      }

      let line = `- Iter ${num}: "${prompt}" → ${status}, workspace: ${wsStatus}${wsError}`;
      if (failedStage) line += ` failed-at: ${failedStage}`;
      line += auditorSummary + implNote + healthNote;
      lines.push(line);
    }

    return `\n\nITERATION HISTORY (${rows.length} previous attempts):\n${lines.join("\n")}\n`;
  } catch (err) {
    console.error("Failed to build iteration history:", err.message);
    return "";
  }
}

function computeFileDiff(oldFiles, newFiles) {
  const oldMap = new Map();
  for (const f of oldFiles) {
    oldMap.set(f.path, f.content);
  }
  const newMap = new Map();
  for (const f of newFiles) {
    newMap.set(f.path, f.content);
  }

  const added = [];
  const removed = [];
  const modified = [];
  const unchanged = [];

  for (const [path, content] of newMap) {
    if (!oldMap.has(path)) {
      added.push(path);
    } else if (oldMap.get(path) !== content) {
      const oldLines = oldMap.get(path).split("\n");
      const newLines = content.split("\n");
      const changes = [];
      const maxLines = Math.max(oldLines.length, newLines.length);
      let addedCount = 0, removedCount = 0, changedCount = 0;

      for (let i = 0; i < maxLines; i++) {
        const oldLine = i < oldLines.length ? oldLines[i] : undefined;
        const newLine = i < newLines.length ? newLines[i] : undefined;
        if (oldLine === undefined) {
          addedCount++;
          if (changes.length < 10) changes.push(`+L${i + 1}: ${newLine.slice(0, 120)}`);
        } else if (newLine === undefined) {
          removedCount++;
          if (changes.length < 10) changes.push(`-L${i + 1}: ${oldLine.slice(0, 120)}`);
        } else if (oldLine !== newLine) {
          changedCount++;
          if (changes.length < 10) {
            changes.push(`~L${i + 1}: "${oldLine.slice(0, 60)}" → "${newLine.slice(0, 60)}"`);
          }
        }
      }

      modified.push({ path, addedCount, removedCount, changedCount, changes });
    } else {
      unchanged.push(path);
    }
  }

  for (const path of oldMap.keys()) {
    if (!newMap.has(path)) {
      removed.push(path);
    }
  }

  return { added, removed, modified, unchanged };
}

function formatDiffSummary(diff) {
  const lines = ["DIFF SUMMARY (previous iteration → this iteration):"];
  if (diff.added.length > 0) lines.push(`Files ADDED: ${diff.added.join(", ")}`);
  if (diff.removed.length > 0) lines.push(`Files REMOVED: ${diff.removed.join(", ")}`);
  if (diff.unchanged.length > 0) lines.push(`Files UNCHANGED: ${diff.unchanged.join(", ")}`);
  for (const m of diff.modified) {
    lines.push(`File MODIFIED: ${m.path} (+${m.addedCount} -${m.removedCount} ~${m.changedCount} lines)`);
    for (const c of m.changes) {
      lines.push(`  ${c}`);
    }
  }
  if (diff.added.length === 0 && diff.removed.length === 0 && diff.modified.length === 0) {
    lines.push("WARNING: ZERO changes detected. The Executor output is identical to the previous iteration.");
  }
  return lines.join("\n");
}

function detectRegressions(oldFiles, newFiles, planDescription) {
  const warnings = [];
  const oldMap = new Map();
  for (const f of oldFiles) oldMap.set(f.path, f.content);
  const newMap = new Map();
  for (const f of newFiles) newMap.set(f.path, f.content);

  for (const path of oldMap.keys()) {
    if (!newMap.has(path)) {
      warnings.push(`REGRESSION: File "${path}" existed in previous iteration but is MISSING in new output.`);
    }
  }

  const routePattern = /app\.(get|post|put|delete|patch|use)\s*\(\s*["'`]([^"'`]+)["'`]/g;
  const oldServerFiles = oldFiles.filter(f => f.path.endsWith(".js") && (f.path.includes("server") || f.path.includes("index") || f.path.includes("app")));
  const newServerFiles = newFiles.filter(f => f.path.endsWith(".js") && (f.path.includes("server") || f.path.includes("index") || f.path.includes("app")));

  const oldRoutes = new Set();
  for (const f of oldServerFiles) {
    let match;
    const re = new RegExp(routePattern.source, routePattern.flags);
    while ((match = re.exec(f.content)) !== null) {
      oldRoutes.add(`${match[1].toUpperCase()} ${match[2]}`);
    }
  }

  const newRoutes = new Set();
  for (const f of newServerFiles) {
    let match;
    const re = new RegExp(routePattern.source, routePattern.flags);
    while ((match = re.exec(f.content)) !== null) {
      newRoutes.add(`${match[1].toUpperCase()} ${match[2]}`);
    }
  }

  for (const route of oldRoutes) {
    if (!newRoutes.has(route)) {
      const planLower = (planDescription || "").toLowerCase();
      const routePath = route.split(" ")[1] || "";
      const planMentionsRemoval = planLower.includes("remove") && planLower.includes(routePath.toLowerCase());
      const planMentionsDelete = planLower.includes("delete") && planLower.includes(routePath.toLowerCase());
      const planMentionsReplace = planLower.includes("replace") && planLower.includes(routePath.toLowerCase());
      if (!planMentionsRemoval && !planMentionsDelete && !planMentionsReplace) {
        warnings.push(`REGRESSION: Route ${route} existed in previous iteration but is MISSING in new output.`);
      }
    }
  }

  return warnings;
}

async function executePipeline(runId) {
  const run = runs.get(runId);
  if (!run) return;

  await loadModelConfig();
  const skillsContext = await loadSkillsContext();

  const isIteration = run.iterationNumber > 1;

  let userMessageContent = run.prompt;
  if (isIteration) {
    const existingFiles = run.existingFiles || [];

    let iterationHistory = "";
    if (run.projectId) {
      iterationHistory = await buildIterationHistory(run.projectId);
    }

    if (existingFiles.length > 0) {
      const fileList = existingFiles.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
      userMessageContent = `FOLLOW-UP REQUEST: ${run.prompt}${iterationHistory}\n\nCURRENT PROJECT FILES (iteration ${run.iterationNumber}):\n\n${fileList}`;
    } else {
      userMessageContent = `FOLLOW-UP REQUEST: ${run.prompt}${iterationHistory}\n\nNote: This is iteration ${run.iterationNumber} but no existing files were captured. Treat this as a fresh build incorporating the original intent plus this new request.`;
    }
  }
  const userMessage = { role: "user", content: userMessageContent };

  try {
    updateStage(run, "planner", "running");
    const plannerInstructions = (isIteration ? PLANNER_ITERATE_INSTRUCTIONS : PLANNER_INSTRUCTIONS) + skillsContext;
    const plannerOutput = await callAgent(
      [userMessage],
      plannerInstructions,
      PlannerSchema,
      PLANNER_MODEL,
      "planner_output"
    );
    trackUsage(run, "planner");
    sanitizePlannerOutput(plannerOutput);
    updateStage(run, "planner", "passed", plannerOutput);

    updateStage(run, "reviewer_p1", "running");
    const reviewMessages = [
      userMessage,
      {
        role: "assistant",
        content: `Build Plan:\n${JSON.stringify(plannerOutput, null, 2)}`,
      },
    ];
    const reviewer1Output = await callAgent(
      reviewMessages,
      REVIEWER_PASS1_INSTRUCTIONS,
      ReviewerSchema,
      REVIEWER_MODEL,
      "reviewer_output"
    );
    trackUsage(run, "reviewer");
    updateStage(run, "reviewer_p1", "passed", reviewer1Output);

    updateStage(run, "revise_p2", "running");
    const reviseMessages = [
      userMessage,
      {
        role: "assistant",
        content: `Build Plan:\n${JSON.stringify(plannerOutput, null, 2)}`,
      },
      {
        role: "user",
        content: `Review Findings:\n${JSON.stringify(reviewer1Output, null, 2)}\n\nRevise the plan to address all required changes.`,
      },
    ];
    const revisedPlan = await callAgent(
      reviseMessages,
      PLANNER_REVISE_INSTRUCTIONS,
      PlannerSchema,
      PLANNER_MODEL,
      "planner_output"
    );
    trackUsage(run, "planner");
    sanitizePlannerOutput(revisedPlan);
    updateStage(run, "revise_p2", "passed", revisedPlan);

    updateStage(run, "reviewer_p2", "running");
    const review2Messages = [
      userMessage,
      {
        role: "assistant",
        content: `Revised Build Plan:\n${JSON.stringify(revisedPlan, null, 2)}`,
      },
    ];
    const reviewer2Output = await callAgent(
      review2Messages,
      REVIEWER_PASS2_INSTRUCTIONS,
      ReviewerSchema,
      REVIEWER_MODEL,
      "reviewer_output"
    );
    trackUsage(run, "reviewer");
    updateStage(run, "reviewer_p2", "passed", reviewer2Output);

    updateStage(run, "policy_gate", "running");
    let techStackContext = "";
    try {
      const settingsManager = require("../settings/manager");
      const techStack = await settingsManager.getSetting("allowed_tech_stack");
      if (techStack) {
        if (techStack.allowed?.length) techStackContext += `\n\nALLOWED PACKAGES: ${techStack.allowed.join(", ")}`;
        if (techStack.banned?.length) techStackContext += `\nBANNED PACKAGES (flag if used): ${techStack.banned.join(", ")}`;
      }
    } catch {}
    const policyMessages = [
      userMessage,
      {
        role: "assistant",
        content: `Final Plan:\n${JSON.stringify(revisedPlan, null, 2)}`,
      },
      {
        role: "user",
        content: `Reviewer Verdict:\n${JSON.stringify(reviewer2Output, null, 2)}`,
      },
    ];
    const policyOutput = await callAgent(
      policyMessages,
      POLICY_GATE_INSTRUCTIONS + techStackContext,
      PolicyGateSchema,
      REVIEWER_MODEL,
      "policy_gate_output"
    );
    trackUsage(run, "policy_gate");
    updateStage(run, "policy_gate", "passed", policyOutput);

    let forceAutoApprove = false;
    try {
      const settingsManager = require("../settings/manager");
      const autoApproveSetting = await settingsManager.getSetting("auto_approve");
      if (autoApproveSetting?.enabled) {
        const riskLevel = policyOutput.riskLevel || "low";
        const maxRisk = autoApproveSetting.maxRiskLevel || "low";
        const riskOrder = { low: 0, medium: 1, high: 2 };
        if ((riskOrder[riskLevel] || 0) <= (riskOrder[maxRisk] || 0)) {
          forceAutoApprove = true;
        }
      }
    } catch {}

    if ((policyOutput.autoApprove && !policyOutput.humanApprovalRequired) || forceAutoApprove) {
      await executeAfterApproval(run);
    } else {
      updateStage(run, "human_approval", "blocked", {
        reason: policyOutput.reason,
        humanApprovalRequired: true,
      });
      run.status = "awaiting-approval";
      run.currentStage = "human_approval";
    }
  } catch (err) {
    run.status = "failed";
    run.error = err.message || "Pipeline failed";
    const currentStage = run.currentStage;
    if (currentStage && run.stages[currentStage]) {
      run.stages[currentStage].status = "failed";
    }
    await saveRunSnapshot(run);
  }
}

async function executeAfterApproval(run) {
  const revisedPlan =
    run.stages.revise_p3?.output || run.stages.revise_p2.output;

  const skillsCtx = await loadSkillsContext();

  try {
    updateStage(run, "human_approval", "passed", { approved: true });
    updateStage(run, "executor", "running");

    const isIteration = run.iterationNumber > 1;
    const executorInstructions = (isIteration ? EXECUTOR_ITERATE_INSTRUCTIONS : EXECUTOR_INSTRUCTIONS) + skillsCtx;
    const existingFiles = run.existingFiles || [];

    let executorContext = "Human approval has been granted. Execute this plan now.";
    if (isIteration && existingFiles.length > 0) {
      executorContext = `Human approval has been granted. Execute this plan now. Here are the current project files you must preserve and modify:\n\n${existingFiles.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n")}`;
    } else if (isIteration) {
      executorContext = `Human approval has been granted. Execute this plan now. This is iteration ${run.iterationNumber} but no existing files were available. Build the complete application from scratch incorporating this iteration's requirements.`;
    }

    const executorMessages = [
      { role: "user", content: run.prompt },
      {
        role: "assistant",
        content: `Approved Build Plan:\n${JSON.stringify(revisedPlan, null, 2)}`,
      },
      {
        role: "user",
        content: executorContext,
      },
    ];

    let executorOutput = await callAgent(
      executorMessages,
      executorInstructions,
      ExecutorSchema,
      PLANNER_MODEL,
      "executor_output"
    );
    trackUsage(run, "executor");
    updateStage(run, "executor", "passed", executorOutput);

    updateStage(run, "auditor", "running");

    let diffContext = "";
    let regressionContext = "";
    if (isIteration && existingFiles.length > 0 && executorOutput.files) {
      const diff = computeFileDiff(existingFiles, executorOutput.files);
      diffContext = "\n\n" + formatDiffSummary(diff);

      const regressions = detectRegressions(existingFiles, executorOutput.files, revisedPlan.description || "");
      if (regressions.length > 0) {
        regressionContext = "\n\nREGRESSION WARNINGS:\n" + regressions.join("\n");
      }
    }

    const auditorMessages = [
      {
        role: "user",
        content: `Audit the following Executor output for deployment readiness. Check every item on your checklist.\n\nORIGINAL USER REQUEST:\n${run.prompt}\n\nAPPROVED PLAN:\n${JSON.stringify(revisedPlan, null, 2)}\n\nExecutor Output:\n${JSON.stringify(executorOutput, null, 2)}${diffContext}${regressionContext}`,
      },
    ];

    let auditorOutput = await callAgent(
      auditorMessages,
      AUDITOR_INSTRUCTIONS,
      AuditorSchema,
      REVIEWER_MODEL,
      "auditor_output"
    );

    trackUsage(run, "auditor");
    const MAX_AUDIT_ROUNDS = 6;
    let auditRound = 0;
    let currentAuditResult = auditorOutput;

    while (!currentAuditResult.approved && currentAuditResult.issues && currentAuditResult.issues.length > 0 && auditRound < MAX_AUDIT_ROUNDS) {
      auditRound++;
      updateStage(run, "auditor", "failed", currentAuditResult);

      const preFixFiles = executorOutput.files || [];

      let fixDiffInfo = "";
      if (isIteration && existingFiles.length > 0 && executorOutput.files) {
        const preDiff = computeFileDiff(existingFiles, executorOutput.files);
        fixDiffInfo = `\n\nDIFF FROM PREVIOUS ITERATION (what you actually changed):\n${formatDiffSummary(preDiff)}\n\nUse this diff to understand what you DID change vs what the Auditor says you SHOULD have changed.`;
      }

      const affectedFiles = new Set(currentAuditResult.issues.map(i => i.file || i.affectedFile || "").filter(Boolean));
      const affectedFilesList = affectedFiles.size > 0
        ? `\n\nFILES THAT MUST BE MODIFIED (the Auditor flagged these specifically): ${[...affectedFiles].join(", ")}`
        : "";

      const roundsLeft = MAX_AUDIT_ROUNDS - auditRound;
      const urgency = roundsLeft <= 2
        ? `URGENT: Only ${roundsLeft} fix round(s) remaining before the build FAILS permanently.`
        : `Fix round ${auditRound} of ${MAX_AUDIT_ROUNDS}.`;

      const planContext = currentAuditResult.planDeviationDetected
        ? `\n\nAPPROVED PLAN (you must revert to this — not patch your deviation):\n${JSON.stringify(revisedPlan, null, 2)}`
        : "";

      const fixMessages = [
        {
          role: "user",
          content: run.prompt,
        },
        {
          role: "assistant",
          content: `Original Executor Output:\n${JSON.stringify(executorOutput, null, 2)}`,
        },
        {
          role: "user",
          content: `The Auditor REJECTED your output. ${urgency}\n\n${currentAuditResult.planDeviationDetected ? `PLAN DEVIATION DETECTED:\n${currentAuditResult.planDeviationNote}\n\nDo NOT patch the deviated implementation. Revert to the mechanism the approved plan specified. Throw away the wrong approach.${planContext}\n\n` : ""}AUDITOR ISSUES (${currentAuditResult.issues.length}):\n${JSON.stringify(currentAuditResult.issues, null, 2)}\n\nFocus on the CRITICAL and HIGH severity issues first. Fix them precisely. Returning unchanged code = immediate failure.${affectedFilesList}${fixDiffInfo}`,
        },
      ];

      executorOutput = await callAgent(
        fixMessages,
        EXECUTOR_FIX_INSTRUCTIONS,
        ExecutorSchema,
        PLANNER_MODEL,
        "executor_output"
      );
      trackUsage(run, "executor");

      const postFixDiff = computeFileDiff(preFixFiles, executorOutput.files || []);
      const affectedFilesChanged = [...affectedFiles].some(af =>
        postFixDiff.modified.some(m => m.path === af) ||
        postFixDiff.added.includes(af)
      );
      const anyChanges = postFixDiff.modified.length > 0 || postFixDiff.added.length > 0 || postFixDiff.removed.length > 0;

      if (!anyChanges) {
        console.log(`[fix-loop] Round ${auditRound}: Executor returned IDENTICAL code. Zero changes detected. Failing immediately.`);
        updateStage(run, "executor", "failed", { ...executorOutput, fixRoundFailed: true, reason: "Executor returned identical code — no fixes applied" });
        updateStage(run, "auditor", "failed", {
          ...currentAuditResult,
          fixApplied: false,
          auditRounds: auditRound + 1,
          exhaustedFixRounds: true,
          executorRefusedToFix: true,
        });
        run.status = "failed";
        run.error = `Executor returned identical code in fix round ${auditRound} — refused to apply Auditor fixes. Issues: ${currentAuditResult.issues.map(i => i.description || i.rule || "unknown").join("; ").slice(0, 500)}`;
        await buildAndRun(run, executorOutput);
        await saveRunSnapshot(run);
        return;
      }

      if (affectedFiles.size > 0 && !affectedFilesChanged) {
        console.log(`[fix-loop] Round ${auditRound}: Executor made changes but NOT to the flagged files (${[...affectedFiles].join(", ")}). Warning — continuing to re-audit anyway.`);
      }

      console.log(`[fix-loop] Round ${auditRound}: Executor made changes — ${postFixDiff.modified.length} modified, ${postFixDiff.added.length} added, ${postFixDiff.removed.length} removed. Re-auditing.`);
      updateStage(run, "executor", "passed", executorOutput);

      run.currentStage = "auditor";

      let fixDiffContext = "";
      let fixRegressionContext = "";
      if (isIteration && existingFiles.length > 0 && executorOutput.files) {
        const fixDiff = computeFileDiff(existingFiles, executorOutput.files);
        fixDiffContext = "\n\n" + formatDiffSummary(fixDiff);
        const fixRegressions = detectRegressions(existingFiles, executorOutput.files, revisedPlan.description || "");
        if (fixRegressions.length > 0) {
          fixRegressionContext = "\n\nREGRESSION WARNINGS:\n" + fixRegressions.join("\n");
        }
      }

      const reAuditMessages = [
        {
          role: "user",
          content: `Audit the following CORRECTED Executor output for deployment readiness. The Executor was asked to fix ${currentAuditResult.issues.length} issue(s). Verify all fixes were applied.\n\nORIGINAL USER REQUEST:\n${run.prompt}\n\nAPPROVED PLAN:\n${JSON.stringify(revisedPlan, null, 2)}\n\nCorrected Executor Output:\n${JSON.stringify(executorOutput, null, 2)}${fixDiffContext}${fixRegressionContext}`,
        },
      ];

      currentAuditResult = await callAgent(
        reAuditMessages,
        AUDITOR_INSTRUCTIONS,
        AuditorSchema,
        REVIEWER_MODEL,
        "auditor_output"
      );
      trackUsage(run, "auditor");
    }

    if (!currentAuditResult.approved) {
      const criticalIssues = (currentAuditResult.issues || []).filter(i => i.severity === "critical" || i.severity === "high");
      updateStage(run, "auditor", "failed", {
        ...currentAuditResult,
        fixApplied: auditRound > 0,
        originalIssueCount: auditorOutput.issues?.length || 0,
        auditRounds: auditRound + 1,
        exhaustedFixRounds: true,
      });
      run.status = "failed";
      run.error = `Auditor rejected after ${auditRound + 1} round(s). ${criticalIssues.length} critical/high issue(s) remain: ${criticalIssues.map(i => i.description || i.rule || "unknown").join("; ").slice(0, 500)}`;
      await buildAndRun(run, executorOutput);
      await saveRunSnapshot(run);
      return;
    }

    updateStage(run, "auditor", "passed", {
      ...currentAuditResult,
      fixApplied: auditRound > 0,
      originalIssueCount: auditorOutput.issues?.length || 0,
      auditRounds: auditRound + 1,
    });

    run.currentStage = "auditor";
    await buildAndRun(run, executorOutput);
    await saveRunSnapshot(run);
  } catch (err) {
    run.status = "failed";
    run.error = err.message || "Executor failed";
    const failStage = run.currentStage || "executor";
    if (run.stages[failStage]) {
      run.stages[failStage].status = "failed";
    }
    await saveRunSnapshot(run);
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

    const shouldStart = executorOutput.startCommand || workspace.isStaticSite(path.join(__dirname, "..", "..", "workspaces", run.id));
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

async function handleApproval(runId) {
  const run = runs.get(runId);
  if (!run || run.status !== "awaiting-approval") {
    return { error: "Run not found or not awaiting approval" };
  }

  run.status = "running";
  executeAfterApproval(run).catch(async (err) => {
    run.status = "failed";
    run.error = err.message;
    await saveRunSnapshot(run);
  });

  return { status: "approved", runId };
}

async function handleRejection(runId, feedback) {
  const run = runs.get(runId);
  if (!run || run.status !== "awaiting-approval") {
    return { error: "Run not found or not awaiting approval" };
  }

  run.status = "running";
  updateStage(run, "human_approval", "failed", {
    approved: false,
    feedback,
  });

  executeRevisionPass(run, feedback).catch(async (err) => {
    run.status = "failed";
    run.error = err.message;
    await saveRunSnapshot(run);
  });

  return { status: "rejected", runId };
}

async function executeRevisionPass(run, feedback) {
  const currentPlan = run.stages.revise_p2.output;
  const lastReview = run.stages.reviewer_p2.output;

  try {
    if (!run.stages.revise_p3) {
      run.stages.revise_p3 = { status: "pending", output: null };
    }
    if (!run.stages.reviewer_p3) {
      run.stages.reviewer_p3 = { status: "pending", output: null };
    }

    updateStage(run, "revise_p3", "running");
    run.currentStage = "revise_p3";

    const reviseMessages = [
      { role: "user", content: run.prompt },
      {
        role: "assistant",
        content: `Current Plan:\n${JSON.stringify(currentPlan, null, 2)}`,
      },
      {
        role: "user",
        content: `Reviewer Findings:\n${JSON.stringify(lastReview, null, 2)}\n\nHuman Feedback:\n${feedback}\n\nRevise the plan to address all issues.`,
      },
    ];

    const revisedPlan = await callAgent(
      reviseMessages,
      PLANNER_REVISE_PASS3_INSTRUCTIONS,
      PlannerSchema,
      PLANNER_MODEL,
      "planner_output"
    );
    trackUsage(run, "planner");
    sanitizePlannerOutput(revisedPlan);
    updateStage(run, "revise_p3", "passed", revisedPlan);

    updateStage(run, "reviewer_p3", "running");
    run.currentStage = "reviewer_p3";

    const review3Messages = [
      { role: "user", content: run.prompt },
      {
        role: "assistant",
        content: `Revised Plan:\n${JSON.stringify(revisedPlan, null, 2)}`,
      },
    ];

    const reviewer3Output = await callAgent(
      review3Messages,
      REVIEWER_PASS3_INSTRUCTIONS,
      ReviewerSchema,
      REVIEWER_MODEL,
      "reviewer_output"
    );
    trackUsage(run, "reviewer");
    updateStage(run, "reviewer_p3", "passed", reviewer3Output);

    if (
      reviewer3Output.approved &&
      reviewer3Output.withRequiredChanges.length === 0
    ) {
      await executeAfterApproval(run);
    } else {
      updateStage(run, "human_approval", "blocked", {
        reason: "Revised plan still has issues after human feedback. Review the updated plan and approve or provide additional feedback.",
        humanApprovalRequired: true,
      });
      run.status = "awaiting-approval";
      run.currentStage = "human_approval";
    }
  } catch (err) {
    run.status = "failed";
    run.error = err.message || "Revision pass failed";
    await saveRunSnapshot(run);
  }
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
  executePipeline,
  handleApproval,
  handleRejection,
  getRun,
  getRunSync,
  getAllRuns,
};
