# Spec Delta

## Purpose

Defines the `agentboard` command surface: commands, arguments, the ticket
status state machine, output conventions, exit codes, and the reserved `mcp`
command.

## ADDED Requirements

### Requirement: Command surface
The CLI SHALL provide: `init`; `new <title> [--description] [--label]...
[--change <name> --group <n>] [--checklist <line>]...`; `show <id>`;
`list [--status] [--assignee] [--change] [--label] [--closed]`;
`claim <id> --as <actor>`; `release <id> --as <actor>`;
`move <id> <status> --as <actor>`; `comment <id> --as <actor> <text>`;
`handoff <id> --as <actor> --to <actor> --status <status> --note <text>`;
`link <id> --as <actor> (--change <name> --group <n> | --pr <ref> | --decision <path>)`;
`checklist tick <id> <index> --as <actor>` and `checklist untick`;
`close <id> --as <actor> (--decision-recorded-in <path> | --no-decision)`;
`inbox --as <actor> [--since <cursor>] [--peek]`; `watch --as <actor>`;
`rebuild [--check]`; `sync`; `import-change <name>`; `close-merged`;
`mcp`; and `version`. Every command SHALL accept `--json`. Ticket ids MAY be
given as a unique prefix of at least 6 characters.

#### Scenario: Prefix resolves a ticket
- **WHEN** `agentboard show 01J9K3` runs and exactly one ticket id starts with `01J9K3`
- **THEN** that ticket is shown

#### Scenario: Ambiguous prefix is refused
- **WHEN** a prefix matches two tickets
- **THEN** the command exits 1 and lists both full ids

### Requirement: Actor is explicit
Every writing command SHALL require `--as <actor>` or the `AGENTBOARD_ACTOR`
environment variable; with neither, it SHALL exit 1 and explain. The actor
SHALL be recorded on the event and SHALL never be inferred from the OS user.

#### Scenario: Missing actor
- **WHEN** `agentboard comment T1 "hi"` runs with no `--as` and no `AGENTBOARD_ACTOR`
- **THEN** the command exits 1 and names both ways to supply an actor

### Requirement: Status state machine
Ticket statuses SHALL be `todo`, `tests`, `implementing`, `review`, `merged`
and `blocked`. Permitted transitions SHALL be: `todo` to `tests`, `tests` to
`implementing`, `implementing` to `review`, `review` to `implementing`
(review sent it back), `review` to `tests` (tests need changing), `review` to
`merged`, any non-`merged` status to `blocked`, and `blocked` back to the
status it was in when blocked. `merged` SHALL be terminal. A board MAY
override the column names through a `board.meta` event with key `columns`
but the terminal status SHALL remain `merged`.

#### Scenario: Review sends work back
- **WHEN** a ticket in `review` is moved to `implementing`
- **THEN** the move is accepted

#### Scenario: Blocked remembers where it came from
- **WHEN** a ticket in `implementing` is moved to `blocked` and later moved out of `blocked` with no explicit target
- **THEN** its status becomes `implementing`

#### Scenario: Merged is terminal
- **WHEN** a ticket in `merged` is moved to any status
- **THEN** the command exits 4 with reason `invalid-transition`

### Requirement: Claim, release and handoff
`claim` SHALL assign the ticket to the actor only if it is unassigned, and
SHALL exit 4 with reason `already-assigned` otherwise, naming the current
assignee. `release` SHALL clear the assignment only when the actor is the
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
file) or `--no-decision`. `close` SHALL be permitted only from `merged` or
`blocked`. Closed tickets SHALL be excluded from `list` unless `--closed` is
given.

#### Scenario: Close without disposition is refused
- **WHEN** `agentboard close T1 --as orch` runs with neither flag
- **THEN** the command exits 1 and explains the rule that decisions made in a ticket must be recorded in a spec or ADR

#### Scenario: Close with a missing decision path
- **WHEN** `--decision-recorded-in docs/adr/0099.md` names a file that does not exist
- **THEN** the command exits 1 naming the path

### Requirement: Output conventions
Human output SHALL be plain ASCII, one ticket per line in `list` (id prefix,
status, assignee or `-`, title), and a full record in `show` including the
ordered comments and the event count. With `--json`, output SHALL be exactly
one JSON document on stdout: an object for single-ticket commands, an array
for `list`, and for writing commands an object containing the event hash and
the resulting ticket. Diagnostics SHALL go to stderr. No command SHALL print
the contents of the cache file or raw event files unless asked with `show
--raw`.

#### Scenario: JSON is a single document
- **WHEN** `agentboard list --json` runs
- **THEN** stdout parses as one JSON array and nothing else is written to stdout

### Requirement: Exit codes
Exit codes SHALL be: 0 success; 1 usage error or missing actor; 2 board not
found or unreadable; 3 conflict during sync that needs a human (see
board-concurrency); 4 action rejected by board state (invalid transition,
already assigned, not assignee, unknown ticket); 5 event log integrity
problem (corrupt or malformed file encountered where the command needed it).

#### Scenario: Unknown ticket
- **WHEN** `agentboard comment 01NOPE00 --as a "x"` names a ticket that does not exist
- **THEN** the command exits 4 with reason `unknown-ticket`

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

### Requirement: Reserved MCP command
`agentboard mcp` SHALL serve the same operations as the CLI as MCP tools over
stdio, one tool per writing or reading command, with identical validation and
exit semantics mapped to tool errors. Until implemented, `agentboard mcp`
SHALL exit 1 with a message that it is not yet available; it SHALL never
silently succeed.

#### Scenario: MCP not yet available
- **WHEN** `agentboard mcp` runs on a build without the MCP server
- **THEN** it exits 1 with a message that the MCP server is not implemented in this version
