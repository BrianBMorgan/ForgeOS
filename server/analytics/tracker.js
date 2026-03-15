"use strict";

// Returns the analytics tracking script as a self-contained IIFE string.
// Injected into every published app's HTML pages at publish time.
// projectId is baked in at injection time.
// The beacon endpoint is the ForgeOS root at /api/analytics/events.

function buildTrackerScript(projectId, forgeOrigin) {
  return `<script>
(function() {
  var PROJECT_ID = ${JSON.stringify(projectId)};
  var FORGE_ORIGIN = ${JSON.stringify(forgeOrigin)};
  var ENDPOINT = FORGE_ORIGIN + '/api/analytics/events';
  var BATCH_INTERVAL = 4000;
  var MAX_BATCH = 30;

  // ── Identity ──────────────────────────────────────────────────────────────
  function uid() {
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }
  var visitorId = (function() {
    try {
      var k = '_fvid';
      var v = localStorage.getItem(k);
      if (!v) { v = uid(); localStorage.setItem(k, v); }
      return v;
    } catch(e) { return uid(); }
  })();
  var sessionId = (function() {
    try {
      var k = '_fsid';
      var v = sessionStorage.getItem(k);
      if (!v) { v = uid(); sessionStorage.setItem(k, v); }
      return v;
    } catch(e) { return uid(); }
  })();

  // ── UA parsing ───────────────────────────────────────────────────────────
  function parseUA(ua) {
    var browser = 'Other', os = 'Other';
    if (/Edg\//.test(ua)) browser = 'Edge';
    else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
    else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) browser = 'Chrome';
    else if (/Firefox\//.test(ua)) browser = 'Firefox';
    else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) browser = 'Safari';
    else if (/Chromium\//.test(ua)) browser = 'Chromium';
    else if (/MSIE|Trident/.test(ua)) browser = 'IE';

    if (/Windows/.test(ua)) os = 'Windows';
    else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
    else if (/Mac OS X/.test(ua)) os = 'macOS';
    else if (/Android/.test(ua)) os = 'Android';
    else if (/Linux/.test(ua)) os = 'Linux';
    else if (/CrOS/.test(ua)) os = 'ChromeOS';

    var deviceType = /Mobi|Android|iPhone|iPad|iPod|Touch/.test(ua) ? 'mobile' : 'desktop';
    if (/iPad|Tablet/.test(ua)) deviceType = 'tablet';

    return { browser: browser, os: os, deviceType: deviceType };
  }

  // ── Queue & flush ─────────────────────────────────────────────────────────
  var queue = [];
  function push(type, props) {
    queue.push({
      type: type,
      sessionId: sessionId,
      visitorId: visitorId,
      url: location.href,
      referrer: document.referrer || '',
      properties: props || {},
      ts: Date.now()
    });
    if (queue.length >= MAX_BATCH) flush();
  }

  function flush() {
    if (queue.length === 0) return;
    var batch = queue.splice(0);
    var payload = JSON.stringify({ projectId: PROJECT_ID, events: batch });
    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([payload], { type: 'application/json' });
        navigator.sendBeacon(ENDPOINT, blob);
      } else {
        fetch(ENDPOINT, { method: 'POST', body: payload, headers: { 'Content-Type': 'application/json' }, keepalive: true });
      }
    } catch(e) {}
  }

  setInterval(flush, BATCH_INTERVAL);
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);

  // ── Public API ────────────────────────────────────────────────────────────
  window.forge_track = function(name, props) { push(name, props || {}); };

  // ── Session start ─────────────────────────────────────────────────────────
  var uaInfo = parseUA(navigator.userAgent);
  push('session_start', {
    browser: uaInfo.browser,
    os: uaInfo.os,
    deviceType: uaInfo.deviceType,
    viewport: window.innerWidth + 'x' + window.innerHeight,
    screen: screen.width + 'x' + screen.height,
    dpr: window.devicePixelRatio || 1,
    language: navigator.language || '',
    timezone: (function() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch(e) { return ''; } })(),
    connection: (function() { try { return (navigator.connection || navigator.mozConnection || navigator.webkitConnection || {}).effectiveType || ''; } catch(e) { return ''; } })(),
    touch: (('ontouchstart' in window) || navigator.maxTouchPoints > 0)
  });

  // ── Pageview ──────────────────────────────────────────────────────────────
  var pageEnterTs = Date.now();
  push('pageview', { title: document.title });

  // SPA route change detection
  (function() {
    var lastUrl = location.href;
    function onNav() {
      if (location.href !== lastUrl) {
        if (pageEnterTs) push('page_exit', { timeOnPage: Date.now() - pageEnterTs });
        lastUrl = location.href;
        pageEnterTs = Date.now();
        push('pageview', { title: document.title });
      }
    }
    var origPush = history.pushState.bind(history);
    var origReplace = history.replaceState.bind(history);
    history.pushState = function() { origPush.apply(this, arguments); onNav(); };
    history.replaceState = function() { origReplace.apply(this, arguments); onNav(); };
    window.addEventListener('popstate', onNav);
  })();

  // Page exit — time on page
  window.addEventListener('pagehide', function() {
    push('page_exit', { timeOnPage: Date.now() - pageEnterTs });
  });

  // ── Scroll depth ─────────────────────────────────────────────────────────
  (function() {
    var marks = { 25: false, 50: false, 75: false, 100: false };
    function onScroll() {
      var el = document.documentElement;
      var scrolled = el.scrollTop + el.clientHeight;
      var total = el.scrollHeight;
      if (total <= el.clientHeight) return;
      var pct = Math.round((scrolled / total) * 100);
      [25, 50, 75, 100].forEach(function(mark) {
        if (!marks[mark] && pct >= mark) {
          marks[mark] = true;
          push('scroll_depth', { depth: String(mark) });
        }
      });
    }
    window.addEventListener('scroll', onScroll, { passive: true });
  })();

  // ── Tab visibility ────────────────────────────────────────────────────────
  document.addEventListener('visibilitychange', function() {
    push('visibility', { state: document.visibilityState });
  });

  // ── Clicks ───────────────────────────────────────────────────────────────
  document.addEventListener('click', function(e) {
    var el = e.target;
    // Walk up to find first meaningful element
    var depth = 0;
    while (el && depth < 5) {
      if (el.tagName && /^(A|BUTTON|INPUT|SELECT|TEXTAREA|LABEL|LI)$/.test(el.tagName)) break;
      el = el.parentElement;
      depth++;
    }
    if (!el || !el.tagName) return;
    push('click', {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      text: (el.textContent || '').trim().slice(0, 100),
      href: el.href || null,
      classes: (el.className && typeof el.className === 'string') ? el.className.slice(0, 100) : null
    });
  }, true);

  // ── Form tracking ─────────────────────────────────────────────────────────
  document.addEventListener('submit', function(e) {
    var form = e.target;
    if (!form || form.tagName !== 'FORM') return;
    var fields = Array.from(form.elements)
      .filter(function(f) { return f.name && f.type !== 'password' && f.type !== 'hidden'; })
      .map(function(f) { return f.name; });
    push('form_submit', { formId: form.id || null, action: form.action || null, fields: fields });
  }, true);

  // ── Copy events ───────────────────────────────────────────────────────────
  document.addEventListener('copy', function() {
    var sel = window.getSelection ? window.getSelection().toString().slice(0, 200) : '';
    push('copy', { text: sel });
  });

  // ── JS errors ────────────────────────────────────────────────────────────
  window.addEventListener('error', function(e) {
    push('js_error', {
      message: (e.message || '').slice(0, 500),
      source: (e.filename || '').slice(0, 300),
      line: e.lineno,
      col: e.colno,
      stack: (e.error && e.error.stack ? e.error.stack.slice(0, 1000) : null)
    });
  });
  window.addEventListener('unhandledrejection', function(e) {
    var msg = '';
    try { msg = String(e.reason && e.reason.message ? e.reason.message : e.reason); } catch(_) {}
    push('unhandled_rejection', { message: msg.slice(0, 500) });
  });

  // ── Fetch / XHR intercept ─────────────────────────────────────────────────
  (function() {
    var origFetch = window.fetch;
    window.fetch = function(resource, init) {
      var url = typeof resource === 'string' ? resource : (resource.url || '');
      if (url.indexOf(FORGE_ORIGIN) !== -1) return origFetch.apply(this, arguments);
      var t0 = Date.now();
      var method = (init && init.method) ? init.method.toUpperCase() : 'GET';
      return origFetch.apply(this, arguments).then(function(resp) {
        push('fetch', { url: url.slice(0, 300), method: method, status: resp.status, duration: Date.now() - t0 });
        return resp;
      }, function(err) {
        push('fetch_error', { url: url.slice(0, 300), method: method, error: String(err).slice(0, 200), duration: Date.now() - t0 });
        throw err;
      });
    };

    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) {
      this._fa_method = method;
      this._fa_url = url;
      this._fa_t0 = null;
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function() {
      var xhr = this;
      xhr._fa_t0 = Date.now();
      xhr.addEventListener('loadend', function() {
        var url = String(xhr._fa_url || '');
        if (url.indexOf(FORGE_ORIGIN) === -1) {
          push('xhr', { url: url.slice(0, 300), method: xhr._fa_method || 'GET', status: xhr.status, duration: Date.now() - xhr._fa_t0 });
        }
      });
      return origSend.apply(this, arguments);
    };
  })();

  // ── Web Vitals via PerformanceObserver ────────────────────────────────────
  (function() {
    var vitals = {};
    function reportVitals() {
      if (Object.keys(vitals).length > 0) {
        push('web_vitals', vitals);
        vitals = {};
      }
    }
    function observe(type, cb) {
      try {
        var po = new PerformanceObserver(function(list) {
          list.getEntries().forEach(cb);
        });
        po.observe({ type: type, buffered: true });
      } catch(e) {}
    }

    // LCP
    observe('largest-contentful-paint', function(e) {
      vitals.LCP = Math.round(e.startTime);
    });
    // FID
    observe('first-input', function(e) {
      vitals.FID = Math.round(e.processingStart - e.startTime);
    });
    // CLS
    var clsVal = 0;
    observe('layout-shift', function(e) {
      if (!e.hadRecentInput) clsVal += e.value;
      vitals.CLS = Math.round(clsVal * 1000) / 1000;
    });
    // FCP
    observe('paint', function(e) {
      if (e.name === 'first-contentful-paint') vitals.FCP = Math.round(e.startTime);
    });
    // INP
    observe('event', function(e) {
      if (e.duration > (vitals.INP || 0)) vitals.INP = Math.round(e.duration);
    });

    // TTFB via Navigation Timing
    window.addEventListener('load', function() {
      setTimeout(function() {
        try {
          var nav = performance.getEntriesByType('navigation')[0];
          if (nav) vitals.TTFB = Math.round(nav.responseStart - nav.requestStart);
        } catch(e) {}
        reportVitals();
      }, 0);
    });
  })();

  // ── Performance: page load timing ─────────────────────────────────────────
  window.addEventListener('load', function() {
    setTimeout(function() {
      try {
        var nav = performance.getEntriesByType('navigation')[0];
        if (!nav) return;
        push('page_load', {
          loadTime: Math.round(nav.loadEventEnd - nav.startTime),
          domContentLoaded: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
          ttfb: Math.round(nav.responseStart - nav.requestStart),
          transferSize: nav.transferSize || 0
        });
      } catch(e) {}
    }, 100);
  });

})();
</script>`;
}

module.exports = { buildTrackerScript };
