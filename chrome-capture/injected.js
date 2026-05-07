// injected.js — page-world fetch and XMLHttpRequest wrapper.
//
// !!! DIAGNOSTIC BUILD — Response 05/06/2026-31b !!!
//
// This file has been temporarily augmented with [linksblue-diag] console
// logs at every step of the capture path so we can see exactly where
// captures are dropping in v0.2.0. The logging is verbose by design —
// the goal is to surface enough signal that one console copy/paste tells
// us which of the four hypotheses is correct.
//
// What we log (and never log):
//   - URL, method, status, response text length, top-level keys of the
//     parsed body, presence/absence of the `uuid` field. STRUCTURAL
//     metadata only.
//   - We do NOT log the bearer token (it doesn't exist in this file
//     anyway — the token only enters background.js).
//   - We do NOT log full conversation contents — no `chat_messages`,
//     no message bodies. Only the top-level key list.
//
// All [linksblue-diag] logs are removed in v0.2.1 (step 2). This file
// reverts to the v0.2.0 behavior with the actual fix applied.

(function () {
  if (window.__linksblueChromeCaptureInstalled) return;
  window.__linksblueChromeCaptureInstalled = true;

  var CONV_GET_RE = /^https:\/\/claude\.ai\/api\/organizations\/[0-9a-f-]{36}\/chat_conversations\/[0-9a-f-]{36}(\?|$)/;

  var missingUuidLogged = false;
  var keysLogged = false;

  function dlog() {
    try { console.log.apply(console, arguments); } catch (_) {}
  }

  function safePostMessage(payload) {
    try {
      window.postMessage(payload, '*');
      dlog('[linksblue-diag] fetch postMessage OK');
    } catch (err) {
      dlog('[linksblue-diag] fetch postMessage threw:', err && err.message ? err.message : String(err));
    }
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
    var topKeys = '';
    try {
      topKeys = parsed && typeof parsed === 'object' ? Object.keys(parsed).join(',') : '(not-object)';
    } catch (_) { topKeys = '(keys-threw)'; }

    if (!keysLogged) {
      keysLogged = true;
      dlog('[linksblue-diag] response top-level keys (first match this page-load):', topKeys);
    } else {
      dlog('[linksblue-diag] response top-level keys (subsequent):', topKeys);
    }

    var hasUuidStr = parsed && typeof parsed.uuid === 'string';
    dlog('[linksblue-diag] parsed.uuid is string?', hasUuidStr,
         '(typeof parsed.uuid =', typeof (parsed && parsed.uuid) + ')');

    if (!hasUuidStr) {
      if (!missingUuidLogged) {
        missingUuidLogged = true;
        try { console.log('[linksblue-chrome-capture] response missing uuid; skipped'); } catch (_) {}
      }
      dlog('[linksblue-diag] DROPPING (uuid guard) — url=', url);
      return;
    }
    dlog('[linksblue-diag] forwarding to content script — url=', url, 'status=', status);
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

      // Log every API-shaped fetch (filters out static asset noise but
      // catches near-matches that might tell us the regex is wrong).
      if (url && url.indexOf('/api/') !== -1) {
        dlog('[linksblue-diag] fetch entered (api): method=', method, 'url=', url,
             'matches CONV_GET_RE?', CONV_GET_RE.test(url));
      }

      var p = origFetch.apply(this, arguments);
      try {
        if (method === 'GET' && CONV_GET_RE.test(url)) {
          dlog('[linksblue-diag] fetch matched URL — awaiting response');
          p.then(function (response) {
            try {
              dlog('[linksblue-diag] fetch response arrived: status=', response.status,
                   'content-type=', response.headers.get('content-type'));
              var clone;
              try { clone = response.clone(); } catch (cloneErr) {
                dlog('[linksblue-diag] fetch response.clone() threw:', cloneErr && cloneErr.message);
                return;
              }
              clone.text().then(function (text) {
                var len = text == null ? 0 : text.length;
                dlog('[linksblue-diag] fetch text length=', len);
                if (len === 0) {
                  dlog('[linksblue-diag] fetch text empty — body may have been pre-consumed by page or stream');
                  return;
                }
                var parsed;
                try { parsed = JSON.parse(text); }
                catch (parseErr) {
                  dlog('[linksblue-diag] fetch JSON.parse failed:', parseErr && parseErr.message,
                       'text starts with:', text.slice(0, 100));
                  return;
                }
                dlog('[linksblue-diag] fetch JSON.parse OK');
                maybeForward(url, response.status, parsed, Date.now());
              }).catch(function (textErr) {
                dlog('[linksblue-diag] fetch clone.text() rejected:', textErr && textErr.message);
              });
            } catch (innerErr) {
              dlog('[linksblue-diag] fetch response handler threw:', innerErr && innerErr.message);
            }
          }).catch(function (fetchErr) {
            dlog('[linksblue-diag] fetch promise rejected:', fetchErr && fetchErr.message);
          });
        }
      } catch (outerErr) {
        dlog('[linksblue-diag] fetch wrapper outer threw:', outerErr && outerErr.message);
      }
      return p;
    };
    dlog('[linksblue-diag] fetch wrapper installed');
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
            if (url && url.indexOf('/api/') !== -1) {
              dlog('[linksblue-diag] xhr load (api): method=', method, 'url=', url,
                   'matches CONV_GET_RE?', CONV_GET_RE.test(url));
            }
            if (method !== 'GET') return;
            if (!CONV_GET_RE.test(url)) return;
            dlog('[linksblue-diag] xhr matched URL — reading response');
            var text = '';
            try {
              text = (xhr.responseType === '' || xhr.responseType === 'text') ? xhr.responseText : '';
            } catch (rtErr) {
              dlog('[linksblue-diag] xhr responseText read threw:', rtErr && rtErr.message);
            }
            dlog('[linksblue-diag] xhr text length=', text ? text.length : 0,
                 'responseType=', xhr.responseType);
            if (!text) return;
            var parsed;
            try { parsed = JSON.parse(text); }
            catch (parseErr) {
              dlog('[linksblue-diag] xhr JSON.parse failed:', parseErr && parseErr.message,
                   'text starts with:', text.slice(0, 100));
              return;
            }
            dlog('[linksblue-diag] xhr JSON.parse OK');
            maybeForward(url, xhr.status, parsed, Date.now());
          } catch (loadErr) {
            dlog('[linksblue-diag] xhr load handler threw:', loadErr && loadErr.message);
          }
        });
      } catch (_) {}
      return origSend.apply(this, arguments);
    };
    dlog('[linksblue-diag] xhr wrapper installed');
  }

  dlog('[linksblue-diag] injected.js init complete; CONV_GET_RE=', CONV_GET_RE.toString());
})();
