const OpenAI = require("openai");
const openai = new OpenAI();

let anthropic = null;
function getAnthropic() {
  if (anthropic) return anthropic;
  const baseURL = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
  if (!baseURL || !apiKey) return null;
  const Anthropic = require("@anthropic-ai/sdk");
  anthropic = new Anthropic({ apiKey, baseURL });
  return anthropic;
}

function isClaudeModel(model) {
  return model && model.startsWith("claude-");
}

let _lastUsage = null;
function getLastUsage() { const u = _lastUsage; _lastUsage = null; return u; }

function extractUsage(response) {
  if (response?.usage) {
    _lastUsage = {
      promptTokens: response.usage.prompt_tokens ?? response.usage.input_tokens ?? 0,
      completionTokens: response.usage.completion_tokens ?? response.usage.output_tokens ?? 0,
      totalTokens: response.usage.total_tokens ?? 0,
    };
    if (!_lastUsage.totalTokens) {
      _lastUsage.totalTokens = _lastUsage.promptTokens + _lastUsage.completionTokens;
    }
  }
}

const RESPONSES_API_MODELS = new Set([
  "gpt-5.2-pro",
  "gpt-5.2",
  "gpt-5.2-mini",
  "o3",
  "o3-mini",
]);

const NO_TEMPERATURE_MODELS = new Set([
  "gpt-5.2-pro",
  "o3",
  "o3-mini",
]);

function usesResponsesAPI(model) {
  return RESPONSES_API_MODELS.has(model);
}

function extractAnthropicUsage(response) {
  if (response?.usage) {
    _lastUsage = {
      promptTokens: response.usage.input_tokens ?? 0,
      completionTokens: response.usage.output_tokens ?? 0,
      totalTokens: (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0),
    };
  }
}

async function callClaudeStructured(model, systemPrompt, userMessages, schema, formatName, temperature) {
  const client = getAnthropic();
  if (!client) throw new Error("Anthropic not configured — missing AI_INTEGRATIONS_ANTHROPIC_BASE_URL or AI_INTEGRATIONS_ANTHROPIC_API_KEY");

  const jsonSchema = zodToJsonSchema(schema, formatName);
  const schemaInstruction = `\n\nYou MUST respond with ONLY valid JSON matching this exact schema — no prose, no markdown, no explanation outside the JSON:\n${JSON.stringify(jsonSchema, null, 2)}`;

  const messages = userMessages.map(m => ({
    role: m.role === "system" ? "user" : m.role,
    content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
  }));

  const params = {
    model,
    max_tokens: 16384,
    system: systemPrompt + schemaInstruction,
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

  const parsed = JSON.parse(content);
  schema.parse(parsed);
  return parsed;
}

async function callClaudeChat(model, systemPrompt, messages, tools, temperature) {
  const client = getAnthropic();
  if (!client) throw new Error("Anthropic not configured — missing AI_INTEGRATIONS_ANTHROPIC_BASE_URL or AI_INTEGRATIONS_ANTHROPIC_API_KEY");

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
  if (isClaudeModel(model)) {
    return callClaudeStructured(model, systemPrompt, userMessages, schema, formatName, temperature);
  }

  if (usesResponsesAPI(model)) {
    const input = userMessages.map(m => ({
      role: m.role,
      content: m.content,
    }));

    const params = {
      model,
      instructions: systemPrompt,
      input,
      text: {
        format: {
          type: "json_schema",
          name: formatName,
          schema: zodToJsonSchema(schema, formatName),
          strict: true,
        },
      },
    };

    if (!NO_TEMPERATURE_MODELS.has(model) && temperature != null) {
      params.temperature = temperature;
    }

    const response = await openai.responses.create(params);
    extractUsage(response);
    const content = response.output_text;
    const parsed = JSON.parse(content);
    schema.parse(parsed);
    return parsed;
  }

  const { zodResponseFormat } = require("openai/helpers/zod");
  const params = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      ...userMessages,
    ],
    response_format: zodResponseFormat(schema, formatName),
  };
  if (temperature != null) {
    params.temperature = temperature;
  }

  const response = await openai.chat.completions.create(params);
  extractUsage(response);
  const content = response.choices[0].message.content;
  const parsed = JSON.parse(content);
  schema.parse(parsed);
  return parsed;
}

async function callChat(model, systemPrompt, messages, tools, temperature) {
  if (isClaudeModel(model)) {
    return callClaudeChat(model, systemPrompt, messages, tools, temperature);
  }

  if (usesResponsesAPI(model)) {
    const sanitizeId = (id) => {
      if (id && id.startsWith("call_")) return "fc_" + id.slice(5);
      return id;
    };
    const input = [];
    for (const m of messages) {
      if (m.role === "system") continue;
      if (m.role === "tool") {
        input.push({
          type: "function_call_output",
          call_id: sanitizeId(m.tool_call_id),
          output: m.content,
        });
      } else if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
        for (const tc of m.tool_calls) {
          const safeId = sanitizeId(tc.id);
          input.push({
            type: "function_call",
            id: safeId,
            call_id: safeId,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
        if (m.content) {
          input.push({ role: "assistant", content: m.content });
        }
      } else {
        input.push({ role: m.role, content: m.content || "" });
      }
    }

    const responsesTools = tools ? tools.map(t => ({
      type: "function",
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    })) : undefined;

    const params = {
      model,
      instructions: systemPrompt,
      input,
    };
    if (responsesTools && responsesTools.length > 0) {
      params.tools = responsesTools;
    }
    if (!NO_TEMPERATURE_MODELS.has(model) && temperature != null) {
      params.temperature = temperature;
    }

    const response = await openai.responses.create(params);
    extractUsage(response);

    const functionCalls = response.output.filter(o => o.type === "function_call");
    if (functionCalls.length > 0) {
      const toolCalls = functionCalls.map(fc => ({
        id: fc.call_id,
        type: "function",
        function: {
          name: fc.name,
          arguments: fc.arguments,
        },
      }));
      return {
        content: null,
        tool_calls: toolCalls,
        _raw: response,
      };
    }

    return {
      content: response.output_text,
      tool_calls: null,
      _raw: response,
    };
  }

  const params = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      ...messages.filter(m => m.role !== "system"),
    ],
  };
  if (tools && tools.length > 0) {
    params.tools = tools;
  }
  if (temperature != null) {
    params.temperature = temperature;
  }

  const response = await openai.chat.completions.create(params);
  extractUsage(response);
  const choice = response.choices[0];
  return {
    content: choice.message.content,
    tool_calls: choice.message.tool_calls || null,
    _raw: response,
  };
}

function zodToJsonSchema(zodSchema, name) {
  const { zodResponseFormat } = require("openai/helpers/zod");
  const fmt = zodResponseFormat(zodSchema, name || "output");
  return fmt.json_schema.schema;
}

module.exports = {
  callStructured,
  callChat,
  usesResponsesAPI,
  isClaudeModel,
  NO_TEMPERATURE_MODELS,
  getLastUsage,
};
