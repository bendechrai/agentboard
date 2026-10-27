# Design

## Context

`init --into-host` (`src/board/into-host.ts`, design.md decision 9 of the
archived `add-board-sharing`) builds the host-model board in a temporary
worktree `<host git common dir>/agentboard/migrating/<pid>` checked out
from `refs/agentboard/migrating` (the source tip the temporary has
integrated). Right after `worktree add` it writes the file
`agentboard-source` into the temporary's own git directory: the identity
of the standalone repository's git directory as `boardGitDir` computes it,
`<realpath>:<dev>:<ino>`.

A later run, before step 2, sorts the leftovers of dead moves:

- one with a stopped rebase or a cherry-pick a human is in the middle of
  is the `sync-in-progress` refusal, and its text says whether the
  temporary belongs to this board;
- one that integrated nothing (HEAD at `refs/agentboard/migrating`, or
  not registered) is removed and named;
- one that integrated something is adopted when it belongs to the board
  at `.board` (`belongsToBoard`), else removed and named as "left by a
  move of another board". Belonging is the record equal to the current
  `boardGitDir` (round 4 ruling 3); with no record at all (code older
  than the record; round 5 ruling 5), the value of
  `refs/agentboard/migrating` being an ancestor of, or equal to, the
  board's source tip.

Released 0.2.0 writes `agentboard-source` with the identity only.

Step 6 re-checks the same identity immediately before the rename and also
that the HEAD step 1 saw (`MovePlan.head`) is an ancestor of, or equal
to, the board's HEAD (round 3 ruling 6), "so a repository rebuilt at the
same path with another history is refused even on a file system that
reuses inode numbers". The adoption rule lacks that half. ext4 hands a
directory created after another was removed the freed inode almost every
time, so `rm -rf .board` followed by `agentboard init` or a clone at the
same path yields a matching identity, and a stale temporary of the old
board is adopted: its events go into `refs/agentboard/board` and the
move's `sync` publishes them.

Step 1 refuses a standalone board with no commit (exit 4 `unsynced`)
before the init lock is taken and before any leftover is looked at, so
every move that writes a record has a HEAD to record, and every run that
judges a leftover has a HEAD to compare with. A run that finds `.board`
missing and resumes a temporary (the "Resuming" path) has no board to
compare with and is not affected: nothing has replaced the old board.

## Goals / Non-Goals

Goals:

- A temporary made from a board other than the one at `.board` now is
  never adopted, whatever the file system does with inode numbers.
- The adoption test is the same test step 6 applies, so the two places
  that ask "is this still the board the move began from?" agree.
- A temporary left by 0.2.0 (identity record only) or by older code (no
  record) is still adopted when it is this board's, so an upgrade in the
  middle of an interrupted move never strands a human's resolution, and
  is never adopted when it is not.

Non-Goals:

- Step 6, plain `init`'s cleanup of leftovers on a host-model board, the
  resume of a move whose `.board` is missing, and the disposition of a
  temporary found to be another board's (removed and named, or the
  `sync-in-progress` refusal) are unchanged.
- Recovering the events or the resolution of a removed temporary of
  another board. They are another board's; its own kept repository or
  remote holds its events.
- No new exit code, reason, hint or JSON field.

## Decisions

### Record the step-1 HEAD beside the identity

Right after `worktree add`, the move writes a second file into the
temporary's git directory, `agentboard-source-head`, holding the full
object name of `MovePlan.head` (the standalone board's HEAD at step 1)
and a newline. `agentboard-source` keeps its content and format, written
first as today.

A second file rather than a second line in `agentboard-source`: 0.2.0
compares the whole content of `agentboard-source` with its identity, so a
two-line record would make a downgraded binary remove every temporary
made by the new code as another board's. With a separate file 0.2.0
still reads its own record unchanged (and stays exposed to inode reuse,
as it is today).

Both records are written before anything is integrated in the temporary
(the rebase of step 3 comes after), so a kill between or during the two
writes leaves a temporary whose HEAD is still at
`refs/agentboard/migrating`. Such a temporary holds nothing and is
removed as a plain leftover without its records being read; a torn
record is never judged.

### Adopt only on the same git directory and the same history

A dead temporary with no rebase or cherry-pick state that integrated
something is adopted when, in this order:

1. its `agentboard-source` equals the current `boardGitDir` (unchanged,
   and the cheap check: no git command runs when it differs), and
2. its `agentboard-source-head` names a commit that is an ancestor of, or
   equal to, the HEAD of the repository at `.board`
   (`git merge-base --is-ancestor <recorded> <MovePlan.head>` run in
   `.board`).

The ancestry test is step 6's, with the same reasoning: step 1 refuses a
board whose branch has commits its remote lacks, so the HEAD a move
records is in the remote's history; afterwards a standalone `sync` only
moves HEAD forward (it commits, and rebases unpushed commits onto a
remote tip that already contains the recorded HEAD). The board the move
began from therefore always passes, however many events it synced since,
while a board created at the same path (by `init`, `init --remote` or a
clone of an unrelated remote) does not, because its history never
contained that commit.

Any failure of the test counts as "not an ancestor": a recorded commit
the board's repository does not have (the usual case for a replacement:
`merge-base` exits 128), a file whose content is not a full hexadecimal
object name of the board's hash algorithm, an unreadable file. When in
doubt the move does not adopt: a temporary wrongly removed costs a human
a conflict resolution they make again (no event of the board at `.board`
is lost, they are all still in `.board`), while one wrongly adopted
publishes another board's events in the host ref.

The same two-part test decides the wording of the `sync-in-progress`
refusal for a temporary with rebase or cherry-pick state, so its text
says "another board" exactly when adoption would refuse it.

### A rewritten history is another board

A `.board` whose history no longer contains the recorded HEAD (a
`git reset` to an older commit, a rebase or filter of the standalone
board, a force-push pulled in) fails test 2 even though its git directory
is the same. It is treated as another board, as step 6 already treats it:
the temporary was built on a history the board no longer has, and
replaying onto it what the board holds now could reintroduce commits the
human removed on purpose. The removal message says so (see "Reporting"),
so the user is not told the board was replaced when they only rewrote it.

A replacement that is a clone of the same board (`rm -rf .board`, then
`agentboard init --remote <the same remote>`), whose history contains the
recorded HEAD and whose git directory reuses the inode, passes both tests
and is adopted. That is correct: the temporary holds the same board's
history, and adoption replays onto it what reached the board since, as it
does for the original repository. Without inode reuse the identity
differs and the temporary is removed as today; this change does not widen
adoption.

### Temporaries of earlier versions

The judgement depends on which records a temporary carries:

| `agentboard-source` | `agentboard-source-head` | belongs when |
| --- | --- | --- |
| present | present | identity equal, and recorded HEAD an ancestor of, or equal to, the board's HEAD |
| present | missing (0.2.0) | identity equal, and the value of `refs/agentboard/migrating` an ancestor of, or equal to, the board's source tip |
| missing (older code) | either | the value of `refs/agentboard/migrating` an ancestor of, or equal to, the board's source tip (round 5 ruling 5, unchanged) |

The 0.2.0 row reuses the history check that already judges a temporary
with no record. It is sound because the value of
`refs/agentboard/migrating` is the integrated tip of the one temporary
being judged: a run judges leftovers before it creates a temporary, and
every dead temporary without rebase state that integrated something is
then either adopted (no new temporary is made) or removed, while one with
rebase state stops the run with `sync-in-progress` before anything is
made. So at most one dead, non-stopped temporary that integrated
something exists at a time, and the ref is its own. A replacement board
does not have the old board's source tip in its history, so the stale
temporary fails the check even when the identity matches.

The board's source tip is `MovePlan.sourceTip` (the remote-tracking ref
of its branch when it has a remote, else the branch), as round 5 ruling 5
uses it. The 0.2.0 row could compare with HEAD instead, but the source
tip is what the integrated tip was taken from, and both rows without a
recorded HEAD then share one check.

A temporary of an earlier version is never refused for its format: the
user would have no way to tell the new code "this one is mine" short of
running the old version again. When such a temporary is adopted, the run
writes the records it lacks (`agentboard-source` with the current
identity, as today, and `agentboard-source-head` with `MovePlan.head` of
the adopting run), so a later run judges it by the full test. The
adopting run's HEAD is a correct record: the temporary has just been
shown to belong to this board, and later legitimate HEADs descend from
it.

### Reporting

Nothing new is a refusal. A temporary that is not this board's keeps
today's dispositions and names it:

- without rebase or cherry-pick state, removed, and the move's output
  line becomes `removed <path>, left by a move of another board (not the
  one at <dir>, or one whose history no longer holds where that move
  began), so nothing of it was adopted`;
- with such state, the `sync-in-progress` refusal (exit 3, its existing
  hint), whose parenthesis becomes `(that worktree was left by a move of
  another board, not the one at <dir> now or one whose history no longer
  holds where that move began, so finishing it moves nothing of this
  board)`.

The output does not say which test failed. The user's remedy is the same
in both cases (nothing to do: the move carries on with the board at
`.board`), and the identity is meaningless to them.

### No ADR

This refines a rule of the `add-board-sharing` design (decision 9, round
4 ruling 3) and aligns it with another rule of that design (round 3
ruling 6). It adds no architecture, so it is recorded here and in the
board-concurrency requirement, not in an ADR.

## Alternatives considered

- **HEAD ancestry only, dropping the identity.** Simpler, and it would
  also adopt the temporary for a same-board clone at a fresh inode. It
  widens adoption beyond what was ruled in round 4, and gives up a check
  that rejects most replacements without running git. Rejected; the
  identity stays as the first check.
- **The `refs/agentboard/migrating` history check for every temporary,
  with no new record.** It needs no format change and is what the 0.2.0
  row uses. Its soundness rests on an emergent property (the order in
  which leftovers are judged and temporaries made keeps the host-wide ref
  paired with one temporary), not on a fact recorded with the temporary,
  and it tests a different thing from step 6. Kept as the fallback for
  temporaries that cannot carry the record, not as the rule.
- **Record the root commit (or another fixed id) of the board.** Tells
  unrelated boards apart, but a rewritten history usually keeps its root
  and would be adopted, and it differs from step 6's test. Rejected.
- **Refuse, or remove, a temporary without a recorded HEAD.** Refusing
  leaves an upgraded user stuck with a resolution only an old binary can
  finish; removing discards that resolution. The history check is sound
  for these temporaries, so neither is needed.
- **Compare the recorded HEAD with the fresh source tip rather than
  HEAD.** Would accept a board whose local branch was reset behind the
  recorded commit as long as its remote still has it, which step 6
  refuses. Rejected for consistency with step 6.

## Risks / Trade-offs

- A user who rewrites the standalone board's history between an
  interrupted move and its re-run loses the temporary, including a
  conflict resolution they made there; they resolve it again. Step 6
  already refuses the same situation at the rename, so this is not a new
  limit, and no event of the board at `.board` is lost.
- One more `git merge-base` per adoptable candidate on a re-run that
  finds one. Negligible.
- The 0.2.0 fallback relies on the leftover invariant above. A test pins
  it (a 0.2.0-format temporary with a matching identity on a replaced
  board is removed), so a change to the order in which leftovers are
  judged that breaks it fails.
