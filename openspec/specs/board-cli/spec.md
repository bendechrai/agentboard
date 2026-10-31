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
`claim <id> --as <actor> [--ttl <duration>] [--wait --timeout <duration>]`;
`renew <id> --as <actor> [--ttl <duration>]`; `unqueue <id> --as <actor>`;
`release <id> --as <actor> [--force --reason <text>]`;
`move <id> <status> --as <actor> [--task <source>:<ref>#<item> | --change <name> --group <n> | --unplanned <reason>]`;
`comment <id> --as <actor> <text>`;
`handoff <id> --as <actor> --to <actor> --status <status> --note <text>`;
`link <id> --as <actor> (--task <source>:<ref>#<item> | --change <name> --group <n> | --pr <ref> | --decision <path>)`;
`checklist tick <id> <index> --as <actor>` and `checklist untick`;
`close <id> --as <actor> (--decision-recorded-in <path> | --no-decision) [--task <source>:<ref>#<item> | --change <name> --group <n> | --unplanned <reason>]`;
`inbox --as <actor> [--since <cursor>] [--peek]`; `watch --as <actor>`;
`rebuild [--check]`; `sync`; `remote`; `import-change <name> [--dry-run] [--force]`;
`close-merged`;
`config set <key> <value> --as <actor>` and `config get [<key>]`;
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
cannot drift; a flag the registry marks CLI-only (`claim --timeout`) is
parsed on the command line and left out of the tool definitions. `serve`
and `top` are streaming commands like `watch`:
`serve` runs until SIGINT or SIGTERM (see board-web), and `top` until the
user quits it or it receives SIGINT or SIGTERM (see board-tui). `claim
--wait` blocks in the foreground until it is granted the ticket, times out
or is interrupted (see "Waiting on the command line"). `init`, `sync` and
`remote` are the commands that run git on the board; they need no actor
(see "Initialising and joining a shared board").

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

#### Scenario: Claim has help for leases and waiting
- **WHEN** `agentboard help claim` runs with no board and no actor
- **THEN** it prints the synopsis with `--ttl`, `--wait` and `--timeout`, the exit codes including 4 `already-assigned`, `queued`, `wait-timeout` and `wait-interrupted`, and an example that parses to `claim` with `--ttl`, and exits 0

#### Scenario: Renew, unqueue and config have help
- **WHEN** `agentboard help renew`, `agentboard help unqueue` and `agentboard help config` run with no board and no actor
- **THEN** each prints its synopsis and an example that parses to that command, and exits 0, and the `config` synopsis names `lease.grace` and `queue.window`

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
`claim` SHALL assign the ticket to the actor only if it is unassigned with
no waiters, or if it is held by another actor under a lease that is
claimable and has no waiters (see "Leases on the command line"), and SHALL
exit 4 with reason `already-assigned` otherwise (or `queued` when the
ticket has waiters), naming the current assignee and, when the ticket has
a lease, its expiry and the time from which it can be claimed; a `claim`
by the current assignee SHALL exit 0, write no event (with or without
`--ttl` or `--wait`) and report that the actor already holds the ticket
and its current lease, so a retried claim is safe. `release` SHALL clear
the assignment only when the actor is the assignee, except with `--force`
(see "Forced release on the command line"). `handoff` SHALL, in one event,
set the assignee to `--to`, set the
status to `--status` (subject to the state machine), and add the note as a
comment attributed to the actor. Every command SHALL refuse the actor
`agentboard` with exit 1 and reason `usage`.

#### Scenario: Handoff to reviewer
- **WHEN** the implementer runs `handoff T1 --as impl --to reviewer --status review --note "green, 96%"`
- **THEN** T1 is assigned to `reviewer`, in status `review`, with a comment "green, 96%" by `impl`, and `show T1` lists one new event

#### Scenario: Handoff with an invalid status writes nothing
- **WHEN** `handoff` names a status the state machine does not permit from the current one
- **THEN** no event is written and the command exits 4

#### Scenario: Refusal names the lease
- **WHEN** `merger-1` holds T1 with a live lease and `claim T1 --as merger-2` runs
- **THEN** the command exits 4 with reason `already-assigned`, and the message names `merger-1`, the lease expiry and the time from which T1 can be claimed

#### Scenario: Reserved actor
- **WHEN** `comment T1 --as agentboard "x"` runs
- **THEN** it exits 1 with reason `usage` and writes nothing

### Requirement: Close requires a decision disposition
`close` SHALL require exactly one of `--decision-recorded-in <path>` (a path
that exists in the host project, expected to be a spec delta, ADR or tasks
file) or `--no-decision`. A relative decision path SHALL be resolved against
the current directory, SHALL lie inside the current working tree (the output
of `git rev-parse --show-toplevel`, or the current directory outside git),
and SHALL be recorded relative to that root with `/` separators, so the
recorded path means the same thing in every worktree and clone; a path
outside the working tree SHALL exit 1 with reason `path-outside-tree`,
naming the working tree's root but not the path given. A decision path
that does not exist SHALL exit 1 with reason `decision-path-missing`,
naming `--decision-recorded-in` but not the path given (see "Refusals
never repeat the refused input"). `link --decision` SHALL record its
path the same way but SHALL NOT require it to exist. `close` SHALL be permitted only from `merged` or
`blocked`. Closed tickets SHALL be excluded from `list` unless `--closed` is
given.

#### Scenario: Close without disposition is refused
- **WHEN** `agentboard close T1 --as orch` runs with neither flag
- **THEN** the command exits 1 and explains the rule that decisions made in a ticket must be recorded in a spec or ADR

#### Scenario: Close with a missing decision path
- **WHEN** `--decision-recorded-in docs/adr/0099.md` names a file that does not exist
- **THEN** the command exits 1 with reason `decision-path-missing`, naming `--decision-recorded-in`, and `0099` appears nowhere in stdout or stderr

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
`sync`, `remote`, `config`, `mcp` and `version`, which are setup, streaming,
settings or maintenance commands run by a human or an orchestrator in a
shell. Tool names SHALL be the command name with
spaces and hyphens replaced by underscores and prefixed `board_` (for
example `board_claim`, `board_checklist_tick`, `board_import_change`). Each
tool's input schema SHALL be generated from the registry, with the same
required arguments and the same validation as the CLI, and without the
flags the registry marks CLI-only; `--json` is implied.
Writing tools SHALL take the actor as an `as` argument, falling back to the
actor given to the server as `agentboard mcp --as <actor>`, then to the
server process's `AGENTBOARD_ACTOR`, and SHALL fail exactly as the CLI does
when none is present. A successful call SHALL return the same JSON document
the CLI prints with `--json` as a text content item, and as structured
content: the document itself when it is an object, or `{items: <array>}`
when it is an array (MCP structured content must be an object). A call to an
unknown or excluded tool name SHALL return a tool error with `exitCode` 1
and `reason` `usage`, not a protocol error, and so SHALL a call that passes
an argument the tool's schema does not define, such as a CLI-only flag. A
failed call
SHALL return a tool error (`isError` true) whose structured content is
`{exitCode, reason, message}`, where `exitCode` is the code the CLI would
have exited with and `reason` is the rejection reason where one exists (for
example `already-assigned`). The server SHALL locate the board once at
start-up by the same discovery rules, and SHALL fail to start, exiting 2,
when no board is found. Every tool call SHALL run the same single-transaction
path as the CLI, so concurrent CLI and MCP writers obey the same guarantees.
No tool call SHALL block waiting on another actor (see "Lease and queue
tools over MCP").

#### Scenario: Tools are listed from the registry
- **WHEN** an MCP client connects and lists tools
- **THEN** the list contains `board_new`, `board_show`, `board_list`, `board_claim`, `board_renew`, `board_unqueue`, `board_release`, `board_move`, `board_comment`, `board_handoff`, `board_link`, `board_checklist_tick`, `board_checklist_untick`, `board_close`, `board_inbox`, `board_import_change`, `board_close_merged` and `board_health`, and no tool for `init`, `watch`, `serve`, `top`, `rebuild`, `sync`, `remote`, `config`, `mcp` or `version`

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

#### Scenario: Excluded config tool
- **WHEN** an MCP client calls the tool `board_config_set` or `board_config_get`
- **THEN** the call returns a tool error with `exitCode` 1 and `reason` `usage`, and no event is written

#### Scenario: CLI-only flag is refused over MCP
- **WHEN** `board_claim` is called with `ttl` `30m`, `wait` true and `timeout` `10m`
- **THEN** the call returns a tool error with `exitCode` 1 and `reason` `usage`, and no event is written

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
  another URL, it SHALL exit 1 with reason `remote-mismatch`, naming the
  remote's URL and `git -C .board remote set-url`.
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
only when the remote exists; when the chosen remote is one the board
repository does not have, it SHALL name the setting that chose it instead
(`agentboard.remote`, or `branch.<b>.remote` when the upstream of the
board's branch `<b>` chose it), both in the sentence and in the suggested
`git config --unset` step.

No refusal of `init --remote` (`usage`, `remote-unreachable`,
`not-a-board`, `remote-mismatch`) SHALL repeat the value given to
`--remote` (see "Refusals never repeat the refused input"): it says "the
value", "the repository given with --remote" or "the URL given", and a
suggested command writes `<url>` for it. A remote's URL read from the
board repository's configuration MAY be named, without its user
information (see "Remote URLs are shown without credentials"). Git's error, where it is
quoted, SHALL be quoted with every occurrence of the value given
replaced by `<url>` (the value as given, as the absolute path git was
given for a relative local path, and without its user information, the
form git prints for a URL with credentials), the user information of
the value given (as given and percent-decoded) replaced by `<redacted>`
wherever it appears, and the user information of every URL in it
(`<scheme>://<userinfo>@`) replaced by `<scheme>://<redacted>@`. The
user name of the scp-like form `user@host:path` is not user information.

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

#### Scenario: Credentials in an unreachable URL
- **WHEN** `agentboard init --remote https://agent:<token>@git.example.com/me/missing.git` runs, with and without `--json`, and the repository cannot be read
- **THEN** it exits 3 with reason `remote-unreachable`, quotes git's error, and neither the token nor the URL given appears in stdout or stderr

#### Scenario: Token given as the user name of an unreachable URL
- **WHEN** `agentboard init --remote http://<token>@<host>/me/x.git` runs, with and without `--json`, and the server answers 401 so git prints `could not read Password for 'http://<token>@<host>'`
- **THEN** it exits 3 with reason `remote-unreachable`, the quoted line reads `http://<redacted>@<host>`, and the token appears nowhere in stdout or stderr

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
- **THEN** it exits 1 with reason `usage`, no git command received the value, `origin` was not contacted, no file was created, nothing changes, and `PWNED` appears nowhere in stdout or stderr

#### Scenario: Remote mismatch does not repeat the URL given
- **WHEN** a standalone board's `origin` is `https://host/d.git` and `agentboard init --remote https://host/<token>.git` runs
- **THEN** it exits 1 with reason `remote-mismatch`, the message names `origin`, `https://host/d.git` and `remote set-url origin <url>`, and the token appears nowhere in stdout or stderr

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

### Requirement: Leases on the command line
`claim <id> --as <actor> [--ttl <duration>]` SHALL write, with `--ttl`, a
`ticket.claim` whose `lease` has that ttl, the board's `lease.grace` as
`grace`, and an `expiresAt` equal to the event's `ts.wall` plus the smaller
of the two. `renew <id> --as <actor> [--ttl <duration>]` SHALL write a
`ticket.renew` with the given ttl, or the lease's requested ttl when
`--ttl` is omitted, and an `expiresAt` equal to its `ts.wall` plus that
ttl, only when the actor is the assignee. `renew` SHALL check the
assignee first: an actor that is not the ticket's assignee SHALL exit 4
with reason `not-assignee` and write nothing, whether or not a well-formed
`--ttl` is given and whether or not the ticket has a lease (a malformed
`--ttl` is refused with exit 1 `usage` first, because arguments are parsed
before the board is opened), so a former holder whose
lock was force-released or handed to another actor learns that it lost
the lock. Only `renew` by the assignee without `--ttl` on a ticket with no
lease SHALL exit 1 with reason `usage`. A ttl SHALL be 1 to 5 ASCII digits
followed by `s`, `m`, `h` or `d`, between 30 seconds and 7 days
inclusive. Any other value SHALL exit 1 with reason `usage` and the
message `invalid --ttl: a ttl is <n>s, <n>m, <n>h or <n>d with <n> of 1
to 5 digits, from 30s to 7d`, which names the form and never repeats the
value given, so a token pasted as a ttl never lands in a terminal or a
log. The command SHALL build the event's hybrid timestamp before
validating, inside the same transaction, and SHALL validate with the
fold's rules against that timestamp. A claim on a ticket held by another
actor with no waiters SHALL be written as a takeover, with `supersedes`
filled from the current lease, only when the new event's `ts.wall` and the
local clock both read at least the lease's `expiresAt` plus 60000;
otherwise it SHALL be refused without writing. Callers SHALL NOT supply
`supersedes`. A takeover SHALL carry its own lease: a claim without
`--ttl` that would otherwise be written as a takeover SHALL exit 1 with
reason `usage` naming `--ttl` and write nothing, so a holder that took a
lock over and then crashed loses it like any other. A successful `claim
--ttl` SHALL print that the lease must be confirmed with `agentboard
renew <id>` before the grace period ends, and when.

`show` SHALL read only applied event files: a rejected file and a file not
yet folded SHALL NOT appear in its lease, queue, grant, takeover or forced
release lines, in human or `--json` output. `show` SHALL display a
ticket's lease (expiry as an ISO 8601 UTC time,
requested ttl, `grace` while unconfirmed, and state), its queue in order
with each waiter's join time, a pending or applied grant (to whom and the
time by which it must be accepted), and for a takeover both the previous
holder's expiry and the takeover's wall time. The lease state SHALL be
computed from the local clock at read time: `live` before `expiresAt`,
`expired` from `expiresAt` until `expiresAt` plus 60000, and `claimable`
from then on. In `--json` output the ticket SHALL carry `lease`: null, or
`{ttl, expiresAt, event, confirmed, state, claimableAt}`, and `queue`: an
array of `{actor, ttl, joined}` in order. In `list`, the assignee column
SHALL stay one token: the actor, then `*` when the lease is unconfirmed,
then `+<remaining>` for a live lease or `!expired` or `!claimable`, then
`^<n>` when `n` actors are waiting (for example `merger-1*+2m^3`). The
state SHALL never be stored in the cache.

#### Scenario: Claim with a lease starts in grace
- **WHEN** `claim T1 --as merger-1 --ttl 30m` runs on an unassigned ticket on a board with the default grace
- **THEN** it exits 0, the claim's lease is `{ttl: 1800000, grace: 120000, expiresAt: <ts.wall + 120000>}`, `list` shows `merger-1*+2m`, and the output names `agentboard renew`

#### Scenario: Renew confirms with the requested ttl
- **WHEN** `merger-1` holds T1 under an unconfirmed lease with ttl 30m and runs `renew T1 --as merger-1`
- **THEN** it exits 0, the renew's ttl is 1800000, and `list` shows `merger-1+30m`

#### Scenario: Takeover of a claimable lease
- **WHEN** `merger-1` claimed T1 with `--ttl 30m` and never renewed, 181 seconds have passed, the queue is empty and `claim T1 --as merger-2 --ttl 30m` runs
- **THEN** it exits 0, T1 is assigned to `merger-2`, and the claim's `supersedes` names `merger-1`, the grace expiry and the claim that set it

#### Scenario: Takeover needs a ttl
- **WHEN** the lease `merger-1` holds on T1 is claimable, the queue is empty and `claim T1 --as merger-2` runs without `--ttl`
- **THEN** it exits 1 with reason `usage` naming `--ttl`, no event is written, and T1 stays assigned to `merger-1`

#### Scenario: Expired but not yet claimable
- **WHEN** a lease expired 20 seconds ago and another actor runs `claim`
- **THEN** it exits 4 with reason `already-assigned`, no event is written, and `list` shows `<holder>!expired`

#### Scenario: Renew by someone else
- **WHEN** `merger-2` runs `renew T1` on a ticket held by `merger-1`
- **THEN** it exits 4 with reason `not-assignee` and no event is written

#### Scenario: Renew after the lock was force-released
- **WHEN** `merger-1` held T1 with `--ttl 30m`, `orchestrator` ran `release T1 --force --reason stalled` with no waiters, and `merger-1` runs `renew T1`, then `renew T1 --ttl 30m`
- **THEN** both exit 4 with reason `not-assignee`, not 1 `usage`, no event is written, and the hint says the lock was lost and names `agentboard show T1`

#### Scenario: Renew by the assignee without a lease
- **WHEN** `impl` claimed T1 without `--ttl` and runs `renew T1 --as impl`
- **THEN** it exits 1 with reason `usage` and no event is written

#### Scenario: Malformed ttl
- **WHEN** `claim T1 --as a --ttl 10min` or `claim T1 --as a --ttl 5s` runs
- **THEN** the command exits 1 with reason `usage` naming the duration form and the 30s to 7d range

#### Scenario: A refused ttl is not repeated
- **WHEN** `claim T1 --as a --ttl <token>` runs with a token-shaped value, with and without `--json`
- **THEN** it exits 1 with reason `usage`, and the token appears nowhere in stdout or stderr

### Requirement: Waiting on the command line
`claim <id> --as <actor> --ttl <duration> --wait --timeout <duration>`
SHALL claim at once, as `claim --ttl`, when the ticket is unassigned with
no waiters, and SHALL then print exactly what `claim --ttl` prints.
Otherwise it SHALL write a `ticket.queue.join` with the ttl (unless the
actor is already queued), print the actor's position (the line `queued for
<id> at position <n>, held by <holder or ->`), and block in the foreground
on the watch machinery until the wait ends. `--wait` SHALL never take over
a lease: on a ticket held by another actor it SHALL join the queue even
when the holder's lease is already claimable, and the ticket then passes to
it through a grant from the queue, due at the join's wall plus 1 when the
lapse lies before the join (see board-events "Grants"). The same holds for
`board_claim` with `wait` over MCP. The deadline SHALL be a monotonic clock
read when the wait starts plus the timeout, and whether it has passed SHALL
be decided on that monotonic clock alone, so a wall clock stepped back or
forward neither delays nor advances it (the wall clock is still the clock
of every catch-up and event). While it blocks it SHALL wake only on a
change notification for the events directory, on the watch machinery's
polling interval, at exactly the cache's grant watermark (the next time a
grant is due, see board-cache "Cache schema"; never later than the
deadline), at the deadline, and on SIGINT or SIGTERM; each wake SHALL catch
up as any command does, so it writes the grants that are due itself, and
the number of catch-ups SHALL be bounded by the wakes, never a busy loop.
After each catch-up, the first of these that applies ends the wait:

1. a grant to the actor is the ticket's current lease: it SHALL exit 0,
   printing the `list` line of the ticket and then `accept the grant with
   'agentboard renew <id> --as <actor>' before <acceptBy>`, where
   `<acceptBy>` is the grant's lease expiry as an ISO 8601 UTC time;
2. the actor has otherwise become the assignee (a hand-off or assign to a
   waiter): it SHALL exit 0 as a retried claim does (`already claimed by
   <actor>`), writing nothing;
3. at the deadline, or on SIGINT or SIGTERM: it SHALL end with one more
   transaction that decides after its own catch-up, since that catch-up
   can write a grant to the actor, or fold a hand-off to it, that the
   wake did not see. When the actor is then the assignee, at the deadline
   it SHALL write nothing and end as in 1 or 2 (exit 0: it holds the
   ticket and must renew), and on a signal it SHALL write a plain
   `ticket.release` (so the next waiter is granted) and exit 4 with
   reason `wait-interrupted` and the message `the wait for ticket <id>
   was interrupted after the ticket was given to you; you released it,
   so it passes to the next waiter` (also in the `--json` error
   document). When the actor is still queued it SHALL write
   `ticket.queue.leave`, and otherwise (it left the queue elsewhere
   meanwhile) nothing, and exit 4 with reason `wait-timeout` at the
   deadline and `wait-interrupted` on a signal. A refused leave is never
   ignored. When that transaction fails with exit 5 `busy` it SHALL be
   attempted once more (the busy timeout and one retry), and when that
   fails too it SHALL exit 5 with reason `busy` and a message naming
   `agentboard unqueue <id> --as <actor>`, the actor still queued. Any
   other error of that transaction SHALL end the wait with that error
   after one attempt, writing nothing (the actor stays queued, and a
   grant it is later given lapses after its window). A
   grant due at the deadline itself is therefore written and wins. A wake
   that already sees the actor holding the ticket ends as in 1 or 2 even
   if a signal arrives in the same wake; only a hold found by the ending
   transaction is released on a signal. The
   wait never exits non-zero while the actor holds the ticket, and an
   interrupted wait never exits 0 unless it holds the ticket, because
   exit 0 means the actor holds it and a script may go on to the
   critical step. The signal handlers SHALL be in place before the join
   is written and removed when the command returns, and the wait SHALL
   leave no abort listener, timer or watcher behind;
4. the actor is neither queued nor the assignee and the ticket is
   unassigned with no waiters (its join was rejected because the ticket
   became free, for example a release from another machine with an
   earlier wall arrived through `sync`): it SHALL claim instead (and when
   that claim finds the ticket taken meanwhile and joins, the wait goes
   on), as `claim
   --ttl`, and exit 0;
5. the actor is neither queued nor the assignee otherwise (it left the
   queue from another command, or a grant to it lapsed and passed on): it
   SHALL exit 4 with reason `invalid-queue`, writing nothing.

With `--json` a waiting claim prints one JSON document per line, as
`watch --json` does: the queued document `{queued, position, holder,
ticket}` when it joins (or finds itself queued), then the final document:
the claim result when it claimed, `{queued: false, grant, acceptBy,
ticket}` when granted (`grant` the grant's hash, `acceptBy` its lease
expiry in milliseconds), or the error document. A claim that claims at
once prints the one document `claim --ttl --wait` prints. The synchronous
in-process entry point (`runCli`) and `board_claim` over MCP never block:
over MCP `wait` joins and returns at once (see "Lease and queue tools over
MCP"), and `runCli` refuses a `claim --wait --timeout` that passed
validation with exit 1 `streaming-command`.

`--wait` SHALL require `--ttl` and, on the CLI, `--timeout` (1 to 5
digits and `s`, `m`, `h` or `d`, at most 1 day), checked in the same
order on every path (`--ttl`, then `--timeout`, then `--wait` without
`--ttl`), so the same invalid arguments give the same first error from
the executable and from the in-process `runCli`; otherwise it SHALL exit 1 with reason `usage`. A refused `--timeout` SHALL
exit 1 with reason `usage` and the message `invalid --timeout: a timeout
is <n>s, <n>m, <n>h or <n>d with <n> of 1 to 5 digits, from 1s to 1d`,
which names the form and never repeats the value given. `unqueue <id> --as
<actor>` SHALL write `ticket.queue.leave`, and SHALL exit 4 with reason
`invalid-queue` when the actor is not queued.

#### Scenario: Waiter is granted on release
- **WHEN** `merger-1` holds T1, `claim T1 --as merger-2 --ttl 30m --wait --timeout 10m` is blocking, and `merger-1` runs `release T1`
- **THEN** the waiting command writes or observes the grant to `merger-2`, exits 0 within 3 seconds of the release, and names `agentboard renew T1`

#### Scenario: Wait on a lapsed lease joins instead of taking over
- **WHEN** `merger-1` claimed T1 with `--ttl 30m` and never renewed, the lease is claimable, the queue is empty, and `claim T1 --as merger-2 --ttl 30m --wait --timeout 10m` runs
- **THEN** it writes a `ticket.queue.join`, not a claim with `supersedes`, prints `queued for <T1> at position 1, held by merger-1`, then writes or observes the grant to `merger-2` whose `after` names `merger-1`'s lease and whose wall is the join's wall plus 1, and exits 0 naming `agentboard renew T1`

#### Scenario: Wait times out
- **WHEN** a waiter's `--timeout 30s` passes (on the fake clock) with the holder still holding T1
- **THEN** the command writes `ticket.queue.leave`, exits 4 with reason `wait-timeout`, and `show T1` no longer lists it in the queue

#### Scenario: Wait needs a timeout on the CLI
- **WHEN** `claim T1 --as a --ttl 30m --wait` runs without `--timeout`
- **THEN** it exits 1 with reason `usage` and writes nothing

#### Scenario: Leave the queue
- **WHEN** `merger-3` is queued on T1 and runs `unqueue T1 --as merger-3`
- **THEN** it exits 0 and `show T1` no longer lists `merger-3`

#### Scenario: Waiter wakes when a grant falls due
- **WHEN** `merger-1` claimed T1 with `--ttl 30m` and never renewed, `merger-2` is waiting on T1, and no other command runs
- **THEN** the waiting command writes the grant to itself at the grant's slot time (the claim's wall plus 120000 plus 60000 plus 1) and exits 0, and it has not exited one millisecond before that time

#### Scenario: Timeout at the boundary
- **WHEN** a waiter started with `--timeout 30s` at time t0 is still queued
- **THEN** it is still waiting at t0 plus 29999 milliseconds and has written nothing, and at t0 plus 30000 it writes `ticket.queue.leave` and exits 4 with reason `wait-timeout`; when a grant to it falls due at exactly t0 plus 30000 instead, it is granted and exits 0

#### Scenario: Interrupted wait leaves the queue
- **WHEN** a waiting `claim --wait` receives SIGINT or SIGTERM
- **THEN** it writes `ticket.queue.leave`, exits 4 with reason `wait-interrupted`, and `show T1` no longer lists it

#### Scenario: Killed waiter stays queued
- **WHEN** a waiting `claim --wait` is killed with SIGKILL
- **THEN** it stays in the queue of T1, and a grant to it after a release lapses after the window and passes to the next waiter

#### Scenario: Join rejected because the ticket became free
- **WHEN** `merger-2` is waiting on T1 and a release by the holder with a wall earlier than `merger-2`'s join arrives late, so the join is rejected and T1 is free with no waiters
- **THEN** the waiting command claims T1 with its ttl and exits 0

#### Scenario: Grant written by the leave at the deadline
- **WHEN** a waiter reaches its deadline still queued and the transaction that would leave the queue finds, after its own catch-up, a grant to the waiter (its slot time passed, or the holder released, in between)
- **THEN** it writes no leave and exits 0 granted, naming `agentboard renew T1` and the acceptance deadline

#### Scenario: Hand-off racing the deadline
- **WHEN** `merger-1` hands T1 to the waiting `merger-2` just as `merger-2`'s deadline passes, so only the ending transaction's catch-up sees it
- **THEN** `merger-2` writes nothing and exits 0 as a retried claim, holding T1

#### Scenario: Grant or hand-off racing an interrupt
- **WHEN** a waiter receives SIGINT or SIGTERM and the ending transaction's catch-up finds T1 granted or handed to it
- **THEN** it writes a `ticket.release` (so the next waiter is granted), exits 4 with reason `wait-interrupted`, and its message says it released the ticket it was given

#### Scenario: Unqueue racing the deadline
- **WHEN** the waiter's actor runs `unqueue T1` elsewhere just as the waiter's deadline passes
- **THEN** the waiter writes nothing more and exits 4 with reason `wait-timeout`

#### Scenario: Busy leave
- **WHEN** the transaction that ends a wait fails with exit 5 `busy`
- **THEN** it is attempted once more; when that succeeds the wait ends as usual, and when it fails too the command exits 5 with reason `busy`, the actor still queued, and the message names `agentboard unqueue T1 --as <actor>`

#### Scenario: Wall clock stepped during a wait
- **WHEN** the wall clock is stepped back or forward by an hour while a waiter with `--timeout 30s` waits
- **THEN** it times out 30 seconds after it started, by the monotonic clock

#### Scenario: Waiter no longer queued
- **WHEN** `merger-2` is waiting on T1, still held by `merger-1`, and `unqueue T1 --as merger-2` runs from another shell
- **THEN** the waiting command exits 4 with reason `invalid-queue` and writes nothing

### Requirement: Forced release on the command line
`release <id> --as <actor> --force --reason <text>` SHALL write a
`ticket.release.force` naming the current assignee as `holder` and the
reason, when the ticket is assigned to an actor other than the caller.
`--force` without a non-empty `--reason`, `--reason` without `--force`,
and `--force` by the assignee itself SHALL exit 1 with reason `usage`
and write nothing. `--force` on an unassigned ticket SHALL exit 4 with
reason `not-assignee`. The reason SHALL be refused like comment text when
it matches a secret pattern (see "No secrets on the board"), and that
check SHALL run before the board is opened, so a secret-like reason is
refused with exit 1 even where no board is found. Forced
release SHALL NOT be restricted to a configured set of actors. `show`
SHALL display a forced release with its actor, the previous holder and the
reason.

#### Scenario: Orchestrator breaks a stale lock
- **WHEN** `merger-1` holds T1 and `release T1 --as orchestrator --force --reason "merger-1 crashed"` runs
- **THEN** it exits 0, T1 has no assignee (or, with waiters, a grant to the head waiter is due), and the event is a `ticket.release.force` with actor `orchestrator`, holder `merger-1` and that reason

#### Scenario: Force without a reason
- **WHEN** `release T1 --as orchestrator --force` runs
- **THEN** it exits 1 with reason `usage` and no event is written

#### Scenario: Secret-like reason without a board
- **WHEN** `release T1 --as orchestrator --force --reason "gone <token>"` runs with a token-shaped reason where no board is found
- **THEN** it exits 1 with reason `secret-like`, not 2, and the token does not appear in its output

#### Scenario: Force by the holder
- **WHEN** `merger-1` holds T1 and runs `release T1 --as merger-1 --force --reason x`
- **THEN** it exits 1 with reason `usage` and names plain `release`

### Requirement: Board settings command
`config set <key> <value> --as <actor>` SHALL write a `board.meta` event
for the keys `lease.grace` and `queue.window`, with the value given as a
duration (1 to 5 digits and `s` or `m`, between 30 seconds and 10
minutes) and stored in milliseconds; any other key or value SHALL exit 1
with reason `usage`. The refusal SHALL never repeat the key or value
given, so a token pasted there never lands in a terminal or a log: an
unknown key is refused with exactly `config set takes <key> as one of
lease.grace, queue.window` (`config get` likewise), and a refused value
with exactly `invalid value: a setting is <n>s or <n>m with <n> of 1 to 5
digits, from 30s to 10m`. `config get [<key>]` SHALL print the effective value
of one or both keys, marking defaults. `config` SHALL NOT be an MCP tool.

#### Scenario: Set the acceptance window
- **WHEN** `config set queue.window 5m --as orchestrator` runs
- **THEN** a `board.meta` event with key `queue.window` and value 300000 is written, and `config get queue.window` prints `5m`

#### Scenario: Unknown key
- **WHEN** `config set columns x --as orchestrator` runs
- **THEN** it exits 1 with reason `usage` listing the two keys

#### Scenario: A refused setting is not repeated
- **WHEN** `config set queue.window <token> --as orchestrator` or `config set <token> 5m --as orchestrator` runs with a token-shaped argument, with and without `--json`
- **THEN** it exits 1 with reason `usage`, nothing is written, and the token appears nowhere in stdout or stderr

### Requirement: Due grants are written during catch-up
Every command that catches up (every command except `rebuild` and
`rebuild --check`) SHALL, within its catch-up and under the write lock,
write each grant that is due (its slot time at or before the local clock)
and not yet present, exactly as the fold derives it, and fold it like a
late-arriving event. A read-only command SHALL take the write lock only
when there is something to fold, reap or grant. Catch-up SHALL read event
files to derive grants only when the local clock has reached the cache's
grant watermark (see board-cache "Cache schema").

#### Scenario: Inbox writes the due grant
- **WHEN** `merger-1` released T1 with `merger-2` queued, no other command has run, and `inbox --as merger-2` runs
- **THEN** the grant to `merger-2` is written and returned in that inbox call

#### Scenario: Grant written late is still exact
- **WHEN** no command runs for ten minutes after a release with a window of 2 minutes and waiters `a` and `b`
- **THEN** the next command writes the grant to `a` at its original slot time and then the grant to `b` after `a`'s lapse, and `rebuild` on another clone of the same events produces identical state

### Requirement: Lease and queue events in the inbox
Inbox entries (and `watch --json` lines) SHALL carry `affects`: the
previous holder for an applied `ticket.release.force` (its `holder`), for
an applied claim that took over a lease (its `supersedes.holder`) and for
an applied grant after a lapse (its `after.lease.holder`), the assignee
for a forced `ticket.reconcile` (its `holder`, see
board-openspec-integration "Reconcile on re-import"), and null for every
other event. For `ticket.grant` the entry's `to` SHALL be the
grantee, and for `ticket.release.force` its `note` SHALL be the reason.
Human inbox output SHALL begin an entry's line with `GRANTED: ` when it is
a grant to the reading actor, and with `LOST: ` when its `affects` equals
the reading actor.

#### Scenario: Previous holder is told
- **WHEN** `orchestrator` force-releases T1 from `merger-1` with reason `stalled` and `inbox --as merger-1` runs
- **THEN** the entry has `affects` `merger-1` and `note` `stalled`, and the human line begins with `LOST: `

#### Scenario: Grantee is told
- **WHEN** T1 is granted to `merger-2` and `inbox --as merger-2` runs
- **THEN** the entry is a `ticket.grant` with `to` `merger-2` and the human line begins with `GRANTED: `

### Requirement: Lease and queue hints
The `already-assigned` hint on a ticket with a lease SHALL name the time
from which it can be claimed and `agentboard claim <id> --ttl <duration>
--wait --timeout <duration> --as <actor>`. The `queued` hint SHALL name
the same `--wait` form. The `holder-changed`, `invalid-queue` and
`stale-grant` reasons SHALL hint `agentboard show <id>`. `not-assignee`
from `renew` SHALL hint `agentboard show <id>` and say the lock was lost.
`wait-timeout` SHALL hint `agentboard inbox --as <actor>`.
`wait-interrupted` SHALL say the actor left the queue and name the same
`--wait` form to wait again. `busy` from `claim` SHALL say that a waiting
actor is still in the queue and name `agentboard unqueue <id> --as
<actor>`.

#### Scenario: Hint for a live lease
- **WHEN** `claim T1 --as merger-2` is refused because `merger-1` holds a live lease
- **THEN** stderr has a `hint: ` line naming the claimable time and `--wait`

### Requirement: Lease and queue tools over MCP
The command registry SHALL define `renew`, `unqueue` and the `--ttl`,
`--wait`, `--timeout`, `--force` and `--reason` flags, so that `agentboard
mcp` lists `board_renew` and `board_unqueue`, `board_claim` gains optional
`ttl` and `wait` and `board_release` gains optional `force` and `reason`,
validated as on the CLI. `--timeout` SHALL be a CLI-only flag, absent from
the tool schema. `board_claim` with `wait` SHALL never block: when the
ticket is unassigned with no waiters it SHALL return the ordinary claim
result with `queued` false; otherwise (a held ticket, including one whose
lease is claimable, or one with waiters) it SHALL write the join and return
`{queued: true, position, holder, ticket}` at once. The grant SHALL be
delivered only through `board_inbox` as a `ticket.grant` entry.

#### Scenario: MCP tool list includes renew and unqueue
- **WHEN** an MCP client lists tools
- **THEN** `board_renew` and `board_unqueue` are listed, `board_claim` has optional `ttl` and `wait` and no `timeout`, and `board_release` has optional `force` and `reason`

#### Scenario: MCP wait returns at once
- **WHEN** `board_claim` is called with `wait` true and `ttl` `30m` on a ticket held by `merger-1` with one waiter
- **THEN** the call returns within one second with structured content `{queued: true, position: 2, holder: "merger-1", ticket: <id>}` and a join event is written

#### Scenario: MCP forced release matches the CLI
- **WHEN** `board_release` is called with `force` true, a `reason` and `as` `orchestrator` on a ticket held by `merger-1`
- **THEN** the written event's body is byte-identical to the one `release --force` writes for the same arguments and actor on a copy of the board

### Requirement: Re-import markers in list and show
`list` SHALL mark a superseded ticket with `[superseded] ` before its
title, after the scope marker (`[adhoc] ` or `[unplanned] `) and the
`[closed] ` marker when those apply.
`show` SHALL print `superseded: <reason>` after the `closed:` line for a
superseded ticket, and nothing for one that is not. `show` SHALL print a
removed checklist line at its own index, with its done flag and text,
followed by ` (removed)`. The `--json` documents carry the ticket as
folded: `superseded` (the reason, or null) and `removed: true` on a
removed line.

#### Scenario: Superseded marker
- **WHEN** the ticket of a group deleted from tasks.md is superseded and `list` runs
- **THEN** its line ends with `[superseded] <title>`, and `show` prints `superseded: group removed from <tasks file>`

### Requirement: Removed checklist lines are inactive
A checklist line removed by a reconcile SHALL be inactive on every
surface. It SHALL be excluded from every checklist count and progress
figure (the board card's done and total counts, `top`'s ticket detail,
the web app's cards and ticket detail); `show`, `top` and the web ticket
detail SHALL show it only marked as removed, and SHALL offer no tick,
checkbox or action for it. The `checklist tick` reminder SHALL map a
checklist index to the tasks-file line by counting only the ticket's lines
that are not removed, so it names the task line the ticked line stands
for.

#### Scenario: Count after a removal
- **WHEN** a ticket with lines `1.1 A` (done), `1.2 B` and `1.3 C` is reconciled with `1.2 B` removed
- **THEN** its card counts 1 done of 2, and `top`'s detail shows `checklist: 1/2`

#### Scenario: Show marks the removed line
- **WHEN** `show` runs for that ticket
- **THEN** it prints `  [ ] 1 1.2 B (removed)` and the other lines at their own indices

#### Scenario: No tick offered for a removed line
- **WHEN** the web ticket detail of that ticket is open on a writable server
- **THEN** lines `1.1 A` and `1.3 C` have a checkbox, and `1.2 B` is shown marked as removed with no checkbox

#### Scenario: Reminder after a removal
- **WHEN** a group's lines `1.1 Alpha`, `1.2 Beta` and `1.3 Gamma` are imported, `1.1 Alpha` is deleted from tasks.md and the change re-imported, and `checklist tick <id> 1` ticks `1.2 Beta`
- **THEN** the reminder names the line of `1.2 Beta` in tasks.md (line 2 when the group heading is line 1), not the line of `1.3 Gamma`

### Requirement: Refusals never repeat the refused input
A refusal SHALL NOT contain any part of the input it refuses, on any
surface: not in the message, not in the hint, not in any field of the
CLI's `--json` error document, the MCP tool error or the web app's action
error, and not in the `agentboard: <message>` line the CLI or the MCP
server writes to stderr. The refused input is the value, flag name,
command word, tool name or tool argument name whose check failed (it is
unknown, malformed, out of range, not one of the choices, or names no
ticket, event, file or tasks file). It SHALL NOT be shortened, masked or
partially shown instead. The refusal SHALL name the argument it refuses
(the flag, as `--task`; the positional, as `<status>`; or, for an unknown
flag or an extra positional, its 1-based position among the arguments
after the program name) and SHALL state the expected form or list the
valid choices, so that a token pasted into the wrong argument never lands
in a terminal, a log or a transcript and the caller can still correct the
call.

Input of the same call that was not refused MAY be repeated (the actor,
a decision path that passed its checks, a ticket id resolved on the
board), and so MAY board data and configuration, each escaped as plain
ASCII on one line like any other text a refusal repeats (so the board
directory named by `AGENTBOARD_DIR` in `board-not-found` cannot carry a
terminal escape sequence). The one exception to the rule is a ticket id
of the id shape (see "Ticket ids in refusals").

Exit codes, reasons and the fields of the error documents are unchanged
by this rule; only message and hint text are.

#### Scenario: Board directory from the environment is escaped
- **WHEN** `AGENTBOARD_DIR` names a missing directory whose name holds an ESC sequence, a BEL and a newline, and `agentboard list` (with and without `--json`) or `agentboard mcp` runs
- **THEN** it exits 2 with reason `board-not-found`, the message names the directory through the plain ASCII escaping (`\u001B`), and no ESC, BEL or newline from the variable is written to stdout or stderr

#### Scenario: Unknown status
- **WHEN** `agentboard move T1 <token> --as orch` runs with a token-shaped value, with and without `--json`
- **THEN** it exits 1 with reason `usage`, the message is `move takes <status> as one of todo, tests, implementing, review, merged, blocked`, no event is written, and the token appears nowhere in stdout or stderr

#### Scenario: Unknown status over MCP
- **WHEN** `board_move` is called with `{"id": "<T1>", "status": "<token>", "as": "orch"}` and `board_handoff` with `status` `<token>`
- **THEN** each returns a tool error with `exitCode` 1 and `reason` `usage` whose message lists the statuses, and the token appears nowhere in the tool result (text or structured content) or in the server's stderr

#### Scenario: Extra and non-integer arguments
- **WHEN** `agentboard comment T1 --as a hello <token>` (unquoted text) and `agentboard checklist tick T1 <token> --as a` run
- **THEN** the first exits 1 with reason `usage` naming position 6, `comment` and its arguments `<id> <text>`, the second exits 1 with reason `usage` saying `index must be an integer`, and the token appears in neither output

#### Scenario: Malformed task reference, change name, group and filter
- **WHEN** `new "x" --task <token> --as a`, `link T1 --change <token>#1 --group 1 --as a`, `link T1 --change c --group <token> --as a` and `list --task <token>` run
- **THEN** each exits 1 with reason `malformed-task-ref`, each message names the flag and its form (`<source>:<ref>#<item>`, non-empty without `#`, a positive decimal number, `<source>:<ref>[#<item>]`), and the token appears in no output

#### Scenario: Health duration
- **WHEN** `agentboard health --stale-after <token>` runs
- **THEN** it exits 1 with reason `usage`, the message names `--stale-after` and the duration form, and the token appears in no output

#### Scenario: Unknown inbox cursor
- **WHEN** `agentboard inbox --as a --since <token>` runs with a token of 64 lowercase hex characters (the only shape that passes the form check) that names no event
- **THEN** it exits 1 with reason `unknown-cursor`, the message names `--since`, and the token appears in no output; a token of any other shape is refused with reason `usage` by the unchanged form message, which names no value either

#### Scenario: Decision path outside the working tree
- **WHEN** `agentboard link T1 --decision ../<token> --as a` runs
- **THEN** it exits 1 with reason `path-outside-tree`, the message names the working tree's root, and the token appears in no output

#### Scenario: Import target
- **WHEN** `agentboard import-change <token>#1 --as orch`, `import-change <token> --as orch` (no such change) and `import-change Bad_Source:<token> --as orch` run
- **THEN** they exit 1 with reasons `malformed-task-ref`, `tasks-not-found` and `malformed-task-ref`, the second message names `openspec/changes/<name>/tasks.md`, and the token appears in no output

#### Scenario: Guidance arguments
- **WHEN** `agentboard help claim <token>`, `agentboard help agents --role <token>` and `agentboard agents install --target <token>` run
- **THEN** each exits 1 with reason `usage`; the role refusal lists the four roles and the target refusal lists the targets; and the token appears in no output

#### Scenario: Unknown tool and unknown tool argument
- **WHEN** an MCP client calls the tool `<token>`, and calls `board_show` with the argument `{"id": "<T1>", "<token>": true}`
- **THEN** both return tool errors with `exitCode` 1 and `reason` `usage`; the second names `board_show` and its arguments; and the token appears in neither result nor in the server's stderr

#### Scenario: Web action
- **WHEN** a writable `agentboard serve --as orch` receives `POST /api/actions/move` with the body `{"id": "<T1>", "status": "<token>"}` from its own page
- **THEN** the response is 400 with reason `usage`, its body lists the statuses, and the token appears nowhere in the body or in the server's output

### Requirement: Ticket ids in refusals
A ticket id argument (the positional `<id>`, or the tool argument `id`)
whose text could be a ULID or a prefix of one, that is, matches
`^0[0-9A-HJKMNP-TV-Z]{0,25}$` with ASCII letters compared without
regard to case (1 to 26 Crockford base32 characters, the first of them 0,
as in every ULID until about the year 3084; no character outside ASCII
counts, whatever it upper-cases to),
MAY be repeated in a refusal and in its hint, even when it matches no
ticket. Any other text given as a ticket
id SHALL NOT be repeated anywhere in a refusal: an unknown id is refused
with its usual exit code and reason (`unknown-ticket`, or `id-too-short`
below 6 characters) by a message that says the text given is not a
ticket id and states the id form, exactly `no ticket matches the id
given, which is not a ticket id: an id is 26 characters of Crockford
base32 (digits and letters other than I, L, O and U) starting with 0, or
a unique prefix of at least 6 of them` for `unknown-ticket`, and every
hint writes the placeholder `<id>` in its place.

#### Scenario: Ticket id that is not an id
- **WHEN** `agentboard show <token>` and `agentboard move <token> review --as orch` run with a token that is not id-shaped, on the CLI with and without `--json`, and `board_move` is called with that `id`
- **THEN** each exits 4 (or returns `exitCode` 4) with reason `unknown-ticket`, the message says the text given is not a ticket id and states the id form, and the token appears in no output

#### Scenario: Hint for an id that is not an id
- **WHEN** `agentboard close <token> --as orch` runs with neither `--decision-recorded-in` nor `--no-decision` and a token that is not id-shaped, and `board_close` is called with that `id` and no decision argument
- **THEN** each is refused with reason `no-disposition`, the hint names the `close` step with `<id>` in place of the id, and the token appears in no output

#### Scenario: Unknown ticket id that is id-shaped
- **WHEN** `agentboard show 01J9K3ZZZZ` runs and no ticket id starts with it
- **THEN** it exits 4 with reason `unknown-ticket` and the message names `01J9K3ZZZZ`

#### Scenario: Base32 secret that is not a ULID
- **WHEN** `agentboard show <text>` runs, with and without `--json`, where `<text>` is `JBSWY3DPEHPK3PXP` (a TOTP-style seed whose characters are all Crockford base32) or 26 Crockford base32 characters starting with a letter, and `board_show` is called with that `id`
- **THEN** each exits 4 (or returns `exitCode` 4) with reason `unknown-ticket`, the message says the text given is not a ticket id, and the text appears in no output

#### Scenario: Crockford text that starts with 1 to 7
- **WHEN** `agentboard show <text>` runs, with and without `--json`, where `<text>` is 26 Crockford base32 characters starting with 7, or `1J9K3ZZZZ`, and `board_show` is called with that `id`
- **THEN** each exits 4 (or returns `exitCode` 4) with reason `unknown-ticket` and the message above, and the text appears in no output

#### Scenario: Characters that upper-case into the id alphabet
- **WHEN** `agentboard show 01<U+017F><U+017F>ABCDEFGH23` runs (U+017F, the long s, upper-cases to `S`), or a text of `0` and twelve U+FB06 ligatures (each upper-cases to `ST`)
- **THEN** the text is not id-shaped, it exits 4 with reason `unknown-ticket` and the message says the text given is not a ticket id

#### Scenario: Actor read from a command line that failed to parse
- **WHEN** `agentboard close --unplanned --as <token>` or `agentboard close --task --as <token>` runs, with and without `--json` and with and without `AGENTBOARD_ACTOR` (the string flag takes `--as` as its value, so the token is the `<id>` positional and no `--as` is parsed)
- **THEN** it exits 1 with reason `no-disposition`, the hint writes `<id>` for the id and, for the actor, the value of `AGENTBOARD_ACTOR` or else `<actor>`, and the token appears in no output; when parsing fails, the actor a hint or message names comes from the parsed values or `AGENTBOARD_ACTOR`, never from a scan of the raw arguments

#### Scenario: Unknown ticket id with a letter outside the id alphabet
- **WHEN** `agentboard show 01NOPE0000` runs (`O` is not a Crockford base32 letter)
- **THEN** it exits 4 with reason `unknown-ticket`, the message says the text given is not a ticket id, and `01NOPE0000` appears in no output

### Requirement: Git lines quoted from remote commands
When agentboard repeats a line of git's output from a failing git
command that talks to a remote (`ls-remote`, `fetch`, `pull`, `push`,
`clone`, the checkout `init --remote` runs after its clone, and the
`remote:` lines a refusing remote prints), in a refusal or a warning of
`sync`, `init` (joining a host-model board), `init --remote` (including
the `sync` it runs) or `init --into-host`, the line SHALL first be
sanitised, in its raw form before it is escaped for output (so a URL
holding a non-ASCII character or a backslash is still recognised),
against every URL configured for the repository the command ran in (the
board repository for a standalone board, the host repository for a
host-model board, the directory `init --remote` runs git in):

- every `remote.<name>.url` and `remote.<name>.pushurl`, as configured
  and as git resolves it after `insteadOf` and `pushInsteadOf` rewrites;
- every `branch.<b>.remote` and `agentboard.remote` value that names no
  configured remote and contains `:` or `/` (a remote named by URL);
- every proxy git may use: `http.proxy`, every `http.<url>.proxy`,
  `https.proxy`, every `remote.<name>.proxy`, and the `http_proxy`,
  `https_proxy`, `all_proxy`, `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY`
  environment variables; a proxy value without `://` also as
  `http://<value>`;
- the value given to `--remote`, and the URL git was given for it, where
  there is one.

Each such URL, and the URL without its user information, SHALL be
replaced by `<url>`; its user information, as configured and
percent-decoded, by `<redacted>` wherever it appears; and the user
information of any other URL in the line (`<scheme>://<userinfo>@`) by
`<scheme>://<redacted>@`. For a proxy URL, whose user information git
and curl split differently, the text from `<scheme>://` up to the last
`@` of the authority SHALL also be redacted in each form the client
prints it: when it holds more than one raw `@`, git splits it at the
first, so the text between the first and the last `@` SHALL be
redacted as given, percent-decoded, and percent-encoded as git encodes a
host (every byte other than an ASCII letter, a digit, `-` and `.`
written `%XX` with upper-case hex); and when the user name holds a raw
`#` or `?`, curl on git 2.32 takes the text before it for the proxy host
(`Could not resolve proxy: <text>`), so that text SHALL be redacted too.
The generic `<scheme>://<userinfo>@` redaction SHALL run before these
pieces are redacted, and a piece SHALL NOT be used when it is shorter
than 6 characters, holds no letter or digit, or is a URL scheme name
(`http`, `https`, `ftp`, `ftps`, `git`, `ssh`, `file`, `git+ssh`,
`ssh+git`, `socks4`, `socks4a`, `socks5`, `socks5h`, in any case), alone
or followed by `:`, so no
piece can remove a `scheme://` marker the generic step needs or mangle an
ordinary word. (The user information as a whole is still redacted at any
length.) The whole message that quotes the line SHALL be
sanitised the same way, so a remote named by URL in `reaching <remote>
failed` is written `<url>`. A git command of these paths that fails
SHALL be reported as a refusal quoting its sanitised line, never as a raw
error carrying git's output: the `fetch` of `refs/agentboard/board` that
the host-model `init` join runs after a successful `ls-remote` exits 3
with reason `sync-failed`, `fetching refs/agentboard/board from <remote>
failed: <line>`. So no credential or token held in a configured or given
URL, a remote named by URL, or a proxy reaches stdout, stderr, the
`--json` document or an MCP result. Exit codes, reasons and the rest of
each message are unchanged. A line the remote's server writes itself
(an error that quotes the request path it received) can repeat a token
from the path in a form no URL rule recognises; that is a known limit.

#### Scenario: Sync with a token as the user name of the configured remote
- **WHEN** a standalone board's `origin` is `http://<token>@<host>/me/x.git`, the server answers 401, and `agentboard sync` runs with and without `--json`
- **THEN** it exits 3 with reason `sync-failed`, the quoted git line reads `could not read Password for 'http://<redacted>@<host>'`, and the token appears nowhere in stdout or stderr

#### Scenario: Sync with user:pass@ and a token in the path of the configured remote
- **WHEN** `origin` is `http://agent:<secret>@<host>/me/<token>.git` and the remote is unreachable or answers 401, and `agentboard sync` runs
- **THEN** it exits 3 with reason `sync-failed`, git's `unable to access` or `Authentication failed for` line quotes `'<url>/'`, and neither the secret nor the token appears in any output

#### Scenario: Sync on a host-model board
- **WHEN** the host repository's `origin` holds a token as its user name or in its path and answers 401, and `agentboard sync` runs on its host-model board
- **THEN** it exits 3 with reason `sync-failed` and the token appears in no output

#### Scenario: The sync that init --remote runs
- **WHEN** `agentboard init --remote http://<token>@<host>/me/x.git` runs on a standalone board without a remote and the server answers 401
- **THEN** it exits 3 with reason `sync-failed` keeping `origin`, the quoted line reads `http://<redacted>@<host>`, and the token appears in no output

#### Scenario: Joining warnings of init and init --into-host
- **WHEN** `agentboard init` (host model) or `agentboard init --into-host` runs in a host whose `origin` holds a token and answers 401
- **THEN** the warning that the remote could not be reached quotes git sanitised, and the token appears in no output

#### Scenario: URL holding a non-ASCII character or a backslash
- **WHEN** the configured `origin`, the host remote, or the value given to `init --remote` is `http://<host>/<token>/caf\u00e9.git` (or holds a backslash) and cannot be reached, on standalone and host-model `sync`, `init --remote`, the `init` join, `init --into-host` and the `remote:` lines of a refused host push
- **THEN** git's line quotes `<url>`, and the token appears in no output, escaped or not

#### Scenario: Remote named by URL
- **WHEN** `branch.main.remote` or `agentboard.remote` is `http://agent:<secret>@<host>/x.git` and `agentboard sync` fails to reach it
- **THEN** it exits 3 with reason `sync-failed`, the message reads `reaching <url> failed: ...` (or `pulling from <url>`, `pushing to <url>`), and the secret appears in no output

#### Scenario: Proxy credentials
- **WHEN** `http_proxy`, `HTTPS_PROXY`, `all_proxy`, `ALL_PROXY`, `http.proxy` or `remote.origin.proxy` is `http://<token>%20x@<proxy>` (or `%2F`, `%27`), the proxy answers 407, and `agentboard sync` or `init --remote` runs, on git 2.32 (which prints the user name decoded) and later
- **THEN** it exits 3, the proxy is quoted as `<url>` or `http://<redacted>@<proxy>`, and the token appears in no output

#### Scenario: Proxy user information split differently
- **WHEN** `http_proxy` is `http://a@<token>%40x@<proxy>` (git 2.53 prints `http://a@<token, encoded>%2540x%40<proxy>`), or `http://<token>#x@<proxy>` or `http://<token>?x@<proxy>` (curl on git 2.32 prints `Could not resolve proxy: <token>`), and `agentboard sync` runs
- **THEN** it exits 3 with reason `sync-failed` and the token appears in no output, in any encoding

#### Scenario: Split pieces neither unmask nor mangle
- **WHEN** a configured URL is `https://a@http@<host>/x.git` (or `https://a@:@...`, or holds one-letter pieces) and a git line quotes another URL with a token as its user name, or names `refs/agentboard/board` or a host
- **THEN** the other URL is written `http://<redacted>@...`, and the board ref and the host are printed unchanged

#### Scenario: Remote mismatch names the setting that chose the remote
- **WHEN** a standalone board's `branch.main.remote` (with `branch.main.merge`) is a URL with credentials, no such remote exists, and `agentboard init --remote <another url>` runs
- **THEN** it exits 1 with reason `remote-mismatch`, the message says `(git config branch.main.remote)` and `git -C <dir> config --unset branch.main.remote`, names the URL without its credentials, and the secret appears in no output

#### Scenario: Multi-byte character in a proxy's user information
- **WHEN** `http_proxy` is `http://a@<token>\u00e9@<proxy>` and git 2.53 prints the host `<token, encoded>%C3%A9%40<proxy>`
- **THEN** the token appears in no output

#### Scenario: Remote named by a relative path
- **WHEN** `branch.main.remote` is `../<token>/repo.git` and `agentboard sync` cannot reach it
- **THEN** the message reads `reaching <url> failed: ...` (or `pulling from <url>`), and the token appears in no output

#### Scenario: Every later git step
- **WHEN** a remote whose URL holds a credential answers `ls-remote` but fails the later step: the `sync` pull or push, the host-model fetch of the board ref, a push that is not rejected, or a push whose board ref loses the race on the last retry, either fetch of `init --into-host`, the clone or checkout of `init --remote`, or the fetch of the host-model `init` join
- **THEN** each refusal quotes git's line with the URL as `<url>`, and the credential appears in no output

### Requirement: Remote URLs are shown without credentials
Wherever agentboard shows a remote URL taken from the configuration or
given to `--remote` (the success messages of `init --remote`, `init`,
`init --into-host` and `sync`, the `remoteUrl` field of `init --remote
--json`, the text and `--json` output of `agentboard remote`, and the
refusals that name a configured URL, such as `remote-mismatch`), and
wherever it shows a remote's name, which is a URL when `agentboard.remote`
or `branch.<b>.remote` names the remote by URL (`sync`'s `pulled from` and
`pushed to` lines and its `--json` `remote`, on both board models, and
`agentboard remote`'s `remote:` and `problem:` lines and its `--json`
`remote.name`; `init` on an existing board, standalone and host model,
and its `--json` `remote`; `init` creating, joining or repairing a
host-model board (`sync publishes it to`, `joined ... from`); `init
--into-host` on a board already in the host and its `--json` `remote`;
the `remote-mismatch` variant of `init --remote` that names the remote
`agentboard.remote` sets; and the `sync-conflict` refusals naming the
remote a pull or rebase used), and the old remote URL `init --into-host` reports
(`oldRemoteUrl` and its `kept` line, from the configured URL, also when a
move is resumed), it SHALL show the URL with its user information removed
(`<scheme>://<userinfo>@<rest>` written `<scheme>://<rest>`; a URL
without user information, a path and the scp-like `user@host:path` as
they are). The configuration keeps the URL as given: `git remote get-url`
still prints it.

#### Scenario: init --remote with credentials succeeds
- **WHEN** `agentboard init --remote http://agent:<secret>@<host>/x.git` creates, clones, attaches or finds unchanged a board, with and without `--json`
- **THEN** its message names `http://<host>/x.git`, `remoteUrl` is `http://<host>/x.git`, and the secret appears in no output

#### Scenario: agentboard remote
- **WHEN** a board's remotes hold credentials and `agentboard remote` runs, with and without `--json`
- **THEN** every URL it prints is the URL without its user information, and no credential appears

#### Scenario: Remote named by URL on success
- **WHEN** `agentboard.remote` or `branch.main.remote` is `http://agent:<secret>@<host>/r.git`, git can reach it, and `agentboard sync` (standalone or host model) and `agentboard remote` run, with and without `--json`
- **THEN** `sync` prints `pushed main to http://<host>/r.git` and its `--json` `remote` is `http://<host>/r.git`, `agentboard remote` prints `remote: http://<host>/r.git (chosen by ...)` and its `--json` `remote.name` is `http://<host>/r.git`, and the secret appears in no output

#### Scenario: Every place a remote named by URL is shown
- **WHEN** `agentboard.remote` or `branch.main.remote` is `http://agent:<secret>@<host>/r.git` and `agentboard init` runs on an existing standalone or host-model board, creates, joins or repairs a host-model board, `agentboard init --into-host` runs on a board already in the host, `agentboard init --remote <another url>` runs, or a `sync` or `init --into-host` stops on a conflict, with and without `--json`
- **THEN** each message and each `--json` `remote` names `http://<host>/r.git`, and the secret appears in no output

#### Scenario: Old remote URL of a moved or resumed board
- **WHEN** a standalone board whose `origin` is `http://agent:<secret>@<host>/board.git` is moved with `agentboard init --into-host`, or a move interrupted after the worktree was placed is resumed
- **THEN** `oldRemoteUrl` and the `its remote was` line read `http://<host>/board.git`, and the secret appears in no output

#### Scenario: Remote mismatch names the configured URL without its credentials
- **WHEN** a standalone board's `origin` is `http://agent:<secret>@<host>/configured.git` and `agentboard init --remote <another url>` runs
- **THEN** it exits 1 with reason `remote-mismatch` naming `http://<host>/configured.git`, and the secret appears in no output

### Requirement: MCP protocol errors never repeat the request
A JSON-RPC error sent by `agentboard mcp` (an error response to an MCP
request, as opposed to a tool error) SHALL NOT contain any part of a value
the client chose in the request's method or parameters: not in its
`message` and not in a `data` member. This extends the rule of "Refusals
never repeat the refused input" to the protocol surface, with the same
definition of refused input and no ticket id exception. The error SHALL
name what it refuses (the resource, the method, the parameter path) and,
where the valid values are few and fixed, list them. The JSON-RPC `id` of
the request, which every response carries by the JSON-RPC protocol, is not
covered. Error codes are those the server sends today: `-32602` for an
unknown resource, `-32601` for an unknown method, and the SDK's code for a
request whose parameters fail its schema.

#### Scenario: Unknown resource URI holding a token
- **WHEN** an MCP client reads a resource whose URI is a token-shaped value, `agentboard://guide/<token>`, or a URL with credentials (`https://agent:<token>@git.example.com/x.git`), through a real stdio client of the built server and as a raw JSON-RPC request
- **THEN** each response is a JSON-RPC error with code `-32602` whose message is the "Guide over MCP" unknown-resource message, and the token appears nowhere in the response, in the error the client raises or in the server's stderr

#### Scenario: Error code for an unknown resource
- **WHEN** a raw JSON-RPC `resources/read` request names an unknown URI
- **THEN** the error's `code` is the integer `-32602`, its `message` does not begin with `MCP error`, and it has no `data` member

#### Scenario: Unknown method
- **WHEN** a raw JSON-RPC request has a token-shaped value as its method, and requests `prompts/get` with a token-shaped `name`
- **THEN** each response is a JSON-RPC error with code `-32601` and message `Method not found`, and the token appears nowhere in the response or in the server's stderr

#### Scenario: Malformed parameters
- **WHEN** raw JSON-RPC requests send `resources/read` with `uri` a number, `tools/call` with `name` a number, and `tools/call` with `arguments` a token-shaped string
- **THEN** each response is a JSON-RPC error, the server keeps serving, and the token appears nowhere in any response or in the server's stderr
