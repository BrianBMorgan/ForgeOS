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

app.get('/api/submissions', async function(req, res) {
  try {
    var sql = getDb();
    var eventId = req.query.event_id;
    var rows = eventId
      ? await sql`SELECT * FROM submissions WHERE event_id = ${eventId} ORDER BY created_at DESC`
      : await sql`SELECT * FROM submissions ORDER BY created_at DESC`;
    res.json({ ok: true, submissions: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/submissions', async function(req, res) {
  try {
    var sql = getDb();
    var b = req.body;
    var rows = await sql`INSERT INTO submissions
      (event_id, title, content_lead, bu, track, format, duration, intel_speakers, partner_speakers,
       abstract, key_topics, partner_highlights, demos, new_launches, featured_products, business_challenge, status)
      VALUES (${b.event_id}, ${b.title||''}, ${b.content_lead||''}, ${b.bu||''}, ${b.track||''},
        ${b.format||''}, ${b.duration||''}, ${b.intel_speakers||''}, ${b.partner_speakers||''},
        ${b.abstract||''}, ${b.key_topics||''}, ${b.partner_highlights||''}, ${b.demos||''},
        ${b.new_launches||''}, ${b.featured_products||''}, ${b.business_challenge||''}, ${b.status||'submitted'})
      RETURNING *`;
    res.json({ ok: true, submission: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/submissions/export', async function(req, res) {
  try {
    var sql = getDb();
    var eventId = req.query.event_id;
    var rows = eventId
      ? await sql`SELECT * FROM submissions WHERE event_id = ${eventId} ORDER BY created_at DESC`
      : await sql`SELECT * FROM submissions ORDER BY created_at DESC`;
    var fields = ['id','event_id','title','bu','track','format','duration','intel_speakers','partner_speakers','status'];
    var lines = [fields.join(',')];
    rows.forEach(function(r) {
      lines.push(fields.map(function(f) { return '"' + String(r[f]||'').replace(/"/g,'""') + '"'; }).join(','));
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="submissions.csv"');
    res.send(lines.join('\n'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/', function(req, res) {
  res.send(getHTML());
});

function getHTML() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Intel Event Content Review</title><style>@font-face{font-family:"IntelOneDisplay";src:url("/api/assets/IntelOneDisplay-Light.woff") format("woff");font-weight:300}@font-face{font-family:"IntelOneDisplay";src:url("/api/assets/IntelOneDisplay-Regular.woff") format("woff");font-weight:400}@font-face{font-family:"IntelOneDisplay";src:url("/api/assets/IntelOneDisplay-Medium.woff") format("woff");font-weight:500}@font-face{font-family:"IntelOneDisplay";src:url("/api/assets/IntelOneDisplay-Bold.woff") format("woff");font-weight:700}*{box-sizing:border-box;margin:0;padding:0;border-radius:0}html,body{height:100%;font-family:"IntelOneDisplay",sans-serif;background:#EAEAEA;color:#2E2F2F}body{display:flex;height:100vh;overflow:hidden}.sidebar{width:220px;background:#000864;color:#fff;display:flex;flex-direction:column;padding:20px;flex-shrink:0}.sidebar img{width:90px;margin-bottom:40px}.sidebar nav ul{list-style:none}.sidebar nav li a{display:block;padding:14px 0;color:#fff;text-decoration:none;font-size:1rem;font-weight:500;opacity:.7}.sidebar nav li a:hover,.sidebar nav li a.active{opacity:1;color:#00AAE8}.content-area{flex:1;overflow-y:auto;padding:30px}.content-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}.content-section{display:none}.content-section.active{display:block}h1{font-size:1.8rem;font-weight:600}h2{font-size:1.3rem;font-weight:500}button{font-family:"IntelOneDisplay",sans-serif;cursor:pointer;border:none;padding:10px 18px;font-size:.9rem;font-weight:500;background:#00AAE8;color:#fff}.btn-secondary{background:#2E2F2F}.btn-sm{padding:6px 12px;font-size:.8rem}button:disabled{background:#999;cursor:not-allowed}#events-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:20px}.event-card{background:#fff;border:1px solid #2E2F2F;padding:20px;cursor:pointer}.event-card:hover{background:#f4f4f4}.event-card h3{color:#000864;margin-bottom:10px;font-size:1.1rem}.event-card p{font-size:.85rem;margin-bottom:4px}.filter-bar{display:flex;gap:12px;margin-bottom:16px;align-items:center}.filter-bar select{padding:8px;border:1px solid #2E2F2F;font-family:"IntelOneDisplay",sans-serif;background:#fff}table{width:100%;border-collapse:collapse;background:#fff}th{background:#2E2F2F;color:#fff;padding:12px;text-align:left;font-weight:500;font-size:.85rem}td{padding:11px 12px;border-bottom:1px solid #EAEAEA;font-size:.85rem;vertical-align:middle}tbody tr:hover{background:#f0f8ff}tbody tr{cursor:pointer}.badge{padding:3px 8px;font-size:.75rem;font-weight:600;color:#fff;display:inline-block}.badge-submitted{background:#00AAE8}.badge-under_review{background:#000864}.badge-accepted{background:#1a7f37}.badge-declined{background:#c0392b}.badge-score-high{background:#1a7f37}.badge-score-med{background:#b8860b;color:#fff}.badge-score-low{background:#c0392b}.badge-score-none{background:#888}.panel-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:100}.panel-overlay.open{display:block}.slide-panel{position:fixed;top:0;right:-640px;width:600px;height:100%;background:#fff;border-left:1px solid #2E2F2F;z-index:101;display:flex;flex-direction:column;transition:right .3s ease}.slide-panel.open{right:0}.panel-head{background:#2E2F2F;color:#fff;padding:18px 20px;display:flex;justify-content:space-between;align-items:center;flex-shrink:0}.panel-head h2{margin:0;font-size:1.1rem}.panel-head button{background:transparent;color:#fff;font-size:1.2rem;padding:0 6px}.panel-body{padding:20px;overflow-y:auto;flex:1}.panel-foot{padding:16px 20px;border-top:1px solid #EAEAEA;flex-shrink:0;display:flex;gap:10px}.form-group{margin-bottom:14px}.form-group label{display:block;font-size:.85rem;font-weight:600;margin-bottom:5px}.form-group input,.form-group textarea,.form-group select{width:100%;padding:9px;border:1px solid #2E2F2F;font-family:"IntelOneDisplay",sans-serif;font-size:.9rem;background:#fff}.form-group textarea{resize:vertical;min-height:90px}.scorecard-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:14px 0}.dim-card{border:1px solid #EAEAEA;padding:12px;background:#fafafa}.dim-card-top{display:flex;justify-content:space-between;align-items:center;font-weight:600;font-size:.85rem;margin-bottom:6px}.dim-card p{font-size:.8rem;color:#555}.lists-row{display:flex;gap:20px;margin-top:10px}.lists-row ul{padding-left:18px;font-size:.83rem}.msg-center{padding:30px;text-align:center;color:#666}.loader{width:18px;height:18px;border:3px solid #ccc;border-top-color:#00AAE8;display:inline-block;animation:spin 1s linear infinite;vertical-align:middle;margin-left:8px}@keyframes spin{to{transform:rotate(360deg)}}.hidden{display:none!important}</style></head><body><div style="display:flex;height:100vh;width:100%;overflow:hidden"><aside class="sidebar"><img src="/api/assets/Logo.png" alt="Intel"><nav><ul><li><a href="#" id="nav-events" class="active">Events</a></li><li><a href="#" id="nav-submissions">Submissions</a></li><li><a href="#" id="nav-review">Review</a></li></ul></nav></aside><main class="content-area"><section id="sec-events" class="content-section active"><div class="content-header"><h1>Events</h1><button id="btn-new-event">+ New Event</button></div><div id="events-grid"><p class="msg-center">Loading events...</p></div></section><section id="sec-submissions" class="content-section"><div class="content-header"><div><h1>Submissions</h1><div id="sub-event-label" style="font-size:.9rem;color:#555"></div></div><button id="btn-add-sub">+ Add Submission</button></div><div class="filter-bar"><select id="filter-track"><option value="">All Tracks</option></select><select id="filter-status"><option value="">All Statuses</option><option value="submitted">Submitted</option><option value="under_review">Under Review</option><option value="accepted">Accepted</option><option value="declined">Declined</option></select></div><table><thead><tr><th>Title</th><th>BU</th><th>Track</th><th>Format</th><th>Speakers</th><th>Status</th><th>AI Score</th></tr></thead><tbody id="sub-tbody"></tbody></table><div id="sub-msg" class="msg-center">Select an event to view submissions.</div></section><section id="sec-review" class="content-section"><div class="content-header"><div><h1>Review</h1><div id="rev-event-label" style="font-size:.9rem;color:#555"></div></div><div style="display:flex;gap:10px"><button id="btn-export" class="btn-secondary">Export CSV</button><button id="btn-score-all">Score All <span id="score-loader" class="loader hidden"></span></button></div></div><table><thead><tr><th>Title</th><th>Track</th><th>Score</th><th>Recommendation</th><th>Actions</th></tr></thead><tbody id="rev-tbody"></tbody></table><div id="rev-msg" class="msg-center">Select an event to review.</div></section></main></div><div id="overlay" class="panel-overlay"></div><div id="panel-event" class="slide-panel"><div class="panel-head"><h2>New Event</h2><button id="close-event-panel">&#x2715;</button></div><div class="panel-body"><div id="step1"><div class="form-group"><label>Event Name *</label><input id="ev-name"></div><div class="form-group"><label>Date</label><input id="ev-date" type="text" placeholder="e.g. April 27-28, 2026"></div><div class="form-group"><label>Venue</label><input id="ev-venue"></div><div class="form-group"><label>Slot Count</label><input id="ev-slots" type="number" value="0"></div></div><div id="step2" class="hidden"><p style="margin-bottom:12px;font-size:.9rem">Event created. Optionally paste a strategy document to auto-generate the AI scoring profile.</p><div class="form-group"><label>Strategy Document</label><textarea id="ev-strategy" style="min-height:200px" placeholder="Paste strategy doc here..."></textarea></div></div></div><div class="panel-foot"><button id="btn-create-ev">Create Event</button><button id="btn-gen-profile" class="btn-secondary hidden">Generate AI Profile <span id="gen-loader" class="loader hidden"></span></button><button id="btn-skip-profile" class="btn-secondary hidden">Skip</button></div></div><div id="panel-sub" class="slide-panel"><div class="panel-head"><h2 id="sub-panel-title">Add Submission</h2><button id="close-sub-panel">&#x2715;</button></div><div class="panel-body"><input type="hidden" id="sub-id"><div class="form-group"><label>Title *</label><input id="sub-title"></div><div class="form-group"><label>Business Unit</label><input id="sub-bu"></div><div class="form-group"><label>Track</label><input id="sub-track"></div><div class="form-group"><label>Format</label><input id="sub-format"></div><div class="form-group"><label>Speakers</label><input id="sub-speakers"></div><div class="form-group"><label>Abstract</label><textarea id="sub-abstract" style="min-height:140px"></textarea></div><div class="form-group"><label>Topics</label><input id="sub-topics"></div><div class="form-group"><label>Demos</label><input id="sub-demos"></div><div class="form-group"><label>Products</label><input id="sub-products"></div><div class="form-group"><label>Status</label><select id="sub-status"><option value="submitted">Submitted</option><option value="under_review">Under Review</option><option value="accepted">Accepted</option><option value="declined">Declined</option></select></div></div><div class="panel-foot"><button id="btn-save-sub">Save</button></div></div><script>(function(){
var currentEventId=null;
var currentEventName=null;
var allSubmissions=[];

function esc(s){if(!s)return"";return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function scoreBadge(s){if(s===null||s===undefined)return"<span class=\"badge badge-score-none\">N/A</span>";var c=s>=80?"high":s>=60?"med":"low";return"<span class=\"badge badge-score-"+c+"\">"+s+"</span>";}
function statusBadge(s){return"<span class=\"badge badge-"+s+"\">"+esc(s.replace("_"," "))+"</span>";}

function showSection(id){
  ["events","submissions","review"].forEach(function(n){
    document.getElementById("sec-"+n).classList.remove("active");
    document.getElementById("nav-"+n).classList.remove("active");
  });
  document.getElementById("sec-"+id).classList.add("active");
  document.getElementById("nav-"+id).classList.add("active");
  if(id==="submissions")loadSubmissions();
  if(id==="review")loadReview();
}

document.getElementById("nav-events").addEventListener("click",function(e){e.preventDefault();showSection("events");});
document.getElementById("nav-submissions").addEventListener("click",function(e){e.preventDefault();showSection("submissions");});
document.getElementById("nav-review").addEventListener("click",function(e){e.preventDefault();showSection("review");});

function loadEvents(){
  fetch("/api/events").then(function(r){return r.json();}).then(function(data){
    var events=data.events||data;
    var grid=document.getElementById("events-grid");
    if(!events||!events.length){grid.innerHTML="<p class=\"msg-center\">No events yet.</p>";return;}
    grid.innerHTML="";
    events.forEach(function(ev){
      var card=document.createElement("div");
      card.className="event-card";
      card.innerHTML="<h3>"+esc(ev.name)+"</h3><p><strong>Date:</strong> "+esc(ev.event_date||"TBD")+"</p><p><strong>Venue:</strong> "+esc(ev.venue||"TBD")+"</p><p><strong>Slots:</strong> "+esc(ev.slot_count)+"</p>";
      card.addEventListener("click",function(){
        currentEventId=ev.id;
        currentEventName=ev.name;
        document.getElementById("sub-event-label").textContent=ev.name;
        document.getElementById("rev-event-label").textContent=ev.name;
        showSection("submissions");
      });
      grid.appendChild(card);
    });
  }).catch(function(e){document.getElementById("events-grid").innerHTML="<p class=\"msg-center\">Error loading events.</p>";console.error(e);});}

function loadSubmissions(){
  var tbody=document.getElementById("sub-tbody");
  var msg=document.getElementById("sub-msg");
  if(!currentEventId){tbody.innerHTML="";msg.textContent="Select an event to view submissions.";msg.classList.remove("hidden");return;}
  msg.textContent="Loading...";msg.classList.remove("hidden");
  var track=document.getElementById("filter-track").value;
  var status=document.getElementById("filter-status").value;
  fetch("/api/events/"+currentEventId+"/submissions").then(function(r){return r.json();}).then(function(data){
    allSubmissions=data.submissions||data;
    var rows=allSubmissions.filter(function(s){
      return(!track||s.track===track)&&(!status||s.status===status);
    });
    var tracks=[...new Set(allSubmissions.map(function(s){return s.track;}).filter(Boolean))];
    var tf=document.getElementById("filter-track");
    tf.innerHTML="<option value=\"\">All Tracks</option>";
    tracks.forEach(function(t){tf.innerHTML+="<option value=\""+esc(t)+"\">"+esc(t)+"</option>";});
    if(track)tf.value=track;
    tbody.innerHTML="";
    if(!rows.length){msg.textContent="No submissions match the current filters.";return;}
    msg.classList.add("hidden");
    rows.forEach(function(s){
      var tr=document.createElement("tr");
      tr.innerHTML="<td>"+esc(s.title)+"</td><td>"+esc(s.bu)+"</td><td>"+esc(s.track)+"</td><td>"+esc(s.format)+"</td><td>"+esc(s.speakers)+"</td><td>"+statusBadge(s.status||"submitted")+"</td><td>"+scoreBadge(s.ai_score)+"</td>";
      tr.addEventListener("click",function(){openSubPanel(s);});
      tbody.appendChild(tr);
    });
  }).catch(function(e){msg.textContent="Error loading submissions.";console.error(e);});}

function loadReview(){
  var tbody=document.getElementById("rev-tbody");
  var msg=document.getElementById("rev-msg");
  if(!currentEventId){tbody.innerHTML="";msg.textContent="Select an event to review.";msg.classList.remove("hidden");return;}
  msg.textContent="Loading...";msg.classList.remove("hidden");
  fetch("/api/events/"+currentEventId+"/submissions").then(function(r){return r.json();}).then(function(data){
    var subs=data.submissions||data;
    subs.sort(function(a,b){return(b.ai_score||0)-(a.ai_score||0);});
    tbody.innerHTML="";
    if(!subs.length){msg.textContent="No submissions for this event.";return;}
    msg.classList.add("hidden");
    subs.forEach(function(s){
      var sc=s.ai_scorecard;
      var rec=sc?(sc.recommendation||sc.summary&&sc.summary.overall_recommendation||"--"):"Not scored";
      var tr=document.createElement("tr");
      tr.innerHTML="<td>"+esc(s.title)+"</td><td>"+esc(s.track)+"</td><td>"+scoreBadge(s.ai_score)+"</td><td><span class=\"badge\" style=\"background:#000864\">"+esc(rec)+"</span></td><td><button class=\"btn-sm btn-score\" data-id=\""+s.id+"\">Score</button>"+( sc?" <button class=\"btn-sm btn-view\" data-id=\""+s.id+"\">Scorecard</button>":"")+"</td>";
      tbody.appendChild(tr);
      if(sc){
        var dr=document.createElement("tr");
        dr.id="sc-row-"+s.id;
        dr.classList.add("hidden");
        dr.innerHTML="<td colspan=\"5\" style=\"padding:16px;background:#fafafa;border-bottom:2px solid #EAEAEA\">"+buildScorecardHTML(sc)+"</td>";
        tbody.appendChild(dr);
      }
    });
  }).catch(function(e){msg.textContent="Error loading review.";console.error(e);});}

function buildScorecardHTML(sc){
  var dims=sc.dimensions||sc.scores||{};
  var dimNames=["federal_relevance","technical_depth","intel_alignment","audience_fit","innovation_signal","delivery_readiness"];
  var grid="<div class=\"scorecard-grid\">";
  dimNames.forEach(function(k){
    var d=dims[k]||{};
    var label=k.replace(/_/g," ").replace(/\b\w/g,function(c){return c.toUpperCase();});
    grid+="<div class=\"dim-card\"><div class=\"dim-card-top\"><span>"+esc(label)+"</span>"+scoreBadge(d.score)+"</div><p>"+esc(d.rationale||"")+"</p></div>";
  });
  grid+="</div>";
  var strengths=(sc.strengths||sc.summary&&sc.summary.strengths||[]);
  var gaps=(sc.gaps||sc.summary&&sc.summary.gaps||[]);
  var sl="<ul>"+strengths.map(function(x){return"<li>"+esc(x)+"</li>";}).join("")+"</ul>";
  var gl="<ul>"+gaps.map(function(x){return"<li>"+esc(x)+"</li>";}).join("")+"</ul>";
  return grid+"<div class=\"lists-row\"><div><strong>Strengths</strong>"+sl+"</div><div><strong>Gaps</strong>"+gl+"</div></div>";}

document.getElementById("rev-tbody").addEventListener("click",function(e){
  if(e.target.classList.contains("btn-score")){
    var id=e.target.getAttribute("data-id");
    e.target.textContent="Scoring...";
    e.target.disabled=true;
    fetch("/api/submissions/"+id+"/score",{method:"POST"}).then(function(r){return r.json();}).then(function(){loadReview();}).catch(function(){e.target.textContent="Score";e.target.disabled=false;});}
  if(e.target.classList.contains("btn-view")){
    var id=e.target.getAttribute("data-id");
    var row=document.getElementById("sc-row-"+id);
    if(row)row.classList.toggle("hidden");}});

document.getElementById("btn-score-all").addEventListener("click",function(){
  if(!currentEventId)return;
  var loader=document.getElementById("score-loader");
  var btn=document.getElementById("btn-score-all");
  loader.classList.remove("hidden");btn.disabled=true;
  fetch("/api/events/"+currentEventId+"/score-all",{method:"POST"}).then(function(r){return r.json();}).then(function(){loadReview();loader.classList.add("hidden");btn.disabled=false;}).catch(function(){loader.classList.add("hidden");btn.disabled=false;});});

document.getElementById("btn-export").addEventListener("click",function(){
  if(!currentEventId)return;
  var rows=[["ID","Title","BU","Track","Format","Speakers","Status","AI Score"]];
  allSubmissions.forEach(function(s){rows.push([s.id,s.title,s.bu,s.track,s.format,s.speakers,s.status,s.ai_score||""]);});
  var csv=rows.map(function(r){return r.map(function(c){return"\""+String(c||"").replace(/"/g,"\"\"")+"\"";}).join(",");}).join("\n");
  var a=document.createElement("a");a.href="data:text/csv;charset=utf-8,"+encodeURIComponent(csv);a.download="submissions.csv";a.click();});

function openPanel(id){document.getElementById(id).classList.add("open");document.getElementById("overlay").classList.add("open");}
function closePanels(){["panel-event","panel-sub"].forEach(function(id){document.getElementById(id).classList.remove("open");});document.getElementById("overlay").classList.remove("open");}
document.getElementById("overlay").addEventListener("click",closePanels);
document.getElementById("close-event-panel").addEventListener("click",closePanels);
document.getElementById("close-sub-panel").addEventListener("click",closePanels);

document.getElementById("btn-new-event").addEventListener("click",function(){
  document.getElementById("step1").classList.remove("hidden");
  document.getElementById("step2").classList.add("hidden");
  document.getElementById("btn-create-ev").classList.remove("hidden");
  document.getElementById("btn-gen-profile").classList.add("hidden");
  document.getElementById("btn-skip-profile").classList.add("hidden");
  ["ev-name","ev-date","ev-venue","ev-slots","ev-strategy"].forEach(function(id){document.getElementById(id).value="";});
  document.getElementById("ev-slots").value="0";
  openPanel("panel-event");});

var newEvId=null;
document.getElementById("btn-create-ev").addEventListener("click",function(){
  var name=document.getElementById("ev-name").value.trim();
  if(!name){alert("Event name is required.");return;}
  var body={name:name,event_date:document.getElementById("ev-date").value,venue:document.getElementById("ev-venue").value,slot_count:parseInt(document.getElementById("ev-slots").value)||0};
  fetch("/api/events",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json();}).then(function(data){
    newEvId=(data.event||data).id;
    loadEvents();
    document.getElementById("step1").classList.add("hidden");
    document.getElementById("step2").classList.remove("hidden");
    document.getElementById("btn-create-ev").classList.add("hidden");
    document.getElementById("btn-gen-profile").classList.remove("hidden");
    document.getElementById("btn-skip-profile").classList.remove("hidden");
  }).catch(function(e){alert("Failed to create event.");console.error(e);});});

document.getElementById("btn-gen-profile").addEventListener("click",function(){
  var doc=document.getElementById("ev-strategy").value.trim();
  if(!doc){alert("Paste a strategy document first.");return;}
  var loader=document.getElementById("gen-loader");
  var btn=document.getElementById("btn-gen-profile");
  loader.classList.remove("hidden");btn.disabled=true;
  fetch("/api/events/"+newEvId+"/generate-profile",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({strategy_doc:doc})}).then(function(r){return r.json();}).then(function(){loader.classList.add("hidden");btn.disabled=false;closePanels();loadEvents();}).catch(function(e){loader.classList.add("hidden");btn.disabled=false;console.error(e);});});

document.getElementById("btn-skip-profile").addEventListener("click",closePanels);

document.getElementById("btn-add-sub").addEventListener("click",function(){openSubPanel(null);});

function openSubPanel(s){
  document.getElementById("sub-panel-title").textContent=s?"Edit Submission":"Add Submission";
  document.getElementById("sub-id").value=s?s.id:"";
  ["title","bu","track","format","speakers","abstract","topics","demos","products"].forEach(function(f){
    document.getElementById("sub-"+f).value=s?(s[f]||""): "";});
  document.getElementById("sub-status").value=s?(s.status||"submitted"): "submitted";
  openPanel("panel-sub");}

document.getElementById("btn-save-sub").addEventListener("click",function(){
  var id=document.getElementById("sub-id").value;
  var title=document.getElementById("sub-title").value.trim();
  if(!title){alert("Title is required.");return;}
  var body={event_id:currentEventId,title:title,bu:document.getElementById("sub-bu").value,track:document.getElementById("sub-track").value,format:document.getElementById("sub-format").value,speakers:document.getElementById("sub-speakers").value,abstract:document.getElementById("sub-abstract").value,topics:document.getElementById("sub-topics").value,demos:document.getElementById("sub-demos").value,products:document.getElementById("sub-products").value,status:document.getElementById("sub-status").value};
  var url=id?("/api/submissions/"+id):"/api/events/"+currentEventId+"/submissions";
  var method=id?"PUT":"POST";
  fetch(url,{method:method,headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json();}).then(function(){closePanels();loadSubmissions();}).catch(function(e){alert("Failed to save submission.");console.error(e);});});

document.getElementById("filter-track").addEventListener("change",loadSubmissions);
document.getElementById("filter-status").addEventListener("change",loadSubmissions);

loadEvents();
})();<\/script></body></html>';
}
app.listen(PORT, '0.0.0.0', async function() {
  console.log('[server] listening on port ' + PORT);
  try {
    await ensureSchema();
    await seedData();
  } catch (err) {
    console.error('[startup]', err.message);
  }
});
