const OpenAI = require("openai");
const { zodResponseFormat } = require("openai/helpers/zod");
const { ChatResponseSchema } = require("../pipeline/schemas");
const { CHAT_AGENT_INSTRUCTIONS } = require("../pipeline/agents");
const { neon } = require("@neondatabase/serverless");
const projectManager = require("../projects/manager");
const settingsManager = require("../settings/manager");
const { webSearch, fetchUrl } = require("./search");

const openai = new OpenAI();

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

  const systemMessage = CHAT_AGENT_INSTRUCTIONS + codeContext + (skillContext ? "\n\nACTIVATED SKILLS:" + skillContext : "");

  const messages = [
    { role: "system", content: systemMessage },
    ...conversationMessages,
  ];

  const MAX_TOOL_ROUNDS = 5;
  let toolRound = 0;
  let usedWebSearch = false;

  while (toolRound < MAX_TOOL_ROUNDS) {
    const requestParams = {
      model: "gpt-4.1-mini",
      temperature: 0.3,
      messages,
      tools: SEARCH_TOOLS,
    };

    const response = await openai.chat.completions.create(requestParams);
    const choice = response.choices[0];

    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      messages.push(choice.message);

      for (const toolCall of choice.message.tool_calls) {
        const result = await executeToolCall(toolCall);
        usedWebSearch = true;
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
        });
      }

      toolRound++;
      continue;
    }

    const content = choice.message.content;
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
