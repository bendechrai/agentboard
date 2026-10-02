# Design

## Context

See proposal.md for motivation and docs/adr/0001 for the decision that the
event log is the source of truth and SQLite is a cache. This document covers
how that is realized in a Node CLI with no server and no native dependencies.

Constraints: Node 22.16 or later (`node:sqlite` is available without a flag
from 22.13, but `DatabaseSync.isTransaction`, which the store relies on,
arrives in 22.16; the floor was raised from 22.13 during group 2 review); TypeScript strict; no `any`; vitest coverage
thresholds of 90 percent; plain ASCII in docs; the tool must work from any
git worktree of the host project and from a plain directory with no git at
all.

## Goals / Non-Goals

**Goals:**
- Correct under concurrent processes without any daemon or lock server.
- Correct after a crash at any point in a writing command.
- Correct across two machines that exchange `.board/` through git, never at
  the same time.
- Every guarantee stated as a test that spawns real child processes.
- A library surface (`src/index.ts`) so an MCP server or another tool can
  reuse the same operations.

**Non-Goals:**
- Multi-developer, simultaneous cross-machine editing (git handles the
  add-only merge, but conflicting human intent is out of scope).
- Compaction of the event log.
- A web UI. `list --json` is the integration point for any UI later.
- Storing secrets. The board refuses secret-looking text.

## Decisions

### Runtime: `node:sqlite` over `better-sqlite3`
`node:sqlite` is built into Node 22.13+, is synchronous (which a CLI wants:
one transaction per command, no event loop juggling) and needs no native
build step, so `npx @bendechrai/agentboard` works on a fresh machine with
nothing but Node. `better-sqlite3` is more mature but requires a compile or
prebuilt binary per platform and Node version, which is exactly the
friction OpenSpec avoids. Alternative considered: no SQLite at all, fold the
events on every command. Rejected: fine at 100 events, slow and awkward for
`list` filters and cursors at 10,000.

### Ids: hand-rolled ULID
Ticket ids are ULIDs (26 Crockford base32 characters, time-ordered,
monotonic within a process). A ULID implementation is about 40 lines; taking
a dependency for it adds supply-chain surface to a tool that runs in every
project's checkout. The implementation is tested against the spec's
monotonicity and encoding rules and against two published example values.

### Canonical JSON
Events are serialized with keys sorted at every level, no whitespace, UTF-8,
`JSON.stringify` number formatting (integers only are used in the schema;
floats are not permitted in event bodies and the canonicalizer rejects
them). This makes the SHA-256 name stable across implementations and makes
identical events dedupe by construction.

### Hybrid timestamp
`ts` is `{wall, counter, actor}`. On write, `wall` is `Date.now()` unless
the latest folded event's wall is greater or equal, in which case wall is
carried forward and counter increments. Fold order is `(wall, counter,
actor, hash)`, which is total. Cross-machine clock skew changes display
order only; correctness never depends on time because every state
transition is validated against the folded state at the event's position,
and rejected events stay in the log so a later fold with more events is
still a function of the log alone.

### Atomic event write
Write to `events/.tmp-<random>` in the same directory, `fsync` the file,
rename to `events/<hash>.json`, `fsync` the directory on POSIX. Rename is
atomic on the same filesystem, so a hash-named file is either absent or
complete. Readers ignore names beginning with `.tmp-`. A leftover temp file
older than one minute is removed by the next command and reported.

### One transaction per command, event file inside it
Order inside `BEGIN IMMEDIATE`: catch-up fold of unrecorded event files,
validate against current rows, build the event, write and rename the file,
apply to rows, insert into `folded`, commit. `BEGIN IMMEDIATE` takes the
write lock at the start, so validation and the write are serialized across
processes: the second of two racing claims sees the first one's row before
it validates. Crash story: if the process dies before the rename, nothing
happened; if it dies after the rename but before commit, the file exists
and the cache lacks it, and the next command's catch-up folds it. The
`folded` table is what makes catch-up cheap: list `events/`, fold anything
not in `folded`.

Alternative considered: write the row first and the file second. Rejected:
a crash after commit but before the file would leave the cache claiming an
event that does not exist in the source of truth.

### Cursors as position plus seen set
`inbox` cursors store the last fold position and the set of hashes seen at
or before that position within a bounded window (the events whose wall is
within the last hour of the cursor). A synced event with an earlier wall
than the cursor is detected because its hash is not in the seen set. An
event older than the window is caught where it becomes effective (arriving
late, or turned effective by a late event): the catch-up at the start of
any command, or `rebuild`, moves the cursor back to the greatest effective
event before it, so it is delivered. A catch-up does this silently;
`rebuild` also lists the late events it made effective in its report. This
keeps cursors small without ever silently skipping an event. See
docs/adr/0003.

### `watch`
`fs.watch` on `events/` with a 2 second polling fallback, because `fs.watch`
is unreliable on network filesystems and coalesces events on macOS. Each
tick runs the same catch-up fold as any command and prints new effective
events for the actor's cursor without advancing it (watch is a stream, not
an acknowledgement; the agent runs `inbox` to acknowledge).

### Git sync model
`.board/` is its own repository. `sync` stages only new event files and
`.board/.gitignore`, commits exactly those paths as the fixed identity
`agentboard <agentboard@localhost>` when anything is staged, then runs
`git pull --rebase` and `git push` (see docs/adr/0005). Event
files are add-only with content-derived names, so two clones can never
produce an add/add conflict with different content for the same path; the
only conflicts possible are on non-event paths, which `sync` refuses to
resolve and hands to a human with exit 3. The cache and its WAL files are
gitignored inside `.board`.

### Board discovery
`AGENTBOARD_DIR` first; then `git rev-parse --git-common-dir` resolved to an
absolute path, parent of that, `.board`; then `./.board`. The git common dir
is shared by every linked worktree, which is what makes agents in separate
worktrees see one board with no configuration.

### Library first, CLI second
Every operation is a function in `src/board/` taking a `Board` handle and
returning a result object. A single command registry (`src/cli/registry.ts`)
describes each command once: name, positional arguments, flags with types
and whether they are required, whether it writes, a one-line summary, and
the operation it calls. The CLI parser, the `mcp` tool definitions and (in a
later change) generated help all read the registry, so a flag added to one
surface is added to all of them. Tests exercise
the functions directly for logic and spawn the built CLI for the concurrency
and crash properties.

### Task reference is source-neutral
Tickets carry `task: {source, ref, item}` instead of OpenSpec-shaped
`change` and `group` fields. OpenSpec maps to `source: openspec`, `ref` the
change name and `item` the group number as a decimal string; Spec Kit would
map to `source: speckit`, `ref` the feature directory (`001-photo-albums`)
and `item` a phase or task id. Everything source-specific (finding the
tasks file, parsing it, pointing at a line) lives behind a source adapter,
and the schema only type-checks the three strings. Alternative considered:
keep `change`/`group` and add a Spec Kit shape later. Rejected: that is a
schema version bump plus a fold for both shapes forever, to save three
strings now. `--change --group` stays as CLI shorthand because OpenSpec is
the source this project uses daily.

### MCP server
`mcp` uses the official MCP TypeScript SDK over stdio rather than a
hand-rolled JSON-RPC loop: protocol conformance (initialization, capability
negotiation, schema publication) is the part most likely to be subtly
wrong, and the SDK is maintained alongside the spec. Tool input schemas are
generated from the command registry. Each call runs the same operation
function and the same `BEGIN IMMEDIATE` transaction as the CLI, so an agent
using MCP and another using the shell race safely. Errors map to tool
errors carrying the CLI exit code and rejection reason, never to protocol
errors, so the calling model sees why it was refused. `init`, `watch`,
`rebuild`, `sync` and `version` are excluded: they are human or
orchestrator operations and `watch` is a stream that does not fit a
request/response tool.

### Secret refusal
A small pattern list (PEM headers, AWS access key ids, GitHub `ghp_` and
`github_pat_` tokens, long base64 after `token|secret|password|key` and a
separator) is checked on free text before an event is written. It is a
guard rail, not a scanner; `--allow-secret-like` bypasses it.

## Interfaces (sketch; the test author's stubs are authoritative)

`tasks.md` names files and behaviors, not signatures. The test author for
each group defines the exported API as compile-only stubs with doc comments
in its first commit, and that commit is the API of record. The sketch below
covers group 1 only, to show the intended shape:

- `src/events/canonical.ts`: `encode(value): Uint8Array` producing sorted-key,
  whitespace-free JSON and rejecting floats; `decode(bytes): unknown`
  rejecting duplicate keys and non-canonical input; `hash(value): string`
  (hex SHA-256 of the encoding).
- `src/events/ulid.ts`: `newUlid(now?): string` with a monotonic generator;
  `parseUlid(s): { time: number } | null`; `isUlid(s): boolean`.
- `src/events/hlc.ts`: `next(prev, wallMs, actor): Hlc`; `compare(a, b): -1 | 0 | 1`;
  `encode`/`decode` for the wire form.
- `src/events/schema.ts`: the `Event` envelope type, one body type per kind,
  the `TaskRef` type (`{ source, ref, item }`) with `parseTaskRef(text)` and
  `formatTaskRef(ref)` for the `<source>:<ref>#<item>` form, and
  `validate(value): { ok: true; event: Event } | { ok: false; reasons: string[] }`.
- `src/events/fold.ts`: `fold(events: Event[]): { state: BoardState; rejected: Rejected[]; unknown: Event[] }`,
  deterministic in the input order.

## Risks / Trade-offs

- [Clock skew between machines reorders display] -> cosmetic only; state
  transitions are validated at fold time from the log, and rejected events
  are kept, so the fold is a pure function of the event set.
- [Two machines both comment before sync] -> both comments survive; order
  is by timestamp; no conflict.
- [`fs.watch` misses events on some filesystems] -> polling fallback every
  2 seconds; `inbox` is the authoritative path.
- [SQLite busy timeout too short under heavy contention] -> 5000 ms with
  `BEGIN IMMEDIATE`; the concurrency tests run 20 processes; if contention
  ever exceeds that, commands retry once and then exit 5 with a clear
  message rather than hang.
- [Leftover temp files from crashes] -> ignored by readers, reaped after one
  minute, reported.
- [Host project forgets `.board/` in its gitignore] -> `init` adds it; `sync`
  warns if the host repo tracks any path under `.board`.
- [Prefix ids collide as the board grows] -> prefixes must be at least 6
  characters and ambiguity is an error, never a guess.

## Migration Plan

Greenfield. `init` creates the board; there is nothing to migrate. Schema
version 1 is recorded in every event; a future version bump folds v1 events
unchanged.

## Open Questions

- Should tickets carry a required `role` field (test-author, implementer,
  reviewer) in addition to status, so a board can show which role a ticket
  is waiting on independently of who holds it? The status set already
  implies the role; deferring until a real board shows the need.
- Should `close-merged` work without `gh` by reading the host repository's
  merged commits for the PR number? Deferred: `gh` is present wherever the
  agents already open PRs.
