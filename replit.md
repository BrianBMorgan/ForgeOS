# ForgeOS

## Overview
ForgeOS is a private internal agentic AI build platform — a thin control plane UI for orchestrating a Planner → Reviewer → Policy Gate → Human Approval → Executor pipeline. The pipeline uses OpenAI models to generate, review, and refine structured build plans for internal tools.

## Architecture
- **Frontend**: React + Vite + TypeScript in `/client`
- **Backend**: Express (Node.js) in `/server`
  - `server/index.js` — Express app with API routes
  - `server/pipeline/` — Agent orchestration engine
    - `schemas.js` — Zod schemas for Planner, Reviewer, Policy Gate, Executor outputs
    - `agents.js` — Agent instruction prompts for each pipeline stage
    - `runner.js` — Pipeline orchestration: run creation, stage execution, approval/rejection flow

## UI Structure
Three-zone layout:
- **Sidebar** (~240px, collapsible to 60px icon rail): New Build, Active Runs, Templates, Logs, Settings
- **Prompt Column** (25%): Build prompt textarea, Run Build button, pipeline stage timeline with live status dots, approval controls (Approve/Reject buttons), metadata
- **Workspace** (75%): Tabbed browser-like interface — Plan, Review, Diff, Render, Shell, DB, Publish

## Component Files
- `client/src/App.tsx` — Main shell layout, shared run state, API integration (polling, approve/reject)
- `client/src/components/PromptColumn.tsx` — Prompt input, pipeline stage visualization, approval controls
- `client/src/components/Workspace.tsx` — Tabbed workspace with Plan, Review, and Diff tabs rendering live agent output
- `client/src/index.css` — All styling (dark theme, institutional aesthetic)

## API Routes
- `GET /health` — Health check
- `POST /api/runs` — Start a new pipeline run (body: `{ prompt: string }`)
- `GET /api/runs` — List all runs
- `GET /api/runs/:id` — Get run status, stages, and outputs
- `POST /api/runs/:id/approve` — Approve a run awaiting human approval
- `POST /api/runs/:id/reject` — Reject with feedback (body: `{ feedback: string }`)

## Pipeline Stages
1. **Planner** — Generates structured build plan from user prompt (gpt-4.1)
2. **Reviewer P1** — Reviews plan for gaps, risks, security issues (gpt-4.1-mini, temp 0.2)
3. **Revise P2** — Incorporates reviewer feedback into revised plan (gpt-4.1)
4. **Reviewer P2** — Final production-readiness review (gpt-4.1-mini, temp 0.2)
5. **Policy Gate** — Determines auto-approve vs human-approval-required (gpt-4.1-mini)
6. **Human Approval** — Pauses for approve/reject; rejection triggers Pass 3 revision loop
7. **Executor** — Produces concrete implementation spec from approved plan (gpt-4.1)

## Development
- `npm run dev` — runs Vite dev server (port 5000) and Express API (port 3001) concurrently
- `npm run build` — builds the React client to `client/dist`
- `npm start` — runs Express in production mode, serving the built client
- Vite proxy: `/api` and `/health` routes proxied to Express backend

## Production
Express serves static files from `client/dist` and falls back to `index.html` for SPA routing.

## Dependencies
- **Root**: concurrently, express, openai, zod, uuid
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

## Current State
- Pipeline runs in-memory (no database persistence yet)
- Agent pipeline fully functional with OpenAI API
- UI wired to backend with live polling for stage updates
- Future phases: tool use for Executor, context management, error recovery, database persistence
