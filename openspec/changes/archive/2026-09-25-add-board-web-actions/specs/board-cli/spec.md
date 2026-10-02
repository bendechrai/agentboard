# Spec Delta

## MODIFIED Requirements

### Requirement: Command surface
The CLI SHALL provide: `init`; `new <title> [--description] [--label]...
(--task <source>:<ref>#<item> | --change <name> --group <n> | --adhoc <reason>)
[--checklist <line>]...`; `show <id>`;
`list [--status] [--assignee] [--task <source>:<ref>[#<item>]] [--change <name>] [--label] [--closed]`;
`claim <id> --as <actor>`; `release <id> --as <actor>`;
`move <id> <status> --as <actor>`; `comment <id> --as <actor> <text>`;
`handoff <id> --as <actor> --to <actor> --status <status> --note <text>`;
`link <id> --as <actor> (--task <source>:<ref>#<item> | --change <name> --group <n> | --pr <ref> | --decision <path>)`;
`checklist tick <id> <index> --as <actor>` and `checklist untick`;
`close <id> --as <actor> (--decision-recorded-in <path> | --no-decision)`;
`inbox --as <actor> [--since <cursor>] [--peek]`; `watch --as <actor>`;
`rebuild [--check]`; `sync`; `import-change <name>`; `close-merged`;
`serve [--port <port>] [--open] [--as <actor>]`; `top`;
`health [--stale-after <duration>] [--blocked-after <duration>] [--check]`;
`mcp`; and `version`. Every command SHALL
accept `--json`. An argument beginning with `--` is
always parsed as a flag; `--` on its own ends the flags, so free text that
begins with `-` (for example a comment) is given after it. Ticket ids MAY be
given as a unique prefix of at least 6 characters. `--change <name> --group
<n>` SHALL be exactly equivalent to `--task openspec:<name>#<n>`, and
`list --change <name>` to `list --task openspec:<name>`. Commands, their
arguments and flags SHALL be defined once, in a single command registry that
drives argument parsing and the MCP tool definitions, so the two surfaces
cannot drift. `serve` and `top` are streaming commands like `watch`:
`serve` runs until SIGINT or SIGTERM (see board-web), and `top` until the
user quits it or it receives SIGINT or SIGTERM (see board-tui).

#### Scenario: OpenSpec shorthand is the same task reference
- **WHEN** one ticket is created with `--change add-board-core --group 3` and another with `--task openspec:add-board-core#3`
- **THEN** both tickets carry the identical task reference `openspec:add-board-core#3`

#### Scenario: Malformed task reference
- **WHEN** `agentboard new "x" --task add-board-core-3 --as a` runs
- **THEN** the command exits 1 and shows the `<source>:<ref>#<item>` form

#### Scenario: Prefix resolves a ticket
- **WHEN** `agentboard show 01J9K3` runs and exactly one ticket id starts with `01J9K3`
- **THEN** that ticket is shown

#### Scenario: Ambiguous prefix is refused
- **WHEN** a prefix matches two tickets
- **THEN** the command exits 1 and lists both full ids

#### Scenario: Top has help
- **WHEN** `agentboard help top` runs with no board and no actor
- **THEN** it prints the synopsis, the exit codes including 1 `not-a-tty` and 2, and an example that parses to `top`, and exits 0

#### Scenario: Serve has help
- **WHEN** `agentboard help serve` runs with no board and no actor
- **THEN** it prints the synopsis with `--port`, `--open` and `--as`, the exit codes including 1 `port-in-use` and 2, and an example that parses to `serve`, and exits 0

#### Scenario: Health has help
- **WHEN** `agentboard help health` runs with no board and no actor
- **THEN** it prints the synopsis with `--stale-after`, `--blocked-after` and `--check`, and an example that parses to `health`, and exits 0

### Requirement: Actor is explicit
Every writing command SHALL require `--as <actor>` or the `AGENTBOARD_ACTOR`
environment variable; with neither, it SHALL exit 1 and explain. The actor
SHALL be recorded on the event and SHALL never be inferred from the OS user.
Every command SHALL accept `--as`; commands that neither write nor track a
per-actor cursor SHALL ignore it, so an agent can pass it habitually. The
one exception is `serve`, which writes only through the write actions of
its web app: those are enabled only by an explicit `--as <actor>` on the
`serve` command line, `serve` SHALL ignore `AGENTBOARD_ACTOR`, and every
event written through it carries that `--as` actor (see
board-web-actions).

#### Scenario: Missing actor
- **WHEN** `agentboard comment T1 "hi"` runs with no `--as` and no `AGENTBOARD_ACTOR`
- **THEN** the command exits 1 and names both ways to supply an actor

#### Scenario: Serve ignores the environment actor
- **WHEN** `agentboard serve` runs with `AGENTBOARD_ACTOR` set and no `--as`
- **THEN** the server is read-only
