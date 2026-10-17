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
- **Board sharing** (`board-events`, `board-concurrency`, `board-cli`): in
  a git project the board's history lives in the host repository under the
  hidden ref `refs/agentboard/board`, with `.board/` as a locked worktree,
  so a second clone joins with `agentboard init` alone and `sync` fetches,
  rebases and pushes that ref; `init --remote <url>` keeps a board in a
  separate repository; `init --into-host` moves a standalone board in with
  its history; `agentboard remote` shows how a board is shared; `make
  check-git-floor` runs the sharing tests on git 2.32. ADR 0012.

Released as `@bendechrai/agentboard` 0.1.0 on npm (tag `v0.1.0`), with the
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
3. `add-adhoc-ticket-lifecycle` (proposed, in `openspec/changes/`): ad hoc
   tickets move through every status like any other; the
   `needs-task-link` gate at `implementing` is removed, and moving an ad
   hoc ticket to `merged` or closing it needs a scope disposition on the
   same command (`--task <ref>`, or `--unplanned <reason>`, recorded as a
   new `ticket.unplanned` event), refused otherwise with
   `needs-scope-disposition`. `health` and the web Health view list
   unplanned scope as information. ADR 0013 (amends ADR 0004). Group 1
   (fold and events) gets a second reviewer.

## Known gaps

None open.
