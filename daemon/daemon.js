#!/usr/bin/env node
// linksblue-daemon — Prompt 05/03/2026-20 (LINKSBLUE_SNAPSHOT_DAEMON)
//
// Snapshots local Claude conversations every 15 minutes and POSTs the
// new messages to https://github.linksblue.network/api/archive/ingest
// in Mode B (snapshot/append).
//
// Watches three sources:
//   - ~/.claude/projects/                          (Claude Code CLI)
//   - ~/Library/Application Support/Claude/local-agent-mode-sessions/  (Cowork)
//   - ~/Library/Application Support/Claude/IndexedDB/https_claude.ai_0.indexeddb.leveldb/
//                                                  (Claude.ai web AND Desktop)
//
// State: ~/.linksblue-daemon/state.json
// Logs:  ~/.linksblue-daemon/daemon.log
// Queue: ~/.linksblue-daemon/queue/
// Parse failures: ~/.linksblue-daemon/parse-failures/

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const SNAPSHOT_INTERVAL_MS = 15 * 60 * 1000;
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const INGEST_URL = 'https://github.linksblue.network/api/archive/ingest';
const HOME = os.homedir();
const STATE_DIR = path.join(HOME, '.linksblue-daemon');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const QUEUE_DIR = path.join(STATE_DIR, 'queue');
const PARSE_FAILURE_DIR = path.join(STATE_DIR, 'parse-failures');
// daemon.log path is owned by the LaunchAgent plist (StandardOutPath /
// StandardErrorPath). Don't redeclare it here — see logger comments below.

// Throttle for repeated GitHub-issue creation on parse failures.
const ISSUE_THROTTLE_MS = 24 * 60 * 60 * 1000;
const issueThrottleState = new Map(); // errorType -> lastIssueTimestamp

function ensureDirs() {
  for (const dir of [STATE_DIR, QUEUE_DIR, PARSE_FAILURE_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

// Logger writes to stdout/stderr only. The LaunchAgent plist redirects
// both StandardOutPath and StandardErrorPath to LOG_FILE, so console.log
// and console.error already land in daemon.log. Writing the same line via
// appendFileSync as well caused every line to appear twice.
// Never log the API key.
function timestamp() {
  return new Date().toISOString();
}

function logInfo(...parts) {
  console.log(`[${timestamp()}] INFO ${parts.join(' ')}`);
}

function logError(...parts) {
  console.error(`[${timestamp()}] ERROR ${parts.join(' ')}`);
}

function loadKey() {
  try {
    const key = execSync('security find-generic-password -s LINKSBLUE_ARCHIVE_API_KEY -w', { encoding: 'utf-8' }).trim();
    if (!key) {
      logError('Keychain entry LINKSBLUE_ARCHIVE_API_KEY returned empty value');
      process.exit(1);
    }
    return key;
  } catch (err) {
    logError('Cannot read API key from Keychain (LINKSBLUE_ARCHIVE_API_KEY):', err.message);
    process.exit(1);
  }
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return { version: 1, conversations: {} };
  }
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed.conversations) parsed.conversations = {};
    if (!parsed.version) parsed.version = 1;
    return parsed;
  } catch (err) {
    logError('Cannot parse state.json — starting fresh:', err.message);
    return { version: 1, conversations: {} };
  }
}

function saveState(state) {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function markStale(state) {
  const cutoff = Date.now() - STALE_AFTER_MS;
  for (const [sourceId, c] of Object.entries(state.conversations)) {
    if (c.active && c.last_seen_at && new Date(c.last_seen_at).getTime() < cutoff) {
      c.active = false;
      logInfo(`marked stale: ${sourceId} (last_seen_at=${c.last_seen_at})`);
    }
  }
}

// Persist a delta to disk if POST fails — daemon never drops data.
function queueDelta(delta, reason) {
  const filename = `${delta.source_id}-${Date.now()}.json`.replace(/[^a-zA-Z0-9.\-_]/g, '_');
  const filepath = path.join(QUEUE_DIR, filename);
  try {
    fs.writeFileSync(filepath, JSON.stringify({ delta, reason, queued_at: timestamp() }, null, 2));
    logInfo(`queued delta source_id=${delta.source_id} reason=${reason} -> ${filename}`);
  } catch (err) {
    logError(`failed to queue delta source_id=${delta.source_id}:`, err.message);
  }
}

function loadQueuedDeltas() {
  if (!fs.existsSync(QUEUE_DIR)) return [];
  return fs.readdirSync(QUEUE_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const filepath = path.join(QUEUE_DIR, f);
        const wrapper = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
        return { filepath, ...wrapper };
      } catch (err) {
        logError(`failed to read queue file ${f}:`, err.message);
        return null;
      }
    })
    .filter(Boolean);
}

function clearQueueFile(filepath) {
  try { fs.unlinkSync(filepath); } catch (_) {}
}

function recordParseFailure(errorType, key, rawValue) {
  const filename = `${errorType}-${Date.now()}.json`.replace(/[^a-zA-Z0-9.\-_]/g, '_');
  const filepath = path.join(PARSE_FAILURE_DIR, filename);
  try {
    fs.writeFileSync(filepath, JSON.stringify({
      error_type: errorType,
      key: typeof key === 'string' ? key : key.toString('hex').slice(0, 200),
      raw_value_hex: rawValue ? Buffer.from(rawValue).toString('hex').slice(0, 4000) : null,
      timestamp: timestamp(),
    }, null, 2));
  } catch (err) {
    logError('failed to record parse failure:', err.message);
  }
}

function maybeOpenIssue(errorType, summary) {
  const last = issueThrottleState.get(errorType);
  if (last && (Date.now() - last) < ISSUE_THROTTLE_MS) return;
  issueThrottleState.set(errorType, Date.now());
  try {
    execSync(`gh issue create --repo TRIADBLUE/linksblue --title "linksblue-daemon: ${errorType} spike" --body ${JSON.stringify(summary).slice(0, 4000)}`, { stdio: 'pipe' });
    logInfo(`opened GitHub issue for parse failure spike: ${errorType}`);
  } catch (err) {
    logError(`failed to open GitHub issue for ${errorType}:`, err.message);
  }
}

async function postDelta(delta, key) {
  const body = {
    platform: delta.platform,
    title: delta.title,
    started_at: delta.started_at,
    last_updated: new Date().toISOString(),
    source_id: delta.source_id,
    from_index: delta.from_index,
    new_messages: delta.new_messages,
  };

  const backoffs = [1000, 2000, 4000];
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, backoffs[attempt - 1]));
    try {
      const res = await fetch(INGEST_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }

      if (res.status === 200 || res.status === 201) {
        logInfo(`POST ${delta.platform}/${delta.source_id} from_index=${delta.from_index} new=${delta.new_messages.length} -> status=${parsed.status || 'ok'}`);
        return { ok: true, body: parsed };
      }
      if (res.status === 401) {
        logError('INGEST 401 — auth drift. Stopping daemon. Dean: check Keychain vs Railway ARCHIVE_API_KEY.');
        process.exit(1);
      }
      if (res.status === 409) {
        logError(`INGEST 409 (gap) source_id=${delta.source_id}: ${JSON.stringify(parsed)}`);
        queueDelta(delta, `gap: ${JSON.stringify(parsed)}`);
        return { ok: false, terminal: true, body: parsed };
      }
      // 5xx or other — retry
      lastErr = new Error(`status ${res.status}: ${text.slice(0, 200)}`);
      logError(`INGEST ${res.status} attempt ${attempt + 1}/3 source_id=${delta.source_id}:`, text.slice(0, 200));
    } catch (err) {
      lastErr = err;
      logError(`INGEST network error attempt ${attempt + 1}/3 source_id=${delta.source_id}:`, err.message);
    }
  }
  // All retries failed — queue for next pass.
  queueDelta(delta, `post failed after 3 retries: ${lastErr ? lastErr.message : 'unknown'}`);
  return { ok: false, terminal: false, error: lastErr };
}

async function drainQueue(key) {
  const queued = loadQueuedDeltas();
  if (queued.length === 0) return;
  logInfo(`draining queue: ${queued.length} delta(s)`);
  for (const item of queued) {
    if (!item.delta) { clearQueueFile(item.filepath); continue; }
    const result = await postDelta(item.delta, key);
    if (result.ok) clearQueueFile(item.filepath);
  }
}

async function runSnapshot(state, key) {
  ensureDirs();
  markStale(state);

  // 1. Drain any queued deltas first.
  await drainQueue(key);

  // 2. Run watchers.
  const watchers = [
    { name: 'claude-code', fn: require('./watchers/claude-code') },
    { name: 'cowork', fn: require('./watchers/cowork') },
    { name: 'claude-leveldb', fn: require('./watchers/claude-leveldb') },
  ];

  for (const w of watchers) {
    try {
      const deltas = await w.fn(state, { logInfo, logError, recordParseFailure, maybeOpenIssue });
      logInfo(`watcher ${w.name}: ${deltas.length} delta(s)`);
      for (const delta of deltas) {
        const result = await postDelta(delta, key);
        if (result.ok) {
          const last = result.body.last_message_index != null
            ? result.body.last_message_index
            : (delta.from_index + delta.new_messages.length);
          state.conversations[delta.source_id] = {
            platform: delta.platform,
            title: delta.title,
            started_at: delta.started_at,
            last_seen_at: timestamp(),
            last_message_index: last,
            snapshot_count: (state.conversations[delta.source_id]?.snapshot_count || 0) + 1,
            active: true,
          };
        }
      }
    } catch (err) {
      logError(`watcher ${w.name} threw:`, err.message);
    }
  }

  saveState(state);
}

async function main() {
  ensureDirs();
  const key = loadKey();
  const state = loadState();

  // Persist on signal.
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      logInfo(`received ${sig} — saving state and exiting`);
      try { saveState(state); } catch (e) { logError('save on exit failed:', e.message); }
      process.exit(0);
    });
  }

  logInfo(`linksblue-daemon starting. interval=${SNAPSHOT_INTERVAL_MS / 1000}s ingest=${INGEST_URL}`);

  async function loop() {
    try {
      await runSnapshot(state, key);
    } catch (err) {
      logError('snapshot pass failed:', err.message);
    } finally {
      setTimeout(loop, SNAPSHOT_INTERVAL_MS);
    }
  }

  loop();
}

if (require.main === module) {
  main().catch(err => { logError('fatal:', err.message); process.exit(1); });
}

module.exports = { runSnapshot, postDelta };
