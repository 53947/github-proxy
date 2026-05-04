// watchers/cowork.js
//
// Walks ~/Library/Application Support/Claude/local-agent-mode-sessions/.
// Cowork is essentially Claude Code running inside a per-session sandbox,
// so the transcripts have the same JSONL format as ~/.claude/projects/.
//
// On-disk layout:
//   local-agent-mode-sessions/
//     <workspace-uuid>/
//       <session-group-uuid>/
//         local_<uuid>/                              <-- one Cowork session
//           .claude/
//             projects/
//               <derived-project-name>/
//                 <session-id>.jsonl                 <-- main transcript
//                 <session-id>/
//                   subagents/agent-<id>.jsonl       <-- subagent (skipped)
//             sessions/, tasks/
//           outputs/, shim-perm/
//
// source_id = the `local_<uuid>` directory name (one Cowork session = one
// archive file). Subagent JSONLs are skipped — only the main transcript is
// captured. If a single local_<uuid> contains multiple main JSONLs (rare
// — e.g. session resumed with a new id), the most-recently-modified file
// wins.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseJsonlFile } = require('../lib/jsonl-parser');

const ROOT = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions');
const LOCAL_UUID_RE = /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Walk recursively and collect every .jsonl whose path matches:
//   <root>/<workspace>/<group>/local_<uuid>/.claude/projects/<project>/<file>.jsonl
// Excludes anything deeper (subagents, nested session dirs).
function findMainSessionJsonls(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;

  function recurse(dir, ancestors) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        recurse(full, [...ancestors, entry.name]);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const localIdx = ancestors.findIndex(a => LOCAL_UUID_RE.test(a));
        if (localIdx === -1) continue;
        // After local_<uuid> the file must be exactly at .claude/projects/<project>/<file>.jsonl
        const after = ancestors.slice(localIdx + 1);
        if (after.length !== 3) continue;
        if (after[0] !== '.claude' || after[1] !== 'projects') continue;
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(full).mtimeMs; } catch {}
        out.push({ sourceId: ancestors[localIdx], filepath: full, mtimeMs });
      }
    }
  }

  recurse(root, []);
  return out;
}

module.exports = async function coworkWatcher(state, log) {
  const deltas = [];
  if (!fs.existsSync(ROOT)) {
    log.logInfo('cowork watcher: local-agent-mode-sessions/ does not exist, skipping');
    return deltas;
  }

  const found = findMainSessionJsonls(ROOT);

  // One Cowork session = one source_id. If multiple main JSONLs map to the
  // same local_<uuid>, take the most recently modified.
  const bySourceId = new Map();
  for (const item of found) {
    const cur = bySourceId.get(item.sourceId);
    if (!cur || item.mtimeMs > cur.mtimeMs) bySourceId.set(item.sourceId, item);
  }

  for (const { sourceId, filepath } of bySourceId.values()) {
    try {
      const existing = state.conversations[sourceId];
      if (existing && existing.active === false) continue;

      const { messages, firstTimestamp, titleCandidate } = parseJsonlFile(filepath);
      if (messages.length === 0) continue;

      const lastIndex = existing?.last_message_index ?? 0;
      if (messages.length <= lastIndex) continue;

      const newMessages = messages.slice(lastIndex);
      deltas.push({
        source_id: sourceId,
        platform: 'cowork',
        title: existing?.title || titleCandidate || `Cowork session ${sourceId.slice(6, 14)}`,
        started_at: existing?.started_at || firstTimestamp || new Date().toISOString(),
        from_index: lastIndex,
        new_messages: newMessages,
      });
    } catch (err) {
      log.logError(`cowork watcher: failed to parse ${filepath}:`, err.message);
      log.recordParseFailure('cowork-jsonl', filepath, null);
    }
  }
  return deltas;
};
