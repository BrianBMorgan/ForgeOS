# ForgeOS

## GOLDEN RULE #1 — DO NOT MODIFY THE FILE STRUCTURE
The ForgeOS deployment on Render is extremely sensitive to file structure changes. The build and start commands depend on exact paths:
- **Build**: `npm install && npm install --prefix client && npm run build --prefix client`
- **Start**: `node server/index.js`

**NEVER** move, rename, or reorganize the top-level directories (`server/`, `client/`, `package.json`). Do not create wrapper directories, nest the project inside a subdirectory, or restructure the root layout. Any change to where `server/index.js`, `client/`, or `package.json` live will crash the production deployment immediately.

When pushing to GitHub (`BrianBMorgan/ForgeOS`), platform source files go to the **repo root** — not inside a subdirectory. Published project apps go into `{slug}/` subdirectories. The platform source itself is never namespaced.

This rule applies to all operations: file edits, git pushes, refactors, and migrations. If in doubt, don't move files.

## GOLDEN RULE #2 — ALWAYS PUSH TO GITHUB (PLATFORM CODE ONLY)
After every code change (no matter how small), push the updated platform files to `BrianBMorgan/ForgeOS` on GitHub. The repo must always reflect the current state of the platform codebase. Use the `pushProjectToGitHub` function from `server/publish/github.js` pointed at the workspace root (`.`) with NO slug prefix — files go to the **repo root**, not a subdirectory. Never skip this step, never batch changes silently. Every edit = a push.

**DO NOT push `workspaces/` or `published/` directories** — these are runtime artifacts that live only on Replit. They are excluded from platform pushes via the deny list in `github.js`. Published project apps are pushed separately by the publish pipeline under their project slug subdirectory. Only push workspace files if the user explicitly asks.

## DEPLOYMENT DISASTER LOG — NEVER REPEAT THESE MISTAKES

### 1. VERIFY GIT REMOTE BEFORE EVERY PUSH
**Mistake**: Agent never configured a GitHub remote. ForgeOS was pushing to `gitsafe-backup` (Replit's internal backup), not to GitHub. Every `git push` went nowhere. **Before committing anything**, run `git remote -v` and confirm `origin` points to `https://github.com/BrianBMorgan/ForgeOS.git`.

### 2. VERIFY ALL CRITICAL FILES ARE TRACKED
**Mistake**: Agent never committed `server/memory/`. A core module was running locally and never made it to GitHub or Render. **Before every push**, run `git status` and `git ls-files` to confirm critical directories (`server/memory/`, `server/chat/`, `server/publish/`, etc.) are tracked.

### 3. NEVER HARDCODE CLAUDE MODEL STRINGS
**Mistake**: Agent hardcoded `claude-sonnet-4-5` into the workspace builder prompt. That model does not exist. Every workspace app build failed with a 404. Agent then tried to blame valid model strings like `claude-sonnet-4-6`. **Model names belong in `server/builder.js` only.** Never put them in prompts or generated code.

### 4. DO NOT OVER-ENGINEER SIMPLE FIXES
**Mistake**: Agent built a six-part infrastructure fix (new API endpoint, new database function, new callback prop, client rebuild) for a one-line UI state problem. When a button needs to disappear, flip the flag in local state. That's it.

### PRE-PUSH CHECKLIST
Before every push: **verify the remote, verify the files, verify the models.**

## Overview
ForgeOS is an internal agentic AI build platform designed to orchestrate a Planner → Reviewer → Policy Gate → Human Approval → Executor → Auditor pipeline. It uses Anthropic Claude models exclusively to generate, review, and refine structured build plans, produce runnable code, and launch live applications. The platform supports iterative development, allowing follow-up prompts to evolve existing applications with full context of the current codebase.

## User Preferences

### CRITICAL: DO NOT HARDCODE CLAUDE MODEL NAMES INTO CODE
**Mistake that was made**: Replit Agent hardcoded `claude-sonnet-4-5` into `server/pipeline/agents.js` as the default model for workspace builds, causing every Claude-built app to fail with 404 "model not found" errors. Agent also incorrectly told ForgeOS that valid model strings like `claude-sonnet-4-6` did not exist, forcing downgrades to inferior models.

**Rule**: Never hardcode Claude model strings into prompts or generated code. Model strings belong in one place — `server/builder.js` or equivalent config. The workspace builder prompt must never specify a model name — that's ForgeOS's job, not the prompt's job. Do not tell the ForgeOS agent that models don't exist or force it to use specific models. The user controls which models are available through the Settings system.

### DO NOT CHANGE BRAIN EMBEDDING DIMENSIONS
Brain memory (`server/memory/brain.js`) uses Voyage AI `voyage-code-3` with **1024 dimensions**. This is correct and must not be changed. Do not set it to 1536 or any other value. The user has fixed this — do not undo it.

## System Architecture
**Frontend**: Built with React, Vite, and TypeScript in the `/client` directory. The UI features a three-zone layout: a collapsible sidebar for navigation, a project list, and a main workspace area. The workspace is a tabbed interface including Plan, Review, Diff, Auditor, Render (live preview + file viewer), and Shell (build logs). The styling is dark-mode only, featuring an institutional, calm, and operational aesthetic.

**Backend**: An Express (Node.js) server located in `/server`.
- **Agent Orchestration**: The `server/pipeline/` module manages the agent workflow, defining Zod schemas for agent outputs and instruction prompts for each stage (Planner, Reviewer, Policy Gate, Executor, Auditor), including iteration-aware variants. It handles run creation, stage execution, approval/rejection flows, and workspace build/run processes.
- **Project Management**: `server/projects/` manages projects, including an in-memory store, iteration tracking, and file capture for context. Each project can have multiple build iterations.
- **Workspace Management**: `server/workspace/` handles the lifecycle of generated applications, including creating isolated directories, writing generated files, patching ports, installing dependencies, starting applications, and proxying requests. Workspaces automatically stop after 5 minutes of inactivity and can auto-wake on demand.
- **Proxy Body Forwarding**: Both the preview proxy (`/preview/:runId`) and published apps proxy (`/apps/:slug`) re-serialize `req.body` into a Buffer for POST/PUT/PATCH requests, since `express.json()` middleware consumes the raw request stream before the proxy handlers run. Without this, `req.pipe(proxyReq)` sends an empty body.
- **Chat System**: A conversational interface powered by claude-haiku-4-5-20251001 allows users to interact with the project. It features an agent that can analyze code, answer questions, diagnose issues, and use web search + diagnose_system tools. The `diagnose_system` tool checks env vars, API connectivity, model config, DB health, pipeline run errors, and workspace status. The chat agent is instructed to call it FIRST when users report failures. There is also a standalone `/api/diagnostics` endpoint. Slash commands trigger skill autocomplete. The system includes response parsing and banned pattern enforcement.
- **Database Viewer**: The workspace includes a DB tab for read-only inspection of the Neon Postgres database, offering a table browser, paginated data grid, and a SQL query runner with blocked DDL statements.
- **Per-Project Environment Variables**: Each project can have custom environment variables (stored in `project_env_vars` table) injected into workspace processes.
- **Settings System**: `server/settings/manager.js` manages global platform settings, secrets, and skills. This includes model configuration, auto-approve policy, default environment variables, a global secrets vault, workspace limits, allowed tech stack, and a skills library.
- **Pipeline Accountability System**: Implements checks like iteration history injection, diff verification gate, regression guard, and workspace health checks to ensure agent accountability and catch failures.
- **Model Router**: `server/pipeline/model-router.js` routes all AI calls exclusively through Anthropic Claude via `@anthropic-ai/sdk` (using `ANTHROPIC_API_KEY` env var directly). Non-Claude model names are automatically redirected to Claude with a warning log. Structured output uses system prompt injection with JSON schema + Zod validation. JSON schema conversion uses `zod-to-json-schema`. Tracks token usage (prompt/completion/total) per API call via `getLastUsage()`. Available models: `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-haiku-4-5-20251001`. The `openai` npm package has been removed from the project.
- **Token Usage Tracking**: The pipeline captures Anthropic token usage per stage (planner, reviewer, policy_gate, executor, auditor) on each run. Usage data includes per-stage breakdowns (tokens + call count) and totals.
- **Static Site Support**: Workspace manager auto-detects static sites (index.html present, no server/start script) and serves them with a built-in Node.js static file server (`__static_server.js`). Pipeline runner also triggers auto-start for static sites.
- **Persistence**: Projects, iterations, run snapshots, chat messages, project env vars, settings, secrets, and skills are persisted in Neon Postgres via `@neondatabase/serverless`.

**Pipeline Stages**:
1.  **Planner**: Generates structured build plans.
2.  **Reviewer P1 & P2**: Reviews plans for issues.
3.  **Revise P2**: Incorporates reviewer feedback.
4.  **Policy Gate**: Determines if human approval is required.
5.  **Human Approval**: Manual approval or rejection pause point.
6.  **Executor**: Produces complete runnable code.
7.  **Auditor**: A pre-deployment quality gate with a 15-point checklist. Includes plan deviation detection (`planDeviationDetected` / `planDeviationNote` fields) — when the Executor builds a mechanism not specified in the approved plan, the Auditor flags it and the Fix pass reverts to the plan-specified approach rather than patching the deviation.

**MCP Server**: ForgeOS includes a built-in MCP (Model Context Protocol) server at `/mcp` that exposes ElevenLabs tools for voice synthesis and speech-to-text.

**Voice Agent**: An embedded ElevenLabs Conversational AI voice agent widget provides a voice interface for user interaction within the UI. Includes a WebSocket intercept bridge that captures agent responses and injects them into the ForgeOS prompt textarea when the call ends, with a manual "Send to Prompt" button and Alt+P shortcut.

**Brain (Persistent Memory)**: `server/memory/brain.js` gives ForgeOS persistent memory across builds. Learns patterns, preferences, mistakes, and project history from every build. Context is injected into Claude's system prompt before each build (with 5s timeout guard). Memory extraction happens non-blocking after successful builds via Haiku. The brain also tracks conversation history per project and maintains a team preferences store. API routes: `GET /api/brain` (summary), `POST /api/brain/upvote/:id`. DB tables: `forge_memory`, `forge_project_index`, `forge_team_prefs`, `forge_conversations`. All brain operations are non-fatal — failures never block builds.

**Publishing System**: `server/publish/manager.js` publishes ForgeOS-built projects. The pipeline: copy workspace → install deps → build (auto-detected from package.json) → start on ports 4100-4199 → proxy at `/apps/:slug`. Supports both new builder (`stages.builder.output`) and legacy executor (`stages.executor.output`) for command resolution and file restore from snapshots. Published apps are also automatically pushed to GitHub (`server/publish/github.js`) as a subdirectory of the configured repo (default: `BrianBMorgan/ForgeOS`). GitHub settings (repo, auto-push toggle) are configurable in Settings → GitHub tab. The `GITHUB_TOKEN` secret provides push access. The `published_apps` DB table tracks state.

**Path-Prefix Proxy Rewriting**: Both `/preview/:runId` and `/apps/:slug` proxies handle the path-prefix problem via three functions in `server/index.js`:
- `rewriteHtmlForProxy()` — rewrites `href`, `src`, `action`, `formaction`, `srcset` attributes and inline `<style>` blocks; injects a runtime script patching `fetch()` (string + Request objects), `XMLHttpRequest.open()`, and `history.pushState/replaceState`
- `rewriteCssForProxy()` — rewrites `url('/...')` references in CSS files served through the proxy
- `rewriteLocationHeader()` — rewrites `Location` headers on redirect responses (302, 301, etc.)
- Proxy strips `accept-encoding` from forwarded requests to ensure responses arrive uncompressed for reliable text rewriting
- Agent instructions (Executor, Executor Iterate, Executor Fix, Auditor) enforce root-relative paths for fetch, HTML attributes, AND CSS url() references. Agents must NOT inject base path variables, URL helpers, or `<base>` tags.

## External Dependencies
- **Anthropic Claude**: The exclusive AI provider for all pipeline stages (Planner, Reviewer, Policy Gate, Executor, Auditor) and the conversational chat interface. Uses `@anthropic-ai/sdk` with `ANTHROPIC_API_KEY` directly (no Replit integration proxy). Default models: `claude-sonnet-4-6` (planner/executor), `claude-haiku-4-5-20251001` (reviewer/chat). OpenAI and `API_SECRET_KEY` are banned — `ANTHROPIC_API_KEY` is the only valid AI key. The sanitizer in `runner.js` strips both `OPENAI_API_KEY` and `API_SECRET_KEY` from all plans automatically.
- **Neon Postgres**: Utilized for project persistence and can be provisioned for generated applications.
- **@neondatabase/serverless**: Node.js driver for Neon Postgres.
- **http-proxy-middleware**: For proxying requests to running workspace applications.
- **uuid**: For generating unique identifiers.
- **zod**: For schema validation of agent outputs.
- **DuckDuckGo**: Integrated via the chat agent's `web_search` tool for fetching external information.
- **ElevenLabs**: Integrated for voice synthesis (TTS) and speech-to-text (STT) capabilities via the MCP server and embedded voice agent.