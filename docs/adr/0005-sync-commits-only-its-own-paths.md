# 5. Sync commits only its own paths, as a fixed identity

Date: 2026-09-24

## Status

Accepted

## Context

`.board/` is its own git repository so that board history moves between
machines without touching the host project (ADR 0001, and the board-events
spec). `agentboard sync` turns new event files into commits, pulls with
rebase and pushes. It runs unattended, from agents, on machines whose git
configuration it does not control: some have no `user.name` or
`user.email`, and a human may have left something staged in the board
repository.

The first design was `git add events`, `git commit`, `git pull --rebase`,
`git push`. Building and reviewing it (task group 6) found three ways
that could go wrong: `git add events` would stage deletions and temporary
files; a plain `git commit` would also commit whatever else happened to be
staged (a cache file if `.gitignore` were emptied, or a human's unrelated
edit); and committing as the user's identity fails on machines with none,
and puts a person's name on commits an agent made.

## Decision

`sync` stages only new files under `events/` (never temporary files, never
deletions) and `.board/.gitignore`, and limits its commit to exactly those
paths. It commits with the fixed identity
`agentboard <agentboard@localhost>`, never the user's git identity, and
only when something is staged.

Around that:

- Before staging, it checks that every event file in `HEAD`'s tree is
  still present; if any is missing it stages nothing and exits 5 with
  reason `integrity`, naming the files and how to restore them. A deletion
  is never committed.
- Content that someone else staged in the board repository is left staged
  and never committed. With a remote, it stops `sync` before the pull with
  exit 3, naming the paths and saying to commit or unstage them.
- It refuses to run over an in-progress rebase, merge or cherry-pick, or a
  detached HEAD (exit 3), and on a board that is not itself the top level
  of a git repository (exit 2).
- Any conflict leaves the rebase in place for a human and exits 3 naming
  the paths. A push rejected because the remote moved is retried once from
  the pull; a second rejection, or an unreachable remote, is exit 3.

## Rationale

Event files are add-only and named by the hash of their content, so two
clones can never produce different content at the same event path; the
only possible conflicts are on the few non-event paths, which a human
resolves. Restricting the commit to sync's own paths makes the cache and
its WAL and SHM files impossible to commit even when `.gitignore` is
damaged, and makes `sync` safe to run in a repository a human is also
using. A fixed identity makes commits work on any machine and makes board
commits recognizable as tool output in `git log`.

## Consequences

- `git log` in `.board` does not say which person or agent made a change;
  the event files do (every event records its actor).
- A human who wants to change a non-event file in `.board` commits it
  themselves; `sync` will not.
- Recovering a deleted event file is a manual `git checkout` or
  `git restore`, which the exit 5 message spells out.

## Alternatives considered

**Commit as the user's git identity.** Rejected: fails where no identity
is configured, which is common in containers and CI-like agent sandboxes,
and misattributes agent activity to a person.

**`git add -A` and commit everything.** Rejected: commits deletions,
temporary files and anything a human staged, which is how an event file
could disappear from every clone.
