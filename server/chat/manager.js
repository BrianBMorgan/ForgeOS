const { ChatResponseSchema } = require("../pipeline/schemas");
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
    }
    return JSON.stringify({ error: "Unknown tool" });
  } catch (err) {
    return JSON.stringify({ error: `Tool execution failed: ${err.message}` });
  }
}

function parseResponse(content) {
  let parsed = null;
  try {
    parsed = JSON.parse(content);
    ChatResponseSchema.parse(parsed);
  } catch {
    parsed = null;
  }

  if (!parsed) {
    const bracePositions = [];
    for (let i = content.length - 1; i >= 0; i--) {
      if (content[i] === "}") bracePositions.push(i);
    }
    for (const endPos of bracePositions) {
      const startPos = content.lastIndexOf("{", endPos);
      if (startPos === -1) continue;
      try {
        const candidate = JSON.parse(content.substring(startPos, endPos + 1));
        if (candidate && typeof candidate.message === "string") {
          parsed = { message: candidate.message, suggestBuild: !!candidate.suggestBuild, buildSuggestion: candidate.buildSuggestion || null };
          break;
        }
      } catch { /* try next brace pair */ }
    }
  }

  if (!parsed) {
    parsed = { message: content, suggestBuild: false, buildSuggestion: null };
  }

  return parsed;
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
        const lines = rows.map(row => {
          const num = row.iteration_number;
          const prompt = (row.prompt || "").slice(0, 100);
          const data = row.data;
          if (!data) return `- Iter ${num}: "${prompt}" → no data`;
          const status = data.status || "unknown";
          const wsStatus = data.workspace?.status || "unknown";
          const wsError = data.workspace?.error ? ` error: ${data.workspace.error.slice(0, 150)}` : "";
          const hc = data.healthCheck;
          let healthNote = "";
          if (hc) {
            healthNote = hc.healthy ? ` health:OK` : ` health:FAILED(${hc.httpStatus || "no-response"})`;
            if (hc.startupLogs) healthNote += ` logs: ${hc.startupLogs.slice(0, 150)}`;
          }
          return `- Iter ${num}: "${prompt}" → ${status}, ws:${wsStatus}${wsError}${healthNote}`;
        });
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

  const conversationMessages = history.map(m => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));

  const systemMessage = CHAT_AGENT_INSTRUCTIONS + iterHistoryContext + codeContext + logsContext + (skillContext ? "\n\nACTIVATED SKILLS:" + skillContext : "");

  const messages = [
    { role: "system", content: systemMessage },
    ...conversationMessages,
  ];

  let chatModel = "gpt-4.1-mini";
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
};
