# linksblue-daemon

Local capture daemon. Runs as a macOS LaunchAgent on Dean's machines.
Every 15 minutes it walks three local sources, finds AI conversations
that have new messages since the last snapshot, and POSTs the deltas
to the linksblue archive ingest endpoint in **Mode B** (snapshot/append).

Builds on **Prompt 05/03/2026-17 (INGEST_SNAPSHOT_MODE)** — Mode B is
required for this daemon to function.

Per the architecture rule, the daemon's code lives on `linksblue.network`
(this repo). The conversation data goes to `TRIADBLUE/ai-archive` via
the ingest endpoint — this daemon never writes there directly.

## What it captures

| Source | Path | Platform |
|---|---|---|
| Claude Code CLI sessions | `~/.claude/projects/**/*.jsonl` | `claude_code` |
| Cowork local sessions | `~/Library/Application Support/Claude/local-agent-mode-sessions/` | `cowork` |
| Claude.ai web + Claude Desktop | `~/Library/Application Support/Claude/IndexedDB/https_claude.ai_0.indexeddb.leveldb/` | `claude_web` / `claude_desktop` |

Conversations accumulate over hours/days. There is no "session end"
trigger — the daemon just appends new messages each pass.

## How it works

1. Read API key from macOS Keychain (`linksblue-archive-api-key`).
2. Load state from `~/.linksblue-daemon/state.json`.
3. Every 15 minutes:
   - Drain the failure queue first (any deltas that couldn't post on
     the previous pass).
   - Mark conversations as `inactive` if `last_seen_at` is older than 7 days.
   - Run each watcher in turn. Each watcher returns deltas for any
     conversation with new messages since `last_message_index`.
   - POST each delta to `/api/archive/ingest` (Mode B). On success,
     update `state.json` with the new index and `snapshot_count`.
   - On 5xx / network errors: exponential backoff (1s, 2s, 4s),
     max 3 retries, then queue locally.
4. On `SIGTERM` / `SIGINT`: flush state, exit cleanly.

## Install

```bash
cd /Users/deanlewis/linksblue-network/daemon
./install.sh
```

The installer:

- Verifies Node 18+ is available.
- Verifies the Keychain entry `linksblue-archive-api-key` exists. If
  not, run:
  ```bash
  security add-generic-password -s linksblue-archive-api-key -a deanlewis -w 'YOUR_KEY'
  ```
  before re-running install.
- Verifies (warns if missing) the three watch paths.
- Creates `~/.linksblue-daemon/` with `queue/` and `parse-failures/`.
- Runs `npm install --omit=dev`.
- Renders the LaunchAgent plist with the resolved Node path and copies
  it to `~/Library/LaunchAgents/com.triadblue.linksblue-daemon.plist`.
- Loads it via `launchctl load`.
- Tails the log for 10 seconds so you see startup messages.

## Verify it's running

```bash
launchctl list | grep linksblue-daemon
tail -f ~/.linksblue-daemon/daemon.log
```

## Round-trip test

```bash
./test.sh
```

Posts two synthetic snapshots (Mode B create + Mode B append) to the
live endpoint and confirms the responses look right. Prompts to delete
the test file at the end.

## Uninstall

```bash
./uninstall.sh
```

Unloads the LaunchAgent and removes the plist. **Leaves
`~/.linksblue-daemon/` intact** (state, logs, queue) so reinstall
picks up where it left off.

## Known behaviors (NOT bugs)

- **leveldb locked while Claude is running.** Logged at INFO level
  ("leveldb locked, will retry next pass"). Next 15-minute pass will
  succeed if Claude is closed or has released the lock.
- **leveldb format changes.** The Anthropic schema is undocumented.
  When parsing throws, the offending bytes are saved to
  `~/.linksblue-daemon/parse-failures/` and the watcher continues. If
  failures spike to 5+ per pass for the same root cause, a throttled
  GitHub issue is opened (max one per 24h per error type).
- **Stale conversations.** No activity for 7 days → marked inactive
  → no longer polled. Reactivate by editing `state.json` (set
  `active: true`) — but usually you don't want to.

## Multi-machine setup

Each machine needs its own Keychain entry. Add it with
`security add-generic-password -s linksblue-archive-api-key -a deanlewis -w 'YOUR_KEY'`
**before** running `install.sh` on a new machine.

If you sign in to claude.ai on multiple machines, each machine's
daemon will independently capture web conversations. The ingest
endpoint's Mode B retry handling makes overlapping snapshots safe —
the second snapshot of the same content returns `no_change`.

## Failure modes

| Symptom | Action |
|---|---|
| `INGEST 401 — auth drift` in log, daemon exits | Keychain key doesn't match Railway `ARCHIVE_API_KEY`. Update the key on whichever side is wrong, then `launchctl load` again. |
| `INGEST 409 (gap)` repeatedly | `state.json` is out of sync with archive. Inspect `~/.linksblue-daemon/queue/` for the queued payload. Reconciliation requires manual intervention. |
| `leveldb locked, will retry next pass` recurring | Normal while Claude is running. Close Claude to allow capture. |
| Daemon stops appearing in `launchctl list` | KeepAlive failed. Check `~/.linksblue-daemon/daemon.log` for the exit reason. |

## Files

```
daemon/
├── daemon.js                              # entry point
├── watchers/
│   ├── claude-code.js                    # ~/.claude/projects/
│   ├── cowork.js                         # local-agent-mode-sessions/
│   └── claude-leveldb.js                 # IndexedDB read-only
├── com.triadblue.linksblue-daemon.plist  # LaunchAgent template (__NODE_PATH__ rendered at install)
├── install.sh
├── uninstall.sh
├── test.sh
├── package.json
└── README.md
```
