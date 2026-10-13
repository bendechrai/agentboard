## MODIFIED Requirements

### Requirement: Command surface
The CLI SHALL provide: `init [--remote <url> | --into-host]`; `new <title> [--description] [--label]...
(--task <source>:<ref>#<item> | --change <name> --group <n> | --adhoc <reason>)
[--checklist <line>]...`; `show <id>`;
`list [--status] [--assignee] [--task <source>:<ref>[#<item>]] [--change <name>] [--label] [--closed]`;
`claim <id> --as <actor>`; `release <id> --as <actor>`;
`move <id> <status> --as <actor>`; `comment <id> --as <actor> <text>`;
`handoff <id> --as <actor> --to <actor> --status <status> --note <text>`;
`link <id> --as <actor> (--task <source>:<ref>#<item> | --change <name> --group <n> | --pr <ref> | --decision <path>)`;
`checklist tick <id> <index> --as <actor>` and `checklist untick`;
`close <id> --as <actor> (--decision-recorded-in <path> | --no-decision)`;
`inbox --as <actor> [--since <cursor>] [--peek]`; `watch --as <actor>`;
`rebuild [--check]`; `sync`; `remote`; `import-change <name>`; `close-merged`;
`serve [--port <port>] [--open | --no-open] [--as <actor>]`; `top`;
`health [--stale-after <duration>] [--blocked-after <duration>] [--check]`;
`mcp`; and `version`. Every command SHALL
accept `--json`. An argument beginning with `--` is
always parsed as a flag; `--` on its own ends the flags, so free text that
begins with `-` (for example a comment) is given after it. Ticket ids MAY be
given as a unique prefix of at least 6 characters. `--change <name> --group
<n>` SHALL be exactly equivalent to `--task openspec:<name>#<n>`, and
`list --change <name>` to `list --task openspec:<name>`. Commands, their
arguments and flags SHALL be defined once, in a single command registry that
drives argument parsing and the MCP tool definitions, so the two surfaces
cannot drift. `serve` and `top` are streaming commands like `watch`:
`serve` runs until SIGINT or SIGTERM (see board-web), and `top` until the
user quits it or it receives SIGINT or SIGTERM (see board-tui). `init`,
`sync` and `remote` are the commands that run git on the board; they need
no actor (see "Initialising and joining a shared board").

#### Scenario: OpenSpec shorthand is the same task reference
- **WHEN** one ticket is created with `--change add-board-core --group 3` and another with `--task openspec:add-board-core#3`
- **THEN** both tickets carry the identical task reference `openspec:add-board-core#3`

#### Scenario: Malformed task reference
- **WHEN** `agentboard new "x" --task add-board-core-3 --as a` runs
- **THEN** the command exits 1 and shows the `<source>:<ref>#<item>` form

#### Scenario: Prefix resolves a ticket
- **WHEN** `agentboard show 01J9K3` runs and exactly one ticket id starts with `01J9K3`
- **THEN** that ticket is shown

#### Scenario: Ambiguous prefix is refused
- **WHEN** a prefix matches two tickets
- **THEN** the command exits 1 and lists both full ids

#### Scenario: Top has help
- **WHEN** `agentboard help top` runs with no board and no actor
- **THEN** it prints the synopsis, the exit codes including 1 `not-a-tty` and 2, and an example that parses to `top`, and exits 0

#### Scenario: Serve has help
- **WHEN** `agentboard help serve` runs with no board and no actor
- **THEN** it prints the synopsis with `--port`, `--open`, `--no-open` and `--as`, the exit codes including 1 `port-in-use` and 2, and an example that parses to `serve`, and exits 0

#### Scenario: Health has help
- **WHEN** `agentboard help health` runs with no board and no actor
- **THEN** it prints the synopsis with `--stale-after`, `--blocked-after` and `--check`, and an example that parses to `health`, and exits 0

#### Scenario: Init has help for sharing
- **WHEN** `agentboard help init` runs with no board and no actor
- **THEN** it prints `--remote` and `--into-host`, says they are mutually exclusive, lists the exit codes including 1 `ambiguous-remote`, 3 `remote-unreachable` and 4 `unsynced`, and has an example for each flag that parses, and exits 0

#### Scenario: Remote has help
- **WHEN** `agentboard help remote` runs with no board and no actor
- **THEN** it prints the synopsis, says the command never contacts the network, lists exit code 2, has an example that parses to `remote`, and exits 0

### Requirement: MCP server
`agentboard mcp` SHALL serve an MCP server over stdio exposing one tool per
command in the registry except `init`, `watch`, `serve`, `top`, `rebuild`,
`sync`, `remote`, `mcp` and `version`, which are setup, streaming or maintenance commands run
by a human or an orchestrator in a shell. Tool names SHALL be the command name with
spaces and hyphens replaced by underscores and prefixed `board_` (for
example `board_claim`, `board_checklist_tick`, `board_import_change`). Each
tool's input schema SHALL be generated from the registry, with the same
required arguments and the same validation as the CLI; `--json` is implied.
Writing tools SHALL take the actor as an `as` argument, falling back to the
actor given to the server as `agentboard mcp --as <actor>`, then to the
server process's `AGENTBOARD_ACTOR`, and SHALL fail exactly as the CLI does
when none is present. A successful call SHALL return the same JSON document
the CLI prints with `--json` as a text content item, and as structured
content: the document itself when it is an object, or `{items: <array>}`
when it is an array (MCP structured content must be an object). A call to an
unknown or excluded tool name SHALL return a tool error with `exitCode` 1
and `reason` `usage`, not a protocol error. A failed call
SHALL return a tool error (`isError` true) whose structured content is
`{exitCode, reason, message}`, where `exitCode` is the code the CLI would
have exited with and `reason` is the rejection reason where one exists (for
example `already-assigned`). The server SHALL locate the board once at
start-up by the same discovery rules, and SHALL fail to start, exiting 2,
when no board is found. Every tool call SHALL run the same single-transaction
path as the CLI, so concurrent CLI and MCP writers obey the same guarantees.

#### Scenario: Tools are listed from the registry
- **WHEN** an MCP client connects and lists tools
- **THEN** the list contains `board_new`, `board_show`, `board_list`, `board_claim`, `board_release`, `board_move`, `board_comment`, `board_handoff`, `board_link`, `board_checklist_tick`, `board_checklist_untick`, `board_close`, `board_inbox`, `board_import_change`, `board_close_merged` and `board_health`, and no tool for `init`, `watch`, `serve`, `top`, `rebuild`, `sync`, `remote`, `mcp` or `version`

#### Scenario: Rejection maps to a tool error
- **WHEN** `board_claim` is called on a ticket assigned to `impl` with `as` set to `reviewer`
- **THEN** the call returns a tool error with `exitCode` 4, `reason` `already-assigned` and a message naming `impl`, and no event is written

#### Scenario: Round trip through the server
- **WHEN** a client calls `board_new`, `board_claim`, `board_handoff` and `board_show` in turn
- **THEN** `board_show` returns the same JSON that `agentboard show <id> --json` prints for that ticket

#### Scenario: No board at start-up
- **WHEN** `agentboard mcp` starts where discovery finds no board
- **THEN** it exits 2 naming the path it looked at, before serving any request

#### Scenario: Excluded serve tool
- **WHEN** an MCP client calls the tool `board_serve`
- **THEN** the call returns a tool error with `exitCode` 1 and `reason` `usage`

#### Scenario: Excluded top tool
- **WHEN** an MCP client calls the tool `board_top`
- **THEN** the call returns a tool error with `exitCode` 1 and `reason` `usage`

#### Scenario: Excluded remote tool
- **WHEN** an MCP client calls the tool `board_remote`
- **THEN** the call returns a tool error with `exitCode` 1 and `reason` `usage`

#### Scenario: Health is a tool
- **WHEN** an MCP client lists tools
- **THEN** `board_health` is listed with the optional properties `stale-after`, `blocked-after` and `check`

## ADDED Requirements

### Requirement: Initialising and joining a shared board
`agentboard init` without flags SHALL need no actor and SHALL behave as
follows (board-events "Board directory per project" says which model it
creates):

- When a healthy board exists, it SHALL change nothing and report the
  model, where the history lives (`refs/agentboard/board` or the branch of
  the board repository) and the remote `sync` would use, with one
  exception: a host-model worktree that is not locked (an `init`
  interrupted after `git worktree add`) is locked again, and the message
  says so. For a standalone board inside a git repository with git 2.32
  or later it SHALL also suggest `agentboard init --into-host`.
- When a host-model board's link is broken (board-events "Board model
  detection"), or `.board` exists inside a host with an in-tree git
  directory but is not a repository (it holds event files without a
  `.git`, or is a stray directory), it SHALL repair it: first by asking git to repair the
  worktree link, only when the board's `.git` file names a git directory
  that is missing (which fixes a moved host; a copied board whose named
  directory still exists in another clone is never repaired that way,
  because git would relink that clone's worktree to the copy); when that
  is not enough, by
  creating a fresh worktree from the best history available (the local
  `refs/agentboard/board`, else the remote's, else a new empty board),
  copying into its `events/` every event file of the old directory that it
  lacks, keeping the old directory at
  `<host git common dir>/agentboard/stale-board-<UTC timestamp>`, and moving
  the fresh worktree into place. Copied event files are committed by the
  next `sync`. The repair step applies only to a broken link; a
  non-repository `.board` goes straight to the fresh worktree. A re-run
  after a repair interrupted between keeping the old directory and moving
  the fresh worktree into place SHALL move it into place, report the kept
  `stale-board-<UTC timestamp>` copy and set `repair` in its `--json`.
- When no board exists and a host-model board is to be created, it SHALL
  choose the remote with the rules of board-concurrency "Sync converges"
  (several remotes and none chosen: exit 1 with reason `ambiguous-remote`,
  creating nothing), then create the worktree from the first of: the local
  `refs/agentboard/board`; the remote's `refs/agentboard/board`, fetched
  into the local ref (joining the shared board); a new empty board. When
  the remote cannot be reached it SHALL warn, naming the remote and that
  the next `sync` joins any board there, and create a new empty board.
  After joining it SHALL fold the board's events into the cache and report
  how many there are. A board re-created from the local
  `refs/agentboard/board` (the directory was deleted) SHALL say that it was
  restored from the local ref, with the number of event files, never that
  it is a new empty board.
- `init` without flags SHALL never push; the first `sync` publishes a new
  board.
- An interrupted `init` SHALL be completed by running `init` again.

With `--json`, `init` SHALL print one object with at least `dir`,
`created`, `model` (`host` or `standalone`), `joined` (true when the board
came from the remote), `remote` (the chosen remote's name, or null),
`events` (the number of event files in the board), `hostGitignore`,
`warnings`, `repair` (what a repair did, or null) and `message`.

#### Scenario: Init in a git host with no remote
- **WHEN** `agentboard init` runs in a git repository with no remote and no board
- **THEN** it creates a host-model board, exits 0, reports `model` `host`, `joined` false and `remote` null, and says that `sync` publishes the board once the repository has a remote

#### Scenario: Init joins the board from the remote
- **WHEN** clone A has synced a host-model board with five events to `origin`, and `agentboard init` runs in a fresh clone B of the project
- **THEN** B's `refs/agentboard/board` equals A's, `.board` is a worktree at it, `agentboard list` in B shows A's tickets without running `sync`, and the output reports `joined` true, `remote` `origin` and five events

#### Scenario: Init where the remote has no board
- **WHEN** `agentboard init` runs in a clone whose `origin` has no `refs/agentboard/board`
- **THEN** it creates a new empty host-model board, pushes nothing, and reports `joined` false and `remote` `origin`

#### Scenario: Init with an unreachable remote
- **WHEN** `agentboard init` runs in a clone whose `origin` cannot be reached
- **THEN** it creates a new empty host-model board, exits 0 with a warning naming `origin`, and a later `sync` with `origin` reachable joins the board there with no conflict

#### Scenario: Init with several remotes and no choice
- **WHEN** `agentboard init` runs in a repository with the remotes `fork` and `upstream`, no `origin`, no upstream on the main checkout's branch and no `agentboard.remote`
- **THEN** it exits 1 with reason `ambiguous-remote` and creates nothing, not even the host `.gitignore` entry

#### Scenario: Init after the board directory was deleted
- **WHEN** a host-model `.board` was deleted with `rm -rf` and `agentboard init` runs
- **THEN** the board is re-created from the local `refs/agentboard/board` with every committed event, and the worktree is registered and locked again

#### Scenario: Init repairs a moved host
- **WHEN** the host checkout with its host-model board is moved to another directory and `agentboard init` runs there
- **THEN** `.board` is linked to the moved repository again, nothing is copied or kept aside, and `sync` works

#### Scenario: Init repairs a stale board copied into a fresh clone
- **WHEN** a host-model `.board` holding an event file that was never synced is copied from clone A into a fresh clone C and `agentboard init` runs in C
- **THEN** `.board` in C is a worktree of C at the board joined from `origin`, its `events/` also holds the unsynced file, the copied directory is kept under C's `<git common dir>/agentboard/`, and clone A is unchanged

### Requirement: Board in a separate repository
`agentboard init --remote <url>` SHALL set up a standalone board shared
through the repository at `<url>`, need no actor, and leave the host
repository's refs untouched:

- When `.board` does not exist: if `<url>` is a local path (an absolute or
  relative path, or a `file://` URL) that does not exist, it SHALL first
  create a bare repository there. If the repository at `<url>` cannot be
  read, it SHALL exit 3 with reason `remote-unreachable`, quoting git's
  error and telling the user to create an empty repository at `<url>` (for
  example on their git host) and check their access, and SHALL create
  nothing. If the repository has a branch, it SHALL clone it into `.board`
  (its default branch) and fold the events; when that branch has no
  `events/` directory it SHALL exit 1 with reason `not-a-board` and leave
  no `.board` behind. If the repository has no refs, it SHALL create a
  standalone board, add `<url>` as `origin`, and `sync` (which pushes and
  sets the upstream).
- When `.board` is a standalone board with no remote, it SHALL add `<url>`
  as `origin` and `sync`.
- When `.board` is a standalone board whose chosen remote already has the
  URL `<url>`, it SHALL change nothing and exit 0. When the remote has
  another URL, it SHALL exit 1 with reason `remote-mismatch`, naming both
  URLs and `git -C .board remote set-url`.
- When `.board` is a host-model board, it SHALL exit 1 with reason
  `board-in-host` and change nothing.

When the `sync` that `init --remote` runs fails, `init` SHALL exit with that
failure's code and reason, keeping the board and the remote it set.

#### Scenario: Init with a remote that has a board
- **WHEN** a standalone board with three events has been pushed to `<url>` and `agentboard init --remote <url>` runs in another clone with no `.board`
- **THEN** `.board` is a clone of `<url>`, `agentboard list` shows the three events' tickets, and `sync` exits 0

#### Scenario: Init with an empty remote
- **WHEN** `agentboard init --remote <url>` runs with no `.board`, and `<url>` is an empty repository
- **THEN** `.board` is a standalone board with `origin` set to `<url>`, and `<url>` has a branch holding `.gitignore` and `events/.gitkeep`

#### Scenario: Init with a local path that does not exist
- **WHEN** `agentboard init --remote ../boards/project.git` runs and `../boards/project.git` does not exist
- **THEN** `../boards/project.git` is created as a bare repository, the board is pushed to it, and the command exits 0

#### Scenario: Init with a non-local URL that does not exist
- **WHEN** `agentboard init --remote https://git.example.com/me/missing.git` runs and the repository cannot be read
- **THEN** the command exits 3 with reason `remote-unreachable`, the message tells the user to create the empty repository, and no `.board` directory or host `.gitignore` entry was created

#### Scenario: Init with a remote on an existing board without one
- **WHEN** a standalone board with unsynced events and no remote exists and `agentboard init --remote <empty url>` runs
- **THEN** `origin` is set to the URL, the events are committed and pushed, and the command exits 0

#### Scenario: Init with a remote on a host-model board
- **WHEN** `.board` is a host-model board and `agentboard init --remote <url>` runs
- **THEN** it exits 1 with reason `board-in-host` and nothing changes

#### Scenario: Remote flags are exclusive
- **WHEN** `agentboard init --remote <url> --into-host` runs
- **THEN** it exits 1 with reason `usage` and nothing changes

### Requirement: Moving a standalone board into the host repository
`agentboard init --into-host` SHALL move a standalone board into the host
model, keeping its whole history, as board-concurrency "Moving a board into
the host repository loses no event" requires. It SHALL need no actor and
git 2.32 or later (else exit 1 with reason `git-too-old`). It SHALL exit 1
with reason `no-host-repository` when the board was not found through a
git repository (outside a git repository, or with `AGENTBOARD_DIR` set),
and exit 2 when there is no board. On a host-model board it SHALL change
nothing and exit 0 (repairing a broken link as `init` does). After the
move it SHALL run `sync`, so the board is published on the host's remote;
when that `sync` fails, the move stays done and `init` exits with the
failure's code and reason. Its output SHALL name the kept old repository,
the old remote's URL, and say that every other clone runs
`agentboard init --into-host` too and that the old remote can be retired
once they have.

#### Scenario: Move reports what it kept
- **WHEN** `agentboard init --into-host` moves a standalone board whose remote is `git@example.com:me/board.git`
- **THEN** the output names the kept repository's path, `git@example.com:me/board.git`, and `agentboard init --into-host` for other clones

#### Scenario: Move outside a git repository
- **WHEN** `agentboard init --into-host` runs in a directory that is not inside a git repository
- **THEN** it exits 1 with reason `no-host-repository` and nothing changes

### Requirement: Showing how a board is shared
`agentboard remote` SHALL print how the board is shared, need no actor,
never contact the network and never change anything. It SHALL report: the
board directory; the model (`host`, `standalone`, `broken host link` or
`not a repository`); where the history lives (the host repository's git
directory and `refs/agentboard/board` with its commit, or the board
repository and its branch); the remote `sync` would use with its URL and
the rule that chose it (`agentboard.remote`, upstream, `origin` or only
remote), or that there is none, or that the choice is ambiguous and how to
set `agentboard.remote`; and every remote of that repository with its URL.
For a broken link or an ambiguous choice it SHALL say how to fix it. It
SHALL exit 0 whenever a board exists, and 2 when there is none. With
`--json` it SHALL print one object with at least `dir`, `model`, `gitDir`,
`ref` (host model, else null), `refCommit` (host model: the commit
`refs/agentboard/board` points to, null when the ref is missing; null for
every other model), `branch` (standalone model, else null), `head`,
`remote` (`{name, url, rule}` or null), `remotes` and `problems`. The
`rule` SHALL be one of the literal tokens `agentboard.remote`, `upstream`,
`origin` or `only`. `remote` SHALL never open the board, so it creates no
cache file and its only exit codes are 0, 1 (usage) and 2 (no board). When
`agentboard.remote` names a remote the repository does not have, `remote`
SHALL still report it as the chosen remote (`url` null) and list a problem
naming it and the remotes that exist. When git cannot be run at all,
`remote` SHALL still exit 0, reporting the model as `not a repository`,
every git-derived field null or empty, and one problem that names git. For
a broken link or a non-repository it SHALL print only the board directory,
the model and its problems.

#### Scenario: Remote on a host-model board
- **WHEN** `agentboard remote` runs on a host-model board whose host repository's main checkout tracks `origin/main`
- **THEN** it prints the model `host`, `refs/agentboard/board` with its commit, `origin` with its URL chosen as the upstream, and exits 0 without contacting `origin`; with `--json`, `refCommit` is that commit and `remote.rule` is `upstream`

#### Scenario: Remote with agentboard.remote naming a missing remote
- **WHEN** `agentboard remote --json` runs on a board whose repository has only `origin` and `agentboard.remote` set to `nope`
- **THEN** `remote` is `{"name": "nope", "url": null, "rule": "agentboard.remote"}`, `problems` holds one line naming `nope` and `origin`, and the command exits 0

#### Scenario: Remote when git cannot be run
- **WHEN** `agentboard remote` runs on an existing board with no `git` on the PATH
- **THEN** it exits 0, reports the model `not a repository`, no history, remote or remotes, and one problem that names git

#### Scenario: Remote on a standalone board without a remote
- **WHEN** `agentboard remote --json` runs on a standalone board with no remote
- **THEN** stdout is one JSON object with `model` `standalone`, the branch, `remote` null and `remotes` empty

#### Scenario: Remote on a broken link
- **WHEN** `agentboard remote` runs on a host-model board whose link is broken
- **THEN** it reports the model `broken host link`, names `agentboard init` as the repair, and exits 0
