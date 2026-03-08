const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function scrapeWebsite(url) {
  const response = await axios.get(url, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5'
    },
    maxRedirects: 5
  });

  const html = response.data;
  const $ = cheerio.load(html);

  // Extract inline styles
  const inlineStyles = [];
  $('[style]').each((i, el) => {
    if (i < 30) inlineStyles.push($(el).attr('style'));
  });

  // Extract <style> tag content
  const styleTags = [];
  $('style').each((i, el) => {
    if (i < 5) {
      const content = $(el).html() || '';
      styleTags.push(content.substring(0, 3000));
    }
  });

  // Extract font references
  const fontLinks = [];
  $('link[href]').each((i, el) => {
    const href = $(el).attr('href') || '';
    if (href.includes('font') || href.includes('typeface') || href.includes('typography')) {
      fontLinks.push(href);
    }
  });

  // Extract Google Fonts
  $('link[href*="fonts.googleapis"], link[href*="fonts.gstatic"]').each((i, el) => {
    fontLinks.push($(el).attr('href') || '');
  });

  // Extract meta tags
  const metaTags = {};
  $('meta').each((i, el) => {
    const name = $(el).attr('name') || $(el).attr('property') || '';
    const content = $(el).attr('content') || '';
    if (name && content) metaTags[name] = content;
  });

  // Extract OG tags
  const ogTags = {};
  $('meta[property^="og:"]').each((i, el) => {
    const prop = $(el).attr('property') || '';
    const content = $(el).attr('content') || '';
    if (prop && content) ogTags[prop] = content;
  });

  // Extract text content for tone analysis
  const headings = [];
  $('h1, h2, h3').each((i, el) => {
    if (i < 15) headings.push($(el).text().trim());
  });

  const paragraphs = [];
  $('p').each((i, el) => {
    const text = $(el).text().trim();
    if (i < 10 && text.length > 20) paragraphs.push(text.substring(0, 200));
  });

  // Extract button/CTA text
  const ctaText = [];
  $('button, a.btn, a.button, .cta, [class*="btn"], [class*="button"]').each((i, el) => {
    const text = $(el).text().trim();
    if (i < 10 && text.length > 0 && text.length < 50) ctaText.push(text);
  });

  // Extract logo
  const logos = [];
  $('img[src*="logo"], img[alt*="logo"], img[class*="logo"], img[id*="logo"]').each((i, el) => {
    if (i < 3) logos.push({ src: $(el).attr('src'), alt: $(el).attr('alt') });
  });

  // Extract title
  const title = $('title').text().trim();

  // Extract CSS class names for patterns
  const classNames = new Set();
  $('[class]').each((i, el) => {
    if (i < 100) {
      const classes = ($(el).attr('class') || '').split(/\s+/);
      classes.forEach(c => { if (c.length > 2) classNames.add(c); });
    }
  });

  return {
    url,
    title,
    metaTags,
    ogTags,
    fontLinks,
    inlineStyles: inlineStyles.slice(0, 20),
    styleTags: styleTags.slice(0, 3),
    headings: headings.slice(0, 10),
    paragraphs: paragraphs.slice(0, 5),
    ctaText: ctaText.slice(0, 8),
    logos,
    classNames: Array.from(classNames).slice(0, 50)
  };
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/scrape', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const { url } = req.body;

  if (!url || typeof url !== 'string' || url.trim().length === 0) {
    return res.status(400).json({ error: 'A valid URL is required.' });
  }

  let normalizedUrl = url.trim();
  if (!/^https?:\/\//i.test(normalizedUrl)) {
    normalizedUrl = 'https://' + normalizedUrl;
  }

  try {
    new URL(normalizedUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL format.' });
  }

  try {
    const scraped = await scrapeWebsite(normalizedUrl);

    const scrapedText = JSON.stringify(scraped, null, 2).substring(0, 12000);

    const prompt = `You are a brand identity analyst. Analyze the following scraped website data and extract a comprehensive brand identity report.

Website: ${normalizedUrl}
Scraped Data:
${scrapedText}

Provide a detailed brand identity analysis in the following JSON format. Be specific and extract real values from the data where possible:

{
  "brand_name": "Company name",
  "website": "URL",
  "summary": "2-3 sentence brand overview",
  "colors": {
    "primary": ["#hex1", "#hex2"],
    "secondary": ["#hex1", "#hex2"],
    "accent": ["#hex1"],
    "background": ["#hex1"],
    "text": ["#hex1", "#hex2"],
    "notes": "Color palette description"
  },
  "typography": {
    "primary_font": "Font name",
    "secondary_font": "Font name or null",
    "font_sources": ["Google Fonts URL or font stack"],
    "font_weights": ["400", "700"],
    "font_sizes": "Description of size scale",
    "css_snippet": "font-family: 'Font Name', sans-serif;"
  },
  "tone_and_voice": {
    "primary_tone": "e.g. Professional, Playful, Bold, Minimal",
    "descriptors": ["word1", "word2", "word3"],
    "writing_style": "Description of how they write",
    "cta_style": "Description of call-to-action language"
  },
  "visual_style": {
    "design_aesthetic": "e.g. Minimalist, Bold, Corporate, Playful",
    "border_radius": "e.g. 4px, 8px, rounded, pill",
    "spacing_style": "e.g. Generous whitespace, Dense, Compact",
    "shadow_usage": "e.g. Subtle, Heavy, None",
    "imagery_style": "Description of image/visual style"
  },
  "css_patterns": {
    "button_style": "CSS snippet for typical button",
    "card_style": "CSS snippet for typical card",
    "css_variables": "CSS custom properties block"
  },
  "brand_keywords": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"]
}

Return ONLY valid JSON. No markdown, no explanation, just the JSON object.`;

    const aiResponse = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    });

    let text = aiResponse.content[0].text;
    if (text.includes('```')) {
      text = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '');
    }
    const firstBrace = text.search(/[{[]/);
    if (firstBrace > 0) text = text.slice(firstBrace);

    const brandData = JSON.parse(text);
    res.json({ success: true, data: brandData });

  } catch (err) {
    console.error('Scrape error:', err.message);
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      return res.status(400).json({ error: 'Could not reach that URL. Check the address and try again.' });
    }
    if (err.response && err.response.status === 403) {
      return res.status(400).json({ error: 'That website blocked our request. Try a different URL.' });
    }
    if (err instanceof SyntaxError) {
      return res.status(500).json({ error: 'Failed to parse brand analysis. Please try again.' });
    }
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.listen(PORT, () => {
  console.log(`Brand Scraper running on port ${PORT}`);
});
