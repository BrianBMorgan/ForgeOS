"use strict";

// server/agents/manager.js
// Focused sub-agents callable by the Chat Agent via the invoke_agent tool.
// Each agent runs as a separate Claude API call with a tight, purpose-built prompt.
// Sub-agents are OPTIONAL tools — the Chat Agent invokes them only when the task
// genuinely requires deeper analysis than its own context can support.
// Never invoke sub-agents for simple single-file fixes or routine diagnostics.

const { callChat } = require("../pipeline/model-router");

const SUB_AGENT_MODEL = "claude-haiku-4-5-20251001";

// ── Agent definitions ────────────────────────────────────────────────────────

const AGENT_DEFINITIONS = {

  // Reads multiple files, understands their relationships, and returns a
  // structured summary. Use when Forge needs to understand how 3+ files
  // interact before diagnosing a bug or planning a multi-file change.
  file_analyst: {
    description: "Reads and analyzes multiple source files, mapping their relationships, imports, and data flow. Returns a structured analysis.",
    system: `You are a source code analyst. You will receive multiple files and a question about them.
Your job is to read the files carefully, understand how they interact, and answer the question precisely.

Rules:
- Cite specific line numbers when referencing code
- Map import/require relationships explicitly
- Identify data flow between files
- Flag any inconsistencies, missing exports, or mismatched interfaces
- Be concise — the orchestrator only needs the answer, not a tutorial
- Output plain text, no markdown headers`,
  },

  // Deep failure diagnosis. Reads run data, error messages, and source files
  // to produce a structured root cause report. Use when postBuildAnalysis
  // didn't match a known pattern and the Chat Agent needs deeper analysis.
  failure_analyst: {
    description: "Deep-diagnoses a build failure by analyzing run data, error messages, stage outputs, and source code. Returns structured root cause report with specific file and line.",
    system: `You are a build failure analyst for ForgeOS. You will receive build failure data and source files.
Your job is to identify the exact root cause — the specific line of code or configuration that caused the failure.

Rules:
- Start with the error message and trace it to its origin
- Check each stage in order: plan → build → install → start
- For JSON parse errors: identify what caused truncation (context size, token budget)
- For start-failed: find the syntax error or missing dependency
- For install-failed: find the bad package name or version
- Name the exact file and line of the root cause
- Recommend one specific fix — not multiple options
- Output: CAUSE: [one sentence] | FILE: [path] | FIX: [one sentence]
- If genuinely uncertain after reading all data: say so explicitly`,
  },

  // Verifies a proposed fix is correct before it runs. Use after a complex
  // multi-file fix to confirm internal consistency before burning a build cycle.
  fix_verifier: {
    description: "Verifies a proposed code fix is internally consistent — correct imports, matching interfaces, no introduced syntax errors. Use before applying complex multi-file changes.",
    system: `You are a code fix verifier for ForgeOS. You will receive existing files and a proposed fix.
Your job is to verify the fix is correct before it is applied.

Check:
1. Imports/requires — does the fix reference functions or modules that exist?
2. Interface matching — if a function signature changes, are all callers updated?
3. Syntax — obvious syntax errors in the proposed change
4. Side effects — does the fix break anything else in the files shown?

Output:
- VALID: [yes/no]
- ISSUES: [list any problems found, or "none"]
- VERDICT: one sentence — approve or reject the fix with reason

Be strict. A false positive wastes a build cycle. A false negative is worse.`,
  },

  // Spec analyst for large builds. Takes a complex prompt and returns a
  // structured breakdown of what needs to be built, in what order, with
  // what dependencies between pieces. Use before the planner on Canvas-scale builds.
  spec_analyst: {
    description: "Analyzes a complex build prompt and returns a structured breakdown: feature list, dependency order, file groupings, and risk areas. Use before planning large multi-file builds.",
    system: `You are a build spec analyst for ForgeOS. You will receive a complex build prompt.
Your job is to analyze it and return a structured breakdown to help the planner.

Output JSON with this shape:
{
  "features": ["list of distinct features to build"],
  "buildOrder": ["feature in the order they must be built — dependencies first"],
  "fileGroups": [
    { "group": "group name", "files": ["files that belong together"], "reason": "why these go together" }
  ],
  "riskAreas": ["anything likely to cause complexity or failure"],
  "estimatedPasses": number
}

Rules:
- buildOrder must respect dependencies (e.g. schema before routes, routes before frontend)
- fileGroups should have 3-5 files each — not too small, not too large
- riskAreas should be honest about what's hard (auth, file uploads, real-time, external APIs)
- estimatedPasses: how many builder passes this realistically needs
- Output raw JSON only — no prose, no markdown`,
  },
};

// ── Sub-agent runner ─────────────────────────────────────────────────────────

async function runSubAgent(agentType, context, question) {
  const definition = AGENT_DEFINITIONS[agentType];
  if (!definition) {
    throw new Error(`Unknown agent type: ${agentType}. Valid types: ${Object.keys(AGENT_DEFINITIONS).join(", ")}`);
  }

  const userContent = question
    ? `${context}\n\nQUESTION: ${question}`
    : context;

  console.log(`[agents] Running sub-agent: ${agentType}`);

  const result = await callChat(
    SUB_AGENT_MODEL,
    definition.system,
    [{ role: "user", content: userContent }],
    null,
    0.1, // Low temperature — sub-agents should be analytical, not creative
  );

  const output = result.content || "";
  console.log(`[agents] Sub-agent ${agentType} complete (${output.length} chars)`);

  return {
    agentType,
    output,
    question: question || null,
  };
}

// ── Convenience wrappers ─────────────────────────────────────────────────────

// Analyze multiple files and answer a question about them
async function analyzeFiles(filePaths, fileContents, question) {
  const context = filePaths.map((p, i) =>
    `--- ${p} ---\n${fileContents[i] || "[file not found]"}`
  ).join("\n\n");

  return runSubAgent("file_analyst", context, question);
}

// Deep-diagnose a build failure
async function diagnoseFailure(run, relevantFiles) {
  const runSummary = JSON.stringify({
    status: run.status,
    error: run.error,
    workspaceStatus: run.workspace?.status,
    workspaceError: run.workspace?.error,
    stages: Object.entries(run.stages || {}).reduce((acc, [k, v]) => {
      acc[k] = { status: v.status, error: v.error, output: typeof v.output === "string" ? v.output.slice(0, 500) : JSON.stringify(v.output || {}).slice(0, 500) };
      return acc;
    }, {}),
  }, null, 2);

  const filesContext = (relevantFiles || [])
    .map(f => `--- ${f.path} ---\n${f.content.slice(0, 2000)}`)
    .join("\n\n");

  const context = `RUN DATA:\n${runSummary}\n\nSOURCE FILES:\n${filesContext}`;
  return runSubAgent("failure_analyst", context, null);
}

// Verify a proposed fix
async function verifyFix(existingFiles, proposedFix) {
  const filesContext = existingFiles
    .map(f => `--- ${f.path} ---\n${f.content.slice(0, 2000)}`)
    .join("\n\n");

  const context = `EXISTING FILES:\n${filesContext}\n\nPROPOSED FIX:\n${proposedFix}`;
  return runSubAgent("fix_verifier", context, null);
}

// Analyze a build spec
async function analyzeSpec(prompt) {
  return runSubAgent("spec_analyst", `BUILD PROMPT:\n${prompt}`, null);
}

module.exports = {
  runSubAgent,
  analyzeFiles,
  diagnoseFailure,
  verifyFix,
  analyzeSpec,
  AGENT_DEFINITIONS,
};
