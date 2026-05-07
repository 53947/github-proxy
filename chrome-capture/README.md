# linksblue chrome-capture

Manifest V3 Chrome extension that captures conversation API responses
the `claude.ai` web app receives, normalizes them into the linksblue
ingest contract, and POSTs them to `TRIADBLUE/ai-archive` via the
linksblue ingest endpoint. As of **v0.2.0** the extension is end-to-end
functional: the wrapper observes the chat_conversations GET endpoint,
the transformer normalizes the response shape, a client-side dedupe
ensures only new turns are sent, and the service worker POSTs to
`https://github.linksblue.network/api/archive/ingest` with a bearer
token set in the options page.

This extension is a peer to `linksblue/daemon/`. The daemon captures
Claude Code, Cowork, and Claude Desktop sessions on Dean's Mac. The
extension captures the one surface the daemon cannot see: `claude.ai`
web chat, observed inside the browser where the conversation is
actually rendered.

## What changed in v0.2.x

Pass 2 added the following (Prompt 05/06/2026-31; see CHANGELOG):

- **Narrowed URL filter.** v0.1 wrapped any `claude.ai/api/*` fetch.
  v0.2 captures only the chat_conversations GET —
  `^https://claude.ai/api/organizations/<uuid>/chat_conversations/<uuid>(\?|$)`.
  The completion SSE stream is intentionally not captured; the
  chat_conversations GET fires after each turn finishes streaming and
  contains the fully-rendered tree.
- **Transformer.** `lib/transformer.js` converts the response into
  the Mode B ingest contract — `source_id: "claude_web:<uuid>"`,
  `platform`, `title`, `started_at`, `last_updated`, `from_index`,
  `new_messages`. Defensive on field shape: accepts `text` or
  `content`, accepts `human` or `user` for user-role; preserves
  artifacts, tool_use, tool_result, attachments, files, and model
  through to the ingest payload as structured fields.
- **Client-side dedupe.** Each capture is compared against the last
  recorded snapshot for the conversation; only new messages are
  forwarded. Snapshot metadata (message_count, last_capture_at,
  last_message_uuid) is stored per `source_id` in
  `chrome.storage.local`.
- **POST + retry queue.** Service worker POSTs to the ingest
  endpoint. Failed POSTs go into a retry queue (cap 20, 3 attempts
  before drop). A 15-minute alarm flushes the queue.
- **Token entry.** Options page accepts the bearer token,
  password-masked, with a Test-connection button.
- **Popup status.** Token configured (yes/no), last successful POST,
  total captures posted, retry queue depth. Yellow banner when no
  token is configured.

## Where it fits

```
claude.ai (browser tab)
        |
        v
injected.js          page world — wraps fetch + XHR; only the
                     chat_conversations GET passes the filter
        |
        |  window.postMessage("linksblue-chrome-capture", ...)
        v
content-script.js    isolated world — bridge
        |
        |  chrome.runtime.sendMessage({type: "captured"})
        v
background.js        service worker — transform, dedupe, POST,
                     retry queue, alarm-driven flush
        |
        |  POST https://github.linksblue.network/api/archive/ingest
        v
TRIADBLUE/ai-archive  YYYY/MM/DD-claude_web-<slug>.md
```

## How to install (sideload)

1. Open `chrome://extensions` in Chrome.
2. Toggle **Developer mode** on, top right.
3. Click **Load unpacked**.
4. Point at `<repo>/linksblue/chrome-capture/`.
5. Pin the extension to the toolbar (puzzle-piece icon → pin).
6. Click the extension icon → **Open options** → paste the linksblue
   archive token (LINKSBLUE_ARCHIVE_API_KEY) → Save.
7. Click **Test connection** to verify the token is accepted.
8. Open `claude.ai`, sign in, start or open a conversation.

No npm install. No build step. The extension is plain JS and loads
straight from this directory.

## Token setup

The bearer token is the same `LINKSBLUE_ARCHIVE_API_KEY` value the
Mac daemon reads from Keychain and that Railway uses as the env var
`ARCHIVE_API_KEY` for the `linksblue` service. The extension's
options page accepts the same value.

After saving the token:

- The Save button confirms with "Saved." for two seconds.
- The "Current token" row shows the first 8 characters + `...` so you
  can verify which token is loaded without revealing the full secret.
- Test connection POSTs `{test: true}` to the ingest endpoint and
  reports the result. Expected outcomes:
  - 401 → token is wrong.
  - Other 4xx (e.g. 400) → token is correct (the empty body is
    rejected by Mode B field validation, which is expected for a
    sanity check). Auth passed, payload rejected as expected for the
    test ping. Response body preview is included.
  - 5xx or network error → endpoint problem; not a token problem.

## How to inspect captures

The popup remains the debug surface. The capture buffer is now capped
at 50 entries (down from 200 in v0.1) since posted captures live in
`ai-archive`. Each entry shows relative time, HTTP status, URL path.
Click a row to expand: full URL, idHash, raw `parsedJson` `<pre>`.

Three buttons:

- **Copy all to clipboard** — JSON array of the buffered captures.
- **Clear** — wipes the buffer (does not affect ingest history or
  retry queue).
- **Open options** — opens the options page.

The popup status section shows token state, last successful POST,
total POSTs, and retry queue depth. A yellow banner appears when no
token is configured.

## Verifying captures land

After installing v0.2.0, configuring the token, and exercising one
real `claude.ai` conversation, look for a new file under:

```
TRIADBLUE/ai-archive/2026/05/<DD>-claude_web-<slug>.md
```

The frontmatter `source_id` field will read `claude_web:<conv-uuid>`.
Subsequent turns in the same conversation append to the same file
(Mode B snapshot/append).

If 30 minutes pass without a file appearing:

- Check the popup capture count. Non-zero = wrapper firing.
- Check the popup status. Token configured = yes. Last successful
  POST = recent. Retry queue depth = 0.
- If captures buffered but POSTs not happening: token may be wrong.
  Open options → Test connection.
- If POSTs happening but no archive file: check Railway logs for the
  linksblue service.

## Boundaries

The extension does NOT do any of the following in v0.2.x:

- Modify `claude.ai` in any way. No DOM mutation, no UI injection,
  no event interception that alters page behavior.
- Read from the `claude.ai` DOM. Capture is via fetch / XHR wrappers
  observing the page's own chat_conversations GET responses — never
  via scraping.
- Capture the SSE completion stream. The chat_conversations GET is
  sufficient and avoids streaming complexity.
- POST anywhere except
  `https://github.linksblue.network/api/archive/ingest`.
- Log the bearer token. Token is stored only in
  `chrome.storage.local` under the single key `linksblue.token`,
  displayed only as "first 8 chars + ..." in the options page, and
  never appears in any console output, postMessage, or popup display.
- Back-fill historical conversations. Only conversations the user
  exercises after install are captured.
- Run on any URL outside `https://claude.ai/*`. The host_permissions
  list contains exactly `claude.ai` and `github.linksblue.network`.

## Numbering

- v0.1.0 — Prompt 05/06/2026-29 (pass 1 of 2 — scaffold + wrapper).
- v0.2.0 — Prompt 05/06/2026-31 (pass 2 of 2 — transformer + POST +
  options + popup status).
