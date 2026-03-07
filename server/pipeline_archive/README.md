# Pipeline Archive

Archived on 2026-03-07. The original multi-agent pipeline has been disconnected
from the active routes in `server/index.js` but all source files are preserved
here and in `server/pipeline/` (which is still required by chat, publish, and
workspace managers for utility functions like `getRun`).

## Archived Pipeline Flow
Planner → Reviewer → Policy Gate → Human Approval → Executor → Auditor

## Files
- `agents.js` — System prompts for all pipeline agents (Planner, Reviewer, Executor, Auditor)
- `model-router.js` — Anthropic Claude API interface (callStructured, callChat)
- `runner.js` — Pipeline orchestration engine (executePipeline, handleApproval, handleRejection)
- `schemas.js` — Zod schemas for pipeline stage outputs
- `chat-manager.js` — Chat agent manager (conversational AI for project context)
- `chat-search.js` — Web search capability for chat agent

## What Was Disconnected
- `POST /api/runs` — no longer executes pipeline
- `POST /api/runs/:id/approve` — stubbed (501)
- `POST /api/runs/:id/reject` — stubbed (501)
- `POST /api/projects` — creates project but does not trigger pipeline
- `POST /api/projects/:id/iterate` — stubbed (501)

## What Still Works
- All project CRUD (list, get, delete, rename)
- Workspace management (start, stop, restart, shell, file viewer)
- Publish system (publish, unpublish, export)
- Settings, secrets, skills, DB viewer
- Chat (still uses model-router.js and agents.js from server/pipeline/)
- ElevenLabs voice agent
- Stress test infrastructure
