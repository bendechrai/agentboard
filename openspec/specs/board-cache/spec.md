# board-cache Specification

## Purpose
Defines the derived SQLite cache that answers queries quickly, the transaction
discipline that makes every command atomic against concurrent processes, and
how the cache is rebuilt from the event log.

## Requirements

### Requirement: Cache is derived and disposable
The board SHALL keep a SQLite database at `.board/cache.sqlite`, excluded from
the board's own git repository. The cache SHALL contain nothing that is not
derivable from the event log, with one exception: the cursor tables
(`cursors` and `cursor_seen`, the per-actor seen set), which record what each
actor has acknowledged through `inbox`. Losing cursors SHALL only
cause events to be delivered again, never skipped. Deleting the cache SHALL
never lose board data; the next command SHALL rebuild it from the events
before proceeding. `rebuild` SHALL keep existing cursor rows, and
`rebuild --check` SHALL compare everything except cursors.

`rebuild` and `rebuild --check` SHALL NOT catch up before they run: `rebuild`
refolds every event file itself (so late events are recorded, and reported,
by the rebuild), and `rebuild --check` compares the live cache as it is,
never reaps temporary files, and, when no cache file exists, exits 1
reporting `no-cache` without creating one. `rebuild --check` SHALL NOT
modify the live cache file in any way: when its schema version differs from
the running version, or the file is empty or not a valid cache, it SHALL exit
1 reporting `schema-mismatch` and leave the file, including its cursor
tables, byte for byte unchanged. Opening the cache SHALL wait on
the busy timeout for every statement, including switching to WAL mode, so
many processes opening a board with no cache at once all succeed.

#### Scenario: Cache deleted between commands
- **WHEN** `cache.sqlite` is removed and `agentboard list` runs
- **THEN** the command rebuilds the cache from `events/` and returns the same tickets as before the deletion

#### Scenario: Cache is not synced
- **WHEN** `agentboard sync` runs
- **THEN** `cache.sqlite` and its WAL and SHM companions are not committed or pushed

### Requirement: Cache schema
The cache SHALL contain tables `tickets` (id, title, description, status,
assignee, lease_ttl, lease_expires_at, lease_event and lease_confirmed
(all null when the ticket has no lease), available_at and available_event
(when and by which release, forced release or lapse the ticket last
became available, for deriving grants), version, updated_at, task_source, task_ref, task_item, adhoc,
unplanned (the unplanned disposition as a JSON object with reason, actor
and ts, or null),
labels as a JSON array,
closed, superseded (the supersede reason, null when not superseded),
decision, checklist as a JSON array whose lines carry `removed` when a
reconcile removed them), `waiters` (ticket id,
position, actor, ttl, join event hash, join ts), `comments` (ticket id, sequence,
actor, ts, text), `links` (ticket id, kind, value), `cursors` (actor, last
wall, last counter, last actor, last hash), `folded` (event hash, folded flag,
reject reason), and `meta` (key, value including the schema version and the
last folded position, and `grant_watermark`: the slot time, as a JSON
number, of the first grant that would be due and is not folded, that is
the first grant `dueGrants` returns for the folded events with no bound on
the clock, each grant derived at its own fold position; the row is absent
when there is none, for example when no ticket has waiters or every
waiting ticket is held without a lease). Catch-up and `rebuild` SHALL compute
`grant_watermark` identically, so it is part of the canonical dump. Catch-up
SHALL read event files only when an event file name is not recorded in
`folded`, a temporary file is stale, or the local clock has reached
`grant_watermark`; otherwise it lists the event file names and reads the
cache only. Adding the lease and queue state SHALL increase the cache
schema version, so an older cache is rebuilt on first open. Adding
`grant_watermark` SHALL increase it again, so a cache written before that
row existed, whose missing row would read as no grant ever being due, is
rebuilt on first open too. Adding `superseded` and the removed flag of
checklist lines SHALL increase it once more. Query commands SHALL read ticket state only from the
cache, inside one read transaction so that every field comes from one
snapshot; `show` MAY additionally read the event files that `folded` marks
as unknown kinds (to report them) and, with `--raw`, the ticket's event
files, and MAY read the applied takeover, grant and forced release events
of the ticket to display them.

#### Scenario: List reads the cache
- **WHEN** `agentboard list --status implementing --json` runs on a board with a current cache and no grant due at the local clock
- **THEN** it returns the matching tickets without reading any event file

#### Scenario: Unplanned disposition survives a rebuild
- **WHEN** a ticket was merged with `--unplanned "hotfix"` and `agentboard rebuild` runs twice
- **THEN** the ticket's `unplanned` is identical after each rebuild, the canonical dumps are byte-identical, and `rebuild --check` detects a hand-edited `unplanned` value

#### Scenario: Cache from an earlier schema is rebuilt
- **WHEN** a command opens a cache whose schema version predates the `unplanned` column
- **THEN** the cache is rebuilt from the event files before the command reads it

#### Scenario: A due grant is the only reason to read the log
- **WHEN** a board has a current cache and a ticket held under a lease with one waiter, whose lapse grant has a slot time in the future, and `agentboard list` runs first at a clock before that slot and then at a clock at or after it
- **THEN** the first run opens no event file and writes nothing, and the second writes the grant

#### Scenario: Lease survives a rebuild
- **WHEN** a ticket holds a renewed lease and `agentboard rebuild` runs
- **THEN** its lease_ttl, lease_expires_at and lease_event equal those of the renew event, lease_confirmed is true, and `rebuild --check` reports no divergence

#### Scenario: Old cache is rebuilt
- **WHEN** a cache written by a version without leases is opened
- **THEN** it is rebuilt from the events before the command proceeds, and inbox entries may be delivered again but none is skipped

#### Scenario: Cache without the watermark is rebuilt
- **WHEN** a cache written with the lease and queue state but without `grant_watermark` is opened on a board with a held lease and a waiter
- **THEN** it is rebuilt from the events before the command proceeds, its `grant_watermark` is the slot of the waiter's grant, and the grant is written once the clock reaches it

#### Scenario: Queue survives a rebuild
- **WHEN** a ticket has three waiters, one of whom left and rejoined, and `agentboard rebuild` runs
- **THEN** the `waiters` rows list the two remaining original waiters in join order followed by the rejoined waiter, and `rebuild --check` reports no divergence

### Requirement: Cache connection settings
Every connection to the cache SHALL enable WAL journal mode, set a busy
timeout of at least 5000 milliseconds, and enable foreign keys. Readers SHALL
never block writers and a writer SHALL wait for a concurrent writer rather
than fail immediately.

#### Scenario: Concurrent writer waits
- **WHEN** two processes attempt write transactions within the same millisecond
- **THEN** both succeed, one after the other, and neither reports a "database is locked" error

### Requirement: One command, one transaction
Every command that writes an event SHALL perform the following inside a
single cache transaction opened with `BEGIN IMMEDIATE`: fold any event files
not yet recorded in `folded` (catch-up); validate the requested action against
the current ticket state (state machine, assignment, existence); construct the
event with a hybrid timestamp later than the latest folded event; write the
event file atomically (temporary file in `events/`, fsync, rename to its hash
name); apply the event to the cache rows; record it in `folded`; commit. If
validation fails the command SHALL write no event of its own and exit with the
documented code, while the work of its catch-up (event files folded and due
grants written and folded) SHALL be committed. If the process dies after the
event file is written but before commit, the event file remains and the next
command's catch-up SHALL fold it.
A `move` or `close` that gives a scope disposition SHALL propose two events
in order, the disposition and then the move or close: each SHALL be
validated against the state the earlier one leaves, each SHALL have a
hybrid timestamp later than the one before, and if either fails validation
neither SHALL be written. Their files SHALL be written in that order, so a
crash can leave the disposition without its move or close, never the
reverse.

#### Scenario: Validation failure writes nothing
- **WHEN** `agentboard move T1 merged` runs, with nothing to catch up, while T1 is in status `todo`
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

#### Scenario: Refused command keeps its catch-up
- **WHEN** a grant is due on T1 and not yet written, and a command on T1 is refused by validation
- **THEN** the grant file exists, the cache shows the grantee holding T1 with an empty queue, the cache equals a fresh rebuild, and the grant is the only new event file

### Requirement: Rebuild
`agentboard rebuild` SHALL delete the cache contents and refold every event
file in deterministic order, reporting counts of folded, rejected, malformed,
corrupt and unknown-kind events. Rebuilding twice SHALL produce a cache whose
canonical dump is byte-identical. `rebuild --check` SHALL rebuild into a
temporary database, compare it with the live cache, report any difference and
exit 1 on divergence without modifying the live cache.

#### Scenario: Rebuild is deterministic
- **WHEN** `agentboard rebuild` runs twice on the same events
- **THEN** the canonical dumps of the two resulting caches are identical

#### Scenario: Check detects divergence
- **WHEN** the live cache has been hand-edited to change a ticket title and `agentboard rebuild --check` runs
- **THEN** the command reports the differing ticket and exits 1, and the live cache is unchanged
