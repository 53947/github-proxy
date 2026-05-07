// routes/archive-last-message-count.js
//
// GET /api/archive/last-message-count?source_id=<encoded-source-id>
// Authorization: Bearer ${ARCHIVE_API_KEY}
//
// Snapshot recovery on fresh install (Prompt 05/07/2026-34, pass 3a).
// Lets the chrome-capture extension query the canonical
// `last_message_count` for a conversation that's already been archived,
// so it can set `from_index` correctly after a clean reinstall instead
// of POSTing the entire conversation history with from_index=0.
//
// Response shape:
//   - file exists:        200 { "exists": true,  "last_message_count": <int> }
//   - file does not exist: 200 { "exists": false, "last_message_count": 0 }
//   - missing source_id:  400
//   - bad/missing token:  401 (via requireBearer)
//   - frontmatter corrupt:500 (missing or non-integer message_count)
//   - GitHub API down:    500 with upstream error included
//
// "Does not exist" returns 0 by design: it collapses to the same
// from_index a brand-new conversation would have, so the extension
// doesn't need separate code paths for "fresh install" vs "fresh
// conversation."

const express = require('express');
const router = express.Router();

const {
  GITHUB_API,
  ARCHIVE_OWNER,
  ARCHIVE_REPO,
  ghGetFile,
  ghSearchSourceId,
  parseFrontmatter,
  requireBearer,
} = require('./archive-helpers');

router.get('/last-message-count', requireBearer, async (req, res) => {
  try {
    const sourceId = req.query.source_id;
    if (typeof sourceId !== 'string' || !sourceId.trim()) {
      return res.status(400).json({ error: 'source_id query parameter is required' });
    }

    let existingPath;
    try {
      existingPath = await ghSearchSourceId(sourceId);
    } catch (searchErr) {
      return res.status(500).json({
        error: 'GitHub search failed',
        upstream: searchErr && searchErr.message ? searchErr.message : 'unknown',
      });
    }

    if (!existingPath) {
      return res.status(200).json({ exists: false, last_message_count: 0 });
    }

    const archiveApiPath = `/repos/${ARCHIVE_OWNER}/${ARCHIVE_REPO}/contents/${existingPath}`;
    let existing;
    try {
      existing = await ghGetFile(archiveApiPath);
    } catch (getErr) {
      return res.status(500).json({
        error: 'GitHub Contents API failed',
        upstream: getErr && getErr.message ? getErr.message : 'unknown',
      });
    }

    if (!existing) {
      // Search returned a path but Contents API didn't see the file.
      // Treat as "does not exist" — the extension will use from_index=0
      // and the next ingest POST will go through Mode B's first-snapshot
      // branch, which creates the file fresh.
      return res.status(200).json({ exists: false, last_message_count: 0 });
    }

    const parsed = parseFrontmatter(existing.content);
    if (!parsed) {
      return res.status(500).json({
        error: 'archive file has no parseable frontmatter',
        path: existingPath,
      });
    }

    const raw = parsed.fm.message_count;
    const n = parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 0) {
      return res.status(500).json({
        error: 'archive file frontmatter has no valid message_count',
        path: existingPath,
        raw_value: raw,
      });
    }

    return res.status(200).json({ exists: true, last_message_count: n });
  } catch (err) {
    console.error('[archive-last-message-count] unexpected error:', err);
    return res.status(500).json({ error: err && err.message ? err.message : 'internal error' });
  }
});

module.exports = router;
