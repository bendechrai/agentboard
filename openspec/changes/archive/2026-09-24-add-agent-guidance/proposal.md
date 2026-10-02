# Proposal

## Why

agentboard's users are mostly coding agents, and an agent can only follow a
protocol it can discover. As specified in `add-board-core`, the CLI has no
help, so `agentboard --help` teaches nothing. The working rules (claim
before work, hand off when done, run `inbox` before dispatching, record
decisions with `DECISION:` and promote them before `close`) exist only in
the specs of this repository, which a host project's agent never reads. A
host project that adopts the board also has no way to tell its own agent
(Claude Code, Codex and others) that the board exists and when to use it,
and OpenSpec's `/opsx:apply` flow says nothing about claiming the ticket
for the task group being implemented.

## What Changes

- Help for every command, generated from the command registry introduced
  by `add-board-core`: `agentboard help [<command>]`, `--help` on every
  command, a top-level overview, `--json` for machine-readable command
  descriptions, and "did you mean" suggestions for unknown commands.
- `agentboard help agents`: a self-contained agent guide printed by the
  running version (what the board is, the actor rule, finding work,
  claiming, handoffs, blocking, the decision rule, what the board is not),
  with every command example in it checked against the registry by a test.
- Actionable errors: every refusal carries a `hint` naming the command that
  moves the agent forward (on stderr for the CLI, as a field in MCP tool
  errors).
- `agentboard agents install` and `agentboard agents check`: opt-in
  installation, into the host project's working tree, of short guidance
  that points the project's agents at the board: a Claude Code skill
  (`.claude/skills/agentboard/SKILL.md`), a managed block in `AGENTS.md`,
  OpenSpec `apply` and `archive` operation guidance in
  `openspec/config.yaml`, and a `.mcp.json` server entry. Installed text is
  deliberately thin and defers to `agentboard help agents`, so it does not
  go stale when the CLI changes; `agents check` reports when it has.
- The MCP server publishes the agent guide as its `instructions` (short
  form) and as a resource `agentboard://guide` (full form).

## Capabilities

### New Capabilities
- `board-agent-guidance`: generated help, the agent guide, error hints,
  installable host-project guidance for agents and OpenSpec, and guide
  delivery over MCP.

### Modified Capabilities
None. This change depends on `add-board-core` (the command registry, the
`mcp` server and `init`) and adds requirements in a new capability rather
than modifying those, so it can be archived after `add-board-core`.

## Non-Goals

- A Spec Kit source adapter. `add-board-core` made the task reference
  source-neutral so one can be added; it is a separate change.
- Automatically committing installed files. `agents install` writes files;
  the user or agent commits them like any other change.
- Guidance for agents other than Claude Code beyond `AGENTS.md`, which
  Codex, Cursor and others already read.

## Impact

- New source under `src/guidance/` (help renderer, agent guide, installers)
  reading `src/cli/registry.ts`.
- One new runtime dependency, the `yaml` package, to edit
  `openspec/config.yaml` while preserving comments and formatting.
- Host projects change only when someone runs `agents install`; board
  activity still never touches host project history.
