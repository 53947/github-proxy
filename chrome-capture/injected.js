// injected.js — page-world fetch and XMLHttpRequest wrapper.
//
// Loaded by content-script.js into the page's JS context (NOT the
// extension's isolated world) so it can wrap window.fetch and
// XMLHttpRequest.prototype.send and observe the responses the page
// itself receives from its own API.
//
// Responsibilities:
//   - Wrap fetch and XHR exactly once. Idempotent; no-op on repeat.
//   - Clone responses before reading. The page must still see the
//     original body — never consume it.
//   - Filter to claude.ai/api/* URLs at the wrapper, before postMessage,
//     to keep IPC volume low.
//   - Forward parsed JSON to the content script via window.postMessage
//     with source "linksblue-chrome-capture".
//   - Never mutate request or response. Never block. Never log to
//     console. Errors are swallowed — capture failure must never break
//     claude.ai.

(function () {
  if (window.__linksblueChromeCaptureInstalled) return;
  window.__linksblueChromeCaptureInstalled = true;

  var API_RE = /^https:\/\/claude\.ai\/api\//;

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

  // ---- fetch wrapper ----
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      var url = urlFromRequestArg(input);
      var p = origFetch.apply(this, arguments);
      try {
        if (API_RE.test(url)) {
          p.then(function (response) {
            try {
              var clone = response.clone();
              clone.text().then(function (text) {
                var parsed;
                try { parsed = JSON.parse(text); } catch (_) { return; }
                safePostMessage({
                  source: 'linksblue-chrome-capture',
                  url: url,
                  status: response.status,
                  parsedJson: parsed,
                  capturedAt: Date.now(),
                });
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
      try { this.__linksblueUrl = String(url); } catch (_) {}
      return origOpen.apply(this, arguments);
    };
    XHRProto.send = function () {
      var xhr = this;
      try {
        xhr.addEventListener('load', function () {
          try {
            var url = xhr.__linksblueUrl || '';
            if (!API_RE.test(url)) return;
            var text = '';
            try { text = xhr.responseType === '' || xhr.responseType === 'text' ? xhr.responseText : ''; } catch (_) {}
            if (!text) return;
            var parsed;
            try { parsed = JSON.parse(text); } catch (_) { return; }
            safePostMessage({
              source: 'linksblue-chrome-capture',
              url: url,
              status: xhr.status,
              parsedJson: parsed,
              capturedAt: Date.now(),
            });
          } catch (_) {}
        });
      } catch (_) {}
      return origSend.apply(this, arguments);
    };
  }
})();
