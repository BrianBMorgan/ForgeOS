/**
 * chat/manager.js — Lean utility module.
 *
 * The old Chat Agent (1380 lines) has been replaced by the unified
 * Forge Agent (server/agent/forge.js). This file retains only:
 *   - runDiagnostics: system health check endpoint
 *   - clearBuildSuggestions: clears stale suggestion state from DB
 *   - getChatHistory: reads conversation history for the chat panel
 */

"use strict";

const { neon } = require("@neondatabase/serverless");

const dbUrl = process.env.NEON_DATABASE_URL;
let sql = null;
function getDb() {
  if (!sql && dbUrl) sql = neon(dbUrl);
  return sql;
}

// ── Chat history ──────────────────────────────────────────────────────────────

async function getChatHistory(projectId) {
  const db = getDb();
  if (!db) return [];
  try {
    const rows = await db`
      SELECT role, content, created_at
      FROM chat_messages
      WHERE project_id = ${projectId}
      ORDER BY created_at ASC
      LIMIT 100
    `;
    return rows;
  } catch {
    return [];
  }
}

async function clearBuildSuggestions(projectId) {
  const db = getDb();
  if (!db) return;
  try {
    await db`
      UPDATE chat_messages
      SET suggest_build = false, suggest_plan = false, suggest_forge = false, forge_suggestion = null
      WHERE project_id = ${projectId}
        AND (suggest_build = true OR suggest_plan = true OR suggest_forge = true)
    `;
  } catch (err) {
    console.error("Failed to clear build suggestions:", err.message);
  }
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

const VALID_CHECKS = new Set(["env", "api", "models", "pipeline", "workspace", "db", "secrets", "all"]);

async function runDiagnostics(projectId, checks) {
  const filtered = (checks && checks.length ? checks : ["all"]).filter(c => VALID_CHECKS.has(c));
  if (filtered.length === 0) filtered.push("all");
  const wantedChecks = new Set(filtered);
  const all = wantedChecks.has("all");
  const report = { timestamp: new Date().toISOString(), checks: {} };

  if (all || wantedChecks.has("env")) {
    const envReport = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ? "SET" : "MISSING",
      NEON_DATABASE_URL: process.env.NEON_DATABASE_URL ? "SET" : "MISSING",
      GITHUB_TOKEN: process.env.GITHUB_TOKEN ? "SET" : "MISSING",
      NODE_ENV: process.env.NODE_ENV || "not set",
    };
    const missing = Object.entries(envReport).filter(([, v]) => v === "MISSING").map(([k]) => k);
    envReport.status = missing.length > 0 ? "FAIL" : "OK";
    envReport.missing = missing;
    if (missing.includes("ANTHROPIC_API_KEY")) {
      envReport.impact = "CRITICAL — all AI pipeline stages will fail. Set ANTHROPIC_API_KEY on Render.";
    }
    report.checks.env = envReport;
  }

  if (all || wantedChecks.has("workspace")) {
    try {
      const workspace = require("../workspace/manager");
      const wsReport = { status: "OK" };
      report.checks.workspace = wsReport;
    } catch (err) {
      report.checks.workspace = { status: "FAIL", error: err.message };
    }
  }

  if (all || wantedChecks.has("secrets")) {
    try {
      const settingsManager = require("../settings/manager");
      const keys = await settingsManager.getAllSecretKeys();
      report.checks.secrets = { status: "OK", keys };
    } catch (err) {
      report.checks.secrets = { status: "FAIL", error: err.message };
    }
  }

  return report;
}

module.exports = {
  getChatHistory,
  clearBuildSuggestions,
  runDiagnostics,
};
