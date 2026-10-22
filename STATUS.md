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

Released as `@bendechrai/agentboard` 0.2.0 on npm (tag `v0.2.0`), with the
landing site in `docs/` served at https://bendechrai.github.io/agentboard/.
Later releases are staged by `.github/workflows/release.yml` (see
CONTRIBUTING.md, "Releasing").

This repository coordinates its own agents with agentboard: `agentboard
agents install` wrote `.claude/skills/agentboard/SKILL.md` and the
`agentboard:` guidance in `openspec/config.yaml`.

## What is next

1. `add-description-markdown` (proposed, in `openspec/changes/`): render a
   ticket's description as Markdown in the web app, into elements only,
   never HTML.
2. `add-claim-leases` (proposed, in `openspec/changes/`): grace leases
   confirmed by `renew` (`claim --ttl`), takeover of a lapsed lease, a
   fair waiting queue (`claim --wait`), an audited `release --force
   --reason`, board settings (`config`), mutex ticket guidance, and
   reconciling tickets when `import-change` is re-run. Groups 1 to 5 are
   concurrency-critical, so they get a second reviewer (see
   CONTRIBUTING.md, "Three roles per task group").

## Known gaps

- `add-claim-leases` was re-synced with the main specs when the ad hoc
  ticket lifecycle was archived (its tasks.md says which requirements):
  its guidance group takes `GUIDANCE_VERSION` 3 and its ADR is 0014. Its
  "Agent guide" keeps the 180-line limit the lifecycle set, which the
  mutex recipe must now fit beside the ad hoc text (the orchestrator
  output is 159 lines today).
- The draft branch `openspec/add-harness-integration` (not merged)
  predates both archives: before it is proposed it re-syncs board-cli
  "Command surface", "Exit codes" and "MCP server" and board-agent-guidance
  "Installing guidance into a host project" (six rules, guidance version
  2) and "Checking installed guidance" with the main specs, keeping
  `remote`, `init --remote | --into-host` and the scope disposition
  flags, and takes the next free `GUIDANCE_VERSION` and ADR number after
  `add-claim-leases`.
- `src/board/__tests__/into-host.test.ts` ("Migration refused with
  unpushed commits") flaked once on the Node 26 CI job of PR #83: the
  `.board` snapshot held 42 entries against 41 expected, most likely a
  transient file (lock, journal or temp) caught by the snapshot helper;
  it passed on rerun and on the other Node lines. Ticket
  01M54J9C8VWG6V6E751JHHVW66 on this repository's board tracks making
  the helper ignore transients or settling before the snapshot.
