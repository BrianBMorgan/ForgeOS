var express = require('express');
var path = require('path');
var axios = require('axios');
var { Resend } = require('resend');

var app = express();
var PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Proxy route for global assets
app.get('/api/assets/:filename', function(req, res) {
  var filename = req.params.filename;
  var assetUrl = 'https://forge-os.ai/api/assets/' + encodeURIComponent(filename);

  axios({
    method: 'get',
    url: assetUrl,
    responseType: 'stream',
    timeout: 15000
  }).then(function(response) {
    var contentType = response.headers['content-type'] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    response.data.pipe(res);
  }).catch(function(err) {
    console.error('Asset proxy error for ' + filename + ':', err.message);
    res.status(404).json({ ok: false, error: 'Asset not found' });
  });
});

// HubSpot upsert helper
function upsertHubSpotContact(name, email) {
  var nameParts = name.trim().split(' ');
  var firstname = nameParts[0] || '';
  var lastname = nameParts.slice(1).join(' ') || '';

  return fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.HUBSPOT_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      properties: {
        email: email,
        firstname: firstname,
        lastname: lastname,
        hs_lead_status: 'NEW'
      }
    })
  }).then(function(res) {
    if (res.status === 409) {
      return res.json().then(function(existing) {
        var match = existing.message && existing.message.match(/ID: (\d+)/);
        var id = match ? match[1] : null;
        if (id) {
          return fetch('https://api.hubapi.com/crm/v3/objects/contacts/' + id, {
            method: 'PATCH',
            headers: {
              'Authorization': 'Bearer ' + process.env.HUBSPOT_API_KEY,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              properties: {
                firstname: firstname,
                lastname: lastname,
                hs_lead_status: 'NEW'
              }
            })
          });
        }
      });
    }
    return res;
  });
}

// Contact form endpoint
app.post('/api/contact', function(req, res) {
  var name = req.body.name;
  var email = req.body.email;
  var message = req.body.message;

  if (!name || !email || !message) {
    return res.status(400).json({ ok: false, error: 'All fields are required.' });
  }

  var resend = new Resend(process.env.RESEND_API_KEY);

  var emailPromise = resend.emails.send({
    from: 'admin@makemysandbox.com',
    to: 'admin@makemysandbox.com',
    subject: 'New enquiry from ' + name,
    html: '<p><strong>Name:</strong> ' + name + '</p>' +
          '<p><strong>Email:</strong> ' + email + '</p>' +
          '<p><strong>Message:</strong></p>' +
          '<p>' + message + '</p>'
  });

  var hubspotPromise = upsertHubSpotContact(name, email).catch(function(err) {
    console.error('HubSpot error:', err.message);
  });

  Promise.all([emailPromise, hubspotPromise]).then(function() {
    res.json({ ok: true });
  }).catch(function(err) {
    console.error('Contact form error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to send message. Please try again.' });
  });
});

// Privacy policy page
app.get('/privacy', function(req, res) {
  var html = '<!DOCTYPE html>\n' +
    '<html lang="en">\n' +
    '<head>\n' +
    '  <meta charset="UTF-8" />\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n' +
    '  <title>Privacy Policy &mdash; Sandbox-XM</title>\n' +
    '  <link rel="icon" type="image/png" href="/api/assets/Icon.png" />\n' +
    '  <link rel="preconnect" href="https://fonts.googleapis.com" />\n' +
    '  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />\n' +
    '  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Space+Grotesk:wght@400;600;700;800&display=swap" rel="stylesheet" />\n' +
    '  <link rel="stylesheet" href="/style.css" />\n' +
    '  <style>\n' +
    '    .privacy-hero {\n' +
    '      background: linear-gradient(135deg, #1A1A2E 0%, #0F3460 100%);\n' +
    '      padding: 10rem 2rem 5rem;\n' +
    '      text-align: center;\n' +
    '    }\n' +
    '    .privacy-hero h1 {\n' +
    '      font-family: \'Space Grotesk\', sans-serif;\n' +
    '      font-size: clamp(2rem, 5vw, 3.2rem);\n' +
    '      font-weight: 800;\n' +
    '      color: #f0f0f0;\n' +
    '      margin-bottom: 1rem;\n' +
    '    }\n' +
    '    .privacy-hero p {\n' +
    '      font-size: 0.88rem;\n' +
    '      color: #888888;\n' +
    '    }\n' +
    '    .privacy-body-section {\n' +
    '      background: #16213E;\n' +
    '      padding: 5rem 2rem 6rem;\n' +
    '    }\n' +
    '    .privacy-body {\n' +
    '      max-width: 720px;\n' +
    '      margin: 0 auto;\n' +
    '      font-family: \'Inter\', sans-serif;\n' +
    '      font-size: 1.05rem;\n' +
    '      color: #cccccc;\n' +
    '      line-height: 1.85;\n' +
    '    }\n' +
    '    .privacy-body p { margin-bottom: 1.6rem; }\n' +
    '    .privacy-body h2 {\n' +
    '      font-family: \'Space Grotesk\', sans-serif;\n' +
    '      font-size: 1.4rem;\n' +
    '      font-weight: 700;\n' +
    '      color: #ffffff;\n' +
    '      margin-top: 2.5rem;\n' +
    '      margin-bottom: 0.75rem;\n' +
    '    }\n' +
    '    .privacy-body ul { padding-left: 1.5rem; margin-bottom: 1.6rem; }\n' +
    '    .privacy-body li { margin-bottom: 0.6rem; color: #cccccc; }\n' +
    '    .privacy-body strong { color: #ffffff; font-weight: 600; }\n' +
    '    .privacy-back {\n' +
    '      display: inline-flex;\n' +
    '      align-items: center;\n' +
    '      gap: 0.4rem;\n' +
    '      font-family: \'Space Grotesk\', sans-serif;\n' +
    '      font-size: 0.88rem;\n' +
    '      font-weight: 600;\n' +
    '      color: #E94560;\n' +
    '      text-decoration: none;\n' +
    '      margin-bottom: 3rem;\n' +
    '      display: block;\n' +
    '    }\n' +
    '    .privacy-back:hover { color: #ffffff; text-decoration: none; }\n' +
    '    .privacy-back::before { content: \'\\2190  \'; }\n' +
    '    .opt-out-btn {\n' +
    '      display: inline-block;\n' +
    '      background: transparent;\n' +
    '      border: 1px solid #E94560;\n' +
    '      color: #E94560;\n' +
    '      font-family: \'Space Grotesk\', sans-serif;\n' +
    '      font-size: 0.88rem;\n' +
    '      font-weight: 600;\n' +
    '      padding: 0.5rem 1.25rem;\n' +
    '      border-radius: 4px;\n' +
    '      cursor: pointer;\n' +
    '      transition: background 0.2s, color 0.2s;\n' +
    '      margin-top: 0.5rem;\n' +
    '    }\n' +
    '    .opt-out-btn:hover { background: #E94560; color: #ffffff; }\n' +
    '    @media (max-width: 768px) {\n' +
    '      .privacy-hero { padding: 8rem 1.5rem 4rem; }\n' +
    '      .privacy-body-section { padding: 3rem 1.5rem 4rem; }\n' +
    '    }\n' +
    '  </style>\n' +
    '</head>\n' +
    '<body>\n' +
    '  <nav class="navbar" id="navbar">\n' +
    '    <div class="nav-container">\n' +
    '      <a href="/" class="nav-logo">Sandbox-<span style="color: #E94560;">XM</span></a>\n' +
    '      <button class="nav-toggle" id="navToggle" aria-label="Toggle navigation">\n' +
    '        <span></span><span></span><span></span>\n' +
    '      </button>\n' +
    '      <ul class="nav-links" id="navLinks">\n' +
    '        <li><a href="/#services">Services</a></li>\n' +
    '        <li><a href="/#about">About</a></li>\n' +
    '        <li><a href="/#contact">Contact</a></li>\n' +
    '        <li><a href="/sandbox.html">The Sandbox</a></li>\n' +
    '      </ul>\n' +
    '    </div>\n' +
    '  </nav>\n' +
    '  <section class="privacy-hero">\n' +
    '    <h1>Privacy Policy</h1>\n' +
    '    <p>Last updated: June 2025</p>\n' +
    '  </section>\n' +
    '  <section class="privacy-body-section">\n' +
    '    <div class="privacy-body">\n' +
    '      <a href="/" class="privacy-back">Back to Sandbox-XM</a>\n' +
    '      <p>This Privacy Policy explains how Sandbox-XM (&#8220;we&#8221;, &#8220;us&#8221;, &#8220;our&#8221;) collects, uses, and protects information when you visit our website.</p>\n' +
    '      <h2>1. Data We Collect</h2>\n' +
    '      <p>We may collect the following categories of data when you use this website:</p>\n' +
    '      <ul>\n' +
    '        <li><strong>Analytics data:</strong> Page views, session duration, referrer URLs, and device/browser type collected via first-party analytics.</li>\n' +
    '        <li><strong>Contact form data:</strong> Name, email address, and message content submitted through our contact form.</li>\n' +
    '        <li><strong>Consent preferences:</strong> A flag stored in your browser&#8217;s localStorage indicating whether you have acknowledged our analytics notice.</li>\n' +
    '      </ul>\n' +
    '      <h2>2. How We Use Your Data</h2>\n' +
    '      <ul>\n' +
    '        <li>To understand how visitors use our website and improve the experience.</li>\n' +
    '        <li>To respond to enquiries submitted via the contact form.</li>\n' +
    '        <li>To maintain a record of consent preferences in your browser.</li>\n' +
    '      </ul>\n' +
    '      <h2>3. Data Storage</h2>\n' +
    '      <p>Analytics data is processed and stored on servers within the European Economic Area or equivalent jurisdictions with adequate data protection standards. Contact form submissions are transmitted via Resend and may be stored in our CRM system (HubSpot). Consent preferences are stored locally in your browser and are never transmitted to our servers.</p>\n' +
    '      <h2>4. Cookies and Local Storage</h2>\n' +
    '      <p>We do not use third-party tracking cookies. We store a single consent flag (<code>_fa_consent</code>) in your browser&#8217;s localStorage to remember that you have acknowledged our analytics notice. This value is not shared with any third party.</p>\n' +
    '      <h2>5. Your Rights</h2>\n' +
    '      <p>Under applicable data protection law (including the UK GDPR and EU GDPR), you have the right to access, correct, or delete personal data we hold about you. To exercise these rights, contact us at <a href="mailto:admin@makemysandbox.com">admin@makemysandbox.com</a>.</p>\n' +
    '      <h2>6. Opt-Out</h2>\n' +
    '      <p>You can withdraw your analytics consent at any time by clicking the button below. This will remove the consent flag from your browser and the analytics notice will reappear on your next visit.</p>\n' +
    '      <button class="opt-out-btn" id="optOutBtn">Withdraw analytics consent</button>\n' +
    '      <p id="optOutConfirm" style="display:none; margin-top:1rem; color:#4caf50;">Consent withdrawn. The analytics notice will reappear on your next visit.</p>\n' +
    '      <h2>7. Third-Party Services</h2>\n' +
    '      <ul>\n' +
    '        <li><strong>Resend</strong> &#8212; used to deliver contact form email notifications. <a href="https://resend.com/privacy" target="_blank" rel="noopener">Resend Privacy Policy</a>.</li>\n' +
    '        <li><strong>HubSpot</strong> &#8212; used as a CRM to store contact enquiries. <a href="https://legal.hubspot.com/privacy-policy" target="_blank" rel="noopener">HubSpot Privacy Policy</a>.</li>\n' +
    '        <li><strong>Google Fonts</strong> &#8212; used to load web fonts. <a href="https://policies.google.com/privacy" target="_blank" rel="noopener">Google Privacy Policy</a>.</li>\n' +
    '      </ul>\n' +
    '      <h2>8. Changes to This Policy</h2>\n' +
    '      <p>We may update this policy from time to time. The &#8220;Last updated&#8221; date at the top of this page reflects the most recent revision. Continued use of the website after changes constitutes acceptance of the updated policy.</p>\n' +
    '      <h2>9. Contact</h2>\n' +
    '      <p>For any privacy-related queries, contact us at <a href="mailto:admin@makemysandbox.com">admin@makemysandbox.com</a>.</p>\n' +
    '    </div>\n' +
    '  </section>\n' +
    '  <footer class="site-footer">\n' +
    '    <p>&copy; 2026 Sandbox-XM. Part of <a href="#">Sandbox Group</a>. All rights reserved.</p>\n' +
    '  </footer>\n' +
    '  <script>\n' +
    '    var navbar = document.getElementById(\'navbar\');\n' +
    '    window.addEventListener(\'scroll\', function() {\n' +
    '      if (window.scrollY > 40) { navbar.classList.add(\'scrolled\'); }\n' +
    '      else { navbar.classList.remove(\'scrolled\'); }\n' +
    '    });\n' +
    '    var navToggle = document.getElementById(\'navToggle\');\n' +
    '    var navLinks = document.getElementById(\'navLinks\');\n' +
    '    navToggle.addEventListener(\'click\', function() {\n' +
    '      navLinks.classList.toggle(\'open\');\n' +
    '      navToggle.classList.toggle(\'open\');\n' +
    '    });\n' +
    '    var optOutBtn = document.getElementById(\'optOutBtn\');\n' +
    '    var optOutConfirm = document.getElementById(\'optOutConfirm\');\n' +
    '    optOutBtn.addEventListener(\'click\', function() {\n' +
    '      localStorage.removeItem(\'_fa_consent\');\n' +
    '      optOutConfirm.style.display = \'block\';\n' +
    '      optOutBtn.disabled = true;\n' +
    '      optOutBtn.textContent = \'Consent withdrawn\';\n' +
    '    });\n' +
    '  <\/script>\n' +
    '</body>\n' +
    '</html>\n';
  res.send(html);
});

// Fallback to index.html for SPA-style routing
app.get('*', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', function() {
  console.log('Sandbox-XM server running on port ' + PORT);
});
