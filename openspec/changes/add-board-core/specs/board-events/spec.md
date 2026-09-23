# Spec Delta

## Purpose

Defines the on-disk event log that is the only source of truth for a board:
where `.board/` lives, how it is found, what an event file is, and how a
sequence of events folds into ticket state.

## ADDED Requirements

### Requirement: Board directory per project
Each project SHALL have at most one board, stored in a directory named
`.board` at the root of the project's main checkout. The `.board` directory
SHALL itself be a git repository, so that board history is versioned and
synced independently of the host project. The host project SHALL ignore
`.board/` in its own `.gitignore`; `agentboard init` SHALL add that entry when
it is missing.

#### Scenario: Init creates the board
- **WHEN** `agentboard init` runs at the root of a git repository with no `.board` directory
- **THEN** a `.board` directory is created containing an initialized git repository, an empty `events` directory and a `.gitignore` that excludes the cache file, and the host project's `.gitignore` contains a `.board/` entry

#### Scenario: Init is idempotent
- **WHEN** `agentboard init` runs where a `.board` directory already exists
- **THEN** nothing is created or modified and the command exits 0 with a message that the board already exists

### Requirement: Board discovery from any worktree
Commands SHALL locate the board without being told where it is. Resolution
order SHALL be: the `AGENTBOARD_DIR` environment variable when set; otherwise,
when inside a git repository, `<git common dir>/../.board`, where the git
common dir is the value of `git rev-parse --git-common-dir` resolved to an
absolute path, so that every linked worktree of the same repository resolves
to the same board; otherwise `./.board` relative to the current directory. A
command other than `init` that resolves to a path with no board SHALL fail
with exit code 2 and a message naming the path it looked at.

#### Scenario: Linked worktree finds the main checkout's board
- **WHEN** a command runs inside a linked git worktree of a project whose main checkout contains `.board`
- **THEN** the command operates on the main checkout's `.board` directory

#### Scenario: Environment override wins
- **WHEN** `AGENTBOARD_DIR` is set to an existing board directory and the command runs inside a different git repository
- **THEN** the command operates on the board named by `AGENTBOARD_DIR`

#### Scenario: Missing board is reported
- **WHEN** `agentboard list` runs in a directory that is not inside a git repository and has no `./.board`
- **THEN** the command exits 2 and the error names the path `./.board`

### Requirement: Event files are immutable and content-addressed
Every change to the board SHALL be recorded as a new file under
`.board/events/` named `<sha256-hex>.json`, where the hash is the SHA-256 of
the file's bytes. The file content SHALL be the canonical JSON encoding of
the event: object keys sorted lexicographically at every level, no
insignificant whitespace, UTF-8, and a single trailing newline is NOT
included. An event file, once written, SHALL never be modified or deleted by
any command. Writing an event whose canonical bytes already exist SHALL be a
no-op that reports the existing file.

#### Scenario: Two identical events dedupe
- **WHEN** the same event (same canonical bytes) is written twice
- **THEN** exactly one file exists and the second write reports it as already present

#### Scenario: A mismatched file is rejected on read
- **WHEN** a file under `events/` has a name that is not the SHA-256 of its bytes
- **THEN** reading the log reports that file as corrupt with its path and does not fold it, and the rest of the log is still folded

### Requirement: Event envelope
Every event SHALL be a JSON object with these fields: `v` (schema version,
integer, 1 for this specification), `kind` (string), `ticket` (ULID string
identifying the ticket, present on every kind except `board.meta`), `actor`
(non-empty string naming the agent or human), `ts` (hybrid timestamp object
with `wall` milliseconds since the Unix epoch as an integer, `counter` as a
non-negative integer, and `actor` repeated, equal to the top-level `actor`),
and `body` (object whose shape depends on `kind`). Unknown top-level fields
SHALL cause the event to be reported as malformed and not folded. `ticket`
SHALL be absent on `board.meta`. For a kind not defined by this
specification, `ticket` SHALL be optional and, when present, SHALL be a
ULID, so that a later version can add board-level kinds.

#### Scenario: Well-formed event is accepted
- **WHEN** an event file contains all required fields with valid types
- **THEN** it is folded into ticket state

#### Scenario: Unknown kind without a ticket
- **WHEN** an event of an undefined kind `board.archive` has no `ticket` field and is otherwise well-formed
- **THEN** it is preserved and reported as unknown, not as malformed

#### Scenario: Missing actor is malformed
- **WHEN** an event file lacks the `actor` field
- **THEN** the event is reported as malformed with its path and reason and is not folded

### Requirement: Task reference
A ticket's link to the planning artifact it implements SHALL be a task
reference: an object with `source` (a lowercase identifier matching
`^[a-z][a-z0-9-]*$` naming the planning tool, `openspec` for OpenSpec),
`ref` (non-empty string naming the change, feature or plan within that
source; for `openspec`, the change directory name) and `item` (non-empty
string naming the unit of work within `ref`; for `openspec`, the task group
number in decimal, for example `"3"`). The event schema SHALL NOT interpret
`ref` or `item` beyond these type rules, so that a new source can be
supported without a schema version change. A task reference SHALL be
written in text form as `<source>:<ref>#<item>`, for example
`openspec:add-board-core#3`.

#### Scenario: Unknown source is accepted by the schema
- **WHEN** a `ticket.create` event carries the task reference `{source: "speckit", ref: "001-photo-albums", item: "phase-2"}`
- **THEN** the event is well-formed and folds, with the task reference stored as given

#### Scenario: Malformed source is rejected
- **WHEN** a task reference has `source` equal to `"Open Spec"`
- **THEN** the event is reported as malformed naming the `source` field

### Requirement: Event kinds
The following kinds SHALL be defined with these bodies:
`ticket.create` (title, optional description, optional labels array, optional
`task` reference, optional `adhoc` reason string, optional checklist array
of strings; `task` and `adhoc` SHALL NOT both be present);
`ticket.comment` (text);
`ticket.move` (to: status);
`ticket.assign` (to: actor);
`ticket.claim` (no body fields; the event's actor claims the ticket);
`ticket.release` (no body fields);
`ticket.handoff` (to: actor, status, note);
`ticket.link` (exactly one of: `task` reference, pr URL or number, decision path);
`ticket.close` (either `decision` path string or `noDecision` true);
`ticket.checklist` (index: integer, done: boolean);
`board.meta` (key, value; board-level settings such as the default column
set). Bodies with extra fields SHALL be malformed.

#### Scenario: Handoff carries three effects
- **WHEN** a `ticket.handoff` event with to, status and note is folded
- **THEN** the ticket's assignee, status and comment list all reflect it, and no separate assign, move or comment event exists for it

#### Scenario: Checklist tick out of range
- **WHEN** a `ticket.checklist` event names an index beyond the ticket's checklist length
- **THEN** the event is reported as rejected with reason `checklist-index` and the ticket is unchanged

### Requirement: Unknown kinds are preserved
An event whose `kind` is not defined by this specification SHALL be kept in
the log, reported by `rebuild` and `show` as unknown with its kind and hash,
and SHALL NOT be dropped or treated as corrupt, so that a newer version of
the tool can fold it later.

#### Scenario: Newer event kind
- **WHEN** the log contains an event of kind `ticket.estimate` unknown to this version
- **THEN** folding completes, the ticket's known state is unaffected, and the unknown event is listed in the fold report

### Requirement: Deterministic ordering
Events SHALL be folded in ascending order of (`ts.wall`, `ts.counter`,
`ts.actor`, file hash). This order SHALL be total and independent of the
order in which files are read or of the filesystem's listing order.

#### Scenario: Same result from any read order
- **WHEN** the same set of event files is folded twice with the files presented in different orders
- **THEN** the resulting ticket states are byte-identical when serialized canonically

### Requirement: Hybrid timestamp construction
When a command writes an event, `ts.wall` SHALL be the current wall clock in
milliseconds and `ts.counter` SHALL be 0, except that if the board's latest
known event has a `ts.wall` greater than or equal to the current wall clock,
`ts.wall` SHALL be that latest value and `ts.counter` SHALL be the latest
counter plus one. Wall clock differences between machines therefore affect
display order only, never correctness.

#### Scenario: Clock moved backwards
- **WHEN** the latest event has wall 1000 counter 0 and the system clock reports 900
- **THEN** the new event has wall 1000 and counter 1

### Requirement: Fold semantics
Folding SHALL produce, per ticket: id, title, description, status, assignee,
labels, task reference or ad hoc reason, checklist with done flags, ordered comments (each
with actor, timestamp and text), links, closed flag with its decision record
path or explicit no-decision marker, `version` (the count of folded events
that changed the ticket), and `updated_at` (the timestamp of the last such
event). A `ticket.create` SHALL be the first event for its id; any other event
for an unknown ticket id SHALL be reported as rejected with reason
`unknown-ticket` and held aside. A second `ticket.create` for an existing id
SHALL be rejected with reason `duplicate-create`. A `ticket.move` to a status
not permitted by the state machine (see board-cli) SHALL be rejected with
reason `invalid-transition`; a `ticket.claim` on an assigned ticket SHALL be
rejected with reason `already-assigned`; a `ticket.release` by an actor other
than the assignee SHALL be rejected with reason `not-assignee`; a
`ticket.move` or `ticket.handoff` that would take a ticket with no task
reference into `implementing` SHALL be rejected with reason
`needs-task-link` (see board-openspec-integration). Rejected
events SHALL be listed in the fold report with hash, kind, ticket and reason
and SHALL never be deleted.

Where the requirements above leave a case open, the fold SHALL behave as
follows. A `ticket.close` on a ticket not in `merged` or `blocked`, or on an
already closed ticket, SHALL be rejected with reason `invalid-transition`.
Events after a close SHALL fold by their own rules (a comment on a closed
ticket is accepted; a move out of `merged` is still rejected). A task link
SHALL replace the ticket's task reference and clear its ad hoc reason; pr
and decision links SHALL be appended in fold order. `version` SHALL count
every applied event of a defined kind, including one that leaves the state
unchanged, such as ticking an already ticked checklist line. `board.meta`
events SHALL be stored in the board state's meta map and SHALL NOT change
the six statuses or the state machine. A ticket SHALL always be created in
`todo`; an import that needs another status writes the permitted moves.

#### Scenario: Close from implementing is refused
- **WHEN** a `ticket.close` is folded for a ticket in `implementing`
- **THEN** it is rejected with reason `invalid-transition`

#### Scenario: Concurrent claims fold to one winner
- **WHEN** two `ticket.claim` events for the same unassigned ticket exist with different timestamps
- **THEN** the earlier one in fold order assigns the ticket and the later one is reported as rejected with reason `already-assigned`

#### Scenario: Comment on unknown ticket is held
- **WHEN** a `ticket.comment` names a ticket id with no `ticket.create` in the log
- **THEN** the fold report lists it as rejected with reason `unknown-ticket` and no ticket is created

#### Scenario: Version counts effective events
- **WHEN** a ticket has one create, two comments and one rejected move
- **THEN** its version is 3 and its updated_at equals the timestamp of the second comment
