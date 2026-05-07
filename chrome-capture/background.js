// background.js — extension service worker.
//
// Message-driven only. No network egress in pass 1: no fetch, no POST,
// no anything outside this browser. Pass 2 will add the ingest POST
// path; until then this file is read-only with respect to the network.
//
// Holds the capture log (chrome.storage.local under 'linksblue.captures',
// capped at 200 entries) and answers four message types from content
// scripts and the popup:
//
//   type: 'captured'  — append a payload from injected.js (via the
//                       content script). Each entry is enriched with
//                       a 12-char sha-256(url + ':' + capturedAt) idHash
//                       used as the popup's row key.
//   type: 'heartbeat' — refresh the popup-status snapshot (tab url +
//                       last-seen-at).
//   type: 'clear-log' — empty the buffer (popup button).
//   type: 'get-log'   — return the buffer + last heartbeat (popup load).

importScripts('lib/storage.js', 'lib/log-buffer.js', 'lib/transformer.js');

const HEARTBEAT_KEY = 'linksblue.lastHeartbeat';
const INGEST_URL = 'https://github.linksblue.network/api/archive/ingest';
const RETRY_QUEUE_KEY = 'linksblue.retry-queue';
const RETRY_QUEUE_CAP = 20;
const MAX_RETRY_ATTEMPTS = 3;
const POST_STATS_KEY = 'linksblue.post-stats';
const ALARM_NAME = 'linksblue-snapshot-tick';

// v0.2.0 — flush-only scheduler. The alarm fires every 15 minutes
// (matching the daemon cadence) and re-attempts queued retries. It
// does NOT force fresh captures — captures collect opportunistically
// from the user's normal claude.ai activity. If nothing's queued, the
// alarm fires and finds nothing to do. That's correct behavior.
function ensureAlarm() {
  try {
    chrome.alarms.create(ALARM_NAME, {
      periodInMinutes: 15,
      delayInMinutes: 1,
    });
  } catch (_) {}
}

// v0.2.0: POST a Mode B payload to the ingest endpoint with bearer
// auth. Throws on non-2xx (caller decides to enqueue or drop).
async function postToIngest(payload, token) {
  var response = await fetch(INGEST_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    var errorText = '';
    try { errorText = await response.text(); } catch (_) {}
    var err = new Error('ingest POST failed: ' + response.status + ' ' + errorText.slice(0, 200));
    err.status = response.status;
    throw err;
  }
  return response.json();
}

async function getRetryQueue() {
  var q = await self.linksblueStorage.get(RETRY_QUEUE_KEY);
  return Array.isArray(q) ? q : [];
}

async function enqueueRetry(payload, error) {
  var q = await getRetryQueue();
  q.push({
    payload: payload,
    attempts: 1,
    queued_at: Date.now(),
    last_error: (error && error.message) ? String(error.message).slice(0, 200) : 'unknown',
  });
  // Cap: drop oldest entries when over.
  while (q.length > RETRY_QUEUE_CAP) q.shift();
  await self.linksblueStorage.set(RETRY_QUEUE_KEY, q);
}

async function flushRetryQueue() {
  var token = await self.linksblueStorage.getToken();
  if (!token) return { attempted: 0, sent: 0, requeued: 0, dropped: 0 };
  var q = await getRetryQueue();
  if (q.length === 0) return { attempted: 0, sent: 0, requeued: 0, dropped: 0 };

  var remaining = [];
  var sent = 0, dropped = 0;
  for (var i = 0; i < q.length; i++) {
    var item = q[i];
    try {
      await postToIngest(item.payload, token);
      sent += 1;
      await bumpPostStats();
      // Snapshot wasn't carried with the queued payload (we only kept
      // the wire-shape body), so we don't update lastSnapshot here.
      // The next live capture's getLastSnapshot will reflect whatever
      // is currently stored; the server's Mode B handler tolerates
      // from_index < message_count by slicing the overlap. One-time
      // duplicate range across a recovered retry is acceptable.
    } catch (err) {
      var attempts = (item.attempts || 0) + 1;
      var nextItem = {
        payload: item.payload,
        attempts: attempts,
        queued_at: item.queued_at,
        last_error: (err && err.message) ? String(err.message).slice(0, 200) : 'unknown',
      };
      if (attempts < MAX_RETRY_ATTEMPTS) {
        remaining.push(nextItem);
      } else {
        dropped += 1;
        try { console.warn('[linksblue-chrome-capture] dropping payload after ' + attempts + ' attempts: ' + (nextItem.last_error || '')); } catch (_) {}
      }
    }
  }
  await self.linksblueStorage.set(RETRY_QUEUE_KEY, remaining);
  return { attempted: q.length, sent: sent, requeued: remaining.length, dropped: dropped };
}

async function bumpPostStats() {
  var cur = (await self.linksblueStorage.get(POST_STATS_KEY)) || {};
  cur.posted_total = (Number(cur.posted_total) || 0) + 1;
  cur.last_post_at = Date.now();
  await self.linksblueStorage.set(POST_STATS_KEY, cur);
}

// v0.2.0: prepare an ingest payload from a captured chat_conversations
// response. Returns:
//   - null if the parse can't yield a conversation, or
//   - null if message_count <= last-snapshot.message_count (nothing new),
//   - { payload, snapshot } otherwise — payload matches Mode B contract
//     in routes/archive-ingest.js; snapshot is what to store after the
//     POST succeeds (commit 5 wires that step in).
async function prepareIngestPayload(captured) {
  if (!captured || !captured.parsedJson) return null;
  var c = self.linksblueTransformer.transformConversation(captured.parsedJson);
  if (!c) return null;

  var lastSnapshot = await self.linksblueStorage.getLastSnapshot(c.source_id);
  var fromIndex = (lastSnapshot && Number.isInteger(lastSnapshot.message_count))
    ? lastSnapshot.message_count
    : 0;

  if (c.all_messages.length <= fromIndex) return null;

  var newMessages = c.all_messages.slice(fromIndex);
  var lastMsg = c.all_messages[c.all_messages.length - 1];

  return {
    payload: {
      platform: c.platform,
      title: c.title,
      started_at: c.started_at,
      last_updated: c.last_updated,
      source_id: c.source_id,
      from_index: fromIndex,
      new_messages: newMessages,
    },
    snapshot: {
      message_count: c.all_messages.length,
      last_capture_at: captured.capturedAt || Date.now(),
      last_message_uuid: lastMsg ? (lastMsg.message_id || null) : null,
    },
  };
}

async function sha256Truncate12(text) {
  var buf = new TextEncoder().encode(String(text));
  var hash = await crypto.subtle.digest('SHA-256', buf);
  var bytes = new Uint8Array(hash);
  var hex = '';
  for (var i = 0; i < 6; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

chrome.runtime.onInstalled.addListener(async function () {
  try {
    var existing = await self.linksblueStorage.get('linksblue.captures');
    if (!Array.isArray(existing)) {
      await self.linksblueStorage.set('linksblue.captures', []);
    }
  } catch (_) {}
  ensureAlarm();
});

chrome.runtime.onStartup.addListener(function () {
  ensureAlarm();
});

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (!alarm || alarm.name !== ALARM_NAME) return;
  (async function () {
    try {
      var result = await flushRetryQueue();
      if (result && result.attempted > 0) {
        try { console.log('[linksblue-chrome-capture] alarm flush:', JSON.stringify(result)); } catch (_) {}
      }
    } catch (err) {
      try { console.warn('[linksblue-chrome-capture] alarm flush error:', err && err.message); } catch (_) {}
    }
  })();
});

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || typeof message !== 'object') {
    sendResponse({ ok: false, error: 'invalid message' });
    return false;
  }

  if (message.type === 'captured') {
    (async function () {
      try {
        var p = message.payload || {};
        var idHash = await sha256Truncate12(String(p.url || '') + ':' + String(p.capturedAt || ''));
        await self.linksblueLogBuffer.appendCapture({
          url: p.url,
          status: p.status,
          parsedJson: p.parsedJson,
          capturedAt: p.capturedAt,
          idHash: idHash,
        });

        // v0.2.0: compute ingest payload via dedupe path, then POST.
        var prepared = await prepareIngestPayload(p);
        if (!prepared) {
          sendResponse({ ok: true, status: 'nothing-new' });
          return;
        }
        var token = await self.linksblueStorage.getToken();
        if (!token) {
          sendResponse({ ok: true, status: 'no-token', count: prepared.payload.new_messages.length });
          return;
        }
        try {
          await postToIngest(prepared.payload, token);
          await self.linksblueStorage.setLastSnapshot(prepared.payload.source_id, prepared.snapshot);
          await bumpPostStats();
          sendResponse({ ok: true, status: 'posted', count: prepared.payload.new_messages.length });
        } catch (postErr) {
          await enqueueRetry(prepared.payload, postErr);
          sendResponse({ ok: true, status: 'queued', count: prepared.payload.new_messages.length, error: postErr && postErr.message });
        }
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message });
      }
    })();
    return true; // async sendResponse
  }

  if (message.type === 'heartbeat') {
    (async function () {
      try {
        await self.linksblueStorage.set(HEARTBEAT_KEY, {
          url: message.url,
          capturedAt: message.capturedAt,
        });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message });
      }
    })();
    return true;
  }

  if (message.type === 'clear-log') {
    (async function () {
      try {
        await self.linksblueLogBuffer.clearCaptures();
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message });
      }
    })();
    return true;
  }

  if (message.type === 'get-log') {
    (async function () {
      try {
        var arr = await self.linksblueLogBuffer.getCaptures();
        var hb = await self.linksblueStorage.get(HEARTBEAT_KEY);
        sendResponse({ ok: true, captures: arr, heartbeat: hb || null });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message });
      }
    })();
    return true;
  }

  if (message.type === 'get-stats') {
    (async function () {
      try {
        var stats = (await self.linksblueStorage.get(POST_STATS_KEY)) || {};
        var queue = await getRetryQueue();
        var token = await self.linksblueStorage.getToken();
        sendResponse({
          ok: true,
          token_configured: !!token,
          posted_total: Number(stats.posted_total) || 0,
          last_post_at: stats.last_post_at || null,
          retry_queue_depth: queue.length,
        });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message });
      }
    })();
    return true;
  }

  sendResponse({ ok: false, error: 'unknown message type' });
  return false;
});
