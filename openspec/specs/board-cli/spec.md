# board-cli Specification

## Purpose
Defines the `agentboard` command surface: commands, arguments, the ticket
status state machine, output conventions, exit codes, and the `mcp` server
that exposes the same operations as MCP tools.

## Requirements

### Requirement: Command surface
The CLI SHALL provide: `init [--remote <url> | --into-host]`; `new <title> [--description] [--label]...
(--task <source>:<ref>#<item> | --change <name> --group <n> | --adhoc <reason>)
[--checklist <line>]...`; `show <id>`;
`list [--status] [--assignee] [--task <source>:<ref>[#<item>]] [--change <name>] [--label] [--closed]`;
`claim <id> --as <actor>`; `release <id> --as <actor>`;
`move <id> <status> --as <actor> [--task <source>:<ref>#<item> | --change <name> --group <n> | --unplanned <reason>]`;
`comment <id> --as <actor> <text>`;
`handoff <id> --as <actor> --to <actor> --status <status> --note <text>`;
`link <id> --as <actor> (--task <source>:<ref>#<item> | --change <name> --group <n> | --pr <ref> | --decision <path>)`;
`checklist tick <id> <index> --as <actor>` and `checklist untick`;
`close <id> --as <actor> (--decision-recorded-in <path> | --no-decision) [--task <source>:<ref>#<item> | --change <name> --group <n> | --unplanned <reason>]`;
`inbox --as <actor> [--since <cursor>] [--peek]`; `watch --as <actor>`;
`rebuild [--check]`; `sync`; `remote`; `import-change <name>`; `close-merged`;
`serve [--port <port>] [--open | --no-open] [--as <actor>]`; `top`;
`health [--stale-after <duration>] [--blocked-after <duration>] [--unplanned-within <duration>] [--check]`;
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
- **THEN** it prints the synopsis with `--stale-after`, `--blocked-after`, `--unplanned-within` and `--check`, and an example that parses to `health`, and exits 0

#### Scenario: Move and close have help for the disposition
- **WHEN** `agentboard help move` and `agentboard help close` run with no board and no actor
- **THEN** each prints the synopsis with `--task`, `--change`, `--group` and `--unplanned`, the exit codes including 4 `needs-scope-disposition` and 4 `already-linked`, and an example with `--unplanned` that parses, and neither mentions `needs-task-link`

#### Scenario: Init has help for sharing
- **WHEN** `agentboard help init` runs with no board and no actor
- **THEN** it prints `--remote` and `--into-host`, says they are mutually exclusive, lists the exit codes including 1 `ambiguous-remote`, 3 `remote-unreachable` and 4 `unsynced`, and has an example for each flag that parses, and exits 0

#### Scenario: Remote has help
- **WHEN** `agentboard help remote` runs with no board and no actor
- **THEN** it prints the synopsis, says the command never contacts the network, lists exit code 2, has an example that parses to `remote`, and exits 0

### Requirement: Actor is explicit
Every writing command SHALL require `--as <actor>` or the `AGENTBOARD_ACTOR`
environment variable; with neither, it SHALL exit 1 and explain. The actor
SHALL be recorded on the event and SHALL never be inferred from the OS user.
Every command SHALL accept `--as`; commands that neither write nor track a
per-actor cursor SHALL ignore it, so an agent can pass it habitually. The
one exception is `serve`, which writes only through the write actions of
its web app: those are enabled only by an explicit `--as <actor>` on the
`serve` command line, `serve` SHALL ignore `AGENTBOARD_ACTOR`, and every
event written through it carries that `--as` actor (see
board-web-actions).

#### Scenario: Missing actor
- **WHEN** `agentboard comment T1 "hi"` runs with no `--as` and no `AGENTBOARD_ACTOR`
- **THEN** the command exits 1 and names both ways to supply an actor

#### Scenario: Serve ignores the environment actor
- **WHEN** `agentboard serve` runs with `AGENTBOARD_ACTOR` set and no `--as`
- **THEN** the server is read-only

### Requirement: Status state machine
Ticket statuses SHALL be `todo`, `tests`, `implementing`, `review`, `merged`
and `blocked`. Permitted transitions SHALL be: `todo` to `tests`, `tests` to
`implementing`, `implementing` to `review`, `review` to `implementing`
(review sent it back), `review` to `tests` (tests need changing), `review` to
`merged`, any non-`merged` status to `blocked`, and `blocked` back to the
status it was in when blocked. A move to the ticket's current status,
including `blocked` to `blocked`, SHALL be rejected as `invalid-transition`;
leaving `blocked` SHALL be permitted only to the remembered status, which
the CLI supplies when no explicit target is given (the `ticket.move` event
always names its target). A `handoff` whose `--status` equals the current
status SHALL be permitted: it reassigns and comments without a transition.
`merged` SHALL be terminal. A board MAY
override the column names through a `board.meta` event with key `columns`
but the terminal status SHALL remain `merged`.

#### Scenario: Review sends work back
- **WHEN** a ticket in `review` is moved to `implementing`
- **THEN** the move is accepted

#### Scenario: Blocked remembers where it came from
- **WHEN** a ticket in `implementing` is moved to `blocked` and later moved out of `blocked` with no explicit target
- **THEN** its status becomes `implementing`

#### Scenario: Handoff within the same status
- **WHEN** a ticket in `implementing` held by `impl-1` is handed off with `--to impl-2 --status implementing`
- **THEN** it is assigned to `impl-2`, still `implementing`, with the note as a comment

#### Scenario: Move to the current status
- **WHEN** a ticket in `blocked` is moved to `blocked`
- **THEN** the command exits 4 with reason `invalid-transition`

#### Scenario: Merged is terminal
- **WHEN** a ticket in `merged` is moved to any status
- **THEN** the command exits 4 with reason `invalid-transition`

### Requirement: Claim, release and handoff
`claim` SHALL assign the ticket to the actor only if it is unassigned, and
SHALL exit 4 with reason `already-assigned` otherwise, naming the current
assignee; a `claim` by the current assignee SHALL exit 0, write no event and
report that the actor already holds the ticket, so a retried claim is safe. `release` SHALL clear the assignment only when the actor is the
assignee. `handoff` SHALL, in one event, set the assignee to `--to`, set the
status to `--status` (subject to the state machine), and add the note as a
comment attributed to the actor.

#### Scenario: Handoff to reviewer
- **WHEN** the implementer runs `handoff T1 --as impl --to reviewer --status review --note "green, 96%"`
- **THEN** T1 is assigned to `reviewer`, in status `review`, with a comment "green, 96%" by `impl`, and `show T1` lists one new event

#### Scenario: Handoff with an invalid status writes nothing
- **WHEN** `handoff` names a status the state machine does not permit from the current one
- **THEN** no event is written and the command exits 4

### Requirement: Close requires a decision disposition
`close` SHALL require exactly one of `--decision-recorded-in <path>` (a path
that exists in the host project, expected to be a spec delta, ADR or tasks
file) or `--no-decision`. A relative decision path SHALL be resolved against
the current directory, SHALL lie inside the current working tree (the output
of `git rev-parse --show-toplevel`, or the current directory outside git),
and SHALL be recorded relative to that root with `/` separators, so the
recorded path means the same thing in every worktree and clone; a path
outside the working tree SHALL exit 1. `link --decision` SHALL record its
path the same way but SHALL NOT require it to exist. `close` SHALL be permitted only from `merged` or
`blocked`. Closed tickets SHALL be excluded from `list` unless `--closed` is
given.

#### Scenario: Close without disposition is refused
- **WHEN** `agentboard close T1 --as orch` runs with neither flag
- **THEN** the command exits 1 and explains the rule that decisions made in a ticket must be recorded in a spec or ADR

#### Scenario: Close with a missing decision path
- **WHEN** `--decision-recorded-in docs/adr/0099.md` names a file that does not exist
- **THEN** the command exits 1 naming the path

### Requirement: Output conventions
Human output SHALL be plain ASCII, one ticket per line in `list` (the full 26-character id, so that ids
created in the same millisecond stay distinct and can be pasted back,
status, assignee or `-`, title), and a full record in `show` including the
ordered comments and the event count. With `--json`, output SHALL be exactly
one JSON document on stdout: an object for single-ticket commands, an array
for `list`, and for writing commands an object containing the event hash and
the resulting ticket. The one exception is `watch --json`, which prints one
JSON document per line, one per inbox entry, as entries arrive. Diagnostics
SHALL go to stderr. No command SHALL print
the contents of the cache file or raw event files unless asked with `show
--raw`.

#### Scenario: JSON is a single document
- **WHEN** `agentboard list --json` runs
- **THEN** stdout parses as one JSON array and nothing else is written to stdout

### Requirement: Exit codes
Exit codes SHALL be: 0 success; 1 usage error, missing actor,
`rebuild --check` finding a difference (including a missing cache file),
`serve` unable to listen on the requested port (`port-in-use`), or `top`
run without an interactive terminal (`not-a-tty`); 2 board not
found or unreadable; 3 sync problem that needs a human (a conflict, a
sync already in progress, a detached HEAD, or an unreachable or rejecting
remote; see board-concurrency); 4 action rejected by board state (invalid transition,
already assigned, not assignee, unknown ticket, a ticket leaving without a
scope disposition (`needs-scope-disposition`), or an unplanned disposition
for a ticket that has a task reference (`already-linked`)); 5 event log or cache
integrity problem (corrupt or malformed file encountered where the command
needed it, an existing event file whose content does not match its name, or
the cache still locked after the busy timeout and one retry).

#### Scenario: Unknown ticket
- **WHEN** `agentboard comment 01NOPE00 --as a "x"` names a ticket that does not exist
- **THEN** the command exits 4 with reason `unknown-ticket`

#### Scenario: Port in use is a usage-class failure
- **WHEN** `agentboard serve --port <p>` cannot bind because the port is in use
- **THEN** the command exits 1 with reason `port-in-use`

#### Scenario: Top without a terminal
- **WHEN** `agentboard top` runs with stdout redirected to a file
- **THEN** the command exits 1 with reason `not-a-tty`

#### Scenario: Missing scope disposition is a state rejection
- **WHEN** `agentboard close T1 --no-decision --as orch` runs for an ad hoc ticket T1 in `blocked` with no task link and no unplanned disposition
- **THEN** the command exits 4 with reason `needs-scope-disposition` and writes nothing

### Requirement: No secrets on the board
The board is not a secret store. `new`, `comment` and `handoff`, and `move`
and `close` when given `--unplanned`, SHALL refuse
text that matches well-known secret patterns (private key PEM headers, AWS
access key ids, GitHub tokens, and strings of 32 or more base64 characters
following `token`, `secret`, `password` or `key` and a separator), exiting 1
with the pattern name and not the matched text, unless `--allow-secret-like`
is given.

#### Scenario: PEM header refused
- **WHEN** a comment contains `-----BEGIN PRIVATE KEY-----`
- **THEN** the command exits 1 naming the `pem-private-key` pattern and writes no event

#### Scenario: Secret-like unplanned reason refused
- **WHEN** `move T1 merged --unplanned "token: <40 base64 characters>"` runs without `--allow-secret-like`
- **THEN** the command exits 1 naming the pattern, not the text, and writes no event

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
- **THEN** `board_health` is listed with the optional properties `stale-after`, `blocked-after`, `unplanned-within` and `check`

#### Scenario: Disposition over MCP
- **WHEN** an MCP client lists tools, then calls `board_move` with `{"id": "<T1>", "status": "merged"}` for an undisposed ad hoc ticket T1 in `review`, then with `{"id": "<T1>", "status": "merged", "unplanned": "hotfix"}`
- **THEN** `board_move` and `board_close` list the optional properties `task`, `change`, `group` and `unplanned`; the first call returns a tool error with `exitCode` 4, `reason` `needs-scope-disposition` and a hint naming both `task` and `unplanned`; the second succeeds with T1 in `merged`, and its events are byte-identical in body to those the CLI writes for the same arguments and actor on a copy of the board

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
- When `.board` is a standalone board with several remotes and none chosen
  by the rules of board-concurrency "Sync converges", it SHALL exit 1 with
  reason `ambiguous-remote` and change nothing.
- When `.board` exists and is not a board (a directory holding any entry
  but no `events/`, a regular file, or a symbolic link that does not
  resolve to a board directory), it SHALL exit 2 with reason
  `board-not-a-repository` before any write (no bare repository, no
  temporary directory, no host `.gitignore` entry), telling the user to
  move it aside; whatever it holds is left byte for byte. An empty
  directory counts as absent.

`<url>` SHALL be checked before anything runs: an empty value, a value
that starts with `-`, or a `file://` URL whose host part is neither empty
nor `localhost` SHALL exit 1 with reason `usage`, and no git command SHALL
be given the value (in particular the host repository's own remote is
never contacted). Every git command that takes `<url>` SHALL pass it
after `--`. A relative local path SHALL be resolved against the host
repository's top level when the board was found through a git repository
(the same directory from every linked worktree), else against the current
directory, and the `origin` URL stored SHALL be the absolute path;
`file://localhost/x` and `file:///x` both name the path `/x`; a `file://`
URL and a non-local URL SHALL be stored as given. The matching-URL
comparison SHALL use the raw `remote.<name>.url` as well as the URL
`git remote get-url` prints, so a URL rewritten by `url.<base>.insteadOf`
is not reported as `remote-mismatch`; a matching URL SHALL run no `sync`.
The `remote-mismatch` message SHALL name `git -C .board remote set-url`
only when the remote exists; when `agentboard.remote` names a remote the
board repository does not have, it SHALL name `agentboard.remote` instead.

A board is cloned into a temporary sibling of `.board` named
`.board-clone-<random>`, renamed to `.board` only once its working tree
holds `events/`. A clone that fails after `ls-remote` succeeded (a remote
whose objects are missing) SHALL exit 3 with reason `remote-unreachable`
and leave nothing behind. When the remote's HEAD names a branch the remote
does not have and the remote has exactly one branch, that branch SHALL be
checked out first; when that checkout fails, `init` SHALL exit 1 with
reason `not-a-board` and leave nothing behind. A `.board-clone-*` left by
an interrupted run SHALL be removed by the next `init --remote`, which
names it in its message.

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

#### Scenario: Remote URL that is an option
- **WHEN** `agentboard init --remote '--upload-pack=touch PWNED;:x'` runs in a clone whose host repository has an `origin`
- **THEN** it exits 1 with reason `usage`, no git command received the value, `origin` was not contacted, no file was created and nothing changes

#### Scenario: Existing directory that is not a board
- **WHEN** `.board` is a directory holding `notes.txt` and no `events/`, and `agentboard init --remote <url>` runs, whether `<url>` holds a board or is empty
- **THEN** it exits 2 with reason `board-not-a-repository` telling the user to move the directory aside, `notes.txt` is unchanged, and no bare repository, temporary directory or host `.gitignore` entry was created

#### Scenario: Init with a remote on a board with several remotes
- **WHEN** `.board` is a standalone board with the remotes `fork` and `upstream`, no `origin`, no upstream and no `agentboard.remote`, and `agentboard init --remote <url>` runs
- **THEN** it exits 1 with reason `ambiguous-remote` naming both remotes and `agentboard init`, and nothing changes

#### Scenario: Matching URL rewritten by insteadOf
- **WHEN** a standalone board's `origin` is `https://host/d.git`, the board repository has `url.<path>.insteadOf=https://host/`, and `agentboard init --remote https://host/d.git` runs
- **THEN** it exits 0 reporting that nothing changed, and runs no `sync`

#### Scenario: Clone fails after ls-remote
- **WHEN** `agentboard init --remote file://<path>` runs against a repository whose tip commit object is missing
- **THEN** it exits 3 with reason `remote-unreachable` quoting git, and no `.board` or temporary directory is left behind

#### Scenario: Leftover clone directory
- **WHEN** `.board-clone-abc123` was left by an interrupted run and `agentboard init --remote <url>` runs
- **THEN** the leftover is removed, the message names it, and the command otherwise completes as it would have

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
failure's code and reason, and its output SHALL still name the kept
repository and the old remote, with `keptAt` and `oldRemoteUrl` in the
`--json` error document. Its output SHALL name the kept old repository,
the old remote's URL as written in the board's configuration, and say that
every other clone runs `agentboard init --into-host` too and that the old
remote can be retired once they have. With `--json` it SHALL print the
`init` document plus `action` (`moved`; `resumed` after an interrupted
move, including one killed after the new worktree was in place but before
its `sync` completed, which the re-run syncs; `unchanged` on a board
already in the host; `repaired` for a broken link), `keptAt` (the kept
repository's path, else null), `oldRemoteUrl` (else null) and `sync` (the
result of the `sync` it ran, else null). `init` without flags on a
host-model board SHALL remove the temporary worktrees of dead moves that
hold no rebase state, as `init --into-host` on such a board does; and
while a kept old repository exists it SHALL leave the marker of a move
whose `sync` has not completed, change nothing else, and say that
`agentboard init --into-host` finishes the move, so that command then
reports `resumed` and carries over and publishes what the move had not.
A move that lost its init lock to another init that finished meanwhile
SHALL exit 3 with reason `sync-failed` naming `agentboard init
--into-host`, never with an untyped error. It
SHALL exit 1 with reason `no-host-repository` also when the host's git
directory is not inside its working tree, exit 3 as `sync` does
(`sync-in-progress`, `detached-head`, `sync-failed`, `sync-conflict`) and
exit 4 `unsynced` as board-concurrency "Moving a board into the host
repository loses no event" says, and every such refusal SHALL print the
hint of its reason.

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

### Requirement: Scope disposition on the command line
`move` (with target `merged` only) and `close` SHALL accept at most one scope
disposition: `--task`, `--change` with `--group` (validated as `link` does), or
`--unplanned <reason>` (non-empty). Before its `ticket.move` or `ticket.close`,
in the same transaction, the command SHALL write the `ticket.link` with that
task, or the `ticket.unplanned`, writing all of these events or none.
`--unplanned` on a ticket with a task reference SHALL exit 4 `already-linked`.

#### Scenario: Merge with a task link
- **WHEN** ad hoc ticket T1 in `review` with no task link runs `agentboard move T1 merged --task openspec:add-login#2 --as orch`
- **THEN** the command exits 0, two event files are written (a `ticket.link` with the task, then a `ticket.move` to `merged`), and T1 is in `merged` with the task reference `openspec:add-login#2` and no ad hoc reason

#### Scenario: Merge as unplanned
- **WHEN** ad hoc ticket T1 in `review` runs `agentboard move T1 merged --unplanned "production hotfix, no plan" --as orch`
- **THEN** the command exits 0, a `ticket.unplanned` with that reason and then a `ticket.move` to `merged` are written, and `show T1` has the line `unplanned: production hotfix, no plan (by orch)` after its `adhoc:` line, and `show T1 --json` and `list --json` carry `unplanned` with that `reason`, the `actor` `orch` and the event's `ts`

#### Scenario: Close with each disposition
- **WHEN** ad hoc tickets A and B, both in `blocked` with no disposition, run `close A --no-decision --task openspec:add-login#3 --as orch` and `close B --no-decision --unplanned "abandoned, duplicate of A" --as orch`
- **THEN** both exit 0, A is closed with the task reference `openspec:add-login#3`, and B is closed with the unplanned disposition `abandoned, duplicate of A`

#### Scenario: Close without a disposition
- **WHEN** ad hoc ticket T1 in `blocked` with no disposition runs `close T1 --no-decision --as orch`
- **THEN** the command exits 4 with reason `needs-scope-disposition`, the hint names `close` with `--task` and with `--unplanned`, and no event file is created

#### Scenario: Both dispositions are a usage error
- **WHEN** `agentboard move T1 merged --task openspec:x#1 --unplanned "y" --as orch` runs
- **THEN** the command exits 1 with reason `usage` naming both flags, before the board is opened, and writes nothing

#### Scenario: Disposition on another move is a usage error
- **WHEN** `agentboard move T1 implementing --unplanned "y" --as orch` runs
- **THEN** the command exits 1 with reason `usage`, saying that a disposition applies only to a move to `merged`, and writes nothing

#### Scenario: Invalid task reference refused as link does
- **WHEN** `agentboard move T1 merged --task add-login-2 --as orch` runs, and separately `move T1 merged --unplanned "" --as orch`
- **THEN** the first exits 1 showing the `<source>:<ref>#<item>` form exactly as `link T1 --task add-login-2` does, the second exits 1 with reason `usage`, and neither writes an event

#### Scenario: Unplanned on a linked ticket
- **WHEN** ticket T1 has the task reference `openspec:add-login#2` and `move T1 merged --unplanned "y" --as orch` runs from `review`
- **THEN** the command exits 4 with reason `already-linked` naming the task reference, and writes nothing

#### Scenario: Disposition with an invalid move writes nothing
- **WHEN** ad hoc ticket T1 is in `todo` and `move T1 merged --unplanned "y" --as orch` runs
- **THEN** the command exits 4 with reason `invalid-transition` and no `ticket.unplanned` or `ticket.move` file is created

#### Scenario: Close check order
- **WHEN** an undisposed ad hoc ticket in `blocked` has an open `DECISION:` comment and `close <id> --no-decision --as orch` runs
- **THEN** the command exits 4 with reason `needs-scope-disposition`; after the same command is given `--unplanned "spike"`, it exits 1 with reason `unpromoted-decision`

#### Scenario: Hand-off into merged needs a disposition first
- **WHEN** an undisposed ad hoc ticket in `review` is handed off with `--status merged`
- **THEN** the command exits 4 with reason `needs-scope-disposition` and the hint names `move <id> merged` with `--task` and with `--unplanned`
