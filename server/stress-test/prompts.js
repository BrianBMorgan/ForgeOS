const prompts = [
  {
    id: "world-clock",
    category: "pure-frontend",
    prompt: "Build a world clock app that shows the current time in 5 different time zones (New York, London, Tokyo, Sydney, Dubai). The clocks should update every second with a clean, modern UI.",
    expectedFeatures: ["has_root_route", "no_banned_packages", "client_side_logic", "relative_fetch_urls", "uses_env_port"],
  },
  {
    id: "calculator",
    category: "pure-frontend",
    prompt: "Build a calculator app with basic arithmetic operations (add, subtract, multiply, divide), a clear button, and keyboard support. Use a grid layout for the buttons.",
    expectedFeatures: ["has_root_route", "no_banned_packages", "client_side_logic", "relative_fetch_urls", "uses_env_port"],
  },
  {
    id: "color-palette-generator",
    category: "pure-frontend",
    prompt: "Build a color palette generator that creates random 5-color palettes. Users can lock individual colors and regenerate the rest. Show hex codes and allow clicking to copy to clipboard.",
    expectedFeatures: ["has_root_route", "no_banned_packages", "client_side_logic", "relative_fetch_urls", "uses_env_port"],
  },
  {
    id: "markdown-previewer",
    category: "pure-frontend",
    prompt: "Build a live markdown previewer with a split-pane layout. Left side is a textarea for markdown input, right side shows the rendered HTML preview updating in real-time.",
    expectedFeatures: ["has_root_route", "no_banned_packages", "client_side_logic", "relative_fetch_urls", "uses_env_port"],
  },
  {
    id: "countdown-timer",
    category: "pure-frontend",
    prompt: "Build a countdown timer app where users can set hours, minutes, and seconds. Include start, pause, and reset buttons. Play a sound or flash the screen when the timer reaches zero.",
    expectedFeatures: ["has_root_route", "no_banned_packages", "client_side_logic", "relative_fetch_urls", "uses_env_port"],
  },
  {
    id: "quotes-api",
    category: "api-only",
    prompt: "Build a REST API for managing quotes. Endpoints: GET /api/quotes (list all), GET /api/quotes/random (random quote), POST /api/quotes (add new with author and text fields). Store quotes in memory. Include a root route with interactive API documentation.",
    expectedFeatures: ["has_root_route", "no_banned_packages", "relative_fetch_urls", "uses_env_port", "no_dotenv"],
  },
  {
    id: "bookmarks-api",
    category: "api-only",
    prompt: "Build a REST API for bookmarks. Endpoints: GET /api/bookmarks, POST /api/bookmarks (url, title, tags), DELETE /api/bookmarks/:id, GET /api/bookmarks/search?tag=xyz. In-memory storage. Root route should show API docs as HTML.",
    expectedFeatures: ["has_root_route", "no_banned_packages", "relative_fetch_urls", "uses_env_port", "no_dotenv"],
  },
  {
    id: "notes-api",
    category: "api-only",
    prompt: "Build a REST API for notes. Endpoints: GET /api/notes, POST /api/notes (title, body), PUT /api/notes/:id, DELETE /api/notes/:id. In-memory storage with auto-generated IDs and timestamps. Show API docs at the root route.",
    expectedFeatures: ["has_root_route", "no_banned_packages", "relative_fetch_urls", "uses_env_port", "no_dotenv"],
  },
  {
    id: "todo-app-postgres",
    category: "fullstack-db",
    prompt: "Build a todo app with Postgres persistence using Neon. Features: add todos, mark as complete, delete todos. Use a simple HTML/CSS/JS frontend served from Express. Store todos in a Postgres table with id, title, completed, and created_at columns.",
    expectedFeatures: ["has_root_route", "uses_neon_serverless", "no_banned_packages", "relative_fetch_urls", "uses_env_port", "no_dotenv", "no_dynamic_sql"],
  },
  {
    id: "inventory-tracker",
    category: "fullstack-db",
    prompt: "Build an inventory tracker with Neon Postgres. Track items with name, quantity, category, and last_updated. Endpoints for CRUD operations. Frontend with a table showing all items, forms to add/edit, and a search/filter by category.",
    expectedFeatures: ["has_root_route", "uses_neon_serverless", "no_banned_packages", "relative_fetch_urls", "uses_env_port", "no_dotenv", "no_dynamic_sql"],
  },
  {
    id: "expense-logger",
    category: "fullstack-db",
    prompt: "Build an expense logger with Neon Postgres. Track expenses with amount, description, category (food, transport, entertainment, other), and date. Show a summary of total spending by category. Include a simple frontend with a form and expense list.",
    expectedFeatures: ["has_root_route", "uses_neon_serverless", "no_banned_packages", "relative_fetch_urls", "uses_env_port", "no_dotenv", "no_dynamic_sql"],
  },
  {
    id: "user-dashboard",
    category: "auth-required",
    prompt: "Build a user dashboard that requires authentication via Neon Auth. After login, users see a personalized welcome page with their email and name from the JWT. Include a simple profile section. Use jose with JWKS for token verification.",
    expectedFeatures: ["has_root_route", "uses_neon_serverless", "no_banned_packages", "relative_fetch_urls", "uses_env_port", "no_dotenv", "no_jwt_secret", "uses_jose_jwks"],
  },
  {
    id: "personal-journal",
    category: "auth-required",
    prompt: "Build a personal journal app with Neon Auth. Users log in and can create, read, update, and delete journal entries. Entries are private to each user (filter by JWT sub claim). Use Neon Postgres for storage and jose for JWT verification.",
    expectedFeatures: ["has_root_route", "uses_neon_serverless", "no_banned_packages", "relative_fetch_urls", "uses_env_port", "no_dotenv", "no_jwt_secret", "uses_jose_jwks", "no_dynamic_sql"],
  },
  {
    id: "multi-file-blog",
    category: "multi-file",
    prompt: "Build a simple blog platform with separate route files for posts (routes/posts.js) and comments (routes/comments.js). Use a models directory for data access. Serve static frontend from a public/ directory. In-memory storage is fine.",
    expectedFeatures: ["has_root_route", "no_banned_packages", "relative_fetch_urls", "uses_env_port", "no_dotenv"],
  },
  {
    id: "multi-file-dashboard",
    category: "multi-file",
    prompt: "Build a metrics dashboard with separate route modules: routes/metrics.js for data endpoints and routes/health.js for health checks. Include a public/ directory with index.html, styles.css, and app.js. The dashboard should show mock metrics with charts using inline SVG or canvas.",
    expectedFeatures: ["has_root_route", "no_banned_packages", "relative_fetch_urls", "uses_env_port", "no_dotenv", "client_side_logic"],
  },
  {
    id: "no-deps-app",
    category: "edge-case",
    prompt: "Build a simple HTTP server using ONLY Node.js built-in modules (http, fs, path). No npm packages at all. Serve a single HTML page that displays a greeting and the current server time. The page should auto-refresh every 10 seconds.",
    expectedFeatures: ["has_root_route", "uses_env_port", "no_banned_packages", "no_dotenv"],
  },
  {
    id: "cors-api",
    category: "edge-case",
    prompt: "Build a REST API that explicitly handles CORS. It should accept requests from any origin. Endpoints: GET /api/data returns sample JSON data, OPTIONS preflight handler. Include proper CORS headers (Access-Control-Allow-Origin, Methods, Headers). Show API docs at root.",
    expectedFeatures: ["has_root_route", "no_banned_packages", "relative_fetch_urls", "uses_env_port", "no_dotenv"],
  },
  {
    id: "snake-game",
    category: "edge-case",
    prompt: "Build a browser-based Snake game. Use HTML5 Canvas for rendering. Arrow keys to control the snake. Show the score. The snake grows when eating food. Game over when hitting walls or itself. Include a restart button.",
    expectedFeatures: ["has_root_route", "no_banned_packages", "client_side_logic", "relative_fetch_urls", "uses_env_port"],
  },
];

module.exports = { prompts };
