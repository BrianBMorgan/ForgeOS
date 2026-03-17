const Anthropic = require("@anthropic-ai/sdk");

let anthropic = null;
function getAnthropic() {
  if (anthropic) return anthropic;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  anthropic = new Anthropic({ apiKey });
  return anthropic;
}

function isClaudeModel(model) {
  return model && model.startsWith("claude-");
}

let _lastUsage = null;
function getLastUsage() { const u = _lastUsage; _lastUsage = null; return u; }

const NO_TEMPERATURE_MODELS = new Set([]);

function extractAnthropicUsage(response) {
  if (response?.usage) {
    _lastUsage = {
      promptTokens: response.usage.input_tokens ?? 0,
      completionTokens: response.usage.output_tokens ?? 0,
      totalTokens: (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0),
    };
  }
}

function zodToJsonSchema(zodSchema) {
  const { z } = require("zod");
  return z.toJSONSchema(zodSchema);
}

async function callClaudeStructured(model, systemPrompt, userMessages, schema, formatName, temperature) {
  const client = getAnthropic();
  if (!client) throw new Error("Anthropic not configured — missing ANTHROPIC_API_KEY environment variable");

  const jsonSchema = zodToJsonSchema(schema);
  // Inject the schema instruction as the LAST user message rather than appending to the
  // system prompt — this keeps the system prompt lean and avoids context overflow on large builds.
  const schemaInstruction = `You MUST respond with ONLY valid JSON matching this exact schema — no prose, no markdown, no explanation outside the JSON:\n${JSON.stringify(jsonSchema, null, 2)}`;

  const messages = userMessages.map(m => ({
    role: m.role === "system" ? "user" : m.role,
    content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
  }));

  // Append schema instruction as final user turn
  messages.push({ role: "user", content: schemaInstruction });

  const params = {
    model,
    max_tokens: 16384,
    system: systemPrompt,
    messages,
  };
  if (temperature != null) {
    params.temperature = temperature;
  }

  const response = await client.messages.create(params);
  extractAnthropicUsage(response);

  let content = "";
  for (const block of response.content) {
    if (block.type === "text") content += block.text;
  }

  content = content.trim();

  if (content.startsWith("```")) {
    content = content.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }

  let jsonStr = content;
  if (!jsonStr.startsWith("{") && !jsonStr.startsWith("[")) {
    const braceStart = jsonStr.indexOf("{");
    const bracketStart = jsonStr.indexOf("[");
    let start = -1;
    if (braceStart >= 0 && bracketStart >= 0) start = Math.min(braceStart, bracketStart);
    else if (braceStart >= 0) start = braceStart;
    else if (bracketStart >= 0) start = bracketStart;

    if (start >= 0) {
      jsonStr = jsonStr.substring(start);
    }
  }

  const lastBrace = jsonStr.lastIndexOf("}");
  const lastBracket = jsonStr.lastIndexOf("]");
  const lastClose = Math.max(lastBrace, lastBracket);
  if (lastClose >= 0 && lastClose < jsonStr.length - 1) {
    jsonStr = jsonStr.substring(0, lastClose + 1);
  }

  jsonStr = jsonStr.trim();

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (parseErr) {
    console.error("[model-router] JSON parse failed. Raw content (first 500 chars):", content.substring(0, 500));
    const pos = parseErr.message.match(/position (\d+)/)?.[1];
    const posNum = pos ? parseInt(pos, 10) : -1;
    const snippet = posNum >= 0
      ? jsonStr.substring(Math.max(0, posNum - 80), posNum + 80)
      : jsonStr.substring(0, 200);
    const err = new Error(`Failed to parse AI response as JSON: ${parseErr.message}`);
    err.rawOutput = content.substring(0, 4000);
    err.parseErrorDetail = parseErr.message;
    err.parseErrorSnippet = snippet;
    throw err;
  }

  schema.parse(parsed);
  parsed._rawOutput = content.substring(0, 4000);
  return parsed;
}

async function callClaudeChat(model, systemPrompt, messages, tools, temperature) {
  const client = getAnthropic();
  if (!client) throw new Error("Anthropic not configured — missing ANTHROPIC_API_KEY environment variable");

  const anthropicMessages = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      anthropicMessages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: m.tool_call_id,
          content: m.content,
        }],
      });
    } else if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      const blocks = [];
      for (const tc of m.tool_calls) {
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || "{}"),
        });
      }
      if (m.content) {
        blocks.unshift({ type: "text", text: m.content });
      }
      anthropicMessages.push({ role: "assistant", content: blocks });
    } else {
      anthropicMessages.push({
        role: m.role,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content || ""),
      });
    }
  }

  const anthropicTools = tools ? tools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  })) : undefined;

  const params = {
    model,
    max_tokens: 8192,
    system: systemPrompt,
    messages: anthropicMessages,
  };
  if (anthropicTools && anthropicTools.length > 0) {
    params.tools = anthropicTools;
  }
  if (temperature != null) {
    params.temperature = temperature;
  }

  const response = await client.messages.create(params);
  extractAnthropicUsage(response);

  const toolUseBlocks = response.content.filter(b => b.type === "tool_use");
  if (toolUseBlocks.length > 0) {
    const toolCalls = toolUseBlocks.map(b => ({
      id: b.id,
      type: "function",
      function: {
        name: b.name,
        arguments: JSON.stringify(b.input),
      },
    }));
    return { content: null, tool_calls: toolCalls, _raw: response };
  }

  let textContent = "";
  for (const block of response.content) {
    if (block.type === "text") textContent += block.text;
  }

  return { content: textContent, tool_calls: null, _raw: response };
}

async function callStructured(model, systemPrompt, userMessages, schema, formatName, temperature) {
  if (!isClaudeModel(model)) {
    console.warn(`[model-router] Non-Claude model "${model}" requested — routing to Claude sonnet as fallback`);
    model = "claude-sonnet-4-6";
  }
  return callClaudeStructured(model, systemPrompt, userMessages, schema, formatName, temperature);
}

async function callChat(model, systemPrompt, messages, tools, temperature) {
  if (!isClaudeModel(model)) {
    console.warn(`[model-router] Non-Claude model "${model}" requested — routing to Claude haiku as fallback`);
    model = "claude-haiku-4-5-20251001";
  }
  return callClaudeChat(model, systemPrompt, messages, tools, temperature);
}

module.exports = {
  callStructured,
  callChat,
  isClaudeModel,
  NO_TEMPERATURE_MODELS,
  getLastUsage,
};

