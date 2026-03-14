(function() {
  var selectedMoods = [];
  var selectedFiles = [];
  var currentLogoData = null;
  var currentPrompt = '';
  var currentBrandName = '';

  var logoForm = document.getElementById('logoForm');
  var generateBtn = document.getElementById('generateBtn');
  var generateBtnText = document.getElementById('generateBtnText');
  var resultPlaceholder = document.getElementById('resultPlaceholder');
  var resultContent = document.getElementById('resultContent');
  var logoImage = document.getElementById('logoImage');
  var logoBrandName = document.getElementById('logoBrandName');
  var logoPrompt = document.getElementById('logoPrompt');
  var errorBox = document.getElementById('errorBox');
  var errorMsg = document.getElementById('errorMsg');
  var downloadBtn = document.getElementById('downloadBtn');
  var refineToggleBtn = document.getElementById('refineToggleBtn');
  var refinePanel = document.getElementById('refinePanel');
  var refineBtn = document.getElementById('refineBtn');
  var refinementPrompt = document.getElementById('refinementPrompt');
  var dropZone = document.getElementById('dropZone');
  var fileInput = document.getElementById('fileInput');
  var fileChips = document.getElementById('fileChips');
  var moodTags = document.querySelectorAll('.mood-tag');

  moodTags.forEach(function(tag) {
    tag.addEventListener('click', function() {
      var mood = tag.getAttribute('data-mood');
      if (tag.classList.contains('active')) {
        tag.classList.remove('active');
        selectedMoods = selectedMoods.filter(function(m) { return m !== mood; });
      } else {
        tag.classList.add('active');
        selectedMoods.push(mood);
      }
    });
  });

  dropZone.addEventListener('click', function() {
    fileInput.click();
  });

  dropZone.addEventListener('dragover', function(e) {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragleave', function() {
    dropZone.classList.remove('drag-over');
  });

  dropZone.addEventListener('drop', function(e) {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    addFiles(e.dataTransfer.files);
  });

  fileInput.addEventListener('change', function() {
    addFiles(fileInput.files);
    fileInput.value = '';
  });

  function addFiles(files) {
    for (var i = 0; i < files.length; i++) {
      if (selectedFiles.length >= 4) break;
      selectedFiles.push(files[i]);
    }
    renderFileChips();
  }

  function renderFileChips() {
    fileChips.innerHTML = '';
    selectedFiles.forEach(function(file, index) {
      var chip = document.createElement('div');
      chip.className = 'file-chip';
      chip.innerHTML = '&#128247; ' + file.name + ' <button class="file-chip-remove" data-index="' + index + '">&times;</button>';
      fileChips.appendChild(chip);
    });
    fileChips.querySelectorAll('.file-chip-remove').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var idx = parseInt(btn.getAttribute('data-index'));
        selectedFiles.splice(idx, 1);
        renderFileChips();
      });
    });
  }

  function showError(msg) {
    errorBox.style.display = 'block';
    errorMsg.textContent = msg;
  }

  function hideError() {
    errorBox.style.display = 'none';
    errorMsg.textContent = '';
  }

  function showLoading(text) {
    var overlay = document.createElement('div');
    overlay.className = 'loading-overlay';
    overlay.id = 'loadingOverlay';
    overlay.innerHTML = '<div class="loading-spinner"></div><p class="loading-text">' + (text || 'Generating...') + '</p>';
    document.body.appendChild(overlay);
    generateBtn.disabled = true;
  }

  function hideLoading() {
    var overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.parentNode.removeChild(overlay);
    generateBtn.disabled = false;
  }

  logoForm.addEventListener('submit', function(e) {
    e.preventDefault();
    hideError();

    var brandNameVal = document.getElementById('brandName').value.trim();
    if (!brandNameVal) {
      showError('Brand name is required.');
      return;
    }

    var formData = new FormData();
    formData.append('brandName', brandNameVal);
    formData.append('industry', document.getElementById('industry').value || '');
    formData.append('style', document.getElementById('style').value || '');
    formData.append('colors', document.getElementById('colors').value || '');
    formData.append('additionalPrompt', document.getElementById('additionalPrompt').value || '');

    selectedMoods.forEach(function(m) {
      formData.append('mood', m);
    });

    selectedFiles.forEach(function(file) {
      formData.append('references', file, file.name);
    });

    showLoading('Crafting your logo with AI...');

    fetch('/api/generate-logo', {
      method: 'POST',
      body: formData
    }).then(function(response) {
      return response.json();
    }).then(function(data) {
      hideLoading();
      if (!data.ok) {
        showError(data.error || 'Failed to generate logo');
        return;
      }
      currentLogoData = data.image;
      currentPrompt = data.prompt;
      currentBrandName = data.brandName;
      displayResult(data);
    }).catch(function(err) {
      hideLoading();
      showError('Network error. Please try again.');
    });
  });

  function displayResult(data) {
    resultPlaceholder.style.display = 'none';
    resultContent.style.display = 'block';
    logoImage.src = data.image;
    logoBrandName.textContent = data.brandName;
    logoPrompt.textContent = data.prompt;
    refinePanel.style.display = 'none';
  }

  downloadBtn.addEventListener('click', function() {
    if (!currentLogoData) return;
    var a = document.createElement('a');
    a.href = currentLogoData;
    a.download = (currentBrandName || 'logo') + '-logo.png';
    a.click();
  });

  refineToggleBtn.addEventListener('click', function() {
    refinePanel.style.display = refinePanel.style.display === 'none' ? 'block' : 'none';
  });

  refineBtn.addEventListener('click', function() {
    var refinement = refinementPrompt.value.trim();
    if (!refinement) {
      showError('Please describe what to change.');
      return;
    }
    hideError();

    var formData = new FormData();
    formData.append('refinementPrompt', refinement);
    formData.append('originalPrompt', currentPrompt);
    formData.append('brandName', currentBrandName);

    showLoading('Refining your logo...');

    fetch('/api/refine-logo', {
      method: 'POST',
      body: formData
    }).then(function(response) {
      return response.json();
    }).then(function(data) {
      hideLoading();
      if (!data.ok) {
        showError(data.error || 'Failed to refine logo');
        return;
      }
      currentLogoData = data.image;
      currentPrompt = data.prompt;
      displayResult(data);
    }).catch(function(err) {
      hideLoading();
      showError('Network error. Please try again.');
    });
  });
})();
