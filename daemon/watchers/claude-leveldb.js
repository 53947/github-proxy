// watchers/claude-leveldb.js
//
// Reads ~/Library/Application Support/Claude/IndexedDB/https_claude.ai_0.indexeddb.leveldb/
// READ-ONLY. The leveldb is locked while Claude is running — when
// locked we log INFO ("leveldb locked, will retry next pass") and
// return zero deltas. Next 15-minute pass will retry.
//
// Web AND Desktop Claude conversations both live here. We try to
// distinguish via record metadata; if not distinguishable we default
// to claude_web (the ingest endpoint accepts either).
//
// Format is undocumented. We are defensive: per-key try/catch, save
// raw bytes on parse failure to ~/.linksblue-daemon/parse-failures/,
// continue with the next key. NEVER crash the watcher.

const fs = require('fs');
const path = require('path');
const os = require('os');

const LEVELDB_PATH = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'IndexedDB', 'https_claude.ai_0.indexeddb.leveldb');

let ClassicLevel;
try {
  ({ ClassicLevel } = require('classic-level'));
} catch (err) {
  // module may be missing during dev/test — handled at runtime
  ClassicLevel = null;
}

function tryDecodeUtf8(buf) {
  try { return buf.toString('utf-8'); } catch { return null; }
}

// IndexedDB stores records under keys with binary prefixes. We
// scan all keys and try to find JSON-shaped values that look like
// conversations. This is intentionally fuzzy — Anthropic's schema
// can change without notice.
function looksLikeConversation(obj) {
  if (!obj || typeof obj !== 'object') return false;
  // Heuristics: an array of message-like objects, or a wrapper with such an array.
  if (Array.isArray(obj.messages) && obj.messages.length > 0) return true;
  if (Array.isArray(obj.turns) && obj.turns.length > 0) return true;
  if (Array.isArray(obj) && obj.length > 0 && obj[0] && (obj[0].role || obj[0].sender)) return true;
  return false;
}

function getMessages(obj) {
  if (Array.isArray(obj.messages)) return obj.messages;
  if (Array.isArray(obj.turns)) return obj.turns;
  if (Array.isArray(obj)) return obj;
  return [];
}

function extractText(m) {
  if (typeof m.text === 'string') return m.text;
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map(p => (typeof p === 'string' ? p : (p && typeof p.text === 'string' ? p.text : null)))
      .filter(Boolean)
      .join('\n');
  }
  return null;
}

function normalizeRole(role) {
  if (!role) return null;
  const r = String(role).toLowerCase();
  if (r === 'user' || r === 'human') return 'user';
  if (r === 'assistant' || r === 'ai' || r === 'claude') return 'assistant';
  return null;
}

function detectPlatform(obj) {
  // Best-effort: claude.ai records often have a "settings" or "model"
  // field; desktop records may carry a "client" hint. If we can't
  // tell, default to claude_web (ingest accepts either).
  const blob = JSON.stringify(obj).toLowerCase();
  if (blob.includes('"client":"desktop"') || blob.includes('claude_desktop')) return 'claude_desktop';
  return 'claude_web';
}

module.exports = async function claudeLevelDbWatcher(state, log) {
  const deltas = [];
  if (!fs.existsSync(LEVELDB_PATH)) {
    log.logInfo('claude-leveldb watcher: leveldb path missing, skipping');
    return deltas;
  }
  if (!ClassicLevel) {
    log.logError('claude-leveldb watcher: classic-level module not installed; run npm install in daemon/');
    return deltas;
  }

  let db;
  try {
    db = new ClassicLevel(LEVELDB_PATH, {
      createIfMissing: false,
      errorIfExists: false,
      readOnly: true,
      keyEncoding: 'buffer',
      valueEncoding: 'buffer',
    });
    await db.open({ passive: false });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (msg.includes('LOCK') || msg.includes('lock') || msg.includes('IO error')) {
      log.logInfo('leveldb locked, will retry next pass');
      return deltas;
    }
    log.logError('claude-leveldb watcher: failed to open db:', msg);
    return deltas;
  }

  let parseFailureCount = 0;

  try {
    for await (const [key, value] of db.iterator()) {
      try {
        const decoded = tryDecodeUtf8(value);
        if (!decoded) continue;
        const trimmed = decoded.trim();
        if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue;
        let parsed;
        try { parsed = JSON.parse(trimmed); } catch { continue; }
        if (!looksLikeConversation(parsed)) continue;

        // Attempt to identify a stable source_id from the record.
        const sourceId =
          parsed.uuid ||
          parsed.id ||
          parsed.conversation_id ||
          parsed.thread_id ||
          (key && tryDecodeUtf8(key)?.replace(/[^a-zA-Z0-9.\-_]/g, '_').slice(0, 120)) ||
          null;
        if (!sourceId) continue;

        const existing = state.conversations[sourceId];
        if (existing && existing.active === false) continue;

        const rawMessages = getMessages(parsed);
        const messages = [];
        let firstTimestamp = parsed.created_at || parsed.started_at || null;
        let titleCandidate = parsed.title || parsed.name || null;
        for (const m of rawMessages) {
          const role = normalizeRole(m.role || m.sender || m.type);
          if (!role) continue;
          const text = extractText(m);
          if (!text) continue;
          const ts = m.timestamp || m.created_at || m.time || null;
          if (ts && !firstTimestamp) firstTimestamp = ts;
          if (role === 'user' && !titleCandidate) titleCandidate = text.slice(0, 80).replace(/\s+/g, ' ').trim();
          messages.push({ role, content: text, timestamp: ts || undefined });
        }
        if (messages.length === 0) continue;

        const lastIndex = existing?.last_message_index ?? 0;
        if (messages.length <= lastIndex) continue;

        deltas.push({
          source_id: sourceId,
          platform: detectPlatform(parsed),
          title: existing?.title || titleCandidate || `Claude conversation ${String(sourceId).slice(0, 8)}`,
          started_at: existing?.started_at || firstTimestamp || new Date().toISOString(),
          from_index: lastIndex,
          new_messages: messages.slice(lastIndex),
        });
      } catch (err) {
        parseFailureCount += 1;
        log.recordParseFailure('claude-leveldb-key', key, value);
      }
    }
  } catch (err) {
    log.logError('claude-leveldb iterator failed:', err.message);
  } finally {
    try { await db.close(); } catch (_) {}
  }

  if (parseFailureCount >= 5) {
    log.maybeOpenIssue('leveldb-parse-failures', `Parse failures in this pass: ${parseFailureCount}. Format may have changed. Inspect ~/.linksblue-daemon/parse-failures/.`);
  }

  return deltas;
};
