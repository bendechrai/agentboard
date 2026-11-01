# Proposal

## Why

`agentboard init --into-host` moves a standalone `.board` into the host
repository through a temporary worktree. Step 4 of the move updates the
local `refs/agentboard/board` with the temporary's HEAD (the board's
history, rebased onto any board ref the host already had); step 6 renames
the old repository aside and moves the temporary into place; step 7's
`sync` publishes the ref. A move that stops between step 4 and step 6 (a
kill, or the step 6 refusal when `.board` was replaced meanwhile) leaves
the board's commits in the local ref, unpublished.

If `.board` is then replaced by a different standalone board B and the
move is run again, step 3 of the re-run integrates the local ref (the
requirement integrates "every commit of any `refs/agentboard/board`
already in the host repository") and step 7 publishes it: the first
board's events become part of B's board and of the host's remote. The
guard-stale-temporary checks do not prevent it. They decide what happens
to the leftover temporary, not to the ref it already wrote: in a host
whose remote had no board ref the temporary integrated nothing beyond its
source, so it is removed as a plain leftover without being judged; when it
joined the remote's board ref it is judged, removed and named "left by a
move of another board ... so nothing of it was adopted", and its events
are published all the same. Both were reproduced with the 0.3.0 CLI
(design.md "Reproduction").

This was reviewer-gst-2's observation 6 in the archived
`guard-stale-temporary` change, ticket 01M5XYG0VT09DBAW7PZJK1CZ5Y.

## What Changes

- Every move records, in its temporary worktree and immediately before
  the compare-and-swap of step 4, the value `refs/agentboard/board` had
  before the swap (the zero object name when it did not exist), in a new
  record `agentboard-board-before`.
- Before any leftover is removed or adopted, a dead temporary without
  rebase or cherry-pick state whose HEAD is in the local
  `refs/agentboard/board` is judged by the adoption tests of
  guard-stale-temporary, whether or not it integrated something. When it
  is this board's, nothing changes: the legitimate re-run (same board,
  killed after step 4) completes as today.
- When it is not this board's and the ref still equals its HEAD, the move
  sets the ref back to the recorded value (or deletes it) with a
  compare-and-swap, says so, removes and names the temporary as today, and
  moves the board at `.board` without any commit of the other board.
- When it is not this board's and the ref cannot be set back safely (no
  record, as from 0.3.0 and earlier; or the ref has moved past that HEAD),
  the move refuses with exit 3 `sync-failed` (its existing hint), naming
  the ref, the temporary and how to reset the ref by hand, and changes
  nothing.
- A local ref that holds no such temporary's HEAD (fetched by hand, or
  left by anything other than an unfinished move) is integrated as today.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `board-concurrency`: "Moving a board into the host repository loses no
  event" gains the record of the ref's value before the swap, the
  judgement of a temporary whose HEAD is in the local ref, the reset and
  the refusal, with eight scenarios. No other requirement changes.

## Impact

- `src/board/into-host.ts`: the record written before the step 4
  compare-and-swap (fresh and adopted temporaries), a new pass in the
  leftover handling of `lockedMove` before `removeDeadMigratingWorktrees`,
  the output line of a reset and the refusal's message.
- `src/board/__tests__/into-host.test.ts` and
  `src/cli/__tests__/into-host-cli.test.ts`: the scenarios, with the
  existing killing git shim.
- README.md ("Moving a board into the host repository") and STATUS.md.
- No new command, flag, exit code, reason, hint or JSON field. The
  temporary's git directory gains one record file; board-cli is unchanged
  (it defers the move's exit 3 refusals to board-concurrency).
- This change modifies board-concurrency only. The proposals written in
  parallel (`actor-secret-check`, `mcp-unknown-resource`) are not expected
  to touch that capability; if one does, the second to be archived
  rebases its delta onto the first.
