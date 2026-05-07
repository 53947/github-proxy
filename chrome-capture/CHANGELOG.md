# linksblue chrome-capture — Changelog

## 0.3.0 — 2026-05-07
- Snapshot recovery on fresh install (Prompt 05/07/2026-34, pass 3a). When `chrome.storage.local` has no `linksblue.snapshot.<source_id>` entry for a captured conversation, the service worker now queries `GET /api/archive/last-message-count?source_id=<id>` (with the same bearer token used for ingest) and uses the returned count as `from_index` instead of defaulting to 0. The recovered count is cached back to local storage so subsequent captures of the same conversation use the fast path. Failure-safe: any recovery error (no token, network down, non-2xx, malformed JSON) falls back to 0 and proceeds with the capture. Recovery never blocks the pipeline.
- Server endpoint shipped separately in linksblue PR #19 / commit 521fbdd.
- Bumped version 0.2.1 → 0.3.0. Minor bump because the extension now depends on a server endpoint that didn't exist in v0.2.x — a v0.3.0 build against a v0.2.x-era server would fall back to from_index=0, the broken behavior 3a is fixing.

## 0.2.1 — 2026-05-07
- Fix: resolve relative URLs to absolute via `new URL(raw, location.href).href` before regex match (Response 05/06/2026-31b). Pass-2's `CONV_GET_RE` is anchored on `^https://claude.ai/...`, but claude.ai's React app calls `fetch('/api/...')` with relative paths — every match returned false and no captures landed. Applies to both fetch and XHR branches.
- Cosmetic: popup subtitle updated 0.2.0 → 0.2.1 to match manifest version (the hardcoded subtitle in pass 2 caused 0.2.0/0.2.99 install-version confusion during the 31b investigation).

## 0.2.0 — 2026-05-06
- Narrowed URL filter to chat_conversations GET only (Prompt 05/06/2026-31).
- Added transformer (parsedJson → ingest contract shape).
- Added client-side diff: only forwards new messages since last snapshot.
- Added POST to https://github.linksblue.network/api/archive/ingest with bearer-token auth.
- Added 15-minute alarm scheduler for retry-queue flush.
- Added options page token entry (password-masked).
- Added popup status: token configured, last POST, captures posted, retry queue depth.
- Bumped version 0.1.0 → 0.2.0.

## 0.1.0 — 2026-05-06
- Initial scaffold (Prompt 05/06/2026-29, pass 1 of 2).
- Manifest V3 extension, claude.ai host only.
- Wraps window.fetch and XMLHttpRequest in the page world.
- Filters captures to https://claude.ai/api/* responses.
- Logs up to 200 most recent captures into chrome.storage.local.
- Popup UI for inspection: list, expand, copy-all, clear.
- Options page stub (no token entry yet — added in pass 2).
- No network egress beyond claude.ai itself.
