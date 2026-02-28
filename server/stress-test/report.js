const fs = require("fs");
const path = require("path");
const { RESULTS_DIR } = require("./logger");

function generateReport(results) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(RESULTS_DIR, `report-${ts}.json`);
  const txtPath = path.join(RESULTS_DIR, `summary-${ts}.txt`);

  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }

  const summary = buildSummary(results);
  const perPrompt = buildPerPromptBreakdown(results);
  const violationFrequency = buildViolationFrequency(results);
  const categoryAnalysis = buildCategoryAnalysis(results);
  const stageFailures = buildStageFailureAnalysis(results);
  const errorPatterns = buildCommonErrorPatterns(results);
  const suggestions = buildInstructionGapSuggestions(violationFrequency, stageFailures, categoryAnalysis);

  const report = {
    generatedAt: new Date().toISOString(),
    summary,
    perPrompt,
    violationFrequency,
    categoryAnalysis,
    stageFailures,
    errorPatterns,
    suggestions,
  };

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf-8");

  const textSummary = renderTextSummary(report);
  fs.writeFileSync(txtPath, textSummary, "utf-8");

  console.log(`\n📊 Report saved:`);
  console.log(`   JSON: ${jsonPath}`);
  console.log(`   Text: ${txtPath}`);

  return { jsonPath, txtPath, report };
}

function buildSummary(results) {
  const total = results.length;
  const pass = results.filter((r) => r.finalStatus === "pass").length;
  const passWithViolations = results.filter((r) => r.finalStatus === "pass_with_violations").length;
  const fail = results.filter((r) => r.finalStatus.startsWith("fail_")).length;
  const timeout = results.filter((r) => r.finalStatus === "timeout").length;
  const error = results.filter((r) => r.finalStatus === "error").length;
  const totalDuration = results.reduce((sum, r) => sum + (r.totalDuration || 0), 0);
  const avgDuration = total > 0 ? totalDuration / total : 0;
  const successRate = total > 0 ? ((pass + passWithViolations) / total) * 100 : 0;

  const auditorFixApplied = results.filter((r) => r.auditorResult?.fixApplied).length;
  const auditorCleanPass = results.filter((r) => r.auditorResult?.approved && !r.auditorResult?.fixApplied).length;

  return {
    total,
    pass,
    passWithViolations,
    fail,
    timeout,
    error,
    successRate: Math.round(successRate * 10) / 10,
    totalDuration,
    avgDuration: Math.round(avgDuration),
    auditorFixApplied,
    auditorCleanPass,
  };
}

function buildPerPromptBreakdown(results) {
  return results.map((r) => ({
    promptId: r.promptId,
    category: r.category,
    finalStatus: r.finalStatus,
    violationCount: (r.violations || []).length,
    violationScore: r.violationScore,
    totalDuration: r.totalDuration,
    error: r.error || null,
    stages: r.stages || {},
    healthCheck: r.healthCheck || null,
  }));
}

function buildViolationFrequency(results) {
  const freq = {};
  for (const r of results) {
    for (const v of r.violations || []) {
      if (!freq[v.rule]) {
        freq[v.rule] = { rule: v.rule, count: 0, severity: v.severity, examples: [] };
      }
      freq[v.rule].count++;
      if (freq[v.rule].examples.length < 3) {
        freq[v.rule].examples.push({
          promptId: r.promptId,
          file: v.file,
          snippet: v.snippet,
        });
      }
    }
  }
  return Object.values(freq).sort((a, b) => b.count - a.count);
}

function buildCategoryAnalysis(results) {
  const categories = {};
  for (const r of results) {
    const cat = r.category || "unknown";
    if (!categories[cat]) {
      categories[cat] = { category: cat, total: 0, pass: 0, fail: 0, timeout: 0, successRate: 0 };
    }
    categories[cat].total++;
    if (r.finalStatus === "pass" || r.finalStatus === "pass_with_violations") {
      categories[cat].pass++;
    } else if (r.finalStatus === "timeout") {
      categories[cat].timeout++;
    } else {
      categories[cat].fail++;
    }
  }
  for (const cat of Object.values(categories)) {
    cat.successRate = cat.total > 0 ? Math.round((cat.pass / cat.total) * 100 * 10) / 10 : 0;
  }
  return Object.values(categories).sort((a, b) => a.successRate - b.successRate);
}

function buildStageFailureAnalysis(results) {
  const stageMap = {
    fail_plan: "planning",
    fail_install: "install",
    fail_start: "startup",
    fail_health: "health-check",
    fail_violations: "violations",
  };

  const stages = {};
  for (const r of results) {
    const stage = stageMap[r.finalStatus];
    if (stage) {
      if (!stages[stage]) {
        stages[stage] = { stage, count: 0, promptIds: [] };
      }
      stages[stage].count++;
      stages[stage].promptIds.push(r.promptId);
    }
  }
  return Object.values(stages).sort((a, b) => b.count - a.count);
}

function buildCommonErrorPatterns(results) {
  const errorGroups = {};
  for (const r of results) {
    if (!r.error) continue;
    const key = normalizeError(r.error);
    if (!errorGroups[key]) {
      errorGroups[key] = { pattern: key, count: 0, promptIds: [], sampleError: r.error };
    }
    errorGroups[key].count++;
    if (errorGroups[key].promptIds.length < 5) {
      errorGroups[key].promptIds.push(r.promptId);
    }
  }
  return Object.values(errorGroups).sort((a, b) => b.count - a.count);
}

function normalizeError(error) {
  let normalized = error
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<ID>")
    .replace(/\d{4,}/g, "<NUM>")
    .replace(/port \d+/gi, "port <PORT>");

  if (normalized.includes("ECONNREFUSED")) return "Connection refused";
  if (normalized.includes("timed out") || normalized.includes("Timeout")) return "Timeout";
  if (normalized.includes("npm install") || normalized.includes("install failed")) return "Install failure";
  if (normalized.includes("Cannot find module")) return "Missing module";
  if (normalized.includes("Health check failed")) return "Health check failure";

  return normalized.substring(0, 100);
}

function buildInstructionGapSuggestions(violationFrequency, stageFailures, categoryAnalysis) {
  const suggestions = [];

  for (const v of violationFrequency) {
    if (v.count >= 2) {
      switch (v.rule) {
        case "banned_package":
          suggestions.push({
            issue: `"${v.rule}" violation found ${v.count} times`,
            suggestion: "Strengthen instructions about banned packages (bcrypt, passport, dotenv, etc.)",
          });
          break;
        case "wrong_db_driver":
          suggestions.push({
            issue: `"${v.rule}" violation found ${v.count} times`,
            suggestion: 'Emphasize using @neondatabase/serverless instead of "pg" in instructions',
          });
          break;
        case "absolute_fetch_path":
          suggestions.push({
            issue: `"${v.rule}" violation found ${v.count} times`,
            suggestion: "Add explicit instruction to use relative fetch URLs (no leading slash with full domain)",
          });
          break;
        case "missing_root_route":
          suggestions.push({
            issue: `"${v.rule}" violation found ${v.count} times`,
            suggestion: 'Require every app to define app.get("/") serving HTML',
          });
          break;
        case "wrong_port":
          suggestions.push({
            issue: `"${v.rule}" violation found ${v.count} times`,
            suggestion: "Reinforce that the app MUST listen on port 4000",
          });
          break;
        case "dotenv_usage":
          suggestions.push({
            issue: `"${v.rule}" violation found ${v.count} times`,
            suggestion: "Explicitly ban dotenv — env vars are already available via process.env",
          });
          break;
        case "jwt_secret_usage":
          suggestions.push({
            issue: `"${v.rule}" violation found ${v.count} times`,
            suggestion: "Emphasize using JWKS via jose instead of JWT_SECRET for auth",
          });
          break;
        case "missing_dependency":
          suggestions.push({
            issue: `"${v.rule}" violation found ${v.count} times`,
            suggestion: "Ensure executor adds all imported packages to package.json dependencies",
          });
          break;
        case "version_hallucination":
          suggestions.push({
            issue: `"${v.rule}" violation found ${v.count} times`,
            suggestion: "Pin specific versions in instructions for key packages",
          });
          break;
        default:
          suggestions.push({
            issue: `"${v.rule}" violation found ${v.count} times`,
            suggestion: `Add or strengthen instructions related to: ${v.rule}`,
          });
      }
    }
  }

  for (const sf of stageFailures) {
    if (sf.count >= 2) {
      suggestions.push({
        issue: `${sf.stage} failures: ${sf.count} prompts`,
        suggestion: `Investigate why ${sf.stage} fails frequently — may need better ${sf.stage} instructions or constraints`,
      });
    }
  }

  for (const ca of categoryAnalysis) {
    if (ca.successRate < 50 && ca.total >= 2) {
      suggestions.push({
        issue: `Category "${ca.category}" has only ${ca.successRate}% success rate (${ca.pass}/${ca.total})`,
        suggestion: `Review and improve instructions for ${ca.category} prompts`,
      });
    }
  }

  return suggestions;
}

function renderTextSummary(report) {
  const lines = [];
  const hr = "=".repeat(70);
  const sr = "-".repeat(70);

  lines.push(hr);
  lines.push("  ForgeOS Stress Test Report");
  lines.push(`  Generated: ${report.generatedAt}`);
  lines.push(hr);
  lines.push("");

  const s = report.summary;
  lines.push("SUMMARY");
  lines.push(sr);
  lines.push(`  Total Runs:           ${s.total}`);
  lines.push(`  Passed:               ${s.pass}`);
  lines.push(`  Passed w/ Violations: ${s.passWithViolations}`);
  lines.push(`  Failed:               ${s.fail}`);
  lines.push(`  Timed Out:            ${s.timeout}`);
  lines.push(`  Errors:               ${s.error}`);
  lines.push(`  Success Rate:         ${s.successRate}%`);
  lines.push(`  Total Duration:       ${(s.totalDuration / 1000).toFixed(1)}s`);
  lines.push(`  Avg Duration:         ${(s.avgDuration / 1000).toFixed(1)}s`);
  if (s.auditorCleanPass !== undefined) {
    lines.push(`  Auditor Clean Pass:   ${s.auditorCleanPass}`);
    lines.push(`  Auditor Fix Applied:  ${s.auditorFixApplied}`);
  }
  lines.push("");

  lines.push("PER-PROMPT BREAKDOWN");
  lines.push(sr);
  const colW = { id: 25, cat: 16, status: 22, viol: 6, dur: 10 };
  lines.push(
    `  ${"Prompt".padEnd(colW.id)} ${"Category".padEnd(colW.cat)} ${"Status".padEnd(colW.status)} ${"Viol".padStart(colW.viol)} ${"Duration".padStart(colW.dur)}`
  );
  lines.push(`  ${"-".repeat(colW.id)} ${"-".repeat(colW.cat)} ${"-".repeat(colW.status)} ${"-".repeat(colW.viol)} ${"-".repeat(colW.dur)}`);
  for (const p of report.perPrompt) {
    const dur = `${(p.totalDuration / 1000).toFixed(1)}s`;
    const viol = String(p.violationCount);
    lines.push(
      `  ${p.promptId.padEnd(colW.id)} ${p.category.padEnd(colW.cat)} ${p.finalStatus.padEnd(colW.status)} ${viol.padStart(colW.viol)} ${dur.padStart(colW.dur)}`
    );
    if (p.error) {
      lines.push(`    Error: ${p.error.substring(0, 80)}`);
    }
  }
  lines.push("");

  if (report.violationFrequency.length > 0) {
    lines.push("VIOLATION FREQUENCY");
    lines.push(sr);
    for (const v of report.violationFrequency) {
      lines.push(`  [${v.severity.toUpperCase()}] ${v.rule}: ${v.count} occurrence(s)`);
      for (const ex of v.examples) {
        lines.push(`    - ${ex.promptId}: ${ex.snippet ? ex.snippet.substring(0, 60) : "N/A"}`);
      }
    }
    lines.push("");
  }

  if (report.categoryAnalysis.length > 0) {
    lines.push("CATEGORY ANALYSIS");
    lines.push(sr);
    for (const c of report.categoryAnalysis) {
      lines.push(`  ${c.category.padEnd(20)} ${c.pass}/${c.total} passed (${c.successRate}%)`);
    }
    lines.push("");
  }

  if (report.stageFailures.length > 0) {
    lines.push("STAGE FAILURE ANALYSIS");
    lines.push(sr);
    for (const sf of report.stageFailures) {
      lines.push(`  ${sf.stage.padEnd(20)} ${sf.count} failure(s): ${sf.promptIds.join(", ")}`);
    }
    lines.push("");
  }

  if (report.errorPatterns.length > 0) {
    lines.push("COMMON ERROR PATTERNS");
    lines.push(sr);
    for (const ep of report.errorPatterns) {
      lines.push(`  "${ep.pattern}" — ${ep.count} occurrence(s)`);
      lines.push(`    Affected: ${ep.promptIds.join(", ")}`);
      lines.push(`    Sample:   ${ep.sampleError.substring(0, 80)}`);
    }
    lines.push("");
  }

  if (report.suggestions.length > 0) {
    lines.push("INSTRUCTION GAP SUGGESTIONS");
    lines.push(sr);
    for (let i = 0; i < report.suggestions.length; i++) {
      const sg = report.suggestions[i];
      lines.push(`  ${i + 1}. Issue: ${sg.issue}`);
      lines.push(`     Suggestion: ${sg.suggestion}`);
    }
    lines.push("");
  }

  lines.push(hr);
  lines.push("  End of Report");
  lines.push(hr);

  return lines.join("\n") + "\n";
}

module.exports = { generateReport };
