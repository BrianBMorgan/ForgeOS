(function () {
  'use strict';

  // ─── State ───────────────────────────────────────────────────────────────────
  var currentMode = 'text';
  var selectedSamples = 1;
  var img2imgFile = null;
  var upscaleFile = null;
  var galleryItems = [];
  var lightboxCurrentSrc = '';

  // ─── DOM refs ────────────────────────────────────────────────────────────────
  var modeTabs       = document.querySelectorAll('.mode-tab');
  var panels         = { text: document.getElementById('panel-text'), i2i: document.getElementById('panel-i2i'), upscale: document.getElementById('panel-upscale') };
  var gallery        = document.getElementById('gallery');
  var loadingEl      = document.getElementById('loading');
  var loadingText    = document.getElementById('loading-text');
  var errorBox       = document.getElementById('error-box');
  var errorMsg       = document.getElementById('error-msg');
  var clearBtn       = document.getElementById('clear-gallery');
  var lightbox       = document.getElementById('lightbox');
  var lightboxImg    = document.getElementById('lightbox-img');
  var lightboxDl     = document.getElementById('lightbox-download');
  var lightboxUp     = document.getElementById('lightbox-upscale');
  var lightboxClose  = document.querySelector('.lightbox-close');
  var lightboxBack   = document.querySelector('.lightbox-backdrop');

  // Text-to-image refs
  var txtPrompt      = document.getElementById('txt-prompt');
  var txtPromptCount = document.getElementById('txt-prompt-count');
  var txtNegative    = document.getElementById('txt-negative');
  var txtModel       = document.getElementById('txt-model');
  var txtStyle       = document.getElementById('txt-style');
  var txtWidth       = document.getElementById('txt-width');
  var txtHeight      = document.getElementById('txt-height');
  var txtCfg         = document.getElementById('txt-cfg');
  var cfgVal         = document.getElementById('cfg-val');
  var txtSteps       = document.getElementById('txt-steps');
  var stepsVal       = document.getElementById('steps-val');
  var sampleBtns     = document.querySelectorAll('.sample-btn');
  var txtGenerate    = document.getElementById('txt-generate');

  // Image-to-image refs
  var img2imgDrop    = document.getElementById('img2img-drop');
  var img2imgFileIn  = document.getElementById('img2img-file');
  var img2imgPreview = document.getElementById('img2img-preview');
  var i2iPrompt      = document.getElementById('i2i-prompt');
  var i2iNegative    = document.getElementById('i2i-negative');
  var i2iStyle       = document.getElementById('i2i-style');
  var i2iStrength    = document.getElementById('i2i-strength');
  var strengthVal    = document.getElementById('strength-val');
  var i2iCfg         = document.getElementById('i2i-cfg');
  var i2iCfgVal      = document.getElementById('i2i-cfg-val');
  var i2iSteps       = document.getElementById('i2i-steps');
  var i2iStepsVal    = document.getElementById('i2i-steps-val');
  var i2iGenerate    = document.getElementById('i2i-generate');

  // Upscale refs
  var upscaleDrop    = document.getElementById('upscale-drop');
  var upscaleFileIn  = document.getElementById('upscale-file');
  var upscalePreview = document.getElementById('upscale-preview');
  var upscaleWidth   = document.getElementById('upscale-width');
  var upscaleGenerate = document.getElementById('upscale-generate');

  // ─── Mode switching ──────────────────────────────────────────────────────────
  modeTabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      var mode = tab.getAttribute('data-mode');
      currentMode = mode;
      modeTabs.forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      Object.keys(panels).forEach(function (key) {
        if (key === mode) {
          panels[key].classList.remove('hidden');
        } else {
          panels[key].classList.add('hidden');
        }
      });
      hideError();
    });
  });

  // ─── Prompt character count ───────────────────────────────────────────────────
  txtPrompt.addEventListener('input', function () {
    txtPromptCount.textContent = txtPrompt.value.length;
  });

  // ─── Range sliders ───────────────────────────────────────────────────────────
  txtCfg.addEventListener('input', function () { cfgVal.textContent = txtCfg.value; });
  txtSteps.addEventListener('input', function () { stepsVal.textContent = txtSteps.value; });
  i2iStrength.addEventListener('input', function () { strengthVal.textContent = parseFloat(i2iStrength.value).toFixed(2); });
  i2iCfg.addEventListener('input', function () { i2iCfgVal.textContent = i2iCfg.value; });
  i2iSteps.addEventListener('input', function () { i2iStepsVal.textContent = i2iSteps.value; });

  // ─── Sample buttons ───────────────────────────────────────────────────────────
  sampleBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      sampleBtns.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      selectedSamples = parseInt(btn.getAttribute('data-val'), 10);
    });
  });

  // ─── Drop zone helpers ────────────────────────────────────────────────────────
  function setupDropZone(dropEl, fileInput, previewEl, onFile) {
    dropEl.addEventListener('click', function (e) {
      if (e.target === previewEl) return;
      fileInput.click();
    });

    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files[0]) {
        handleFile(fileInput.files[0], previewEl, onFile);
      }
    });

    dropEl.addEventListener('dragover', function (e) {
      e.preventDefault();
      dropEl.classList.add('drag-over');
    });

    dropEl.addEventListener('dragleave', function () {
      dropEl.classList.remove('drag-over');
    });

    dropEl.addEventListener('drop', function (e) {
      e.preventDefault();
      dropEl.classList.remove('drag-over');
      var file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file && file.type.startsWith('image/')) {
        handleFile(file, previewEl, onFile);
      }
    });
  }

  function handleFile(file, previewEl, onFile) {
    if (file.size > 20 * 1024 * 1024) {
      showError('File too large. Maximum size is 20MB.');
      return;
    }
    var reader = new FileReader();
    reader.onload = function (e) {
      previewEl.src = e.target.result;
      previewEl.classList.remove('hidden');
    };
    reader.readAsDataURL(file);
    onFile(file);
  }

  setupDropZone(img2imgDrop, img2imgFileIn, img2imgPreview, function (file) {
    img2imgFile = file;
  });

  setupDropZone(upscaleDrop, upscaleFileIn, upscalePreview, function (file) {
    upscaleFile = file;
  });

  // ─── Error helpers ────────────────────────────────────────────────────────────
  function showError(msg) {
    errorMsg.textContent = msg;
    errorBox.removeAttribute('hidden');
    errorBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function hideError() {
    errorBox.setAttribute('hidden', '');
    errorMsg.textContent = '';
  }

  // ─── Loading helpers ──────────────────────────────────────────────────────────
  function showLoading(msg) {
    loadingText.textContent = msg || 'Generating your image...';
    loadingEl.removeAttribute('hidden');
    hideError();
  }

  function hideLoading() {
    loadingEl.setAttribute('hidden', '');
  }

  // ─── Gallery helpers ──────────────────────────────────────────────────────────
  function clearEmptyState() {
    var empty = gallery.querySelector('.gallery-empty');
    if (empty) empty.remove();
  }

  function addToGallery(imageUrl, label, meta) {
    clearEmptyState();
    clearBtn.removeAttribute('hidden');

    var item = document.createElement('div');
    item.className = 'gallery-item';

    var img = document.createElement('img');
    img.className = 'gallery-img';
    img.src = imageUrl;
    img.alt = label || 'Generated image';
    img.loading = 'lazy';

    var overlay = document.createElement('div');
    overlay.className = 'gallery-overlay';

    var labelEl = document.createElement('p');
    labelEl.className = 'gallery-label';
    labelEl.textContent = label || 'Generated';

    var actions = document.createElement('div');
    actions.className = 'gallery-actions';

    var viewBtn = document.createElement('button');
    viewBtn.className = 'gallery-action-btn';
    viewBtn.textContent = '&#128269;';
    viewBtn.innerHTML = '&#128269; View';
    viewBtn.addEventListener('click', function () {
      openLightbox(imageUrl);
    });

    var dlBtn = document.createElement('a');
    dlBtn.className = 'gallery-action-btn';
    dlBtn.href = imageUrl;
    dlBtn.download = 'forge-vision-' + Date.now() + '.jpg';
    dlBtn.innerHTML = '&#8659; Save';

    actions.appendChild(viewBtn);
    actions.appendChild(dlBtn);
    overlay.appendChild(labelEl);
    overlay.appendChild(actions);
    item.appendChild(img);
    item.appendChild(overlay);

    // Click on image opens lightbox
    img.addEventListener('click', function () {
      openLightbox(imageUrl);
    });

    gallery.insertBefore(item, gallery.firstChild);
    galleryItems.push({ url: imageUrl, label: label, meta: meta });
  }

  // ─── Clear gallery ────────────────────────────────────────────────────────────
  clearBtn.addEventListener('click', function () {
    gallery.innerHTML = '';
    galleryItems = [];
    clearBtn.setAttribute('hidden', '');
    var empty = document.createElement('div');
    empty.className = 'gallery-empty';
    empty.innerHTML = '<span class="empty-icon">&#127912;</span><p>Your generated images will appear here</p><p class="hint">Configure your settings and click Generate</p>';
    gallery.appendChild(empty);
  });

  // ─── Lightbox ─────────────────────────────────────────────────────────────────
  function openLightbox(src) {
    lightboxCurrentSrc = src;
    lightboxImg.src = src;
    lightboxDl.href = src;
    lightboxDl.download = 'forge-vision-' + Date.now() + '.jpg';
    lightbox.removeAttribute('hidden');
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    lightbox.setAttribute('hidden', '');
    lightboxImg.src = '';
    document.body.style.overflow = '';
  }

  lightboxClose.addEventListener('click', closeLightbox);
  lightboxBack.addEventListener('click', closeLightbox);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeLightbox();
  });

  // Send to upscale from lightbox
  lightboxUp.addEventListener('click', function () {
    if (!lightboxCurrentSrc) return;
    closeLightbox();
    // Switch to upscale tab
    modeTabs.forEach(function (t) {
      if (t.getAttribute('data-mode') === 'upscale') t.click();
    });
    // Load the image URL into upscale drop zone as a blob
    fetch(lightboxCurrentSrc)
      .then(function (r) { return r.blob(); })
      .then(function (blob) {
        var file = new File([blob], 'gallery-image.jpg', { type: blob.type || 'image/jpeg' });
        handleFile(file, upscalePreview, function (f) { upscaleFile = f; });
      })
      .catch(function () {
        showError('Could not load image for upscaling.');
      });
  });

  // ─── Text-to-Image generation ─────────────────────────────────────────────────
  txtGenerate.addEventListener('click', function () {
    var prompt = txtPrompt.value.trim();
    if (!prompt) {
      showError('Please enter a prompt before generating.');
      return;
    }

    var payload = {
      prompt: prompt,
      negative_prompt: txtNegative.value.trim(),
      model: txtModel.value,
      style_preset: txtStyle.value || null,
      width: parseInt(txtWidth.value, 10),
      height: parseInt(txtHeight.value, 10),
      cfg_scale: parseFloat(txtCfg.value),
      steps: parseInt(txtSteps.value, 10),
      samples: selectedSamples
    };

    showLoading('Generating ' + selectedSamples + ' image' + (selectedSamples > 1 ? 's' : '') + '...');
    txtGenerate.disabled = true;

    fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        hideLoading();
        txtGenerate.disabled = false;
        if (data.error) {
          showError(data.error);
          return;
        }
        if (!data.images || data.images.length === 0) {
          showError('No images returned. Please try again.');
          return;
        }
        data.images.forEach(function (img, idx) {
          var label = prompt.length > 40 ? prompt.slice(0, 40) + '...' : prompt;
          addToGallery(img.url, label, { mode: 'text', model: txtModel.value, index: idx });
        });
      })
      .catch(function (err) {
        hideLoading();
        txtGenerate.disabled = false;
        showError('Request failed: ' + (err.message || 'Unknown error'));
      });
  });

  // ─── Image-to-Image generation ────────────────────────────────────────────────
  i2iGenerate.addEventListener('click', function () {
    if (!img2imgFile) {
      showError('Please upload a source image first.');
      return;
    }
    var prompt = i2iPrompt.value.trim();
    if (!prompt) {
      showError('Please enter a prompt describing the transformation.');
      return;
    }

    var formData = new FormData();
    formData.append('image', img2imgFile);
    formData.append('prompt', prompt);
    formData.append('negative_prompt', i2iNegative.value.trim());
    formData.append('style_preset', i2iStyle.value || '');
    formData.append('image_strength', i2iStrength.value);
    formData.append('cfg_scale', i2iCfg.value);
    formData.append('steps', i2iSteps.value);

    showLoading('Transforming your image...');
    i2iGenerate.disabled = true;

    fetch('/api/image-to-image', {
      method: 'POST',
      body: formData
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        hideLoading();
        i2iGenerate.disabled = false;
        if (data.error) {
          showError(data.error);
          return;
        }
        if (!data.images || data.images.length === 0) {
          showError('No images returned. Please try again.');
          return;
        }
        data.images.forEach(function (img) {
          var label = prompt.length > 40 ? prompt.slice(0, 40) + '...' : prompt;
          addToGallery(img.url, label, { mode: 'i2i' });
        });
      })
      .catch(function (err) {
        hideLoading();
        i2iGenerate.disabled = false;
        showError('Request failed: ' + (err.message || 'Unknown error'));
      });
  });

  // ─── Upscale generation ───────────────────────────────────────────────────────
  upscaleGenerate.addEventListener('click', function () {
    if (!upscaleFile) {
      showError('Please upload an image to upscale.');
      return;
    }

    var formData = new FormData();
    formData.append('image', upscaleFile);
    formData.append('width', upscaleWidth.value);

    showLoading('Upscaling your image...');
    upscaleGenerate.disabled = true;

    fetch('/api/upscale', {
      method: 'POST',
      body: formData
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        hideLoading();
        upscaleGenerate.disabled = false;
        if (data.error) {
          showError(data.error);
          return;
        }
        if (!data.image) {
          showError('No image returned. Please try again.');
          return;
        }
        addToGallery(data.image, 'Upscaled ' + upscaleWidth.value + 'px', { mode: 'upscale', width: upscaleWidth.value });
      })
      .catch(function (err) {
        hideLoading();
        upscaleGenerate.disabled = false;
        showError('Request failed: ' + (err.message || 'Unknown error'));
      });
  });

  // ─── Keyboard shortcut: Ctrl+Enter to generate ───────────────────────────────
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      if (currentMode === 'text') txtGenerate.click();
      else if (currentMode === 'i2i') i2iGenerate.click();
      else if (currentMode === 'upscale') upscaleGenerate.click();
    }
  });

})();
