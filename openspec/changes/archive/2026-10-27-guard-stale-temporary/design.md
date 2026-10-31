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

The records of a fresh temporary (these two and `agentboard-source-tip`
below) are written before anything is integrated in it (the rebase of
step 3 comes after), so a kill between or during the writes leaves a temporary whose HEAD is still at
`refs/agentboard/migrating`. Such a temporary holds nothing and is
removed as a plain leftover without its records being read; a torn
record is never judged.

### Record the tip the temporary integrated

A third file, `agentboard-source-tip`, holds the full object name of the
source tip the temporary has integrated and a newline: the value
`refs/agentboard/migrating` is set to for it. It is written right after
`agentboard-source-head` (the temporary is checked out at that value, so
the record names what it holds), rewritten whenever the move advances
`refs/agentboard/migrating` for this temporary (after a replay of what
reached the board since, round 4 ruling 1), and written on adoption when
the temporary lacks it, with the value of `refs/agentboard/migrating`
that the temporary was judged by (see "Temporaries of earlier
versions"). It is read and judged well formed by the same rules as the
HEAD record below.

The record exists because `refs/agentboard/migrating` is one ref for the
whole host, not a fact of one temporary (review round 2, reviewer-gst-2
R1). A temporary whose pid is alive is skipped by every pass of a run,
so a run can make its own temporary and overwrite the ref while an older
temporary of another board, or of an older history, still exists; once
that older temporary's pid is dead, a later run would judge it against
the newer temporary's tip. The per-temporary record makes test 3 a fact
recorded with the temporary, as tests 1 and 2 are.

Every write of `agentboard-source`, `agentboard-source-head` and
`agentboard-source-tip`, right after `worktree add`, when the tip
advances, and when an adopted temporary gains the records it lacks, is
atomic: the content goes to a temporary file in the
same git directory, which is then renamed onto the record's name, so a
reader sees the old state or the whole new record, never an empty or
partial one. This matters on adoption, where the temporary has already
integrated something: a kill in the middle of a truncating write there
would leave an empty `agentboard-source-head`, which the next run would
judge malformed and remove the temporary, with the human's resolution,
as another board's. A leftover temporary file of an interrupted write is
not a record and is never read as one.

### Adopt only on the same git directory and the same history

A dead temporary with no rebase or cherry-pick state that integrated
something is adopted when, in this order:

1. its `agentboard-source` equals the current `boardGitDir` (unchanged,
   and the cheap check: no git command runs when it differs), and
2. its `agentboard-source-head` names a commit that is an ancestor of, or
   equal to, the HEAD of the repository at `.board`
   (`git merge-base --is-ancestor <recorded> <MovePlan.head>` run in
   `.board`), and
3. the tip it integrated, named by its `agentboard-source-tip`, is an
   ancestor of, or equal to, the board's source tip
   (`MovePlan.sourceTip`), the check the 0.2.0 row uses (for a temporary
   without that record, see "Temporaries of earlier versions").

Test 3 is needed because a temporary integrates the board's source tip,
the remote-tracking ref when the board has a remote, which step 1 lets be
ahead of HEAD, and test 2 says nothing about the commits between the
recorded HEAD and the integrated tip. Without test 3, a board whose
remote was force-reset past those commits after the move began, and a
replacement forked from the board at or after the recorded HEAD (with
the identity matching), would both have the commits only the temporary
holds published in `refs/agentboard/board` (review round 1,
reviewer-gst-2 counterexamples A and B). The board the move began from
passes test 3 while its remote only grows, as it passes test 2 while its
HEAD only grows; a board without a remote has its branch as source tip.

The ancestry test is step 6's, with the same reasoning: step 1 refuses a
board whose branch has commits its remote lacks, so the HEAD a move
records is in the remote's history; afterwards a standalone `sync` only
moves HEAD forward (it commits, and rebases unpushed commits onto a
remote tip that already contains the recorded HEAD). The board the move
began from therefore always passes, however many events it synced since,
while a board created at the same path (by `init`, `init --remote` or a
clone of an unrelated remote) does not, because its history never
contained that commit.

Any failure of tests 2 and 3 counts as "not an ancestor": a recorded commit
the board's repository does not have (the usual case for a replacement:
`merge-base` exits 128), a file whose content is not a full hexadecimal
object name of the board's hash algorithm, an unreadable file. An
`agentboard-source` that cannot be read (a directory, a permission
error) is judged the same way, as naming another board, never thrown as a
raw file error. When in
doubt the move does not adopt: a temporary wrongly removed costs a human
a conflict resolution they make again (no event of the board at `.board`
is lost, they are all still in `.board`), while one wrongly adopted
publishes another board's events in the host ref.

A recorded HEAD, and a recorded tip, is read as the file's content with at most one trailing
newline removed, and it is well formed only when that is exactly a full
lowercase hexadecimal object name of the board's hash algorithm (40
digits for SHA-1, 64 for SHA-256). Anything git would resolve otherwise
is malformed, and so not an ancestor, before any git command runs with
it: an abbreviated name, a ref name such as `HEAD` or `main`, a revision
expression such as `<name>^0`, and a second line. A well formed name the
board's repository does not have as a commit (missing, or a tree) fails
the ancestry test itself.

The same test decides the wording of the `sync-in-progress`
refusal for a temporary with rebase or cherry-pick state, so its text
says "another board" exactly when adoption would refuse it.

### A rewritten history is another board

A `.board` whose history no longer contains the recorded HEAD (a
`git reset` to an older commit, a rebase or filter of the standalone
board, a force-push pulled in) fails test 2 even though its git directory
is the same, and one whose remote was force-reset so that its source tip
no longer holds what the temporary integrated fails test 3. It is treated as another board, as step 6 already treats it:
the temporary was built on a history the board no longer has, and
replaying onto it what the board holds now could reintroduce commits the
human removed on purpose. The removal message says so (see "Reporting"),
so the user is not told the board was replaced when they only rewrote it.

A replacement that is a clone of the same board (`rm -rf .board`, then
`agentboard init --remote <the same remote>`), whose history contains the
recorded HEAD and whose git directory reuses the inode, passes every test
and is adopted. That is correct: the temporary holds the same board's
history, and adoption replays onto it what reached the board since, as it
does for the original repository. Without inode reuse the identity
differs and the temporary is removed as today; this change does not widen
adoption.

### Temporaries of earlier versions

The judgement depends on which records a temporary carries:

| `agentboard-source` | `agentboard-source-head` | belongs when |
| --- | --- | --- |
| present | present | identity equal, recorded HEAD an ancestor of, or equal to, the board's HEAD, and its integrated tip an ancestor of, or equal to, the board's source tip |
| present | missing (0.2.0) | identity equal (an unreadable record is not equal), and its integrated tip an ancestor of, or equal to, the board's source tip |
| missing (older code) | either | its integrated tip an ancestor of, or equal to, the board's source tip (round 5 ruling 5) |

Its integrated tip is what its `agentboard-source-tip` names; a present
but malformed or unreadable record fails the check. A temporary without
the record (made before this change: by 0.2.0, by older code, or by this
change's own earlier form) has only the shared `refs/agentboard/migrating`
to go by, and that ref is its integrated tip only when it is the only
temporary on the host: the run judges it against the ref when no other
entry, of any pid, alive or dead, registered or not, with or without
rebase state, is found under `<host git common dir>/agentboard/migrating/`
before the run removes any leftover; otherwise the temporary fails the
check and is not adopted.

An earlier form of this design held that the ref is always the judged
temporary's own, because "at most one dead, non-stopped temporary that
integrated something exists at a time". That is false: a temporary whose
pid is alive during a run is skipped by it, so that run makes its own
temporary and overwrites the ref, and the older temporary is dead and
judged at a later run (review round 2, reviewer-gst-2 R1: a temporary of
board A looking alive while a fork of A replaces `.board` and its move
loses the compare-and-swap; once A's pid is dead, A's temporary passed
every test against the fork's tip and published the events only A's
remote held). The property does hold when the temporary is the only one
on the host: nothing else has set the ref since it was made, because
every run that sets the ref leaves a temporary or removes it together
with the ref. A replacement board does not have the old board's source
tip in its history, so the stale temporary fails the check even when the
identity matches.

The board's source tip is `MovePlan.sourceTip` (the remote-tracking ref
of its branch when it has a remote, else the branch), as round 5 ruling 5
uses it. The 0.2.0 row could compare with HEAD instead, but the source
tip is what the integrated tip was taken from, and both rows without a
recorded HEAD then share one check.

A temporary of an earlier version is never refused for its format alone:
the user would have no way to tell the new code "this one is mine" short
of running the old version again. The one exception is the tip check
above, which it fails when another temporary exists, because its
integrated tip is then unknown; the user then resolves the conflict
again in a fresh temporary. When such a temporary is adopted, the run
writes the records it lacks (`agentboard-source` with the current
identity, as today, `agentboard-source-head` with `MovePlan.head` of the
adopting run, and `agentboard-source-tip` with the value of
`refs/agentboard/migrating` it was judged by), so a later run judges it
by the full test. The
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
