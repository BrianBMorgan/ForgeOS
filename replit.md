# ForgeOS

## Overview
ForgeOS is a private internal agentic AI build platform — a thin control plane UI for orchestrating a Planner → Reviewer → Policy Gate → Human Approval → Executor → Auditor pipeline. The pipeline uses OpenAI models to generate, review, and refine structured build plans, then the Executor produces complete runnable code that gets written to disk, built, and launched as a live app. Projects support iterative development — follow-up prompts evolve an existing running app with full context of the current codebase.

## Architecture
- **Frontend**: React + Vite + TypeScript in `/client`
- **Backend**: Express (Node.js) in `/server`
  - `server/index.js` — Express app with API routes, preview proxy, project/run/stress-test endpoints
  - `server/pipeline/` — Agent orchestration engine
    - `schemas.js` — Zod schemas for Planner, Reviewer, Policy Gate, Executor, Auditor outputs
    - `agents.js` — Agent instruction prompts for each pipeline stage (including iteration-aware variants)
    - `runner.js` — Pipeline orchestration: run creation, stage execution, approval/rejection flow, workspace build & run
  - `server/projects/` — Project management
    - `manager.js` — In-memory project store, iteration tracking, file capture for iteration context
  - `server/workspace/` — Workspace manager for generated apps
    - `manager.js` — File writing, dependency installation, app process management per run
  - `server/stress-test/` — Automated stress test harness
    - `prompts.js` — Pool of 18 diverse test prompts across 6 categories
    - `runner.js` — Autonomous test runner with auto-approval and sequential execution
    - `analyzer.js` — Static analysis violation detector for executor output
    - `logger.js` — Detailed per-prompt logging to disk
    - `report.js` — Report generator with summary, violation frequency, category analysis

## Project System
Projects are the top-level organizational unit. Each project groups multiple build iterations:
- **Create project**: `POST /api/projects` → creates project + first pipeline run
- **Iterate**: `POST /api/projects/:id/iterate` → captures current workspace files, creates new run with existing code context
- **Iteration context**: The Planner and Executor receive iteration-aware instructions (PLANNER_ITERATE_INSTRUCTIONS, EXECUTOR_ITERATE_INSTRUCTIONS) that tell them to analyze existing code and make incremental changes
- **File capture**: `captureCurrentFiles(runId)` reads workspace directory, skipping node_modules, lock files, and binary files
- **Full file output**: The Executor always outputs ALL files (modified + unchanged) so the workspace can be cleanly rewritten

## Workspace System
After the Executor produces code, ForgeOS automatically:
1. Creates an isolated workspace directory (`workspaces/<runId>/`)
2. Writes all generated files to disk
3. Patches hardcoded ports → `process.env.PORT || <original>` in all JS files
4. Resolves `npm start` → direct `node server.js` to avoid orphaned child processes
5. Allocates a dynamic free port in 4000-4099 range via `getNextFreePort()`
6. Runs the install command (e.g., `npm install`)
7. Starts the app process with PORT env var set to the allocated port
8. Proxies requests through `/preview/<runId>/` to the running app
- Workspace states: writing-files → installing → starting → running (or failed at any step)
- Generated apps get dynamic ports (4000-4099); ForgeOS uses 3001/5000
- Previous workspace apps are stopped when a new run starts
- `patchHardcodedPort()` scans all .js files for `const PORT = NNNN;`, `let port = NNNN;`, `.listen(NNNN,` patterns and injects `process.env.PORT ||` fallback

## UI Structure
Three-zone layout:
- **Sidebar** (~240px, collapsible to 60px icon rail): New Project, Projects, Templates, Logs, Stress Test, Settings
- **Projects List**: Grid of project cards showing name, status (Building/Running/Stopped/Failed), iteration count, prompt snippet
- **Prompt Column** (25%): Project header with name/status, iteration history timeline, prompt textarea (context-aware placeholder), pipeline stages, approval controls
- **Workspace** (75%): Tabbed browser-like interface — Plan, Review, Diff, Auditor, Render, Shell, DB, Publish; iteration banner when viewing past iterations
- **Stress Test** (full width): Replaces prompt/workspace when active — run button, progress bar, results table

## Component Files
- `client/src/App.tsx` — Main shell layout, project/run state management, API integration (polling, approve/reject, iterate)
- `client/src/components/PromptColumn.tsx` — Prompt input, iteration history, pipeline stage visualization, approval controls
- `client/src/components/Workspace.tsx` — Tabbed workspace with Plan, Review, Diff, Auditor, Render (live preview + file viewer), and Shell (build logs) tabs
- `client/src/components/ProjectsList.tsx` — Projects grid with status cards, empty state, polling
- `client/src/components/StressTest.tsx` — Stress test UI with controls, progress, results table, category analysis
- `client/src/index.css` — All styling (dark theme, institutional aesthetic)

## API Routes
- `GET /health` — Health check
- `POST /api/projects` — Create a new project with initial prompt
- `GET /api/projects` — List all projects
- `GET /api/projects/:id` — Get project with iterations and current run data
- `POST /api/projects/:id/iterate` — Submit follow-up prompt (captures current files, creates iteration run)
- `POST /api/projects/:id/stop` — Stop the running app
- `POST /api/projects/:id/chat` — Send a chat message (body: `{ message }`) — returns `{ role, content, suggestBuild, buildSuggestion, createdAt }`
- `GET /api/projects/:id/chat` — Get chat history for a project
- `POST /api/runs` — Start a new pipeline run (legacy, used by stress test)
- `GET /api/runs` — List all runs
- `GET /api/runs/:id` — Get run status, stages, outputs, and workspace status
- `GET /api/runs/:id/logs` — Get workspace build/install/app logs
- `POST /api/runs/:id/exec` — Execute a command in the workspace directory (body: `{ command }`) — returns `{ exitCode, stdout, stderr }`; dangerous commands blocked by pattern matching; 15s timeout; 256KB output limit
- `POST /api/runs/:id/approve` — Approve a run awaiting human approval
- `POST /api/runs/:id/reject` — Reject with feedback (body: `{ feedback: string }`)
- `/preview/:runId/*` — Proxies to the running workspace app (path-based routing)
- `POST /api/stress-test/start` — Start stress test (optional `{ promptIds: [] }`)
- `GET /api/stress-test/status` — Get stress test progress
- `GET /api/stress-test/results` — Get latest stress test report

## Pipeline Stages
1. **Planner** — Generates structured build plan from user prompt (gpt-4.1); uses PLANNER_ITERATE_INSTRUCTIONS for iterations
2. **Reviewer P1** — Reviews plan for gaps, risks, security issues (gpt-4.1-mini, temp 0.2)
3. **Revise P2** — Incorporates reviewer feedback into revised plan (gpt-4.1)
4. **Reviewer P2** — Final production-readiness review (gpt-4.1-mini, temp 0.2)
5. **Policy Gate** — Determines auto-approve vs human-approval-required (gpt-4.1-mini)
6. **Human Approval** — Pauses for approve/reject; rejection triggers Pass 3 revision loop
7. **Executor** — Produces complete runnable code (gpt-4.1); uses EXECUTOR_ITERATE_INSTRUCTIONS for iterations (outputs ALL files including unchanged ones)
8. **Auditor** — Pre-deployment quality gate (gpt-4.1-mini). Checks 11-point checklist, triggers fix loop (up to 2 rounds) if issues found.

## Executor Output Schema
- `files[]` — Array of `{ path, purpose, content }` — complete source code for every file
- `installCommand` — e.g., "npm install"
- `startCommand` — e.g., "node server.js"
- `port` — Port the generated app listens on (default 4000)
- `implementationSummary`, `environmentVariables`, `databaseSchema`, `buildTasks`

## Stress Test System
Automated harness to evaluate Executor quality without manual intervention:
- **18 test prompts** across 6 categories: pure-frontend, api-only, fullstack-db, auth-required, multi-file, edge-cases
- **Violation detector** scans for: banned packages, wrong DB driver, absolute fetch paths, missing root route, dynamic SQL, wrong port, dotenv usage, missing deps, JWT_SECRET usage, version hallucination
- **Sequential execution** with auto-approval, health checks, 120s timeout per prompt
- **Reports** saved to `stress-test-results/` with JSON and human-readable text summaries
- Results include: per-prompt breakdown, violation frequency, category success rates, instruction gap suggestions

## Development
- `npm run dev` — runs Vite dev server (port 5000) and Express API (port 3001) concurrently
- `npm run build` — builds the React client to `client/dist`
- `npm start` — runs Express in production mode, serving the built client
- Vite proxy: `/api`, `/health`, and `/preview` routes proxied to Express backend

## Production
Express serves static files from `client/dist` and falls back to `index.html` for SPA routing.

## Dependencies
- **Root**: concurrently, express, openai, zod, uuid, http-proxy-middleware, @neondatabase/serverless
- **Client**: react, react-dom, vite, typescript, @vitejs/plugin-react

## Environment Variables
- `OPENAI_API_KEY` — Required for pipeline agent calls
- `NEON_DATABASE_URL` — Neon Postgres connection string, used by ForgeOS for project persistence AND passed to generated apps as `DATABASE_URL`
- `NEON_AUTH_JWKS_URL` — Neon Auth JWKS endpoint, passed to generated apps for JWT verification
- `PORT` — Express server port (default 3001, or set by hosting platform)
- `NODE_ENV` — Set to "production" for static file serving

## Design Direction
- Dark mode only (#0F172A base, #111827/#1E293B panels, #3B82F6 accent blue)
- Institutional, calm, operational aesthetic
- No chat bubbles, no playful startup chrome
- No Replit-specific dependencies — fully portable

## Chat System
Projects have a built-in conversational interface powered by gpt-4.1-mini:
- **Conversational agent** (`server/chat/manager.js`): Receives user messages with full codebase context, analyzes code, answers questions, diagnoses issues
- **Web search** (`server/chat/search.js`): Agent has `web_search` and `fetch_url` tools via OpenAI function calling. Searches DuckDuckGo for current info about APIs, libraries, and services. Fetches and extracts text from documentation URLs. Responses prefixed with "[Researched]" when web search was used. Agent decides autonomously when to search (external services, APIs, docs) vs answer from code/knowledge.
- **Intent detection**: Agent determines if user is asking a question (suggestBuild=false) or requesting a change (suggestBuild=true with buildSuggestion)
- **Build confirmation**: When the agent suggests a build, a green "Build this change" button appears in the chat thread; clicking it triggers the iteration pipeline
- **Persistence**: Chat messages stored in `chat_messages` table, survive restarts
- **UI flow**: In project view, the input says "Ask a question or describe a change..." with a "Send" button for chat and a "Build" button for explicit builds

## Database Viewer
The DB tab in the workspace provides a read-only database browser for inspecting the Neon Postgres database:
- **Table browser**: Lists all tables, click to see columns (name, type, nullable) and row count
- **Data grid**: Paginated rows with sortable columns (50 rows per page, max 200)
- **SQL query runner**: Free-form SQL input with Ctrl+Enter shortcut; shows row count and execution time
- **Safety**: DDL statements (DROP, TRUNCATE, ALTER, CREATE, GRANT, REVOKE) are blocked at the API level
- **API**: Uses `@neondatabase/serverless` neon().query() for dynamic table queries, tagged template literals for parameterized queries

## Current State
- **Full persistence**: Projects, iterations, run snapshots, and chat messages stored in Neon Postgres via `@neondatabase/serverless`; in-memory cache for fast reads; schema auto-created on startup
- **Run data survives restarts**: When a run completes/fails, a full snapshot (stages, outputs, workspace status) is saved to `run_snapshots` table; `getRun()` falls back to DB when not in memory and caches in-memory
- **Workspace restoration on startup**: When the server starts, it scans for projects with "active" status, loads their run data from DB, and re-launches workspace apps from their existing files on disk. `restoreWorkspace()` in workspace/manager.js re-uses the workspace directory, re-installs deps if node_modules is missing, and starts the app. Live workspace status is synced from the workspace manager on every API response.
- Agent pipeline fully functional with OpenAI API
- **Project system**: Create projects, iterate with follow-up prompts, full context passing to Planner/Executor
- Executor generates complete runnable code (Layer 1)
- Workspace manager writes files, installs deps, starts apps (Layer 2)
- Dynamic port allocation (4000-4099) with hardcoded port patching (Layer 2.5)
- Live preview via iframe in Render tab (Layer 3)
- Auditor stage with 11-point checklist and fix loop (up to 2 rounds)
- Interactive shell in Shell tab (command execution in workspace directory, command history, safety-blocked patterns)
- Structured log viewer in Shell tab (Logs mode) — timestamped entries with level detection (INFO/WARN/ERROR/DEBUG), source labels (SYS/NPM/APP), level filter buttons with counts, text search, auto-scroll toggle; server-side filtering via query params (since, level, source, search, limit); capped at 2000 entries with automatic rotation
- Neon Postgres available for generated apps that need a database (via DATABASE_URL)
- Neon Auth available for generated apps that need user management (via NEON_AUTH_JWKS_URL)
- Stress test harness: 100% pass rate (18/18)
- Future phases: persistence, self-correction (Layer 4), context management
