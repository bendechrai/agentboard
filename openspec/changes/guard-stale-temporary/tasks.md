# Tasks

Independent of `add-claim-leases`: that change modifies board-concurrency
"Re-import is idempotent" only, and this change modifies "Moving a board
into the host repository loses no event" only, so either may be archived
first. Group 1 builds on PR #99 (ticket 01M5VA1B0XK4HRGCSXQ7BTVNB6), which
keeps the two git directories of the existing "temporary left by a move of
a different .board" test on different inodes; cut its branch from
`origin/staging` after PR #99 is merged.

Every group is delivered by a test author, an implementer and a reviewer
in turn (see CONTRIBUTING.md), on one branch per group cut from
`origin/staging`; the test author's first commit defines any new
internal API as stubs. Verification for every task includes `make check`,
`make check-floor` and `make check-git-floor` passing (the change is under
`src/board/` and runs git) with coverage at or above 90 percent. Group 1
is concurrency-critical (it decides whether another board's events reach a
shared ref): the orchestrator runs a second reviewer on the strongest
model.

Inode reuse is never left to the file system in a test: a test makes a
temporary's identity match a replacement board by rewriting the
temporary's `agentboard-source` to the replacement's `boardGitDir`
identity (`<realpath>:<dev>:<ino>` of its git directory), the
reproduction used in the PR #99 investigation, so it fails the same way
on tmpfs, ext4 and every CI runner. A temporary of 0.2.0 is made by
removing `agentboard-source-head` from one made by the current code, and
one of older code by removing both records.

No git command runs between the two record writes, so a kill there
cannot be made with a git shim: a test builds the temporary a kill would
leave (HEAD at `refs/agentboard/migrating`) with no record, with
`agentboard-source` only, with a torn or unreadable
`agentboard-source-head`, and with both. That a temporary adopted by a
run a replay conflict interrupted is judged by the full test on the next
run is observed by resetting the board's branch behind the HEAD the
adoption recorded while its remote still has it: the identity matches
and the integrated tip is still in the source tip, so only the recorded
HEAD refuses it.

## 1. Adoption guarded by the recorded HEAD (`board/guard-stale-temporary`)

- [ ] 1.1 Record the step-1 HEAD in every temporary: right after `worktree add` in step 3, after `agentboard-source`, write `agentboard-source-head` (the full object name of `MovePlan.head` and a newline) into the temporary's git directory; when a temporary is adopted, write whichever of the two records it lacks (`agentboard-source` with the current identity, as today, and `agentboard-source-head` with this run's `MovePlan.head`). Verify: a test that a move stopped on a conflict leaves a temporary whose `agentboard-source-head` equals the standalone board's HEAD at the start of that move and whose `agentboard-source` is unchanged in format; tests that a 0.2.0 temporary and a record-less temporary, once adopted, carry both records with the adopting run's identity and HEAD, and that a run interrupted after that adoption (a replay conflict) judges the temporary by the full test on its next run; a test that a temporary killed between the two writes (HEAD still at `refs/agentboard/migrating`) is removed as a plain leftover without its records being read
- [ ] 1.2 Judge belonging by the table in design.md "Temporaries of earlier versions": with both records, the identity equal to `boardGitDir` (checked first; no git command runs when it differs) and the recorded HEAD an ancestor of, or equal to, `MovePlan.head` in `.board`; with the identity only, the identity equal and the value of `refs/agentboard/migrating` an ancestor of, or equal to, `MovePlan.sourceTip`; with no identity record, the round 5 ruling 5 check unchanged. A recorded HEAD that is missing from the board's repository, not a full hexadecimal object name, or unreadable counts as not an ancestor. The same judgement drives the adoption and the wording of the `sync-in-progress` refusal. Verify: tests for every new scenario of board-concurrency "Moving a board into the host repository loses no event" (inode reuse with and without rebase state, rewritten history, a board that only grew, a 0.2.0 temporary on this board and on a replaced board with the identity rewritten to match); tests that a malformed and an empty `agentboard-source-head` make the temporary not adoptable; the existing round 4 ruling 3 and round 5 ruling 5 tests unchanged and passing; and a mutant check recorded in the PR (dropping the ancestry test makes the inode-reuse tests fail with the old board's events in `refs/agentboard/board`; comparing with the fresh source tip instead of HEAD makes the rewritten-history test of a board with a remote, its branch reset behind the recorded HEAD that its remote still has, fail; without a remote the source tip is the branch, so the no-remote scenario cannot tell the two apart)
- [ ] 1.3 Word the two places that name a temporary of another board as design.md "Reporting" says: the move's output line `removed <path>, left by a move of another board (not the one at <dir>, or one whose history no longer holds where that move began), so nothing of it was adopted`, and the parenthesis of the `sync-in-progress` refusal for such a temporary; exit codes, reasons, hints and the `--json` document are unchanged. Verify: tests asserting both texts in the output and in the `--json` error document's message, and that the refusal's reason and hint equal those of the existing `sync-in-progress` refusal

## 2. Documentation (`docs/guard-stale-temporary`)

- [ ] 2.1 Update README.md ("Moving a board into the host repository": the sentence saying a worktree left by a move of a replaced board is never adopted now says that this holds even when the replacement's git directory reuses the old one's inode, and that a board whose history was rewritten since counts as another board) and STATUS.md (what exists; no known gap left for this ticket). Verify: `make ascii`, `make validate-specs`, and the README text matching the board-concurrency requirement and the messages of task 1.3
