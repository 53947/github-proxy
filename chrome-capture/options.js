// options.js — read-only status panel for pass 1.
//
// Pass 2 will add token entry and a save button here. Until then this
// page exists so the structure is in place and Dean can confirm the
// file loads cleanly.

(function () {
  function setText(id, text) {
    var node = document.getElementById(id);
    if (node) node.textContent = text;
  }

  function relativeTime(ts) {
    if (!ts) return 'never';
    var diff = Date.now() - Number(ts);
    if (isNaN(diff)) return 'unknown';
    if (diff < 0) return 'just now';
    var s = Math.floor(diff / 1000);
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    var d = Math.floor(h / 24);
    return d + 'd ago';
  }

  document.addEventListener('DOMContentLoaded', async function () {
    var manifest = chrome.runtime.getManifest();
    setText('ext-version', manifest.version || '(unknown)');
    setText('ext-hosts', (manifest.host_permissions || []).join(', ') || '(none)');

    try {
      var captures = await self.linksblueStorage.get('linksblue.captures');
      var n = Array.isArray(captures) ? captures.length : 0;
      setText('ext-count', String(n) + ' / 200');
    } catch (_) {
      setText('ext-count', '(unavailable)');
    }

    try {
      var hb = await self.linksblueStorage.get('linksblue.lastHeartbeat');
      if (hb && hb.capturedAt) {
        setText('ext-heartbeat', relativeTime(hb.capturedAt) + '   (' + (hb.url || '') + ')');
      } else {
        setText('ext-heartbeat', 'never');
      }
    } catch (_) {
      setText('ext-heartbeat', '(unavailable)');
    }
  });
})();
