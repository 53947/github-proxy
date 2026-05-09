// lib/jsonl-parser.js
//
// Shared JSONL transcript parser. Used by:
//   - watchers/claude-code.js  (~/.claude/projects/**/*.jsonl)
//   - watchers/cowork.js       (Cowork sandbox transcripts have the same format)
//
// One JSON object per line. Captures user/assistant text turns; skips
// system messages, tool-use, and any line that fails to parse.

const fs = require('fs');

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

function parseJsonlFile(filepath) {
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

    // Title-selection: skip lines marked `isMeta: true` by Claude Code's CLI
    // when picking a session title.
    //
    // (a) Claude Code emits an `isMeta: true` flag on JSONL entries it
    //     injects itself — `<local-command-caveat>...`,
    //     `<command-name>/exit</...>`, and similar harness wrappers around
    //     slash commands.
    // (b) These lines have role: "user" but their content is byte-for-byte
    //     identical across every session. If we use their first 80 chars as
    //     the title, every /exit-only Claude Code session lands at the same
    //     archive path and all but the first 409 with "path collision".
    //     Surfaced by Prompt 05/07/2026-37; structural fix here. The
    //     endpoint-side path-discriminator follow-up is Prompt 05/09/2026-39.
    // (c) `isMeta` is observed empirically in Claude Code transcripts as of
    //     2026-05-09 but is not formally documented by Anthropic. If the
    //     flag is renamed or removed in a future Claude Code release, the
    //     boilerplate collisions will silently return — check this branch
    //     first when debugging title regressions.
    // (d) Meta lines remain in `messages[]` below. They are excluded only
    //     from title selection, not from the captured transcript.
    if (role === 'user' && !titleCandidate && entry.isMeta !== true) titleCandidate = text.slice(0, 80).replace(/\s+/g, ' ').trim();
    messages.push({
      role,
      content: text,
      timestamp: ts || undefined,
    });
  }
  return { messages, firstTimestamp, titleCandidate };
}

module.exports = { parseJsonlFile, extractText };
