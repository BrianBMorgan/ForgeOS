"use strict";

let _sql = null;
function getDb() {
  if (!_sql) {
    const { neon } = require("@neondatabase/serverless");
    _sql = neon(process.env.NEON_DATABASE_URL);
  }
  return _sql;
}

async function ensureSchema() {
  const sql = getDb();
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS forge_analytics (
        id          BIGSERIAL PRIMARY KEY,
        project_id  VARCHAR(8) NOT NULL,
        session_id  VARCHAR(64) NOT NULL,
        visitor_id  VARCHAR(64) NOT NULL,
        event_type  VARCHAR(64) NOT NULL,
        url         TEXT,
        referrer    TEXT,
        properties  JSONB DEFAULT '{}',
        created_at  BIGINT NOT NULL
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS fa_project_id_idx    ON forge_analytics (project_id)`;
    await sql`CREATE INDEX IF NOT EXISTS fa_event_type_idx    ON forge_analytics (project_id, event_type)`;
    await sql`CREATE INDEX IF NOT EXISTS fa_created_at_idx    ON forge_analytics (project_id, created_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS fa_session_idx       ON forge_analytics (project_id, session_id)`;
    console.log("[analytics] Schema ready");
  } catch (err) {
    console.error("[analytics] ensureSchema failed:", err.message);
  }
}

// Ingest a batch of events from the tracker beacon
async function ingestEvents(projectId, events) {
  if (!Array.isArray(events) || events.length === 0) return;
  const sql = getDb();
  const now = Date.now();
  try {
    for (const ev of events) {
      await sql`
        INSERT INTO forge_analytics
          (project_id, session_id, visitor_id, event_type, url, referrer, properties, created_at)
        VALUES (
          ${projectId},
          ${String(ev.sessionId || "").slice(0, 64)},
          ${String(ev.visitorId || "").slice(0, 64)},
          ${String(ev.type || "unknown").slice(0, 64)},
          ${String(ev.url || "").slice(0, 2000) || null},
          ${String(ev.referrer || "").slice(0, 2000) || null},
          ${JSON.stringify(ev.properties || {})},
          ${ev.ts || now}
        )
      `;
    }
  } catch (err) {
    console.error("[analytics] ingestEvents failed:", err.message);
  }
}

// ── Query helpers ────────────────────────────────────────────────────────────

function sinceTs(range) {
  const now = Date.now();
  const map = { "1h": 3600000, "24h": 86400000, "7d": 604800000, "30d": 2592000000 };
  return now - (map[range] || map["24h"]);
}

async function getOverview(projectId, range = "24h") {
  const sql = getDb();
  const since = sinceTs(range);
  try {
    const [totals] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE event_type = 'pageview')   AS pageviews,
        COUNT(DISTINCT session_id)                         AS sessions,
        COUNT(DISTINCT visitor_id)                         AS visitors
      FROM forge_analytics
      WHERE project_id = ${projectId} AND created_at >= ${since}
    `;

    // Avg session duration — sum of session_end - session_start per session
    const durations = await sql`
      SELECT
        session_id,
        MAX(created_at) - MIN(created_at) AS duration_ms
      FROM forge_analytics
      WHERE project_id = ${projectId} AND created_at >= ${since}
      GROUP BY session_id
    `;
    const totalDur = durations.reduce((acc, r) => acc + Number(r.duration_ms), 0);
    const avgDuration = durations.length > 0 ? Math.round(totalDur / durations.length) : 0;

    // Bounce rate — sessions with only 1 pageview
    const bounces = await sql`
      SELECT COUNT(*) AS bounce_count FROM (
        SELECT session_id
        FROM forge_analytics
        WHERE project_id = ${projectId} AND created_at >= ${since} AND event_type = 'pageview'
        GROUP BY session_id
        HAVING COUNT(*) = 1
      ) bounced
    `;
    const bounceRate = totals.sessions > 0
      ? Math.round((Number(bounces[0].bounce_count) / Number(totals.sessions)) * 100)
      : 0;

    return {
      pageviews: Number(totals.pageviews),
      sessions: Number(totals.sessions),
      visitors: Number(totals.visitors),
      avgDurationMs: avgDuration,
      bounceRate,
    };
  } catch (err) {
    console.error("[analytics] getOverview failed:", err.message);
    return { pageviews: 0, sessions: 0, visitors: 0, avgDurationMs: 0, bounceRate: 0 };
  }
}

async function getTopPages(projectId, range = "24h", limit = 20) {
  const sql = getDb();
  const since = sinceTs(range);
  try {
    return await sql`
      SELECT
        url,
        COUNT(*) AS views,
        COUNT(DISTINCT session_id) AS sessions,
        ROUND(AVG(CAST(properties->>'timeOnPage' AS NUMERIC))) AS avg_time_ms
      FROM forge_analytics
      WHERE project_id = ${projectId}
        AND event_type = 'pageview'
        AND created_at >= ${since}
      GROUP BY url
      ORDER BY views DESC
      LIMIT ${limit}
    `;
  } catch (err) {
    console.error("[analytics] getTopPages failed:", err.message);
    return [];
  }
}

async function getTopEvents(projectId, range = "24h", limit = 30) {
  const sql = getDb();
  const since = sinceTs(range);
  try {
    return await sql`
      SELECT
        event_type,
        COUNT(*) AS count,
        COUNT(DISTINCT session_id) AS sessions
      FROM forge_analytics
      WHERE project_id = ${projectId}
        AND event_type NOT IN ('pageview', 'session_start', 'session_end', 'heartbeat')
        AND created_at >= ${since}
      GROUP BY event_type
      ORDER BY count DESC
      LIMIT ${limit}
    `;
  } catch (err) {
    console.error("[analytics] getTopEvents failed:", err.message);
    return [];
  }
}

async function getEventStream(projectId, range = "24h", limit = 100) {
  const sql = getDb();
  const since = sinceTs(range);
  try {
    return await sql`
      SELECT event_type, url, properties, created_at
      FROM forge_analytics
      WHERE project_id = ${projectId} AND created_at >= ${since}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  } catch (err) {
    console.error("[analytics] getEventStream failed:", err.message);
    return [];
  }
}

async function getWebVitals(projectId, range = "24h") {
  const sql = getDb();
  const since = sinceTs(range);
  try {
    const rows = await sql`
      SELECT properties
      FROM forge_analytics
      WHERE project_id = ${projectId}
        AND event_type = 'web_vitals'
        AND created_at >= ${since}
    `;
    if (rows.length === 0) return null;

    const agg = { LCP: [], FID: [], CLS: [], FCP: [], TTFB: [], INP: [] };
    for (const row of rows) {
      const p = row.properties || {};
      for (const metric of Object.keys(agg)) {
        if (p[metric] != null) agg[metric].push(Number(p[metric]));
      }
    }

    const result = {};
    for (const [k, vals] of Object.entries(agg)) {
      if (vals.length === 0) continue;
      vals.sort((a, b) => a - b);
      result[k] = {
        p50: vals[Math.floor(vals.length * 0.5)],
        p75: vals[Math.floor(vals.length * 0.75)],
        p95: vals[Math.floor(vals.length * 0.95)],
        count: vals.length,
      };
    }
    return result;
  } catch (err) {
    console.error("[analytics] getWebVitals failed:", err.message);
    return null;
  }
}

async function getErrors(projectId, range = "24h", limit = 50) {
  const sql = getDb();
  const since = sinceTs(range);
  try {
    return await sql`
      SELECT
        properties->>'message' AS message,
        properties->>'stack'   AS stack,
        properties->>'source'  AS source,
        COUNT(*) AS count,
        MAX(created_at) AS last_seen
      FROM forge_analytics
      WHERE project_id = ${projectId}
        AND event_type IN ('js_error', 'unhandled_rejection')
        AND created_at >= ${since}
      GROUP BY message, stack, source
      ORDER BY count DESC
      LIMIT ${limit}
    `;
  } catch (err) {
    console.error("[analytics] getErrors failed:", err.message);
    return [];
  }
}

async function getDeviceBreakdown(projectId, range = "24h") {
  const sql = getDb();
  const since = sinceTs(range);
  try {
    const browsers = await sql`
      SELECT properties->>'browser' AS browser, COUNT(DISTINCT session_id) AS sessions
      FROM forge_analytics
      WHERE project_id = ${projectId} AND event_type = 'session_start' AND created_at >= ${since}
      GROUP BY browser ORDER BY sessions DESC LIMIT 10
    `;
    const os = await sql`
      SELECT properties->>'os' AS os, COUNT(DISTINCT session_id) AS sessions
      FROM forge_analytics
      WHERE project_id = ${projectId} AND event_type = 'session_start' AND created_at >= ${since}
      GROUP BY os ORDER BY sessions DESC LIMIT 10
    `;
    const devices = await sql`
      SELECT properties->>'deviceType' AS device_type, COUNT(DISTINCT session_id) AS sessions
      FROM forge_analytics
      WHERE project_id = ${projectId} AND event_type = 'session_start' AND created_at >= ${since}
      GROUP BY device_type ORDER BY sessions DESC
    `;
    const viewports = await sql`
      SELECT properties->>'viewport' AS viewport, COUNT(*) AS count
      FROM forge_analytics
      WHERE project_id = ${projectId} AND event_type = 'session_start' AND created_at >= ${since}
      GROUP BY viewport ORDER BY count DESC LIMIT 10
    `;
    return { browsers, os, devices, viewports };
  } catch (err) {
    console.error("[analytics] getDeviceBreakdown failed:", err.message);
    return { browsers: [], os: [], devices: [], viewports: [] };
  }
}

async function getPageviewTimeseries(projectId, range = "24h") {
  const sql = getDb();
  const since = sinceTs(range);
  // Bucket size: 1h for 24h, 6h for 7d, 1d for 30d
  const bucketMs = range === "1h" ? 300000 : range === "24h" ? 3600000 : range === "7d" ? 21600000 : 86400000;
  try {
    const rows = await sql`
      SELECT
        (created_at / ${bucketMs}) * ${bucketMs} AS bucket,
        COUNT(*) FILTER (WHERE event_type = 'pageview') AS pageviews,
        COUNT(DISTINCT session_id) AS sessions
      FROM forge_analytics
      WHERE project_id = ${projectId} AND created_at >= ${since}
      GROUP BY bucket
      ORDER BY bucket ASC
    `;
    return rows.map(r => ({
      ts: Number(r.bucket),
      pageviews: Number(r.pageviews),
      sessions: Number(r.sessions),
    }));
  } catch (err) {
    console.error("[analytics] getPageviewTimeseries failed:", err.message);
    return [];
  }
}

async function getReferrers(projectId, range = "24h", limit = 20) {
  const sql = getDb();
  const since = sinceTs(range);
  try {
    return await sql`
      SELECT
        COALESCE(NULLIF(referrer, ''), '(direct)') AS referrer,
        COUNT(*) AS visits,
        COUNT(DISTINCT session_id) AS sessions
      FROM forge_analytics
      WHERE project_id = ${projectId}
        AND event_type = 'pageview'
        AND created_at >= ${since}
      GROUP BY referrer
      ORDER BY visits DESC
      LIMIT ${limit}
    `;
  } catch (err) {
    console.error("[analytics] getReferrers failed:", err.message);
    return [];
  }
}

async function getScrollDepth(projectId, range = "24h") {
  const sql = getDb();
  const since = sinceTs(range);
  try {
    const rows = await sql`
      SELECT properties->>'depth' AS depth, COUNT(*) AS count
      FROM forge_analytics
      WHERE project_id = ${projectId}
        AND event_type = 'scroll_depth'
        AND created_at >= ${since}
      GROUP BY depth
      ORDER BY CAST(depth AS INTEGER) ASC
    `;
    return rows;
  } catch (err) {
    console.error("[analytics] getScrollDepth failed:", err.message);
    return [];
  }
}

module.exports = {
  ensureSchema,
  ingestEvents,
  getOverview,
  getTopPages,
  getTopEvents,
  getEventStream,
  getWebVitals,
  getErrors,
  getDeviceBreakdown,
  getPageviewTimeseries,
  getReferrers,
  getScrollDepth,
};
