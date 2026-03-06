const https = require("https");

const BASE_URL = "https://api.elevenlabs.io";

function getApiKey() {
  return process.env.ELEVENLABS_API_KEY || "";
}

async function apiRequest(method, path, body = null) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY not set. Add it to the Global Secrets Vault in Settings.");
  }

  const url = new URL(path, BASE_URL);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode >= 400) {
          let errMsg = `ElevenLabs API error ${res.statusCode}`;
          try {
            const parsed = JSON.parse(data);
            errMsg += `: ${parsed.detail?.message || parsed.detail || JSON.stringify(parsed)}`;
          } catch {
            errMsg += `: ${data.slice(0, 500)}`;
          }
          reject(new Error(errMsg));
          return;
        }

        if (res.headers["content-type"]?.includes("audio/")) {
          resolve({ _audio: true, contentType: res.headers["content-type"], size: data.length, note: "Audio binary returned. Use the TTS endpoint directly to stream audio." });
          return;
        }

        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ raw: data.slice(0, 2000) });
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("Request timeout")); });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

const TOOLS = [
  {
    name: "elevenlabs_list_voices",
    description: "List all available voices in the ElevenLabs account, including premade, cloned, and designed voices.",
    inputSchema: {
      type: "object",
      properties: {
        show_legacy: { type: "boolean", description: "Include legacy voices in the listing", default: false },
      },
    },
  },
  {
    name: "elevenlabs_get_voice",
    description: "Get detailed information about a specific voice by ID, including settings and labels.",
    inputSchema: {
      type: "object",
      properties: {
        voice_id: { type: "string", description: "The voice ID to retrieve" },
      },
      required: ["voice_id"],
    },
  },
  {
    name: "elevenlabs_text_to_speech",
    description: "Convert text to speech using a specified voice. Returns metadata about the generated audio. The audio itself should be accessed via the ElevenLabs API or SDK directly.",
    inputSchema: {
      type: "object",
      properties: {
        voice_id: { type: "string", description: "The voice ID to use for speech synthesis" },
        text: { type: "string", description: "The text to convert to speech (max 5000 chars)" },
        model_id: { type: "string", description: "Model to use. Options: eleven_multilingual_v2, eleven_flash_v2_5, eleven_turbo_v2_5", default: "eleven_multilingual_v2" },
        stability: { type: "number", description: "Voice stability (0-1). Lower = more expressive, higher = more consistent", default: 0.5 },
        similarity_boost: { type: "number", description: "Voice clarity/similarity (0-1). Higher = closer to original voice", default: 0.75 },
        output_format: { type: "string", description: "Audio format: mp3_44100_128, pcm_16000, pcm_24000", default: "mp3_44100_128" },
      },
      required: ["voice_id", "text"],
    },
  },
  {
    name: "elevenlabs_list_models",
    description: "List all available ElevenLabs models with their capabilities and supported languages.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "elevenlabs_get_user",
    description: "Get current user account information including subscription tier, character usage, and limits.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "elevenlabs_get_usage",
    description: "Get character usage statistics for the current billing period.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "elevenlabs_list_agents",
    description: "List all conversational AI agents in the account.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "elevenlabs_get_agent",
    description: "Get detailed configuration and status of a specific conversational AI agent.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "The agent ID to retrieve" },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "elevenlabs_create_agent",
    description: "Create a new conversational AI agent with specified configuration including voice, language model, and first message.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name for the agent" },
        voice_id: { type: "string", description: "Voice ID for the agent to use" },
        first_message: { type: "string", description: "The greeting message the agent says when a conversation starts" },
        system_prompt: { type: "string", description: "System prompt defining the agent's behavior and personality" },
        language: { type: "string", description: "Primary language code (e.g. en, es, fr)", default: "en" },
        llm: { type: "string", description: "LLM provider to use (e.g. claude-sonnet-4-5-20250514, claude-haiku-3-5-20241022)", default: "claude-sonnet-4-5-20250514" },
      },
      required: ["name", "voice_id", "first_message", "system_prompt"],
    },
  },
  {
    name: "elevenlabs_list_conversations",
    description: "List recent conversations for an agent, including status and metadata.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "The agent ID to list conversations for" },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "elevenlabs_get_conversation",
    description: "Get full details of a specific conversation including transcript.",
    inputSchema: {
      type: "object",
      properties: {
        conversation_id: { type: "string", description: "The conversation ID to retrieve" },
      },
      required: ["conversation_id"],
    },
  },
  {
    name: "elevenlabs_speech_to_text",
    description: "Transcribe audio from a URL. Provide the URL of an audio file to get a text transcription.",
    inputSchema: {
      type: "object",
      properties: {
        audio_url: { type: "string", description: "URL of the audio file to transcribe" },
        language_code: { type: "string", description: "Language code for transcription (e.g. en, es)", default: "en" },
      },
      required: ["audio_url"],
    },
  },
];

async function executeTool(name, args) {
  switch (name) {
    case "elevenlabs_list_voices": {
      const result = await apiRequest("GET", "/v1/voices");
      const voices = (result.voices || []).map(v => ({
        voice_id: v.voice_id,
        name: v.name,
        category: v.category,
        labels: v.labels,
        preview_url: v.preview_url,
        description: v.description,
      }));
      return { voices, count: voices.length };
    }

    case "elevenlabs_get_voice": {
      return await apiRequest("GET", `/v1/voices/${args.voice_id}`);
    }

    case "elevenlabs_text_to_speech": {
      const body = {
        text: args.text.slice(0, 5000),
        model_id: args.model_id || "eleven_multilingual_v2",
        voice_settings: {
          stability: args.stability ?? 0.5,
          similarity_boost: args.similarity_boost ?? 0.75,
        },
      };
      const result = await apiRequest("POST", `/v1/text-to-speech/${args.voice_id}?output_format=${args.output_format || "mp3_44100_128"}`, body);
      return result;
    }

    case "elevenlabs_list_models": {
      return await apiRequest("GET", "/v1/models");
    }

    case "elevenlabs_get_user": {
      return await apiRequest("GET", "/v1/user");
    }

    case "elevenlabs_get_usage": {
      return await apiRequest("GET", "/v1/usage/character-stats");
    }

    case "elevenlabs_list_agents": {
      return await apiRequest("GET", "/v1/convai/agents");
    }

    case "elevenlabs_get_agent": {
      return await apiRequest("GET", `/v1/convai/agents/${args.agent_id}`);
    }

    case "elevenlabs_create_agent": {
      const body = {
        name: args.name,
        conversation_config: {
          agent: {
            prompt: {
              prompt: args.system_prompt,
            },
            first_message: args.first_message,
            language: args.language || "en",
          },
          tts: {
            voice_id: args.voice_id,
          },
        },
      };
      return await apiRequest("POST", "/v1/convai/agents/create", body);
    }

    case "elevenlabs_list_conversations": {
      return await apiRequest("GET", `/v1/convai/conversations?agent_id=${args.agent_id}`);
    }

    case "elevenlabs_get_conversation": {
      return await apiRequest("GET", `/v1/convai/conversations/${args.conversation_id}`);
    }

    case "elevenlabs_speech_to_text": {
      const body = {
        audio_url: args.audio_url,
        language_code: args.language_code || "en",
      };
      return await apiRequest("POST", "/v1/speech-to-text", body);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

module.exports = { TOOLS, executeTool };
