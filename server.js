"use strict";

const express = require("express");
const { neon } = require("@neondatabase/serverless");
const cookieSession = require("cookie-session");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const DB_URL = process.env.CANVAS_DATABASE_URL;
if (!DB_URL) { console.error("[canvas] FATAL: CANVAS_DATABASE_URL not set"); process.exit(1); }
const sql = neon(DB_URL);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Apply cookie-session only to admin routes
const adminSession = cookieSession({
  name: "canvas_admin",
  keys: [process.env.ADMIN_PASSWORD || "canvas-secret"],
  maxAge: 8 * 60 * 60 * 1000,
});

// ── Debug (remove after proxy issue resolved) ────────────────────────────────
app.post("/debug-register", (req, res) => {
  res.json({
    body: req.body,
    headers: {
      "content-type": req.headers["content-type"],
      "content-length": req.headers["content-length"],
    },
  });
});

// ── Schema ────────────────────────────────────────────────────────────────────
async function ensureSchema() {
  await sql`CREATE TABLE IF NOT EXISTS canvas_attendees (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR(32) UNIQUE NOT NULL,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    email VARCHAR(255),
    created_at BIGINT NOT NULL
  )`;
  await sql`CREATE TABLE IF NOT EXISTS canvas_artworks (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR(32) REFERENCES canvas_attendees(session_id) ON DELETE CASCADE,
    png_data TEXT NOT NULL,
    created_at BIGINT NOT NULL
  )`;
  await sql`CREATE TABLE IF NOT EXISTS canvas_stickers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    image_data TEXT NOT NULL,
    mime_type VARCHAR(50) NOT NULL,
    created_at BIGINT NOT NULL
  )`;
  console.log("[canvas] Schema ready");
}

// ── Auth helpers ──────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.redirect("/admin/login");
}

// ── Registration ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send(renderRegistration()));

app.post("/register", async (req, res) => {
  try {
    const { first_name, last_name, email } = req.body;
    if (!first_name || !email) return res.redirect("/");
    const sessionId = crypto.randomBytes(16).toString("hex");
    await sql`INSERT INTO canvas_attendees (session_id, first_name, last_name, email, created_at)
      VALUES (${sessionId}, ${first_name.trim()}, ${(last_name || "").trim()}, ${email.trim()}, ${Date.now()})`;
    res.redirect(`/canvas/${sessionId}`);
  } catch (err) {
    console.error("[canvas] /register error:", err.message);
    res.status(500).send(`<pre>Registration error: ${err.message}</pre>`);
  }
});

// ── Canvas experience ─────────────────────────────────────────────────────────
app.get("/canvas/:sessionId", async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM canvas_attendees WHERE session_id = ${req.params.sessionId}`;
    if (!rows.length) return res.redirect("/");
    const attendee = rows[0];
    const stickers = await sql`SELECT id, name, image_data, mime_type FROM canvas_stickers ORDER BY created_at ASC`;
    res.send(renderCanvas(attendee, stickers));
  } catch (err) {
    console.error("[canvas] /canvas error:", err.message);
    res.status(500).send(`<pre>Canvas error: ${err.message}</pre>`);
  }
});

// ── AI Background generation ──────────────────────────────────────────────────
app.post("/canvas/:sessionId/generate", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "Prompt required" });

  const falKey = process.env.FAL_API_KEY;
  if (!falKey) return res.status(500).json({ error: "FAL_API_KEY not configured" });

  try {
    const falRes = await fetch("https://fal.run/fal-ai/flux-pro", {
      method: "POST",
      headers: { "Authorization": `Key ${falKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        image_size: { width: 1024, height: 1024 },
        num_inference_steps: 28,
        guidance_scale: 3.5,
        num_images: 1,
        output_format: "jpeg",
      }),
    });

    if (!falRes.ok) {
      const err = await falRes.text();
      return res.status(500).json({ error: `Flux API error: ${err.slice(0, 200)}` });
    }

    const data = await falRes.json();
    const imageUrl = data.images?.[0]?.url;
    if (!imageUrl) return res.status(500).json({ error: "No image returned from Flux" });

    // Fetch and return as base64 data URL
    const imgRes = await fetch(imageUrl);
    const buffer = await imgRes.arrayBuffer();
    const b64 = Buffer.from(buffer).toString("base64");
    const dataUrl = `data:image/jpeg;base64,${b64}`;
    res.json({ dataUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Save artwork ──────────────────────────────────────────────────────────────
app.post("/canvas/:sessionId/save", async (req, res) => {
  const { png } = req.body; // base64 PNG from html2canvas at 800x800
  if (!png) return res.status(400).json({ error: "No image data" });

  const rows = await sql`SELECT * FROM canvas_attendees WHERE session_id = ${req.params.sessionId}`;
  if (!rows.length) return res.status(404).json({ error: "Session not found" });
  const attendee = rows[0];

  try {
    // Upscale to 3000x3000 for heat transfer print quality using sharp
    const sharp = require("sharp");
    const base64Data = png.replace(/^data:image\/\w+;base64,/, "");
    const inputBuffer = Buffer.from(base64Data, "base64");
    const upscaled = await sharp(inputBuffer)
      .resize(3000, 3000, { kernel: sharp.kernel.lanczos3 })
      .png({ quality: 100 })
      .toBuffer();
    const finalBase64 = upscaled.toString("base64");

    // Delete any previous artwork for this session
    await sql`DELETE FROM canvas_artworks WHERE session_id = ${req.params.sessionId}`;
    await sql`INSERT INTO canvas_artworks (session_id, png_data, created_at)
      VALUES (${req.params.sessionId}, ${finalBase64}, ${Date.now()})`;

    // Generate QR code pointing to download
    const QRCode = require("qrcode");
    const downloadUrl = `${req.protocol}://${req.get("host")}/download/${req.params.sessionId}`;
    const qrDataUrl = await QRCode.toDataURL(downloadUrl, { width: 300, margin: 2 });

    res.json({ qrCode: qrDataUrl, downloadUrl, name: attendee.first_name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Download ──────────────────────────────────────────────────────────────────
app.get("/download/:sessionId", async (req, res) => {
  const rows = await sql`
    SELECT a.png_data, att.first_name, att.last_name
    FROM canvas_artworks a
    JOIN canvas_attendees att ON att.session_id = a.session_id
    WHERE a.session_id = ${req.params.sessionId}
    ORDER BY a.created_at DESC LIMIT 1
  `;
  if (!rows.length) return res.status(404).send("Artwork not found");
  const { png_data, first_name, last_name } = rows[0];
  const buffer = Buffer.from(png_data, "base64");
  const filename = `canvas-${first_name}-${last_name || "art"}.png`.replace(/\s+/g, "-").toLowerCase();
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(buffer);
});

// ── Admin login ───────────────────────────────────────────────────────────────
app.get("/admin/login", adminSession, (req, res) => res.send(renderAdminLogin()));

app.post("/admin/login", adminSession, (req, res) => {
  const { password } = req.body;
  if (password === (process.env.ADMIN_PASSWORD || "canvas")) {
    req.session.admin = true;
    res.redirect("/admin");
  } else {
    res.send(renderAdminLogin("Invalid password"));
  }
});

app.get("/admin/logout", adminSession, (req, res) => {
  req.session = null;
  res.redirect("/admin/login");
});

// ── Admin dashboard ───────────────────────────────────────────────────────────
app.get("/admin", adminSession, requireAdmin, async (req, res) => {
  const stickers = await sql`SELECT * FROM canvas_stickers ORDER BY created_at DESC`;
  const artworks = await sql`
    SELECT a.id, a.session_id, a.png_data, a.created_at, att.first_name, att.last_name, att.email
    FROM canvas_artworks a
    JOIN canvas_attendees att ON att.session_id = a.session_id
    ORDER BY a.created_at DESC
  `;
  res.send(renderAdmin(stickers, artworks));
});

// Sticker upload
app.post("/admin/stickers", adminSession, requireAdmin, async (req, res) => {
  const Busboy = require("busboy");
  const busboy = Busboy({ headers: req.headers, limits: { fileSize: 2 * 1024 * 1024 } });
  let name = "";
  let fileData = null;
  let mimeType = "";

  busboy.on("field", (fieldname, val) => { if (fieldname === "name") name = val.trim(); });
  busboy.on("file", (fieldname, file, info) => {
    mimeType = info.mimeType;
    const chunks = [];
    file.on("data", chunk => chunks.push(chunk));
    file.on("end", () => { fileData = Buffer.concat(chunks).toString("base64"); });
  });
  busboy.on("finish", async () => {
    if (!name || !fileData) return res.redirect("/admin");
    await sql`INSERT INTO canvas_stickers (name, image_data, mime_type, created_at)
      VALUES (${name}, ${fileData}, ${mimeType}, ${Date.now()})`;
    res.redirect("/admin");
  });
  req.pipe(busboy);
});

// Sticker delete
app.post("/admin/stickers/:id/delete", adminSession, requireAdmin, async (req, res) => {
  await sql`DELETE FROM canvas_stickers WHERE id = ${req.params.id}`;
  res.redirect("/admin");
});

// Gallery download all
app.get("/admin/gallery/download", adminSession, requireAdmin, async (req, res) => {
  const archiver = require("archiver");
  const rows = await sql`
    SELECT a.png_data, att.first_name, att.last_name, a.created_at
    FROM canvas_artworks a
    JOIN canvas_attendees att ON att.session_id = a.session_id
    ORDER BY a.created_at DESC
  `;
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", "attachment; filename=\"canvas-artworks.zip\"");
  const archive = archiver("zip");
  archive.pipe(res);
  for (const row of rows) {
    const buffer = Buffer.from(row.png_data, "base64");
    const filename = `${row.first_name}-${row.last_name || "art"}-${row.created_at}.png`.replace(/\s+/g, "-").toLowerCase();
    archive.append(buffer, { name: filename });
  }
  archive.finalize();
});

// ── HTML templates ────────────────────────────────────────────────────────────
function renderRegistration() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Canvas — Create Your Art</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=Playfair+Display:ital,wght@0,700;1,400&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0a0a0f;
    --surface: #111118;
    --border: rgba(255,255,255,0.08);
    --accent: #6366f1;
    --accent-glow: rgba(99,102,241,0.3);
    --text: #f1f5f9;
    --muted: #64748b;
    --input-bg: rgba(255,255,255,0.04);
  }
  html, body { height: 100%; background: var(--bg); color: var(--text); font-family: 'Space Grotesk', sans-serif; }
  body {
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh;
    background-image:
      radial-gradient(ellipse 80% 50% at 50% -20%, rgba(99,102,241,0.15), transparent),
      radial-gradient(ellipse 60% 40% at 80% 80%, rgba(99,102,241,0.08), transparent);
  }
  .card {
    width: 100%; max-width: 480px; padding: 3rem 3.5rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 20px;
    box-shadow: 0 0 80px rgba(99,102,241,0.08), 0 24px 48px rgba(0,0,0,0.4);
    margin: 2rem;
  }
  .eyebrow {
    font-size: 0.7rem; font-weight: 600; letter-spacing: 0.18em;
    text-transform: uppercase; color: var(--accent);
    margin-bottom: 0.75rem;
  }
  h1 {
    font-family: 'Playfair Display', serif;
    font-size: 2.6rem; font-weight: 700; line-height: 1.1;
    margin-bottom: 0.5rem;
  }
  .subtitle { color: var(--muted); font-size: 0.9rem; line-height: 1.5; margin-bottom: 2.5rem; }
  .field { margin-bottom: 1.25rem; }
  label { display: block; font-size: 0.75rem; font-weight: 600; letter-spacing: 0.06em; color: var(--muted); margin-bottom: 0.5rem; text-transform: uppercase; }
  input {
    width: 100%; padding: 0.875rem 1rem;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    color: var(--text); font-family: inherit; font-size: 1rem;
    outline: none; transition: border-color 0.2s, box-shadow 0.2s;
    min-height: 52px;
  }
  input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-glow); }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  .btn {
    width: 100%; padding: 1rem;
    background: var(--accent); color: #fff;
    border: none; border-radius: 10px;
    font-family: inherit; font-size: 1rem; font-weight: 600;
    cursor: pointer; margin-top: 0.5rem;
    transition: background 0.2s, transform 0.1s, box-shadow 0.2s;
    min-height: 52px;
    box-shadow: 0 4px 24px var(--accent-glow);
  }
  .btn:hover { background: #4f46e5; transform: translateY(-1px); box-shadow: 0 8px 32px var(--accent-glow); }
  .btn:active { transform: translateY(0); }
</style>
</head>
<body>
<div class="card">
  <div class="eyebrow">Powered by Intel + Forge</div>
  <h1>Create Your Canvas</h1>
  <p class="subtitle">Design AI-generated artwork with brand stickers. Your creation gets printed on a tee.</p>
  <form method="POST" action="/register">
    <div class="row">
      <div class="field"><label>First Name</label><input name="first_name" required autocomplete="given-name" placeholder="Alex"></div>
      <div class="field"><label>Last Name</label><input name="last_name" autocomplete="family-name" placeholder="Chen"></div>
    </div>
    <div class="field"><label>Email</label><input name="email" type="email" required autocomplete="email" placeholder="alex@company.com"></div>
    <button type="submit" class="btn">Start Creating →</button>
  </form>
</div>
</body>
</html>`;
}

function renderCanvas(attendee, stickers) {
  const stickersJson = JSON.stringify(stickers.map(s => ({
    id: s.id,
    name: s.name,
    src: `data:${s.mime_type};base64,${s.image_data}`,
  })));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Canvas — ${attendee.first_name}'s Art</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"></script>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0a0a0f; --surface: #111118; --panel: #0f0f17;
    --border: rgba(255,255,255,0.07); --accent: #6366f1;
    --accent-glow: rgba(99,102,241,0.25); --text: #f1f5f9; --muted: #475569;
  }
  html, body { height: 100%; background: var(--bg); color: var(--text); font-family: 'Space Grotesk', sans-serif; overflow: hidden; }
  .layout { display: flex; height: 100vh; }

  /* ── Left Panel ── */
  .panel {
    width: 260px; flex-shrink: 0;
    background: var(--panel); border-right: 1px solid var(--border);
    display: flex; flex-direction: column;
    overflow: hidden;
  }
  .panel-header { padding: 1.25rem 1rem 0.75rem; border-bottom: 1px solid var(--border); }
  .panel-name { font-size: 0.65rem; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--accent); margin-bottom: 0.2rem; }
  .panel-title { font-size: 1rem; font-weight: 600; }
  .section { padding: 0.875rem 1rem; border-bottom: 1px solid var(--border); }
  .section-label { font-size: 0.62rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); margin-bottom: 0.6rem; }
  .prompt-input {
    width: 100%; background: rgba(255,255,255,0.04); border: 1px solid var(--border);
    border-radius: 8px; color: var(--text); font-family: inherit; font-size: 0.82rem;
    padding: 0.6rem 0.75rem; resize: none; outline: none; transition: border-color 0.2s;
    min-height: 80px;
  }
  .prompt-input:focus { border-color: var(--accent); }
  .gen-btn {
    width: 100%; margin-top: 0.5rem; padding: 0.65rem;
    background: var(--accent); color: #fff; border: none; border-radius: 8px;
    font-family: inherit; font-size: 0.82rem; font-weight: 600; cursor: pointer;
    transition: background 0.15s; min-height: 40px;
  }
  .gen-btn:hover { background: #4f46e5; }
  .gen-btn:disabled { background: #2d2f5e; color: #475569; cursor: not-allowed; }

  /* Sticker tray */
  .sticker-tray { flex: 1; overflow-y: auto; padding: 0.75rem; display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; align-content: start; }
  .sticker-tray::-webkit-scrollbar { width: 4px; }
  .sticker-tray::-webkit-scrollbar-track { background: transparent; }
  .sticker-tray::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
  .sticker-item {
    aspect-ratio: 1; border-radius: 8px; overflow: hidden; cursor: pointer;
    background: rgba(255,255,255,0.04); border: 1px solid var(--border);
    display: flex; align-items: center; justify-content: center;
    transition: border-color 0.15s, transform 0.1s;
    position: relative;
  }
  .sticker-item:hover { border-color: var(--accent); transform: scale(1.04); }
  .sticker-item img { width: 80%; height: 80%; object-fit: contain; }
  .sticker-item .sticker-name { position: absolute; bottom: 2px; left: 0; right: 0; text-align: center; font-size: 0.58rem; color: var(--muted); padding: 0 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .no-stickers { grid-column: 1/-1; text-align: center; color: var(--muted); font-size: 0.78rem; padding: 1rem; }

  /* ── Canvas Area ── */
  .canvas-area {
    flex: 1; display: flex; align-items: center; justify-content: center;
    position: relative; overflow: hidden;
    background: radial-gradient(ellipse at center, rgba(99,102,241,0.04) 0%, transparent 70%);
  }
  .canvas-wrap {
    position: relative; width: 800px; height: 800px;
    border: 2px solid var(--border);
    border-radius: 4px;
    box-shadow: 0 0 60px rgba(0,0,0,0.5), 0 0 1px rgba(99,102,241,0.2);
    overflow: hidden;
    background: #1a1a2e;
    flex-shrink: 0;
  }
  .canvas-bg {
    position: absolute; inset: 0;
    background-size: cover; background-position: center;
    background-repeat: no-repeat;
    pointer-events: none;
    transition: opacity 0.4s;
  }
  .canvas-bg.loading { opacity: 0.4; }
  .canvas-grid {
    position: absolute; inset: 0;
    background-image: linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px);
    background-size: 40px 40px;
    pointer-events: none;
  }
  .sticker-overlay { position: absolute; inset: 0; overflow: hidden; }
  .sticker-el {
    position: absolute; cursor: move; user-select: none;
    transform-origin: center center;
  }
  .sticker-el img { width: 100%; height: 100%; pointer-events: none; }
  .sticker-el .delete-btn {
    position: absolute; top: -8px; right: -8px;
    width: 22px; height: 22px; border-radius: 50%;
    background: #ef4444; color: #fff; border: none;
    font-size: 12px; cursor: pointer; display: none;
    align-items: center; justify-content: center;
    z-index: 10; line-height: 1;
  }
  .sticker-el:hover .delete-btn,
  .sticker-el.selected .delete-btn { display: flex; }
  .generating-overlay {
    position: absolute; inset: 0; background: rgba(10,10,15,0.7);
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 1rem; display: none;
  }
  .generating-overlay.active { display: flex; }
  .spinner {
    width: 40px; height: 40px; border: 3px solid rgba(255,255,255,0.1);
    border-top-color: var(--accent); border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .gen-label { font-size: 0.85rem; color: #94a3b8; letter-spacing: 0.04em; }

  /* Save button */
  .save-bar {
    position: absolute; bottom: 1.5rem; left: 50%; transform: translateX(-50%);
  }
  .save-btn {
    padding: 0.875rem 2.5rem; background: var(--accent);
    color: #fff; border: none; border-radius: 40px;
    font-family: inherit; font-size: 0.95rem; font-weight: 700;
    cursor: pointer; box-shadow: 0 4px 24px var(--accent-glow);
    transition: all 0.2s; white-space: nowrap; min-height: 50px;
  }
  .save-btn:hover { background: #4f46e5; transform: translateY(-2px); box-shadow: 0 8px 32px var(--accent-glow); }
  .save-btn:disabled { background: #2d2f5e; color: #475569; cursor: not-allowed; transform: none; }

  /* QR screen */
  .qr-screen {
    position: absolute; inset: 0;
    background: rgba(10,10,15,0.96);
    display: none; flex-direction: column;
    align-items: center; justify-content: center; gap: 1.5rem;
    border-radius: 4px;
  }
  .qr-screen.active { display: flex; }
  .qr-title { font-size: 1.4rem; font-weight: 700; text-align: center; }
  .qr-sub { font-size: 0.85rem; color: #94a3b8; text-align: center; }
  .qr-img { border-radius: 12px; background: #fff; padding: 12px; }
  .qr-actions { display: flex; gap: 0.75rem; flex-wrap: wrap; justify-content: center; }
  .qr-btn {
    padding: 0.75rem 1.75rem; border-radius: 40px;
    font-family: inherit; font-size: 0.88rem; font-weight: 600;
    cursor: pointer; border: none; min-height: 46px;
  }
  .qr-btn.primary { background: var(--accent); color: #fff; }
  .qr-btn.secondary { background: rgba(255,255,255,0.08); color: var(--text); }

  /* Mobile */
  @media (max-width: 900px) {
    .layout { flex-direction: column; }
    .panel { width: 100%; height: auto; border-right: none; border-bottom: 1px solid var(--border); }
    .sticker-tray { max-height: 120px; grid-template-columns: repeat(auto-fill, minmax(60px, 1fr)); }
    .canvas-wrap { width: min(90vw, 90vh); height: min(90vw, 90vh); }
    .layout { overflow-y: auto; }
    .canvas-area { min-height: min(90vw, 90vh); padding: 1rem; }
  }
</style>
</head>
<body>
<div class="layout">
  <!-- Left panel -->
  <div class="panel">
    <div class="panel-header">
      <div class="panel-name">${attendee.first_name}'s Canvas</div>
      <div class="panel-title">Create Your Scene</div>
    </div>

    <div class="section">
      <div class="section-label">AI Background</div>
      <textarea class="prompt-input" id="promptInput" placeholder="Describe your scene… e.g. 'futuristic cityscape at night with neon reflections'" rows="3"></textarea>
      <button class="gen-btn" id="genBtn" onclick="generateBackground()">✦ Generate Background</button>
    </div>

    <div class="section" style="flex:1;overflow:hidden;display:flex;flex-direction:column;padding-bottom:0">
      <div class="section-label">Brand Stickers</div>
      <div class="sticker-tray" id="stickerTray">
        ${stickers.length === 0
          ? '<div class="no-stickers">No stickers uploaded yet.<br>Visit /admin to add some.</div>'
          : stickers.map(s => `
            <div class="sticker-item" onclick="addSticker(${s.id})" title="${s.name}">
              <img src="data:${s.mime_type};base64,${s.image_data}" alt="${s.name}" loading="lazy">
              <span class="sticker-name">${s.name}</span>
            </div>`).join("")
        }
      </div>
    </div>
  </div>

  <!-- Canvas -->
  <div class="canvas-area">
    <div class="canvas-wrap" id="canvasWrap">
      <div class="canvas-bg" id="canvasBg"></div>
      <div class="canvas-grid" id="canvasGrid"></div>
      <div class="sticker-overlay" id="stickerOverlay"></div>

      <div class="generating-overlay" id="genOverlay">
        <div class="spinner"></div>
        <div class="gen-label">Generating your scene…</div>
      </div>

      <div class="qr-screen" id="qrScreen">
        <div class="qr-title">Your art is ready, ${attendee.first_name}! 🎨</div>
        <div class="qr-sub">Scan to download your high-res image</div>
        <img class="qr-img" id="qrImg" width="220" height="220" alt="QR Code">
        <div class="qr-actions">
          <a id="downloadLink" class="qr-btn primary" target="_blank">⬇ Download PNG</a>
          <button class="qr-btn secondary" onclick="resetCanvas()">Create Another</button>
        </div>
      </div>
    </div>

    <div class="save-bar">
      <button class="save-btn" id="saveBtn" onclick="saveArtwork()">Save &amp; Get QR Code ✦</button>
    </div>
  </div>
</div>

<script>
const SESSION_ID = "${attendee.session_id}";
const STICKERS = ${stickersJson};
let stickerCounter = 0;
let bgLoaded = false;

// ── Generate background ───────────────────────────────────────────────────────
async function generateBackground() {
  const prompt = document.getElementById("promptInput").value.trim();
  if (!prompt) return;
  const btn = document.getElementById("genBtn");
  const overlay = document.getElementById("genOverlay");
  const bg = document.getElementById("canvasBg");
  const grid = document.getElementById("canvasGrid");

  btn.disabled = true;
  btn.textContent = "Generating…";
  overlay.classList.add("active");
  bg.classList.add("loading");

  try {
    const res = await fetch("/canvas/" + SESSION_ID + "/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const data = await res.json();
    if (data.dataUrl) {
      bg.style.backgroundImage = "url(" + data.dataUrl + ")";
      bg.classList.remove("loading");
      grid.style.display = "none";
      bgLoaded = true;
    } else {
      alert("Generation failed: " + (data.error || "Unknown error"));
    }
  } catch (err) {
    alert("Error: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "✦ Generate Background";
    overlay.classList.remove("active");
  }
}

// ── Stickers ──────────────────────────────────────────────────────────────────
function addSticker(stickerId) {
  const sticker = STICKERS.find(s => s.id === stickerId);
  if (!sticker) return;

  const overlay = document.getElementById("stickerOverlay");
  const wrap = document.getElementById("canvasWrap");
  const wrapRect = wrap.getBoundingClientRect();

  const el = document.createElement("div");
  el.className = "sticker-el";
  el.dataset.id = ++stickerCounter;

  const size = 120;
  const x = (wrapRect.width / 2) - size / 2;
  const y = (wrapRect.height / 2) - size / 2;
  el.style.cssText = "width:" + size + "px;height:" + size + "px;left:" + x + "px;top:" + y + "px;";

  const img = document.createElement("img");
  img.src = sticker.src;
  img.alt = sticker.name;
  el.appendChild(img);

  const del = document.createElement("button");
  del.className = "delete-btn";
  del.innerHTML = "×";
  del.onclick = (e) => { e.stopPropagation(); el.remove(); };
  el.appendChild(del);

  makeDraggable(el, wrap);
  makeResizable(el);
  overlay.appendChild(el);

  // Select it
  document.querySelectorAll(".sticker-el").forEach(s => s.classList.remove("selected"));
  el.classList.add("selected");
}

function makeDraggable(el, container) {
  let startX, startY, startLeft, startTop, isDragging = false;

  const onStart = (clientX, clientY) => {
    isDragging = true;
    startX = clientX; startY = clientY;
    startLeft = parseInt(el.style.left) || 0;
    startTop = parseInt(el.style.top) || 0;
    document.querySelectorAll(".sticker-el").forEach(s => s.classList.remove("selected"));
    el.classList.add("selected");
    el.style.zIndex = ++stickerCounter + 10;
  };

  const onMove = (clientX, clientY) => {
    if (!isDragging) return;
    const dx = clientX - startX;
    const dy = clientY - startY;
    const rect = container.getBoundingClientRect();
    const newLeft = Math.max(0, Math.min(rect.width - el.offsetWidth, startLeft + dx));
    const newTop = Math.max(0, Math.min(rect.height - el.offsetHeight, startTop + dy));
    el.style.left = newLeft + "px";
    el.style.top = newTop + "px";
  };

  const onEnd = () => { isDragging = false; };

  el.addEventListener("mousedown", e => { if (e.target.classList.contains("delete-btn")) return; e.preventDefault(); onStart(e.clientX, e.clientY); });
  document.addEventListener("mousemove", e => onMove(e.clientX, e.clientY));
  document.addEventListener("mouseup", onEnd);

  el.addEventListener("touchstart", e => { if (e.target.classList.contains("delete-btn")) return; e.preventDefault(); onStart(e.touches[0].clientX, e.touches[0].clientY); }, { passive: false });
  document.addEventListener("touchmove", e => { if (isDragging) { e.preventDefault(); onMove(e.touches[0].clientX, e.touches[0].clientY); } }, { passive: false });
  document.addEventListener("touchend", onEnd);
}

function makeResizable(el) {
  el.addEventListener("wheel", e => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -10 : 10;
    const currentW = el.offsetWidth;
    const newW = Math.max(40, Math.min(400, currentW + delta));
    const diff = newW - currentW;
    el.style.width = newW + "px";
    el.style.height = newW + "px";
    el.style.left = (parseInt(el.style.left) - diff/2) + "px";
    el.style.top = (parseInt(el.style.top) - diff/2) + "px";
  }, { passive: false });

  // Pinch to resize
  let lastDist = null;
  el.addEventListener("touchstart", e => { if (e.touches.length === 2) { const dx = e.touches[0].clientX - e.touches[1].clientX; const dy = e.touches[0].clientY - e.touches[1].clientY; lastDist = Math.sqrt(dx*dx+dy*dy); } });
  el.addEventListener("touchmove", e => {
    if (e.touches.length !== 2 || !lastDist) return;
    e.preventDefault();
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const dist = Math.sqrt(dx*dx+dy*dy);
    const scale = dist / lastDist;
    const newW = Math.max(40, Math.min(400, el.offsetWidth * scale));
    el.style.width = newW + "px";
    el.style.height = newW + "px";
    lastDist = dist;
  }, { passive: false });
  el.addEventListener("touchend", () => { lastDist = null; });
}

// Click outside deselects
document.getElementById("canvasWrap").addEventListener("click", e => {
  if (e.target === e.currentTarget || e.target.id === "canvasBg" || e.target.id === "canvasGrid") {
    document.querySelectorAll(".sticker-el").forEach(s => s.classList.remove("selected"));
  }
});

// ── Save & QR ─────────────────────────────────────────────────────────────────
async function saveArtwork() {
  const btn = document.getElementById("saveBtn");
  btn.disabled = true;
  btn.textContent = "Saving…";

  // Hide delete buttons before capture
  document.querySelectorAll(".delete-btn").forEach(b => b.style.display = "none");
  document.querySelectorAll(".sticker-el").forEach(s => s.classList.remove("selected"));

  try {
    const wrap = document.getElementById("canvasWrap");
    const canvas = await html2canvas(wrap, {
      width: 800, height: 800,
      scale: 1,
      useCORS: true,
      allowTaint: true,
      backgroundColor: "#1a1a2e",
      ignoreElements: el => el.classList.contains("generating-overlay") || el.classList.contains("qr-screen"),
    });

    const png = canvas.toDataURL("image/png");
    const res = await fetch("/canvas/" + SESSION_ID + "/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ png }),
    });
    const data = await res.json();

    if (data.qrCode) {
      document.getElementById("qrImg").src = data.qrCode;
      document.getElementById("downloadLink").href = data.downloadUrl;
      document.getElementById("qrScreen").classList.add("active");
    } else {
      alert("Save failed: " + (data.error || "Unknown error"));
    }
  } catch (err) {
    alert("Error: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Save & Get QR Code ✦";
    document.querySelectorAll(".delete-btn").forEach(b => b.style.display = "");
  }
}

function resetCanvas() {
  window.location.href = "/";
}

// ── Inactivity timer — reset to registration after 2 minutes ─────────────────
let inactivityTimer;
const INACTIVITY_MS = 2 * 60 * 1000;

function resetInactivityTimer() {
  clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(() => {
    window.location.href = "/";
  }, INACTIVITY_MS);
}

// Reset timer on any user interaction
["mousemove", "mousedown", "touchstart", "touchmove", "keydown", "wheel"].forEach(evt => {
  document.addEventListener(evt, resetInactivityTimer, { passive: true });
});

// Start the timer on load
resetInactivityTimer();
</script>
</body>
</html>`;
}

function renderAdmin(stickers, artworks) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Canvas Admin</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root { --bg: #0a0a0f; --surface: #111118; --border: rgba(255,255,255,0.08); --accent: #6366f1; --text: #f1f5f9; --muted: #64748b; }
  body { background: var(--bg); color: var(--text); font-family: system-ui, sans-serif; min-height: 100vh; }
  .header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 1rem 2rem; display: flex; align-items: center; justify-content: space-between; }
  .header h1 { font-size: 1.1rem; font-weight: 700; }
  .header-right { display: flex; align-items: center; gap: 1rem; }
  .badge { background: rgba(99,102,241,0.15); color: #818cf8; border-radius: 20px; padding: 0.2rem 0.75rem; font-size: 0.75rem; font-weight: 600; }
  a.logout { color: var(--muted); font-size: 0.82rem; text-decoration: none; }
  a.logout:hover { color: var(--text); }
  .tabs { display: flex; gap: 0; border-bottom: 1px solid var(--border); padding: 0 2rem; background: var(--surface); }
  .tab { padding: 0.75rem 1.25rem; cursor: pointer; font-size: 0.85rem; font-weight: 500; color: var(--muted); border-bottom: 2px solid transparent; transition: color 0.15s, border-color 0.15s; }
  .tab.active { color: var(--text); border-bottom-color: var(--accent); }
  .content { padding: 2rem; max-width: 1100px; }
  .panel { display: none; }
  .panel.active { display: block; }
  .section-title { font-size: 0.7rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); margin-bottom: 1rem; }
  .upload-form { display: flex; gap: 0.75rem; align-items: flex-end; flex-wrap: wrap; margin-bottom: 1.5rem; padding: 1.25rem; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
  .form-field { display: flex; flex-direction: column; gap: 0.4rem; }
  .form-field label { font-size: 0.72rem; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }
  input[type=text], input[type=file] { background: rgba(255,255,255,0.05); border: 1px solid var(--border); border-radius: 7px; color: var(--text); font-family: inherit; font-size: 0.85rem; padding: 0.55rem 0.75rem; outline: none; min-width: 180px; }
  input[type=text]:focus { border-color: var(--accent); }
  .btn { padding: 0.6rem 1.25rem; background: var(--accent); color: #fff; border: none; border-radius: 7px; font-family: inherit; font-size: 0.85rem; font-weight: 600; cursor: pointer; transition: background 0.15s; white-space: nowrap; }
  .btn:hover { background: #4f46e5; }
  .btn.danger { background: rgba(239,68,68,0.15); color: #f87171; border: 1px solid rgba(239,68,68,0.2); }
  .btn.danger:hover { background: rgba(239,68,68,0.25); }
  .btn.secondary { background: rgba(255,255,255,0.06); color: var(--text); }
  .btn.secondary:hover { background: rgba(255,255,255,0.1); }
  .sticker-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 1rem; }
  .sticker-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 0.75rem; text-align: center; }
  .sticker-card img { width: 80px; height: 80px; object-fit: contain; margin-bottom: 0.5rem; }
  .sticker-card .name { font-size: 0.78rem; font-weight: 500; margin-bottom: 0.5rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .artwork-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1.25rem; }
  .artwork-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .artwork-thumb { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; }
  .artwork-info { padding: 0.75rem; }
  .artwork-name { font-size: 0.85rem; font-weight: 600; }
  .artwork-meta { font-size: 0.72rem; color: var(--muted); margin-top: 0.2rem; }
  .artwork-actions { display: flex; gap: 0.4rem; margin-top: 0.6rem; }
  .stat { font-size: 0.82rem; color: var(--muted); margin-bottom: 1.5rem; }
  .stat strong { color: var(--text); }
</style>
</head>
<body>
<div class="header">
  <h1>Canvas Admin</h1>
  <div class="header-right">
    <span class="badge">${artworks.length} artworks</span>
    <a href="/admin/logout" class="logout">Sign out</a>
  </div>
</div>
<div class="tabs">
  <div class="tab active" onclick="showTab('stickers',this)">Stickers</div>
  <div class="tab" onclick="showTab('gallery',this)">Gallery</div>
</div>
<div class="content">
  <div class="panel active" id="tab-stickers">
    <div class="section-title">Upload Sticker</div>
    <form class="upload-form" method="POST" action="/admin/stickers" enctype="multipart/form-data">
      <div class="form-field"><label>Name</label><input type="text" name="name" placeholder="e.g. Intel Logo" required></div>
      <div class="form-field"><label>File (PNG/SVG/GIF, max 2MB)</label><input type="file" name="sticker" accept="image/png,image/svg+xml,image/gif" required></div>
      <button type="submit" class="btn">Upload Sticker</button>
    </form>
    <div class="section-title">${stickers.length} Sticker${stickers.length !== 1 ? "s" : ""}</div>
    <div class="sticker-grid">
      ${stickers.map(s => `
        <div class="sticker-card">
          <img src="data:${s.mime_type};base64,${s.image_data}" alt="${s.name}">
          <div class="name">${s.name}</div>
          <form method="POST" action="/admin/stickers/${s.id}/delete" onsubmit="return confirm('Delete ${s.name}?')">
            <button type="submit" class="btn danger" style="width:100%;font-size:0.75rem;padding:0.4rem">Delete</button>
          </form>
        </div>`).join("") || "<p style='color:var(--muted);font-size:0.85rem'>No stickers yet.</p>"}
    </div>
  </div>

  <div class="panel" id="tab-gallery">
    <div class="stat"><strong>${artworks.length}</strong> artworks saved · <a href="/admin/gallery/download" class="btn secondary" style="display:inline-flex;margin-left:0.75rem;font-size:0.8rem;padding:0.4rem 1rem">⬇ Download All</a></div>
    <div class="artwork-grid">
      ${artworks.map(a => `
        <div class="artwork-card">
          <img class="artwork-thumb" src="data:image/png;base64,${a.png_data.slice(0, 200)}..." alt="${a.first_name}'s art" onerror="this.style.display='none'">
          <div style="background:#1a1a2e;aspect-ratio:1;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:0.75rem" id="thumb-${a.id}">Preview</div>
          <div class="artwork-info">
            <div class="artwork-name">${a.first_name} ${a.last_name || ""}</div>
            <div class="artwork-meta">${a.email} · ${new Date(Number(a.created_at)).toLocaleDateString()}</div>
            <div class="artwork-actions">
              <a href="/download/${a.session_id}" class="btn" style="font-size:0.75rem;padding:0.4rem 0.75rem;text-decoration:none">Download</a>
            </div>
          </div>
        </div>`).join("") || "<p style='color:var(--muted);font-size:0.85rem'>No artworks yet.</p>"}
    </div>
  </div>
</div>
<script>
// Load actual thumbnails after render
document.querySelectorAll(".artwork-card").forEach((card, i) => {
  const img = card.querySelector(".artwork-thumb");
  const placeholder = card.querySelector("[id^='thumb-']");
  if (img && img.src.includes("...")) {
    img.style.display = "none";
    if (placeholder) placeholder.style.display = "flex";
  }
});

function showTab(name, el) {
  document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  document.getElementById("tab-" + name).classList.add("active");
  el.classList.add("active");
}
</script>
</body>
</html>`;
}

function renderAdminLogin(error) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Canvas Admin Login</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0a0a0f; display: flex; align-items: center; justify-content: center; min-height: 100vh; font-family: system-ui, sans-serif; color: #f1f5f9; }
  .card { background: #111118; border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; padding: 2.5rem; width: 100%; max-width: 360px; }
  h1 { font-size: 1.25rem; font-weight: 700; margin-bottom: 1.5rem; }
  label { display: block; font-size: 0.72rem; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 0.4rem; }
  input { width: 100%; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; color: #f1f5f9; font-family: inherit; font-size: 0.95rem; padding: 0.75rem; outline: none; margin-bottom: 1rem; }
  input:focus { border-color: #6366f1; }
  button { width: 100%; padding: 0.875rem; background: #6366f1; color: #fff; border: none; border-radius: 8px; font-family: inherit; font-size: 0.95rem; font-weight: 600; cursor: pointer; }
  button:hover { background: #4f46e5; }
  .error { color: #f87171; font-size: 0.82rem; margin-bottom: 1rem; }
</style>
</head>
<body>
<div class="card">
  <h1>Canvas Admin</h1>
  ${error ? `<div class="error">${error}</div>` : ""}
  <form method="POST" action="/admin/login">
    <label>Password</label>
    <input type="password" name="password" autofocus>
    <button type="submit">Sign In</button>
  </form>
</div>
</body>
</html>`;
}

// ── Global error handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("[canvas] Unhandled error:", err.message, err.stack);
  res.status(500).send(`<pre>Server error: ${err.message}</pre>`);
});

// ── Start ─────────────────────────────────────────────────────────────────────
ensureSchema().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[canvas] Running on port ${PORT}`);
  });
}).catch(err => {
  console.error("[canvas] Startup failed:", err.message);
  process.exit(1);
});
