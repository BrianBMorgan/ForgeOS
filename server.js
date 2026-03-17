var express = require('express');
var app = express();
var PORT = process.env.PORT || 3000;

app.get('/', function(req, res) {
  res.send('<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Canvas</title><style>*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; } html, body { height: 100%; } body { background-color: #1A1A2E; display: flex; align-items: center; justify-content: center; font-family: \'Space Grotesk\', \'Inter\', sans-serif; } h1 { color: #ffffff; font-size: clamp(1.5rem, 4vw, 2.5rem); font-weight: 600; letter-spacing: 0.05em; }</style><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600&display=swap" rel="stylesheet"></head><body><h1>Canvas &#8212; Loading</h1></body></html>');
});

app.listen(PORT, '0.0.0.0', function() {
  console.log('Server running on port ' + PORT);
});
