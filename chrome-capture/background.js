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

        // v0.2.0: compute would-be ingest payload via dedupe path. The
        // POST + snapshot-update steps are wired in commit 5 (POST to
        // ingest + retry queue). For now, prepare and report status —
        // no network egress in this commit yet.
        var prepared = await prepareIngestPayload(p);
        if (!prepared) {
          sendResponse({ ok: true, status: 'nothing-new' });
          return;
        }
        sendResponse({ ok: true, status: 'prepared', count: prepared.payload.new_messages.length });
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

  sendResponse({ ok: false, error: 'unknown message type' });
  return false;
});
