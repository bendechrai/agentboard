# 3. Inbox cursors as a position plus a seen set

Date: 2026-09-24

## Status

Accepted

## Context

`inbox --as <actor>` returns the events an actor has not yet acknowledged
and then advances that actor's cursor. The orchestrator protocol depends on
it never missing an event: an orchestrator that misses a hand-off stalls
the whole loop.

Events are folded in `(ts.wall, ts.counter, ts.actor, hash)` order. When
two machines exchange events through `sync`, an event can arrive with a
timestamp earlier than events the actor has already acknowledged, because
it was written on the other machine before they were but synced after. A
cursor that is only a position (or a timestamp) would treat that event as
already seen and skip it for good.

A related case: an event can become effective after the fact. A comment
synced before its ticket's `ticket.create` is rejected as `unknown-ticket`;
when the create arrives, a refold makes the comment effective, at a
position that may be long behind every cursor.

## Decision

A cursor is a fold position plus a bounded seen set.

- The position is the last event delivered to the actor (the `cursors`
  table: `last_wall`, `last_counter`, `last_actor`, `last_hash`).
- The seen set is the hashes of events delivered to the actor whose wall
  is within one hour (`SEEN_WINDOW_MS`) before the position's wall, stored
  in a second table, `cursor_seen (actor, hash, wall)`, and pruned to that
  window whenever the cursor advances.

An effective event is pending for an actor when its hash is not in the
seen set and either it sorts after the position, or it sorts before the
position with a wall inside the window. The position itself is never
pending. `inbox` lists the pending events in fold order and advances the
cursor in the same `BEGIN IMMEDIATE` transaction, so two concurrent calls
for one actor never deliver the same event twice. Advancing never moves a
position backwards: delivering only late events keeps the old position.

Events older than the window are handled when they become effective, not
when `inbox` runs. Whatever changes the `folded` table (the catch-up at the
start of any command, and `rebuild`) passes every event it made effective,
whether newly recorded as applied or turned from rejected to applied by a
refold, to `resetLateCursors`. For each cursor, an event that sorts before
the position with a wall older than the window is late (an event exactly
at the window boundary is inside it). The cursor is moved back to the
greatest effective event that sorts strictly before the earliest late
event, or to no position when there is none; the seen set is kept. The
reset lands only on effective events, never on a rejected, unknown or
malformed one: the position is treated as delivered, so a rejected event
used as a position and later made effective would be skipped forever.

What is reported differs by path. A catch-up resets cursors silently: the
command that triggered it (any command) does not list the late events, and
the next `inbox` simply delivers them. `rebuild` lists, in its report's
`late` field, the late events that the rebuild itself made effective, one
per (actor, event); events an earlier catch-up already handled are not
listed again.

Cursors live in the cache but are the one thing there that is not derived
from the event log. `rebuild` keeps `cursors` and `cursor_seen`; `rebuild
--check` does not compare them. Losing them (a deleted cache, a schema
version change) makes every event pending again: redelivery, never a skip.

`watch` never advances the stored cursor; it is a stream, not an
acknowledgement. It keeps its own in-memory bookmark: the set of effective
events it has examined, plus SQLite's `data_version` at its last look. A
tick whose catch-up folded nothing, with no commit from another connection
since, reads nothing. Otherwise it lists from `folded` the effective events
not yet examined (new, late, or newly effective) and passes on those
pending for the stored cursor, so no entry is passed on twice. The
examined set is not pruned, because pruning could make an old event look
new; it grows by one hash per effective event for the life of the watch.

## Rationale

The seen set catches the common late arrival (events synced a few minutes
or hours out of order) at `inbox` time with no extra work, and bounding it
by wall time keeps it small regardless of how long the board lives. The
reset handles the rare arrival older than the window without keeping an
unbounded seen set: it trades redelivery (every unseen event between the
new and old position is delivered again) for never skipping. An
orchestrator that acts idempotently on events, which it must anyway, pays
nothing for redelivery.

Doing the reset where events become effective, inside the transaction that
folds them, means no path can fold a late event without the check: every
command catches up, and `rebuild` refolds everything.

## Consequences

- An actor may receive an event twice after a reset or after a lost cache.
  Consumers must tolerate redelivery; they never have to tolerate a gap.
- A reset is invisible to the command that caused it, except through
  `rebuild`'s report. This is deliberate: a `comment` or `list` should not
  print inbox bookkeeping for other actors.
- `cursor_seen` is created with `CREATE TABLE IF NOT EXISTS` on every open,
  so caches created before it existed gain it without a schema version
  change.
- `--since <hash>` bypasses the stored cursor entirely (neither read nor
  written) and implies `--peek`.

## Alternatives considered

**A timestamp cursor.** Rejected: it skips every event synced in with an
earlier timestamp, which is exactly the cross-machine case the board must
handle.

**An unbounded seen set (every hash ever delivered).** Correct without any
reset, but it grows with the board forever and must be read on every
`inbox`. The bounded set plus the reset gives the same guarantee with a
set sized by recent activity.

**Detect late events only in `inbox`.** Rejected: `inbox` would have to
rescan the whole log on every call to find old events it has not seen,
which is what the bounded window exists to avoid.
