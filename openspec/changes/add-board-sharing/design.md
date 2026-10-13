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

The create-only `update-ref` makes two racing `init`s agree on the ref,
but not on the worktree: two concurrent `git worktree add` of one path can
both pass git's non-empty check and register two worktrees (`-board` and
`-board1`) for `.board`. So the host-model steps of `init` (finding or
making the ref, adding and locking the worktree, repairing a broken link)
run under a pid lock file `<git common dir>/agentboard/init.lock`, removed
when `init` is done. A lock whose pid is not running, or which is older
than 60 seconds, is stale and is broken by the next `init`, so a killed
`init` never blocks the one that completes the board. The lock lives
inside the git directory, where the host's `git status` never shows it.

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

### 4. Host-model sync

Same entry point and result shape as today, with `model: "host"` and
`ref` added to the JSON. Every git command runs in `.board` with the
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

Preconditions: git present and at least 2.32; model `host` (a broken link
is exit 2 `board-link-broken`); no rebase, merge or cherry-pick in progress
in the worktree's git directory (exit 3 `sync-in-progress`); HEAD detached
(exit 3 `board-on-branch`); committed event files present (exit 5
`integrity`).

Steps:

1. Stage and commit exactly as ADR 0005 (`--no-verify`, own paths only).
2. Integrate the local ref: if `refs/agentboard/board` is not an ancestor
   of HEAD, `git rebase --no-verify refs/agentboard/board` (conflict:
   exit 3 `sync-conflict`). Then `update-ref` with the old value read
   before the rebase; a failed compare-and-swap repeats this step once,
   then exits 3 `sync-failed`.
3. Remote: chosen as in board-concurrency "Sync converges". No remote ends
   here, exit 0. The main worktree's branch is used for the upstream rule
   (not the branch of the linked worktree the command happens to run in)
   so every agent on the board picks the same remote.
4. Fetch: `git fetch --no-tags <remote> refs/agentboard/board`. With no
   destination in the refspec the result lands in the worktree's own
   `FETCH_HEAD` (per worktree, so it never disturbs the main checkout's)
   and no remote-tracking ref is written; `fetch.prune` cannot prune
   anything. A missing remote ref (fresh remote) skips to step 6.
5. If `FETCH_HEAD` is not an ancestor of HEAD:
   `git rebase --no-verify FETCH_HEAD`, then `update-ref` as in step 2.
   Histories with different roots (a board created offline meeting a
   migrated one) rebase the same way: the empty-board root only adds the
   same `.gitignore` and `.gitkeep`, which git applies cleanly and drops,
   as the verification above showed; a differing `.gitignore` is an
   ordinary conflict.
6. Push: `git push --porcelain --no-verify <remote> HEAD:refs/agentboard/board`
   (never `--force`). A rejection retries once from step 4; a second
   rejection or any other failure is exit 3 `sync-failed`.
7. Catch up the cache, report arrivals as today.

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
half-made board is never mistaken for a board.

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
`<git common dir>/agentboard/stale-board-<UTC timestamp>`, and the fresh
worktree is moved into place with `git worktree move`, then locked.

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
   `refs/agentboard/migrating` (a reserved, temporary ref).
3. Add a worktree at `<git common dir>/agentboard/migrating` on it, and
   integrate the local `refs/agentboard/board` and the host remote's
   `refs/agentboard/board` when they exist, with the rebase of decision 4
   (a conflict stops with exit 3, the old `.board` untouched, and the
   message naming the temporary worktree).
4. `update-ref refs/agentboard/board` to the result (compare-and-swap
   against the value seen in step 3) and delete `refs/agentboard/migrating`.
5. Verify every `events/*.json` of the old `.board` is in the new worktree
   with identical bytes (exit 5 `integrity` otherwise, nothing moved).
6. Rename the old `.board` to
   `<git common dir>/agentboard/standalone-<UTC timestamp>` (same file
   system, atomic), `git worktree move` the temporary worktree to `.board`,
   lock it.
7. `sync` (publishes the ref) and catch up the cache.

Resuming: a re-run that finds `.board` missing and a registered worktree
at `<git common dir>/agentboard/migrating` whose HEAD equals
`refs/agentboard/board` finishes step 6; one that finds the temporary
worktree while the old `.board` is still standalone removes it (it holds
nothing that is not in the old board or the refs) and starts again.

The old repository is kept rather than deleted: it is the only copy of
anything a bug in steps 2 to 5 might miss, and inside the git directory it
costs nothing visible. The output names it and the old remote's URL.

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
