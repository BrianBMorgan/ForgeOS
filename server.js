const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');
const Anthropic = require('@anthropic-ai/sdk');
const FormData = require('form-data');

const app = express();
const PORT = process.env.PORT || 3000;

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

async function fetchUrlContent(url) {
  try {
    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ArtDirectorBot/1.0)'
      },
      responseType: 'arraybuffer'
    });
    const contentType = response.headers['content-type'] || '';
    if (contentType.startsWith('image/')) {
      const base64 = Buffer.from(response.data).toString('base64');
      const mediaType = contentType.split(';')[0].trim();
      return { type: 'image', base64, mediaType, url };
    } else {
      const html = Buffer.from(response.data).toString('utf-8');
      const $ = cheerio.load(html);
      $('script, style, nav, footer, header').remove();
      const title = $('title').text().trim();
      const metaDesc = $('meta[name="description"]').attr('content') || '';
      const ogImage = $('meta[property="og:image"]').attr('content') || '';
      const bodyText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 2000);
      return { type: 'webpage', title, metaDesc, ogImage, bodyText, url };
    }
  } catch (err) {
    return { type: 'error', url, error: err.message };
  }
}

function buildSystemPrompt(outputFormat) {
  const formatInstructions = {
    concepts: 'Generate 5 distinct creative concepts, each with a title, visual direction, mood/atmosphere, color palette suggestion, and key visual elements.',
    moodboard: 'Describe a detailed moodboard with visual themes, textures, color stories, typography direction, and imagery suggestions organized into cohesive sections. For each major visual theme or section, write a concise image generation prompt (under 75 words) that could be used to generate a representative image. Label these clearly as "IMAGE PROMPT:" followed by the prompt text.',
    styleGuide: 'Create a comprehensive style guide with visual identity direction, color system, typography hierarchy, imagery style, and design principles.',
    shotList: 'Generate a detailed shot list with scene descriptions, camera angles, lighting setups, props, and styling notes for each shot.',
    brief: 'Write a comprehensive creative brief with project overview, target audience, creative direction, visual references to seek, deliverables, and do/don\'t guidelines.',
    freeform: 'Provide rich, expansive creative direction ideas in whatever format best serves the prompt and references provided.'
  };
  const instruction = formatInstructions[outputFormat] || formatInstructions.freeform;
  return 'You are an expert AI Art Director with decades of experience across advertising, editorial, fashion, branding, and digital media. Your role is to analyze creative prompts and visual references to generate sophisticated, actionable art direction.\n\nOutput Format Instruction: ' + instruction + '\n\nGuidelines:\n- Be specific, evocative, and professionally precise\n- Reference visual culture, art movements, photographers, directors, and designers when relevant\n- Consider practical production realities alongside creative ambition\n- Use industry-standard terminology\n- Build meaningfully upon any provided references rather than ignoring them\n- Your output should inspire and guide a creative team to execute with clarity and vision\n- Format your response with clear headers, bullet points where appropriate, and rich descriptive language';
}

function buildRefinementSystemPrompt(outputFormat) {
  return buildSystemPrompt(outputFormat) + '\n\nIMPORTANT: You are refining a previous creative direction. The user has reviewed your initial output and is providing additional guidance. Acknowledge what worked, evolve what needs changing, and push the creative direction further based on their refinement notes. Maintain continuity with strong elements while boldly evolving the direction.';
}

async function buildMessageContent(prompt, files, urlContents) {
  const content = [];
  let textContext = 'Creative Prompt: ' + prompt + '\n\n';
  const webRefs = urlContents.filter(u => u.type === 'webpage');
  const imageUrlRefs = urlContents.filter(u => u.type === 'image');
  const errorRefs = urlContents.filter(u => u.type === 'error');
  if (webRefs.length > 0) {
    textContext += 'Web References Analyzed:\n';
    webRefs.forEach((ref, i) => {
      textContext += '\nReference ' + (i + 1) + ': ' + ref.url + '\n';
      if (ref.title) textContext += 'Title: ' + ref.title + '\n';
      if (ref.metaDesc) textContext += 'Description: ' + ref.metaDesc + '\n';
      if (ref.bodyText) textContext += 'Content excerpt: ' + ref.bodyText.slice(0, 500) + '\n';
    });
    textContext += '\n';
  }
  if (errorRefs.length > 0) {
    textContext += 'Note: Some URLs could not be fetched: ' + errorRefs.map(e => e.url).join(', ') + '\n\n';
  }
  content.push({ type: 'text', text: textContext });
  imageUrlRefs.forEach(ref => {
    content.push({ type: 'text', text: 'Image reference from URL: ' + ref.url });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: ref.mediaType, data: ref.base64 }
    });
  });
  files.forEach((file, i) => {
    content.push({ type: 'text', text: 'Uploaded image reference ' + (i + 1) + ': ' + file.originalname });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: file.mimetype, data: file.buffer.toString('base64') }
    });
  });
  return content;
}

async function generateMoodboardImages(moodboardText) {
  const stabilityApiKey = process.env.STABILITYAI_API_KEY;
  if (!stabilityApiKey) {
    console.warn('STABILITYAI_API_KEY not set — skipping image generation');
    return [];
  }

  const imagePromptRegex = /IMAGE PROMPT:\s*([^\n]+(?:\n(?!IMAGE PROMPT:)[^\n]+)*)/gi;
  const concepts = [];
  let match;
  while ((match = imagePromptRegex.exec(moodboardText)) !== null) {
    const promptText = match[1].trim().replace(/\s+/g, ' ');
    if (promptText.length > 0) {
      concepts.push(promptText);
    }
  }

  const limitedConcepts = concepts.slice(0, 4);

  if (limitedConcepts.length === 0) {
    return [];
  }

  const results = [];

  for (const concept of limitedConcepts) {
    try {
      const formData = new FormData();
      formData.append('prompt', concept);
      formData.append('output_format', 'png');

      const response = await axios.post(
        'https://api.stability.ai/v2beta/stable-image/generate/ultra',
        formData,
        {
          headers: {
            ...formData.getHeaders(),
            Accept: 'application/json',
            Authorization: 'Bearer ' + stabilityApiKey
          },
          timeout: 20000
        }
      );

      if (response.data && response.data.image) {
        results.push({
          concept,
          imageUrl: 'data:image/png;base64,' + response.data.image
        });
      }
    } catch (err) {
      const errDetail = err.response ? JSON.stringify(err.response.data) : err.message;
      console.error('Stability API error for concept "' + concept + '":', errDetail);
    }
  }

  return results;
}

app.post('/api/generate', upload.array('files', 10), async (req, res) => {
  try {
    const client = new Anthropic();
    const { prompt, urls, outputFormat, previousOutput } = req.body;
    const files = req.files || [];
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: 'A creative prompt is required.' });
    }
    let urlList = [];
    if (urls) {
      try {
        urlList = JSON.parse(urls);
      } catch (e) {
        urlList = urls.split('\n').map(u => u.trim()).filter(Boolean);
      }
    }
    const urlContents = await Promise.all(urlList.map(url => fetchUrlContent(url)));
    const messageContent = await buildMessageContent(prompt, files, urlContents);
    const isRefinement = previousOutput && previousOutput.trim().length > 0;
    if (isRefinement) {
      messageContent.push({
        type: 'text',
        text: '\n\nPREVIOUS ART DIRECTION OUTPUT:\n' + previousOutput + '\n\nREFINEMENT REQUEST: ' + prompt
      });
    }
    const systemPrompt = isRefinement
      ? buildRefinementSystemPrompt(outputFormat || 'freeform')
      : buildSystemPrompt(outputFormat || 'freeform');
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: messageContent }]
    });
    let outputText = response.content[0].text;

    const responsePayload = {
      success: true,
      output: outputText,
      outputFormat: outputFormat || 'freeform',
      isRefinement
    };

    if ((outputFormat || 'freeform') === 'moodboard') {
      try {
        const moodboardImages = await generateMoodboardImages(outputText);
        responsePayload.moodboardImages = moodboardImages;
      } catch (imgErr) {
        console.error('Moodboard image generation failed:', imgErr.message);
        responsePayload.moodboardImages = [];
      }
    }

    res.json(responsePayload);
  } catch (err) {
    console.error('Generate error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate art direction.' });
  }
});

app.get('/', (req, res) => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Art Director Companion</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0a0a0f;
      --surface: #13131a;
      --surface2: #1c1c28;
      --border: #2a2a3d;
      --accent: #7c6af7;
      --accent2: #e040fb;
      --accent3: #00e5ff;
      --text: #e8e8f0;
      --text-muted: #7a7a9a;
      --success: #00e676;
      --error: #ff5252;
      --radius: 12px;
      --radius-sm: 8px;
    }
    html, body { height: 100%; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      overflow-x: hidden;
    }
    .app-header {
      padding: 24px 32px;
      border-bottom: 1px solid var(--border);
      background: var(--surface);
      display: flex;
      align-items: center;
      gap: 16px;
      position: sticky;
      top: 0;
      z-index: 100;
      backdrop-filter: blur(12px);
    }
    .logo {
      width: 40px;
      height: 40px;
      background: linear-gradient(135deg, var(--accent), var(--accent2));
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      flex-shrink: 0;
    }
    .app-title {
      font-size: clamp(16px, 2vw, 22px);
      font-weight: 700;
      background: linear-gradient(135deg, var(--accent), var(--accent2), var(--accent3));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      letter-spacing: -0.5px;
    }
    .app-subtitle {
      font-size: 13px;
      color: var(--text-muted);
      margin-left: auto;
    }
    .main-layout {
      display: grid;
      grid-template-columns: 420px 1fr;
      min-height: calc(100vh - 73px);
    }
    .sidebar {
      background: var(--surface);
      border-right: 1px solid var(--border);
      padding: 28px 24px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 24px;
    }
    .output-panel {
      padding: 32px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 24px;
    }
    .section-label {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 1.5px;
      text-transform: uppercase;
      color: var(--text-muted);
      margin-bottom: 10px;
    }
    .form-group { display: flex; flex-direction: column; gap: 8px; }
    textarea, input[type="text"] {
      background: var(--surface2);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text);
      font-family: inherit;
      font-size: 14px;
      padding: 12px 14px;
      resize: vertical;
      transition: border-color 0.2s;
      width: 100%;
    }
    textarea:focus, input[type="text"]:focus {
      outline: none;
      border-color: var(--accent);
    }
    textarea::placeholder, input::placeholder { color: var(--text-muted); }
    #prompt { min-height: 120px; }
    .output-format-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .format-option {
      position: relative;
    }
    .format-option input[type="radio"] {
      position: absolute;
      opacity: 0;
      width: 0;
      height: 0;
    }
    .format-option label {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 10px 12px;
      background: var(--surface2);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: all 0.2s;
      font-size: 13px;
      font-weight: 600;
    }
    .format-option label span {
      font-size: 10px;
      font-weight: 400;
      color: var(--text-muted);
    }
    .format-option input:checked + label {
      border-color: var(--accent);
      background: rgba(124, 106, 247, 0.12);
      color: var(--accent);
    }
    .format-option label:hover {
      border-color: var(--accent);
    }
    .url-list { display: flex; flex-direction: column; gap: 8px; }
    .url-row {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .url-row input { flex: 1; }
    .btn-icon {
      background: var(--surface2);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text-muted);
      cursor: pointer;
      font-size: 18px;
      height: 40px;
      width: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
      flex-shrink: 0;
    }
    .btn-icon:hover { border-color: var(--accent); color: var(--accent); }
    .btn-add-url {
      background: none;
      border: 1px dashed var(--border);
      border-radius: var(--radius-sm);
      color: var(--text-muted);
      cursor: pointer;
      font-size: 13px;
      padding: 8px;
      text-align: center;
      transition: all 0.2s;
      width: 100%;
    }
    .btn-add-url:hover { border-color: var(--accent); color: var(--accent); }
    .upload-zone {
      border: 2px dashed var(--border);
      border-radius: var(--radius);
      padding: 24px;
      text-align: center;
      cursor: pointer;
      transition: all 0.2s;
      position: relative;
    }
    .upload-zone:hover, .upload-zone.drag-over {
      border-color: var(--accent);
      background: rgba(124, 106, 247, 0.05);
    }
    .upload-zone input[type="file"] {
      position: absolute;
      inset: 0;
      opacity: 0;
      cursor: pointer;
      width: 100%;
      height: 100%;
    }
    .upload-icon { font-size: 28px; margin-bottom: 8px; }
    .upload-text { font-size: 13px; color: var(--text-muted); }
    .upload-text strong { color: var(--text); }
    .file-previews {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
    }
    .file-preview {
      position: relative;
      width: 72px;
      height: 72px;
      border-radius: var(--radius-sm);
      overflow: hidden;
      border: 1px solid var(--border);
    }
    .file-preview img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .file-preview .remove-file {
      position: absolute;
      top: 2px;
      right: 2px;
      background: rgba(0,0,0,0.7);
      border: none;
      border-radius: 50%;
      color: white;
      cursor: pointer;
      font-size: 12px;
      width: 20px;
      height: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      line-height: 1;
    }
    .btn-generate {
      background: linear-gradient(135deg, var(--accent), var(--accent2));
      border: none;
      border-radius: var(--radius);
      color: white;
      cursor: pointer;
      font-family: inherit;
      font-size: 15px;
      font-weight: 700;
      letter-spacing: 0.3px;
      padding: 14px 24px;
      transition: all 0.2s;
      width: 100%;
    }
    .btn-generate:hover { opacity: 0.9; transform: translateY(-1px); }
    .btn-generate:active { transform: translateY(0); }
    .btn-generate:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      flex: 1;
      gap: 16px;
      color: var(--text-muted);
      text-align: center;
      padding: 60px 40px;
    }
    .empty-icon { font-size: 64px; opacity: 0.3; }
    .empty-title { font-size: 20px; font-weight: 600; color: var(--text); opacity: 0.5; }
    .empty-desc { font-size: 14px; max-width: 320px; line-height: 1.6; }
    .output-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
      animation: slideIn 0.4s ease;
    }
    @keyframes slideIn {
      from { opacity: 0; transform: translateY(16px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .output-card-header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: var(--surface2);
      cursor: pointer;
      user-select: none;
    }
    .output-card-header:hover {
      background: rgba(124, 106, 247, 0.08);
    }
    .output-card-header-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .output-badge {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 1px;
      text-transform: uppercase;
      padding: 4px 10px;
      border-radius: 20px;
      background: linear-gradient(135deg, var(--accent), var(--accent2));
      color: white;
    }
    .output-badge.refinement {
      background: linear-gradient(135deg, var(--accent2), var(--accent3));
    }
    .output-prompt-preview {
      font-size: 12px;
      color: var(--text-muted);
      max-width: 300px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .output-actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .toggle-arrow {
      color: var(--text-muted);
      font-size: 14px;
      transition: transform 0.25s ease;
      flex-shrink: 0;
    }
    .toggle-arrow.expanded {
      transform: rotate(180deg);
    }
    .btn-copy {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text-muted);
      cursor: pointer;
      font-size: 12px;
      padding: 6px 12px;
      transition: all 0.2s;
    }
    .btn-copy:hover { border-color: var(--accent); color: var(--accent); }
    .btn-copy.copied { border-color: var(--success); color: var(--success); }
    .output-body {
      overflow: hidden;
      transition: max-height 0.35s ease, opacity 0.25s ease;
      max-height: 0;
      opacity: 0;
    }
    .output-body.expanded {
      max-height: 9999px;
      opacity: 1;
    }
    .output-content {
      padding: 24px;
      font-size: 14px;
      line-height: 1.8;
      white-space: pre-wrap;
      color: var(--text);
    }
    .output-content h1, .output-content h2, .output-content h3 {
      color: var(--accent);
      margin: 16px 0 8px;
      font-size: 15px;
    }
    .moodboard-images {
      padding: 0 24px 24px;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 16px;
    }
    .moodboard-image-card {
      border-radius: var(--radius-sm);
      overflow: hidden;
      border: 1px solid var(--border);
      background: var(--surface2);
    }
    .moodboard-image-card img {
      width: 100%;
      height: 220px;
      object-fit: cover;
      display: block;
    }
    .moodboard-image-caption {
      padding: 10px 12px;
      font-size: 11px;
      color: var(--text-muted);
      line-height: 1.5;
      border-top: 1px solid var(--border);
    }
    .moodboard-images-header {
      padding: 16px 24px 8px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 1.5px;
      text-transform: uppercase;
      color: var(--accent);
      border-top: 1px solid var(--border);
    }
    .moodboard-generating {
      padding: 16px 24px;
      font-size: 13px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 10px;
      border-top: 1px solid var(--border);
    }
    .spinner-sm {
      width: 16px;
      height: 16px;
      border: 2px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      flex-shrink: 0;
    }
    .refine-section {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 24px;
      animation: slideIn 0.4s ease;
    }
    .refine-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 16px;
    }
    .refine-icon {
      width: 32px;
      height: 32px;
      background: linear-gradient(135deg, var(--accent2), var(--accent3));
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
    }
    .refine-title {
      font-size: 15px;
      font-weight: 700;
      background: linear-gradient(135deg, var(--accent2), var(--accent3));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .refine-subtitle { font-size: 12px; color: var(--text-muted); }
    #refinePrompt { min-height: 80px; margin-bottom: 12px; }
    .btn-refine {
      background: linear-gradient(135deg, var(--accent2), var(--accent3));
      border: none;
      border-radius: var(--radius);
      color: white;
      cursor: pointer;
      font-family: inherit;
      font-size: 14px;
      font-weight: 700;
      padding: 12px 20px;
      transition: all 0.2s;
      width: 100%;
    }
    .btn-refine:hover { opacity: 0.9; transform: translateY(-1px); }
    .btn-refine:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .loading-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
      padding: 48px;
      color: var(--text-muted);
    }
    .spinner {
      width: 40px;
      height: 40px;
      border: 3px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .loading-text { font-size: 14px; }
    .loading-subtext { font-size: 12px; opacity: 0.6; }
    .error-msg {
      background: rgba(255, 82, 82, 0.1);
      border: 1px solid rgba(255, 82, 82, 0.3);
      border-radius: var(--radius-sm);
      color: var(--error);
      font-size: 13px;
      padding: 12px 16px;
    }
    @media (max-width: 900px) {
      .main-layout { grid-template-columns: 1fr; }
      .sidebar { border-right: none; border-bottom: 1px solid var(--border); }
      .app-subtitle { display: none; }
    }
  </style>
</head>
<body>
  <header class="app-header">
    <div class="logo">&#127912;</div>
    <div>
      <div class="app-title">AI Art Director Companion</div>
    </div>
    <div class="app-subtitle">Powered by Claude</div>
  </header>

  <div class="main-layout">
    <aside class="sidebar">
      <div class="form-group">
        <div class="section-label">Creative Prompt</div>
        <textarea id="prompt" placeholder="Describe your creative vision, campaign concept, mood, or art direction challenge..."></textarea>
      </div>

      <div class="form-group">
        <div class="section-label">Output Format</div>
        <div class="output-format-grid">
          <div class="format-option">
            <input type="radio" name="outputFormat" id="fmt-concepts" value="concepts" checked>
            <label for="fmt-concepts">Concepts<span>5 distinct directions</span></label>
          </div>
          <div class="format-option">
            <input type="radio" name="outputFormat" id="fmt-moodboard" value="moodboard">
            <label for="fmt-moodboard">Moodboard<span>Visual themes + AI images</span></label>
          </div>
          <div class="format-option">
            <input type="radio" name="outputFormat" id="fmt-styleguide" value="styleGuide">
            <label for="fmt-styleguide">Style Guide<span>Visual identity</span></label>
          </div>
          <div class="format-option">
            <input type="radio" name="outputFormat" id="fmt-shotlist" value="shotList">
            <label for="fmt-shotlist">Shot List<span>Production ready</span></label>
          </div>
          <div class="format-option">
            <input type="radio" name="outputFormat" id="fmt-brief" value="brief">
            <label for="fmt-brief">Creative Brief<span>Full document</span></label>
          </div>
          <div class="format-option">
            <input type="radio" name="outputFormat" id="fmt-freeform" value="freeform">
            <label for="fmt-freeform">Freeform<span>Open direction</span></label>
          </div>
        </div>
      </div>

      <div class="form-group">
        <div class="section-label">Reference URLs</div>
        <div class="url-list" id="urlList">
          <div class="url-row">
            <input type="text" placeholder="https://example.com/reference" class="url-input">
            <button class="btn-icon" onclick="removeUrl(this)" title="Remove">&#215;</button>
          </div>
        </div>
        <button class="btn-add-url" onclick="addUrl()">+ Add another URL</button>
      </div>

      <div class="form-group">
        <div class="section-label">Upload References</div>
        <div class="upload-zone" id="uploadZone">
          <input type="file" id="fileInput" multiple accept="image/*" onchange="handleFiles(this.files)">
          <div class="upload-icon">&#128193;</div>
          <div class="upload-text"><strong>Drop images here</strong> or click to browse</div>
          <div class="upload-text" style="font-size:11px;margin-top:4px;">JPG, PNG, GIF, WebP &mdash; up to 20MB each</div>
        </div>
        <div class="file-previews" id="filePreviews"></div>
      </div>

      <button class="btn-generate" id="generateBtn" onclick="generate()">&#10022; Generate Art Direction</button>
      <div id="sidebarError"></div>
    </aside>

    <main class="output-panel" id="outputPanel">
      <div class="empty-state" id="emptyState">
        <div class="empty-icon">&#10022;</div>
        <div class="empty-title">Ready to Direct</div>
        <div class="empty-desc">Enter a creative prompt, add references, choose your output format, and let the AI Art Director generate your vision.</div>
      </div>
    </main>
  </div>

  <script>
    var uploadedFiles = [];
    var currentOutput = '';
    var outputHistory = [];

    var uploadZone = document.getElementById('uploadZone');
    uploadZone.addEventListener('dragover', function(e) { e.preventDefault(); uploadZone.classList.add('drag-over'); });
    uploadZone.addEventListener('dragleave', function() { uploadZone.classList.remove('drag-over'); });
    uploadZone.addEventListener('drop', function(e) {
      e.preventDefault();
      uploadZone.classList.remove('drag-over');
      handleFiles(e.dataTransfer.files);
    });

    function handleFiles(files) {
      Array.from(files).forEach(function(file) {
        if (!file.type.startsWith('image/')) return;
        uploadedFiles.push(file);
        var reader = new FileReader();
        var idx = uploadedFiles.length - 1;
        reader.onload = function(e) { renderFilePreview(file, e.target.result, idx); };
        reader.readAsDataURL(file);
      });
    }

    function renderFilePreview(file, src, index) {
      var previews = document.getElementById('filePreviews');
      var div = document.createElement('div');
      div.className = 'file-preview';
      div.dataset.index = index;
      var img = document.createElement('img');
      img.src = src;
      img.alt = file.name;
      var btn = document.createElement('button');
      btn.className = 'remove-file';
      btn.textContent = '\u00d7';
      btn.onclick = function() { removeFile(index, div); };
      div.appendChild(img);
      div.appendChild(btn);
      previews.appendChild(div);
    }

    function removeFile(index, el) {
      uploadedFiles[index] = null;
      el.remove();
    }

    function addUrl() {
      var list = document.getElementById('urlList');
      var row = document.createElement('div');
      row.className = 'url-row';
      var input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'https://example.com/reference';
      input.className = 'url-input';
      var btn = document.createElement('button');
      btn.className = 'btn-icon';
      btn.title = 'Remove';
      btn.textContent = '\u00d7';
      btn.onclick = function() { removeUrl(btn); };
      row.appendChild(input);
      row.appendChild(btn);
      list.appendChild(row);
    }

    function removeUrl(btn) {
      var row = btn.parentElement;
      var list = document.getElementById('urlList');
      if (list.children.length > 1) row.remove();
      else row.querySelector('input').value = '';
    }

    function getUrls() {
      return Array.from(document.querySelectorAll('.url-input'))
        .map(function(i) { return i.value.trim(); })
        .filter(Boolean);
    }

    function getOutputFormat() {
      var checked = document.querySelector('input[name="outputFormat"]:checked');
      return checked ? checked.value : 'freeform';
    }

    function showError(msg) {
      var el = document.getElementById('sidebarError');
      el.innerHTML = '<div class="error-msg">' + msg + '</div>';
    }

    function hideError() {
      document.getElementById('sidebarError').innerHTML = '';
    }

    function setLoading(isLoading, isRefine) {
      var btn = document.getElementById('generateBtn');
      var refineBtn = document.getElementById('refineBtn');
      btn.disabled = isLoading;
      if (refineBtn) refineBtn.disabled = isLoading;
      if (isLoading) {
        var panel = document.getElementById('outputPanel');
        var loadingEl = document.createElement('div');
        loadingEl.id = 'loadingState';
        loadingEl.className = 'output-card';
        loadingEl.innerHTML = '<div class="loading-state"><div class="spinner"></div><div class="loading-text">' + (isRefine ? 'Refining your direction...' : 'Generating art direction...') + '</div><div class="loading-subtext">Analyzing references and crafting your vision</div></div>';
        panel.appendChild(loadingEl);
      } else {
        var el = document.getElementById('loadingState');
        if (el) el.remove();
      }
    }

    function toggleCard(cardEl) {
      var body = cardEl.querySelector('.output-body');
      var arrow = cardEl.querySelector('.toggle-arrow');
      if (!body) return;
      var isExpanded = body.classList.contains('expanded');
      if (isExpanded) {
        body.classList.remove('expanded');
        if (arrow) arrow.classList.remove('expanded');
      } else {
        body.classList.add('expanded');
        if (arrow) arrow.classList.add('expanded');
      }
    }

    async function generate() {
      hideError();
      var prompt = document.getElementById('prompt').value.trim();
      if (!prompt) { showError('Please enter a creative prompt.'); return; }

      var formData = new FormData();
      formData.append('prompt', prompt);
      formData.append('outputFormat', getOutputFormat());
      formData.append('urls', JSON.stringify(getUrls()));

      var activeFiles = uploadedFiles.filter(Boolean);
      activeFiles.forEach(function(file) { formData.append('files', file); });

      var emptyState = document.getElementById('emptyState');
      if (emptyState) emptyState.remove();
      setLoading(true, false);

      try {
        var res = await fetch('/api/generate', { method: 'POST', body: formData });
        var data = await res.json();
        setLoading(false, false);
        if (!res.ok || !data.success) { showError(data.error || 'Generation failed.'); return; }
        currentOutput = data.output;
        outputHistory.push({ output: data.output, format: data.outputFormat, isRefinement: false, prompt: prompt });
        renderOutput(data.output, data.outputFormat, false, prompt, data.moodboardImages);
        renderRefineSection();
      } catch (err) {
        setLoading(false, false);
        showError('Network error: ' + err.message);
      }
    }

    async function refine() {
      hideError();
      var refinePrompt = document.getElementById('refinePrompt').value.trim();
      if (!refinePrompt) { showError('Please enter refinement notes.'); return; }
      if (!currentOutput) { showError('No output to refine yet.'); return; }

      var formData = new FormData();
      formData.append('prompt', refinePrompt);
      formData.append('outputFormat', getOutputFormat());
      formData.append('urls', JSON.stringify(getUrls()));
      formData.append('previousOutput', currentOutput);

      var activeFiles = uploadedFiles.filter(Boolean);
      activeFiles.forEach(function(file) { formData.append('files', file); });

      setLoading(true, true);

      try {
        var res = await fetch('/api/generate', { method: 'POST', body: formData });
        var data = await res.json();
        setLoading(false, true);
        if (!res.ok || !data.success) { showError(data.error || 'Refinement failed.'); return; }
        currentOutput = data.output;
        outputHistory.push({ output: data.output, format: data.outputFormat, isRefinement: true, prompt: refinePrompt });
        renderOutput(data.output, data.outputFormat, true, refinePrompt, data.moodboardImages);
        document.getElementById('refinePrompt').value = '';
        var refineSection = document.getElementById('refineSection');
        if (refineSection) {
          var panel = document.getElementById('outputPanel');
          panel.appendChild(refineSection);
        }
      } catch (err) {
        setLoading(false, true);
        showError('Network error: ' + err.message);
      }
    }

    function renderOutput(output, format, isRefinement, prompt, moodboardImages) {
      var panel = document.getElementById('outputPanel');
      var card = document.createElement('div');
      card.className = 'output-card';

      var formatLabels = { concepts: 'Concepts', moodboard: 'Moodboard', styleGuide: 'Style Guide', shotList: 'Shot List', brief: 'Creative Brief', freeform: 'Freeform' };
      var label = formatLabels[format] || format;
      var badgeClass = isRefinement ? 'output-badge refinement' : 'output-badge';
      var badgeText = isRefinement ? '\u2736 Refined \u2014 ' + label : '\u2736 ' + label;
      var histIdx = outputHistory.length - 1;

      var promptPreview = prompt.length > 60 ? prompt.slice(0, 57) + '...' : prompt;

      // Build header
      var header = document.createElement('div');
      header.className = 'output-card-header';
      header.innerHTML =
        '<div class="output-card-header-left">' +
          '<span class="' + badgeClass + '">' + badgeText + '</span>' +
          '<span class="output-prompt-preview">' + escapeHtml(promptPreview) + '</span>' +
        '</div>' +
        '<div class="output-actions">' +
          '<button class="btn-copy" onclick="event.stopPropagation(); copyOutput(this, ' + histIdx + ')">Copy</button>' +
          '<span class="toggle-arrow expanded">&#9660;</span>' +
        '</div>';
      header.addEventListener('click', function() { toggleCard(card); });

      // Build collapsible body
      var body = document.createElement('div');
      body.className = 'output-body expanded';

      var contentDiv = document.createElement('div');
      contentDiv.className = 'output-content';
      contentDiv.textContent = output;
      body.appendChild(contentDiv);

      if (format === 'moodboard' && moodboardImages && moodboardImages.length > 0) {
        var imgHeader = document.createElement('div');
        imgHeader.className = 'moodboard-images-header';
        imgHeader.textContent = '\u2736 Generated Visuals';
        body.appendChild(imgHeader);

        var imgGrid = document.createElement('div');
        imgGrid.className = 'moodboard-images';
        moodboardImages.forEach(function(img) {
          var imgCard = document.createElement('div');
          imgCard.className = 'moodboard-image-card';
          var imgEl = document.createElement('img');
          imgEl.src = img.imageUrl;
          imgEl.alt = 'Moodboard visual';
          imgEl.loading = 'lazy';
          var caption = document.createElement('div');
          caption.className = 'moodboard-image-caption';
          caption.textContent = img.concept;
          imgCard.appendChild(imgEl);
          imgCard.appendChild(caption);
          imgGrid.appendChild(imgCard);
        });
        body.appendChild(imgGrid);
      } else if (format === 'moodboard') {
        var hint = document.createElement('div');
        hint.className = 'moodboard-generating';
        hint.innerHTML = '<span>&#128161; Add a STABILITYAI_API_KEY to generate AI moodboard images automatically.</span>';
        body.appendChild(hint);
      }

      card.appendChild(header);
      card.appendChild(body);
      panel.appendChild(card);
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function renderRefineSection() {
      var existing = document.getElementById('refineSection');
      if (existing) existing.remove();
      var panel = document.getElementById('outputPanel');
      var section = document.createElement('div');
      section.id = 'refineSection';
      section.className = 'refine-section';
      var refineIcon = document.createElement('div');
      refineIcon.className = 'refine-header';
      refineIcon.innerHTML =
        '<div class="refine-icon">&#9999;&#65039;</div>' +
        '<div><div class="refine-title">Refine Direction</div>' +
        '<div class="refine-subtitle">Iterate on the output above with additional guidance</div></div>';
      var textarea = document.createElement('textarea');
      textarea.id = 'refinePrompt';
      textarea.placeholder = 'What would you like to change or push further? e.g. Make it more cinematic, shift the palette to earth tones, add more tension to the compositions...';
      var refineBtn = document.createElement('button');
      refineBtn.className = 'btn-refine';
      refineBtn.id = 'refineBtn';
      refineBtn.textContent = '\u2736 Refine Art Direction';
      refineBtn.onclick = refine;
      section.appendChild(refineIcon);
      section.appendChild(textarea);
      section.appendChild(refineBtn);
      panel.appendChild(section);
      section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function copyOutput(btn, historyIndex) {
      var text = outputHistory[historyIndex] ? outputHistory[historyIndex].output : currentOutput;
      navigator.clipboard.writeText(text).then(function() {
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(function() { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
      });
    }

    function escapeHtml(str) {
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
  </script>
</body>
</html>`;
  res.send(html);
});

app.listen(PORT, () => {
  console.log('AI Art Director Companion running on port ' + PORT);
});
