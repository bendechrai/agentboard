# Design

## Context

`init --into-host` (`src/board/into-host.ts`, decision 9 of the archived
`add-board-sharing`, refined by `guard-stale-temporary`) runs, under the
init lock:

- the leftover pass: a stopped rebase or cherry-pick is the
  `sync-in-progress` refusal; a dead temporary that integrated nothing
  (HEAD equal to `refs/agentboard/migrating`) is removed as a plain
  leftover without being judged; one that integrated something is adopted
  when it is this board's (the identity record, the recorded step-1 HEAD
  and the recorded integrated tip, `belongsToBoard`), else removed and
  named as left by a move of another board;
- step 2, the fetch of the source tip into `refs/agentboard/migrating-fetch`;
- step 3, a fresh temporary (or the adopted one), `<old>` read as the
  value of the local `refs/agentboard/board`, the rebase onto the local
  ref when it is not an ancestor of HEAD, then the rebase onto the host
  remote's ref;
- step 4, `update-ref refs/agentboard/board <HEAD> <old>`, the host
  `.gitignore` entry;
- step 5, the carry-over of event files into the temporary;
- step 6, the check that `.board` is still the repository of step 1 (else
  exit 3 `sync-failed`, "replaced meanwhile", the temporary kept), the
  rename aside, `worktree move`, the deletion of the temporary refs;
- step 7, `sync`, which publishes `refs/agentboard/board`.

Between step 4 and step 6 the local ref holds the temporary's HEAD and
the temporary still exists under `<git common dir>/agentboard/migrating/`.
Nothing after step 4 changes the temporary's HEAD (step 5 only copies
untracked files), so a dead temporary whose HEAD equals the local ref is
the trace of a move that updated the ref and did not complete.

## Reproduction

Scratch boards under the session scratchpad, the CLI built from staging
`aeef737` (0.3.0, `npm run build`, `node dist/cli.js`), a `git` shim on
the PATH that runs the real `update-ref refs/agentboard/board <new> <old>`
and then kills its parent (the CLI process), the same kill the test
helper `withKillingGitShim(env, COMMANDS.updateRef, 'after')` makes. The
host has a bare `origin`; board A is a standalone board made with
`init --remote` holding two tickets; B is an unrelated standalone board
made the same way at the same path after `mv .board` aside, holding one
ticket.

| Run | Sequence | After run 1 | After the re-run |
| --- | --- | --- | --- |
| replaced | host remote without a board ref; kill after step 4; replace with B; re-run | local ref = A's tip (A's 2 events); host remote has no ref; temporary `migrating/<pid>` left, HEAD = `refs/agentboard/migrating` | exit 0 `moved`; temporary "removed ..., left by an interrupted move" (a plain leftover, never judged); local ref, host remote ref and `.board/events` hold A's 2 events and B's 1; `list` shows all three tickets |
| joined | another clone published a host-model board (1 event) to the host remote first; kill after step 4; replace with B; re-run | local ref = A rebased onto the remote's ref (3 events) | exit 0 `moved`; temporary "removed ..., left by a move of another board (...), so nothing of it was adopted"; local ref, host remote ref and `.board/events` hold the other clone's event, A's 2 and B's 1 |
| step6 | no kill: the shim replaces `.board` with B right after the step 4 update | exit 3 `sync-failed` "not the repository the move checked (it was replaced meanwhile) ... the temporary worktree ... is kept"; local ref = A's tip | as "replaced": A's events published with B's |
| same | kill after step 4; re-run with A unchanged | as "replaced" | exit 0 `moved`; the leftover removed, a fresh temporary from A's tip (the ref is an ancestor of it); A's 2 events, nothing else |

So the observation is a real leak into the shared ref, not a local
contamination waiting for a later sync: the re-run's own step 7 pushes it.
The guard-stale-temporary checks do not prevent it, because they decide
the fate of the temporary and never look at what its move already wrote
into the local ref. In the "joined" run the output even says nothing of
the temporary was adopted while its events are published. No kill is
needed either: the step 6 refusal leaves the same state.

## Goals / Non-Goals

Goals:

- No commit of a move of another board that updated the local ref and did
  not complete reaches the board now at `.board` or the host's remote.
- The legitimate resume is unchanged: the same board, killed or refused
  after step 4, completes on the re-run with what it put into the ref.
- A local ref that an unfinished move did not write (fetched by hand from
  another clone, which the requirement integrates on purpose and a test
  pins) is integrated as today.
- When the move cannot undo the update safely, it refuses before changing
  anything rather than guessing.

Non-Goals:

- A temporary removed by hand, or by a 0.3.0 run that already published
  its events: nothing traces the update any more.
- `.board` missing (the "Resuming" path) and plain `init`: no other board
  is at `.board`, so nothing is mixed into another board.
- Rolling the ref back inside the run that refuses at step 6 or step 5:
  the re-run handles it with the same rule as a kill, and the temporary
  may still be this board's (a transient refusal).
- Recovering the other board's events: step 1 of its move required every
  event committed, and pushed when it had a remote, so they are in its own
  repository or remote. The ref only held an unpublished copy.
- No new exit code, reason, hint or JSON field.

## Decisions

### Record the ref's value before the swap

Immediately before the compare-and-swap of step 4 the move writes
`agentboard-board-before` into the temporary's git directory: the full
object name of `<old>` (the value the swap compares against) and a
newline, or the zero object name of the board's hash algorithm when the
ref does not exist (git's own convention for "no ref";
`update-ref <ref> <zero> <value>` deletes the ref). It is written with
the atomic `writeRecord` of guard-stale-temporary, on every pass through
step 4: a fresh temporary and an adopted one (an adopted temporary's
record is rewritten with the `<old>` of the run that swaps). It is read
with the rules of the HEAD record: well formed only as exactly one full
lowercase hexadecimal object name of the board's algorithm with at most
one trailing newline; anything else, or an unreadable file, is "no
record".

Before the swap rather than after: a kill between a successful swap and
a later write would leave the update without its record, exactly the
case to undo. A kill between the write and the swap leaves a record and a
ref that does not hold the temporary's HEAD, which the rule below ignores
(scenario "Killed before the host ref was updated").

### Judge every dead temporary whose HEAD is in the local ref

In the leftover pass, after the stopped-temporary refusal and the quit of
an interrupted replay, and before `removeDeadMigratingWorktrees` and the
adoption loop, the move looks at every dead temporary without rebase or
cherry-pick state whose HEAD is an ancestor of, or equal to, the local
`refs/agentboard/board` (`merge-base --is-ancestor` in the host). Plain
leftovers are included: in a host whose remote has no board ref the
temporary of a killed move integrated nothing beyond its source tip and
would otherwise be removed without being judged (run "replaced").

Each is judged by `belongsToBoard`, the adoption test, with the same
`entriesBefore` fallback for a temporary without a tip record:

- **This board's.** Nothing new happens. The temporary is adopted or
  removed as a plain leftover by today's rules, and the ref's commits are
  this board's history: the step 3 integration finds them in, or
  rebases onto them, as it does today (run "same"; scenario "Move killed
  after it updated the host ref resumes with the same board").
- **Not this board's, the ref equal to its HEAD, a well formed
  `agentboard-board-before`.** The move runs
  `update-ref refs/agentboard/board <recorded> <HEAD>` (which deletes the
  ref when `<recorded>` is the zero object name), adds the output line
  `set refs/agentboard/board in the host repository back to its value
  before the interrupted move at <path>, which had updated it for another
  board and not published it` (`deleted refs/agentboard/board ... which
  had created it ...` when the value was the zero object name), and the
  temporary is removed and named by today's rules (as a plain leftover or
  as left by a move of another board). The remaining candidates are then
  judged against the new value of the ref, so a chain of such updates is
  undone in order or ends in the refusal below.
- **Not this board's, otherwise** (no well formed record, as from 0.3.0
  and earlier, or a ref that holds the HEAD but has moved past it):
  `BoardError(3, 'sync-failed')` whose message names
  `refs/agentboard/board`, the temporary's path, that the move put
  commits of another board into the ref and cannot set it back by itself,
  and how to do it by hand (`git update-ref -d refs/agentboard/board`
  when the host's remote holds the board or the ref did not exist before
  that move, else `git update-ref refs/agentboard/board <its earlier
  commit>`), then `agentboard init --into-host` again. Nothing changes:
  the refusal is taken before any leftover is removed, so the temporary
  stays as the evidence and the next run judges again. The hint is the
  existing `sync-failed` hint.

A lost compare-and-swap of the reset (something moved the ref after it
was read) is the step 4 refusal's twin: exit 3 `sync-failed` saying the
ref moved meanwhile and to run again, nothing removed.

The rule runs under the init lock, after step 1, so the standalone board
at `.board` has a HEAD and a source tip to judge with, and nothing else
of agentboard writes the ref meanwhile.

### Why "HEAD equal to the ref" is evidence of the update

A temporary's HEAD is the board's history rebased onto the local and the
remote board refs. It is in the local ref only when step 4 put it there,
when a later step 4 that integrated it did (which requires adopting the
temporary, so it was this board's), or when the ref already held all of
it before the move (then the ref's content was there independently of
the move, and resetting to the recorded value, equal to the ref, changes
nothing). The record makes the reset exact: the ref returns to the value
it had when that move compared against it, and anything another writer
added since makes the ref differ from the HEAD and turns the reset into a
refusal, so a commit nobody can account for is never discarded silently.

### Reporting

The reset is an output line of an exit 0 move, beside the existing
"removed ..." lines; no JSON field. The refusal reuses `sync-failed` and
its hint, as the step 6 refusal does: board-cli lists the move's exit 3
reasons by deferring to board-concurrency, so no other capability
changes. The messages name board data (paths, the ref) and no refused
input, as the no-echo rule requires.

### No ADR

This extends the leftover rule of `add-board-sharing` decision 9 as
`guard-stale-temporary` did; it is recorded here and in the
board-concurrency requirement.

## Alternatives considered

- **Document it as accepted behaviour, with a test.** Rejected: the
  reproduction shows another board's events published to the shared ref,
  under a message saying nothing of that board was adopted, which the
  requirement ("none of its commits or events SHALL reach
  `refs/agentboard/board`") already forbids.
- **Refuse whenever the local ref holds commits that are neither in the
  board at `.board` nor on the host's remote.** Stateless and needs no
  record, but the requirement integrates a local ref fetched by hand from
  another clone on purpose (test "a local refs/agentboard/board in the
  host (fetched by hand) is integrated"), which this rule would refuse; it
  also cannot decide when the host's remote is unreachable. Rejected for
  evidence tied to the unfinished move.
- **Always refuse, never reset.** Simpler, but every user who replaced a
  half-moved board would have to run raw git on a ref they never touched.
  The record makes the reset exact and safe, so the refusal is kept only
  for the cases the move cannot undo.
- **Roll back to the host remote's ref instead of a recorded value.**
  Loses a hand-fetched local ref's commits and is undefined when the
  remote is unreachable. Rejected.
- **Move the step 4 update after the rename.** Would remove the window,
  but the ordering of steps 4 to 7 carries the crash-consistency rulings
  of `add-board-sharing` (round 3 rulings 2 and 6, ruling D); reopening
  them is out of proportion to the gap.
- **Undo the update in the run that refuses at step 6.** Covers only the
  refusal, not the kill, and the temporary may still be this board's.
  The re-run rule covers both.

## Risks / Trade-offs

- A dead temporary of another board killed before step 4 whose HEAD is
  nevertheless in the local ref (a ref fetched by hand that already held
  that board's whole history) has no record and makes the move refuse.
  It is exotic, and the refusal is recoverable by hand.
- One `merge-base --is-ancestor` per dead temporary per run, and one more
  record write per step 4. Negligible.
- A run of 0.3.0 or earlier after an upgrade-then-downgrade ignores the
  new record and keeps today's behaviour; the record does not change any
  file 0.3.0 reads.
