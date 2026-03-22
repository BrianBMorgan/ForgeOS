var express = require('express');
var axios = require('axios');
var multer = require('multer');
var { Anthropic } = require('@anthropic-ai/sdk');
var { Resend } = require('resend');
var { neon } = require('@neondatabase/serverless');

var app = express();
var PORT = process.env.PORT || 3000;

var FORGE_API_BASE = process.env.FORGE_API_BASE || 'https://forge-os.ai';
var PROJECT_ID = process.env.PROJECT_ID || '6f5c4586';

var upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: function(req, file, cb) {
    var allowed = ['image/jpeg','image/png','image/gif','image/webp','image/svg+xml'];
    cb(null, allowed.indexOf(file.mimetype) !== -1);
  }
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

var db = null;

function initDb() {
  var dbUrl = process.env.NEON_DATABASE_URL;
  if (!dbUrl) { console.log('NEON_DATABASE_URL not set'); return Promise.resolve(); }
  try {
    db = neon(dbUrl);
    return db`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      last_login TIMESTAMPTZ
    )`.then(function() {
      return db`CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        user_email TEXT NOT NULL,
        prompt TEXT NOT NULL,
        output TEXT NOT NULL,
        format TEXT NOT NULL DEFAULT 'concept',
        created_at BIGINT NOT NULL
      )`;
    }).then(function() {
      console.log('Database ready');
    }).catch(function(err) {
      console.error('DB init error:', err.message);
      db = null;
    });
  } catch(err) {
    console.error('DB connection error:', err.message);
    db = null;
    return Promise.resolve();
  }
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

var SYSTEM_PROMPTS = {
  concept: 'You are a senior creative director. Generate a detailed creative concept with sections: CONCEPT OVERVIEW, VISUAL DIRECTION, TONE & VOICE, KEY THEMES, EXECUTION IDEAS. Use clear headers and bullet points.',
  moodboard: 'You are a visual creative director. Generate exactly 4 distinct image prompts for a moodboard, each on its own line prefixed with "IMAGE PROMPT:". After the prompts, add a MOODBOARD CONCEPT section describing the overall visual direction.',
  styleguide: 'You are a brand designer. Generate a comprehensive style guide with sections: BRAND PERSONALITY, COLOR PALETTE (with hex codes), TYPOGRAPHY, IMAGERY STYLE, TONE OF VOICE, DO\'S AND DON\'TS.',
  copywriting: 'You are a senior copywriter. Generate compelling copy with sections: HEADLINE OPTIONS (5 variations), TAGLINE OPTIONS (5 variations), BODY COPY, CALL TO ACTION OPTIONS, KEY MESSAGES.',
  campaign: 'You are a campaign strategist. Generate a full campaign plan with sections: CAMPAIGN CONCEPT, TARGET AUDIENCE, KEY MESSAGES, CHANNEL STRATEGY, CONTENT PILLARS, CAMPAIGN PHASES, SUCCESS METRICS.'
};

function generateMoodboardImages(prompts) {
  var fluxUrl = FORGE_API_BASE + '/api/projects/' + PROJECT_ID + '/flux';
  var requests = prompts.map(function(prompt) {
    return axios.post(fluxUrl, { prompt: prompt, width: 1024, height: 1024 }, {
      headers: { 'Content-Type': 'application/json' }, timeout: 60000
    }).then(function(r) {
      var d = r.data;
      if (d && d.ok && d.image && d.image.base64) return { ok: true, base64: d.image.base64 };
      if (d && d.ok && Array.isArray(d.images) && d.images[0] && d.images[0].base64) return { ok: true, base64: d.images[0].base64 };
      if (d && d.base64) return { ok: true, base64: d.base64 };
      return { ok: false, error: 'No image in response' };
    }).catch(function(err) { return { ok: false, error: err.message }; });
  });
  return Promise.all(requests);
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.post('/api/auth', function(req, res) {
  var email = (req.body.email || '').trim();
  if (!email || !validateEmail(email)) return res.json({ ok: false, error: 'Valid email required' });
  if (!db) return res.json({ ok: true, email: email });
  db`INSERT INTO users (email, last_login) VALUES (${email}, NOW())
     ON CONFLICT (email) DO UPDATE SET last_login = NOW() RETURNING *`
    .then(function(rows) { res.json({ ok: true, email: rows[0].email }); })
    .catch(function(err) { console.error('Auth error:', err.message); res.json({ ok: true, email: email }); });
});

// ── GENERATE ──────────────────────────────────────────────────────────────────
app.post('/api/generate', upload.array('references', 4), function(req, res) {
  var client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  var prompt = (req.body.prompt || '').trim();
  var format = (req.body.format || 'concept').trim();
  var moods = req.body.moods || '';
  var colors = req.body.colors || '';
  if (!prompt) return res.json({ ok: false, error: 'Prompt is required' });

  var moodList = Array.isArray(moods) ? moods.join(', ') : moods;
  var colorList = Array.isArray(colors) ? colors.join(', ') : colors;
  var systemPrompt = SYSTEM_PROMPTS[format] || SYSTEM_PROMPTS.concept;

  var userMessage = 'Create ' + format + ' for the following brief:\n\n' + prompt;
  if (moodList) userMessage += '\n\nMood/Tone: ' + moodList;
  if (colorList) userMessage += '\nColor Preferences: ' + colorList;
  if (req.files && req.files.length > 0) userMessage += '\n\nReference images have been provided (' + req.files.length + ' image(s)). Consider their visual style, composition, and aesthetic.';

  var messageContent = [{ type: 'text', text: userMessage }];
  if (req.files) {
    req.files.forEach(function(file) {
      messageContent.push({ type: 'image', source: { type: 'base64', media_type: file.mimetype, data: file.buffer.toString('base64') } });
    });
  }

  client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: messageContent }]
  }).then(function(response) {
    var text = response.content[0].text;
    if (format !== 'moodboard') return res.json({ ok: true, output: text, format: format, images: [] });

    var imagePrompts = text.split('\n')
      .filter(function(l) { return l.indexOf('IMAGE PROMPT:') === 0; })
      .map(function(l) { return l.replace('IMAGE PROMPT:', '').trim(); });

    if (!imagePrompts.length) return res.json({ ok: true, output: text, format: format, images: [] });

    return generateMoodboardImages(imagePrompts).then(function(results) {
      var images = results.filter(function(r) { return r.ok; }).map(function(r) { return { base64: r.base64 }; });
      res.json({ ok: true, output: text, format: format, images: images });
    });
  }).catch(function(err) {
    console.error('Generate error:', err.message);
    res.json({ ok: false, error: 'Generation failed: ' + err.message });
  });
});

// ── SAVE ──────────────────────────────────────────────────────────────────────
app.post('/api/save', function(req, res) {
  if (!db) return res.status(503).json({ ok: false, error: 'Database not available' });
  var email = (req.body.email || '').trim();
  var prompt = (req.body.prompt || '').trim();
  var output = (req.body.output || '').trim();
  var format = (req.body.format || 'concept').trim();
  if (!email || !prompt || !output) return res.json({ ok: false, error: 'email, prompt, and output required' });
  var now = Date.now();
  db`INSERT INTO conversations (user_email, prompt, output, format, created_at)
     VALUES (${email}, ${prompt}, ${output}, ${format}, ${now}) RETURNING *`
    .then(function(rows) { res.json({ ok: true, record: rows[0] }); })
    .catch(function(err) { console.error('Save error:', err.message); res.json({ ok: false, error: 'Save failed' }); });
});

// ── HISTORY ───────────────────────────────────────────────────────────────────
app.get('/api/history', function(req, res) {
  if (!db) return res.status(503).json({ ok: false, error: 'Database not available' });
  var email = (req.query.email || '').trim();
  if (!email) return res.json({ ok: false, error: 'email required' });
  db`SELECT * FROM conversations WHERE user_email = ${email} ORDER BY created_at DESC LIMIT 50`
    .then(function(rows) { res.json({ ok: true, history: rows }); })
    .catch(function(err) { console.error('History error:', err.message); res.json({ ok: false, error: 'Failed' }); });
});

// ── DELETE ────────────────────────────────────────────────────────────────────
app.delete('/api/delete/:id', function(req, res) {
  if (!db) return res.status(503).json({ ok: false, error: 'Database not available' });
  var id = parseInt(req.params.id);
  var email = (req.query.email || '').trim();
  if (!id || !email) return res.json({ ok: false, error: 'id and email required' });
  db`DELETE FROM conversations WHERE id = ${id} AND user_email = ${email} RETURNING id`
    .then(function(rows) {
      if (!rows.length) return res.status(404).json({ ok: false, error: 'Not found' });
      res.json({ ok: true, deleted: rows[0].id });
    })
    .catch(function(err) { console.error('Delete error:', err.message); res.json({ ok: false, error: 'Delete failed' }); });
});

// ── HTML ──────────────────────────────────────────────────────────────────────
app.get('/', function(req, res) {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Art Director</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0d0d0f;--surface:#16161a;--surface2:#1e1e24;--border:#2a2a35;
  --accent:#7c6af7;--accent2:#a78bfa;--text:#e8e8f0;--muted:#888899;
  --danger:#ef4444;--success:#22c55e;
}
body{background:var(--bg);color:var(--text);font-family:'Inter',system-ui,sans-serif;min-height:100vh;overflow:hidden}
h1,h2,h3{font-family:'Space Grotesk',sans-serif}

/* AUTH */
#authScreen{position:fixed;inset:0;background:var(--bg);display:flex;align-items:center;justify-content:center;z-index:100}
#authScreen.hidden{display:none}
.auth-card{background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:52px 44px;width:100%;max-width:440px;text-align:center}
.auth-card h1{font-size:2rem;font-weight:800;background:linear-gradient(135deg,var(--accent),var(--accent2));-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:8px}
.auth-card p{color:var(--muted);font-size:0.92rem;margin-bottom:36px}
.auth-card input{width:100%;padding:13px 16px;background:var(--surface2);border:1px solid var(--border);border-radius:10px;color:var(--text);font-size:1rem;margin-bottom:12px;outline:none;transition:border-color .15s}
.auth-card input:focus{border-color:var(--accent)}
.error-msg{color:var(--danger);font-size:0.82rem;margin-top:8px}

/* LAYOUT */
#app{display:none;flex-direction:column;height:100vh}
#app.visible{display:flex}
nav{background:var(--surface);border-bottom:1px solid var(--border);padding:0 24px;height:54px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.nav-brand{display:flex;align-items:center;gap:10px;font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:1.05rem}
.nav-brand span:first-child{font-size:1.3rem}
.user-pill{background:var(--surface2);border:1px solid var(--border);border-radius:20px;padding:5px 14px;font-size:0.78rem;color:var(--muted);display:flex;align-items:center;gap:10px}
.user-pill button{background:none;border:none;color:var(--danger);cursor:pointer;font-size:0.75rem}
.main-layout{display:flex;flex:1;overflow:hidden}

/* SIDEBAR */
.sidebar{width:270px;min-width:270px;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden}
.sidebar-header{padding:14px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.sidebar-header h3{font-size:0.78rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.btn-icon{background:none;border:1px solid var(--border);border-radius:6px;color:var(--muted);cursor:pointer;width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-size:1rem;line-height:1;transition:border-color .15s,color .15s}
.btn-icon:hover{border-color:var(--accent);color:var(--accent)}
.history-list{flex:1;overflow-y:auto;padding:8px}
.history-list::-webkit-scrollbar{width:4px}
.history-list::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
.history-item{background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:6px;display:flex;align-items:flex-start;justify-content:space-between;gap:8px;cursor:pointer;transition:border-color .15s}
.history-item:hover{border-color:var(--accent)}
.history-item-inner{flex:1;min-width:0}
.history-prompt{font-size:0.79rem;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.history-meta{font-size:0.69rem;color:var(--muted);margin-top:3px}
.history-del{background:none;border:none;color:var(--border);cursor:pointer;font-size:0.82rem;padding:2px 4px;border-radius:4px;flex-shrink:0;transition:color .15s}
.history-del:hover{color:var(--danger)}
.history-empty{color:var(--muted);font-size:0.8rem;text-align:center;padding:32px 16px;line-height:1.7}

/* WORKSPACE */
.workspace{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
.input-panel{padding:20px 24px;border-bottom:1px solid var(--border);background:var(--surface);flex-shrink:0}

/* FORMAT TABS */
.format-tabs{display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap}
.tab{background:var(--surface2);border:1px solid var(--border);border-radius:8px;color:var(--muted);cursor:pointer;font-size:0.8rem;font-weight:500;padding:6px 14px;transition:all .15s}
.tab:hover{border-color:var(--accent);color:var(--text)}
.tab.active{background:var(--accent);border-color:var(--accent);color:#fff}

/* PROMPT */
textarea{width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:10px;color:var(--text);padding:12px 14px;font-size:0.88rem;resize:none;font-family:inherit;outline:none;transition:border-color .15s;margin-bottom:10px}
textarea:focus{border-color:var(--accent)}

/* TAGS */
.options-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.options-label{font-size:0.75rem;color:var(--muted);flex-shrink:0}
.tag{background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--muted);cursor:pointer;font-size:0.76rem;padding:4px 10px;transition:all .15s}
.tag:hover{border-color:var(--accent);color:var(--text)}
.tag.active{background:rgba(124,106,247,0.15);border-color:var(--accent);color:var(--accent2)}

/* UPLOAD */
.upload-area{border:1px dashed var(--border);border-radius:10px;padding:12px 14px;margin-bottom:12px;transition:border-color .15s;cursor:pointer}
.upload-area:hover,.upload-area.drag-over{border-color:var(--accent)}
.upload-prompt{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:0.82rem}
.upload-prompt span:first-child{font-size:1.1rem}
.btn-link{background:none;border:none;color:var(--accent);cursor:pointer;font-size:inherit;padding:0;text-decoration:underline}
.file-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.file-chip{background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:3px 10px;font-size:0.75rem;color:var(--text);display:flex;align-items:center;gap:6px}
.file-chip button{background:none;border:none;color:var(--muted);cursor:pointer;font-size:0.75rem;padding:0;line-height:1}
.file-chip button:hover{color:var(--danger)}

/* GENERATE */
.generate-row{display:flex;align-items:center;gap:12px}
.btn-primary{background:var(--accent);border:none;border-radius:10px;color:#fff;cursor:pointer;font-size:0.92rem;font-weight:600;padding:11px 28px;transition:background .15s;font-family:'Space Grotesk',sans-serif}
.btn-primary:hover{background:var(--accent2)}
.btn-primary:disabled{opacity:.5;cursor:not-allowed}

/* OUTPUT */
.output-panel{flex:1;overflow-y:auto;padding:20px 24px;display:flex;flex-direction:column;gap:14px}
.output-panel::-webkit-scrollbar{width:5px}
.output-panel::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
.output-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;animation:fadeIn .25s ease}
@keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.card-header{background:var(--surface2);padding:12px 16px;display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none;transition:background .15s}
.card-header:hover{background:var(--border)}
.card-title{font-size:0.84rem;font-weight:600;color:var(--accent2);font-family:'Space Grotesk',sans-serif}
.card-prompt{font-size:0.71rem;color:var(--muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:500px}
.card-btns{display:flex;gap:6px;align-items:center;flex-shrink:0;margin-left:12px}
.btn-sm{background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--muted);cursor:pointer;font-size:0.71rem;padding:4px 9px;transition:all .15s}
.btn-sm:hover{border-color:var(--accent);color:var(--text)}
.btn-sm.save{border-color:var(--success);color:var(--success)}
.btn-sm.save:hover{background:var(--success);color:#fff}
.btn-sm:disabled{opacity:.6;cursor:not-allowed}
.chevron{color:var(--muted);font-size:0.7rem;margin-left:4px;transition:transform .2s;display:inline-block}
.chevron.collapsed{transform:rotate(-90deg)}
.card-body{padding:18px 20px}
.card-body.collapsed{display:none}
.card-text{white-space:pre-wrap;font-size:0.86rem;line-height:1.8;color:var(--text);font-family:inherit}
.card-images{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin-top:16px}
.card-images img{width:100%;border-radius:8px;border:1px solid var(--border)}
.loading-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;display:flex;align-items:center;gap:14px;color:var(--muted);font-size:0.88rem}
.spinner{width:18px;height:18px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0}
@keyframes spin{to{transform:rotate(360deg)}}
.empty-state{color:var(--muted);text-align:center;padding:60px 20px;font-size:0.88rem;line-height:1.8}
.empty-state .big{font-size:2.5rem;margin-bottom:12px}
</style>
<script>(function(){var active=false,overlay=null,lastEl=null;function sel(el){var parts=[];var e=el;for(var i=0;i<4&&e&&e!==document.body;i++){var s=e.tagName.toLowerCase();if(e.id)s+='#'+e.id;else if(e.className&&typeof e.className==='string')s+='.'+e.className.trim().split(/\s+/).slice(0,2).join('.');parts.unshift(s);e=e.parentElement;}return parts.join(' > ');}function trim(s,n){return s&&s.length>n?s.slice(0,n)+'...':s||'';}function show(el){if(!overlay){overlay=document.createElement('div');overlay.style.cssText='position:fixed;pointer-events:none;outline:2px solid #6366f1;outline-offset:1px;background:rgba(99,102,241,0.1);z-index:2147483647;transition:all 0.05s';document.body.appendChild(overlay);}var r=el.getBoundingClientRect();overlay.style.top=r.top+'px';overlay.style.left=r.left+'px';overlay.style.width=r.width+'px';overlay.style.height=r.height+'px';overlay.style.display='block';}function hide(){if(overlay)overlay.style.display='none';}document.addEventListener('mousemove',function(e){if(!active)return;var el=document.elementFromPoint(e.clientX,e.clientY);if(el&&el!==overlay){lastEl=el;show(el);}},true);document.addEventListener('click',function(e){if(!active)return;e.preventDefault();e.stopPropagation();var el=lastEl||e.target;window.parent.postMessage({type:'forge:inspect:selection',outerHTML:trim(el.outerHTML,600),textContent:trim((el.textContent||'').trim(),200),selector:sel(el)},'*');},true);window.addEventListener('message',function(e){if(!e.data)return;if(e.data.type==='forge:inspect:activate'){active=true;document.body.style.cursor='crosshair';}if(e.data.type==='forge:inspect:deactivate'){active=false;hide();document.body.style.cursor='';}});})();</script>\n</head>
<body>

<div id="authScreen">
  <div class="auth-card">
    <h1>AI Art Director</h1>
    <p>Your creative intelligence engine</p>
    <input type="email" id="emailInput" placeholder="you@example.com" />
    <button class="btn-primary" id="authBtn" style="width:100%" onclick="doAuth()">Get Started</button>
    <div class="error-msg" id="authError" hidden></div>
  </div>
</div>

<div id="app">
  <nav>
    <div class="nav-brand">
      <span>🎨</span>
      <span>AI Art Director</span>
    </div>
    <div class="user-pill" id="userPill" hidden>
      <span id="userEmail"></span>
      <button onclick="doLogout()">Sign out</button>
    </div>
  </nav>

  <div class="main-layout">
    <div class="sidebar">
      <div class="sidebar-header">
        <h3>History</h3>
        <button class="btn-icon" title="Clear output" onclick="clearOutput()">+</button>
      </div>
      <div class="history-list" id="historyList">
        <div class="history-empty">No saved work yet</div>
      </div>
    </div>

    <div class="workspace">
      <div class="input-panel">
        <div class="format-tabs" id="formatTabs">
          <button class="tab active" data-format="concept">Concept</button>
          <button class="tab" data-format="moodboard">Moodboard</button>
          <button class="tab" data-format="styleguide">Style Guide</button>
          <button class="tab" data-format="copywriting">Copywriting</button>
          <button class="tab" data-format="campaign">Campaign</button>
        </div>

        <textarea id="promptInput" rows="4" placeholder="Describe your creative brief..."></textarea>

        <div class="options-row">
          <span class="options-label">Mood:</span>
          <button class="tag" data-mood="Bold">Bold</button>
          <button class="tag" data-mood="Minimal">Minimal</button>
          <button class="tag" data-mood="Playful">Playful</button>
          <button class="tag" data-mood="Elegant">Elegant</button>
          <button class="tag" data-mood="Edgy">Edgy</button>
          <button class="tag" data-mood="Warm">Warm</button>
          <button class="tag" data-mood="Cool">Cool</button>
          <button class="tag" data-mood="Organic">Organic</button>
        </div>

        <div class="options-row">
          <span class="options-label">Colors:</span>
          <button class="tag" data-color="Monochrome">Monochrome</button>
          <button class="tag" data-color="Earth tones">Earth tones</button>
          <button class="tag" data-color="Pastels">Pastels</button>
          <button class="tag" data-color="Vibrant">Vibrant</button>
          <button class="tag" data-color="Dark & moody">Dark & moody</button>
          <button class="tag" data-color="Neon">Neon</button>
        </div>

        <div class="upload-area" id="uploadArea">
          <input type="file" id="fileInput" multiple accept="image/*" style="display:none">
          <div class="upload-prompt" id="uploadPrompt">
            <span>📎</span>
            <span>Drop reference images or <button class="btn-link" id="browseBtn">browse</button></span>
          </div>
          <div class="file-chips" id="fileChips"></div>
        </div>

        <div class="generate-row">
          <button class="btn-primary" id="generateBtn" onclick="doGenerate()">Generate</button>
          <div class="error-msg" id="generateError" hidden></div>
        </div>
      </div>

      <div class="output-panel" id="outputPanel">
        <div class="empty-state">
          <div class="big">✦</div>
          Describe a creative brief above and hit Generate
        </div>
      </div>
    </div>
  </div>
</div>

<script>
(function() {
  var currentUser = null;
  var currentFormat = 'concept';
  var selectedMoods = [];
  var selectedColors = [];
  var selectedFiles = [];

  // ── INIT ────────────────────────────────────────────────────────────────────
  function init() {
    var stored = localStorage.getItem('aad_email');
    if (stored) { currentUser = stored; showApp(); }

    // Format tabs
    document.getElementById('formatTabs').addEventListener('click', function(e) {
      var tab = e.target.closest('.tab');
      if (!tab) return;
      document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
      tab.classList.add('active');
      currentFormat = tab.dataset.format;
    });

    // Mood tags
    document.querySelectorAll('[data-mood]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var mood = btn.dataset.mood;
        var idx = selectedMoods.indexOf(mood);
        if (idx === -1) { selectedMoods.push(mood); btn.classList.add('active'); }
        else { selectedMoods.splice(idx, 1); btn.classList.remove('active'); }
      });
    });

    // Color tags
    document.querySelectorAll('[data-color]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var color = btn.dataset.color;
        var idx = selectedColors.indexOf(color);
        if (idx === -1) { selectedColors.push(color); btn.classList.add('active'); }
        else { selectedColors.splice(idx, 1); btn.classList.remove('active'); }
      });
    });

    // File upload
    var fileInput = document.getElementById('fileInput');
    document.getElementById('browseBtn').addEventListener('click', function(e) {
      e.preventDefault(); fileInput.click();
    });
    document.getElementById('uploadArea').addEventListener('click', function(e) {
      if (e.target === this || e.target.id === 'uploadPrompt') fileInput.click();
    });
    document.getElementById('uploadArea').addEventListener('dragover', function(e) {
      e.preventDefault(); this.classList.add('drag-over');
    });
    document.getElementById('uploadArea').addEventListener('dragleave', function() {
      this.classList.remove('drag-over');
    });
    document.getElementById('uploadArea').addEventListener('drop', function(e) {
      e.preventDefault(); this.classList.remove('drag-over');
      addFiles(Array.from(e.dataTransfer.files));
    });
    fileInput.addEventListener('change', function() {
      addFiles(Array.from(this.files));
      this.value = '';
    });

    // Enter to submit
    document.getElementById('emailInput').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') doAuth();
    });
    document.getElementById('promptInput').addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) doGenerate();
    });
  }

  function addFiles(files) {
    files.filter(function(f) { return f.type.startsWith('image/'); }).forEach(function(f) {
      if (selectedFiles.length < 4) selectedFiles.push(f);
    });
    renderFileChips();
  }

  function renderFileChips() {
    var chipsEl = document.getElementById('fileChips');
    chipsEl.innerHTML = '';
    selectedFiles.forEach(function(f, i) {
      var chip = document.createElement('div');
      chip.className = 'file-chip';
      chip.innerHTML = f.name + ' <button onclick="removeFile(' + i + ')">✕</button>';
      chipsEl.appendChild(chip);
    });
    document.getElementById('uploadPrompt').style.display = selectedFiles.length ? 'none' : 'flex';
  }

  window.removeFile = function(i) {
    selectedFiles.splice(i, 1); renderFileChips();
  };

  // ── AUTH ────────────────────────────────────────────────────────────────────
  window.doAuth = function() {
    var email = document.getElementById('emailInput').value.trim();
    var errEl = document.getElementById('authError');
    errEl.hidden = true;
    if (!email) { errEl.textContent = 'Email required'; errEl.hidden = false; return; }
    var btn = document.getElementById('authBtn');
    btn.disabled = true; btn.textContent = 'Checking...';

    fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email }) })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        btn.disabled = false; btn.textContent = 'Get Started';
        if (!data.ok) { errEl.textContent = data.error || 'Auth failed'; errEl.hidden = false; return; }
        currentUser = data.email;
        localStorage.setItem('aad_email', currentUser);
        showApp();
      })
      .catch(function() { btn.disabled = false; btn.textContent = 'Get Started'; errEl.textContent = 'Network error'; errEl.hidden = false; });
  };

  window.doLogout = function() {
    localStorage.removeItem('aad_email');
    currentUser = null;
    document.getElementById('authScreen').classList.remove('hidden');
    document.getElementById('app').classList.remove('visible');
    document.getElementById('historyList').innerHTML = '<div class="history-empty">No saved work yet</div>';
  };

  function showApp() {
    document.getElementById('authScreen').classList.add('hidden');
    document.getElementById('app').classList.add('visible');
    document.getElementById('userEmail').textContent = currentUser;
    document.getElementById('userPill').hidden = false;
    loadHistory();
  }

  window.clearOutput = function() {
    document.getElementById('outputPanel').innerHTML = '<div class="empty-state"><div class="big">✦</div>Describe a creative brief above and hit Generate</div>';
  };

  // ── GENERATE ────────────────────────────────────────────────────────────────
  window.doGenerate = function() {
    var prompt = document.getElementById('promptInput').value.trim();
    var errEl = document.getElementById('generateError');
    errEl.hidden = true;
    if (!prompt) { errEl.textContent = 'Prompt is required'; errEl.hidden = false; return; }

    var btn = document.getElementById('generateBtn');
    btn.disabled = true; btn.textContent = 'Generating...';

    var outputPanel = document.getElementById('outputPanel');
    var loader = document.createElement('div');
    loader.className = 'loading-card';
    loader.innerHTML = '<div class="spinner"></div><span>Crafting your ' + currentFormat + '...</span>';
    outputPanel.innerHTML = '';
    outputPanel.appendChild(loader);

    var fd = new FormData();
    fd.append('prompt', prompt);
    fd.append('format', currentFormat);
    selectedMoods.forEach(function(m) { fd.append('moods', m); });
    selectedColors.forEach(function(c) { fd.append('colors', c); });
    selectedFiles.forEach(function(f) { fd.append('references', f); });

    fetch('/api/generate', { method: 'POST', body: fd })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        loader.remove();
        btn.disabled = false; btn.textContent = 'Generate';
        if (!data.ok) { errEl.textContent = data.error || 'Generation failed'; errEl.hidden = false; return; }
        outputPanel.prepend(buildCard(data, prompt));
      })
      .catch(function(e) {
        loader.remove(); btn.disabled = false; btn.textContent = 'Generate';
        errEl.textContent = 'Network error: ' + e.message; errEl.hidden = false;
      });
  };

  function formatLabel(f) {
    return { concept:'Concept', moodboard:'Moodboard', styleguide:'Style Guide', copywriting:'Copywriting', campaign:'Campaign' }[f] || f;
  }

  function buildCard(data, prompt) {
    var card = document.createElement('div');
    card.className = 'output-card';

    var header = document.createElement('div');
    header.className = 'card-header';
    header.innerHTML = '<div style="min-width:0;flex:1"><div class="card-title">' + formatLabel(data.format) + '</div><div class="card-prompt">' + (prompt || '').slice(0, 80) + '</div></div><div class="card-btns"><button class="btn-sm copy-btn">Copy</button><button class="btn-sm save save-btn">Save</button><span class="chevron">▾</span></div>';

    var body = document.createElement('div');
    body.className = 'card-body';

    var pre = document.createElement('pre');
    pre.className = 'card-text';
    pre.textContent = data.output;
    body.appendChild(pre);

    if (data.images && data.images.length > 0) {
      var grid = document.createElement('div');
      grid.className = 'card-images';
      data.images.forEach(function(img) {
        var el = document.createElement('img');
        el.src = 'data:image/jpeg;base64,' + img.base64;
        el.alt = 'Moodboard image';
        grid.appendChild(el);
      });
      body.appendChild(grid);
    }

    // Toggle collapse
    var chevron = header.querySelector('.chevron');
    header.addEventListener('click', function(e) {
      if (e.target.closest('button')) return;
      body.classList.toggle('collapsed');
      chevron.classList.toggle('collapsed');
    });

    // Copy
    header.querySelector('.copy-btn').addEventListener('click', function(e) {
      e.stopPropagation();
      navigator.clipboard.writeText(data.output).then(function() {
        e.target.textContent = 'Copied!';
        setTimeout(function() { e.target.textContent = 'Copy'; }, 1500);
      });
    });

    // Save
    var saveBtn = header.querySelector('.save-btn');
    saveBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      if (!currentUser) return;
      saveBtn.disabled = true; saveBtn.textContent = 'Saving...';
      fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: currentUser, prompt: prompt, output: data.output, format: data.format }) })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (d.ok) { saveBtn.textContent = 'Saved ✓'; loadHistory(); }
          else { saveBtn.disabled = false; saveBtn.textContent = 'Error'; setTimeout(function() { saveBtn.textContent = 'Save'; }, 2000); }
        })
        .catch(function() { saveBtn.disabled = false; saveBtn.textContent = 'Error'; });
    });

    card.appendChild(header);
    card.appendChild(body);
    return card;
  }

  // ── HISTORY ─────────────────────────────────────────────────────────────────
  window.loadHistory = function() {
    if (!currentUser) return;
    fetch('/api/history?email=' + encodeURIComponent(currentUser))
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var el = document.getElementById('historyList');
        if (!data.ok || !data.history || !data.history.length) {
          el.innerHTML = '<div class="history-empty">No saved work yet</div>'; return;
        }
        el.innerHTML = '';
        data.history.forEach(function(row) {
          var item = document.createElement('div');
          item.className = 'history-item';
          item.innerHTML = '<div class="history-item-inner"><div class="history-prompt">' + row.prompt.slice(0,60) + '</div><div class="history-meta">' + formatLabel(row.format) + ' · ' + new Date(Number(row.created_at)).toLocaleDateString() + '</div></div><button class="history-del" title="Delete">✕</button>';
          item.querySelector('.history-item-inner').addEventListener('click', function() {
            var outputPanel = document.getElementById('outputPanel');
            outputPanel.prepend(buildCard({ output: row.output, format: row.format, images: [] }, row.prompt));
            outputPanel.scrollTop = 0;
          });
          item.querySelector('.history-del').addEventListener('click', function(e) {
            e.stopPropagation();
            fetch('/api/delete/' + row.id + '?email=' + encodeURIComponent(currentUser), { method: 'DELETE' })
              .then(function(r) { return r.json(); })
              .then(function(d) { if (d.ok) item.remove(); });
          });
          el.appendChild(item);
        });
      })
      .catch(function() {});
  };

  init();
}());
</script>
</body>
</html>`);
});

initDb().then(function() {
  app.listen(PORT, '0.0.0.0', function() {
    console.log('AI Art Director running on port ' + PORT);
  });
});
