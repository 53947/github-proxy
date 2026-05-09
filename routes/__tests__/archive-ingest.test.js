// routes/__tests__/archive-ingest.test.js
//
// Unit tests for archive-ingest's path-discriminator behavior. Uses
// Node's built-in test runner (`node:test` + `node:assert`); no external
// dependencies. Run via `npm test` from the repo root.

const test = require('node:test');
const assert = require('node:assert');

const { pathFor, pathDiscriminator } = require('../archive-ingest');

test('pathDiscriminator is exactly 8 lowercase hex chars', () => {
  const disc = pathDiscriminator('any-source-id-here');
  assert.match(disc, /^[0-9a-f]{8}$/);
  assert.strictEqual(disc.length, 8);
});

test('pathDiscriminator is deterministic — same input always yields same output', () => {
  const a1 = pathDiscriminator('foo');
  const a2 = pathDiscriminator('foo');
  assert.strictEqual(a1, a2);
  // And different inputs produce different outputs (overwhelmingly likely;
  // sha256 collisions are not a real-world concern for this assertion).
  const b = pathDiscriminator('bar');
  assert.notStrictEqual(a1, b);
});

test('pathFor returns different paths for two distinct source_ids with identical title/platform/started_at', () => {
  const common = {
    startedAt: '2026-05-09T00:00:00.000Z',
    platform: 'claude_code',
    slug: 'read-the-necessary-paperwork',
  };

  const p1 = pathFor({ ...common, sourceId: 'session-aaaa-1111' });
  const p2 = pathFor({ ...common, sourceId: 'session-bbbb-2222' });

  assert.notStrictEqual(p1.full, p2.full);
  // Both share the leading prefix (same date, same platform, same slug)
  // and differ only in the 8-char hex suffix.
  const prefix = '2026/05/09-claude_code-read-the-necessary-paperwork-';
  assert.ok(p1.full.startsWith(prefix), `expected p1 to start with ${prefix}, got ${p1.full}`);
  assert.ok(p2.full.startsWith(prefix), `expected p2 to start with ${prefix}, got ${p2.full}`);
  assert.match(p1.full, /-[0-9a-f]{8}\.md$/);
  assert.match(p2.full, /-[0-9a-f]{8}\.md$/);
});

test('pathFor is idempotent — same source_id always yields same path', () => {
  const args = {
    startedAt: '2026-05-09T00:00:00.000Z',
    platform: 'claude_code',
    slug: 'whatever',
    sourceId: 'stable-source-id',
  };

  const p1 = pathFor(args);
  const p2 = pathFor(args);
  assert.strictEqual(p1.full, p2.full);
  assert.strictEqual(p1.date, p2.date);
});

test('pathFor encodes UTC date components correctly', () => {
  // 2026-05-09T23:30:00Z — late in UTC day; ensure UTC components used,
  // not local-tz components.
  const p = pathFor({
    startedAt: '2026-05-09T23:30:00.000Z',
    platform: 'cowork',
    slug: 'test-session',
    sourceId: 'src-1',
  });
  assert.strictEqual(p.date, '2026-05-09');
  assert.ok(p.full.startsWith('2026/05/09-cowork-test-session-'));
});
