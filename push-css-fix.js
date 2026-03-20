var https = require('https');

var TOKEN = process.env.GITHUB_TOKEN;
var OWNER = 'BrianBMorgan';
var REPO = 'ForgeOS';
var FILE_PATH = 'client/src/index.css';

function githubRequest(method, path, body, callback) {
  var data = body ? JSON.stringify(body) : null;
  var options = {
    hostname: 'api.github.com',
    path: path,
    method: method,
    headers: {
      'Authorization': 'token ' + TOKEN,
      'User-Agent': 'ForgeOS-Bot',
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    }
  };
  if (data) options.headers['Content-Length'] = Buffer.byteLength(data);

  var req = https.request(options, function(res) {
    var chunks = [];
    res.on('data', function(c) { chunks.push(c); });
    res.on('end', function() {
      try {
        callback(null, JSON.parse(Buffer.concat(chunks).toString()));
      } catch(e) {
        callback(e);
      }
    });
  });
  req.on('error', callback);
  if (data) req.write(data);
  req.end();
}

// Step 1: Get current file (sha + content)
githubRequest('GET', '/repos/' + OWNER + '/' + REPO + '/contents/' + FILE_PATH, null, function(err, file) {
  if (err) { console.error('GET error:', err); process.exit(1); }
  if (file.message) { console.error('GitHub error:', file.message); process.exit(1); }

  var sha = file.sha;
  var content = Buffer.from(file.content, 'base64').toString('utf8');

  // Step 2: Apply the two changes
  // Change 1: justify-content: flex-end -> flex-start in .prompt-actions
  var updated = content.replace(
    /\.prompt-actions\s*\{([^}]*?)justify-content:\s*flex-end/,
    function(match, inner) {
      return match.replace('justify-content: flex-end', 'justify-content: flex-start');
    }
  );

  // Verify change 1 was made
  if (updated === content) {
    console.error('ERROR: Could not find .prompt-actions justify-content: flex-end — no change made');
    process.exit(1);
  }

  // Change 2: Add/update .attach-btn styles
  // Check if .attach-btn already exists
  var attachBtnRule = '\n\n.attach-btn {\n' +
    '  width: 28px;\n' +
    '  height: 28px;\n' +
    '  padding: 0;\n' +
    '  display: flex;\n' +
    '  align-items: center;\n' +
    '  justify-content: center;\n' +
    '  background: rgba(255, 255, 255, 0.06);\n' +
    '  border: 1px solid #1e293b;\n' +
    '  border-radius: 50%;\n' +
    '  color: #94a3b8;\n' +
    '  font-size: 0.9rem;\n' +
    '  cursor: pointer;\n' +
    '  transition: background 0.15s, color 0.15s;\n' +
    '  flex-shrink: 0;\n' +
    '}\n' +
    '\n' +
    '.attach-btn:hover {\n' +
    '  background: rgba(255, 255, 255, 0.1);\n' +
    '  color: #e2e8f0;\n' +
    '}';

  if (updated.indexOf('.attach-btn {') !== -1) {
    // Replace existing .attach-btn block
    updated = updated.replace(
      /\.attach-btn\s*\{[^}]*\}/,
      '.attach-btn {\n' +
      '  width: 28px;\n' +
      '  height: 28px;\n' +
      '  padding: 0;\n' +
      '  display: flex;\n' +
      '  align-items: center;\n' +
      '  justify-content: center;\n' +
      '  background: rgba(255, 255, 255, 0.06);\n' +
      '  border: 1px solid #1e293b;\n' +
      '  border-radius: 50%;\n' +
      '  color: #94a3b8;\n' +
      '  font-size: 0.9rem;\n' +
      '  cursor: pointer;\n' +
      '  transition: background 0.15s, color 0.15s;\n' +
      '  flex-shrink: 0;\n' +
      '}'
    );
    console.log('Updated existing .attach-btn rule');
  } else {
    // Insert after .prompt-actions block
    updated = updated.replace(
      /\.prompt-actions\s*\{[^}]*\}/,
      function(match) { return match + attachBtnRule; }
    );
    console.log('Inserted new .attach-btn rule');
  }

  // Step 3: Push to GitHub
  var newContent = Buffer.from(updated).toString('base64');
  var body = {
    message: 'UI: move attach button left, tighten padding',
    content: newContent,
    sha: sha
  };

  githubRequest('PUT', '/repos/' + OWNER + '/' + REPO + '/contents/' + FILE_PATH, body, function(err, result) {
    if (err) { console.error('PUT error:', err); process.exit(1); }
    if (result.message) { console.error('GitHub PUT error:', result.message); process.exit(1); }
    console.log('SUCCESS: Pushed to GitHub');
    console.log('Commit SHA:', result.commit && result.commit.sha);
    console.log('Render will auto-redeploy shortly.');
  });
});
