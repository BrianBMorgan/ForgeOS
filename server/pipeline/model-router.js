const OpenAI = require("openai");
const openai = new OpenAI();

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

async function callStructured(model, systemPrompt, userMessages, schema, formatName, temperature) {
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
          schema: zodToJsonSchema(schema),
          strict: true,
        },
      },
    };

    if (!NO_TEMPERATURE_MODELS.has(model) && temperature != null) {
      params.temperature = temperature;
    }

    const response = await openai.responses.create(params);
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
  const content = response.choices[0].message.content;
  const parsed = JSON.parse(content);
  schema.parse(parsed);
  return parsed;
}

async function callChat(model, systemPrompt, messages, tools, temperature) {
  if (usesResponsesAPI(model)) {
    const input = messages.filter(m => m.role !== "system").map(m => {
      if (m.role === "tool") {
        return {
          type: "function_call_output",
          call_id: m.tool_call_id,
          output: m.content,
        };
      }
      return { role: m.role, content: m.content };
    });

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
  const choice = response.choices[0];
  return {
    content: choice.message.content,
    tool_calls: choice.message.tool_calls || null,
    _raw: response,
  };
}

function zodToJsonSchema(zodSchema) {
  const { zodToJsonSchema: convert } = require("zod-to-json-schema");
  const full = convert(zodSchema);
  delete full.$schema;
  return full;
}

module.exports = {
  callStructured,
  callChat,
  usesResponsesAPI,
  NO_TEMPERATURE_MODELS,
};
