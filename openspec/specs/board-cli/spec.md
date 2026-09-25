# board-cli Specification

## Purpose
Defines the `agentboard` command surface: commands, arguments, the ticket
status state machine, output conventions, exit codes, and the `mcp` server
that exposes the same operations as MCP tools.

## Requirements

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
`serve [--port <port>] [--open | --no-open] [--as <actor>]`; `top`;
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
- **THEN** it prints the synopsis with `--port`, `--open`, `--no-open` and `--as`, the exit codes including 1 `port-in-use` and 2, and an example that parses to `serve`, and exits 0

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

### Requirement: Status state machine
Ticket statuses SHALL be `todo`, `tests`, `implementing`, `review`, `merged`
and `blocked`. Permitted transitions SHALL be: `todo` to `tests`, `tests` to
`implementing`, `implementing` to `review`, `review` to `implementing`
(review sent it back), `review` to `tests` (tests need changing), `review` to
`merged`, any non-`merged` status to `blocked`, and `blocked` back to the
status it was in when blocked. A move to the ticket's current status,
including `blocked` to `blocked`, SHALL be rejected as `invalid-transition`;
leaving `blocked` SHALL be permitted only to the remembered status, which
the CLI supplies when no explicit target is given (the `ticket.move` event
always names its target). A `handoff` whose `--status` equals the current
status SHALL be permitted: it reassigns and comments without a transition.
`merged` SHALL be terminal. A board MAY
override the column names through a `board.meta` event with key `columns`
but the terminal status SHALL remain `merged`.

#### Scenario: Review sends work back
- **WHEN** a ticket in `review` is moved to `implementing`
- **THEN** the move is accepted

#### Scenario: Blocked remembers where it came from
- **WHEN** a ticket in `implementing` is moved to `blocked` and later moved out of `blocked` with no explicit target
- **THEN** its status becomes `implementing`

#### Scenario: Handoff within the same status
- **WHEN** a ticket in `implementing` held by `impl-1` is handed off with `--to impl-2 --status implementing`
- **THEN** it is assigned to `impl-2`, still `implementing`, with the note as a comment

#### Scenario: Move to the current status
- **WHEN** a ticket in `blocked` is moved to `blocked`
- **THEN** the command exits 4 with reason `invalid-transition`

#### Scenario: Merged is terminal
- **WHEN** a ticket in `merged` is moved to any status
- **THEN** the command exits 4 with reason `invalid-transition`

### Requirement: Claim, release and handoff
`claim` SHALL assign the ticket to the actor only if it is unassigned, and
SHALL exit 4 with reason `already-assigned` otherwise, naming the current
assignee; a `claim` by the current assignee SHALL exit 0, write no event and
report that the actor already holds the ticket, so a retried claim is safe. `release` SHALL clear the assignment only when the actor is the
assignee. `handoff` SHALL, in one event, set the assignee to `--to`, set the
status to `--status` (subject to the state machine), and add the note as a
comment attributed to the actor.

#### Scenario: Handoff to reviewer
- **WHEN** the implementer runs `handoff T1 --as impl --to reviewer --status review --note "green, 96%"`
- **THEN** T1 is assigned to `reviewer`, in status `review`, with a comment "green, 96%" by `impl`, and `show T1` lists one new event

#### Scenario: Handoff with an invalid status writes nothing
- **WHEN** `handoff` names a status the state machine does not permit from the current one
- **THEN** no event is written and the command exits 4

### Requirement: Close requires a decision disposition
`close` SHALL require exactly one of `--decision-recorded-in <path>` (a path
that exists in the host project, expected to be a spec delta, ADR or tasks
file) or `--no-decision`. A relative decision path SHALL be resolved against
the current directory, SHALL lie inside the current working tree (the output
of `git rev-parse --show-toplevel`, or the current directory outside git),
and SHALL be recorded relative to that root with `/` separators, so the
recorded path means the same thing in every worktree and clone; a path
outside the working tree SHALL exit 1. `link --decision` SHALL record its
path the same way but SHALL NOT require it to exist. `close` SHALL be permitted only from `merged` or
`blocked`. Closed tickets SHALL be excluded from `list` unless `--closed` is
given.

#### Scenario: Close without disposition is refused
- **WHEN** `agentboard close T1 --as orch` runs with neither flag
- **THEN** the command exits 1 and explains the rule that decisions made in a ticket must be recorded in a spec or ADR

#### Scenario: Close with a missing decision path
- **WHEN** `--decision-recorded-in docs/adr/0099.md` names a file that does not exist
- **THEN** the command exits 1 naming the path

### Requirement: Output conventions
Human output SHALL be plain ASCII, one ticket per line in `list` (the full 26-character id, so that ids
created in the same millisecond stay distinct and can be pasted back,
status, assignee or `-`, title), and a full record in `show` including the
ordered comments and the event count. With `--json`, output SHALL be exactly
one JSON document on stdout: an object for single-ticket commands, an array
for `list`, and for writing commands an object containing the event hash and
the resulting ticket. The one exception is `watch --json`, which prints one
JSON document per line, one per inbox entry, as entries arrive. Diagnostics
SHALL go to stderr. No command SHALL print
the contents of the cache file or raw event files unless asked with `show
--raw`.

#### Scenario: JSON is a single document
- **WHEN** `agentboard list --json` runs
- **THEN** stdout parses as one JSON array and nothing else is written to stdout

### Requirement: Exit codes
Exit codes SHALL be: 0 success; 1 usage error, missing actor,
`rebuild --check` finding a difference (including a missing cache file),
`serve` unable to listen on the requested port (`port-in-use`), or `top`
run without an interactive terminal (`not-a-tty`); 2 board not
found or unreadable; 3 sync problem that needs a human (a conflict, a
sync already in progress, a detached HEAD, or an unreachable or rejecting
remote; see board-concurrency); 4 action rejected by board state (invalid transition,
already assigned, not assignee, unknown ticket); 5 event log or cache
integrity problem (corrupt or malformed file encountered where the command
needed it, an existing event file whose content does not match its name, or
the cache still locked after the busy timeout and one retry).

#### Scenario: Unknown ticket
- **WHEN** `agentboard comment 01NOPE00 --as a "x"` names a ticket that does not exist
- **THEN** the command exits 4 with reason `unknown-ticket`

#### Scenario: Port in use is a usage-class failure
- **WHEN** `agentboard serve --port <p>` cannot bind because the port is in use
- **THEN** the command exits 1 with reason `port-in-use`

#### Scenario: Top without a terminal
- **WHEN** `agentboard top` runs with stdout redirected to a file
- **THEN** the command exits 1 with reason `not-a-tty`

### Requirement: No secrets on the board
The board is not a secret store. `new`, `comment` and `handoff` SHALL refuse
text that matches well-known secret patterns (private key PEM headers, AWS
access key ids, GitHub tokens, and strings of 32 or more base64 characters
following `token`, `secret`, `password` or `key` and a separator), exiting 1
with the pattern name and not the matched text, unless `--allow-secret-like`
is given.

#### Scenario: PEM header refused
- **WHEN** a comment contains `-----BEGIN PRIVATE KEY-----`
- **THEN** the command exits 1 naming the `pem-private-key` pattern and writes no event

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
- **THEN** `board_health` is listed with the optional properties `stale-after`, `blocked-after` and `check`
