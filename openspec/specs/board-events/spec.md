# board-events Specification

## Purpose
Defines the on-disk event log that is the only source of truth for a board:
where `.board/` lives, how it is found, what an event file is, and how a
sequence of events folds into ticket state.

## Requirements

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
later and the host has an in-tree git directory: the parent of `.board`
(the parent of the git common directory) is the top level of a working
tree, and that working tree's git common directory is `<top level>/.git`,
compared as realpaths. It SHALL create a standalone board otherwise:
outside a git repository, when `AGENTBOARD_DIR` is set, when git is older
than 2.32 (in which case it SHALL say that the host model needs git 2.32
or later), or when the host's git directory is not in its working tree (a
bare repository with linked worktrees, a `--separate-git-dir` repository,
or a submodule whose git directory is `<superproject>/.git/modules/<name>`;
in which case it SHALL say that the host model needs the repository's
`.git` directory inside its working tree, naming the git directory found).
That decision is taken before anything is written. `init --remote <url>`
SHALL always create a standalone board (see board-cli). An existing board
of either model SHALL keep its model until it is moved with
`init --into-host`. The host project SHALL ignore `.board/` in its own
`.gitignore`; whenever the parent of `.board` is the top level of a
working tree (the host model, or a standalone fallback inside such a
repository), `agentboard init` SHALL add that entry when it is missing,
before it creates the board; outside a working tree (no git repository,
`AGENTBOARD_DIR`, or a parent that is a git directory's container) it
SHALL write no host `.gitignore`.

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
- **THEN** nothing is created or modified and the command exits 0 with a message that the board already exists, naming its model; the one exception is a host-model worktree that is not locked (an `init` interrupted after the worktree was added), whose lock `init` restores and reports

#### Scenario: Init in a host whose git directory is not in its working tree
- **WHEN** `agentboard init` runs with git 2.32 or later in a linked worktree of a bare repository, in a repository made with `git init --separate-git-dir`, or inside a submodule of a superproject
- **THEN** it creates a standalone board where discovery puts it, exits 0 with a message that the host model needs the repository's `.git` directory inside its working tree, writes no `.gitignore` outside a working tree, and creates no ref under `refs/agentboard/` and no worktree in the repository or the superproject

### Requirement: Board discovery from any worktree
Commands SHALL locate the board without being told where it is. Resolution
order SHALL be: the `AGENTBOARD_DIR` environment variable when set; otherwise,
when inside a git repository, `<git common dir>/../.board`, where the git
common dir is the value of `git rev-parse --git-common-dir` resolved to an
absolute path, so that every linked worktree of the same repository resolves
to the same board; otherwise `./.board` relative to the current directory.
As an exception, when the directory that would be the host root is itself a
board directory named `.board` (the command runs inside `.board` or below
it), that directory SHALL be the board. A
command other than `init` that resolves to a path with no board SHALL fail
with exit code 2 and a message naming the path it looked at.

#### Scenario: Linked worktree finds the main checkout's board
- **WHEN** a command runs inside a linked git worktree of a project whose main checkout contains `.board`
- **THEN** the command operates on the main checkout's `.board` directory

#### Scenario: Environment override wins
- **WHEN** `AGENTBOARD_DIR` is set to an existing board directory and the command runs inside a different git repository
- **THEN** the command operates on the board named by `AGENTBOARD_DIR`

#### Scenario: Missing board is reported
- **WHEN** `agentboard list` runs in a directory that is not inside a git repository and has no `./.board`
- **THEN** the command exits 2 and the error names the path `./.board`

### Requirement: Event files are immutable and content-addressed
Every change to the board SHALL be recorded as a new file under
`.board/events/` named `<sha256-hex>.json`, where the hash is the SHA-256 of
the file's bytes. The file content SHALL be the canonical JSON encoding of
the event: object keys sorted lexicographically at every level, no
insignificant whitespace, UTF-8, and a single trailing newline is NOT
included. An event file, once written, SHALL never be modified or deleted by
any command. Writing an event whose canonical bytes already exist SHALL be a
no-op that reports the existing file.

#### Scenario: Two identical events dedupe
- **WHEN** the same event (same canonical bytes) is written twice
- **THEN** exactly one file exists and the second write reports it as already present

Readers SHALL ignore every entry under `events/` whose name begins with `.`
(temporary files and placeholders such as `.gitkeep`). Any other name that
is not `<sha256-hex>.json` SHALL be reported as corrupt. A board SHALL be
considered to exist when `<board>/events` is a directory.

#### Scenario: Placeholder is not corrupt
- **WHEN** `events/` contains `.gitkeep` and valid event files
- **THEN** reading the log reports no corrupt file

#### Scenario: A mismatched file is rejected on read
- **WHEN** a file under `events/` has a name that is not the SHA-256 of its bytes
- **THEN** reading the log reports that file as corrupt with its path and does not fold it, and the rest of the log is still folded

### Requirement: Event envelope
Every event SHALL be a JSON object with these fields: `v` (schema version,
integer, 1 for this specification), `kind` (string), `ticket` (ULID string
identifying the ticket, present on every kind except `board.meta`), `actor`
(non-empty string naming the agent or human), `ts` (hybrid timestamp object
with `wall` milliseconds since the Unix epoch as an integer, `counter` as a
non-negative integer, and `actor` repeated, equal to the top-level `actor`),
and `body` (object whose shape depends on `kind`). Unknown top-level fields
SHALL cause the event to be reported as malformed and not folded. `ticket`
SHALL be absent on `board.meta`. For a kind not defined by this
specification, `ticket` SHALL be optional and, when present, SHALL be a
ULID, so that a later version can add board-level kinds.

#### Scenario: Well-formed event is accepted
- **WHEN** an event file contains all required fields with valid types
- **THEN** it is folded into ticket state

#### Scenario: Unknown kind without a ticket
- **WHEN** an event of an undefined kind `board.archive` has no `ticket` field and is otherwise well-formed
- **THEN** it is preserved and reported as unknown, not as malformed

#### Scenario: Missing actor is malformed
- **WHEN** an event file lacks the `actor` field
- **THEN** the event is reported as malformed with its path and reason and is not folded

### Requirement: Task reference
A ticket's link to the planning artifact it implements SHALL be a task
reference: an object with `source` (a lowercase identifier matching
`^[a-z][a-z0-9-]*$` naming the planning tool, `openspec` for OpenSpec),
`ref` (non-empty string naming the change, feature or plan within that
source; for `openspec`, the change directory name) and `item` (non-empty
string naming the unit of work within `ref`; for `openspec`, the task group
number in decimal, for example `"3"`). The event schema SHALL NOT interpret
`ref` or `item` beyond these type rules, so that a new source can be
supported without a schema version change. A task reference SHALL be
written in text form as `<source>:<ref>#<item>`, for example
`openspec:add-board-core#3`.

#### Scenario: Unknown source is accepted by the schema
- **WHEN** a `ticket.create` event carries the task reference `{source: "speckit", ref: "001-photo-albums", item: "phase-2"}`
- **THEN** the event is well-formed and folds, with the task reference stored as given

#### Scenario: Malformed source is rejected
- **WHEN** a task reference has `source` equal to `"Open Spec"`
- **THEN** the event is reported as malformed naming the `source` field

### Requirement: Event kinds
The following kinds SHALL be defined with these bodies:
`ticket.create` (title, optional description, optional labels array, optional
`task` reference, optional `adhoc` reason string, optional checklist array
of strings; `task` and `adhoc` SHALL NOT both be present);
`ticket.comment` (text);
`ticket.move` (to: status);
`ticket.assign` (to: actor);
`ticket.claim` (no body fields; the event's actor claims the ticket);
`ticket.release` (no body fields);
`ticket.handoff` (to: actor, status, note);
`ticket.link` (exactly one of: `task` reference, pr URL or number, decision path);
`ticket.close` (either `decision` path string or `noDecision` true);
`ticket.checklist` (index: integer, done: boolean);
`ticket.checklist.add` (items: non-empty array of objects with `text`, a
non-empty string, and `done`, a boolean; the fold appends them in order);
`board.meta` (key, value; board-level settings such as the default column
set). Bodies with extra fields SHALL be malformed.

#### Scenario: Handoff carries three effects
- **WHEN** a `ticket.handoff` event with to, status and note is folded
- **THEN** the ticket's assignee, status and comment list all reflect it, and no separate assign, move or comment event exists for it

#### Scenario: Checklist tick out of range
- **WHEN** a `ticket.checklist` event names an index beyond the ticket's checklist length
- **THEN** the event is reported as rejected with reason `checklist-index` and the ticket is unchanged

### Requirement: Unknown kinds are preserved
An event whose `kind` is not defined by this specification SHALL be kept in
the log, reported by `rebuild` and `show` as unknown with its kind and hash,
and SHALL NOT be dropped or treated as corrupt, so that a newer version of
the tool can fold it later.

#### Scenario: Newer event kind
- **WHEN** the log contains an event of kind `ticket.estimate` unknown to this version
- **THEN** folding completes, the ticket's known state is unaffected, and the unknown event is listed in the fold report

### Requirement: Deterministic ordering
Events SHALL be folded in ascending order of (`ts.wall`, `ts.counter`,
`ts.actor`, file hash). This order SHALL be total and independent of the
order in which files are read or of the filesystem's listing order.

#### Scenario: Same result from any read order
- **WHEN** the same set of event files is folded twice with the files presented in different orders
- **THEN** the resulting ticket states are byte-identical when serialized canonically

### Requirement: Hybrid timestamp construction
When a command writes an event, `ts.wall` SHALL be the current wall clock in
milliseconds and `ts.counter` SHALL be 0, except that if the board's latest
known event has a `ts.wall` greater than or equal to the current wall clock,
`ts.wall` SHALL be that latest value and `ts.counter` SHALL be the latest
counter plus one. Wall clock differences between machines therefore affect
display order only, never correctness.

#### Scenario: Clock moved backwards
- **WHEN** the latest event has wall 1000 counter 0 and the system clock reports 900
- **THEN** the new event has wall 1000 and counter 1

### Requirement: Fold semantics
Folding SHALL produce, per ticket: id, title, description, status, assignee,
labels, task reference or ad hoc reason, checklist with done flags, ordered comments (each
with actor, timestamp and text), links, closed flag with its decision record
path or explicit no-decision marker, `version` (the count of folded events
that changed the ticket), and `updated_at` (the timestamp of the last such
event). A `ticket.create` SHALL be the first event for its id; any other event
for an unknown ticket id SHALL be reported as rejected with reason
`unknown-ticket` and held aside. A second `ticket.create` for an existing id
SHALL be rejected with reason `duplicate-create`. A `ticket.move` to a status
not permitted by the state machine (see board-cli) SHALL be rejected with
reason `invalid-transition`; a `ticket.claim` on an assigned ticket SHALL be
rejected with reason `already-assigned`; a `ticket.release` by an actor other
than the assignee SHALL be rejected with reason `not-assignee`; a
`ticket.move` or `ticket.handoff` that would take a ticket with no task
reference into `implementing` SHALL be rejected with reason
`needs-task-link` (see board-openspec-integration). Rejected
events SHALL be listed in the fold report with hash, kind, ticket and reason
and SHALL never be deleted.

Where the requirements above leave a case open, the fold SHALL behave as
follows. A `ticket.close` on a ticket not in `merged` or `blocked`, or on an
already closed ticket, SHALL be rejected with reason `invalid-transition`.
Events after a close SHALL fold by their own rules (a comment on a closed
ticket is accepted; a move out of `merged` is still rejected). A task link
SHALL replace the ticket's task reference and clear its ad hoc reason; pr
and decision links SHALL be appended in fold order. `version` SHALL count
every applied event of a defined kind, including one that leaves the state
unchanged, such as ticking an already ticked checklist line. `board.meta`
events SHALL be stored in the board state's meta map and SHALL NOT change
the six statuses or the state machine. A ticket SHALL always be created in
`todo`; an import that needs another status writes the permitted moves.

#### Scenario: Close from implementing is refused
- **WHEN** a `ticket.close` is folded for a ticket in `implementing`
- **THEN** it is rejected with reason `invalid-transition`

#### Scenario: Concurrent claims fold to one winner
- **WHEN** two `ticket.claim` events for the same unassigned ticket exist with different timestamps
- **THEN** the earlier one in fold order assigns the ticket and the later one is reported as rejected with reason `already-assigned`

#### Scenario: Comment on unknown ticket is held
- **WHEN** a `ticket.comment` names a ticket id with no `ticket.create` in the log
- **THEN** the fold report lists it as rejected with reason `unknown-ticket` and no ticket is created

#### Scenario: Version counts effective events
- **WHEN** a ticket has one create, two comments and one rejected move
- **THEN** its version is 3 and its updated_at equals the timestamp of the second comment

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
leave it alone. `init` SHALL hold a pid lock file
`<git common dir>/agentboard/init.lock` while it finds or makes the ref,
adds and locks the worktree or repairs a broken link, removing it when
done, so two `init` processes racing on one host leave one ref and one
worktree; a lock whose pid is not running or that is older than 60
seconds SHALL be treated as stale and broken by the next `init`. Every git command agentboard runs against the host
repository for the board SHALL run with the host's git hooks disabled,
without writing the host's configuration: each command is given
`core.hooksPath` pointing at an empty directory `agentboard-no-hooks` that
agentboard creates under the board worktree's git directory (a temporary
directory when git cannot name it), and `git config core.hooksPath` in the
host is unchanged afterwards.
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
- **standalone**: the board directory is the top level of a repository that
  is not a linked worktree (its git common directory is its git directory,
  after resolving), whether `.git` is a directory or a file naming a git
  directory elsewhere (`git init --separate-git-dir`, a submodule of the
  host whose git directory is `<host>/.git/modules/<name>`);
- **broken host link**: the board directory contains a `.git` file whose
  target is missing, or is a linked worktree whose git common directory is
  not `<parent>`'s (the host was moved, or a `.board` was copied from
  another clone);
- **not a repository**: none of the above (no `.git`, or a plain
  subdirectory of the host repository).

Where a standalone board's git directory lies SHALL NOT change how it is
treated: `sync` and `remote` SHALL handle a standalone board whose `.git`
is a file exactly as one whose git directory is `.board/.git`, so every
board that synced before the host model existed keeps syncing unchanged.
A board's model never affects commands that only read or write events.
Detection decides the model of an existing board; `init` SHALL take the
host model for a new board only in a host with an in-tree git directory
(see "Board directory per project"), so a board that detection would
report as a worktree of a bare repository or of a superproject is never
created. On
a broken host link, `sync` SHALL exit 2 with reason `board-link-broken`,
naming the directory and that `agentboard init` repairs it, and SHALL change
nothing.

#### Scenario: Separate git directory is standalone
- **WHEN** `.board` was made with `git init --separate-git-dir <dir> .board` (its `.git` is a file naming a git directory outside `.board`), has `origin` configured and a new event file, and `agentboard sync` runs
- **THEN** the model is `standalone`, `sync` commits the event, pushes `main` to `origin` and exits 0, exactly as on a standalone board whose git directory is `.board/.git`

#### Scenario: Submodule board is standalone
- **WHEN** `.board` is a submodule of the host repository (its `.git` file names `<host>/.git/modules/.board`) and `agentboard remote` runs
- **THEN** it reports the model `standalone` with the git directory the `.git` file names, not a broken host link

#### Scenario: Stale board copied into a fresh clone
- **WHEN** a host-model `.board` directory is copied from clone A into a fresh clone C of the same project and `agentboard sync` runs in C
- **THEN** it exits 2 with reason `board-link-broken`, and neither clone's repository or board changed

#### Scenario: Board commands work on a broken link
- **WHEN** the host link is broken and `agentboard list` runs
- **THEN** it lists the tickets from the event files in `.board/events` and exits 0
