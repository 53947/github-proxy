# linksblue

Agent-facing infrastructure for the TRIADBLUE ecosystem. Hosts the GitHub proxy that lets web-based agents read TRIADBLUE repositories, the MCP server that exposes those reads as Model Context Protocol tools, and the conversation-archive ingest endpoint that captures AI conversations into a durable Git-backed archive.

## URLs

| Domain | Purpose |
|--------|---------|
| `https://github.linksblue.network` | Custom domain, primary |
| `https://linksblue-githubproxy.up.railway.app` | Railway-generated domain, equivalent |

Both resolve to the same Railway service on port 8080.

## Endpoints

### MCP — Model Context Protocol

- `POST /mcp` (also mounted at `/`) — Streamable HTTP MCP transport
- `GET /mcp`, `DELETE /mcp`, `HEAD /mcp` — session management

Tools exposed: `list_repos`, `get_repo`, `list_files`, `read_file`, `list_branches`, `list_issues`, `list_pulls`, `search_code`, `list_commits`.

### REST — direct GitHub proxy

- `GET /api/github/repos`
- `GET /api/github/files?repo=&path=`
- `GET /api/github/file?repo=&path=`
- `GET /api/github/commits?repo=&branch=`
- `GET /api/github/branches?repo=`
- `GET /api/github/grep?repo=&path=&q=`
- `GET /api/github/search?repo=&path=&q=&ext=`
- `GET /api/github/lines?repo=&path=&from=&to=`

### Archive ingest

`POST /api/archive/ingest` — receives conversation captures and commits each one as a markdown file to `TRIADBLUE/ai-archive`. Bearer auth required: `Authorization: Bearer <ARCHIVE_API_KEY>`.

Two request modes, distinguished by which fields are present:

**Mode A — single-shot capture** (legacy, backward compatible). Send a complete conversation in one POST.

```
curl -X POST https://github.linksblue.network/api/archive/ingest \
  -H "Authorization: Bearer $ARCHIVE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "claude_code",
    "title": "Build session",
    "started_at": "2026-05-03T18:00:00Z",
    "ended_at": "2026-05-03T19:30:00Z",
    "source_id": "session-abc-123",
    "messages": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]
  }'
```

Returns `{"status": "created", "path": "..."}` on first ingest, `{"status": "duplicate", "path": "..."}` if the same `source_id` was already committed.

**Mode B — snapshot/append**. Send incremental snapshots of a still-evolving conversation. The first snapshot for a `source_id` creates the file; subsequent snapshots append the new messages.

```
curl -X POST https://github.linksblue.network/api/archive/ingest \
  -H "Authorization: Bearer $ARCHIVE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "claude_web",
    "title": "Live session",
    "started_at": "2026-05-03T20:00:00Z",
    "last_updated": "2026-05-03T20:15:00Z",
    "source_id": "session-xyz-789",
    "from_index": 0,
    "new_messages": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]
  }'
```

Response shapes:
- `{"status": "created", "path": "...", "snapshot_count": 1, "message_count": N}` — first snapshot.
- `{"status": "appended", "path": "...", "snapshot_count": K, "message_count": N, "appended": M}` — subsequent snapshot.
- `{"status": "no_change", ...}` — retry of an already-applied snapshot, no new messages.
- `409 {"error": "snapshot gap detected", "expected_from_index": N, "got_from_index": M, ...}` — `from_index` ahead of the archive (daemon state ahead of server state). Send a reconciliation snapshot starting at `expected_from_index` with the missing messages.

Field reference:

| Field | Mode A | Mode B | Notes |
|------|--------|--------|-------|
| `platform` | required | required | Enum: `claude_code`, `claude_web`, `claude_desktop`, `cowork` |
| `title` | required | required | Latest snapshot's title wins on append |
| `started_at` | required | required | ISO 8601; never overwritten after first POST |
| `source_id` | required | required | Unique ID from the source system |
| `ended_at` | required | — | ISO 8601 (Mode A only) |
| `messages` | required | — | Full message array (Mode A only) |
| `last_updated` | — | required | ISO 8601, refreshed every snapshot (Mode B) |
| `from_index` | — | required | Integer; index this snapshot's `new_messages` start at (Mode B) |
| `new_messages` | — | required | Messages added since last snapshot (Mode B) |
| `metadata` | optional | optional | Free-form object |

Mode is detected by which mutually-exclusive field set is present. If both `messages`+`ended_at` AND `new_messages`+`from_index` are sent, the request is rejected with 400.

### Health

- `GET /` (no MCP session header) — service status JSON.

## Stack

- Node.js (>=18) + Express
- `@modelcontextprotocol/sdk` for MCP server (Streamable HTTP transport)
- Deployed on Railway via the nixpacks builder; `railway.toml` is the only deploy config

## Environment variables

| Name | Purpose |
|------|---------|
| `GITHUB_TOKEN` | GitHub PAT used by the proxy and archive ingest. Needs read on TRIADBLUE org and write on `TRIADBLUE/ai-archive`. |
| `GITHUB_ORG` | Defaults to `TRIADBLUE`. |
| `ARCHIVE_API_KEY` | Bearer token required by `POST /api/archive/ingest`. Single-user auth. Mirrored in macOS Keychain on Dean's Mac at service `linksblue-archive-api-key`. |
| `PORT` | Defaults to 3000; Railway uses 8080 via the public-domain port mapping. |

## Companion projects

- `TRIADBLUE/ai-archive` (private) — Git-backed conversation archive. Receives commits from `POST /api/archive/ingest`.
- linksblue capture daemon (Prompt 05/01/2026-10) — macOS LaunchAgent that watches Claude Code, Claude.ai web/desktop, and Cowork local files and POSTs new conversations to the ingest endpoint.

## See also

- `CLAUDE.md` — agent instructions for working in this repo. Read before any code change.
- TRIADBLUE Universal Brand Rules — `TRIADBLUE/triadblue.rulebook/CLAUDE.MD` (private; public mirror at `TRIADBLUE/.github/CLAUDE.MD`).

