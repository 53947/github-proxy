// routes/archive-helpers.js
//
// Shared helpers used by /api/archive routes — currently the
// snapshot-append POST in archive-ingest.js and the read-only
// GET /api/archive/last-message-count handler in
// archive-last-message-count.js.
//
// Extracted (Prompt 05/07/2026-34) so two routes don't duplicate the
// GitHub-API plumbing or the bearer-auth middleware. archive-ingest.js
// keeps the ingest-specific helpers (slugify, pathFor, yamlEscape,
// buildFrontmatter, parseExistingBody, validateModeA/B, frontmatterSourceId);
// only the truly shared pieces moved here.

const GITHUB_API = 'https://api.github.com';
const ARCHIVE_OWNER = 'TRIADBLUE';
const ARCHIVE_REPO = 'ai-archive';

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------

function ghHeaders() {
  const h = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'linksblue-archive-helpers/1.0',
  };
  if (process.env.GITHUB_TOKEN) {
    h['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return h;
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
  // GitHub code search across the private archive repo. Index can lag
  // a few seconds — callers that just wrote a file may need a fallback
  // (Mode A's 422 retry path uses Contents API directly). For
  // last-message-count's purpose (lookup against files written days
  // or weeks ago) the lag is not relevant.
  const q = `"source_id: ${sourceId}" repo:${ARCHIVE_OWNER}/${ARCHIVE_REPO}`;
  const url = `${GITHUB_API}/search/code?q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) {
    console.warn(`[archive-helpers] dedupe search ${res.status}: ${await res.text()}`);
    return null;
  }
  const data = await res.json();
  if (Array.isArray(data.items) && data.items.length > 0) {
    return data.items[0].path;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Frontmatter parser
// ---------------------------------------------------------------------------

// Parse the YAML frontmatter at the top of a markdown file. Returns
// { fm: <key/value object>, fmEndIdx: <line index of closing ---> } or
// null if the file has no '---' delimiter pair at the top.
//
// Deliberately limited to the format buildFrontmatter() in
// archive-ingest.js produces: simple `key: value` lines, optional
// double-quoted string scalars. No YAML library.
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

module.exports = {
  GITHUB_API,
  ARCHIVE_OWNER,
  ARCHIVE_REPO,
  ghHeaders,
  ghGetFile,
  ghSearchSourceId,
  parseFrontmatter,
  requireBearer,
};
