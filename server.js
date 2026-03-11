var express = require('express');
var axios = require('axios');
var FormData = require('form-data');
var multer = require('multer');
var path = require('path');

var app = express();
var PORT = process.env.PORT || 3000;

var upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

var STABILITY_API_BASE = 'https://api.stability.ai';

function getApiKey() {
  return process.env.STABILITYAI_API_KEY;
}

function buildGenerationPayload(params) {
  return {
    text_prompts: [
      { text: params.prompt, weight: 1 },
      { text: params.negativePrompt || 'blurry, bad quality, distorted, ugly, low resolution, watermark, text, signature', weight: -1 }
    ],
    cfg_scale: params.cfgScale || 7,
    height: params.height || 1024,
    width: params.width || 1024,
    steps: params.steps || 30,
    samples: params.samples || 1,
    style_preset: params.stylePreset || undefined
  };
}

app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/generate', function(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  var apiKey = getApiKey();
  if (!apiKey) {
    return res.status(500).json({ ok: false, error: 'STABILITYAI_API_KEY not configured' });
  }

  var prompt = (req.body.prompt || '').trim();
  if (!prompt) {
    return res.status(400).json({ ok: false, error: 'Prompt is required' });
  }
  if (prompt.length > 2000) {
    return res.status(400).json({ ok: false, error: 'Prompt must be under 2000 characters' });
  }

  var model = req.body.model || 'stable-diffusion-xl-1024-v1-0';
  var endpoint = STABILITY_API_BASE + '/v1/generation/' + model + '/text-to-image';

  var payload = buildGenerationPayload(req.body);

  axios.post(endpoint, payload, {
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    timeout: 60000
  })
  .then(function(response) {
    var artifacts = response.data.artifacts;
    if (!artifacts || artifacts.length === 0) {
      return res.status(500).json({ ok: false, error: 'No images returned from API' });
    }
    var images = artifacts.map(function(artifact) {
      return {
        base64: artifact.base64,
        seed: artifact.seed,
        finishReason: artifact.finishReason
      };
    });
    res.json({ ok: true, images: images, prompt: prompt });
  })
  .catch(function(err) {
    var status = err.response ? err.response.status : 500;
    var message = 'Image generation failed';
    if (err.response && err.response.data) {
      var data = err.response.data;
      if (data.message) message = data.message;
      else if (data.errors) message = data.errors.join(', ');
    } else if (err.code === 'ECONNABORTED') {
      message = 'Request timed out — try a simpler prompt or fewer steps';
    }
    res.status(status).json({ ok: false, error: message });
  });
});

app.post('/api/image-to-image', upload.single('image'), function(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  var apiKey = getApiKey();
  if (!apiKey) {
    return res.status(500).json({ ok: false, error: 'STABILITYAI_API_KEY not configured' });
  }

  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'Image file is required' });
  }

  var prompt = (req.body.prompt || '').trim();
  if (!prompt) {
    return res.status(400).json({ ok: false, error: 'Prompt is required' });
  }

  var model = 'stable-diffusion-xl-1024-v1-0';
  var endpoint = STABILITY_API_BASE + '/v1/generation/' + model + '/image-to-image';

  var form = new FormData();
  form.append('init_image', req.file.buffer, {
    filename: req.file.originalname || 'image.png',
    contentType: req.file.mimetype
  });
  form.append('text_prompts[0][text]', prompt);
  form.append('text_prompts[0][weight]', '1');
  form.append('text_prompts[1][text]', req.body.negativePrompt || 'blurry, bad quality, distorted');
  form.append('text_prompts[1][weight]', '-1');
  form.append('image_strength', req.body.imageStrength || '0.35');
  form.append('cfg_scale', req.body.cfgScale || '7');
  form.append('steps', req.body.steps || '30');
  form.append('samples', '1');
  if (req.body.stylePreset) form.append('style_preset', req.body.stylePreset);

  var headers = Object.assign({}, form.getHeaders(), {
    'Authorization': 'Bearer ' + apiKey,
    'Accept': 'application/json'
  });

  axios.post(endpoint, form, { headers: headers, timeout: 90000 })
  .then(function(response) {
    var artifacts = response.data.artifacts;
    if (!artifacts || artifacts.length === 0) {
      return res.status(500).json({ ok: false, error: 'No images returned from API' });
    }
    var images = artifacts.map(function(artifact) {
      return { base64: artifact.base64, seed: artifact.seed, finishReason: artifact.finishReason };
    });
    res.json({ ok: true, images: images, prompt: prompt });
  })
  .catch(function(err) {
    var status = err.response ? err.response.status : 500;
    var message = 'Image-to-image failed';
    if (err.response && err.response.data && err.response.data.message) {
      message = err.response.data.message;
    }
    res.status(status).json({ ok: false, error: message });
  });
});

app.post('/api/upscale', upload.single('image'), function(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  var apiKey = getApiKey();
  if (!apiKey) {
    return res.status(500).json({ ok: false, error: 'STABILITYAI_API_KEY not configured' });
  }

  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'Image file is required' });
  }

  var endpoint = STABILITY_API_BASE + '/v1/generation/esrgan-v1-x2plus/image-to-image/upscale';

  var form = new FormData();
  form.append('image', req.file.buffer, {
    filename: req.file.originalname || 'image.png',
    contentType: req.file.mimetype
  });
  form.append('width', req.body.width || '2048');

  var headers = Object.assign({}, form.getHeaders(), {
    'Authorization': 'Bearer ' + apiKey,
    'Accept': 'application/json'
  });

  axios.post(endpoint, form, { headers: headers, timeout: 60000 })
  .then(function(response) {
    var artifacts = response.data.artifacts;
    if (!artifacts || artifacts.length === 0) {
      return res.status(500).json({ ok: false, error: 'No result from upscaler' });
    }
    res.json({ ok: true, images: [{ base64: artifacts[0].base64, seed: artifacts[0].seed }] });
  })
  .catch(function(err) {
    var status = err.response ? err.response.status : 500;
    var message = 'Upscaling failed';
    if (err.response && err.response.data && err.response.data.message) {
      message = err.response.data.message;
    }
    res.status(status).json({ ok: false, error: message });
  });
});

app.listen(PORT, '0.0.0.0', function() {
  console.log('AI Image Generator running on port ' + PORT);
});
