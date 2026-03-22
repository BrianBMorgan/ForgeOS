var express = require('express');
var path = require('path');

var app = express();
var PORT = process.env.PORT || 3000;

app.use(express.static('public'));

app.get('/', function(req, res) {
  var html = '<!DOCTYPE html>\n' +
    '<html lang="en">\n' +
    '<head>\n' +
    '  <meta charset="UTF-8">\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    '  <title>CSV Grid Viewer</title>\n' +
    '  <link rel="stylesheet" href="/style.css">\n' +
    '</head>\n' +
    '<body>\n' +
    '  <div class="app">\n' +
    '    <header>\n' +
    '      <h1>&#128202; CSV Grid Viewer</h1>\n' +
    '      <p class="subtitle">Book1.csv</p>\n' +
    '    </header>\n' +
    '    <div class="controls">\n' +
    '      <input type="text" id="searchInput" placeholder="&#128269; Search..." />\n' +
    '      <span id="rowCount" class="row-count"></span>\n' +
    '    </div>\n' +
    '    <div id="error" class="error" hidden></div>\n' +
    '    <div id="loading" class="loading">Loading data...</div>\n' +
    '    <div id="tableWrapper" class="table-wrapper" hidden>\n' +
    '      <table id="dataTable">\n' +
    '        <thead id="tableHead"></thead>\n' +
    '        <tbody id="tableBody"></tbody>\n' +
    '      </table>\n' +
    '    </div>\n' +
    '    <div class="pagination" id="pagination"></div>\n' +
    '  </div>\n' +
    '  <script src="/app.js"></script>\n' +
    '</body>\n' +
    '</html>';
  res.send(html);
});

app.listen(PORT, function() {
  console.log('Server running on port ' + PORT);
});
