var express = require('express');
var path = require('path');
var Anthropic = require('@anthropic-ai/sdk');

var app = express();
var PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function getSunSign(month, day) {
  if ((month === 3 && day >= 21) || (month === 4 && day <= 19)) return 'Aries';
  if ((month === 4 && day >= 20) || (month === 5 && day <= 20)) return 'Taurus';
  if ((month === 5 && day >= 21) || (month === 6 && day <= 20)) return 'Gemini';
  if ((month === 6 && day >= 21) || (month === 7 && day <= 22)) return 'Cancer';
  if ((month === 7 && day >= 23) || (month === 8 && day <= 22)) return 'Leo';
  if ((month === 8 && day >= 23) || (month === 9 && day <= 22)) return 'Virgo';
  if ((month === 9 && day >= 23) || (month === 10 && day <= 22)) return 'Libra';
  if ((month === 10 && day >= 23) || (month === 11 && day <= 21)) return 'Scorpio';
  if ((month === 11 && day >= 22) || (month === 12 && day <= 21)) return 'Sagittarius';
  if ((month === 12 && day >= 22) || (month === 1 && day <= 19)) return 'Capricorn';
  if ((month === 1 && day >= 20) || (month === 2 && day <= 18)) return 'Aquarius';
  return 'Pisces';
}

function getMoonSign(year, month, day, hour) {
  var signs = ['Aries','Taurus','Gemini','Cancer','Leo','Virgo','Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces'];
  var refDate = new Date(2000, 2, 21, 0, 0, 0);
  var birthDate = new Date(year, month - 1, day, hour || 12, 0, 0);
  var diffMs = birthDate - refDate;
  var diffDays = diffMs / (1000 * 60 * 60 * 24);
  var lunarCycle = 27.321661;
  var daysPerSign = lunarCycle / 12;
  var normalizedDays = ((diffDays % lunarCycle) + lunarCycle) % lunarCycle;
  var signIndex = Math.floor(normalizedDays / daysPerSign) % 12;
  return signs[signIndex];
}

function getRisingSign(hour, minute) {
  var signs = ['Aries','Taurus','Gemini','Cancer','Leo','Virgo','Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces'];
  var totalMinutes = (hour * 60) + (minute || 0);
  var signIndex = Math.floor(totalMinutes / 120) % 12;
  return signs[signIndex];
}

function getElement(sign) {
  var fire = ['Aries', 'Leo', 'Sagittarius'];
  var earth = ['Taurus', 'Virgo', 'Capricorn'];
  var air = ['Gemini', 'Libra', 'Aquarius'];
  var water = ['Cancer', 'Scorpio', 'Pisces'];
  if (fire.indexOf(sign) !== -1) return 'Fire';
  if (earth.indexOf(sign) !== -1) return 'Earth';
  if (air.indexOf(sign) !== -1) return 'Air';
  return 'Water';
}

function getModality(sign) {
  var cardinal = ['Aries', 'Cancer', 'Libra', 'Capricorn'];
  var fixed = ['Taurus', 'Leo', 'Scorpio', 'Aquarius'];
  if (cardinal.indexOf(sign) !== -1) return 'Cardinal';
  if (fixed.indexOf(sign) !== -1) return 'Fixed';
  return 'Mutable';
}

function getPlanetaryRuler(sign) {
  var rulers = {
    'Aries': 'Mars', 'Taurus': 'Venus', 'Gemini': 'Mercury',
    'Cancer': 'Moon', 'Leo': 'Sun', 'Virgo': 'Mercury',
    'Libra': 'Venus', 'Scorpio': 'Pluto', 'Sagittarius': 'Jupiter',
    'Capricorn': 'Saturn', 'Aquarius': 'Uranus', 'Pisces': 'Neptune'
  };
  return rulers[sign] || 'Unknown';
}

function getSignSymbol(sign) {
  var symbols = {
    'Aries': '\u2648', 'Taurus': '\u2649', 'Gemini': '\u264a',
    'Cancer': '\u264b', 'Leo': '\u264c', 'Virgo': '\u264d',
    'Libra': '\u264e', 'Scorpio': '\u264f', 'Sagittarius': '\u2650',
    'Capricorn': '\u2651', 'Aquarius': '\u2652', 'Pisces': '\u2653'
  };
  return symbols[sign] || '';
}

app.post('/api/chart', function(req, res) {
  var body = req.body;
  var dateOfBirth = body.dateOfBirth;
  var timeOfBirth = body.timeOfBirth;
  var cityOfBirth = body.cityOfBirth;

  if (!dateOfBirth || !cityOfBirth) {
    return res.status(400).json({ ok: false, error: 'Date of birth and city are required.' });
  }

  var dateParts = dateOfBirth.split('-');
  var year = parseInt(dateParts[0]);
  var month = parseInt(dateParts[1]);
  var day = parseInt(dateParts[2]);

  var hour = 12;
  var minute = 0;
  if (timeOfBirth) {
    var timeParts = timeOfBirth.split(':');
    hour = parseInt(timeParts[0]);
    minute = parseInt(timeParts[1]) || 0;
  }

  var sunSign = getSunSign(month, day);
  var moonSign = getMoonSign(year, month, day, hour);
  var risingSign = timeOfBirth ? getRisingSign(hour, minute) : null;

  var chartData = {
    sunSign: sunSign,
    moonSign: moonSign,
    risingSign: risingSign,
    sunElement: getElement(sunSign),
    moonElement: getElement(moonSign),
    sunModality: getModality(sunSign),
    sunRuler: getPlanetaryRuler(sunSign),
    moonRuler: getPlanetaryRuler(moonSign),
    risingRuler: risingSign ? getPlanetaryRuler(risingSign) : null,
    risingElement: risingSign ? getElement(risingSign) : null,
    dateOfBirth: dateOfBirth,
    timeOfBirth: timeOfBirth || 'Unknown',
    cityOfBirth: cityOfBirth,
    year: year,
    month: month,
    day: day,
    hour: hour
  };

  var client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  var prompt = 'You are a wise and insightful astrologer. Based on the following birth chart data, provide a detailed, personalized astrological reading. Be warm, encouraging, and specific. Use the actual sign names and placements provided.\n\n' +
    'Birth Details:\n' +
    '- Date of Birth: ' + dateOfBirth + '\n' +
    '- Time of Birth: ' + (timeOfBirth || 'Unknown') + '\n' +
    '- City of Birth: ' + cityOfBirth + '\n\n' +
    'Chart Placements:\n' +
    '- Sun Sign: ' + sunSign + ' (' + getElement(sunSign) + ' / ' + getModality(sunSign) + ')\n' +
    '- Moon Sign: ' + moonSign + '\n' +
    (risingSign ? '- Rising Sign (Ascendant): ' + risingSign + '\n' : '') +
    '- Sun Ruler: ' + getPlanetaryRuler(sunSign) + '\n' +
    '- Moon Ruler: ' + getPlanetaryRuler(moonSign) + '\n\n' +
    'Please provide a reading with these sections:\n' +
    '1. CORE IDENTITY (Sun in ' + sunSign + '): 2-3 sentences about their core personality and life purpose\n' +
    '2. EMOTIONAL NATURE (Moon in ' + moonSign + '): 2-3 sentences about their emotional world, instincts, and inner life\n' +
    (risingSign ? '3. OUTER PERSONA (Rising in ' + risingSign + '): 2-3 sentences about how others perceive them and their approach to new situations\n' : '') +
    (risingSign ? '4.' : '3.') + ' ELEMENTAL BALANCE: Brief insight on their dominant elements\n' +
    (risingSign ? '5.' : '4.') + ' LIFE THEMES: 2-3 key themes or lessons for this person\n' +
    (risingSign ? '6.' : '5.') + ' COSMIC GIFTS: Their natural strengths and talents based on these placements\n\n' +
    'Keep the total response under 500 words. Be mystical yet grounded, poetic yet practical.';

  client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }]
  }).then(function(response) {
    var reading = response.content[0].text;
    chartData.reading = reading;
    res.json({ ok: true, chart: chartData });
  }).catch(function(err) {
    console.error('Claude API error:', err);
    chartData.reading = null;
    res.json({ ok: true, chart: chartData });
  });
});

app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', function() {
  console.log('Astrology app running on port ' + PORT);
});
