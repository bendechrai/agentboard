## MODIFIED Requirements

### Requirement: Command surface
The CLI SHALL provide: `init [--remote <url> | --into-host] [--agents | --no-agents]`;
`new <title> [--description] [--label]...
(--task <source>:<ref>#<item> | --change <name> --group <n> | --adhoc <reason>)
[--checklist <line>]...`; `show <id>`;
`list [--status] [--assignee] [--task <source>:<ref>[#<item>]] [--change <name>] [--label] [--closed]`;
`claim <id> --as <actor>`; `release <id> --as <actor>`;
`move <id> <status> --as <actor> [--task <source>:<ref>#<item> | --change <name> --group <n> | --unplanned <reason>]`;
`comment <id> --as <actor> <text>`;
`handoff <id> --as <actor> --to <actor> --status <status> --note <text>`;
`link <id> --as <actor> (--task <source>:<ref>#<item> | --change <name> --group <n> | --pr <ref> | --decision <path>)`;
`checklist tick <id> <index> --as <actor>` and `checklist untick`;
`close <id> --as <actor> (--decision-recorded-in <path> | --no-decision) [--task <source>:<ref>#<item> | --change <name> --group <n> | --unplanned <reason>]`;
`inbox --as <actor> [--since <cursor>] [--peek]`; `watch --as <actor>`;
`rebuild [--check]`; `sync`; `remote`; `import-change <name>`; `close-merged`;
`serve [--port <port>] [--open | --no-open] [--as <actor>]`; `top`;
`health [--stale-after <duration>] [--blocked-after <duration>] [--unplanned-within <duration>] [--check]`;
`hook <event> [--strict]`; `mcp`; and `version`. Every command SHALL
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
user quits it or it receives SIGINT or SIGTERM (see board-tui). `init`,
`sync` and `remote` are the commands that run git on the board; they need
no actor (see "Initialising and joining a shared board").

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
- **THEN** it prints the synopsis with `--port`, `--open`, `--no-open` and `--as`, the exit codes including 1 `port-in-use` and 2, and an example that parses to `serve`, and exits 0

#### Scenario: Hook has help
- **WHEN** `agentboard help hook` runs with no board and no actor
- **THEN** it prints the synopsis with the three events `session-start`, `stop` and `pre-tool-use` and `--strict`, the exit codes 0 and 2 with their hook meaning, and an example that parses to `hook`, and exits 0

#### Scenario: Init has help for the agents flags
- **WHEN** `agentboard help init` runs
- **THEN** it prints `--agents` and `--no-agents` and says they are mutually exclusive

#### Scenario: Health has help
- **WHEN** `agentboard help health` runs with no board and no actor
- **THEN** it prints the synopsis with `--stale-after`, `--blocked-after`, `--unplanned-within` and `--check`, and an example that parses to `health`, and exits 0

#### Scenario: Move and close have help for the disposition
- **WHEN** `agentboard help move` and `agentboard help close` run with no board and no actor
- **THEN** each prints the synopsis with `--task`, `--change`, `--group` and `--unplanned`, the exit codes including 4 `needs-scope-disposition` and 4 `already-linked`, and an example with `--unplanned` that parses, and neither mentions `needs-task-link`

#### Scenario: Init has help for sharing
- **WHEN** `agentboard help init` runs with no board and no actor
- **THEN** it prints `--remote` and `--into-host`, says they are mutually exclusive, lists the exit codes including 1 `ambiguous-remote`, 3 `remote-unreachable` and 4 `unsynced`, and has an example for each flag that parses, and exits 0

#### Scenario: Remote has help
- **WHEN** `agentboard help remote` runs with no board and no actor
- **THEN** it prints the synopsis, says the command never contacts the network, lists exit code 2, has an example that parses to `remote`, and exits 0

### Requirement: Exit codes
Exit codes SHALL be: 0 success; 1 usage error, missing actor,
`rebuild --check` finding a difference (including a missing cache file),
`serve` unable to listen on the requested port (`port-in-use`), or `top`
run without an interactive terminal (`not-a-tty`); 2 board not
found or unreadable; 3 sync problem that needs a human (a conflict, a
sync already in progress, a detached HEAD, or an unreachable or rejecting
remote; see board-concurrency); 4 action rejected by board state (invalid transition,
already assigned, not assignee, unknown ticket, a ticket leaving without a
scope disposition (`needs-scope-disposition`), or an unplanned disposition
for a ticket that has a task reference (`already-linked`)); 5 event log or cache
integrity problem (corrupt or malformed file encountered where the command
needed it, an existing event file whose content does not match its name, or
the cache still locked after the busy timeout and one retry).
`hook` is the one exception: it exits 0 or 2 only, as Claude Code's hook
protocol defines them (see board-harness-hooks), and never reports the
codes above.

#### Scenario: Unknown ticket
- **WHEN** `agentboard comment 01NOPE00 --as a "x"` names a ticket that does not exist
- **THEN** the command exits 4 with reason `unknown-ticket`

#### Scenario: Port in use is a usage-class failure
- **WHEN** `agentboard serve --port <p>` cannot bind because the port is in use
- **THEN** the command exits 1 with reason `port-in-use`

#### Scenario: Hook never reports a board error
- **WHEN** `agentboard hook stop` runs where discovery finds no board
- **THEN** it exits 0, not 2

#### Scenario: Top without a terminal
- **WHEN** `agentboard top` runs with stdout redirected to a file
- **THEN** the command exits 1 with reason `not-a-tty`

#### Scenario: Missing scope disposition is a state rejection
- **WHEN** `agentboard close T1 --no-decision --as orch` runs for an ad hoc ticket T1 in `blocked` with no task link and no unplanned disposition
- **THEN** the command exits 4 with reason `needs-scope-disposition` and writes nothing

### Requirement: MCP server
`agentboard mcp` SHALL serve an MCP server over stdio exposing one tool per
command in the registry except `init`, `watch`, `serve`, `top`, `rebuild`,
`sync`, `remote`, `hook`, `mcp` and `version`, which are setup, streaming or maintenance commands run
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
- **THEN** the list contains `board_new`, `board_show`, `board_list`, `board_claim`, `board_release`, `board_move`, `board_comment`, `board_handoff`, `board_link`, `board_checklist_tick`, `board_checklist_untick`, `board_close`, `board_inbox`, `board_import_change`, `board_close_merged` and `board_health`, and no tool for `init`, `watch`, `serve`, `top`, `rebuild`, `sync`, `remote`, `hook`, `mcp` or `version`

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

#### Scenario: Excluded top tool
- **WHEN** an MCP client calls the tool `board_top`
- **THEN** the call returns a tool error with `exitCode` 1 and `reason` `usage`

#### Scenario: Excluded remote tool
- **WHEN** an MCP client calls the tool `board_remote`
- **THEN** the call returns a tool error with `exitCode` 1 and `reason` `usage`

#### Scenario: Excluded hook tool
- **WHEN** an MCP client calls the tool `board_hook`
- **THEN** the call returns a tool error with `exitCode` 1 and `reason` `usage`

#### Scenario: Health is a tool
- **WHEN** an MCP client lists tools
- **THEN** `board_health` is listed with the optional properties `stale-after`, `blocked-after`, `unplanned-within` and `check`

#### Scenario: Disposition over MCP
- **WHEN** an MCP client lists tools, then calls `board_move` with `{"id": "<T1>", "status": "merged"}` for an undisposed ad hoc ticket T1 in `review`, then with `{"id": "<T1>", "status": "merged", "unplanned": "hotfix"}`
- **THEN** `board_move` and `board_close` list the optional properties `task`, `change`, `group` and `unplanned`; the first call returns a tool error with `exitCode` 4, `reason` `needs-scope-disposition` and a hint naming both `task` and `unplanned`; the second succeeds with T1 in `merged`, and its events are byte-identical in body to those the CLI writes for the same arguments and actor on a copy of the board

## ADDED Requirements

### Requirement: Init offers to install agent guidance
`agentboard init` SHALL, after creating or finding the board, offer to run
`agents install` when stdin and stdout are both terminals and neither
`--json`, `--agents` nor `--no-agents` is given: it asks `Install agent
guidance now? [Y/n]` and runs the install on `y`, `yes` or an empty answer
(any case) and skips it on `n` or `no`. `--agents` SHALL
run the install without asking and `--no-agents` SHALL skip it silently;
giving both SHALL exit 1 with reason `usage` before writing anything. When
the install is not run, `init` SHALL end its output with the line
suggesting `agentboard agents install`. The install runs exactly as `agents
install` does with no `--target`, including its bare-project prompt on a
terminal. A failure of the install SHALL NOT undo the board: `init` reports
the board as created, prints the install's refusal, and exits with the
install's exit code.

#### Scenario: Prompt on a terminal
- **WHEN** `agentboard init` runs on a terminal with no flags and the user answers `y`
- **THEN** the board is created and `agents install` runs with auto-detected targets

#### Scenario: Enter installs
- **WHEN** the user presses Enter at the prompt
- **THEN** the board is created and `agents install` runs with auto-detected targets

#### Scenario: Declined
- **WHEN** the user answers `n`
- **THEN** the board is created, no guidance file is written, and the output ends with the hint line

#### Scenario: Scripts get no prompt
- **WHEN** `agentboard init` runs with stdout redirected to a file and no flags
- **THEN** it does not read stdin, creates the board and ends with the hint line

#### Scenario: Explicit flags
- **WHEN** `agentboard init --agents` runs in a project with `.claude/`
- **THEN** the board is created and the `claude` target is installed without a prompt

#### Scenario: Flags conflict
- **WHEN** `agentboard init --agents --no-agents` runs
- **THEN** it exits 1 with reason `usage` and no board is created

#### Scenario: Install failure keeps the board
- **WHEN** `agentboard init --agents` runs non-interactively in a bare project
- **THEN** the board exists, the output says no target was selected, and the exit code is 1
