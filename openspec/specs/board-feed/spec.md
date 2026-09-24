# board-feed Specification

## Purpose
Defines the board-wide change feed: append and resync messages, position
ids, resuming from a position and joining a running feed, shared by every
live view of the board (the web server's event stream and, later, the
terminal UI) without ever blocking writers.

## Requirements

### Requirement: Board-wide change feed
The board SHALL provide a change feed that follows every effective event of
the board (an event recorded in `folded` as applied), of every kind and on
every ticket, independent of any actor. The feed SHALL run ticks the way
`watch` does: one tick at start, then a tick after each `fs.watch`
notification on `events/` (coalesced over 25 milliseconds) and every 2
seconds regardless, never two ticks at once. Each tick SHALL run the same
catch-up as any read command. A tick whose catch-up folded nothing, when
neither `PRAGMA data_version` nor the connection's `total_changes()` has
moved since the previous examination, SHALL read no event file and no
`folded` row. The feed SHALL never read or write a cursor, and a tick that
fails with reason `busy` SHALL be reported as a warning and retried at the
next tick. `watch` SHALL keep its current behavior and output while
sharing the same tick machinery.

#### Scenario: Event written by another process
- **WHEN** a feed is running and another process runs `agentboard comment T1 --as impl "hi"`
- **THEN** the feed reports the comment within 3 seconds, and no actor's cursor has changed

#### Scenario: Idle ticks read nothing
- **WHEN** a feed has examined the board and several ticks pass with no write by any process
- **THEN** those ticks read no event file

#### Scenario: Watch is unchanged
- **WHEN** the existing `watch` tests run after the tick machinery is shared
- **THEN** they pass without modification

### Requirement: Append and resync messages
The feed SHALL keep the set of effective events it has delivered and its
head, the greatest delivered event in fold order. For a tick that finds a
change it SHALL emit exactly one message:
- an `append` when every newly effective event sorts after the head and no
  delivered event has stopped being effective, carrying the newly effective
  events in fold order and the current state of every ticket they name
  (and the board `meta` when one of them is `board.meta`), all read from
  one snapshot;
- otherwise a `resync`, carrying the late events (newly effective and
  sorting before the head, in fold order) and the hashes of the delivered
  events that are no longer effective, after which the consumer SHALL
  reload its snapshot.
The first message of a feed started without a position SHALL be an
`append` of every effective event. A tick that finds no change SHALL emit
nothing.

#### Scenario: New event after the head
- **WHEN** the head is a comment at wall 2000 and a move at wall 3000 is written
- **THEN** the feed emits an `append` with the move and the moved ticket's current state

#### Scenario: Late event from sync
- **WHEN** the head is at wall 2000 and an event file with wall 1500 is copied into `events/` as `sync` would
- **THEN** the feed emits a `resync` whose late events include the wall 1500 event

#### Scenario: An event stops being effective
- **WHEN** the feed has delivered a `ticket.claim` by `a` on T1, and an earlier `ticket.claim` by `b` on T1 arrives from another machine
- **THEN** the feed emits a `resync` listing the claim by `b` as late and the claim by `a` as removed

### Requirement: Position ids
Every feed message SHALL carry a position id `<head>.<digest>`, where
`<head>` is the 64-character hash of the head after the message, or
`none` when no event is effective, and `<digest>` is 64 lowercase hex
characters: the bytewise XOR of the SHA-256 values (32 bytes each, from
their hashes) of every effective event at or before the head, or 64 zeros
when there is none. The id SHALL be computed from the same snapshot as the
message.

#### Scenario: Digest is order independent
- **WHEN** the same set of effective events is folded from files presented in two different orders
- **THEN** the position ids are identical

#### Scenario: Empty board
- **WHEN** a feed starts on a board with no event
- **THEN** its position id is `none.` followed by 64 zeros

### Requirement: Resume from a position id
A feed started with a position id SHALL compare it with the board: when the
id parses, its head is a recorded effective event, and the digest of the
effective events at or before that head equals the id's digest, the first
message SHALL be an `append` of the effective events after that head (with
the state of the tickets they name), or nothing when there are none;
otherwise the first message SHALL be a `resync`. The empty-board id
resumes as the position before every event: it gives an `append` of every
effective event, or nothing on a board that is still empty. A `resync`
sent at resume carries empty `late` and `removed` lists, because the feed
cannot know what the consumer held. An id that does not parse SHALL cause a
`resync`, never an error.

#### Scenario: Resume after missed appends
- **WHEN** a consumer last received id X, then two comments are written, then a feed is started with X
- **THEN** its first message is an `append` of exactly those two comments

#### Scenario: Late arrival while disconnected
- **WHEN** a consumer last received id X, and an event sorting before X's head becomes effective before the feed is restarted with X
- **THEN** the first message is a `resync`

#### Scenario: Unparsable id
- **WHEN** a feed is started with the position id `garbage`
- **THEN** its first message is a `resync`

### Requirement: Joining a running feed
One running feed MAY serve several consumers, each joining at its own
position id. A consumer's position id SHALL be compared with the board,
not with the state the feed has delivered so far: before computing a
joining consumer's first message, the feed SHALL bring itself up to date
in the same synchronous turn, running one catch-up and examination as a
tick does and delivering any resulting message to the consumers already
joined, and SHALL then compute the joiner's first message from the
resulting state exactly as "Resume from a position id" describes. No
message of the feed SHALL fall between that first message and the
joiner's subscription. So a consumer joining with the id of any snapshot
of the board taken before the join receives an `append` of exactly the
effective events after that id, or nothing, and never a `resync` or an
event the snapshot already held (unless the board itself changed so that
a resync is due).

#### Scenario: Join from a snapshot ahead of the feed
- **WHEN** a feed is running, another process writes a comment, a snapshot of the board is taken (its id includes the comment), and a consumer joins with that id before the feed's next tick
- **THEN** the joiner's first message is nothing (no `resync`), the consumers already joined receive an `append` of the comment, and no later message to the joiner carries the comment

#### Scenario: Join from an older snapshot
- **WHEN** a consumer joins a running feed with the id of a snapshot taken before two comments that the feed has not yet examined
- **THEN** the joiner's first message is an `append` of exactly those two comments

### Requirement: The feed never blocks writers
The feed SHALL take the write lock only when its catch-up has something to
fold or reap, SHALL read each message's data inside one short read
snapshot that it ends before delivering the message, and SHALL never hold
a transaction while a consumer processes a message or while waiting for a
timer or IO.

#### Scenario: Stalled consumer
- **WHEN** a consumer of the feed stops processing messages and twenty processes then each run `comment` on one ticket
- **THEN** all twenty commands exit 0 within the busy timeout
