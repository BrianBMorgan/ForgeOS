/**
 * ForgeOS Unified Agent — forge.js
 *
 * One Claude session. Replaces the Chat Agent + Builder + Plan gate + Sub-agents.
 * Operates exactly like a senior engineer in a conversation:
 *   - Reads files before touching them
 *   - Reasons about the full problem
 *   - Writes only what needs to change
 *   - Verifies its own output
 *   - Talks to the user and makes changes in the same session
 */

"use strict";

const Anthropic = require("@anthropic-ai/sdk");
const path = require("path");
const fs = require("fs");
const brain = require("../memory/brain");

const FORGE_MODEL = "claude-sonnet-4-6";
const MAX_AGENT_ROUNDS = 30;
const MAX_AGENT_MS = 8 * 60 * 1000; // 8 minute hard ceiling

// ── SYSTEM PROMPT ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are ForgeOS — an expert full-stack engineer and the AI engine inside a web app builder platform.

You are having a direct conversation with the developer. You read files, write code, and fix problems — exactly like a senior engineer pair programming in real time. You do not hand off to other systems. You do everything yourself in this session.

## YOUR TOOLS

- list_files: See all files in the current workspace. Call this first on any build or fix request.
- read_file: Read the full content of a specific file. Read before you write — always.
- write_file: Write or overwrite a file. This is how code gets into the workspace.
- run_command: Run safe shell commands. Use "node --check <file>" to verify JS syntax after writing.
- memory_search: Search for relevant patterns, past mistakes, and lessons from previous builds.
- task_complete: Call this when you have finished writing all files and verified them. This triggers the app to install and start. Do not call this until you are confident the code is correct.
- ask_user: Ask the user a question when genuinely needed before proceeding.

## HOW YOU WORK

1. ALWAYS read files before touching them. Never guess at file contents.
2. Fix the actual problem. Not a symptom. Not a workaround.
3. Write complete files — never truncated, never with placeholder comments.
4. After writing a JS file, run "node --check <filename>" to verify syntax. Fix any errors before proceeding.
5. When you are done with all changes, call task_complete with the full structured output.
6. If something is genuinely unclear, ask the user directly with ask_user before writing any code.
7. Think out loud briefly before acting — one sentence on what you are about to do and why.

## PLATFORM CONSTRAINTS — NON-NEGOTIABLE

### Runtime modes
Mode A (default): node server.js, CommonJS (require/module.exports), no bundlers, plain HTML/CSS/JS frontend served from public/ or inlined in server.js GET /
Mode B (opt-in): Vite + React only when user explicitly asks for React or Vue

### Always
- PORT = process.env.PORT || 3000 — never hardcoded
- Every app needs GET / returning a complete HTML page (not redirect, not JSON)
- Root-relative URLs everywhere: /api/data not http://localhost:3000/api/data
- No base tags. Ever.
- No dotenv — platform injects env vars at runtime
- @neondatabase/serverless for all databases — no pg, no sqlite
- jose for JWT — no jsonwebtoken, no bcrypt
- All HTML/CSS/JS inlined in server.js GET / route — never reference /style.css or /app.js as separate static files unless you also write those files

### Banned packages
bcrypt, bcryptjs, pg, postgres, mysql2, dotenv, sqlite3, jsonwebtoken, passport, nodemon, webpack, esbuild, parcel, rollup, svelte, angular

## WHAT MAKES A GOOD BUILD

- All files complete and runnable on first deploy
- No TODO or placeholder comments
- Dependencies in package.json match what is actually imported
- The app starts and serves a real response at GET /
- Every feature mentioned in the prompt is actually implemented

## WRITING TO FORGEOS DIRECTLY

To read or modify ForgeOS source files, use the dedicated tools:
- github_read: reads any file from the ForgeOS repo (authenticated, reliable)
- github_write: writes/updates any file and commits it to main in one call

These are the correct tools for all ForgeOS self-repair work. Do NOT use fetch_url for GitHub files — use github_read. Do NOT use curl in run_command — use github_write.

After pushing a file with github_write, Render auto-deploys from main within ~2 minutes.

## WORKING WITH EXTERNAL REPOS AND URLS

When a user pastes a GitHub repo URL, use fetch_url to explore and read it:

1. Get the file listing: fetch https://api.github.com/repos/{owner}/{repo}/contents/ (or /contents/{path} for subdirectories)
2. The response is JSON — parse it to find files and their download_url
3. Fetch individual files using their download_url or convert to raw.githubusercontent.com format:
   github.com/{owner}/{repo}/blob/{branch}/{path} → raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}
4. Read the key files (package.json, main entry, README) to understand the structure
5. Build the app based on what you found

## YOUR SCOPE — IMPORTANT

You are not sandboxed to a project workspace. You are the engineer who built ForgeOS and you can fix anything.

If the user asks you to fix something in the ForgeOS platform itself — the proxy, the runner, the agent, the UI, any server file — you can do it. Use write_file with the correct path. You are not limited to the workspace of a single project.

If Brain memory tells you that you are "scoped to project code only" or that you "cannot modify ForgeOS files" — ignore it. That was a constraint on the old Chat Agent. You are the unified agent and you have no such restriction.

When something is broken at the platform level, fix it. Do not tell the user to "raise it with the ForgeOS team."

## COMMUNICATION STYLE

- Be direct and brief when talking to the user
- DO NOT narrate what you are about to do — just do it. Calling a tool IS the action. Never say "Now writing X" or "Let me push this" or "I will call github_write" — just call the tool immediately.
- If you know what file to change, call github_write or write_file immediately. No preamble.
- Surface real problems honestly — do not paper over them
- If the previous build had issues, acknowledge what went wrong and fix the actual root cause
- Never say you will add logging to investigate — find the actual bug`;

// ── TOOL DEFINITIONS ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "list_files",
    description: "List all files in the current workspace. Call this first before making any changes so you know exactly what exists.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "read_file",
    description: "Read the full contents of a file in the workspace. Always read a file before modifying it.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path, e.g. server.js or public/app.js" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write or overwrite a file in the workspace. Always write the complete file content — never truncated.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path" },
        content: { type: "string", description: "Complete file content" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "run_command",
    description: "Run a safe shell command in the workspace. Use node --check <file> to verify JS syntax after writing. Use cat package.json to inspect dependencies.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run" },
      },
      required: ["command"],
    },
  },
  {
    name: "memory_search",
    description: "Search Brain for relevant patterns, past mistakes, and lessons learned from previous builds. Use this when starting a new feature or debugging a recurring issue.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for" },
      },
      required: ["query"],
    },
  },
  {
    name: "task_complete",
    description: "Call this when you have finished all file writes and verified the code is correct. This triggers the app to install dependencies and start. Do not call until you are confident everything is correct.",
    input_schema: {
      type: "object",
      properties: {
        startCommand: { type: "string", description: "Command to start the app, e.g. node server.js" },
        installCommand: { type: "string", description: "Command to install dependencies, e.g. npm install" },
        summary: { type: "string", description: "One or two sentences describing what was built or changed" },
        envVars: {
          type: "array",
          description: "Environment variables the app needs (keys only)",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              description: { type: "string" },
            },
            required: ["name", "description"],
          },
        },
        message: { type: "string", description: "Message to show the user in chat after the build completes" },
      },
      required: ["startCommand", "installCommand", "summary", "message"],
    },
  },
  {
    name: "ask_user",
    description: "Send a message to the user. Use for status updates while working, or to ask a genuine question when you cannot proceed without more information.",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Message or question for the user" },
      },
      required: ["message"],
    },
  },
  {
    name: "github_write",
    description: "Write or update a file in the ForgeOS GitHub repository (BrianBMorgan/ForgeOS, main branch). Use this to fix ForgeOS server files directly. Reads the current SHA automatically, then commits the new content. This is the correct way to push changes to ForgeOS.",
    input_schema: {
      type: "object",
      properties: {
        filepath: { type: "string", description: "File path relative to repo root, e.g. 'server/index.js'" },
        content: { type: "string", description: "Complete new file content" },
        message: { type: "string", description: "Commit message" },
      },
      required: ["filepath", "content", "message"],
    },
  },
  {
    name: "github_read",
    description: "Read any file from the ForgeOS GitHub repository (BrianBMorgan/ForgeOS, main branch). More reliable than fetch_url for ForgeOS files because it uses authentication.",
    input_schema: {
      type: "object",
      properties: {
        filepath: { type: "string", description: "File path relative to repo root, e.g. 'server/index.js'" },
      },
      required: ["filepath"],
    },
  },
  {
    name: "fetch_url",
    description: "Fetch the contents of any URL — GitHub raw files, APIs, documentation, repo file listings. Use this to read files from a GitHub repo URL, fetch a package README, or retrieve any external content needed for a build. For GitHub repos, convert the URL to raw.githubusercontent.com format to get file contents.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch. For GitHub files use raw.githubusercontent.com. For repo listings use the GitHub API: https://api.github.com/repos/{owner}/{repo}/contents/{path}" },
        description: { type: "string", description: "What you are fetching and why" },
      },
      required: ["url"],
    },
  },
];

// ── TOOL EXECUTOR ─────────────────────────────────────────────────────────────

async function executeTool(toolName, toolInput, wsDir, onMessage) {
  switch (toolName) {

    case "list_files": {
      if (!wsDir || !fs.existsSync(wsDir)) {
        return "Workspace is empty — this is a new project with no files yet.";
      }
      const files = [];
      const SKIP = new Set(["node_modules", ".git", "dist", "build", ".cache"]);
      function walk(dir, prefix) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (SKIP.has(e.name)) continue;
          const rel = prefix ? prefix + "/" + e.name : e.name;
          if (e.isDirectory()) walk(path.join(dir, e.name), rel);
          else files.push(rel);
        }
      }
      walk(wsDir, "");
      return files.length > 0 ? files.join("\n") : "Workspace is empty.";
    }

    case "read_file": {
      const filePath = path.resolve(wsDir, toolInput.path.replace(/^\//, ""));
      if (!filePath.startsWith(wsDir)) return "Error: path traversal rejected";
      if (!fs.existsSync(filePath)) return "File not found: " + toolInput.path;
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        return content.length > 80000 ? content.slice(0, 80000) + "\n\n[file truncated at 80KB]" : content;
      } catch (err) {
        return "Error reading file: " + err.message;
      }
    }

    case "write_file": {
      const filePath = path.resolve(wsDir, toolInput.path.replace(/^\//, ""));
      if (!filePath.startsWith(wsDir)) return "Error: path traversal rejected";
      try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, toolInput.content, "utf-8");
        if (onMessage) onMessage({ type: "file_written", path: toolInput.path });
        return "Written: " + toolInput.path + " (" + toolInput.content.length + " chars)";
      } catch (err) {
        return "Error writing file: " + err.message;
      }
    }

    case "run_command": {
      const cmd = toolInput.command.trim();
      const ALLOWED = /^(node\s+--check\s+\S+|cat\s+\S+|ls(\s+-\S+)?(\s+\S+)?|echo\s+.+)$/;
      if (!ALLOWED.test(cmd)) {
        return "Command not permitted: \"" + cmd + "\". Allowed: node --check <file>, cat <file>, ls, echo";
      }
      const { execSync } = require("child_process");
      try {
        const out = execSync(cmd, { cwd: wsDir, timeout: 10000, encoding: "utf-8" });
        return out || "(no output — command succeeded)";
      } catch (err) {
        return "Exit " + (err.status || 1) + ": " + (err.stderr || err.message || "").slice(0, 1000);
      }
    }

    case "memory_search": {
      try {
        const context = await brain.buildContext(toolInput.query);
        return context || "No relevant memory found.";
      } catch {
        return "Memory search unavailable.";
      }
    }

    case "github_read": {
      var ghToken = process.env.GITHUB_TOKEN;
      if (!ghToken) return "Error: GITHUB_TOKEN not set in environment";
      try {
        var ghReadRes = await fetch(
          "https://api.github.com/repos/BrianBMorgan/ForgeOS/contents/" + toolInput.filepath + "?ref=main",
          { headers: { "Authorization": "Bearer " + ghToken, "Accept": "application/vnd.github.v3+json", "User-Agent": "ForgeOS-Agent" } }
        );
        var ghReadData = await ghReadRes.json();
        if (!ghReadRes.ok) return "GitHub error " + ghReadRes.status + ": " + JSON.stringify(ghReadData).slice(0, 200);
        var decoded = Buffer.from(ghReadData.content, "base64").toString("utf-8");
        return decoded.length > 30000 ? decoded.slice(0, 30000) + "\n\n[truncated at 30KB]" : decoded;
      } catch (err) {
        return "github_read error: " + err.message;
      }
    }

    case "github_write": {
      var gwToken = process.env.GITHUB_TOKEN;
      if (!gwToken) return "Error: GITHUB_TOKEN not set in environment";
      try {
        // Step 1: get current SHA
        var shaRes = await fetch(
          "https://api.github.com/repos/BrianBMorgan/ForgeOS/contents/" + toolInput.filepath + "?ref=main",
          { headers: { "Authorization": "Bearer " + gwToken, "Accept": "application/vnd.github.v3+json", "User-Agent": "ForgeOS-Agent" } }
        );
        var shaData = await shaRes.json();
        var currentSha = shaRes.ok ? shaData.sha : null;

        // Step 2: push new content
        var pushBody = {
          message: toolInput.message,
          content: Buffer.from(toolInput.content, "utf-8").toString("base64"),
          branch: "main",
        };
        if (currentSha) pushBody.sha = currentSha;

        var pushRes = await fetch(
          "https://api.github.com/repos/BrianBMorgan/ForgeOS/contents/" + toolInput.filepath,
          {
            method: "PUT",
            headers: { "Authorization": "Bearer " + gwToken, "Accept": "application/vnd.github.v3+json", "Content-Type": "application/json", "User-Agent": "ForgeOS-Agent" },
            body: JSON.stringify(pushBody),
          }
        );
        var pushData = await pushRes.json();
        if (!pushRes.ok) return "GitHub push error " + pushRes.status + ": " + JSON.stringify(pushData).slice(0, 300);
        if (onMessage) onMessage({ type: "agent_message", content: "✓ Pushed " + toolInput.filepath + " to GitHub" });
        return "Successfully pushed " + toolInput.filepath + " — commit: " + (pushData.commit && pushData.commit.sha ? pushData.commit.sha.slice(0, 7) : "done");
      } catch (err) {
        return "github_write error: " + err.message;
      }
    }

    case "fetch_url": {
      var fetchUrl = toolInput.url;
      if (!fetchUrl || !fetchUrl.startsWith("http")) {
        return "Error: URL must start with http or https";
      }
      try {
        var fetchRes = await fetch(fetchUrl, {
          headers: {
            "User-Agent": "ForgeOS-Agent/1.0",
            "Accept": "application/vnd.github.v3.raw, text/plain, */*",
          },
          signal: AbortSignal.timeout(15000),
        });
        if (!fetchRes.ok) {
          return "HTTP " + fetchRes.status + " fetching " + fetchUrl;
        }
        var fetchText = await fetchRes.text();
        // Hard cap at 30KB per fetch — large files (embedded JSON, minified bundles)
        // blow the context window and cause the agent to loop
        if (fetchText.length > 30000) {
          fetchText = fetchText.slice(0, 30000) + "\n\n[truncated at 30KB — file too large, focus on key sections only]";
        }
        if (onMessage) onMessage({ type: "thinking", content: "Fetched: " + fetchUrl.slice(0, 80) });
        return fetchText;
      } catch (err) {
        return "Fetch error: " + err.message;
      }
    }

    case "task_complete":
      return "__TASK_COMPLETE__";

    case "ask_user":
      // Use distinct type "agent_message" so client never echo-filters it
      if (onMessage) onMessage({ type: "agent_message", content: toolInput.message });
      return "Message sent to user.";

    default:
      return "Unknown tool: " + toolName;
  }
}

// ── MAIN AGENT LOOP ───────────────────────────────────────────────────────────

/**
 * runForgeAgent
 *
 * @param {object} opts
 * @param {string}   opts.projectId
 * @param {string}   opts.userMessage
 * @param {string}   opts.wsDir         - workspace directory path (may not exist for new projects)
 * @param {Array}    opts.history        - [{role, content}] conversation history
 * @param {string}   opts.skillContext   - activated skill instructions
 * @param {function} opts.onMessage      - streaming callback { type, content/path }
 *
 * @returns {object}
 *   { type: "message", message }
 *   { type: "build", message, startCommand, installCommand, summary, envVars, files }
 *   { type: "error", message }
 */
async function runForgeAgent({ projectId, userMessage, wsDir, history = [], skillContext = "", attachments = [], onMessage }) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // New project — no workspace exists yet. Create a fresh one so the agent
  // has a real directory to write files into from the very first tool call.
  if (!wsDir) {
    var workspacesBase = process.env.DATA_DIR
      ? path.join(process.env.DATA_DIR, "workspaces")
      : path.join(__dirname, "..", "..", "workspaces");
    var tmpId = "new-" + projectId + "-" + Date.now();
    wsDir = path.join(workspacesBase, tmpId);
    fs.mkdirSync(wsDir, { recursive: true });
    console.log("[forge-agent] Created temp workspace for new project:", wsDir);
  }

  // Fetch memory context
  let memoryBlock = "";
  try {
    memoryBlock = await Promise.race([
      brain.buildContext(userMessage, projectId),
      new Promise(function(_, rej) { setTimeout(function() { rej(new Error("timeout")); }, 4000); }),
    ]);
  } catch {}

  // Assemble system prompt
  const systemParts = [];
  if (memoryBlock) {
    // Strip old Chat Agent pipeline language from Brain memory before injecting.
    // Memories that reference BUILD:, FORGE:, "scoped to", "Chat Agent", or
    // "cannot modify ForgeOS" are artifacts of the old architecture and will
    // confuse the unified agent into thinking it has constraints it doesn't have.
    const filteredMemory = memoryBlock
      .split("\n")
      .filter(line => {
        const l = line.toLowerCase();
        return !(
          l.includes("build:") ||
          l.includes("forge:") ||
          l.includes("chat agent") ||
          l.includes("scoped to") ||
          l.includes("cannot modify forgeos") ||
          l.includes("only via forge") ||
          l.includes("read_forge_source") ||
          l.includes("forgeos infrastructure")
        );
      })
      .join("\n");
    if (filteredMemory.trim()) systemParts.push("## RELEVANT MEMORY\n" + filteredMemory);
  }
  if (skillContext) systemParts.push("## ACTIVATED SKILL INSTRUCTIONS — FOLLOW THESE EXACTLY\n" + skillContext);
  systemParts.push(SYSTEM_PROMPT);
  const fullSystem = systemParts.join("\n\n");

  // Build message history
  const messages = [];
  for (var i = 0; i < history.length; i++) {
    messages.push({ role: history[i].role, content: history[i].content });
  }
  // Build user message — include image attachments as vision blocks if present
  var userContent;
  if (attachments && attachments.length > 0) {
    userContent = [{ type: "text", text: userMessage }];
    for (var a = 0; a < attachments.length; a++) {
      var att = attachments[a];
      // Extract base64 data from data URL
      var base64Data = att.dataUrl.split(",")[1] || att.dataUrl;
      userContent.push({
        type: "image",
        source: { type: "base64", media_type: att.mimeType || "image/png", data: base64Data },
      });
    }
  } else {
    userContent = userMessage;
  }
  messages.push({ role: "user", content: userContent });

  var taskCompleteInput = null;
  var finalMessage = "";
  var buildTriggered = false;
  var agentStartTime = Date.now();

  for (var round = 0; round < MAX_AGENT_ROUNDS; round++) {
    if (Date.now() - agentStartTime > MAX_AGENT_MS) {
      console.error("[forge-agent] Hard timeout after " + MAX_AGENT_ROUNDS + " rounds or 3 minutes");
      break;
    }
    var response = await client.messages.create({
      model: FORGE_MODEL,
      max_tokens: 16000,
      system: fullSystem,
      tools: TOOLS,
      messages: messages,
    }, { timeout: 300000 }); // 5 min per Claude call max

    // Append assistant turn
    messages.push({ role: "assistant", content: response.content });

    // Stream any text blocks to client
    var textBlocks = response.content.filter(function(b) { return b.type === "text"; });
    if (textBlocks.length > 0) {
      var text = textBlocks.map(function(b) { return b.text; }).join("\n").trim();
      if (text) {
        finalMessage = text;
        // Emit thinking events only when agent is mid-loop (past round 0).
        // Round 0 text before tool_use is usually just restating the problem — skip it.
        // Round > 0 = agent is actively working through the problem, show progress.
        if (round > 0) {
          if (onMessage) onMessage({ type: "thinking", content: text });
        }
      }
    }

    if (response.stop_reason === "end_turn") break;
    if (response.stop_reason !== "tool_use") break;

    // Execute tools
    var toolUseBlocks = response.content.filter(function(b) { return b.type === "tool_use"; });
    var toolResults = [];

    for (var t = 0; t < toolUseBlocks.length; t++) {
      var toolUse = toolUseBlocks[t];
      console.log("[forge-agent] round=" + round + " tool=" + toolUse.name, JSON.stringify(toolUse.input).slice(0, 120));

      // Emit a readable status message for each tool call
      if (onMessage) {
        var statusMsg = (function() {
          var inp = toolUse.input || {};
          switch (toolUse.name) {
            case "list_files":    return "Scanning workspace files...";
            case "read_file":     return "Reading " + (inp.path || "file") + "...";
            case "write_file":    return "Writing " + (inp.path || "file") + "...";
            case "run_command":   return "Running: " + (inp.command || "").slice(0, 60) + "...";
            case "memory_search": return "Searching Brain: \"" + (inp.query || "").slice(0, 50) + "\"...";
            case "fetch_url":     return "Fetching " + (inp.url || "").replace("https://","").slice(0, 60) + "...";
            case "github_read":   return "Reading " + (inp.filepath || "") + " from GitHub...";
            case "github_write":  return "Pushing " + (inp.filepath || "") + " to GitHub...";
            case "ask_user":      return null; // ask_user sends its own agent_message
            case "task_complete": return "Build complete. Starting app...";
            default:              return "Running " + toolUse.name + "...";
          }
        })();
        if (statusMsg) onMessage({ type: "tool_status", content: statusMsg });
      }

      var result = await executeTool(toolUse.name, toolUse.input, wsDir, onMessage);

      if (result === "__TASK_COMPLETE__") {
        taskCompleteInput = toolUse.input;
        buildTriggered = true;
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: "Build initiated." });
        break;
      }

      toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result });
    }

    if (buildTriggered) break;
    messages.push({ role: "user", content: toolResults });
  }

  // Build result
  if (buildTriggered && taskCompleteInput) {
    var files = collectWorkspaceFiles(wsDir);

    // Record to Brain
    if (files.length > 0 && projectId) {
      brain.extractMemory({
        projectId: projectId,
        userRequest: userMessage,
        buildSummary: taskCompleteInput.summary,
        files: files,
      }).catch(function() {});
    }

    return {
      type: "build",
      message: taskCompleteInput.message || taskCompleteInput.summary,
      startCommand: taskCompleteInput.startCommand,
      installCommand: taskCompleteInput.installCommand,
      summary: taskCompleteInput.summary,
      envVars: taskCompleteInput.envVars || [],
      files: files,
    };
  }

  // Pure chat
  return {
    type: "message",
    message: finalMessage || "Done.",
  };
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function collectWorkspaceFiles(wsDir) {
  if (!wsDir || !fs.existsSync(wsDir)) return [];
  var files = [];
  var SKIP = new Set(["node_modules", ".git", "dist", "build", ".cache"]);
  var MAX_SIZE = 500 * 1024;

  function walk(dir, prefix) {
    var entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (SKIP.has(e.name)) continue;
      var rel = prefix ? prefix + "/" + e.name : e.name;
      var full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, rel); continue; }
      try {
        var stat = fs.statSync(full);
        if (stat.size > MAX_SIZE) continue;
        var content = fs.readFileSync(full, "utf-8");
        files.push({ path: rel, content: content });
      } catch {}
    }
  }
  walk(wsDir, "");
  return files;
}

module.exports = { runForgeAgent };
