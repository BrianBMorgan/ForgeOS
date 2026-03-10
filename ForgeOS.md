# ForgeOS

ForgeOS is an AI-powered web app builder with a cockpit UI, workspace runner, and a GitHub-to-Render deploy chain. It allows users to build, preview, and publish full web applications through a conversational AI interface backed by a persistent memory system (Brain) and a clean agent architecture.

---

## Architecture Overview

### Deploy Chain
```
Claude → GitHub (BrianBMorgan/ForgeOS) → Render → production (forge-os.ai)
```
Replit is fully sunset. Claude pushes directly to GitHub via PAT.

### Key Components

| Component | Location | Purpose |
|---|---|---|
| Cockpit UI | `client/` | Tab-based interface: Plan / Review / **Diff** / Auditor / Render / **Edit** / Shell / DB / Env / Publish + global Assets sidebar + collapsible chat column |
| Server | `server/index.js` | Express API + subdomain proxy middleware + inspector script injection |
| Builder | `server/builder.js` | Single Claude-powered workspace builder (replaces legacy multi-agent pipeline) |
| Pipeline Runner | `server/pipeline/runner.js` | Orchestrates build calls and injects context |
| Workspace Manager | `server/workspace/manager.js` | Workspace lifecycle + `listWorkspaceFiles`, `readWorkspaceFile`, `writeWorkspaceFile`, `searchWorkspaceFiles` |
| Publish Manager | `server/publish/manager.js` | Manages Render service lifecycle for published apps |
| Assets Manager | `server/assets/manager.js` | Global file uploads stored in Neon DB |
| Brain | `server/memory/brain.js` | Persistent memory across all projects and team members |
| Render API Wrapper | `server/publish/render-api.js` | createService, updateServiceEnv, redeployService, getServiceStatus, deleteService, listServices, addCustomDomain, listCustomDomains, removeCustomDomain |
| GitHub Publisher | `server/publish/github.js` | Pushes app files to branch, tags versions, supports rollback |
| Auth Gate | `server/auth/gate.js` | HMAC-signed cookie session with ALLOWED_EMAILS whitelist |

### Database
- **Provider:** Neon Postgres (`@neondatabase/serverless` — no other DB drivers)
- **Key tables:** `published_apps`, `forge_assets`, `forge_memory`, `forge_project_index`, `forge_team_prefs`, `forge_conversations`
- All `CREATE TABLE` statements use `IF NOT EXISTS`
- FK column types must exactly match referenced PK types

---

## Published App Lifecycle

1. User triggers publish from the Publish tab
2. `_doPublish` in `publish/manager.js` pushes workspace files to a dedicated GitHub branch (`apps/<slug>`)
3. Render auto-deploys from that branch as an independent Web Service (plan: standard — always-on)
4. Global Secrets are passed to the Render service via `updateServiceEnv`
5. The app is accessible at `<slug>.forge-os.ai` via the wildcard subdomain proxy
6. Slug renames create a new Render service and delete the old one — no in-place rename

### Version History & Rollback
- Before a branch is deleted on republish, a git tag (`v<timestamp>-<slug>`) is created
- `GET /api/projects/:id/versions` lists all version tags for a project
- `POST /api/projects/:id/rollback` with `{ tag }` restores files from that tag and redeploys the Render service
- Version History UI in the Publish tab shows all versions with rollback buttons

### Custom Domain (BYO)
- `POST /api/projects/:id/custom-domain` with `{ domain }` calls Render API to attach the domain
- `DELETE /api/projects/:id/custom-domain` removes it
- Custom Domain section in the Publish tab — user points their DNS CNAME to Render after adding

### Subdomain Proxy
- Wildcard `*.forge-os.ai` DNS and TLS configured via Namecheap + Render
- Proxy middleware in `server/index.js` routes subdomains to the correct Render service
- Uses `accept-encoding: identity` on proxied fetch calls to prevent content decoding errors
- `BASE_DOMAIN=forge-os.ai` env var controls the proxy domain

---

## Visual Editor — Three-Phase Inspect System

The cockpit includes a full inspect-to-edit system spanning three integrated phases.

### Phase 1 — Inspect Mode (Render tab)
- **⊹ Inspect** button in the Live Preview header activates crosshair mode
- Blue overlay highlights elements on hover inside the preview iframe
- Click any element → selection badge appears showing CSS selector path + text preview
- **Use in chat ↗** prepends `[Selected element: selector\nHTML: ...]` into the prompt input
- Eliminates "which element?" ambiguity without changing the builder pipeline

### Phase 2 — Edit Tab (direct file editing)
- Split-pane: file tree + textarea editor (left) + live preview iframe (right)
- Save writes the file to disk, restarts the workspace, refreshes preview after 1.2s
- Dirty state tracking (● dot), Revert button, inline save confirmation
- Bypasses the builder entirely — zero pipeline cost for copy edits and styling tweaks

### Phase 3 — Inspect-to-Edit Bridge
- When **Use in chat ↗** is clicked, a background file search runs against all workspace files using the element's text content
- On match: cockpit switches to Edit tab, loads the file, scrolls to and selects the matching line, brief blue flash confirms the landing
- Falls back gracefully to Phase 1 behavior (context in chat only) when no file match is found (dynamic/JS-rendered content)

### Inspector Script Injection
- `rewriteHtmlForProxy` injects a dormant inspector script into every preview HTML response
- Activated/deactivated via `postMessage({ type: 'forge:inspect:activate' | 'forge:inspect:deactivate' })`
- Selection posted back to parent as `{ type: 'forge:inspect:selection', outerHTML, textContent, selector }`

### File Search API
- `GET /api/runs/:id/file/search?text=...` — searches all text files in the workspace, returns up to 10 `{ file, line, snippet }` matches
- Implemented in `server/workspace/manager.js` as `searchWorkspaceFiles(runId, searchText)`

---

## Workspace App Rules — Two Runtime Modes

### Mode A: Plain Node (default)
- Start command: `node server.js`
- No build steps, no bundlers, no transpilers, no chained commands
- CommonJS only: `require()` / `module.exports` — zero `import`/`export` statements
- Frontend: plain HTML, CSS, JavaScript served statically from a `public/` directory
- `GET /` must return a complete HTML page — not a redirect, not JSON

### Mode B: Vite + React (opt-in)
Use only when the user explicitly asks for React or Vue, or when UI complexity clearly warrants a component model.

- Start command: `npm run dev`
- Vite is the only permitted bundler — no webpack, esbuild, parcel, rollup
- `vite.config.js` required with `server.port: parseInt(process.env.PORT) || 3000` and `server.host: true`
- `package.json` scripts must include `"dev": "vite --host"`
- `index.html` at project root (Vite convention)
- ES modules and `import`/`export` allowed in React/Vue component files

### Rules that apply to both modes
- **URLs:** Root-relative only — `/api/items`, `/style.css`. Never absolute URLs with `://`
- **No `<base>` tags** — they break proxy rewriting
- **Port:** Always `process.env.PORT || 3000` — never hardcoded
- **Database:** `@neondatabase/serverless` only — no other drivers
- **Auth:** Neon Auth via `jose` + JWKS only — no bcrypt, no custom JWT signing
- **Environment variables:** Injected at runtime — no dotenv, no `.env` files
- **CSS `url()` references:** Must use root-relative paths — the proxy does not rewrite stylesheets

---

## Global Assets

Assets are global scope — not project-scoped. Any project can use any uploaded asset.

- **Storage:** Neon DB (`forge_assets` table) as base64 (binary) or UTF-8 text (CSV/JSON/text)
- **Access URL pattern:** `/api/assets/:filename`
- **Upload UI:** Global Assets sidebar in the cockpit
- **Context injection:** `getAssetsContext()` injects `AVAILABLE GLOBAL ASSETS` block into builder system prompt before every build

### Asset Fetch Rules
- **Frontend (always preferred):** `fetch('/api/assets/filename.csv')` — root-relative, proxy handles it
- **Server-side (avoid):** `http://localhost:${PORT}/api/assets/filename.csv` — only if server-side parse is absolutely required
- Never read assets from disk — always fetch via HTTP
- Never add project IDs, run IDs, or any other segment to asset URLs

### Preview Proxy Passthrough
The `/preview/:runId` middleware short-circuits `/api/assets/*` requests to the ForgeOS root handler instead of forwarding to the workspace app. Without this, asset fetches return 404. This is already implemented in `server/index.js`.

---

## ForgeOS Brain (Persistent Memory)

Brain provides memory across all projects and team members via Neon Postgres.

- **Tables:** `forge_memory`, `forge_project_index`, `forge_team_prefs`, `forge_conversations`
- Memory extraction runs as a non-blocking post-build call — never blocks the build response
- Uses `claude-haiku-4-5-20251001` for memory extraction (lightweight classification task)
- pgvector semantic search is live and active
- **Current scale:** 200 patterns, 5 mistakes, 158 code snippets, 148 team preferences, 63 embeddings

---

## Tech Stack

### Approved Packages
express, @neondatabase/serverless, uuid, cors, cookie-parser, body-parser, multer, nodemailer, node-cron, ws, socket.io, marked, cheerio, axios, node-fetch, @anthropic-ai/sdk, react, react-dom, @vitejs/plugin-react, vite, vue, jose, resend

### Platform Integrations
- **Email:** Resend (`RESEND_API_KEY`) — default from `admin@makemysandbox.com`
- **CRM:** HubSpot (`HUBSPOT_API_KEY`, `HUBSPOT_CLIENT_SECRET`) — contacts, companies, deals, leads, marketing events

### Banned Packages
angular, nuxt, svelte, bcrypt, bcryptjs, jsonwebtoken, dotenv, typescript, webpack, rollup, parcel, esbuild, tailwindcss, openai, pg, postgres, mysql2, sqlite3, better-sqlite3, passport, passport-local, nodemon

---

## Environment Variables

| Variable | Purpose |
|---|---|
| `DATA_DIR` | Persistent disk path on Render (`/data`) — all workspace and published app paths |
| `ALLOWED_EMAILS` | Whitelist for ForgeOS access via auth gate |
| `BASE_DOMAIN` | Subdomain proxy domain (`forge-os.ai`) |
| `PORT` | App port — always `process.env.PORT \|\| 3000` |
| `NEON_DATABASE_URL` | Database connection — published apps must use this, not `DATABASE_URL` |

Env var merge order in published apps: **platform keys → global defaults → project-specific vars**. Never spread `process.env` wholesale into child processes.

---

## Models

| Task | Model |
|---|---|
| All primary builds and reasoning | `claude-opus-4-5` |
| Memory extraction | `claude-haiku-4-5-20251001` |

All Anthropic API calls route through `model-router.js` — never call the API directly from route handlers.

---

## Code Style & Conventions

- **Language:** CommonJS (`require`/`module.exports`) for all server code — ES modules in Mode B frontend only
- **Terminology:** It's **reforge**, never "refactor"
- **No logging as a fix.** No try-catch as a fix. Find the actual broken code.
- `buildSuggestion` must contain: file + route/function + current broken code + replacement. One sentence. No outcome descriptions. One root cause, one code change.
- Claude API responses frequently wrap JSON in markdown fences — always strip before `JSON.parse`:
  ```js
  text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '')
  ```
  Then scan for the first `{` or `[`.
- **Never write inline backtick-wrapped content inside JS template literal strings** — Node parser treats the backtick as closing the template literal. Use plain text or escaped backticks (`\\``) instead.

---

## Common Failure Modes to Avoid

- Inline backtick-wrapped HTML or code examples inside JS template literal strings — breaks Node parser on Render
- Claude Code PRs (`claude/*` branches) merged without review — can introduce syntax errors and conflicting prompt changes
- Fetch URL audit rule inverted — correct rule: fetch argument must start with `/` and must not contain `://`
- Chat Agent degradation: after failed iterations it suggests logging or try-catch — named failure mode, not acceptable
- Generated apps fetching assets server-side via localhost — always fetch client-side using root-relative `/api/assets/FILENAME`
- `getAssetsContext()` returning array instead of string — must return formatted string for `filter(Boolean).join()` in builder.js
- Spreading `process.env` wholesale into child processes
- Copying `.git` directory into published app files
- Using `execSync` with shell string interpolation — use `execFileSync` with args array
- URL helper functions that construct absolute URLs — fix `fetch()` calls directly with `/path` strings
- Multiple code changes in a single `buildSuggestion`

---

### Pipeline Directory
`server/pipeline/` contains only `runner.js` — one file, one purpose (run lifecycle management).
- `agents.js` deleted — `CHAT_AGENT_INSTRUCTIONS` moved inline to `server/chat/manager.js`
- `schemas.js` deleted — `ExecutorSchema`/`AuditorSchema` were unused since the single-builder migration
- `STAGES` constant and pending-init loop removed from `runner.js` — stages written directly by the builder

---

## Cockpit UI — Diff Tab & Chat Panel Controls

### Diff Tab
- Positioned between Edit and Shell in the default tab strip
- Two version selectors (A = red, B = green) defaulting to previous vs current iteration
- File list shows the union of files from both runs — `+` badge for new files, `−` for deleted
- LCS-based line diff (`computeDiff`) — side-by-side columns with aligned blank rows for readability
- Red lines (removed) on left, green lines (added) on right, unchanged lines neutral
- "No changes" message when a file is identical between versions
- CSS: `.diff-tab`, `.diff-controls`, `.diff-run-selectors`, `.diff-columns`, `.diff-col`, `.diff-lines`, `.diff-line-added`, `.diff-line-removed`, `.diff-line-empty`

### Collapsible Chat Column
- `chatCollapsed` state in `App.tsx`; `‹`/`›` toggle tab fixed to the right edge of the prompt column
- Smooth `width` CSS transition (0.2s ease) — chat collapses to zero width, giving the workspace panel full width
- State is preserved when re-expanded — no DOM removal
- Hidden on mobile (mobile panel switching already handles layout; collapse would conflict)
- CSS: `.chat-collapse-tab`, `.mobile-panel-chat.chat-collapsed .prompt-column`

### Mobile Chat Scroll Fix
- `.mobile-panel-chat .prompt-column` — added `min-height: 0`, `height: 100%`, `overflow: hidden`
- Allows `.chat-thread` (which has `flex: 1; overflow-y: auto; min-height: 0`) to scroll correctly inside a flex column

---

## Open Questions

- Should failed builds auto-record to Brain or require human confirmation?
- What is the right conversation history limit per project before summarization is needed?
- Should the workspace builder stream responses or return complete JSON on completion?

---

*Last updated: 2026-03-10*
