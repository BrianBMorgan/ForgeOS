# ForgeOS

## Overview
ForgeOS is a private internal agentic AI build platform — a thin control plane UI for orchestrating a Planner → Reviewer → Policy Gate → Human Approval → Executor pipeline.

## Architecture
- **Frontend**: React + Vite + TypeScript in `/client`
- **Backend**: Express (Node.js) in `/server` (only `index.js`)
- **Root**: `package.json` with shared dependencies and orchestration scripts

## UI Structure
Three-zone layout:
- **Sidebar** (~240px, collapsible to 60px icon rail): New Build, Active Runs, Templates, Logs, Settings
- **Prompt Column** (25%): Build prompt textarea, Run Build button, pipeline stage timeline, metadata
- **Workspace** (75%): Tabbed browser-like interface — Plan, Review, Diff, Render, Shell, DB, Publish

## Component Files
- `client/src/App.tsx` — Main shell layout with sidebar + content split
- `client/src/components/PromptColumn.tsx` — Prompt input and pipeline stages
- `client/src/components/Workspace.tsx` — Tabbed workspace panels
- `client/src/index.css` — All styling (dark theme, institutional aesthetic)

## Development
- `npm run dev` — runs Vite dev server (port 5000) and Express API (port 3001) concurrently
- `npm run build` — builds the React client to `client/dist`
- `npm start` — runs Express in production mode, serving the built client on port 5000

## Production
Express serves static files from `client/dist` and falls back to `index.html` for SPA routing.

## Key Routes
- `GET /health` — returns `{ status: "ok" }`

## Dependencies
- **Root**: concurrently, express
- **Client**: react, react-dom, vite, typescript, @vitejs/plugin-react

## Render Deployment
- Build Command: `npm install && npm run install:all && npm run build`
- Start Command: `npm start`

## Design Direction
- Dark mode only (#0F172A base, #111827/#1E293B panels, #3B82F6 accent blue)
- Institutional, calm, operational aesthetic
- Grid background on prompt column
- No chat bubbles, no playful startup chrome

## Notes
- No database, authentication, or CI configured yet
- Agent pipeline (Planner/Reviewer/Policy/Executor) runs externally — UI will wire to it later
- Designed for deployment as a single Web Service on Render
