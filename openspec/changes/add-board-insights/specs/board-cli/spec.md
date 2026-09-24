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
`serve [--port <n>] [--open]`;
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
cannot drift. `serve` is a streaming command like `watch`: it runs until
SIGINT or SIGTERM (see board-web).

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

#### Scenario: Health has help
- **WHEN** `agentboard help health` runs with no board and no actor
- **THEN** it prints the synopsis with `--stale-after`, `--blocked-after` and `--check`, and an example that parses to `health`, and exits 0

#### Scenario: Serve has help
- **WHEN** `agentboard help serve` runs with no board and no actor
- **THEN** it prints the synopsis with `--port` and `--open`, the exit codes including 1 `port-in-use` and 2, and an example that parses to `serve`, and exits 0

### Requirement: MCP server
`agentboard mcp` SHALL serve an MCP server over stdio exposing one tool per
command in the registry except `init`, `watch`, `serve`, `rebuild`, `sync`,
`mcp` and `version`, which are setup, streaming or maintenance commands run
by a human or an orchestrator in a shell. Tool names SHALL be the command name with
spaces and hyphens replaced by underscores and prefixed `board_` (for
example `board_claim`, `board_checklist_tick`, `board_import_change`). Each
tool's input schema SHALL be generated from the registry, with the same
required arguments and the same validation as the CLI; `--json` is implied.
Writing tools SHALL take the actor as an `as` argument, falling back to the
actor given to the server as `agentboard mcp --as <actor>`, then to the
server process's `AGENTBOARD_ACTOR`, and SHALL fail exactly as the CLI does
when none is present. A successful call SHALL return the same JSON document
the CLI prints with `--json` as a text content item, and as structured
content: the document itself when it is an object, or `{items: <array>}`
when it is an array (MCP structured content must be an object). A call to an
unknown or excluded tool name SHALL return a tool error with `exitCode` 1
and `reason` `usage`, not a protocol error. A failed call
SHALL return a tool error (`isError` true) whose structured content is
`{exitCode, reason, message}`, where `exitCode` is the code the CLI would
have exited with and `reason` is the rejection reason where one exists (for
example `already-assigned`). The server SHALL locate the board once at
start-up by the same discovery rules, and SHALL fail to start, exiting 2,
when no board is found. Every tool call SHALL run the same single-transaction
path as the CLI, so concurrent CLI and MCP writers obey the same guarantees.

#### Scenario: Tools are listed from the registry
- **WHEN** an MCP client connects and lists tools
- **THEN** the list contains `board_new`, `board_show`, `board_list`, `board_claim`, `board_release`, `board_move`, `board_comment`, `board_handoff`, `board_link`, `board_checklist_tick`, `board_checklist_untick`, `board_close`, `board_inbox`, `board_import_change`, `board_close_merged` and `board_health`, and no tool for `init`, `watch`, `serve`, `rebuild`, `sync`, `mcp` or `version`

#### Scenario: Rejection maps to a tool error
- **WHEN** `board_claim` is called on a ticket assigned to `impl` with `as` set to `reviewer`
- **THEN** the call returns a tool error with `exitCode` 4, `reason` `already-assigned` and a message naming `impl`, and no event is written

#### Scenario: Round trip through the server
- **WHEN** a client calls `board_new`, `board_claim`, `board_handoff` and `board_show` in turn
- **THEN** `board_show` returns the same JSON that `agentboard show <id> --json` prints for that ticket

#### Scenario: No board at start-up
- **WHEN** `agentboard mcp` starts where discovery finds no board
- **THEN** it exits 2 naming the path it looked at, before serving any request

#### Scenario: Excluded serve tool
- **WHEN** an MCP client calls the tool `board_serve`
- **THEN** the call returns a tool error with `exitCode` 1 and `reason` `usage`

#### Scenario: Health is a tool
- **WHEN** an MCP client lists tools
- **THEN** `board_health` is listed with the optional properties `stale-after`, `blocked-after` and `check`
