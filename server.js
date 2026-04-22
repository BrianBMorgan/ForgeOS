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
  { title: 'VP of Marketing / CMO', company_type: 'Mid-market B2B SaaS ($50M–$500M revenue, Series B–D)', pain: 'User conferences and customer summits underperform — they feel like product demos in a ballroom, not industry-defining moments. Marketing team is stretched thin.', trigger: 'Annual conference on the roadmap, Series C/D raise, category positioning shift, new CMO setting brand agenda.', value_prop: 'A strategic experience partner who treats the flagship event as a brand moment, not a production job. Audience-first thinking tied to pipeline outcomes.' },
  { title: 'Head of Brand / Brand Marketing Lead', company_type: 'Design-led B2B SaaS — fintech, devtools, GTM, compliance', pain: 'Brand lives beautifully on the site and in product, but goes generic the moment it enters a physical room. No experiential partner who gets the aesthetic bar.', trigger: 'User conference, customer advisory board, executive dinners series, category launch, field marketing expansion.', value_prop: 'We match the design maturity of modern B2B brands — the room feels like the brand, not like a trade show. Every choice is deliberate.' },
  { title: 'Director of Events / Field Marketing', company_type: 'Growth-stage B2B tech with 5–20 person marketing team', pain: 'Running 20+ events a year with a tiny team. Needs a creative+strategic partner who can own flagship moments end-to-end, not a vendor to manage.', trigger: 'Hiring freeze + growth targets, flagship event underperformed, new VP demanding measurable brand lift from events budget.', value_prop: 'Embedded partnership model. We operate like an extension of the team — concept, design, production, narrative — so internal team can focus on the rest of the calendar.' },
  { title: 'Founder / Category-Creator CEO', company_type: 'Founder-led B2B (~$20M–$200M ARR) where the founder IS the brand', pain: 'The founder is the story but there\'s no signature moment that scales their POV. Keynotes feel like marketing, not movement.', trigger: 'Category definition push, book launch, executive visibility strategy, IPO prep, competitive narrative shift.', value_prop: 'We design signature founder-led moments — the kind that get written about and remembered. Part thought leadership, part theater, part manifesto.' }
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
  { company: 'Vanta', category: 'B2B SaaS — Compliance', stage: 'prospect', notes: 'Series C, rebranded 2024, runs customer summits (VantaCon). Marketing team visibly investing in brand. Fit: user conference elevation + customer dinners series.' },
  { company: 'Ramp', category: 'B2B SaaS — Fintech', stage: 'prospect', notes: 'Founder-led brand (Eric Glyman), strong design taste, runs Ramp-hosted events. Already respects design-led partners. Fit: founder visibility moments, customer advisory dinners.' },
  { company: 'Gusto', category: 'B2B SaaS — HR/Payroll', stage: 'prospect', notes: 'Mid-market, SMB-focused, plays in partner + accountant events. Warm to creative partners. Fit: channel partner summit redesign.' },
  { company: 'Webflow', category: 'B2B SaaS — Design tools', stage: 'prospect', notes: 'Design-forward brand, Webflow Conf is growing. Conference is their annual moment — ripe for creative elevation. Fit: Webflow Conf content + staging partnership.' },
  { company: 'Retool', category: 'B2B SaaS — Internal tools', stage: 'prospect', notes: 'Developer-first brand with a growing marketing arm. RetoolCon is young. Fit: shape the conference identity while it\'s still forming.' },
  { company: 'Linear', category: 'B2B SaaS — Project mgmt', stage: 'prospect', notes: 'Design-obsessed, small team, founder-visible (Karri Saarinen). Hosts launches and curated meetups. Fit: launch events + founder-led signature moment.' },
  { company: 'Attio', category: 'B2B SaaS — CRM', stage: 'prospect', notes: 'Series B, design-first, European aesthetic, expanding U.S. presence. No established event presence in U.S. yet. Fit: U.S. launch moment + founder intro dinners.' },
  { company: 'Clay', category: 'B2B SaaS — GTM data', stage: 'prospect', notes: 'On fire right now, runs community/creator events (Clay Labs), tiny marketing team that outsources creative. Fit: flagship community summit + GTM thought leadership theater.' },
  { company: 'Mercury', category: 'B2B SaaS — Business banking', stage: 'prospect', notes: 'Beautiful brand, founder-led (Immad Akhund), runs founder dinners and events. Growth mode. Fit: founder-to-founder dinner series, flagship customer moment.' }
];

var SEED_PLAYBOOKS = [
  { title: 'The Signature Activation Pitch', summary: 'Lead with a single, concept-led pitch for one flagship moment per brand — a hero experience that anchors their year.', steps: '1. Identify the brand\'s unanswered audience question. 2. Design one activation that makes the brand feel inevitable. 3. Show the story architecture before the build. 4. Quote scope tied to narrative outcome, not just deliverables.' },
  { title: 'The Discovery Workshop Wedge', summary: 'Offer a paid half-day brand experience workshop as a low-friction first engagement that leads to scoped work.', steps: '1. Package a 4-hour working session (audience mapping + experience opportunity audit). 2. Price as a discrete deliverable ($7.5K–$15K). 3. Deliverable = a one-page "Experience Thesis." 4. 60%+ should convert to larger project.' },
  { title: 'The Founder-to-Founder Channel', summary: 'When Brian connects directly with founders/CMOs through LinkedIn, warm intros, or event rooms — never hand off too early.', steps: '1. Keep Brian in the loop through first meeting. 2. Bring creative lead to second meeting with early thinking. 3. Send a sharp one-pager within 48 hours of first call. 4. Never pitch credentials; pitch a perspective on their business.' },
  { title: 'Case Study Flywheel', summary: 'Every project ships with a case study asset set — long-form, film, social cutdowns — that feeds every channel.', steps: '1. Scope documentation into every SOW from day one. 2. Capture process photo/video throughout. 3. Publish within 30 days of wrap. 4. Pitch to 3 trade publications on publish day.' }
];

// ---- First pitch: Oatly — Signature Activation ----
var OATLY_CONCEPT = [
  'THE OAT REPORT — Oatly\'s first annual cultural moment.',
  '',
  'A one-day, invite-only summit in NYC or LA where Oatly publishes its annual "State of the Oat" — part cultural report, part tasting experience, part provocation.',
  '',
  'Guests: food press, chefs, cultural critics, longtime fans, dissenting voices. Deliverable: a printed editorial report + a live experience that IS the launch of the report. It recurs annually. It becomes the thing they own.',
  '',
  'WHY IT WINS',
  '— Ladders to their brand voice (opinionated, literate, funny)',
  '— Creates owned media (the report) + earned media (the event) in one motion',
  '— Scales: year two is bigger than year one, by design',
  '— Pitch-sized: one hero moment, not a retainer ask',
  '',
  'THE AUDIENCE QUESTION WE\'RE ANSWERING',
  'How does a challenger dairy-alt brand stay culturally sharp once it\'s mainstream? The Oat Report is their answer — a platform to keep provoking, observing, and leading the conversation rather than defending share.'
].join('\n');

var OATLY_ONELINER = 'An invite-only annual summit where Oatly publishes "The Oat Report" — the cultural document the plant-based movement has been waiting for, delivered as a hero experience.';

var OATLY_EMAIL = [
  'Subject: An annual moment for Oatly — a concept, not a pitch deck',
  '',
  'Hi [First name],',
  '',
  'I run Sandbox-XM — we design brand experiences for teams who believe the room is strategy, not staging.',
  '',
  'I\'m writing because Oatly is one of maybe five brands in the world whose voice could carry a full-scale owned cultural moment, and as far as I can tell you haven\'t built one yet. You do sampling brilliantly. You do stunts. You do packaging as manifesto. But there isn\'t a single day of the year the industry waits for from Oatly — and there should be.',
  '',
  'The rough idea: an invite-only annual summit where Oatly publishes "The Oat Report" — part cultural audit of the plant-based movement, part tasting experience, part provocation. Food press, chefs, critics, superfans. A printed editorial report as the artifact. An evening that IS the launch. Year one sets the franchise. Year two is bigger by design.',
  '',
  'It answers a real tension: how does Oatly stay the loudest challenger now that the category caught up? The Oat Report keeps you leading the conversation instead of defending share.',
  '',
  'I\'m not looking to send a deck or get on a procurement list. I\'d like 25 minutes to walk you through the concept — if it\'s not for you, you\'ll at least have a framework to hand to whoever does build it.',
  '',
  'Worth a conversation?',
  '',
  'Brian',
  'Sandbox-XM',
  '[phone] · [site]'
].join('\n');

var SEED_PITCHES = [
  {
    target_company: 'Oatly',
    play: 'Signature Activation Pitch',
    concept_title: 'The Oat Report',
    one_liner: OATLY_ONELINER,
    concept: OATLY_CONCEPT,
    contact_name: '',
    contact_role: 'Head of Brand / CMO / Global Creative Director',
    outbound_draft: OATLY_EMAIL,
    status: 'drafting',
    next_action: 'Identify the right contact at Oatly (LinkedIn: Head of Brand, Creative Director, or CMO). Finalize subject line A/B. Send within 5 business days.'
  }
];

async function ensureSchema() {
  if (!sql) return;
  await sql('CREATE TABLE IF NOT EXISTS personas (id SERIAL PRIMARY KEY, title TEXT, company_type TEXT, pain TEXT, trigger TEXT, value_prop TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())');
  await sql('CREATE TABLE IF NOT EXISTS channels (id SERIAL PRIMARY KEY, name TEXT, motion TEXT, priority TEXT, status TEXT, next_action TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())');
  await sql('CREATE TABLE IF NOT EXISTS accounts (id SERIAL PRIMARY KEY, company TEXT, category TEXT, stage TEXT, notes TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())');
  await sql('CREATE TABLE IF NOT EXISTS playbooks (id SERIAL PRIMARY KEY, title TEXT, summary TEXT, steps TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())');
  await sql('CREATE TABLE IF NOT EXISTS notes (id SERIAL PRIMARY KEY, body TEXT, author TEXT, created_at TIMESTAMPTZ DEFAULT NOW())');
  await sql('CREATE TABLE IF NOT EXISTS pitches (id SERIAL PRIMARY KEY, target_company TEXT, play TEXT, concept_title TEXT, one_liner TEXT, concept TEXT, contact_name TEXT, contact_role TEXT, outbound_draft TEXT, status TEXT, next_action TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())');

  var counts = await sql('SELECT (SELECT COUNT(*) FROM personas) AS p, (SELECT COUNT(*) FROM channels) AS c, (SELECT COUNT(*) FROM accounts) AS a, (SELECT COUNT(*) FROM playbooks) AS b, (SELECT COUNT(*) FROM pitches) AS pt');
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
  if (Number(row.pt) === 0) {
    for (var n = 0; n < SEED_PITCHES.length; n++) {
      var pt = SEED_PITCHES[n];
      await sql(
        'INSERT INTO pitches (target_company, play, concept_title, one_liner, concept, contact_name, contact_role, outbound_draft, status, next_action) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [pt.target_company, pt.play, pt.concept_title, pt.one_liner, pt.concept, pt.contact_name, pt.contact_role, pt.outbound_draft, pt.status, pt.next_action]
      );
    }
  }

  // One-time refocus migration: clear the old consumer-leaning account list and reseed with mid-market B2B targets.
  // Guarded by a marker row so it only runs once.
  var marker = await sql("SELECT 1 FROM accounts WHERE company = 'Vanta' LIMIT 1");
  if (marker.length === 0) {
    console.log('[xm-demand] Running B2B refocus migration: clearing old accounts, reseeding');
    await sql('DELETE FROM accounts');
    for (var kk = 0; kk < SEED_ACCOUNTS.length; kk++) {
      var aa = SEED_ACCOUNTS[kk];
      await sql('INSERT INTO accounts (company, category, stage, notes) VALUES ($1,$2,$3,$4)', [aa.company, aa.category, aa.stage, aa.notes]);
    }
    // Also retire the Oatly pitch — it's off-strategy now. Keep it archived by marking passed so we don't lose the writing.
    await sql("UPDATE pitches SET status = 'passed', next_action = 'ARCHIVED: Off-strategy after B2B refocus. Concept preserved as reference for future consumer-brand opportunities.' WHERE target_company = 'Oatly'");
  }

  // Attio activation: move to researching + seed the Signature Activation pitch. Idempotent.
  var attioPitch = await sql("SELECT 1 FROM pitches WHERE target_company = 'Attio' LIMIT 1");
  if (attioPitch.length === 0) {
    console.log('[xm-demand] Activating Attio pitch');
    await sql("UPDATE accounts SET stage = 'researching', notes = $1 WHERE company = 'Attio'", [
      'ACTIVE PITCH: Signature Activation — "Ask More" — an invite-only NYC salon + annual GTM field guide. See Pitches tab for full concept + outbound draft. Why Attio wins: design-led positioning, no owned US moment yet, Series B/C inflection, ~80-person team = no agency gatekeepers, founder (Nicolas Sharp) is design-obsessed and publicly vocal.'
    ]);

    var ATTIO_CONCEPT = [
      'ASK MORE — Attio\'s first owned cultural moment.',
      '',
      'A one-night, invitation-only salon in New York for ~120 of the sharpest GTM operators, founders, and RevOps leaders in the ecosystem. Not a conference. Not a user summit. A salon — dinner, a curated conversation on the record, and a printed artifact attendees take home: "The Ask More Report" — an annual field guide to how the best GTM teams actually run.',
      '',
      'Every Attio value, made physical:',
      '— TASTE: the room, the food, the design, the print piece',
      '— DATA-DRIVEN: the report is original research (survey Attio\'s customer base + friends-of)',
      '— OPINIONATED: a stated POV about what\'s broken in modern GTM',
      '— BUILT FOR THE BEST TEAMS: the guest list IS the marketing',
      '',
      'THE ARC',
      'Year 1 — 120 people, one night, one report. Proof of concept.',
      'Year 2 — the report pre-sells the room. Waitlist forms.',
      'Year 3 — "Ask More" is a franchise. The thing Attio owns that Salesforce can never make.',
      '',
      'WHY IT WINS',
      '— Anti-scale, pro-signal. Opposite of Dreamforce/INBOUND — which is exactly the Attio brand argument.',
      '— Creates owned media (the report circulates for 12 months) + earned media (the room is the story) in one motion.',
      '— Costs a fraction of a single conference booth. 10x the reach and residual.',
      '— Fully on-brand: reading the concept IS the demo of why Sandbox-XM is the right partner.',
      '',
      'THE AUDIENCE QUESTION WE\'RE ANSWERING',
      'How does Attio — the opinionated, design-led challenger to Salesforce — make its POV physical in the U.S. market without imitating the incumbents? "Ask More" is the answer: a small room, a sharp report, and a franchise that rewards taste over scale.'
    ].join('\n');

    var ATTIO_ONELINER = 'A one-night NYC salon + annual printed field guide — "The Ask More Report" — that turns Attio\'s design-led, opinionated POV into an owned cultural moment the best GTM teams will want on their calendar.';

    var ATTIO_EMAIL = [
      'Subject: The moment Attio doesn\'t have yet',
      '',
      'Hi [First name],',
      '',
      'I run Sandbox-XM. We design brand experiences for teams who believe the room is strategy, not staging. I\'m writing with a concept, not a pitch deck.',
      '',
      'Attio is one of the few B2B brands whose voice could carry an owned cultural moment in the U.S. — and as far as I can tell, you haven\'t built one. Salesforce has Dreamforce. HubSpot has INBOUND. Attio has a beautiful product page and very good taste, and that\'s a gap worth closing on your own terms.',
      '',
      'The idea: one night in New York. 120 people — the sharpest GTM operators, founders, and RevOps leaders in the ecosystem. A curated dinner conversation on the record. A printed artifact everyone takes home: "The Ask More Report" — an annual field guide to how the best GTM teams actually run, built from original research across your customer base and friends-of.',
      '',
      'Every Attio value, made physical. Taste in the room. Data in the report. A stated POV about what\'s broken in modern GTM. And a guest list that IS the marketing.',
      '',
      'It\'s the opposite of a conference: anti-scale, pro-signal. Year one proves it. Year two the report pre-sells the room. Year three it\'s a franchise — something Salesforce structurally cannot copy.',
      '',
      'I\'m not looking to send a deck or get on a procurement list. I\'d like 25 minutes to walk you through the concept. If it\'s not for you, you\'ll at least have a framework to hand to whoever does build it.',
      '',
      'Worth a conversation?',
      '',
      'Brian',
      'Sandbox-XM',
      '[phone] · [site]'
    ].join('\n');

    await sql(
      'INSERT INTO pitches (target_company, play, concept_title, one_liner, concept, contact_name, contact_role, outbound_draft, status, next_action) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      ['Attio', 'Signature Activation Pitch', 'Ask More', ATTIO_ONELINER, ATTIO_CONCEPT, '', 'Head of Brand / Head of Marketing / CMO (US) — or direct to Nicolas Sharp (Founder/CEO) if warm intro possible', ATTIO_EMAIL, 'drafting', 'Identify right US contact — Head of Marketing or Head of Brand (LinkedIn search: "Attio marketing" + NY/SF filter). Consider direct-to-founder path via mutual connection. A/B test subject line. Send within 5 business days.']
    );
  }

  // Attio language upgrade v2: mirror their own tagline ("Ask more from CRM.") as the subject line,
  // and lead the email with a sentence that reflects it back at them. Research-backed patch.
  // Idempotent — guarded by subject-line marker.
  var attioV2 = await sql("SELECT 1 FROM pitches WHERE target_company = 'Attio' AND outbound_draft LIKE 'Subject: Ask more from Attio%' LIMIT 1");
  if (attioV2.length === 0) {
    var attioRows = await sql("SELECT id FROM pitches WHERE target_company = 'Attio' LIMIT 1");
    if (attioRows.length > 0) {
      console.log('[xm-demand] Applying Attio language upgrade v2');
      var ATTIO_EMAIL_V2 = [
        'Subject: Ask more from Attio',
        '',
        'Hi [First name],',
        '',
        'You tell your customers to ask more from CRM. This is a concept for the room where the best GTM teams actually do.',
        '',
        'I run Sandbox-XM. We design brand experiences for teams who believe the room is strategy, not staging. I\'m writing with a concept, not a pitch deck.',
        '',
        'Attio is one of the few B2B brands whose voice could carry an owned cultural moment in the U.S. — and as far as I can tell, you haven\'t built one. Salesforce has Dreamforce. HubSpot has INBOUND. Attio has a beautiful product page and very good taste, and that\'s a gap worth closing on your own terms. It\'s the moment Attio doesn\'t have yet.',
        '',
        'The idea: one night in New York. 120 people — the sharpest GTM operators, founders, and RevOps leaders in the ecosystem. A curated dinner conversation on the record. A printed artifact everyone takes home: "The Ask More Report" — an annual field guide to how the best GTM teams actually run, built from original research across your customer base and friends-of.',
        '',
        'Every Attio value, made physical. Taste in the room. Data in the report. A stated POV about what\'s broken in modern GTM. And a guest list that IS the marketing.',
        '',
        'It\'s the opposite of a conference: anti-scale, pro-signal. Year one proves it. Year two the report pre-sells the room. Year three it\'s a franchise — something Salesforce structurally cannot copy.',
        '',
        'I\'m not looking to send a deck or get on a procurement list. I\'d like 25 minutes to walk you through the concept. If it\'s not for you, you\'ll at least have a framework to hand to whoever does build it.',
        '',
        'Worth a conversation?',
        '',
        'Brian',
        'Sandbox-XM',
        '[phone] · [site]'
      ].join('\n');
      await sql("UPDATE pitches SET outbound_draft = $1, updated_at = NOW() WHERE target_company = 'Attio'", [ATTIO_EMAIL_V2]);
    }
  }

  // Attio contact v3: identified target — Alex Vale, Attio (UK). His LinkedIn post pattern shows he's the
  // public voice celebrating Attio customers (Granola unicorn, Seapoint, Astral, etc) — founding-team /
  // senior GTM profile. Sharpen email to speak slightly more to GTM/ecosystem outcomes while keeping
  // the design-led voice. Idempotent — guarded by contact_name marker.
  var attioV3 = await sql("SELECT 1 FROM pitches WHERE target_company = 'Attio' AND contact_name = 'Alex Vale' LIMIT 1");
  if (attioV3.length === 0) {
    var attioV3Rows = await sql("SELECT id FROM pitches WHERE target_company = 'Attio' LIMIT 1");
    if (attioV3Rows.length > 0) {
      console.log('[xm-demand] Applying Attio contact v3 — Alex Vale');
      var ATTIO_EMAIL_V3 = [
        'Subject: Ask more from Attio',
        '',
        'Hi Alex,',
        '',
        'You tell your customers to ask more from CRM. This is a concept for the room where the best GTM teams actually do.',
        '',
        'I\'ve been watching how you talk about Attio publicly — the Granola unicorn post, the Seapoint shout-out, the steady drumbeat of "another awesome Attio customer." You\'re already trying to build a room in LinkedIn posts. I\'m writing with a concept for the physical version.',
        '',
        'I run Sandbox-XM. We design brand experiences for teams who believe the room is strategy, not staging. This isn\'t a pitch deck — it\'s a concept.',
        '',
        'One night in New York. 120 people — the sharpest GTM operators, founders, and RevOps leaders in the Attio ecosystem. A curated dinner conversation on the record. A printed artifact everyone takes home: "The Ask More Report" — an annual field guide to how the best GTM teams actually run, built from original research across your customer base and friends-of.',
        '',
        'Every Attio value, made physical. Taste in the room. Data in the report. A stated POV about what\'s broken in modern GTM. And a guest list that IS the marketing.',
        '',
        'Salesforce has Dreamforce. HubSpot has INBOUND. Attio has a beautiful product page and very good taste — and a U.S. moment worth closing on your own terms. "Ask More" is the opposite of a conference: anti-scale, pro-signal. Year one proves it. Year two the report pre-sells the room. Year three it\'s a franchise Salesforce structurally cannot copy.',
        '',
        'It also does something tactical: every customer you\'re already celebrating on LinkedIn gets a physical reason to rally around Attio — and a report they circulate for 12 months after.',
        '',
        'I\'d like 25 minutes to walk you through it. If it\'s not for you, you\'ll at least have a framework to hand to whoever does build it.',
        '',
        'Worth a conversation?',
        '',
        'Brian',
        'Sandbox-XM',
        '[phone] · [site]'
      ].join('\n');
      await sql(
        "UPDATE pitches SET contact_name = $1, contact_role = $2, outbound_draft = $3, next_action = $4, updated_at = NOW() WHERE target_company = 'Attio'",
        [
          'Alex Vale',
          'Attio — founding-team / senior GTM. UK-based. Public voice for Attio customer wins on LinkedIn (linkedin.com/in/alexjvale).',
          ATTIO_EMAIL_V3,
          'Warm-intro scan first: any one hop to Alex Vale, a Redpoint partner, or an Attio customer (Granola, Seapoint, Astral, Replicate, ElevenLabs, Flatfile, Hex, Vercel). If warm path = send via intro. If cold = LinkedIn DM + email parallel within 48 hours. Keep the GTM/ecosystem angle — he responds to customer-success stories.'
        ]
      );
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
    sql('SELECT * FROM notes ORDER BY created_at DESC LIMIT 50'),
    sql('SELECT * FROM pitches ORDER BY created_at DESC')
  ]).then(function(r) {
    res.json({ ok: true, personas: r[0], channels: r[1], accounts: r[2], playbooks: r[3], notes: r[4], pitches: r[5] });
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
app.patch('/api/pitches/:id', function(req, res) {
  updateRow('pitches', ['target_company', 'play', 'concept_title', 'one_liner', 'concept', 'contact_name', 'contact_role', 'outbound_draft', 'status', 'next_action'], req, res);
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

// Create pitch
app.post('/api/pitches', function(req, res) {
  if (!requireDb(res)) return;
  var b = req.body || {};
  sql(
    'INSERT INTO pitches (target_company, play, concept_title, one_liner, concept, contact_name, contact_role, outbound_draft, status, next_action) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
    [b.target_company || 'New Target', b.play || 'Signature Activation Pitch', b.concept_title || '', b.one_liner || '', b.concept || '', b.contact_name || '', b.contact_role || '', b.outbound_draft || '', b.status || 'drafting', b.next_action || '']
  ).then(function(r) {
    res.json({ ok: true, row: r[0] });
  }).catch(function(e) { res.status(500).json({ ok: false, error: e.message }); });
});

// Delete pitch
app.delete('/api/pitches/:id', function(req, res) {
  if (!requireDb(res)) return;
  var id = parseInt(req.params.id, 10);
  sql('DELETE FROM pitches WHERE id = $1', [id]).then(function() {
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
