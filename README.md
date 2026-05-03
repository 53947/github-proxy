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

- `POST /api/archive/ingest` — receives conversation captures from the linksblue capture daemon and commits each one as a markdown file to `TRIADBLUE/ai-archive`. Bearer auth required: `Authorization: Bearer <ARCHIVE_API_KEY>`. Returns `{ status: "created", path }` on first ingest, `{ status: "duplicate", path }` if `source_id` already exists in the archive.

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
