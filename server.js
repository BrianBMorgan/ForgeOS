const express = require('express');
const multer = require('multer');
const axios = require('axios');
const cheerio = require('cheerio');
const FormData = require('form-data');
const { neon } = require('@neondatabase/serverless');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
    cb(null, allowed.includes(file.mimetype));
  }
});

let sql = null;

async function initDb() {
  if (!process.env.NEON_DATABASE_URL) {
    console.log('NEON_DATABASE_URL not set — skipping DB init');
    return;
  }
  try {
    sql = neon(process.env.NEON_DATABASE_URL);
    await sql`CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      user_email TEXT NOT NULL,
      prompt TEXT NOT NULL,
      output TEXT NOT NULL,
      format TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )`;
    console.log('DB initialized');
  } catch (err) {
    console.error('DB init error:', err.message);
    sql = null;
  }
}

initDb();

// ─── HELPERS (defined before routes so they are available when routes execute) ───

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function buildSystemPrompt(format) {
  var base = 'You are an expert AI Art Director with deep knowledge of visual design, brand identity, photography, illustration, typography, color theory, and creative direction.';
  var formats = {
    concepts: base + ' Generate 3 distinct creative concepts. For each concept provide: CONCEPT NAME, VISUAL DIRECTION, COLOR PALETTE, MOOD, KEY REFERENCES. Format clearly with headers.',
    moodboard: base + ' Create a detailed moodboard brief. Include: OVERALL THEME, COLOR STORY, TEXTURE & MATERIAL, LIGHTING DIRECTION, TYPOGRAPHY FEEL, IMAGE PROMPT: [detailed image generation prompt 1], IMAGE PROMPT: [detailed image generation prompt 2], IMAGE PROMPT: [detailed image generation prompt 3]. Each IMAGE PROMPT: line should be a complete standalone prompt for an image generator.',
    styleguide: base + ' Produce a comprehensive style guide including: BRAND VOICE, COLOR PALETTE (with hex codes), TYPOGRAPHY SYSTEM, IMAGERY STYLE, DO\'S AND DON\'TS, USAGE EXAMPLES.',
    copywriting: base + ' Write creative copy directions including: HEADLINE OPTIONS (5 variations), TAGLINE OPTIONS (3 variations), BODY COPY TONE, KEY MESSAGES, CALL TO ACTION EXAMPLES.',
    campaign: base + ' Develop a full campaign concept including: CAMPAIGN THEME, TARGET AUDIENCE, KEY CHANNELS, HERO VISUAL CONCEPT, SUPPORTING ASSETS LIST, MESSAGING HIERARCHY.',
    technical: base + ' Provide technical art direction specifications including: FILE FORMATS, RESOLUTION REQUIREMENTS, COLOR SPACE, TYPOGRAPHY SPECS, GRID SYSTEM, COMPONENT BREAKDOWN.'
  };
  return formats[format] || formats.concepts;
}

async function scrapeUrl(url) {
  try {
    var response = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ArtDirectorBot/1.0)' }
    });
    var $ = cheerio.load(response.data);
    $('script, style, nav, footer').remove();
    var title = $('title').text().trim();
    var description = $('meta[name="description"]').attr('content') || '';
    var bodyText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 2000);
    return { title: title, description: description, bodyText: bodyText };
  } catch (err) {
    return { error: err.message };
  }
}

async function generateMoodboardImages(moodboardText) {
  var stabilityApiKey = process.env.STABILITYAI_API_KEY;
  if (!stabilityApiKey) {
    console.log('STABILITYAI_API_KEY not set — skipping image generation');
    return [];
  }

  var promptMatches = moodboardText.match(/IMAGE PROMPT:\s*([^\n]+)/gi) || [];
  var prompts = promptMatches.map(function(p) { return p.replace(/IMAGE PROMPT:\s*/i, '').trim(); }).slice(0, 3);

  if (prompts.length === 0) return [];

  var images = [];
  for (var i = 0; i < prompts.length; i++) {
    var prompt = prompts[i];
    try {
      var formData = new FormData();
      formData.append('prompt', prompt);
      formData.append('output_format', 'jpeg');

      var response = await axios.post(
        'https://api.stability.ai/v2beta/stable-image/generate/core',
        formData,
        {
          headers: Object.assign({}, formData.getHeaders(), {
            Authorization: 'Bearer ' + stabilityApiKey,
            Accept: 'image/*'
          }),
          responseType: 'arraybuffer',
          timeout: 20000
        }
      );

      var base64 = Buffer.from(response.data).toString('base64');
      images.push({ prompt: prompt, base64: base64, mimeType: 'image/jpeg' });
    } catch (err) {
      console.error('Image generation error for prompt:', prompt, err.message);
    }
  }
  return images;
}

// ─── ROUTES ────────────────────────────────────────────────────────────────

app.post('/api/auth', function(req, res) {
  var email = req.body && req.body.email ? req.body.email : '';
  if (!email || !validateEmail(email)) {
    return res.status(400).json({ success: false, error: 'Valid email required' });
  }
  return res.json({ success: true, email: email });
});

app.post('/api/generate', upload.array('files', 10), async (req, res) => {
  try {
    var client = new Anthropic();
    var prompt = req.body.prompt;
    var format = req.body.format;
    var urls = req.body.urls;
    var userEmail = req.body.userEmail;

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    var outputFormat = format || 'concepts';
    var systemPrompt = buildSystemPrompt(outputFormat);
    var contentParts = [];

    contentParts.push({ type: 'text', text: prompt.trim() });

    if (urls) {
      var urlList = Array.isArray(urls) ? urls : [urls];
      for (var i = 0; i < urlList.length; i++) {
        var url = urlList[i];
        if (url && url.trim()) {
          var scraped = await scrapeUrl(url.trim());
          if (!scraped.error) {
            contentParts.push({
              type: 'text',
              text: 'REFERENCE URL: ' + url + '\nTitle: ' + scraped.title + '\nDescription: ' + scraped.description + '\nContent: ' + scraped.bodyText
            });
          }
        }
      }
    }

    if (req.files && req.files.length > 0) {
      for (var j = 0; j < req.files.length; j++) {
        var file = req.files[j];
        if (file.mimetype.startsWith('image/')) {
          var base64 = file.buffer.toString('base64');
          contentParts.push({
            type: 'image',
            source: { type: 'base64', media_type: file.mimetype, data: base64 }
          });
        }
      }
    }

    var response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: contentParts }]
    });

    var outputText = response.content[0].text;
    var images = [];

    if (outputFormat === 'moodboard') {
      images = await generateMoodboardImages(outputText);
    }

    res.json({ success: true, output: outputText, format: outputFormat, images: images });
  } catch (err) {
    console.error('Generate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/save', async (req, res) => {
  if (!sql) {
    return res.status(503).json({ error: 'Database not available' });
  }
  var userEmail = req.body.userEmail;
  var prompt = req.body.prompt;
  var output = req.body.output;
  var format = req.body.format;
  if (!userEmail || !prompt || !output || !format) {
    return res.status(400).json({ error: 'userEmail, prompt, output, and format are required' });
  }
  if (!validateEmail(userEmail)) {
    return res.status(400).json({ error: 'Invalid email' });
  }
  try {
    var createdAt = Date.now();
    var result = await sql`
      INSERT INTO conversations (user_email, prompt, output, format, created_at)
      VALUES (${userEmail}, ${prompt}, ${output}, ${format}, ${createdAt})
      RETURNING id, user_email, prompt, output, format, created_at
    `;
    res.json({ success: true, conversation: result[0] });
  } catch (err) {
    console.error('Save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/history', async (req, res) => {
  if (!sql) {
    return res.status(503).json({ error: 'Database not available' });
  }
  var userEmail = req.query.userEmail;
  if (!userEmail || !validateEmail(userEmail)) {
    return res.status(400).json({ error: 'Valid userEmail query param required' });
  }
  try {
    var rows = await sql`
      SELECT id, user_email, prompt, output, format, created_at
      FROM conversations
      WHERE user_email = ${userEmail}
      ORDER BY created_at DESC
      LIMIT 50
    `;
    res.json({ success: true, conversations: rows });
  } catch (err) {
    console.error('History error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/delete/:id', async (req, res) => {
  if (!sql) {
    return res.status(503).json({ error: 'Database not available' });
  }
  var id = req.params.id;
  var userEmail = req.body.userEmail;
  if (!userEmail || !validateEmail(userEmail)) {
    return res.status(400).json({ error: 'Valid userEmail required in request body' });
  }
  var convId = parseInt(id, 10);
  if (isNaN(convId)) {
    return res.status(400).json({ error: 'Invalid conversation id' });
  }
  try {
    var result = await sql`
      DELETE FROM conversations
      WHERE id = ${convId} AND user_email = ${userEmail}
      RETURNING id
    `;
    if (result.length === 0) {
      return res.status(404).json({ error: 'Conversation not found or not owned by user' });
    }
    res.json({ success: true, deletedId: convId });
  } catch (err) {
    console.error('Delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  var html = '<!DOCTYPE html>\n' +
'<html lang="en">\n' +
'<head>\n' +
'<meta charset="UTF-8">\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'<title>AI Art Director Companion</title>\n' +
'<style>\n' +
'  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }\n' +
'  :root {\n' +
'    --bg: #0d0d0f;\n' +
'    --surface: #16161a;\n' +
'    --surface2: #1e1e24;\n' +
'    --border: #2a2a35;\n' +
'    --accent: #7c6af7;\n' +
'    --accent2: #a78bfa;\n' +
'    --text: #e8e8f0;\n' +
'    --muted: #888899;\n' +
'    --danger: #ef4444;\n' +
'    --success: #22c55e;\n' +
'  }\n' +
'  body { background: var(--bg); color: var(--text); font-family: system-ui, -apple-system, sans-serif; min-height: 100vh; }\n' +
'\n' +
'  #auth-gate {\n' +
'    position: fixed; inset: 0; background: var(--bg);\n' +
'    display: flex; align-items: center; justify-content: center; z-index: 100;\n' +
'  }\n' +
'  #auth-gate.hidden { display: none; }\n' +
'  .auth-card {\n' +
'    background: var(--surface); border: 1px solid var(--border); border-radius: 16px;\n' +
'    padding: 48px 40px; width: 100%; max-width: 420px; text-align: center;\n' +
'  }\n' +
'  .auth-card h1 { font-size: 1.6rem; margin-bottom: 8px; background: linear-gradient(135deg, var(--accent), var(--accent2)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }\n' +
'  .auth-card p { color: var(--muted); margin-bottom: 32px; font-size: 0.9rem; }\n' +
'  .auth-card input {\n' +
'    width: 100%; padding: 12px 16px; background: var(--surface2); border: 1px solid var(--border);\n' +
'    border-radius: 8px; color: var(--text); font-size: 1rem; margin-bottom: 12px;\n' +
'  }\n' +
'  .auth-card input:focus { outline: none; border-color: var(--accent); }\n' +
'  .auth-card button {\n' +
'    width: 100%; padding: 12px; background: var(--accent); border: none; border-radius: 8px;\n' +
'    color: #fff; font-size: 1rem; font-weight: 600; cursor: pointer;\n' +
'  }\n' +
'  .auth-card button:hover { background: var(--accent2); }\n' +
'  .auth-error { color: var(--danger); font-size: 0.85rem; margin-top: 8px; }\n' +
'\n' +
'  #app { display: none; flex-direction: column; height: 100vh; overflow: hidden; }\n' +
'  #app.visible { display: flex; }\n' +
'\n' +
'  header {\n' +
'    background: var(--surface); border-bottom: 1px solid var(--border);\n' +
'    padding: 14px 24px; display: flex; align-items: center; justify-content: space-between;\n' +
'    flex-shrink: 0;\n' +
'  }\n' +
'  header h1 { font-size: 1.1rem; font-weight: 700; background: linear-gradient(135deg, var(--accent), var(--accent2)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }\n' +
'  .user-pill {\n' +
'    background: var(--surface2); border: 1px solid var(--border); border-radius: 20px;\n' +
'    padding: 6px 14px; font-size: 0.8rem; color: var(--muted); display: flex; align-items: center; gap: 8px;\n' +
'  }\n' +
'  .user-pill button { background: none; border: none; color: var(--danger); cursor: pointer; font-size: 0.75rem; }\n' +
'\n' +
'  .main-layout { display: flex; flex: 1; overflow: hidden; }\n' +
'\n' +
'  #sidebar {\n' +
'    width: 280px; min-width: 280px; background: var(--surface); border-right: 1px solid var(--border);\n' +
'    display: flex; flex-direction: column; overflow: hidden;\n' +
'  }\n' +
'  .sidebar-header {\n' +
'    padding: 14px 16px; border-bottom: 1px solid var(--border);\n' +
'    display: flex; align-items: center; justify-content: space-between; flex-shrink: 0;\n' +
'  }\n' +
'  .sidebar-header span { font-size: 0.8rem; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }\n' +
'  .sidebar-refresh {\n' +
'    background: none; border: 1px solid var(--border); border-radius: 6px;\n' +
'    color: var(--muted); cursor: pointer; font-size: 0.72rem; padding: 4px 8px;\n' +
'  }\n' +
'  .sidebar-refresh:hover { color: var(--text); border-color: var(--accent); }\n' +
'  #history-list { flex: 1; overflow-y: auto; padding: 8px; }\n' +
'  #history-list::-webkit-scrollbar { width: 4px; }\n' +
'  #history-list::-webkit-scrollbar-track { background: transparent; }\n' +
'  #history-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }\n' +
'  .history-item {\n' +
'    background: var(--surface2); border: 1px solid var(--border); border-radius: 8px;\n' +
'    padding: 10px 12px; margin-bottom: 6px;\n' +
'    display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;\n' +
'    transition: border-color 0.15s;\n' +
'  }\n' +
'  .history-item:hover { border-color: var(--accent); }\n' +
'  .history-item-content { flex: 1; min-width: 0; cursor: pointer; }\n' +
'  .history-item-prompt {\n' +
'    font-size: 0.8rem; color: var(--text);\n' +
'    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;\n' +
'  }\n' +
'  .history-item-meta { font-size: 0.7rem; color: var(--muted); margin-top: 3px; }\n' +
'  .history-delete {\n' +
'    background: none; border: none; color: var(--border); cursor: pointer;\n' +
'    font-size: 0.85rem; padding: 2px 5px; border-radius: 4px; flex-shrink: 0;\n' +
'    line-height: 1; transition: color 0.15s;\n' +
'  }\n' +
'  .history-delete:hover { color: var(--danger); }\n' +
'  .history-empty { color: var(--muted); font-size: 0.8rem; text-align: center; padding: 32px 16px; line-height: 1.6; }\n' +
'\n' +
'  #main-content { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; }\n' +
'\n' +
'  .form-area {\n' +
'    padding: 20px 24px; border-bottom: 1px solid var(--border); background: var(--surface); flex-shrink: 0;\n' +
'  }\n' +
'  .form-row { display: flex; gap: 10px; margin-bottom: 10px; }\n' +
'  .form-row select, .form-row input[type=text] {\n' +
'    background: var(--surface2); border: 1px solid var(--border); border-radius: 8px;\n' +
'    color: var(--text); padding: 9px 13px; font-size: 0.88rem;\n' +
'  }\n' +
'  .form-row select { flex: 0 0 170px; }\n' +
'  .form-row input[type=text] { flex: 1; }\n' +
'  .form-row select:focus, .form-row input[type=text]:focus { outline: none; border-color: var(--accent); }\n' +
'  textarea {\n' +
'    width: 100%; background: var(--surface2); border: 1px solid var(--border); border-radius: 8px;\n' +
'    color: var(--text); padding: 11px 13px; font-size: 0.88rem; resize: vertical; min-height: 90px;\n' +
'    font-family: inherit; margin-bottom: 10px;\n' +
'  }\n' +
'  textarea:focus { outline: none; border-color: var(--accent); }\n' +
'  .form-actions { display: flex; gap: 10px; align-items: center; }\n' +
'  .form-actions label {\n' +
'    background: var(--surface2); border: 1px solid var(--border); border-radius: 8px;\n' +
'    padding: 9px 14px; cursor: pointer; font-size: 0.82rem; color: var(--muted);\n' +
'  }\n' +
'  .form-actions label:hover { border-color: var(--accent); color: var(--text); }\n' +
'  .form-actions input[type=file] { display: none; }\n' +
'  #file-count { font-size: 0.78rem; color: var(--muted); }\n' +
'  .btn-generate {\n' +
'    margin-left: auto; background: var(--accent); border: none; border-radius: 8px;\n' +
'    color: #fff; font-size: 0.92rem; font-weight: 600; padding: 9px 26px; cursor: pointer;\n' +
'    transition: background 0.15s;\n' +
'  }\n' +
'  .btn-generate:hover { background: var(--accent2); }\n' +
'  .btn-generate:disabled { opacity: 0.5; cursor: not-allowed; }\n' +
'  .form-error {\n' +
'    color: var(--danger); font-size: 0.82rem; padding: 9px 13px; margin-top: 10px;\n' +
'    background: rgba(239,68,68,0.08); border-radius: 8px; border: 1px solid rgba(239,68,68,0.25);\n' +
'  }\n' +
'\n' +
'  #output-area { flex: 1; overflow-y: auto; padding: 20px 24px; display: flex; flex-direction: column; gap: 14px; }\n' +
'  #output-area::-webkit-scrollbar { width: 5px; }\n' +
'  #output-area::-webkit-scrollbar-track { background: transparent; }\n' +
'  #output-area::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }\n' +
'\n' +
'  .output-card {\n' +
'    background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden;\n' +
'    animation: fadeIn 0.25s ease;\n' +
'  }\n' +
'  @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }\n' +
'  .card-header {\n' +
'    padding: 12px 16px; display: flex; align-items: center; justify-content: space-between;\n' +
'    cursor: pointer; user-select: none; background: var(--surface2);\n' +
'    transition: background 0.15s;\n' +
'  }\n' +
'  .card-header:hover { background: var(--border); }\n' +
'  .card-title-wrap { min-width: 0; flex: 1; }\n' +
'  .card-title { font-size: 0.85rem; font-weight: 600; color: var(--accent2); }\n' +
'  .card-meta { font-size: 0.72rem; color: var(--muted); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n' +
'  .card-actions { display: flex; gap: 7px; align-items: center; flex-shrink: 0; margin-left: 12px; }\n' +
'  .btn-copy {\n' +
'    background: var(--surface); border: 1px solid var(--border); border-radius: 6px;\n' +
'    color: var(--muted); cursor: pointer; font-size: 0.72rem; padding: 4px 9px;\n' +
'    transition: color 0.15s, border-color 0.15s;\n' +
'  }\n' +
'  .btn-copy:hover { color: var(--text); border-color: var(--accent); }\n' +
'  .btn-save {\n' +
'    background: var(--surface); border: 1px solid var(--success); border-radius: 6px;\n' +
'    color: var(--success); cursor: pointer; font-size: 0.72rem; padding: 4px 9px;\n' +
'    transition: background 0.15s, color 0.15s;\n' +
'  }\n' +
'  .btn-save:hover { background: var(--success); color: #fff; }\n' +
'  .btn-save:disabled { opacity: 0.6; cursor: not-allowed; }\n' +
'  .chevron { color: var(--muted); font-size: 0.75rem; transition: transform 0.2s; margin-left: 4px; }\n' +
'  .chevron.collapsed { transform: rotate(-90deg); }\n' +
'  .card-body { padding: 16px 18px; }\n' +
'  .card-body.collapsed { display: none; }\n' +
'  .card-text { white-space: pre-wrap; font-size: 0.86rem; line-height: 1.75; color: var(--text); font-family: inherit; }\n' +
'  .card-images { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; margin-top: 14px; }\n' +
'  .card-images img { width: 100%; border-radius: 8px; border: 1px solid var(--border); display: block; }\n' +
'\n' +
'  .loading-indicator {\n' +
'    display: flex; align-items: center; gap: 12px; padding: 18px;\n' +
'    color: var(--muted); font-size: 0.88rem;\n' +
'    background: var(--surface); border: 1px solid var(--border); border-radius: 12px;\n' +
'  }\n' +
'  .spinner {\n' +
'    width: 18px; height: 18px; border: 2px solid var(--border);\n' +
'    border-top-color: var(--accent); border-radius: 50%; animation: spin 0.7s linear infinite; flex-shrink: 0;\n' +
'  }\n' +
'  @keyframes spin { to { transform: rotate(360deg); } }\n' +
'</style>\n' +
'</head>\n' +
'<body>\n' +
'\n' +
'<div id="auth-gate">\n' +
'  <div class="auth-card">\n' +
'    <h1>AI Art Director</h1>\n' +
'    <p>Enter your email to continue</p>\n' +
'    <input type="email" id="auth-email" placeholder="you@example.com" />\n' +
'    <button id="auth-btn" onclick="doAuth()">Continue</button>\n' +
'    <div class="auth-error" id="auth-error"></div>\n' +
'  </div>\n' +
'</div>\n' +
'\n' +
'<div id="app">\n' +
'  <header>\n' +
'    <h1>AI Art Director Companion</h1>\n' +
'    <div class="user-pill">\n' +
'      <span id="header-email"></span>\n' +
'      <button onclick="doLogout()">Sign out</button>\n' +
'    </div>\n' +
'  </header>\n' +
'\n' +
'  <div class="main-layout">\n' +
'    <div id="sidebar">\n' +
'      <div class="sidebar-header">\n' +
'        <span>History</span>\n' +
'        <button class="sidebar-refresh" onclick="loadHistory()">Refresh</button>\n' +
'      </div>\n' +
'      <div id="history-list"><div class="history-empty">No saved history yet</div></div>\n' +
'    </div>\n' +
'\n' +
'    <div id="main-content">\n' +
'      <div class="form-area">\n' +
'        <div class="form-row">\n' +
'          <select id="format-select">\n' +
'            <option value="concepts">Creative Concepts</option>\n' +
'            <option value="moodboard">Moodboard</option>\n' +
'            <option value="styleguide">Style Guide</option>\n' +
'            <option value="copywriting">Copywriting</option>\n' +
'            <option value="campaign">Campaign</option>\n' +
'            <option value="technical">Technical Specs</option>\n' +
'          </select>\n' +
'          <input type="text" id="url-input" placeholder="Reference URL (optional)" />\n' +
'        </div>\n' +
'        <textarea id="prompt-input" placeholder="Describe your creative brief, project, or direction..."></textarea>\n' +
'        <div class="form-actions">\n' +
'          <label>\n' +
'            Upload Files\n' +
'            <input type="file" id="file-input" multiple accept="image/*" onchange="updateFileCount()" />\n' +
'          </label>\n' +
'          <span id="file-count"></span>\n' +
'          <button class="btn-generate" id="gen-btn" onclick="doGenerate()">Generate</button>\n' +
'        </div>\n' +
'        <div id="form-error" class="form-error" hidden></div>\n' +
'      </div>\n' +
'      <div id="output-area"></div>\n' +
'    </div>\n' +
'  </div>\n' +
'</div>\n' +
'\n' +
'<script>\n' +
'(function() {\n' +
'  var currentUser = null;\n' +
'\n' +
'  function init() {\n' +
'    var stored = localStorage.getItem(\'artdirector_email\');\n' +
'    if (stored) {\n' +
'      currentUser = stored;\n' +
'      showApp();\n' +
'    }\n' +
'  }\n' +
'\n' +
'  function showApp() {\n' +
'    document.getElementById(\'auth-gate\').classList.add(\'hidden\');\n' +
'    document.getElementById(\'app\').classList.add(\'visible\');\n' +
'    document.getElementById(\'header-email\').textContent = currentUser;\n' +
'    loadHistory();\n' +
'  }\n' +
'\n' +
'  window.doAuth = function() {\n' +
'    var email = document.getElementById(\'auth-email\').value.trim();\n' +
'    var errEl = document.getElementById(\'auth-error\');\n' +
'    errEl.textContent = \'\';\n' +
'    if (!email) { errEl.textContent = \'Email required\'; return; }\n' +
'\n' +
'    var btn = document.getElementById(\'auth-btn\');\n' +
'    btn.disabled = true;\n' +
'    btn.textContent = \'Checking...\';\n' +
'\n' +
'    fetch(\'/api/auth\', {\n' +
'      method: \'POST\',\n' +
'      headers: { \'Content-Type\': \'application/json\' },\n' +
'      body: JSON.stringify({ email: email })\n' +
'    })\n' +
'    .then(function(res) { return res.json().then(function(data) { return { ok: res.ok, data: data }; }); })\n' +
'    .then(function(result) {\n' +
'      btn.disabled = false;\n' +
'      btn.textContent = \'Continue\';\n' +
'      if (!result.ok) { errEl.textContent = result.data.error || \'Auth failed\'; return; }\n' +
'      currentUser = result.data.email;\n' +
'      localStorage.setItem(\'artdirector_email\', currentUser);\n' +
'      showApp();\n' +
'    })\n' +
'    .catch(function() {\n' +
'      btn.disabled = false;\n' +
'      btn.textContent = \'Continue\';\n' +
'      errEl.textContent = \'Network error — please try again\';\n' +
'    });\n' +
'  };\n' +
'\n' +
'  window.doLogout = function() {\n' +
'    localStorage.removeItem(\'artdirector_email\');\n' +
'    currentUser = null;\n' +
'    document.getElementById(\'auth-gate\').classList.remove(\'hidden\');\n' +
'    document.getElementById(\'app\').classList.remove(\'visible\');\n' +
'    document.getElementById(\'history-list\').innerHTML = \'<div class="history-empty">No saved history yet</div>\';\n' +
'    document.getElementById(\'output-area\').innerHTML = \'\';\n' +
'  };\n' +
'\n' +
'  window.updateFileCount = function() {\n' +
'    var files = document.getElementById(\'file-input\').files;\n' +
'    document.getElementById(\'file-count\').textContent = files.length > 0 ? files.length + \' file(s)\' : \'\';\n' +
'  };\n' +
'\n' +
'  function showFormError(msg) {\n' +
'    var el = document.getElementById(\'form-error\');\n' +
'    el.textContent = msg;\n' +
'    el.removeAttribute(\'hidden\');\n' +
'  }\n' +
'\n' +
'  function hideFormError() {\n' +
'    var el = document.getElementById(\'form-error\');\n' +
'    el.setAttribute(\'hidden\', \'\');\n' +
'    el.textContent = \'\';\n' +
'  }\n' +
'\n' +
'  window.doGenerate = function() {\n' +
'    hideFormError();\n' +
'    var prompt = document.getElementById(\'prompt-input\').value.trim();\n' +
'    if (!prompt) { showFormError(\'Prompt is required\'); return; }\n' +
'\n' +
'    var btn = document.getElementById(\'gen-btn\');\n' +
'    btn.disabled = true;\n' +
'    btn.textContent = \'Generating...\';\n' +
'\n' +
'    var outputArea = document.getElementById(\'output-area\');\n' +
'    var loadingEl = document.createElement(\'div\');\n' +
'    loadingEl.className = \'loading-indicator\';\n' +
'    var spinner = document.createElement(\'div\');\n' +
'    spinner.className = \'spinner\';\n' +
'    var loadingText = document.createElement(\'span\');\n' +
'    loadingText.textContent = \'Generating your creative direction...\';\n' +
'    loadingEl.appendChild(spinner);\n' +
'    loadingEl.appendChild(loadingText);\n' +
'    outputArea.prepend(loadingEl);\n' +
'\n' +
'    var formData = new FormData();\n' +
'    formData.append(\'prompt\', prompt);\n' +
'    formData.append(\'format\', document.getElementById(\'format-select\').value);\n' +
'    formData.append(\'userEmail\', currentUser || \'\');\n' +
'    var urlVal = document.getElementById(\'url-input\').value.trim();\n' +
'    if (urlVal) formData.append(\'urls\', urlVal);\n' +
'    var files = document.getElementById(\'file-input\').files;\n' +
'    for (var i = 0; i < files.length; i++) formData.append(\'files\', files[i]);\n' +
'\n' +
'    fetch(\'/api/generate\', { method: \'POST\', body: formData })\n' +
'    .then(function(res) { return res.json().then(function(data) { return { ok: res.ok, data: data }; }); })\n' +
'    .then(function(result) {\n' +
'      loadingEl.remove();\n' +
'      btn.disabled = false;\n' +
'      btn.textContent = \'Generate\';\n' +
'      if (!result.ok) { showFormError(result.data.error || \'Generation failed\'); return; }\n' +
'      var card = buildOutputCard(result.data, prompt);\n' +
'      outputArea.prepend(card);\n' +
'    })\n' +
'    .catch(function(e) {\n' +
'      loadingEl.remove();\n' +
'      btn.disabled = false;\n' +
'      btn.textContent = \'Generate\';\n' +
'      showFormError(\'Network error: \' + e.message);\n' +
'    });\n' +
'  };\n' +
'\n' +
'  function buildOutputCard(data, prompt) {\n' +
'    var card = document.createElement(\'div\');\n' +
'    card.className = \'output-card\';\n' +
'\n' +
'    var header = document.createElement(\'div\');\n' +
'    header.className = \'card-header\';\n' +
'\n' +
'    var titleWrap = document.createElement(\'div\');\n' +
'    titleWrap.className = \'card-title-wrap\';\n' +
'\n' +
'    var title = document.createElement(\'div\');\n' +
'    title.className = \'card-title\';\n' +
'    title.textContent = formatLabel(data.format);\n' +
'\n' +
'    var meta = document.createElement(\'div\');\n' +
'    meta.className = \'card-meta\';\n' +
'    meta.textContent = prompt.slice(0, 70) + (prompt.length > 70 ? \'...\' : \'\');\n' +
'\n' +
'    titleWrap.appendChild(title);\n' +
'    titleWrap.appendChild(meta);\n' +
'\n' +
'    var actions = document.createElement(\'div\');\n' +
'    actions.className = \'card-actions\';\n' +
'\n' +
'    var copyBtn = document.createElement(\'button\');\n' +
'    copyBtn.className = \'btn-copy\';\n' +
'    copyBtn.textContent = \'Copy\';\n' +
'    copyBtn.onclick = function(e) {\n' +
'      e.stopPropagation();\n' +
'      navigator.clipboard.writeText(data.output).then(function() {\n' +
'        copyBtn.textContent = \'Copied!\';\n' +
'        setTimeout(function() { copyBtn.textContent = \'Copy\'; }, 1500);\n' +
'      });\n' +
'    };\n' +
'\n' +
'    var saveBtn = document.createElement(\'button\');\n' +
'    saveBtn.className = \'btn-save\';\n' +
'    saveBtn.textContent = \'Save\';\n' +
'    saveBtn.onclick = function(e) {\n' +
'      e.stopPropagation();\n' +
'      doSave(data, prompt, saveBtn);\n' +
'    };\n' +
'\n' +
'    var chevron = document.createElement(\'span\');\n' +
'    chevron.className = \'chevron\';\n' +
'    chevron.textContent = \'\\u25be\';\n' +
'\n' +
'    actions.appendChild(copyBtn);\n' +
'    actions.appendChild(saveBtn);\n' +
'    actions.appendChild(chevron);\n' +
'\n' +
'    header.appendChild(titleWrap);\n' +
'    header.appendChild(actions);\n' +
'\n' +
'    var body = document.createElement(\'div\');\n' +
'    body.className = \'card-body\';\n' +
'\n' +
'    var textEl = document.createElement(\'pre\');\n' +
'    textEl.className = \'card-text\';\n' +
'    textEl.textContent = data.output;\n' +
'    body.appendChild(textEl);\n' +
'\n' +
'    if (data.images && data.images.length > 0) {\n' +
'      var imgGrid = document.createElement(\'div\');\n' +
'      imgGrid.className = \'card-images\';\n' +
'      data.images.forEach(function(img) {\n' +
'        var imgEl = document.createElement(\'img\');\n' +
'        imgEl.src = \'data:\' + img.mimeType + \';base64,\' + img.base64;\n' +
'        imgEl.alt = img.prompt;\n' +
'        imgGrid.appendChild(imgEl);\n' +
'      });\n' +
'      body.appendChild(imgGrid);\n' +
'    }\n' +
'\n' +
'    header.onclick = function() {\n' +
'      var collapsed = body.classList.toggle(\'collapsed\');\n' +
'      chevron.classList.toggle(\'collapsed\', collapsed);\n' +
'    };\n' +
'\n' +
'    card.appendChild(header);\n' +
'    card.appendChild(body);\n' +
'    return card;\n' +
'  }\n' +
'\n' +
'  function doSave(data, prompt, btn) {\n' +
'    if (!currentUser) return;\n' +
'    btn.disabled = true;\n' +
'    btn.textContent = \'Saving...\';\n' +
'    fetch(\'/api/save\', {\n' +
'      method: \'POST\',\n' +
'      headers: { \'Content-Type\': \'application/json\' },\n' +
'      body: JSON.stringify({ userEmail: currentUser, prompt: prompt, output: data.output, format: data.format })\n' +
'    })\n' +
'    .then(function(res) { return res.json().then(function(d) { return { ok: res.ok, data: d }; }); })\n' +
'    .then(function(result) {\n' +
'      if (result.ok) {\n' +
'        btn.textContent = \'Saved!\';\n' +
'        btn.style.background = \'var(--success)\';\n' +
'        btn.style.color = \'#fff\';\n' +
'        btn.style.borderColor = \'var(--success)\';\n' +
'        loadHistory();\n' +
'      } else {\n' +
'        btn.textContent = result.data.error || \'Error\';\n' +
'        btn.disabled = false;\n' +
'        setTimeout(function() {\n' +
'          btn.textContent = \'Save\';\n' +
'          btn.style.background = \'\';\n' +
'          btn.style.color = \'\';\n' +
'          btn.style.borderColor = \'\';\n' +
'        }, 2000);\n' +
'      }\n' +
'    })\n' +
'    .catch(function() {\n' +
'      btn.textContent = \'Error\';\n' +
'      btn.disabled = false;\n' +
'      setTimeout(function() {\n' +
'        btn.textContent = \'Save\';\n' +
'        btn.style.background = \'\';\n' +
'        btn.style.color = \'\';\n' +
'        btn.style.borderColor = \'\';\n' +
'      }, 2000);\n' +
'    });\n' +
'  }\n' +
'\n' +
'  window.loadHistory = function() {\n' +
'    if (!currentUser) return;\n' +
'    var listEl = document.getElementById(\'history-list\');\n' +
'    fetch(\'/api/history?userEmail=\' + encodeURIComponent(currentUser))\n' +
'    .then(function(res) {\n' +
'      if (!res.ok) {\n' +
'        listEl.innerHTML = \'<div class="history-empty">History unavailable</div>\';\n' +
'        return null;\n' +
'      }\n' +
'      return res.json();\n' +
'    })\n' +
'    .then(function(data) {\n' +
'      if (!data) return;\n' +
'      if (!data.conversations || data.conversations.length === 0) {\n' +
'        listEl.innerHTML = \'<div class="history-empty">No saved history yet.<br>Generate and save outputs to see them here.</div>\';\n' +
'        return;\n' +
'      }\n' +
'      listEl.innerHTML = \'\';\n' +
'      data.conversations.forEach(function(conv) {\n' +
'        var item = document.createElement(\'div\');\n' +
'        item.className = \'history-item\';\n' +
'\n' +
'        var content = document.createElement(\'div\');\n' +
'        content.className = \'history-item-content\';\n' +
'\n' +
'        var promptEl = document.createElement(\'div\');\n' +
'        promptEl.className = \'history-item-prompt\';\n' +
'        promptEl.textContent = conv.prompt;\n' +
'\n' +
'        var metaEl = document.createElement(\'div\');\n' +
'        metaEl.className = \'history-item-meta\';\n' +
'        metaEl.textContent = formatLabel(conv.format) + \' \\u00b7 \' + new Date(Number(conv.created_at)).toLocaleDateString();\n' +
'\n' +
'        content.appendChild(promptEl);\n' +
'        content.appendChild(metaEl);\n' +
'\n' +
'        var delBtn = document.createElement(\'button\');\n' +
'        delBtn.className = \'history-delete\';\n' +
'        delBtn.textContent = \'\\u2715\';\n' +
'        delBtn.title = \'Delete\';\n' +
'        (function(convId, itemEl) {\n' +
'          delBtn.onclick = function(e) {\n' +
'            e.stopPropagation();\n' +
'            doDelete(convId, itemEl);\n' +
'          };\n' +
'        })(conv.id, item);\n' +
'\n' +
'        (function(c) {\n' +
'          content.onclick = function() {\n' +
'            var outputArea = document.getElementById(\'output-area\');\n' +
'            var card = buildOutputCard({ output: c.output, format: c.format, images: [] }, c.prompt);\n' +
'            outputArea.prepend(card);\n' +
'            outputArea.scrollTop = 0;\n' +
'          };\n' +
'        })(conv);\n' +
'\n' +
'        item.appendChild(content);\n' +
'        item.appendChild(delBtn);\n' +
'        listEl.appendChild(item);\n' +
'      });\n' +
'    })\n' +
'    .catch(function() {\n' +
'      listEl.innerHTML = \'<div class="history-empty">Error loading history</div>\';\n' +
'    });\n' +
'  };\n' +
'\n' +
'  function doDelete(id, itemEl) {\n' +
'    fetch(\'/api/delete/\' + id, {\n' +
'      method: \'DELETE\',\n' +
'      headers: { \'Content-Type\': \'application/json\' },\n' +
'      body: JSON.stringify({ userEmail: currentUser })\n' +
'    })\n' +
'    .then(function(res) {\n' +
'      if (res.ok) {\n' +
'        itemEl.remove();\n' +
'        var listEl = document.getElementById(\'history-list\');\n' +
'        if (listEl.children.length === 0) {\n' +
'          listEl.innerHTML = \'<div class="history-empty">No saved history yet.<br>Generate and save outputs to see them here.</div>\';\n' +
'        }\n' +
'      }\n' +
'    })\n' +
'    .catch(function(e) {\n' +
'      console.error(\'Delete error:\', e);\n' +
'    });\n' +
'  }\n' +
'\n' +
'  function formatLabel(format) {\n' +
'    var labels = {\n' +
'      concepts: \'Creative Concepts\',\n' +
'      moodboard: \'Moodboard\',\n' +
'      styleguide: \'Style Guide\',\n' +
'      copywriting: \'Copywriting\',\n' +
'      campaign: \'Campaign\',\n' +
'      technical: \'Technical Specs\'\n' +
'    };\n' +
'    return labels[format] || format;\n' +
'  }\n' +
'\n' +
'  document.getElementById(\'auth-email\').addEventListener(\'keydown\', function(e) {\n' +
'    if (e.key === \'Enter\') doAuth();\n' +
'  });\n' +
'\n' +
'  document.getElementById(\'prompt-input\').addEventListener(\'keydown\', function(e) {\n' +
'    if (e.key === \'Enter\' && (e.ctrlKey || e.metaKey)) doGenerate();\n' +
'  });\n' +
'\n' +
'  init();\n' +
'}());\n' +
'<\/script>\n' +
'</body>\n' +
'</html>';
  res.send(html);
});

app.listen(PORT, function() {
  console.log('AI Art Director Companion running on port ' + PORT);
});
