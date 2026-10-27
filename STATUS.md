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
  `inbox` and `watch`, and the concurrency and crash property tests.
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
  `board-view-model`; change `add-claim-leases`, not yet archived):
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
  waiting queue and mutex tickets". ADR 0014.

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

## What is next

1. `add-claim-leases` (in progress, in `openspec/changes/`): groups 1
   (lease, queue and grant fold, PR #69), 2 (grant materialisation in
   catch-up, PR #70), 3 (lease, queue, forced-release and config
   commands, PR #98), 4 (waiting in the foreground, PR #102), 6 (mutex
   guidance and feed summaries, PR #101), 7 (documentation, this README,
   ADR 0014 and STATUS) and 8 (re-import reconciliation, PR #72) are
   merged. Group 5 (concurrency, crash and replica tests, no behaviour
   change) is merging alongside; it also carries three small items moved
   from group 4's review (a CLI test of the busy warning on stderr, a test
   of a non-busy error in the ending transaction, and one delta sentence
   on a wake that sees the actor holding as a signal arrives). When it
   is merged, the change is archived in its own pull request, folding its
   deltas into the main specs.
2. `guard-stale-temporary` (in progress, in `openspec/changes/`, proposed
   in PR #100): `init --into-host` adopts a leftover temporary only when
   it was made from the board at `.board` now, checked by the recorded
   HEAD as well as the git directory's identity, which a file system that
   reuses inode numbers cannot tell apart (ticket
   01M5XPHX2V5DHQY0RB6M5JWRD6). Its implementation group is in review;
   its documentation group follows.

## Known gaps

- Release gate for `add-claim-leases`: every machine that writes to a
  shared board must be upgraded before any actor uses `--ttl`, `--wait`,
  `release --force` or `config set` (README, "Upgrading a board shared
  between machines"); the release notes for the version that ships it
  must say so.
- A cache schema upgrade drops inbox cursors: on a `schema_version`
  mismatch the cache drops every table, the non-derivable `cursors` and
  `cursor_seen` included, so after upgrading (0.2.0 to 0.3.0 moves the
  cache schema from 4 to 5) every actor's next `inbox` returns the whole
  board once, and an agent following the guidance may act on stale
  events: ticket 01M5Y0T56JQ1HS04A3N042Y2Z4. A fix is being proposed as
  the OpenSpec change `keep-cursors-on-upgrade`.
- The `agentboard` on PATH on the maintainer's machine is the published
  0.2.0 (guidance version 2) until 0.3.0 is installed. Run from this
  repository it reports the version 3 guidance as `stale` and suggests
  `agents install`, which would downgrade it, so check and install
  guidance with a build of `staging` (`node dist/cli.js agents check`)
  until then. Agents on this repository's board that call it are writers
  that do not understand leases, the mixed-version case README
  "Upgrading a board shared between machines" describes.
- The guide is at its limit: the orchestrator output of `help agents
  --role orchestrator` is exactly 180 lines, the limit the ad hoc
  lifecycle and `add-claim-leases` share, so the next change that adds
  guidance (`GUIDANCE_VERSION` 4) has to make room or raise the limit
  through its own spec delta.
- Refusals outside the lease commands still repeat the refused input
  (for example `move <id> <token>` with an unknown status), where
  `add-claim-leases` made the `--ttl`, `--timeout` and `config`
  refusals name the expected form instead: ticket
  01M5X7EGBFRQA4BH7R0A35ZW50, to be settled by an OpenSpec change.
- `init --into-host` killed after its step 4 (the local
  `refs/agentboard/board` updated) leaves the first board's events in
  that ref if `.board` is then replaced by a different board before the
  move is re-run; whether the re-run must detect and refuse this is open:
  ticket 01M5XYG0VT09DBAW7PZJK1CZ5Y.
- The draft branch `openspec/add-harness-integration` (not merged)
  predates both archives: before it is proposed it re-syncs board-cli
  "Command surface", "Exit codes" and "MCP server" and board-agent-guidance
  "Installing guidance into a host project" (six rules, guidance version
  2) and "Checking installed guidance" with the main specs, keeping
  `remote`, `init --remote | --into-host` and the scope disposition
  flags, and takes the next free `GUIDANCE_VERSION` and ADR number after
  `add-claim-leases` (version 4, and ADR 0016 since 0015 is taken).
