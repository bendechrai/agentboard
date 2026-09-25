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
last folded position). Adding the lease and queue state SHALL increase the cache
schema version, so an older cache is rebuilt on first open. Query commands SHALL read ticket state only from the
cache, inside one read transaction so that every field comes from one
snapshot; `show` MAY additionally read the event files that `folded` marks
as unknown kinds (to report them) and, with `--raw`, the ticket's event
files, and MAY read the applied takeover, grant and forced release events
of the ticket to display them.

#### Scenario: List reads the cache
- **WHEN** `agentboard list --status implementing --json` runs on a board with a current cache
- **THEN** it returns the matching tickets without reading any event file

#### Scenario: Lease survives a rebuild
- **WHEN** a ticket holds a renewed lease and `agentboard rebuild` runs
- **THEN** its lease_ttl, lease_expires_at and lease_event equal those of the renew event, lease_confirmed is true, and `rebuild --check` reports no divergence

#### Scenario: Old cache is rebuilt
- **WHEN** a cache written by a version without leases is opened
- **THEN** it is rebuilt from the events before the command proceeds, and inbox entries may be delivered again but none is skipped

#### Scenario: Queue survives a rebuild
- **WHEN** a ticket has three waiters, one of whom left and rejoined, and `agentboard rebuild` runs
- **THEN** the `waiters` rows list the two remaining original waiters in join order followed by the rejoined waiter, and `rebuild --check` reports no divergence
