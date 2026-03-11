(function() {
  'use strict';

  // State
  var currentMode = 'text';
  var selectedSamples = 1;
  var img2imgFile = null;
  var upscaleFile = null;
  var lightboxBase64 = null;
  var galleryItems = [];

  // DOM refs
  var gallery = document.getElementById('gallery');
  var errorBox = document.getElementById('error-box');
  var loading = document.getElementById('loading');
  var loadingText = document.getElementById('loading-text');
  var clearBtn = document.getElementById('clear-gallery');
  var lightbox = document.getElementById('lightbox');
  var lightboxImg = document.getElementById('lightbox-img');
  var lightboxDownload = document.getElementById('lightbox-download');
  var lightboxUpscale = document.getElementById('lightbox-upscale');

  // Mode tabs
  document.querySelectorAll('.mode-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      document.querySelectorAll('.mode-tab').forEach(function(t) { t.classList.remove('active'); });
      document.querySelectorAll('.panel').forEach(function(p) { p.classList.add('hidden'); });
      tab.classList.add('active');
      currentMode = tab.dataset.mode;
      document.getElementById('panel-' + currentMode).classList.remove('hidden');
    });
  });

  // Range sliders
  function bindRange(inputId, displayId) {
    var input = document.getElementById(inputId);
    var display = document.getElementById(displayId);
    if (!input || !display) return;
    display.textContent = input.value;
    input.addEventListener('input', function() { display.textContent = input.value; });
  }
  bindRange('txt-cfg', 'cfg-val');
  bindRange('txt-steps', 'steps-val');
  bindRange('i2i-cfg', 'i2i-cfg-val');
  bindRange('i2i-steps', 'i2i-steps-val');
  bindRange('i2i-strength', 'strength-val');

  // Char counter
  var txtPrompt = document.getElementById('txt-prompt');
  var txtCount = document.getElementById('txt-prompt-count');
  txtPrompt.addEventListener('input', function() {
    txtCount.textContent = txtPrompt.value.length;
    txtCount.style.color = txtPrompt.value.length > 1800 ? '#E94560' : '';
  });

  // Sample buttons
  document.querySelectorAll('.sample-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.sample-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      selectedSamples = parseInt(btn.dataset.val);
    });
  });

  // Drop zones
  function setupDropZone(dropId, fileInputId, previewId, onFile) {
    var drop = document.getElementById(dropId);
    var fileInput = document.getElementById(fileInputId);
    var preview = document.getElementById(previewId);

    drop.addEventListener('click', function() { fileInput.click(); });
    fileInput.addEventListener('change', function() {
      if (fileInput.files[0]) handleFile(fileInput.files[0]);
    });
    drop.addEventListener('dragover', function(e) { e.preventDefault(); drop.classList.add('drag-over'); });
    drop.addEventListener('dragleave', function() { drop.classList.remove('drag-over'); });
    drop.addEventListener('drop', function(e) {
      e.preventDefault();
      drop.classList.remove('drag-over');
      if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });

    function handleFile(file) {
      if (!file.type.startsWith('image/')) { console.warn('Invalid file type:', file.type); return; }
      if (file.size > 20 * 1024 * 1024) { console.warn('File too large:', file.size); return; }
      onFile(file);
      var reader = new FileReader();
      reader.onload = function(e) {
        preview.src = e.target.result;
        preview.classList.remove('hidden');
        drop.querySelector('.drop-inner').style.display = 'none';
      };
      reader.readAsDataURL(file);
    }
  }

  setupDropZone('img2img-drop', 'img2img-file', 'img2img-preview', function(f) { img2imgFile = f; });
  setupDropZone('upscale-drop', 'upscale-file', 'upscale-preview', function(f) { upscaleFile = f; });

  // Loading helpers
  function showLoading(msg) {
    loadingText.textContent = msg || 'Generating your image...';
    loading.removeAttribute('hidden');
  }
  function hideLoading() {
    loading.setAttribute('hidden', '');
  }
  function setGenerating(state) {
    document.querySelectorAll('.generate-btn').forEach(function(btn) {
      btn.disabled = state;
    });
  }

  // Gallery
  function addToGallery(base64, prompt, seed) {
    var dataUrl = 'data:image/png;base64,' + base64;
    galleryItems.push({ dataUrl: dataUrl, prompt: prompt, seed: seed });

    // Remove empty state
    var empty = gallery.querySelector('.gallery-empty');
    if (empty) empty.remove();

    var card = document.createElement('div');
    card.className = 'image-card';

    var img = document.createElement('img');
    img.src = dataUrl;
    img.alt = prompt;
    img.addEventListener('click', function() { openLightbox(dataUrl, base64); });

    var footer = document.createElement('div');
    footer.className = 'card-footer';

    var promptEl = document.createElement('div');
    promptEl.className = 'card-prompt';
    promptEl.textContent = prompt;
    promptEl.title = prompt;

    var actions = document.createElement('div');
    actions.className = 'card-actions';

    var dlBtn = document.createElement('button');
    dlBtn.className = 'card-btn';
    dlBtn.textContent = '\u2B07 Save';
    dlBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      downloadImage(dataUrl, 'forge-vision-' + (seed || Date.now()) + '.png');
    });

    var expandBtn = document.createElement('button');
    expandBtn.className = 'card-btn';
    expandBtn.textContent = '\u26F6 View';
    expandBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      openLightbox(dataUrl, base64);
    });

    actions.appendChild(dlBtn);
    actions.appendChild(expandBtn);
    footer.appendChild(promptEl);
    footer.appendChild(actions);
    card.appendChild(img);
    card.appendChild(footer);
    gallery.insertBefore(card, gallery.firstChild);

    clearBtn.removeAttribute('hidden');
  }

  function downloadImage(dataUrl, filename) {
    var a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    a.click();
  }

  // Lightbox
  function openLightbox(dataUrl, base64) {
    lightboxBase64 = base64;
    lightboxImg.src = dataUrl;
    lightboxDownload.href = dataUrl;
    lightbox.removeAttribute('hidden');
    document.body.style.overflow = 'hidden';
  }
  function closeLightbox() {
    lightbox.setAttribute('hidden', '');
    document.body.style.overflow = '';
    lightboxBase64 = null;
  }

  document.querySelector('.lightbox-close').addEventListener('click', closeLightbox);
  document.querySelector('.lightbox-backdrop').addEventListener('click', closeLightbox);
  document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeLightbox(); });

  lightboxUpscale.addEventListener('click', function() {
    if (!lightboxBase64) return;
    // Convert base64 to blob and send to upscaler
    var byteChars = atob(lightboxBase64);
    var byteArr = new Uint8Array(byteChars.length);
    for (var i = 0; i < byteChars.length; i++) byteArr[i] = byteChars.charCodeAt(i);
    var blob = new Blob([byteArr], { type: 'image/png' });
    upscaleFile = new File([blob], 'lightbox-image.png', { type: 'image/png' });

    // Switch to upscale tab
    document.querySelectorAll('.mode-tab').forEach(function(t) { t.classList.remove('active'); });
    document.querySelectorAll('.panel').forEach(function(p) { p.classList.add('hidden'); });
    document.querySelector('[data-mode="upscale"]').classList.add('active');
    document.getElementById('panel-upscale').classList.remove('hidden');
    currentMode = 'upscale';

    // Show preview
    var preview = document.getElementById('upscale-preview');
    preview.src = lightboxImg.src;
    preview.classList.remove('hidden');
    var dropInner = document.querySelector('#upscale-drop .drop-inner');
    if (dropInner) dropInner.style.display = 'none';

    closeLightbox();
  });

  // Clear gallery
  clearBtn.addEventListener('click', function() {
    galleryItems = [];
    gallery.innerHTML = '<div class="gallery-empty"><span class="empty-icon">\u1F3A8</span><p>Your generated images will appear here</p><p class="hint">Configure your settings and click Generate</p></div>';
    clearBtn.setAttribute('hidden', '');
  });

  // Generate: Text to Image
  document.getElementById('txt-generate').addEventListener('click', function() {
    var prompt = document.getElementById('txt-prompt').value.trim();
    if (!prompt) { console.warn('Prompt is required'); return; }
    if (prompt.length > 2000) { console.warn('Prompt too long'); return; }

    var payload = {
      prompt: prompt,
      negativePrompt: document.getElementById('txt-negative').value.trim(),
      model: document.getElementById('txt-model').value,
      stylePreset: document.getElementById('txt-style').value || undefined,
      width: parseInt(document.getElementById('txt-width').value),
      height: parseInt(document.getElementById('txt-height').value),
      cfgScale: parseInt(document.getElementById('txt-cfg').value),
      steps: parseInt(document.getElementById('txt-steps').value),
      samples: selectedSamples
    };

    showLoading('Generating ' + selectedSamples + ' image' + (selectedSamples > 1 ? 's' : '') + '...');
    setGenerating(true);

    fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      hideLoading();
      setGenerating(false);
      if (!data.ok) { console.error('Generation failed:', data.error); return; }
      data.images.forEach(function(img) {
        addToGallery(img.base64, prompt, img.seed);
      });
    })
    .catch(function(err) {
      hideLoading();
      setGenerating(false);
      console.error('Network error:', err.message);
    });
  });

  // Generate: Image to Image
  document.getElementById('i2i-generate').addEventListener('click', function() {
    if (!img2imgFile) { console.warn('No source image'); return; }
    var prompt = document.getElementById('i2i-prompt').value.trim();
    if (!prompt) { console.warn('Prompt is required'); return; }

    var form = new FormData();
    form.append('image', img2imgFile);
    form.append('prompt', prompt);
    form.append('negativePrompt', document.getElementById('i2i-negative').value.trim());
    form.append('stylePreset', document.getElementById('i2i-style').value);
    form.append('imageStrength', document.getElementById('i2i-strength').value);
    form.append('cfgScale', document.getElementById('i2i-cfg').value);
    form.append('steps', document.getElementById('i2i-steps').value);

    showLoading('Transforming your image...');
    setGenerating(true);

    fetch('/api/image-to-image', { method: 'POST', body: form })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      hideLoading();
      setGenerating(false);
      if (!data.ok) { console.error('Transformation failed:', data.error); return; }
      data.images.forEach(function(img) {
        addToGallery(img.base64, prompt, img.seed);
      });
    })
    .catch(function(err) {
      hideLoading();
      setGenerating(false);
      console.error('Network error:', err.message);
    });
  });

  // Generate: Upscale
  document.getElementById('upscale-generate').addEventListener('click', function() {
    if (!upscaleFile) { console.warn('No image to upscale'); return; }

    var form = new FormData();
    form.append('image', upscaleFile);
    form.append('width', document.getElementById('upscale-width').value);

    showLoading('Upscaling your image...');
    setGenerating(true);

    fetch('/api/upscale', { method: 'POST', body: form })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      hideLoading();
      setGenerating(false);
      if (!data.ok) { console.error('Upscaling failed:', data.error); return; }
      data.images.forEach(function(img) {
        addToGallery(img.base64, 'Upscaled image', img.seed);
      });
    })
    .catch(function(err) {
      hideLoading();
      setGenerating(false);
      console.error('Network error:', err.message);
    });
  });

})();
