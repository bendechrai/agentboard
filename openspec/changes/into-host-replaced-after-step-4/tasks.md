# Tasks

This change modifies board-concurrency "Moving a board into the host
repository loses no event" only. The proposals written in parallel
(`actor-secret-check`, `mcp-unknown-resource`) are not expected to modify
that requirement; if one does, the change archived second rebases its
delta onto the first.

Every group is delivered by a test author, an implementer and a reviewer
in turn (see CONTRIBUTING.md), on one branch per group cut from
`origin/staging`; the test author's first commit defines any new internal
API as stubs. Verification for every task of group 1 includes `make
check`, `make check-floor` and `make check-git-floor` passing (the change
is under `src/board/` and runs git) with coverage at or above 90 percent.
Group 1 is concurrency- and crash-critical (it decides whether another
board's events reach a shared ref, across a kill): the orchestrator runs a
second reviewer on the strongest model.

How the tests make each state, so they fail the same way on every file
system and runner:

- A kill right after the step 4 update: `withKillingGitShim(env,
  COMMANDS.updateRef, 'after')`, as the existing test "killed after
  update-ref refs/agentboard/board (step 4 ...)" does. A kill after the
  record and before the swap: the same shim with `'before'`.
- A replacement board: `mv` the old `.board` aside and build an unrelated
  standalone board at the same path with another actor (no shared event
  file). Whether its git directory reuses the old inode does not matter to
  this rule; the guard-stale-temporary tests cover that.
- The step 6 refusal without a kill: a shim before the first git command
  after the step 4 update (or `withGitShimBefore` on the update itself,
  running the real command first) that moves `.board` aside and the
  replacement into place, as design.md "Reproduction" (run "step6") did.
- A temporary of 0.3.0: remove `agentboard-board-before` from one made by
  the current code.
- A ref moved past the temporary's HEAD: `commit-tree` on the HEAD's tree
  with the HEAD as parent, then `update-ref`, as the existing
  `loseCasAgain` helper does.
- A lost race on the reset: `withGitShimBefore` on
  `update-ref refs/agentboard/board <recorded>` moving the ref first.

## 1. Undo or refuse what an unfinished move of another board put in the host ref (`board/into-host-replaced-after-step-4`)

- [ ] 1.1 Record the ref's value before the swap: immediately before the step 4 compare-and-swap, for a fresh and for an adopted temporary, write `agentboard-board-before` (the full object name of `<old>` and a newline, or the zero object name of the board's hash algorithm when the ref does not exist) into the temporary's git directory with the atomic `writeRecord`; read it with the HEAD record's well-formedness rules. Verify: tests that a move killed right after the update leaves the record equal to the ref's value before the move (the zero object name for a host without the ref, the earlier commit for a host with a local ref fetched by hand); that an adopted temporary's record is rewritten with the `<old>` of the run that swaps; and that a write simulated as torn never leaves a partial record under the record's name (the guard-stale-temporary torn-write shim)
- [ ] 1.2 Judge, before any leftover is removed or adopted, every dead temporary without rebase or cherry-pick state whose HEAD is an ancestor of, or equal to, the local `refs/agentboard/board`, plain leftovers included, with `belongsToBoard` and the same `entriesBefore` fallback; for one that is not this board's, with the ref equal to its HEAD and a well formed record, reset the ref with `update-ref refs/agentboard/board <recorded> <HEAD>`, add the output line design.md "Judge every dead temporary" words, re-judge the rest against the new value, and let today's rules remove and name the temporary. Verify: tests for the scenarios "Board replaced after the move updated the host ref", "Board replaced after a move that joined the host remote updated the host ref", "Board replaced after the move refused at the rename", "Move killed after it updated the host ref resumes with the same board" (both forms) and "Killed before the host ref was updated", each asserting the event files of `.board/events`, of every commit of the local and the remote `refs/agentboard/board`, and the output line (present, absent); the existing test "a local refs/agentboard/board in the host (fetched by hand) is integrated" unchanged and passing; a test that a hand-fetched local ref beside a dead temporary of another board whose HEAD is not in it is integrated and not reset; and a mutant check recorded in the PR (skipping plain leftovers makes "Board replaced after the move updated the host ref" fail with A's events in the remote ref; skipping `belongsToBoard` and resetting for every candidate makes the same-board resume of the joined form fail; resetting without the compare-and-swap makes the race test of 1.3 fail)
- [ ] 1.3 Refuse when the ref cannot be set back: a temporary that is not this board's whose HEAD is in the ref with no well formed `agentboard-board-before`, or with the ref moved past its HEAD, is `BoardError(3, 'sync-failed')` naming `refs/agentboard/board`, the temporary's path and the `git update-ref` remedy of design.md, before anything is removed; a lost compare-and-swap of the reset is the same refusal saying the ref moved meanwhile. Verify: tests for the scenarios "Temporary that updated the host ref without recording its value before" (including the run after `git update-ref -d` by hand moving B without A's events), "Host ref moved past a temporary of another board" and "Reset of the host ref loses a race", each asserting exit 3, reason `sync-failed`, the existing hint, the text in the output and in the `--json` error document's message, and that the temporary, `.board`, the local ref and the host remote's ref are unchanged; tests that a missing, empty, malformed (abbreviated, upper case, second line, a ref name) and unreadable record each refuse
- [ ] 1.4 Run the kill matrix once more with the new record: the existing into-host CLI kill tests (every step) and the guard-stale-temporary tests pass unchanged. Verify: `src/cli/__tests__/into-host-cli.test.ts` and `src/board/__tests__/into-host.test.ts` each run 5 times under load all green, recorded in the PR with the counts

## 2. Documentation (`docs/into-host-replaced-after-step-4`)

- [ ] 2.1 Update README.md ("Moving a board into the host repository": a move interrupted after it updated `refs/agentboard/board`, re-run with another board at `.board`, sets the ref back and moves the new board without the old one's events, or refuses with the remedy when it cannot) and STATUS.md (what exists; ticket 01M5XYG0VT09DBAW7PZJK1CZ5Y no longer a known gap). Verify: `make ascii`, `make validate-specs`, and the README text matching the board-concurrency requirement and the messages of tasks 1.2 and 1.3 as `src/board/into-host.ts` prints them
