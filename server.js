const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Use memory storage for stateless deployment
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Helper: get fal.ai auth header
function getFalAuthHeader() {
  var key = process.env.FAL_API_KEY;
  if (!key) throw new Error('FAL_API_KEY environment variable is not set');
  return 'Key ' + key;
}

// Helper: poll fal.ai queue until result is ready
async function pollFalQueue(requestId, modelPath) {
  var authHeader = getFalAuthHeader();
  var statusUrl = 'https://queue.fal.run/' + modelPath + '/requests/' + requestId + '/status';
  var resultUrl = 'https://queue.fal.run/' + modelPath + '/requests/' + requestId;

  var attempts = 0;
  var maxAttempts = 120;

  while (attempts < maxAttempts) {
    await new Promise(function(resolve) { setTimeout(resolve, 2000); });
    attempts++;

    var statusRes = await fetch(statusUrl, {
      headers: { 'Authorization': authHeader }
    });

    if (!statusRes.ok) {
      var errText = await statusRes.text();
      throw new Error('Status check failed: ' + errText);
    }

    var statusData = await statusRes.json();

    if (statusData.status === 'COMPLETED') {
      var resultRes = await fetch(resultUrl, {
        headers: { 'Authorization': authHeader }
      });
      if (!resultRes.ok) {
        var errText2 = await resultRes.text();
        throw new Error('Result fetch failed: ' + errText2);
      }
      return await resultRes.json();
    }

    if (statusData.status === 'FAILED') {
      throw new Error('Fal.ai job failed: ' + JSON.stringify(statusData));
    }
  }

  throw new Error('Timeout waiting for fal.ai result after ' + maxAttempts + ' attempts');
}

// Helper: submit to fal.ai queue
async function submitToFalQueue(modelPath, payload) {
  var authHeader = getFalAuthHeader();
  var queueUrl = 'https://queue.fal.run/' + modelPath;

  var res = await fetch(queueUrl, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    var errText = await res.text();
    throw new Error('Queue submission failed (' + res.status + '): ' + errText);
  }

  var data = await res.json();
  return data.request_id;
}

// Helper: upload image to fal.ai storage
async function uploadImageToFal(buffer, mimeType, filename) {
  var authHeader = getFalAuthHeader();
  var form = new FormData();
  form.append('file', buffer, { filename: filename || 'image.jpg', contentType: mimeType || 'image/jpeg' });

  var res = await fetch('https://storage.fal.run/upload', {
    method: 'POST',
    headers: Object.assign({ 'Authorization': authHeader }, form.getHeaders()),
    body: form
  });

  if (!res.ok) {
    var errText = await res.text();
    throw new Error('Image upload failed (' + res.status + '): ' + errText);
  }

  var data = await res.json();
  return data.url;
}

// ─── ROUTE 1: Text-to-Image (Flux Pro) ───────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  try {
    var prompt = req.body.prompt;
    var width = req.body.width || 1024;
    var height = req.body.height || 1024;
    var num_inference_steps = req.body.num_inference_steps || 28;
    var guidance_scale = req.body.guidance_scale || 3.5;
    var num_images = req.body.num_images || 1;
    var seed = req.body.seed;

    if (!prompt || prompt.trim() === '') {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    var payload = {
      prompt: prompt.trim(),
      image_size: { width: parseInt(width), height: parseInt(height) },
      num_inference_steps: parseInt(num_inference_steps),
      guidance_scale: parseFloat(guidance_scale),
      num_images: parseInt(num_images),
      enable_safety_checker: true
    };

    if (seed !== undefined && seed !== '' && seed !== null) {
      payload.seed = parseInt(seed);
    }

    var requestId = await submitToFalQueue('fal-ai/flux-pro', payload);
    var result = await pollFalQueue(requestId, 'fal-ai/flux-pro');

    var images = (result.images || []).map(function(img) {
      return {
        url: img.url,
        width: img.width,
        height: img.height,
        content_type: img.content_type
      };
    });

    res.json({ success: true, images: images, seed: result.seed, timings: result.timings });
  } catch (err) {
    console.error('Generate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── ROUTE 2: Image-to-Image (Flux Pro Image-to-Image) ──────────────────────
app.post('/api/image-to-image', upload.single('image'), async (req, res) => {
  try {
    var prompt = req.body.prompt;
    var strength = req.body.strength || 0.85;
    var num_inference_steps = req.body.num_inference_steps || 28;
    var guidance_scale = req.body.guidance_scale || 3.5;
    var seed = req.body.seed;
    var image_url = req.body.image_url;

    if (!prompt || prompt.trim() === '') {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    var sourceImageUrl = image_url;

    if (req.file) {
      sourceImageUrl = await uploadImageToFal(
        req.file.buffer,
        req.file.mimetype,
        req.file.originalname
      );
    }

    if (!sourceImageUrl) {
      return res.status(400).json({ error: 'An image file or image_url is required' });
    }

    var payload = {
      prompt: prompt.trim(),
      image_url: sourceImageUrl,
      strength: parseFloat(strength),
      num_inference_steps: parseInt(num_inference_steps),
      guidance_scale: parseFloat(guidance_scale),
      enable_safety_checker: true
    };

    if (seed !== undefined && seed !== '' && seed !== null) {
      payload.seed = parseInt(seed);
    }

    var requestId = await submitToFalQueue('fal-ai/flux-pro/image-to-image', payload);
    var result = await pollFalQueue(requestId, 'fal-ai/flux-pro/image-to-image');

    var images = (result.images || []).map(function(img) {
      return {
        url: img.url,
        width: img.width,
        height: img.height,
        content_type: img.content_type
      };
    });

    res.json({ success: true, images: images, seed: result.seed });
  } catch (err) {
    console.error('Image-to-image error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── ROUTE 3: Upscaling (Fal ESRGAN) ──────────────────────────────────────────────
app.post('/api/upscale', upload.single('image'), async (req, res) => {
  try {
    var prompt = req.body.prompt || '';
    var scale = req.body.scale || 2;
    var image_url = req.body.image_url;

    var sourceImageUrl = image_url;

    if (req.file) {
      sourceImageUrl = await uploadImageToFal(
        req.file.buffer,
        req.file.mimetype,
        req.file.originalname
      );
    }

    if (!sourceImageUrl) {
      return res.status(400).json({ error: 'An image file or image_url is required' });
    }

    var payload = {
      image_url: sourceImageUrl,
      scale: parseInt(scale)
    };

    if (prompt && prompt.trim() !== '') {
      payload.prompt = prompt.trim();
    }

    var requestId = await submitToFalQueue('fal-ai/esrgan', payload);
    var result = await pollFalQueue(requestId, 'fal-ai/esrgan');

    var images = (result.images || []).map(function(img) {
      return {
        url: img.url,
        width: img.width,
        height: img.height,
        content_type: img.content_type
      };
    });

    res.json({ success: true, images: images });
  } catch (err) {
    console.error('Upscale error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Health check ───────────────────────────────────────────────────────────────────
app.get('/api/health', function(req, res) {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Root route ───────────────────────────────────────────────────────────────────────
app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', function() {
  console.log('Flux Image Generator running on port ' + PORT);
});
