// watchers/cowork.js
//
// Walks ~/Library/Application Support/Claude/local-agent-mode-sessions/.
// Each session is a JSON file. Format may have messages either at the
// top level or nested under a "messages" / "conversation" key — we
// inspect at runtime and adapt.

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions');

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

function findMessageArray(obj) {
  if (Array.isArray(obj)) return obj;
  if (!obj || typeof obj !== 'object') return null;
  for (const key of ['messages', 'conversation', 'turns', 'history', 'events']) {
    if (Array.isArray(obj[key])) return obj[key];
  }
  return null;
}

function extractText(m) {
  if (typeof m.content === 'string') return m.content;
  if (typeof m.text === 'string') return m.text;
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
  if (r === 'assistant' || r === 'agent' || r === 'cowork' || r === 'ai') return 'assistant';
  return null;
}

module.exports = async function coworkWatcher(state, log) {
  const deltas = [];
  if (!fs.existsSync(ROOT)) {
    log.logInfo('cowork watcher: local-agent-mode-sessions/ does not exist, skipping');
    return deltas;
  }

  const files = walk(ROOT);
  for (const filepath of files) {
    try {
      const sourceId = path.basename(filepath, '.json');
      const existing = state.conversations[sourceId];
      if (existing && existing.active === false) continue;

      const raw = fs.readFileSync(filepath, 'utf-8');
      let parsed;
      try { parsed = JSON.parse(raw); } catch (err) {
        log.logError(`cowork watcher: invalid JSON in ${filepath}:`, err.message);
        log.recordParseFailure('cowork-json-invalid', filepath, null);
        continue;
      }

      const arr = findMessageArray(parsed);
      if (!arr) continue;

      const messages = [];
      let firstTimestamp = parsed.started_at || parsed.created_at || null;
      let titleCandidate = parsed.title || parsed.name || null;
      for (const m of arr) {
        const role = normalizeRole(m.role || m.type || m.author);
        if (!role) continue;
        const text = extractText(m);
        if (!text) continue;
        const ts = m.timestamp || m.time || m.created_at || null;
        if (ts && !firstTimestamp) firstTimestamp = ts;
        if (role === 'user' && !titleCandidate) titleCandidate = text.slice(0, 80).replace(/\s+/g, ' ').trim();
        messages.push({ role, content: text, timestamp: ts || undefined });
      }
      if (messages.length === 0) continue;

      const lastIndex = existing?.last_message_index ?? 0;
      if (messages.length <= lastIndex) continue;

      const newMessages = messages.slice(lastIndex);
      deltas.push({
        source_id: sourceId,
        platform: 'cowork',
        title: existing?.title || titleCandidate || `Cowork session ${sourceId.slice(0, 8)}`,
        started_at: existing?.started_at || firstTimestamp || new Date().toISOString(),
        from_index: lastIndex,
        new_messages: newMessages,
      });
    } catch (err) {
      log.logError(`cowork watcher: failed to parse ${filepath}:`, err.message);
      log.recordParseFailure('cowork-json-other', filepath, null);
    }
  }
  return deltas;
};
