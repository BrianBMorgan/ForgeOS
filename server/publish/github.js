const fs = require("fs");
const path = require("path");
const { buildTrackerScript } = require("../analytics/tracker");

const API = "https://api.github.com";

function getToken() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN not configured");
  return token;
}

function headers() {
  return {
    Authorization: `Bearer ${getToken()}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function apiRequest(method, endpoint, body = null) {
  const opts = { method, headers: headers() };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API}${endpoint}`, opts);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`GitHub API ${method} ${endpoint}: ${res.status} — ${data.message || JSON.stringify(data)}`);
  }
  return data;
}

const DENIED_FILES = new Set([
  ".env", ".env.local", ".env.production", ".env.development", ".env.staging",
  ".env.test", ".env.secret", "secrets.json", "credentials.json",
  ".npmrc", ".yarnrc",
]);

const DENIED_PATTERNS = [
  /\.env\./,
  /\.pem$/,
  /\.key$/,
  /\.cert$/,
  /\.secret$/,
  /id_rsa/,
  /id_ed25519/,
];

const DENIED_DIRS = new Set([
  "node_modules", ".git", ".env", ".cache", ".tmp",
  "coverage", ".nyc_output",
  ".local", "attached_assets",
  "workspaces", "published",
]);

function isSensitiveFile(name) {
  if (DENIED_FILES.has(name.toLowerCase())) return true;
  return DENIED_PATTERNS.some((p) => p.test(name.toLowerCase()));
}

function collectFiles(dir, base = "") {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (DENIED_DIRS.has(entry.name) || entry.name.startsWith(".env")) continue;
    if (isSensitiveFile(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    const relPath = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath, relPath));
    } else {
      results.push({ path: relPath, fullPath });
    }
  }
  return results;
}

function isTextFile(filePath) {
  const textExts = new Set([
    ".js", ".ts", ".tsx", ".jsx", ".json", ".html", ".css", ".scss",
    ".md", ".txt", ".yml", ".yaml", ".toml", ".sh", ".bash",
    ".py", ".rb", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".hpp",
    ".xml", ".svg", ".csv", ".sql", ".graphql", ".prisma", ".lock",
    ".gitignore", ".npmrc", ".eslintrc", ".prettierrc", ".editorconfig",
    ".mjs", ".cjs", ".vue", ".svelte", ".astro",
  ]);
  const ext = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath).toLowerCase();
  return textExts.has(ext) || ["makefile", "dockerfile", "procfile", "license", ".gitignore", ".env.example"].includes(name);
}

async function pushProjectToGitHub(repoFullName, projectSlug, sourceDir, commitMessage) {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) throw new Error(`Invalid repo name: ${repoFullName}`);

  const repoInfo = await apiRequest("GET", `/repos/${owner}/${repo}`);
  const defaultBranch = repoInfo.default_branch || "main";

  const refData = await apiRequest("GET", `/repos/${owner}/${repo}/git/ref/heads/${defaultBranch}`);
  const latestCommitSha = refData.object.sha;

  const commitData = await apiRequest("GET", `/repos/${owner}/${repo}/git/commits/${latestCommitSha}`);
  const baseTreeSha = commitData.tree.sha;

  const files = collectFiles(sourceDir);
  if (files.length === 0) throw new Error("No files to push");

  const treeItems = [];
  for (const file of files) {
    const filePath = `${projectSlug}/${file.path}`;
    let content;
    let encoding;

    if (isTextFile(file.fullPath)) {
      try {
        content = fs.readFileSync(file.fullPath, "utf8");
        encoding = "utf-8";
      } catch {
        content = fs.readFileSync(file.fullPath).toString("base64");
        encoding = "base64";
      }
    } else {
      content = fs.readFileSync(file.fullPath).toString("base64");
      encoding = "base64";
    }

    const blob = await apiRequest("POST", `/repos/${owner}/${repo}/git/blobs`, {
      content,
      encoding,
    });

    treeItems.push({
      path: filePath,
      mode: "100644",
      type: "blob",
      sha: blob.sha,
    });
  }

  const newTree = await apiRequest("POST", `/repos/${owner}/${repo}/git/trees`, {
    base_tree: baseTreeSha,
    tree: treeItems,
  });

  const newCommit = await apiRequest("POST", `/repos/${owner}/${repo}/git/commits`, {
    message: commitMessage || `[ForgeOS] Publish ${projectSlug}`,
    tree: newTree.sha,
    parents: [latestCommitSha],
  });

  await apiRequest("PATCH", `/repos/${owner}/${repo}/git/refs/heads/${defaultBranch}`, {
    sha: newCommit.sha,
  });

  return {
    commitSha: newCommit.sha,
    commitUrl: `https://github.com/${owner}/${repo}/commit/${newCommit.sha}`,
    filesCount: files.length,
  };
}

async function verifyRepoAccess(repoFullName) {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) throw new Error(`Invalid repo name: ${repoFullName}`);
  try {
    const data = await apiRequest("GET", `/repos/${owner}/${repo}`);
    return {
      ok: true,
      name: data.full_name,
      private: data.private,
      permissions: data.permissions,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function pushToAppBranch(repoFullName, slug, sourceDir) {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) throw new Error(`Invalid repo name: ${repoFullName}`);

  const branch = `apps/${slug}`;

  // Get default branch SHA to use as base
  const repoInfo = await apiRequest("GET", `/repos/${owner}/${repo}`);
  const defaultBranch = repoInfo.default_branch || "main";
  const refData = await apiRequest("GET", `/repos/${owner}/${repo}/git/ref/heads/${defaultBranch}`);
  const latestCommitSha = refData.object.sha;

  // Collect files from source dir
  const files = collectFiles(sourceDir);
  if (files.length === 0) throw new Error("No files to push");

  // Build the tracker script once — baked with projectId and ForgeOS origin
  const forgeOrigin = process.env.BASE_DOMAIN
    ? `https://${process.env.BASE_DOMAIN}`
    : "https://forge-os.ai";
  const trackerScript = buildTrackerScript(slug, forgeOrigin);

  // Build tree with files at root of branch (no subdirectory)
  const treeItems = [];
  for (const file of files) {
    let content, encoding;
    if (isTextFile(file.fullPath)) {
      try {
        content = fs.readFileSync(file.fullPath, "utf8");
        encoding = "utf-8";
        // Inject analytics tracker before </body> in HTML files
        if (file.path.endsWith(".html") && content.includes("</body>")) {
          content = content.replace("</body>", trackerScript + "\n</body>");
        }
      } catch {
        content = fs.readFileSync(file.fullPath).toString("base64");
        encoding = "base64";
      }
    } else {
      content = fs.readFileSync(file.fullPath).toString("base64");
      encoding = "base64";
    }
    const blob = await apiRequest("POST", `/repos/${owner}/${repo}/git/blobs`, { content, encoding });
    treeItems.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }

  // Create tree with empty base (standalone branch, not inheriting main)
  const newTree = await apiRequest("POST", `/repos/${owner}/${repo}/git/trees`, {
    tree: treeItems,
  });

  const newCommit = await apiRequest("POST", `/repos/${owner}/${repo}/git/commits`, {
    message: `[ForgeOS] Publish ${slug}`,
    tree: newTree.sha,
    parents: [],
  });

  // Create or force-update the branch
  try {
    await apiRequest("POST", `/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: newCommit.sha,
    });
  } catch {
    // Branch exists — force update
    await apiRequest("PATCH", `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
      sha: newCommit.sha,
      force: true,
    });
  }

  return {
    branch,
    commitSha: newCommit.sha,
    commitUrl: `https://github.com/${owner}/${repo}/commit/${newCommit.sha}`,
    filesCount: files.length,
  };
}

async function tagAndDeleteAppBranch(repoFullName, slug, commitSha) {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) throw new Error(`Invalid repo name: ${repoFullName}`);
  const branch = `apps/${slug}`;
  const tag = `apps/${slug}-v${Date.now()}`;

  // Create lightweight tag pointing at the commit before deleting the branch
  try {
    await apiRequest("POST", `/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/tags/${tag}`,
      sha: commitSha,
    });
  } catch (err) {
    console.warn(`[github] Could not create version tag ${tag}: ${err.message}`);
  }

  // Delete the branch — Render already has the commit, banner gone
  try {
    await apiRequest("DELETE", `/repos/${owner}/${repo}/git/refs/heads/${branch}`);
  } catch (err) {
    console.warn(`[github] Could not delete branch ${branch}: ${err.message}`);
  }

  return { tag, commitSha };
}

async function listVersionTags(repoFullName, slug) {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) throw new Error(`Invalid repo name: ${repoFullName}`);
  const data = await apiRequest("GET", `/repos/${owner}/${repo}/git/refs/tags/apps/${slug}-v`);
  const tags = Array.isArray(data) ? data : (data.ref ? [data] : []);
  return tags
    .map(t => ({
      tag: t.ref.replace("refs/tags/", ""),
      sha: t.object.sha,
      // Extract timestamp from tag name: apps/slug-v1234567890
      timestamp: parseInt(t.ref.split("-v").pop()) || 0,
    }))
    .sort((a, b) => b.timestamp - a.timestamp); // newest first
}

async function restoreFromTag(repoFullName, slug, tag, commitSha) {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) throw new Error(`Invalid repo name: ${repoFullName}`);
  const branch = `apps/${slug}`;

  // Push the tagged commit back onto the branch so Render can redeploy
  try {
    await apiRequest("POST", `/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: commitSha,
    });
  } catch {
    // Branch already exists — force update
    await apiRequest("PATCH", `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
      sha: commitSha,
      force: true,
    });
  }

  return { branch, commitSha };
}

module.exports = {
  pushProjectToGitHub,
  pushToAppBranch,
  tagAndDeleteAppBranch,
  listVersionTags,
  restoreFromTag,
  verifyRepoAccess,
};

