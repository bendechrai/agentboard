# Spec Delta

## Purpose

Defines the derived SQLite cache that answers queries quickly, the transaction
discipline that makes every command atomic against concurrent processes, and
how the cache is rebuilt from the event log.

## ADDED Requirements

### Requirement: Cache is derived and disposable
The board SHALL keep a SQLite database at `.board/cache.sqlite`, excluded from
the board's own git repository. The cache SHALL contain nothing that is not
derivable from the event log, with one exception: `cursors`, which record
what each actor has acknowledged through `inbox`. Losing cursors SHALL only
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
assignee, version, updated_at, task_source, task_ref, task_item, adhoc,
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
validation fails the command SHALL write nothing and exit with the documented
code. If the process dies after the event file is written but before commit,
the event file remains and the next command's catch-up SHALL fold it.

#### Scenario: Validation failure writes nothing
- **WHEN** `agentboard move T1 merged` runs while T1 is in status `todo`
- **THEN** no event file is created, the cache is unchanged, and the command exits 4 with reason `invalid-transition`

#### Scenario: Crash between file and commit
- **WHEN** a command is killed after its event file is renamed into place but before the transaction commits
- **THEN** the next command folds that event and the cache reflects it exactly as if the first command had completed

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
