# linksblue chrome-capture — Changelog

## 0.1.0 — 2026-05-06
- Initial scaffold (Prompt 05/06/2026-29, pass 1 of 2).
- Manifest V3 extension, claude.ai host only.
- Wraps window.fetch and XMLHttpRequest in the page world.
- Filters captures to https://claude.ai/api/* responses.
- Logs up to 200 most recent captures into chrome.storage.local.
- Popup UI for inspection: list, expand, copy-all, clear.
- Options page stub (no token entry yet — added in pass 2).
- No network egress beyond claude.ai itself.
