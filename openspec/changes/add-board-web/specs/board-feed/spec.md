# Spec Delta

## ADDED Requirements

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

### Requirement: The feed never blocks writers
The feed SHALL take the write lock only when its catch-up has something to
fold or reap, SHALL read each message's data inside one short read
snapshot that it ends before delivering the message, and SHALL never hold
a transaction while a consumer processes a message or while waiting for a
timer or IO.

#### Scenario: Stalled consumer
- **WHEN** a consumer of the feed stops processing messages and twenty processes then each run `comment` on one ticket
- **THEN** all twenty commands exit 0 within the busy timeout
