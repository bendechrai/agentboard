## MODIFIED Requirements

### Requirement: Sync converges
`sync` SHALL commit any new event files in `.board`, integrate the board's
history from its remote with a rebase, and push. For a standalone board it
SHALL pull with rebase from the board repository's remote and push its
branch, as before. For a host-model board it SHALL first make
`refs/agentboard/board` equal to HEAD (rebasing HEAD onto the ref when the
ref holds commits HEAD does not), then fetch `refs/agentboard/board` from
the remote, rebase HEAD onto it when it holds commits HEAD does not, update
the local ref, and push `HEAD:refs/agentboard/board` without force; it
SHALL never create or move a branch. In both models a push rejected
because the remote moved SHALL be retried once from the fetch or pull, and
a second rejection SHALL exit 3. Because event files are add-only and
named by content, two clones that each added events SHALL merge without
conflict, and after both have synced, `rebuild` on each SHALL produce
byte-identical canonical dumps. If git reports a conflict on any path,
`sync` SHALL stop, leave the board's worktree in the conflicted state for a
human, and exit 3 naming the paths. `sync` SHALL stage only new files under
`events/` (never temporary files, never deletions) and `.board/.gitignore`,
so the cache and its WAL and SHM files are never committed even if
`.gitignore` is emptied. It SHALL commit with the fixed identity
`agentboard <agentboard@localhost>`, never the user's git identity, and only
when something is staged. When event files that are recorded in the
board's git history are missing from the working tree, `sync` SHALL stage
nothing and exit 5 with reason `integrity`, naming the missing files and
how to restore them. When the board directory is not the top level of a
git repository or worktree, `sync` SHALL exit 2. A standalone board on a
detached HEAD, or a host-model board whose worktree has a branch checked
out (reason `board-on-branch`), SHALL make `sync` exit 3 without staging
anything. A host-model board with a git older than 2.32 SHALL make `sync`
exit 1 with reason `git-too-old` without staging anything. When the host project's git repository tracks any path under
`.board`, `sync` SHALL warn on stderr (and in its JSON output) without
failing. After integrating, `sync` SHALL fold the arrived events and report
them.

The remote SHALL be chosen in the repository that holds the board's
history (the board repository for a standalone board, the host repository
for a host-model board), in this order: the remote named by the git
configuration value `agentboard.remote` in that repository, when set; the
remote of the upstream of the current branch (for a host-model board, the
branch checked out in the host's main worktree), ignoring an upstream
remote of `.`; `origin` when it exists; the only remote. With no remote,
`sync` commits locally, reports that no remote is configured and exits 0.
With several remotes and none chosen by these rules, `sync` SHALL exit 1
with reason `ambiguous-remote`, naming the remotes and saying how to set
`agentboard.remote`, after committing locally. When `agentboard.remote`
names a remote the repository does not have, `sync` SHALL use it as named,
so after committing locally it exits 3 with reason `sync-failed` naming
that remote (and `agentboard remote` lists the problem, see board-cli). A
host-model board's remote SHALL be reachable with the host's own URL and
credentials; agentboard SHALL never store a second URL for it. For a
standalone board, `sync` SHALL set the branch's upstream (`push -u`) only
when the branch has none (neither `branch.<name>.remote` nor
`branch.<name>.merge` is set); when `agentboard.remote` or the `origin`
rule chooses a remote other than the branch's upstream (including an
upstream of `.`), the branch's upstream SHALL be left unchanged, so the
override never changes what the user's own `git pull` does.

#### Scenario: Deleted event file is not synced
- **WHEN** a committed event file is deleted from `.board/events` and `sync` runs
- **THEN** nothing is staged or pushed and the command exits 5 naming the file

#### Scenario: Divergent clones converge
- **WHEN** clone A adds three events and clone B adds two events, both run `sync`, and A runs `sync` again
- **THEN** both clones contain all five event files and their rebuilt caches are identical

#### Scenario: Sync with no remote
- **WHEN** the repository that holds the board's history has no remote configured
- **THEN** `sync` commits local events, reports that no remote is configured, and exits 0

#### Scenario: Two clones of a host repository converge through the board ref
- **WHEN** clones A and B of one project share a host-model board through `origin`, A adds three events and B two, both run `sync`, and A runs `sync` again
- **THEN** both clones contain all five event files, their rebuilt caches are identical, `refs/agentboard/board` is the same commit in A, in B and on `origin`, and no branch was created or moved in either clone or on `origin`

#### Scenario: First sync publishes the board
- **WHEN** a host-model board was created with no board on `origin` and `sync` runs
- **THEN** `git ls-remote origin refs/agentboard/board` lists the commit of the local `refs/agentboard/board`

#### Scenario: Rejected push is retried
- **WHEN** clone B pushes the board ref between clone A's fetch and A's push
- **THEN** A's first push is rejected, A fetches again, rebases, pushes, reports B's events as arrived and exits 0

#### Scenario: Host with several remotes
- **WHEN** a host-model board's host repository has the remotes `fork` and `upstream`, no `origin`, its main checkout's branch tracks `upstream/main`, and `sync` runs
- **THEN** it fetches from and pushes to `upstream`

#### Scenario: Host with several remotes and no way to choose
- **WHEN** the host repository has the remotes `fork` and `upstream`, no `origin`, the main checkout's branch has no upstream and `agentboard.remote` is not set
- **THEN** `sync` commits locally, exits 1 with reason `ambiguous-remote` naming both remotes and `git config agentboard.remote <name>`, and pushes nothing

#### Scenario: Configured remote wins
- **WHEN** `agentboard.remote` is set to `fork` in the host repository and the main checkout's branch tracks `upstream/main`
- **THEN** `sync` fetches from and pushes to `fork`

#### Scenario: Configured remote does not change the upstream
- **WHEN** a standalone board's `main` tracks `upstream/main`, `agentboard.remote` is set to `fork` in the board repository, and `sync` runs
- **THEN** `sync` pushes to `fork` without setting an upstream, `branch.main.remote` is still `upstream` and `branch.main.merge` still `refs/heads/main`, and `upstream` received nothing

#### Scenario: Configured remote that does not exist
- **WHEN** `agentboard.remote` is set to `nope`, no remote of that name exists, and `sync` runs on a board with a new event
- **THEN** `sync` commits locally, exits 3 with reason `sync-failed` naming `nope`, and pushes nothing

#### Scenario: Conflict on a host-model board
- **WHEN** clones A and B change `.board/.gitignore` differently, A syncs, and B runs `sync`
- **THEN** B exits 3 with reason `sync-conflict` naming `.gitignore`, the rebase is left in progress in B's board worktree, B's `refs/agentboard/board` and every branch, index and working tree of B's host repository are unchanged, and the next `sync` in B exits 3 with reason `sync-in-progress` until a human finishes or aborts the rebase

#### Scenario: Board worktree on a branch
- **WHEN** a human runs `git -C .board switch -c scratch` on a host-model board and then `sync`
- **THEN** `sync` exits 3 with reason `board-on-branch`, stages nothing, and the hint names `git -C .board switch --detach refs/agentboard/board`

## ADDED Requirements

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
nothing.

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

#### Scenario: Interrupted migration resumes
- **WHEN** `agentboard init --into-host` is killed after the old `.board` was moved aside but before the new worktree was moved into place, and it runs again
- **THEN** it completes the move, `.board` is the host-model board with every event, and exactly one old repository is kept
