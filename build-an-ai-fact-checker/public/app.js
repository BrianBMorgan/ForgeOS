(function () {
  var form = document.getElementById('factForm');
  var claimInput = document.getElementById('claimInput');
  var charCount = document.getElementById('charCount');
  var submitBtn = document.getElementById('submitBtn');
  var btnText = submitBtn.querySelector('.btn-text');
  var btnSpinner = submitBtn.querySelector('.btn-spinner');
  var resultSection = document.getElementById('resultSection');
  var errorBanner = document.getElementById('errorBanner');
  var errorMessage = document.getElementById('errorMessage');

  var verdictIcons = {
    TRUE: '&#10003;',
    FALSE: '&#10007;',
    MOSTLY_TRUE: '&#8679;',
    MOSTLY_FALSE: '&#8681;',
    AMBIGUOUS: '&#8776;',
    UNVERIFIABLE: '&#63;',
    MISLEADING: '&#9888;'
  };

  var verdictLabels = {
    TRUE: 'True',
    FALSE: 'False',
    MOSTLY_TRUE: 'Mostly True',
    MOSTLY_FALSE: 'Mostly False',
    AMBIGUOUS: 'Ambiguous',
    UNVERIFIABLE: 'Unverifiable',
    MISLEADING: 'Misleading'
  };

  claimInput.addEventListener('input', function () {
    charCount.textContent = claimInput.value.length;
  });

  document.querySelectorAll('.chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      claimInput.value = chip.getAttribute('data-claim');
      charCount.textContent = claimInput.value.length;
      claimInput.focus();
    });
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var claim = claimInput.value.trim();
    if (!claim) {
      showError('Please enter a claim to fact-check.');
      return;
    }
    checkFact(claim);
  });

  function setLoading(loading) {
    submitBtn.disabled = loading;
    btnText.hidden = loading;
    btnSpinner.hidden = !loading;
  }

  function showError(msg) {
    errorBanner.hidden = false;
    errorMessage.textContent = msg;
    resultSection.hidden = true;
  }

  function hideError() {
    errorBanner.hidden = true;
    errorMessage.textContent = '';
  }

  function checkFact(claim) {
    hideError();
    setLoading(true);
    resultSection.hidden = true;

    fetch('/api/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claim: claim })
    })
      .then(function (res) {
        return res.json().then(function (data) {
          return { ok: res.ok, data: data };
        });
      })
      .then(function (result) {
        setLoading(false);
        if (!result.ok) {
          showError(result.data.error || 'An error occurred. Please try again.');
          return;
        }
        renderResult(result.data);
      })
      .catch(function (err) {
        setLoading(false);
        showError('Network error. Please check your connection and try again.');
      });
  }

  function renderResult(data) {
    hideError();
    var verdict = data.verdict || 'AMBIGUOUS';
    var confidence = typeof data.confidence === 'number' ? data.confidence : 50;

    var badge = document.getElementById('verdictBadge');
    badge.className = 'verdict-badge verdict-' + verdict;
    document.getElementById('verdictIcon').innerHTML = verdictIcons[verdict] || '?';
    document.getElementById('verdictLabel').textContent = verdictLabels[verdict] || verdict;

    var fill = document.getElementById('confidenceFill');
    fill.style.width = '0%';
    document.getElementById('confidencePct').textContent = confidence + '%';
    setTimeout(function () { fill.style.width = confidence + '%'; }, 50);

    document.getElementById('resultSummary').textContent = data.summary || '';

    var expEl = document.getElementById('resultExplanation');
    expEl.innerHTML = '';
    var explanation = data.explanation || '';
    var paragraphs = explanation.split(/\n\n+/);
    paragraphs.forEach(function (para) {
      if (para.trim()) {
        var p = document.createElement('p');
        p.textContent = para.trim();
        expEl.appendChild(p);
      }
    });

    var sourcesList = document.getElementById('sourcesList');
    sourcesList.innerHTML = '';
    var sources = Array.isArray(data.sources) ? data.sources : [];
    sources.forEach(function (src) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = src.url || '#';
      a.textContent = src.title || src.url || 'Source';
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      li.appendChild(a);
      sourcesList.appendChild(li);
    });
    document.getElementById('sourcesBlock').hidden = sources.length === 0;

    var tagsList = document.getElementById('tagsList');
    tagsList.innerHTML = '';
    var tags = Array.isArray(data.tags) ? data.tags : [];
    tags.forEach(function (tag) {
      var span = document.createElement('span');
      span.className = 'tag';
      span.textContent = tag;
      tagsList.appendChild(span);
    });
    document.getElementById('tagsBlock').hidden = tags.length === 0;

    resultSection.hidden = false;
    resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
})();
