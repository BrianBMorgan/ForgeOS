"use strict";

const { googleFetch, jsonOrThrow } = require("./auth");

const DOCS_BASE = "https://docs.googleapis.com/v1/documents";

async function readDoc(documentId) {
  const res = await googleFetch(`${DOCS_BASE}/${encodeURIComponent(documentId)}`);
  const data = await jsonOrThrow(res, "docs.documents.get");
  return {
    id: data.documentId,
    title: data.title,
    body: flattenBody(data.body),
    revisionId: data.revisionId,
  };
}

// Collapse the Docs structural body into plain text so Frank can reason about
// content without wading through the raw API schema. Preserves headings by
// prefixing with '# ' / '## ' based on named style.
function flattenBody(body) {
  if (!body?.content) return "";
  const lines = [];
  for (const el of body.content) {
    if (el.paragraph) {
      const style = el.paragraph.paragraphStyle?.namedStyleType || "";
      const text = (el.paragraph.elements || [])
        .map((e) => e.textRun?.content || "")
        .join("")
        .replace(/\n$/, "");
      let prefix = "";
      if (style.startsWith("HEADING_1")) prefix = "# ";
      else if (style.startsWith("HEADING_2")) prefix = "## ";
      else if (style.startsWith("HEADING_3")) prefix = "### ";
      else if (style.startsWith("HEADING_4")) prefix = "#### ";
      else if (style === "TITLE") prefix = "# ";
      lines.push(prefix + text);
    } else if (el.table) {
      lines.push("[table — use Docs UI to view]");
    }
  }
  return lines.join("\n").trim();
}

async function batchUpdate(documentId, requests) {
  const res = await googleFetch(`${DOCS_BASE}/${encodeURIComponent(documentId)}:batchUpdate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  return jsonOrThrow(res, "docs.documents.batchUpdate");
}

async function appendText(documentId, text) {
  // First get the document so we know the end index.
  const getRes = await googleFetch(`${DOCS_BASE}/${encodeURIComponent(documentId)}?fields=body.content(endIndex)`);
  const data = await jsonOrThrow(getRes, "docs.documents.get (for append)");
  const contents = data.body?.content || [];
  // endIndex of the last element minus 1 is the safe insertion point.
  const lastEnd = contents.length > 0 ? contents[contents.length - 1].endIndex : 1;
  const index = Math.max(1, lastEnd - 1);
  return batchUpdate(documentId, [
    { insertText: { location: { index }, text } },
  ]);
}

async function replaceAllText(documentId, replacements) {
  // replacements: [{ find, replace, matchCase }]
  const requests = replacements.map((r) => ({
    replaceAllText: {
      containsText: { text: r.find, matchCase: r.matchCase !== false },
      replaceText: r.replace,
    },
  }));
  return batchUpdate(documentId, requests);
}

async function createDoc({ title }) {
  const res = await googleFetch(DOCS_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  return jsonOrThrow(res, "docs.documents.create");
}

module.exports = {
  readDoc,
  appendText,
  replaceAllText,
  createDoc,
  batchUpdate,
};
