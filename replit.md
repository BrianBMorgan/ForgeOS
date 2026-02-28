# ForgeOS

## Overview
ForgeOS is a unified full-stack web application scaffold with a React frontend and Express backend in a single repository.

## Architecture
- **Frontend**: React + Vite + TypeScript in `/client` (has its own `package.json`)
- **Backend**: Express (Node.js) in `/server` (only `index.js`, no separate package.json)
- **Root**: `package.json` with all shared dependencies (express, concurrently) and orchestration scripts

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

## Notes
- No database, authentication, or CI configured yet
- Designed for deployment as a single Web Service on Render
