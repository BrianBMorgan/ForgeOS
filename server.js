const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hello World</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #0f0f0f;
      font-family: 'Segoe UI', system-ui, sans-serif;
    }
    h1 {
      font-size: clamp(2rem, 8vw, 5rem);
      color: #fff;
      letter-spacing: -0.02em;
      animation: fadeIn 0.8s ease both;
    }
    h1 span {
      background: linear-gradient(135deg, #a78bfa, #60a5fa);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(16px); }
      to   { opacity: 1; transform: translateY(0); }
    }
  </style>
<script>(function(){var active=false,overlay=null,lastEl=null;function sel(el){var parts=[];var e=el;for(var i=0;i<4&&e&&e!==document.body;i++){var s=e.tagName.toLowerCase();if(e.id)s+='#'+e.id;else if(e.className&&typeof e.className==='string')s+='.'+e.className.trim().split(/\s+/).slice(0,2).join('.');parts.unshift(s);e=e.parentElement;}return parts.join(' > ');}function trim(s,n){return s&&s.length>n?s.slice(0,n)+'...':s||'';}function show(el){if(!overlay){overlay=document.createElement('div');overlay.style.cssText='position:fixed;pointer-events:none;outline:2px solid #6366f1;outline-offset:1px;background:rgba(99,102,241,0.1);z-index:2147483647;transition:all 0.05s';document.body.appendChild(overlay);}var r=el.getBoundingClientRect();overlay.style.top=r.top+'px';overlay.style.left=r.left+'px';overlay.style.width=r.width+'px';overlay.style.height=r.height+'px';overlay.style.display='block';}function hide(){if(overlay)overlay.style.display='none';}document.addEventListener('mousemove',function(e){if(!active)return;var el=document.elementFromPoint(e.clientX,e.clientY);if(el&&el!==overlay){lastEl=el;show(el);}},true);document.addEventListener('click',function(e){if(!active)return;e.preventDefault();e.stopPropagation();var el=lastEl||e.target;window.parent.postMessage({type:'forge:inspect:selection',outerHTML:trim(el.outerHTML,600),textContent:trim((el.textContent||'').trim(),200),selector:sel(el)},'*');},true);window.addEventListener('message',function(e){if(!e.data)return;if(e.data.type==='forge:inspect:activate'){active=true;document.body.style.cursor='crosshair';}if(e.data.type==='forge:inspect:deactivate'){active=false;hide();document.body.style.cursor='';}});})();</script>\n</head>
<body>
  <h1>Hello, <span>world</span></h1>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
