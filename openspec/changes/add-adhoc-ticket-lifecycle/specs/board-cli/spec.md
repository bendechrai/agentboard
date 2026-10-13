## MODIFIED Requirements

### Requirement: Command surface
The CLI SHALL provide: `init`; `new <title> [--description] [--label]...
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
`rebuild [--check]`; `sync`; `import-change <name>`; `close-merged`;
`serve [--port <port>] [--open | --no-open] [--as <actor>]`; `top`;
`health [--stale-after <duration>] [--blocked-after <duration>] [--unplanned-within <duration>] [--check]`;
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
- **THEN** it prints the synopsis with `--port`, `--open`, `--no-open` and `--as`, the exit codes including 1 `port-in-use` and 2, and an example that parses to `serve`, and exits 0

#### Scenario: Health has help
- **WHEN** `agentboard help health` runs with no board and no actor
- **THEN** it prints the synopsis with `--stale-after`, `--blocked-after`, `--unplanned-within` and `--check`, and an example that parses to `health`, and exits 0

#### Scenario: Move and close have help for the disposition
- **WHEN** `agentboard help move` and `agentboard help close` run with no board and no actor
- **THEN** each prints the synopsis with `--task`, `--change`, `--group` and `--unplanned`, the exit codes including 4 `needs-scope-disposition` and 4 `already-linked`, and an example with `--unplanned` that parses, and neither mentions `needs-task-link`

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
the cache still locked after the busy timeout and one retry). The reason
`needs-task-link` SHALL NOT be produced.

#### Scenario: Unknown ticket
- **WHEN** `agentboard comment 01NOPE00 --as a "x"` names a ticket that does not exist
- **THEN** the command exits 4 with reason `unknown-ticket`

#### Scenario: Port in use is a usage-class failure
- **WHEN** `agentboard serve --port <p>` cannot bind because the port is in use
- **THEN** the command exits 1 with reason `port-in-use`

#### Scenario: Top without a terminal
- **WHEN** `agentboard top` runs with stdout redirected to a file
- **THEN** the command exits 1 with reason `not-a-tty`

#### Scenario: Missing scope disposition is a state rejection
- **WHEN** `agentboard close T1 --no-decision --as orch` runs for an ad hoc ticket T1 in `blocked` with no task link and no unplanned disposition
- **THEN** the command exits 4 with reason `needs-scope-disposition` and writes nothing

### Requirement: No secrets on the board
The board is not a secret store. `new`, `comment` and `handoff`, and `move`
and `close` when given `--unplanned`, SHALL refuse
text that matches well-known secret patterns (private key PEM headers, AWS
access key ids, GitHub tokens, and strings of 32 or more base64 characters
following `token`, `secret`, `password` or `key` and a separator), exiting 1
with the pattern name and not the matched text, unless `--allow-secret-like`
is given.

#### Scenario: PEM header refused
- **WHEN** a comment contains `-----BEGIN PRIVATE KEY-----`
- **THEN** the command exits 1 naming the `pem-private-key` pattern and writes no event

#### Scenario: Secret-like unplanned reason refused
- **WHEN** `move T1 merged --unplanned "token: <40 base64 characters>"` runs without `--allow-secret-like`
- **THEN** the command exits 1 naming the pattern, not the text, and writes no event

### Requirement: MCP server
`agentboard mcp` SHALL serve an MCP server over stdio exposing one tool per
command in the registry except `init`, `watch`, `serve`, `top`, `rebuild`,
`sync`, `mcp` and `version`, which are setup, streaming or maintenance commands run
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
- **THEN** the list contains `board_new`, `board_show`, `board_list`, `board_claim`, `board_release`, `board_move`, `board_comment`, `board_handoff`, `board_link`, `board_checklist_tick`, `board_checklist_untick`, `board_close`, `board_inbox`, `board_import_change`, `board_close_merged` and `board_health`, and no tool for `init`, `watch`, `serve`, `top`, `rebuild`, `sync`, `mcp` or `version`

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

#### Scenario: Health is a tool
- **WHEN** an MCP client lists tools
- **THEN** `board_health` is listed with the optional properties `stale-after`, `blocked-after`, `unplanned-within` and `check`

#### Scenario: Disposition over MCP
- **WHEN** an MCP client lists tools, then calls `board_move` with `{"id": "<T1>", "status": "merged"}` for an undisposed ad hoc ticket T1 in `review`, then with `{"id": "<T1>", "status": "merged", "unplanned": "hotfix"}`
- **THEN** `board_move` and `board_close` list the optional properties `task`, `change`, `group` and `unplanned`; the first call returns a tool error with `exitCode` 4, `reason` `needs-scope-disposition` and a hint naming both `task` and `unplanned`; the second succeeds with T1 in `merged`, and its events are byte-identical in body to those the CLI writes for the same arguments and actor on a copy of the board

## ADDED Requirements

### Requirement: Scope disposition on the command line
`move` (with target `merged` only) and `close` SHALL accept at most one scope
disposition: `--task`, `--change` with `--group` (validated as `link` does), or
`--unplanned <reason>` (non-empty). Before its `ticket.move` or `ticket.close`,
in the same transaction, the command SHALL write the `ticket.link` with that
task, or the `ticket.unplanned`, writing all of these events or none.
`--unplanned` on a ticket with a task reference SHALL exit 4 `already-linked`.

#### Scenario: Merge with a task link
- **WHEN** ad hoc ticket T1 in `review` with no task link runs `agentboard move T1 merged --task openspec:add-login#2 --as orch`
- **THEN** the command exits 0, two event files are written (a `ticket.link` with the task, then a `ticket.move` to `merged`), and T1 is in `merged` with the task reference `openspec:add-login#2` and no ad hoc reason

#### Scenario: Merge as unplanned
- **WHEN** ad hoc ticket T1 in `review` runs `agentboard move T1 merged --unplanned "production hotfix, no plan" --as orch`
- **THEN** the command exits 0, a `ticket.unplanned` with that reason and then a `ticket.move` to `merged` are written, and `show T1` has the line `unplanned: production hotfix, no plan (by orch)` after its `adhoc:` line, and `show T1 --json` and `list --json` carry `unplanned` with that `reason`, the `actor` `orch` and the event's `ts`

#### Scenario: Close with each disposition
- **WHEN** ad hoc tickets A and B, both in `blocked` with no disposition, run `close A --no-decision --task openspec:add-login#3 --as orch` and `close B --no-decision --unplanned "abandoned, duplicate of A" --as orch`
- **THEN** both exit 0, A is closed with the task reference `openspec:add-login#3`, and B is closed with the unplanned disposition `abandoned, duplicate of A`

#### Scenario: Close without a disposition
- **WHEN** ad hoc ticket T1 in `blocked` with no disposition runs `close T1 --no-decision --as orch`
- **THEN** the command exits 4 with reason `needs-scope-disposition`, the hint names `close` with `--task` and with `--unplanned`, and no event file is created

#### Scenario: Both dispositions are a usage error
- **WHEN** `agentboard move T1 merged --task openspec:x#1 --unplanned "y" --as orch` runs
- **THEN** the command exits 1 with reason `usage` naming both flags, before the board is opened, and writes nothing

#### Scenario: Disposition on another move is a usage error
- **WHEN** `agentboard move T1 implementing --unplanned "y" --as orch` runs
- **THEN** the command exits 1 with reason `usage`, saying that a disposition applies only to a move to `merged`, and writes nothing

#### Scenario: Invalid task reference refused as link does
- **WHEN** `agentboard move T1 merged --task add-login-2 --as orch` runs, and separately `move T1 merged --unplanned "" --as orch`
- **THEN** the first exits 1 showing the `<source>:<ref>#<item>` form exactly as `link T1 --task add-login-2` does, the second exits 1 with reason `usage`, and neither writes an event

#### Scenario: Unplanned on a linked ticket
- **WHEN** ticket T1 has the task reference `openspec:add-login#2` and `move T1 merged --unplanned "y" --as orch` runs from `review`
- **THEN** the command exits 4 with reason `already-linked` naming the task reference, and writes nothing

#### Scenario: Disposition with an invalid move writes nothing
- **WHEN** ad hoc ticket T1 is in `todo` and `move T1 merged --unplanned "y" --as orch` runs
- **THEN** the command exits 4 with reason `invalid-transition` and no `ticket.unplanned` or `ticket.move` file is created

#### Scenario: Close check order
- **WHEN** an undisposed ad hoc ticket in `blocked` has an open `DECISION:` comment and `close <id> --no-decision --as orch` runs
- **THEN** the command exits 4 with reason `needs-scope-disposition`; after the same command is given `--unplanned "spike"`, it exits 1 with reason `unpromoted-decision`

#### Scenario: Hand-off into merged needs a disposition first
- **WHEN** an undisposed ad hoc ticket in `review` is handed off with `--status merged`
- **THEN** the command exits 4 with reason `needs-scope-disposition` and the hint names `move <id> merged` with `--task` and with `--unplanned`
