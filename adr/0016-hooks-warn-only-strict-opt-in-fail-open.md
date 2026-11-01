# 16. Harness hooks are warn-only by default, strict by opt-in, and fail open

Date: 2026-10-31

## Status

Accepted.

## Context

`add-harness-integration` gives a coding harness (Claude Code first) three
hooks that call `agentboard hook <event>`: `session-start` delivers the
actor's inbox and held tickets, `stop` notices a held ticket with no
hand-off, and `pre-tool-use` notices an edit of a project file while the
actor holds no ticket. The harness reads the answer from the exit code:
0 continues (with optional JSON context on stdout), 2 blocks the agent
with the reason on stderr.

The hooks run inside the agent's own loop, on every stop and on every
edit. A hook that blocks wrongly, or waits, stops the agent's work; a
board is a coordination aid, not a gate on editing files. The board may
also be unavailable for ordinary reasons: the project has no board, the
cache is being rebuilt or is held by another process, the cache was made
by another agentboard version, no actor is set, or the harness sent a
payload shape the command does not know. Several of these are the
normal state in a project that has installed the hooks but is between
tickets, or in a worktree whose agent has not set `AGENTBOARD_ACTOR`.

## Decision

- **Warn-only by default.** `agents install --target claude-hooks` writes
  the hooks without `--strict`. In warn mode a hook never exits 2: it
  gives the agent context (`session-start`, `pre-tool-use`) or the user a
  `systemMessage` (`stop`) naming the commands to run, and the agent
  carries on. A `pre-tool-use` warning is rate limited to once per 10
  minutes per session, tracked outside the board.
- **Strict is an explicit opt-in.** `agents install --target claude-hooks
  --hooks-strict` appends `--strict` to the three commands, and only then
  may `stop` and `pre-tool-use` exit 2, for exactly the reasons the
  board-harness-hooks requirements name. Even in strict mode a `stop`
  is blocked only when its payload has `stop_hook_active` exactly
  `false`; true, missing or a payload the hook cannot read never blocks,
  so one stop produces at most one block. Reinstalling in the other mode
  updates the owned entries without `--force`.
- **Fail open, read-only, bounded.** A failure of the hook itself never
  blocks: it is exit 0 (or the strict exit 2 the event had already
  decided) with nothing on stdout, at most one line on stderr and never a
  stack trace. That covers no board, a missing, locked, unreadable or
  other-version cache, no resolvable actor, a payload that is not a JSON
  object or is larger than 1 MiB, an error in the command's own
  arguments, a process directory removed under the process, a stdout or stderr that is closed or failing
  (a broken pipe, a full device), an internal error, and the 2 second
  budget running out. The budget is measured from the start of the
  process and covers everything the command does: Node's start-up, board
  discovery (whose `git` child is bounded by the time left and counts as
  failing when it does not answer, so discovery falls back to `./.board`),
  the stdin read, the cache read and the event's own work (checked
  between event-file reads and before the one write, which takes the
  write lock in a single attempt bounded by the time left), so the
  settings `timeout` of 5 seconds is not normally reached. The command
  is the one exception to board-cli "Exit codes": it exits 0 or 2 only,
  and never the usual 1 to 5. It reads the cache as it is, through an inspect-only open that never
  creates, migrates or rebuilds it, and never catches up: it folds no
  event file, writes no due grant and reaps no temporary file. The only
  state it may write is the actor's inbox cursor in `session-start`. It
  never claims, renews, releases, queues or unqueues, never runs `sync`
  and never touches the network. The actor comes from `--as` or
  `AGENTBOARD_ACTOR` only, never from the OS user or the payload, and a
  name a writing command could not use counts as no actor and is never
  repeated; no stderr line names the payload's `cwd` or the actor.
  `AGENTBOARD_HOOKS=off` disables every hook at once, before stdin, the
  arguments or the board are read.

## Consequences

- A team can install the hooks on day one without changing what its
  agents are allowed to do; the hooks start as reminders. A project that
  wants the board to be a gate turns strict mode on deliberately, and
  can turn it off again, or set `AGENTBOARD_HOOKS=off` for one session,
  without uninstalling.
- Because a hook never blocks for its own failure, a broken or absent
  board is invisible to the agent rather than a reason it cannot edit.
  The price is that strict mode is only as strong as the board's
  availability: a locked or stale cache lets an edit through that a
  readable board would have denied. The design accepts this; the board
  is a coordination aid.
- The hook is a reader with no catch-up, so what it reports can lag the
  event files by one command: a grant that is due but not yet written is
  delivered by the next `inbox`, not by `session-start`, and a lapsed
  lease is still "held" until another actor takes the ticket over, as
  the lease rules already define. In exchange the hook never takes the
  write lock and never competes with the commands doing the work.
- The fail-open rule shapes the tests: every scenario of the protocol
  asserts exit 0 and no stdout for a failure, byte-identical event files,
  cache and cursors after `stop` and `pre-tool-use`, and that no stderr
  line repeats any input, including a token-shaped event name or actor.
- The 2 second internal budget and the inspect-only open mean the cache's
  usual 5 second busy timeout is capped at what is left of the budget;
  `openCache` gained a `busyTimeoutMs` option for inspect-only opens to
  make that possible without changing the ordinary open, and
  `locateBoard` a `timeoutMs` option that bounds its `git` child the same
  way.
- Known limit: `stop` reads, for a ticket the actor commented on, the
  applied events after that comment and at or before the ticket's last
  update, to see whether it became the actor's again. A ticket updated
  long after the actor's comment, with many unrelated events between,
  can still spend the budget; `stop` then fails open with the
  out-of-time line and exit 0, and the reminder (or the strict block) is
  lost for that stop. An index of the ticket per folded event in the
  cache would remove the limit and is left for a later change.
- Known limit: the inspect-only open is a read-write connection, as
  `rebuild --check` opens the cache (a read-only connection leaves empty
  `-wal` and `-shm` files behind on a clean cache). After an unclean
  shutdown that left a non-empty write-ahead log, the hook's connection
  is the last to close and checkpoints that log into `cache.sqlite`: the
  cache's content is unchanged, its bytes and modification time are not.
  The read-only guarantee is therefore literal for a cleanly closed
  cache, which every scenario assumes; a crash recovery is the one write
  the hook can cause, and it writes nothing of its own.
