# Proposal

## Why

`agentboard init --into-host` moves a standalone `.board` into the host
repository through a temporary worktree under
`<host git common dir>/agentboard/migrating/<pid>`. When a move is
interrupted after it integrated something (a conflict a human resolved, a
lost compare-and-swap, a kill), the next run adopts that temporary, but
only when it was made from the board at `.board` now: a temporary left by
a move of a board that was replaced since is never adopted (the
leftover-temporary rule of the `add-board-sharing` design, round 4 ruling
3). The temporary records the board it came from as the identity of the
board's git directory: its realpath, device and inode.

That identity does not tell two boards apart on a file system that reuses
inode numbers. On ext4 a replacement `.board/.git` created at the same
path after the old one was removed gets the freed inode almost every time
(50 times out of 50 in the investigation of PR #99), so the record
matches, the stale temporary is adopted, and the old board's events are
integrated into `refs/agentboard/board` and published with it by the
move's `sync`. That contradicts the design's "never adopted" and cannot
be undone without rewriting a shared ref. The flaky test that exposed it
(ticket 01M5VA1B0XK4HRGCSXQ7BTVNB6) was fixed in PR #99 by keeping the two
inodes apart; the production gap is ticket 01M5XPHX2V5DHQY0RB6M5JWRD6.

Step 6 of the move already guards the same case: before the rename it
checks the same identity and also that the HEAD step 1 saw is still an
ancestor of, or equal to, the board's HEAD (round 3 ruling 6), so a
repository rebuilt at the same path with another history is refused even
where inode numbers are reused. The adoption rule has no such guard.

## What Changes

- A temporary records, beside the git directory identity it records
  today, the HEAD commit of the standalone board at step 1 of the move
  that made it.
- A dead temporary that integrated something is adopted only when both
  hold: the recorded identity names the board's git directory now (the
  cheap first check, unchanged), and the recorded HEAD is an ancestor of,
  or equal to, the board's HEAD now (the step 6 test). A board replaced
  at the same path, whether or not its git directory reuses the old
  inode, and a board whose history was rewritten so that it no longer
  contains that HEAD, are another board: the temporary is removed and
  named (no rebase or cherry-pick state) or is the `sync-in-progress`
  refusal saying so (with such state), as today for a mismatched
  identity.
- Temporaries made by earlier versions stay resumable: one with an
  identity record and no recorded HEAD (written by 0.2.0) is this board's
  when the identity matches and the source tip it integrated
  (`refs/agentboard/migrating`) is in the board's history, the check that
  already applies to a temporary with no record at all; it is never
  refused for its format. An adopted temporary gains the full record.
- The removal line and the `sync-in-progress` text name a board whose
  history no longer contains the move's starting point as well as a
  replaced one.
- The leftover rule, which until now lived only in the design, is stated
  in board-concurrency "Moving a board into the host repository loses no
  event" with scenarios, including the inode-reuse case and the 0.2.0
  temporary.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `board-concurrency`: "Moving a board into the host repository loses no
  event" states when a leftover temporary is adopted (same git directory
  and same history), how temporaries of earlier versions are judged, and
  what happens to one that is not this board's.

## Impact

- `src/board/into-host.ts`: the record written after `worktree add` and
  on adoption, `belongsToBoard`, and the two messages that name a
  temporary of another board. Step 6, plain `init`'s cleanup of
  leftovers on a host-model board and the resume of a move whose `.board`
  is missing are unchanged.
- `src/board/__tests__/into-host.test.ts`: the inode-reuse case is made
  deterministic by rewriting a temporary's identity record to the
  replacement's identity, as the PR #99 investigation did.
- README.md ("Moving a board into the host repository", the sentence on
  worktrees of a replaced board) and STATUS.md.
- No new command, flag, exit code, reason or JSON field. The on-disk
  record gains one file in the temporary's git directory; 0.2.0 reading a
  temporary made by the new code still finds its own record unchanged.
