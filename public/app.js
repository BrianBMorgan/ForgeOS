(function() {
  var claimInput = document.getElementById('claim-input');
  var checkBtn = document.getElementById('check-btn');
  var charCount = document.getElementById('char-count');
  var errorBox = document.getElementById('error-box');
  var errorMsg = document.getElementById('error-msg');
  var loading = document.getElementById('loading');
  var resultSection = document.getElementById('result-section');
  var verdictBadge = document.getElementById('verdict-badge');
  var confidenceBar = document.getElementById('confidence-bar');
  var confidencePct = document.getElementById('confidence-pct');
  var resultSummary = document.getElementById('result-summary');
  var resultExplanation = document.getElementById('result-explanation');
  var sourcesList = document.getElementById('sources-list');
  var tagsList = document.getElementById('tags-list');
  var sourcesBlock = document.getElementById('sources-block');
  var tagsBlock = document.getElementById('tags-block');

  claimInput.addEventListener('input', function() {
    charCount.textContent = claimInput.value.length;
  });

  claimInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      checkBtn.click();
    }
  });

  function hideError() {
    errorBox.hidden = true;
    errorMsg.textContent = '';
  }

  function showError(msg) {
    errorMsg.textContent = msg;
    errorBox.hidden = false;
  }

  function setLoading(on) {
    loading.hidden = !on;
    checkBtn.disabled = on;
    if (on) {
      resultSection.hidden = true;
    }
  }

  function getVerdictIcon(verdict) {
    if (verdict === 'TRUE') return '\u2705';
    if (verdict === 'FALSE') return '\u274C';
    return '\u2753';
  }

  function getVerdictClass(verdict) {
    if (verdict === 'TRUE') return 'true';
    if (verdict === 'FALSE') return 'false';
    return 'undetermined';
  }

  function renderResult(result) {
    var verdict = result.verdict || 'UNDETERMINED';
    var confidence = typeof result.confidence === 'number' ? result.confidence : 50;

    verdictBadge.className = 'verdict-badge ' + getVerdictClass(verdict);
    verdictBadge.textContent = getVerdictIcon(verdict) + ' ' + verdict;

    confidenceBar.style.width = confidence + '%';
    confidencePct.textContent = confidence + '%';

    resultSummary.textContent = result.summary || '';
    resultExplanation.textContent = result.explanation || '';

    sourcesList.innerHTML = '';
    if (result.sources && result.sources.length > 0) {
      result.sources.forEach(function(src) {
        var li = document.createElement('li');
        var a = document.createElement('a');
        a.href = src.url || '#';
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = '\uD83D\uDD17 ' + (src.name || src.url);
        li.appendChild(a);
        sourcesList.appendChild(li);
      });
      sourcesBlock.hidden = false;
    } else {
      sourcesBlock.hidden = true;
    }

    tagsList.innerHTML = '';
    if (result.tags && result.tags.length > 0) {
      result.tags.forEach(function(tag) {
        var span = document.createElement('span');
        span.className = 'tag';
        span.textContent = tag;
        tagsList.appendChild(span);
      });
      tagsBlock.hidden = false;
    } else {
      tagsBlock.hidden = true;
    }

    resultSection.hidden = false;
  }

  checkBtn.addEventListener('click', function() {
    hideError();

    var claim = claimInput.value.trim();
    if (!claim) {
      showError('Please enter a claim or question to fact-check.');
      return;
    }
    if (claim.length > 1000) {
      showError('Claim must be 1000 characters or fewer.');
      return;
    }

    setLoading(true);

    fetch('/api/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claim: claim })
    })
    .then(function(res) {
      return res.json();
    })
    .then(function(data) {
      setLoading(false);
      if (!data.ok) {
        showError(data.error || 'Something went wrong. Please try again.');
        return;
      }
      renderResult(data.result);
    })
    .catch(function(err) {
      setLoading(false);
      console.error('Request error:', err);
      showError('Network error. Please check your connection and try again.');
    });
  });
})();
