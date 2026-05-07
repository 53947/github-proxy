// injected.js — page-world fetch and XMLHttpRequest wrapper.
//
// Loaded by content-script.js into the page's JS context (NOT the
// extension's isolated world) so it can wrap window.fetch and
// XMLHttpRequest.prototype.send and observe the responses the page
// itself receives from its own API.
//
// v0.2.0 narrows the filter: only the chat_conversations GET is
// captured. That endpoint returns the full conversation tree post-stream
// (~137KB JSON) and is sufficient by itself — capturing the SSE
// completion endpoint is intentionally out of scope. See Prompt
// 05/06/2026-29's verified note for the diagnostic that confirmed
// this is the correct surface.
//
// Responsibilities:
//   - Wrap fetch and XHR exactly once. Idempotent; no-op on repeat.
//   - Filter to GET requests against the chat_conversations endpoint
//     ONLY (CONV_GET_RE shared between fetch and XHR branches).
//   - Clone responses before reading. The page must still see the
//     original body — never consume it.
//   - Skip silently if the parsed body lacks a top-level `uuid` field
//     (a guard against shape drift). Log the skip once per page-load.
//   - Forward parsed JSON to the content script via window.postMessage
//     with source "linksblue-chrome-capture".
//   - Never mutate request or response. Never block. Errors swallowed —
//     capture failure must never break claude.ai.

(function () {
  if (window.__linksblueChromeCaptureInstalled) return;
  window.__linksblueChromeCaptureInstalled = true;

  // The single capture target — exactly the chat_conversations GET that
  // claude.ai's React app fires after each turn finishes streaming.
  // Anchored: 36-char UUIDs in both org and conversation positions, with
  // either a query string or end-of-URL after the conversation UUID.
  var CONV_GET_RE = /^https:\/\/claude\.ai\/api\/organizations\/[0-9a-f-]{36}\/chat_conversations\/[0-9a-f-]{36}(\?|$)/;

  var missingUuidLogged = false;

  function safePostMessage(payload) {
    try { window.postMessage(payload, '*'); } catch (_) {}
  }

  function urlFromRequestArg(input) {
    try {
      if (typeof input === 'string') return input;
      if (input && typeof input.url === 'string') return input.url;
      return String(input);
    } catch (_) { return ''; }
  }

  function methodFromInit(input, init) {
    try {
      if (init && typeof init.method === 'string') return init.method.toUpperCase();
      if (input && typeof input.method === 'string') return input.method.toUpperCase();
    } catch (_) {}
    return 'GET';
  }

  function maybeForward(url, status, parsed, capturedAt) {
    if (!parsed || typeof parsed.uuid !== 'string') {
      if (!missingUuidLogged) {
        missingUuidLogged = true;
        try { console.log('[linksblue-chrome-capture] response missing uuid; skipped'); } catch (_) {}
      }
      return;
    }
    safePostMessage({
      source: 'linksblue-chrome-capture',
      url: url,
      status: status,
      parsedJson: parsed,
      capturedAt: capturedAt,
    });
  }

  // ---- fetch wrapper ----
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      var url = urlFromRequestArg(input);
      var method = methodFromInit(input, init);
      var p = origFetch.apply(this, arguments);
      try {
        if (method === 'GET' && CONV_GET_RE.test(url)) {
          p.then(function (response) {
            try {
              var clone = response.clone();
              clone.text().then(function (text) {
                var parsed;
                try { parsed = JSON.parse(text); } catch (_) { return; }
                maybeForward(url, response.status, parsed, Date.now());
              }).catch(function () {});
            } catch (_) {}
          }).catch(function () {});
        }
      } catch (_) {}
      return p;
    };
  }

  // ---- XHR wrapper ----
  var XHRProto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XHRProto) {
    var origOpen = XHRProto.open;
    var origSend = XHRProto.send;
    XHRProto.open = function (method, url) {
      try {
        this.__linksblueUrl = String(url);
        this.__linksblueMethod = method ? String(method).toUpperCase() : 'GET';
      } catch (_) {}
      return origOpen.apply(this, arguments);
    };
    XHRProto.send = function () {
      var xhr = this;
      try {
        xhr.addEventListener('load', function () {
          try {
            var url = xhr.__linksblueUrl || '';
            var method = xhr.__linksblueMethod || 'GET';
            if (method !== 'GET') return;
            if (!CONV_GET_RE.test(url)) return;
            var text = '';
            try {
              text = (xhr.responseType === '' || xhr.responseType === 'text') ? xhr.responseText : '';
            } catch (_) {}
            if (!text) return;
            var parsed;
            try { parsed = JSON.parse(text); } catch (_) { return; }
            maybeForward(url, xhr.status, parsed, Date.now());
          } catch (_) {}
        });
      } catch (_) {}
      return origSend.apply(this, arguments);
    };
  }
})();
