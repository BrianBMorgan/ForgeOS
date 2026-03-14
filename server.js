var express = require('express');
var axios = require('axios');
var multer = require('multer');
var FormData = require('form-data');
var Anthropic = require('@anthropic-ai/sdk');

var app = express();
var PORT = process.env.PORT || 3000;

var storage = multer.memoryStorage();
var upload = multer({
  storage: storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: function(req, file, cb) {
    var allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowed.indexOf(file.mimetype) !== -1) {
      cb(null, true);
    } else {
      cb(null, false);
    }
  }
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

app.post('/api/generate-logo', upload.array('references', 4), function(req, res) {
  if (!process.env.ANTHROPIC_API_KEY || !process.env.STABILITYAI_API_KEY) {
    return res.json({ ok: false, error: 'API keys not configured' });
  }

  var brandName = req.body.brandName || '';
  var industry = req.body.industry || '';
  var style = req.body.style || '';
  var colors = req.body.colors || '';
  var moodRaw = req.body.mood || '';
  var mood = Array.isArray(moodRaw) ? moodRaw.join(', ') : moodRaw;
  var additionalPrompt = req.body.additionalPrompt || '';
  var referenceFiles = req.files || [];

  if (!brandName.trim()) {
    return res.json({ ok: false, error: 'Brand name is required' });
  }

  var invalidFiles = referenceFiles.filter(function(file) {
    var allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    return allowed.indexOf(file.mimetype) === -1;
  });
  if (invalidFiles.length > 0) {
    return res.json({ ok: false, error: 'Only image files are allowed' });
  }

  var anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  var systemPrompt = 'You are an expert brand identity designer and logo art director. Your job is to craft precise, detailed image generation prompts for creating professional brand logos. Focus on visual elements, composition, style, and technical specifications that will produce high-quality, scalable logo concepts. Always output a single IMAGE PROMPT: followed by the complete prompt on one line.';

  var userMessage = 'Create a detailed logo generation prompt for:\n\nBrand Name: ' + brandName + '\nIndustry: ' + (industry || 'Not specified') + '\nDesired Style: ' + (style || 'Not specified') + '\nColor Preferences: ' + (colors || 'Not specified') + '\nBrand Mood/Personality: ' + (mood || 'Not specified') + '\nAdditional Requirements: ' + (additionalPrompt || 'None') + '\n\nCreate a prompt that will generate a professional, clean logo. The prompt should specify: logo style (minimal, geometric, illustrative, etc.), typography hints if needed, color palette, background (white or transparent-style), composition, and professional quality markers. Make it suitable for a brand identity system.\n\nIMAGE PROMPT: [your complete prompt here]';

  var messages = [{ role: 'user', content: userMessage }];

  if (referenceFiles.length > 0) {
    var contentParts = [{ type: 'text', text: userMessage }];
    referenceFiles.forEach(function(file) {
      var base64Data = file.buffer.toString('base64');
      contentParts.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: file.mimetype,
          data: base64Data
        }
      });
    });
    contentParts[0].text = 'I have provided reference images above. ' + userMessage;
    messages = [{ role: 'user', content: contentParts }];
  }

  var errorMsg = 'Failed to generate logo';

  return anthropicClient.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: systemPrompt,
    messages: messages
  }).then(function(claudeResponse) {
    var claudeText = claudeResponse.content[0].text;
    var imagePromptMatch = claudeText.match(/IMAGE PROMPT:\s*(.+)/i);
    var imagePrompt = imagePromptMatch ? imagePromptMatch[1].trim() : claudeText.trim();

    var fullPrompt = imagePrompt + ', professional logo design, vector style, clean white background, high quality, sharp edges, scalable design';

    var stabilityForm = new FormData();
    stabilityForm.append('prompt', fullPrompt);
    stabilityForm.append('output_format', 'png');
    stabilityForm.append('aspect_ratio', '1:1');

    return axios.post(
      'https://api.stability.ai/v2beta/stable-image/generate/core',
      stabilityForm,
      {
        headers: Object.assign({}, stabilityForm.getHeaders(), {
          'Authorization': 'Bearer ' + process.env.STABILITYAI_API_KEY,
          'Accept': 'image/*'
        }),
        responseType: 'arraybuffer',
        timeout: 60000
      }
    ).then(function(stabilityResponse) {
      if (!stabilityResponse.data || stabilityResponse.data.byteLength === 0) {
        return res.json({ ok: false, error: 'No image generated from Stability AI' });
      }

      var imageBase64 = Buffer.from(stabilityResponse.data).toString('base64');
      return res.json({
        ok: true,
        image: 'data:image/png;base64,' + imageBase64,
        prompt: imagePrompt,
        brandName: brandName
      });
    });
  }).catch(function(err) {
    console.error('Logo generation error:', err.response ? err.response.data : err.message);
    if (err.code === 'ECONNABORTED') {
      errorMsg = 'Request timed out. Please try again.';
    } else if (err.response && err.response.data) {
      var errData = err.response.data;
      if (Buffer.isBuffer(errData)) {
        try {
          var parsed = JSON.parse(errData.toString());
          errorMsg = parsed.message || parsed.errors || errorMsg;
        } catch(e) {
          errorMsg = errData.toString().slice(0, 200);
        }
      } else if (errData.message) {
        errorMsg = errData.message;
      }
    } else if (err.message) {
      errorMsg = err.message;
    }
    return res.json({ ok: false, error: errorMsg });
  });
});

app.post('/api/refine-logo', upload.single('currentLogo'), function(req, res) {
  if (!process.env.ANTHROPIC_API_KEY || !process.env.STABILITYAI_API_KEY) {
    return res.json({ ok: false, error: 'API keys not configured' });
  }

  var refinementPrompt = req.body.refinementPrompt || '';
  var originalPrompt = req.body.originalPrompt || '';
  var brandName = req.body.brandName || '';

  if (!refinementPrompt.trim()) {
    return res.json({ ok: false, error: 'Refinement instructions are required' });
  }

  var anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  var refineMessage = 'I have a logo with this original prompt: "' + originalPrompt + '"\n\nThe brand is: ' + brandName + '\n\nRefinement request: ' + refinementPrompt + '\n\nCreate an improved prompt incorporating these refinements while keeping the core brand identity.\n\nIMAGE PROMPT: [your complete refined prompt here]';

  var errorMsg = 'Failed to refine logo';

  return anthropicClient.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: 'You are an expert brand identity designer. Refine logo generation prompts based on feedback while maintaining brand consistency. Always output IMAGE PROMPT: followed by the complete prompt.',
    messages: [{ role: 'user', content: refineMessage }]
  }).then(function(claudeResponse) {
    var claudeText = claudeResponse.content[0].text;
    var imagePromptMatch = claudeText.match(/IMAGE PROMPT:\s*(.+)/i);
    var imagePrompt = imagePromptMatch ? imagePromptMatch[1].trim() : claudeText.trim();

    var fullPrompt = imagePrompt + ', professional logo design, vector style, clean white background, high quality, sharp edges, scalable design';

    var stabilityForm = new FormData();
    stabilityForm.append('prompt', fullPrompt);
    stabilityForm.append('output_format', 'png');
    stabilityForm.append('aspect_ratio', '1:1');

    return axios.post(
      'https://api.stability.ai/v2beta/stable-image/generate/core',
      stabilityForm,
      {
        headers: Object.assign({}, stabilityForm.getHeaders(), {
          'Authorization': 'Bearer ' + process.env.STABILITYAI_API_KEY,
          'Accept': 'image/*'
        }),
        responseType: 'arraybuffer',
        timeout: 60000
      }
    ).then(function(stabilityResponse) {
      if (!stabilityResponse.data || stabilityResponse.data.byteLength === 0) {
        return res.json({ ok: false, error: 'No image generated from Stability AI' });
      }

      var imageBase64 = Buffer.from(stabilityResponse.data).toString('base64');
      return res.json({
        ok: true,
        image: 'data:image/png;base64,' + imageBase64,
        prompt: imagePrompt,
        brandName: brandName
      });
    });
  }).catch(function(err) {
    console.error('Refinement error:', err.response ? err.response.data : err.message);
    if (err.code === 'ECONNABORTED') {
      errorMsg = 'Request timed out. Please try again.';
    } else if (err.response && err.response.data) {
      var errData = err.response.data;
      if (Buffer.isBuffer(errData)) {
        try {
          var parsed = JSON.parse(errData.toString());
          errorMsg = parsed.message || parsed.errors || errorMsg;
        } catch(e) {
          errorMsg = errData.toString().slice(0, 200);
        }
      } else if (errData.message) {
        errorMsg = errData.message;
      }
    } else if (err.message) {
      errorMsg = err.message;
    }
    return res.json({ ok: false, error: errorMsg });
  });
});

app.listen(PORT, '0.0.0.0', function() {
  console.log('Brand Logo Maker running on port ' + PORT);
});
