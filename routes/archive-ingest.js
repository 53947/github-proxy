// routes/archive-ingest.js
//
// POST /api/archive/ingest — receives AI conversation captures from the
// linksblue capture daemon (Prompt 05/01/2026-10) and commits each one to
// TRIADBLUE/ai-archive as a markdown file with YAML frontmatter.
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
// GitHub helpers (self-contained — does not import index.js helpers so this
// route is safe to lift into another service if linksblue ever splits)
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
    throw new Error(`GitHub PUT ${path} ${res.status}: ${text}`);
  }
  return res.json();
}

async function ghSearchSourceId(sourceId) {
  // GitHub code search across the private archive repo. We search for the
  // literal frontmatter line, which is unique per conversation.
  const q = `"source_id: ${sourceId}" repo:${ARCHIVE_OWNER}/${ARCHIVE_REPO}`;
  const url = `${GITHUB_API}/search/code?q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) {
    // Search failures (rate limit, indexing delay) are non-fatal. Log and
    // proceed; if a true duplicate is committed, the GitHub Contents API
    // returns 422 on path collision, which is a backup safety net.
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
  // Minimal escaping for double-quoted YAML scalars.
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildFrontmatter({ date, platform, title, started_at, ended_at, message_count, source_id }) {
  return [
    '---',
    `date: ${date}`,
    `platform: ${platform}`,
    `title: "${yamlEscape(title)}"`,
    `started_at: ${started_at}`,
    `ended_at: ${ended_at}`,
    `message_count: ${message_count}`,
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
// Body validation
// ---------------------------------------------------------------------------

function validateBody(body) {
  if (!body || typeof body !== 'object') {
    return 'request body must be a JSON object';
  }
  const { platform, title, started_at, ended_at, messages, source_id } = body;
  if (!VALID_PLATFORMS.includes(platform)) {
    return `platform must be one of: ${VALID_PLATFORMS.join(', ')}`;
  }
  if (typeof title !== 'string' || !title.trim()) {
    return 'title must be a non-empty string';
  }
  if (typeof started_at !== 'string' || isNaN(Date.parse(started_at))) {
    return 'started_at must be an ISO 8601 string';
  }
  if (typeof ended_at !== 'string' || isNaN(Date.parse(ended_at))) {
    return 'ended_at must be an ISO 8601 string';
  }
  if (!Array.isArray(messages)) {
    return 'messages must be an array';
  }
  if (typeof source_id !== 'string' || !source_id.trim()) {
    return 'source_id must be a non-empty string';
  }
  return null;
}

// ---------------------------------------------------------------------------
// POST /ingest
// ---------------------------------------------------------------------------

router.post('/ingest', requireBearer, async (req, res) => {
  try {
    const validationError = validateBody(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const { platform, title, started_at, ended_at, messages, source_id } = req.body;

    // Dedupe by source_id
    const existingPath = await ghSearchSourceId(source_id);
    if (existingPath) {
      return res.status(200).json({ status: 'duplicate', path: existingPath });
    }

    // Build path + content
    const slug = slugify(title);
    const p    = pathFor({ startedAt: started_at, platform, slug });
    const fm   = buildFrontmatter({
      date: p.date,
      platform,
      title,
      started_at,
      ended_at,
      message_count: messages.length,
      source_id,
    });
    const markdown = fm + buildBody(messages);

    // Commit to ai-archive via GitHub Contents API
    await ghPut(`/repos/${ARCHIVE_OWNER}/${ARCHIVE_REPO}/contents/${p.full}`, {
      message: `archive: ${platform}/${slug} (${source_id})`,
      content: Buffer.from(markdown, 'utf-8').toString('base64'),
    });

    return res.status(200).json({ status: 'created', path: p.full });
  } catch (err) {
    console.error('[archive-ingest] error:', err);
    return res.status(500).json({ error: err && err.message ? err.message : 'internal error' });
  }
});

module.exports = router;
