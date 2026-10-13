## MODIFIED Requirements

### Requirement: Cache schema
The cache SHALL contain tables `tickets` (id, title, description, status,
assignee, version, updated_at, task_source, task_ref, task_item, adhoc,
unplanned (the unplanned disposition as a JSON object with reason, actor
and ts, or null),
labels as a JSON array,
closed, decision, checklist as a JSON array), `comments` (ticket id, sequence,
actor, ts, text), `links` (ticket id, kind, value), `cursors` (actor, last
wall, last counter, last actor, last hash), `folded` (event hash, folded flag,
reject reason), and `meta` (key, value including the schema version and the
last folded position). Query commands SHALL read ticket state only from the
cache, inside one read transaction so that every field comes from one
snapshot; `show` MAY additionally read the event files that `folded` marks
as unknown kinds (to report them) and, with `--raw`, the ticket's event
files.

#### Scenario: List reads the cache
- **WHEN** `agentboard list --status implementing --json` runs on a board with a current cache
- **THEN** it returns the matching tickets without reading any event file

#### Scenario: Unplanned disposition survives a rebuild
- **WHEN** a ticket was merged with `--unplanned "hotfix"` and `agentboard rebuild` runs twice
- **THEN** the ticket's `unplanned` is identical after each rebuild, the canonical dumps are byte-identical, and `rebuild --check` detects a hand-edited `unplanned` value

#### Scenario: Cache from an earlier schema is rebuilt
- **WHEN** a command opens a cache whose schema version predates the `unplanned` column
- **THEN** the cache is rebuilt from the event files before the command reads it

### Requirement: One command, one transaction
Every command that writes an event SHALL perform the following inside a
single cache transaction opened with `BEGIN IMMEDIATE`: fold any event files
not yet recorded in `folded` (catch-up); validate the requested action against
the current ticket state (state machine, assignment, existence); construct the
event with a hybrid timestamp later than the latest folded event; write the
event file atomically (temporary file in `events/`, fsync, rename to its hash
name); apply the event to the cache rows; record it in `folded`; commit. If
validation fails the command SHALL write nothing and exit with the documented
code. If the process dies after the event file is written but before commit,
the event file remains and the next command's catch-up SHALL fold it.
A `move` or `close` that gives a scope disposition SHALL propose two events
in order, the disposition and then the move or close: each SHALL be
validated against the state the earlier one leaves, each SHALL have a
hybrid timestamp later than the one before, and if either fails validation
neither SHALL be written. Their files SHALL be written in that order, so a
crash can leave the disposition without its move or close, never the
reverse.

#### Scenario: Validation failure writes nothing
- **WHEN** `agentboard move T1 merged` runs while T1 is in status `todo`
- **THEN** no event file is created, the cache is unchanged, and the command exits 4 with reason `invalid-transition`

#### Scenario: Crash between file and commit
- **WHEN** a command is killed after its event file is renamed into place but before the transaction commits
- **THEN** the next command folds that event and the cache reflects it exactly as if the first command had completed

#### Scenario: Crash between the disposition and the move
- **WHEN** `move T1 merged --unplanned "hotfix"` is killed after the `ticket.unplanned` file is renamed into place but before the `ticket.move` file is written
- **THEN** the next command folds the disposition, T1 is still in `review` with the unplanned disposition, and `move T1 merged` without a disposition then succeeds

#### Scenario: Second event refused
- **WHEN** `close T1 --no-decision --task openspec:x#1` runs for a ticket in `implementing`
- **THEN** the command exits 4 with reason `invalid-transition` and neither the `ticket.link` nor the `ticket.close` file is created
