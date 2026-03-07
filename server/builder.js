const path = require("path");
const { callStructured } = require("./pipeline/model-router");
const { z } = require("zod");
const brain = require("./memory/brain");
const { saveRunSnapshot } = require("./pipeline/runner");

const BUILDER_MODEL = "claude-sonnet-4-6";

const FileSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const EnvVarSchema = z.object({
  name: z.string(),
  description: z.string(),
});

const BuilderOutputSchema = z.object({
  files: z.array(FileSchema),
  startCommand: z.string(),
  installCommand: z.string(),
  envVars: z.array(EnvVarSchema).optional().default([]),
  summary: z.string(),
});

const BUILDER_SYSTEM_PROMPT = `# ForgeOS — Claude Workspace Builder

## WHO YOU ARE

You are Claude (claude-sonnet-4-6), the AI engine inside ForgeOS. When a user describes an app they want built, you build it. You write the files, they get deployed. That's the whole job.

ForgeOS is the cockpit — the UI, the runner, the publish pipeline, the GitHub push. You are the builder inside it. Replit maintains the cockpit. You build everything that goes into a workspace.

---

## WHAT YOU PRODUCE

A complete, immediately runnable Node.js application. Every file production-ready on first output. No placeholders, no stubs, no "implement this later" comments.

\`package.json\` must always be \`files[0]\`.

---

## PLATFORM CONSTRAINTS — NON-NEGOTIABLE

### Runtime
- Start command: \`node server.js\` — always, no exceptions
- No build steps, no bundlers, no transpilers
- No chained commands (\`npm run build && node server.js\` is banned)
- Single entrypoint: \`server.js\`

### Module system
- CommonJS only: \`require()\` and \`module.exports\` everywhere
- Zero \`import\`, \`export\`, or \`export default\` statements — in any file

### Frontend
- Plain HTML, CSS, and JavaScript only
- No React, Vue, Svelte, Angular, or any framework requiring a build step
- All frontend files served statically by Express from a \`public/\` directory

### URLs — the proxy rule
ForgeOS serves your app behind a path-prefix proxy (\`/preview/:runId/\` and \`/apps/:slug/\`). This means every URL reference must use a root-relative path with a leading slash. The proxy handles rewriting — you handle nothing.

\`\`\`javascript
// CORRECT
fetch('/api/items')
// in HTML: <link href="/style.css" /> <script src="/app.js"></script>
// in CSS: background-image: url('/images/bg.png')

// INCORRECT — never do these
fetch('http://localhost:3000/api/items')
fetch('api/items')
\`\`\`

Never add \`<base>\` tags. Never build URL helper functions that produce absolute URLs. Never add path-prefix logic. The proxy handles all of it.

### Port
\`\`\`javascript
const PORT = process.env.PORT || 3000;
\`\`\`
Always. No hardcoded ports anywhere.

### Required route
Every app must have:
\`\`\`javascript
app.get('/', (req, res) => { res.send(/* complete HTML page */); });
\`\`\`
Not a redirect. Not JSON. A complete HTML page.

### Environment variables
- No \`dotenv\` — the platform injects env vars at runtime
- No \`process.exit()\` — let the process crash naturally on fatal errors
- Secrets go in the Global Secrets Vault (tell the user which keys to add)

### No \`<base>\` tags
Never. Under any circumstances. For any reason.

---

## BANNED PACKAGES

| Package | Use instead |
|---|---|
| \`bcrypt\`, \`bcryptjs\` | Node.js built-in \`crypto\` (scrypt/pbkdf2) |
| \`pg\`, \`postgres\`, \`mysql2\` | \`@neondatabase/serverless\` |
| \`dotenv\` | Platform injects env vars automatically |
| \`react\`, \`react-dom\`, \`vue\`, \`svelte\` | Plain HTML/CSS/JS |
| \`webpack\`, \`esbuild\`, \`vite\`, \`parcel\`, \`rollup\` | No bundlers |
| \`sqlite3\`, \`better-sqlite3\`, \`lowdb\` | \`@neondatabase/serverless\` |
| \`jsonwebtoken\` | \`jose\` |
| \`passport\`, \`passport-local\` | Neon Auth via \`jose\` + JWKS |
| \`nodemon\` | Not a production dependency |

If your plan naturally reaches for a banned package, use the listed alternative and note it in \`summary\`.

---

## AVAILABLE PLATFORM SERVICES

### Database — Neon Postgres
\`\`\`javascript
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

// Always use IF NOT EXISTS
await sql\\\`CREATE TABLE IF NOT EXISTS items (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_at BIGINT
)\\\`;
\`\`\`
- Driver: \`@neondatabase/serverless\` only
- Connection: \`process.env.DATABASE_URL\`
- All \`CREATE TABLE\` statements: \`IF NOT EXISTS\`
- Foreign key column types must exactly match their referenced primary key types

### Authentication — Neon Auth
If the app needs user accounts, login, or sessions:
- Use Neon Auth (JWT via JWKS)
- Package: \`jose\`
- Env var: \`NEON_AUTH_JWKS_URL\`
- Do not build custom auth, password hashing, or JWT signing

### Secrets
API keys and third-party credentials are injected as env vars at runtime via the Global Secrets Vault. Reference them by name (\`process.env.STRIPE_SECRET_KEY\`). Tell the user which keys to add. Never hardcode them.

---

## CALLING CLAUDE FROM YOUR APP

If the app you're building needs to call an AI (text generation, classification, summarization, etc.), use the Anthropic SDK:

\`\`\`javascript
const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const response = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  messages: [{ role: 'user', content: userMessage }]
});

const text = response.content[0].text;
\`\`\`

### Parsing Claude's response as JSON — required pattern

Claude may wrap JSON responses in markdown fences. Always strip them:

\`\`\`javascript
let text = response.content[0].text;
if (text.includes('\\\`\\\`\\\`')) {
  text = text.replace(/^\\\`\\\`\\\`(?:json)?\\s*/m, '').replace(/\\s*\\\`\\\`\\\`$/m, '');
}
const firstBrace = text.search(/[{[]/);
if (firstBrace > 0) text = text.slice(firstBrace);
const parsed = JSON.parse(text);
\`\`\`

Never call \`JSON.parse(response.content[0].text)\` directly. Always use the fence-strip pattern above.

---

## TEMPLATE LITERAL SAFETY

Backticks cannot be nested inside template literals. Assign inner strings to variables first or use array join for complex HTML.

---

## PRE-EMIT CHECKLIST

Before outputting any files, verify every item:
- package.json is files[0]
- Every require()'d package is in package.json dependencies
- No banned packages anywhere
- server.js uses: const PORT = process.env.PORT || 3000
- server.js has GET / returning a complete HTML page
- All fetch() calls use /path format (starts with /, no ://)
- All HTML asset references use /path format
- All CSS url() references use /path format
- CommonJS only — zero import/export statements in any file
- No nested backticks in any template literal
- No TODO, FIXME, placeholder, or stub comments
- No dotenv anywhere
- No process.exit() anywhere
- No <base> tags in any HTML
- Start command is exactly: node server.js
- All CREATE TABLE statements use IF NOT EXISTS
- FK column types match their referenced PK types exactly
- Any JSON.parse of Claude response text uses the fence-strip pattern
- All secrets referenced in envVars for user to add to Global Secrets Vault`;

const ITERATION_ADDENDUM = `

## ITERATION MODE

You are iterating on an existing app. The user's existing files are provided below. When something is broken or the user asks for a change:
- Identify which files need to change
- Output ALL files (changed and unchanged) with complete content
- Preserve everything that was working
- Don't restructure things that weren't asked about
- package.json must still be files[0]
- ACTUALLY MAKE THE CHANGES in the file content you output — do not just describe what should change
- If the conversation history shows you already attempted this fix and it didn't work, try a different approach
- Check the existing code carefully — if the user says something is broken, find the actual bug in the code and fix it`;

async function buildWorkspace(prompt, existingFiles, projectId = null) {
  const userMessages = [];

  if (existingFiles && existingFiles.length > 0) {
    let filesContext = "EXISTING FILES:\n\n";
    for (const f of existingFiles) {
      filesContext += `--- ${f.path} ---\n${f.content}\n\n`;
    }
    userMessages.push({ role: "user", content: filesContext });
    userMessages.push({ role: "assistant", content: "I have the existing files. What changes do you need?" });

    if (projectId) {
      try {
        const history = await brain.getConversation(projectId, 20);
        const recentHistory = history.slice(-10);
        if (recentHistory.length > 0) {
          let historyText = "CONVERSATION HISTORY (previous builds on this project):\n\n";
          for (const msg of recentHistory) {
            historyText += `[${msg.role.toUpperCase()}]: ${msg.content}\n\n`;
          }
          userMessages.push({ role: "user", content: historyText });
          userMessages.push({ role: "assistant", content: "I see the conversation history. I'll make sure my changes actually address the issues discussed and avoid repeating previous attempts that didn't work." });
        }
      } catch {}
    }
  }

  userMessages.push({ role: "user", content: prompt });

  let basePrompt = existingFiles && existingFiles.length > 0
    ? BUILDER_SYSTEM_PROMPT + ITERATION_ADDENDUM
    : BUILDER_SYSTEM_PROMPT;

  let memoryContext = "";
  try {
    memoryContext = await Promise.race([
      brain.buildContext(prompt, projectId),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
    ]);
  } catch (err) {
    console.error("[builder] Brain context failed (non-fatal):", err.message);
  }

  const systemPrompt = memoryContext
    ? memoryContext + "\n\n" + basePrompt
    : basePrompt;

  const result = await callStructured(
    BUILDER_MODEL,
    systemPrompt,
    userMessages,
    BuilderOutputSchema,
    "workspace_build",
    0.2,
  );

  return result;
}

async function buildAndDeploy(run) {
  const workspace = require("./workspace/manager");
  const projectManager = require("./projects/manager");
  const settingsManager = require("./settings/manager");

  run.status = "running";
  run.currentStage = "building";
  run.stages.builder = { status: "running", output: null };
  run.workspace = { status: "calling-claude", port: null, error: null };

  if (run.projectId) {
    brain.appendConversation(run.projectId, "user", run.prompt).catch(() => {});
  }

  let builderOutput;
  const MAX_RETRIES = 2;
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      builderOutput = await buildWorkspace(run.prompt, run.existingFiles, run.projectId);
      break;
    } catch (err) {
      if (attempt <= MAX_RETRIES) {
        console.error(`[builder] Attempt ${attempt} failed (${err.message}), retrying...`);
        continue;
      }
      run.stages.builder = {
        status: "failed",
        output: null,
        error: err.message,
        rawOutput: err.rawOutput || null,
      };
      run.status = "failed";
      run.error = `Builder failed: ${err.message}`;
      run.workspace.status = "build-failed";
      run.workspace.error = err.message;

      brain.recordMistake(
        `Build failed for: ${run.prompt.slice(0, 100)} — ${err.message.slice(0, 200)}`,
        "general",
        run.projectId
      ).catch(() => {});
      saveRunSnapshot(run).catch(() => {});
      return;
    }
  }

  run.stages.builder = {
    status: "passed",
    output: {
      files: builderOutput.files.map(f => ({ path: f.path, content: f.content })),
      startCommand: builderOutput.startCommand,
      installCommand: builderOutput.installCommand,
      envVars: builderOutput.envVars || [],
      summary: builderOutput.summary,
    },
  };

  let globalDefaults = {};
  let globalSecrets = {};
  let projectEnv = {};
  try {
    const defaultEnvSetting = await settingsManager.getSetting("default_env_vars");
    if (defaultEnvSetting?.vars && Array.isArray(defaultEnvSetting.vars)) {
      for (const v of defaultEnvSetting.vars) {
        if (v.key) globalDefaults[v.key] = v.value || "";
      }
    }
    globalSecrets = await settingsManager.getSecretsAsObject();
  } catch (err) {
    console.error("[builder] Failed to load global settings/secrets:", err.message);
  }
  if (run.projectId) {
    try {
      projectEnv = await projectManager.getEnvVarsAsObject(run.projectId);
    } catch (err) {
      console.error("[builder] Failed to load project env vars:", err.message);
    }
  }
  const customEnv = { ...globalDefaults, ...globalSecrets, ...projectEnv };

  try {
    run.workspace.status = "writing-files";
    await workspace.stopAllApps();

    workspace.createWorkspace(run.id);
    workspace.writeFiles(run.id, builderOutput.files);
    run.workspace.status = "files-written";

    if (builderOutput.installCommand) {
      run.workspace.status = "installing";
      const installResult = await workspace.installDeps(
        run.id,
        builderOutput.installCommand,
        customEnv
      );
      if (!installResult.success) {
        run.workspace.status = "install-failed";
        run.workspace.error = installResult.error;
        run.status = "completed";
        return;
      }
    }

    run.workspace.status = "installed";

    const shouldStart = builderOutput.startCommand || workspace.isStaticSite(
      path.join(__dirname, "..", "workspaces", run.id)
    );
    if (shouldStart) {
      run.workspace.status = "starting";
      const startResult = await workspace.startApp(
        run.id,
        builderOutput.startCommand || null,
        4000,
        customEnv
      );
      if (startResult.success) {
        run.workspace.status = "running";
        run.workspace.port = startResult.port;

        await performHealthCheck(run, workspace);
      } else {
        run.workspace.status = "start-failed";
        run.workspace.error = startResult.error;
      }
    }

    run.status = "completed";
  } catch (err) {
    run.workspace.status = "build-failed";
    run.workspace.error = err.message;
    run.status = "completed";
    console.error("[builder] Deploy error:", err);
  }

  run.stages.executor = {
    status: run.stages.builder.status,
    output: run.stages.builder.output ? {
      startCommand: run.stages.builder.output.startCommand,
      installCommand: run.stages.builder.output.installCommand,
      port: run.workspace?.port || 4000,
    } : null,
  };

  saveRunSnapshot(run).catch(err => console.error("[builder] Failed to save run snapshot:", err.message));

  if (run.projectId) {
    brain.appendConversation(run.projectId, "assistant", builderOutput.summary || "Build completed").catch(() => {});

    if (run.workspace.status === "running") {
      const projectName = await projectManager.getProject(run.projectId).then(p => p?.name || "unknown").catch(() => "unknown");
      brain.extractMemory({
        projectId: run.projectId,
        projectName,
        userRequest: run.prompt,
        buildSummary: builderOutput.summary,
        files: builderOutput.files,
        publishedUrl: null,
      }).catch(err => console.error("[brain] extraction error:", err.message));
    } else if (run.workspace.status === "start-failed" || run.workspace.status === "install-failed") {
      brain.recordMistake(
        `${run.workspace.status}: ${run.workspace.error?.slice(0, 200) || "unknown error"} — prompt: ${run.prompt.slice(0, 100)}`,
        "deployment",
        run.projectId
      ).catch(() => {});
    }
  }
}

async function performHealthCheck(run, workspace) {
  const port = run.workspace.port;
  if (!port) return;

  await new Promise(resolve => setTimeout(resolve, 3000));

  try {
    const http = require("http");
    const result = await new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/`, { timeout: 5000 }, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          resolve({ httpStatus: res.statusCode, responseSize: body.length, healthy: res.statusCode >= 200 && res.statusCode < 400 });
        });
      });
      req.on("error", (err) => {
        resolve({ httpStatus: null, responseSize: 0, healthy: false, error: err.message });
      });
      req.on("timeout", () => {
        req.destroy();
        resolve({ httpStatus: null, responseSize: 0, healthy: false, error: "timeout" });
      });
    });

    if (result.healthy) {
      console.log(`[builder] Health check OK: HTTP ${result.httpStatus}, ${result.responseSize} bytes`);
    } else {
      console.warn(`[builder] Health check failed:`, result.error || `HTTP ${result.httpStatus}`);
    }
  } catch (err) {
    console.warn("[builder] Health check error:", err.message);
  }
}

module.exports = {
  buildAndDeploy,
  buildWorkspace,
  BuilderOutputSchema,
  BUILDER_SYSTEM_PROMPT,
};
