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

This repository coordinates its own agents with agentboard: `agentboard
agents install` wrote `.claude/skills/agentboard/SKILL.md` and the
`agentboard:` guidance in `openspec/config.yaml`.

## What is next

1. Publish 0.1.0 to npm as `@bendechrai/agentboard`, then move publishing
   to a GitHub Actions release workflow with npm trusted publishing.
2. `add-claim-leases` (proposed, in `openspec/changes/`): grace leases
   confirmed by `renew` (`claim --ttl`), takeover of a lapsed lease, a
   fair waiting queue (`claim --wait`), an audited `release --force
   --reason`, board settings (`config`), mutex ticket guidance, and
   reconciling tickets when `import-change` is re-run. Groups 1 to 5 are
   concurrency-critical, so they get a second reviewer (see
   CONTRIBUTING.md, "Three roles per task group").

## Known gaps

- `add-claim-leases` adds the `config` command (not an MCP tool) and new
  `claim` and `release` flags, but its `board-cli` delta does not modify
  "Command surface" (the full command list) or "MCP server" (the excluded
  commands). Add both as MODIFIED requirements, restated from the current
  main spec, before its task group 1 starts.
