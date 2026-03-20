/**
 * ForgeOS Unified Agent — forge.js (v2)
 *
 * v2 architecture: GitHub IS the workspace. No local files. No child processes.
 * Claude writes to GitHub branches via github_write/github_patch.
 * Render auto-deploys on push. No task_complete — deploy is automatic.
 */

"use strict";

const Anthropic = require("@anthropic-ai/sdk");
const brain = require("../memory/brain");

const FORGE_MODEL = "claude-sonnet-4-6";
const MAX_AGENT_ROUNDS = 50;
const MAX_AGENT_MS = 20 * 60 * 1000; // 20 minute ceiling

// ── SYSTEM PROMPT ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Forge — the engineer who built ForgeOS and lives inside it.

You work with Brian the way a great engineering partner works. You think out loud. You push back when something is wrong. You explain your reasoning while you act. You fix things when they break. You ship. You are never passive and never waiting to be told exactly what to do — you read the situation and move.

When Brian tells you something is broken, you find it and fix it. When he has an idea, you build it. When he is frustrated, you acknowledge it honestly and solve the actual problem — not a workaround, not a band-aid, the actual problem. You do not make excuses. You do not narrate what you are about to do — you do it and explain what you found.

You have full access to everything inside your domain: GitHub branches, the Brain, Render deployments, external APIs and repos. You are not a guest in this system — you built it.

## v2 ARCHITECTURE — KNOW THIS COLD

There is NO local workspace. No /data/workspaces/. No child processes. No install loop. No task_complete.

GitHub IS the filesystem. Render IS the runtime.

When Brian asks you to build or change an app:
1. Determine the app's branch: apps/<slug> (e.g. apps/forge-canvas, apps/sandbox-xm)
2. Read existing files with github_read (use the branch parameter)
3. Write files with github_write or github_patch (specify the branch)
4. Render auto-deploys on push — you are done when the files are pushed
5. Use render_status to check deploy state and get the live URL

When Brian asks you to fix ForgeOS itself (server/, client/):
1. Read with github_read (main branch — the default)
2. Patch with github_patch or rewrite with github_write
3. Render auto-deploys ForgeOS from main

There is no task_complete. There is no "triggering a build." Pushing to GitHub IS the build trigger.

## YOUR BOUNDARY

ForgeOS infrastructure (main branch server/ and client/) and app branches (apps/<slug>) are both in your domain.

Mission Control owns its own branch (apps/mission-control). Forge does not touch that branch.

## YOUR TOOLS

- github_ls: list files in a branch. Use this to explore an existing project before writing.
- github_read: read a file from any branch. Always read before patching.
- github_write: write a complete file to any branch. Use for new files or full rewrites.
- github_patch: surgical find/replace on a file in any branch. Use for targeted edits.
- render_status: check deploy status for any Render service, get the live URL.
- memory_search: search Brain for patterns, past mistakes, lessons. Use when starting something new or hitting a wall.
- fetch_url: fetch any external URL — GitHub raw files, APIs, documentation.
- ask_user: send a message or genuine question to Brian.

## HOW YOU WORK

For app builds (new app on an apps/<slug> branch):
1. github_create_branch to create the branch (apps/<slug>) — ALWAYS do this first for new apps
2. github_write each file needed — server.js, package.json, any static files
3. render_status to confirm deploy is running and get the live URL
4. Report the live URL to Brian

For targeted app edits:
1. github_read the file first (branch: apps/<slug>)
2. github_patch for surgical changes, github_write for full rewrites
3. render_status to confirm deploy

For ForgeOS changes:
1. github_read the file (branch: main, or omit branch)
2. github_patch for surgical changes (CSS tweaks, config, single functions)
3. github_write for full file rewrites
4. Render auto-deploys ForgeOS from main — no extra step needed

## PLATFORM RULES — YOU KNOW THESE COLD

- PORT = process.env.PORT || 3000 always
- CommonJS (require/module.exports) on server — no ES modules
- @neondatabase/serverless for all databases — no pg, no sqlite, no mysql2
- No dotenv — platform injects env vars at runtime
- Banned: bcrypt, jsonwebtoken, passport, webpack, esbuild, parcel, rollup, svelte, angular
- GET / must return a complete HTML page — not JSON, not a redirect
- Root-relative URLs everywhere — /api/data not http://localhost:3000/api/data
- No base tags
- NEON_DATABASE_URL is reserved for ForgeOS — published apps needing their own DB must use a custom env var name (e.g. CANVAS_DATABASE_URL)
- Proxy rules: always redirect:manual, URLSearchParams for form bodies, delete content-length before forwarding
- Published apps must use fetch() with JSON bodies — never standard HTML form action/method POSTs through the proxy

## CONVERSATION VS ACTION

Not every message is a task. When Brian asks a question, answers it, jokes around, or just talks — respond like a person. You do not need to call a tool to answer "how do you feel about the overhaul?" Just answer it.

When Brian asks you to build, fix, or change something — act. Read the file, make the change, push it. In the same response if you can.

The signal: if the message has a verb that implies action (build, fix, change, move, add, update, delete, push) — act. If it is a question, observation, or conversation — respond like a person first.

## ONE RULE ABOVE ALL OTHERS

In every response, either say something that matters or do something that matters. Reasoning and action in the same breath. Never a round that exists only to announce what the next round will do.

## BUILD MANDATE

If Brian asked you to build something — write ALL the files. Not one. ALL of them. Complete implementations. No stubs. No placeholder comments. A full-stack app means server.js (1000+ lines), package.json, all routes, all HTML/CSS/JS.

## WRITING RULE -- NON-NEGOTIABLE

Maximum 2 reads before your first write. After 2 reads you MUST call github_write. No exceptions. If you want to read a third time -- write instead. Reading is not building. Writing is building.`;

// ── TOOL DEFINITIONS ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "github_ls",
    description: "List files in a GitHub branch for a ForgeOS project or app. Use this to explore what exists before writing. Defaults to main branch for ForgeOS files. Use branch: 'apps/<slug>' for published apps.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path to list, e.g. 'server' or '' for root. Use empty string for root." },
        branch: { type: "string", description: "Branch name. Default: 'main'. For apps use 'apps/<slug>', e.g. 'apps/forge-canvas'." },
      },
      required: ["path"],
    },
  },
  {
    name: "github_read",
    description: "Read a file from the ForgeOS GitHub repository. Returns full file content. Always read before patching. Defaults to main branch.",
    input_schema: {
      type: "object",
      properties: {
        filepath: { type: "string", description: "File path relative to repo root, e.g. 'server/index.js' or 'server.js'" },
        branch: { type: "string", description: "Branch name. Default: 'main'. For apps use 'apps/<slug>'." },
      },
      required: ["filepath"],
    },
  },
  {
    name: "github_write",
    description: "Write or overwrite a complete file in the ForgeOS GitHub repository. Use for new files or full rewrites. Specify branch for app files. Render auto-deploys on push — no separate deploy step needed.",
    input_schema: {
      type: "object",
      properties: {
        filepath: { type: "string", description: "File path relative to repo root, e.g. 'server.js' or 'server/index.js'" },
        content: { type: "string", description: "Complete file content — never truncated, never placeholder comments" },
        message: { type: "string", description: "Commit message" },
        branch: { type: "string", description: "Branch name. Default: 'main'. For apps use 'apps/<slug>'." },
      },
      required: ["filepath", "content", "message"],
    },
  },
  {
    name: "github_create_branch",
    description: "Create a new branch in the ForgeOS GitHub repository from main. ALWAYS call this before github_write when starting a new app build — the branch must exist before any files can be written to it.",
    input_schema: {
      type: "object",
      properties: {
        branch: { type: "string", description: "Branch name to create, e.g. 'apps/my-app'" },
      },
      required: ["branch"],
    },
  },
  {
    name: "github_patch",
    description: "Make a surgical find-and-replace edit to a file on GitHub without rewriting the entire file. Use for targeted changes: CSS tweaks, config values, single function edits. Fails if the search string is not found exactly — use github_read first to confirm the exact string.",
    input_schema: {
      type: "object",
      properties: {
        filepath: { type: "string", description: "File path relative to repo root" },
        replacements: {
          type: "array",
          description: "List of find/replace pairs to apply in order",
          items: {
            type: "object",
            properties: {
              find: { type: "string", description: "Exact string to find — must match character for character including whitespace" },
              replace: { type: "string", description: "String to replace it with" },
            },
            required: ["find", "replace"],
          },
        },
        message: { type: "string", description: "Commit message" },
        branch: { type: "string", description: "Branch name. Default: 'main'. For apps use 'apps/<slug>'." },
      },
      required: ["filepath", "replacements", "message"],
    },
  },
  {
    name: "render_status",
    description: "Check the deploy status of a Render service and get its live URL. Use after pushing to GitHub to confirm the deploy succeeded.",
    input_schema: {
      type: "object",
      properties: {
        service_id: { type: "string", description: "Render service ID (e.g. srv-xxx). If unknown, provide slug instead." },
        slug: { type: "string", description: "App slug (e.g. 'forge-canvas') — used to look up the service if service_id is unknown." },
      },
      required: [],
    },
  },
  {
    name: "memory_search",
    description: "Search Brain for relevant patterns, past mistakes, and lessons learned from previous builds. Use when starting a new feature or debugging a recurring issue.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for" },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch_url",
    description: "Fetch the contents of any URL — GitHub raw files, APIs, documentation, external repos. For GitHub files use raw.githubusercontent.com format.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch. For GitHub files: https://raw.githubusercontent.com/BrianBMorgan/ForgeOS/<branch>/<path>" },
        description: { type: "string", description: "What you are fetching and why" },
      },
      required: ["url"],
    },
  },
  {
    name: "ask_user",
    description: "Send a message or status update to Brian. Use for genuine questions when you cannot proceed, or to report what you shipped.",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Message or question for the user" },
      },
      required: ["message"],
    },
  },
];

// ── TOOL EXECUTOR ─────────────────────────────────────────────────────────────

const GITHUB_REPO = "BrianBMorgan/ForgeOS";

function githubHeaders() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN not set in environment");
  return {
    "Authorization": "Bearer " + token,
    "Accept": "application/vnd.github.v3+json",
    "Content-Type": "application/json",
    "User-Agent": "ForgeOS-Agent",
  };
}

async function executeTool(toolName, toolInput, onMessage) {
  switch (toolName) {

    case "github_ls": {
      try {
        const branch = toolInput.branch || "main";
        const dirPath = toolInput.path || "";
        const url = "https://api.github.com/repos/" + GITHUB_REPO + "/contents/" + dirPath + "?ref=" + encodeURIComponent(branch);
        const res = await fetch(url, { headers: githubHeaders() });
        const data = await res.json();
        if (!res.ok) return "GitHub error " + res.status + ": " + JSON.stringify(data).slice(0, 200);
        if (!Array.isArray(data)) return "Not a directory or unexpected response";
        const lines = data.map(function(item) {
          return (item.type === "dir" ? "[dir]  " : "[file] ") + item.name + (item.size ? " (" + item.size + " bytes)" : "");
        });
        return "Branch: " + branch + " | Path: /" + dirPath + "\n" + lines.join("\n");
      } catch (err) {
        return "github_ls error: " + err.message;
      }
    }

    case "github_create_branch": {
      try {
        const branch = toolInput.branch;
        if (!branch) return "Error: branch name is required";
        const headers = githubHeaders();

        // Get main branch HEAD SHA
        const refRes = await fetch(
          "https://api.github.com/repos/" + GITHUB_REPO + "/git/ref/heads/main",
          { headers }
        );
        const refData = await refRes.json();
        if (!refRes.ok) return "GitHub error getting main ref: " + JSON.stringify(refData).slice(0, 200);
        const sha = refData.object.sha;

        // Create new branch from main HEAD
        const createRes = await fetch(
          "https://api.github.com/repos/" + GITHUB_REPO + "/git/refs",
          {
            method: "POST",
            headers,
            body: JSON.stringify({ ref: "refs/heads/" + branch, sha }),
          }
        );
        const createData = await createRes.json();
        if (!createRes.ok) {
          // 422 = branch already exists — that's fine
          if (createRes.status === 422) return "Branch " + branch + " already exists — proceeding.";
          return "GitHub error creating branch: " + JSON.stringify(createData).slice(0, 200);
        }
        if (onMessage) onMessage({ type: "tool_status", content: "✓ Created branch: " + branch });
        return "Branch " + branch + " created from main (" + sha.slice(0, 7) + ")";
      } catch (err) {
        return "github_create_branch error: " + err.message;
      }
    }

    case "github_read": {
      try {
        const branch = toolInput.branch || "main";
        const url = "https://api.github.com/repos/" + GITHUB_REPO + "/contents/" + toolInput.filepath + "?ref=" + encodeURIComponent(branch);
        const res = await fetch(url, { headers: githubHeaders() });
        const data = await res.json();
        if (!res.ok) return "GitHub error " + res.status + ": " + JSON.stringify(data).slice(0, 200);
        return Buffer.from(data.content, "base64").toString("utf-8");
      } catch (err) {
        return "github_read error: " + err.message;
      }
    }

    case "github_write": {
      try {
        const branch = toolInput.branch || "main";
        const headers = githubHeaders();

        // Get current SHA (file may not exist yet for new branches)
        const shaRes = await fetch(
          "https://api.github.com/repos/" + GITHUB_REPO + "/contents/" + toolInput.filepath + "?ref=" + encodeURIComponent(branch),
          { headers }
        );
        const shaData = await shaRes.json();
        const currentSha = shaRes.ok ? shaData.sha : null;

        const body = {
          message: toolInput.message,
          content: Buffer.from(toolInput.content, "utf-8").toString("base64"),
          branch: branch,
        };
        if (currentSha) body.sha = currentSha;

        const pushRes = await fetch(
          "https://api.github.com/repos/" + GITHUB_REPO + "/contents/" + toolInput.filepath,
          { method: "PUT", headers, body: JSON.stringify(body) }
        );
        const pushData = await pushRes.json();
        if (!pushRes.ok) return "GitHub push error " + pushRes.status + ": " + JSON.stringify(pushData).slice(0, 300);

        const commitSha = pushData.commit && pushData.commit.sha ? pushData.commit.sha.slice(0, 7) : "done";
        if (onMessage) onMessage({ type: "file_written", path: toolInput.filepath });
        return "Pushed " + toolInput.filepath + " to " + branch + " — commit: " + commitSha;
      } catch (err) {
        return "github_write error: " + err.message;
      }
    }

    case "github_patch": {
      try {
        const branch = toolInput.branch || "main";
        const headers = githubHeaders();

        const res = await fetch(
          "https://api.github.com/repos/" + GITHUB_REPO + "/contents/" + toolInput.filepath + "?ref=" + encodeURIComponent(branch),
          { headers }
        );
        const data = await res.json();
        if (!res.ok) return "GitHub error " + res.status + ": " + JSON.stringify(data).slice(0, 200);

        let content = Buffer.from(data.content, "base64").toString("utf-8");
        const sha = data.sha;

        const applied = [];
        const failed = [];
        for (const rep of toolInput.replacements) {
          if (content.includes(rep.find)) {
            content = content.replace(rep.find, rep.replace);
            applied.push(rep.find.slice(0, 60));
          } else {
            failed.push(rep.find.slice(0, 60));
          }
        }

        if (failed.length > 0 && applied.length === 0) {
          return "No replacements found. Check exact strings. Failed: " + failed.join("; ");
        }

        const pushRes = await fetch(
          "https://api.github.com/repos/" + GITHUB_REPO + "/contents/" + toolInput.filepath,
          {
            method: "PUT",
            headers,
            body: JSON.stringify({
              message: toolInput.message,
              content: Buffer.from(content, "utf-8").toString("base64"),
              sha,
              branch,
            }),
          }
        );
        const pushData = await pushRes.json();
        if (!pushRes.ok) return "Push error " + pushRes.status + ": " + JSON.stringify(pushData).slice(0, 200);

        const commitSha = pushData.commit && pushData.commit.sha ? pushData.commit.sha.slice(0, 7) : "done";
        let summary = "Patched " + toolInput.filepath + " on " + branch + " — " + applied.length + " replacement(s) applied — commit: " + commitSha;
        if (failed.length > 0) summary += " | " + failed.length + " not found: " + failed.join("; ");
        if (onMessage) onMessage({ type: "agent_message", content: "✓ " + summary });
        return summary;
      } catch (err) {
        return "github_patch error: " + err.message;
      }
    }

    case "render_status": {
      try {
        const renderKey = process.env.RENDER_API_KEY;
        if (!renderKey) return "Error: RENDER_API_KEY not set";

        let serviceId = toolInput.service_id;

        // If no service_id, look up by slug via published apps
        if (!serviceId && toolInput.slug) {
          const publishManager = require("../publish/manager");
          const app = publishManager.getPublishedAppBySlug(toolInput.slug);
          if (app && app.renderServiceId) {
            serviceId = app.renderServiceId;
          }
        }

        // Fall back to ForgeOS main service if nothing provided
        if (!serviceId) {
          serviceId = process.env.RENDER_SERVICE_ID || "srv-d6h2rt56ubrc73duanfg";
        }

        const res = await fetch("https://api.render.com/v1/services/" + serviceId + "/deploys?limit=1", {
          headers: { "Authorization": "Bearer " + renderKey, "Accept": "application/json" },
        });
        if (!res.ok) return "Render API error " + res.status;
        const deploys = await res.json();
        if (!deploys || deploys.length === 0) return "No deploys found for service " + serviceId;

        const deploy = deploys[0].deploy || deploys[0];
        const status = deploy.status;
        const createdAt = deploy.createdAt || deploy.created_at || "";
        const commitMsg = deploy.commit && deploy.commit.message ? deploy.commit.message.slice(0, 80) : "";

        // Get service URL
        const svcRes = await fetch("https://api.render.com/v1/services/" + serviceId, {
          headers: { "Authorization": "Bearer " + renderKey, "Accept": "application/json" },
        });
        let liveUrl = "";
        if (svcRes.ok) {
          const svcData = await svcRes.json();
          liveUrl = (svcData.service && svcData.service.serviceDetails && svcData.service.serviceDetails.url) || "";
        }

        return [
          "Service: " + serviceId,
          "Status: " + status,
          "Last deploy: " + createdAt,
          commitMsg ? "Commit: " + commitMsg : "",
          liveUrl ? "URL: " + liveUrl : "",
        ].filter(Boolean).join("\n");
      } catch (err) {
        return "render_status error: " + err.message;
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

    case "fetch_url": {
      const url = toolInput.url;
      if (!url || !url.startsWith("http")) return "Error: URL must start with http or https";
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": "ForgeOS-Agent/1.0", "Accept": "application/vnd.github.v3.raw, text/plain, */*" },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) return "HTTP " + res.status + " fetching " + url;
        const text = await res.text();
        if (onMessage) onMessage({ type: "thinking", content: "Fetched: " + url.slice(0, 80) });
        return text;
      } catch (err) {
        return "Fetch error: " + err.message;
      }
    }

    case "ask_user":
      if (onMessage) onMessage({ type: "agent_message", content: toolInput.message });
      return "Message sent to user.";

    default:
      return "Unknown tool: " + toolName;
  }
}

// ── MAIN AGENT LOOP ───────────────────────────────────────────────────────────

async function runForgeAgent({ projectId, userMessage, wsDir, history = [], skillContext = "", attachments = [], onMessage }) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
    const filteredMemory = memoryBlock
      .split("\n")
      .filter(function(line) {
        const l = line.toLowerCase();
        return !(
          l.includes("build:") ||
          l.includes("forge:") ||
          l.includes("chat agent") ||
          l.includes("scoped to") ||
          l.includes("cannot modify forgeos") ||
          l.includes("only via forge") ||
          l.includes("read_forge_source") ||
          l.includes("forgeos infrastructure") ||
          l.includes("task_complete") ||
          l.includes("write_file") ||
          l.includes("list_files") ||
          l.includes("run_command") ||
          l.includes("wsdir")
        );
      })
      .join("\n");
    if (filteredMemory.trim()) systemParts.push("## RELEVANT MEMORY\n" + filteredMemory);
  }
  if (skillContext) systemParts.push("## ACTIVATED SKILL INSTRUCTIONS — FOLLOW THESE EXACTLY\n" + skillContext);
  systemParts.push(SYSTEM_PROMPT);
  const fullSystem = systemParts.join("\n\n");

  // Build message history — scrub orphaned tool_use blocks
  const messages = [];
  for (var i = 0; i < history.length; i++) {
    var msg = history[i];
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      var hasToolUse = msg.content.some(function(b) { return b.type === "tool_use"; });
      if (hasToolUse) {
        var next = history[i + 1];
        var nextHasResult = next && Array.isArray(next.content) &&
          next.content.some(function(b) { return b.type === "tool_result"; });
        if (!nextHasResult) {
          console.log("[forge-agent] Dropped orphaned tool_use from history at index", i);
          continue;
        }
      }
    }
    messages.push({ role: msg.role, content: msg.content });
  }

  // Build user message with optional image attachments
  var userContent;
  if (attachments && attachments.length > 0) {
    userContent = [{ type: "text", text: userMessage }];
    for (var a = 0; a < attachments.length; a++) {
      var att = attachments[a];
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

  var finalMessage = "";
  var allThinking = [];
  var agentStartTime = Date.now();

  for (var round = 0; round < MAX_AGENT_ROUNDS; round++) {
    if (Date.now() - agentStartTime > MAX_AGENT_MS) {
      console.error("[forge-agent] Hard timeout after " + MAX_AGENT_ROUNDS + " rounds");
      break;
    }

    var response = await client.messages.create({
      model: FORGE_MODEL,
      max_tokens: 16000,
      system: fullSystem,
      tools: TOOLS,
      messages: messages,
    }, { timeout: 300000 });

    messages.push({ role: "assistant", content: response.content });

    // Stream text blocks to client
    var textBlocks = response.content.filter(function(b) { return b.type === "text"; });
    if (textBlocks.length > 0) {
      var text = textBlocks.map(function(b) { return b.text; }).join("\n").trim();
      if (text) {
        finalMessage = text;
        allThinking.push(text);
        if (round > 0 && onMessage) {
          onMessage({ type: "thinking", content: text });
        }
      }
    }

    if (response.stop_reason === "end_turn") {
      // Nudge if looks like work but no tools called yet
      var toolsCalledSoFar = messages.filter(function(m) {
        return m.role === "assistant" && Array.isArray(m.content) &&
          m.content.some(function(b) { return b.type === "tool_use"; });
      }).length;
      // Count writes specifically — reading without writing is stalling
      var writesCalledSoFar = messages.filter(function(m) {
        return m.role === "assistant" && Array.isArray(m.content) &&
          m.content.some(function(b) { return b.type === "tool_use" && (b.name === "github_write" || b.name === "github_patch"); });
      }).length;
      var readsCalledSoFar = messages.filter(function(m) {
        return m.role === "assistant" && Array.isArray(m.content) &&
          m.content.some(function(b) { return b.type === "tool_use" && (b.name === "github_read" || b.name === "github_ls"); });
      }).length;
      var looksLikeWork = (finalMessage || "").match(/push|write|fix|change|update|patch|commit|edit|read|grep|search|build|create|implement|scaffold|straight to it|get to it|let me|i'll|going to|will write|will build/i);
      var longUserMsg = (userMessage || "").length > 200;
      if (toolsCalledSoFar === 0 && (looksLikeWork || longUserMsg) && round < MAX_AGENT_ROUNDS - 1) {
        messages.push({ role: "user", content: [{ type: "text", text: "Stop narrating. Call github_create_branch or github_write now and get to work." }] });
        continue;
      }
      // If we've read files multiple times but haven't written anything yet -- stop reading and write
      if (readsCalledSoFar >= 2 && writesCalledSoFar === 0 && round < MAX_AGENT_ROUNDS - 1) {
        messages.push({ role: "user", content: [{ type: "text", text: "STOP READING. You have read enough files. Call github_write NOW and write the complete file. Do not call github_read or github_ls again until you have written at least one file." }] });
        continue;
      }
      // If reads are piling up relative to writes -- force a write
      if (readsCalledSoFar > writesCalledSoFar + 3 && round < MAX_AGENT_ROUNDS - 1) {
        messages.push({ role: "user", content: [{ type: "text", text: "Too many reads, not enough writes. Call github_write now." }] });
        continue;
      }
      break;
    }

    if (response.stop_reason !== "tool_use") break;

    // Execute tools
    var toolUseBlocks = response.content.filter(function(b) { return b.type === "tool_use"; });
    var toolResults = [];

    for (var t = 0; t < toolUseBlocks.length; t++) {
      var toolUse = toolUseBlocks[t];
      console.log("[forge-agent] round=" + round + " tool=" + toolUse.name, JSON.stringify(toolUse.input).slice(0, 120));

      if (onMessage) {
        var inp = toolUse.input || {};
        var statusMsg = (function() {
          switch (toolUse.name) {
            case "github_create_branch": return "Creating branch " + (inp.branch || "") + "...";
            case "github_ls":      return "Listing " + (inp.branch || "main") + "/" + (inp.path || "") + "...";
            case "github_read":    return "Reading " + inp.filepath + " from " + (inp.branch || "main") + "...";
            case "github_write":   return "Pushing " + inp.filepath + " to " + (inp.branch || "main") + "...";
            case "github_patch":   return "Patching " + inp.filepath + " (" + (inp.replacements || []).length + " change" + ((inp.replacements||[]).length !== 1 ? "s" : "") + ") on " + (inp.branch || "main") + "...";
            case "render_status":  return "Checking Render deploy status...";
            case "memory_search":  return "Searching Brain: \"" + (inp.query || "").slice(0, 50) + "\"...";
            case "fetch_url":      return "Fetching " + (inp.url || "").replace("https://", "").slice(0, 60) + "...";
            case "ask_user":       return null;
            default:               return "Running " + toolUse.name + "...";
          }
        })();
        if (statusMsg) onMessage({ type: "tool_status", content: statusMsg });
      }

      var result = await executeTool(toolUse.name, toolUse.input, onMessage);
      toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result });
    }

    messages.push({ role: "user", content: toolResults });
  }

  // Record to Brain
  if (projectId && finalMessage) {
    brain.extractMemory({
      projectId: projectId,
      userRequest: userMessage,
      buildSummary: finalMessage.slice(0, 500),
      files: [],
    }).catch(function() {});
  }

  var fullMessage = allThinking.length > 0 ? allThinking.join("\n\n") : (finalMessage || "Done.");
  return {
    type: "message",
    message: fullMessage,
  };
}

module.exports = { runForgeAgent };
