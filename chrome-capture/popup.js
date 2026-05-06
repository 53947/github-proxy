// popup.js — debug inspector for the capture buffer.
//
// Loads on popup open. Asks the service worker for {captures, heartbeat}
// and renders. Click a row to expand its raw parsedJson. Buttons:
// Copy all, Clear, Open options. No frameworks, vanilla DOM only.

(function () {
  var HEARTBEAT_FRESH_MS = 60 * 1000;

  function relativeTime(ts) {
    if (!ts) return 'unknown';
    var diff = Date.now() - Number(ts);
    if (isNaN(diff)) return 'unknown';
    if (diff < 0) return 'just now';
    if (diff < 1000) return 'just now';
    var s = Math.floor(diff / 1000);
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    var d = Math.floor(h / 24);
    return d + 'd ago';
  }

  function pathnameOnly(url) {
    try {
      var u = new URL(url);
      return u.pathname + (u.search || '');
    } catch (_) {
      return String(url || '');
    }
  }

  function statusClass(status) {
    var n = Number(status);
    if (!n) return '';
    if (n >= 500) return 's5xx';
    if (n >= 400) return 's4xx';
    if (n >= 300) return 's3xx';
    return 's2xx';
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (k === 'className') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else node.setAttribute(k, attrs[k]);
      }
    }
    if (children) {
      for (var i = 0; i < children.length; i++) {
        if (children[i]) node.appendChild(children[i]);
      }
    }
    return node;
  }

  function renderStatus(heartbeat) {
    var row = document.getElementById('status-row');
    var fresh = heartbeat && heartbeat.capturedAt && (Date.now() - Number(heartbeat.capturedAt)) < HEARTBEAT_FRESH_MS;
    if (fresh) {
      row.className = 'status-row attached';
      row.textContent = 'Attached to claude.ai tab: yes. Last heartbeat ' + relativeTime(heartbeat.capturedAt) + '.';
    } else if (heartbeat && heartbeat.capturedAt) {
      row.className = 'status-row detached';
      row.textContent = 'No claude.ai tab detected (last heartbeat ' + relativeTime(heartbeat.capturedAt) + '). Open one and reopen this popup.';
    } else {
      row.className = 'status-row detached';
      row.textContent = 'No claude.ai tab detected — open one and reopen this popup.';
    }
  }

  function renderCount(captures) {
    var row = document.getElementById('count-row');
    var n = captures ? captures.length : 0;
    row.textContent = n + ' capture' + (n === 1 ? '' : 's') + ' buffered (cap 200).';
  }

  function renderList(captures) {
    var list = document.getElementById('capture-list');
    var empty = document.getElementById('empty-state');
    list.textContent = '';
    if (!captures || captures.length === 0) {
      empty.className = 'empty-state visible';
      return;
    }
    empty.className = 'empty-state';

    // Newest first.
    var rows = captures.slice().reverse();
    for (var i = 0; i < rows.length; i++) {
      var c = rows[i];
      var summary = el('div', { className: 'capture-summary' }, [
        el('span', { className: 'capture-time', text: relativeTime(c.capturedAt) }),
        el('span', { className: 'capture-status ' + statusClass(c.status), text: String(c.status || '?') }),
        el('span', { className: 'capture-path', title: c.url || '', text: pathnameOnly(c.url) }),
      ]);

      var pre = el('pre', { text: safeStringify(c.parsedJson) });
      var detail = el('div', { className: 'capture-detail' }, [
        el('div', { className: 'meta', text: (c.url || '') + '   id=' + (c.idHash || '') }),
        pre,
      ]);

      var row = el('li', { className: 'capture-row' }, [summary, detail]);
      summary.addEventListener('click', (function (rowEl) {
        return function () {
          if (rowEl.className.indexOf('expanded') >= 0) {
            rowEl.className = 'capture-row';
          } else {
            rowEl.className = 'capture-row expanded';
          }
        };
      })(row));

      list.appendChild(row);
    }
  }

  function safeStringify(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch (_) {
      return String(value);
    }
  }

  function showFeedback(text) {
    var fb = document.getElementById('action-feedback');
    fb.textContent = text;
    setTimeout(function () { fb.textContent = ''; }, 2500);
  }

  function loadAndRender() {
    chrome.runtime.sendMessage({ type: 'get-log' }, function (resp) {
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        renderStatus(null);
        renderCount([]);
        renderList([]);
        return;
      }
      renderStatus(resp.heartbeat);
      renderCount(resp.captures);
      renderList(resp.captures);
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    loadAndRender();

    document.getElementById('copy-all').addEventListener('click', function () {
      chrome.runtime.sendMessage({ type: 'get-log' }, function (resp) {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          showFeedback('Could not read log.');
          return;
        }
        var text = safeStringify(resp.captures || []);
        navigator.clipboard.writeText(text).then(function () {
          showFeedback('Copied ' + (resp.captures || []).length + ' capture(s).');
        }, function () {
          showFeedback('Clipboard write failed.');
        });
      });
    });

    document.getElementById('clear').addEventListener('click', function () {
      chrome.runtime.sendMessage({ type: 'clear-log' }, function (resp) {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          showFeedback('Clear failed.');
          return;
        }
        showFeedback('Cleared.');
        loadAndRender();
      });
    });

    document.getElementById('open-options').addEventListener('click', function () {
      try { chrome.runtime.openOptionsPage(); } catch (_) {}
    });
  });
})();
