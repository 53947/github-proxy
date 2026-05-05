================================================================
  Prompt #: 05/05/2026-26
  Title:    LINKSBLUE_MCP_CLAIM_TOOLS
  Status:   committed (docs-only — code already shipped under 05/03/2026-13)
  Author:   Claude Code (Mac)
  Platform: linksblue.network
  Created:  2026-05-05
  Approved: 2026-05-05  (Dean — discovered tools/auth/TTL were already in place; scope reduced to README + CLAUDE.md sync)
================================================================

GOAL
----
Close the gap that prevents non-Mac agents (Cowork, Claude.ai web,
any future MCP client) from claiming prompt numbers themselves.
Expose the three existing claim REST endpoints as first-class MCP
tools on the linksblue MCP server so any agent connected to the
proxy can claim, respond, and update status without ever handling
the LINKSBLUE_WRITE_KEY.

CONTEXT
-------
PROMPT_LOG.md is authoritative-by-law and the only sanctioned writers
are the three endpoints under `/api/archive/`. Today those endpoints
are REST-only and gated by `LINKSBLUE_WRITE_KEY`. The linksblue MCP
server (the same Express app, see `linksblue/index.js` and the README's
"MCP" section) currently exposes only read tools: `list_repos`,
`get_repo`, `list_files`, `read_file`, `list_branches`, `list_issues`,
`list_pulls`, `search_code`, `list_commits`.

This means an agent running outside the Mac (Cowork session, browser
agent, any third-party MCP client) can READ TRIADBLUE repos through
the MCP but CANNOT claim a prompt number — there is no MCP tool for
it, and the agent doesn't have the write key. The only way to comply
with the workflow today is to be Claude Code on Dean's Mac. That's the
gap.

The fix is mechanical: register three new tools on the MCP server
that wrap the existing REST handlers internally. The server already
holds `LINKSBLUE_WRITE_KEY` (Railway secret), so the wrapper passes
auth itself. The agent calling the tool never sees a credential.
This is the "lazy agent friendly" surface that Prompt 05/03/2026-12
intended — it shipped as REST + helper scripts, not MCP tools, which
left this gap.

Builds on:
  - 05/03/2026-12  LINKSBLUE_WRITE_ENDPOINTS + LAZY_AGENT_FRIENDLY + AGENT_TOOLKIT
  - 05/03/2026-13  PROMPT_NUMBERING_VIA_AI_ARCHIVE
  - 05/04/2026-22  CLAIM_TTL_AND_EXPIRY (TTL behavior must remain intact)

ACCEPTANCE CRITERIA
-------------------
- [ ] `linksblue/index.js` (or wherever MCP tool registration lives)
      registers three new tools using the MCP SDK:
      - `claim_number({type, platform, agent, title, covers_prompts?})`
        → returns `{n, date, id, type, claimed_at, log_sha,
        log_commit_sha}`
      - `claim_response({parent_n, parent_date, platform, agent, title})`
        → returns the same shape with letter-suffixed id
      - `update_prompt_status({id, status, commit_sha?, note?})`
        → returns the patched row
- [ ] Each tool's implementation calls the existing REST handler
      function directly (no extra HTTP hop). No duplicate
      validation logic — share the request validators already
      written for the REST routes.
- [ ] Auth: the MCP tools use the server's own LINKSBLUE_WRITE_KEY
      at call time. No new env var. No key passed by the caller.
- [ ] TTL behavior preserved: lazy-sweep still runs, expired rows
      still 409 on PATCH, no new path that bypasses TTL.
- [ ] Tool descriptions written for agents who have never seen
      the system: each description names the schema rules
      (sequential N forever, responses letter-suffix, etc.) and
      points at PROMPT_LOG.md.
- [ ] Updated MCP tool inventory in `linksblue/README.md` —
      "Tools exposed" line now lists the three new tools.
- [ ] `linksblue/CLAUDE.md` updated with a section telling agents
      "use the MCP tools, never call the REST endpoints directly
      from agent code." REST stays for daemons and humans.
- [ ] Railway redeployed; verification: open a fresh Cowork
      session, attempt `claim_number` via MCP, confirm a row is
      written to PROMPT_LOG.md and the response payload matches.
      Status patches `verified` once that round-trip works.

OUT OF SCOPE
------------
- Changing the REST endpoints, their bodies, or their auth.
- Changing PROMPT_LOG.md schema or any data already in it.
- Adding new status values or new claim types.
- A web UI for the log (separate prompt if/when wanted).
- Migrating to an external ticketing system (separate evaluation —
  Linear/Plane/etc. is its own decision).

NOTES
-----
- The MCP server uses `@modelcontextprotocol/sdk` Streamable HTTP
  transport (per README). Follow the same registration pattern the
  existing read tools use; do not introduce a different SDK pattern.
- Cowork's MCP client may need a reconnect to pick up the new tool
  list after deploy. Document the reconnect step in CLAUDE.md.
- After this lands, the next prompt is RULEBOOK_PROMPT_WORKFLOW_DOCS
  (already drafted in Cowork's outputs/). Cowork will be able to
  self-claim its number then.
