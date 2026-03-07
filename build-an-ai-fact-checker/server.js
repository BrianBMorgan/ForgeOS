const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a rigorous fact-checking assistant. When given a claim or question, analyze it carefully and return a structured JSON response.

Your response must be valid JSON with exactly this structure:
{
  "verdict": "<one of: TRUE, FALSE, MOSTLY_TRUE, MOSTLY_FALSE, AMBIGUOUS, UNVERIFIABLE, MISLEADING>",
  "confidence": <integer 0-100>,
  "summary": "<one sentence verdict summary>",
  "explanation": "<2-4 paragraphs of detailed explanation>",
  "sources": [
    { "title": "<source name>", "url": "<credible URL or organization homepage>" }
  ],
  "tags": ["<topic tag>", "<topic tag>"]
}

Verdict definitions:
- TRUE: Claim is accurate and well-supported by evidence
- FALSE: Claim is factually incorrect
- MOSTLY_TRUE: Claim is largely accurate with minor inaccuracies or missing context
- MOSTLY_FALSE: Claim contains a kernel of truth but is largely misleading or incorrect
- AMBIGUOUS: Claim is unclear, depends heavily on interpretation, or evidence is mixed
- UNVERIFIABLE: Claim cannot be confirmed or denied with available evidence
- MISLEADING: Claim may be technically true but is framed to create a false impression

Rules:
- confidence reflects your certainty in the verdict (0=no idea, 100=absolute certainty)
- Include 2-4 credible sources (academic, government, major news, scientific organizations)
- Only use real, credible source URLs — prefer organization homepages if exact article URL is uncertain
- tags should be 2-5 short topic labels
- Never fabricate facts; if uncertain, use UNVERIFIABLE or AMBIGUOUS
- Return ONLY the JSON object, no markdown fences, no extra text`;

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/check', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const { claim } = req.body;

  if (!claim || typeof claim !== 'string') {
    return res.status(400).json({ error: 'A claim string is required.' });
  }

  const trimmed = claim.trim().slice(0, 1000);
  if (!trimmed) {
    return res.status(400).json({ error: 'Claim cannot be empty.' });
  }

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: trimmed }]
    });

    let text = response.content[0].text;

    if (text.includes('```')) {
      text = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '');
    }
    const firstBrace = text.search(/[{[]/);
    if (firstBrace > 0) text = text.slice(firstBrace);

    const parsed = JSON.parse(text);

    const validVerdicts = ['TRUE', 'FALSE', 'MOSTLY_TRUE', 'MOSTLY_FALSE', 'AMBIGUOUS', 'UNVERIFIABLE', 'MISLEADING'];
    if (!validVerdicts.includes(parsed.verdict)) {
      parsed.verdict = 'AMBIGUOUS';
    }
    if (typeof parsed.confidence !== 'number') {
      parsed.confidence = 50;
    }
    parsed.confidence = Math.max(0, Math.min(100, Math.round(parsed.confidence)));

    return res.json(parsed);
  } catch (err) {
    console.error('Fact-check error:', err.message);
    return res.status(500).json({ error: 'Failed to process the claim. Please try again.' });
  }
});

app.listen(PORT, () => {
  console.log('Fact Checker running on port ' + PORT);
});
