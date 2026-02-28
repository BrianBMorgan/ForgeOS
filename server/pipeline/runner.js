const OpenAI = require("openai");
const { v4: uuidv4 } = require("uuid");
const { zodResponseFormat } = require("openai/helpers/zod");
const {
  PlannerSchema,
  ReviewerSchema,
  PolicyGateSchema,
  ExecutorSchema,
  AuditorSchema,
} = require("./schemas");
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

const openai = new OpenAI();

const dbUrl = process.env.NEON_DATABASE_URL;
const sql = dbUrl ? neon(dbUrl) : null;

const PLANNER_MODEL = "gpt-4.1";
const REVIEWER_MODEL = "gpt-4.1-mini";

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

async function callAgent(messages, instructions, schema, model, formatName) {
  const response = await openai.chat.completions.create({
    model,
    temperature: model === REVIEWER_MODEL ? 0.2 : 0.7,
    messages: [
      { role: "system", content: instructions },
      ...messages,
    ],
    response_format: zodResponseFormat(schema, formatName),
  });

  const content = response.choices[0].message.content;
  const parsed = JSON.parse(content);
  schema.parse(parsed);
  return parsed;
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

async function executePipeline(runId) {
  const run = runs.get(runId);
  if (!run) return;

  const isIteration = run.iterationNumber > 1;

  let userMessageContent = run.prompt;
  if (isIteration) {
    const existingFiles = run.existingFiles || [];
    if (existingFiles.length > 0) {
      const fileList = existingFiles.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
      userMessageContent = `FOLLOW-UP REQUEST: ${run.prompt}\n\nCURRENT PROJECT FILES (iteration ${run.iterationNumber}):\n\n${fileList}`;
    } else {
      userMessageContent = `FOLLOW-UP REQUEST: ${run.prompt}\n\nNote: This is iteration ${run.iterationNumber} but no existing files were captured. Treat this as a fresh build incorporating the original intent plus this new request.`;
    }
  }
  const userMessage = { role: "user", content: userMessageContent };

  try {
    updateStage(run, "planner", "running");
    const plannerInstructions = isIteration ? PLANNER_ITERATE_INSTRUCTIONS : PLANNER_INSTRUCTIONS;
    const plannerOutput = await callAgent(
      [userMessage],
      plannerInstructions,
      PlannerSchema,
      PLANNER_MODEL,
      "planner_output"
    );
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
    updateStage(run, "reviewer_p2", "passed", reviewer2Output);

    updateStage(run, "policy_gate", "running");
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
      POLICY_GATE_INSTRUCTIONS,
      PolicyGateSchema,
      REVIEWER_MODEL,
      "policy_gate_output"
    );
    updateStage(run, "policy_gate", "passed", policyOutput);

    if (policyOutput.autoApprove && !policyOutput.humanApprovalRequired) {
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

  try {
    updateStage(run, "human_approval", "passed", { approved: true });
    updateStage(run, "executor", "running");

    const isIteration = run.iterationNumber > 1;
    const executorInstructions = isIteration ? EXECUTOR_ITERATE_INSTRUCTIONS : EXECUTOR_INSTRUCTIONS;
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
    updateStage(run, "executor", "passed", executorOutput);

    updateStage(run, "auditor", "running");
    const auditorMessages = [
      {
        role: "user",
        content: `Audit the following Executor output for deployment readiness. Check every item on your checklist.\n\nExecutor Output:\n${JSON.stringify(executorOutput, null, 2)}`,
      },
    ];

    const auditorOutput = await callAgent(
      auditorMessages,
      AUDITOR_INSTRUCTIONS,
      AuditorSchema,
      REVIEWER_MODEL,
      "auditor_output"
    );

    const MAX_AUDIT_ROUNDS = 2;
    let auditRound = 0;
    let currentAuditResult = auditorOutput;

    while (!currentAuditResult.approved && currentAuditResult.issues && currentAuditResult.issues.length > 0 && auditRound < MAX_AUDIT_ROUNDS) {
      auditRound++;
      updateStage(run, "auditor", "failed", currentAuditResult);

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
          content: `The Auditor found the following issues that must be fixed before deployment:\n\n${JSON.stringify(currentAuditResult.issues, null, 2)}\n\nFix ALL issues and return the complete corrected output.`,
        },
      ];

      executorOutput = await callAgent(
        fixMessages,
        EXECUTOR_FIX_INSTRUCTIONS,
        ExecutorSchema,
        PLANNER_MODEL,
        "executor_output"
      );
      updateStage(run, "executor", "passed", executorOutput);

      run.currentStage = "auditor";
      const reAuditMessages = [
        {
          role: "user",
          content: `Audit the following CORRECTED Executor output for deployment readiness. The Executor was asked to fix ${currentAuditResult.issues.length} issue(s). Verify all fixes were applied.\n\nCorrected Executor Output:\n${JSON.stringify(executorOutput, null, 2)}`,
        },
      ];

      currentAuditResult = await callAgent(
        reAuditMessages,
        AUDITOR_INSTRUCTIONS,
        AuditorSchema,
        REVIEWER_MODEL,
        "auditor_output"
      );
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

  run.workspace = { status: "writing-files", port: null, error: null };

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
        executorOutput.installCommand
      );
      if (!installResult.success) {
        run.workspace.status = "install-failed";
        run.workspace.error = installResult.error;
        run.status = "completed";
        return;
      }
    }

    run.workspace.status = "installed";

    if (executorOutput.startCommand) {
      run.workspace.status = "starting";
      const startResult = await workspace.startApp(
        run.id,
        executorOutput.startCommand,
        executorOutput.port || 4000
      );
      if (startResult.success) {
        run.workspace.status = "running";
        run.workspace.port = startResult.port;
      } else {
        run.workspace.status = "start-failed";
        run.workspace.error = startResult.error;
      }
    }

    run.status = "completed";
  } catch (err) {
    run.workspace.status = "build-failed";
    run.workspace.error = err.message;
    run.status = "completed";
  }
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
  return await loadRunSnapshot(runId);
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
