// server/forge-repair/manager.js
// Enables ForgeOS to diagnose and fix bugs in its own infrastructure code.
// The Chat Agent reads ForgeOS source via read_forge_source tool, outputs FORGE: signal,
// user approves plan, and this module writes the fix + commits + pushes to GitHub.

const path = require("path");
const fs = require("fs");

const FORGE_ROOT = path.resolve(__dirname, "../../");
const FORGE_SERVER = path.resolve(FORGE_ROOT, "server");

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".cache"]);
const SKIP_FILES = new Set(["package-lock.json", "yarn.lock"]);
const MAX_FILE_SIZE = 100 * 1024;

function getAllForgeFilePaths() {
  const files = [];
  function walk(dir, prefix) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name) || SKIP_FILES.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else {
        files.push(`server/${rel}`);
      }
    }
  }
  walk(FORGE_SERVER, "");
  return files;
}

function readForgeFile(relPath) {
  const fullPath = path.resolve(FORGE_ROOT, relPath);
  if (!fullPath.startsWith(FORGE_ROOT + path.sep) && fullPath !== FORGE_ROOT) {
    throw new Error("Path traversal not allowed");
  }
  const stat = fs.statSync(fullPath);
  if (stat.size > MAX_FILE_SIZE) return `[File too large to display: ${stat.size} bytes]`;
  return fs.readFileSync(fullPath, "utf-8");
}

function getForgeFiles(relPaths) {
  return relPaths.map((p) => {
    try {
      const content = readForgeFile(p);
      return { path: p, content };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

async function generateForgePlan(forgeSuggestion) {
  const { generatePlan } = require("../plan/manager");
  const filePaths = getAllForgeFilePaths();
  return generatePlan(forgeSuggestion, filePaths);
}

async function applyForgeFix(forgeSuggestion, approvedPlan) {
  const { buildWorkspace } = require("../builder");
  const { planToConstraintBlock } = require("../plan/manager");

  // Collect ForgeOS files that need changing
  const rawToModify = (approvedPlan.filesToModify || []).map((f) => f.split(" — ")[0].trim());
  const rawToCreate = (approvedPlan.filesToCreate || []);
  const targetPaths = [...new Set([...rawToModify, ...rawToCreate])];
  const existingFiles = getForgeFiles(targetPaths);

  // Also pass off-limits files as context (read-only reference for the builder)
  const offLimitsPaths = (approvedPlan.filesOffLimits || []).map((f) => f.split(" — ")[0].trim()).slice(0, 10);
  const offLimitsFiles = getForgeFiles(offLimitsPaths);

  const allExistingFiles = [...existingFiles, ...offLimitsFiles];

  const constraintBlock = planToConstraintBlock(approvedPlan);
  const prompt = `${constraintBlock}\n\n${forgeSuggestion}`;

  const output = await buildWorkspace(prompt, allExistingFiles, null, approvedPlan);

  if (!output || !output.files || output.files.length === 0) {
    throw new Error("Builder produced no files");
  }

  // Write files to ForgeOS directory
  const writtenPaths = [];
  for (const file of output.files) {
    const fullPath = path.resolve(FORGE_ROOT, file.path);
    const safeRoot = FORGE_ROOT + path.sep;
    if (!fullPath.startsWith(safeRoot)) {
      console.warn(`[forge-repair] Skipping out-of-bounds path: ${file.path}`);
      continue;
    }
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, file.content, "utf-8");
    writtenPaths.push(file.path);
  }

  if (writtenPaths.length === 0) throw new Error("No files were written — all paths were out of bounds");

  // Push files to GitHub via API — shell git commands cannot work on Render
  // because the running service has no .git directory.
  const settingsManager = require("../settings/manager");
  const githubSettings = await settingsManager.getSetting("github");
  const repo = githubSettings?.repo || "BrianBMorgan/ForgeOS";
  const [owner, repoName] = repo.split("/");

  let token = process.env.GITHUB_TOKEN;
  if (!token) {
    const secrets = await settingsManager.getSecretsAsObject();
    token = secrets.GITHUB_TOKEN || secrets.GITHUB_PAT;
  }
  if (!token) throw new Error("GITHUB_TOKEN not available — add it to the Global Secrets Vault");

  const taskSummary = approvedPlan.taskSummary || forgeSuggestion.slice(0, 80);
  const commitMessage = `forge: ${taskSummary.replace(/"/g, "'")}`;

  // Push each file individually via GitHub Contents API
  const pushedPaths = [];
  for (const filePath of writtenPaths) {
    const fullPath = path.resolve(FORGE_ROOT, filePath);
    const fileContent = fs.readFileSync(fullPath, "utf-8");
    const encoded = Buffer.from(fileContent).toString("base64");

    // Get current SHA for the file (needed for updates)
    let fileSha = null;
    try {
      const getResp = await fetch(
        `https://api.github.com/repos/${owner}/${repoName}/contents/${filePath}`,
        { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } }
      );
      if (getResp.ok) {
        const data = await getResp.json();
        fileSha = data.sha;
      }
    } catch {}

    const body = { message: commitMessage, content: encoded, branch: "main" };
    if (fileSha) body.sha = fileSha;

    const putResp = await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/contents/${filePath}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    if (!putResp.ok) {
      const err = await putResp.json().catch(() => ({}));
      throw new Error(`GitHub API push failed for ${filePath}: ${err.message || putResp.status}`);
    }

    pushedPaths.push(filePath);
    console.log(`[forge-repair] Pushed ${filePath} to GitHub`);
  }

  return {
    ok: true,
    filesWritten: pushedPaths,
    message: `ForgeOS self-repair applied — ${pushedPaths.length} file(s) updated and pushed to GitHub. Render will redeploy automatically.`,
  };
}

module.exports = { getAllForgeFilePaths, readForgeFile, getForgeFiles, generateForgePlan, applyForgeFix };

