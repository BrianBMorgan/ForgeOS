var express = require('express');
var { neon } = require('@neondatabase/serverless');
var axios = require('axios');
var multer = require('multer');

var app = express();
var PORT = process.env.PORT || 3000;
var upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ─── DATABASE ────────────────────────────────────────────────────────────────

function getDb() {
  var url = process.env.APP_DATABASE_URL;
  if (!url) throw new Error('APP_DATABASE_URL is not set');
  return neon(url);
}

async function ensureSchema() {
  var sql = getDb();

  await sql`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      event_date TEXT,
      venue TEXT,
      slot_count INTEGER DEFAULT 0,
      context_profile TEXT,
      ai_system_prompt TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS submissions (
      id SERIAL PRIMARY KEY,
      event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      bu TEXT,
      track TEXT,
      format TEXT,
      speakers TEXT,
      abstract TEXT,
      topics TEXT,
      demos TEXT,
      products TEXT,
      status TEXT DEFAULT 'submitted',
      ai_score INTEGER,
      ai_scorecard JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  console.log('[db] schema ready');
}

async function seedData() {
  var sql = getDb();
  var existing = await sql`SELECT id FROM events LIMIT 1`;
  if (existing.length > 0) {
    console.log('[db] seed already present — skipping');
    return;
  }

  var systemPrompt = [
    'You are an AI content reviewer for the Intel Federal Summit 2026, a premier event targeting US federal government, defense, intelligence community, and public sector IT decision-makers.',
    '',
    'Scoring mission: Evaluate session submissions on their relevance, technical depth, and strategic value to federal/defense audiences. Intel\'s federal priorities for 2026 center on AI for national security, edge computing at the tactical edge, data center modernization for classified workloads, and silicon-level trust/security.',
    '',
    'Score each submission on six dimensions (0-100 each):',
    '1. Federal Relevance — Does this directly address federal/defense/IC use cases, mission requirements, or procurement concerns?',
    '2. Technical Depth — Is the content substantive enough for technical buyers and architects in cleared environments?',
    '3. Intel Alignment — Does it showcase Intel silicon, software, or ecosystem advantages meaningfully?',
    '4. Audience Fit — Is the content level and framing appropriate for GS-13+, SES, and senior program managers?',
    '5. Innovation Signal — Does it present genuinely new capabilities, architectures, or approaches vs. known baselines?',
    '6. Delivery Readiness — Are the speakers credible, is the format appropriate, and is the abstract clear enough to attract the right attendees?',
    '',
    'Return ONLY valid JSON in this exact shape:',
    '{',
    '  "overall": <integer 0-100>,',
    '  "dimensions": {',
    '    "federal_relevance": { "score": <int>, "rationale": "<string>" },',
    '    "technical_depth": { "score": <int>, "rationale": "<string>" },',
    '    "intel_alignment": { "score": <int>, "rationale": "<string>" },',
    '    "audience_fit": { "score": <int>, "rationale": "<string>" },',
    '    "innovation_signal": { "score": <int>, "rationale": "<string>" },',
    '    "delivery_readiness": { "score": <int>, "rationale": "<string>" }',
    '  },',
    '  "strengths": ["<string>", ...],',
    '  "gaps": ["<string>", ...],',
    '  "recommendation": "<Accept|Accept with Revisions|Decline>"',
    '}'
  ].join('\n');

  var contextProfile = [
    'Intel Federal Summit 2026',
    'Date: April 27-28, 2026',
    'Venue: Marriott Westfields Chantilly, VA',
    'Available session slots: 12',
    '',
    'Audience: Senior federal IT decision-makers, defense program managers, intelligence community architects, DoD CIOs and CTOs, cleared systems integrators.',
    '',
    'Strategic themes for 2026:',
    '- Agentic AI for autonomous mission systems and decision support',
    '- Edge & embedded computing for contested/denied environments',
    '- Data center modernization for classified and FedRAMP workloads',
    '- Silicon-level security: TDX, SGX, Boot Guard for zero-trust architectures',
    '- High-performance computing for simulation, modeling, and intelligence analysis',
    '- Commercial client platforms for government-managed device fleets',
    '',
    'Intel federal portfolio highlights: Intel Xeon 6 (code-named Granite Rapids), Intel Core Ultra (Meteor Lake) with NPU for on-device AI, Gaudi 3 AI accelerators, Intel TDX for confidential computing, Intel vPro for enterprise manageability.',
    '',
    'Content bar: Sessions must be technically credible, speak directly to federal procurement and mission realities, and avoid purely commercial/enterprise framing.'
  ].join('\n');

  var eventResult = await sql`
    INSERT INTO events (name, event_date, venue, slot_count, context_profile, ai_system_prompt)
    VALUES (
      'Intel Federal Summit 2026',
      'April 27-28, 2026',
      'Marriott Westfields Chantilly, VA',
      12,
      ${contextProfile},
      ${systemPrompt}
    )
    RETURNING id
  `;

  var eventId = eventResult[0].id;

  var seeds = [
    {
      title: 'Agentic AI at the Tactical Edge: Autonomous Decision Support for DoD',
      bu: 'DCAI',
      track: 'Agentic AI',
      format: 'Technical Keynote',
      speakers: 'Dr. Sarah Chen (Intel DCAI), Col. James Harrington (US Army, ret.)',
      abstract: 'This session presents Intel\'s Gaudi 3-powered agentic AI framework deployed in a classified Army logistics optimization pilot. We demonstrate how multi-agent systems running on Intel silicon achieve sub-second decision latency for resupply routing in GPS-denied environments, reducing mission planner cognitive load by 40%. Architecture deep-dive covers inference pipeline, security isolation via Intel TDX, and integration with existing C2 systems.',
      topics: 'Agentic AI, autonomous systems, Gaudi 3, tactical edge, C2 integration',
      demos: 'Live agentic routing simulation on Gaudi 3 hardware',
      products: 'Intel Gaudi 3, Intel TDX, Intel Xeon 6',
      status: 'submitted'
    },
    {
      title: 'Building Trustworthy AI Agents for Intelligence Analysis Workflows',
      bu: 'DCAI',
      track: 'Agentic AI',
      format: 'Technical Session',
      speakers: 'Maya Patel (Intel AI Research), Thomas Nguyen (Intel Federal Solutions)',
      abstract: 'Intelligence analysts face an explosion of multi-source data requiring rapid synthesis. This session covers Intel\'s reference architecture for deploying agentic AI pipelines in air-gapped IC environments, using open-weight LLMs on Xeon 6 with Intel AMX acceleration. Topics include agent orchestration patterns, hallucination mitigation for high-stakes decisions, provenance tracking, and audit logging for compliance with IC data handling directives.',
      topics: 'Intelligence analysis, air-gapped AI, AMX, agent orchestration, compliance',
      demos: 'Multi-source intelligence fusion agent demo on Xeon 6',
      products: 'Intel Xeon 6, Intel AMX, Intel Developer Cloud',
      status: 'submitted'
    },
    {
      title: 'Intel Core Ultra at the Edge: AI Inference in SWaP-Constrained Platforms',
      bu: 'NEX',
      track: 'Edge & Embedded Systems',
      format: 'Technical Session',
      speakers: 'Kevin Park (Intel NEX), Dr. Lisa Torres (Intel Labs)',
      abstract: 'Forward-deployed ISR platforms demand AI inference capabilities within strict SWaP envelopes. Intel Core Ultra\'s integrated NPU delivers 34 TOPS within a 15W TDP, enabling real-time object detection, signals classification, and sensor fusion directly on the platform. This session covers thermal management, security hardening via BootGuard, ruggedization considerations, and a case study from a SOCOM-adjacent program.',
      topics: 'Edge AI, SWaP, NPU, ISR, BootGuard, ruggedized computing',
      demos: 'Object detection inference comparison: NPU vs CPU vs iGPU on Core Ultra',
      products: 'Intel Core Ultra (Meteor Lake), Intel NPU, Intel vPro',
      status: 'under_review'
    },
    {
      title: 'Modernizing the DoD Data Center: Xeon 6 for Classified HPC Workloads',
      bu: 'DCAI',
      track: 'Data Center/HPC',
      format: 'Technical Session',
      speakers: 'Robert Kim (Intel Data Center Group), Jennifer Walsh (Intel Federal)',
      abstract: 'The Department of Defense operates hundreds of data centers supporting classified modeling, simulation, and intelligence processing workloads that cannot move to commercial cloud. Intel Xeon 6 with P-cores delivers 2.1x the performance-per-watt of prior generation for HPC workloads while Intel TDX enables confidential computing enclaves for multi-tenant classified environments. Session covers ATO considerations, migration path from legacy infrastructure, and JWICS/SIPRNet integration.',
      topics: 'HPC, classified workloads, TDX, confidential computing, JWICS, data center modernization',
      demos: 'Xeon 6 vs Xeon 4 benchmark comparison on HPC workloads',
      products: 'Intel Xeon 6 (Granite Rapids), Intel TDX, Intel SGX',
      status: 'submitted'
    },
    {
      title: 'Zero Trust Device Identity: Intel vPro and Hardware-Rooted Security for Federal Fleets',
      bu: 'CCG',
      track: 'Commercial Client',
      format: 'Technical Session',
      speakers: 'Amanda Foster (Intel vPro Product), David Chen (Intel Security Solutions)',
      abstract: 'Federal agencies managing large device fleets under CISA zero trust mandates require hardware-rooted identity and remote attestation capabilities beyond software MDM. Intel vPro with Hardware Shield provides silicon-level platform attestation, below-OS threat detection, and remote remediation. Session covers NIST SP 800-155 alignment, integration with Microsoft SCCM and Intune for federal M365 tenants, FedRAMP implications, and practical deployment guidance.',
      topics: 'Zero trust, vPro, hardware security, MDM, FedRAMP, fleet management',
      demos: 'Remote attestation and below-OS threat detection live demo',
      products: 'Intel vPro, Intel Hardware Shield, Intel Boot Guard',
      status: 'submitted'
    },
    {
      title: 'AI-Assisted Code Modernization for Legacy Defense Systems',
      bu: 'CCG',
      track: 'Commercial Client',
      format: 'Workshop',
      speakers: 'Brian Taylor (Intel Software Division)',
      abstract: 'Defense software teams maintain millions of lines of COBOL, Ada, and legacy C++ in mission-critical systems. This workshop explores using Intel-optimized LLMs running locally on Core Ultra developer workstations to assist with code analysis, documentation generation, and controlled modernization without sending sensitive source code to external APIs. Covers toolchain setup, model selection, Intel OpenVINO integration, and lessons from a pilot with a prime integrator.',
      topics: 'Legacy modernization, local LLM, OpenVINO, developer tools, COBOL, Ada',
      demos: 'Live code analysis with local LLM on Core Ultra workstation',
      products: 'Intel Core Ultra, Intel OpenVINO, Intel NPU',
      status: 'submitted'
    }
  ];

  for (var i = 0; i < seeds.length; i++) {
    var s = seeds[i];
    await sql`
      INSERT INTO submissions (event_id, title, bu, track, format, speakers, abstract, topics, demos, products, status)
      VALUES (
        ${eventId}, ${s.title}, ${s.bu}, ${s.track}, ${s.format},
        ${s.speakers}, ${s.abstract}, ${s.topics}, ${s.demos}, ${s.products}, ${s.status}
      )
    `;
  }

  console.log('[db] seed complete — event id ' + eventId + ', ' + seeds.length + ' submissions');
}

// ─── ASSET PROXY ─────────────────────────────────────────────────────────────

app.get('/api/assets/:filename', async function(req, res) {
  try {
    var url = 'https://forge-os.ai/api/assets/' + req.params.filename;
    var response = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
    var ct = response.headers['content-type'] || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(response.data));
  } catch (err) {
    res.status(404).send('asset not found');
  }
});

// ─── EVENTS API ───────────────────────────────────────────────────────────────

app.get('/api/events', async function(req, res) {
  try {
    var sql = getDb();
    var rows = await sql`SELECT * FROM events ORDER BY created_at DESC`;
    res.json({ ok: true, events: rows });
  } catch (err) {
    console.error('[api/events GET]', err.message);
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/events', async function(req, res) {
  try {
    var sql = getDb();
    var { name, event_date, venue, slot_count, context_profile, ai_system_prompt } = req.body;
    if (!name) return res.json({ ok: false, error: 'name is required' });
    var result = await sql`
      INSERT INTO events (name, event_date, venue, slot_count, context_profile, ai_system_prompt)
      VALUES (${name}, ${event_date || ''}, ${venue || ''}, ${parseInt(slot_count) || 0}, ${context_profile || ''}, ${ai_system_prompt || ''})
      RETURNING *
    `;
    res.json({ ok: true, event: result[0] });
  } catch (err) {
    console.error('[api/events POST]', err.message);
    res.json({ ok: false, error: err.message });
  }
});

app.get('/api/events/:id', async function(req, res) {
  try {
    var sql = getDb();
    var rows = await sql`SELECT * FROM events WHERE id = ${parseInt(req.params.id)}`;
    if (!rows.length) return res.json({ ok: false, error: 'not found' });
    res.json({ ok: true, event: rows[0] });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.put('/api/events/:id', async function(req, res) {
  try {
    var sql = getDb();
    var { name, event_date, venue, slot_count, context_profile, ai_system_prompt } = req.body;
    var result = await sql`
      UPDATE events SET
        name = ${name},
        event_date = ${event_date || ''},
        venue = ${venue || ''},
        slot_count = ${parseInt(slot_count) || 0},
        context_profile = ${context_profile || ''},
        ai_system_prompt = ${ai_system_prompt || ''}
      WHERE id = ${parseInt(req.params.id)}
      RETURNING *
    `;
    if (!result.length) return res.json({ ok: false, error: 'not found' });
    res.json({ ok: true, event: result[0] });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.delete('/api/events/:id', async function(req, res) {
  try {
    var sql = getDb();
    await sql`DELETE FROM events WHERE id = ${parseInt(req.params.id)}`;
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// AI: generate event profile from strategy doc
app.post('/api/events/:id/generate-profile', async function(req, res) {
  try {
    var apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.json({ ok: false, error: 'ANTHROPIC_API_KEY not set' });

    var sql = getDb();
    var rows = await sql`SELECT * FROM events WHERE id = ${parseInt(req.params.id)}`;
    if (!rows.length) return res.json({ ok: false, error: 'event not found' });
    var event = rows[0];

    var strategyDoc = req.body.strategy_doc || '';
    if (!strategyDoc.trim()) return res.json({ ok: false, error: 'strategy_doc is required' });

    var response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system: 'You are an event strategy analyst. Given a strategy document, extract and synthesize a structured context profile and an AI scoring system prompt for session review. Return ONLY valid JSON with keys: context_profile (string) and ai_system_prompt (string). The ai_system_prompt must instruct an AI to score sessions on six dimensions: federal_relevance, technical_depth, intel_alignment, audience_fit, innovation_signal, delivery_readiness — each returning score (0-100) and rationale. Also include overall (0-100), strengths (array), gaps (array), recommendation (Accept|Accept with Revisions|Decline).',
        messages: [{ role: 'user', content: 'Event: ' + event.name + '\n\nStrategy document:\n' + strategyDoc }]
      },
      {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        timeout: 60000
      }
    );

    var text = response.data.content[0].text;
    var cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    var parsed = JSON.parse(cleaned);

    await sql`
      UPDATE events SET context_profile = ${parsed.context_profile || ''}, ai_system_prompt = ${parsed.ai_system_prompt || ''}
      WHERE id = ${parseInt(req.params.id)}
    `;

    res.json({ ok: true, context_profile: parsed.context_profile, ai_system_prompt: parsed.ai_system_prompt });
  } catch (err) {
    console.error('[generate-profile]', err.message);
    res.json({ ok: false, error: err.message });
  }
});

// ─── SUBMISSIONS API ──────────────────────────────────────────────────────────

app.get('/api/events/:eventId/submissions', async function(req, res) {
  try {
    var sql = getDb();
    var rows = await sql`
      SELECT * FROM submissions WHERE event_id = ${parseInt(req.params.eventId)}
      ORDER BY created_at DESC
    `;
    res.json({ ok: true, submissions: rows });
  } catch (err) {
    console.error('[api/submissions GET]', err.message);
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/events/:eventId/submissions', async function(req, res) {
  try {
    var sql = getDb();
    var eid = parseInt(req.params.eventId);
    var { title, bu, track, format, speakers, abstract, topics, demos, products, status } = req.body;
    if (!title) return res.json({ ok: false, error: 'title is required' });
    var result = await sql`
      INSERT INTO submissions (event_id, title, bu, track, format, speakers, abstract, topics, demos, products, status)
      VALUES (
        ${eid}, ${title}, ${bu || ''}, ${track || ''}, ${format || ''},
        ${speakers || ''}, ${abstract || ''}, ${topics || ''}, ${demos || ''}, ${products || ''},
        ${status || 'submitted'}
      )
      RETURNING *
    `;
    res.json({ ok: true, submission: result[0] });
  } catch (err) {
    console.error('[api/submissions POST]', err.message);
    res.json({ ok: false, error: err.message });
  }
});

app.put('/api/submissions/:id', async function(req, res) {
  try {
    var sql = getDb();
    var { title, bu, track, format, speakers, abstract, topics, demos, products, status } = req.body;
    var result = await sql`
      UPDATE submissions SET
        title = ${title}, bu = ${bu || ''}, track = ${track || ''}, format = ${format || ''},
        speakers = ${speakers || ''}, abstract = ${abstract || ''}, topics = ${topics || ''},
        demos = ${demos || ''}, products = ${products || ''}, status = ${status || 'submitted'}
      WHERE id = ${parseInt(req.params.id)}
      RETURNING *
    `;
    if (!result.length) return res.json({ ok: false, error: 'not found' });
    res.json({ ok: true, submission: result[0] });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.delete('/api/submissions/:id', async function(req, res) {
  try {
    var sql = getDb();
    await sql`DELETE FROM submissions WHERE id = ${parseInt(req.params.id)}`;
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// AI: parse PPTX into submission fields
app.post('/api/events/:eventId/parse-pptx', upload.single('file'), async function(req, res) {
  try {
    var apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.json({ ok: false, error: 'ANTHROPIC_API_KEY not set' });
    if (!req.file) return res.json({ ok: false, error: 'no file uploaded' });

    var b64 = req.file.buffer.toString('base64');

    var response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system: 'You are a session proposal parser. Extract structured submission fields from a presentation file (provided as base64). Return ONLY valid JSON with keys: title, bu, track, format, speakers, abstract, topics, demos, products. All values are strings. topics/demos/products may be comma-separated.',
        messages: [{
          role: 'user',
          content: [{
            type: 'document',
            source: {
              type: 'base64',
              media_type: req.file.mimetype || 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              data: b64
            }
          }, {
            type: 'text',
            text: 'Extract the session submission fields from this presentation file.'
          }]
        }]
      },
      {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        timeout: 60000
      }
    );

    var text = response.data.content[0].text;
    var cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    var parsed = JSON.parse(cleaned);
    res.json({ ok: true, fields: parsed });
  } catch (err) {
    console.error('[parse-pptx]', err.message);
    res.json({ ok: false, error: err.message });
  }
});

// ─── AI SCORING ──────────────────────────────────────────────────────────────

app.post('/api/submissions/:id/score', async function(req, res) {
  try {
    var apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.json({ ok: false, error: 'ANTHROPIC_API_KEY not set' });

    var sql = getDb();
    var subRows = await sql`SELECT * FROM submissions WHERE id = ${parseInt(req.params.id)}`;
    if (!subRows.length) return res.json({ ok: false, error: 'submission not found' });
    var sub = subRows[0];

    var evtRows = await sql`SELECT * FROM events WHERE id = ${sub.event_id}`;
    if (!evtRows.length) return res.json({ ok: false, error: 'event not found' });
    var evt = evtRows[0];

    var systemPrompt = evt.ai_system_prompt || 'You are an event content reviewer. Score this session submission on six dimensions and return JSON.';

    var submissionText = [
      'Title: ' + sub.title,
      'Business Unit: ' + (sub.bu || 'N/A'),
      'Track: ' + (sub.track || 'N/A'),
      'Format: ' + (sub.format || 'N/A'),
      'Speakers: ' + (sub.speakers || 'N/A'),
      'Abstract: ' + (sub.abstract || 'N/A'),
      'Topics: ' + (sub.topics || 'N/A'),
      'Demos: ' + (sub.demos || 'N/A'),
      'Products: ' + (sub.products || 'N/A')
    ].join('\n');

    var response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: 'user', content: 'Score this session submission:\n\n' + submissionText }]
      },
      {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        timeout: 60000
      }
    );

    var text = response.data.content[0].text;
    var cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    var scorecard = JSON.parse(cleaned);

    await sql`
      UPDATE submissions SET ai_score = ${scorecard.overall || 0}, ai_scorecard = ${JSON.stringify(scorecard)}
      WHERE id = ${parseInt(req.params.id)}
    `;

    res.json({ ok: true, scorecard: scorecard });
  } catch (err) {
    console.error('[score]', err.message);
    res.json({ ok: false, error: err.message });
  }
});

// Bulk score all submissions for an event
app.post('/api/events/:eventId/score-all', async function(req, res) {
  try {
    var apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.json({ ok: false, error: 'ANTHROPIC_API_KEY not set' });

    var sql = getDb();
    var evtRows = await sql`SELECT * FROM events WHERE id = ${parseInt(req.params.eventId)}`;
    if (!evtRows.length) return res.json({ ok: false, error: 'event not found' });
    var evt = evtRows[0];

    var submissions = await sql`SELECT * FROM submissions WHERE event_id = ${parseInt(req.params.eventId)}`;
    var systemPrompt = evt.ai_system_prompt || 'You are an event content reviewer. Score this session submission on six dimensions and return JSON.';

    var results = [];
    for (var i = 0; i < submissions.length; i++) {
      var sub = submissions[i];
      try {
        var submissionText = [
          'Title: ' + sub.title,
          'Business Unit: ' + (sub.bu || 'N/A'),
          'Track: ' + (sub.track || 'N/A'),
          'Format: ' + (sub.format || 'N/A'),
          'Speakers: ' + (sub.speakers || 'N/A'),
          'Abstract: ' + (sub.abstract || 'N/A'),
          'Topics: ' + (sub.topics || 'N/A'),
          'Demos: ' + (sub.demos || 'N/A'),
          'Products: ' + (sub.products || 'N/A')
        ].join('\n');

        var response = await axios.post(
          'https://api.anthropic.com/v1/messages',
          {
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1500,
            system: systemPrompt,
            messages: [{ role: 'user', content: 'Score this session submission:\n\n' + submissionText }]
          },
          {
            headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
            timeout: 60000
          }
        );

        var text = response.data.content[0].text;
        var cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        var scorecard = JSON.parse(cleaned);

        await sql`
          UPDATE submissions SET ai_score = ${scorecard.overall || 0}, ai_scorecard = ${JSON.stringify(scorecard)}
          WHERE id = ${sub.id}
        `;

        results.push({ id: sub.id, ok: true, score: scorecard.overall });
      } catch (err) {
        results.push({ id: sub.id, ok: false, error: err.message });
      }
    }

    res.json({ ok: true, results: results });
  } catch (err) {
    console.error('[score-all]', err.message);
    res.json({ ok: false, error: err.message });
  }
});

// ─── HTML SHELL (Part 2 will replace this) ───────────────────────────────────

app.get('/', function(req, res) {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Intel Event Content Review</title>
<style>
@font-face { font-family: 'IntelOneDisplay'; font-weight: 300; src: url('/api/assets/intelone-display-light.woff') format('woff'); }
@font-face { font-family: 'IntelOneDisplay'; font-weight: 400; src: url('/api/assets/intelone-display-regular.woff') format('woff'); }
@font-face { font-family: 'IntelOneDisplay'; font-weight: 500; src: url('/api/assets/intelone-display-medium.woff') format('woff'); }
@font-face { font-family: 'IntelOneDisplay'; font-weight: 700; src: url('/api/assets/intelone-display-bold.woff') format('woff'); }
*{box-sizing:border-box;margin:0;padding:0;border-radius:0;}
body{font-family:'IntelOneDisplay',sans-serif;font-weight:400;background:#EAEAEA;color:#2E2F2F;display:flex;height:100vh;overflow:hidden;}
#sidebar{width:240px;min-width:240px;background:#000864;color:#fff;display:flex;flex-direction:column;height:100vh;}
#sidebar .logo{padding:20px 16px;border-bottom:1px solid rgba(255,255,255,0.1);}
#sidebar .logo img{height:32px;}
#sidebar nav{flex:1;padding:16px 0;}
#sidebar nav a{display:block;padding:12px 16px;color:rgba(255,255,255,0.7);text-decoration:none;font-weight:500;font-size:14px;border-left:3px solid transparent;cursor:pointer;}
#sidebar nav a.active{color:#00AAE8;border-left-color:#00AAE8;background:rgba(0,170,232,0.08);}
#sidebar nav a:hover:not(.active){color:#fff;background:rgba(255,255,255,0.05);}
#sidebar .event-selector{padding:16px;border-top:1px solid rgba(255,255,255,0.1);}
#sidebar .event-selector label{display:block;font-size:11px;color:rgba(255,255,255,0.5);margin-bottom:6px;font-weight:500;text-transform:uppercase;letter-spacing:0.5px;}
#sidebar .event-selector select{width:100%;background:#000555;color:#fff;border:1px solid rgba(255,255,255,0.2);padding:8px;font-family:'IntelOneDisplay',sans-serif;font-size:13px;cursor:pointer;}
#main{flex:1;display:flex;flex-direction:column;overflow:hidden;}
#topbar{height:56px;background:#fff;border-bottom:1px solid #2E2F2F;display:flex;align-items:center;justify-content:space-between;padding:0 24px;flex-shrink:0;}
#topbar .title{font-weight:700;font-size:16px;}
#topbar .subtitle{font-size:13px;color:#888;margin-left:8px;}
#content{flex:1;overflow-y:auto;padding:24px;}
.btn-primary{background:#00AAE8;color:#fff;border:none;padding:8px 16px;font-family:'IntelOneDisplay',sans-serif;font-weight:700;font-size:13px;cursor:pointer;}
.btn-primary:hover{background:#0090C8;}
.btn-secondary{background:#fff;color:#2E2F2F;border:1px solid #2E2F2F;padding:8px 16px;font-family:'IntelOneDisplay',sans-serif;font-weight:400;font-size:13px;cursor:pointer;}
.btn-secondary:hover{background:#f5f5f5;}
.btn-danger{background:#CC0000;color:#fff;border:none;padding:8px 16px;font-family:'IntelOneDisplay',sans-serif;font-weight:700;font-size:13px;cursor:pointer;}
.card{background:#fff;border:1px solid #2E2F2F;padding:20px;margin-bottom:16px;}
.card h3{font-weight:700;font-size:15px;margin-bottom:4px;}
.card .meta{font-size:12px;color:#888;font-weight:300;}
input,textarea,select{font-family:'IntelOneDisplay',sans-serif;font-size:13px;background:#fff;border:1px solid #2E2F2F;color:#2E2F2F;padding:8px;width:100%;}
input:focus,textarea:focus,select:focus{outline:none;border-color:#00AAE8;}
label{display:block;font-size:12px;font-weight:500;margin-bottom:4px;color:#2E2F2F;}
.form-group{margin-bottom:16px;}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #2E2F2F;}
th{background:#2E2F2F;color:#fff;text-align:left;padding:10px 12px;font-size:12px;font-weight:700;}
td{padding:10px 12px;font-size:13px;border-bottom:1px solid #EAEAEA;}
tr:last-child td{border-bottom:none;}
tr:hover td{background:#f9f9f9;}
.badge{display:inline-block;padding:3px 8px;font-size:11px;font-weight:700;color:#fff;}
.badge-submitted{background:#2E2F2F;}
.badge-under_review{background:#000864;}
.badge-approved{background:#007A3D;}
.badge-rejected{background:#CC0000;}
.badge-needs_revision{background:#B8860B;}
.score-high{background:#007A3D;color:#fff;}
.score-mid{background:#B8860B;color:#fff;}
.score-low{background:#CC0000;color:#fff;}
.score-none{background:#6B6B6B;color:#fff;}
.slot-bar{height:8px;background:#EAEAEA;border:1px solid #ccc;margin:4px 0;}
.slot-bar-fill{height:100%;background:#00AAE8;}
.panel-overlay{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4);z-index:100;}
.panel-overlay.open{display:block;}
.slide-panel{position:fixed;top:0;right:-600px;width:600px;height:100vh;background:#fff;border-left:1px solid #2E2F2F;z-index:101;overflow-y:auto;transition:right 0.2s;padding:24px;}
.slide-panel.open{right:0;}
.slide-panel h2{font-weight:700;font-size:18px;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #EAEAEA;}
.dim-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #f0f0f0;}
.dim-score{font-weight:700;font-size:14px;}
.dim-rationale{font-size:12px;color:#666;margin-top:2px;}
.tabs{display:flex;border-bottom:2px solid #EAEAEA;margin-bottom:20px;}
.tab{padding:8px 16px;cursor:pointer;font-weight:500;font-size:13px;color:#888;border-bottom:2px solid transparent;margin-bottom:-2px;}
.tab.active{color:#00AAE8;border-bottom-color:#00AAE8;}
.section{display:none;}.section.active{display:block;}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
.grid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;}
.stat-card{background:#fff;border:1px solid #2E2F2F;padding:16px;text-align:center;}
.stat-card .num{font-size:32px;font-weight:700;color:#00AAE8;}
.stat-card .lbl{font-size:12px;color:#888;font-weight:300;}
.filter-bar{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center;}
.filter-bar input{width:200px;}
.filter-bar select{width:140px;}
.compare-row{display:grid;gap:8px;margin-bottom:8px;}
.compare-header{font-weight:700;font-size:12px;color:#888;text-transform:uppercase;}
.actions a{color:#00AAE8;cursor:pointer;font-size:12px;margin-right:8px;text-decoration:none;}
.actions a:hover{text-decoration:underline;}
.alert{padding:12px 16px;margin-bottom:16px;font-size:13px;}
.alert-error{background:#fff0f0;border:1px solid #CC0000;color:#CC0000;}
.alert-success{background:#f0fff4;border:1px solid #007A3D;color:#007A3D;}
.loading{color:#888;font-size:13px;padding:20px 0;}
</style>
</head>
<body>
<div id="sidebar">
  <div class="logo"><img src="/api/assets/Logo.png" alt="Intel"></div>
  <nav>
    <a class="active" onclick="showSection('events')">Events</a>
    <a onclick="showSection('submissions')">Submissions</a>
    <a onclick="showSection('review')">Review</a>
  </nav>
  <div class="event-selector">
    <label>Current Event</label>
    <select id="event-select" onchange="onEventChange()"><option>Loading...</option></select>
  </div>
</div>
<div id="main">
  <div id="topbar">
    <div><span class="title" id="page-title">Events</span></div>
    <div id="topbar-action"></div>
  </div>
  <div id="content">
    <!-- EVENTS SECTION -->
    <div id="section-events" class="section active">
      <div id="events-list"></div>
    </div>
    <!-- SUBMISSIONS SECTION -->
    <div id="section-submissions" class="section">
      <div id="submissions-content"></div>
    </div>
    <!-- REVIEW SECTION -->
    <div id="section-review" class="section">
      <div id="review-content"></div>
    </div>
  </div>
</div>

<!-- Slide panel -->
<div class="panel-overlay" id="panel-overlay" onclick="closePanel()"></div>
<div class="slide-panel" id="slide-panel"></div>

<script>
var currentEventId = localStorage.getItem('selectedEventId') || null;
var allEvents = [];
var allSubmissions = [];

// ── Navigation ────────────────────────────────────────────────────────────────
function showSection(name) {
  document.querySelectorAll('.section').forEach(function(s){s.classList.remove('active');});
  document.getElementById('section-' + name).classList.add('active');
  document.querySelectorAll('#sidebar nav a').forEach(function(a,i){
    a.classList.toggle('active', ['events','submissions','review'][i] === name);
  });
  document.getElementById('page-title').textContent = name.charAt(0).toUpperCase() + name.slice(1);
  document.getElementById('topbar-action').innerHTML = '';
  if (name === 'events') { renderEventsList(); addTopbarBtn('New Event', showNewEventForm); }
  if (name === 'submissions') { renderSubmissions(); }
  if (name === 'review') { renderReview(); addTopbarBtn('Score All Unscored', scoreAllUnscored); }
}

function addTopbarBtn(label, fn) {
  var btn = document.createElement('button');
  btn.className = 'btn-primary'; btn.textContent = label; btn.onclick = fn;
  document.getElementById('topbar-action').appendChild(btn);
}

// ── API helpers ───────────────────────────────────────────────────────────────
async function api(method, path, body) {
  var opts = { method: method, headers: {'Content-Type':'application/json'} };
  if (body) opts.body = JSON.stringify(body);
  var r = await fetch(path, opts);
  return r.json();
}

// ── Events ────────────────────────────────────────────────────────────────────
async function loadEvents() {
  var data = await api('GET', '/api/events');
  allEvents = data.events || data || [];
  var sel = document.getElementById('event-select');
  sel.innerHTML = allEvents.map(function(e){
    return '<option value="' + e.id + '"' + (String(e.id) === String(currentEventId) ? ' selected' : '') + '>' + e.name + '</option>';
  }).join('');
  if (!currentEventId && allEvents.length) { currentEventId = String(allEvents[0].id); sel.value = currentEventId; }
  return allEvents;
}

function onEventChange() {
  currentEventId = document.getElementById('event-select').value;
  localStorage.setItem('selectedEventId', currentEventId);
  var sect = document.querySelector('.section.active');
  if (sect && sect.id === 'section-submissions') renderSubmissions();
  if (sect && sect.id === 'section-review') renderReview();
}

async function renderEventsList() {
  var el = document.getElementById('events-list');
  el.innerHTML = '<div class="loading">Loading...</div>';
  await loadEvents();
  var subs = await api('GET', '/api/submissions?event_id=' + (currentEventId||''));
  var subsByEvent = {};
  (subs.submissions || subs || []).forEach(function(s){ subsByEvent[s.event_id] = (subsByEvent[s.event_id]||0)+1; });
  el.innerHTML = allEvents.map(function(e){
    var count = subsByEvent[e.id] || 0;
    var slots = e.total_slots || 12;
    var pct = Math.min(100, Math.round(count/slots*100));
    return '<div class="card"><div style="display:flex;justify-content:space-between;align-items:flex-start"><div><h3>' + e.name + '</h3><div class="meta">' + (e.event_date||'') + ' &nbsp;|&nbsp; ' + (e.venue||'') + '</div></div><div style="text-align:right"><span class="badge" style="background:#000864">' + count + ' / ' + slots + ' slots</span></div></div><div class="slot-bar" style="margin-top:12px"><div class="slot-bar-fill" style="width:' + pct + '%"></div></div></div>';
  }).join('') || '<div class="loading">No events yet.</div>';
}

function showNewEventForm(editEvent) {
  var isEdit = !!editEvent;
  document.getElementById('slide-panel').innerHTML = '<h2>' + (isEdit ? 'Edit Event' : 'New Event') + '</h2><div id="event-form-step1"><div class="form-group"><label>Event Name *</label><input id="ef-name" value="' + (editEvent&&editEvent.name||'') + '"></div><div class="grid-2"><div class="form-group"><label>Event Date</label><input id="ef-date" value="' + (editEvent&&editEvent.event_date||'') + '"></div><div class="form-group"><label>Total Session Slots</label><input id="ef-slots" type="number" value="' + (editEvent&&editEvent.total_slots||12) + '"></div></div><div class="form-group"><label>Venue</label><input id="ef-venue" value="' + (editEvent&&editEvent.venue||'') + '"></div>' + (isEdit ? '' : '<button class="btn-primary" onclick="showStep2()">Next &rarr;</button>') + (isEdit ? '<button class="btn-primary" onclick="saveEventEdit(' + editEvent.id + ')">Save Changes</button>' : '') + '</div><div id="event-form-step2" style="display:none"><div class="form-group"><label>Paste event strategy, goals, KPIs, audience, content pillars here. The more context the better AI scoring.</label><textarea id="ef-context" rows="8" placeholder="Paste POR deck, strategy doc, goals..."></textarea></div><button class="btn-primary" onclick="generateProfile()">Generate Event Profile</button> <button class="btn-secondary" onclick="saveEventDirect()">Save Without Profile</button><div id="profile-result" style="margin-top:16px"></div></div>';
  openPanel();
}

function showStep2() {
  var name = document.getElementById('ef-name').value.trim();
  if (!name) { alert('Event name is required'); return; }
  document.getElementById('event-form-step1').style.display = 'none';
  document.getElementById('event-form-step2').style.display = 'block';
}

async function generateProfile() {
  var ctx = document.getElementById('ef-context').value.trim();
  if (!ctx) { alert('Paste some context first'); return; }
  document.getElementById('profile-result').innerHTML = '<div class="loading">Generating profile with AI...</div>';
  var r = await api('POST', '/api/events/generate-profile', { context_raw: ctx });
  if (r.error) { document.getElementById('profile-result').innerHTML = '<div class="alert alert-error">' + r.error + '</div>'; return; }
  var p = r.profile || r;
  document.getElementById('profile-result').innerHTML = '<div class="card"><h3>Generated Profile</h3><pre style="font-size:11px;overflow:auto;max-height:200px">' + JSON.stringify(p, null, 2) + '</pre></div><button class="btn-primary" onclick="saveEventWithProfile()">Save Event</button>';
  window._generatedProfile = p;
}

async function saveEventWithProfile() {
  var body = { name: document.getElementById('ef-name').value.trim(), event_date: document.getElementById('ef-date').value, venue: document.getElementById('ef-venue').value, total_slots: parseInt(document.getElementById('ef-slots').value)||12, context_raw: document.getElementById('ef-context').value, context_profile: window._generatedProfile };
  var r = await api('POST', '/api/events', body);
  if (r.error) { alert(r.error); return; }
  closePanel(); renderEventsList(); loadEvents();
}

async function saveEventDirect() {
  var body = { name: document.getElementById('ef-name').value.trim(), event_date: document.getElementById('ef-date').value, venue: document.getElementById('ef-venue').value, total_slots: parseInt(document.getElementById('ef-slots').value)||12 };
  if (!body.name) { alert('Event name required'); return; }
  var r = await api('POST', '/api/events', body);
  if (r.error) { alert(r.error); return; }
  closePanel(); renderEventsList(); loadEvents();
}

async function saveEventEdit(id) {
  var body = { name: document.getElementById('ef-name').value.trim(), event_date: document.getElementById('ef-date').value, venue: document.getElementById('ef-venue').value, total_slots: parseInt(document.getElementById('ef-slots').value)||12 };
  await api('PUT', '/api/events/' + id, body);
  closePanel(); renderEventsList(); loadEvents();
}

// ── Submissions ───────────────────────────────────────────────────────────────
var subFilters = { search: '', track: '', bu: '', status: '', has_demo: '', has_partner: '' };

async function renderSubmissions() {
  if (!currentEventId) { document.getElementById('submissions-content').innerHTML = '<div class="loading">Select an event first.</div>'; return; }
  var el = document.getElementById('submissions-content');
  el.innerHTML = '<div class="loading">Loading...</div>';
  var event = allEvents.find(function(e){return String(e.id)===String(currentEventId);});
  var data = await api('GET', '/api/submissions?event_id=' + currentEventId);
  allSubmissions = data.submissions || data || [];
  var tracks = [...new Set(allSubmissions.map(function(s){return s.track;}).filter(Boolean))];
  var bus = [...new Set(allSubmissions.map(function(s){return s.bu;}).filter(Boolean))];
  var slots = event ? event.total_slots || 12 : 12;
  var used = allSubmissions.length;
  var pct = Math.min(100, Math.round(used/slots*100));
  el.innerHTML = '<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px"><div style="flex:1"><div class="slot-bar"><div class="slot-bar-fill" style="width:' + pct + '%"></div></div><div style="font-size:12px;color:#888;margin-top:4px">' + used + ' / ' + slots + ' slots used</div></div><button class="btn-primary" onclick="showAddSubmission()">+ Add Submission</button><button class="btn-secondary" onclick="exportCSV()">Export CSV</button></div>' +
    '<div class="filter-bar"><input placeholder="Search title / speaker..." oninput="subFilters.search=this.value;renderSubTable()" value="' + subFilters.search + '"><select onchange="subFilters.track=this.value;renderSubTable()"><option value="">All Tracks</option>' + tracks.map(function(t){return '<option value="' + t + '"' + (subFilters.track===t?' selected':'') + '>' + t + '</option>';}).join('') + '</select><select onchange="subFilters.bu=this.value;renderSubTable()"><option value="">All BUs</option>' + bus.map(function(b){return '<option value="' + b + '"' + (subFilters.bu===b?' selected':'') + '>' + b + '</option>';}).join('') + '</select><select onchange="subFilters.status=this.value;renderSubTable()"><option value="">All Status</option><option value="submitted">Submitted</option><option value="under_review">Under Review</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="needs_revision">Needs Revision</option></select></div>' +
    '<div id="sub-table"></div>';
  renderSubTable();
  // topbar for export
  document.getElementById('topbar-action').innerHTML = '<button class="btn-primary" onclick="showAddSubmission()">+ Add Submission</button>';
}

function renderSubTable() {
  var filtered = allSubmissions.filter(function(s){
    if (subFilters.search) { var q = subFilters.search.toLowerCase(); if (!(s.title||'').toLowerCase().includes(q) && !(s.intel_speakers||'').toLowerCase().includes(q) && !(s.content_lead||'').toLowerCase().includes(q)) return false; }
    if (subFilters.track && s.track !== subFilters.track) return false;
    if (subFilters.bu && s.bu !== subFilters.bu) return false;
    if (subFilters.status && s.status !== subFilters.status) return false;
    return true;
  });
  var html = '<table><thead><tr><th>Title</th><th>BU</th><th>Track</th><th>Format</th><th>Speakers</th><th>Demo</th><th>Partner</th><th>Status</th><th>AI Score</th><th>Actions</th></tr></thead><tbody>';
  filtered.forEach(function(s){
    var score = s.ai_score ? s.ai_score.overall_score : null;
    var scoreBadge = score !== null ? '<span class="badge ' + (score>=80?'score-high':score>=60?'score-mid':'score-low') + '">' + score + '</span>' : '<span class="badge score-none">&mdash;</span>';
    var statusBadge = '<span class="badge badge-' + (s.status||'submitted') + '">' + (s.status||'submitted').replace('_',' ') + '</span>';
    html += '<tr><td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + (s.title||'') + '">' + (s.title||'').slice(0,55) + (s.title&&s.title.length>55?'...':'') + '</td><td>' + (s.bu||'&mdash;') + '</td><td>' + (s.track||'&mdash;') + '</td><td>' + (s.format||'&mdash;') + '</td><td style="font-size:11px">' + (s.intel_speakers||'&mdash;').slice(0,40) + '</td><td style="text-align:center">' + (s.demos&&s.demos!=='None'&&s.demos!=='TBD'?'&#10003;':'&mdash;') + '</td><td style="text-align:center">' + (s.partner_speakers&&s.partner_speakers!=='TBD'?'&#10003;':'&mdash;') + '</td><td>' + statusBadge + '</td><td>' + scoreBadge + '</td><td class="actions"><a onclick="viewSubmission(' + s.id + ')">View</a><a onclick="scoreSubmission(' + s.id + ')">Score</a><a onclick="editStatus(' + s.id + ')">Status</a></td></tr>';
  });
  html += '</tbody></table>';
  if (!filtered.length) html = '<div class="loading">No submissions match filters.</div>';
  document.getElementById('sub-table').innerHTML = html;
}

function showAddSubmission() {
  document.getElementById('slide-panel').innerHTML = '<h2>Add Submission</h2>' + submissionForm(null) + '<button class="btn-primary" onclick="saveNewSubmission()">Save Submission</button>';
  openPanel();
}

function submissionForm(s) {
  var f = s || {};
  var fields = [['title','Title'],['content_lead','Content Lead'],['bu','BU'],['track','Track'],['format','Format'],['duration','Duration'],['intel_speakers','Intel Speakers'],['partner_speakers','Partner Speakers'],['abstract','Abstract','textarea'],['key_topics','Key Topics','textarea'],['demos','Demos'],['featured_products','Featured Products'],['business_challenge','Business Challenge'],['partner_highlights','Partner Highlights'],['new_launches','New Launches']];
  return fields.map(function(fd){
    var val = f[fd[0]] || '';
    if (fd[2]==='textarea') return '<div class="form-group"><label>' + fd[1] + '</label><textarea id="sf-' + fd[0] + '" rows="3">' + val + '</textarea></div>';
    return '<div class="form-group"><label>' + fd[1] + '</label><input id="sf-' + fd[0] + '" value="' + val.toString().replace(/"/g,'&quot;') + '"></div>';
  }).join('');
}

function getSubmissionFormData() {
  var fields = ['title','content_lead','bu','track','format','duration','intel_speakers','partner_speakers','abstract','key_topics','demos','featured_products','business_challenge','partner_highlights','new_launches'];
  var data = { event_id: currentEventId };
  fields.forEach(function(f){ data[f] = (document.getElementById('sf-' + f)||{}).value || ''; });
  return data;
}

async function saveNewSubmission() {
  var data = getSubmissionFormData();
  var r = await api('POST', '/api/submissions', data);
  if (r.error) { alert(r.error); return; }
  closePanel(); renderSubmissions();
}

async function viewSubmission(id) {
  var s = allSubmissions.find(function(x){return x.id===id;});
  if (!s) return;
  var score = s.ai_score;
  var scoreHtml = '';
  if (score) {
    var dims = score.dimension_scores || {};
    scoreHtml = '<div style="margin-top:16px;padding-top:16px;border-top:1px solid #EAEAEA"><div style="font-weight:700;margin-bottom:8px">AI Score: <span class="badge ' + (score.overall_score>=80?'score-high':score.overall_score>=60?'score-mid':'score-low') + '" style="font-size:16px">' + score.overall_score + '</span></div>';
    Object.keys(dims).forEach(function(k){ var d = dims[k]; scoreHtml += '<div class="dim-row"><div><div style="font-weight:500;font-size:13px">' + k.replace(/_/g,' ') + '</div><div class="dim-rationale">' + (d.rationale||'') + '</div></div><div class="dim-score">' + d.score + '</div></div>'; });
    scoreHtml += '<div style="margin-top:12px"><div style="font-weight:500;margin-bottom:4px;color:#007A3D">Strengths</div>' + (score.strengths||[]).map(function(s){return '<div style="font-size:12px;margin-bottom:2px">• ' + s + '</div>';}).join('') + '</div><div style="margin-top:8px"><div style="font-weight:500;margin-bottom:4px;color:#CC0000">Gaps</div>' + (score.gaps||[]).map(function(g){return '<div style="font-size:12px;margin-bottom:2px">• ' + g + '</div>';}).join('') + '</div><div style="margin-top:12px;padding:12px;background:#f9f9f9;border:1px solid #EAEAEA"><div style="font-weight:700">' + (score.recommendation||'') + '</div><div style="font-size:12px;color:#666;margin-top:4px">' + (score.recommendation_rationale||'') + '</div></div></div>';
  }
  document.getElementById('slide-panel').innerHTML = '<h2>' + (s.title||'Untitled') + '</h2><div class="grid-2"><div><b>BU:</b> ' + (s.bu||'—') + '</div><div><b>Track:</b> ' + (s.track||'—') + '</div><div><b>Format:</b> ' + (s.format||'—') + '</div><div><b>Duration:</b> ' + (s.duration||'—') + '</div></div><div style="margin-top:12px"><b>Intel Speakers:</b> ' + (s.intel_speakers||'—') + '</div><div style="margin-top:8px"><b>Partner Speakers:</b> ' + (s.partner_speakers||'—') + '</div><div style="margin-top:8px"><b>Abstract:</b><p style="font-size:13px;margin-top:4px;color:#444">' + (s.abstract||'—') + '</p></div><div style="margin-top:8px"><b>Key Topics:</b> ' + (s.key_topics||'—') + '</div><div style="margin-top:8px"><b>Demos:</b> ' + (s.demos||'—') + '</div><div style="margin-top:8px"><b>Featured Products:</b> ' + (s.featured_products||'—') + '</div><div style="margin-top:16px"><label>Reviewer Notes</label><textarea id="notes-' + s.id + '" rows="3" style="margin-top:4px">' + (s.reviewer_notes||'') + '</textarea><button class="btn-secondary" style="margin-top:8px" onclick="saveNotes(' + s.id + ')">Save Notes</button></div><div style="margin-top:12px;display:flex;gap:8px"><button class="btn-primary" onclick="scoreSubmission(' + s.id + ')">Run AI Score</button></div>' + scoreHtml;
  openPanel();
}

async function saveNotes(id) {
  var notes = document.getElementById('notes-' + id).value;
  await api('PUT', '/api/submissions/' + id, { reviewer_notes: notes });
}

function editStatus(id) {
  var s = allSubmissions.find(function(x){return x.id===id;});
  document.getElementById('slide-panel').innerHTML = '<h2>Edit Status</h2><div class="form-group"><label>Status</label><select id="status-sel"><option value="submitted"' + (s.status==='submitted'?' selected':'') + '>Submitted</option><option value="under_review"' + (s.status==='under_review'?' selected':'') + '>Under Review</option><option value="approved"' + (s.status==='approved'?' selected':'') + '>Approved</option><option value="rejected"' + (s.status==='rejected'?' selected':'') + '>Rejected</option><option value="needs_revision"' + (s.status==='needs_revision'?' selected':'') + '>Needs Revision</option></select></div><button class="btn-primary" onclick="saveStatus(' + id + ')">Save</button>';
  openPanel();
}

async function saveStatus(id) {
  var status = document.getElementById('status-sel').value;
  await api('PUT', '/api/submissions/' + id, { status: status });
  var s = allSubmissions.find(function(x){return x.id===id;}); if (s) s.status = status;
  closePanel(); renderSubTable();
}

async function scoreSubmission(id) {
  var el = document.getElementById('slide-panel');
  el.innerHTML = '<h2>Scoring...</h2><div class="loading">Running AI alignment scoring...</div>';
  openPanel();
  var r = await api('POST', '/api/submissions/' + id + '/score');
  if (r.error) { el.innerHTML = '<h2>Error</h2><div class="alert alert-error">' + r.error + '</div>'; return; }
  var idx = allSubmissions.findIndex(function(x){return x.id===id;}); if (idx>=0) allSubmissions[idx].ai_score = r.ai_score || r;
  renderSubTable();
  viewSubmission(id);
}

function exportCSV() {
  window.open('/api/submissions/export?event_id=' + currentEventId);
}

// ── Review ────────────────────────────────────────────────────────────────────
var compareIds = [];

async function renderReview() {
  if (!currentEventId) { document.getElementById('review-content').innerHTML = '<div class="loading">Select an event first.</div>'; return; }
  var el = document.getElementById('review-content');
  el.innerHTML = '<div class="loading">Loading...</div>';
  var data = await api('GET', '/api/submissions?event_id=' + currentEventId);
  allSubmissions = data.submissions || data || [];
  var scored = allSubmissions.filter(function(s){return s.ai_score;});
  var unscored = allSubmissions.filter(function(s){return !s.ai_score;});
  var tracks = {};
  allSubmissions.forEach(function(s){ if (s.track) { if (!tracks[s.track]) tracks[s.track] = []; tracks[s.track].push(s); } });
  var sortedSubs = scored.slice().sort(function(a,b){return (b.ai_score.overall_score||0)-(a.ai_score.overall_score||0);});

  el.innerHTML = '<div class="grid-3" style="margin-bottom:20px"><div class="stat-card"><div class="num">' + allSubmissions.length + '</div><div class="lbl">Total Submissions</div></div><div class="stat-card"><div class="num">' + scored.length + '</div><div class="lbl">Scored</div></div><div class="stat-card"><div class="num">' + unscored.length + '</div><div class="lbl">Unscored</div></div></div>' +
  '<div style="margin-bottom:20px"><button class="btn-primary" onclick="scoreAllUnscored()">Score All Unscored (' + unscored.length + ')</button> <button class="btn-secondary" onclick="exportCSV()">Export CSV</button></div>' +
  '<div class="tabs"><div class="tab active" onclick="reviewTab(this,\'ranked\')">Ranked</div><div class="tab" onclick="reviewTab(this,\'tracks\')">By Track</div><div class="tab" onclick="reviewTab(this,\'compare\')">Compare</div></div>' +
  '<div id="review-ranked"><h3 style="font-weight:700;margin-bottom:12px">All Submissions by Score</h3>' + sortedSubs.map(function(s){ var sc = s.ai_score; return '<div class="card" style="display:flex;justify-content:space-between;align-items:flex-start"><div style="flex:1"><div style="font-weight:700">' + (s.title||'') + '</div><div style="font-size:12px;color:#888">' + (s.bu||'') + ' &nbsp;|&nbsp; ' + (s.track||'') + '</div><div style="font-size:12px;margin-top:4px;color:#444">' + (sc.recommendation||'') + '</div></div><div style="text-align:right;margin-left:16px"><span class="badge ' + (sc.overall_score>=80?'score-high':sc.overall_score>=60?'score-mid':'score-low') + '" style="font-size:18px;padding:6px 12px">' + sc.overall_score + '</span><div style="margin-top:8px"><a class="actions" style="color:#00AAE8;cursor:pointer;font-size:12px" onclick="viewSubmission(' + s.id + ')">View Details</a></div></div></div>'; }).join('') + (sortedSubs.length===0?'<div class="loading">No scored submissions yet. Run scoring first.</div>':'') + '</div>' +
  '<div id="review-tracks" style="display:none">' + Object.keys(tracks).map(function(track){ var ts = tracks[track].slice().sort(function(a,b){return ((b.ai_score&&b.ai_score.overall_score)||0)-((a.ai_score&&a.ai_score.overall_score)||0);}); return '<div style="margin-bottom:20px"><h3 style="font-weight:700;margin-bottom:8px;padding-bottom:8px;border-bottom:2px solid #00AAE8">' + track + ' (' + ts.length + ' submissions)</h3>' + ts.map(function(s){ var sc = s.ai_score; return '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid #EAEAEA"><div><div style="font-weight:500">' + (s.title||'').slice(0,70) + '</div><div style="font-size:11px;color:#888">' + (s.bu||'') + '</div></div><div style="display:flex;align-items:center;gap:8px">' + (sc?'<span class="badge ' + (sc.overall_score>=80?'score-high':sc.overall_score>=60?'score-mid':'score-low') + '">' + sc.overall_score + '</span>':'<span class="badge score-none">&mdash;</span>') + '<a style="color:#00AAE8;cursor:pointer;font-size:12px" onclick="viewSubmission(' + s.id + ')">View</a></div></div>'; }).join('') + '</div>'; }).join('') + '</div>' +
  '<div id="review-compare" style="display:none"><div style="margin-bottom:12px;font-size:13px;color:#666">Select 2-3 submissions to compare side by side:</div><div id="compare-picks" style="margin-bottom:16px">' + allSubmissions.map(function(s){ return '<label style="display:flex;align-items:center;gap:8px;margin-bottom:6px;cursor:pointer"><input type="checkbox" value="' + s.id + '" onchange="toggleCompare(' + s.id + ')"> ' + (s.title||'').slice(0,80) + '</label>'; }).join('') + '</div><div id="compare-table"></div></div>';
}

function reviewTab(el, name) {
  document.querySelectorAll('.tab').forEach(function(t){t.classList.remove('active');});
  el.classList.add('active');
  document.getElementById('review-ranked').style.display = name==='ranked'?'block':'none';
  document.getElementById('review-tracks').style.display = name==='tracks'?'block':'none';
  document.getElementById('review-compare').style.display = name==='compare'?'block':'none';
}

function toggleCompare(id) {
  var idx = compareIds.indexOf(id);
  if (idx>=0) compareIds.splice(idx,1); else if (compareIds.length<3) compareIds.push(id);
  renderCompareTable();
}

function renderCompareTable() {
  var subs = compareIds.map(function(id){return allSubmissions.find(function(s){return s.id===id;});}).filter(Boolean);
  if (subs.length < 2) { document.getElementById('compare-table').innerHTML = '<div class="loading">Select 2-3 submissions above.</div>'; return; }
  var dims = ['track_fit','audience_alignment','intel_product_coverage','mission_relevance','partner_value','demo_strength'];
  var html = '<div style="display:grid;grid-template-columns:repeat(' + subs.length + ',1fr);gap:1px;background:#2E2F2F">';
  subs.forEach(function(s){ html += '<div style="background:#fff;padding:12px"><div style="font-weight:700;font-size:13px">' + (s.title||'').slice(0,60) + '</div><div style="font-size:11px;color:#888">' + (s.bu||'') + '</div></div>'; });
  html += '</div>';
  dims.forEach(function(dim){ html += '<div style="display:grid;grid-template-columns:repeat(' + subs.length + ',1fr);gap:1px;background:#EAEAEA;margin-top:1px">'; subs.forEach(function(s){ var sc = s.ai_score&&s.ai_score.dimension_scores&&s.ai_score.dimension_scores[dim]; html += '<div style="background:#fff;padding:10px"><div style="font-size:11px;font-weight:500;color:#888;text-transform:uppercase">' + dim.replace(/_/g,' ') + '</div>' + (sc?'<div style="font-size:20px;font-weight:700;color:' + (sc.score>=80?'#007A3D':sc.score>=60?'#B8860B':'#CC0000') + '">' + sc.score + '</div><div style="font-size:11px;color:#666">' + (sc.rationale||'') + '</div>':'<div style="color:#999">—</div>') + '</div>'; });
  html += '</div>'; });
  document.getElementById('compare-table').innerHTML = html;
}

async function scoreAllUnscored() {
  var unscored = allSubmissions.filter(function(s){return !s.ai_score;});
  if (!unscored.length) { alert('All submissions already scored.'); return; }
  if (!confirm('Score ' + unscored.length + ' unscored submissions? This may take a minute.')) return;
  var btn = event.target; btn.disabled = true; btn.textContent = 'Scoring...';
  for (var i = 0; i < unscored.length; i++) {
    btn.textContent = 'Scoring ' + (i+1) + ' / ' + unscored.length + '...';
    var r = await api('POST', '/api/submissions/' + unscored[i].id + '/score');
    if (r.ai_score || r.overall_score) { var idx = allSubmissions.findIndex(function(s){return s.id===unscored[i].id;}); if (idx>=0) allSubmissions[idx].ai_score = r.ai_score || r; }
  }
  btn.disabled = false; btn.textContent = 'Score All Unscored';
  renderReview();
}

// ── Panel helpers ─────────────────────────────────────────────────────────────
function openPanel() { document.getElementById('panel-overlay').classList.add('open'); document.getElementById('slide-panel').classList.add('open'); }
function closePanel() { document.getElementById('panel-overlay').classList.remove('open'); document.getElementById('slide-panel').classList.remove('open'); }

// ── Expose functions globally for inline onclick handlers ────────────────────
window.showSection = showSection;
window.onEventChange = onEventChange;
window.showNewEventForm = showNewEventForm;
window.showStep2 = showStep2;
window.generateProfile = generateProfile;
window.saveEventWithProfile = saveEventWithProfile;
window.saveEventDirect = saveEventDirect;
window.saveEventEdit = saveEventEdit;
window.renderSubmissions = renderSubmissions;
window.renderSubTable = renderSubTable;
window.showAddSubmission = showAddSubmission;
window.saveNewSubmission = saveNewSubmission;
window.viewSubmission = viewSubmission;
window.saveNotes = saveNotes;
window.editStatus = editStatus;
window.saveStatus = saveStatus;
window.scoreSubmission = scoreSubmission;
window.exportCSV = exportCSV;
window.renderReview = renderReview;
window.reviewTab = reviewTab;
window.toggleCompare = toggleCompare;
window.scoreAllUnscored = scoreAllUnscored;
window.openPanel = openPanel;
window.closePanel = closePanel;

// ── Init ──────────────────────────────────────────────────────────────────────
loadEvents().then(function() { showSection('events'); });
</script>
</body>
</html>`);
});

app.listen(PORT, '0.0.0.0', async function() {
  console.log('[server] listening on port ' + PORT);
  try {
    await ensureSchema();
    await seedData();
  } catch (err) {
    console.error('[startup]', err.message);
  }
});
