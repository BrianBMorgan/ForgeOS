var express = require('express');
var app = express();

var PORT = process.env.PORT || 3001;

app.get('/', function(req, res) {
  res.send('<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Intel Event Content Review</title><style>body{margin:0;background:#1A1A2E;color:#fff;font-family:\'Space Grotesk\',Inter,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;}</style></head><body><h1>Intel Event Content Review &#8212; Loading</h1></body></html>');
});

app.listen(PORT, '0.0.0.0', function() {
  console.log('Intel Event Content Review running on port ' + PORT);
});
