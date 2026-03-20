var express = require('express');
var { neon } = require('@neondatabase/serverless');

var app = express();
var PORT = process.env.PORT || 3000;

async function checkDb() {
  var url = process.env.APP_DATABASE_URL;
  if (!url) {
    console.log('[db] APP_DATABASE_URL not set — skipping DB check');
    return 'no database configured';
  }
  try {
    var sql = neon(url);
    var result = await sql`SELECT 1 AS ok`;
    return result[0].ok === 1 ? 'connected' : 'unexpected result';
  } catch (err) {
    console.error('[db] connection error:', err.message);
    return 'error: ' + err.message;
  }
}

app.get('/', function(req, res) {
  res.status(200).send('<h1>Intel Event Content Review</h1><p>Server is up.</p>');
});

app.get('/healthz', function(req, res) {
  res.json({ ok: true });
});

app.listen(PORT, '0.0.0.0', async function() {
  console.log('[server] listening on port ' + PORT);
  var dbStatus = await checkDb();
  console.log('[db] status:', dbStatus);
});
