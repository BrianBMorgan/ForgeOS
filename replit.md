# ForgeOS

## Overview
ForgeOS is an internal agentic AI build platform designed to orchestrate a Planner → Reviewer → Policy Gate → Human Approval → Executor → Auditor pipeline. It uses Anthropic Claude models exclusively to generate, review, and refine structured build plans, produce runnable code, and launch live applications. The platform supports iterative development, allowing follow-up prompts to evolve existing applications with full context of the current codebase.

## User Preferences

### CRITICAL: DO NOT HARDCODE CLAUDE MODEL NAMES INTO CODE
**Mistake that was made**: Replit Agent hardcoded `claude-sonnet-4-5` into `server/pipeline/agents.js` as the default model for workspace builds, causing every Claude-built app to fail with 404 "model not found" errors. Agent also incorrectly told ForgeOS that valid model strings like `claude-sonnet-4-6` did not exist, forcing downgrades to inferior models.

**Rule**: Never hardcode Claude model strings into prompts or generated code. Model strings belong in one place — `server/builder.js` or equivalent config. The workspace builder prompt must never specify a model name — that's ForgeOS's job, not the prompt's job. Do not tell the ForgeOS agent that models don't exist or force it to use specific models. The user controls which models are available through the Settings system.

### DO NOT CHANGE BRAIN EMBEDDING DIMENSIONS
Brain memory (`server/memory/brain.js`) uses Voyage AI `voyage-code-3` with **1024 dimensions**. This is correct and must not be changed. Do not set it to 1536 or any other value. The user has fixed this — do not undo it.

## System Architecture
**Frontend**: Built with React, Vite, and TypeScript in the `/client` directory, featuring a three-zone layout (sidebar, project list, main workspace) with a dark-mode, institutional aesthetic. The workspace is a tabbed interface including Plan, Review, Diff, Auditor, Render (live preview + file viewer), and Shell (build logs). Mobile responsive at 679px breakpoint: sidebar becomes horizontal top menu, chat/workspace toggle at bottom, workspace tabs become bottom nav bar.

**Backend**: An Express (Node.js) server in `/server`.
- **Agent Orchestration**: `server/pipeline/` manages agent workflows using Zod schemas for structured outputs and instruction prompts for each stage (Planner, Reviewer, Policy Gate, Human Approval, Executor, Auditor), supporting iteration-aware variants.
- **Project & Workspace Management**: `server/projects/` manages project iterations and context capture, while `server/workspace/` handles the lifecycle of generated applications (isolated directories, file writing, port patching, dependency installation, starting, proxying). Workspaces stop after 5 mins of inactivity and auto-wake.
- **Proxy Body Forwarding**: Proxies (`/preview/:runId`, `/apps/:slug`) re-serialize `req.body` into a Buffer for POST/PUT/PATCH requests to ensure correct body forwarding.
- **Chat System**: A conversational interface powered by `claude-haiku-4-5-20251001` with an agent capable of code analysis, issue diagnosis, and tool usage (`web_search`, `diagnose_system`). A `/api/diagnostics` endpoint is also available.
- **Database Viewer**: A DB tab provides read-only inspection of the Neon Postgres database with a table browser, data grid, and SQL query runner (DDL blocked).
- **Per-Project Environment Variables**: Custom environment variables can be injected into workspace processes.
- **Settings System**: `server/settings/manager.js` manages global platform settings, secrets, and skills (model config, auto-approve policy, default env vars, global secrets vault, workspace limits, allowed tech stack, skills library).
- **Pipeline Accountability**: Includes iteration history injection, diff verification, regression guard, and workspace health checks.
- **Model Router**: `server/pipeline/model-router.js` routes all AI calls exclusively through Anthropic Claude via `@anthropic-ai/sdk`. Non-Claude model names are redirected. Structured output uses system prompt injection with JSON schema + Zod validation. Tracks token usage per API call. Available models: `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-haiku-4-5-20251001`.
- **Token Usage Tracking**: Captures Anthropic token usage per pipeline stage.
- **Static Site Support**: Workspace manager auto-detects static sites and serves them with a built-in Node.js static file server.
- **Persistence**: Projects, iterations, run snapshots, chat messages, project env vars, settings, secrets, and skills are persisted in Neon Postgres.
- **Pipeline Stages**: Planner, Reviewer P1 & P2, Revise P2, Policy Gate, Human Approval, Executor, and Auditor (pre-deployment quality gate with 15-point checklist and plan deviation detection).
- **MCP Server**: Includes a built-in Model Context Protocol (MCP) server at `/mcp` exposing ElevenLabs tools.
- **Voice Agent**: An embedded ElevenLabs Conversational AI widget provides a voice interface, with a WebSocket intercept bridge for injecting agent responses into the prompt textarea.
- **Brain (Persistent Memory)**: `server/memory/brain.js` provides persistent memory across builds by learning from patterns, preferences, mistakes, and project history, injecting context into Claude's system prompt. Tracks conversation history and team preferences.
- **Publishing System**: `server/publish/manager.js` publishes projects by copying workspaces, installing dependencies, building, starting on ports 4100-4199, and proxying. Published apps are also pushed to GitHub.
- **Path-Prefix Proxy Rewriting**: Proxies rewrite HTML attributes, CSS `url()` references, and `Location` headers to handle path-prefixing, and strip `accept-encoding` for reliable text rewriting. Agent instructions enforce root-relative paths.

## External Dependencies
- **Anthropic Claude**: Exclusive AI provider for all pipeline stages and conversational chat, using `@anthropic-ai/sdk` with `ANTHROPIC_API_KEY`.
- **Neon Postgres**: Primary database for persistence and available for generated applications.
- **@neondatabase/serverless**: Node.js driver for Neon Postgres.
- **http-proxy-middleware**: For proxying requests to workspace applications.
- **uuid**: For generating unique identifiers.
- **zod**: For schema validation of agent outputs.
- **DuckDuckGo**: Integrated via the chat agent's `web_search` tool.
- **ElevenLabs**: Integrated for voice synthesis (TTS) and speech-to-text (STT) via the MCP server and embedded voice agent.