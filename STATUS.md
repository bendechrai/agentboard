# Status

A cold-start orientation for anyone (human or agent) opening this
repository for the first time: what exists, what is next, and the known
gaps. See README.md for what the product is and how to use it,
CONTRIBUTING.md for the workflow, and `adr/` for design decisions.

## What exists

Every capability below is specified in `openspec/specs/`, implemented,
tested and documented in README.md.

- **Board core** (`board-events`, `board-cache`, `board-concurrency`,
  `board-cli`): the append-only event log with a disposable SQLite cache,
  every CLI command, `rebuild`, `sync` over git, inbox cursors with
  `inbox` and `watch` (kept across a cache schema upgrade, so an upgrade
  does not replay the whole board to every actor), and the concurrency
  and crash property tests.
  ADRs 0001 to 0005.
- **OpenSpec integration** (`board-openspec-integration`):
  `import-change`, source-neutral task links and `close-merged`.
- **MCP server** (`board-cli`): `agentboard mcp`, exposing the board
  commands as tools.
- **Agent guidance** (`board-agent-guidance`): generated help and
  suggestions, `help agents` with role checklists, error hints on the CLI
  and MCP, `agents install` (including `--mcp-command`) and `agents
  check`, and the guide over MCP.
- **Web app** (`board-web`, `board-feed`, `board-view-model`,
  `board-web-actions`): `agentboard serve`, a local web app behind a
  per-run token with a JSON API and live stream, write actions with
  `serve --as <actor>`, and opening the browser by default. ADRs 0006,
  0007, 0009 and 0010.
- **Terminal UI** (`board-tui`): `agentboard top`, a full-screen,
  read-only live view of the board. ADR 0008.
- **Insights** (`board-insights`): `agentboard health`, the
  `board_health` MCP tool, and the Health, Replay and Graph views of the
  web app.
- **Board sharing** (`board-cli`, `board-concurrency`): in a git project
  the board's history lives in the host repository under the hidden ref
  `refs/agentboard/board`, with `.board/` as a locked worktree, so a
  second clone joins with `agentboard init` alone; `sync` fetches, rebases
  and pushes that ref; `init --remote <url>` keeps a board in a separate
  repository; `init --into-host` moves an existing standalone board in
  with its history, refusing whenever an event could be lost and resuming
  after an interruption; `agentboard remote` shows how a board is shared.
  The host model needs git 2.32 or later, checked by `make
  check-git-floor`, and the walkthrough
  `src/__tests__/walkthroughs/board-sharing.sh` runs the README examples
  end to end. ADR 0012. Archived as
  `openspec/changes/archive/2026-10-17-add-board-sharing`.
- **Ad hoc ticket lifecycle** (`board-openspec-integration`,
  `board-events`, `board-cache`, `board-cli`, `board-insights`,
  `board-view-model`, `board-web-actions`, `board-agent-guidance`): an
  ad hoc ticket moves
  through every status like any other; moving it to `merged` or closing
  it needs a scope disposition on the same command (`--task <ref>`, or
  `--unplanned <reason>`, recorded as a `ticket.unplanned` event before
  the move or close in one transaction), refused otherwise with
  `needs-scope-disposition` (and `--unplanned` on a linked ticket with
  `already-linked`). `health`, `board_health` and the web Health view
  list unplanned scope as information (`--unplanned-within`, default 7
  days); `list`, `show` and the web cards mark it `[unplanned]`. The
  walkthrough `src/__tests__/walkthroughs/adhoc-lifecycle.sh` runs the
  README example end to end. ADR 0013 (amends ADR 0004). Archived as
  `openspec/changes/archive/2026-10-17-add-adhoc-ticket-lifecycle`.
- **Markdown descriptions** (`board-web`): the ticket detail view of the
  web app renders a ticket's description as Markdown (CommonMark plus GFM
  tables, task lists, strikethrough and autolink literals), parsed to a
  syntax tree and rendered into elements from an allow-list, never as an
  HTML string, with a guard test over the client source; links only for
  absolute `http:`, `https:` and `mailto:` URLs, opened in a new tab with
  no opener and no referrer; images never loaded, shown as links labelled
  with the alt text; nesting deeper than 32 levels and descriptions
  longer than 16384 characters fall back to text. ADR 0015 (amends ADR
  0006). Archived as
  `openspec/changes/archive/2026-10-26-add-description-markdown`.
- **Claim leases and the waiting queue** (`board-events`, `board-cache`,
  `board-cli`, `board-concurrency`, `board-agent-guidance`,
  `board-view-model`, `board-openspec-integration`, `board-web`,
  `board-web-actions`):
  `claim --ttl` writes a grace lease (`lease.grace`, default 2 minutes)
  that only the holder's `renew` confirms; a lease lapsed by more than the
  fixed 60 second skew tolerance can be taken over with `claim --ttl`;
  `claim --wait` joins a fair queue, blocking on the CLI until granted
  (`--timeout`, exit 4 `wait-timeout` or `wait-interrupted`) and
  non-blocking over MCP (`board_claim` with `wait`, the grant arriving in
  `board_inbox`), with `unqueue` to leave; grants are derived, backdated
  `ticket.grant` events by the reserved actor `agentboard`, written by
  whichever command catches up once they are due and accepted by `renew`
  within `queue.window`; `release --force --reason` breaks another
  actor's hold as `ticket.release.force` and tells the previous holder
  (`LOST: ` in its inbox); `config set|get lease.grace|queue.window`;
  lease and queue display in `list`, `show` and the inbox; feed summaries;
  the mutex ticket recipe in the guide, the role checklists, the
  installed guidance and the MCP instructions (`GUIDANCE_VERSION` 3); and
  re-import reconciliation in `import-change` (pairing tickets to groups
  by identity, `ticket.renumber`, `ticket.reconcile`, `ticket.supersede`,
  `--dry-run`, `--force`). Cache schema version 5. README "Leases, the
  waiting queue and mutex tickets". ADR 0014. Delivered in PRs #69, #70,
  #72, #98, #101, #102, #105 and #107; archived as
  `openspec/changes/archive/2026-10-27-add-claim-leases`.

Released as `@bendechrai/agentboard` 0.2.0 on npm (tag `v0.2.0`), with the
landing site in `docs/` served at https://bendechrai.github.io/agentboard/.
Later releases are staged by `.github/workflows/release.yml` (see
CONTRIBUTING.md, "Releasing").

This repository coordinates its own agents with agentboard: `agentboard
agents install` wrote `.claude/skills/agentboard/SKILL.md` and the
`agentboard:` guidance in `openspec/config.yaml`, at guidance version 3
(`agentboard agents check` reports both current). Machines that share
this repository's board should run a build with leases before anyone uses
them on it (see "Known gaps").
- **Guard on leftover temporaries** (`board-concurrency`): `init
  --into-host` adopts a temporary worktree left by an interrupted move
  only when it comes from the board's own history: the git directory it
  recorded is the one at `.board` now, and its recorded starting HEAD and
  integrated tip (three atomic records in the temporary's git directory)
  are both in that board's history, so a replacement board that reuses
  the old git directory's inode, or a board whose history was rewritten,
  is another board and its events never reach `refs/agentboard/board`.
  Temporaries of 0.2.0 and older stay resumable. The removal line and the
  `sync-in-progress` text name such a temporary. Delivered in PR #104
  (ticket 01M5XPHX2V5DHQY0RB6M5JWRD6) and documented in README "Moving a
  board into the host repository" (PR #111); the change is archived as
  `openspec/changes/archive/2026-10-27-guard-stale-temporary`.
- **Inbox positions survive a cache schema upgrade** (`board-cache`):
  when the cache was written by an earlier schema version, the recreate
  carries each actor's cursor and seen set and the old cache's applied
  events inside the same transaction, so the first `inbox` after an
  upgrade returns only events after the actor's position plus any whose
  outcome the new version changed (0.2.0 recorded reconcile, renumber and
  supersede as unknown kinds). Old long-running `watch`, `serve`, `top` or
  `mcp` processes must be stopped before upgrading. Delivered in PR #108
  (ticket 01M5Y0T56JQ1HS04A3N042Y2Z4); archived as
  `openspec/changes/archive/2026-10-30-keep-cursors-on-upgrade`.
- **Refusals never repeat the refused input** (`board-cli`,
  `board-agent-guidance`): no refusal, hint, `--json` error, MCP tool
  error, web action error or stderr line repeats the value, flag name,
  command word or argument name it refuses; it names the argument and the
  expected form or the valid choices. The one exception is text of the
  ticket id shape starting with `0`. `init --remote`, `sync`, `remote` and
  the `init` paths never show a remote URL's credentials: quoted git lines
  are sanitised against every configured remote, remote named by URL and
  proxy, and success output shows URLs without user information. A source
  scan fails if a refusal starts echoing input again. Delivered in PRs
  #117 and #113 (ticket 01M5X7EGBFRQA4BH7R0A35ZW50); archived as
  `openspec/changes/archive/2026-10-31-no-echo-refusals`.
- **MCP protocol errors never repeat the request** (`board-cli`,
  `board-agent-guidance`): an MCP `resources/read` of an unknown URI is
  JSON-RPC error `-32602` whose message is `unknown resource; the
  resources are ` followed by the listed URIs in `resources/list` order,
  with no `data` member and without the SDK's `MCP error -32602: ` prefix
  on the wire, so the URI (which may hold a token) is never repeated and
  SDK clients no longer show the prefix twice. The code, exact matching,
  the resource list and the read results are unchanged; unknown methods
  and malformed parameters keep the SDK's errors, which name only the
  method or the parameter path. Delivered in PR #126 (ticket
  01M5YD930V39N0203HTTMQHYMW); archived as
  `openspec/changes/archive/2026-10-31-mcp-unknown-resource`.
- **Actor names are checked** (`board-cli`, `board-events`,
  `board-web-actions`, `board-agent-guidance`): an actor name given with
  `--as`, `AGENTBOARD_ACTOR` (when used), `handoff --to`, an MCP `as` or
  `to`, `serve --as` or a web hand-off's `to` is refused with exit 1
  `invalid-actor` (HTTP 400 on the web) when it matches a secret pattern
  or falls outside 1 to 32 ASCII letters, digits, `.`, `_`, `-` or `@`
  starting with a letter or digit, before anything is written and without
  repeating it; `--allow-secret-like` does not apply. Existing events of
  any actor still fold. Delivered in PRs #128 and #131 (ticket
  01M5Y9MQB9E3969DZ29VX5MZD0); archived as
  `openspec/changes/archive/2026-10-31-actor-secret-check`.

## What is next

0.3.0 is released (tag `v0.3.0`, npm `@bendechrai/agentboard@0.3.0`).
In progress for the next release: `add-harness-integration` (hooks and
more harness targets; group 1, the hook command contract, is merged in
#127) and `into-host-replaced-after-step-4` (in review).

## Known gaps

- Release gate for `add-claim-leases`, stated in the 0.3.0 release notes:
  every machine that writes to a shared board must run 0.3.0 before any
  actor uses `--ttl`, `--wait`, `release --force` or `config set` (README,
  "Upgrading a board shared between machines").
- The guide is at its limit: the orchestrator output of `help agents
  --role orchestrator` is exactly 180 lines, the limit the ad hoc
  lifecycle and `add-claim-leases` share, so the next change that adds
  guidance (`GUIDANCE_VERSION` 4) has to make room or raise the limit
  through its own spec delta.
- The shared secret patterns miss short prefixed keys such as Stripe
  restricted keys (`rk_live_`, `rk_test_`), which also fit the actor form:
  ticket 01M69B8W53DGS7CF8XY4H951TC.
- `init --into-host` killed after its step 4 (the local
  `refs/agentboard/board` updated) leaves the first board's events in
  that ref if `.board` is then replaced by a different board before the
  move is re-run; whether the re-run must detect and refuse this is open:
  ticket 01M5XYG0VT09DBAW7PZJK1CZ5Y.
- The proposal `add-harness-integration` (draft PR #67, not merged) was
  re-synced on 2026-10-31 with the main specs as of `a455011` (guidance
  version stays 3, ADR 0016; its design.md lists what the newer archives
  forced). Any change archived after that which touches the requirements
  it modifies needs one more re-sync before it is archived.
