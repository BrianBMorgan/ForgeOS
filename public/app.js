(function() {
  var allData = [];
  var filteredData = [];
  var currentPage = 1;
  var rowsPerPage = 25;
  var sortCol = null;
  var sortAsc = true;

  var searchInput = document.getElementById('searchInput');
  var rowCount = document.getElementById('rowCount');
  var errorDiv = document.getElementById('error');
  var loadingDiv = document.getElementById('loading');
  var tableWrapper = document.getElementById('tableWrapper');
  var tableHead = document.getElementById('tableHead');
  var tableBody = document.getElementById('tableBody');
  var pagination = document.getElementById('pagination');

  function hideError() {
    errorDiv.hidden = true;
    errorDiv.textContent = '';
  }

  function showError(msg) {
    errorDiv.textContent = msg;
    errorDiv.hidden = false;
  }

  function parseCSV(text) {
    var lines = text.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });
    if (lines.length < 2) return [];

    function splitLine(line) {
      var result = [];
      var current = '';
      var inQuotes = false;
      for (var i = 0; i < line.length; i++) {
        var ch = line[i];
        if (ch === '"') {
          inQuotes = !inQuotes;
        } else if (ch === ',' && !inQuotes) {
          result.push(current.trim());
          current = '';
        } else {
          current += ch;
        }
      }
      result.push(current.trim());
      return result;
    }

    var headers = splitLine(lines[0]);
    var rows = [];
    for (var i = 1; i < lines.length; i++) {
      var cols = splitLine(lines[i]);
      var row = {};
      for (var j = 0; j < headers.length; j++) {
        row[headers[j]] = cols[j] !== undefined ? cols[j] : '';
      }
      rows.push(row);
    }
    return rows;
  }

  function buildHeaders(columns) {
    var cells = columns.map(function(col, i) {
      return '<th data-col="' + i + '">' +
        col +
        '<span class="sort-icon">&#8597;</span>' +
        '</th>';
    });
    tableHead.innerHTML = '<tr>' + cells.join('') + '</tr>';

    var ths = tableHead.querySelectorAll('th');
    ths.forEach(function(th) {
      th.addEventListener('click', function() {
        var colIndex = parseInt(th.getAttribute('data-col'));
        var colName = columns[colIndex];
        if (sortCol === colName) {
          sortAsc = !sortAsc;
        } else {
          sortCol = colName;
          sortAsc = true;
        }
        ths.forEach(function(t) { t.classList.remove('sorted'); });
        th.classList.add('sorted');
        th.querySelector('.sort-icon').textContent = sortAsc ? '\u25b2' : '\u25bc';
        applySort();
        currentPage = 1;
        render();
      });
    });
  }

  function applySort() {
    if (!sortCol) return;
    filteredData.sort(function(a, b) {
      var av = a[sortCol] || '';
      var bv = b[sortCol] || '';
      var an = parseFloat(av);
      var bn = parseFloat(bv);
      if (!isNaN(an) && !isNaN(bn)) {
        return sortAsc ? an - bn : bn - an;
      }
      av = av.toString().toLowerCase();
      bv = bv.toString().toLowerCase();
      if (av < bv) return sortAsc ? -1 : 1;
      if (av > bv) return sortAsc ? 1 : -1;
      return 0;
    });
  }

  function applyFilter(query) {
    query = query.trim().toLowerCase();
    if (!query) {
      filteredData = allData.slice();
    } else {
      filteredData = allData.filter(function(row) {
        return Object.values(row).some(function(val) {
          return (val || '').toString().toLowerCase().indexOf(query) !== -1;
        });
      });
    }
    applySort();
    currentPage = 1;
    render();
  }

  function render() {
    var total = filteredData.length;
    var totalPages = Math.max(1, Math.ceil(total / rowsPerPage));
    if (currentPage > totalPages) currentPage = totalPages;

    var start = (currentPage - 1) * rowsPerPage;
    var end = Math.min(start + rowsPerPage, total);
    var pageData = filteredData.slice(start, end);

    rowCount.textContent = total + ' row' + (total !== 1 ? 's' : '');

    var rows = pageData.map(function(row) {
      var cols = Object.values(row).map(function(val) {
        var safe = (val || '').toString()
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        return '<td title="' + safe + '">' + safe + '</td>';
      });
      return '<tr>' + cols.join('') + '</tr>';
    });
    tableBody.innerHTML = rows.join('');

    renderPagination(totalPages);
  }

  function renderPagination(totalPages) {
    if (totalPages <= 1) {
      pagination.innerHTML = '';
      return;
    }
    var parts = [];
    parts.push('<button id="prevBtn"' + (currentPage === 1 ? ' disabled' : '') + '>&#8592; Prev</button>');

    var start = Math.max(1, currentPage - 2);
    var end = Math.min(totalPages, currentPage + 2);
    if (start > 1) {
      parts.push('<button data-page="1">1</button>');
      if (start > 2) parts.push('<span class="page-info">...</span>');
    }
    for (var p = start; p <= end; p++) {
      parts.push('<button data-page="' + p + '"' + (p === currentPage ? ' class="active"' : '') + '>' + p + '</button>');
    }
    if (end < totalPages) {
      if (end < totalPages - 1) parts.push('<span class="page-info">...</span>');
      parts.push('<button data-page="' + totalPages + '">' + totalPages + '</button>');
    }
    parts.push('<button id="nextBtn"' + (currentPage === totalPages ? ' disabled' : '') + '>Next &#8594;</button>');

    pagination.innerHTML = parts.join('');

    document.getElementById('prevBtn').addEventListener('click', function() {
      if (currentPage > 1) { currentPage--; render(); }
    });
    document.getElementById('nextBtn').addEventListener('click', function() {
      var totalPages2 = Math.ceil(filteredData.length / rowsPerPage);
      if (currentPage < totalPages2) { currentPage++; render(); }
    });
    var pageBtns = pagination.querySelectorAll('[data-page]');
    pageBtns.forEach(function(btn) {
      btn.addEventListener('click', function() {
        currentPage = parseInt(btn.getAttribute('data-page'));
        render();
      });
    });
  }

  function loadData() {
    hideError();
    loadingDiv.hidden = false;
    tableWrapper.hidden = true;

    fetch('/api/assets/Book1.csv')
      .then(function(response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.text();
      })
      .then(function(text) {
        loadingDiv.hidden = true;
        var data = parseCSV(text);
        if (data.length === 0) {
          showError('No data found in CSV.');
          return;
        }
        allData = data;
        filteredData = allData.slice();
        var columns = Object.keys(allData[0]);
        buildHeaders(columns);
        tableWrapper.hidden = false;
        render();
      })
      .catch(function(err) {
        loadingDiv.hidden = true;
        showError('Error loading data: ' + err.message);
      });
  }

  searchInput.addEventListener('input', function() {
    applyFilter(searchInput.value);
  });

  loadData();
})();
