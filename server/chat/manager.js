const { CHAT_AGENT_INSTRUCTIONS } = require("../pipeline/agents");
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
      description: "Run a system health check to diagnose why builds are failing. Call this FIRST when a user reports build failures, crashes, or errors. Checks: environment variables, API connectivity, model availability, pipeline run errors, workspace status, and database connectivity.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Optional project ID to include project-specific diagnostics (pipeline run errors, workspace logs)." },
          checks: {
            type: "array",
            items: { type: "string", enum: ["env", "api", "models", "pipeline", "workspace", "db", "all"] },
            description: "Which checks to run. Use 'all' for a full system diagnostic. Defaults to 'all'.",
          },
        },
        required: [],
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
      created_at BIGINT NOT NULL
    )`;
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
      const rows = await sql`SELECT role, content, suggest_build, build_suggestion, created_at FROM chat_messages WHERE project_id = ${projectId} ORDER BY created_at ASC`;
      for (const row of rows) {
        messages.push({
          role: row.role,
          content: row.content,
          suggestBuild: row.suggest_build || false,
          buildSuggestion: row.build_suggestion || null,
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
      await sql`INSERT INTO chat_messages (project_id, role, content, suggest_build, build_suggestion, created_at)
        VALUES (${projectId}, ${msg.role}, ${msg.content}, ${msg.suggestBuild || false}, ${msg.buildSuggestion || null}, ${msg.createdAt})`;
    } catch (err) {
      console.error("Failed to save chat message:", err.message);
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
    }
    return JSON.stringify({ error: "Unknown tool" });
  } catch (err) {
    return JSON.stringify({ error: `Tool execution failed: ${err.message}` });
  }
}

const VALID_CHECKS = new Set(["env", "api", "models", "pipeline", "workspace", "db", "all"]);

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

  const failures = Object.entries(report.checks).filter(([, v]) => v.status === "FAIL");
  report.summary = failures.length === 0
    ? "All checks passed"
    : `${failures.length} check(s) failed: ${failures.map(([k]) => k).join(", ")}`;

  return report;
}

function parseResponse(content) {
  const buildMatch = content.match(/^BUILD:\s*(.+)$/m);
  let message = content;
  let suggestBuild = false;
  let buildSuggestion = null;

  if (buildMatch) {
    buildSuggestion = buildMatch[1].trim();
    suggestBuild = true;
    message = content.substring(0, buildMatch.index).trim();
  }

  if (!suggestBuild) {
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed.message === "string") {
        return {
          message: parsed.message,
          suggestBuild: !!parsed.suggestBuild,
          buildSuggestion: parsed.buildSuggestion || null,
        };
      }
    } catch { /* not JSON — use plain text path */ }
  }

  return { message, suggestBuild, buildSuggestion };
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
              if (!sd || !sd.output) continue;
              const outputStr = typeof sd.output === "string" ? sd.output : JSON.stringify(sd.output, null, 2);
              const truncated = outputStr.length > 3000 ? outputStr.slice(0, 3000) + "\n... [truncated]" : outputStr;
              lines.push(`\n  --- LATEST RUN: ${sn} (${sd.status}) ---\n${truncated}`);
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
    const reforgeMatch = msg.match(/I'll reforge\s+(.+?)(?:\.|$)/i);
    if (reforgeMatch && !parsed.suggestBuild) {
      parsed.suggestBuild = true;
      if (!parsed.buildSuggestion) {
        parsed.buildSuggestion = msg;
      }
    }

    const violations = detectBannedPatterns(parsed.message, parsed.buildSuggestion);
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
  runDiagnostics,
};
