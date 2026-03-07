const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 4000;

// Body parsing with strict size limit
app.use(express.json({ limit: '10kb' }));

// Static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Health
app.get('/health', (req, res) => {
  res.type('text/plain').send('OK');
});

// Root route (mandatory)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ error: 'rate_limited' });
  }
});

function validatePrompt(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, status: 400, body: { error: 'prompt_required' } };
  }
  const prompt = raw.trim();
  if (!prompt) {
    return { ok: false, status: 400, body: { error: 'prompt_required' } };
  }
  if (prompt.length > 500) {
    return { ok: false, status: 400, body: { error: 'prompt_too_long' } };
  }
  return { ok: true, prompt };
}

async function generateAffirmation(prompt) {
  // Do not log prompts or secrets.
  if (!process.env.OPENAI_API_KEY) {
    // Never exit; return a safe error.
    const err = new Error('OPENAI_API_KEY not configured');
    err.code = 'MISSING_OPENAI_KEY';
    throw err;
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const system = [
    'You write short, specific, uplifting daily affirmations.',
    'Return only the affirmation text. No quotes. No preamble. No bullet points.',
    'Keep it to 1-3 sentences, warm and grounded, not overly cheesy.',
    'Avoid medical, legal, or financial advice.',
    'Make it relevant to the user\'s day description.'
  ].join(' ');

  const user = `My day: ${prompt}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4.1-mini',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0.8,
    max_tokens: 120
  });

  const text = (completion.choices && completion.choices[0] && completion.choices[0].message && completion.choices[0].message.content) || '';
  return String(text).trim();
}

async function handleAffirmation(req, res) {
  try {
    const v = validatePrompt(req.body && req.body.prompt);
    if (!v.ok) return res.status(v.status).json(v.body);

    const affirmation = await generateAffirmation(v.prompt);
    if (!affirmation) {
      return res.status(502).json({ error: 'upstream_failed' });
    }

    return res.json({ affirmation });
  } catch (err) {
    if (err && err.code === 'MISSING_OPENAI_KEY') {
      return res.status(500).json({ error: 'server_not_configured' });
    }
    // Do not leak stack traces.
    return res.status(502).json({ error: 'upstream_failed' });
  }
}

// Primary route
app.post('/api/affirmation', limiter, handleAffirmation);

// Compatibility route (for relative fetch from nested paths)
app.post('/affirmation', limiter, handleAffirmation);

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
