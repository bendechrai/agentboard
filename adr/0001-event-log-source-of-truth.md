# 1. Event log as the source of truth

Date: 2026-09-23

## Status

Accepted

## Context

agentboard is a ticket board for AI agents working on one project, with no
hosted service. Multiple agents, possibly running concurrently and possibly
on different machines that sync the project over git, need to create and
update tickets without a central server to arbitrate writes and without
clobbering each other's changes.

We need a storage format for `.board/` that supports concurrent writers
with no coordination, merges cleanly when synced between machines through
git, and still supports fast queries (list open tickets, filter by status,
and so on).

## Decision

The source of truth is an append-only, content-addressed event log: every
change to the board (create a ticket, move it, comment on it, close it) is
written as its own new file under `.board/`, named by the hash of its
content. Existing event files are never modified or deleted. A SQLite
database, built by folding the event log in order, is kept purely as a
disposable read cache for fast queries; it can be deleted and rebuilt from
the event log at any time and is never treated as authoritative.

## Rationale

Concurrent agents never modify a file that another agent might also be
writing, so there is no clobbering: two agents adding events at the same
time simply add two different files. When the project's `.board/` directory
is synced between machines through git (or copied, or synced by any other
add-only mechanism), the merge is trivial: the union of event files from
both sides is a valid, complete event log, with no merge conflicts to
resolve by hand. The SQLite cache gives fast queries without giving up any
of this, because it is derived, not authoritative: it can always be thrown
away and rebuilt from the event log alone.

## Consequences

- Reading current board state requires folding the event log (or querying
  the derived cache); there is no single file to open and read directly.
- The event log grows without bound over the life of a project; compaction
  or archival of old events is a future concern, not addressed by this
  decision.
- The SQLite cache must be rebuilt (or incrementally updated) whenever new
  event files appear, including after a git sync picks up events written by
  another machine.

## Alternatives considered

**A single SQLite file, synced by copy.** Simpler to implement, since
reads and writes go directly to one database file. Rejected because SQLite
files do not merge: two agents writing to their own copy of the same
database file and then syncing produce a conflict that cannot be resolved
automatically, and a forgotten sync silently loses whichever side's updates
are not copied over. This is exactly the failure mode agentboard exists to
avoid.
