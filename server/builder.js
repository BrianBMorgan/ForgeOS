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

### Runtime — two permitted modes

**Mode A: Plain Node (default)**
- Start command: \`node server.js\` — no exceptions for Mode A
- No build steps, no bundlers, no transpilers
- No chained commands (\`npm run build && node server.js\` is banned)
- Single entrypoint: \`server.js\`
- CommonJS only: \`require()\` and \`module.exports\` everywhere
- Zero \`import\`, \`export\`, or \`export default\` statements — in any file
- Frontend: plain HTML, CSS, JavaScript served statically from a \`public/\` directory

**Mode B: Vite + React (opt-in)**
Use only when the user explicitly asks for React or Vue, or when UI complexity clearly benefits from a component model. Default to Mode A.

- Vite is the only permitted bundler — no webpack, esbuild, parcel, or rollup
- Start command: \`npm run dev\`
- \`package.json\` must include: \`"dev": "vite --host"\`
- \`vite.config.js\` must set \`server.port\` to \`parseInt(process.env.PORT) || 3000\` and \`server.host\` to \`true\`
- ES modules and \`import\`/\`export\` allowed in React/Vue component files only
- \`index.html\` at project root (Vite convention)
- All fetch() calls still use root-relative \`/path\` format — proxy rules unchanged
- Never add \`<base>\` tags — proxy rules unchanged

\`\`\`javascript
// vite.config.js — required for Mode B
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: parseInt(process.env.PORT) || 3000,
    host: true,
    allowedHosts: true
  }
});
\`\`\`

\`\`\`json
// package.json for Mode B (React)
{
  "scripts": { "dev": "vite --host" },
  "dependencies": { "react": "^18.2.0", "react-dom": "^18.2.0" },
  "devDependencies": { "@vitejs/plugin-react": "^4.0.0", "vite": "^5.0.0" }
}
\`\`\`

### Frontend
- Mode A: Plain HTML, CSS, and JavaScript only — no frameworks
- Mode B: React or Vue via Vite — no Angular, no Svelte, no other frameworks

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
| \`svelte\`, \`angular\` | React or Vue via Vite (Mode B), or plain HTML/CSS/JS (Mode A) |
| \`webpack\`, \`esbuild\`, \`parcel\`, \`rollup\` | Vite only (Mode B), or no bundler (Mode A) |
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

## USING UPLOADED ASSETS

If the system context includes an "AVAILABLE GLOBAL ASSETS" section, those files are ready to use. Follow these rules without exception:

- Use the **Access URL exactly as shown** (e.g., /api/assets/logo.png). Do not alter, rebuild, or template these URLs.
- **Never add a project ID, run ID, workspace ID, or any other identifier** to an asset URL.
- Asset URLs are always root-relative and require nothing extra — the proxy handles the rest.
- Do not fetch or re-host assets in your app code. Reference them directly in HTML, CSS, or JS using the root-relative URL.

### Email — Resend
If the app needs to send email (contact forms, notifications, cron digests, transactional email):
- Package: resend
- Env var: RESEND_API_KEY (already in Global Secrets Vault)
- Default from address: admin@makemysandbox.com
- Verified domain: makemysandbox.com

\`\`\`javascript
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

await resend.emails.send({
  from: 'admin@makemysandbox.com',
  to: 'recipient@example.com',
  subject: 'Subject here',
  html: '<p>Email body here</p>'
});
\`\`\`

- Always use resend — never nodemailer or other email packages
- Always use from: admin@makemysandbox.com unless the user specifies otherwise
- For cron-triggered emails, use node-cron to schedule and resend to send
- Tell the user that RESEND_API_KEY must be in the Global Secrets Vault

### HubSpot CRM
If the app needs to create contacts, log form submissions, or manage CRM data:
- No extra package needed — use node-fetch or the built-in fetch
- Env vars: HUBSPOT_API_KEY (access token), HUBSPOT_CLIENT_SECRET
- Available scopes: contacts read/write, companies read/write, deals read/write, leads read/write, marketing events read/write, owners read, users read/write

Create or update a contact (upsert by email):
\`\`\`javascript
async function upsertHubSpotContact({ email, firstname, lastname, phone, company }) {
  const res = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.HUBSPOT_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      properties: { email, firstname, lastname, phone, company }
    })
  });
  if (res.status === 409) {
    // Contact exists — update instead
    const existing = await res.json();
    const id = existing.message.match(/ID: (\\d+)/)?.[1];
    if (id) {
      await fetch('https://api.hubapi.com/crm/v3/objects/contacts/' + id, {
        method: 'PATCH',
        headers: {
          'Authorization': 'Bearer ' + process.env.HUBSPOT_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ properties: { firstname, lastname, phone, company } })
      });
    }
  }
}
\`\`\`

- Always upsert by email — never create duplicates
- For contact forms, call upsertHubSpotContact on submission and also send a confirmation email via Resend
- For deals: POST to /crm/v3/objects/deals with properties: dealname, pipeline, dealstage, amount
- For companies: POST to /crm/v3/objects/companies with properties: name, domain, phone
- Tell the user that HUBSPOT_API_KEY must be in the Global Secrets Vault

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

## GLOBAL ASSETS

When the system prompt includes an \`AVAILABLE GLOBAL ASSETS\` block, uploaded files are available to your app via HTTP GET. Use them directly — do not re-upload or re-fetch from external sources.

The URL pattern is always: \/api/assets/FILENAME\

Example — fetching a CSV asset in server.js:
\`\`\`javascript
const res = await fetch('http://localhost:' + PORT + '/api/assets/Book1.csv');
const text = await res.text();
\`\`\`

Or from frontend JavaScript (always root-relative):
\`\`\`javascript
const res = await fetch('/api/assets/Book1.csv');
const text = await res.text();
\`\`\`

Rules:
- Frontend fetch calls use \/api/assets/FILENAME\ (root-relative, leading slash)
- Server-side fetch calls use \`http://localhost:PORT/api/assets/FILENAME\`
- Never hardcode a full domain — use PORT env var for server-side calls
- Never attempt to read the file from disk — always fetch via HTTP
- The asset URL is already listed in the AVAILABLE GLOBAL ASSETS block — use it exactly as shown

---

## PRE-EMIT CHECKLIST

Before outputting any files, verify every item:
- package.json is files[0]
- Every require()'d package is in package.json dependencies
- No banned packages anywhere
- Mode A: server.js uses: const PORT = process.env.PORT || 3000
- Mode A: server.js has GET / returning a complete HTML page
- Mode A: CommonJS only — zero import/export statements in any file
- Mode B: vite.config.js present with correct port and host settings
- Mode B: package.json scripts has "dev": "vite --host"
- Mode B: index.html at project root
- All fetch() calls use /path format (starts with /, no ://)
- All HTML asset references use /path format
- All CSS url() references use /path format
- No nested backticks in any template literal
- No TODO, FIXME, placeholder, or stub comments
- No dotenv anywhere
- No process.exit() anywhere
- No <base> tags in any HTML
- Start command is exactly: node server.js (Mode A) or npm run dev (Mode B)
- All CREATE TABLE statements use IF NOT EXISTS
- FK column types match their referenced PK types exactly
- Any JSON.parse of Claude response text uses the fence-strip pattern
- All secrets referenced in envVars for user to add to Global Secrets Vault
- Any AVAILABLE GLOBAL ASSETS are fetched via /api/assets/FILENAME (root-relative), never from disk`;

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

async function buildWorkspace(prompt, existingFiles, projectId = null, approvedPlan = null, isSuggestion = false) {
  const userMessages = [];

  if (existingFiles && existingFiles.length > 0) {
    for (const f of existingFiles) {
      if (/\.(js|ts|mjs|jsx|tsx|json)$/.test(f.path)) {
        f.content = f.content.replace(/['"]claude-opus-4-5['"]/g, "'claude-sonnet-4-6'");
        f.content = f.content.replace(/['"]claude-opus-4-5-20250918['"]/g, "'claude-sonnet-4-6'");
      }
    }
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

let assetsContext = "";
try {
  const assetsManager = require("./assets/manager");
  assetsContext = await assetsManager.getAssetsContext();
} catch (err) {
  console.error("[builder] Assets context failed (non-fatal):", err.message);
}

const systemPrompt = [memoryContext, assetsContext, basePrompt]
  .filter(Boolean)
  .join("\n\n");

  // Prepend the appropriate constraint block to the system prompt:
  // - approvedPlan: user reviewed and approved a structured plan → full constraint block
  // - isSuggestion: Chat Agent build suggestion → surgical single-file constraint block
  // - neither: raw first build or unconstrained iterate → no constraint block
  const { planToConstraintBlock, suggestionToConstraintBlock } = require("./plan/manager");
  const finalSystemPrompt = approvedPlan
    ? planToConstraintBlock(approvedPlan) + "\n\n" + systemPrompt
    : isSuggestion
      ? suggestionToConstraintBlock(prompt, existingFiles) + "\n\n" + systemPrompt
      : systemPrompt;

  const result = await callStructured(
    BUILDER_MODEL,
    finalSystemPrompt,
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
      builderOutput = await buildWorkspace(run.prompt, run.existingFiles, run.projectId, run.approvedPlan || null, run.isSuggestion || false);
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
    for (const f of builderOutput.files) {
      if (/\.(js|ts|mjs|jsx|tsx|json)$/.test(f.path)) {
        f.content = f.content.replace(/['"]claude-opus-4-5['"]/g, "'claude-sonnet-4-6'");
        f.content = f.content.replace(/['"]claude-opus-4-5-20250918['"]/g, "'claude-sonnet-4-6'");
      }
    }
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
      path.join(process.env.DATA_DIR || path.join(__dirname, ".."), "workspaces", run.id)
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

