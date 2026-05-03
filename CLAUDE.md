# CLAUDE.md — linksblue
# Last updated: 2026-05-03

---

## READ THE UNIVERSAL RULES FIRST

Before doing ANY work in this repo, fetch and read the TRIADBLUE Universal Brand Rules:

```
curl -s "https://github.linksblue.network/api/github/file?repo=triadblue.rulebook&path=CLAUDE.MD"
```

If the proxy's `GITHUB_TOKEN` does not yet have access to the private `triadblue.rulebook` repo, fall back to the public mirror:

```
curl -s "https://github.linksblue.network/api/github/file?repo=.github&path=CLAUDE.MD"
```

Also read the continuity briefing (now in markdown — was migrated from .txt 2026-05-02):

```
curl -s "https://github.linksblue.network/api/github/file?repo=triadblue.rulebook&path=TRIADBLUE_CONTINUITY_BRIEFING.md"
```

Also read the editing rules:

```
curl -s "https://github.linksblue.network/api/github/file?repo=triadblue.rulebook&path=RULEBOOK_EDITING_RULES.md"
```

These rules govern brand casing, payment, ecosystem standards. Non-negotiable.

---

## PLATFORM IDENTITY

**Name:** linksblue (lowercase — distinct from LINKBlue, the link-monitoring product at LINKBlue.systems)
**Role:** Agent-facing infrastructure for the TRIADBLUE ecosystem. GitHub proxy + MCP server + conversation archive ingest.
**Stack:** Node.js (>=18) + Express + `@modelcontextprotocol/sdk` (Streamable HTTP transport). No database server; archive storage is a Git repo.
**Deployment:** Railway (nixpacks builder, `npm start`). No Procfile, no railway.json — `railway.toml` is the only deploy config.
**Custom domain:** `https://github.linksblue.network`
**Railway domain:** `https://linksblue-githubproxy.up.railway.app`
**Repo:** `TRIADBLUE/linksblue` (formerly `TRIADBLUE/github-proxy`, renamed 2026-05-02 as part of the linksblue.network platform setup)
**Local path:** `/Users/deanlewis/linksblue` (post-rename — was `/Users/deanlewis/github-proxy`)
**Companion repo:** `TRIADBLUE/ai-archive` (private) — receives commits from the archive ingest endpoint.

### Environment variables

| Name | Purpose |
|------|---------|
| `GITHUB_TOKEN` | GitHub PAT. Read access on TRIADBLUE org for the proxy/MCP tools. Write access on `TRIADBLUE/ai-archive` (private) for archive ingest commits. |
| `GITHUB_ORG` | Defaults to `TRIADBLUE`. |
| `ARCHIVE_API_KEY` | Bearer token required by `POST /api/archive/ingest`. Stored on Dean's Mac in macOS Keychain at service `linksblue-archive-api-key`. Set on Railway as the env var of the same name. |
| `PORT` | Defaults to 3000; Railway uses 8080 via the public-domain port mapping. |

---

## ARCHITECTURE

### GitHub MCP tools — DO NOT MODIFY

`index.js` registers nine MCP tools via `@modelcontextprotocol/sdk`:

`list_repos`, `get_repo`, `list_files`, `read_file`, `list_branches`, `list_issues`, `list_pulls`, `search_code`, `list_commits`.

Mount points:
- `/mcp` — primary (HEAD, POST, GET, DELETE)
- `/` — Claude.ai compatibility mount (HEAD, POST, DELETE)

Session management: `StreamableHTTPServerTransport` with an in-memory `eventStore` for resumability. Sessions are NOT auto-expired — clients don't reliably re-initialize.

REST mirror of these reads is mounted under `/api/github/*`.

These tool registrations and the REST endpoints below them are existing infrastructure used by every running Claude session connected to this MCP server. **Do not refactor, rename, reorder, or "improve" any of them without an explicit prompt scoping that work.**

### Archive ingest

`routes/archive-ingest.js` — `POST /api/archive/ingest`. Authenticated with `Authorization: Bearer <ARCHIVE_API_KEY>`. Receives conversations from the linksblue capture daemon (Prompt 05/01/2026-10) and commits each one to `TRIADBLUE/ai-archive` as a markdown file with YAML frontmatter.

**Path convention** (in `ai-archive`):

```
YYYY/MM/DD-{platform}-{slug}.md
```

Slug = lowercased title, alphanumeric and hyphens only, max 60 chars.
Platform is one of: `claude_code`, `claude_web`, `claude_desktop`, `cowork`.

**Dedupe:** each request includes `source_id` (unique to the source system). Before committing, the route runs a GitHub code search for `"source_id: <id>"` scoped to `TRIADBLUE/ai-archive`. If a match is found, the route returns `{ status: "duplicate", path: <existing> }` and skips the commit.

**Single-user auth:** comment `// SINGLE-USER AUTH — multi-user plug point goes here` marks the place where the bearer-check middleware would be replaced with a per-user resolver.

**Mounted in `index.js` via:**

```javascript
app.use('/api/archive', require('./routes/archive-ingest'));
```

This line sits between the existing `/api/github/lines` route and the `app.get('/', ...)` health-check handler.

### Where the archive lives

`TRIADBLUE/ai-archive` (private). One markdown file per conversation. Phase 2 will add `archive.db` (SQLite FTS5) at the repo root for keyword search.

### GitHub WRITE tools (added 2026-05-03 by Prompt 05/03/2026-12)

Four MCP tools registered alongside the read tools, and four REST endpoints under `/api/github/*`. Gated by bearer auth (`LINKSBLUE_WRITE_KEY`) and repo allow-list (`WRITE_ALLOWED_REPOS`). The intent: linksblue is the SINGLE GitHub-access surface for the whole ecosystem — read AND write, public AND private — replacing the multi-connector setup with one.

**MCP tools — single-file:**
- `write_file` — DEFAULT WRITE TOOL FOR ONE FILE. Sha auto-fetched. Message auto-generated. Idempotent.
- `delete_file` — Just give repo, path. Sha auto-fetched.
- `create_branch` — Branch from another branch's HEAD.
- `move_file` — Rename/move in one tool call.

**MCP tools — multi-file and refs (v2.6):**
- `push_files` — DEFAULT WRITE TOOL FOR MULTIPLE FILES. Atomic. ONE commit, ONE deploy. Use this instead of multiple `write_file` calls when changes belong together.
- `create_ref` — Create any git ref (branch OR tag). For tags use `refs/tags/v1.0`; for branches `refs/heads/X` (or use `create_branch`).

**MCP tools — pull requests (v2.6):**
- `create_pull_request` — Open a PR. Auto-defaults `base` to repo default branch.
- `merge_pull_request` — Merge a PR. Supports merge / squash / rebase methods.

**MCP tools — issues (v2.6):**
- `create_issue` — Open a new issue. Optional labels and assignees.
- `update_issue` — Edit an issue (close/reopen, change title/body/labels).
- `add_issue_comment` — Comment on an issue or PR.

**MCP tool — escape hatch (v2.6):**
- `gh_api` — Generic GitHub REST API passthrough. Use ONLY when no specialized tool exists. Forwards `{method, path, body}` with the proxy's GITHUB_TOKEN. Logged in full.

**MCP tools — prompt-numbering ledger (v2.7):**
- `claim_number` — Atomically claim a new PROMPT or SEGUE number from `TRIADBLUE/ai-archive/PROMPT_LOG.md`. Returns the assigned id. Optimistic concurrency, 3 retries on race. Use this BEFORE drafting any prompt or segue. NEVER guess a number.
- `claim_response` — Atomically claim a response letter (a, b, c, ...) under an existing parent prompt.
- `update_prompt_status` — Lifecycle update: claimed → fired → committed → verified (or abandoned).

**REST endpoints (parallel to MCP tools):**
- `POST /api/github/file` — write_file
- `DELETE /api/github/file` — delete_file
- `POST /api/github/branch` — create_branch
- `POST /api/github/move` — move_file
- `POST /api/github/push` — push_files (multi-file atomic)
- `POST /api/github/ref` — create_ref
- `POST /api/github/pull` — create_pull_request
- `PUT /api/github/pull/merge` — merge_pull_request
- `POST /api/github/issue` — create_issue
- `PATCH /api/github/issue` — update_issue
- `POST /api/github/issue/comment` — add_issue_comment
- `POST /api/github/raw` — gh_api passthrough
- `POST /api/archive/claim-number` — claim_number (PROMPT or SEGUE)
- `POST /api/archive/claim-response` — claim_response
- `PATCH /api/archive/prompt-status` — update_prompt_status

**Lazy-agent-friendly defaults — these fields are OPTIONAL:**

| Field | Default if omitted |
|---|---|
| `message` | `[linksblue] <op> <path>` (e.g. "[linksblue] update CLAUDE.MD") |
| `branch` | The repo's default branch |
| `sha` | Auto-fetched from current state of the file |

**Path normalization:** Leading/trailing slashes stripped automatically (`/foo/bar/` → `foo/bar`). Whitespace trimmed. Common agent gotcha eliminated.

**Idempotency:** `write_file` compares new content against the current file (when one exists). If identical, no commit is made — returns `{status: "unchanged"}`. Safe to retry.

**Allow-list modes (WRITE_ALLOWED_REPOS env var):**
- `*` — any repo in `GITHUB_ORG` is writable (Dean's current setup)
- `repo1,repo2,...` — only the listed repos
- unset/empty — all writes return 403

Bearer auth via `LINKSBLUE_WRITE_KEY` is the primary security gate; the allow-list is a second independent check.

---

## BRAND CASING REMINDER

- **TRIADBLUE** — always all caps. Parent company.
- **LINKBlue** — exact mixed case. Link-monitoring product at `LINKBlue.systems`. **NOT this repo.**
- **linksblue** — lowercase. **THIS repo.** Agent-facing infrastructure at `linksblue.network`.
- All other platforms (`hostsblue.com`, `swipesblue.com`, `businessblueprint.io`, `scansblue.com`, `builderblue2`, `tbsys`) — lowercase.

If you find yourself about to write to `TRIADBLUE/linkblue` instead of `TRIADBLUE/linksblue`, stop. That is the wrong repo.

---

## DO NOT MODIFY (without an explicit prompt)

- All nine read `server.tool(...)` registrations inside `createMcpServer()` in `index.js`.
- All write `server.tool(...)` registrations: `write_file`, `delete_file`, `create_branch`, `move_file`, `push_files`, `create_ref`, `create_pull_request`, `merge_pull_request`, `create_issue`, `update_issue`, `add_issue_comment`, `gh_api`, `claim_number`, `claim_response`, `update_prompt_status`.
- `ghHeaders()`, `ghFetch()`, `ghPut()`, `ghPost()`, `ghPatch()`, `ghDeleteContents()`, `ghGetFile()`, `ghGetSha()`, `pushFilesAtomic()` helpers.
- `parseHighestN()`, `findResponsesForParent()`, `nextAlphabetic()`, `highestLetterFrom()`, `todayDateMMDDYYYY()`, `todayISODate()`, `buildPromptRow()`, `insertRowAtTopOfLog()`, `updateNextNumberLine()`, `updateRowStatus()`, `isShaConflict()`, `claimNumberAtomic()`, `claimResponseAtomic()`, `updatePromptStatusAtomic()` v2.7 prompt-log helpers.
- `normalizePath()`, `defaultMessage()` helpers.
- `getAllowedRepos()`, `isRepoAllowed()`, `repoDenialReason()` allow-list functions.
- `requireWriteKey()`, `requireAllowedRepo()`, `logWrite()` middleware.
- `InMemoryEventStore` class.
- `handleMcpPost`, `handleMcpGet`, `handleMcpDelete`, `handleMcpHead` handlers.
- The `app.head/post/get/delete('/mcp', ...)` and `app.head/post/delete('/', ...)` MCP route mounts.
- All `/api/github/*` REST endpoints (read AND write — see full inventory above).
- `GITHUB_TOKEN` flow.
- Existing CORS middleware.

The only line Phase 1 adds inside `index.js` is:

```javascript
app.use('/api/archive', require('./routes/archive-ingest'));
```

inserted before the health-check handler.

---

## PENDING

### Phase 2 — Retrieval tools and search UI (Prompt 05/01/2026-9, Gate 5)

Cannot start until daemon is capturing conversations and `ai-archive` has content.

- `archive.db` — SQLite FTS5 index file at root of `TRIADBLUE/ai-archive`. Schema: `conversations` table + `conversations_fts` virtual table on title and message content.
- `scripts/rebuild-index.js` — pulls `ai-archive`, walks markdown, rebuilds `archive.db`, commits the updated DB back. Idempotent.
- Incremental update in `routes/archive-ingest.js` — insert one row + commit `archive.db` alongside the markdown file.
- Four MCP tools — `search_conversations`, `get_conversation`, `list_recent`, `archive_decision`. All four pull `archive.db` from raw URL on first call, cache locally for 60 seconds.
- `GET /search` web UI — single HTML, mobile-friendly, Triad White `#E9ECF0` background, Archivo typography. Bearer auth or session cookie via `/search/login`.

### Phase 3 — Weekly archive audit (Prompt 05/01/2026-9, Gate 7)

Cowork scheduled task. Pulls `ai-archive`, rebuilds the index, detects drift between markdown files and the DB, counts ingests by platform per week, opens (and auto-closes if green) a weekly GitHub issue in `TRIADBLUE/linksblue`.

### Outstanding observations (not Phase 1 scope)

- MCP server's internal name is `'triadblue-github'` (in `createMcpServer()`). Same — strictly outside Phase 1 scope.
- `.DS_Store` is currently committed at the repo root. Mac metadata cruft. Separate cleanup.

---

## CURRENT STATE CHANGELOG

| Date | Changes |
|------|---------|
| 2026-05-03 | **Phase 1 — Archive ingest endpoint added.** Builds on the prior 2.4 deploy (which already shipped `consoleblue-github-proxy` → `linksblue-github-proxy` rename and added `write_file`/`delete_file`/`create_branch` MCP tools). `package.json` `name` field changed to `"linksblue"`. New file `routes/archive-ingest.js` implements `POST /api/archive/ingest` with bearer auth (`ARCHIVE_API_KEY`), body validation (platform enum, ISO 8601 timestamps, non-empty `source_id`), GitHub code-search dedupe on `source_id`, and PUT-to-Contents-API commit to `TRIADBLUE/ai-archive` at path `YYYY/MM/DD-{platform}-{slug}.md`. `index.js` patched with one wiring line `app.use('/api/archive', require('./routes/archive-ingest'))` inserted before the health-check route — all existing GitHub MCP tools, REST endpoints, MCP session handling, and `/mcp` mounts left untouched. New root `README.md` documents the service, URLs, endpoints, env vars. New `CLAUDE.md` (this file) replaces the prior placeholder. Companion repo `TRIADBLUE/ai-archive` initialized with its own `README.md` documenting the folder structure and file format. (Prompt 05/01/2026-9, Gate 2.) |
| 2026-05-03 | **v2.5 — write endpoints made lazy-agent-friendly.** Builds on v2.4. (1) `message` field is now optional on write_file, delete_file, move_file — defaults to `[linksblue] <op> <path>`. (2) Path normalization helper strips leading/trailing slashes and whitespace before any GitHub API call. (3) `write_file` now does an idempotency check: if the new content matches the current file's content, returns `{status: "unchanged"}` and does not make a no-op commit. (4) New tool `move_file` (and `POST /api/github/move`) renames/moves a file in one tool call — server does the read+write+delete sequence internally. (5) `WRITE_ALLOWED_REPOS=*` wildcard supported (any repo in the org). (6) MCP tool descriptions rewritten to be self-explanatory: each one tells the agent what's required vs auto-handled. (7) `ghGetFile()` helper introduced returning `{sha, content}` so the idempotency check doesn't add a round trip; `ghGetSha()` retained as a thin wrapper. Service version bumped 2.4 → 2.5. (Prompt 05/03/2026-12.) |
| 2026-05-03 | **v2.6 — agent toolkit completion.** Per Cowork's gap analysis, eight new MCP tools and seven new REST endpoints, addressing the workflow gaps that forced 5 separate Railway deploys for what was logically one Phase 1 commit. (1) `push_files` (POST /api/github/push) — atomic multi-file commit via Git Data API (blobs → tree → commit → ref update); ONE commit for any number of files. (2) `create_pull_request` (POST /api/github/pull) — opens PRs with auto-default base branch, enables the "Cowork pushes to staging, Dean merges" workflow. (3) `merge_pull_request` (PUT /api/github/pull/merge) — merge / squash / rebase methods. (4) `create_ref` (POST /api/github/ref) — generic ref creation for tags AND branches (Cowork couldn't tag the pre-Phase-1 restore point earlier — fixed). (5) `create_issue` (POST /api/github/issue) + `update_issue` (PATCH /api/github/issue) + `add_issue_comment` (POST /api/github/issue/comment) — needed for Phase 3 weekly archive audit (auto-open and auto-close weekly status issues). (6) `gh_api` (POST /api/github/raw) — generic GitHub REST API passthrough escape hatch for future API needs (rate limit checks, workflow dispatches, releases, deployments) without shipping new tools. New helpers: `ghPatch()`, `pushFilesAtomic()`. Service version bumped 2.5 → 2.6. (Prompt 05/03/2026-12, Cowork feedback.) |
| 2026-05-03 | **v2.7 — atomic prompt-numbering ledger.** Three new MCP tools / REST endpoints that make prompt numbering structurally enforced (no agent can guess a number). All operate against `TRIADBLUE/ai-archive/PROMPT_LOG.md` using optimistic concurrency control: read the file with its current sha, modify, conditional PUT, retry up to 3 times on sha mismatch. (1) `claim_number` (POST /api/archive/claim-number) — claims next N for a PROMPT or SEGUE, writes a row with status=claimed, returns the assigned id. (2) `claim_response` (POST /api/archive/claim-response) — claims next letter (a, b, c, ...) under a parent prompt. Responses do NOT increment N. (3) `update_prompt_status` (PATCH /api/archive/prompt-status) — lifecycle update through claimed → fired → committed → verified (or abandoned). New helpers added (parsing, alphabetic increment, row insertion, conditional update). Bearer auth via LINKSBLUE_WRITE_KEY. Service version bumped 2.6 → 2.7. (Prompt 05/03/2026-13.) |

**AGENTS: Update this section on every commit. Your work is not done until this changelog reflects it.**
**AGENTS: All code changes go to `staging` branch. NEVER push to `main` directly.**
| 2026-05-03 | **Phase 1.5 — Ingest snapshot/append mode (Prompt 05/03/2026-17).** Endpoint `POST /api/archive/ingest` now supports two request modes. **Mode A** (legacy single-conversation capture, fully backward compatible) accepts `messages` + `ended_at` and creates one markdown file per conversation. **Mode B** (snapshot/append) accepts `new_messages` + `from_index` + `last_updated` for the same `source_id` across multiple POSTs; first POST creates the file, subsequent POSTs append only the truly new messages and update the `last_updated` and `snapshot_count` frontmatter fields. Mode B handles three retry/race cases: clean append (`from_index == message_count`), retry of an already-applied snapshot (`from_index < message_count` — slices and appends only the new tail, returns `no_change` if nothing new), and gap detection (`from_index > message_count` — returns 409 with `expected_from_index`). Frontmatter gains `last_updated` and `snapshot_count` fields; existing Mode A files written before Phase 1.5 still work — Mode B falls back to `snapshot_count: 1` when reading them. Helper functions added: `parseFrontmatter`, `parseExistingBody`, `validateModeA`, `validateModeB`, `modeOf`, `handleModeA`, `handleModeB`. No changes to `index.js` (mount line already at L1570), `package.json` (no new deps), or `claim_*` / `update_prompt_status` endpoints. (Prompt 05/03/2026-17, Cowork.) |

**AGENTS: After every PR merge, sync main back into staging: `git pull origin main && git push origin staging`.**

