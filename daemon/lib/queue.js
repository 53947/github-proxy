// daemon/lib/queue.js
//
// Retry queue helpers — Prompt 05/09/2026-43.
//
// Why this file exists.
// `queueDelta()` previously lived inline in daemon.js with a fatal
// design flaw: the queue filename was built as
//   `${delta.source_id}-${Date.now()}.json`
// `Date.now()` made every retry write a NEW file for the SAME
// source_id rather than overwriting the prior one. Each 15-minute
// snapshot pass that re-encountered a persistently-failing delta
// (e.g. a path collision pre-Prompt-39, or a sustained network or
// GitHub-API outage) appended one more file to the retry queue.
// Across hours that produced the 11,477-delta runaway documented in
// SEGUE_05-09-2026-41 operational finding (1) and preserved at
// `~/.linksblue-daemon/queue-stuck-20260509T0501Z`.
//
// The fix.
// The queue file is keyed by `source_id` alone. `fs.writeFileSync`
// overwrites on collision, so the latest payload wins on each
// retry. Exactly one queue file per source_id, period. This is
// "Behavior A — replace on retry": when a retry happens later, the
// delta may legitimately carry MORE messages than the original
// (more activity has happened since), and we want the LATEST
// snapshot to be what eventually drains, not a stale one. That is
// the right semantic for snapshot/append capture against the
// linksblue ingest endpoint.
//
// Risk and follow-ons.
// If a delta is genuinely un-postable forever (e.g. a permanent
// schema-violating payload), it sits at one path forever. That is
// acceptable — it is a single observable file, removable by hand,
// and inert. The retry behavior inside daemon.js (`postDelta`'s
// 3-attempt + backoff + queue-on-terminal logic) is unchanged by
// this fix; only the on-disk fanout is suppressed.
//
// Why this is its own module rather than inline in daemon.js.
// Mirrors the established lib/ pattern from Prompt 05/09/2026-38
// (parseJsonlFile lives in lib/jsonl-parser.js so it can be unit-
// tested in isolation against a tmpdir). The same shape applies
// here — tests need to inject their own queue directory, which is
// not possible when QUEUE_DIR is a module-level const computed
// from os.homedir().

const fs = require('node:fs');
const path = require('node:path');

const FILENAME_SAFE_CHARS = /[^a-zA-Z0-9.\-_]/g;

function queueFilename(sourceId) {
  return `${sourceId}.json`.replace(FILENAME_SAFE_CHARS, '_');
}

function queueDelta({ queueDir, delta, reason, now, logger }) {
  const filename = queueFilename(delta.source_id);
  const filepath = path.join(queueDir, filename);
  const queuedAt = (typeof now === 'function' ? now() : new Date().toISOString());
  try {
    fs.writeFileSync(filepath, JSON.stringify({ delta, reason, queued_at: queuedAt }, null, 2));
    if (logger && typeof logger.info === 'function') {
      logger.info(`queued delta source_id=${delta.source_id} reason=${reason} -> ${filename}`);
    }
  } catch (err) {
    if (logger && typeof logger.error === 'function') {
      logger.error(`failed to queue delta source_id=${delta.source_id}:`, err.message);
    }
  }
  return { filename, filepath };
}

module.exports = { queueDelta, queueFilename };
