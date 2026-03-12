(function() {
  var form = document.getElementById('chartForm');
  var submitBtn = document.getElementById('submitBtn');
  var errorBox = document.getElementById('errorBox');
  var errorMsg = document.getElementById('errorMsg');
  var formSection = document.getElementById('formSection');
  var resultsSection = document.getElementById('resultsSection');
  var backBtn = document.getElementById('backBtn');

  // Generate starfield
  (function generateStars() {
    var container = document.getElementById('stars');
    var count = 150;
    for (var i = 0; i < count; i++) {
      var star = document.createElement('div');
      star.className = 'star';
      var size = Math.random() * 2.5 + 0.5;
      star.style.cssText = [
        'width:' + size + 'px',
        'height:' + size + 'px',
        'top:' + Math.random() * 100 + '%',
        'left:' + Math.random() * 100 + '%',
        '--dur:' + (Math.random() * 4 + 2) + 's',
        '--max-opacity:' + (Math.random() * 0.6 + 0.2),
        'animation-delay:' + Math.random() * 5 + 's'
      ].join(';');
      container.appendChild(star);
    }
  })();

  function hideError() {
    errorBox.hidden = true;
    errorMsg.textContent = '';
  }

  function showError(msg) {
    errorMsg.textContent = msg;
    errorBox.hidden = false;
  }

  function getElementClass(element) {
    return 'element-' + element.toLowerCase();
  }

  var signSymbols = {
    'Aries': '\u2648', 'Taurus': '\u2649', 'Gemini': '\u264a',
    'Cancer': '\u264b', 'Leo': '\u264c', 'Virgo': '\u264d',
    'Libra': '\u264e', 'Scorpio': '\u264f', 'Sagittarius': '\u2650',
    'Capricorn': '\u2651', 'Aquarius': '\u2652', 'Pisces': '\u2653'
  };

  function buildPlacementCard(planet, sign, element, modality, ruler, delay) {
    var card = document.createElement('div');
    card.className = 'placement-card ' + getElementClass(element);
    card.style.animationDelay = delay + 's';

    var planetDiv = document.createElement('div');
    planetDiv.className = 'placement-planet';
    planetDiv.textContent = planet;

    var symbolSpan = document.createElement('span');
    symbolSpan.className = 'placement-symbol';
    symbolSpan.textContent = signSymbols[sign] || '\u2605';

    var signDiv = document.createElement('div');
    signDiv.className = 'placement-sign';
    signDiv.textContent = sign;

    var metaDiv = document.createElement('div');
    metaDiv.className = 'placement-meta';
    metaDiv.textContent = element + (modality ? ' \u00b7 ' + modality : '');

    var rulerDiv = document.createElement('div');
    rulerDiv.className = 'placement-ruler';
    rulerDiv.textContent = 'Ruled by ' + ruler;

    card.appendChild(planetDiv);
    card.appendChild(symbolSpan);
    card.appendChild(signDiv);
    card.appendChild(metaDiv);
    card.appendChild(rulerDiv);

    return card;
  }

  function renderResults(chart) {
    // Subtitle
    var subtitle = document.getElementById('resultsSubtitle');
    var dateStr = chart.dateOfBirth;
    var parts = dateStr.split('-');
    var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    var formattedDate = months[parseInt(parts[1]) - 1] + ' ' + parseInt(parts[2]) + ', ' + parts[0];
    subtitle.textContent = 'Born ' + formattedDate + (chart.timeOfBirth !== 'Unknown' ? ' at ' + chart.timeOfBirth : '') + ' \u00b7 ' + chart.cityOfBirth;

    // Placements
    var grid = document.getElementById('placementsGrid');
    grid.innerHTML = '';

    grid.appendChild(buildPlacementCard(
      '\u2600 Sun Sign', chart.sunSign, chart.sunElement,
      chart.sunModality, chart.sunRuler, 0
    ));

    grid.appendChild(buildPlacementCard(
      '\ud83c\udf19 Moon Sign', chart.moonSign, chart.moonElement,
      null, chart.moonRuler, 0.1
    ));

    if (chart.risingSign) {
      grid.appendChild(buildPlacementCard(
        '\u2191 Rising Sign', chart.risingSign, chart.risingElement,
        null, chart.risingRuler, 0.2
      ));
    }

    // Reading
    var readingBody = document.getElementById('readingBody');
    readingBody.innerHTML = '';

    if (chart.reading) {
      var lines = chart.reading.split('\n');
      var currentP = null;
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) {
          currentP = null;
          continue;
        }
        if (/^\d+\./.test(line) || /^[A-Z][A-Z\s]+:/.test(line)) {
          var h4 = document.createElement('h4');
          h4.textContent = line.replace(/^\d+\.\s*/, '').replace(/:$/, '');
          readingBody.appendChild(h4);
          currentP = null;
        } else {
          if (!currentP) {
            currentP = document.createElement('p');
            readingBody.appendChild(currentP);
          }
          currentP.textContent += (currentP.textContent ? ' ' : '') + line;
        }
      }
    } else {
      var noAi = document.createElement('p');
      noAi.className = 'reading-no-ai';
      noAi.textContent = 'Add your ANTHROPIC_API_KEY to unlock your personalized cosmic reading.';
      readingBody.appendChild(noAi);
    }

    // Elements tally
    var elementCounts = { Fire: 0, Earth: 0, Air: 0, Water: 0 };
    elementCounts[chart.sunElement] = (elementCounts[chart.sunElement] || 0) + 1;
    elementCounts[chart.moonElement] = (elementCounts[chart.moonElement] || 0) + 1;
    if (chart.risingElement) {
      elementCounts[chart.risingElement] = (elementCounts[chart.risingElement] || 0) + 1;
    }

    var elementsGrid = document.getElementById('elementsGrid');
    elementsGrid.innerHTML = '';

    var elementData = [
      { name: 'Fire', icon: '\ud83d\udd25', cls: 'element-fire-pill' },
      { name: 'Earth', icon: '\ud83c\udf3f', cls: 'element-earth-pill' },
      { name: 'Air', icon: '\ud83c\udf2c\ufe0f', cls: 'element-air-pill' },
      { name: 'Water', icon: '\ud83d\udca7', cls: 'element-water-pill' }
    ];

    for (var j = 0; j < elementData.length; j++) {
      var ed = elementData[j];
      var pill = document.createElement('div');
      pill.className = 'element-pill ' + ed.cls;

      var iconSpan = document.createElement('span');
      iconSpan.className = 'element-pill-icon';
      iconSpan.textContent = ed.icon;

      var nameDiv = document.createElement('div');
      nameDiv.className = 'element-pill-name';
      nameDiv.textContent = ed.name;

      var countDiv = document.createElement('div');
      countDiv.className = 'element-pill-count';
      countDiv.textContent = elementCounts[ed.name] || 0;

      pill.appendChild(iconSpan);
      pill.appendChild(nameDiv);
      pill.appendChild(countDiv);
      elementsGrid.appendChild(pill);
    }

    // Show results
    formSection.hidden = true;
    resultsSection.hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  form.addEventListener('submit', function(e) {
    e.preventDefault();
    hideError();

    var dateOfBirth = document.getElementById('dateOfBirth').value.trim();
    var timeOfBirth = document.getElementById('timeOfBirth').value.trim();
    var cityOfBirth = document.getElementById('cityOfBirth').value.trim();

    if (!dateOfBirth) {
      showError('Please enter your date of birth.');
      return;
    }
    if (!cityOfBirth) {
      showError('Please enter your city of birth.');
      return;
    }

    submitBtn.disabled = true;

    fetch('/api/chart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        dateOfBirth: dateOfBirth,
        timeOfBirth: timeOfBirth || null,
        cityOfBirth: cityOfBirth
      })
    })
    .then(function(response) {
      return response.json();
    })
    .then(function(data) {
      submitBtn.disabled = false;
      if (!data.ok) {
        showError(data.error || 'Something went wrong. Please try again.');
        return;
      }
      renderResults(data.chart);
    })
    .catch(function(err) {
      submitBtn.disabled = false;
      console.error('Request error:', err);
      showError('Network error. Please check your connection and try again.');
    });
  });

  backBtn.addEventListener('click', function() {
    resultsSection.hidden = true;
    formSection.hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
})();
