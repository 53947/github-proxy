# linksblue chrome-capture

Manifest V3 Chrome extension that captures conversation API responses
the `claude.ai` web app receives, and stores them locally in the
extension's storage for inspection. **Pass 1 (v0.1.x) is observe-and-
log-only** — the extension never sends data anywhere outside the
browser. Pass 2 will add the POST path to the linksblue ingest endpoint
and a snapshot scheduler aligned to the Mac daemon's 15-minute cadence.

This extension is a peer to `linksblue/daemon/`, not a replacement.
The daemon captures Claude Code, Cowork, and Claude Desktop sessions
locally on Dean's Mac. The extension captures the one surface the
daemon cannot see: `claude.ai` web chat, observed inside the browser
where the conversation is actually rendered.

## Where it fits

```
claude.ai (browser tab)
        |
        v
injected.js          page world — wraps fetch + XHR, observes only
        |
        |  window.postMessage("linksblue-chrome-capture", ...)
        v
content-script.js    isolated world — bridge
        |
        |  chrome.runtime.sendMessage({type: "captured"})
        v
background.js        service worker — buffer of last 200, no network
        |
        |  chrome.storage.local["linksblue.captures"]
        v
popup.html           debug UI — Dean inspects raw JSON here
```

The eventual ingest target (pass 2) is the same endpoint the existing
Mac daemon already uses — Mode B (snapshot/append). In pass 1 the
extension does not know that endpoint exists.

## How to install (sideload)

1. Open `chrome://extensions` in Chrome.
2. Toggle **Developer mode** on, top right.
3. Click **Load unpacked**.
4. Point at `<repo>/linksblue/chrome-capture/`.
5. Pin the extension to the toolbar (puzzle-piece icon → pin).
6. Open `claude.ai`, sign in, start or open a conversation.
7. Click the extension icon in the toolbar. The popup shows captures.

No npm install. No build step. The extension is plain JS and loads
straight from this directory.

## How to inspect captures

Each entry in the popup list shows the relative time it was captured,
the HTTP status code returned by the page's API call, and the URL
path (with query string). Click a row to expand it — the detail panel
shows the full URL, a 12-char id hash, and a `<pre>` block with the
raw `parsedJson` formatted with 2-space indentation.

Three buttons:

- **Copy all to clipboard** — serializes the entire current buffer
  as a single JSON array (oldest entries first, newest last) for
  handoff to Claude.ai web chat. Use this to share captured shapes
  for pass 2 transformer design.
- **Clear** — wipes the buffer.
- **Open options** — opens the read-only options page (placeholder
  in pass 1; token entry in pass 2).

## What pass 2 adds

A separately numbered prompt will deliver:

- Token entry on the options page (paste the linksblue archive key).
- A `parsedJson → {role, content, timestamp}[]` transformer.
- POST to `https://github.linksblue.network/api/archive/ingest` in
  Mode B (snapshot/append).
- A snapshot scheduler aligned to the daemon's 15-minute cadence.
- A status indicator on the toolbar icon.

## Boundaries

The extension does NOT do any of the following in pass 1:

- Modify `claude.ai` in any way. No DOM mutation, no UI injection,
  no event interception that alters page behavior.
- Read from the `claude.ai` DOM. Capture is via fetch / XHR wrappers
  observing the page's own network responses — never via scraping.
- Send data anywhere outside the local browser. No POST. No telemetry.
  No analytics. The host_permissions list contains only
  `https://claude.ai/*`.
- Log a bearer token. Pass 1 has no token. Pass 2 will accept one on
  the options page; no log line will ever print it.
- Persist anything outside `chrome.storage.local` under the keys
  `linksblue.captures` (capped at 200) and `linksblue.lastHeartbeat`
  (a small popup-status snapshot).

## Numbering

- v0.1.0 — Prompt 05/06/2026-29 (this build, pass 1 of 2).
- v0.2.x — pass 2, separate prompt, delivered separately.
