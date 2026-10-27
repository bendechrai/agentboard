## MODIFIED Requirements

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

When a preparing open finds a cache of an earlier schema version (a
`meta.schema_version` that is an integer from 1 up to, but not including,
the running version) and recreates the schema, it SHALL keep the cursor
tables, in the same write transaction as the recreate, whenever the old
`cursors`, `cursor_seen` and `folded` tables have the expected columns
(`cursors`: exactly `actor`, `last_wall`, `last_counter`, `last_actor`,
`last_hash`; `cursor_seen`: exactly `actor`, `hash`, `wall`; `folded`: at
least `hash` and `folded`; with the declared types of the running schema).
It SHALL keep every cursor row whose values have the expected types, and
the seen rows of those actors, unchanged. When any of the three tables is
missing or has other columns, or reading them fails, it SHALL drop the
cursors with every other table, and a cursor row with values of other
types SHALL be dropped; that actor is then given every effective event
again. A cache of a later schema version, or with no schema version, SHALL
be recreated without keeping cursors. The open SHALL keep, until the
first fold that records events into the recreated cache, which events the
old cache had applied; that fold SHALL treat an event as newly effective
for the purpose of moving cursors back only when the old cache had not
applied it, so an actor's next `inbox` returns the events after its
cursor (and the unseen ones inside its seen window), plus every event that
the running version applies and the old version did not, wherever it sits
relative to the cursor. The record of the old cache's applied events SHALL
be discarded by that fold and SHALL NOT be compared by `rebuild --check`.

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

#### Scenario: Upgrade from a 0.2.0 cache keeps every actor's position
- **WHEN** a board's cache was made by agentboard 0.2.0 (schema version 4), two actors have each run `inbox` on it (one more than an hour of event time after the board's first event), and this version runs `inbox --peek --as` each actor
- **THEN** the cache is recreated at the running schema version with both actors' `cursors` and `cursor_seen` rows unchanged, and each call returns only the effective events after that actor's cursor, none of the events it was already given

#### Scenario: Upgrade delivers an event the old version did not apply
- **WHEN** a 0.2.0 cache recorded a `ticket.supersede` event as an unknown kind, an actor's cursor is more than an hour of event time past it, and this version runs `inbox --as` that actor
- **THEN** the returned events include the `ticket.supersede` event, and no event that the actor was already given is returned when it sorts before the greatest effective event preceding the `ticket.supersede` and is more than an hour of event time before that event

#### Scenario: Upgrade delivers an event the old cache had not recorded
- **WHEN** an event file with a timestamp more than an hour before an actor's cursor is added to `events/` after the 0.2.0 cache last caught up, and this version runs `inbox --as` that actor
- **THEN** the returned events include that event

#### Scenario: Cache without the expected cursor tables loses its cursors
- **WHEN** a cache of an earlier schema version has no `cursor_seen` table, or a `cursors` table with a column added or missing, and this version opens it
- **THEN** the cache is recreated with no cursor rows, and each actor's next `inbox` returns every effective event

#### Scenario: Cache of a later schema version is recreated as before
- **WHEN** this version opens a cache whose schema version is greater than the running one
- **THEN** every table, cursors included, is dropped and recreated empty

#### Scenario: Inspecting an earlier cache changes nothing
- **WHEN** `agentboard rebuild --check` runs on a board whose cache was made by 0.2.0
- **THEN** it exits 1 reporting `schema-mismatch`, and the cache file, including its cursor tables, is byte for byte unchanged and still at schema version 4
