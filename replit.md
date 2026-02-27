# ForgeOS

## Overview
ForgeOS is a unified full-stack web application scaffold with a React frontend and Express backend in a single repository.

## Architecture
- **Frontend**: React + Vite + TypeScript in `/client`
- **Backend**: Express (Node.js) in `/server`
- **Root**: Orchestration `package.json` with scripts for dev, build, and start

## Development
- `npm run dev` — runs Vite dev server (port 5000) and Express API (port 3001) concurrently
- `npm run build` — builds the React client to `client/dist`
- `npm start` — runs Express in production mode, serving the built client on port 5000

## Production
Express serves static files from `client/dist` and falls back to `index.html` for SPA routing.

## Key Routes
- `GET /health` — returns `{ status: "ok" }`

## Dependencies
- **Root**: concurrently
- **Client**: react, react-dom, vite, typescript, @vitejs/plugin-react
- **Server**: express

## Notes
- No database, authentication, or CI configured yet
- Designed for deployment as a single Web Service on Render
