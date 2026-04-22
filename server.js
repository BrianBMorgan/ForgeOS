var express = require('express');
var path = require('path');
var { neon } = require('@neondatabase/serverless');

var app = express();
var PORT = process.env.PORT || 3000;
var DB_URL = process.env.XM_DEMAND_DATABASE_URL || process.env.DATABASE_URL || process.env.NEON_DATABASE_URL;

app.use(express.json({ limit: '2mb' }));

var sql = null;
if (DB_URL) {
  sql = neon(DB_URL);
  console.log('[xm-demand] Neon connected');
} else {
  console.log('[xm-demand] No DB URL — running in read-only seed mode');
}

// ---- Seed content: Sandbox-XM positioning + starter board data ----
var SEED_PERSONAS = [
  { title: 'Head of Brand Experience', company_type: 'Mid-to-large consumer brand', pain: 'Brand activations feel generic; struggle to translate brand voice into real-world moments that resonate.', trigger: 'New product launch, flagship event, brand repositioning, or founder-led campaign.', value_prop: 'Human-centered experiential design that makes the brand feel intentional and alive, not staged.' },
  { title: 'VP of Marketing / CMO', company_type: 'B2B SaaS, wellness, hospitality, premium DTC', pain: 'Trade shows and events underperform; no lasting narrative beyond the badge scan.', trigger: 'Annual event strategy planning, budget allocation Q4/Q1, competitive positioning shift.', value_prop: 'Strategic experience design tied to demand — measurable audience insight and story-driven brand lift.' },
  { title: 'Director of Events / Experiential', company_type: 'Enterprise, tech, lifestyle brands', pain: 'Vendors deliver production, not ideas. Needs a partner who thinks strategy-first.', trigger: 'RFP cycle, new hire in role, poor feedback from last activation.', value_prop: 'We start with the audience question, not the floorplan. Every decision laddered to brand meaning.' },
  { title: 'Founder / Head of Marketing', company_type: 'Growth-stage brands ($5M–$50M revenue)', pain: 'Limited bandwidth; needs an experiential partner who can own the full arc.', trigger: 'Series B/C raise, category launch, founder visibility push.', value_prop: 'Embedded creative partnership — we operate like an extension of your team, not a transactional vendor.' }
];

var SEED_CHANNELS = [
  { name: 'LinkedIn Thought Leadership', motion: 'Founder-led posts 3x/week on experiential strategy, audience psychology, brand storytelling. Less promo, more point-of-view.', priority: 'HIGH', status: 'active', next_action: 'Draft content pillars: (1) experience design critique, (2) behind-the-scenes builds, (3) industry trend POVs, (4) client wins.' },
  { name: 'Strategic Partnerships', motion: 'Co-sell with adjacent agencies (brand strategy, PR, venue designers) where we fill the experiential gap.', priority: 'HIGH', status: 'planning', next_action: 'Map 15 target agency partners. Open with 3 warm intros to pilot referral flow.' },
  { name: 'Targeted Outbound', motion: 'Highly researched, 1:1 outreach to named accounts — never volume blasts. Reference specific activations they have run or should run.', priority: 'MED', status: 'planning', next_action: 'Build ICP list of 50 accounts. Write 5 hyper-personalized opens as templates.' },
  { name: 'Earned Press & Case Studies', motion: 'Publish long-form case studies on site; pitch trade press (Event Marketer, AdAge, Campaign US) when we ship a notable project.', priority: 'MED', status: 'planning', next_action: 'Identify 2 existing projects ready for case study treatment. Commission photography/film if needed.' },
  { name: 'Industry Events & Speaking', motion: 'Apply to speak at EventMB, BizBash, SXSW, Cannes fringe — not to attend, to lead a track.', priority: 'LOW', status: 'planning', next_action: 'Identify 3 speaking applications for next cycle. Build signature talk: "Experience as Operating System."' },
  { name: 'Portfolio & Website', motion: 'Ensure the Sandbox-XM public site shows work with depth — process, intent, outcomes. Not a gallery, a point of view.', priority: 'HIGH', status: 'active', next_action: 'Audit current case studies for depth. Add 2 new project breakdowns with real metrics.' }
];

var SEED_ACCOUNTS = [
  { company: 'Patagonia', category: 'Lifestyle / Outdoor', stage: 'prospect', notes: 'Values-driven brand, environmental storytelling, high bar for experiential authenticity.' },
  { company: 'Oatly', category: 'Consumer / F&B', stage: 'prospect', notes: 'Quirky brand voice translates well to experiential; likely active event calendar.' },
  { company: 'Arc\'teryx', category: 'Lifestyle / Outdoor', stage: 'prospect', notes: 'Recent retail theater focus — could extend to owned experiences.' },
  { company: 'Notion', category: 'B2B SaaS', stage: 'prospect', notes: 'Founder-led brand, strong community energy, user conferences growing.' },
  { company: 'Figma (Config)', category: 'B2B SaaS', stage: 'researching', notes: 'Massive annual conference — study how they stage community over product.' },
  { company: 'Aesop', category: 'Premium DTC / Beauty', stage: 'prospect', notes: 'Retail = experience already. Opportunity in launches and editorial moments.' },
  { company: 'Equinox', category: 'Wellness / Hospitality', stage: 'prospect', notes: 'Member events, seasonal programming — fits XM sensibility.' },
  { company: 'Mailchimp', category: 'B2B SaaS', stage: 'prospect', notes: 'Freddie brand still playful; SMB events and creator partnerships are ongoing.' }
];

var SEED_PLAYBOOKS = [
  { title: 'The Signature Activation Pitch', summary: 'Lead with a single, concept-led pitch for one flagship moment per brand — a hero experience that anchors their year.', steps: '1. Identify the brand\'s unanswered audience question. 2. Design one activation that makes the brand feel inevitable. 3. Show the story architecture before the build. 4. Quote scope tied to narrative outcome, not just deliverables.' },
  { title: 'The Discovery Workshop Wedge', summary: 'Offer a paid half-day brand experience workshop as a low-friction first engagement that leads to scoped work.', steps: '1. Package a 4-hour working session (audience mapping + experience opportunity audit). 2. Price as a discrete deliverable ($7.5K–$15K). 3. Deliverable = a one-page "Experience Thesis." 4. 60%+ should convert to larger project.' },
  { title: 'The Founder-to-Founder Channel', summary: 'When Brian connects directly with founders/CMOs through LinkedIn, warm intros, or event rooms — never hand off too early.', steps: '1. Keep Brian in the loop through first meeting. 2. Bring creative lead to second meeting with early thinking. 3. Send a sharp one-pager within 48 hours of first call. 4. Never pitch credentials; pitch a perspective on their business.' },
  { title: 'Case Study Flywheel', summary: 'Every project ships with a case study asset set — long-form, film, social cutdowns — that feeds every channel.', steps: '1. Scope documentation into every SOW from day one. 2. Capture process photo/video throughout. 3. Publish within 30 days of wrap. 4. Pitch to 3 trade publications on publish day.' }
];

async function ensureSchema() {
  if (!sql) return;
  await sql('CREATE TABLE IF NOT EXISTS personas (id SERIAL PRIMARY KEY, title TEXT, company_type TEXT, pain TEXT, trigger TEXT, value_prop TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())');
  await sql('CREATE TABLE IF NOT EXISTS channels (id SERIAL PRIMARY KEY, name TEXT, motion TEXT, priority TEXT, status TEXT, next_action TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())');
  await sql('CREATE TABLE IF NOT EXISTS accounts (id SERIAL PRIMARY KEY, company TEXT, category TEXT, stage TEXT, notes TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())');
  await sql('CREATE TABLE IF NOT EXISTS playbooks (id SERIAL PRIMARY KEY, title TEXT, summary TEXT, steps TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())');
  await sql('CREATE TABLE IF NOT EXISTS notes (id SERIAL PRIMARY KEY, body TEXT, author TEXT, created_at TIMESTAMPTZ DEFAULT NOW())');

  var counts = await sql('SELECT (SELECT COUNT(*) FROM personas) AS p, (SELECT COUNT(*) FROM channels) AS c, (SELECT COUNT(*) FROM accounts) AS a, (SELECT COUNT(*) FROM playbooks) AS b');
  var row = counts[0];
  if (Number(row.p) === 0) {
    for (var i = 0; i < SEED_PERSONAS.length; i++) {
      var p = SEED_PERSONAS[i];
      await sql('INSERT INTO personas (title, company_type, pain, trigger, value_prop) VALUES ($1,$2,$3,$4,$5)', [p.title, p.company_type, p.pain, p.trigger, p.value_prop]);
    }
  }
  if (Number(row.c) === 0) {
    for (var j = 0; j < SEED_CHANNELS.length; j++) {
      var c = SEED_CHANNELS[j];
      await sql('INSERT INTO channels (name, motion, priority, status, next_action) VALUES ($1,$2,$3,$4,$5)', [c.name, c.motion, c.priority, c.status, c.next_action]);
    }
  }
  if (Number(row.a) === 0) {
    for (var k = 0; k < SEED_ACCOUNTS.length; k++) {
      var a = SEED_ACCOUNTS[k];
      await sql('INSERT INTO accounts (company, category, stage, notes) VALUES ($1,$2,$3,$4)', [a.company, a.category, a.stage, a.notes]);
    }
  }
  if (Number(row.b) === 0) {
    for (var m = 0; m < SEED_PLAYBOOKS.length; m++) {
      var pb = SEED_PLAYBOOKS[m];
      await sql('INSERT INTO playbooks (title, summary, steps) VALUES ($1,$2,$3)', [pb.title, pb.summary, pb.steps]);
    }
  }
  console.log('[xm-demand] Schema ready, seed verified');
}

ensureSchema().catch(function(e) { console.error('[xm-demand] Schema error:', e.message); });

// ---- Static ----
app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ---- API ----
function requireDb(res) {
  if (!sql) {
    res.status(503).json({ ok: false, error: 'Database not configured. Set XM_DEMAND_DATABASE_URL.' });
    return false;
  }
  return true;
}

// GET all data
app.get('/api/state', function(req, res) {
  if (!requireDb(res)) return;
  Promise.all([
    sql('SELECT * FROM personas ORDER BY id'),
    sql('SELECT * FROM channels ORDER BY CASE priority WHEN \'HIGH\' THEN 1 WHEN \'MED\' THEN 2 ELSE 3 END, id'),
    sql('SELECT * FROM accounts ORDER BY id'),
    sql('SELECT * FROM playbooks ORDER BY id'),
    sql('SELECT * FROM notes ORDER BY created_at DESC LIMIT 50')
  ]).then(function(r) {
    res.json({ ok: true, personas: r[0], channels: r[1], accounts: r[2], playbooks: r[3], notes: r[4] });
  }).catch(function(e) {
    console.error('[state]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  });
});

// Generic update handler
function updateRow(table, allowed, req, res) {
  if (!requireDb(res)) return;
  var id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ ok: false, error: 'Bad id' });
  var fields = [];
  var values = [];
  var idx = 1;
  for (var key in req.body) {
    if (allowed.indexOf(key) !== -1) {
      fields.push(key + ' = $' + idx);
      values.push(req.body[key]);
      idx++;
    }
  }
  if (!fields.length) return res.status(400).json({ ok: false, error: 'No valid fields' });
  fields.push('updated_at = NOW()');
  values.push(id);
  var q = 'UPDATE ' + table + ' SET ' + fields.join(', ') + ' WHERE id = $' + idx + ' RETURNING *';
  sql(q, values).then(function(r) {
    res.json({ ok: true, row: r[0] });
  }).catch(function(e) {
    console.error('[update ' + table + ']', e.message);
    res.status(500).json({ ok: false, error: e.message });
  });
}

app.patch('/api/personas/:id', function(req, res) {
  updateRow('personas', ['title', 'company_type', 'pain', 'trigger', 'value_prop'], req, res);
});
app.patch('/api/channels/:id', function(req, res) {
  updateRow('channels', ['name', 'motion', 'priority', 'status', 'next_action'], req, res);
});
app.patch('/api/accounts/:id', function(req, res) {
  updateRow('accounts', ['company', 'category', 'stage', 'notes'], req, res);
});
app.patch('/api/playbooks/:id', function(req, res) {
  updateRow('playbooks', ['title', 'summary', 'steps'], req, res);
});

// Create account
app.post('/api/accounts', function(req, res) {
  if (!requireDb(res)) return;
  var b = req.body || {};
  sql('INSERT INTO accounts (company, category, stage, notes) VALUES ($1,$2,$3,$4) RETURNING *', [b.company || 'New Account', b.category || '', b.stage || 'prospect', b.notes || '']).then(function(r) {
    res.json({ ok: true, row: r[0] });
  }).catch(function(e) { res.status(500).json({ ok: false, error: e.message }); });
});

// Delete account
app.delete('/api/accounts/:id', function(req, res) {
  if (!requireDb(res)) return;
  var id = parseInt(req.params.id, 10);
  sql('DELETE FROM accounts WHERE id = $1', [id]).then(function() {
    res.json({ ok: true });
  }).catch(function(e) { res.status(500).json({ ok: false, error: e.message }); });
});

// Notes — append-only strategy notes
app.post('/api/notes', function(req, res) {
  if (!requireDb(res)) return;
  var b = req.body || {};
  if (!b.body || !b.body.trim()) return res.status(400).json({ ok: false, error: 'Note body required' });
  sql('INSERT INTO notes (body, author) VALUES ($1,$2) RETURNING *', [b.body.trim(), (b.author || 'Brian').trim()]).then(function(r) {
    res.json({ ok: true, row: r[0] });
  }).catch(function(e) { res.status(500).json({ ok: false, error: e.message }); });
});

app.delete('/api/notes/:id', function(req, res) {
  if (!requireDb(res)) return;
  var id = parseInt(req.params.id, 10);
  sql('DELETE FROM notes WHERE id = $1', [id]).then(function() {
    res.json({ ok: true });
  }).catch(function(e) { res.status(500).json({ ok: false, error: e.message }); });
});

app.listen(PORT, '0.0.0.0', function() {
  console.log('[xm-demand] listening on 0.0.0.0:' + PORT);
});
