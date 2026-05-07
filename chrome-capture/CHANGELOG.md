# linksblue chrome-capture — Changelog

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
