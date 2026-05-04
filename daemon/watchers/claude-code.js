// watchers/claude-code.js
//
// Walks ~/.claude/projects/ recursively. Each .jsonl file represents
// one Claude Code session. Filename includes the session UUID.
//
// Captures user/assistant messages only. Skips system/tool-use noise
// (matches the role mapping the ingest endpoint expects).
//
// Note: Cowork sandbox transcripts use the same JSONL format but live
// under ~/Library/Application Support/Claude/local-agent-mode-sessions/.
// They are NOT under ~/.claude/projects/ and are handled by cowork.js
// — disjoint roots, no double-capture risk.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseJsonlFile } = require('../lib/jsonl-parser');

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

      const { messages, firstTimestamp, titleCandidate } = parseJsonlFile(filepath);
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
