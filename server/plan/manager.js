// server/plan/manager.js
// Lightweight pre-build planning agent.
// Runs BEFORE the builder — produces a structured plan the user can approve,
// revise, or ask about. Only fires for raw chat prompts, not inspect-mode edits.

const Anthropic = require("@anthropic-ai/sdk");

const PLAN_SYSTEM_PROMPT = `You are the Forge Planner. Your job is to produce a concise, structured build plan for a web app change request.

You will receive:
- The user's prompt describing what they want
- A list of files currently in the workspace

Your output MUST be valid JSON with exactly this shape:
{
  "taskSummary": "One sentence describing what will be built",
  "approach": "One short paragraph describing how you will implement it",
  "filesToCreate": ["list of new files that will be created"],
  "filesToModify": ["list of existing files that will be changed and why, as 'filename — reason'"],
  "filesOffLimits": ["list of existing files that will NOT be touched"]
}

Rules:
- Be specific about file names — no vague entries like "various files"
- filesOffLimits must list every existing file you will NOT touch
- filesToModify must only include files genuinely required for the change
- Never include node_modules, package-lock.json, or .git entries
- Output raw JSON only — no markdown fences, no preamble`;

async function generatePlan(prompt, existingFiles) {
  const client = new Anthropic();

  const fileList = existingFiles.length > 0
    ? existingFiles.map(f => f.path || f).join("\n")
    : "(empty workspace — first build)";

  const userMessage = `User request: ${prompt}\n\nCurrent workspace files:\n${fileList}`;

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: PLAN_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  const raw = response.content
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("");

  const clean = raw.replace(/```json|```/g, "").trim();

  let plan;
  try {
    plan = JSON.parse(clean);
  } catch {
    plan = {
      taskSummary: "Build the requested feature",
      approach: "The planner could not generate a structured plan. You can approve to proceed with the full build, or revise your prompt.",
      filesToCreate: [],
      filesToModify: [],
      filesOffLimits: existingFiles.map(f => f.path || f),
    };
  }

  return plan;
}

// Serialize the approved plan into a constraint block injected at the top of the builder prompt.
// This is what makes the builder surgical — explicit permission and denial lists.
function planToConstraintBlock(plan) {
  const lines = [
    "╔══════════════════════════════════════════════════════════════╗",
    "  PRE-APPROVED BUILD PLAN — FOLLOW EXACTLY",
    "╚══════════════════════════════════════════════════════════════╝",
    "",
    `TASK: ${plan.taskSummary}`,
    "",
    `APPROACH: ${plan.approach}`,
    "",
  ];

  if (plan.filesToCreate?.length) {
    lines.push("FILES YOU MAY CREATE:");
    plan.filesToCreate.forEach(f => lines.push(`  + ${f}`));
    lines.push("");
  }

  if (plan.filesToModify?.length) {
    lines.push("FILES YOU MAY MODIFY:");
    plan.filesToModify.forEach(f => lines.push(`  ~ ${f}`));
    lines.push("");
  }

  if (plan.filesOffLimits?.length) {
    lines.push("FILES THAT ARE STRICTLY OFF LIMITS — DO NOT TOUCH THESE:");
    plan.filesOffLimits.forEach(f => lines.push(`  ✗ ${f}`));
    lines.push("");
  }

  lines.push("Any file not listed above must not be created or modified.");
  lines.push("Violating the off-limits list is a critical error.");

  return lines.join("\n");
}

module.exports = { generatePlan, planToConstraintBlock };
