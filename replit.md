# ForgeOS

## Overview
ForgeOS is an internal agentic AI build platform designed to orchestrate a Planner → Reviewer → Policy Gate → Human Approval → Executor → Auditor pipeline. It uses OpenAI models to generate, review, and refine structured build plans, produce runnable code, and launch live applications. The platform supports iterative development, allowing follow-up prompts to evolve existing applications with full context of the current codebase.

## User Preferences
None specified.

## System Architecture
**Frontend**: Built with React, Vite, and TypeScript in the `/client` directory. The UI features a three-zone layout: a collapsible sidebar for navigation, a project list, and a main workspace area. The workspace is a tabbed interface including Plan, Review, Diff, Auditor, Render (live preview + file viewer), and Shell (build logs). The styling is dark-mode only, featuring an institutional, calm, and operational aesthetic with no playful elements or Replit-specific dependencies.

**Backend**: An Express (Node.js) server located in `/server`.
- **Agent Orchestration**: The `server/pipeline/` module manages the agent workflow, defining Zod schemas for agent outputs and instruction prompts for each stage (Planner, Reviewer, Policy Gate, Executor, Auditor), including iteration-aware variants. It handles run creation, stage execution, approval/rejection flows, and workspace build/run processes.
- **Project Management**: `server/projects/` manages projects, including an in-memory store, iteration tracking, and file capture for context. Each project can have multiple build iterations.
- **Workspace Management**: `server/workspace/` handles the lifecycle of generated applications. It creates isolated directories, writes generated files, patches hardcoded ports to use `process.env.PORT`, resolves `npm start` commands, allocates dynamic ports (4000-4099), installs dependencies, starts applications, and proxies requests. It also manages workspace states (writing-files, installing, starting, running, failed) and ensures previous workspace apps are stopped when new runs begin. Stop/restart controls are available in the Shell tab header — `restartApp()` stores `lastStartCommand`/`lastPort` for re-launching; if workspace isn't in memory, the restart endpoint falls back to `restoreWorkspace()` using executor output from the run snapshot.
- **Chat System**: A conversational interface powered by gpt-4.1-mini allows users to interact with the project. It features an agent that can analyze code, answer questions, diagnose issues, and use web search tools (DuckDuckGo, URL fetching) to gather external information. It detects user intent to suggest builds, which can be confirmed to trigger an iteration.
- **Database Viewer**: The workspace includes a DB tab for read-only inspection of the Neon Postgres database. It offers a table browser, a paginated data grid, and a SQL query runner with blocked DDL statements for safety.
- **Per-Project Environment Variables**: Each project can have custom environment variables (stored in `project_env_vars` table) that are injected into workspace processes during install and app start. CRUD via `GET/PUT/DELETE /api/projects/:id/env`. Reserved system keys (PORT, DATABASE_URL, JWT_SECRET, etc.) are blocked from override at both API and runtime levels. The Env tab in the workspace UI provides add/delete/show-hide controls and lists auto-injected platform variables.
- **Persistence**: Projects, iterations, run snapshots, chat messages, and project env vars are persisted in Neon Postgres via `@neondatabase/serverless`. Run data survives restarts, and the system can restore and re-launch workspace applications from existing files on disk upon server startup.

**Pipeline Stages**:
1.  **Planner**: Generates structured build plans from user prompts, adapting for iterations.
2.  **Reviewer P1 & P2**: Reviews plans for issues and ensures production readiness.
3.  **Revise P2**: Incorporates reviewer feedback into the plan.
4.  **Policy Gate**: Determines if human approval is required.
5.  **Human Approval**: A pause point for manual approval or rejection.
6.  **Executor**: Produces complete runnable code, outputting all files (modified and unchanged) for iterations.
7.  **Auditor**: A pre-deployment quality gate that performs an 11-point checklist and can trigger fix loops.

**Executor Output**: Includes an array of files with `path`, `purpose`, and `content`, along with `installCommand`, `startCommand`, `port`, `implementationSummary`, `environmentVariables`, `databaseSchema`, and `buildTasks`.

## External Dependencies
- **OpenAI**: Used for agent pipeline calls (Planner, Reviewer, Policy Gate, Executor, Auditor) and the conversational chat interface.
- **Neon Postgres**: Utilized for project persistence (projects, iterations, run snapshots, chat messages) and can be provisioned for generated applications via `DATABASE_URL`.
- **@neondatabase/serverless**: Node.js driver for Neon Postgres.
- **http-proxy-middleware**: For proxying requests to running workspace applications.
- **uuid**: For generating unique identifiers.
- **zod**: For schema validation of agent outputs.
- **DuckDuckGo**: Integrated via the chat agent's `web_search` tool for fetching external information.