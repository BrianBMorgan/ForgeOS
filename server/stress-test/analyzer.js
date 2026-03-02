const path = require("path");

const BANNED_PACKAGES = [
  "bcrypt",
  "bcryptjs",
  "jsonwebtoken",
  "passport",
  "passport-local",
  "passport-jwt",
  "dotenv",
  "pg",
  "esbuild",
  "webpack",
  "vite",
  "parcel",
  "rollup",
  "react",
  "react-dom",
  "vue",
  "svelte",
];

const PINNED_VERSIONS = {
  "@neondatabase/serverless": "^1.0.2",
  "jose": "^6.1.3",
};

function analyzeExecutorOutput(executorOutput) {
  const violations = [];
  if (!executorOutput || !executorOutput.files) {
    return { violations: [{ rule: "no_output", severity: "critical", file: null, line: null, snippet: "No executor output or files found" }], score: 0 };
  }

  const files = executorOutput.files;
  const packageJsonFile = files.find(f => path.basename(f.path) === "package.json");
  let packageJson = null;

  if (packageJsonFile) {
    try {
      packageJson = JSON.parse(packageJsonFile.content);
    } catch (e) {
      violations.push({ rule: "invalid_package_json", severity: "critical", file: packageJsonFile.path, line: null, snippet: "package.json is not valid JSON" });
    }
  }

  if (packageJson) {
    checkBannedPackages(packageJson, packageJsonFile.path, violations);
    checkWrongDbDriver(packageJson, packageJsonFile.path, violations);
    checkVersionHallucination(packageJson, packageJsonFile.path, violations);
  }

  const serverFiles = files.filter(f => /\.(js|ts)$/.test(f.path) && !/public|static|client/i.test(f.path));
  const frontendFiles = files.filter(f => /\.(js|ts|html)$/.test(f.path));

  if (!packageJsonFile) {
    const NODE_BUILTINS = new Set(["http","https","fs","path","os","url","util","crypto","stream","events","net","child_process","querystring","zlib","assert","buffer","cluster","dgram","dns","domain","readline","repl","string_decoder","tls","tty","v8","vm","worker_threads"]);
    const hasThirdPartyRequires = files.some(f => {
      if (!f.content) return false;
      const matches = f.content.match(/require\s*\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g);
      if (!matches) return false;
      return matches.some(m => {
        const mod = m.match(/['"]([^'"]+)['"]/);
        return mod && !NODE_BUILTINS.has(mod[1].split("/")[0]);
      });
    });
    if (hasThirdPartyRequires) {
      violations.push({ rule: "missing_package_json", severity: "critical", file: null, line: null, snippet: "No package.json found but files use third-party require()" });
    }
  }

  const jsFiles = files.filter(f => /\.(js|ts)$/.test(f.path));

  checkAbsoluteFetchPaths(frontendFiles, violations);
  checkMissingRootRoute(serverFiles, violations);
  checkDynamicSql(jsFiles, violations);
  checkWrongPort(serverFiles, executorOutput.port, violations);
  checkDotenvUsage(jsFiles, violations);
  checkMissingDeps(jsFiles, packageJson, violations);
  checkJwtSecretUsage(jsFiles, violations);
  checkEsmSyntax(jsFiles, violations);
  checkBuildSteps(executorOutput, violations);
  checkNestedBackticks(serverFiles, violations);

  const score = calculateScore(violations);
  return { violations, score };
}

function checkBannedPackages(packageJson, filePath, violations) {
  const allDeps = { ...packageJson.dependencies, ...packageJson.devDependencies };
  for (const banned of BANNED_PACKAGES) {
    if (allDeps && allDeps[banned]) {
      violations.push({
        rule: "banned_package",
        severity: "critical",
        file: filePath,
        line: null,
        snippet: `"${banned}": "${allDeps[banned]}"`,
      });
    }
  }
}

function checkWrongDbDriver(packageJson, filePath, violations) {
  const deps = packageJson.dependencies || {};
  if (deps["pg"] && !deps["@neondatabase/serverless"]) {
    violations.push({
      rule: "wrong_db_driver",
      severity: "critical",
      file: filePath,
      line: null,
      snippet: `Uses "pg" instead of "@neondatabase/serverless"`,
    });
  }
}

function checkAbsoluteFetchPaths(files, violations) {
  for (const file of files) {
    if (!file.content) continue;
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/fetch\s*\(\s*["'`]\//.test(line)) {
        violations.push({
          rule: "absolute_fetch_path",
          severity: "high",
          file: file.path,
          line: i + 1,
          snippet: line.trim(),
        });
      }
    }
  }
}

function checkMissingRootRoute(serverFiles, violations) {
  let hasRootRoute = false;
  for (const file of serverFiles) {
    if (!file.content) continue;
    if (/app\.(get|use)\s*\(\s*["'`][/]["'`]/.test(file.content) ||
        /app\.(get|use)\s*\(\s*["'`]\/["'`]\s*,/.test(file.content) ||
        /router\.(get|use)\s*\(\s*["'`]\/["'`]/.test(file.content)) {
      hasRootRoute = true;
      break;
    }
  }
  if (!hasRootRoute && serverFiles.length > 0) {
    violations.push({
      rule: "missing_root_route",
      severity: "high",
      file: serverFiles[0]?.path || null,
      line: null,
      snippet: 'No app.get("/") or app.get(\'/\') found in server files',
    });
  }
}

function checkDynamicSql(files, violations) {
  for (const file of files) {
    if (!file.content) continue;
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/sql\.raw\s*\(/.test(line)) {
        violations.push({
          rule: "dynamic_sql",
          severity: "critical",
          file: file.path,
          line: i + 1,
          snippet: line.trim(),
        });
      }
      if (/\$\{\s*\$\{/.test(line)) {
        violations.push({
          rule: "nested_template_literal",
          severity: "critical",
          file: file.path,
          line: i + 1,
          snippet: line.trim(),
        });
      }
    }
  }
}

function checkWrongPort(serverFiles, declaredPort, violations) {
  for (const file of serverFiles) {
    if (!file.content) continue;
    const hasEnvPort = /process\.env\.PORT/.test(file.content);
    if (!hasEnvPort) {
      const lines = file.content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (/\.listen\s*\(\s*\d+/.test(lines[i])) {
          violations.push({
            rule: "hardcoded_port",
            severity: "medium",
            file: file.path,
            line: i + 1,
            snippet: lines[i].trim(),
          });
          break;
        }
      }
    }
  }
}

function checkDotenvUsage(files, violations) {
  for (const file of files) {
    if (!file.content) continue;
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/require\s*\(\s*["']dotenv["']\s*\)/.test(line) || /from\s+["']dotenv["']/.test(line)) {
        violations.push({
          rule: "dotenv_usage",
          severity: "high",
          file: file.path,
          line: i + 1,
          snippet: line.trim(),
        });
      }
    }
  }
}

function checkMissingDeps(files, packageJson, violations) {
  if (!packageJson) return;
  const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
  const builtins = new Set([
    "path", "fs", "http", "https", "url", "os", "crypto", "stream",
    "events", "util", "querystring", "buffer", "child_process", "net",
    "tls", "zlib", "assert", "dns", "cluster", "readline", "vm",
    "string_decoder", "timers", "tty", "dgram", "domain",
  ]);

  for (const file of files) {
    if (!file.content) continue;
    if (!/\.(js|cjs|mjs|ts)$/.test(file.path)) continue;
    const requireMatches = file.content.matchAll(/require\s*\(\s*["']([^"'./][^"']*)["']\s*\)/g);
    const importMatches = file.content.matchAll(/\bimport\s+.*\s+from\s+["']([^"'./][^"']*)["']/g);

    const allMatches = [...requireMatches, ...importMatches];
    for (const match of allMatches) {
      const pkg = match[1].startsWith("@") ? match[1] : match[1].split("/")[0];
      if (!builtins.has(pkg) && !deps[pkg]) {
        const lines = file.content.split("\n");
        let lineNum = null;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(match[0])) {
            lineNum = i + 1;
            break;
          }
        }
        violations.push({
          rule: "missing_dependency",
          severity: "critical",
          file: file.path,
          line: lineNum,
          snippet: `Package "${pkg}" is required/imported but not in package.json`,
        });
      }
    }
  }
}

function checkJwtSecretUsage(files, violations) {
  for (const file of files) {
    if (!file.content) continue;
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/process\.env\.JWT_SECRET/.test(line)) {
        violations.push({
          rule: "jwt_secret_usage",
          severity: "critical",
          file: file.path,
          line: i + 1,
          snippet: line.trim(),
        });
      }
    }
  }
}

function checkVersionHallucination(packageJson, filePath, violations) {
  const deps = packageJson.dependencies || {};
  for (const [pkg, expectedVersion] of Object.entries(PINNED_VERSIONS)) {
    if (deps[pkg] && deps[pkg] !== expectedVersion) {
      violations.push({
        rule: "version_hallucination",
        severity: "medium",
        file: filePath,
        line: null,
        snippet: `"${pkg}": "${deps[pkg]}" — expected "${expectedVersion}"`,
      });
    }
  }
}

function checkEsmSyntax(files, violations) {
  for (const file of files) {
    if (!file.content) continue;
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*export\s+(default\s+)?function\s/.test(line) ||
          /^\s*export\s+(default\s+)?(class|const|let|var)\s/.test(line) ||
          /^\s*import\s+.+\s+from\s+["']/.test(line)) {
        violations.push({
          rule: "esm_syntax",
          severity: "critical",
          file: file.path,
          line: i + 1,
          snippet: line.trim(),
        });
      }
    }
  }
}

function checkBuildSteps(executorOutput, violations) {
  const startCmd = executorOutput.startCommand || "";
  if (/&&/.test(startCmd)) {
    violations.push({
      rule: "chained_start_command",
      severity: "critical",
      file: null,
      line: null,
      snippet: `startCommand: "${startCmd}" — must be a single command, no && chains`,
    });
  }
  const buildTools = ["esbuild", "webpack", "vite", "parcel", "tsc", "babel", "rollup"];
  for (const tool of buildTools) {
    if (startCmd.includes(tool)) {
      violations.push({
        rule: "build_step_in_start",
        severity: "critical",
        file: null,
        line: null,
        snippet: `startCommand uses build tool "${tool}": "${startCmd}"`,
      });
    }
  }
}

function checkNestedBackticks(serverFiles, violations) {
  for (const file of serverFiles) {
    if (!file.content) continue;
    const lines = file.content.split("\n");
    let inTemplateLiteral = false;
    let templateStart = -1;
    let depth = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/res\.(send|end|type\(.*\)\.send)\s*\(\s*`/.test(line) && !line.includes("`)")) {
        inTemplateLiteral = true;
        templateStart = i;
        depth = 1;
        continue;
      }
      if (inTemplateLiteral) {
        const backtickCount = (line.match(/`/g) || []).length;
        if (backtickCount > 0 && /fetch\s*\(\s*`/.test(line)) {
          violations.push({
            rule: "nested_backticks",
            severity: "critical",
            file: file.path,
            line: i + 1,
            snippet: line.trim(),
          });
        }
        if (/`\s*\)\s*;?\s*$/.test(line)) {
          inTemplateLiteral = false;
        }
      }
    }
  }
}

function calculateScore(violations) {
  let score = 100;
  for (const v of violations) {
    switch (v.severity) {
      case "critical": score -= 20; break;
      case "high": score -= 10; break;
      case "medium": score -= 5; break;
      default: score -= 2;
    }
  }
  return Math.max(0, score);
}

module.exports = { analyzeExecutorOutput };
