// watchers/claude-code.js
//
// Walks ~/.claude/projects/ recursively. Each .jsonl file represents
// one Claude Code session. Filename includes the session UUID.
//
// Captures user/assistant messages only. Skips system/tool-use noise
// (matches the role mapping the ingest endpoint expects).

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(os.homedir(), '.claude', 'projects');

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
        return null;
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return null;
}

function parseFile(filepath) {
  const messages = [];
  let firstTimestamp = null;
  let titleCandidate = null;
  const raw = fs.readFileSync(filepath, 'utf-8');
  const lines = raw.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const role = entry.type || entry.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = extractText(entry.message?.content ?? entry.content);
    if (!text) continue;
    const ts = entry.timestamp || entry.time || entry.created_at || null;
    if (ts && !firstTimestamp) firstTimestamp = ts;
    if (role === 'user' && !titleCandidate) titleCandidate = text.slice(0, 80).replace(/\s+/g, ' ').trim();
    messages.push({
      role,
      content: text,
      timestamp: ts || undefined,
    });
  }
  return { messages, firstTimestamp, titleCandidate };
}

module.exports = async function claudeCodeWatcher(state, log) {
  const deltas = [];
  if (!fs.existsSync(ROOT)) {
    log.logInfo('claude-code watcher: ~/.claude/projects/ does not exist, skipping');
    return deltas;
  }

  const files = walk(ROOT);
  for (const filepath of files) {
    try {
      // Source ID = the filename minus .jsonl (typically the session UUID).
      const sourceId = path.basename(filepath, '.jsonl');
      const existing = state.conversations[sourceId];
      if (existing && existing.active === false) continue;

      const { messages, firstTimestamp, titleCandidate } = parseFile(filepath);
      if (messages.length === 0) continue;

      const lastIndex = existing?.last_message_index ?? 0;
      if (messages.length <= lastIndex) continue; // nothing new

      const newMessages = messages.slice(lastIndex);
      deltas.push({
        source_id: sourceId,
        platform: 'claude_code',
        title: existing?.title || titleCandidate || `Claude Code session ${sourceId.slice(0, 8)}`,
        started_at: existing?.started_at || firstTimestamp || new Date().toISOString(),
        from_index: lastIndex,
        new_messages: newMessages,
      });
    } catch (err) {
      log.logError(`claude-code watcher: failed to parse ${filepath}:`, err.message);
      log.recordParseFailure('claude-code-jsonl', filepath, null);
    }
  }
  return deltas;
};
