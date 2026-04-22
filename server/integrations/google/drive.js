"use strict";

const { googleFetch, jsonOrThrow } = require("./auth");

const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";

const FILE_FIELDS = "id,name,mimeType,size,modifiedTime,createdTime,parents,webViewLink,iconLink,trashed";

// ── Search & list ─────────────────────────────────────────────────────────────

async function search({ q, pageSize = 25, orderBy = "modifiedTime desc", folderId, includeTrashed = false }) {
  const parts = [];
  if (q) parts.push(`(name contains '${escapeQuery(q)}' or fullText contains '${escapeQuery(q)}')`);
  if (folderId) parts.push(`'${folderId}' in parents`);
  if (!includeTrashed) parts.push("trashed = false");
  const params = new URLSearchParams({
    q: parts.join(" and "),
    fields: `files(${FILE_FIELDS}),nextPageToken`,
    pageSize: String(Math.min(1000, pageSize)),
    orderBy,
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const res = await googleFetch(`${DRIVE_BASE}/files?${params.toString()}`);
  const data = await jsonOrThrow(res, "drive.files.list");
  return (data.files || []).map(normalizeFile);
}

function escapeQuery(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function listFolder({ folderId = "root", pageSize = 100 }) {
  return search({ q: "", folderId, pageSize, orderBy: "name" });
}

async function getFile(fileId) {
  const res = await googleFetch(`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`);
  const data = await jsonOrThrow(res, "drive.files.get");
  return normalizeFile(data);
}

function normalizeFile(f) {
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    size: f.size ? Number(f.size) : null,
    modifiedTime: f.modifiedTime,
    createdTime: f.createdTime,
    parents: f.parents || [],
    webViewLink: f.webViewLink,
    trashed: !!f.trashed,
  };
}

// ── Read contents ─────────────────────────────────────────────────────────────
// Google-native types need export. Plain files use alt=media.

const GOOGLE_NATIVE_EXPORTS = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.drawing": "image/png",
  "application/vnd.google-apps.script": "application/vnd.google-apps.script+json",
};

async function readFile(fileId, { maxBytes = 200_000 } = {}) {
  const meta = await getFile(fileId);
  let url;
  let asText = true;
  if (GOOGLE_NATIVE_EXPORTS[meta.mimeType]) {
    url = `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(GOOGLE_NATIVE_EXPORTS[meta.mimeType])}&supportsAllDrives=true`;
  } else {
    url = `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
    // If it's not a text mime-type, return base64 bytes instead
    if (!(meta.mimeType || "").startsWith("text/") && meta.mimeType !== "application/json") {
      asText = false;
    }
  }
  const res = await googleFetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`drive.read failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const truncated = buf.length > maxBytes;
  const slice = truncated ? buf.subarray(0, maxBytes) : buf;
  return {
    meta,
    encoding: asText ? "utf-8" : "base64",
    content: asText ? slice.toString("utf-8") : slice.toString("base64"),
    truncated,
    totalBytes: buf.length,
  };
}

// ── Write / create ────────────────────────────────────────────────────────────

async function createFolder({ name, parentId }) {
  const payload = { name, mimeType: "application/vnd.google-apps.folder" };
  if (parentId) payload.parents = [parentId];
  const res = await googleFetch(`${DRIVE_BASE}/files?fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await jsonOrThrow(res, "drive.folder.create");
  return normalizeFile(data);
}

async function writeFile({ name, parentId, mimeType = "text/plain", content, encoding = "utf-8", fileId }) {
  // Multipart upload so we can set metadata + body in one call.
  const boundary = "frgms_" + Math.random().toString(36).slice(2);
  const metadata = { name };
  if (parentId && !fileId) metadata.parents = [parentId];

  const bodyBuf = encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content || "", "utf-8");

  const preamble = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    "utf-8"
  );
  const epilogue = Buffer.from(`\r\n--${boundary}--`, "utf-8");
  const multipart = Buffer.concat([preamble, bodyBuf, epilogue]);

  const isUpdate = Boolean(fileId);
  const url = isUpdate
    ? `${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(fileId)}?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`
    : `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`;

  const res = await googleFetch(url, {
    method: isUpdate ? "PATCH" : "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body: multipart,
  });
  const data = await jsonOrThrow(res, "drive.files." + (isUpdate ? "update" : "create"));
  return normalizeFile(data);
}

async function moveFile({ fileId, addParents, removeParents }) {
  const params = new URLSearchParams({
    fields: FILE_FIELDS,
    supportsAllDrives: "true",
  });
  if (addParents) params.set("addParents", addParents);
  if (removeParents) params.set("removeParents", removeParents);
  const res = await googleFetch(`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?${params.toString()}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const data = await jsonOrThrow(res, "drive.files.move");
  return normalizeFile(data);
}

async function deleteFile(fileId, { trash = true } = {}) {
  // Default to trashing (recoverable) rather than hard-delete. Frank can pass
  // trash=false to hard-delete but it should be rare.
  if (trash) {
    const res = await googleFetch(`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true }),
    });
    const data = await jsonOrThrow(res, "drive.files.trash");
    return { trashed: true, id: data.id };
  }
  const res = await googleFetch(`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) {
    await jsonOrThrow(res, "drive.files.delete");
  }
  return { deleted: true, id: fileId };
}

module.exports = {
  search,
  listFolder,
  getFile,
  readFile,
  createFolder,
  writeFile,
  moveFile,
  deleteFile,
};
