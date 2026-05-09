// routes/__tests__/daemon-heartbeat.test.js
//
// Unit tests for daemon-heartbeat — Prompt 05/09/2026-44.
//
// Approach: spin up a tiny in-process Express server per test, hit it
// via Node's built-in fetch, and inject a no-op persistence stub so
// tests never touch the real GitHub API. Zero new dependencies — uses
// node:test, node:assert, node:http, and the existing express dep.
//
// Pure helpers (validateBody, computeSecondsSince) are also tested
// directly — that mirrors the archive-ingest.test.js style for
// pure-function coverage.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

// Set the bearer key BEFORE requiring the route module — requireBearer
// reads ARCHIVE_API_KEY at request time, so this would also work post-
// require, but setting it up here keeps the test setup explicit.
process.env.ARCHIVE_API_KEY = 'test-bearer-key-44';

const express = require('express');
const router = require('../daemon-heartbeat');
const { validateBody, computeSecondsSince } = router;

const VALID_PAYLOAD_FIXTURE = {
  daemon_id: 'linksblue-daemon',
  host: 'test-host.local',
  timestamp: new Date().toISOString(),
  last_pass_status: 'ok',
  watchers: {
    'claude-code': { deltas: 3, ok: true },
    'cowork': { deltas: 0, ok: true },
    'claude-leveldb': { deltas: 1, ok: true },
  },
  queue_depth: 2,
};

async function withServer(fn) {
  router.__reset();
  router.__setPersistFn(async () => { /* no-op for tests */ });
  const app = express();
  app.use(express.json());
  app.use('/api/daemon', router);
  const server = http.createServer(app).listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const port = server.address().port;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function withAuth(payload) {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer test-bearer-key-44',
    },
    body: JSON.stringify(payload),
  };
}

// ---------------------------------------------------------------------------
// Pure-function tests (mirror archive-ingest.test.js style)
// ---------------------------------------------------------------------------

test('validateBody accepts a well-formed payload', () => {
  const err = validateBody({ ...VALID_PAYLOAD_FIXTURE, timestamp: new Date().toISOString() });
  assert.strictEqual(err, null);
});

test('validateBody rejects missing timestamp', () => {
  const { timestamp, ...rest } = VALID_PAYLOAD_FIXTURE;
  const err = validateBody(rest);
  assert.match(err || '', /timestamp/);
});

test('validateBody rejects unknown last_pass_status', () => {
  const err = validateBody({ ...VALID_PAYLOAD_FIXTURE, last_pass_status: 'happy' });
  assert.match(err || '', /last_pass_status/);
});

test('validateBody rejects negative queue_depth', () => {
  const err = validateBody({ ...VALID_PAYLOAD_FIXTURE, queue_depth: -1 });
  assert.match(err || '', /queue_depth/);
});

test('computeSecondsSince returns ~0 for a just-now timestamp', () => {
  const ts = new Date().toISOString();
  const s = computeSecondsSince({ timestamp: ts }, Date.now());
  assert.ok(s >= 0 && s <= 1, `expected near-zero, got ${s}`);
});

test('computeSecondsSince returns ~3600 for a 1h-old timestamp', () => {
  const ts = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const s = computeSecondsSince({ timestamp: ts }, Date.now());
  assert.ok(s >= 3590 && s <= 3610, `expected ~3600, got ${s}`);
});

// ---------------------------------------------------------------------------
// Integration tests via in-process server
// ---------------------------------------------------------------------------

test('POST /heartbeat with valid bearer + body returns 200 with stored_at', async () => {
  await withServer(async (baseUrl) => {
    const payload = { ...VALID_PAYLOAD_FIXTURE, timestamp: new Date().toISOString() };
    const res = await fetch(`${baseUrl}/api/daemon/heartbeat`, withAuth(payload));
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.status, 'ok');
    assert.match(json.stored_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

test('POST /heartbeat without bearer returns 401', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/daemon/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_PAYLOAD_FIXTURE),
    });
    assert.strictEqual(res.status, 401);
  });
});

test('POST /heartbeat with malformed body (missing timestamp) returns 400', async () => {
  await withServer(async (baseUrl) => {
    const { timestamp, ...badPayload } = VALID_PAYLOAD_FIXTURE;
    const res = await fetch(`${baseUrl}/api/daemon/heartbeat`, withAuth(badPayload));
    assert.strictEqual(res.status, 400);
    const json = await res.json();
    assert.match(json.error, /timestamp/);
  });
});

test('GET /heartbeat before any POST returns 404', async () => {
  await withServer(async (baseUrl) => {
    // Stub the cold-start GH read so the test doesn't hit the network.
    router.__setPersistFn(async () => {});
    const res = await fetch(`${baseUrl}/api/daemon/heartbeat`);
    assert.strictEqual(res.status, 404);
    const json = await res.json();
    assert.match(json.error, /no heartbeat/);
  });
});

test('GET /heartbeat after a POST returns 200 with seconds_since >= 0 and full payload', async () => {
  await withServer(async (baseUrl) => {
    const payload = { ...VALID_PAYLOAD_FIXTURE, timestamp: new Date().toISOString() };
    const postRes = await fetch(`${baseUrl}/api/daemon/heartbeat`, withAuth(payload));
    assert.strictEqual(postRes.status, 200);

    const getRes = await fetch(`${baseUrl}/api/daemon/heartbeat`);
    assert.strictEqual(getRes.status, 200);
    const json = await getRes.json();
    assert.ok(json.seconds_since >= 0, `seconds_since should be >= 0, got ${json.seconds_since}`);
    assert.strictEqual(json.daemon_id, 'linksblue-daemon');
    assert.strictEqual(json.last_pass_status, 'ok');
    assert.strictEqual(json.host, 'test-host.local');
    assert.strictEqual(json.queue_depth, 2);
  });
});

test('GET /heartbeat reports ~3600 seconds_since for a 1h-old POST', async () => {
  await withServer(async (baseUrl) => {
    const oldPayload = {
      ...VALID_PAYLOAD_FIXTURE,
      timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    };
    await fetch(`${baseUrl}/api/daemon/heartbeat`, withAuth(oldPayload));
    const res = await fetch(`${baseUrl}/api/daemon/heartbeat`);
    const json = await res.json();
    assert.ok(json.seconds_since >= 3590 && json.seconds_since <= 3610, `expected ~3600, got ${json.seconds_since}`);
  });
});

test('persistence failure does not break the POST response', async () => {
  // Inject a persist stub that throws — POST should still return 200 because
  // persistence failures are logged-and-swallowed (in-memory cache + next-pass
  // retry are sufficient resilience).
  router.__reset();
  router.__setPersistFn(async () => { throw new Error('synthetic gh outage'); });
  const app = express();
  app.use(express.json());
  app.use('/api/daemon', router);
  const server = http.createServer(app).listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const port = server.address().port;
    const payload = { ...VALID_PAYLOAD_FIXTURE, timestamp: new Date().toISOString() };
    const res = await fetch(`http://127.0.0.1:${port}/api/daemon/heartbeat`, withAuth(payload));
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.status, 'ok');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
