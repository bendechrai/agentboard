## MODIFIED Requirements

### Requirement: Board directory per project
Each project SHALL have at most one board, stored in a directory named
`.board` at the root of the project's main checkout. A board's history
SHALL be versioned in git in one of two models:

- **Host model**: `.board` is a linked git worktree of the host project's
  repository, on a detached HEAD, and the board's history is the ref
  `refs/agentboard/board` in the host repository (see "Board ref in the host
  repository").
- **Standalone model**: `.board` is itself the top level of a git
  repository of its own, synced independently of the host project.

`agentboard init` without flags SHALL create a host-model board when it
runs inside a git repository (discovery source `git`) with git 2.32 or
later, and a standalone board otherwise: outside a git repository, when
`AGENTBOARD_DIR` is set, or when git is older than 2.32 (in which case it
SHALL say that the host model needs git 2.32 or later). `init --remote
<url>` SHALL always create a standalone board (see board-cli). An existing
board of either model SHALL keep its model until it is moved with
`init --into-host`. The host project SHALL ignore `.board/` in its own
`.gitignore`; `agentboard init` SHALL add that entry when it is missing,
before it creates the board, in both models.

#### Scenario: Init creates the board
- **WHEN** `agentboard init` runs at the root of a git repository with git 2.32 or later, no `.board` directory, no `refs/agentboard/board` and no remote
- **THEN** the host repository has a ref `refs/agentboard/board`, `.board` is a linked worktree of the host repository on a detached HEAD at that ref, containing an `events` directory with only an empty `.gitkeep` and a `.gitignore` that excludes the cache file, and the host project's `.gitignore` contains a `.board/` entry

#### Scenario: Init outside a git repository
- **WHEN** `agentboard init` runs in a directory that is not inside a git repository
- **THEN** a `.board` directory is created containing an initialized git repository of its own, an `events` directory containing only an empty `.gitkeep` and a `.gitignore` that excludes the cache file, no commit is made, and no host `.gitignore` is written

#### Scenario: Init with an old git
- **WHEN** `agentboard init` runs at the root of a git repository with no `.board` and git 2.31 is on the PATH
- **THEN** a standalone board is created as outside a git repository, the host `.gitignore` gains `.board/`, and the output says the host model needs git 2.32 or later

#### Scenario: Init is idempotent
- **WHEN** `agentboard init` runs where a healthy `.board` of either model already exists
- **THEN** nothing is created or modified and the command exits 0 with a message that the board already exists, naming its model

## ADDED Requirements

### Requirement: Board ref in the host repository
A host-model board's history SHALL be the commit history of the single ref
`refs/agentboard/board` in the host repository. Every ref under
`refs/agentboard/` is reserved for agentboard; agentboard SHALL never create
a branch (`refs/heads/*`) or tag for a board. The ref SHALL be the only
thing that keeps board commits reachable: when any agentboard command that
moves the worktree's HEAD completes (one that stops on a conflict for a
human has not completed), `refs/agentboard/board` SHALL equal that HEAD, so `git gc` in the host repository never loses a board commit even if
`.board` is removed. A new empty board's first commit SHALL be
deterministic: the tree holds `.gitignore` (the cache exclusions) and
`events/.gitkeep`, author and committer are
`agentboard <agentboard@localhost>` at time 0 (`1970-01-01T00:00:00Z`), and
the message is `agentboard: empty board`, so empty boards created
independently in clones of one project share their root commit. The
worktree SHALL be registered in the host repository and locked with the
reason `agentboard board` so `git worktree prune` and `git worktree remove`
leave it alone. Every git command agentboard runs against the host
repository for the board SHALL run with the host's git hooks disabled.
Apart from the `.board/` entry `init` adds to the host `.gitignore`,
agentboard SHALL never modify a branch, a tag, the index or the working
tree of any other worktree of the host. `git clone` of the host and `git fetch` without an
explicit refspec SHALL NOT transfer the board, because they only fetch
branches and tags.

#### Scenario: Plain clone does not fetch the board
- **WHEN** clone A of a project has pushed `refs/agentboard/board` to `origin` and someone runs `git clone <origin>` and then `git fetch origin`
- **THEN** the new clone has no ref under `refs/agentboard/`, no branch or tag was added for the board, and `git ls-remote origin refs/agentboard/board` still lists it

#### Scenario: Garbage collection keeps the board
- **WHEN** a host-model board has synced commits and `git gc --prune=now` runs in the host repository
- **THEN** every event file in the board's history is still readable from `refs/agentboard/board`

#### Scenario: Independent empty boards share their root
- **WHEN** two clones of a project each run `agentboard init` with no board on any remote
- **THEN** the root commits of their `refs/agentboard/board` have the same id

#### Scenario: Host hooks do not run for the board
- **WHEN** the host repository has a `pre-push` hook that fails and `agentboard sync` pushes a host-model board
- **THEN** the push succeeds and the hook did not run

#### Scenario: Worktree cleanup leaves the board alone
- **WHEN** `git worktree prune` runs in the host repository, and then `git worktree remove .board` without `--force`
- **THEN** `.board` is still registered and present, and the remove is refused because the worktree is locked

### Requirement: Board model detection
Every command that runs git on the board (`init`, `sync` and `remote`) SHALL
decide the board's model the same way. With `<parent>` the directory that
contains the board directory:

- **host**: the board directory is the top level of a linked worktree whose
  git common directory is the git common directory of `<parent>`;
- **standalone**: the board directory is the top level of a git repository
  whose git directory is inside the board directory;
- **broken host link**: the board directory contains a `.git` file whose
  target is missing, or is a linked worktree of a different repository than
  `<parent>`'s (the host was moved, or a `.board` was copied from another
  clone);
- **not a repository**: none of the above.

A board's model never affects commands that only read or write events. On
a broken host link, `sync` SHALL exit 2 with reason `board-link-broken`,
naming the directory and that `agentboard init` repairs it, and SHALL change
nothing.

#### Scenario: Stale board copied into a fresh clone
- **WHEN** a host-model `.board` directory is copied from clone A into a fresh clone C of the same project and `agentboard sync` runs in C
- **THEN** it exits 2 with reason `board-link-broken`, and neither clone's repository or board changed

#### Scenario: Board commands work on a broken link
- **WHEN** the host link is broken and `agentboard list` runs
- **THEN** it lists the tickets from the event files in `.board/events` and exits 0
