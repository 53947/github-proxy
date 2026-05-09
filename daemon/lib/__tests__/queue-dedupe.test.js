// lib/__tests__/queue-dedupe.test.js
//
// Unit tests for queueDelta. The dedupe contract: exactly one queue
// file per source_id, with replace-on-retry semantics (latest payload
// wins). This is the fix for the runaway documented in
// SEGUE_05-09-2026-41 operational finding (1) — Prompt 05/09/2026-43.
//
// Uses Node's built-in test runner (`node:test` + `node:assert`); no
// external dependencies. Run via `npm test` from the daemon/ directory.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { queueDelta } = require('../queue');

function makeTmpQueue() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'queue-dedupe-test-'));
}

function listJsonFiles(dir) {
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
}

test('two queueDelta calls with the same source_id produce exactly one file (replace on retry)', () => {
  const queueDir = makeTmpQueue();

  queueDelta({
    queueDir,
    delta: { source_id: 'abc-123', platform: 'claude_code', from_index: 0, new_messages: ['first'] },
    reason: 'first failure',
  });
  queueDelta({
    queueDir,
    delta: { source_id: 'abc-123', platform: 'claude_code', from_index: 0, new_messages: ['first', 'second'] },
    reason: 'second failure',
  });

  const files = listJsonFiles(queueDir);
  assert.strictEqual(files.length, 1, `expected 1 file in queue dir, got ${files.length}: ${files.join(', ')}`);
});

test('after two calls with the same source_id, file contents reflect the SECOND payload (latest wins)', () => {
  const queueDir = makeTmpQueue();

  queueDelta({
    queueDir,
    delta: { source_id: 'abc-123', platform: 'claude_code', from_index: 0, new_messages: ['original'] },
    reason: 'first failure',
  });
  queueDelta({
    queueDir,
    delta: { source_id: 'abc-123', platform: 'claude_code', from_index: 5, new_messages: ['updated', 'with', 'more'] },
    reason: 'retry',
  });

  const files = listJsonFiles(queueDir);
  assert.strictEqual(files.length, 1);
  const contents = JSON.parse(fs.readFileSync(path.join(queueDir, files[0]), 'utf-8'));
  assert.strictEqual(contents.delta.from_index, 5);
  assert.deepStrictEqual(contents.delta.new_messages, ['updated', 'with', 'more']);
  assert.strictEqual(contents.reason, 'retry');
});

test('two queueDelta calls with different source_ids produce two distinct files', () => {
  const queueDir = makeTmpQueue();

  queueDelta({
    queueDir,
    delta: { source_id: 'first-source', platform: 'claude_code', from_index: 0, new_messages: ['m1'] },
    reason: 'first failure',
  });
  queueDelta({
    queueDir,
    delta: { source_id: 'second-source', platform: 'cowork', from_index: 0, new_messages: ['m2'] },
    reason: 'second failure',
  });

  const files = listJsonFiles(queueDir);
  assert.strictEqual(files.length, 2, `expected 2 files in queue dir, got ${files.length}: ${files.join(', ')}`);
});

test('source_ids needing sanitization still collide deterministically (filesystem-safe AND stable)', () => {
  const queueDir = makeTmpQueue();
  const messySourceId = 'claude_web:f7e3/abc def:xyz';

  queueDelta({
    queueDir,
    delta: { source_id: messySourceId, platform: 'claude_web', from_index: 0, new_messages: ['m1'] },
    reason: 'first',
  });
  queueDelta({
    queueDir,
    delta: { source_id: messySourceId, platform: 'claude_web', from_index: 0, new_messages: ['m1', 'm2'] },
    reason: 'second',
  });

  const files = listJsonFiles(queueDir);
  assert.strictEqual(files.length, 1, `expected 1 file (deterministic sanitization), got ${files.length}: ${files.join(', ')}`);
  // Filename must be filesystem-safe — only alphanumerics, dot, dash, underscore.
  assert.match(files[0], /^[a-zA-Z0-9.\-_]+\.json$/);
});
