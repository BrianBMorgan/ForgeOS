# ForgeOS

## Overview
ForgeOS is an internal agentic AI build platform designed to orchestrate a Planner → Reviewer → Policy Gate → Human Approval → Executor → Auditor pipeline. It uses OpenAI models to generate, review, and refine structured build plans, produce runnable code, and launch live applications. The platform supports iterative development, allowing follow-up prompts to evolve existing applications with full context of the current codebase.

## User Preferences
None specified.

## System Architecture
**Frontend**: Built with React, Vite, and TypeScript in the `/client` directory. The UI features a three-zone layout: a collapsible sidebar for navigation, a project list, and a main workspace area. The workspace is a tabbed interface including Plan, Review, Diff, Auditor, Render (live preview + file viewer), and Shell (build logs). The styling is dark-mode only, featuring an institutional, calm, and operational aesthetic.

**Backend**: An Express (Node.js) server located in `/server`.
- **Agent Orchestration**: The `server/pipeline/` module manages the agent workflow, defining Zod schemas for agent outputs and instruction prompts for each stage (Planner, Reviewer, Policy Gate, Executor, Auditor), including iteration-aware variants. It handles run creation, stage execution, approval/rejection flows, and workspace build/run processes.
- **Project Management**: `server/projects/` manages projects, including an in-memory store, iteration tracking, and file capture for context. Each project can have multiple build iterations.
- **Workspace Management**: `server/workspace/` handles the lifecycle of generated applications, including creating isolated directories, writing generated files, patching ports, installing dependencies, starting applications, and proxying requests. Workspaces automatically stop after 5 minutes of inactivity and can auto-wake on demand.
- **Chat System**: A conversational interface powered by gpt-4.1-mini allows users to interact with the project. It features an agent that can analyze code, answer questions, diagnose issues, and use web search tools. It detects user intent to suggest builds and incorporates runtime logs for diagnosis. Slash commands trigger skill autocomplete. The system includes a robust response parsing and banned pattern enforcement mechanism to ensure quality and adherence to guidelines.
- **Database Viewer**: The workspace includes a DB tab for read-only inspection of the Neon Postgres database, offering a table browser, paginated data grid, and a SQL query runner with blocked DDL statements.
- **Per-Project Environment Variables**: Each project can have custom environment variables (stored in `project_env_vars` table) injected into workspace processes.
- **Settings System**: `server/settings/manager.js` manages global platform settings, secrets, and skills. This includes model configuration, auto-approve policy, default environment variables, a global secrets vault, workspace limits, allowed tech stack, and a skills library.
- **Pipeline Accountability System**: Implements checks like iteration history injection, diff verification gate, regression guard, and workspace health checks to ensure agent accountability and catch failures.
- **Model Router**: `server/pipeline/model-router.js` provides a model-agnostic abstraction over OpenAI's Chat Completions and Responses APIs, routing calls based on the model used and normalizing tool calls. Tracks token usage (prompt/completion/total) per API call via `getLastUsage()`.
- **Token Usage Tracking**: The pipeline captures OpenAI token usage per stage (planner, reviewer, policy_gate, executor, auditor) on each run. Usage data includes per-stage breakdowns (tokens + call count) and totals with estimated cost. Displayed in the PromptColumn sidebar below iteration info. Cost estimate uses gpt-4o pricing ($2.50/M prompt, $10/M completion).
- **Static Site Support**: Workspace manager auto-detects static sites (index.html present, no server/start script) and serves them with a built-in Node.js static file server (`__static_server.js`). Pipeline runner also triggers auto-start for static sites.
- **Persistence**: Projects, iterations, run snapshots, chat messages, project env vars, settings, secrets, and skills are persisted in Neon Postgres via `@neondatabase/serverless`.

**Pipeline Stages**:
1.  **Planner**: Generates structured build plans.
2.  **Reviewer P1 & P2**: Reviews plans for issues.
3.  **Revise P2**: Incorporates reviewer feedback.
4.  **Policy Gate**: Determines if human approval is required.
5.  **Human Approval**: Manual approval or rejection pause point.
6.  **Executor**: Produces complete runnable code.
7.  **Auditor**: A pre-deployment quality gate with a 14-point checklist.

**MCP Server**: ForgeOS includes a built-in MCP (Model Context Protocol) server at `/mcp` that exposes ElevenLabs tools for voice synthesis and speech-to-text.

**Voice Agent**: An embedded ElevenLabs Conversational AI voice agent widget provides a voice interface for user interaction within the UI. Includes a WebSocket intercept bridge that captures agent responses and injects them into the ForgeOS prompt textarea when the call ends, with a manual "Send to Prompt" button and Alt+P shortcut.

**Publishing System**: `server/publish/manager.js` publishes ForgeOS-built projects. The pipeline: copy workspace → install deps → build (auto-detected from package.json) → start on ports 4100-4199 → proxy at `/apps/:slug`. Published apps are also automatically pushed to GitHub (`server/publish/github.js`) as a subdirectory of the configured repo (default: `BrianBMorgan/ForgeOS`). GitHub settings (repo, auto-push toggle) are configurable in Settings → GitHub tab. The `GITHUB_TOKEN` secret provides push access. The `published_apps` DB table tracks state.

## External Dependencies
- **OpenAI**: Used for agent pipeline calls (Planner, Reviewer, Policy Gate, Executor, Auditor) and the conversational chat interface.
- **Neon Postgres**: Utilized for project persistence and can be provisioned for generated applications.
- **@neondatabase/serverless**: Node.js driver for Neon Postgres.
- **http-proxy-middleware**: For proxying requests to running workspace applications.
- **uuid**: For generating unique identifiers.
- **zod**: For schema validation of agent outputs.
- **DuckDuckGo**: Integrated via the chat agent's `web_search` tool for fetching external information.
- **ElevenLabs**: Integrated for voice synthesis (TTS) and speech-to-text (STT) capabilities via the MCP server and embedded voice agent.