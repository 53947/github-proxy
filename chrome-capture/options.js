// options.js — token entry + read-only status panel.

(function () {
  var INGEST_URL = 'https://github.linksblue.network/api/archive/ingest';

  function setText(id, text, cls) {
    var node = document.getElementById(id);
    if (!node) return;
    node.textContent = text;
    if (cls !== undefined) node.className = cls;
  }

  function maskToken(t) {
    if (!t) return '(none)';
    if (t.length <= 8) return '*'.repeat(Math.max(t.length, 1));
    return t.slice(0, 8) + '...';
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

  function showFeedback(msg, kind) {
    var node = document.getElementById('token-feedback');
    if (!node) return;
    node.textContent = msg || '';
    node.className = msg ? ('feedback ' + (kind || 'ok')) : 'feedback';
  }

  async function refreshTokenDisplay() {
    var token = await self.linksblueStorage.getToken();
    setText('token-current', maskToken(token));
  }

  async function refreshStats() {
    try {
      var manifest = chrome.runtime.getManifest();
      setText('ext-version', manifest.version || '(unknown)');
      setText('ext-hosts', (manifest.host_permissions || []).join(', ') || '(none)');
    } catch (_) {
      setText('ext-version', '(unavailable)');
      setText('ext-hosts', '(unavailable)');
    }
    try {
      var captures = await self.linksblueStorage.get('linksblue.captures');
      var n = Array.isArray(captures) ? captures.length : 0;
      setText('ext-count', String(n));
    } catch (_) { setText('ext-count', '(unavailable)'); }
    try {
      var hb = await self.linksblueStorage.get('linksblue.lastHeartbeat');
      if (hb && hb.capturedAt) {
        setText('ext-heartbeat', relativeTime(hb.capturedAt) + '   (' + (hb.url || '') + ')');
      } else {
        setText('ext-heartbeat', 'never');
      }
    } catch (_) { setText('ext-heartbeat', '(unavailable)'); }
    try {
      var stats = (await self.linksblueStorage.get('linksblue.post-stats')) || {};
      setText('ext-posted', String(Number(stats.posted_total) || 0));
      setText('ext-lastpost', stats.last_post_at ? relativeTime(stats.last_post_at) : 'never');
    } catch (_) {
      setText('ext-posted', '(unavailable)');
      setText('ext-lastpost', '(unavailable)');
    }
    try {
      var queue = await self.linksblueStorage.get('linksblue.retry-queue');
      var qd = Array.isArray(queue) ? queue.length : 0;
      setText('ext-retry', String(qd) + ' / 20');
    } catch (_) { setText('ext-retry', '(unavailable)'); }
  }

  async function handleSave(event) {
    event.preventDefault();
    var input = document.getElementById('token-input');
    var value = input.value.trim();
    if (!value) {
      showFeedback('Token cannot be empty.', 'warn');
      return;
    }
    try {
      await self.linksblueStorage.setToken(value);
      input.value = '';
      showFeedback('Saved.', 'ok');
      await refreshTokenDisplay();
      setTimeout(function () { showFeedback(''); }, 2000);
    } catch (err) {
      showFeedback('Save failed: ' + (err && err.message ? err.message : 'unknown'), 'error');
    }
  }

  async function handleClear() {
    var confirmed = window.confirm('Clear the saved token? Captures will continue to buffer locally but will not be POSTed until a new token is saved.');
    if (!confirmed) return;
    try {
      await self.linksblueStorage.clearToken();
      showFeedback('Cleared.', 'warn');
      await refreshTokenDisplay();
      setTimeout(function () { showFeedback(''); }, 2000);
    } catch (err) {
      showFeedback('Clear failed: ' + (err && err.message ? err.message : 'unknown'), 'error');
    }
  }

  async function handleTest() {
    var token = await self.linksblueStorage.getToken();
    if (!token) {
      showFeedback('No token saved. Save one first.', 'warn');
      return;
    }
    showFeedback('Testing...', 'ok');
    try {
      var res = await fetch(INGEST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ test: true }),
      });
      var bodyText = '';
      try { bodyText = (await res.text()).slice(0, 100); } catch (_) {}
      if (res.status === 401) {
        showFeedback('Invalid token (401). Check the value and re-save.', 'error');
        return;
      }
      if (res.status >= 200 && res.status < 300) {
        showFeedback('Token OK (' + res.status + ').', 'ok');
        return;
      }
      if (res.status >= 400 && res.status < 500) {
        showFeedback(
          'Token OK (auth passed; status ' + res.status +
          ', payload rejected as expected for test ping). body: ' + bodyText,
          'ok'
        );
        return;
      }
      showFeedback('Endpoint error: status ' + res.status + ' — ' + bodyText, 'error');
    } catch (err) {
      showFeedback('Network error: ' + (err && err.message ? err.message : 'unknown'), 'error');
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    refreshTokenDisplay();
    refreshStats();

    var form = document.getElementById('token-form');
    if (form) form.addEventListener('submit', handleSave);

    var clearBtn = document.getElementById('clear-btn');
    if (clearBtn) clearBtn.addEventListener('click', handleClear);

    var testBtn = document.getElementById('test-btn');
    if (testBtn) testBtn.addEventListener('click', handleTest);
  });
})();
