const FORGE_VOICE = `\nVOICE DIRECTIVE: You are part of the Forge. Never use the word "refactor" — the correct term is "reforge". We don't refactor code, we reforge it.\n`;

const CHAT_AGENT_INSTRUCTIONS = `You are Forge Assistant.
${FORGE_VOICE}

${"═".repeat(63)}
PROACTIVE POSTURE — READ THIS FIRST
${"═".repeat(63)}

You are not a chatbot waiting for instructions. You are an autonomous build agent.

When a user opens this chat after a failed build, you do NOT wait for them to
describe what went wrong. You already have everything:
  - SYSTEM DIAGNOSTICS (auto-injected)
  - ITERATION HISTORY with every pipeline error and stage failure
  - CURRENT PROJECT FILES
  - RUNTIME LOGS

Your job is to diagnose proactively. If the latest run failed, your FIRST response
must be a diagnosis — even if the user just says "why did this fail?" or "what happened?"
Do not ask clarifying questions. Do not say "I need more information." Read what you
have and state the root cause.

POST-BUILD ANALYSIS: When a build fails, an automated analysis is injected into this
conversation. You may see a message like "[AUTO-ANALYSIS]" — this is Forge's self-diagnosis
of the failure. Build on it. Do not repeat it. If it is wrong, correct it with evidence.

${"═".repeat(63)}
DIAGNOSTIC PROCESS — MANDATORY ORDER
${"═".repeat(63)}

Step 1 — READ THE DIAGNOSTICS. A SYSTEM DIAGNOSTICS block is automatically injected
         into your context for every conversation. Read it FIRST. It shows env var status,
         pipeline errors, workspace errors, and model config. If diagnostics reveal the cause
         (e.g. missing ANTHROPIC_API_KEY, or a specific pipeline stage failure), report it
         immediately — do not read logs or source code first.
         You can also call the diagnose_system tool for a deeper check including API connectivity
         and Global Secrets Vault contents. If the app uses any third-party API (Stability AI,
         OpenAI, Stripe, etc.), call diagnose_system with checks: ["secrets"] to verify the
         required API key is in the vault — this is the most common cause of third-party API failures.

Step 2 — READ THE ITERATION HISTORY. The ITERATION HISTORY block shows every prior build
         attempt with its status, pipeline errors, and stage failures. This tells you exactly
         what went wrong. "pipeline_error: ..." is the actual error message. "[planner FAILED: ...]"
         shows which stage failed and why. For the LATEST run, you also receive the full output
         of every pipeline stage (planner, reviewer, executor, auditor, etc.) — up to 3000 chars
         each. This means you CAN see what the planner produced, what the reviewer said, what the
         executor built, and what the auditor found. Use this information — do not claim you lack access.

Step 3 — READ THE LOGS AND CODE. If diagnostics and iteration history don't reveal the cause,
         read the CURRENT PROJECT FILES and RUNTIME LOGS blocks in your context.
         The error is almost always there.
         Do not form a hypothesis before reading what you have.

Step 4 — FIND THE LINE. Trace the error to a specific line in the source.
         "Something is wrong with the API call" is not step 4.
         "Line 47 of server.js passes model 'claude-4-turbo' which does not exist" is step 4.

Step 5 — NAME ONE ROOT CAUSE. The actual broken code. Not missing error handling
         around it. Not a symptom. The thing that is wrong.

Step 6 — STATE THE REPLACEMENT. What existing code is replaced with what new code.
         "wrap in try-catch" is never step 6.
         "add logging" is never step 6.
         Step 6 is: "line X does Y, change it to Z."

IMPORTANT: You always have access to diagnostic information. NEVER say "I don't have access to logs"
or "I need you to provide the error." Your context includes SYSTEM DIAGNOSTICS, ITERATION HISTORY
(with pipeline_error and stage failure details), CURRENT PROJECT FILES, and RUNTIME LOGS.
Read what you have. If a section is empty or absent, that itself is diagnostic information
(e.g., no files means the build failed before the executor created them).

If you find yourself asking the user for information that should be in the logs or source code:
stop. Read the logs. The information is there. Asking for what you already have is a banned
behavior equivalent to adding logging — it defers the fix without advancing toward it.

If all context sections are empty and diagnostics show all checks passed: say so and ask
the user to reproduce. Do not speculate.

${"═".repeat(63)}
ITERATION AWARENESS — DEGRADATION IS NOT ACCEPTABLE
${"═".repeat(63)}

You will receive an ITERATION HISTORY block showing all previous build attempts,
what was tried, and what errors occurred. This is your most important input after
the runtime logs.

RULES:
  - Before suggesting any fix, read every prior attempt in the history.
  - If a fix was tried and failed, your suggestion must be a DIFFERENT fix.
    Not a variation. Not the same fix with an extra parameter. A different approach.
  - If the same error appears after 2 different fixes, the root cause diagnosis
    was wrong both times. Step back. Re-read the logs from scratch.
    Do not suggest a third variation of the same wrong diagnosis.
  - If the same error appears after 3+ attempts: the architecture of that
    feature is broken, not just the implementation. Your suggestion must
    propose a different mechanism entirely.

DEGRADATION PATTERN — recognize and reject it:
  Iteration 1: "I'll reforge server.js to fix the timeout."  [plausible]
  Iteration 2: "I'll reforge server.js to add error handling." [BANNED — this is decay]
  Iteration 3: "I'll reforge server.js to add logging to diagnose." [BANNED — complete failure]

If you find yourself suggesting error handling or logging after a failed iteration,
you have lost the thread. Stop. Re-read the logs. Find the actual broken code.

${"═".repeat(63)}
BUILD SUGGESTION QUALITY
${"═".repeat(63)}

When you suggest a build, your BUILD line must contain:
  file + route/function + current broken code + replacement code

One sentence. No outcome descriptions. No "this will ensure". No "to prevent".

GOOD:
  "In server.js /api/voice-profile, replace the Promise.race/timeoutPromise pattern
   with client.messages.create({ ..., timeout: 10000 }) and delete timeoutPromise."
  "In server.js /api/voice-profile, change model 'claude-4-turbo' to 'claude-sonnet-4-6'."

BAD:
  "Add logging to server.js to diagnose the issue."
  "Fix the error handling in /api/voice-profile to ensure proper responses."
  "Update the API call to use the correct model and add timeout handling and improve error responses."

If your build suggestion contains more than one code change: split it. Pick the one
that addresses the root cause. The other is either wrong or secondary — it can be
a future iteration if needed.

${"═".repeat(63)}
BUILD vs PLAN — CHOOSING THE RIGHT SIGNAL
${"═".repeat(63)}

BUILD: is for surgical single-file fixes.
  Use when: one root cause, one file, one specific code change, no dependency changes needed.
  The builder receives a tight constraint — only the target file, nothing else.

PLAN: is for coordinated multi-step fixes that cannot be reduced to one code change.
  Use when:
    - An external API has changed endpoint, auth, or payload format
    - Multiple routes must be rewritten together to work correctly
    - package.json dependencies must change alongside code changes
    - The fix genuinely requires touching more than one area of the same file in coordinated ways
    - A deprecated SDK, library, or integration must be replaced

  The PLAN: signal routes the fix through the full plan gate: the planner maps the
  complete scope, the user approves, the builder receives explicit permission for all
  files that need to change. This is the right tool for migrations.

BUILD: output format (one sentence, existing code → replacement code):
  BUILD: In server.js /api/refine-logo, add return before the anthropicClient.messages.create call on line 170.

PLAN: output format (one paragraph describing full migration scope):
  PLAN: server.js requires a full Stability AI v1-to-v2beta migration — the /api/generate-logo
  and /api/refine-logo routes use the deprecated v1 endpoint and JSON payload format; both routes
  must be rewritten to call the v2beta endpoint using multipart/form-data, and package.json
  must update the form-data dependency usage to match.

FORGE: is for bugs in ForgeOS infrastructure code (proxy, runner, workspace manager, builder).
  Use when: the error traces to a ForgeOS server file (server/index.js, server/workspace/manager.js,
  etc.) rather than to app code. Read the infrastructure file first with read_forge_source, then
  output FORGE: with the full diagnosis and what needs to change in which ForgeOS file.

FORGE: output format (full diagnosis + what ForgeOS file changes):
  FORGE: server/index.js preview proxy corrupts multipart bodies — the bodyBuffer path at line
  1308 serializes req.body as JSON for all requests including multipart/form-data; add a
  Content-Type check so multipart requests always pipe the raw stream instead.

Rules:
  - Output FORGE:, PLAN:, or BUILD: — never more than one.
  - FORGE: is only for ForgeOS infrastructure bugs, not app bugs.
  - Always use read_forge_source to confirm the bug before outputting FORGE:.
  - The PLAN: line is not subject to the two-sentence limit — describe the full scope.
  - The PLAN: line IS subject to all banned words (no "robust", "ensure", "comprehensive", etc.).
  - Never use PLAN: for single-line fixes. Do not escalate to avoid writing a precise BUILD: line.

${"═".repeat(63)}
BEHAVIORAL RULES
${"═".repeat(63)}

  - You are a builder. Find the bug. State the code change. Nothing else.
  - You have FULL SOURCE CODE and RUNTIME LOGS. Use them. Do not guess.
  - When the user reports anything broken: default to suggesting a build.
  - Every response that describes a problem without fixing it is a wasted iteration.
  - Every iteration that suggests logging instead of fixing the root cause is a failure.

LARGE BUILD DETECTION — proactive plan gate:
  When the user submits a prompt that describes a multi-route, multi-file, or
  multi-feature build (more than ~3 files, more than one major feature area, or
  a prompt longer than a short paragraph), do NOT attempt a direct BUILD:.
  Instead, output a PLAN: signal describing the full build scope.
  This prevents context overflow and gives the user visibility before the builder runs.

  Signs a prompt is too large for a direct build:
  - Describes multiple routes or endpoints (more than 3)
  - Describes multiple database tables or schemas
  - Describes both a frontend and a backend with significant complexity in each
  - Mentions admin vs user-facing interfaces as separate concerns
  - Prompt is longer than ~500 words
  - Prompt explicitly lists dependencies, schemas, and design direction

  When you detect a large build, respond with:
  "This is a large build covering [X, Y, Z]. Running it without a plan risks context
  overflow in the builder pipeline. I'll generate a plan for your approval first."
  Then output PLAN: with the full scope.

  NEVER attempt BUILD: on a large multi-feature prompt. Always escalate to PLAN:.

${"═".repeat(63)}
PLATFORM CONTEXT
${"═".repeat(63)}

  - Global Secrets Vault (Settings): secrets are auto-injected as env vars at runtime.
    Tell users to add API keys there — not in code, not in .env files.
    CRITICAL: When an app calls a third-party API (Stability AI, OpenAI, Stripe, ElevenLabs, etc.)
    and the call fails or returns an error, check the secrets vault FIRST by calling
    diagnose_system with checks: ["secrets"]. A missing API key is the most common root cause
    and will not appear in the code — only in the vault check.
  - Skills Library (Settings): curated instructions injected into build agents.
  - Default Env Vars (Settings): global env vars injected into all runtimes.
  - Web search and fetch_url are available for external APIs, libraries, and documentation.
    Do not search when the answer is in the source code you already have.
  - Health check results show whether the app responds to HTTP after startup.
  - diagnose_system tool is available — see DIAGNOSTIC PROCESS section above for when/how to use it.
  - read_forge_source tool is available — reads ForgeOS infrastructure files. Use when an error
    cannot be traced to app code. See FORGEOS INFRASTRUCTURE MAP below for which file owns what.

FORGEOS INFRASTRUCTURE MAP (for tracing proxy/runner/pipeline errors):
  server/index.js              — Express app, preview proxy (~line 1249), all API routes
  server/builder.js            — AI builder, generates file outputs from prompts
  server/pipeline/runner.js    — Build pipeline orchestrator, workspace lifecycle
  server/pipeline/model-router.js — Claude API calls, JSON schema validation, token budget
  server/workspace/manager.js  — Workspace process manager, port assignment, runtime logs
  server/chat/manager.js       — Chat Agent (this file)
  server/plan/manager.js       — Planner agent, constraint block generation, prompt truncation
  server/projects/manager.js   — Project CRUD, iteration tracking, captureCurrentFiles
  server/publish/manager.js    — Publish to GitHub branches and Render services
  server/settings/manager.js   — Global settings, secrets vault, skills library

CONTEXT OVERFLOW ERRORS — these patterns mean the builder's total token budget was exceeded.
The root cause is in server/builder.js (context assembly) or server/pipeline/model-router.js
(schema injection), NOT in the app code. Do NOT suggest fixing the app prompt.
  - "Failed to parse AI response as JSON" with a high position number (>10000)
  - "position NNNNN" parse error in the build output
  - Builder returns truncated or incomplete file output
  - Build fails on large/complex prompts but works on simple ones
  If you see these patterns, output FORGE: pointing to server/pipeline/model-router.js
  or server/builder.js — the fix involves reducing context size or moving schema instruction
  out of the system prompt.

${"═".repeat(63)}
SUB-AGENTS — invoke_agent TOOL
${"═".repeat(63)}

You have access to an invoke_agent tool that runs focused sub-agents for deep analysis.
Sub-agents are optional — use them only when the task genuinely exceeds what you can
do with the context you already have.

AGENT TYPES:
  file_analyst    — understands how 3+ files interact. Use when you need to map
                    imports, exports, data flow, and interfaces across multiple files
                    before diagnosing a multi-file bug or planning a change.

  failure_analyst — deep-diagnoses a build failure. Use when postBuildAnalysis
                    didn't fire or when the failure is genuinely ambiguous after
                    reading the iteration history and run data.

  fix_verifier    — verifies a proposed multi-file fix is internally consistent
                    before a build cycle is spent. Use for Canvas-scale or
                    multi-route changes. Never use for single-file fixes.

  spec_analyst    — breaks down a complex build prompt into ordered feature groups.
                    Use when a user submits a large prompt (Canvas, receptionist, etc.)
                    and the planner needs a structured decomposition before generating passes.

WHEN TO USE:
  ✓ 3+ files need to be understood together before diagnosing
  ✓ A build failure didn't match any known pattern and iteration history is ambiguous
  ✓ A multi-file fix needs consistency verification before running
  ✓ A large build prompt needs structural decomposition before planning

WHEN NOT TO USE:
  ✗ Single-file fixes — read the file yourself and use BUILD:
  ✗ Routine failures that match known patterns — postBuildAnalysis already handled it
  ✗ When the answer is already in your iteration history, source files, or logs
  ✗ As a delay tactic — if you already know the fix, state it

PROXY-LAYER ERRORS — these error patterns are caused by the ForgeOS preview proxy,
not by the app code. Do NOT suggest fixing the app's multipart or body-parsing code.
Instead, tell the user this is a ForgeOS infrastructure issue:
  - "Unexpected end of form" (busboy/multipart) when the app's multer code looks correct
  - "Premature close" or "socket hang up" on POST requests with file uploads
  - 500 errors on multipart routes that pass a JSON body check (e.g. plain JSON routes work,
    file upload routes always 500)
  If you see these patterns, say: "This is a ForgeOS proxy-layer issue — the preview proxy
  is corrupting the multipart stream before it reaches the app. The app code is correct.
  This requires a fix to the ForgeOS server, not this app."

${"═".repeat(63)}
RESPONSE FORMAT — HARD CONSTRAINT (overrides all other formatting impulses)
${"═".repeat(63)}

When the user reports a problem, your ENTIRE response is exactly TWO sentences:

  Sentence 1: State the root cause — file, route/function, exact broken code.
  Sentence 2: "I'll reforge [file] to [specific code change: what existing code is replaced with what]."

Do NOT start with "I found the bug" for cosmetic changes, feature tweaks, inspect-mode edits,
or any request that isn't a reported runtime error or crash. "I found the bug" is only
appropriate when something is genuinely broken. For everything else, lead with a plain
description of what's wrong or what's changing.

Nothing else. No third sentence. No explanation of what the fix achieves. No outcome predictions.

CORRECT (runtime error):
  "In server.js /api/voice-profile, client.messages.create is called without a timeout
   parameter so the request hangs indefinitely.
   I'll reforge server.js to pass { timeout: 10000 } to the Anthropic client.messages.create call
   and remove the Promise.race/timeoutPromise wrapper."

CORRECT (cosmetic / inspect):
  "The hero subtitle in index.html uses font-size 1.2rem but the design calls for 1rem.
   I'll reforge index.html to change the hero-sub font-size from 1.2rem to 1rem."

WRONG (everything after the pipe is the violation):
  "..." | + "This will prevent the request from hanging."
  "..." | + "This ensures the client receives a response."
  "..." | + "and also add error handling to the catch block."
  "..." | + ", and I'll also log the error for visibility."

${"═".repeat(63)}
BANNED — RESPONSE REJECTED IF ANY OF THESE APPEAR
${"═".repeat(63)}

BANNED WORDS:
  comprehensive, robust, proper, ensure, to prevent, to reveal,
  detailed logging, error handling and logging

BANNED PHRASES:
  "potential causes" / "possible causes" / "likely cause"
  "to fix:" / "try:" / "you could" / "you might"
  "verify that" / "make sure" / "consider"
  "ensure the endpoint" / "so the client does not"
  "I cannot see" / "I need you to provide" / "I don't have access"
  "what is your project ID" / "what is the project ID"
  You are chatting inside a project. The project ID, name, run ID, pipeline state,
  source code, and logs are all in your system context. Never ask the user for them.

BANNED FIXES — these are not fixes, they are admissions of failure:
  - "Add error handling" or "wrap in try-catch"
    try-catch does not fix broken code. It hides it.
    Find what the broken code is doing wrong. State the replacement.
  - "Add logging" or "add console.error"
    Logging does not fix bugs. Ever. Not even as a temporary step.
    If you cannot identify the root cause without adding logging,
    say so explicitly and ask the user to reproduce with the current logs.
  - "Implement proper X"
    Say exactly what. Not "proper timeout handling" but "pass { timeout: 10000 }".
  - Multiple fixes in one suggestion
    ONE root cause. ONE code change. If you write "and also" or "and add" — stop.
  - "Try rebuilding" / "try again" / "this is typically transient" / "retry usually resolves"
    These are not diagnoses. They are dismissals.
    If the root cause is known, state it and fix it.
    If the root cause is genuinely unknown, say "I don't know the root cause" and ask for more logs.
    Never tell the user to retry and hope it works.

BANNED FORMATS — no exceptions, no matter how long the conversation gets:
  - Bullet lists, numbered lists, dashes, or any list structure
  - Code blocks or file rewrites in the response
  - More than 2 sentences when reporting a bug

${"═".repeat(63)}
OUTPUT FORMAT
${"═".repeat(63)}

Plain text. Two sentences for bug reports (see RESPONSE FORMAT above).
For non-bug questions (setup, configuration, platform questions): answer directly
in plain prose. No JSON wrapper. No markdown formatting.

When a surgical single-file fix is warranted, append on a new line:
  BUILD: [your build suggestion — one sentence, file + route + what changes to what]

When a multi-step coordinated fix is warranted (API migrations, cross-file changes, dependency updates), append on a new line:
  PLAN: [one paragraph describing the full scope — files, what changes in each, APIs/endpoints changing]

When the bug is in ForgeOS infrastructure (proxy, runner, workspace manager, builder), append on a new line:
  FORGE: [one paragraph: which ForgeOS file, what the bug is, what the fix is]`;
const { neon } = require("@neondatabase/serverless");
const projectManager = require("../projects/manager");
const settingsManager = require("../settings/manager");
const { webSearch, fetchUrl } = require("./search");
const { callChat } = require("../pipeline/model-router");

const SEARCH_TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for current information, documentation, APIs, libraries, tutorials, or best practices. Use when the user asks about something you're not certain about, need current/verified information, or the question involves external services, APIs, or libraries.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query. Be specific and include relevant context (e.g. 'hCaptcha API integration Node.js' not just 'captcha')." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description: "Fetch the content of a specific URL to read documentation, API references, or other web pages. Use after web_search to get detailed information from a specific page.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The full URL to fetch (must start with http:// or https://)." },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "diagnose_system",
      description: "Run a system health check to diagnose why builds are failing. Call this FIRST when a user reports build failures, crashes, or errors. Checks: environment variables, API connectivity, model availability, pipeline run errors, workspace status, database connectivity, and Global Secrets Vault contents (which API keys are configured). ALWAYS include 'secrets' in checks when an app uses a third-party API (Stability AI, OpenAI, Stripe, etc.) — a missing secret is the most common cause of API errors.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Optional project ID to include project-specific diagnostics (pipeline run errors, workspace logs)." },
          checks: {
            type: "array",
            items: { type: "string", enum: ["env", "api", "models", "pipeline", "workspace", "db", "secrets", "all"] },
            description: "Which checks to run. Use 'all' for a full system diagnostic including secrets vault. Defaults to 'all'.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "hubspot_query",
      description: "Query HubSpot CRM data. Use to look up contacts, deals, or check HubSpot connection status. Only available when HUBSPOT_ACCESS_TOKEN is set in the Global Secrets Vault.",
      parameters: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: ["status", "search_contacts", "search_deals"],
            description: "Operation to perform: status (check connection), search_contacts (find contacts by name/email), search_deals (find deals by name).",
          },
          query: {
            type: "string",
            description: "Search query for search_contacts or search_deals operations.",
          },
        },
        required: ["operation"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_forge_source",
      description: "Read a ForgeOS infrastructure source file by relative path (e.g. 'server/index.js', 'server/workspace/manager.js'). Use this when an app error cannot be explained by the app code alone and may be caused by the ForgeOS proxy, workspace runner, or pipeline. Always check the FORGEOS INFRASTRUCTURE MAP in your context to know which file to read. Returns file contents. Read-only — do not suggest changes to ForgeOS files via BUILD:, only via FORGE:.",
      parameters: {
        type: "object",
        properties: {
          filepath: {
            type: "string",
            description: "Relative path from ForgeOS root, e.g. 'server/index.js' or 'server/workspace/manager.js'",
          },
        },
        required: ["filepath"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "invoke_agent",
      description: `Invoke a focused sub-agent for tasks requiring deeper analysis than your context supports.

WHEN TO USE — only when genuinely needed:
  file_analyst: understand how 3+ files interact before diagnosing or planning. Use when relationships between files are unclear.
  failure_analyst: deep-diagnose a build failure when postBuildAnalysis didn't match a known pattern and the failure is genuinely ambiguous.
  fix_verifier: verify a complex multi-file fix is internally consistent before spending a build cycle. Use for Canvas-scale changes, not single-file fixes.
  spec_analyst: break down a large complex build prompt before planning. Use for prompts describing 5+ features or multiple interconnected systems.

WHEN NOT TO USE:
  - Simple single-file fixes (use BUILD: directly)
  - Routine diagnostics (use diagnose_system)
  - When the answer is already in your context
  - As a substitute for reading files you already have

Sub-agents add ~2-3 seconds. Use selectively.`,
      parameters: {
        type: "object",
        properties: {
          agent_type: {
            type: "string",
            enum: ["file_analyst", "failure_analyst", "fix_verifier", "spec_analyst"],
            description: "The sub-agent to invoke.",
          },
          context: {
            type: "string",
            description: "Everything the agent needs — file contents, run data, error messages, or build prompt.",
          },
          question: {
            type: "string",
            description: "Optional question for file_analyst or fix_verifier. Leave empty for failure_analyst and spec_analyst.",
          },
        },
        required: ["agent_type", "context"],
      },
    },
  },
];

const dbUrl = process.env.NEON_DATABASE_URL;
const sql = dbUrl ? neon(dbUrl) : null;

const chatHistory = new Map();

async function ensureSchema() {
  if (!sql) return;
  try {
    await sql`CREATE TABLE IF NOT EXISTS chat_messages (
      id SERIAL PRIMARY KEY,
      project_id VARCHAR(8) NOT NULL,
      role VARCHAR(20) NOT NULL,
      content TEXT NOT NULL,
      suggest_build BOOLEAN DEFAULT false,
      build_suggestion TEXT,
      suggest_plan BOOLEAN DEFAULT false,
      plan_suggestion TEXT,
      created_at BIGINT NOT NULL
    )`;
    await sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS suggest_plan BOOLEAN DEFAULT false`;
    await sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS plan_suggestion TEXT`;
    await sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS suggest_forge BOOLEAN DEFAULT false`;
    await sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS forge_suggestion TEXT`;
  } catch (err) {
    console.error("Failed to create chat_messages table:", err.message);
  }
}

let schemaReady = false;

async function getHistory(projectId) {
  if (!schemaReady) {
    await ensureSchema();
    schemaReady = true;
  }

  if (chatHistory.has(projectId)) {
    return chatHistory.get(projectId);
  }

  const messages = [];
  if (sql) {
    try {
      const rows = await sql`SELECT role, content, suggest_build, build_suggestion, suggest_plan, plan_suggestion, suggest_forge, forge_suggestion, created_at FROM chat_messages WHERE project_id = ${projectId} ORDER BY created_at ASC`;
      for (const row of rows) {
        messages.push({
          role: row.role,
          content: row.content,
          suggestBuild: row.suggest_build || false,
          buildSuggestion: row.build_suggestion || null,
          suggestPlan: row.suggest_plan || false,
          planSuggestion: row.plan_suggestion || null,
          suggestForge: row.suggest_forge || false,
          forgeSuggestion: row.forge_suggestion || null,
          createdAt: Number(row.created_at),
        });
      }
    } catch (err) {
      console.error("Failed to load chat history:", err.message);
    }
  }

  chatHistory.set(projectId, messages);
  return messages;
}

async function saveMessage(projectId, msg) {
  const history = await getHistory(projectId);
  history.push(msg);

  if (sql) {
    try {
      await sql`INSERT INTO chat_messages (project_id, role, content, suggest_build, build_suggestion, suggest_plan, plan_suggestion, suggest_forge, forge_suggestion, created_at)
        VALUES (${projectId}, ${msg.role}, ${msg.content}, ${msg.suggestBuild || false}, ${msg.buildSuggestion || null}, ${msg.suggestPlan || false}, ${msg.planSuggestion || null}, ${msg.suggestForge || false}, ${msg.forgeSuggestion || null}, ${msg.createdAt})`;
    } catch (err) {
      console.error("Failed to save chat message:", err.message);
    }
  }
}

async function clearBuildSuggestions(projectId) {
  const history = await getHistory(projectId);
  for (const msg of history) {
    if (msg.suggestBuild) {
      msg.suggestBuild = false;
    }
  }

  if (sql) {
    try {
      await sql`UPDATE chat_messages SET suggest_build = false, suggest_plan = false, suggest_forge = false, forge_suggestion = null WHERE project_id = ${projectId} AND (suggest_build = true OR suggest_plan = true OR suggest_forge = true)`;
    } catch (err) {
      console.error("Failed to clear build suggestions:", err.message);
    }
  }
}

async function executeToolCall(toolCall) {
  try {
    const name = toolCall.function.name;
    let args;
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      return JSON.stringify({ error: "Invalid tool arguments" });
    }

    if (name === "web_search") {
      const query = args.query || "";
      console.log(`  [chat] web_search: "${query}"`);
      const result = await webSearch(query);
      return JSON.stringify(result);
    } else if (name === "fetch_url") {
      const url = args.url || "";
      console.log(`  [chat] fetch_url: ${url}`);
      const result = await fetchUrl(url);
      return JSON.stringify(result);
    } else if (name === "diagnose_system") {
      console.log(`  [chat] diagnose_system`);
      const result = await runDiagnostics(args.project_id, args.checks);
      return JSON.stringify(result);
    } else if (name === "hubspot_query") {
      const hubspot = require("../integrations/hubspot");
      const operation = args.operation || "status";
      console.log(`  [chat] hubspot_query: ${operation}`);
      if (operation === "status") {
        const result = await hubspot.getStatus();
        return JSON.stringify(result);
      } else if (operation === "search_contacts") {
        const result = await hubspot.searchContacts(args.query || "");
        return JSON.stringify(result);
      } else if (operation === "search_deals") {
        const result = await hubspot.searchDeals(args.query || "");
        return JSON.stringify(result);
      }
      return JSON.stringify({ error: "Unknown hubspot operation" });
    } else if (name === "read_forge_source") {
      const forgeRepair = require("../forge-repair/manager");
      const filepath = args.filepath || "";
      console.log(`  [chat] read_forge_source: ${filepath}`);
      try {
        const content = forgeRepair.readForgeFile(filepath);
        return JSON.stringify({ filepath, content });
      } catch (err) {
        return JSON.stringify({ error: `Cannot read ${filepath}: ${err.message}` });
      }
    } else if (name === "invoke_agent") {
      const agentType = args.agent_type || "";
      const context = args.context || "";
      const question = args.question || null;
      console.log(`  [chat] invoke_agent: ${agentType}`);
      try {
        const agents = require("../agents/manager");
        const result = await agents.runSubAgent(agentType, context, question);
        return JSON.stringify(result);
      } catch (err) {
        return JSON.stringify({ error: `Sub-agent ${agentType} failed: ${err.message}` });
      }
    }
    return JSON.stringify({ error: "Unknown tool" });
  } catch (err) {
    return JSON.stringify({ error: `Tool execution failed: ${err.message}` });
  }
}

const VALID_CHECKS = new Set(["env", "api", "models", "pipeline", "workspace", "db", "secrets", "all"]);

async function runDiagnostics(projectId, checks) {
  const filtered = (checks && checks.length ? checks : ["all"]).filter(c => VALID_CHECKS.has(c));
  if (filtered.length === 0) filtered.push("all");
  const wantedChecks = new Set(filtered);
  const all = wantedChecks.has("all");
  const report = { timestamp: new Date().toISOString(), checks: {} };

  if (all || wantedChecks.has("env")) {
    const envReport = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ? "SET" : "MISSING",
      NEON_DATABASE_URL: process.env.NEON_DATABASE_URL ? "SET" : "MISSING",
      ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY ? "SET" : "MISSING",
      GITHUB_TOKEN: process.env.GITHUB_TOKEN ? "SET" : "MISSING",
      NODE_ENV: process.env.NODE_ENV || "not set",
    };
    const missing = Object.entries(envReport).filter(([, v]) => v === "MISSING").map(([k]) => k);
    envReport.status = missing.length > 0 ? "FAIL" : "OK";
    envReport.missing = missing;
    if (missing.includes("ANTHROPIC_API_KEY")) {
      envReport.impact = "CRITICAL — all AI pipeline stages will fail immediately. The ANTHROPIC_API_KEY environment variable must be set on the deployment platform (e.g. Render dashboard > Environment).";
    }
    report.checks.env = envReport;
  }

  if (all || wantedChecks.has("api")) {
    const apiReport = {};
    try {
      const Anthropic = require("@anthropic-ai/sdk");
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        apiReport.status = "FAIL";
        apiReport.error = "ANTHROPIC_API_KEY not set — cannot test API connectivity";
      } else {
        const client = new Anthropic({ apiKey });
        const r = await client.messages.create({ model: "claude-haiku-4-5-20251001", max_tokens: 5, messages: [{ role: "user", content: "say ok" }] });
        apiReport.status = "OK";
        apiReport.model_used = r.model;
        apiReport.response = r.content?.[0]?.text;
      }
    } catch (err) {
      apiReport.status = "FAIL";
      apiReport.error = err.message?.substring(0, 300);
      if (err.status === 401) apiReport.impact = "API key is invalid or expired";
      if (err.status === 404) apiReport.impact = "Model not found — check model names in settings";
    }
    report.checks.api = apiReport;
  }

  if (all || wantedChecks.has("models")) {
    try {
      const config = await settingsManager.getSetting("model_config");
      report.checks.models = {
        status: "OK",
        plannerModel: config?.plannerModel || "claude-sonnet-4-6",
        reviewerModel: config?.reviewerModel || "claude-haiku-4-5-20251001",
        chatModel: config?.chatModel || "claude-haiku-4-5-20251001",
      };
    } catch (err) {
      report.checks.models = { status: "FAIL", error: err.message };
    }
  }

  if (all || wantedChecks.has("db")) {
    try {
      if (!sql) {
        report.checks.db = { status: "FAIL", error: "No NEON_DATABASE_URL configured" };
      } else {
        const rows = await sql`SELECT COUNT(*) as count FROM projects`;
        report.checks.db = { status: "OK", projectCount: Number(rows[0].count) };
      }
    } catch (err) {
      report.checks.db = { status: "FAIL", error: err.message?.substring(0, 200) };
    }
  }

  if ((all || wantedChecks.has("pipeline")) && projectId) {
    try {
      const runner = require("../pipeline/runner");
      const project = await projectManager.getProject(projectId);
      if (project && project.currentRunId) {
        const run = await runner.getRun(project.currentRunId);
        if (run) {
          const stagesSummary = {};
          if (run.stages) {
            for (const [k, v] of Object.entries(run.stages)) {
              stagesSummary[k] = v.status;
              if (v.status === "failed" && v.output) {
                const errStr = typeof v.output === "string" ? v.output : JSON.stringify(v.output);
                stagesSummary[k + "_error"] = errStr.substring(0, 500);
              }
            }
          }
          report.checks.pipeline = {
            status: run.status === "failed" ? "FAIL" : "OK",
            runStatus: run.status,
            runError: run.error?.substring(0, 500) || null,
            currentStage: run.currentStage,
            stages: stagesSummary,
          };
        } else {
          report.checks.pipeline = { status: "WARN", reason: "Run ID exists but run data not found (may have been evicted from memory)" };
        }
      } else {
        report.checks.pipeline = { status: "N/A", reason: "No current run for this project" };
      }
    } catch (err) {
      report.checks.pipeline = { status: "FAIL", error: err.message?.substring(0, 200) };
    }
  } else if ((all || wantedChecks.has("pipeline")) && !projectId) {
    report.checks.pipeline = { status: "N/A", reason: "No project_id provided — pass project_id for pipeline diagnostics" };
  }

  if ((all || wantedChecks.has("workspace")) && projectId) {
    try {
      const workspace = require("../workspace/manager");
      const project = await projectManager.getProject(projectId);
      if (project && project.currentRunId) {
        const wsStatus = workspace.getWorkspaceStatus(project.currentRunId);
        const wsLogs = workspace.getWorkspaceLogs(project.currentRunId, { limit: 20, level: "error" });
        report.checks.workspace = {
          status: wsStatus?.status || "unknown",
          port: wsStatus?.port || null,
          error: wsStatus?.error?.substring(0, 300) || null,
          recentErrors: (wsLogs?.entries || []).map(e => e.message.substring(0, 200)).slice(-5),
        };
      } else {
        report.checks.workspace = { status: "N/A", reason: "No workspace for this project" };
      }
    } catch (err) {
      report.checks.workspace = { status: "FAIL", error: err.message?.substring(0, 200) };
    }
  } else if ((all || wantedChecks.has("workspace")) && !projectId) {
    report.checks.workspace = { status: "N/A", reason: "No project_id provided — pass project_id for workspace diagnostics" };
  }

  if (all || wantedChecks.has("secrets")) {
    try {
      const secretKeys = await settingsManager.getAllSecretKeys();
      report.checks.secrets = {
        status: "OK",
        configuredKeys: secretKeys,
        count: secretKeys.length,
        note: secretKeys.length === 0
          ? "No secrets configured in Global Secrets Vault. If this project needs API keys (e.g. STABILITYAI_API_KEY, OPENAI_API_KEY), add them in Settings → Global Secrets Vault."
          : `These keys are available as env vars in all project workspaces: ${secretKeys.join(", ")}`,
      };
    } catch (err) {
      report.checks.secrets = { status: "FAIL", error: err.message?.substring(0, 200) };
    }
  }

  const failures = Object.entries(report.checks).filter(([, v]) => v.status === "FAIL");
  report.summary = failures.length === 0
    ? "All checks passed"
    : `${failures.length} check(s) failed: ${failures.map(([k]) => k).join(", ")}`;

  return report;
}

// ── Known failure pattern classifier ────────────────────────────────────────
// Maps error signatures to instant diagnoses without requiring a Claude call.
// Each entry: { test(run) => bool, signal, diagnosis, suggestion }
const KNOWN_FAILURE_PATTERNS = [
  {
    id: "context_overflow",
    test: (run) => {
      const err = (run.error || "") + JSON.stringify(run.stages || {});
      return /position \d{4,}|unterminated string|json parse.*position|failed to parse ai response/i.test(err);
    },
    signal: "FORGE",
    diagnosis: (run) => {
      const posMatch = (run.error || "").match(/position (\d+)/i);
      const pos = posMatch ? ` at position ${posMatch[1]}` : "";
      return `Builder JSON output was truncated${pos} — the total token input (system prompt + context + prompt) exceeded Claude's output budget. Root cause: server/builder.js context assembly is too large for this prompt. Fix: reduce pass scope or cap context further in buildWorkspaceMultiPass.`;
    },
    forge: "server/builder.js buildWorkspaceMultiPass assembles too much context per pass — the passPrompt, accumulated files, and system prompt together exceed the output token budget, truncating JSON at high position numbers. Reduce promptSummary cap from 600 to 300 chars and filter accumulated files more aggressively to only files with direct import relationships.",
  },
  {
    id: "missing_api_key",
    test: (run) => {
      const err = (run.error || "") + JSON.stringify(run.stages || {});
      return /api.?key|authentication|401|not configured|missing.*key/i.test(err);
    },
    signal: "PLAIN",
    diagnosis: () => "Build failed due to a missing or invalid API key. Check the Global Secrets Vault in Settings — the required key is not configured or has expired.",
  },
  {
    id: "json_schema_validation",
    test: (run) => {
      const err = (run.error || "") + JSON.stringify(run.stages || {});
      return /zod|schema.*validation|invalid.*schema|parse.*schema/i.test(err);
    },
    signal: "FORGE",
    diagnosis: () => "Builder output failed Zod schema validation — the AI response had the right structure but a field value didn't match the expected type. Root cause: server/pipeline/model-router.js schema validation is too strict or the builder prompt produced a field in the wrong format.",
    forge: "server/pipeline/model-router.js schema.parse(parsed) throws when a field value doesn't match the Zod schema — add .passthrough() or loosen the field type to accept both string and null for optional fields that the builder may omit.",
  },
  {
    id: "start_failed",
    test: (run) => run.workspace?.status === "start-failed",
    signal: "BUILD",
    diagnosis: (run) => {
      const err = run.workspace?.error || "unknown error";
      return `App failed to start after build — ${err}. The builder produced files but the start command crashed. Check for missing dependencies in package.json, a wrong start command, or a syntax error in server.js.`;
    },
  },
  {
    id: "install_failed",
    test: (run) => run.workspace?.status === "install-failed",
    signal: "PLAIN",
    diagnosis: (run) => {
      const err = run.workspace?.error || "unknown error";
      return `Dependency install failed — ${err}. The builder's package.json may reference a non-existent package version, a banned module, or have a syntax error.`;
    },
  },
  {
    id: "build_failed_generic",
    test: (run) => run.status === "failed" && run.stages?.builder?.status === "failed",
    signal: "PLAIN",
    diagnosis: (run) => {
      const err = run.stages?.builder?.error || run.error || "unknown error";
      return `Builder stage failed: ${err.slice(0, 300)}`;
    },
  },
];

// Classify a failed run against known patterns. Returns the first match or null.
function classifyRunFailure(run) {
  for (const pattern of KNOWN_FAILURE_PATTERNS) {
    if (pattern.test(run)) return pattern;
  }
  return null;
}

// Auto-analysis fired after every failed build. Saves a diagnosis as an assistant
// message so the user sees it immediately without asking. Does not require user input.
async function postBuildAnalysis(projectId, run) {
  try {
    if (!projectId) return;
    if (!run || run.status !== "failed") return;

    const pattern = classifyRunFailure(run);

    let message, suggestForge, forgeSuggestion, suggestBuild, buildSuggestion;

    if (pattern) {
      // Pattern-matched — instant diagnosis, no Claude call needed
      message = `[AUTO-ANALYSIS] ${typeof pattern.diagnosis === "function" ? pattern.diagnosis(run) : pattern.diagnosis}`;

      if (pattern.signal === "FORGE" && pattern.forge) {
        suggestForge = true;
        forgeSuggestion = pattern.forge;
      } else if (pattern.signal === "BUILD" && pattern.build) {
        suggestBuild = true;
        buildSuggestion = pattern.build;
      }
    } else {
      // No pattern match — call Claude with tight diagnostic context for analysis
      const runError = run.error || "";
      const stageErrors = Object.entries(run.stages || {})
        .filter(([, v]) => v.status === "failed")
        .map(([k, v]) => `${k}: ${(v.error || v.output || "").toString().slice(0, 200)}`)
        .join("\n");
      const wsError = run.workspace?.error || "";

      const diagPrompt = `A ForgeOS build just failed. Diagnose it and output the appropriate signal.

Run status: ${run.status}
Workspace status: ${run.workspace?.status || "unknown"}
Run error: ${runError.slice(0, 400)}
Stage errors:
${stageErrors.slice(0, 600)}
Workspace error: ${wsError.slice(0, 200)}

Output your diagnosis in two sentences followed by the appropriate signal (FORGE:, BUILD:, or PLAN:).
Prefix your message with [AUTO-ANALYSIS].`;

      const result = await callChat(
        "claude-haiku-4-5-20251001",
        CHAT_AGENT_INSTRUCTIONS,
        [{ role: "user", content: diagPrompt }],
        null,
        0.2,
      );

      const parsed = parseResponse(result.content || "");
      message = parsed.message || "[AUTO-ANALYSIS] Build failed — check the iteration history for details.";
      suggestForge = parsed.suggestForge;
      forgeSuggestion = parsed.forgeSuggestion;
      suggestBuild = parsed.suggestBuild;
      buildSuggestion = parsed.buildSuggestion;
    }

    const assistantMsg = {
      role: "assistant",
      content: message,
      suggestBuild: suggestBuild || false,
      buildSuggestion: buildSuggestion || null,
      suggestPlan: false,
      planSuggestion: null,
      suggestForge: suggestForge || false,
      forgeSuggestion: forgeSuggestion || null,
      createdAt: Date.now(),
    };

    await saveMessage(projectId, assistantMsg);
    console.log(`[chat] Post-build analysis saved for project ${projectId}: ${pattern?.id || "claude-analysis"}`);
  } catch (err) {
    console.error("[chat] postBuildAnalysis failed (non-fatal):", err.message);
  }
}

function parseResponse(content) {
  let message = content;
  let suggestBuild = false;
  let buildSuggestion = null;
  let suggestPlan = false;
  let planSuggestion = null;
  let suggestForge = false;
  let forgeSuggestion = null;

  const forgeMatch = content.match(/^FORGE:\s*([\s\S]+)$/m);
  const planMatch = content.match(/^PLAN:\s*(.+)$/m);
  const buildMatch = content.match(/^BUILD:\s*(.+)$/m);

  if (forgeMatch) {
    forgeSuggestion = forgeMatch[1].trim();
    suggestForge = true;
    message = content.substring(0, forgeMatch.index).trim();
  } else if (planMatch) {
    planSuggestion = planMatch[1].trim();
    suggestPlan = true;
    message = content.substring(0, planMatch.index).trim();
  } else if (buildMatch) {
    buildSuggestion = buildMatch[1].trim();
    suggestBuild = true;
    message = content.substring(0, buildMatch.index).trim();
  }

  if (!suggestBuild && !suggestPlan && !suggestForge) {
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed.message === "string") {
        return {
          message: parsed.message,
          suggestBuild: !!parsed.suggestBuild,
          buildSuggestion: parsed.buildSuggestion || null,
          suggestPlan: false,
          planSuggestion: null,
          suggestForge: false,
          forgeSuggestion: null,
        };
      }
    } catch { /* not JSON — use plain text path */ }
  }

  return { message, suggestBuild, buildSuggestion, suggestPlan, planSuggestion, suggestForge, forgeSuggestion };
}

const BANNED_PATTERNS = [
  { regex: /\bcomprehensive\b/i, rule: "Banned word: 'comprehensive'" },
  { regex: /\brobust\b/i, rule: "Banned word: 'robust'" },
  { regex: /\bproper\b/i, rule: "Banned word: 'proper'" },
  { regex: /\bensure\b/i, rule: "Banned word: 'ensure'" },
  { regex: /\badd\s+(detailed\s+)?logging\b/i, rule: "Banned fix: 'add logging' is not a bug fix" },
  { regex: /\badd\s+(detailed\s+)?console\.error\b/i, rule: "Banned fix: 'add console.error' is not a bug fix" },
  { regex: /\badd\s+(better\s+)?error\s+handling\b/i, rule: "Banned fix: 'add error handling' is not a bug fix" },
  { regex: /\bwrap\s+.*\s+in\s+try[- ]?catch\b/i, rule: "Banned fix: 'wrap in try-catch' is not a bug fix" },
  { regex: /\bto\s+prevent\s+/i, rule: "Banned padding: 'to prevent...' — stop after stating the code change" },
  { regex: /\bto\s+reveal\s+/i, rule: "Banned padding: 'to reveal...' — stop after stating the code change" },
  { regex: /\bto\s+ensure\s+/i, rule: "Banned padding: 'to ensure...' — stop after stating the code change" },
  { regex: /\bensuring\s+(the|that)\b/i, rule: "Banned padding: 'ensuring the/that...' — stop after stating the code change" },
  { regex: /\bso\s+the\s+(client|endpoint|server|request|response)\s+(does\s+not|doesn't|won't|will\s+not)\b/i, rule: "Banned padding: 'so the X does not...' — stop after stating the code change" },
  { regex: /\bpreventing\s+(the|it|hanging|errors)\b/i, rule: "Banned padding: 'preventing...' — stop after stating the code change" },
  { regex: /\bwithout\s+(a\s+)?(proper|hanging|crashing)\b/i, rule: "Banned padding: 'without hanging/crashing...' — stop after stating the code change" },
  { regex: /\bpotential\s+causes?\b/i, rule: "Banned phrase: 'potential cause(s)'" },
  { regex: /\bpossible\s+causes?\b/i, rule: "Banned phrase: 'possible cause(s)'" },
  { regex: /\blikely\s+cause\b/i, rule: "Banned phrase: 'likely cause'" },
  { regex: /\berror\s+handling\s+and\s+logging\b/i, rule: "Banned phrase: 'error handling and logging'" },
  { regex: /\bor\s+(switch|change|use|try|replace|fall\s*back)\b/i, rule: "Banned hedging: 'or switch/change/use...' — pick ONE fix, do not offer alternatives" },
  { regex: /\b(like|such\s+as)\s+'[^']+'/i, rule: "Banned hedging: 'like X' or 'such as X' — name the exact value, not an example" },
  { regex: /\b(a\s+valid|a\s+supported|a\s+correct)\s+(model|endpoint|version|package)\b/i, rule: "Banned vagueness: 'a valid model' — name the exact model" },
  { regex: /\band\s+(also|additionally)\b/i, rule: "Banned bundling: 'and also/additionally' — ONE fix only" },
  { regex: /\b(instead\s+of\s+hanging|instead\s+of\s+crashing|instead\s+of\s+failing)\b/i, rule: "Banned padding: 'instead of hanging/crashing...' — stop after stating the code change" },
  { regex: /\bto\s+properly\s+/i, rule: "Banned padding: 'to properly...' — stop after stating the code change" },
  { regex: /\band\s+allow\s+(the|it)\b/i, rule: "Banned padding: 'and allow the/it...' — stop after stating the code change" },
  { regex: /\bto\s+allow\s+(the|it)\b/i, rule: "Banned padding: 'to allow the/it...' — stop after stating the code change" },
  { regex: /\band\s+(respond|complete|finish|return)\b/i, rule: "Banned padding: 'and respond/complete...' — stop after stating the code change" },
  { regex: /\bcausing\s+(the\s+)?(request|endpoint|server|app|application)\s+to\s+(hang|crash|fail)\b/i, rule: "Banned diagnosis padding: 'causing the request to hang' — the user already told you it hangs, state the code fix" },
  { regex: /\btry\s+(rebuilding|again|rerunning|re-running|restarting)\b/i, rule: "Banned dismissal: 'try rebuilding/again' is not a diagnosis — state the root cause or say you don't know" },
  { regex: /\b(this\s+is\s+)?(typically|usually|often)\s+transient\b/i, rule: "Banned dismissal: 'typically transient' is not a diagnosis — state the root cause or say you don't know" },
  { regex: /\bretry\s+(usually|often|typically|generally)\s+(resolves?|fixes?|works?)\b/i, rule: "Banned dismissal: 'retry usually resolves' is not a diagnosis — state the root cause or say you don't know" },
  { regex: /\bI\s+(cannot|can't|don't)\s+(see|have\s+access|have\s+visibility)\b/i, rule: "Banned ignorance claim: you have diagnostics, iteration history, source code, and runtime logs in your context — read them" },
  { regex: /\bI\s+need\s+you\s+to\s+provide\b/i, rule: "Banned info request: the information is in your context (diagnostics, logs, source code) — read it instead of asking" },
  { regex: /\bwhat\s+is\s+(your|the)\s+project\s*id\b/i, rule: "Banned question: the project ID is in your system context — you already have it" },
];

function detectBannedPatterns(message, buildSuggestion) {
  const violations = [];
  const textsToCheck = [message || "", buildSuggestion || ""];
  const combined = textsToCheck.join(" ");

  for (const { regex, rule } of BANNED_PATTERNS) {
    if (regex.test(combined)) {
      violations.push(`- ${rule}`);
    }
  }

  return violations;
}

async function chat(projectId, userMessage) {
  const project = await projectManager.getProject(projectId);
  if (!project) throw new Error("Project not found");

  const history = await getHistory(projectId);

  const now = Date.now();
  const userMsg = { role: "user", content: userMessage, suggestBuild: false, buildSuggestion: null, createdAt: now };
  await saveMessage(projectId, userMsg);

  // Repeat-prompt detection — if the user is sending a very similar message to their last one,
  // the previous build likely didn't satisfy the request. Log this as a logical failure to Brain.
  try {
    const recentHistory = await getHistory(projectId);
    const lastUserMsg = recentHistory.filter(m => m.role === "user").slice(-2, -1)[0];
    if (lastUserMsg && lastUserMsg.content) {
      const prev = lastUserMsg.content.toLowerCase().trim().slice(0, 80);
      const curr = userMessage.toLowerCase().trim().slice(0, 80);
      // Simple overlap check — if 60%+ of words match, flag as a repeat
      const prevWords = new Set(prev.split(/\s+/));
      const currWords = curr.split(/\s+/);
      const overlap = currWords.filter(w => prevWords.has(w)).length / Math.max(currWords.length, 1);
      if (overlap > 0.6 && currWords.length > 4) {
        const lesson = "User repeated a nearly identical prompt, suggesting the previous build did not address the request: \"" + userMessage.slice(0, 120) + "\". Builder must read existing files carefully and address the exact stated change.";
        brain.recordMistake(lesson, "repeat-prompt", projectId).catch(() => {});
      }
    }
  } catch {}

  const lastRunId = project.currentRunId;
  const existingFiles = lastRunId ? projectManager.captureCurrentFiles(lastRunId) : [];

  let codeContext = "";
  if (existingFiles.length > 0) {
    codeContext = "\n\nCURRENT PROJECT FILES:\n" + existingFiles.map(f => `--- ${f.path} ---\n${f.content}`).join("\n\n");
  }

  let logsContext = "";
  if (lastRunId) {
    try {
      const workspace = require("../workspace/manager");
      const logData = workspace.getWorkspaceLogs(lastRunId, { maxEntries: 50 });
      if (logData) {
        const appLog = (logData.app || "").trim();
        const recentEntries = (logData.entries || []).map(e => `[${e.level}] ${e.message}`).join("\n");
        if (appLog || recentEntries) {
          logsContext = "\n\nRUNTIME LOGS (last 50 entries from running app):\n";
          if (appLog) logsContext += "--- stdout/stderr ---\n" + appLog.slice(-3000) + "\n";
          if (recentEntries) logsContext += "--- structured logs ---\n" + recentEntries.slice(-3000) + "\n";
        }
      }
    } catch {}
  }

  let iterHistoryContext = "";
  if (sql) {
    try {
      const rows = await sql`
        SELECT i.iteration_number, i.prompt, rs.data
        FROM iterations i
        LEFT JOIN run_snapshots rs ON rs.id = i.run_id
        WHERE i.project_id = ${projectId}
        ORDER BY i.iteration_number ASC
      `;
      if (rows.length > 0) {
        const lines = [];
        for (let ri = 0; ri < rows.length; ri++) {
          const row = rows[ri];
          const num = row.iteration_number;
          const prompt = (row.prompt || "").slice(0, 100);
          const data = row.data;
          if (!data) { lines.push(`- Iter ${num}: "${prompt}" → no data`); continue; }
          const status = data.status || "unknown";
          const wsStatus = data.workspace?.status || "unknown";
          const wsError = data.workspace?.error ? ` error: ${data.workspace.error.slice(0, 150)}` : "";
          const runError = data.error ? ` pipeline_error: ${data.error.slice(0, 300)}` : "";
          let stageErrors = "";
          if (data.stages) {
            for (const [stageName, stageData] of Object.entries(data.stages)) {
              if (stageData.status === "failed") {
                const errDetail = stageData.output ? (typeof stageData.output === "string" ? stageData.output : JSON.stringify(stageData.output)).slice(0, 200) : "";
                stageErrors += ` [${stageName} FAILED${errDetail ? ": " + errDetail : ""}]`;
              }
            }
          }
          const hc = data.healthCheck;
          let healthNote = "";
          if (hc) {
            healthNote = hc.healthy ? ` health:OK` : ` health:FAILED(${hc.httpStatus || "no-response"})`;
            if (hc.startupLogs) healthNote += ` logs: ${hc.startupLogs.slice(0, 150)}`;
          }
          lines.push(`- Iter ${num}: "${prompt}" → ${status}, ws:${wsStatus}${wsError}${runError}${stageErrors}${healthNote}`);

          const isLatest = ri === rows.length - 1;
          if (isLatest && data.stages) {
            const stageOrder = ["planner", "reviewer_p1", "revise_p2", "reviewer_p2", "revise_p3", "reviewer_p3", "policy_gate", "executor", "auditor"];
            for (const sn of stageOrder) {
              const sd = data.stages[sn];
              if (!sd) continue;
              if (sd.parseError) {
                lines.push(`\n  --- LATEST RUN: ${sn} (PARSE FAILED) ---`);
                lines.push(`  Parse Error: ${sd.parseError}`);
                if (sd.parseErrorSnippet) lines.push(`  Error Snippet (around failure position): ${sd.parseErrorSnippet}`);
                if (sd.rawOutput) {
                  const raw = sd.rawOutput.length > 3000 ? sd.rawOutput.slice(0, 3000) + "\n... [truncated]" : sd.rawOutput;
                  lines.push(`  Raw Model Output:\n${raw}`);
                }
                continue;
              }
              if (!sd.output) continue;
              const outputStr = typeof sd.output === "string" ? sd.output : JSON.stringify(sd.output, null, 2);
              const truncated = outputStr.length > 3000 ? outputStr.slice(0, 3000) + "\n... [truncated]" : outputStr;
              lines.push(`\n  --- LATEST RUN: ${sn} (${sd.status}) ---\n${truncated}`);
              if (sd.rawOutput && sd.status === "failed") {
                const raw = sd.rawOutput.length > 2000 ? sd.rawOutput.slice(0, 2000) + "\n... [truncated]" : sd.rawOutput;
                lines.push(`  Raw Model Output:\n${raw}`);
              }
            }
          }
        }
        iterHistoryContext = `\n\nITERATION HISTORY (${rows.length} builds for this project):\n${lines.join("\n")}\n`;
      }
    } catch {}
  }

  let skillContext = "";
  const slashRefs = userMessage.match(/\/([a-z0-9-]+)/gi);
  if (slashRefs && slashRefs.length > 0) {
    const allSkills = await settingsManager.getAllSkills();
    for (const ref of slashRefs) {
      const slug = ref.slice(1).toLowerCase();
      const matched = allSkills.find(s => {
        const sSlug = s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
        return sSlug === slug;
      });
      if (matched) {
        skillContext += `\n\n--- SKILL: ${matched.name} ---\n${matched.instructions}`;
      }
    }
  }

  let diagnosticsContext = "";
  try {
    const diagReport = await runDiagnostics(projectId, ["env", "models", "pipeline", "workspace"]);
    const parts = [];
    if (diagReport.checks.env?.status === "FAIL") {
      parts.push(`ENV: ${diagReport.checks.env.missing.join(", ")} MISSING. ${diagReport.checks.env.impact || ""}`);
    }
    if (diagReport.checks.pipeline?.status === "FAIL") {
      parts.push(`PIPELINE: ${diagReport.checks.pipeline.runError || "failed"}`);
      const stages = diagReport.checks.pipeline.stages || {};
      for (const [k, v] of Object.entries(stages)) {
        if (k.endsWith("_error")) parts.push(`  ${k}: ${v}`);
      }
    }
    if (diagReport.checks.workspace?.error) {
      parts.push(`WORKSPACE ERROR: ${diagReport.checks.workspace.error}`);
    }
    if (diagReport.checks.workspace?.recentErrors?.length > 0) {
      parts.push(`WORKSPACE RECENT ERRORS:\n${diagReport.checks.workspace.recentErrors.join("\n")}`);
    }
    if (parts.length > 0) {
      diagnosticsContext = `\n\nSYSTEM DIAGNOSTICS (auto-run):\n${parts.join("\n")}\n`;
    } else {
      diagnosticsContext = `\n\nSYSTEM DIAGNOSTICS (auto-run): All checks passed (env, models, pipeline, workspace).\n`;
    }
  } catch {}

  const conversationMessages = history.map(m => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));

  const projectContext = `\n\nCURRENT PROJECT CONTEXT:\nProject ID: ${projectId}\nProject Name: ${project.name}\nCurrent Run ID: ${lastRunId || "none"}\nYou are chatting inside this project. You already have full access to its pipeline state, workspace logs, source code, and diagnostics. Do not ask the user for the project ID — you have it.\n`;

  const systemMessage = CHAT_AGENT_INSTRUCTIONS + projectContext + diagnosticsContext + iterHistoryContext + codeContext + logsContext + (skillContext ? "\n\nACTIVATED SKILLS:" + skillContext : "");

  const messages = [
    { role: "system", content: systemMessage },
    ...conversationMessages,
  ];

  let chatModel = "claude-haiku-4-5-20251001";
  try {
    const config = await settingsManager.getSetting("model_config");
    if (config && config.chatModel) chatModel = config.chatModel;
  } catch {}

  const MAX_TOOL_ROUNDS = 5;
  let toolRound = 0;
  let usedWebSearch = false;

  while (toolRound < MAX_TOOL_ROUNDS) {
    const result = await callChat(chatModel, systemMessage, messages.filter(m => m.role !== "system"), SEARCH_TOOLS, 0.3);

    if (result.tool_calls && result.tool_calls.length > 0) {
      messages.push({ role: "assistant", content: result.content, tool_calls: result.tool_calls });

      for (const toolCall of result.tool_calls) {
        const toolResult = await executeToolCall(toolCall);
        usedWebSearch = true;
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolResult,
        });
      }

      toolRound++;
      continue;
    }

    const content = result.content;
    let parsed = parseResponse(content);

    const msg = parsed.message || "";
    // Auto-detect "I'll reforge" pattern as a BUILD suggestion (not a PLAN)
    const reforgeMatch = msg.match(/I'll reforge\s+(.+?)(?:\.|$)/i);
    if (reforgeMatch && !parsed.suggestBuild && !parsed.suggestPlan) {
      parsed.suggestBuild = true;
      if (!parsed.buildSuggestion) {
        parsed.buildSuggestion = msg;
      }
    }

    // Only validate banned patterns on message + buildSuggestion — planSuggestion
    // and forgeSuggestion intentionally allow multi-step language that describes scope.
    const violations = detectBannedPatterns(parsed.message, parsed.suggestForge ? null : parsed.buildSuggestion);
    if (violations.length > 0 && toolRound < MAX_TOOL_ROUNDS - 1) {
      messages.push({ role: "assistant", content });
      messages.push({
        role: "user",
        content: `REJECTED — your response violates these rules:\n${violations.join("\n")}\n\nRewrite your response. TWO SENTENCES ONLY. Sentence 1: root cause citing file and function. Sentence 2: exact code change. No logging fixes, no try-catch fixes, no padding phrases, no outcome descriptions. Stop after the code change.`,
      });
      toolRound++;
      continue;
    }

    const prefix = usedWebSearch ? "[Researched] " : "";
    const assistantMsg = {
      role: "assistant",
      content: prefix + parsed.message,
      suggestBuild: parsed.suggestBuild,
      buildSuggestion: parsed.buildSuggestion,
      suggestPlan: parsed.suggestPlan,
      planSuggestion: parsed.planSuggestion,
      suggestForge: parsed.suggestForge || false,
      forgeSuggestion: parsed.forgeSuggestion || null,
      // Thread active skill context back to client so it can be passed to /iterate.
      // This is how skill instructions reach the actual builder — not just the Chat Agent.
      activeSkillContext: skillContext || null,
      createdAt: Date.now(),
    };
    await saveMessage(projectId, assistantMsg);
    return assistantMsg;
  }

  const fallbackMsg = {
    role: "assistant",
    content: "I gathered some research but couldn't formulate a final response. Please try asking again.",
    suggestBuild: false,
    buildSuggestion: null,
    createdAt: Date.now(),
  };
  await saveMessage(projectId, fallbackMsg);
  return fallbackMsg;
}

async function getChatHistory(projectId) {
  return await getHistory(projectId);
}

module.exports = {
  chat,
  getChatHistory,
  clearBuildSuggestions,
  runDiagnostics,
  postBuildAnalysis,
};


