const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");

const net = require("net");

const WORKSPACES_DIR = path.join(__dirname, "..", "..", "workspaces");
const PORT_RANGE_START = 4000;
const PORT_RANGE_END = 4099;

const workspaces = new Map();

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

function getWorkspaceEnv() {
  const env = {};
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
    error: null,
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

function installDeps(runId, installCommand) {
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

    const parts = validateCommand(installCommand);
    const proc = spawn(parts[0], parts.slice(1), {
      cwd: ws.dir,
      env: { ...process.env, NODE_ENV: "development", ...getWorkspaceEnv() },
    });

    proc.stdout.on("data", (data) => {
      ws.logs.install += data.toString();
    });

    proc.stderr.on("data", (data) => {
      ws.logs.install += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        ws.status = "installed";
        resolve({ success: true });
      } else {
        ws.status = "install-failed";
        ws.error = `Install exited with code ${code}`;
        resolve({ success: false, error: ws.error });
      }
    });

    proc.on("error", (err) => {
      ws.status = "install-failed";
      ws.error = err.message;
      resolve({ success: false, error: err.message });
    });
  });
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

async function startApp(runId, startCommand, port) {
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

  let assignedPort;
  try {
    assignedPort = await getNextFreePort();
  } catch {
    assignedPort = port || 4000;
    await forceKillPort(assignedPort);
  }
  ws.port = assignedPort;

  const resolvedCommand = resolveStartCommand(ws.dir, startCommand);

  return new Promise((resolve) => {

    const parts = validateCommand(resolvedCommand);
    const proc = spawn(parts[0], parts.slice(1), {
      cwd: ws.dir,
      env: {
        ...process.env,
        PORT: String(ws.port),
        NODE_ENV: "development",
        ...getWorkspaceEnv(),
      },
    });

    ws.process = proc;

    proc.stdout.on("data", (data) => {
      ws.logs.app += data.toString();
    });

    proc.stderr.on("data", (data) => {
      ws.logs.app += data.toString();
    });

    let resolved = false;

    proc.on("close", (code) => {
      ws.logs.app += `\nProcess exited with code ${code}\n`;
      ws.process = null;
      if (!resolved) {
        resolved = true;
        ws.status = "start-failed";
        ws.error = `App exited with code ${code} during startup`;
        resolve({ success: false, error: ws.error });
      } else if (ws.status === "running") {
        ws.status = "stopped";
        ws.error = `App crashed with code ${code}`;
      }
    });

    proc.on("error", (err) => {
      ws.process = null;
      if (!resolved) {
        resolved = true;
        ws.status = "start-failed";
        ws.error = err.message;
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

function getWorkspaceLogs(runId) {
  const ws = workspaces.get(runId);
  if (!ws) return { install: "", app: "" };

  return {
    install: ws.logs.install,
    app: ws.logs.app,
  };
}

module.exports = {
  createWorkspace,
  writeFiles,
  installDeps,
  startApp,
  stopApp,
  stopAllApps,
  forceKillPort,
  getWorkspaceStatus,
  getWorkspaceLogs,
};
