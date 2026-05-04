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
    if (role === 'user' && !titleCandidate) titleCandidate = text.slice(0, 80).replace(/\s+/g, ' ').trim();
    messages.push({
      role,
      content: text,
      timestamp: ts || undefined,
    });
  }
  return { messages, firstTimestamp, titleCandidate };
}

module.exports = { parseJsonlFile, extractText };
