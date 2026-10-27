# Design

## Context

`openCache` (`src/store/cache.ts`) reads `meta.schema_version` and, when
it differs from `CACHE_SCHEMA_VERSION`, takes the write lock
(`inImmediate`, `BEGIN IMMEDIATE`), checks again under the lock (a
concurrent opener may have won), runs `SCHEMA` (drop every table, create
the current ones) and records the version and `last_position` `null`.
After the schema step `ensureCursorSeen` creates `cursor_seen` when it is
missing. The open never folds events; the first catch-up does.

A cursor (`src/store/cursors.ts`) is a fold position (the hash and
timestamp of the last delivered event) plus a seen set (hashes delivered
within `SEEN_WINDOW_MS`, one hour of wall time, before the position).
`isPending(cursor, event)` decides delivery from the cursor and the
event's hash and timestamp only. Whatever changes `folded` calls
`resetLateCursors(db, arrived)` with every event that became effective
in that call ("arrived"): for each cursor at `P`, an arrived event before
`P` with `ts.wall < P.ts.wall - SEEN_WINDOW_MS` is late, and the cursor
moves back to the greatest effective event before the earliest late one
(or to null). "Arrived" is computed against a snapshot of the `folded`
flags taken before the fold (`recordedFlags`, `becameEffective`): an
event applied now whose prior flag is not 1. On the incremental path of
`foldNew` (every new event sorts after `last_position`), every applied
input is passed.

The delivery invariant this rests on (board-concurrency "Inbox never
misses an event"): for every actor and every effective event `E`, either
`E` was delivered to that actor or `isPending(cursor, E)` is true.

Released versions: 0.1.0 is cache schema 1, 0.2.0 is schema 4, staging
is schema 5. All three create `cursors (actor TEXT PRIMARY KEY, last_wall
INTEGER, last_counter INTEGER, last_actor TEXT, last_hash TEXT)`,
`cursor_seen (actor TEXT NOT NULL, hash TEXT NOT NULL, wall INTEGER NOT
NULL, PRIMARY KEY (actor, hash))` and `folded (hash TEXT PRIMARY KEY,
folded INTEGER NOT NULL, reason TEXT, position TEXT)`. `cursors.ts` and
`compareFoldOrder` are unchanged since 0.1.0. 0.2.0 knows neither
`ticket.reconcile`, `ticket.renumber` nor `ticket.supersede` and records
them as unknown kinds; 0.1.0 also did not know `ticket.unplanned`.

## Goals / Non-Goals

Goals:

- An upgrade of the cache schema keeps every actor's inbox position, so
  the first `inbox` after it returns only what that actor has not been
  given, not the whole board.
- Never a skipped event: an event this version applies that the actor
  was not given (because the old version did not apply it, or the old
  cache had not recorded it yet) is still delivered.
- Whenever the carry cannot be shown safe (unexpected shape, unreadable
  table, a later version's cache), fall back to today's behavior.
- `rebuild --check` and the inspect-only open stay byte-for-byte
  non-modifying.

Non-Goals:

- Downgrades. An older version opening a newer cache drops every table
  as it does today; nothing in released code can change that, and none
  is needed: losing cursors is redelivery.
- Carrying anything else across the recreate. Everything else is
  derived and is rebuilt from the event files by the first catch-up.
- Changing the delivery rule, the seen window or `resetLateCursors`.

## Decisions

### Carry the cursor tables inside the recreate's transaction

The schema step, still under the write lock and after the re-check,
becomes: when the stored version is an earlier one, read the carry from
the old tables; run `SCHEMA` (which now also drops `carried_applied`);
record the version and `last_position` as today; then create
`cursor_seen` and write the carried `cursors` and `cursor_seen` rows and
the carried applied hashes. All of it commits or rolls back as one
transaction, so a concurrent opener sees either the old cache (and waits
on the lock, then finds the current version on its re-check) or the
new one with the cursors in place, never a recreated cache without them.
A process killed mid-step leaves the old cache, which the next open
carries.

"An earlier version" is a `schema_version` that is the decimal text of
an integer from 1 to `CACHE_SCHEMA_VERSION - 1`. A later version
(downgrade), no meta table or row, or anything else carries nothing. A
later version's cursors might follow a delivery rule this version does
not know, so the only safe reading is not to read them.

### The expected shape

Checked with `PRAGMA table_info(<table>)` on each table; a missing table
gives no rows and fails the check.

- `cursors`: exactly the columns `actor` (TEXT, primary key),
  `last_wall` (INTEGER), `last_counter` (INTEGER), `last_actor` (TEXT),
  `last_hash` (TEXT), and no other column. Names compare exactly,
  declared types case-insensitively.
- `cursor_seen`: exactly `actor` (TEXT), `hash` (TEXT), `wall`
  (INTEGER), with `actor` and `hash` the primary key, and no other
  column.
- `folded`: has `hash` (TEXT, primary key) and `folded` (INTEGER). Other
  columns are not read and do not matter (the table is derived and may
  change in a later version without affecting what `folded` = 1 means).

All three must pass, or nothing is carried. A cache whose `cursor_seen`
is missing (no release ever leaves one so) loses its cursors rather than
carrying positions without their seen sets: keeping a position with an
empty seen set would be safe (more redelivery), but it is a shape no
released version produces, and the simple rule is easier to review.

Rows are filtered, never repaired:

- a `cursors` row is carried when `actor` is TEXT and the four position
  columns are either all NULL or INTEGER, INTEGER, TEXT, TEXT
  (`typeof()`); other rows are left out, so that actor has the empty
  cursor and receives every effective event (redelivery);
- a `cursor_seen` row is carried when `actor` and `hash` are TEXT,
  `wall` is INTEGER, and its actor has a carried `cursors` row;
- an applied hash is carried for each `folded` row with `hash` TEXT and
  `folded` = 1 (INTEGER). Any other flag is treated as not applied, the
  conservative reading (it can only cause a reset, never prevent one).

Any SQLite error while reading the carry (for example SQLITE_CORRUPT on
a damaged table) makes the carry empty and the recreate proceeds as
today. A busy error cannot happen there (the lock is held) and is not
swallowed if it does.

### Remember what the old cache applied until the first fold

Carrying the cursors alone does not work. After the recreate `folded` is
empty and `last_position` is null, so the first catch-up records every
event file for the first time, takes the incremental path, and passes
every applied event to `resetLateCursors`. For any cursor more than an
hour past the board's first event, the board's first event is late, and
the cursor moves back to null: the full replay again, only later.

The question `resetLateCursors` needs answered is "which events are
effective now that were not effective when the cursor was last
maintained", and the old `folded` table is exactly that record. So the
recreate keeps its applied hashes in a transient table:

```sql
CREATE TABLE carried_applied (
  hash TEXT PRIMARY KEY
);
```

created only by a carrying recreate. The first write transaction that
records events into an empty `folded` (catch-up under the lock, a
command's own catch-up, or `rebuild`) uses it as the prior: an event is
"arrived" when it is applied now and, if `folded` had a row for it
before the fold, that row's flag was not 1, else it is not in
`carried_applied`. The same transaction drops `carried_applied`. In code
this is one helper that returns the prior applied set (`recordedFlags`
when `folded` is not empty, the carried hashes when it is) used by both
paths of `foldNew` and by `refoldWithCursors`; the incremental path then
filters its applied inputs against it instead of passing all of them.

A `carried_applied` found while `folded` is not empty is stale (left by
a version that does not know it, see "Mixed versions" below) and is
dropped without being used. A locked catch-up that records nothing (no
event files) leaves it; it describes no event and does no harm.

`carried_applied` is not covered by `dumpCache`, `diffCaches` or
`rebuild --check` (like the cursor tables, it is not derived from the
event files), so a cache that still holds it compares equal to a fresh
rebuild.

### Why no event is skipped

Let `C` be an actor's cursor in the old cache at the moment of the
recreate, `A_old` the set of events the old cache had applied (its
`folded` = 1 rows), and `A_new` the set this version applies after the
first fold. The old invariant gives: for every `E` in `A_old`, `E` was
delivered to the actor or `isPending(C, E)`.

1. The carried cursor is `C` itself: same position (hash and
   timestamp, which are fixed by the event file), same seen set. Fold
   order of positions is `compareHlc` then hash, the same in every
   version, and `isPending` is the same function, so for every event
   `isPending` gives the same answer before and after the recreate.
2. `E` in `A_new` and in `A_old`: delivered, or still pending under the
   same cursor. Not passed to `resetLateCursors` (not "arrived"), and it
   need not be.
3. `E` in `A_new` and not in `A_old`: this covers an event the old
   version recorded as rejected or as an unknown kind (for example a
   `ticket.supersede` from a newer peer, which 0.2.0 does not know), and
   an event file the old cache had not recorded yet (it arrived after the
   old version's last catch-up). It was never delivered to the actor
   (inbox delivers only applied events). It is "arrived" in the first
   fold. If it sorts after `C`'s position, or before it but inside the
   seen window, `isPending` is true (it is not in the seen set, since it
   was never delivered). If it sorts before the position and outside the
   window, `resetLateCursors` moves the cursor back before it, and it is
   pending. Either way the next `inbox` returns it.
4. `E` in `A_old` and not in `A_new`: no longer effective, so there is
   nothing to deliver. If it is the cursor's position, `isPending` still
   treats the position as delivered, which only concerns that one event,
   and `resetLateCursors` never moves a cursor onto it (it picks
   effective events only).
5. Events after the first fold follow the unchanged rules.

So the invariant holds for `A_new` right after the first fold, which is
all "never skipped" asks. The cost of case 3 when the event is behind
the window is today's late-event cost: the events between the new and
the old position that are outside the seen set are redelivered.

The argument depends on three things being the same in the version that
wrote the cursor and the version that reads it: the cursor table
shapes, the delivery rule (`isPending`, `SEEN_WINDOW_MS`) and fold
order. All three are unchanged from 0.1.0 to this change. A later change
that alters the delivery rule or fold order must either change the
cursor table shape (so the shape check refuses the carry) or stop
carrying from versions before it; the module documentation of
`cursors.ts` says so.

### Cache older than the cursor tables, and odd shapes

Every released cache (schema 1 and later) has all three tables in the
expected shape, so every released cache carries. A cache whose tables do
not match, including any hand-made or damaged one, falls back to
today's recreate: cursors are lost and every actor is redelivered the
board once. That is the existing guarantee, never a skip.

### Mixed versions on one board

Two versions sharing one `.board` (a local cache is per clone, so this
means two binaries on one machine) already drop each other's cache on
every switch. With this change: the newer version carries the older
one's cursors; the older one drops the newer cache, cursors included, as
today, and leaves `carried_applied` behind if it existed (it does not
know the table). When the newer version next opens that cache, its
version is older, so the recreate drops the stale `carried_applied` with
everything else before carrying afresh. A build of schema 5 from before
this change (unreleased) never creates or reads `carried_applied`, and
the stale-table rule above covers it leaving one behind.

### Read-only paths

The inspect-only open (`prepare: false`, used by `rebuild --check`) still
throws `schema-mismatch` for a cache of another version and never takes
the write lock, so it never carries, never creates `carried_applied` and
leaves the file byte for byte unchanged. `checkCache`'s temporary
`:memory:` cache is created fresh and carries nothing. `rebuild --check`
on a current cache that still holds `carried_applied` ignores the table
and does not drop it.

### No schema version bump

The cursor tables are unchanged. `carried_applied` is optional: a schema
5 cache without it means nothing is carried, which is the state of every
schema 5 cache after its first fold. So `CACHE_SCHEMA_VERSION` stays 5,
and the change ships in the same release as the bump to 5, so that the
0.2.0 upgrade is the first to keep cursors.

### No ADR

This refines how the cache treats its one non-derivable table on a
schema change; it adds no architecture. It is recorded here and in the
board-cache requirement.

## Alternatives considered

- **Carry the cursor tables only.** Simple, and wrong in effect: the
  first fold resets every cursor more than an hour into the board back
  to null (see "Remember what the old cache applied"). Rejected.
- **Carry the cursors and skip `resetLateCursors` on the first fold.**
  Keeps positions, but skips case 3: an event the old version recorded as
  unknown, behind the cursor and outside the window, would never be
  delivered. Rejected; it breaks "never a skip".
- **Reset each carried cursor to before the earliest event whose outcome
  changed, computed in the open.** Needs the new fold outcome, which the
  open does not have (it never reads event files). The carried prior
  gives the same result at the first fold through the existing
  `resetLateCursors`.
- **Fold inside the open, holding the old flags in memory.** Removes the
  transient table, but makes `openCache` fold events (it has no events
  directory today and is used for `:memory:` caches), and a process
  killed between the recreate and the fold would lose the prior, after
  which the next fold resets every cursor. Rejected; the table survives
  a crash.
- **Store the prior in a `meta` row.** `meta` is covered by `dumpCache`,
  so the cache would differ from a fresh rebuild until the first fold,
  and a row can be very large. Rejected.
- **Migrate the derived tables in place instead of recreating.** Per
  version migrations of a disposable cache are cost with no benefit;
  rebuilding from the event files is the design. Rejected.
- **Bump the schema version.** Not needed (see above), and a bump would
  itself be an upgrade that this change has to survive.

## Risks / Trade-offs

- The first fold after an upgrade still reads every event file, as
  today; the carry adds one read of the old `cursors`, `cursor_seen` and
  `folded` rows under the lock, and one set lookup per event.
- A user who relied on an upgrade to redeliver the whole board (none is
  documented) no longer gets it; `inbox --since` and deleting the cache
  still do.
- The no-skip argument assumes the old cache honoured the delivery
  invariant. A cache damaged in a way that keeps the expected shape
  (a hand-edited cursor) is carried as it is, exactly as `rebuild` keeps
  such a cursor today.
