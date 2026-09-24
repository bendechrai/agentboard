# 2. One transaction per command, event file inside it

Date: 2026-09-24

## Status

Accepted

## Context

ADR 0001 makes the append-only event log under `.board/events/` the source
of truth and a SQLite cache (`.board/cache.sqlite`) a disposable read cache
derived from it. Every writing command therefore touches two stores: it
writes a new event file and it updates the cache rows. Several agents run
commands against one board at the same time, as separate processes with no
daemon or lock server, and any of them can be killed at any point.

Two things must hold regardless:

- Validation and the write must be serialized. Ten agents racing to `claim`
  one ticket must produce exactly one winner, which means the second
  claimant must see the first one's claim before it decides.
- A crash between the two writes must never leave the cache claiming
  something the event log does not contain, and must never need a human to
  repair it.

## Decision

Every writing command runs as one SQLite transaction opened with
`BEGIN IMMEDIATE`, and the event file is written inside it. In order:

1. Catch-up: fold every event file not yet recorded in the `folded` table
   (files written by other processes, synced from another machine, or left
   by a command that crashed after its rename), and reap temporary files
   older than one minute.
2. Validate the requested action against the caught-up state, using the
   fold's own rules (state machine, assignment, existence, checklist range,
   task link) rather than a restatement of them.
3. Build the event with a hybrid timestamp later than every folded event.
4. Write the event file atomically: temporary file in `events/`, fsync,
   rename to `<sha256>.json`, fsync the directory.
5. Apply the event to the cache rows and record it in `folded`.
6. Commit.

A refusal in steps 2 or 3 rolls back before anything is written, not even
a temporary file. The cache connection uses WAL mode and a busy timeout of
5000 ms, so a writer waits for a concurrent writer instead of failing; if
`BEGIN IMMEDIATE` is still busy after the timeout it is retried once, and a
second failure exits 5 with a clear message rather than hanging.

Read-only commands run the same catch-up, but take the write lock only when
there is something to fold or reap; otherwise they read one snapshot
without blocking or being blocked by writers. `rebuild` and `rebuild
--check` are the exceptions: they do not catch up first, because `rebuild`
refolds every file itself and `--check` must compare the live cache exactly
as it is.

## Rationale

`BEGIN IMMEDIATE` takes SQLite's write lock at the start of the
transaction, not at the first write, so the catch-up, the validation and
the write happen under one lock held across processes. The loser of a claim
race blocks on the lock, then its catch-up folds the winner's event, and
its validation refuses with `already-assigned`. The concurrency tests race
ten claims and twenty comments as real child processes and require exactly
one winner and no lost comment.

Writing the file before the commit makes every crash recoverable by the
normal path:

- killed before the rename: no hash-named file exists and the transaction
  never committed, so nothing happened (a leftover temporary file is
  ignored by readers and reaped later);
- killed after the rename but before the commit: the file exists and the
  cache lacks it, which is exactly the situation catch-up handles, so the
  next command folds it as if the first had completed.

The `folded` table is what makes catch-up cheap: list `events/`, fold what
is not recorded. Because the new event's timestamp sorts after everything
already folded, a command's own event never forces a refold.

## Consequences

- Writers are serialized per board. Throughput is bounded by one
  transaction at a time, which is ample for a handful of agents and was
  tested with twenty concurrent processes.
- The store relies on `DatabaseSync.isTransaction` to tell whether a
  caller already holds the transaction, which is why the Node floor is
  22.16 rather than 22.13 (where `node:sqlite` is unflagged).
- A command can be refused with exit 5 when an event file with its exact
  name already exists but was not recorded, or holds other bytes; that is
  an integrity problem, not a race, since the new event sorts after every
  folded one.
- Every command pays for a directory listing of `events/` at start-up.
  This grows with the log (compaction is out of scope, see ADR 0001).

## Alternatives considered

**Write the cache row first, then the event file.** Rejected: a crash
after the commit but before the file leaves the cache claiming an event
that does not exist in the source of truth, and the next rebuild silently
loses it.

**Write the event file with no transaction, and fold later.** Rejected:
validation would run against a state that another process may already have
changed, so two racing claims could both be written as accepted; the fold
would reject one of them later, after its agent had already started work.

**A lock file or lock server.** Rejected: SQLite already provides a
cross-process write lock with a busy timeout, and a lock file left by a
killed process needs stale-lock detection that SQLite handles for us.
