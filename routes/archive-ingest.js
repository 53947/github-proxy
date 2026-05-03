// routes/archive-ingest.js
//
// POST /api/archive/ingest — receives AI conversation captures and commits
// them to TRIADBLUE/ai-archive as markdown files with YAML frontmatter.
//
// Two modes:
//
//   MODE A — legacy single-conversation capture. One POST = one whole
//            conversation. Field signature: { messages, ended_at }.
//
//   MODE B — snapshot/append. One POST per snapshot of a still-evolving
//            conversation; subsequent snapshots with the same source_id
//            append new messages instead of dedup-and-skip.
//            Field signature: { new_messages, from_index, last_updated }.
//
// Mounted in index.js via:
//   app.use('/api/archive', require('./routes/archive-ingest'));

const express = require('express');
const router = express.Router();

const GITHUB_API = 'https://api.github.com';
const ARCHIVE_OWNER = 'TRIADBLUE';
const ARCHIVE_REPO  = 'ai-archive';
const VALID_PLATFORMS = ['claude_code', 'claude_web', 'claude_desktop', 'cowork'];

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------

function ghHeaders() {
  const h = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'linksblue-archive-ingest/1.0',
  };
  if (process.env.GITHUB_TOKEN) {
    h['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return h;
}

async function ghPut(path, body) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method: 'PUT',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`GitHub PUT ${path} ${res.status}: ${text}`);
    err.statusCode = res.status;
    err.body = text;
    throw err;
  }
  return res.json();
}

async function ghGetFile(path) {
  const res = await fetch(`${GITHUB_API}${path}`, { headers: ghHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub GET ${path} ${res.status}: ${text}`);
  }
  const data = await res.json();
  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  return { content, sha: data.sha };
}

async function ghSearchSourceId(sourceId) {
  // GitHub code search across the private archive repo. Index can lag a few
  // seconds — Mode A has a 422 fallback (path-existence + frontmatter
  // source_id compare) for that race. Mode B reads the existing file via
  // Contents API directly, which is immediately consistent.
  const q = `"source_id: ${sourceId}" repo:${ARCHIVE_OWNER}/${ARCHIVE_REPO}`;
  const url = `${GITHUB_API}/search/code?q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) {
    console.warn(`[archive-ingest] dedupe search ${res.status}: ${await res.text()}`);
    return null;
  }
  const data = await res.json();
  if (Array.isArray(data.items) && data.items.length > 0) {
    return data.items[0].path;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Slug, path, frontmatter, body helpers
// ---------------------------------------------------------------------------

function slugify(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
}

function pathFor({ startedAt, platform, slug }) {
  const d = new Date(startedAt);
  const yyyy = String(d.getUTCFullYear());
  const mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd   = String(d.getUTCDate()).padStart(2, '0');
  return {
    full: `${yyyy}/${mm}/${dd}-${platform}-${slug}.md`,
    date: `${yyyy}-${mm}-${dd}`,
  };
}

function yamlEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildFrontmatter({ date, platform, title, started_at, last_updated, message_count, snapshot_count, source_id }) {
  return [
    '---',
    `date: ${date}`,
    `platform: ${platform}`,
    `title: "${yamlEscape(title)}"`,
    `started_at: ${started_at}`,
    `last_updated: ${last_updated}`,
    `message_count: ${message_count}`,
    `snapshot_count: ${snapshot_count}`,
    `source_id: ${source_id}`,
    'topics: []',
    '---',
    '',
  ].join('\n');
}

function buildBody(messages) {
  return messages.map(m => {
    const role = m && m.role ? String(m.role) : 'unknown';
    const ts   = m && m.timestamp ? ` _(${m.timestamp})_` : '';
    const body = m && m.content != null ? String(m.content) : '';
    return `## ${role}${ts}\n\n${body}\n`;
  }).join('\n');
}

function frontmatterSourceId(markdown) {
  const m = markdown.match(/^source_id:\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

// Parse the YAML frontmatter at the top of a markdown file. Returns
// { fm: <key/value object>, fmEndIdx: <line index of closing ---> } or null
// if the file has no '---' delimiter pair at the top.
//
// Deliberately limited to the format buildFrontmatter() produces: simple
// `key: value` lines, optional double-quoted string scalars. No YAML library.
function parseFrontmatter(markdown) {
  const lines = markdown.split('\n');
  if (lines[0] !== '---') return null;
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { endIdx = i; break; }
  }
  if (endIdx === -1) return null;
  const fm = {};
  for (let i = 1; i < endIdx; i++) {
    const line = lines[i];
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) {
      v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    fm[m[1]] = v;
  }
  return { fm, fmEndIdx: endIdx };
}

// Extract the body content (everything after the closing '---' of the
// frontmatter). Returns the full markdown if no frontmatter is present.
function parseExistingBody(markdown) {
  const parsed = parseFrontmatter(markdown);
  if (!parsed) return markdown;
  const lines = markdown.split('\n');
  return lines.slice(parsed.fmEndIdx + 1).join('\n');
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

// SINGLE-USER AUTH — multi-user plug point goes here
function requireBearer(req, res, next) {
  const expected = process.env.ARCHIVE_API_KEY;
  const got = req.headers.authorization || '';
  if (!expected || got !== `Bearer ${expected}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Mode detection + body validation
// ---------------------------------------------------------------------------

function modeOf(body) {
  if (!body || typeof body !== 'object') return 'invalid';
  const hasA = ('messages' in body) && ('ended_at' in body);
  const hasB = ('new_messages' in body) && ('from_index' in body);
  if (hasA && hasB) return 'invalid'; // ambiguous
  if (hasA) return 'A';
  if (hasB) return 'B';
  return 'invalid';
}

function validateCommon(body) {
  if (!body || typeof body !== 'object') return 'request body must be a JSON object';
  const { platform, title, started_at, source_id } = body;
  if (!VALID_PLATFORMS.includes(platform)) return `platform must be one of: ${VALID_PLATFORMS.join(', ')}`;
  if (typeof title !== 'string' || !title.trim()) return 'title must be a non-empty string';
  if (typeof started_at !== 'string' || isNaN(Date.parse(started_at))) return 'started_at must be an ISO 8601 string';
  if (typeof source_id !== 'string' || !source_id.trim()) return 'source_id must be a non-empty string';
  return null;
}

function validateModeA(body) {
  const c = validateCommon(body); if (c) return c;
  const { ended_at, messages } = body;
  if (typeof ended_at !== 'string' || isNaN(Date.parse(ended_at))) return 'ended_at must be an ISO 8601 string (Mode A)';
  if (!Array.isArray(messages)) return 'messages must be an array (Mode A)';
  return null;
}

function validateModeB(body) {
  const c = validateCommon(body); if (c) return c;
  const { last_updated, new_messages, from_index } = body;
  if (typeof last_updated !== 'string' || isNaN(Date.parse(last_updated))) return 'last_updated must be an ISO 8601 string (Mode B)';
  if (!Array.isArray(new_messages)) return 'new_messages must be an array (Mode B)';
  if (!Number.isInteger(from_index) || from_index < 0) return 'from_index must be a non-negative integer (Mode B)';
  return null;
}

// ---------------------------------------------------------------------------
// Mode A handler — legacy single-shot capture
// ---------------------------------------------------------------------------

async function handleModeA(req, res) {
  const validationError = validateModeA(req.body);
  if (validationError) return res.status(400).json({ error: validationError });

  const { platform, title, started_at, ended_at, messages, source_id } = req.body;

  // Dedupe by source_id via search index
  const existingPath = await ghSearchSourceId(source_id);
  if (existingPath) {
    return res.status(200).json({ status: 'duplicate', path: existingPath });
  }

  const slug = slugify(title);
  const p    = pathFor({ startedAt: started_at, platform, slug });
  const fm   = buildFrontmatter({
    date: p.date,
    platform,
    title,
    started_at,
    last_updated: ended_at,
    message_count: messages.length,
    snapshot_count: 1,
    source_id,
  });
  const markdown = fm + buildBody(messages);

  const archiveApiPath = `/repos/${ARCHIVE_OWNER}/${ARCHIVE_REPO}/contents/${p.full}`;
  try {
    await ghPut(archiveApiPath, {
      message: `archive: ${platform}/${slug} (${source_id})`,
      content: Buffer.from(markdown, 'utf-8').toString('base64'),
    });
    return res.status(200).json({ status: 'created', path: p.full });
  } catch (putErr) {
    if (putErr.statusCode !== 422) throw putErr;
    // Path exists. Search index lagged on the dedupe lookup OR a different
    // conversation slugified to the same path. Verify by reading the file.
    const existing = await ghGetFile(archiveApiPath);
    if (existing && frontmatterSourceId(existing.content) === source_id) {
      return res.status(200).json({ status: 'duplicate', path: p.full });
    }
    return res.status(409).json({
      error: 'path collision: a different conversation already occupies this path',
      path: p.full,
      hint: 'two distinct source_ids slugified to the same path; rename or add a discriminator to the conversation title',
    });
  }
}

// ---------------------------------------------------------------------------
// Mode B handler — snapshot/append
// ---------------------------------------------------------------------------

async function handleModeB(req, res) {
  const validationError = validateModeB(req.body);
  if (validationError) return res.status(400).json({ error: validationError });

  const { platform, title, started_at, last_updated, new_messages, from_index, source_id } = req.body;

  // Search for an existing file with this source_id
  const existingPath = await ghSearchSourceId(source_id);

  // ----- First snapshot: file does not exist yet -----
  if (!existingPath) {
    const slug = slugify(title);
    const p = pathFor({ startedAt: started_at, platform, slug });
    const fm = buildFrontmatter({
      date: p.date,
      platform,
      title,
      started_at,
      last_updated,
      message_count: new_messages.length,
      snapshot_count: 1,
      source_id,
    });
    const markdown = fm + buildBody(new_messages);
    const archiveApiPath = `/repos/${ARCHIVE_OWNER}/${ARCHIVE_REPO}/contents/${p.full}`;
    try {
      await ghPut(archiveApiPath, {
        message: `archive: ${platform}/${slug} (${source_id}) snapshot 1`,
        content: Buffer.from(markdown, 'utf-8').toString('base64'),
      });
      return res.status(200).json({
        status: 'created',
        path: p.full,
        snapshot_count: 1,
        message_count: new_messages.length,
      });
    } catch (putErr) {
      if (putErr.statusCode !== 422) throw putErr;
      // Path collision: very rare in Mode B (search would normally find the
      // file). Could only happen if two different source_ids slugify to the
      // same path AND the search hadn't indexed the existing file yet.
      const existing = await ghGetFile(archiveApiPath);
      if (existing && frontmatterSourceId(existing.content) === source_id) {
        // Index lag — fall through to the append path on the next request.
        return res.status(409).json({
          error: 'search index lag detected; retry shortly',
          path: p.full,
          hint: 're-send the same Mode B request in 30-60 seconds — search index will catch up',
        });
      }
      return res.status(409).json({
        error: 'path collision: a different conversation already occupies this path',
        path: p.full,
        hint: 'two distinct source_ids slugified to the same path; rename or add a discriminator to the conversation title',
      });
    }
  }

  // ----- Existing file: read, possibly append, re-emit -----
  const archiveApiPath = `/repos/${ARCHIVE_OWNER}/${ARCHIVE_REPO}/contents/${existingPath}`;
  const existing = await ghGetFile(archiveApiPath);
  if (!existing) {
    return res.status(500).json({
      error: 'search returned existing path but Contents API does not see it',
      path: existingPath,
    });
  }
  const parsed = parseFrontmatter(existing.content);
  if (!parsed) {
    return res.status(500).json({
      error: 'existing file has no parseable frontmatter',
      path: existingPath,
    });
  }
  const currentMessageCount = parseInt(parsed.fm.message_count, 10);
  const currentSnapshotCount = parseInt(parsed.fm.snapshot_count, 10) || 1;
  if (isNaN(currentMessageCount)) {
    return res.status(500).json({
      error: 'existing file frontmatter has no valid message_count',
      path: existingPath,
    });
  }

  // Decide which slice of new_messages is actually new
  let toAppend;
  if (from_index === currentMessageCount) {
    toAppend = new_messages;
  } else if (from_index < currentMessageCount) {
    // Retry of an already-applied snapshot. Slice off the overlap.
    const skip = currentMessageCount - from_index;
    if (skip >= new_messages.length) {
      return res.status(200).json({
        status: 'no_change',
        path: existingPath,
        snapshot_count: currentSnapshotCount,
        message_count: currentMessageCount,
      });
    }
    toAppend = new_messages.slice(skip);
  } else {
    // from_index > currentMessageCount — gap
    return res.status(409).json({
      error: 'snapshot gap detected',
      expected_from_index: currentMessageCount,
      got_from_index: from_index,
      hint: 'daemon state file is ahead of the archive — run a reconciliation snapshot starting at expected_from_index with the missing messages, or accept the gap with ?force=true (not yet implemented)',
    });
  }

  // Append: parse existing body, append new content, re-emit full markdown
  const existingBody = parseExistingBody(existing.content);
  const newSnapshotCount = currentSnapshotCount + 1;
  const newMessageCount = currentMessageCount + toAppend.length;
  const newFm = buildFrontmatter({
    date: parsed.fm.date,
    platform: parsed.fm.platform || platform,
    title,                            // latest wins
    started_at: parsed.fm.started_at, // never overwritten after first POST
    last_updated,
    message_count: newMessageCount,
    snapshot_count: newSnapshotCount,
    source_id,
  });
  // Normalize trailing newlines on existing body to exactly one blank-line
  // separator before the appended block.
  const trimmedBody = existingBody.replace(/\n+$/, '');
  const newMarkdown = newFm + trimmedBody + '\n\n' + buildBody(toAppend);

  const slug = slugify(title);
  await ghPut(archiveApiPath, {
    message: `archive: ${parsed.fm.platform || platform}/${slug} (${source_id}) snapshot ${newSnapshotCount} +${toAppend.length}`,
    content: Buffer.from(newMarkdown, 'utf-8').toString('base64'),
    sha: existing.sha,
  });

  return res.status(200).json({
    status: 'appended',
    path: existingPath,
    snapshot_count: newSnapshotCount,
    message_count: newMessageCount,
    appended: toAppend.length,
  });
}

// ---------------------------------------------------------------------------
// POST /ingest — dispatch by mode
// ---------------------------------------------------------------------------

router.post('/ingest', requireBearer, async (req, res) => {
  try {
    const m = modeOf(req.body);
    if (m === 'A') return await handleModeA(req, res);
    if (m === 'B') return await handleModeB(req, res);
    return res.status(400).json({
      error: 'request body does not match Mode A (messages + ended_at) or Mode B (new_messages + from_index); send exactly one mode',
    });
  } catch (err) {
    console.error('[archive-ingest] error:', err);
    return res.status(500).json({ error: err && err.message ? err.message : 'internal error' });
  }
});

module.exports = router;
