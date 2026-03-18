var express = require('express');
var axios = require('axios');
var multer = require('multer');
var path = require('path');
var { Anthropic } = require('@anthropic-ai/sdk');
var { Resend } = require('resend');
var { neon } = require('@neondatabase/serverless');

var app = express();
var PORT = process.env.PORT || 3000;

var FORGE_API_BASE = process.env.FORGE_API_BASE || 'https://forge-os.ai';
var PROJECT_ID = process.env.PROJECT_ID || '6f5c4586';

console.log('FORGE_API_BASE=' + FORGE_API_BASE + ' PROJECT_ID=' + PROJECT_ID);

var upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: function(req, file, cb) {
    var allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
    if (allowed.indexOf(file.mimetype) !== -1) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'));
    }
  }
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

var db = null;

function initDb() {
  var dbUrl = process.env.NEON_DATABASE_URL;
  if (!dbUrl) {
    console.log('NEON_DATABASE_URL not set — database features disabled');
    return Promise.resolve();
  }
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
  } catch (err) {
    console.error('DB connection error:', err.message);
    db = null;
    return Promise.resolve();
  }
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function stripFences(text) {
  if (text.includes('```')) {
    text = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '');
  }
  var firstBrace = text.search(/[{[]/);
  if (firstBrace > 0) text = text.slice(firstBrace);
  return text;
}

function generateMoodboardImages(prompts) {
  var fluxUrl = FORGE_API_BASE + '/api/projects/' + PROJECT_ID + '/flux';

  console.log('generateMoodboardImages: sending ' + prompts.length + ' prompts to ' + fluxUrl);

  var requests = prompts.map(function(prompt) {
    console.log('Calling Flux for prompt: ' + prompt.substring(0, 80));
    return axios.post(
      fluxUrl,
      { prompt: prompt, width: 1024, height: 1024 },
      { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
    ).then(function(response) {
      var data = response.data;
      console.log('Flux response keys: ' + Object.keys(data || {}).join(', '));

      if (data && data.ok && data.image && data.image.base64) {
        console.log('Extracted via data.image.base64');
        return { ok: true, base64: data.image.base64, seed: data.image.seed || 0 };
      }

      if (data && data.ok && Array.isArray(data.images) && data.images.length > 0 && data.images[0].base64) {
        console.log('Extracted via data.images[0].base64');
        return { ok: true, base64: data.images[0].base64, seed: data.images[0].seed || 0 };
      }

      if (data && data.base64) {
        console.log('Extracted via data.base64');
        return { ok: true, base64: data.base64, seed: data.seed || 0 };
      }

      console.error('Unexpected Flux response for "' + prompt.substring(0, 60) + '": ' + JSON.stringify(data).substring(0, 300));
      return { ok: false, error: 'No image in flux response' };
    }).catch(function(err) {
      var detail = err.response ? JSON.stringify(err.response.data).substring(0, 200) : err.message;
      console.error('Flux error for "' + prompt.substring(0, 60) + '": ' + detail);
      return { ok: false, error: err.message };
    });
  });

  return Promise.all(requests);
}

app.post('/api/auth', function(req, res) {
  var email = (req.body.email || '').trim();
  if (!email || !validateEmail(email)) {
    return res.json({ ok: false, error: 'Valid email required' });
  }

  if (!db) {
    return res.json({ ok: true, email: email });
  }

  return db`INSERT INTO users (email, last_login)
    VALUES (${email}, NOW())
    ON CONFLICT (email) DO UPDATE SET last_login = NOW()
    RETURNING *`.then(function(rows) {
    return res.json({ ok: true, email: rows[0].email });
  }).catch(function(err) {
    console.error('Auth DB error:', err.message);
    return res.json({ ok: true, email: email });
  });
});

app.post('/api/generate', upload.array('references', 4), function(req, res) {
  var client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  var prompt = (req.body.prompt || '').trim();
  var format = (req.body.format || 'concept').trim();
  var moods = req.body.moods || '';
  var colors = req.body.colors || '';

  if (!prompt) {
    return res.json({ ok: false, error: 'Prompt is required' });
  }

  var moodList = Array.isArray(moods) ? moods.join(', ') : moods;
  var colorList = Array.isArray(colors) ? colors.join(', ') : colors;

  var systemPrompts = {
    concept: 'You are a senior creative director. Generate a detailed creative concept with sections: CONCEPT OVERVIEW, VISUAL DIRECTION, TONE & VOICE, KEY THEMES, EXECUTION IDEAS. Use clear headers and bullet points.',
    moodboard: 'You are a visual creative director. Generate exactly 4 distinct image prompts for a moodboard, each on its own line prefixed with "IMAGE PROMPT:". After the prompts, add a MOODBOARD CONCEPT section describing the overall visual direction.',
    styleguide: 'You are a brand designer. Generate a comprehensive style guide with sections: BRAND PERSONALITY, COLOR PALETTE (with hex codes), TYPOGRAPHY, IMAGERY STYLE, TONE OF VOICE, DO\'S AND DON\'TS.',
    copywriting: 'You are a senior copywriter. Generate compelling copy with sections: HEADLINE OPTIONS (5 variations), TAGLINE OPTIONS (5 variations), BODY COPY, CALL TO ACTION OPTIONS, KEY MESSAGES.',
    campaign: 'You are a campaign strategist. Generate a full campaign plan with sections: CAMPAIGN CONCEPT, TARGET AUDIENCE, KEY MESSAGES, CHANNEL STRATEGY, CONTENT PILLARS, CAMPAIGN PHASES, SUCCESS METRICS.'
  };

  var systemPrompt = systemPrompts[format] || systemPrompts.concept;

  var userMessage = 'Create ' + format + ' for the following brief:\n\n' + prompt;
  if (moodList) userMessage += '\n\nMood/Tone: ' + moodList;
  if (colorList) userMessage += '\nColor Preferences: ' + colorList;

  if (req.files && req.files.length > 0) {
    userMessage += '\n\nReference images have been provided (' + req.files.length + ' image(s)). Consider their visual style, composition, and aesthetic in your creative direction.';
  }

  var messageContent = [{ type: 'text', text: userMessage }];

  if (req.files && req.files.length > 0) {
    req.files.forEach(function(file) {
      messageContent.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: file.mimetype,
          data: file.buffer.toString('base64')
        }
      });
    });
  }

  client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: messageContent }]
  }).then(function(response) {
    var text = response.content[0].text;

    if (format !== 'moodboard') {
      return res.json({ ok: true, output: text, format: format, images: [] });
    }

    var lines = text.split('\n');
    var imagePrompts = [];
    lines.forEach(function(line) {
      if (line.indexOf('IMAGE PROMPT:') === 0) {
        imagePrompts.push(line.replace('IMAGE PROMPT:', '').trim());
      }
    });

    console.log('Extracted ' + imagePrompts.length + ' image prompts from moodboard response');

    if (imagePrompts.length === 0) {
      return res.json({ ok: true, output: text, format: format, images: [] });
    }

    return generateMoodboardImages(imagePrompts).then(function(imageResults) {
      var images = imageResults.filter(function(r) { return r.ok; }).map(function(r) {
        return { base64: r.base64, seed: r.seed };
      });
      console.log('Moodboard complete: ' + images.length + '/' + imagePrompts.length + ' images succeeded');
      return res.json({ ok: true, output: text, format: format, images: images });
    });
  }).catch(function(err) {
    console.error('Generate error:', err.message);
    return res.json({ ok: false, error: 'Generation failed: ' + err.message });
  });
});

app.post('/api/save', function(req, res) {
  if (!db) {
    return res.status(503).json({ ok: false, error: 'Database not available' });
  }
  var email = (req.body.email || '').trim();
  var prompt = (req.body.prompt || '').trim();
  var output = (req.body.output || '').trim();
  var format = (req.body.format || 'concept').trim();

  if (!email || !prompt || !output) {
    return res.json({ ok: false, error: 'email, prompt, and output are required' });
  }

  var now = Date.now();
  db`INSERT INTO conversations (user_email, prompt, output, format, created_at)
     VALUES (${email}, ${prompt}, ${output}, ${format}, ${now})
     RETURNING *`.then(function(rows) {
    return res.json({ ok: true, record: rows[0] });
  }).catch(function(err) {
    console.error('Save error:', err.message);
    return res.json({ ok: false, error: 'Save failed' });
  });
});

app.get('/api/history', function(req, res) {
  if (!db) {
    return res.status(503).json({ ok: false, error: 'Database not available' });
  }
  var email = (req.query.email || '').trim();
  if (!email) {
    return res.json({ ok: false, error: 'email is required' });
  }

  db`SELECT * FROM conversations WHERE user_email = ${email} ORDER BY created_at DESC LIMIT 50`.then(function(rows) {
    return res.json({ ok: true, history: rows });
  }).catch(function(err) {
    console.error('History error:', err.message);
    return res.json({ ok: false, error: 'Failed to load history' });
  });
});

app.delete('/api/delete/:id', function(req, res) {
  if (!db) {
    return res.status(503).json({ ok: false, error: 'Database not available' });
  }
  var id = parseInt(req.params.id);
  var email = (req.query.email || '').trim();

  if (!id || !email) {
    return res.json({ ok: false, error: 'id and email are required' });
  }

  db`DELETE FROM conversations WHERE id = ${id} AND user_email = ${email} RETURNING id`.then(function(rows) {
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Record not found' });
    }
    return res.json({ ok: true, deleted: rows[0].id });
  }).catch(function(err) {
    console.error('Delete error:', err.message);
    return res.json({ ok: false, error: 'Delete failed' });
  });
});

app.get('/', function(req, res) {
  var html = '<!DOCTYPE html>\n';
  html += '<html lang="en">\n';
  html += '<head>\n';
  html += '  <meta charset="UTF-8">\n';
  html += '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n';
  html += '  <title>AI Art Director</title>\n';
  html += '  <link rel="preconnect" href="https://fonts.googleapis.com">\n';
  html += '  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">\n';
  html += '  <link rel="stylesheet" href="/style.css">\n';
  html += '</head>\n';
  html += '<body>\n';
  html += '  <div id="app">\n';
  html += '    <nav class="navbar">\n';
  html += '      <div class="nav-brand">\n';
  html += '        <span class="brand-icon">&#127912;</span>\n';
  html += '        <span class="brand-name">AI Art Director</span>\n';
  html += '      </div>\n';
  html += '      <div class="nav-actions" id="navActions"></div>\n';
  html += '    </nav>\n';
  html += '\n';
  html += '    <div id="authScreen" class="screen active">\n';
  html += '      <div class="auth-container">\n';
  html += '        <div class="auth-card">\n';
  html += '          <h1>AI Art Director</h1>\n';
  html += '          <p class="auth-subtitle">Your creative intelligence engine</p>\n';
  html += '          <div class="form-group">\n';
  html += '            <label for="emailInput">Enter your email to begin</label>\n';
  html += '            <input type="email" id="emailInput" placeholder="you@example.com" />\n';
  html += '          </div>\n';
  html += '          <button class="btn-primary" id="authBtn">Get Started</button>\n';
  html += '          <div id="authError" class="error-msg" hidden></div>\n';
  html += '        </div>\n';
  html += '      </div>\n';
  html += '    </div>\n';
  html += '\n';
  html += '    <div id="mainScreen" class="screen">\n';
  html += '      <div class="main-layout">\n';
  html += '        <aside class="sidebar" id="sidebar">\n';
  html += '          <div class="sidebar-header">\n';
  html += '            <h3>History</h3>\n';
  html += '            <button class="btn-icon" id="newProjectBtn" title="New project">+</button>\n';
  html += '          </div>\n';
  html += '          <div class="history-list" id="historyList"></div>\n';
  html += '        </aside>\n';
  html += '\n';
  html += '        <main class="workspace">\n';
  html += '          <div class="input-panel">\n';
  html += '            <div class="format-tabs" id="formatTabs">\n';
  html += '              <button class="tab active" data-format="concept">Concept</button>\n';
  html += '              <button class="tab" data-format="moodboard">Moodboard</button>\n';
  html += '              <button class="tab" data-format="styleguide">Style Guide</button>\n';
  html += '              <button class="tab" data-format="copywriting">Copywriting</button>\n';
  html += '              <button class="tab" data-format="campaign">Campaign</button>\n';
  html += '            </div>\n';
  html += '\n';
  html += '            <div class="prompt-area">\n';
  html += '              <textarea id="promptInput" placeholder="Describe your creative brief..." rows="4"></textarea>\n';
  html += '            </div>\n';
  html += '\n';
  html += '            <div class="options-row">\n';
  html += '              <div class="mood-tags" id="moodTags">\n';
  html += '                <span class="options-label">Mood:</span>\n';
  html += '                <button class="tag" data-mood="Bold">Bold</button>\n';
  html += '                <button class="tag" data-mood="Minimal">Minimal</button>\n';
  html += '                <button class="tag" data-mood="Playful">Playful</button>\n';
  html += '                <button class="tag" data-mood="Elegant">Elegant</button>\n';
  html += '                <button class="tag" data-mood="Edgy">Edgy</button>\n';
  html += '                <button class="tag" data-mood="Warm">Warm</button>\n';
  html += '                <button class="tag" data-mood="Cool">Cool</button>\n';
  html += '                <button class="tag" data-mood="Organic">Organic</button>\n';
  html += '              </div>\n';
  html += '            </div>\n';
  html += '\n';
  html += '            <div class="options-row">\n';
  html += '              <div class="color-tags" id="colorTags">\n';
  html += '                <span class="options-label">Colors:</span>\n';
  html += '                <button class="tag" data-color="Monochrome">Monochrome</button>\n';
  html += '                <button class="tag" data-color="Earth tones">Earth tones</button>\n';
  html += '                <button class="tag" data-color="Pastels">Pastels</button>\n';
  html += '                <button class="tag" data-color="Vibrant">Vibrant</button>\n';
  html += '                <button class="tag" data-color="Dark &amp; moody">Dark &amp; moody</button>\n';
  html += '                <button class="tag" data-color="Neon">Neon</button>\n';
  html += '              </div>\n';
  html += '            </div>\n';
  html += '\n';
  html += '            <div class="upload-area" id="uploadArea">\n';
  html += '              <input type="file" id="fileInput" multiple accept="image/*" style="display:none">\n';
  html += '              <div class="upload-prompt" id="uploadPrompt">\n';
  html += '                <span class="upload-icon">&#128206;</span>\n';
  html += '                <span>Drop reference images or <button class="btn-link" id="browseBtn">browse</button></span>\n';
  html += '              </div>\n';
  html += '              <div class="file-chips" id="fileChips"></div>\n';
  html += '            </div>\n';
  html += '\n';
  html += '            <div class="generate-row">\n';
  html += '              <button class="btn-primary btn-generate" id="generateBtn">Generate</button>\n';
  html += '              <div id="generateError" class="error-msg" hidden></div>\n';
  html += '            </div>\n';
  html += '          </div>\n';
  html += '\n';
  html += '          <div class="output-panel" id="outputPanel"></div>\n';
  html += '        </main>\n';
  html += '      </div>\n';
  html += '    </div>\n';
  html += '  </div>\n';
  html += '  <script src="/app.js"></script>\n';
  html += '</body>\n';
  html += '</html>\n';
  res.send(html);
});

initDb().then(function() {
  app.listen(PORT, '0.0.0.0', function() {
    console.log('Server running on port ' + PORT);
  });
});
