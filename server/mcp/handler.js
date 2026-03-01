const crypto = require("crypto");
const { TOOLS, executeTool } = require("./elevenlabs");

const sessions = new Map();
const rateLimits = new Map();

const SERVER_INFO = {
  name: "ForgeOS-ElevenLabs",
  version: "1.0.0",
};

const SERVER_CAPABILITIES = {
  tools: {},
};

const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 60;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimits.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW) {
    rateLimits.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

function createSession() {
  const id = crypto.randomUUID();
  sessions.set(id, { createdAt: Date.now(), lastUsed: Date.now() });
  return id;
}

function touchSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) session.lastUsed = Date.now();
}

function jsonRpcResponse(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message, data) {
  const err = { jsonrpc: "2.0", id, error: { code, message } };
  if (data !== undefined) err.error.data = data;
  return err;
}

function validateJsonRpcRequest(request) {
  if (!request || typeof request !== "object") return "Request must be a JSON object";
  if (request.jsonrpc !== "2.0") return "jsonrpc must be '2.0'";
  if (typeof request.method !== "string") return "method must be a string";
  if (request.id !== undefined && request.id !== null && typeof request.id !== "string" && typeof request.id !== "number") {
    return "id must be a string, number, or null";
  }
  return null;
}

async function handleJsonRpcRequest(request) {
  const validationError = validateJsonRpcRequest(request);
  if (validationError) {
    return { response: jsonRpcError(request?.id || null, -32600, validationError) };
  }

  const { id, method, params } = request;

  switch (method) {
    case "initialize": {
      const sessionId = createSession();
      return {
        response: jsonRpcResponse(id, {
          protocolVersion: "2025-03-26",
          capabilities: SERVER_CAPABILITIES,
          serverInfo: SERVER_INFO,
        }),
        sessionId,
      };
    }

    case "notifications/initialized": {
      return { response: null };
    }

    case "tools/list": {
      const toolList = TOOLS.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      return { response: jsonRpcResponse(id, { tools: toolList }) };
    }

    case "tools/call": {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};

      if (!toolName) {
        return { response: jsonRpcError(id, -32602, "Missing tool name") };
      }

      const tool = TOOLS.find(t => t.name === toolName);
      if (!tool) {
        return { response: jsonRpcError(id, -32602, `Unknown tool: ${toolName}`) };
      }

      const required = tool.inputSchema?.required || [];
      for (const field of required) {
        if (toolArgs[field] === undefined || toolArgs[field] === null || toolArgs[field] === "") {
          return { response: jsonRpcError(id, -32602, `Missing required argument: ${field}`) };
        }
      }

      try {
        const result = await executeTool(toolName, toolArgs);
        return {
          response: jsonRpcResponse(id, {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          }),
        };
      } catch (err) {
        return {
          response: jsonRpcResponse(id, {
            content: [
              {
                type: "text",
                text: `Error: ${err.message}`,
              },
            ],
            isError: true,
          }),
        };
      }
    }

    case "ping": {
      return { response: jsonRpcResponse(id, {}) };
    }

    default: {
      return { response: jsonRpcError(id, -32601, `Method not found: ${method}`) };
    }
  }
}

function authenticateRequest(req) {
  const mcpKey = process.env.MCP_AUTH_KEY;
  if (!mcpKey) return true;

  const authHeader = req.headers["authorization"] || "";
  if (authHeader.startsWith("Bearer ") && authHeader.slice(7) === mcpKey) return true;

  const headerKey = req.headers["x-mcp-auth"] || "";
  if (headerKey === mcpKey) return true;

  return false;
}

function mountMcp(app) {
  const mcpAuth = (req, res, next) => {
    if (!authenticateRequest(req)) {
      return res.status(401).json(jsonRpcError(null, -32600, "Unauthorized: invalid or missing authentication"));
    }

    const ip = req.ip || req.connection?.remoteAddress || "unknown";
    if (!checkRateLimit(ip)) {
      return res.status(429).json(jsonRpcError(null, -32600, "Rate limit exceeded. Max 60 requests per minute."));
    }

    next();
  };

  app.post("/mcp", mcpAuth, async (req, res) => {
    const contentType = req.headers["content-type"] || "";
    if (!contentType.includes("application/json")) {
      return res.status(415).json(jsonRpcError(null, -32700, "Content-Type must be application/json"));
    }

    const body = req.body;

    if (Array.isArray(body)) {
      if (body.length === 0) {
        return res.status(400).json(jsonRpcError(null, -32600, "Empty batch request"));
      }

      const results = [];
      let newSessionId = null;
      for (const request of body) {
        const { response, sessionId: sid } = await handleJsonRpcRequest(request);
        if (sid) newSessionId = sid;
        if (response) results.push(response);
      }
      if (newSessionId) res.setHeader("Mcp-Session-Id", newSessionId);
      return res.json(results);
    }

    if (!body || typeof body !== "object" || !body.jsonrpc) {
      return res.status(400).json(jsonRpcError(null, -32700, "Invalid JSON-RPC request"));
    }

    const sessionId = req.headers["mcp-session-id"];
    if (sessionId) {
      if (!sessions.has(sessionId)) {
        return res.status(404).json(jsonRpcError(body.id || null, -32600, "Invalid or expired session"));
      }
      touchSession(sessionId);
    } else if (body.method !== "initialize") {
      const hasAnySessions = sessions.size > 0;
      if (hasAnySessions) {
      }
    }

    const { response, sessionId: newSessionId } = await handleJsonRpcRequest(body);

    if (newSessionId) {
      res.setHeader("Mcp-Session-Id", newSessionId);
    }

    if (response === null) {
      return res.status(204).end();
    }

    res.json(response);
  });

  app.get("/mcp", mcpAuth, (req, res) => {
    const accept = req.headers["accept"] || "";
    if (accept.includes("text/event-stream")) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.write("event: ping\ndata: {}\n\n");

      const interval = setInterval(() => {
        res.write("event: ping\ndata: {}\n\n");
      }, 30000);

      req.on("close", () => {
        clearInterval(interval);
      });
      return;
    }

    res.json({
      name: SERVER_INFO.name,
      version: SERVER_INFO.version,
      protocol: "MCP Streamable HTTP",
      protocolVersion: "2025-03-26",
      tools: TOOLS.length,
      status: "ready",
    });
  });

  app.delete("/mcp", mcpAuth, (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (sessionId && sessions.has(sessionId)) {
      sessions.delete(sessionId);
    }
    res.status(204).end();
  });

  setInterval(() => {
    const maxAge = 4 * 60 * 60 * 1000;
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastUsed > maxAge) {
        sessions.delete(id);
      }
    }

    for (const [ip, entry] of rateLimits) {
      if (now - entry.windowStart > RATE_LIMIT_WINDOW * 2) {
        rateLimits.delete(ip);
      }
    }
  }, 60 * 60 * 1000);

  console.log("[mcp] ElevenLabs MCP server mounted at /mcp");
}

module.exports = { mountMcp };
