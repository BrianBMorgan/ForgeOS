var express = require('express');
var path = require('path');
var Anthropic = require('@anthropic-ai/sdk');

var app = express();
var PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

var SYSTEM_PROMPT = 'You are a rigorous fact-checking assistant. When given a claim or question, you must analyze it carefully and return a structured JSON response.\n\nYour response must be valid JSON with exactly these fields:\n{\n  "verdict": "TRUE" | "FALSE" | "UNDETERMINED",\n  "confidence": <integer 0-100>,\n  "summary": "<one sentence verdict summary>",\n  "explanation": "<2-4 sentence detailed reasoning>",\n  "sources": [\n    { "name": "<source name>", "url": "<credible URL or organization homepage>" }\n  ],\n  "tags": ["<topic tag>", ...]\n}\n\nRules:\n- verdict must be exactly TRUE, FALSE, or UNDETERMINED\n- confidence is 0-100 integer reflecting your certainty\n- sources must be real, credible organizations (use homepage URLs when exact article URL is uncertain)\n- tags are short topic labels (e.g. "science", "politics", "health")\n- Never include markdown, code fences, or extra text — only the raw JSON object';

function stripAndParseJSON(text) {
  if (text.includes('```')) {
    text = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '');
  }
  var firstBrace = text.search(/[{[]/);
  if (firstBrace > 0) {
    text = text.slice(firstBrace);
  }
  return JSON.parse(text);
}

var VALID_VERDICTS = ['TRUE', 'FALSE', 'UNDETERMINED'];

app.post('/api/check', function(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  var claim = req.body && req.body.claim;

  if (!claim || typeof claim !== 'string' || claim.trim().length === 0) {
    return res.status(400).json({ ok: false, error: 'Please provide a claim to fact-check.' });
  }

  if (claim.trim().length > 1000) {
    return res.status(400).json({ ok: false, error: 'Claim must be 1000 characters or fewer.' });
  }

  var client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: 'Fact-check this claim: ' + claim.trim() }
    ]
  }).then(function(response) {
    var rawText = response.content[0].text;
    var parsed;

    try {
      parsed = stripAndParseJSON(rawText);
    } catch (e) {
      console.error('Failed to parse AI response as JSON:', e.message);
      console.error('Raw response:', rawText);
      return res.status(500).json({ ok: false, error: 'Failed to parse AI response. Please try again.' });
    }

    if (!VALID_VERDICTS.includes(parsed.verdict)) {
      console.error('Invalid verdict received:', parsed.verdict);
      return res.status(500).json({ ok: false, error: 'Invalid verdict from AI. Please try again.' });
    }

    if (typeof parsed.confidence !== 'number' || parsed.confidence < 0 || parsed.confidence > 100) {
      parsed.confidence = 50;
    }

    if (!Array.isArray(parsed.sources)) parsed.sources = [];
    if (!Array.isArray(parsed.tags)) parsed.tags = [];
    if (!parsed.summary) parsed.summary = '';
    if (!parsed.explanation) parsed.explanation = '';

    return res.json({ ok: true, result: parsed });
  }).catch(function(err) {
    console.error('Anthropic API error:', err.message);
    if (err.message && err.message.includes('timeout')) {
      return res.status(504).json({ ok: false, error: 'Request timed out. Please try again.' });
    }
    return res.status(500).json({ ok: false, error: 'AI service error. Please try again.' });
  });
});

app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', function() {
  console.log('AI Fact Checker running on port ' + PORT);
});
