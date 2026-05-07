// content-script.js — bridge between the page world (injected.js) and
// the extension service worker (background.js).
//
// !!! DIAGNOSTIC BUILD — Response 05/06/2026-31b !!!
// Extra [linksblue-diag] logs added so we can see whether the page→
// content-script bridge or the content-script→worker bridge is where
// captures get lost. No conversation contents logged. Diagnostic
// removed in v0.2.1.

(function () {
  function dlog() {
    try { console.log.apply(console, arguments); } catch (_) {}
  }

  // ---- 1. inject the page-world wrapper exactly once ----
  try {
    var s = document.createElement('script');
    s.src = chrome.runtime.getURL('injected.js');
    s.async = false;
    s.onload = function () {
      try {
        if (s.parentNode) s.parentNode.removeChild(s);
      } catch (_) {}
    };
    (document.head || document.documentElement).appendChild(s);
    dlog('[linksblue-diag] content-script: injected.js script tag appended');
  } catch (injectErr) {
    dlog('[linksblue-diag] content-script: injection threw:', injectErr && injectErr.message);
  }

  // ---- 2. forward captures from page world to service worker ----
  window.addEventListener('message', function (event) {
    try {
      if (event.source !== window) return;
      var data = event.data;
      if (!data || data.source !== 'linksblue-chrome-capture') return;
      dlog('[linksblue-diag] content-script: received from page; url=', data.url,
           'status=', data.status, 'hasParsed=', !!data.parsedJson);
      try {
        chrome.runtime.sendMessage({
          type: 'captured',
          payload: {
            url: data.url,
            status: data.status,
            parsedJson: data.parsedJson,
            capturedAt: data.capturedAt,
          },
        }, function (resp) {
          if (chrome.runtime.lastError) {
            dlog('[linksblue-diag] content-script: sendMessage lastError:',
                 chrome.runtime.lastError.message);
            return;
          }
          dlog('[linksblue-diag] content-script: worker responded:',
               resp && resp.status ? resp.status : '(no-status)',
               'ok=', resp && resp.ok);
        });
      } catch (sendErr) {
        dlog('[linksblue-diag] content-script: sendMessage threw:',
             sendErr && sendErr.message);
      }
    } catch (msgErr) {
      dlog('[linksblue-diag] content-script: message handler threw:',
           msgErr && msgErr.message);
    }
  }, false);

  // ---- 3. heartbeat ----
  function heartbeat() {
    try {
      chrome.runtime.sendMessage({
        type: 'heartbeat',
        url: location.href,
        capturedAt: Date.now(),
      }, function () { void chrome.runtime.lastError; });
    } catch (_) {}
  }
  heartbeat();
  setInterval(heartbeat, 30 * 1000);

  dlog('[linksblue-diag] content-script: init complete on', location.href);
})();
