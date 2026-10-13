## MODIFIED Requirements

### Requirement: Cache schema
The cache SHALL contain tables `tickets` (id, title, description, status,
assignee, lease_ttl, lease_expires_at, lease_event and lease_confirmed
(all null when the ticket has no lease), available_at and available_event
(when and by which release, forced release or lapse the ticket last
became available, for deriving grants), version, updated_at, task_source, task_ref, task_item, adhoc,
labels as a JSON array,
closed, decision, checklist as a JSON array), `waiters` (ticket id,
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
rebuilt on first open too. Query commands SHALL read ticket state only from the
cache, inside one read transaction so that every field comes from one
snapshot; `show` MAY additionally read the event files that `folded` marks
as unknown kinds (to report them) and, with `--raw`, the ticket's event
files, and MAY read the applied takeover, grant and forced release events
of the ticket to display them.

#### Scenario: List reads the cache
- **WHEN** `agentboard list --status implementing --json` runs on a board with a current cache and no grant due at the local clock
- **THEN** it returns the matching tickets without reading any event file

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

#### Scenario: Validation failure writes nothing
- **WHEN** `agentboard move T1 merged` runs, with nothing to catch up, while T1 is in status `todo`
- **THEN** no event file is created, the cache is unchanged, and the command exits 4 with reason `invalid-transition`

#### Scenario: Crash between file and commit
- **WHEN** a command is killed after its event file is renamed into place but before the transaction commits
- **THEN** the next command folds that event and the cache reflects it exactly as if the first command had completed

#### Scenario: Refused command keeps its catch-up
- **WHEN** a grant is due on T1 and not yet written, and a command on T1 is refused by validation
- **THEN** the grant file exists, the cache shows the grantee holding T1 with an empty queue, the cache equals a fresh rebuild, and the grant is the only new event file
