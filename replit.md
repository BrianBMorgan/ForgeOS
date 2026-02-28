# ForgeOS

## Overview
ForgeOS is a private internal agentic AI build platform — a thin control plane UI for orchestrating a Planner → Reviewer → Policy Gate → Human Approval → Executor pipeline. The pipeline uses OpenAI models to generate, review, and refine structured build plans, then the Executor produces complete runnable code that gets written to disk, built, and launched as a live app.

## Architecture
- **Frontend**: React + Vite + TypeScript in `/client`
- **Backend**: Express (Node.js) in `/server`
  - `server/index.js` — Express app with API routes and preview proxy
  - `server/pipeline/` — Agent orchestration engine
    - `schemas.js` — Zod schemas for Planner, Reviewer, Policy Gate, Executor outputs
    - `agents.js` — Agent instruction prompts for each pipeline stage
    - `runner.js` — Pipeline orchestration: run creation, stage execution, approval/rejection flow, workspace build & run
  - `server/workspace/` — Workspace manager for generated apps
    - `manager.js` — File writing, dependency installation, app process management per run

## Workspace System
After the Executor produces code, ForgeOS automatically:
1. Creates an isolated workspace directory (`workspaces/<runId>/`)
2. Writes all generated files to disk
3. Runs the install command (e.g., `npm install`)
4. Starts the app process (e.g., `node server.js`)
5. Proxies requests through `/preview?runId=<id>` to the running app
- Workspace states: writing-files → installing → starting → running (or failed at any step)
- Generated apps run on port 4000 by default (ForgeOS uses 3001/5000)
- Previous workspace apps are stopped when a new run starts

## UI Structure
Three-zone layout:
- **Sidebar** (~240px, collapsible to 60px icon rail): New Build, Active Runs, Templates, Logs, Settings
- **Prompt Column** (25%): Build prompt textarea, Run Build button, pipeline stage timeline with live status dots, approval controls (Approve/Reject buttons), metadata
- **Workspace** (75%): Tabbed browser-like interface — Plan, Review, Diff, Render, Shell, DB, Publish

## Component Files
- `client/src/App.tsx` — Main shell layout, shared run state, API integration (polling, approve/reject)
- `client/src/components/PromptColumn.tsx` — Prompt input, pipeline stage visualization, approval controls
- `client/src/components/Workspace.tsx` — Tabbed workspace with Plan, Review, Diff, Render (live preview + file viewer), and Shell (build logs) tabs
- `client/src/index.css` — All styling (dark theme, institutional aesthetic)

## API Routes
- `GET /health` — Health check
- `POST /api/runs` — Start a new pipeline run (body: `{ prompt: string }`)
- `GET /api/runs` — List all runs
- `GET /api/runs/:id` — Get run status, stages, outputs, and workspace status
- `GET /api/runs/:id/logs` — Get workspace build/install/app logs
- `POST /api/runs/:id/approve` — Approve a run awaiting human approval
- `POST /api/runs/:id/reject` — Reject with feedback (body: `{ feedback: string }`)
- `/preview?runId=<id>` — Proxies to the running workspace app

## Pipeline Stages
1. **Planner** — Generates structured build plan from user prompt (gpt-4.1)
2. **Reviewer P1** — Reviews plan for gaps, risks, security issues (gpt-4.1-mini, temp 0.2)
3. **Revise P2** — Incorporates reviewer feedback into revised plan (gpt-4.1)
4. **Reviewer P2** — Final production-readiness review (gpt-4.1-mini, temp 0.2)
5. **Policy Gate** — Determines auto-approve vs human-approval-required (gpt-4.1-mini)
6. **Human Approval** — Pauses for approve/reject; rejection triggers Pass 3 revision loop
7. **Executor** — Produces complete runnable code with file contents, install/start commands, port (gpt-4.1)

## Executor Output Schema
- `files[]` — Array of `{ path, purpose, content }` — complete source code for every file
- `installCommand` — e.g., "npm install"
- `startCommand` — e.g., "node server.js"
- `port` — Port the generated app listens on (default 4000)
- `implementationSummary`, `environmentVariables`, `databaseSchema`, `buildTasks`

## Development
- `npm run dev` — runs Vite dev server (port 5000) and Express API (port 3001) concurrently
- `npm run build` — builds the React client to `client/dist`
- `npm start` — runs Express in production mode, serving the built client
- Vite proxy: `/api`, `/health`, and `/preview` routes proxied to Express backend

## Production
Express serves static files from `client/dist` and falls back to `index.html` for SPA routing.

## Dependencies
- **Root**: concurrently, express, openai, zod, uuid, http-proxy-middleware
- **Client**: react, react-dom, vite, typescript, @vitejs/plugin-react

## Environment Variables
- `OPENAI_API_KEY` — Required for pipeline agent calls
- `PORT` — Express server port (default 3001, or set by hosting platform)
- `NODE_ENV` — Set to "production" for static file serving

## Render Deployment
- Build Command: `npm install && npm run install:all && npm run build`
- Start Command: `npm start`

## Design Direction
- Dark mode only (#0F172A base, #111827/#1E293B panels, #3B82F6 accent blue)
- Institutional, calm, operational aesthetic
- No chat bubbles, no playful startup chrome
- No Replit-specific dependencies — fully portable

## Current State
- Pipeline runs in-memory (no database persistence yet)
- Agent pipeline fully functional with OpenAI API
- Executor generates complete runnable code (Layer 1)
- Workspace manager writes files, installs deps, starts apps (Layer 2)
- Live preview via iframe in Render tab (Layer 3)
- Build/runtime logs in Shell tab
- Future phases: self-correction (Layer 4), context management, database persistence
