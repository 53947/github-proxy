// routes/daemon-heartbeat.js
//
// Daemon health monitoring endpoint pair — Prompt 05/09/2026-44.
// Companion to the heartbeat POST in daemon/daemon.js and the
// scheduled GitHub Action at .github/workflows/daemon-health-check.yml.
//
// Why this exists.
// On 2026-05-04 at 17:12 UTC the linksblue capture daemon received a
// SIGTERM and exited cleanly. The LaunchAgent's KeepAlive=true setting
// only respawns crashed processes, not SIGTERM-directed shutdowns, so
// the daemon stayed dead for three days. The outage was discovered
// only as a side effect of an unrelated diagnostic on 2026-05-07. See
// SEGUE_05-09-2026-41 operational finding (2).
//
// Architecture.
// Three pieces, single contract:
//   1. Daemon POSTs to this endpoint after each successful runSnapshot.
//   2. This endpoint stores the latest heartbeat in memory + persists
//      one file per daemon_id to TRIADBLUE/ai-archive at
//      monitoring/heartbeat-{daemon_id}.json. Persistence survives
//      Railway redeploys; in-memory is the fast path.
//   3. A scheduled GitHub Action GETs every 15 minutes and opens an
//      issue if the heartbeat is older than 45 minutes.
//
// Worst-case detection lag = 15 (Action interval) + 45 (staleness
// threshold) = 60 minutes. Two orders of magnitude better than the
// 3-day silent outage that motivated the prompt.
//
// Persistence to ai-archive is a feature beyond mere durability — git
// log of monitoring/heartbeat-linksblue-daemon.json gives a queryable
// audit trail of every successful pass. Volume is bounded: ~96
// commits/day at the daemon's 15-minute interval, well within the
// proxy's PAT budget.
//
// Persistence is fail-soft: a write failure is logged and swallowed.
// The in-memory cache covers the daemon → endpoint delivery, and the
// daemon will POST again next pass anyway.

const express = require('express');
const router = express.Router();

const {
  GITHUB_API,
  ARCHIVE_OWNER,
  ARCHIVE_REPO,
  ghHeaders,
  ghGetFile,
  requireBearer,
} = require('./archive-helpers');

const VALID_STATUSES = ['ok', 'degraded', 'failed'];
const DEFAULT_DAEMON_ID = 'linksblue-daemon';

// ---------------------------------------------------------------------------
// In-memory cache (per daemon_id)
//
// The first GET after a Railway redeploy will see an empty cache and
// fall through to ghGetFile to repopulate from ai-archive. After the
// repopulate, subsequent GETs serve from memory.
// ---------------------------------------------------------------------------

const cache = new Map();

// ---------------------------------------------------------------------------
// Persistence — one PUT to ai-archive per heartbeat
//
// Wrapped in a swappable function reference so unit tests can stub it
// without touching the real GitHub API. Production uses
// `persistToArchive`; tests inject a no-op via __setPersistFn.
// ---------------------------------------------------------------------------

async function persistToArchive(daemonId, payload) {
  const path = `monitoring/heartbeat-${daemonId}.json`;
  const apiPath = `/repos/${ARCHIVE_OWNER}/${ARCHIVE_REPO}/contents/${path}`;
  const existing = await ghGetFile(apiPath);
  const body = {
    message: `monitoring: ${daemonId} heartbeat ${payload.timestamp}`,
    content: Buffer.from(JSON.stringify(payload, null, 2), 'utf-8').toString('base64'),
  };
  if (existing && existing.sha) body.sha = existing.sha;
  const res = await fetch(`${GITHUB_API}${apiPath}`, {
    method: 'PUT',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub PUT ${apiPath} ${res.status}: ${text}`);
  }
}

let persistFn = persistToArchive;

// ---------------------------------------------------------------------------
// Validation + helpers (pure)
// ---------------------------------------------------------------------------

function validateBody(body) {
  if (!body || typeof body !== 'object') return 'request body must be a JSON object';
  if (typeof body.daemon_id !== 'string' || !body.daemon_id.trim()) return 'daemon_id must be a non-empty string';
  if (typeof body.host !== 'string' || !body.host.trim()) return 'host must be a non-empty string';
  if (typeof body.timestamp !== 'string' || isNaN(Date.parse(body.timestamp))) return 'timestamp must be an ISO 8601 string';
  if (!VALID_STATUSES.includes(body.last_pass_status)) return `last_pass_status must be one of: ${VALID_STATUSES.join(', ')}`;
  if (!body.watchers || typeof body.watchers !== 'object' || Array.isArray(body.watchers)) return 'watchers must be an object';
  if (!Number.isFinite(body.queue_depth) || body.queue_depth < 0) return 'queue_depth must be a non-negative number';
  return null;
}

function computeSecondsSince(payload, now) {
  const t = Date.parse(payload && payload.timestamp);
  if (isNaN(t)) return null;
  return Math.floor(((now == null ? Date.now() : now) - t) / 1000);
}

// ---------------------------------------------------------------------------
// POST /heartbeat — bearer-authed, validates body, stores latest heartbeat
// ---------------------------------------------------------------------------

router.post('/heartbeat', requireBearer, async (req, res) => {
  const validationError = validateBody(req.body);
  if (validationError) return res.status(400).json({ error: validationError });

  const payload = req.body;
  cache.set(payload.daemon_id, payload);

  try {
    await persistFn(payload.daemon_id, payload);
  } catch (err) {
    console.error(`[daemon-heartbeat] persistence failed for ${payload.daemon_id}: ${err.message}`);
  }

  return res.status(200).json({ status: 'ok', stored_at: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// GET /heartbeat — public, returns latest heartbeat with seconds_since
// ---------------------------------------------------------------------------

router.get('/heartbeat', async (req, res) => {
  const daemonId = (req.query && req.query.daemon_id) || DEFAULT_DAEMON_ID;
  let payload = cache.get(daemonId) || null;

  if (!payload) {
    try {
      const path = `monitoring/heartbeat-${daemonId}.json`;
      const apiPath = `/repos/${ARCHIVE_OWNER}/${ARCHIVE_REPO}/contents/${path}`;
      const existing = await ghGetFile(apiPath);
      if (existing && existing.content) {
        payload = JSON.parse(existing.content);
        cache.set(daemonId, payload);
      }
    } catch (err) {
      console.warn(`[daemon-heartbeat] cold-start read failed for ${daemonId}: ${err.message}`);
    }
  }

  if (!payload) {
    return res.status(404).json({ error: 'no heartbeat received yet', daemon_id: daemonId });
  }

  return res.status(200).json({
    ...payload,
    seconds_since: computeSecondsSince(payload),
  });
});

// ---------------------------------------------------------------------------
// Test hooks — exported so unit tests can reset state and stub
// persistence without touching the real GitHub API. Not part of the
// public surface; daemon and Action consumers never call these.
// ---------------------------------------------------------------------------

module.exports = router;
module.exports.validateBody = validateBody;
module.exports.computeSecondsSince = computeSecondsSince;
module.exports.__reset = function () { cache.clear(); persistFn = persistToArchive; };
module.exports.__setPersistFn = function (fn) { persistFn = fn; };
