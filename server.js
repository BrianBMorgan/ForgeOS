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
    '<script>(function(){var active=false,overlay=null,lastEl=null;function sel(el){var parts=[];var e=el;for(var i=0;i<4&&e&&e!==document.body;i++){var s=e.tagName.toLowerCase();if(e.id)s+='#'+e.id;else if(e.className&&typeof e.className==='string')s+='.'+e.className.trim().split(/\s+/).slice(0,2).join('.');parts.unshift(s);e=e.parentElement;}return parts.join(' > ');}function trim(s,n){return s&&s.length>n?s.slice(0,n)+'...':s||'';}function show(el){if(!overlay){overlay=document.createElement('div');overlay.style.cssText='position:fixed;pointer-events:none;outline:2px solid #6366f1;outline-offset:1px;background:rgba(99,102,241,0.1);z-index:2147483647;transition:all 0.05s';document.body.appendChild(overlay);}var r=el.getBoundingClientRect();overlay.style.top=r.top+'px';overlay.style.left=r.left+'px';overlay.style.width=r.width+'px';overlay.style.height=r.height+'px';overlay.style.display='block';}function hide(){if(overlay)overlay.style.display='none';}document.addEventListener('mousemove',function(e){if(!active)return;var el=document.elementFromPoint(e.clientX,e.clientY);if(el&&el!==overlay){lastEl=el;show(el);}},true);document.addEventListener('click',function(e){if(!active)return;e.preventDefault();e.stopPropagation();var el=lastEl||e.target;window.parent.postMessage({type:'forge:inspect:selection',outerHTML:trim(el.outerHTML,600),textContent:trim((el.textContent||'').trim(),200),selector:sel(el)},'*');},true);window.addEventListener('message',function(e){if(!e.data)return;if(e.data.type==='forge:inspect:activate'){active=true;document.body.style.cursor='crosshair';}if(e.data.type==='forge:inspect:deactivate'){active=false;hide();document.body.style.cursor='';}});})();</script>\n</head>\n' +
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
