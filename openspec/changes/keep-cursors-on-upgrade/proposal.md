# Proposal

## Why

The SQLite cache is disposable except for the cursor tables, `cursors`
and `cursor_seen`, which record what each actor has acknowledged through
`inbox`. `rebuild` keeps them, but when `openCache` finds a
`meta.schema_version` other than `CACHE_SCHEMA_VERSION` it drops every
table and recreates the schema empty, cursors included. board-cache
tolerates that ("Losing cursors SHALL only cause events to be delivered
again, never skipped"), and it is safe, but in practice every actor's
next `inbox` after an upgrade returns the whole board once. An
orchestrator or worker following the guidance reads that as news and may
act on stale events (re-dispatching finished work, answering old
handoffs).

0.2.0 caches are schema 4 and the next release is schema 5 (the
`unplanned` and `superseded` columns and removed checklist lines of
`add-claim-leases`), so every user hits this on the upgrade. Nothing
forces it: `cursors` and `cursor_seen` have the same columns in 0.1.0,
0.2.0 and staging, `src/store/cursors.ts` (the delivery rule, the seen
window, fold order of positions) is unchanged since 0.1.0, and a cursor
names events by timestamp and hash, which the event files fix and no
schema version changes.

Ticket 01M5Y0T56JQ1HS04A3N042Y2Z4.

## What Changes

- When `openCache` recreates the schema of a cache whose stored schema
  version is an earlier one (an integer from 1 to
  `CACHE_SCHEMA_VERSION - 1`), it carries the cursor tables across the
  recreate, in the same `BEGIN IMMEDIATE` transaction: it reads the old
  `cursors` and `cursor_seen` rows and the hashes the old `folded` table
  records as applied, drops and recreates every table as today, and
  writes the cursor rows back and the applied hashes into a new
  transient table, `carried_applied`.
- The carry happens only when all three old tables have the expected
  shape (checked with `PRAGMA table_info`); otherwise, and on any error
  reading them, the recreate drops the cursors exactly as today
  (redelivery, never a skip). Cursor rows with ill-typed values are left
  out (that actor is redelivered everything).
- The first transaction that records events into the then empty
  `folded` table (a locked catch-up, a command's catch-up, or `rebuild`)
  treats an event as having become effective only when it is applied now
  and was not applied in the old cache, passes only those to
  `resetLateCursors`, and drops `carried_applied`. Without this, every
  event would look newly effective and `resetLateCursors` would move
  every cursor back to the start, which is today's full replay again.
- So an actor's first `inbox` after the upgrade returns the events after
  its cursor (and unseen ones inside its seen window, as always), plus
  any event that this version applies and the old version did not (for
  example a `ticket.supersede` synced from a newer peer that 0.2.0
  recorded as an unknown kind) that sits behind the cursor.
- A cache of a later schema version (a downgrade), a cache with no
  schema version, and a file that is not a cache recreate exactly as
  today. `rebuild --check` and the inspect-only open
  (`openCache(path, { prepare: false })`) are unchanged and never modify
  the file. No cache schema version bump.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `board-cache`: "Cache is derived and disposable" states that a schema
  upgrade keeps the cursor tables when the old cache has them in the
  expected shape, how the first fold after it decides which events moved
  behind a cursor, and when cursors are still lost (with scenarios).

## Impact

- `src/store/cache.ts`: the schema step of `openCache` (the carry, the
  shape check, `carried_applied` in `SCHEMA`'s drops and in the module
  documentation); `inspectCache` unchanged.
- `src/store/engine.ts`: `foldNew` (incremental and refold paths) and
  `refoldWithCursors` (used by `rebuild`) take the prior applied set from
  `carried_applied` when `folded` is empty, and drop it.
- `src/store/cursors.ts`: module documentation only (a schema version
  change no longer always loses cursors).
- Tests under `src/store/__tests__/` with a cache made by 0.2.0 (or a
  faithful construction of one).
- README.md (the paragraph on upgrading every machine that shares a
  board gains a sentence: an upgrade keeps each actor's inbox position,
  and the first `inbox` also returns events the old version did not
  apply) and STATUS.md.
- No new command, flag, exit code, reason or JSON field, and no change
  to `CACHE_SCHEMA_VERSION`.
