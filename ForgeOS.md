# ForgeOS

ForgeOS is a deployment GUI for AI-built web apps. Claude writes code directly to GitHub, Render auto-deploys on push, and ForgeOS handles env vars, assets, secrets, skills, memory, and deploy monitoring. The ForgeOS app itself is the cockpit — the IDE is Claude.

**Not** a Replit competitor. **Not** a sandboxed workspace builder. Every project is a GitHub branch (`apps/<slug>`) that auto-deploys to its own Render service and is served at `<slug>.forge-os.ai` via a wildcard subdomain proxy.

---

## Architecture Overview

### Deploy Chain
```
Frank (Claude) → GitHub (BrianBMorgan/ForgeOS) → Render → production (forge-os.ai)
```
- ForgeOS runtime itself lives on `main` and auto-deploys to `srv-d6h2rt56ubrc73duanfg`.
- Published apps live on `apps/<slug>` branches and auto-deploy to their own Render services.
- Replit is fully sunset. No local workspace runner. No build pipeline. No bundler orchestration.

### Repo Layout
```
server/
  index.js                   Express app + subdomain proxy + all API routes + Frank chat engine
  memory/brain.js            Brain (persistent memory, pgvector semantic search, conversations)
  projects/manager.js        Projects + per-project env vars
  publish/manager.js         Published app lifecycle (Render service create/update/delete)
  publish/github.js          GitHub operations for published apps
  publish/render-api.js      Thin Render REST API wrapper
  settings/manager.js        Global settings, global secrets vault, skills registry
  assets/manager.js          Global asset library (Neon-backed file storage)
  integrations/hubspot.js    HubSpot CRM integration (contacts, deals)
client/
  src/App.tsx                Top-level shell; Projects / Assets / Settings / Dashboard
  src/components/
    PromptColumn.tsx         Chat column (Frank conversation + attachments + approvals)
    Workspace.tsx            Per-project workspace (tabs start at "files")
    ProjectsList.tsx         Project list + create
    Dashboard.tsx            3-column dashboard (commits / brain+logs / usage)
    Settings.tsx             Settings + secrets + skills
    Assets.tsx               Global asset library UI
```

### Runtime Facts
- **Server:** `node server/index.js`, CommonJS, Express. Single file, ~1940 lines — intentionally monolithic for v2.
- **Client:** React 18 + Vite 6, TypeScript, built to `client/dist`, served statically by Express in production.
- **Database:** Neon Postgres via `@neondatabase/serverless`. All schemas use `CREATE TABLE IF NOT EXISTS` and run on boot.
- **Auth:** none. The auth gate was removed in v2. ForgeOS is currently open — no `ALLOWED_EMAILS`, no cookie session, no JWT.

---

## Database Schema

All tables live in one Neon database (`NEON_DATABASE_URL`). Schema is created on boot by each module's `ensureSchema()`.

| Table | Owner | Purpose |
|---|---|---|
| `projects` | projects/manager.js | Project metadata (id, name, status, project_history) |
| `project_env_vars` | projects/manager.js | Per-project env vars (forwarded to Render at publish time) |
| `published_apps` | publish/manager.js | Slug, render_service_id, render_url, commands, custom domain fields |
| `forge_memory` | memory/brain.js | Patterns, mistakes, snippets — pgvector(1024) HNSW index |
| `forge_project_index` | memory/brain.js | Project summaries for cross-project recall — pgvector(1024) |
| `forge_team_prefs` | memory/brain.js | Team preferences with confidence counter |
| `forge_conversations` | memory/brain.js | Chat history per project (role, content, created_at) |
| `forge_assets` | assets/manager.js | Global file library (base64 or UTF-8 text blobs) |
| `forge_usage` | server/index.js | Per-call token + cost tracking for Anthropic API |
| `global_settings` | settings/manager.js | JSONB key/value settings |
| `global_secrets` | settings/manager.js | Secrets vault (values stored plaintext in DB — access-controlled via ForgeOS UI) |
| `skills` | settings/manager.js | Reusable skill instructions injected into Frank's system prompt |

v2 boot migrations drop the old v1 tables: `DROP TABLE IF EXISTS iterations`, `DROP TABLE IF EXISTS run_snapshots`, `ALTER TABLE projects DROP COLUMN IF EXISTS current_run_id`.

---

## Frank — The Chat Engine

Frank is a direct Anthropic streaming chat engine. **No agent loop abstraction. No Hedwig. No nudges, guards, or forced tool calls.** Claude gets tools + system prompt + history, and that's it.

- **Endpoint:** `POST /api/projects/:id/chat` — SSE stream (`text/event-stream`)
- **Model:** `claude-opus-4-7`
- **SDK:** `@anthropic-ai/sdk` via `client.messages.stream(...)`
- **Max rounds per turn:** 20 (safety cap — rarely reached)
- **History:** last 30 messages loaded from `forge_conversations`; user messages, assistant text, tool results all round-trip through the DB
- **Attachments:** images supported as base64 blocks in the user message
- **Memory injection:** `brain.buildContext()` runs with a 4-second timeout; result prepended as `## RELEVANT MEMORY`
- **Skill injection:** when a skill is selected in the UI, its instructions are prepended as `## SKILL INSTRUCTIONS`
- **Usage tracking:** every API call's input/output tokens + cost are inserted into `forge_usage` for dashboard rollup

### Frank's Tools
| Tool | Requires Approval | Purpose |
|---|---|---|
| `github_create_branch` | no | Create `apps/<slug>` from main |
| `github_ls` | no | List files at a path on a branch |
| `github_read` | no | Read a file (base64 decoded) |
| `github_write` | **yes** | Commit a complete file. **Hard-blocks `branch: main`.** |
| `github_patch` | **yes** | Surgical find/replace on a file |
| `render_status` | no | Deploy status + live URL for a Render service |
| `memory_search` | no | Semantic search across Brain (pgvector) |
| `fetch_url` | no | Fetch any URL — docs, live app pages, internal ForgeOS endpoints |
| `list_assets` | no | List global asset library |
| `ask_user` | no | Send a message/question to Brian |

### Approval Flow
- Write tools (`github_write`, `github_patch`) pause and emit an approval card to the client.
- Brian can: **approve once**, **approve all writes** (for the rest of this chat turn), or **cancel**.
- Cancel → tool result is `"User cancelled this action."` — Frank adapts.
- Pending approvals time out after 5 minutes.
- Reads auto-execute with no approval.

### Hard Rules Enforced in Code
- `github_write` / `github_patch` refuse `branch: "main"` — apps **cannot** touch the ForgeOS runtime.
- Writes require a branch argument; callers must pass `apps/<slug>` explicitly.

---

## Published App Lifecycle

1. Brian creates a project in ForgeOS → gets a project id.
2. Frank talks to Brian, writes code, commits to `apps/<slug>`.
3. First publish from the cockpit calls `publish/manager.js` → `render-api.js`:
   - Creates a Render Web Service pointing at `apps/<slug>`
   - Sets install / build / start commands from the published_apps row
   - Pushes env vars from `project_env_vars` and global secrets
4. Render auto-deploys the branch. All subsequent commits trigger redeploys.
5. The app is reachable at `<slug>.forge-os.ai` via the subdomain proxy.

### Subdomain Proxy
Implemented as the first middleware in `server/index.js`. Wildcard DNS + TLS on `*.forge-os.ai`.

- Request to `<slug>.forge-os.ai` → looked up in `published_apps` → proxied to the corresponding `render_url`.
- Cloudflare headers stripped (`cf-*`, `x-forwarded-*`) before forwarding.
- `accept-encoding: identity` forced to avoid decoding errors.
- SSE responses are piped chunk-by-chunk; everything else is buffered.
- Redirect `Location` headers are rewritten Render URL → proxy URL.
- If no matching app → `503` with an "App Offline" splash.

### Custom Domains (BYO)
- `POST /api/projects/:id/custom-domain` → attaches domain via Render API
- `DELETE /api/projects/:id/custom-domain` → removes it
- Status, A-record, and CNAME values are cached in `published_apps`

### Slug Rename
Renaming a slug creates a new Render service and deletes the old one. No in-place rename.

---

## API Surface (non-exhaustive)

### Projects
```
POST   /api/projects                        Create project
GET    /api/projects                        List projects
GET    /api/projects/:id                    Get project
PATCH  /api/projects/:id                    Rename
DELETE /api/projects/:id                    Delete (cascades env vars)
GET    /api/projects/:id/env                List env vars
PUT    /api/projects/:id/env                Upsert env var
DELETE /api/projects/:id/env/:key           Remove env var
POST   /api/projects/:id/publish            Publish / republish to Render
DELETE /api/projects/:id/publish            Unpublish (deletes Render service)
POST   /api/projects/:id/slug               Rename slug
POST   /api/projects/:id/custom-domain      Attach BYO domain
DELETE /api/projects/:id/custom-domain      Remove BYO domain
GET    /api/projects/:id/versions           List version tags
POST   /api/projects/:id/rollback           Restore from tag + redeploy
GET    /api/projects/:id/publish            Publish details
GET    /api/projects/:id/export             Export project zip
```

### Chat
```
POST   /api/projects/:id/chat               SSE chat stream with Frank
POST   /api/projects/:id/chat/approve       Resolve a pending tool approval
GET    /api/projects/:id/chat               Load conversation history
```

### Brain
```
GET    /api/brain                           Brain stats + recent entries
POST   /api/brain/memory                    Append memory
POST   /api/brain/upvote/:id                Upvote a memory (usefulness++)
POST   /api/brain/purge                     Purge entries by pattern
```

### Assets
```
GET    /api/assets                          List assets
POST   /api/assets                          Upload (multipart)
GET    /api/assets/:filename                Serve asset
DELETE /api/assets/:filename                Delete asset
```

### Settings / Secrets / Skills
```
GET    /api/settings                        All settings
PUT    /api/settings/:key                   Upsert setting
GET    /api/secrets                         List secret keys (no values)
PUT    /api/secrets                         Upsert secret
GET    /api/secrets/:key/reveal             Reveal one secret value
DELETE /api/secrets/:key                    Delete secret
GET    /api/skills                          List skills
POST   /api/skills                          Create skill
PUT    /api/skills/:id                      Update skill
DELETE /api/skills/:id                      Delete skill
POST   /api/skills/import-url               Import from skillsmp.com, github.com, or raw.githubusercontent.com
```

### Dashboard
```
GET    /api/dashboard/status                ForgeOS + integrations health
GET    /api/dashboard/builds                Recent builds
GET    /api/dashboard/memory                Brain snapshot for the dashboard
GET    /api/dashboard/logs                  Render deploy logs
POST   /api/dashboard/redeploy              Manual redeploy of ForgeOS
GET    /api/dashboard/usage                 Token + cost rollups (total, recent, by-model)
```

### HubSpot
```
GET    /api/hubspot/status                  Integration health
GET    /api/hubspot/contacts                List contacts
POST   /api/hubspot/contacts                Create contact
GET    /api/hubspot/deals                   List deals
POST   /api/hubspot/deals                   Create deal
```

### GitHub / DB Browser (admin utilities)
```
GET    /api/github/ls                       Proxy GitHub ls
GET    /api/github/read                     Proxy GitHub read
GET    /api/github/commits                  Proxy GitHub commit history
GET    /api/db/tables                       List Neon tables
GET    /api/db/tables/:name                 Table schema
GET    /api/db/tables/:name/rows            Rows
POST   /api/db/query                        Execute a query
```

### Misc
```
GET    /health                              Liveness
GET    /api/published                       All published apps
GET    /api/diagnostics                     Env + DB + Render visibility checks
```

---

## Global Assets

Assets are **global** — not project-scoped. Any published app can fetch any asset.

- Stored in `forge_assets` as base64 (binary) or UTF-8 text (CSV/JSON/text).
- Access URL: `/api/assets/:filename` — root-relative from published apps.
- The subdomain proxy passes `/api/assets/*` through to the ForgeOS root handler, so `fetch('/api/assets/logo.png')` inside a published app resolves against ForgeOS without leaving the subdomain.
- Never read assets from disk. Never add project IDs to asset URLs.

---

## Brain (Persistent Memory)

`server/memory/brain.js` — memory across all projects and team members.

- **Tables:** `forge_memory`, `forge_project_index`, `forge_team_prefs`, `forge_conversations`
- **Vectors:** pgvector 1024-dim with HNSW indexes on both `forge_memory` and `forge_project_index`
- **Embedding model:** runs via Anthropic; semantic search is live
- **Conversations:** stored per project; last 30 messages replayed into every chat turn
- **Memory extraction:** runs as a non-blocking post-chat job — never blocks the response

`brain.buildContext(query, projectId)` is the single entry point used by Frank to inject relevant memory into the system prompt.

---

## Settings, Secrets & Skills

All three tables live in `server/settings/manager.js`.

- **global_settings** — JSONB key/value. Seeded with defaults on first boot.
- **global_secrets** — key/value vault. Frank's Anthropic key falls back to `process.env.ANTHROPIC_API_KEY` if the vault is empty.
- **skills** — reusable instructions. Selected in the chat UI; injected as `## SKILL INSTRUCTIONS` ahead of Frank's base system prompt. Importable from skillsmp.com, github.com, or raw.githubusercontent.com via `POST /api/skills/import-url`.

---

## Dashboard

Three-column grid (desktop ≥1100px):

- **Col 1** — Recent Commits
- **Col 2** — Brain Memory + Render Logs
- **Col 3** — Anthropic Usage (tokens, cost, by-model breakdown)

Breakpoints: 3-col → 2-col at <1100px → 1-col at <900px. The `.content-split` wrapper has `overflow-y: auto` so dashboard content scrolls on mobile (fixed 2026-03-24, commit 47b950d).

---

## Workspace App Rules — Published Apps

### Mode A: Plain Node (default)
- Start: `node server.js`
- CommonJS only (`require`/`module.exports`)
- Frontend: plain HTML/CSS/JS served from `public/`
- `GET /` returns a complete HTML page

### Mode B: Vite + React (opt-in)
- Only when Brian explicitly asks for React/Vue, or UI clearly warrants it
- Start: `npm run dev`
- `vite.config.js` with `server.port: parseInt(process.env.PORT) || 3000` and `server.host: true`
- `index.html` at project root (Vite convention)

### Shared Rules
- **URLs:** root-relative only — `/api/items`, `/style.css`. Never `://`.
- **No `<base>` tags** — breaks proxy rewriting.
- **Port:** `process.env.PORT || 3000` — never hardcoded.
- **Database:** `@neondatabase/serverless` only.
- **Env vars:** injected at runtime. Apps should **not** use `dotenv` — values come from Render.
- **Database URL naming:** `NEON_DATABASE_URL` is reserved for ForgeOS itself. Published apps use their own name (e.g. `APP_DATABASE_URL`).
- **Backend/frontend split:** backend in `server.js`, frontend in `index.html` — never inline HTML into `server.js`.
- **Index serving:** `res.sendFile(require("path").join(__dirname, "index.html"))`.

---

## Tech Stack

### Server Deps (in use)
`express`, `@anthropic-ai/sdk`, `@neondatabase/serverless`, `uuid`, `cookie-parser`, `busboy`, `concurrently`, `p-limit`, `p-retry`, `zod`, `drizzle-zod`, `zod-validation-error`

### Client Deps
`react`, `react-dom`, `react-markdown`, `lucide-react`, `vite`, `typescript`

### Vestigial / Cleanup Candidates
- `@google/generative-ai` — imported at `server/index.js:875`, **never actually called**. Gemini was the pre-Anthropic chat engine. Safe to remove along with the import and the `GEMINI_API_KEY` check in `/api/dashboard/status`.
- `dotenv` — listed in deps but env vars come from Render. Unused in code paths that matter.

### Platform Integrations
- **CRM:** HubSpot via `server/integrations/hubspot.js` (`HUBSPOT_API_KEY`)
- **Render:** `server/publish/render-api.js` (`RENDER_API_KEY`)
- **GitHub:** PAT via `GITHUB_TOKEN`

---

## Environment Variables

| Variable | Purpose |
|---|---|
| `PORT` | ForgeOS listen port (default 3001) |
| `NEON_DATABASE_URL` | ForgeOS database (reserved — published apps use their own var name) |
| `ANTHROPIC_API_KEY` | Frank's Anthropic key (vault override also supported) |
| `GITHUB_TOKEN` | PAT for all GitHub tool calls |
| `RENDER_API_KEY` | Render service management |
| `RENDER_OWNER_ID` | Render owner id for service creation |
| `BASE_DOMAIN` | Subdomain proxy domain (`forge-os.ai`) |
| `HUBSPOT_API_KEY` | HubSpot CRM |
| `ADMIN_PASSWORD` | Required for `/api/admin/relay` SQL relay |

---

## Models

| Task | Model |
|---|---|
| Frank (all chat + tool use) | `claude-opus-4-7` |
| Brain memory extraction | routed through Anthropic (lightweight) |

No model router module. Direct SDK calls from `server/index.js`.

---

## Code Style & Conventions

- **CommonJS** everywhere on the server.
- **ES modules** in the React client only.
- **Terminology:** reforge, not "refactor".
- **No logging as a fix. No try-catch as a fix.** Find the actual broken code.
- Claude responses sometimes wrap JSON in markdown fences — always strip before `JSON.parse`.
- **Never write inline backtick-wrapped content inside JS template literal strings** — Node treats the backtick as closing the template literal.

---

## Common Failure Modes

- Inline backtick-wrapped HTML or code inside JS template literals — breaks Node parser on Render.
- Multi-line CSS edits via `sed` — unreliable; use Python `str.replace()` on full file content.
- `fetch` URL audit: argument must start with `/` and must not contain `://`.
- Published apps fetching assets server-side via localhost — always client-side `/api/assets/FILENAME`.
- Spreading `process.env` wholesale into child processes.
- `execSync` with shell string interpolation — use `execFileSync` with args array.
- Writing to `main` from Frank — hard-blocked in `github_write`/`github_patch`, but worth remembering when debugging.

---

## Cleanup Backlog (spotted during 2026-04-18 audit)

- Remove `@google/generative-ai` dep + import + `GEMINI_API_KEY` dashboard check.
- Remove `dotenv` dep — unused.
- Decide fate of `brain_import.json` and `Forge_context_pack.json` at repo root — either document or remove.
- Brain memory purge of v1 poison terms still pending (tracked in Project Memory).
- Consider extracting `FORGE_TOOLS` and the chat handler out of `server/index.js` — it's approaching 2000 lines.

---

## Session Log

### 2026-04-18
- Stub opened
- Full README rewrite — old doc was describing the v1 architecture (builder.js, workspace/manager.js, pipeline/runner.js, auth gate, Diff/Edit/Shell tab strip, "model-router.js"). None of that exists. New README reflects actual v2 reality: monolithic `server/index.js`, Frank as direct Anthropic streaming engine with 10 tools, approval flow, real DB schema, real API surface.
- Shipped **Brand Profile skill** (id 27) — instructs Frank to scrape a brand's live site and capture colors, fonts, nav/footer HTML, container pattern, voice.
- Shipped **Brand Profiles feature** (feat: 0b387a1):
  - New `forge_brands` + `forge_project_brands` tables (many-to-many)
  - `server/brands/manager.js` — CRUD + Anthropic-powered scraper (claude-opus-4-7, usage recorded)
  - Six `/api/brands/*` routes; `PATCH /api/projects/:id` accepts `brandIds: number[]`
  - Chat handler injects `## BRAND PROFILES` into Frank's system prompt between THIS PROJECT and RELEVANT MEMORY
  - Settings UI: new Brands tab with list + editor; Save, Save & Scrape, Re-scrape, Delete; profile is hand-editable markdown
  - Workspace tab bar: compact multi-select brand chip selector
- Updated skill 27 to point at the Brands library API instead of writing `.forge/brand.md` to branches — profiles now live in Neon, are reusable across projects, and are auto-injected without a tool call.
- Cleanup commits landed in parallel sessions: `33c857f` dropped vestigial `@google/generative-ai` + `dotenv` deps and fixed the `/api/dashboard/status` Anthropic check to consult the vault; `e513c93` passed the real date into the scraper prompt and surfaced fetch failures.
- Fixed new-project brand attach (`f6f2b7a`) — `BrandSelector` now renders pre-creation with staged state, and `POST /api/projects` accepts `brandIds: number[]` so Frank gets `## BRAND PROFILES` on turn 1.
- Fixed brand chip dropdown visibility + iPad touch (`48a59ef`) — menu rendered as `position: fixed` with computed coords to escape the tab-bar `overflow-x: auto` clip; outside-tap detection moved from `mousedown` to `pointerdown` for iOS Safari; larger hit targets and `touch-action: manipulation`.

### 2026-04-19
- **Frank migrated to Claude Opus 4.7** (`a0b3179`) — both the chat engine and the brand scraper. Pricing math updated from $15/$75 per MTok to $5/$25 per MTok to match the current rate card. `forge_usage` now records `model='claude-opus-4-7'` on new rows; historical rows are untouched. No banned params in use (no `temperature`/`top_p`/`top_k`), so 4.7's parameter deprecation had no impact.

---

*Last updated: 2026-04-19*
