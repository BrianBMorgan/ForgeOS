// server/plan/manager.js
// Lightweight pre-build planning agent.
// Runs BEFORE the builder — produces a structured plan the user can approve,
// revise, or ask about. Only fires for raw chat prompts, not inspect-mode edits.

const Anthropic = require("@anthropic-ai/sdk");

const PLAN_SYSTEM_PROMPT = `You are the Forge Planner. Your job is to produce a concise, structured build plan from either a user feature request or a Chat Agent diagnosis.

You will receive:
- A prompt — either a user feature request OR a Chat Agent diagnosis of a bug/migration
- A list of files currently in the workspace

INPUT TYPES:
1. User feature request (e.g. "Add a dark mode toggle") — plan the implementation.
2. Chat Agent diagnosis (e.g. "The Stability AI v1 endpoint is deprecated — rewrite both API routes to use v2beta with multipart/form-data") — treat this as a precise specification. Map exactly what files change and why. Do not add scope beyond what the diagnosis describes.

Your output MUST be valid JSON with exactly this shape:
{
  "taskSummary": "One sentence describing what will be built or fixed",
  "approach": "One short paragraph describing how you will implement it",
  "filesToCreate": ["list of new files that will be created"],
  "filesToModify": ["list of existing files that will be changed and why, as 'filename — reason'"],
  "filesOffLimits": ["list of existing files that will NOT be touched"]
}

Rules:
- Be specific about file names — no vague entries like "various files"
- filesOffLimits must list every existing file you will NOT touch
- filesToModify must only include files genuinely required for the change
- For diagnosis inputs: trust the diagnosis — do not second-guess the root cause or add extra scope
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

// Builds a tight constraint block for Chat Agent build suggestions.
// These prompts already name the target file explicitly (e.g. "in public/index.html, the hero-sub reads...").
// We parse the file out of the suggestion text and lock the builder to that one file only.
// Every other file in the workspace is placed off limits.
function suggestionToConstraintBlock(suggestionPrompt, existingFiles) {
  // Extract file path from suggestion — Chat Agent always writes "in <filepath>,"
  const match = suggestionPrompt.match(/\bin\s+([\w./-]+\.\w+)/i);
  const targetFile = match ? match[1] : null;

  const allFiles = (existingFiles || []).map(f => f.path || f).filter(Boolean);
  const offLimits = targetFile
    ? allFiles.filter(f => f !== targetFile)
    : allFiles; // if we can't parse the file, lock everything as a safety fallback

  const lines = [
    "╔══════════════════════════════════════════════════════════════╗",
    "  SURGICAL EDIT — CHAT AGENT INSTRUCTION",
    "╚══════════════════════════════════════════════════════════════╝",
    "",
    "This is a targeted fix from the Chat Agent. You must make ONLY the change described.",
    "Do not reorganize, rewrite, restyle, or touch anything not explicitly mentioned.",
    "",
  ];

  if (targetFile) {
    lines.push("FILE YOU MAY MODIFY:");
    lines.push(`  ~ ${targetFile}`);
    lines.push("");
  }

  if (offLimits.length) {
    lines.push("FILES THAT ARE STRICTLY OFF LIMITS — DO NOT TOUCH THESE:");
    offLimits.forEach(f => lines.push(`  ✗ ${f}`));
    lines.push("");
  }

  lines.push("Make only the single change described. Nothing else.");
  lines.push("Violating the off-limits list is a critical error.");

  // Return both the constraint text and the parsed target so the caller
  // can store it on the run object and surface it in the UI.
  return { constraintBlock: lines.join("\n"), targetFile };
}

module.exports = { generatePlan, planToConstraintBlock, suggestionToConstraintBlock };

