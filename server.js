import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Serve the built assets under /context-agent
app.use('/context-agent', express.static(path.join(__dirname, 'dist')));

// Asset proxy for ForgeOS assets
app.get('/api/assets/:filename', async function(req, res) {
  try {
    const response = await fetch('https://forge-os.ai/api/assets/' + req.params.filename);
    if (!response.ok) throw new Error('Not found');
    const buffer = await response.arrayBuffer();
    res.set('Content-Type', response.headers.get('content-type'));
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(404).send('Asset not found');
  }
});

// Redirect root to /context-agent
app.get('/', function(req, res) {
  res.redirect(301, '/context-agent');
});

// SPA catch-all: any /context-agent/* route serves index.html
app.get('/context-agent/*', function(req, res) {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, '0.0.0.0', function() {
  console.log('Forge Intelligence Context Agent Workspace running on port ' + PORT);
});
