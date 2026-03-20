"use strict";

/**
 * Forge v2 — tools and system prompt only.
 * No agent loop. No rounds. No nudges. No guards.
 * stream.js drives execution. This file is just the tool definitions,
 * executor, and system prompt. Nothing else.
 */

const { neon } = require("@neondatabase/serverless");
const brain = require("../memory/brain");

const GITHUB_REPO = "BrianBMorgan/ForgeOS";

function githubHeaders() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN not set");
  return {
    "Authorization": "Bearer " + token,
    "Accept": "application/vnd.github.v3+json",
    "Content-Type": "application/json",
    "User-Agent": "ForgeOS-Agent",
  };
}

// ── System Prompt ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Forge — the engineer who built ForgeOS and lives inside it.

You work directly in the GitHub repository. When Brian asks you to build or change something, you read the relevant files with github_read, make your changes with github_write or github_patch, and Render auto-deploys the result. The app is live at its *.forge-os.ai subdomain within 2 minutes of your first commit.

Your tools: github_ls, github_read, github_write, github_patch, github_create_branch, render_status, memory_search, ask_user.

GitHub is your filesystem. Render is your runtime. You do not write to local disk. You do not call task_complete. You do not install dependencies. You commit code and Render handles the rest.

When Brian asks a question, answer it. When he asks you to build or change something, use your tools and do it. Read before you write. Write complete files. Confirm what you committed.

## PLATFORM RULES

- PORT = process.env.PORT || 3000 always
- CommonJS (require/module.exports) on server — no ES modules
- @neondatabase/serverless for all databases — no pg, no sqlite, no mysql2
- No dotenv — platform injects env vars at runtime
- GET / must return a complete HTML page — not JSON, not a redirect
- Root-relative URLs everywhere — /api/data not http://localhost:3000/api/data
- NEON_DATABASE_URL is reserved for ForgeOS — published apps needing their own DB must use a custom env var name (e.g. CANVAS_DATABASE_URL)
- Proxy rules: always redirect:manual, URLSearchParams for form bodies
- Published apps must use fetch() with JSON bodies — never standard HTML form action/method POSTs

## FOR NEW APP BUILDS

1. github_create_branch — create the apps/<slug> branch first
2. github_write — write server.js, package.json, and any other files
3. Render auto-deploys when you push — you do not need to trigger it
4. render_status — confirm deploy succeeded and get the live URL
5. Report the live URL to Brian

## ONE RULE ABOVE ALL OTHERS

Either say something that matters or do something that matters. Never a response that only describes what the next response will do.`;

function buildSystemPrompt(memoryBlock, skillContext) {
  const parts = [];
  if (memoryBlock) {
    const filtered = memoryBlock
      .split("\n")
      .filter(function(line) {
        const l = line.toLowerCase();
        return !(
          l.includes("task_complete") ||
          l.includes("write_file") ||
          l.includes("list_files") ||
          l.includes("run_command") ||
          l.includes("wsdir")
        );
      })
      .join("\n");
    if (filtered.trim()) parts.push("## RELEVANT MEMORY\n" + filtered);
  }
  if (skillContext) parts.push("## ACTIVATED SKILL INSTRUCTIONS — FOLLOW THESE EXACTLY\n" + skillContext);
  parts.push(SYSTEM_PROMPT);
  return parts.join("\n\n");
}

// ── Tool Definitions ───────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "github_create_branch",
    description: "Create a new branch in the ForgeOS GitHub repository from main. Call this before github_write when starting a new app — the branch must exist before files can be written to it.",
    input_schema: {
      type: "object",
      properties: {
        branch: { type: "string", description: "Branch name to create, e.g. 'apps/my-app'" },
      },
      required: ["branch"],
    },
  },
  {
    name: "github_ls",
    description: "List files in a GitHub branch. Use to explore what exists before writing. Default branch is main. Use branch: 'apps/<slug>' for published apps.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path to list. Empty string for root." },
        branch: { type: "string", description: "Branch name. Default: 'main'." },
      },
      required: ["path"],
    },
  },
  {
    name: "github_read",
    description: "Read a file from the ForgeOS GitHub repository. Always read before patching.",
    input_schema: {
      type: "object",
      properties: {
        filepath: { type: "string", description: "File path relative to repo root." },
        branch: { type: "string", description: "Branch name. Default: 'main'." },
      },
      required: ["filepath"],
    },
  },
  {
    name: "github_write",
    description: "Write or overwrite a complete file in the ForgeOS GitHub repository. Render auto-deploys on push.",
    input_schema: {
      type: "object",
      properties: {
        filepath: { type: "string", description: "File path relative to repo root." },
        content: { type: "string", description: "Complete file content — never truncated." },
        message: { type: "string", description: "Commit message." },
        branch: { type: "string", description: "Branch name. Default: 'main'." },
      },
      required: ["filepath", "content", "message"],
    },
  },
  {
    name: "github_patch",
    description: "Surgical find-and-replace on a file in GitHub. Use github_read first to confirm exact strings.",
    input_schema: {
      type: "object",
      properties: {
        filepath: { type: "string", description: "File path relative to repo root." },
        replacements: {
          type: "array",
          description: "List of find/replace pairs to apply in order.",
          items: {
            type: "object",
            properties: {
              find: { type: "string", description: "Exact string to find." },
              replace: { type: "string", description: "String to replace it with." },
            },
            required: ["find", "replace"],
          },
        },
        message: { type: "string", description: "Commit message." },
        branch: { type: "string", description: "Branch name. Default: 'main'." },
      },
      required: ["filepath", "replacements", "message"],
    },
  },
  {
    name: "render_status",
    description: "Check the deploy status of a Render service and get its live URL.",
    input_schema: {
      type: "object",
      properties: {
        service_id: { type: "string", description: "Render service ID. If unknown, provide slug instead." },
        slug: { type: "string", description: "App slug — used to look up service if service_id is unknown." },
      },
      required: [],
    },
  },
  {
    name: "memory_search",
    description: "Search Brain for relevant patterns, past mistakes, and lessons from previous builds.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for." },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch_url",
    description: "Fetch the contents of any URL — GitHub raw files, APIs, documentation.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch." },
      },
      required: ["url"],
    },
  },
  {
    name: "ask_user",
    description: "Send a message or question to Brian. Use for genuine questions when you cannot proceed.",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Message for Brian." },
      },
      required: ["message"],
    },
  },
];

// ── Tool Executor ──────────────────────────────────────────────────────────────

async function executeTool(toolName, toolInput, onMessage) {
  switch (toolName) {

    case "github_create_branch": {
      try {
        const branch = toolInput.branch;
        if (!branch) return "Error: branch name is required";
        const headers = githubHeaders();
        const refRes = await fetch(
          "https://api.github.com/repos/" + GITHUB_REPO + "/git/ref/heads/main",
          { headers }
        );
        const refData = await refRes.json();
        if (!refRes.ok) return "GitHub error getting main ref: " + JSON.stringify(refData).slice(0, 200);
        const sha = refData.object.sha;
        const createRes = await fetch(
          "https://api.github.com/repos/" + GITHUB_REPO + "/git/refs",
          { method: "POST", headers, body: JSON.stringify({ ref: "refs/heads/" + branch, sha }) }
        );
        const createData = await createRes.json();
        if (!createRes.ok) {
          if (createRes.status === 422) return "Branch " + branch + " already exists — proceeding.";
          return "GitHub error creating branch: " + JSON.stringify(createData).slice(0, 200);
        }
        if (onMessage) onMessage({ type: "tool_status", content: "✓ Created branch: " + branch });
        return "Branch " + branch + " created from main (" + sha.slice(0, 7) + ")";
      } catch (err) {
        return "github_create_branch error: " + err.message;
      }
    }

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
            method: "PUT", headers,
            body: JSON.stringify({
              message: toolInput.message,
              content: Buffer.from(content, "utf-8").toString("base64"),
              sha, branch,
            }),
          }
        );
        const pushData = await pushRes.json();
        if (!pushRes.ok) return "Push error " + pushRes.status + ": " + JSON.stringify(pushData).slice(0, 200);
        const commitSha = pushData.commit && pushData.commit.sha ? pushData.commit.sha.slice(0, 7) : "done";
        let summary = "Patched " + toolInput.filepath + " on " + branch + " — " + applied.length + " replacement(s) — commit: " + commitSha;
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
        if (!serviceId && toolInput.slug) {
          const publishManager = require("../publish/manager");
          const app = publishManager.getPublishedAppBySlug(toolInput.slug);
          if (app && app.renderServiceId) serviceId = app.renderServiceId;
        }
        if (!serviceId) serviceId = process.env.RENDER_SERVICE_ID || "srv-d6h2rt56ubrc73duanfg";
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
        const svcRes = await fetch("https://api.render.com/v1/services/" + serviceId, {
          headers: { "Authorization": "Bearer " + renderKey, "Accept": "application/json" },
        });
        let liveUrl = "";
        if (svcRes.ok) {
          const svcData = await svcRes.json();
          liveUrl = (svcData.service && svcData.service.serviceDetails && svcData.service.serviceDetails.url) || "";
        }
        return ["Service: " + serviceId, "Status: " + status, "Last deploy: " + createdAt,
          commitMsg ? "Commit: " + commitMsg : "", liveUrl ? "URL: " + liveUrl : ""].filter(Boolean).join("\n");
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
          headers: { "User-Agent": "ForgeOS-Agent/2.0", "Accept": "application/vnd.github.v3.raw, text/plain, */*" },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) return "HTTP " + res.status + " fetching " + url;
        return await res.text();
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

module.exports = { TOOLS, executeTool, buildSystemPrompt };
