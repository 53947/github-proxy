// content-script.js — bridge between the page world (injected.js) and
// the extension service worker (background.js).
//
// Runs in the extension's isolated world on https://claude.ai/*. Three
// jobs and three only:
//
//   1. Inject injected.js into the page's JS context exactly once,
//      then remove the script tag after it loads.
//   2. Listen for window.message events tagged source
//      "linksblue-chrome-capture" and forward them to the service
//      worker as {type: "captured", payload}.
//   3. Heartbeat every 30 seconds so the popup can report which tab
//      is currently attached and how recent the connection is.
//
// Never reads from the DOM. Never modifies the DOM other than the
// one-time injected.js script tag insertion + removal.

(function () {
  // ---- 1. inject the page-world wrapper exactly once ----
  try {
    var s = document.createElement('script');
    s.src = chrome.runtime.getURL('injected.js');
    s.async = false;
    s.onload = function () {
      // Detach the script tag once it has executed.
      try {
        if (s.parentNode) s.parentNode.removeChild(s);
      } catch (_) {}
    };
    (document.head || document.documentElement).appendChild(s);
  } catch (_) {
    // If injection fails the page is unaffected — capture just won't work.
  }

  // ---- 2. forward captures from page world to service worker ----
  window.addEventListener('message', function (event) {
    try {
      if (event.source !== window) return;
      var data = event.data;
      if (!data || data.source !== 'linksblue-chrome-capture') return;
      chrome.runtime.sendMessage({
        type: 'captured',
        payload: {
          url: data.url,
          status: data.status,
          parsedJson: data.parsedJson,
          capturedAt: data.capturedAt,
        },
      }, function () {
        // Swallow chrome.runtime.lastError — service worker may be asleep.
        void chrome.runtime.lastError;
      });
    } catch (_) {}
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
})();
