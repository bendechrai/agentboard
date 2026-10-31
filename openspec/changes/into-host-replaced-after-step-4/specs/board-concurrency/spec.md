## MODIFIED Requirements

### Requirement: Moving a board into the host repository loses no event
`agentboard init --into-host` SHALL move a standalone board into the host
model only when doing so cannot lose an event. Before changing anything it
SHALL refuse with exit 4 and reason `unsynced`, telling the user to run
`agentboard sync` first, when the standalone board has an event file that
is not committed (untracked or staged), or when the standalone board has a
remote and its branch has commits that the remote's branch does not
(checked after fetching that branch). It SHALL refuse with exit 3 as `sync`
does when a rebase or merge is in progress in the standalone board, when
its HEAD is detached, or when its remote cannot be reached; and with exit 5
reason `integrity` when committed event files are missing. When it
proceeds, the resulting `refs/agentboard/board` SHALL contain every commit
of the standalone board's branch (as fetched from its remote when it has
one) and every commit of any `refs/agentboard/board` already in the host
repository or on the host's remote, so when another clone moved first,
this clone's history is rebased onto it. Before the old repository is
moved aside, every event file in the old `.board/events` SHALL be present
with identical content in the new worktree; otherwise the move SHALL stop
with exit 5 reason `integrity` and leave the old `.board` in place. The old
repository SHALL be kept, not deleted, at
`<host git common dir>/agentboard/standalone-<UTC timestamp>`. The move
SHALL be resumable: if the process is killed at any point, `.board` either
is still the old standalone board or becomes the new host-model board when
`init --into-host` runs again, and running it again after success changes
nothing. When integrating an existing `refs/agentboard/board` stops on a
conflict, the move SHALL exit 3 with reason `sync-conflict`, leave the
rebase in place in its temporary worktree under
`<host git common dir>/agentboard/migrating/` for a human, leave the old
`.board` and `refs/agentboard/board` unchanged, and name the worktree's
path and the steps (resolve, `git add`, `git rebase --continue` there, then
`agentboard init --into-host` again). While that rebase is still in
progress, `init --into-host` SHALL exit 3 with reason `sync-in-progress`
naming the path with the same steps and SHALL remove nothing; once the
rebase is finished it SHALL adopt that worktree and complete the move with
every event, including every commit that reached the standalone board or
its remote since the worktree was made, integrated as a first run
integrates its source tip, and SHALL never discard what the human
resolved nor apply again a commit the human already resolved (the clones
of one board share its history: the re-run replays only what reached the
board since the worktree was made, and nothing when nothing did, so one
re-run completes the move). Every event file present in the old `.board/events` at any
point of the move (written by another writer or a standalone `sync`
while the move ran, even between the verification and the moment the old
repository is kept aside) SHALL end in the new worktree, carried over
content-addressed and committed by the move's `sync`; only a file whose
content does not match its name is an `integrity` refusal. The move SHALL
refuse with exit 3 instead of keeping the old repository aside when
`.board` is no longer the standalone repository it checked. A temporary
worktree is named by the pid of the move that made it, and one left by a
process that is still running is never touched. A dead temporary worktree
without rebase or cherry-pick state that integrated something (its HEAD
differs from the tip `refs/agentboard/migrating` records as integrated)
SHALL be adopted only when it was made from the board at `.board` now:
from the same standalone repository (the same git directory, by realpath,
device and inode) and from the same history (the HEAD that board had when
the move that made the temporary began is an ancestor of, or equal to, the
board's HEAD now, and the tip the temporary integrated, as the temporary
itself records it, is an ancestor of, or equal to, the tip of the board's
branch, as fetched from its remote when it has one). Every temporary
SHALL record the tip it integrated, and the record SHALL follow it when
it integrates more; the tip `refs/agentboard/migrating` holds, which the
whole host shares, SHALL stand for that record only for a temporary made
before the record existed and only when no other temporary worktree
exists on the host, otherwise such a temporary SHALL NOT be adopted. A temporary left by a move of a board replaced since,
even one whose git directory has the same realpath, device and inode as
the old one's and whose history holds that HEAD, or by a move that began
before the board's history or its remote's was rewritten so that it no
longer holds that HEAD or that tip, SHALL never be adopted,
and none of its commits or events SHALL reach `refs/agentboard/board`: it
is removed and named as left by a move of another board, or, with rebase
or cherry-pick state, it is the `sync-in-progress` refusal saying so,
which removes nothing. A record of the temporary that cannot be read
counts as naming another board, never as an error of the move. A
temporary made by an earlier version, which
recorded no starting HEAD, SHALL be judged by the tip it integrated
instead: it is this board's when the git directory it recorded, if it
recorded one, is the board's and that tip is an ancestor of, or equal to,
the tip of the board's branch (as fetched from its remote when it has
one). It SHALL never be refused for being made by an earlier version, and
once adopted it is judged as one made by this version.
Immediately before the compare-and-swap that updates
`refs/agentboard/board` in the host repository, every move SHALL record in
its temporary worktree the value the ref had before the first update of
this board that is not yet published: the value the swap compares against
(the zero object name when the ref does not exist), except when the move
resumes from a dead temporary of this board without rebase or cherry-pick
state whose HEAD is an ancestor of, or equal to, the ref as the leftover
pass found it (the evidence). When the ref still has that value at the
swap, the ref already holds this board's unpublished commits, and the move
SHALL carry the evidence's record forward instead (an adopted temporary
keeps its own) when the evidence's HEAD equals the ref; when its HEAD is a
strict ancestor of the ref (another writer added commits on top), or it
has no readable, well formed record, the move SHALL write none. When the
ref has another value at the swap (another writer moved it after the
leftover pass) that is a descendant of, or equal to, the evidence's HEAD,
it still holds this board's unpublished commits, and the move SHALL write
no record either. Writing none means a later run with another board
refuses rather than resets or integrates. When several such temporaries
exist, the evidence is the first in the byte order of their names whose
HEAD equals the ref, or, when none does, the first in that order. A
record equal to its temporary's HEAD is taken as content the ref held
independently of that move only because a resume never records a value
that holds its own board's commits. The evidence SHALL NOT be removed
before the move that resumes from it has written its own record, so no run
that stops between the leftover pass and that write (a kill, or a refusal
that discards its fresh temporary) loses it.
A move that updated the ref and did not complete has put its commits into
the ref without publishing them; they SHALL reach neither the board now at
`.board` nor the host's remote unless the temporary is this board's.
Before any leftover is removed or adopted, the move SHALL judge every
temporary worktree without rebase or cherry-pick state whose HEAD is an
ancestor of, or equal to, the local `refs/agentboard/board`, whether or
not it integrated something, by the tests that decide adoption. A live one
(its pid names a running process) that is not this board's SHALL make the
move exit 3 with reason `sync-in-progress`, naming the temporary, before
anything else of this rule, changing nothing: another move may be
running, or the pid was reused, and either way its commits are not
integrated. A live one that is this board's is left alone. A dead one
that is this board's is handled as before, and what it put into the ref is
this board's history: a move killed after it updated the ref completes
when run again with the same board. For a dead one that
is not this board's: when the ref equals its HEAD and its record of the
value before the swap is readable and well formed, the move SHALL set the
ref back to that value (deleting it when the value is the zero object name
of the repository's hash algorithm) with a compare-and-swap against that
HEAD, say so in its output, judge the remaining temporaries against the
new value, and remove and name the temporary as left by a move of another
board, also when a kill between the reset and the removal leaves the
removal to the next run; every dead temporary of another board whose HEAD
was in the ref when the run began is named the same way, also one whose
update a reset made for another temporary undid; when the recorded value
equals that HEAD the ref SHALL be left as it is, with no line saying it
was set back, and the temporary removed and named the same way; otherwise (no such record, as
from a version that did not write it, a recorded value that is not a
commit of the host repository, or a ref that has moved past that HEAD) the
move SHALL exit 3 with reason `sync-failed`, naming the ref, the
temporary's path and how to reset the ref by hand, and change nothing
more: the temporary, `.board`, `refs/agentboard/board` and the host's
remote stay as they are, except that resets already made earlier in the
same run stay, and the refusal SHALL say so instead of saying nothing was
changed. A lost compare-and-swap of the reset SHALL be the same refusal as
a lost compare-and-swap of the update, the ref unchanged. A local
`refs/agentboard/board` that does not hold the HEAD of such a temporary is
integrated as before.

#### Scenario: Migration success
- **WHEN** a standalone board with a remote, fully synced, holding 40 committed events, runs `agentboard init --into-host` in a host repository with no board ref, and `sync` then runs
- **THEN** `.board` is a host-model board whose history contains every commit of the old branch, `.board/events` holds the same 40 event files, `rebuild` gives a canonical dump byte-identical to the one taken before the move, the old repository is kept under `<host git common dir>/agentboard/`, and `origin` of the host lists `refs/agentboard/board`

#### Scenario: Migration re-run
- **WHEN** `agentboard init --into-host` runs again after it succeeded
- **THEN** it exits 0 saying the board is already in the host repository, and nothing changes

#### Scenario: Migration refused with uncommitted events
- **WHEN** a standalone board has an event file that `sync` has not committed and `agentboard init --into-host` runs
- **THEN** it exits 4 with reason `unsynced`, names the file count and `agentboard sync`, and the host repository has no new ref, worktree or object directory and `.board` is unchanged

#### Scenario: Migration refused with unpushed commits
- **WHEN** a standalone board with a remote has a commit its remote does not have and `agentboard init --into-host` runs
- **THEN** it exits 4 with reason `unsynced` and changes nothing

#### Scenario: Second clone migrates after the first
- **WHEN** clone A moved its standalone board into the host and synced, clone B then synced two new events to the old standalone remote and runs `agentboard init --into-host`
- **THEN** B's `refs/agentboard/board` contains A's history and B's two new commits, after `sync` in both clones every event file is in both, and their rebuilt caches are identical

#### Scenario: Migration stopped on a conflict
- **WHEN** the host's remote holds a `refs/agentboard/board` whose `.board/.gitignore` differs from the standalone board's committed `.gitignore`, and `agentboard init --into-host` runs
- **THEN** it exits 3 with reason `sync-conflict` naming `.gitignore`, the temporary worktree under `<host git common dir>/agentboard/migrating/` and `git rebase --continue`, the old `.board` is unchanged and still standalone, the host has no `refs/agentboard/board`, and running it again before the rebase is finished exits 3 with reason `sync-in-progress` naming the same path and removes nothing

#### Scenario: Migration completes after the conflict is resolved
- **WHEN** the two clones are clones of one standalone board (they share its early commits), a human resolves `.gitignore` in that temporary worktree, runs `git add` and `git rebase --continue` until the rebase is finished, a third clone meanwhile syncs an event to the old standalone remote, and `agentboard init --into-host` runs again
- **THEN** that one run completes the move with exit 0: `.board` is the host-model board holding every event of both histories, the third clone's event and the resolved `.gitignore`, the resolved commit is an ancestor of `refs/agentboard/board` and appears in its history once, exactly one old repository is kept, and no temporary ref or worktree remains

#### Scenario: Event written during the move is carried over
- **WHEN** another writer adds an event file to the standalone `.board/events` after `agentboard init --into-host` has verified the events and before it keeps the old repository aside
- **THEN** the move exits 0, the event file is in the new `.board/events` and in `refs/agentboard/board`, and the kept repository holds it too

#### Scenario: Interrupted migration resumes
- **WHEN** `agentboard init --into-host` is killed after the old `.board` was moved aside but before the new worktree was moved into place, and it runs again
- **THEN** it completes the move, `.board` is the host-model board with every event, and exactly one old repository is kept

#### Scenario: Temporary of a replaced board whose git directory reuses the inode
- **WHEN** a move of standalone board A (three events) stopped after its temporary integrated a commit, `.board` is then replaced by an unrelated standalone board B (two events, its own history) whose git directory has the same realpath, device and inode that A's had, and `agentboard init --into-host` runs
- **THEN** it moves B with exit 0, the output names the temporary as left by a move of another board, no event file or commit of A is in `.board/events` or `refs/agentboard/board`, and no temporary worktree or temporary ref remains

#### Scenario: Stopped temporary of a replaced board whose git directory reuses the inode
- **WHEN** a move of standalone board A stopped on a conflict with its rebase still in progress in the temporary, `.board` is then replaced by an unrelated standalone board B whose git directory has the same realpath, device and inode that A's had, and `agentboard init --into-host` runs
- **THEN** it exits 3 with reason `sync-in-progress` naming the temporary and saying it was left by a move of another board, the temporary, `.board` and the host's refs are unchanged, and nothing is removed

#### Scenario: Board history rewritten since the interrupted move
- **WHEN** a move of a standalone board without a remote stopped after its temporary integrated a commit, the board's branch is then reset to a commit older than its HEAD when that move began (the same git directory), and `agentboard init --into-host` runs
- **THEN** the temporary is removed and named as left by a move of another board, and the move completes with exit 0 from the board as it is now: no event file added only by the commits the reset removed is in `.board/events` or `refs/agentboard/board`

#### Scenario: Board remote rewritten since the interrupted move
- **WHEN** another clone synced two events to the remote of a standalone board that this clone had not pulled, a move here integrated them from the remote-tracking tip and stopped after its temporary integrated a commit, the remote's branch was then force-reset to the HEAD this clone had when that move began (dropping the two events), this clone synced one new event (the same git directory, its HEAD a descendant of the one the move began from), and `agentboard init --into-host` runs
- **THEN** the temporary is removed and named as left by a move of another board, the move completes with exit 0, and neither dropped event is in `.board/events` or in any commit of `refs/agentboard/board`

#### Scenario: Temporary of a replaced board forked at or after the HEAD the move began from
- **WHEN** a move of standalone board A integrated two events A's remote held beyond A's HEAD and stopped after its temporary integrated a commit, `.board` is then replaced by board B, a fork of A at that HEAD with a remote of its own and one event of its own, whose git directory has the same realpath, device and inode that A's had, and `agentboard init --into-host` runs
- **THEN** it moves B with exit 0, the output names the temporary as left by a move of another board, and neither of the two events is in `.board/events` or in any commit of `refs/agentboard/board`

#### Scenario: Temporary that looked alive while a fork of the board moved
- **WHEN** a move of standalone board A integrated two events A's remote held beyond A's HEAD and stopped after its temporary integrated a commit, the pid that temporary is named by then belongs to a running process, `.board` is replaced by board B, a fork of A at A's HEAD with a remote and an event of its own whose git directory has the same realpath, device and inode that A's had, a move of B stops after its own temporary integrated a commit, the first temporary's pid then exits, and `agentboard init --into-host` runs
- **THEN** it moves B with exit 0, the first temporary is removed and named as left by a move of another board, and neither of the two events is in `.board/events` or in any commit of `refs/agentboard/board`

#### Scenario: Temporary that looked alive while its board's remote was rewritten
- **WHEN** a move of a standalone board integrated two events its remote held beyond its HEAD and stopped after its temporary integrated a commit, the pid that temporary is named by then belongs to a running process, the remote's branch is force-reset to that HEAD (dropping the two events), the board syncs one new event, a second move stops after its own temporary integrated a commit, the first temporary's pid then exits, and `agentboard init --into-host` runs
- **THEN** the first temporary is removed and named as left by a move of another board, the move completes with exit 0, and neither dropped event is in `.board/events` or in any commit of `refs/agentboard/board`

#### Scenario: Board whose remote is ahead of its HEAD is adopted
- **WHEN** another clone synced an event to a standalone board's remote that this board fetched but did not merge, a move of the board integrated that remote-tracking tip, stopped on a conflict, and a human finished the rebase in its temporary, and `agentboard init --into-host` runs
- **THEN** it adopts the temporary and completes the move with exit 0: the resolution is an ancestor of `refs/agentboard/board`, which holds the other clone's event, and the output does not name the temporary as removed

#### Scenario: Unreadable record of a temporary
- **WHEN** a dead temporary that integrated a commit has an `agentboard-source` record that cannot be read as a file, and `agentboard init --into-host` runs
- **THEN** the temporary is removed and named as left by a move of another board and the move completes with exit 0, or, with rebase state, it is the `sync-in-progress` refusal saying so; no raw file error is reported

#### Scenario: Board that only grew since the interrupted move is adopted
- **WHEN** a move of a standalone board stopped on a conflict, a human finished the rebase in the temporary, the board then synced two new events (the same git directory, its HEAD a descendant of the one the move began from), and `agentboard init --into-host` runs
- **THEN** it adopts the temporary and completes the move with exit 0: the resolved commit is an ancestor of `refs/agentboard/board`, both new events are in it, and the output does not name the temporary as removed

#### Scenario: Temporary of an earlier version on this board is adopted
- **WHEN** a temporary made by agentboard 0.2.0 (it recorded the git directory and no starting HEAD) holds a finished resolution of a conflict of the board at `.board`, the tip it integrated is in that board's history, and `agentboard init --into-host` runs
- **THEN** it adopts the temporary and completes the move with exit 0, the resolution kept as an ancestor of `refs/agentboard/board`, every event of the board in it, and a run interrupted after the adoption judges the temporary as one made by this version

#### Scenario: Temporary of an earlier version on a replaced board whose git directory reuses the inode
- **WHEN** a temporary made by agentboard 0.2.0 records a git directory identity equal to that of the board now at `.board`, which replaced the board the temporary was made from, the tip it integrated is not in the new board's history, and `agentboard init --into-host` runs
- **THEN** the temporary is removed and named as left by a move of another board, the new board is moved with exit 0, and no event file or commit of the old board is in `refs/agentboard/board`

#### Scenario: Board replaced after the move updated the host ref
- **WHEN** a move of standalone board A (two events) into a host whose remote has no `refs/agentboard/board` is killed right after it updated the local `refs/agentboard/board`, `.board` is then replaced by an unrelated standalone board B (one event), and `agentboard init --into-host` runs
- **THEN** it moves B with exit 0, its output says the ref was set back to its value before the interrupted move and names the temporary as left by a move of another board, and no event file or commit of A is in `.board/events`, the local `refs/agentboard/board` or the host remote's `refs/agentboard/board`

#### Scenario: Board replaced after a move that joined the host remote updated the host ref
- **WHEN** another clone has published a host-model board with one event to the host's remote, a move here of standalone board A integrated it and was killed right after it updated the local `refs/agentboard/board`, `.board` is then replaced by an unrelated standalone board B, and `agentboard init --into-host` runs
- **THEN** it moves B with exit 0 and the ref set back as above, `.board/events` and both the local and the remote `refs/agentboard/board` hold the other clone's event and B's, and no event file or commit of A is in any of them

#### Scenario: Board replaced after the move refused at the rename
- **WHEN** a move of standalone board A updated the local `refs/agentboard/board`, `.board` was replaced by an unrelated standalone board B before the rename so the move exited 3 saying `.board` changed meanwhile, and `agentboard init --into-host` runs again
- **THEN** it moves B with exit 0, the ref set back as above, and no event file or commit of A is in `.board/events` or in the local or the remote `refs/agentboard/board`

#### Scenario: Move killed after it updated the host ref resumes with the same board
- **WHEN** a move of a standalone board is killed right after it updated the local `refs/agentboard/board`, once with the host's remote holding no board ref and once with it holding another clone's, and `agentboard init --into-host` runs again with the same board at `.board`
- **THEN** each re-run completes the move with exit 0, every event of the board (and the other clone's) is in `.board/events` and in the local and the remote `refs/agentboard/board`, the value the killed move gave the ref is an ancestor of the ref, and the output does not say the ref was set back

#### Scenario: Killed before the host ref was updated
- **WHEN** a move of standalone board A is killed after it recorded the ref's value before the swap and before the swap ran, `.board` is then replaced by an unrelated standalone board B, and `agentboard init --into-host` runs
- **THEN** the ref is not set back, the temporary is removed as today, B is moved with exit 0, and no event file or commit of A is in `refs/agentboard/board`

#### Scenario: Temporary that updated the host ref without recording its value before
- **WHEN** a dead temporary of standalone board A holds no record of the ref's value before its swap (made by a version that did not write it), its HEAD equals the local `refs/agentboard/board`, `.board` is an unrelated standalone board B, and `agentboard init --into-host` runs
- **THEN** it exits 3 with reason `sync-failed` and the hint of that reason, the message names `refs/agentboard/board`, the temporary's path and `git update-ref`, and the temporary, `.board`, the local and the remote `refs/agentboard/board` are unchanged; once the ref is deleted by hand, the next run moves B with exit 0 and no event file or commit of A in `refs/agentboard/board`

#### Scenario: Host ref moved past a temporary of another board
- **WHEN** the local `refs/agentboard/board` holds a commit made on top of the HEAD of a dead temporary of a board other than the one at `.board`, which recorded the ref's value before its swap, and `agentboard init --into-host` runs
- **THEN** it exits 3 with reason `sync-failed` naming the ref and the temporary, and nothing changes

#### Scenario: Reset of the host ref loses a race
- **WHEN** the move is about to set the local `refs/agentboard/board` back for a temporary of another board and something moves the ref first
- **THEN** it exits 3 with reason `sync-failed` as a lost compare-and-swap of the update does, the ref keeps the value the other writer gave it, and `.board` and the temporary are unchanged

#### Scenario: Move of the same board interrupted twice after it updated the host ref, then replaced
- **WHEN** a move of standalone board A into a host whose remote has no `refs/agentboard/board` (or has another clone's) is killed right after it updated the local `refs/agentboard/board`, the move is run again with A and that run is killed right after its own update, or right before it, or refused at the rename because `.board` was replaced right after its update, `.board` is (then) an unrelated standalone board B, and `agentboard init --into-host` runs
- **THEN** it moves B with exit 0 and the ref deleted (a real reset, said in its output; no line says the ref was set back to a value it already had), and no event file or commit of A is in `.board/events`, the local `refs/agentboard/board` or the host remote's `refs/agentboard/board`

#### Scenario: Record carried forward from the same board's leftover
- **WHEN** a move of board A beside a local ref fetched by hand updated the ref and stopped, a run of A that resumes from its temporary (whose HEAD equals the ref) stops after its own update, `.board` is an unrelated board B, and `agentboard init --into-host` runs
- **THEN** every temporary records the hand-fetched commit, never the value A's own update wrote, and the run with B sets the ref back to the hand-fetched commit; when A's leftover held no record, the resuming run writes none and the run with B refuses with reason `sync-failed`

#### Scenario: Resume of the same board stopped before its update keeps the evidence
- **WHEN** a move of board A is killed right after it updated the local `refs/agentboard/board`, a run of A is then killed after the leftover pass and before its step 2 fetch, or refused because the fetch of the host remote's board ref failed, `.board` is replaced by an unrelated board B, and `agentboard init --into-host` runs
- **THEN** A's first temporary is still there with its record before the run with B, and that run moves B with exit 0 and the ref deleted, nothing of A in `.board/events` or either ref

#### Scenario: Live temporary of another board in the host ref
- **WHEN** the temporary of a move of board A that updated the local `refs/agentboard/board` is named by the pid of a running process, `.board` is an unrelated board B, and `agentboard init --into-host` runs
- **THEN** it exits 3 with reason `sync-in-progress` naming the temporary, and the temporary, `.board`, the local and the remote `refs/agentboard/board` are unchanged; once that process has exited, the next run moves B with the ref deleted and nothing of A anywhere

#### Scenario: Killed between the reset and the removal of the temporary
- **WHEN** a run with board B is killed right after it set back the local `refs/agentboard/board` for a temporary of board A, and `agentboard init --into-host` runs again
- **THEN** it moves B with exit 0 and names the temporary as left by a move of another board, not as left by an interrupted move

#### Scenario: Refusal after a reset in the same run
- **WHEN** two moves of other boards updated the ref one after the other, the newer one recorded its value before, the older one recorded none, and `agentboard init --into-host` runs
- **THEN** the ref is set back for the newer one and the move exits 3 with reason `sync-failed` for the older one, saying that the reset already made was kept rather than that nothing was changed

#### Scenario: Another writer on top of the unpublished update before the same board resumes
- **WHEN** a move of board A is killed right after it updated the local `refs/agentboard/board`, another writer adds a commit on top of that update in the local ref, a run of A is killed right after its own update, `.board` is replaced by an unrelated board B, and `agentboard init --into-host` runs
- **THEN** the resuming run recorded no value before its swap, and the run with B exits 3 with reason `sync-failed` saying that move left no record, naming the resuming run's temporary, and changes nothing; no event file of A is in `.board/events` or the host remote's `refs/agentboard/board`

#### Scenario: Two temporaries of the same board undone by one reset
- **WHEN** a run of board A that resumed from its leftover is killed right after its update, so two temporaries of A hold the ref, `.board` is replaced by an unrelated board B, and `agentboard init --into-host` runs
- **THEN** the ref is deleted once, and both temporaries are named as left by a move of another board, neither as left by an interrupted move

#### Scenario: Another writer moves the host ref while the same board resumes
- **WHEN** a move of board A is killed right after it updated the local `refs/agentboard/board`, a run of A resumes from its temporary and, after its leftover pass and before its step 2 fetch, another writer adds a commit on top of A's update in the local ref, that run is killed right after its own update or right before it, `.board` is replaced by an unrelated board B, and `agentboard init --into-host` runs; once with the host's remote holding another clone's board (A's temporary is adopted) and once with it holding none (a fresh temporary)
- **THEN** the resuming run recorded no value before its swap, and the run with B exits 3 with reason `sync-failed` and changes nothing; no event file of A is in `.board/events` or the host remote's `refs/agentboard/board`

#### Scenario: Evidence equal to the ref preferred over an older one
- **WHEN** a move of board A is killed right after it updated the local `refs/agentboard/board`, A gains an event, a run of A that resumes from that temporary is killed between its own update and the removal of the first temporary, the first temporary's name sorts before the second's, a further run of A is killed right after its update, `.board` is replaced by an unrelated board B, and `agentboard init --into-host` runs
- **THEN** it moves B with exit 0 and the ref deleted (said in its output), and no event file or commit of A is in `.board/events`, the local `refs/agentboard/board` or the host remote's `refs/agentboard/board`

