var express = require('express');
var path = require('path');
var { Resend } = require('resend');
var app = express();
var PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post('/api/contact', function(req, res) {
  var name = (req.body.name || '').trim();
  var email = (req.body.email || '').trim();
  var message = (req.body.message || '').trim();

  if (!name || !email || !message) {
    return res.status(400).json({ ok: false, error: 'All fields are required.' });
  }

  var resend = new Resend(process.env.RESEND_API_KEY);

  var htmlBody = [
    '<h2>New Contact Form Submission</h2>',
    '<p><strong>Name:</strong> ' + name + '</p>',
    '<p><strong>Email:</strong> ' + email + '</p>',
    '<p><strong>Message:</strong></p>',
    '<p>' + message.replace(/\n/g, '<br>') + '</p>'
  ].join('');

  resend.emails.send({
    from: 'admin@makemysandbox.com',
    to: 'admin@makemysandbox.com',
    reply_to: email,
    subject: 'New message from ' + name + ' via Sandbox-XM',
    html: htmlBody
  }).then(function() {
    res.json({ ok: true });
  }).catch(function(err) {
    console.error('Resend error:', err);
    res.status(500).json({ ok: false, error: 'Failed to send message. Please try again.' });
  });
});

app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', function() {
  console.log('Sandbox-XM server running on port ' + PORT);
});
