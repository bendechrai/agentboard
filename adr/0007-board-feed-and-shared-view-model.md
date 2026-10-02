# 7. Board feed with append, resync and digest resume; a shared view-model

Date: 2026-09-24

## Status

Accepted

## Context

`watch` (ADR 0003) streams one actor's pending inbox entries. A live view
of the board (the web page of `agentboard serve`, and later `agentboard
top` and the insights views) needs something different: every effective
event, of every kind, independent of any actor, and a correct picture of
board state. Two properties of the event log make that harder than
appending events as they appear:

- events arrive late through `sync`, sorting before events already shown;
- an event can stop being effective. Two clones each fold a local claim of
  one ticket; after `sync` the earlier claim wins and the other is refolded
  as `already-assigned`. An inbox is a stream and never has to take an
  entry back; a board view does.

A browser also disconnects (network blips, laptop sleep) and should resume
without a full reload when nothing unusual happened, but must never miss a
late arrival or a refold that happened while it was away. Finally, the web
client, the terminal UI and the insights all need the same columns, feed
summaries, conversations and lanes, and should not each reimplement them.

## Decision

**One tick loop.** The tick machinery of `watch` (an initial tick, a tick
after each `fs.watch` notification on `events/` coalesced over 25 ms, a
tick every 2 seconds regardless, never two at once, `busy` reported as a
warning, cleanup on abort) moves to `src/board/ticker.ts` and runs both
`watchInbox` and the board feed. A tick whose catch-up folded nothing and
whose change marker (`PRAGMA data_version` plus `total_changes()`) has not
moved reads no event file. The feed never reads or writes a cursor.

**Append or resync.** The feed (`watchBoard`, `src/board/feed.ts`) keeps
the set of effective events it has delivered and its head, the greatest
delivered event in fold order. A tick that finds a change emits exactly one
message:

- `append` when every newly effective event sorts after the head and no
  delivered event stopped being effective. It carries the new events in
  fold order and the current state of every ticket they name (and the
  board meta when it changed), read from one snapshot.
- `resync` otherwise, listing the late events (newly effective behind the
  head) and the hashes of removed ones (no longer effective). The consumer
  reloads its snapshot rather than patching its model.

**Position ids and digest resume.** Every message has the id
`<head>.<digest>`: the head's hash (or `none` on an empty board) and the
64-character hex XOR of the SHA-256 values of every effective event at or
before the head. XOR over a set is order independent and updated in
constant time per added or removed event. A consumer resumes by sending an
id (`Last-Event-ID`, or `?since=` from its snapshot). When the head is a
recorded event and the digest of the effective events up to it matches,
the consumer's set is the board's, and it receives one append of the
events after the head; otherwise, including an unparsable id, a resync.

**Joins catch up first.** One feed serves every stream of a server. A
snapshot from `/api/board` runs its own catch-up, so its id can be ahead
of what the shared feed has delivered for up to one tick. A join therefore
first brings the shared feed up to date in the same synchronous turn (one
catch-up and examination, exactly as a tick, fanning any resulting message
out to the streams already open), and only then computes the joiner's
first message against the result. A stream started with the id of any
earlier snapshot gets an append of exactly the events after it, or
nothing, and never a spurious resync or a duplicate.

**Event files cached by hash.** File names are content hashes and files
are never modified, so a process-wide map from hash to parsed event means
no file is read twice.

**A shared, pure view-model.** `src/view/` holds pure functions from
tickets, events with outcomes, `now` and filters to plain view data:
`boardColumns`, `feedEntries`, `describeEvent`, `conversation`,
`agentLanes`, `relativeTime`, and `applyFeedMessage`, the reducer that
applies an append to a client model (a resync reloads). They read no
clock, do no IO and import no `node:` module, directly or transitively,
which a layering test enforces, so the browser bundle, the terminal UI and
the insights use the same definitions. `ulid.ts` uses the global Web
Crypto `getRandomValues` and `openDecisions` lives in
`src/events/decisions.ts` to make this possible; both are re-exported
unchanged.

## Rationale

Append covers nearly every tick with a small message and exact event
granularity, which the activity feed needs. Resync handles the rare late
arrival and refold correctly without teaching every consumer to refold:
a reload is one request. The digest distinguishes the one case a head
hash or a count cannot: a late arrival and a removed claim during a
disconnect cancel out in a count, and leave the head unchanged. Making a
join catch up first removes the window in which a fresh snapshot is ahead
of the feed (found by the security review: 13 of 25 page loads during a
burst of agent writes got a spurious resync and a duplicated event). Sharing
the ticker keeps one tested implementation of tick timing; the unchanged
`watch` tests are the check that the extraction was safe. A pure
view-model is tested once, table-driven, and a property test pins that a
model built from a snapshot plus an append equals a model built from a
later snapshot.

## Consequences

- A consumer must handle resync by reloading; it never gets a patch for a
  late or removed event.
- The feed's delivered set grows by one hash per effective event for the
  life of the feed, like `watch`'s examined set.
- The server's event cache holds one parsed event per well-formed file, of
  the same order of size as the log, freed on exit.
- A reconnect after a quiet disconnect costs one append, not a reload.
- Anything that renders board state (`serve`, `top`, the insights) goes
  through `src/view/`, so a change to a summary or a column rule is made
  once.

## Alternatives considered

**Send the whole board state on every change.** Simple, but it re-sends
every ticket for each comment and loses the event granularity the feed
needs.

**Refold late events in the client.** Correct, but every consumer would
have to do it, the terminal UI included.

**Resume by head hash alone.** Misses a late arrival behind the head
during a disconnect.

**Resume by a count of effective events up to the head.** An added late
event and a removed claim cancel out, which is exactly the claim race.

**Always resync on reconnect.** Correct, but reloads everything after every
network blip or sleep.

**Resume a joiner against the feed's delivered set.** The original design;
it gave spurious resyncs and duplicated events when the snapshot was ahead
of the feed (see Rationale).
