# Design

## Context

See proposal.md for why. Today `.board/` is always its own git repository
(ADR 0001, board-events "Board directory per project"). `init`
(`src/board/init.ts`) runs `git init` in it and makes no commit. `sync`
(`src/board/sync.ts`) checks that the board directory is the top level of
its own repository and on a branch, stages only `events/` and `.gitignore`,
commits as `agentboard <agentboard@localhost>` (ADR 0005), chooses a remote
(upstream, `origin`, the only remote, else `ambiguous-remote`), runs
`git pull --rebase`, pushes, retries a rejected push once, and catches the
cache up. Discovery (`src/store/locate.ts`) resolves
`<git common dir>/../.board`, so every linked worktree of the host finds the
main checkout's board; a board only needs `events/` to exist.

Constraints that shape this design:

- Event files are add-only and content-addressed, so any two histories of
  one board merge by union; only `.gitignore` can conflict.
- agentboard runs unattended inside other people's repositories. It must
  not trip their CI, hooks, branch tooling or cleanup scripts, and it must
  never lose a committed event.
- The decisions in the proposal are fixed (ADR 0012). This document
  decides the mechanics.

## Goals / Non-Goals

**Goals:**
- A second clone of a git project joins the board with `agentboard init`
  and nothing else.
- Board history in the host repository is invisible to everyone who does
  not ask for it, and survives every routine git maintenance command.
- The host-model `sync` keeps every guarantee of the standalone `sync`:
  ADR 0005's commit rules, exit codes, conflict handling, one retry.
- Moving an existing board into the host repository is one command, loses
  nothing, and can be re-run or resumed.
- Standalone boards behave exactly as before.

**Non-Goals:**
- Moving a board out of the host repository.
- Supporting git older than 2.32 for the host model.
- Detecting whether the host repository is public.
- Windows-specific handling beyond what git itself provides.

## Decisions

### 1. Detached HEAD, with agentboard owning `refs/agentboard/board`

`.board` is a linked worktree of the host on a detached HEAD. Every
agentboard step that moves HEAD (a `sync` commit, a rebase, a fast-forward)
is followed by `git update-ref refs/agentboard/board <new> <expected old>`,
a compare-and-swap that fails if anything else moved the ref in between.
Before it commits, `sync` checks the reverse direction: when the ref holds
commits HEAD does not (someone fetched into it by hand), HEAD is rebased
onto the ref first. So the ref and HEAD are equal whenever a command
completes (board-events "Board ref in the host repository"), and the ref,
not the worktree, is what keeps the commits reachable.

Alternatives considered:

- **HEAD as a symbolic ref to `refs/agentboard/board`**
  (`git symbolic-ref HEAD refs/agentboard/board` in the worktree). Tried
  on git 2.52: commit and rebase update the ref through it and `git status`
  reports "On branch refs/agentboard/board". Rejected: `git worktree add`
  cannot create it, a HEAD outside `refs/heads/` is undocumented porcelain
  behavior that other git versions and tools (IDEs, prompts) may treat as
  detached or as an error, and a human's `git checkout` silently detaches
  it so later commits stop moving the ref with no error.
- **A local-only branch** (`refs/heads/agentboard/board`). Rejected: it
  appears in `git branch`, IDE branch pickers and cleanup scripts, is
  pushed by `git push --all` or `push.default=matching`, and blocks anyone
  who tries to check it out elsewhere. The point of the ref model is that
  nothing about the board looks like a branch.

A `.board` with a branch checked out (a human ran `git switch` in it) is
refused by `sync` with exit 3 `board-on-branch`; the hint is
`git -C .board switch --detach refs/agentboard/board`. The standalone
model keeps its branch and its `detached-head` refusal.

### 2. Creating, joining and locking the worktree

All with plumbing that exists in every supported git:

- **New empty board:** `git hash-object -w` for `.gitignore` and the empty
  `events/.gitkeep`, `git mktree` twice (events, root),
  `git commit-tree` with the fixed identity, `GIT_AUTHOR_DATE` and
  `GIT_COMMITTER_DATE` of `@0 +0000` and the message
  `agentboard: empty board`, then
  `git update-ref refs/agentboard/board <commit> ""` (the empty old value
  means create-only, so two racing `init`s cannot overwrite each other; the
  loser re-reads the ref and uses it).
- **Join:** `git fetch --no-tags <remote> refs/agentboard/board:refs/agentboard/board`
  when the local ref does not exist (presence checked with
  `git ls-remote <remote> refs/agentboard/board`).
- **Worktree:** `git worktree add --detach .board refs/agentboard/board`,
  then `git worktree lock --reason "agentboard board" .board`. A missing
  but still registered (and locked) `.board` needs
  `git worktree add -f -f`; `init` uses that only after checking that the
  registered path is exactly `<host>/.board` and the directory is gone.
- If the host has sparse checkout enabled, `init` runs
  `git -C .board sparse-checkout disable` so every event file is checked
  out.

Git names the worktree's administrative directory itself (`-board` on
2.52 for the path `.board`); agentboard never assumes the name and always
asks git (`git rev-parse --absolute-git-dir` in `.board`).

The host model needs a host whose git directory is inside its working
tree: `init` takes it only when the parent of `.board` (discovery's parent
of the git common directory) is the top level of a working tree and that
working tree's common directory is `<top level>/.git`, compared as
realpaths. A bare repository with linked worktrees, a `--separate-git-dir`
repository and a submodule (common directory
`<superproject>/.git/modules/<name>`) fail that check: discovery puts
`.board` beside the git directory, outside any working tree or inside the
superproject's `.git`, and a worktree added there would belong to the
wrong repository. They get a standalone board with a message naming the
git directory, like the old-git fallback, and no host `.gitignore` is
written, because the parent is not a working tree. The check runs before
anything is written.

The create-only `update-ref` makes two racing `init`s agree on the ref,
but not on the worktree: two concurrent `git worktree add` of one path can
both pass git's non-empty check and register two worktrees (`-board` and
`-board1`) for `.board`. So the host-model steps of `init` (finding or
making the ref, adding and locking the worktree, repairing a broken link)
run under a pid lock file `<git common dir>/agentboard/init.lock`, removed
when `init` is done. The lock is taken before `init` decides between
creating or joining a board and repairing a broken link, because a
`.board` that another `init` is in the middle of adding (the directory
exists, `events/` does not) looks like a broken link or a stray directory;
a second `init` that decided before taking the lock would start a repair
of a board that is healthy by the time it holds the lock. Under the lock
it looks again, sees the finished board and reports it. Two things happen
before the lock, because they write nothing and the lock itself would
(its directory under the host's `.git`): a board that is already healthy
is reported as it is (no `init` changes a healthy board), and an
ambiguous remote refuses. A lock whose pid is not running, or which is older
than 60 seconds, is stale and is broken by the next `init`, so a killed
`init` never blocks the one that completes the board. The lock lives
inside the git directory, where the host's `git status` never shows it.
Known limit: a holder that is still alive after 60 seconds (a slow fetch,
a credential prompt inside `ensureBoardRef`) has its lock broken by a
waiting `init`, which then runs concurrently with it; the create-only
`update-ref` and the idempotent worktree steps keep the outcome
consistent, and 60 seconds is far beyond a normal `init`. The move of
decision 9, whose steps are not all idempotent, refreshes the lock's
mtime before each of its network steps instead.

`git worktree add --orphan` would create the first commit without
plumbing, but it needs git 2.42 and makes a non-deterministic commit.
Plumbing works on the floor and gives every independent empty board the
same root commit, so a clone that created a board offline shares history
with the remote's board and its first `sync` is an ordinary rebase.

### 3. Git floor: 2.32 for the host model

The full lifecycle (create, lock, sync between two clones through a bare
remote, rejected push and retry, `.gitignore` conflict, gc, prune, remove,
`push --mirror`, missing worktree re-add, moved host repair, stale copy
detection, migration with `worktree move`, rebasing an unrelated
standalone history) was scripted and run on:

| git | result |
|---|---|
| 2.52.0 (macOS) | all pass |
| 2.34.1 (Ubuntu 22.04) | all pass |
| 2.32.7 (Alpine 3.14) | all pass |
| 2.30.6 (Alpine 3.13) | `git worktree repair` cannot fix a host moved together with its `.board` ("unable to locate repository; .git file broken") |
| 2.26.3 and 2.25.1 | no `git worktree repair`; migration steps fail |

2.32 is therefore the oldest verified version that supports everything
the host model needs. It is older than the git of every current
mainstream platform (Ubuntu 22.04 and later, Debian 12, RHEL 9, macOS
command line tools, the Node 22 Docker images). Below it, `init` creates a
standalone board and says why, `init --into-host` and `sync` on an
existing host-model board exit 1 `git-too-old`, and `remote` reports the
old git as a problem. The version comes from `git --version`, accepting suffixes
such as `(Apple Git-154)`.

The floor is tested, not only declared: `make check-git-floor`
(CONTRIBUTING.md, "Checks") runs the sharing tests, the explicit
`SHARING_TESTS` list in the Makefile rather than the whole suite or a
glob and without coverage, in the `dev-git-floor` compose service, the
oldest supported Node with git 2.32.7 built from its kernel.org release
tarball (hash pinned) in `Dockerfile.dev` behind `ARG GIT_VERSION`; empty,
the argument keeps the distro git, so the `dev` and `dev-floor` images
are unchanged. The container refuses to run the tests on a git outside
the 2.32 line, and `src/__tests__/git-floor.test.ts` pins that
`HOST_MODEL_GIT_FLOOR`, the Makefile's `GIT_FLOOR` and the image's
`GIT_VERSION` agree, that every file the list names exists, and that the
list holds every file of the test's own required set (the git layer,
model detection, `init`, both syncs, `init --remote`, `init --into-host`
and `remote`, in process, through the CLI and as child processes), so a
file dropped from the list fails the test.

### 4. Host-model sync

Same entry point and result shape as today, with these additions to the
result (and the `sync --json` document) for both models: `model` (`host`
or `standalone`), `ref` (`refs/agentboard/board` for the host model, null
for a standalone board) and `refCommit` (host model: the commit the ref
holds when `sync` returns, which is the worktree's HEAD; null for a
standalone board). For the host model `branch` is null (the worktree is
detached by design) and `upstreamSet` is always false (no branch, no
upstream). `arrived` is, for the host model, the set of event files the
fetched or hand-fetched commits added to HEAD's tree (`git diff
--no-renames --name-only --diff-filter=A <HEAD before step 2> HEAD --
events`; without `--no-renames` a local event similar to an arrived one
would hide it as a rename), never an
event this process committed or that another writer in the same clone
wrote while the sync ran; an event written mid-sync stays untracked and
is committed by the next `sync`. `pulled` is true when the fetch found
`refs/agentboard/board` on the remote and its history was integrated,
whether or not anything new arrived; false on the no-remote path and when
the remote has no board ref yet. `pushed` is true when a push completed,
also when the remote was already up to date.

Every git command runs in `.board` with the
existing sanitised environment and fixed identity, plus
`-c core.hooksPath=<empty directory>`, so the host's hooks (pre-commit,
pre-rebase, post-checkout, pre-push) never run for the board: they are
written for the host's branches, and a slow or failing `pre-push` (this
repository's runs `make`) would otherwise block every board sync. The
empty directory is `agentboard-no-hooks` under the worktree's git
directory (`git rev-parse --absolute-git-dir` in `.board`, so
`<host git common dir>/worktrees/<name>/agentboard-no-hooks`), created by
the git runner when it is missing, or a fresh temporary directory when git
cannot name the git directory. It is the one file the host's git directory
gains for the board besides the worktree entry itself; `core.hooksPath` is
passed on each command and never written to any configuration file.

Preconditions: git present and at least 2.32 (exit 1 `git-too-old`);
model `host` (a broken link is exit 2 `board-link-broken`); no rebase,
merge or cherry-pick in progress in the worktree's git directory (exit 3
`sync-in-progress`); HEAD detached (exit 3 `board-on-branch`); committed
event files present (exit 5 `integrity`).

Steps:

1. Stage and commit exactly as ADR 0005 (`--no-verify`, own paths only).
   Then, as the standalone `sync` does before its pull, refuse content
   that someone else staged in the worktree (anything staged outside
   `events/` and `.gitignore`): exit 3 `sync-failed` naming the paths and
   `git restore --staged`, on every path including the no-remote one,
   because the rebases of steps 2 and 5 cannot run over a dirty index and
   `sync` never commits such content. The commit of step 1 is kept and the
   next `sync` moves the ref to it.
2. Integrate the local ref: if `refs/agentboard/board` is not an ancestor
   of HEAD, `git rebase --no-verify refs/agentboard/board` (conflict: exit
   3 `sync-conflict`; the ref keeps the value it had, so a hand-fetched
   history stays reachable through it), unless the ref is a stale value
   of this worktree, which is moved to HEAD without a rebase. The ref is
   stale exactly when it is the commit the last rebase of this worktree
   started from (`ORIG_HEAD` in the worktree's git directory, which `git
   rebase` sets to the pre-rebase HEAD) and that commit is not a
   descendant of HEAD (so a `git reset --hard <older>`, which also sets
   `ORIG_HEAD`, does not qualify), and HEAD's tree holds every event file
   of the ref's tree (`git diff --no-renames --name-only --diff-filter=A
   HEAD refs/agentboard/board -- events` prints nothing; `--no-renames`,
   because two similar event files on either side would otherwise pair as
   one rename and hide the one HEAD lacks). That is the state a `sync`
   killed between its rebase and its `update-ref` leaves, and the state a
   human leaves by finishing a conflicted rebase with `git rebase
   --continue`: the rebase replayed the ref's commits into HEAD, so
   rebasing onto the ref again would replay the other side's commits onto
   it and conflict a second time. Every other way the ref can hold what
   HEAD does not rebases: a hand fetch into the ref (the ref's commit is
   not `ORIG_HEAD`, whatever it holds, so a commit that only changes
   `.gitignore` is integrated too), an aborted rebase (`--abort` restores
   HEAD and `ORIG_HEAD` to the pre-rebase commit, not the fetched one), a
   `checkout` or `reset --hard` of an older commit in `.board` (the ref is
   a descendant of HEAD). So the ref never loses an event it held. A rule
   that only asked whether the ref is an ancestor of HEAD would conflict
   again after a human's `rebase --continue` and rebase again after a kill,
   because the rebased HEAD does not descend from the pre-rebase commit
   (verified with plain git); a rule based on the HEAD reflog was wider
   than that and moved the ref backwards (round 1 reviews). Then
   `update-ref` with the old value read before the rebase (the empty
   string when the ref was deleted by hand, which creates it again from
   HEAD); a failed compare-and-swap repeats this step once, then exits 3
   `sync-failed` naming the ref.
3. Remote: chosen as in board-concurrency "Sync converges". No remote ends
   here, exit 0. The main worktree's branch is used for the upstream rule
   (not the branch of the linked worktree the command happens to run in)
   so every agent on the board picks the same remote. A remote whose URL
   is a relative path (`git remote add origin ../project.git`) is resolved
   against the host's top level for the duration of the command (the
   commands run in `.board`, from which git would resolve it one directory
   too deep); the configuration is never rewritten.
4. Fetch: `git fetch --no-tags <remote> refs/agentboard/board`. With no
   destination in the refspec the result lands in the worktree's own
   `FETCH_HEAD` (per worktree, so it never disturbs the main checkout's)
   and no remote-tracking ref is written; `fetch.prune` cannot prune
   anything. A missing remote ref (fresh remote, checked with `ls-remote`
   first) skips to step 6. Any other failure of the `ls-remote` or the
   fetch (an unreachable remote, a configured remote that does not exist)
   is exit 3 `sync-failed` with git's first error line, the commit of
   step 1 kept.
5. If `FETCH_HEAD` is not an ancestor of HEAD:
   `git rebase --no-verify FETCH_HEAD`, then `update-ref` as in step 2
   (the repeat of a failed compare-and-swap reads the ref again and treats
   it as step 2 does). A rebase that stops on a conflict is left in place
   for a human (exit 3 `sync-conflict`); one that fails for another reason
   (an untracked file in `.board` that the fetched commits would
   overwrite) is exit 3 `sync-failed` with git's error, HEAD unchanged.
   Histories with different roots (a board created offline meeting a
   migrated one) rebase the same way: the empty-board root only adds the
   same `.gitignore` and `.gitkeep`, which git applies cleanly and drops,
   as the verification above showed; a differing `.gitignore` is an
   ordinary conflict.
6. Push: `git push --porcelain --no-verify <remote> HEAD:refs/agentboard/board`
   (never `--force`). A rejection because the remote moved (a porcelain
   `!` line whose reason is `[rejected]`, non-fast-forward; or a
   `[remote rejected]` whose reason is a lost ref update, which is how
   receive-pack reports a push received at the same time as another one
   to the same ref: `failed to update ref`, `failed to lock`, `incorrect
   old value provided`, `cannot lock ref`, and `reference already exists`
   when the other push created the ref between this push's advertisement
   and its ref update; ten writers and two syncs per clone hit it in the
   first round of the concurrency test, and two clones moving their boards
   into one host at the same time hit the last wording) retries once
   from step 4; a second such rejection is exit 3 `sync-failed`. A remote
   that refuses the ref (any other `[remote rejected]`: a `pre-receive`
   hook, a host that does not accept custom refs) is not a race and is
   not retried:
   one push, then exit 3 `sync-failed` whose message carries the remote's
   reason as git printed it (the hook's text), so the user can read why.
   Any other push failure is exit 3 `sync-failed` with git's first error
   line.
7. Catch up the cache, report arrivals as today.

Guarantee on the ref (board-events "Board ref in the host repository"):
`refs/agentboard/board` equals the worktree's HEAD after every successful
`sync`, and after the refusals `sync-conflict` (the ref was updated before
the rebase and the failed rebase moved nothing), `sync-in-progress` and
`board-on-branch` (nothing ran). After exit 3 `sync-failed` the ref may
lag HEAD (the staged-content refusal after the commit, a compare-and-swap
that failed twice, a rebase that failed without a conflict); no commit is
lost, and the next `sync` repairs it in step 2. A process killed between
any step and its `update-ref` likewise leaves HEAD ahead of the ref, which
the next `sync` repairs with no commit lost.

Known limit: nothing serialises two `sync` processes in one clone. Inside
the rebase window the second one exits 3 `sync-in-progress`; outside it
the two collide on git's `index.lock` and the loser exits 5 with git's
"index.lock: File exists" error, exactly as two standalone syncs do today,
or, when both reach their rebase at once, the loser exits 3 `sync-failed`
with git's "there is already a rebase-merge directory" error; in every
shape the ref equals HEAD afterwards and nothing is lost (the second
reviewer measured 9 of 10 collisions as exit 5 and 1 as exit 3). An
orchestrator runs one `sync` per clone at a time.

Known limit: for a remote whose URL is a relative path, the resolved
absolute path is passed in place of the remote name, so
`remote.<name>.pushurl` and `url.<base>.insteadOf` rewrites configured
for that remote are bypassed for the board's fetch and push; a remote
with any other URL goes through them as usual.

### 5. Choosing the remote, and `agentboard.remote`

Today's order is kept and an explicit override is put in front of it:
`git config agentboard.remote <name>` in the repository that holds the
board's history. Without it, a host-model board in a fork workflow (remotes
`fork` and `upstream`, no `origin`, no upstream) could only be fixed by
changing the host branch's upstream, which changes how the user's own
`git pull` behaves. The override is read in both models for consistency;
it changes nothing unless set. An upstream remote of `.` (a branch tracking
a local branch) is skipped, because pushing the board to the repository
itself means nothing.

The override never rewrites the user's upstream either: the standalone
`sync` pushes with `-u` only when the branch has no upstream at all
(neither `branch.<name>.remote` nor `branch.<name>.merge` set). When
`agentboard.remote` or the `origin` rule picks a remote other than the
branch's upstream (including an upstream of `.`), the branch keeps its
upstream, so `git pull` in the board repository behaves as it did before.
Where a standalone board's git directory lies makes no difference (decision
6).

### 6. Model detection

One function, used by `init`, `sync` and `remote`, implements
board-events "Board model detection" with `git rev-parse
--show-toplevel --git-common-dir --absolute-git-dir` run in the board
directory and `git rev-parse --git-common-dir` run in its parent, both
resolved with `realpath` before comparing. The git directory and the common
directory being equal means the board is not a linked worktree, and that is
what makes it standalone: wherever that directory lies, `.board/.git` or
the directory a `.git` file names (`git init --separate-git-dir`, a
submodule of the host under `<host>/.git/modules/`). Whether `.git` is a
file or a directory is never the deciding fact, since boards of both kinds
synced before this change and must keep doing so. A `.git` file whose
target is missing makes the first call fail; that, or a linked worktree
whose common directory is not the parent's, is a broken host link; nothing
else is. Commands that only read or write events never call it, so a
broken link never stops the board itself.

### 7. `init` without flags

Order of operations for a new host-model board, chosen so every step is
idempotent and an interrupted `init` is finished by running it again:
choose the remote (an ambiguous choice stops before anything is written);
add the host `.gitignore` entry; find or make the ref (local, else fetch,
else create); add and lock the worktree; disable sparse checkout; catch up
the cache. `.board/events` only appears with the worktree checkout, so a
half-made board is never mistaken for a board. An `init` interrupted after
`git worktree add` and before the lock leaves a board that exists; the
next `init` finds it healthy, restores the lock and says so (the only
change `init` makes to an existing board). A board re-created from the
local ref after its directory was deleted reports that it was restored
from the local ref with the number of event files; a board whose ref was
written fresh, or whose ref holds nothing but the deterministic
empty-board commit (the loser of two racing `init`s, or an empty board
whose directory was deleted), is reported as a new empty board, since it
has no history to restore.

The standalone fallbacks (old git, a host whose git directory is not in
its working tree) put the reason in both `message` and `warnings`, so the
CLI prints it on stderr even with `--json`.

Repair of a broken link: `git worktree repair .board` first, and only when
`.board/.git` names a git directory that is missing (the host was moved
together with its `.board`; the repair fixes it in place). When the named
directory exists in another repository (a `.board` copied from clone A,
whose `A/.git/worktrees/-board` is still there), `git worktree repair`
would rewrite A's `worktrees/-board/gitdir` to point at the copy, changing
clone A, so that case skips the repair step. If the link is still broken
(or the repair step was skipped), the old directory is kept and
a fresh worktree is built at `<git common dir>/agentboard/repairing` from
the best history available, every event file of the old `events/` it lacks
is copied in (names are content hashes, so a copy can never change an
existing event; a file whose content does not match its name is skipped and
reported), the old directory is renamed to
`<git common dir>/agentboard/stale-board-<UTC timestamp>` (the timestamp
as `YYYYMMDDTHHMMSSZ`, with a numeric suffix when that name is taken), and
the fresh worktree is moved into place with `git worktree move`, then
locked. A `.board` that exists in such a host but is not a repository
(event files without a `.git`, or a stray directory) takes the same
fresh-worktree path, skipping the `git worktree repair` step. A repair
interrupted between the rename and the move leaves `.board` missing and
the `repairing` worktree registered; the next `init` moves it into place
and reports the kept copy with `repair` set. A `repairing` worktree left
by a repair interrupted earlier is removed and the repair starts again.
Every path in a broken-link detail (`detectBoardModel`) is a realpath, so
the message never mixes a symlinked spelling with a resolved one.

### 8. `init --remote <url>`

A URL is local when git would treat it as a path: it starts with
`file://`, or it has no `:` before its first `/` (git's rule for the
`host:path` form), on any platform where that applies. A missing local
path is created with `git init --bare`. Reachability and emptiness come
from `git ls-remote <url>` (no refs means empty). An existing board is
cloned with `git clone <url>` into a temporary sibling directory that is
renamed to `.board` only after its default branch is found to contain
`events/`, so a failed or rejected clone leaves nothing behind. An empty
remote gets today's standalone `init`, `git remote add origin <url>` and a
`sync`, whose first push sets the upstream. GitHub answers "Repository not
found" both for a missing repository and for one the user cannot read, so
the `remote-unreachable` message says to create the repository and to
check access.

The value of `--remote` is validated before any git command runs: an
empty value, one that starts with `-` (which `ls-remote` would read as an
option, `--upload-pack=<command>` among them, against the host's own
`origin`), and a `file://` URL whose host is neither empty nor `localhost`
are usage errors, and every git command that takes the URL passes it after
`--`. A relative path is resolved against the host's top level (the parent
of `.board` when discovery went through git, the same from every linked
worktree, as the host-model `sync` resolves one) or the current directory,
and `origin` stores the absolute path, so a later `sync` reaches it from any
directory and no `pushurl` or `insteadOf` rewrite is bypassed at sync time;
`file://localhost/x` and `file:///x` are the path `/x`, and a `file://` or
non-local URL is stored as given. A matching URL is compared against the
raw `remote.<name>.url` as well as the rewritten URL, so `insteadOf` does
not turn a re-run into `remote-mismatch`; a re-run with a matching URL runs
no `sync`, so `init` stays idempotent. An existing `.board` that is not a
board (a non-empty directory without `events/`, a file, a dangling symbolic
link) is refused with exit 2 `board-not-a-repository` before any write,
rather than repaired or adopted as plain `init` would: `--remote` names a
repository to clone or create, and the user's directory must not be
renamed over or turned into a repository; an empty directory is treated as
absent. A standalone board with several remotes and none chosen is
`ambiguous-remote`, as `init`, `sync` and `remote` all decide through the
same choice. The temporary clone is `.board-clone-<random>` beside `.board`
(same file system, so the rename is atomic); a clone that fails after a
successful `ls-remote` is `remote-unreachable`; a remote whose HEAD names a
branch it does not have (a bare repository whose HEAD is `main` that only
received `master`) checks nothing out, so when it has exactly one branch
that branch is checked out before the `events/` check, and a failed
checkout is `not-a-board`; in every refusal the temporary directory is
removed, and a `.board-clone-*` left by an interrupted run is removed by
the next `init --remote`, which names it.

### 9. Migration: `agentboard init --into-host`

Name: a flag on `init` rather than a new command (`agentboard migrate`,
`agentboard move-board`). `init` is already the one setup command, decides
the board's model, is idempotent, needs no actor and is excluded from MCP;
`--into-host` reads as the counterpart of `--remote` (where the board's
history lives). A one-off top-level verb would add a command that each
clone uses once.

Steps (the temporary paths are inside the host's git common directory, so
the host's `git status` never shows them and nothing can `git add` them):

1. Checks, in order, changing nothing: git 2.32 or later; board found
   through a git repository; healthy host-model board: exit 0; standalone
   board: no rebase or merge in progress and on a branch (exit 3 as
   `sync`), committed events present (exit 5), no uncommitted event file
   (exit 4 `unsynced`); with a standalone remote: `git fetch` of its branch
   (unreachable: exit 3 `sync-failed`) and HEAD an ancestor of the fetched
   tip (else exit 4 `unsynced`). The source tip is the fetched tip when
   there is a remote (it may hold other clones' events too), else HEAD.
2. Fetch the source tip from the standalone repository into the host as
   `refs/agentboard/migrating-fetch` (a reserved scratch ref, the only
   ref a fetch of the move ever writes).
3. Set `refs/agentboard/migrating` (the tip the temporary worktree has
   integrated) to it, add a worktree at `<git common dir>/agentboard/migrating`
   on it, record the standalone repository's identity in the worktree,
   and integrate the local `refs/agentboard/board` and the host remote's
   `refs/agentboard/board` when they exist, with the rebase of decision 4
   (a conflict stops with exit 3, the old `.board` untouched, and the
   message naming the temporary worktree).
4. `update-ref refs/agentboard/board` to the result (compare-and-swap
   against the value seen in step 3).
5. Verify every `events/*.json` of the old `.board` is in the new worktree
   with identical bytes (exit 5 `integrity` otherwise, nothing moved).
6. Rename the old `.board` to
   `<git common dir>/agentboard/standalone-<UTC timestamp>` (same file
   system, atomic), `git worktree move` the temporary worktree to `.board`,
   lock it, then delete `refs/agentboard/migrating` and
   `refs/agentboard/migrating-fetch`.
7. `sync` (publishes the ref) and catch up the cache.

The temporary worktree is `<git common dir>/agentboard/migrating/<pid>`,
one subdirectory per move named by the pid of the process that made it,
and `refs/agentboard/migrating` is one ref that records what the
temporary worktree integrated and lives as long as the worktree does: set
when the worktree is added, advanced only after a replay integrated the
fresh tip (round 4 ruling: never by the fetch of step 2, which writes the
scratch ref `refs/agentboard/migrating-fetch` only, so a run that fetched
and then stopped, by a kill, a lost lock or a conflict of the replay,
leaves the next run replaying from the tip the worktree really holds and
no event synced to the old remote meanwhile is skipped), deleted in step
6 once the worktree is in place (round 3 ruling: not at the end of step
4, so a kill between the compare-and-swap and the `worktree move` leaves
a re-run that adopts the temporary with the tip it integrated, and its
replay is never based on a merge base or `--root`), by a resumed move
when it still exists, and when no temporary worktree remains at all; the
scratch ref goes with it. A leftover of an earlier
move is touched only when its pid is dead (the group 4 review of
`init --remote`, whose cleanup of every `.board-clone-*` can make a
concurrent run fail): a live-pid temporary is left alone; a temporary
named by the running process's own pid counts as dead, since one process
runs one move at a time under the init lock (this also covers pid
namespaces in containers). The step 1 checks run before the init lock, so
a refusal creates no `<git common dir>/agentboard` directory; steps 2 to
7 run under it, and the move refreshes the lock file's mtime immediately
before each network step (the `ls-remote` and the fetch of step 3, the
`sync` of step 7), so a move waiting on a slow remote is not broken as
stale at 60 seconds while it is alive (the known limit of decision 2 does
not apply to it). The host `.gitignore` entry is written only after the
compare-and-swap of step 4 succeeded, so a refusal of steps 2 to 4 leaves
the host's working tree as it was.

Conflicts are not a dead end (orchestrator rulings, group 5): a rebase of
step 3 that stops on a conflict exits 3 `sync-conflict` with the
temporary worktree left as git left it, the old `.board` untouched and
`refs/agentboard/board` unchanged, and the message names the worktree's
path and the human steps: resolve, `git add`, `git rebase --continue` in
that worktree, then `agentboard init --into-host` again. A re-run never
removes a dead-pid temporary worktree that has rebase state, or
cherry-pick state a human is in the middle of: it exits 3
`sync-in-progress` naming the path with the matching instructions (`git
rebase --continue` or `git cherry-pick --continue`) and changes nothing
(an interrupted replay of the move's own, with nothing unmerged and a
clean index, is quit and run again instead, see below). A dead-pid
temporary worktree without such state
whose HEAD differs from `refs/agentboard/migrating` (its rebase finished,
by the move before it was killed or by a human, or its compare-and-swap
was lost) is adopted when it belongs to the board at `.board`: every
temporary records the identity of the standalone repository it was made
from (the git directory identity of step 1, in the file
`agentboard-source` of the worktree's git directory), and one whose
record is missing or names another repository (`.board` replaced by
another standalone board since) is never adopted (round 4 ruling):
without rebase or cherry-pick state it is removed like a dead leftover
and named as left by a move of another board, with such state it is the
`sync-in-progress` refusal saying the same. Adoption integrates: the
re-run reads the value `refs/agentboard/migrating` holds (the source tip
the worktree integrated), fetches the fresh source tip into
`refs/agentboard/migrating-fetch` as step 2 does, and replays onto the
adopted HEAD exactly the source commits that reached the standalone board
or its remote since, from this clone's own `sync` or from a third clone:
nothing when the fresh tip equals the integrated one or is already an
ancestor of HEAD (no cherry-pick and no rebase runs), else `git
cherry-pick <base>..refs/agentboard/migrating-fetch` (round 4 ruling: a
cherry-pick, not `rebase --onto`, so HEAD stays the branch the commits
land on and a human's `git cherry-pick --abort` returns to the HEAD they
resolved instead of to the fresh tip) with `<base>` the integrated tip
when it is an ancestor of the fresh tip, which is the normal case (round
3 ruling: clones of one board share its history, so the merge base of
the adopted HEAD and the fresh tip predates the commits the human
resolved and a replay based on it applies them again, conflicting
forever); the merge base is only the fallback when the integrated tip is
unrelated, and every commit of the fresh tip the last one. A commit whose
patch HEAD already holds (one the human finished by hand) is skipped,
never kept empty and never a refusal. Only after the replay,
`refs/agentboard/migrating` is advanced to the fresh tip. A replay that
stops on a conflict exits 3 `sync-conflict` naming the worktree, `git
cherry-pick --continue` and `agentboard init --into-host`, with the
worktree, both refs and the old `.board` as they were; after the human's
`--continue` the re-run completes the move with every event, after their
`--abort` it adopts the worktree again, still at the resolution, and
replays again. A replay a human finished is told from one they abandoned
by a record the move writes in the temporary worktree's git directory
before the cherry-pick (`agentboard-replay`: the HEAD the replay started
from and the tip it replays up to; implementer decision, round 4): a
re-run that finds the record with HEAD moved on and every event file of
the replayed range in HEAD's tree counts the worktree as having
integrated that tip and replays nothing of it again (a commit the human
resolved by hand would conflict with the same commit replayed once more,
and git cannot tell them apart by patch), while HEAD still at the
recorded start (`--abort`, or every commit skipped) or an event file of
the range missing from HEAD (`git cherry-pick --quit` half way) replays
again from the integrated tip, the commits already applied becoming
empty and skipped; the record goes once `refs/agentboard/migrating` has
been advanced. The cherry-pick runs without `--no-verify` (git takes no
such option on `cherry-pick` and exits 129 on it; implementer decision,
round 4): the host's hooks are kept out of it by the runner's
`core.hooksPath`, as every other git command of the move. A replay the
move itself left half done (round 5 rulings 1 and 2: a kill between two
picks of a multi-commit replay leaves git's `sequencer` directory alone,
a kill while a pick is committed leaves `CHERRY_PICK_HEAD` too, and
both count as a cherry-pick in progress, as `CHERRY_PICK_HEAD` alone
does) is not a dead end and not a human's: when nothing is unmerged, the
index equals HEAD and the working tree is clean (`git diff --quiet` as
well as `git diff --cached --quiet`; round 6 ruling 2), the re-run runs
`git cherry-pick --quit` in the worktree (HEAD and the picks already
made stay), then adopts it and replays again from the integrated tip,
the picks already made becoming empty and skipped, so a kill anywhere in
a replay is completed by the re-run with every event, each once. A
stopped cherry-pick with an unmerged path, or with a resolution staged
and not continued, is a human's and stays, never quit, the refusal
naming `git cherry-pick --continue`, `git cherry-pick --abort` and, for
a pick git reports as empty, `git cherry-pick --skip` and `git commit
--allow-empty` (round 6 ruling 1); one with unstaged changes (a `git
reset` that left the conflict markers in the file) is never quit either:
while git's sequencer is still present (a reset on an earlier pick of
the sequence) it is that same human's conflict in progress and the same
`sync-in-progress` refusal, and once git has dropped its cherry-pick
state (a reset on the last pick) it is the dirty worktree described
below (orchestrator ruling, round 6); the hints of `sync-conflict`
and `sync-in-progress` from `init` name `git cherry-pick --continue`
beside `git rebase --continue` (round 5 ruling 4). The move itself skips
a pick only on git's own empty stop (`CHERRY_PICK_HEAD` present, nothing
unmerged, the index equal to HEAD); any other stop of its replay (a pick
refused over a local change of a tracked file) is exit 3 `sync-failed`
with the sequencer quit, the replay record removed and the temporary
kept adoptable, so no commit of the range is ever dropped and the `sync`
of step 7 never commits or publishes a conflict marker. For the same
reason an adopted worktree with an unstaged change to a tracked file and
no cherry-pick state left (a `git reset` on the last pick of a sequence
also removes git's cherry-pick state, leaving the markers in a worktree
with no `CHERRY_PICK_HEAD` and no `sequencer`; an edit by hand) is exit 3
`sync-failed` naming the files and the steps (commit, stash or discard
them, then `agentboard init --into-host` again) before anything is quit,
replayed or carried over, the worktree kept adoptable, HEAD, the refs
and `.board` untouched (implementer decision, round 6). A replay counts
as integrated up to its recorded tip whenever every event file the range
adds is in HEAD, whether or not HEAD moved (round 6 ruling 1): a conflict
the human resolved by keeping our side leaves an empty pick, which they
skip, and the re-run then completes instead of replaying the same commit
and conflicting forever. Before a
replay, every untracked `events/*.json` of the worktree whose content
equals the fresh tip's blob of the same path is removed (round 5 ruling
3): the step 5 carry-over of an earlier run that stopped before the
rename leaves such files, the standalone board commits them since, and
git refuses to let a pick overwrite an untracked file even with identical
content; the pick re-creates them, and anything the fresh tip lacks is
left for step 5. A temporary without the `agentboard-source` record
(older code; round 5 ruling 5) is this board's when the tip it
integrated is an ancestor of the fresh tip fetched from `.board`, else
it is removed and named like one of another board. Nothing the
human resolved is replayed; the resolution
stays the ancestor of the result. Then the re-run integrates the current
local and remote board refs as step 3 does (no-ops for what is already
integrated), then runs steps 4 to 7. Nothing a human resolved in a
temporary worktree is ever discarded. Only dead-pid temporaries with no
rebase or cherry-pick state and nothing integrated (HEAD still at the
temporary ref, or not registered at all), or made from another board,
are removed, and the output names them. A `worktree add` that fails for
any reason leaves nothing behind (round 4 ruling): a registration git
wrote before failing is removed, the directory and this run's refs go,
and the refusal is exit 3 `sync-failed` naming `agentboard init
--into-host`, so the re-run adds a fresh worktree at the same path.

Leftovers on a board already in the host (plain `init` and
`init --into-host`, round 3 rulings): both remove every dead-pid
temporary without rebase state under `migrating/`, whatever its HEAD (the
board is in place, there is nothing to adopt), naming it, and leave a
stopped rebase or a live pid alone. The `migrating` directory emptied by
that is removed only when no kept `standalone-*` repository exists; with
one it is the marker of a move whose `sync` has not completed (see
"Resuming"), and the two commands differ in what they do with it: plain
`init` never removes it and never finishes the move, it reports that an
`init --into-host` was interrupted before its sync completed and names
`agentboard init --into-host`; `init --into-host` resumes it (the
carry-over and the `sync`, both idempotent when nothing is pending, so a
marker left by a cleaned temporary beside an old kept repository costs one
no-op `sync`), and is `unchanged` only when the directory still holds a
temporary or no kept repository exists; in the latter case the emptied
directory is removed in that same run (round 4 ruling), so a plain `init`
afterwards finds no directory and reports no pending move.

A move whose init lock went stale while it stalled before its `worktree
add` (another `init --into-host` or `init` took the lock and finished,
deleting `refs/agentboard/migrating` and moving the board) refuses with
exit 3 `sync-failed` saying it lost its lock and naming
`agentboard init --into-host` (round 3 ruling), never with a raw git
failure; it leaves nothing behind, and the board the other init made is
untouched.

Step 5 is a carry-over, not a bare verification, as the repair of
decision 7: every event file of the old `.board/events` that the new
worktree lacks (written by a writer or a standalone `sync` after step 1)
is copied in when its content hashes to its name, and the `sync` of step
7 commits it; only a file whose content does not match its name (or whose
copy in the worktree differs) is exit 5 `integrity`, with nothing moved
and the temporary left for the re-run. Immediately before the rename,
step 6 re-checks that `.board` is still the standalone repository step 1
saw (the same resolved git directory, by realpath, device and inode; the
HEAD commit step 1 saw still an ancestor of, or equal to, its HEAD, so a
repository rebuilt at the same path with another history is refused even
where inode numbers are reused, while a standalone `sync` that committed
meanwhile is not a replacement; no host worktree registered there)
and refuses with exit 3 `sync-failed` otherwise, so a move that lost its
lock to a second one never renames the second move's worktree away. After
the `worktree move` the carry-over runs again from the kept repository,
for an event that landed in the old `.board` between step 5 and the
rename (the rename window). The `migrating` directory stays, empty, until
the `sync` of step 7 has completed: it marks a move whose publication is
not done.

Resuming: a re-run that finds `.board` missing and a registered worktree
under `<git common dir>/agentboard/migrating/` with a dead pid, no rebase
state and a HEAD equal to `refs/agentboard/board` finishes step 6 and
runs step 7 (`resumed`); one that finds `.board` a host-model board with
the empty `migrating` marker (a move killed between the `worktree move`
and the end of step 7, or whose `sync` failed) restores the lock when it
is missing, deletes `refs/agentboard/migrating` and
`refs/agentboard/migrating-fetch` when they still exist,
repeats the carry-over from the newest kept repository (the greatest
`standalone-*` name; with several kept repositories, from several moves
or a rollback, the others are left alone), runs
step 7 and reports `resumed` with the kept repository; only a board
without the marker is `unchanged`. The marker counts only with a kept
repository to carry over from (every move keeps one before it moves the
worktree into place): a `migrating` directory left empty by the removal
of dead temporaries on a board that was never moved is removed, and the
board is `unchanged`; beside a kept repository it is never removed by
plain `init`, only by the `sync` of a resumed move. When the `sync` of step 7 fails, the
move stays done, `init` exits with the sync's code and reason, and its
output still carries the move's lines (the kept repository, the old
remote) with `keptAt` and `oldRemoteUrl` in the `--json` error document.

Other details of step 1: a committed event file whose content differs
from its committed blob (a content-addressed file modified in place) is
exit 5 `integrity`, not `unsynced`; a standalone board with no commit yet
is exit 4 `unsynced`, telling the user to run `agentboard sync` first; a
host whose git directory is not in its working tree (a bare repository
with worktrees, a `--separate-git-dir` repository, a submodule) is exit 1
`no-host-repository`, as is a board found outside a git repository or
with `AGENTBOARD_DIR`; `git-too-old` is checked before everything else,
also outside a git repository and on a host-model board. The standalone
remote's tip is fetched with
`git fetch --no-tags <remote> +refs/heads/<branch>:refs/remotes/<remote>/<branch>`,
and step 2 fetches that tracking ref (`refs/heads/<branch>` without a
remote) from the standalone repository as a local path into the scratch
ref. In step 3 a host
remote whose `ls-remote` fails is treated as having no board ref, with a
warning naming it; the move completes and the `sync` of step 7 then fails
with exit 3 `sync-failed`, the move done, the next `sync` publishing. A
compare-and-swap failure in step 4 (the old value is the one read before
the rebases of step 3) leaves the old `.board` untouched, the host
`.gitignore` unwritten and the temporary worktree in place for the re-run
to adopt; a rebase that fails without a conflict, or a fetch of the
remote's ref that fails after the `ls-remote`, removes the temporary (it
holds nothing a human did); `refs/agentboard/board` keeps whatever value
step 4 gave it (a correct board history either way).

The old repository is kept rather than deleted: it is the only copy of
anything a bug in steps 2 to 5 might miss, and inside the git directory it
costs nothing visible. The output names it and the old remote's URL as
written in the board's configuration (the raw `remote.<name>.url`, so a
URL rewritten by `insteadOf` is reported the way the user wrote it). With
`--json` the document is the ten keys of `init` plus `action` (`moved`,
`resumed`, `unchanged` for a board already in the host, `repaired` for a
broken link repaired as `init` does), `keptAt`, `oldRemoteUrl` and `sync`
(the result of step 7, null when no `sync` ran).

### 10. Showing the configuration: `agentboard remote`

A new read-only command, CLI-only. Alternatives considered:

- **Extend the "board already exists" output of `init`.** `init` does
  report the model now (decision 7), but asking people to run a setup
  command to inspect a board is not discoverable and reads as risky.
- **A line in `health`.** `health` is about tickets and is an MCP tool;
  the remote and its URL are host configuration that agents do not need.
- **`sync --dry-run`.** Would have to contact the network to be honest
  about what sync would do, and mixes inspection into a command that
  writes.

`remote` mirrors `git remote` in name, never contacts the network, always
exits 0 on an existing board and puts problems in its output, so it is safe
to run when something is wrong.

### 11. MCP

`remote` is added to `EXCLUDED_COMMANDS` with `init` and `sync`: all three
run git against the host's configuration and network, which a tool call
from any agent must not do. The new flags of `init` need no MCP handling.

## Risks / Trade-offs

- [A board in a public repository is public: anyone who can clone can
  `git fetch origin refs/agentboard/board`.] -> `init` says the board is
  shared with everyone who can fetch the remote; README explains
  `init --remote` for keeping it separate; the ADR records it.
- [`git push --mirror` from a stale clone force-rewinds the remote ref.]
  -> Every other clone's next `sync` rebases its own commits onto the
  rewound ref and pushes them back, so only events whose sole copy was on
  the remote are lost; README warns against `--mirror` pushes from working
  clones. `git clone --mirror` and `push --mirror` for backups carry the
  board, which is intended.
- [Hosts that refuse custom refs.] GitHub and GitLab accept pushes to
  `refs/agentboard/*` (only their own namespaces such as `refs/pull/*` and
  `refs/merge-requests/*` are reserved), and neither applies branch
  protection or rulesets to it. Gerrit needs a push permission on the
  namespace. -> A rejected first push is an ordinary `sync-failed` naming
  git's error; README points such hosts at `init --remote`.
- [Forks do not copy custom refs.] A GitHub fork starts without the board.
  -> Expected: a fork is a different project; it can join the upstream's
  board by setting `agentboard.remote`.
- [The `.board` worktree shows up in `git worktree list` and in IDEs that
  list worktrees.] -> It is locked with a reason that names agentboard;
  README explains it.
- [Shallow or partial host clones.] Fetching the board ref into a shallow
  clone fetches the board's whole history (the depth applies only to the
  refs it was given); a partial clone fetches board blobs on checkout. ->
  Covered by one test each in group 3.
- [Older agentboard versions on another machine] see a host-model `.board`
  as a board, but their `sync` refuses the detached HEAD (exit 3). ->
  Documented as an upgrade requirement; no event is ever lost.
- [A user deletes `refs/agentboard/board` by hand while `.board` exists.]
  -> The worktree's HEAD still holds the commits; the next `sync`'s
  compare-and-swap creates the ref again from HEAD.

## Migration Plan

- Existing boards are standalone and stay so; nothing changes for them on
  upgrade.
- Users move a board with `agentboard init --into-host` in each clone,
  first clone first; the old remote can be retired once every clone has
  moved (`agentboard remote` in each clone shows its model).
- Rollback of a move: unlock and remove the `.board` worktree, move the
  kept `standalone-<timestamp>` directory back to `.board`, copy in any
  event files written since (content-addressed, so copying is safe), and
  delete `refs/agentboard/board` locally and on the remote if wanted.
- This repository keeps its own board standalone, in a private
  repository attached with `init --remote`, so that the board is not
  published with the public host (tasks.md, workflow follow-up).

## Overlap with in-flight changes

- `add-harness-integration` (PR #67, draft) changes `init` too: `init
  [--agents | --no-agents]` offers `agents install` after the board is
  created. The flags are independent; the combined synopsis is
  `init [--agents | --no-agents] [--remote <url> | --into-host]`, and the
  offer runs after the sharing step, including after a join or a move.
  Both changes edit `src/board/init.ts` and the `init` registry entry, and
  both restate `board-cli` "Command surface" and "MCP server" (`hook` and
  `remote` are each added to the exclusion list). `add-harness-integration`
  also restates "Exit codes"; this change adds reasons only within the
  existing exit code classes and does not restate it.
- `add-claim-leases` restates "Command surface" and "MCP server" as well.
- Whichever of the three is archived later re-syncs both requirements with
  the main spec first, keeping the other changes' additions.

## Open Questions

- Whether `init` should write the ignore entry to the host's
  `.git/info/exclude` instead of `.gitignore` for host-model boards, so a
  project whose collaborators do not all use agentboard carries no
  agentboard line. Deferrable: either works with this design, and the spec
  keeps today's `.gitignore` rule.
