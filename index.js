const express = require('express');
const crypto = require('crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');

const app = express();

const TARGET = 'https://consoleblue.triadblue.com';
const PORT = process.env.PORT || 3000;
const GITHUB_ORG = process.env.GITHUB_ORG || 'TRIADBLUE';
const GITHUB_API = 'https://api.github.com';

// --- CORS middleware (must be first) ---
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, x-api-key, Authorization, mcp-session-id, Mcp-Session-Id, Last-Event-ID, MCP-Protocol-Version');
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id, Mcp-Session-Id, MCP-Protocol-Version');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// /api/archive/ingest receives chrome-capture POSTs of full claude.ai
// conversations — 100s of messages, structured content, can run several
// MB. Other routes get the default 100kb limit. (Response 05/06/2026-31c)
// Order is load-bearing — the path-prefix override must register before
// the global parser, since Express runs middleware in registration order
// and the first parser to populate req.body wins.
app.use('/api/archive/ingest', express.json({ limit: '10mb' }));
app.use(express.json());

// --- GitHub API helper ---
function ghHeaders() {
  const h = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'consoleblue-github-proxy/1.0',
  };
  if (process.env.GITHUB_TOKEN) {
    h['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return h;
}

async function ghFetch(path) {
  const url = `${GITHUB_API}${path}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status}: ${body}`);
  }
  return res.json();
}

async function ghPut(path, body) {
  const url = `${GITHUB_API}${path}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub PUT ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function ghDeleteContents(path, body) {
  const url = `${GITHUB_API}${path}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub DELETE ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function ghPost(path, body) {
  const url = `${GITHUB_API}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub POST ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function ghPatch(path, body) {
  const url = `${GITHUB_API}${path}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub PATCH ${res.status}: ${text}`);
  return JSON.parse(text);
}

// Atomic multi-file commit via the Git Data API. Steps:
//   1. Get the current head sha of the target branch
//   2. Get the tree sha of that commit
//   3. Create blobs for each new file
//   4. Create a new tree based on the parent tree + the new blobs
//   5. Create a commit pointing at the new tree, parented at the old head
//   6. Update the branch ref to point at the new commit
// Returns { commit_sha, tree_sha, branch, files_changed }.
async function pushFilesAtomic(repo, files, message, branch) {
  // 1. Resolve target branch (default = repo default branch)
  let targetBranch = branch;
  if (!targetBranch) {
    const repoMeta = await ghFetch(`/repos/${GITHUB_ORG}/${repo}`);
    targetBranch = repoMeta.default_branch;
  }
  // 2. Get current head ref + commit
  const ref = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/git/ref/heads/${targetBranch}`);
  const headSha = ref.object.sha;
  const headCommit = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/git/commits/${headSha}`);
  const baseTreeSha = headCommit.tree.sha;
  // 3. Create blobs
  const blobs = await Promise.all(files.map(async (f) => {
    const blob = await ghPost(`/repos/${GITHUB_ORG}/${repo}/git/blobs`, {
      content: Buffer.from(String(f.content), 'utf-8').toString('base64'),
      encoding: 'base64',
    });
    return { path: normalizePath(f.path), sha: blob.sha };
  }));
  // 4. Create the new tree
  const treeEntries = blobs.map(b => ({
    path: b.path,
    mode: '100644',
    type: 'blob',
    sha: b.sha,
  }));
  const tree = await ghPost(`/repos/${GITHUB_ORG}/${repo}/git/trees`, {
    base_tree: baseTreeSha,
    tree: treeEntries,
  });
  // 5. Create the commit
  const commitMsg = message || `[linksblue] push ${files.length} file${files.length === 1 ? '' : 's'}`;
  const commit = await ghPost(`/repos/${GITHUB_ORG}/${repo}/git/commits`, {
    message: commitMsg,
    tree: tree.sha,
    parents: [headSha],
  });
  // 6. Update the ref
  await ghPatch(`/repos/${GITHUB_ORG}/${repo}/git/refs/heads/${targetBranch}`, {
    sha: commit.sha,
  });
  return {
    status: 'pushed',
    commit_sha: commit.sha,
    tree_sha: tree.sha,
    branch: targetBranch,
    files_changed: files.length,
    paths: blobs.map(b => b.path),
  };
}

// --- v2.7+TTL: PROMPT LOG operations (atomic claim + lifecycle + 7-day TTL on `claimed`) ---
// Storage: TRIADBLUE/ai-archive/PROMPT_LOG.md
// Concurrency: optimistic (read sha, modify, conditional PUT, retry up to 3x)
//
// TTL behavior (added by Prompt 05/04/2026-22 — CLAIM_TTL_AND_EXPIRY):
//   - Claims with status=`claimed` and a parseable `claimed_at` ISO timestamp
//     auto-expire when (now - claimed_at) > 7 days.
//   - Expiry sweep is LAZY — runs at the start of every claim-number,
//     claim-response, and prompt-status call. No scheduled task.
//   - When the sweep changes any row, it commits PROMPT_LOG.md before the
//     endpoint's main commit. Two commits on expiration runs; one otherwise.
//   - Expired numbers are NEVER reissued. nextN advances past them.
//   - Historical rows without claimed_at are immune (sweep skips them).
//   - PATCH targeting an `expired` row returns 409 (cannot transition).

const ARCHIVE_REPO = 'ai-archive';
const PROMPT_LOG_PATH = 'PROMPT_LOG.md';
const MAX_CLAIM_RETRIES = 3;
const CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function parseHighestN(content) {
  // Scans the entire file for MM/DD/YYYY-N patterns and returns max N.
  // This naturally includes `expired` rows (which retain their ID), so
  // expired numbers are never reissued — the next claim is always max+1.
  let max = 0;
  const re = /\d{2}\/\d{2}\/\d{4}-(\d+)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max;
}

function findResponsesForParent(content, parentDate, parentN) {
  const escaped = parentDate.replace(/\//g, '\\/');
  const re = new RegExp(`${escaped}-${parentN}([a-z]+)\\b`, 'g');
  const letters = [];
  let m;
  while ((m = re.exec(content)) !== null) letters.push(m[1]);
  return letters;
}

function nextAlphabetic(s) {
  if (!s) return 'a';
  const last = s.charCodeAt(s.length - 1);
  if (last < 'z'.charCodeAt(0)) {
    return s.slice(0, -1) + String.fromCharCode(last + 1);
  }
  return nextAlphabetic(s.slice(0, -1)) + 'a';
}

function highestLetterFrom(letters) {
  if (!letters.length) return null;
  const sorted = letters.slice().sort((a, b) => {
    if (a.length !== b.length) return a.length - b.length;
    return a.localeCompare(b);
  });
  return sorted[sorted.length - 1];
}

function todayDateMMDDYYYY() {
  const d = new Date();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getUTCFullYear()}`;
}

function todayISODate() {
  return new Date().toISOString().slice(0, 10);
}

// Builds a PROMPT_LOG row. If `claimedAt` is provided, emits the 10-column
// schema (with Claimed At cell between Commit SHA and Note). If omitted,
// emits the legacy 9-column schema for backward compatibility.
function buildPromptRow({ id, type, dateISO, title, platform, agent, status, commitSha, note, claimedAt }) {
  const base = `| ${id} | ${type} | ${dateISO} | ${title || ''} | ${platform || ''} | ${agent || ''} | ${status} | ${commitSha || '—'}`;
  if (claimedAt) {
    return `${base} | ${claimedAt} | ${note || ''} |`;
  }
  return `${base} | ${note || ''} |`;
}

function insertRowAtTopOfLog(content, newRow) {
  // The 9-or-10-cell separator row anchors the LOG table (the smaller
  // CLAIM ENDPOINTS table at the top of PROMPT_LOG.md has only 2 cells,
  // so it can't match). Tolerates 9 cells (legacy) or 10 cells (with
  // Claimed At column).
  const sepRegex = /(\|(?:\s*-+\s*\|){9,10}[ \t]*\n)/;
  if (!sepRegex.test(content)) {
    throw new Error('PROMPT_LOG.md does not contain the expected 9- or 10-cell table separator row');
  }
  return content.replace(sepRegex, `$1${newRow}\n`);
}

function updateNextNumberLine(content, nextN) {
  return content.replace(/The next PROMPT or SEGUE will be N=\d+\./, `The next PROMPT or SEGUE will be N=${nextN}.`);
}

// Detects whether a parsed row uses the legacy 9-column schema or the new
// 10-column schema (with Claimed At). split('|') yields [empty, ..cols.., empty]
// so 9 data columns → 11 array elements, 10 data columns → 12 elements.
function rowHasClaimedAtColumn(cols) {
  return cols.length >= 12;
}

// Parses a markdown row into a structured object. Returns null for non-rows.
// Handles both 9-column legacy rows (claimed_at = null) and 10-column rows.
function parseLogRow(line) {
  if (!line || !line.startsWith('|')) return null;
  const cols = line.split('|').map(s => s.trim());
  // Either ['', id, type, date, title, platform, agent, status, sha, note, '']  (legacy, 11)
  // or     ['', id, type, date, title, platform, agent, status, sha, claimed_at, note, '']  (new, 12)
  if (cols.length < 11) return null;
  // Reject the header / separator rows (their "id" cell is "ID" or all dashes)
  if (cols[1] === 'ID' || /^-+$/.test(cols[1])) return null;
  const has = rowHasClaimedAtColumn(cols);
  return {
    id: cols[1],
    type: cols[2],
    date: cols[3],
    title: cols[4],
    platform: cols[5],
    agent: cols[6],
    status: cols[7],
    commitSha: cols[8],
    claimedAt: has ? cols[9] : null,
    note: has ? cols[10] : cols[9],
    has_claimed_at: has,
  };
}

// Updates a row's status (and optionally commit_sha and note). Handles both
// legacy 9-column and new 10-column rows. Returns the new content or null if
// the row wasn't found.
function updateRowStatus(content, id, newStatus, commitSha, note) {
  const lines = content.split('\n');
  let modified = false;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith(`| ${id} |`)) continue;
    const cols = lines[i].split('|').map(s => s.trim());
    if (cols.length < 11) continue;
    const has = rowHasClaimedAtColumn(cols);
    const noteIdx = has ? 10 : 9;
    cols[7] = newStatus;
    if (commitSha !== undefined && commitSha !== null) cols[8] = commitSha;
    if (note !== undefined && note !== null && note !== '') {
      const oldNote = cols[noteIdx] || '';
      cols[noteIdx] = oldNote && oldNote !== '' ? `${oldNote}; ${note}` : note;
    }
    lines[i] = '| ' + cols.slice(1, -1).join(' | ') + ' |';
    modified = true;
    break;
  }
  return modified ? lines.join('\n') : null;
}

// --- TTL: lazy expiry sweep ---

// Pure function: given the current PROMPT_LOG content, returns
// { changed, newContent, expiredIds }. Does NOT commit.
function sweepExpiredClaims(content) {
  const now = Date.now();
  const lines = content.split('\n');
  const expiredIds = [];
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const row = parseLogRow(lines[i]);
    if (!row) continue;
    if (row.status !== 'claimed') continue;
    if (!row.has_claimed_at || !row.claimedAt) continue; // historical rows immune
    const claimedTime = Date.parse(row.claimedAt);
    if (Number.isNaN(claimedTime)) continue; // malformed timestamp, leave alone
    if (now - claimedTime <= CLAIM_TTL_MS) continue; // still fresh
    // Expire this row
    const cols = lines[i].split('|').map(s => s.trim());
    cols[7] = 'expired';
    const noteIdx = 10; // 10-col rows always have noteIdx=10
    const oldNote = cols[noteIdx] || '';
    const expireNote = `auto-expired ${new Date(now).toISOString()}`;
    cols[noteIdx] = oldNote && oldNote !== '' ? `${oldNote}; ${expireNote}` : expireNote;
    lines[i] = '| ' + cols.slice(1, -1).join(' | ') + ' |';
    expiredIds.push(row.id);
    changed = true;
  }
  return { changed, newContent: lines.join('\n'), expiredIds };
}

// If the current file has any expirable claims, commits the sweep and
// returns the new file ref ({ sha, content }). Otherwise returns the
// original file ref unchanged.
async function maybeSweepAndCommit(file) {
  const sweep = sweepExpiredClaims(file.content);
  if (!sweep.changed) return file;
  const result = await ghPut(`/repos/${GITHUB_ORG}/${ARCHIVE_REPO}/contents/${PROMPT_LOG_PATH}`, {
    message: `Auto-expire stale claims: ${sweep.expiredIds.join(', ')}`,
    content: Buffer.from(sweep.newContent, 'utf-8').toString('base64'),
    sha: file.sha,
  });
  return { sha: result.content.sha, content: sweep.newContent };
}

function isShaConflict(err) {
  const msg = (err && err.message) || '';
  return /\b(409|422)\b/.test(msg) || /does not match/i.test(msg) || /sha/i.test(msg) && /match/i.test(msg);
}

// --- atomic operations ---

async function claimNumberAtomic({ type, platform, agent, title, coversPrompts }) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_CLAIM_RETRIES; attempt++) {
    try {
      let file = await ghGetFile(ARCHIVE_REPO, PROMPT_LOG_PATH);
      if (!file) throw new Error(`${PROMPT_LOG_PATH} not found in ${ARCHIVE_REPO}`);
      // Lazy expiry sweep — may produce a separate commit before our claim commit.
      file = await maybeSweepAndCommit(file);
      const { sha, content } = file;
      const highestN = parseHighestN(content);
      const nextN = highestN + 1;
      const date = todayDateMMDDYYYY();
      const id = `${date}-${nextN}`;
      let note = '';
      if (type === 'SEGUE' && coversPrompts && coversPrompts.length) {
        note = `covers: ${coversPrompts.join(', ')}`;
      }
      const claimedAt = new Date().toISOString();
      const row = buildPromptRow({
        id, type,
        dateISO: todayISODate(),
        title, platform, agent,
        status: 'claimed',
        note,
        claimedAt,
      });
      let newContent = insertRowAtTopOfLog(content, row);
      newContent = updateNextNumberLine(newContent, nextN + 1);
      const result = await ghPut(`/repos/${GITHUB_ORG}/${ARCHIVE_REPO}/contents/${PROMPT_LOG_PATH}`, {
        message: `claim ${type} ${id}${title ? ` (${title})` : ''}`,
        content: Buffer.from(newContent, 'utf-8').toString('base64'),
        sha,
      });
      return { n: nextN, date, id, type, claimed_at: claimedAt, log_sha: result.content.sha, log_commit_sha: result.commit.sha };
    } catch (err) {
      lastErr = err;
      if (isShaConflict(err)) continue;
      throw err;
    }
  }
  throw new Error(`claim conflict after ${MAX_CLAIM_RETRIES} retries: ${(lastErr && lastErr.message) || 'unknown'}`);
}

async function claimResponseAtomic({ parentN, parentDate, platform, agent, title }) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_CLAIM_RETRIES; attempt++) {
    try {
      let file = await ghGetFile(ARCHIVE_REPO, PROMPT_LOG_PATH);
      if (!file) throw new Error(`${PROMPT_LOG_PATH} not found in ${ARCHIVE_REPO}`);
      file = await maybeSweepAndCommit(file);
      const { sha, content } = file;
      const existing = findResponsesForParent(content, parentDate, parentN);
      const next = existing.length ? nextAlphabetic(highestLetterFrom(existing)) : 'a';
      const id = `${parentDate}-${parentN}${next}`;
      const claimedAt = new Date().toISOString();
      const row = buildPromptRow({
        id, type: 'RESPONSE',
        dateISO: todayISODate(),
        title, platform, agent,
        status: 'claimed',
        note: `parent: ${parentDate}-${parentN}`,
        claimedAt,
      });
      const newContent = insertRowAtTopOfLog(content, row);
      const result = await ghPut(`/repos/${GITHUB_ORG}/${ARCHIVE_REPO}/contents/${PROMPT_LOG_PATH}`, {
        message: `claim RESPONSE ${id}${title ? ` (${title})` : ''}`,
        content: Buffer.from(newContent, 'utf-8').toString('base64'),
        sha,
      });
      return { letter: next, parent: `${parentDate}-${parentN}`, id, claimed_at: claimedAt, log_sha: result.content.sha, log_commit_sha: result.commit.sha };
    } catch (err) {
      lastErr = err;
      if (isShaConflict(err)) continue;
      throw err;
    }
  }
  throw new Error(`claim conflict after ${MAX_CLAIM_RETRIES} retries: ${(lastErr && lastErr.message) || 'unknown'}`);
}

async function updatePromptStatusAtomic({ id, status, commitSha, note }) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_CLAIM_RETRIES; attempt++) {
    try {
      let file = await ghGetFile(ARCHIVE_REPO, PROMPT_LOG_PATH);
      if (!file) throw new Error(`${PROMPT_LOG_PATH} not found in ${ARCHIVE_REPO}`);
      file = await maybeSweepAndCommit(file);
      const { sha, content } = file;
      if (!content.includes(`| ${id} |`)) {
        const err = new Error(`row not found: ${id}`);
        err.notFound = true;
        throw err;
      }
      // Reject transitions on `expired` rows (TTL has retired the number).
      const lines = content.split('\n');
      for (const line of lines) {
        if (!line.startsWith(`| ${id} |`)) continue;
        const row = parseLogRow(line);
        if (row && row.status === 'expired') {
          const err = new Error('cannot transition expired claim');
          err.expired = true;
          err.expiredId = id;
          throw err;
        }
        break;
      }
      const newContent = updateRowStatus(content, id, status, commitSha, note);
      if (newContent === null) throw new Error(`row not modified: ${id}`);
      const result = await ghPut(`/repos/${GITHUB_ORG}/${ARCHIVE_REPO}/contents/${PROMPT_LOG_PATH}`, {
        message: `update ${id}: ${status}${commitSha ? ` (${String(commitSha).slice(0, 7)})` : ''}`,
        content: Buffer.from(newContent, 'utf-8').toString('base64'),
        sha,
      });
      return { status: 'updated', id, new_status: status, log_commit_sha: result.commit.sha };
    } catch (err) {
      lastErr = err;
      if (err.notFound || err.expired) throw err;
      if (isShaConflict(err)) continue;
      throw err;
    }
  }
  throw new Error(`update conflict after ${MAX_CLAIM_RETRIES} retries: ${(lastErr && lastErr.message) || 'unknown'}`);
}

// Auto-fetch the current sha + content for an existing file. Returns
// {sha, content} for files, null for missing, throws for directories.
// Used by write_file (for sha + idempotency check) and delete_file (sha only).
async function ghGetFile(repo, path, branch) {
  const ref = branch ? `?ref=${encodeURIComponent(branch)}` : '';
  const url = `${GITHUB_API}/repos/${GITHUB_ORG}/${repo}/contents/${path}${ref}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub GET ${res.status}: ${body}`);
  }
  const data = await res.json();
  if (Array.isArray(data)) throw new Error(`${path} is a directory, not a file`);
  return { sha: data.sha, content: Buffer.from(data.content, 'base64').toString('utf-8') };
}

// Backwards-compatible wrapper — old name returns just sha.
async function ghGetSha(repo, path, branch) {
  const f = await ghGetFile(repo, path, branch);
  return f ? f.sha : null;
}

// --- Lazy-agent-friendly helpers ---

// Strip leading / trailing slashes and whitespace. GitHub Contents API
// rejects paths with leading slashes; common agent mistake.
function normalizePath(p) {
  if (typeof p !== 'string') return p;
  return p.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

// Build a sensible default commit message if the caller didn't supply one.
function defaultMessage(op, repo, path) {
  return `[linksblue] ${op} ${path}`;
}

// --- Write-endpoint security: bearer auth + repo allow-list ---
// WRITE_ALLOWED_REPOS supports three modes:
//   - "*"          → any repo in the GITHUB_ORG is writable (use with care)
//   - "a,b,c"      → only listed repos are writable
//   - unset/empty  → all writes denied
function getAllowedRepos() {
  const raw = (process.env.WRITE_ALLOWED_REPOS || '').trim();
  if (raw === '*') return '*';
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function isRepoAllowed(repo) {
  const allowed = getAllowedRepos();
  if (allowed === '*') return true;
  if (allowed.length === 0) return false;
  return allowed.includes(repo);
}

function repoDenialReason(repo) {
  const allowed = getAllowedRepos();
  if (allowed === '*') return null;
  if (allowed.length === 0) return 'no repos in WRITE_ALLOWED_REPOS — writes disabled';
  return `repo "${repo}" not in WRITE_ALLOWED_REPOS`;
}

function requireWriteKey(req, res, next) {
  const expected = process.env.LINKSBLUE_WRITE_KEY;
  const got = req.headers.authorization || '';
  if (!expected) return res.status(401).json({ error: 'write endpoint disabled — LINKSBLUE_WRITE_KEY not configured' });
  if (got !== `Bearer ${expected}`) return res.status(401).json({ error: 'unauthorized' });
  next();
}

function requireAllowedRepo(req, res, next) {
  const repo = (req.body && req.body.repo) || req.query.repo;
  if (!repo) return res.status(400).json({ error: 'repo required' });
  if (!isRepoAllowed(repo)) return res.status(403).json({ error: repoDenialReason(repo) });
  next();
}

function logWrite(op, req, extra = {}) {
  const ts = new Date().toISOString();
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const repo = (req.body && req.body.repo) || req.query.repo || '?';
  const path = (req.body && req.body.path) || req.query.path || '?';
  const auth = req.headers.authorization || '';
  const authHash = auth ? crypto.createHash('sha256').update(auth).digest('hex').slice(0, 8) : 'none';
  const size = req.body && req.body.content ? Buffer.byteLength(req.body.content, 'utf-8') : 0;
  console.log(`[${ts}] WRITE ${op} repo=${repo} path=${path} bytes=${size} ip=${ip} auth=${authHash} ${JSON.stringify(extra)}`);
}

// --- In-memory event store for session resumability ---
class InMemoryEventStore {
  constructor() {
    this.events = new Map();
  }

  async storeEvent(streamId, message) {
    const eventId = `${streamId}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    this.events.set(eventId, { streamId, message });
    if (this.events.size > 1000) {
      const keys = [...this.events.keys()];
      for (let i = 0; i < keys.length - 1000; i++) {
        this.events.delete(keys[i]);
      }
    }
    return eventId;
  }

  async replayEventsAfter(lastEventId, { send }) {
    if (!lastEventId || !this.events.has(lastEventId)) return '';
    const parts = lastEventId.split('_');
    const streamId = parts.length > 0 ? parts[0] : '';
    if (!streamId) return '';
    let foundLast = false;
    const sorted = [...this.events.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [eventId, { streamId: sid, message }] of sorted) {
      if (sid !== streamId) continue;
      if (eventId === lastEventId) { foundLast = true; continue; }
      if (foundLast) await send(eventId, message);
    }
    return streamId;
  }
}

// --- MCP Server setup ---
function createMcpServer() {
  const server = new McpServer({
    name: 'triadblue-github',
    version: '1.0.0',
  });

  server.tool('list_repos', 'List all repositories in the TRIADBLUE org', {}, async () => {
    const repos = await ghFetch(`/orgs/${GITHUB_ORG}/repos?per_page=100`);
    const summary = repos.map(r => ({
      name: r.name,
      description: r.description,
      language: r.language,
      updated_at: r.updated_at,
      html_url: r.html_url,
      default_branch: r.default_branch,
      private: r.private,
    }));
    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
  });

  server.tool('get_repo', 'Get details about a specific repo', {
    repo: z.string().describe('Repository name'),
  }, async ({ repo }) => {
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('list_files', 'List files and directories in a repo path', {
    repo: z.string().describe('Repository name'),
    path: z.string().optional().describe('Directory path (empty for root)'),
  }, async ({ repo, path }) => {
    const p = path || '';
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/contents/${p}`);
    const listing = Array.isArray(data)
      ? data.map(f => ({ name: f.name, type: f.type, size: f.size, path: f.path }))
      : [{ name: data.name, type: data.type, size: data.size, path: data.path }];
    return { content: [{ type: 'text', text: JSON.stringify(listing, null, 2) }] };
  });

  server.tool('read_file', 'Read the contents of a file in a repo', {
    repo: z.string().describe('Repository name'),
    path: z.string().describe('File path'),
  }, async ({ repo, path }) => {
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/contents/${path}`);
    if (data.type !== 'file') {
      return { content: [{ type: 'text', text: `Error: ${path} is a ${data.type}, not a file` }], isError: true };
    }
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    return { content: [{ type: 'text', text: content }] };
  });

  server.tool('list_branches', 'List branches of a repo', {
    repo: z.string().describe('Repository name'),
  }, async ({ repo }) => {
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/branches?per_page=100`);
    const branches = data.map(b => ({ name: b.name, sha: b.commit.sha }));
    return { content: [{ type: 'text', text: JSON.stringify(branches, null, 2) }] };
  });

  server.tool('list_issues', 'List open issues for a repo', {
    repo: z.string().describe('Repository name'),
    state: z.enum(['open', 'closed', 'all']).optional().describe('Issue state filter'),
  }, async ({ repo, state }) => {
    const s = state || 'open';
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/issues?state=${s}&per_page=50`);
    const issues = data.map(i => ({
      number: i.number,
      title: i.title,
      state: i.state,
      user: i.user.login,
      created_at: i.created_at,
      labels: i.labels.map(l => l.name),
    }));
    return { content: [{ type: 'text', text: JSON.stringify(issues, null, 2) }] };
  });

  server.tool('list_pulls', 'List pull requests for a repo', {
    repo: z.string().describe('Repository name'),
    state: z.enum(['open', 'closed', 'all']).optional().describe('PR state filter'),
  }, async ({ repo, state }) => {
    const s = state || 'open';
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/pulls?state=${s}&per_page=50`);
    const prs = data.map(p => ({
      number: p.number,
      title: p.title,
      state: p.state,
      user: p.user.login,
      created_at: p.created_at,
      head: p.head.ref,
      base: p.base.ref,
    }));
    return { content: [{ type: 'text', text: JSON.stringify(prs, null, 2) }] };
  });

  server.tool('search_code', 'Search for code across all TRIADBLUE repos', {
    query: z.string().describe('Search query (code, filename, etc.)'),
  }, async ({ query }) => {
    const data = await ghFetch(`/search/code?q=${encodeURIComponent(query)}+org:${GITHUB_ORG}&per_page=20`);
    const results = data.items.map(i => ({
      repo: i.repository.full_name,
      file: i.path,
      url: i.html_url,
    }));
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  });

  // --- WRITE TOOLS — gated by allow-list (NOT by bearer in MCP, since MCP transport handles auth at the connector layer) ---

  server.tool('write_file', 'Create or update a file. DEFAULT TOOL FOR WRITING. Just give repo, path, content — sha is auto-fetched if the file exists, message defaults to "[linksblue] update <path>" if omitted, branch defaults to the repo default. Returns {status: created|updated|unchanged}. If content matches what is already there, returns "unchanged" without making a no-op commit.', {
    repo: z.string().describe('Repository name (e.g. "triadblue.rulebook")'),
    path: z.string().describe('File path. Leading slash is fine — it will be normalized.'),
    content: z.string().describe('Plain UTF-8 file content. Base64 encoding is handled server-side.'),
    message: z.string().optional().describe('Commit message. Defaults to "[linksblue] update <path>" or "create <path>".'),
    branch: z.string().optional().describe('Branch to commit to. Defaults to the repo default branch.'),
    sha: z.string().optional().describe('Sha of the file being replaced. Auto-fetched if omitted — leave empty unless you need to assert a specific version.'),
  }, async ({ repo, path, content, message, branch, sha }) => {
    if (!isRepoAllowed(repo)) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: repoDenialReason(repo) }) }], isError: true };
    }
    try {
      const normPath = normalizePath(path);
      let resolvedSha = sha;
      let existingContent = null;
      if (!resolvedSha) {
        const existing = await ghGetFile(repo, normPath, branch);
        if (existing) {
          resolvedSha = existing.sha;
          existingContent = existing.content;
        }
      }
      // Idempotency: skip the commit if the content already matches.
      if (existingContent !== null && existingContent === content) {
        const ts = new Date().toISOString();
        console.log(`[${ts}] WRITE write_file (mcp) repo=${repo} path=${normPath} unchanged`);
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'unchanged', path: normPath }, null, 2) }] };
      }
      const op = resolvedSha ? 'update' : 'create';
      const body = {
        message: message || defaultMessage(op, repo, normPath),
        content: Buffer.from(content, 'utf-8').toString('base64'),
      };
      if (resolvedSha) body.sha = resolvedSha;
      if (branch) body.branch = branch;
      const result = await ghPut(`/repos/${GITHUB_ORG}/${repo}/contents/${normPath}`, body);
      const ts = new Date().toISOString();
      console.log(`[${ts}] WRITE write_file (mcp) repo=${repo} path=${normPath} bytes=${Buffer.byteLength(content, 'utf-8')} op=${op} sha=${result.commit.sha.slice(0,7)}`);
      return { content: [{ type: 'text', text: JSON.stringify({ status: resolvedSha ? 'updated' : 'created', path: result.content.path, sha: result.content.sha, commit_sha: result.commit.sha }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  });

  server.tool('delete_file', 'Delete a file. Just give repo, path. Sha is auto-fetched. Message defaults to "[linksblue] delete <path>" if omitted. Returns {status: deleted} or 404 if the file does not exist.', {
    repo: z.string().describe('Repository name'),
    path: z.string().describe('File path. Leading slash is fine — it will be normalized.'),
    message: z.string().optional().describe('Commit message. Defaults to "[linksblue] delete <path>".'),
    branch: z.string().optional().describe('Branch to delete from. Defaults to the repo default branch.'),
    sha: z.string().optional().describe('Sha of the file. Auto-fetched if omitted.'),
  }, async ({ repo, path, message, branch, sha }) => {
    if (!isRepoAllowed(repo)) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: repoDenialReason(repo) }) }], isError: true };
    }
    try {
      const normPath = normalizePath(path);
      let resolvedSha = sha;
      if (!resolvedSha) resolvedSha = await ghGetSha(repo, normPath, branch);
      if (!resolvedSha) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `file not found: ${normPath}` }) }], isError: true };
      }
      const body = { message: message || defaultMessage('delete', repo, normPath), sha: resolvedSha };
      if (branch) body.branch = branch;
      const result = await ghDeleteContents(`/repos/${GITHUB_ORG}/${repo}/contents/${normPath}`, body);
      const ts = new Date().toISOString();
      console.log(`[${ts}] WRITE delete_file (mcp) repo=${repo} path=${normPath} sha=${result.commit.sha.slice(0,7)}`);
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'deleted', path: normPath, commit_sha: result.commit.sha }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  });

  server.tool('create_branch', 'Create a new branch. Just give repo and the new branch name — defaults to branching off the repo default branch HEAD. Returns {status: created, branch, sha}.', {
    repo: z.string().describe('Repository name'),
    name: z.string().describe('New branch name'),
    from_sha: z.string().optional().describe('Specific sha to branch from. Optional.'),
    from_branch: z.string().optional().describe('Branch to copy from. Defaults to repo default branch if both from_sha and from_branch are omitted.'),
  }, async ({ repo, name, from_sha, from_branch }) => {
    if (!isRepoAllowed(repo)) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: repoDenialReason(repo) }) }], isError: true };
    }
    try {
      let sha = from_sha;
      if (!sha) {
        const sourceBranch = from_branch || (await ghFetch(`/repos/${GITHUB_ORG}/${repo}`)).default_branch;
        const refData = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/git/ref/heads/${sourceBranch}`);
        sha = refData.object.sha;
      }
      const result = await ghPost(`/repos/${GITHUB_ORG}/${repo}/git/refs`, {
        ref: `refs/heads/${name}`,
        sha,
      });
      const ts = new Date().toISOString();
      console.log(`[${ts}] WRITE create_branch (mcp) repo=${repo} branch=${name} from=${sha.slice(0,7)}`);
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'created', branch: name, sha, ref: result.ref }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  });

  server.tool('move_file', 'Rename or move a file in one tool call. Reads source, writes to destination, deletes source — TWO commits server-side, but the agent only calls one tool. Defaults to "[linksblue] move <from> -> <to>" message.', {
    repo: z.string().describe('Repository name'),
    from_path: z.string().describe('Current file path'),
    to_path: z.string().describe('New file path'),
    message: z.string().optional().describe('Commit message. Defaults to "[linksblue] move <from> -> <to>".'),
    branch: z.string().optional().describe('Branch. Defaults to repo default.'),
  }, async ({ repo, from_path, to_path, message, branch }) => {
    if (!isRepoAllowed(repo)) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: repoDenialReason(repo) }) }], isError: true };
    }
    try {
      const fromNorm = normalizePath(from_path);
      const toNorm = normalizePath(to_path);
      if (fromNorm === toNorm) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'from_path and to_path are identical after normalization' }) }], isError: true };
      }
      const source = await ghGetFile(repo, fromNorm, branch);
      if (!source) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `source file not found: ${fromNorm}` }) }], isError: true };
      }
      const msg = message || `[linksblue] move ${fromNorm} -> ${toNorm}`;
      // Step 1: write to new location
      const writeBody = {
        message: `${msg} (write)`,
        content: Buffer.from(source.content, 'utf-8').toString('base64'),
      };
      if (branch) writeBody.branch = branch;
      const writeResult = await ghPut(`/repos/${GITHUB_ORG}/${repo}/contents/${toNorm}`, writeBody);
      // Step 2: delete from old location
      const deleteBody = { message: `${msg} (delete)`, sha: source.sha };
      if (branch) deleteBody.branch = branch;
      const deleteResult = await ghDeleteContents(`/repos/${GITHUB_ORG}/${repo}/contents/${fromNorm}`, deleteBody);
      const ts = new Date().toISOString();
      console.log(`[${ts}] WRITE move_file (mcp) repo=${repo} ${fromNorm} -> ${toNorm} write=${writeResult.commit.sha.slice(0,7)} delete=${deleteResult.commit.sha.slice(0,7)}`);
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'moved', from: fromNorm, to: toNorm, write_commit: writeResult.commit.sha, delete_commit: deleteResult.commit.sha }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  });

  server.tool('list_commits', 'List recent commits for a repo', {
    repo: z.string().describe('Repository name'),
    branch: z.string().optional().describe('Branch name (defaults to main)'),
  }, async ({ repo, branch }) => {
    const b = branch ? `&sha=${branch}` : '';
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/commits?per_page=20${b}`);
    const commits = data.map(c => ({
      sha: c.sha.slice(0, 7),
      message: c.commit.message.split('\n')[0],
      author: c.commit.author.name,
      date: c.commit.author.date,
    }));
    return { content: [{ type: 'text', text: JSON.stringify(commits, null, 2) }] };
  });

  // --- v2.6: ATOMIC MULTI-FILE COMMITS via Git Data API ---

  server.tool('push_files', 'Atomically commit MULTIPLE files in ONE commit. Use this instead of calling write_file multiple times when changes belong together — produces a single commit, single deploy. Files: array of {path, content}. Returns {commit_sha, files_changed}.', {
    repo: z.string().describe('Repository name'),
    files: z.array(z.object({
      path: z.string().describe('File path within the repo'),
      content: z.string().describe('Plain UTF-8 file content'),
    })).describe('List of files to write or update — minimum 1, no upper limit'),
    message: z.string().optional().describe('Commit message. Defaults to "[linksblue] push N files".'),
    branch: z.string().optional().describe('Branch. Defaults to repo default.'),
  }, async ({ repo, files, message, branch }) => {
    if (!isRepoAllowed(repo)) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: repoDenialReason(repo) }) }], isError: true };
    }
    if (!Array.isArray(files) || files.length === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'files must be a non-empty array of {path, content}' }) }], isError: true };
    }
    try {
      const result = await pushFilesAtomic(repo, files, message, branch);
      const ts = new Date().toISOString();
      console.log(`[${ts}] WRITE push_files (mcp) repo=${repo} count=${files.length} commit=${result.commit_sha.slice(0,7)}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  });

  // --- v2.6: REFS — generic create_ref (branches AND tags) ---

  server.tool('create_ref', 'Create any git ref — branch (refs/heads/X) or tag (refs/tags/X). Use this for tags; for plain branches you can also use create_branch. ref must include the full path like "refs/tags/v1.0" or "refs/heads/feature-x".', {
    repo: z.string().describe('Repository name'),
    ref: z.string().describe('Full ref path, e.g. "refs/tags/v1.0" or "refs/heads/feature-x"'),
    sha: z.string().describe('Commit sha to point the ref at'),
  }, async ({ repo, ref, sha }) => {
    if (!isRepoAllowed(repo)) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: repoDenialReason(repo) }) }], isError: true };
    }
    try {
      const result = await ghPost(`/repos/${GITHUB_ORG}/${repo}/git/refs`, { ref, sha });
      const ts = new Date().toISOString();
      console.log(`[${ts}] WRITE create_ref (mcp) repo=${repo} ref=${ref} sha=${sha.slice(0,7)}`);
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'created', ref: result.ref, sha: result.object.sha }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  });

  // --- v2.6: PULL REQUESTS — staging→PR→merge workflow ---

  server.tool('create_pull_request', 'Open a PR from a head branch into a base branch. Returns {number, url, state}.', {
    repo: z.string().describe('Repository name'),
    title: z.string().describe('PR title'),
    head: z.string().describe('Source branch (the branch with the changes)'),
    base: z.string().optional().describe('Target branch. Defaults to repo default branch.'),
    body: z.string().optional().describe('PR description (markdown). Defaults to empty.'),
    draft: z.boolean().optional().describe('Open as draft PR. Defaults to false.'),
  }, async ({ repo, title, head, base, body, draft }) => {
    if (!isRepoAllowed(repo)) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: repoDenialReason(repo) }) }], isError: true };
    }
    try {
      const targetBase = base || (await ghFetch(`/repos/${GITHUB_ORG}/${repo}`)).default_branch;
      const result = await ghPost(`/repos/${GITHUB_ORG}/${repo}/pulls`, {
        title, head, base: targetBase, body: body || '', draft: !!draft,
      });
      const ts = new Date().toISOString();
      console.log(`[${ts}] WRITE create_pull_request (mcp) repo=${repo} #${result.number} ${head}->${targetBase}`);
      return { content: [{ type: 'text', text: JSON.stringify({ number: result.number, url: result.html_url, state: result.state, head: result.head.ref, base: result.base.ref }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  });

  server.tool('merge_pull_request', 'Merge an open PR. merge_method: "merge" (default — merge commit), "squash", or "rebase".', {
    repo: z.string().describe('Repository name'),
    number: z.number().int().describe('PR number'),
    commit_title: z.string().optional().describe('Merge commit title'),
    commit_message: z.string().optional().describe('Merge commit body'),
    merge_method: z.enum(['merge', 'squash', 'rebase']).optional().describe('How to merge'),
  }, async ({ repo, number, commit_title, commit_message, merge_method }) => {
    if (!isRepoAllowed(repo)) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: repoDenialReason(repo) }) }], isError: true };
    }
    try {
      const body = {};
      if (commit_title) body.commit_title = commit_title;
      if (commit_message) body.commit_message = commit_message;
      if (merge_method) body.merge_method = merge_method;
      const result = await ghPut(`/repos/${GITHUB_ORG}/${repo}/pulls/${number}/merge`, body);
      const ts = new Date().toISOString();
      console.log(`[${ts}] WRITE merge_pull_request (mcp) repo=${repo} #${number} sha=${result.sha.slice(0,7)} method=${merge_method || 'merge'}`);
      return { content: [{ type: 'text', text: JSON.stringify({ merged: result.merged, sha: result.sha, message: result.message }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  });

  // --- v2.6: ISSUES — for Phase 3 weekly archive audit and similar reports ---

  server.tool('create_issue', 'Open a new issue. Returns {number, url}.', {
    repo: z.string().describe('Repository name'),
    title: z.string().describe('Issue title'),
    body: z.string().optional().describe('Issue body (markdown)'),
    labels: z.array(z.string()).optional().describe('Label names to apply'),
    assignees: z.array(z.string()).optional().describe('GitHub usernames to assign'),
  }, async ({ repo, title, body, labels, assignees }) => {
    if (!isRepoAllowed(repo)) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: repoDenialReason(repo) }) }], isError: true };
    }
    try {
      const payload = { title };
      if (body) payload.body = body;
      if (labels && labels.length) payload.labels = labels;
      if (assignees && assignees.length) payload.assignees = assignees;
      const result = await ghPost(`/repos/${GITHUB_ORG}/${repo}/issues`, payload);
      const ts = new Date().toISOString();
      console.log(`[${ts}] WRITE create_issue (mcp) repo=${repo} #${result.number}`);
      return { content: [{ type: 'text', text: JSON.stringify({ number: result.number, url: result.html_url, state: result.state }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  });

  server.tool('update_issue', 'Update an existing issue (close, reopen, edit title/body, add/remove labels).', {
    repo: z.string().describe('Repository name'),
    number: z.number().int().describe('Issue number'),
    title: z.string().optional().describe('New title'),
    body: z.string().optional().describe('New body'),
    state: z.enum(['open', 'closed']).optional().describe('Set state'),
    labels: z.array(z.string()).optional().describe('Replace labels with this set'),
    assignees: z.array(z.string()).optional().describe('Replace assignees'),
  }, async ({ repo, number, title, body, state, labels, assignees }) => {
    if (!isRepoAllowed(repo)) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: repoDenialReason(repo) }) }], isError: true };
    }
    try {
      const payload = {};
      if (title !== undefined) payload.title = title;
      if (body !== undefined) payload.body = body;
      if (state !== undefined) payload.state = state;
      if (labels !== undefined) payload.labels = labels;
      if (assignees !== undefined) payload.assignees = assignees;
      const result = await ghPatch(`/repos/${GITHUB_ORG}/${repo}/issues/${number}`, payload);
      const ts = new Date().toISOString();
      console.log(`[${ts}] WRITE update_issue (mcp) repo=${repo} #${number} state=${result.state}`);
      return { content: [{ type: 'text', text: JSON.stringify({ number: result.number, url: result.html_url, state: result.state }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  });

  server.tool('add_issue_comment', 'Comment on an issue or PR (issues and PRs share a comment endpoint).', {
    repo: z.string().describe('Repository name'),
    number: z.number().int().describe('Issue or PR number'),
    body: z.string().describe('Comment body (markdown)'),
  }, async ({ repo, number, body }) => {
    if (!isRepoAllowed(repo)) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: repoDenialReason(repo) }) }], isError: true };
    }
    try {
      const result = await ghPost(`/repos/${GITHUB_ORG}/${repo}/issues/${number}/comments`, { body });
      const ts = new Date().toISOString();
      console.log(`[${ts}] WRITE add_issue_comment (mcp) repo=${repo} #${number} comment=${result.id}`);
      return { content: [{ type: 'text', text: JSON.stringify({ id: result.id, url: result.html_url }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  });

  // --- v2.7: PROMPT NUMBERING — atomic claim against ai-archive/PROMPT_LOG.md ---

  server.tool('claim_number', 'CLAIM A NEW PROMPT OR SEGUE NUMBER. Atomic. Reads the master log in TRIADBLUE/ai-archive/PROMPT_LOG.md, finds the highest N, claims N+1, writes a row with status=claimed, returns the assigned id. NEVER guess a number — always claim. After firing, call update_prompt_status to mark "fired"; after commit, "committed" with the commit SHA; after verification, "verified".', {
    type: z.enum(['PROMPT', 'SEGUE']).describe('PROMPT for new work, SEGUE for session-boundary handoff'),
    platform: z.string().describe('"Executing for Platform" header value, e.g. "businessblueprint.io" or "TRIADBLUE"'),
    agent: z.string().describe('Who is making the claim, e.g. "Claude Code (Mac)" or "Cowork" or "Claude web chat"'),
    title: z.string().optional().describe('Short title of the prompt or segue'),
    covers_prompts: z.array(z.string()).optional().describe('SEGUE only: list of prompt IDs this segue covers (e.g. ["04/29/2026-3", "04/29/2026-4"])'),
  }, async ({ type, platform, agent, title, covers_prompts }) => {
    try {
      const result = await claimNumberAtomic({ type, platform, agent, title, coversPrompts: covers_prompts });
      const ts = new Date().toISOString();
      console.log(`[${ts}] CLAIM ${type} (mcp) id=${result.id} agent="${agent}"`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  });

  server.tool('claim_response', 'CLAIM A RESPONSE LETTER (a, b, c, ...) under an existing parent prompt. Responses do NOT increment N — they letter-suffix the parent. Atomic. Reads PROMPT_LOG.md, finds the parent row, computes the next available letter, writes a row.', {
    parent_n: z.number().int().describe('Parent prompt N (e.g. 8 for parent 04/29/2026-8)'),
    parent_date: z.string().describe('Parent prompt date in MM/DD/YYYY format'),
    platform: z.string().describe('"Executing for Platform" header value'),
    agent: z.string().describe('Who is making the claim'),
    title: z.string().optional().describe('Short title of the response'),
  }, async ({ parent_n, parent_date, platform, agent, title }) => {
    try {
      const result = await claimResponseAtomic({ parentN: parent_n, parentDate: parent_date, platform, agent, title });
      const ts = new Date().toISOString();
      console.log(`[${ts}] CLAIM RESPONSE (mcp) id=${result.id} agent="${agent}"`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  });

  server.tool('update_prompt_status', 'Update the status of a row in PROMPT_LOG.md. Use the lifecycle: claimed → fired → committed → verified. (Or → abandoned if the work is dropped.)', {
    id: z.string().describe('Full prompt ID, e.g. "05/03/2026-13"'),
    status: z.enum(['claimed', 'fired', 'committed', 'verified', 'abandoned']).describe('New status'),
    commit_sha: z.string().optional().describe('Commit SHA. Required when status=committed or verified.'),
    note: z.string().optional().describe('Optional note appended to the row'),
  }, async ({ id, status, commit_sha, note }) => {
    try {
      const result = await updatePromptStatusAtomic({ id, status, commitSha: commit_sha, note });
      const ts = new Date().toISOString();
      console.log(`[${ts}] UPDATE_STATUS (mcp) id=${id} status=${status}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  });

  // --- v2.6: ESCAPE HATCH — generic GitHub API passthrough ---
  // Trust model: caller has bearer + the proxy's GITHUB_TOKEN governs what the
  // call can actually do at GitHub. Path is logged in full.

  server.tool('gh_api', 'ESCAPE HATCH. Call any GitHub REST API path with the proxy GITHUB_TOKEN. Use ONLY when no specialized tool exists. Method must be GET, POST, PATCH, PUT, or DELETE. path is the URL path after https://api.github.com (e.g. "/rate_limit", "/repos/X/Y/actions/workflows"). Body is optional JSON for non-GET requests.', {
    method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']).describe('HTTP method'),
    path: z.string().describe('GitHub API path, must start with "/"'),
    body: z.any().optional().describe('Request body for POST/PATCH/PUT/DELETE. Optional.'),
  }, async ({ method, path, body }) => {
    if (typeof path !== 'string' || !path.startsWith('/')) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'path must be a string starting with "/"' }) }], isError: true };
    }
    try {
      const url = `${GITHUB_API}${path}`;
      const opts = { method, headers: { ...ghHeaders(), 'Content-Type': 'application/json' } };
      if (body !== undefined && method !== 'GET') opts.body = JSON.stringify(body);
      const res = await fetch(url, opts);
      const text = await res.text();
      const ts = new Date().toISOString();
      console.log(`[${ts}] WRITE gh_api (mcp) ${method} ${path} → ${res.status}`);
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      if (!res.ok) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `GitHub ${method} ${res.status}`, body: parsed }) }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ status: res.status, body: parsed }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  });

  return server;
}

// --- MCP session management ---
const sessions = new Map(); // sessionId -> { server, transport, createdAt }
const eventStore = new InMemoryEventStore();

function isInitializeRequest(body) {
  if (Array.isArray(body)) return body.some(m => m.method === 'initialize');
  return body?.method === 'initialize';
}

function getSessionId(req) {
  return req.headers['mcp-session-id'] || req.headers['Mcp-Session-Id'];
}

// Session cleanup disabled — clients don't reliably re-initialize after expiry

async function handleMcpPost(req, res) {
  const ts = new Date().toISOString();
  const method = Array.isArray(req.body) ? req.body.map(m => m.method).join(',') : req.body?.method;
  const sessionId = getSessionId(req);
  const isInit = isInitializeRequest(req.body);
  console.log(`[${ts}] MCP POST method=${method} session=${sessionId || 'none'}${isInit ? ' (init)' : ''}`);

  try {
    // Existing session — forward request
    if (sessionId && sessions.has(sessionId)) {
      console.log(`[${ts}] MCP → reusing session ${sessionId}`);
      const { transport } = sessions.get(sessionId);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // Initialize — create a fresh session whether or not a (likely-stale) ID was sent.
    // v2.9: previously this branch required `!sessionId`, which rejected init requests
    // that included a stale session ID from a previous server lifetime. Now we accept
    // init regardless and let the transport mint a new ID.
    if (isInit) {
      if (sessionId) {
        console.log(`[${ts}] MCP → init with stale session ID ${sessionId}; minting fresh session`);
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        eventStore,
        enableJsonResponse: true, // JSON not SSE — avoids stream close killing session
        onsessioninitialized: (sid) => {
          sessions.set(sid, { server, transport, createdAt: Date.now() });
          console.log(`[${ts}] MCP session created: ${sid} (total: ${sessions.size})`);
        },
        onsessionclosed: (sid) => {
          sessions.delete(sid);
          console.log(`[${ts}] MCP session explicitly closed: ${sid}`);
        },
      });
      const server = createMcpServer();

      // DO NOT set transport.onclose — that fires on every stream end
      // and was killing sessions immediately. Use onsessionclosed instead.

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // Session not found AND request is not an initialize.
    // v2.9: return 404 (was 400) with restart_hint so well-behaved MCP clients
    // drop their cached session ID and re-initialize transparently. This is the
    // common case after a Railway redeploy wipes the in-memory session map.
    console.log(`[${ts}] MCP → session not found: ${sessionId}, active=[${[...sessions.keys()].join(', ')}]; returning 404 with restart hint to trigger client re-init`);
    res.status(404).json({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: 'Session not found — server likely restarted since this session was created. Please re-initialize.',
        data: { restart_hint: true },
      },
      id: (req.body && !Array.isArray(req.body) && req.body.id !== undefined) ? req.body.id : null,
    });
  } catch (err) {
    console.error(`[${ts}] MCP POST error:`, err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  }
}

async function handleMcpGet(req, res) {
  const ts = new Date().toISOString();
  const sessionId = getSessionId(req);
  console.log(`[${ts}] MCP GET session=${sessionId || 'none'}`);

  if (sessionId && sessions.has(sessionId)) {
    const { transport } = sessions.get(sessionId);
    await transport.handleRequest(req, res);
    return;
  }

  // No valid session — return 405 with Allow header
  // (tells Claude "use POST, server is fine" — NOT 501 which means "broken")
  res.setHeader('Allow', 'POST, HEAD');
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed — use POST' },
    id: null,
  });
}

async function handleMcpDelete(req, res) {
  const ts = new Date().toISOString();
  const sessionId = getSessionId(req);
  console.log(`[${ts}] MCP DELETE session=${sessionId || 'none'}`);

  if (sessionId && sessions.has(sessionId)) {
    const { transport } = sessions.get(sessionId);
    await transport.handleRequest(req, res);
    return;
  }

  res.status(404).json({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Session not found' },
    id: null,
  });
}

function handleMcpHead(req, res) {
  res.setHeader('MCP-Protocol-Version', '2025-11-25');
  res.setHeader('Content-Type', 'application/json');
  res.sendStatus(200);
}

// --- Mount MCP on /mcp (HEAD first so Express doesn't auto-handle via GET) ---
app.head('/mcp', handleMcpHead);
app.post('/mcp', handleMcpPost);
app.get('/mcp', handleMcpGet);
app.delete('/mcp', handleMcpDelete);

// --- Mount MCP on root / too (Claude.ai may use root path) ---
app.head('/', handleMcpHead);
app.post('/', handleMcpPost);
app.delete('/', handleMcpDelete);

// --- REST endpoints for GitHub API ---
app.get('/api/github/repos', async (req, res) => {
  try {
    const repos = await ghFetch(`/orgs/${GITHUB_ORG}/repos?per_page=100`);
    const summary = repos.map(r => ({ name: r.name, description: r.description, language: r.language, updated_at: r.updated_at, html_url: r.html_url }));
    res.json(summary);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/github/files', async (req, res) => {
  const { repo, path } = req.query;
  if (!repo) return res.status(400).json({ error: 'repo parameter required' });
  try {
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/contents/${path || ''}`);
    const listing = Array.isArray(data)
      ? data.map(f => ({ name: f.name, type: f.type, size: f.size, path: f.path }))
      : [{ name: data.name, type: data.type, size: data.size, path: data.path }];
    res.json(listing);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/github/file', async (req, res) => {
  const { repo, path } = req.query;
  if (!repo || !path) return res.status(400).json({ error: 'repo and path parameters required' });
  try {
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/contents/${path}`);
    if (data.type !== 'file') return res.status(400).json({ error: `${path} is a ${data.type}, not a file` });
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    res.type('text/plain').send(content);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/github/commits', async (req, res) => {
  const { repo, branch } = req.query;
  if (!repo) return res.status(400).json({ error: 'repo parameter required' });
  try {
    const b = branch ? `&sha=${branch}` : '';
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/commits?per_page=20${b}`);
    const commits = data.map(c => ({ sha: c.sha.slice(0, 7), message: c.commit.message.split('\n')[0], author: c.commit.author.name, date: c.commit.author.date }));
    res.json(commits);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/github/branches', async (req, res) => {
  const { repo } = req.query;
  if (!repo) return res.status(400).json({ error: 'repo parameter required' });
  try {
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/branches?per_page=100`);
    const branches = data.map(b => ({ name: b.name, sha: b.commit.sha }));
    res.json(branches);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Grep: search within a single file, return matching lines ---
app.get('/api/github/grep', async (req, res) => {
  const { repo, path, q } = req.query;
  if (!repo || !path || !q) return res.status(400).json({ error: 'repo, path, and q parameters required' });
  try {
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/contents/${path}`);
    if (data.type !== 'file') return res.status(400).json({ error: `${path} is a ${data.type}, not a file` });
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    const lines = content.split('\n');
    const matches = [];
    const query = String(q).toLowerCase();
    lines.forEach((line, i) => {
      if (line.toLowerCase().includes(query)) {
        matches.push({ line: i + 1, text: line.trimEnd() });
      }
    });
    res.json({ file: path, query: q, total: matches.length, matches });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Search: search across all files in a repo directory ---
app.get('/api/github/search', async (req, res) => {
  const { repo, path, q, ext } = req.query;
  if (!repo || !q) return res.status(400).json({ error: 'repo and q parameters required' });
  try {
    const dir = path || '';
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/contents/${dir}`);
    if (!Array.isArray(data)) return res.status(400).json({ error: 'path must be a directory' });
    const files = data.filter(f => {
      if (f.type !== 'file') return false;
      if (ext && !f.name.endsWith(String(ext))) return false;
      return true;
    });
    const results = [];
    const query = String(q).toLowerCase();
    for (const f of files.slice(0, 50)) { // limit to 50 files
      try {
        const fileData = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/contents/${f.path}`);
        const content = Buffer.from(fileData.content, 'base64').toString('utf-8');
        const lines = content.split('\n');
        const matches = [];
        lines.forEach((line, i) => {
          if (line.toLowerCase().includes(query)) {
            matches.push({ line: i + 1, text: line.trimEnd() });
          }
        });
        if (matches.length > 0) {
          results.push({ file: f.path, matches });
        }
      } catch (e) { /* skip unreadable files */ }
    }
    res.json({ query: q, directory: dir, filesSearched: files.length, results });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Read file with line range (for large files) ---
app.get('/api/github/lines', async (req, res) => {
  const { repo, path, from, to } = req.query;
  if (!repo || !path) return res.status(400).json({ error: 'repo and path parameters required' });
  try {
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/contents/${path}`);
    if (data.type !== 'file') return res.status(400).json({ error: `${path} is a ${data.type}, not a file` });
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    const lines = content.split('\n');
    const start = Math.max(1, parseInt(from) || 1);
    const end = Math.min(lines.length, parseInt(to) || lines.length);
    const selected = lines.slice(start - 1, end).map((text, i) => ({
      line: start + i,
      text: text.trimEnd(),
    }));
    res.json({ file: path, totalLines: lines.length, from: start, to: end, lines: selected });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- WRITE REST endpoints (bearer-auth + repo-allow-list gated) ---

app.post('/api/github/file', requireWriteKey, requireAllowedRepo, async (req, res) => {
  const { repo, content, message, branch, sha } = req.body || {};
  const path = normalizePath(req.body && req.body.path);
  if (!repo || !path || content == null) {
    return res.status(400).json({ error: 'repo, path, content all required (message is optional — defaults to "[linksblue] update <path>")' });
  }
  try {
    let resolvedSha = sha;
    let existingContent = null;
    if (!resolvedSha) {
      const existing = await ghGetFile(repo, path, branch);
      if (existing) {
        resolvedSha = existing.sha;
        existingContent = existing.content;
      }
    }
    if (existingContent !== null && existingContent === String(content)) {
      logWrite('write_file', req, { op: 'unchanged' });
      return res.json({ status: 'unchanged', path });
    }
    const op = resolvedSha ? 'update' : 'create';
    const body = {
      message: message || defaultMessage(op, repo, path),
      content: Buffer.from(String(content), 'utf-8').toString('base64'),
    };
    if (resolvedSha) body.sha = resolvedSha;
    if (branch) body.branch = branch;
    const result = await ghPut(`/repos/${GITHUB_ORG}/${repo}/contents/${path}`, body);
    logWrite('write_file', req, { commit_sha: result.commit.sha.slice(0, 7), op });
    res.json({ status: resolvedSha ? 'updated' : 'created', path: result.content.path, sha: result.content.sha, commit_sha: result.commit.sha });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.delete('/api/github/file', requireWriteKey, requireAllowedRepo, async (req, res) => {
  const { repo, message, branch, sha } = req.body || {};
  const path = normalizePath(req.body && req.body.path);
  if (!repo || !path) {
    return res.status(400).json({ error: 'repo and path required (message is optional — defaults to "[linksblue] delete <path>")' });
  }
  try {
    let resolvedSha = sha;
    if (!resolvedSha) resolvedSha = await ghGetSha(repo, path, branch);
    if (!resolvedSha) return res.status(404).json({ error: `file not found: ${path}` });
    const body = { message: message || defaultMessage('delete', repo, path), sha: resolvedSha };
    if (branch) body.branch = branch;
    const result = await ghDeleteContents(`/repos/${GITHUB_ORG}/${repo}/contents/${path}`, body);
    logWrite('delete_file', req, { commit_sha: result.commit.sha.slice(0, 7) });
    res.json({ status: 'deleted', path, commit_sha: result.commit.sha });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/github/move', requireWriteKey, requireAllowedRepo, async (req, res) => {
  const { repo, message, branch } = req.body || {};
  const fromPath = normalizePath(req.body && req.body.from_path);
  const toPath = normalizePath(req.body && req.body.to_path);
  if (!repo || !fromPath || !toPath) {
    return res.status(400).json({ error: 'repo, from_path, to_path all required' });
  }
  if (fromPath === toPath) {
    return res.status(400).json({ error: 'from_path and to_path are identical after normalization' });
  }
  try {
    const source = await ghGetFile(repo, fromPath, branch);
    if (!source) return res.status(404).json({ error: `source file not found: ${fromPath}` });
    const msg = message || `[linksblue] move ${fromPath} -> ${toPath}`;
    const writeBody = { message: `${msg} (write)`, content: Buffer.from(source.content, 'utf-8').toString('base64') };
    if (branch) writeBody.branch = branch;
    const writeResult = await ghPut(`/repos/${GITHUB_ORG}/${repo}/contents/${toPath}`, writeBody);
    const deleteBody = { message: `${msg} (delete)`, sha: source.sha };
    if (branch) deleteBody.branch = branch;
    const deleteResult = await ghDeleteContents(`/repos/${GITHUB_ORG}/${repo}/contents/${fromPath}`, deleteBody);
    logWrite('move_file', req, { from: fromPath, to: toPath, write: writeResult.commit.sha.slice(0, 7), delete: deleteResult.commit.sha.slice(0, 7) });
    res.json({ status: 'moved', from: fromPath, to: toPath, write_commit: writeResult.commit.sha, delete_commit: deleteResult.commit.sha });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/github/branch', requireWriteKey, requireAllowedRepo, async (req, res) => {
  const { repo, name, from_sha, from_branch } = req.body || {};
  if (!repo || !name) return res.status(400).json({ error: 'repo and name required' });
  try {
    let sha = from_sha;
    if (!sha) {
      const sourceBranch = from_branch || (await ghFetch(`/repos/${GITHUB_ORG}/${repo}`)).default_branch;
      const refData = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/git/ref/heads/${sourceBranch}`);
      sha = refData.object.sha;
    }
    const result = await ghPost(`/repos/${GITHUB_ORG}/${repo}/git/refs`, {
      ref: `refs/heads/${name}`,
      sha,
    });
    logWrite('create_branch', req, { branch: name, from_sha: sha.slice(0, 7) });
    res.json({ status: 'created', branch: name, sha, ref: result.ref });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Archive ingest endpoint ---
// --- v2.6 REST endpoints — multi-file, refs, PRs, issues, raw passthrough ---

app.post('/api/github/push', requireWriteKey, requireAllowedRepo, async (req, res) => {
  const { repo, files, message, branch } = req.body || {};
  if (!repo || !Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'repo and non-empty files array required' });
  }
  try {
    const result = await pushFilesAtomic(repo, files, message, branch);
    logWrite('push_files', req, { count: files.length, commit_sha: result.commit_sha.slice(0, 7) });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/github/ref', requireWriteKey, requireAllowedRepo, async (req, res) => {
  const { repo, ref, sha } = req.body || {};
  if (!repo || !ref || !sha) return res.status(400).json({ error: 'repo, ref, sha required' });
  try {
    const result = await ghPost(`/repos/${GITHUB_ORG}/${repo}/git/refs`, { ref, sha });
    logWrite('create_ref', req, { ref, sha: sha.slice(0, 7) });
    res.json({ status: 'created', ref: result.ref, sha: result.object.sha });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/github/pull', requireWriteKey, requireAllowedRepo, async (req, res) => {
  const { repo, title, head, base, body, draft } = req.body || {};
  if (!repo || !title || !head) return res.status(400).json({ error: 'repo, title, head required' });
  try {
    const targetBase = base || (await ghFetch(`/repos/${GITHUB_ORG}/${repo}`)).default_branch;
    const result = await ghPost(`/repos/${GITHUB_ORG}/${repo}/pulls`, {
      title, head, base: targetBase, body: body || '', draft: !!draft,
    });
    logWrite('create_pull_request', req, { number: result.number, head, base: targetBase });
    res.json({ number: result.number, url: result.html_url, state: result.state, head: result.head.ref, base: result.base.ref });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.put('/api/github/pull/merge', requireWriteKey, requireAllowedRepo, async (req, res) => {
  const { repo, number, commit_title, commit_message, merge_method } = req.body || {};
  if (!repo || number == null) return res.status(400).json({ error: 'repo and number required' });
  try {
    const body = {};
    if (commit_title) body.commit_title = commit_title;
    if (commit_message) body.commit_message = commit_message;
    if (merge_method) body.merge_method = merge_method;
    const result = await ghPut(`/repos/${GITHUB_ORG}/${repo}/pulls/${number}/merge`, body);
    logWrite('merge_pull_request', req, { number, sha: result.sha.slice(0, 7) });
    res.json({ merged: result.merged, sha: result.sha, message: result.message });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/github/issue', requireWriteKey, requireAllowedRepo, async (req, res) => {
  const { repo, title, body, labels, assignees } = req.body || {};
  if (!repo || !title) return res.status(400).json({ error: 'repo and title required' });
  try {
    const payload = { title };
    if (body) payload.body = body;
    if (labels && labels.length) payload.labels = labels;
    if (assignees && assignees.length) payload.assignees = assignees;
    const result = await ghPost(`/repos/${GITHUB_ORG}/${repo}/issues`, payload);
    logWrite('create_issue', req, { number: result.number });
    res.json({ number: result.number, url: result.html_url, state: result.state });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.patch('/api/github/issue', requireWriteKey, requireAllowedRepo, async (req, res) => {
  const { repo, number, title, body, state, labels, assignees } = req.body || {};
  if (!repo || number == null) return res.status(400).json({ error: 'repo and number required' });
  try {
    const payload = {};
    if (title !== undefined) payload.title = title;
    if (body !== undefined) payload.body = body;
    if (state !== undefined) payload.state = state;
    if (labels !== undefined) payload.labels = labels;
    if (assignees !== undefined) payload.assignees = assignees;
    const result = await ghPatch(`/repos/${GITHUB_ORG}/${repo}/issues/${number}`, payload);
    logWrite('update_issue', req, { number, state: result.state });
    res.json({ number: result.number, url: result.html_url, state: result.state });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/github/issue/comment', requireWriteKey, requireAllowedRepo, async (req, res) => {
  const { repo, number, body } = req.body || {};
  if (!repo || number == null || !body) return res.status(400).json({ error: 'repo, number, body required' });
  try {
    const result = await ghPost(`/repos/${GITHUB_ORG}/${repo}/issues/${number}/comments`, { body });
    logWrite('add_issue_comment', req, { number, comment: result.id });
    res.json({ id: result.id, url: result.html_url });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Raw passthrough — no allow-list (path is variable), bearer-auth still required.
app.post('/api/github/raw', requireWriteKey, async (req, res) => {
  const { method, path: ghPath, body } = req.body || {};
  if (!method || !ghPath) return res.status(400).json({ error: 'method and path required' });
  if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) {
    return res.status(400).json({ error: 'method must be GET, POST, PATCH, PUT, or DELETE' });
  }
  if (typeof ghPath !== 'string' || !ghPath.startsWith('/')) {
    return res.status(400).json({ error: 'path must start with "/"' });
  }
  try {
    const url = `${GITHUB_API}${ghPath}`;
    const opts = { method, headers: { ...ghHeaders(), 'Content-Type': 'application/json' } };
    if (body !== undefined && method !== 'GET') opts.body = JSON.stringify(body);
    const ghRes = await fetch(url, opts);
    const text = await ghRes.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    const ts = new Date().toISOString();
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    console.log(`[${ts}] WRITE gh_api (rest) ${method} ${ghPath} → ${ghRes.status} ip=${ip}`);
    if (!ghRes.ok) {
      return res.status(ghRes.status).json({ error: `GitHub ${method} ${ghRes.status}`, body: parsed });
    }
    res.json({ status: ghRes.status, body: parsed });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- v2.7 REST endpoints — atomic prompt-log claim + lifecycle ---

app.post('/api/archive/claim-number', requireWriteKey, async (req, res) => {
  const { type, platform, agent, title, covers_prompts } = req.body || {};
  if (!type || !platform || !agent) {
    return res.status(400).json({ error: 'type, platform, agent all required' });
  }
  if (!['PROMPT', 'SEGUE'].includes(type)) {
    return res.status(400).json({ error: 'type must be "PROMPT" or "SEGUE"' });
  }
  try {
    const result = await claimNumberAtomic({ type, platform, agent, title, coversPrompts: covers_prompts });
    const ts = new Date().toISOString();
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    console.log(`[${ts}] CLAIM ${type} (rest) id=${result.id} agent="${agent}" ip=${ip}`);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/archive/claim-response', requireWriteKey, async (req, res) => {
  const { parent_n, parent_date, platform, agent, title } = req.body || {};
  if (parent_n == null || !parent_date || !platform || !agent) {
    return res.status(400).json({ error: 'parent_n, parent_date, platform, agent all required' });
  }
  try {
    const result = await claimResponseAtomic({ parentN: parent_n, parentDate: parent_date, platform, agent, title });
    const ts = new Date().toISOString();
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    console.log(`[${ts}] CLAIM RESPONSE (rest) id=${result.id} agent="${agent}" ip=${ip}`);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.patch('/api/archive/prompt-status', requireWriteKey, async (req, res) => {
  const { id, status, commit_sha, note } = req.body || {};
  if (!id || !status) {
    return res.status(400).json({ error: 'id and status required' });
  }
  if (!['claimed', 'fired', 'committed', 'verified', 'abandoned'].includes(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }
  try {
    const result = await updatePromptStatusAtomic({ id, status, commitSha: commit_sha, note });
    const ts = new Date().toISOString();
    console.log(`[${ts}] UPDATE_STATUS (rest) id=${id} status=${status}`);
    res.json(result);
  } catch (err) {
    if (err.notFound) return res.status(404).json({ error: err.message });
    res.status(502).json({ error: err.message });
  }
});

app.use('/api/archive', require('./routes/archive-ingest'));

// --- GET / without session header = health check ---
app.get('/', (req, res) => {
  const sessionId = getSessionId(req);
  if (sessionId && sessions.has(sessionId)) {
    return handleMcpGet(req, res);
  }
  res.json({
    status: 'ok',
    service: 'linksblue-github-proxy',
    version: '2.9',
    mcp: '/mcp',
    activeSessions: sessions.size,
  });
});

app.listen(PORT, () => {
  console.log(`Proxy + MCP server running on port ${PORT}`);
});

