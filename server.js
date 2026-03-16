var express = require('express');
var twilio = require('twilio');
var nodemailer = require('nodemailer');
var Anthropic = require('@anthropic-ai/sdk');

var app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

var PORT = process.env.PORT || 3000;

// Per-call in-memory state keyed by CallSid
var callSessions = new Map();

var SYSTEM_PROMPT = 'You are a professional AI receptionist for Sandbox Group, a portfolio of ventures spanning live experience design (Sandbox-XM), go-to-market strategy and event intelligence (Sandbox-GTM), and web and software production (Forge by Sandbox). You are warm, concise, and helpful. You never pretend to be human — you are an AI assistant.\n\nHandle these scenarios:\n\n1. Leave a message / callback request: collect the caller\'s name, number, and what it\'s regarding. Confirm back to them and let them know someone will follow up.\n2. Scheduling: collect name, number, what they\'d like to discuss, and preferred days/times. Confirm and let them know the team will reach out to confirm.\n3. Services inquiry: give a brief, accurate overview of the relevant Sandbox entity based on what they describe. Offer to take their contact info so the team can follow up with details.\n4. Anything else: handle gracefully, collect name and number, take a message.\n\nAlways end by confirming what you\'ve captured and letting the caller know someone will be in touch. Keep responses short — this is a phone call, not a chat.\n\nWhen you have collected all necessary information and the conversation is naturally complete, end your JSON response with "done": true.\n\nYou must ALWAYS respond with valid JSON in this exact format:\n{"reply": "spoken response text", "done": false, "collected": {"name": "", "phone": "", "reason": "", "notes": ""}}\n\nMerge collected fields across turns — never lose previously captured data. When done is true the server triggers post-call actions.';

var GREETING = "Hi, I'm an AI assistant for Sandbox Group. I can help you leave a message, schedule time with our team, or answer questions about our services. How can I help you today?";

function buildTwiML(sayText, gatherAction, isFinal) {
  var VoiceResponse = twilio.twiml.VoiceResponse;
  var response = new VoiceResponse();

  if (isFinal) {
    response.say({ voice: 'Polly.Joanna' }, sayText);
    response.hangup();
  } else {
    var gather = response.gather({
      input: 'speech',
      action: gatherAction,
      method: 'POST',
      timeout: 5,
      speechTimeout: 'auto'
    });
    gather.say({ voice: 'Polly.Joanna' }, sayText);
    // Fallback if no speech detected
    response.say({ voice: 'Polly.Joanna' }, "I didn't catch that — could you say that again?");
    var retryGather = response.gather({
      input: 'speech',
      action: gatherAction,
      method: 'POST',
      timeout: 5,
      speechTimeout: 'auto'
    });
    retryGather.say({ voice: 'Polly.Joanna' }, 'Please go ahead whenever you are ready.');
  }

  return response.toString();
}

// POST /incoming-call — entry point
app.post('/incoming-call', function(req, res) {
  var callSid = req.body.CallSid || ('unknown-' + Date.now());
  var callerNumber = req.body.From || '';

  // Initialise session
  callSessions.set(callSid, {
    history: [],
    collected: { name: '', phone: callerNumber, reason: '', notes: '' },
    startTime: new Date().toISOString()
  });

  var VoiceResponse = twilio.twiml.VoiceResponse;
  var response = new VoiceResponse();

  var gather = response.gather({
    input: 'speech',
    action: '/respond',
    method: 'POST',
    timeout: 5,
    speechTimeout: 'auto',
    statusCallback: '/call-complete',
    statusCallbackMethod: 'POST'
  });
  gather.say({ voice: 'Polly.Joanna' }, GREETING);

  // Fallback if caller says nothing
  response.say({ voice: 'Polly.Joanna' }, "I didn't catch that — could you say that again?");
  var retryGather = response.gather({
    input: 'speech',
    action: '/respond',
    method: 'POST',
    timeout: 5,
    speechTimeout: 'auto'
  });
  retryGather.say({ voice: 'Polly.Joanna' }, 'Please go ahead whenever you are ready.');

  res.type('text/xml');
  res.send(response.toString());
});

// POST /respond — conversation loop
app.post('/respond', function(req, res) {
  var callSid = req.body.CallSid || '';
  var speechResult = (req.body.SpeechResult || '').trim();

  // If no speech, prompt again
  if (!speechResult) {
    var twiml = buildTwiML("I didn't catch that — could you say that again?", '/respond', false);
    res.type('text/xml');
    res.send(twiml);
    return;
  }

  var session = callSessions.get(callSid);
  if (!session) {
    // Session missing — create a minimal one
    session = {
      history: [],
      collected: { name: '', phone: req.body.From || '', reason: '', notes: '' },
      startTime: new Date().toISOString()
    };
    callSessions.set(callSid, session);
  }

  // Append caller turn to history
  session.history.push({ role: 'user', content: speechResult });

  var client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Build messages with collected context injected as first assistant turn if history > 1
  var messages = session.history.slice();

  client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: messages
  }).then(function(aiResponse) {
    var rawText = aiResponse.content[0].text;

    // Fence-strip pattern
    if (rawText.includes('```')) {
      rawText = rawText.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '');
    }
    var firstBrace = rawText.search(/[{[]/);
    if (firstBrace > 0) rawText = rawText.slice(firstBrace);

    var parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      console.error('Failed to parse Claude JSON:', e.message, rawText.slice(0, 200));
      parsed = { reply: "I'm sorry, I had a technical issue. Could you repeat that?", done: false, collected: {} };
    }

    var reply = parsed.reply || "I'm sorry, I didn't understand. Could you say that again?";
    var done = parsed.done === true;
    var collectedUpdate = parsed.collected || {};

    // Merge collected fields — never lose previously captured data
    if (collectedUpdate.name) session.collected.name = collectedUpdate.name;
    if (collectedUpdate.phone) session.collected.phone = collectedUpdate.phone;
    if (collectedUpdate.reason) session.collected.reason = collectedUpdate.reason;
    if (collectedUpdate.notes) session.collected.notes = collectedUpdate.notes;

    // Append assistant turn to history
    session.history.push({ role: 'assistant', content: rawText });

    var twiml = buildTwiML(reply, '/respond', done);
    res.type('text/xml');
    res.send(twiml);
  }).catch(function(err) {
    console.error('Claude API error:', err.message);
    var twiml = buildTwiML("I'm sorry, I'm having trouble right now. Please try calling back in a moment.", '/respond', true);
    res.type('text/xml');
    res.send(twiml);
  });
});

// POST /call-complete — statusCallback from Twilio
app.post('/call-complete', function(req, res) {
  var callSid = req.body.CallSid || '';
  var callStatus = req.body.CallStatus || 'unknown';

  console.log('Call complete:', callSid, 'Status:', callStatus);

  var session = callSessions.get(callSid);
  if (!session) {
    console.log('No session found for CallSid:', callSid);
    res.sendStatus(200);
    return;
  }

  var collected = session.collected;
  var startTime = session.startTime;

  // Clean up session
  callSessions.delete(callSid);

  var callerName = collected.name || 'Unknown';
  var callerPhone = collected.phone || 'Unknown';
  var reason = collected.reason || 'Not specified';
  var notes = collected.notes || 'None';

  // Send email
  sendEmailSummary(callerName, callerPhone, reason, notes, startTime).catch(function(err) {
    console.error('Email send error:', err.message);
  });

  // Create HubSpot contact
  createHubSpotContact(callerName, callerPhone, reason, notes).catch(function(err) {
    console.error('HubSpot error:', err.message);
  });

  res.sendStatus(200);
});

function sendEmailSummary(name, phone, reason, notes, timestamp) {
  var transporter = nodemailer.createTransport({
    host: 'smtp.resend.com',
    port: 465,
    secure: true,
    auth: {
      user: 'resend',
      pass: process.env.RESEND_API_KEY
    }
  });

  var subject = 'New Sandbox Receptionist Message \u2014 ' + name;
  var body = [
    'New message received via AI Receptionist',
    '',
    'Caller Name:  ' + name,
    'Caller Phone: ' + phone,
    'Reason:       ' + reason,
    'Notes:        ' + notes,
    'Call Time:    ' + timestamp,
    '',
    '---',
    'Sandbox Group AI Receptionist'
  ].join('\n');

  return transporter.sendMail({
    from: 'admin@makemysandbox.com',
    to: process.env.NOTIFY_EMAIL,
    subject: subject,
    text: body
  });
}

function createHubSpotContact(name, phone, reason, notes) {
  var nameParts = name.split(' ');
  var firstname = nameParts[0] || name;
  var lastname = nameParts.slice(1).join(' ') || '';

  var properties = {
    firstname: firstname,
    lastname: lastname,
    phone: phone,
    hs_lead_status: 'NEW',
    lead_source: 'Phone \u2014 AI Receptionist',
    hs_content: 'Reason: ' + reason + '\nNotes: ' + notes
  };

  return fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.HUBSPOT_ACCESS_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ properties: properties })
  }).then(function(res) {
    if (res.status === 409) {
      return res.json().then(function(existing) {
        var idMatch = (existing.message || '').match(/ID: (\d+)/);
        if (!idMatch) return;
        var contactId = idMatch[1];
        return fetch('https://api.hubapi.com/crm/v3/objects/contacts/' + contactId, {
          method: 'PATCH',
          headers: {
            'Authorization': 'Bearer ' + process.env.HUBSPOT_ACCESS_TOKEN,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            properties: {
              firstname: firstname,
              lastname: lastname,
              phone: phone,
              hs_lead_status: 'NEW',
              hs_content: 'Reason: ' + reason + '\nNotes: ' + notes
            }
          })
        });
      });
    }
    if (!res.ok) {
      return res.text().then(function(text) {
        console.error('HubSpot create failed:', res.status, text);
      });
    }
    return res.json().then(function(data) {
      console.log('HubSpot contact created:', data.id);
    });
  });
}

// Health check / root
app.get('/', function(req, res) {
  var html = '<!DOCTYPE html>'
    + '<html lang="en">'
    + '<head>'
    + '<meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
    + '<title>Sandbox AI Receptionist</title>'
    + '<style>'
    + 'body { margin: 0; font-family: Inter, sans-serif; background: #1A1A2E; color: #ccc; display: flex; align-items: center; justify-content: center; min-height: 100vh; }'
    + '.card { background: #16213E; border: 1px solid #0F3460; border-radius: 12px; padding: 2.5rem 3rem; max-width: 520px; text-align: center; }'
    + 'h1 { font-family: "Space Grotesk", sans-serif; color: #fff; font-size: 1.6rem; margin: 0 0 0.5rem; }'
    + '.badge { display: inline-block; background: rgba(233,69,96,0.15); border: 1px solid #E94560; color: #E94560; border-radius: 20px; padding: 0.25rem 0.9rem; font-size: 0.8rem; margin-bottom: 1.5rem; }'
    + 'p { line-height: 1.7; font-size: 0.95rem; }'
    + '.endpoint { background: #0F3460; border-radius: 6px; padding: 0.3rem 0.7rem; font-family: monospace; font-size: 0.85rem; color: #E94560; margin: 0.2rem 0; display: inline-block; }'
    + '.endpoints { margin-top: 1.5rem; text-align: left; }'
    + '.endpoints li { margin: 0.4rem 0; list-style: none; }'
    + '</style>'
    + '</head>'
    + '<body>'
    + '<div class="card">'
    + '<h1>Sandbox AI Receptionist</h1>'
    + '<div class="badge">&#9679; Active</div>'
    + '<p>This server handles inbound Twilio Voice calls for Sandbox Group, conducts AI-powered conversations via Claude, and logs messages to email and HubSpot.</p>'
    + '<div class="endpoints">'
    + '<ul>'
    + '<li><span class="endpoint">POST /incoming-call</span> &mdash; Twilio entry webhook</li>'
    + '<li><span class="endpoint">POST /respond</span> &mdash; Conversation loop</li>'
    + '<li><span class="endpoint">POST /call-complete</span> &mdash; Status callback</li>'
    + '</ul>'
    + '</div>'
    + '</div>'
    + '</body>'
    + '</html>';
  res.send(html);
});

app.listen(PORT, '0.0.0.0', function() {
  console.log('Sandbox AI Receptionist running on port ' + PORT);
});
