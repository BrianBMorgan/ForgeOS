const OpenAI = require("openai");
const { zodResponseFormat } = require("openai/helpers/zod");
const { ChatResponseSchema } = require("../pipeline/schemas");
const { CHAT_AGENT_INSTRUCTIONS } = require("../pipeline/agents");
const { neon } = require("@neondatabase/serverless");
const projectManager = require("../projects/manager");

const openai = new OpenAI();

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

  const conversationMessages = history.map(m => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));

  const systemMessage = CHAT_AGENT_INSTRUCTIONS + codeContext;

  const response = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.3,
    messages: [
      { role: "system", content: systemMessage },
      ...conversationMessages,
    ],
    response_format: zodResponseFormat(ChatResponseSchema, "chat_response"),
  });

  const content = response.choices[0].message.content;
  const parsed = JSON.parse(content);
  ChatResponseSchema.parse(parsed);

  const assistantMsg = {
    role: "assistant",
    content: parsed.message,
    suggestBuild: parsed.suggestBuild,
    buildSuggestion: parsed.buildSuggestion,
    createdAt: Date.now(),
  };
  await saveMessage(projectId, assistantMsg);

  return assistantMsg;
}

async function getChatHistory(projectId) {
  return await getHistory(projectId);
}

module.exports = {
  chat,
  getChatHistory,
};
