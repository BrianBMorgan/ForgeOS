const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");

const net = require("net");

const WORKSPACES_DIR = path.join(__dirname, "..", "..", "workspaces");
const PORT_RANGE_START = 4000;
const PORT_RANGE_END = 4099;

const workspaces = new Map();

const LOG_LEVEL_PATTERNS = [
  { pattern: /\b(error|ERR!|Error:|FATAL|fatal|ENOENT|EACCES|ECONNREFUSED|uncaught|unhandled|throw|TypeError|ReferenceError|SyntaxError)\b/i, level: "error" },
  { pattern: /\b(warn|warning|WARN|deprecated)\b/i, level: "warn" },
  { pattern: /\b(debug|DEBUG|verbose)\b/i, level: "debug" },
];

function detectLogLevel(line, source) {
  if (!line.trim()) return null;
  for (const { pattern, level } of LOG_LEVEL_PATTERNS) {
    if (pattern.test(line)) return level;
  }
  return "info";
}

function createLogEntry(message, level, source) {
  return {
    ts: Date.now(),
    level: level || "info",
    source,
    message: message.replace(/\n$/, ""),
  };
}

function pushLogEntries(ws, rawData, source) {
  const text = rawData.toString();
  const lines = text.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    const level = detectLogLevel(line, source);
    if (level) {
      ws.logEntries.push(createLogEntry(line, level, source));
    }
  }
  if (ws.logEntries.length > 2000) {
    ws.logEntries = ws.logEntries.slice(-1500);
  }
}

function getNextFreePort() {
  return new Promise((resolve, reject) => {
    const usedPorts = new Set();
    for (const [, ws] of workspaces) {
      if (ws.port && ws.status === "running") usedPorts.add(ws.port);
    }
    function tryPort(port) {
      if (port > PORT_RANGE_END) {
        reject(new Error("No free ports in range"));
        return;
      }
      if (usedPorts.has(port)) {
        tryPort(port + 1);
        return;
      }
      const server = net.createServer();
      server.once("error", () => tryPort(port + 1));
      server.once("listening", () => {
        server.close(() => resolve(port));
      });
      server.listen(port);
    }
    tryPort(PORT_RANGE_START);
  });
}

function cleanDatabaseUrl(raw) {
  if (!raw) return raw;
  let url = raw;
  if (url.startsWith("postgres://")) {
    url = "postgresql://" + url.slice("postgres://".length);
  }
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("channel_binding");
    return parsed.toString();
  } catch {
    return url;
  }
}

function getWorkspaceEnv(customEnv = {}) {
  const filtered = { ...customEnv };
  const RESERVED = ["PORT", "DATABASE_URL", "NEON_AUTH_JWKS_URL", "JWT_SECRET", "NODE_ENV", "HOME", "PATH", "TERM"];
  for (const k of RESERVED) delete filtered[k];

  const env = { ...filtered };
  if (process.env.NEON_DATABASE_URL) {
    env.DATABASE_URL = cleanDatabaseUrl(process.env.NEON_DATABASE_URL);
  }
  if (process.env.NEON_AUTH_JWKS_URL) {
    env.NEON_AUTH_JWKS_URL = process.env.NEON_AUTH_JWKS_URL;
  }
  env.JWT_SECRET = "forgeos-generated-app-secret-" + Date.now();
  return env;
}

function ensureWorkspacesDir() {
  if (!fs.existsSync(WORKSPACES_DIR)) {
    fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
  }
}

function createWorkspace(runId) {
  ensureWorkspacesDir();
  const wsDir = path.join(WORKSPACES_DIR, runId);

  if (fs.existsSync(wsDir)) {
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
  fs.mkdirSync(wsDir, { recursive: true });

  const ws = {
    runId,
    dir: wsDir,
    status: "created",
    port: null,
    process: null,
    logs: {
      install: "",
      app: "",
    },
    logEntries: [],
    error: null,
    lastStartCommand: null,
    lastPort: null,
  };

  workspaces.set(runId, ws);
  return ws;
}

function sanitizePath(wsDir, filePath) {
  const normalized = path.normalize(filePath).replace(/^(\.\.[/\\])+/, "");
  if (path.isAbsolute(normalized)) {
    throw new Error(`Rejected absolute path: ${filePath}`);
  }
  const resolved = path.resolve(wsDir, normalized);
  if (!resolved.startsWith(wsDir + path.sep) && resolved !== wsDir) {
    throw new Error(`Path traversal detected: ${filePath}`);
  }
  return resolved;
}

const ALLOWED_COMMANDS = ["npm", "npx", "node", "yarn", "pnpm", "python", "python3", "pip", "pip3"];

function validateCommand(command) {
  const parts = command.trim().split(/\s+/);
  const bin = parts[0];
  if (!ALLOWED_COMMANDS.includes(bin)) {
    throw new Error(`Command not allowed: ${bin}. Allowed: ${ALLOWED_COMMANDS.join(", ")}`);
  }
  return parts;
}

function writeFiles(runId, files) {
  const ws = workspaces.get(runId);
  if (!ws) throw new Error("Workspace not found");

  ws.status = "writing-files";

  for (const file of files) {
    const filePath = sanitizePath(ws.dir, file.path);
    const dir = path.dirname(filePath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, file.content, "utf-8");
  }

  ws.status = "files-written";
  return ws;
}

function installDeps(runId, installCommand, customEnv = {}) {
  return new Promise((resolve) => {
    const ws = workspaces.get(runId);
    if (!ws) {
      resolve({ success: false, error: "Workspace not found" });
      return;
    }

    if (!installCommand) {
      ws.status = "installed";
      resolve({ success: true });
      return;
    }

    ws.status = "installing";
    ws.logs.install = "";
    ws.logEntries.push(createLogEntry(`Installing dependencies: ${installCommand}`, "info", "system"));

    const parts = validateCommand(installCommand);
    const proc = spawn(parts[0], parts.slice(1), {
      cwd: ws.dir,
      env: { ...process.env, NODE_ENV: "development", ...getWorkspaceEnv(customEnv) },
    });

    proc.stdout.on("data", (data) => {
      ws.logs.install += data.toString();
      pushLogEntries(ws, data, "install");
    });

    proc.stderr.on("data", (data) => {
      ws.logs.install += data.toString();
      pushLogEntries(ws, data, "install");
    });

    proc.on("close", (code) => {
      if (code === 0) {
        ws.status = "installed";
        ws.logEntries.push(createLogEntry("Dependencies installed successfully", "info", "system"));
        resolve({ success: true });
      } else {
        ws.status = "install-failed";
        ws.error = `Install exited with code ${code}`;
        ws.logEntries.push(createLogEntry(ws.error, "error", "system"));
        resolve({ success: false, error: ws.error });
      }
    });

    proc.on("error", (err) => {
      ws.status = "install-failed";
      ws.error = err.message;
      ws.logEntries.push(createLogEntry(`Install error: ${err.message}`, "error", "system"));
      resolve({ success: false, error: err.message });
    });
  });
}

function collectJsFiles(dir) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...collectJsFiles(full));
      } else if (/\.(js|cjs|mjs|ts)$/.test(entry.name)) {
        results.push(full);
      }
    }
  } catch {}
  return results;
}

function patchHardcodedPort(wsDir) {
  try {
    const jsFiles = collectJsFiles(wsDir);
    for (const filePath of jsFiles) {
      let content;
      try { content = fs.readFileSync(filePath, "utf8"); } catch { continue; }
      if (/process\.env\.PORT/.test(content)) continue;
      let patched = content;
      patched = patched.replace(
        /(const|let|var)\s+(PORT|port)\s*=\s*(\d{3,5})\s*;/g,
        "$1 $2 = process.env.PORT || $3;"
      );
      patched = patched.replace(
        /\.listen\(\s*(\d{3,5})\s*,/g,
        ".listen(process.env.PORT || $1,"
      );
      patched = patched.replace(
        /\.listen\(\s*(\d{3,5})\s*\)/g,
        ".listen(process.env.PORT || $1)"
      );
      if (patched !== content) {
        fs.writeFileSync(filePath, patched, "utf8");
      }
    }
  } catch {}
}

function resolveStartCommand(wsDir, startCommand) {
  if (startCommand === "npm start" || startCommand === "npm run start") {
    try {
      const pkgPath = path.join(wsDir, "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        const script = pkg.scripts?.start;
        if (script && /^node\s+\S+/.test(script)) {
          return script;
        }
      }
    } catch {}
  }
  return startCommand;
}

async function startApp(runId, startCommand, port, customEnv = {}) {
  const ws = workspaces.get(runId);
  if (!ws) {
    return { success: false, error: "Workspace not found" };
  }

  if (!startCommand) {
    ws.status = "no-start-command";
    return { success: false, error: "No start command provided" };
  }

  ws.status = "starting";
  ws.logs.app = "";
  ws.lastStartCommand = startCommand;
  ws.lastPort = port;

  let assignedPort;
  try {
    assignedPort = await getNextFreePort();
  } catch {
    assignedPort = port || 4000;
    await forceKillPort(assignedPort);
  }
  ws.port = assignedPort;

  patchHardcodedPort(ws.dir);

  const resolvedCommand = resolveStartCommand(ws.dir, startCommand);
  ws.logEntries.push(createLogEntry(`Starting application: ${resolvedCommand} (port ${ws.port})`, "info", "system"));

  return new Promise((resolve) => {

    const parts = validateCommand(resolvedCommand);
    const proc = spawn(parts[0], parts.slice(1), {
      cwd: ws.dir,
      env: {
        ...process.env,
        PORT: String(ws.port),
        NODE_ENV: "development",
        ...getWorkspaceEnv(customEnv),
      },
    });

    ws.process = proc;

    proc.stdout.on("data", (data) => {
      ws.logs.app += data.toString();
      pushLogEntries(ws, data, "app");
    });

    proc.stderr.on("data", (data) => {
      ws.logs.app += data.toString();
      pushLogEntries(ws, data, "app");
    });

    let resolved = false;

    proc.on("close", (code) => {
      ws.logs.app += `\nProcess exited with code ${code}\n`;
      ws.process = null;
      if (!resolved) {
        resolved = true;
        ws.status = "start-failed";
        ws.error = `App exited with code ${code} during startup`;
        ws.logEntries.push(createLogEntry(ws.error, "error", "system"));
        resolve({ success: false, error: ws.error });
      } else if (ws.status === "running") {
        ws.status = "stopped";
        ws.error = `App crashed with code ${code}`;
        ws.logEntries.push(createLogEntry(ws.error, "error", "system"));
      }
    });

    proc.on("error", (err) => {
      ws.process = null;
      if (!resolved) {
        resolved = true;
        ws.status = "start-failed";
        ws.error = err.message;
        ws.logEntries.push(createLogEntry(`Process error: ${err.message}`, "error", "system"));
        resolve({ success: false, error: err.message });
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        if (ws.process && !ws.process.killed) {
          ws.status = "running";
          resolve({ success: true, port: ws.port });
        } else {
          ws.status = "start-failed";
          ws.error = "App exited before startup completed";
          resolve({ success: false, error: ws.error });
        }
      }
    }, 3000);
  });
}

function stopApp(runId) {
  return new Promise((resolve) => {
    const ws = workspaces.get(runId);
    if (!ws || !ws.process || ws.process.killed) {
      if (ws) {
        ws.status = "stopped";
        ws.process = null;
      }
      resolve();
      return;
    }

    const proc = ws.process;
    const onExit = () => {
      ws.status = "stopped";
      ws.process = null;
      resolve();
    };

    proc.once("exit", onExit);
    proc.kill("SIGTERM");

    setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
      setTimeout(() => {
        proc.removeListener("exit", onExit);
        ws.status = "stopped";
        ws.process = null;
        resolve();
      }, 500);
    }, 2000);
  });
}

async function restartApp(runId, customEnv = {}) {
  const ws = workspaces.get(runId);
  if (!ws) {
    return { success: false, error: "Workspace not found" };
  }
  if (!ws.lastStartCommand) {
    return { success: false, error: "No start command recorded — cannot restart" };
  }

  const cmd = ws.lastStartCommand;
  const port = ws.lastPort || 4000;

  await stopApp(runId);
  ws.logEntries.push(createLogEntry("Restarting application...", "info", "system"));

  const result = await startApp(runId, cmd, port, customEnv);
  return result;
}

async function stopAllApps() {
  const promises = [];
  for (const [runId] of workspaces) {
    promises.push(stopApp(runId));
  }
  await Promise.all(promises);
}

async function forceKillPort(port) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      execSync(`fuser -k -9 ${port}/tcp 2>/dev/null`, { timeout: 3000 });
    } catch {}
    try {
      const pids = execSync(`lsof -ti :${port} 2>/dev/null`, { timeout: 2000 }).toString().trim();
      if (pids) {
        for (const pid of pids.split("\n")) {
          try { process.kill(parseInt(pid), "SIGKILL"); } catch {}
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
    try {
      execSync(`fuser ${port}/tcp 2>/dev/null`, { timeout: 2000 });
    } catch {
      return;
    }
  }
}

function getWorkspaceStatus(runId) {
  const ws = workspaces.get(runId);
  if (!ws) return null;

  return {
    runId: ws.runId,
    status: ws.status,
    port: ws.port,
    error: ws.error,
  };
}

function getWorkspaceLogs(runId, opts = {}) {
  const ws = workspaces.get(runId);
  if (!ws) return { install: "", app: "", entries: [] };

  const { since, level, source, search, limit: maxEntries } = opts;
  let entries = ws.logEntries;

  if (since) entries = entries.filter((e) => e.ts > since);
  if (level) {
    const levels = Array.isArray(level) ? level : [level];
    entries = entries.filter((e) => levels.includes(e.level));
  }
  if (source) entries = entries.filter((e) => e.source === source);
  if (search) {
    const re = new RegExp(search, "i");
    entries = entries.filter((e) => re.test(e.message));
  }
  if (maxEntries) entries = entries.slice(-maxEntries);

  return {
    install: ws.logs.install,
    app: ws.logs.app,
    entries,
    totalEntries: ws.logEntries.length,
  };
}

async function restoreWorkspace(runId, startCommand, port, customEnv = {}) {
  const wsDir = path.join(WORKSPACES_DIR, runId);
  if (!fs.existsSync(wsDir)) return { success: false, error: "Workspace directory not found" };

  const nodeModules = path.join(wsDir, "node_modules");
  const pkgJson = path.join(wsDir, "package.json");

  const ws = {
    runId,
    dir: wsDir,
    status: "restoring",
    port: null,
    process: null,
    logs: { install: "", app: "" },
    logEntries: [],
    error: null,
    lastStartCommand: startCommand || null,
    lastPort: port || null,
  };
  workspaces.set(runId, ws);

  try {
    if (fs.existsSync(pkgJson) && !fs.existsSync(nodeModules)) {
      ws.status = "installing";
      const installResult = await installDeps(runId, "npm install", customEnv);
      if (!installResult.success) {
        ws.status = "restore-failed";
        ws.error = installResult.error;
        return { success: false, error: installResult.error };
      }
    }

    if (startCommand) {
      const result = await startApp(runId, startCommand, port || 4000, customEnv);
      return result;
    }

    ws.status = "stopped";
    return { success: false, error: "No start command" };
  } catch (err) {
    ws.status = "restore-failed";
    ws.error = err.message;
    return { success: false, error: err.message };
  }
}

const BLOCKED_SHELL_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*\s+)*\//,
  /\brm\s+(-[a-zA-Z]*\s+)*\.\./,
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+\*/,
  /\bmkfs\b/,
  /\bdd\s+/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bkill\s+(-9\s+)?1\b/,
  /\bkillall\b/,
  />\s*\/dev\//,
  /\bchmod\s+777\b/,
  /\bchown\b.*\//,
  /\bcurl\b.*\|\s*(bash|sh)\b/,
  /\bwget\b.*\|\s*(bash|sh)\b/,
  /\bperl\s+-e\b/,
  /\bruby\s+-e\b/,
  /\bpython[23]?\s+-c\b/,
  /\bbash\s+-c\b/,
  /\bsudo\b/,
  /\bsu\s/,
  /\/etc\/(passwd|shadow|sudoers)/,
  /\/proc\//,
  /\/sys\//,
  /\bsystemctl\b/,
  /\bservice\s/,
  /\bnc\s.*-[el]/,
  /\bssh\b/,
  /\bscp\b/,
];

const MAX_OUTPUT_SIZE = 256 * 1024;

function execCommand(runId, command, timeout = 15000) {
  return new Promise((resolve) => {
    const ws = workspaces.get(runId);
    if (!ws) {
      return resolve({ exitCode: 1, stdout: "", stderr: "Workspace not found" });
    }

    const trimmed = command.trim();
    if (!trimmed) {
      return resolve({ exitCode: 1, stdout: "", stderr: "Empty command" });
    }

    if (trimmed.length > 2000) {
      return resolve({ exitCode: 1, stdout: "", stderr: "Command too long (max 2000 chars)" });
    }

    for (const pattern of BLOCKED_SHELL_PATTERNS) {
      if (pattern.test(trimmed)) {
        return resolve({ exitCode: 1, stdout: "", stderr: "Command blocked for safety" });
      }
    }

    let stdout = "";
    let stderr = "";
    let finished = false;
    let outputTruncated = false;

    const proc = spawn("sh", ["-c", trimmed], {
      cwd: ws.dir,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TERM: "dumb",
        PORT: String(ws.port || 4000),
        DATABASE_URL: process.env.NEON_DATABASE_URL || "",
        NODE_ENV: "development",
      },
      timeout,
    });

    proc.stdout.on("data", (data) => {
      if (stdout.length + stderr.length < MAX_OUTPUT_SIZE) {
        stdout += data.toString();
      } else if (!outputTruncated) {
        outputTruncated = true;
        stdout += "\n... output truncated (256KB limit)\n";
      }
    });

    proc.stderr.on("data", (data) => {
      if (stdout.length + stderr.length < MAX_OUTPUT_SIZE) {
        stderr += data.toString();
      } else if (!outputTruncated) {
        outputTruncated = true;
        stderr += "\n... output truncated (256KB limit)\n";
      }
    });

    proc.on("close", (code) => {
      if (finished) return;
      finished = true;
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });

    proc.on("error", (err) => {
      if (finished) return;
      finished = true;
      resolve({ exitCode: 1, stdout, stderr: stderr || err.message });
    });

    setTimeout(() => {
      if (finished) return;
      finished = true;
      try { proc.kill("SIGKILL"); } catch {}
      resolve({ exitCode: 124, stdout, stderr: stderr + "\nCommand timed out" });
    }, timeout);
  });
}

module.exports = {
  createWorkspace,
  writeFiles,
  installDeps,
  startApp,
  stopApp,
  restartApp,
  stopAllApps,
  forceKillPort,
  getWorkspaceStatus,
  getWorkspaceLogs,
  restoreWorkspace,
  execCommand,
};
