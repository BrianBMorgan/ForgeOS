"use strict";

const { googleFetch, jsonOrThrow } = require("./auth");

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

// ── Search & read ─────────────────────────────────────────────────────────────

async function searchThreads({ query, maxResults = 20 }) {
  const url = `${GMAIL_BASE}/threads?q=${encodeURIComponent(query || "")}&maxResults=${Math.min(100, maxResults)}`;
  const res = await googleFetch(url);
  const data = await jsonOrThrow(res, "gmail.threads.list");
  return (data.threads || []).map((t) => ({ id: t.id, historyId: t.historyId, snippet: t.snippet }));
}

async function readThread(threadId, { maxBodyChars = 4000 } = {}) {
  const url = `${GMAIL_BASE}/threads/${encodeURIComponent(threadId)}?format=full`;
  const res = await googleFetch(url);
  const data = await jsonOrThrow(res, "gmail.threads.get");
  const messages = (data.messages || []).map((m) => {
    const headers = Object.fromEntries(
      (m.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value])
    );
    return {
      id: m.id,
      from: headers.from || "",
      to: headers.to || "",
      cc: headers.cc || "",
      subject: headers.subject || "",
      date: headers.date || "",
      snippet: m.snippet || "",
      body: extractBody(m.payload, maxBodyChars),
      labelIds: m.labelIds || [],
    };
  });
  return { id: data.id, historyId: data.historyId, messages };
}

function extractBody(payload, maxChars) {
  if (!payload) return "";
  const parts = [];
  const walk = (p) => {
    if (!p) return;
    if (p.body?.data && (p.mimeType === "text/plain" || p.mimeType === "text/html")) {
      try {
        const decoded = Buffer.from(p.body.data, "base64").toString("utf-8");
        parts.push({ mime: p.mimeType, text: decoded });
      } catch { /* ignore malformed part */ }
    }
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  // Prefer plaintext; fall back to stripped HTML
  const plain = parts.find((p) => p.mime === "text/plain");
  const html = parts.find((p) => p.mime === "text/html");
  let body = plain?.text || (html ? html.text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "");
  if (body.length > maxChars) body = body.slice(0, maxChars) + `\n[...truncated, ${body.length - maxChars} more chars]`;
  return body;
}

// ── Labels ────────────────────────────────────────────────────────────────────

async function listLabels() {
  const res = await googleFetch(`${GMAIL_BASE}/labels`);
  const data = await jsonOrThrow(res, "gmail.labels.list");
  return (data.labels || []).map((l) => ({ id: l.id, name: l.name, type: l.type }));
}

async function modifyThreadLabels(threadId, { addLabelIds = [], removeLabelIds = [] }) {
  const res = await googleFetch(`${GMAIL_BASE}/threads/${encodeURIComponent(threadId)}/modify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ addLabelIds, removeLabelIds }),
  });
  return jsonOrThrow(res, "gmail.threads.modify");
}

// ── Drafts & send ─────────────────────────────────────────────────────────────

function buildRawMessage({ to, cc, bcc, subject, body, replyTo, inReplyTo, references }) {
  const headers = [];
  if (to) headers.push(`To: ${to}`);
  if (cc) headers.push(`Cc: ${cc}`);
  if (bcc) headers.push(`Bcc: ${bcc}`);
  if (replyTo) headers.push(`Reply-To: ${replyTo}`);
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);
  headers.push(`Subject: ${subject || ""}`);
  headers.push("MIME-Version: 1.0");
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push("Content-Transfer-Encoding: 7bit");
  const raw = `${headers.join("\r\n")}\r\n\r\n${body || ""}`;
  // Gmail wants URL-safe base64
  return Buffer.from(raw, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function createDraft({ to, cc, bcc, subject, body, threadId, inReplyTo, references }) {
  const raw = buildRawMessage({ to, cc, bcc, subject, body, inReplyTo, references });
  const payload = { message: { raw } };
  if (threadId) payload.message.threadId = threadId;
  const res = await googleFetch(`${GMAIL_BASE}/drafts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return jsonOrThrow(res, "gmail.drafts.create");
}

async function sendMessage({ to, cc, bcc, subject, body, threadId, inReplyTo, references }) {
  const raw = buildRawMessage({ to, cc, bcc, subject, body, inReplyTo, references });
  const payload = { raw };
  if (threadId) payload.threadId = threadId;
  const res = await googleFetch(`${GMAIL_BASE}/messages/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return jsonOrThrow(res, "gmail.messages.send");
}

module.exports = {
  searchThreads,
  readThread,
  listLabels,
  modifyThreadLabels,
  createDraft,
  sendMessage,
};
