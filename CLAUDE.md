# linksblue GitHub Proxy — Claude Code Instructions
# Project-specific rules. Global rules in ~/.claude/CLAUDE.md apply to every session.
# Canonical org-wide rules: TRIADBLUE/triadblue.rulebook/CLAUDE.MD (private).

## WHAT THIS IS

GitHub proxy for Claude web chat, Claude Desktop, Cowork, and any other
MCP-capable surface to access TRIADBLUE repos. Acts as the single
authentication boundary between Claude surfaces and the GitHub API.

Canonical URL: https://github.linksblue.network/mcp
Legacy origin: https://linkblue-githubproxy.up.railway.app (still active)

## WHAT IT EXPOSES

### Read tools (open — no auth)
- list_repos, get_repo, list_files, read_file, list_branches,
  list_issues, list_pulls, search_code, list_commits

### Read REST endpoints (open — no auth)
- GET /api/github/repos
- GET /api/github/files
- GET /api/github/file
- GET /api/github/commits
- GET /api/github/branches
- GET /api/github/grep
- GET /api/github/search
- GET /api/github/lines

### Write tools (bearer-auth + repo allow-list)
- write_file (create or update; auto-fetches sha)
- delete_file (auto-fetches sha)
- create_branch

### Write REST endpoints (bearer-auth + repo allow-list)
- POST /api/github/file
- DELETE /api/github/file
- POST /api/github/branch

## ENVIRONMENT VARIABLES (Railway)

- `GITHUB_TOKEN` — required. Must have `repo` scope (full private read+write).
- `GITHUB_ORG` — defaults to `TRIADBLUE`. Override only if testing.
- `LINKSBLUE_WRITE_KEY` — required for write endpoints. 32-char random.
  Without it, writes return 401.
- `WRITE_ALLOWED_REPOS` — controls which repos accept writes. Three modes:
  - `*` — any repo in the GITHUB_ORG is writable (broadest; default for Dean's setup)
  - `repo1,repo2,repo3` — only listed repos are writable (strictest)
  - unset/empty — all writes return 403 (disabled)
  Reads are unaffected by this variable.

## SECURITY MODEL

Reads are open by design — Claude surfaces query without per-request
auth (the `GITHUB_TOKEN` server-side handles GitHub auth). Writes are
gated by TWO independent checks:

1. **Bearer auth** — `Authorization: Bearer ${LINKSBLUE_WRITE_KEY}` header
2. **Repo allow-list** — request's `repo` field must be in `WRITE_ALLOWED_REPOS`

Both must pass. Every successful write is logged to console with: timestamp,
operation, repo, path, byte size, caller IP, auth header sha-256 prefix.

## ARCHITECTURE NOTE

This proxy is BACKEND ONLY. Per the org-wide rule (CLAUDE.MD section
"ARCHITECTURE RULE — UI vs BACKEND SEPARATION"), any UI for managing
this proxy (request log viewer, allow-list editor, write-key rotation,
deploy status) lives on **triadblue.systems** and calls these
endpoints over HTTP. Do not bake admin UI into this codebase.

## PROJECT-SPECIFIC INSTRUCTIONS

- All edits to index.js follow the rulebook's editing rules:
  TRIADBLUE/triadblue.rulebook/RULEBOOK_EDITING_RULES.md
- This repo has a single `main` branch. No staging.
- Railway auto-deploys on push to main.
- Never commit secrets — `LINKSBLUE_WRITE_KEY` and `GITHUB_TOKEN` are
  set in Railway service variables, not in code or .env.
- The legacy Railway origin URL is kept active for backward compat with
  existing clients. New code should use the canonical custom domain.
