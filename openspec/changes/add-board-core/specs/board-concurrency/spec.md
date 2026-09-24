# Spec Delta

## Purpose

States the guarantees a board gives when several processes write at once,
when a process dies mid-command, and when two machines exchange events over
git, in a form that tests can exercise with real child processes.

## ADDED Requirements

### Requirement: Claim race has exactly one winner
When N processes concurrently run `claim` on the same unassigned ticket, the
board SHALL end with exactly one assignee, exactly one process SHALL exit 0,
and every other process SHALL exit 4 with reason `already-assigned` naming
the winner. Exactly one `ticket.claim` event SHALL be folded as effective; any
others written SHALL be recorded as rejected, never deleted.

#### Scenario: Ten concurrent claims
- **WHEN** ten child processes run `claim T1 --as agent-<n>` started within the same millisecond
- **THEN** one exits 0, nine exit 4, `show T1` reports a single assignee, and `rebuild` reports at most nine rejected claim events

### Requirement: Concurrent comments are never lost
When N processes concurrently add one comment each to the same ticket, all N
comments SHALL be present after the commands return, in a deterministic
order, and the cache SHALL equal a fresh rebuild from the events.

#### Scenario: Twenty concurrent comments
- **WHEN** twenty child processes each run `comment T1 --as agent-<n> "c<n>"` concurrently
- **THEN** `show T1` lists twenty comments, and `rebuild --check` reports no divergence

### Requirement: Crash consistency
If a process is killed at any point during a writing command, the board SHALL
be left in a state from which the next command recovers without human
action: either the event file does not exist and nothing changed, or the
event file exists and the next command folds it. No partial event file SHALL
ever be visible under its final hash name.

#### Scenario: Killed after rename, before commit
- **WHEN** a child process is killed with SIGKILL immediately after its event file is renamed into place (the test injects a pause at that point)
- **THEN** `agentboard show` for that ticket reflects the event and `rebuild --check` reports no divergence

#### Scenario: Killed during temporary write
- **WHEN** a child process is killed while writing the temporary file
- **THEN** no file with a hash name was created, the ticket is unchanged, and the leftover temporary file is ignored by every command and reported and removed by the first command other than `rebuild --check` that runs once it is older than one minute

### Requirement: Inbox never misses an event
`inbox --as <actor>` SHALL return every effective event whose fold position
is after the actor's stored cursor, in fold order, and SHALL then advance the
cursor to the last returned event unless `--peek` is given. Events that
arrive between two inbox calls, including events synced from another
machine with earlier timestamps than the cursor, SHALL still be returned:
the cursor SHALL therefore be a set of seen hashes bounded by a position,
not a timestamp alone. Every effective event counts, including the actor's
own events and `board.meta` events; rejected, unknown and malformed events
never appear. An actor with no cursor receives every effective event.
`--since <hash>` starts after the named event and implies `--peek`. Whenever
an event becomes effective at a position behind an actor's cursor and
outside that cursor's seen window (because it arrived late, or because a
late event made a previously rejected event effective), the cursor SHALL be
moved back so the event is delivered; redelivering other events as a
consequence is permitted, skipping one is not.

#### Scenario: Late-arriving synced event
- **WHEN** an actor's cursor is at wall 2000 and `sync` brings in an event with wall 1500 from another machine
- **THEN** the next `inbox` for that actor returns the wall 1500 event

#### Scenario: Peek does not advance
- **WHEN** `inbox --peek` is run twice with no new events in between
- **THEN** both calls return the same events

### Requirement: Sync converges
`sync` SHALL commit any new event files in `.board`, pull with rebase from the
board's remote, and push. Because event files are add-only and named by
content, two clones that each added events SHALL merge without conflict, and
after both have synced, `rebuild` on each SHALL produce byte-identical
canonical dumps. If git reports a conflict on any path, `sync` SHALL stop,
leave the repository in the conflicted state for a human, and exit 3 naming
the paths. `sync` SHALL stage only new files under `events/` (never temporary
files, never deletions) and `.board/.gitignore`, so the cache and its WAL and
SHM files are never committed even if `.gitignore` is emptied. It SHALL
commit with the fixed identity `agentboard <agentboard@localhost>`, never the
user's git identity, and only when something is staged. When event files
that are recorded in the board's git history are missing from the working
tree, `sync` SHALL stage nothing and exit 5 with reason `integrity`, naming
the missing files and how to restore them. When the board directory is not
itself the top level of a git repository, `sync` SHALL exit 2. When the host
project's git repository tracks any path under `.board`, `sync` SHALL warn
on stderr (and in its JSON output) without failing. After pulling, `sync`
SHALL fold the arrived events and report them.

#### Scenario: Deleted event file is not synced
- **WHEN** a committed event file is deleted from `.board/events` and `sync` runs
- **THEN** nothing is staged or pushed and the command exits 5 naming the file

#### Scenario: Divergent clones converge
- **WHEN** clone A adds three events and clone B adds two events, both run `sync`, and A runs `sync` again
- **THEN** both clones contain all five event files and their rebuilt caches are identical

#### Scenario: Sync with no remote
- **WHEN** the board's git repository has no remote configured
- **THEN** `sync` commits local events, reports that no remote is configured, and exits 0

### Requirement: Re-import is idempotent
Running `import-change <name>` twice for the same change SHALL create no
duplicate tickets: tickets are keyed by their task reference (source, ref,
item) and a second import
SHALL update checklists for existing tickets by appending new lines only,
with one `ticket.checklist.add` event per ticket that gained lines. Existing
lines are matched by position and never edited or removed; a re-import never
changes a ticket's title, labels or status. `import-change` also accepts
`<source>:<ref>` so an unsupported source can be named.

#### Scenario: Second import adds nothing
- **WHEN** `import-change add-board-core` runs twice with an unchanged tasks file
- **THEN** the ticket count is unchanged and no new events are written
