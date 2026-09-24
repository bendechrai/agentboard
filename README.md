# agentboard

A local, offline, conflict-free ticket board for AI agents working on one
project.

Status: early development, not yet released. Every command below, including
the MCP server, is implemented and tested, but there is no npm release yet,
and commands, flags and output may still change before the first one.

## What it is

Multiple coding agents (and humans) working on the same project, in
separate git worktrees and sometimes on different machines, need a shared
view of who holds which piece of work, what state it is in, what it is
blocked on and what was said in each hand-off, without a hosted service and
without losing an update when two agents write at the same time.

agentboard keeps an append-only event log as the source of truth: every
change (create a ticket, move it, comment on it, close it) is written as its
own content-addressed file under `.board/events/`. Because agents only ever
add new event files and never modify existing ones, concurrent writes from
several agents, or from several machines syncing over git, never clobber
each other. A SQLite database (`.board/cache.sqlite`) is derived from the
event log as a disposable read cache; it can be deleted at any time and is
rebuilt from the events by the next command.

See `docs/adr/` for the reasoning behind the design, starting with
`docs/adr/0001-event-log-source-of-truth.md`.

## Install and run

Requires Node 22.16 or later (for the built-in `node:sqlite`), `git` on the
PATH for board discovery and `sync`, and the GitHub CLI `gh` on the PATH
only for `close-merged`.

Once released, run it with `npx`, no install required:

```
npx @bendechrai/agentboard <command> [arguments]
```

(The `agentboard` package name on npm was already taken by an unrelated
project, so this ships as the scoped package `@bendechrai/agentboard`; the
command it installs is still called `agentboard`.)

Until the first release, build it from this repository:

```
npm ci
npm run build
node dist/cli.js <command> [arguments]
```

`npm link` in this repository puts an `agentboard` command on your PATH.
The examples below write `agentboard`.

There is no `--help` yet (generated help is a planned change); running
`agentboard` with no command prints the list of commands.

## Set up a project

Run `init` once at the root of the project's main checkout:

```
$ agentboard init
created the board at /path/to/project/.board
```

This creates `.board/`, which is itself a small git repository holding
`events/` (with an empty `.gitkeep`) and a `.gitignore` that excludes the
cache (`cache.sqlite` and its `-wal` and `-shm` files). `init` also adds a
`.board/` entry to the host project's `.gitignore` when it is missing, so
board activity never touches the host project's history; commit that
`.gitignore` change. Running `init` again changes nothing and exits 0.

Every command finds the board without being told where it is:

1. `AGENTBOARD_DIR`, when set;
2. otherwise, inside a git repository, `.board` next to the git common dir
   (`git rev-parse --git-common-dir`), so every linked worktree of the
   project sees the main checkout's board with no configuration;
3. otherwise `./.board`.

A command run inside `.board` itself uses that board. When no board is
found, commands exit 2 naming the path they looked at.

## The actor rule

Every command that writes, and `inbox` and `watch` (which keep a per-actor
cursor), needs an actor: `--as <actor>` or, as the fallback, the
`AGENTBOARD_ACTOR` environment variable. With neither, the command exits 1
and says so. The actor is never inferred from the OS user. Every command
accepts `--as`, and commands that do not need it ignore it, so an agent can
pass it on every call.

Use one stable name per role instance, for example `orchestrator`,
`test-1`, `impl-1`, `reviewer-1`.

## Tickets and task references

Every ticket references the unit of planned work it delivers, as a task
reference `<source>:<ref>#<item>`. For OpenSpec, the source is `openspec`,
the ref is the change name and the item is the task group number, for
example `openspec:add-login#2`. `--change <name> --group <n>` is shorthand
for exactly that reference. A ticket that is not planned work must say why
with `--adhoc <reason>`:

```
$ agentboard new "Login form" --as orchestrator --change add-login --group 2 \
    --label ui --checklist "write form" --checklist "validate"
created 01M38YRHC32109EYJ1TPDZPQ2N
01M38YRHC32109EYJ1TPDZPQ2N  todo  -  Login form

$ agentboard new "Fix typo in footer" --as orchestrator --adhoc "reported by a user"
$ agentboard new "Photo albums" --as orchestrator --task speckit:001-photo-albums#phase-2
```

`new` also takes `--description <text>`. With none of `--task`,
`--change`/`--group` or `--adhoc`, it exits 1. A reference in another form
(for example `--task add-login-3`) exits 1 and shows the expected form.
Sources other than `openspec` are accepted and fully usable; only
`import-change` needs a source adapter, and only the `openspec` one ships.
An ad hoc ticket cannot move into `implementing` (exit 4,
`needs-task-link`) until it is linked to a task with `link <id> --task ...`
or `link <id> --change ... --group ...`: the board never introduces scope.

Reading the board:

```
agentboard list                              # open tickets, one per line
agentboard list --status implementing
agentboard list --assignee impl-1
agentboard list --change add-login           # same as --task openspec:add-login
agentboard list --task openspec:add-login#2
agentboard list --label ui                   # repeatable
agentboard list --closed                     # include closed tickets
agentboard show 01M38YRHC3                   # full record, comments, event count
agentboard show 01M38YRHC3 --raw             # the ticket's raw event files
```

Ticket ids are ULIDs; any unique prefix of at least 6 characters works, and
an ambiguous prefix exits 1 listing the matches. `list` prints
`<id>  <status>  <assignee or ->  <title>`, with `[adhoc]` and `[closed]`
markers.

Every command accepts `--json` and then prints exactly one JSON document on
stdout: an object for single-ticket commands, an array for `list`, and for
writing commands an object with the event `hash` and the resulting
`ticket`. The one exception is `watch --json`, which prints one JSON
document per line. Diagnostics always go to stderr.

## Statuses and the state machine

Statuses follow the roles that work on a task group:

| Status         | Meaning                                        |
| -------------- | ---------------------------------------------- |
| `todo`         | not started                                    |
| `tests`        | a test author is writing the tests             |
| `implementing` | an implementer is making the tests pass        |
| `review`       | a reviewer is checking the work                |
| `merged`       | the work has landed (terminal)                 |
| `blocked`      | waiting on something; remembers where it was   |

Permitted moves:

- `todo` to `tests`, `tests` to `implementing`, `implementing` to `review`;
- `review` to `implementing` (sent back), `review` to `tests` (the tests
  need changing), `review` to `merged`;
- any status except `merged` to `blocked`, and `blocked` back to the status
  it was blocked from, which `move <id>` with no target does for you.

Anything else, including a move to the current status, exits 4 with reason
`invalid-transition`. `merged` is terminal.

## Working a ticket

```
agentboard claim 01M38YRHC3 --as test-1
agentboard move 01M38YRHC3 tests --as test-1
agentboard handoff 01M38YRHC3 --as test-1 --to impl-1 --status implementing \
    --note "red tests in src/login.test.ts"
agentboard checklist tick 01M38YRHC3 0 --as impl-1
agentboard comment 01M38YRHC3 --as impl-1 "using the existing session store"
agentboard move 01M38YRHC3 blocked --as impl-1
agentboard comment 01M38YRHC3 --as impl-1 "blocked on the API decision in #41"
agentboard move 01M38YRHC3 --as impl-1        # back to implementing
agentboard link 01M38YRHC3 --as impl-1 --pr 42
agentboard release 01M38YRHC3 --as impl-1
```

- `claim` assigns an unassigned ticket to the actor. On a ticket someone
  else holds it exits 4 with reason `already-assigned` naming the holder;
  claiming a ticket you already hold exits 0 and writes nothing, so a
  retried claim is safe. When several agents race to claim one ticket,
  exactly one wins.
- `release` clears the assignment; only the assignee may release (else
  exit 4, `not-assignee`).
- `handoff` does three things in one event: assigns `--to`, moves to
  `--status` (subject to the state machine; naming the current status only
  reassigns) and records `--note` as a comment by the actor. If the move is
  not permitted, nothing is written and it exits 4.
- `move <id> <status>` and `move <id>` (leave `blocked`) change status only.
  Blocking is a `move` to `blocked` plus a `comment` saying why.
- `comment <id> <text>` appends to the ticket's thread. Text that starts
  with `-` goes after `--`: `comment <id> --as a -- "- item"`.
- `checklist tick <id> <index>` and `checklist untick` set a checklist line
  (indexes start at 0). A tick prints a reminder naming the tasks file:
  the board never marks a task complete; the task's checkbox in `tasks.md`
  is ticked in the implementing PR.
- `link <id>` adds exactly one of `--task`, `--change` with `--group`,
  `--pr <url or number>` or `--decision <path>`.

## The orchestrator inbox protocol

An orchestrator coordinates agents from the board, not from its own memory:

1. Before dispatching any agent, run `agentboard inbox --as orchestrator`
   and act on every event it returns.
2. The dispatched agent claims its ticket.
3. When done, the agent hands off to the next role (`handoff ... --status
   review`), or moves the ticket to `blocked` with a comment.
4. For current state, use `show` or `list`, never a remembered picture of
   the board.

```
$ agentboard inbox --as orchestrator
01M38YRHDJDH9E02WN42FFWFMT  ticket.handoff  impl-1  to reviewer-1  status review  note green, 96%
$ agentboard inbox --as orchestrator
$
```

`inbox` returns every effective event after the actor's cursor, in board
order, including the actor's own events, and then advances the cursor, so a
second call returns nothing new. Rejected or unreadable events never
appear. It never skips an event, including one that arrives by `sync` with
a timestamp earlier than events already seen. `--peek` lists without
advancing. `--since <hash>` lists the events after the named event (its
full 64-character hash, from `--json` output) and implies `--peek`. An
actor with no cursor yet receives every event on the board.

`agentboard watch --as <actor>` prints the same entries as they arrive
(using `fs.watch` with a 2 second polling fallback) until stopped with
Ctrl-C. It never advances the cursor: watching is not acknowledging, so run
`inbox` to acknowledge what you have acted on.

## Decisions and closing tickets

Decisions belong in specs and ADRs, not in ticket threads. When a
discussion on a ticket settles something, record it in a comment beginning
with `DECISION:`, then promote it to a spec delta or ADR before the ticket
closes.

`close` requires exactly one disposition:

```
agentboard close 01M38YRHC3 --as orchestrator --decision-recorded-in docs/adr/0002-sessions.md
agentboard close 01M38YRHC3 --as orchestrator --no-decision
```

- With neither flag, `close` exits 1 and explains the rule.
- `--decision-recorded-in` must name a file that exists inside the current
  working tree (relative paths resolve against the current directory); it
  is recorded relative to the working tree root, so it means the same thing
  in every worktree and clone. A missing file exits 1.
- `--no-decision` is refused (exit 1, quoting the comments) while the
  ticket has a `DECISION:` comment that its author has not retracted with a
  later comment beginning `RETRACTED:`.
- Only tickets in `merged` or `blocked` can be closed. Closed tickets drop
  out of `list` unless `--closed` is given.

## OpenSpec integration

`agentboard import-change <name> --as <actor>` reads
`openspec/changes/<name>/tasks.md` (the OpenSpec root is found the same way
as the board) and creates one ticket per numbered task group: titled with
the group heading, with task reference `openspec:<name>#<n>`, labels
`change:<name>` and `group:<n>`, and the group's task lines as its
checklist, with ticks copied. A group whose tasks are all ticked is
imported as `merged`.

```
$ agentboard import-change add-search --as orchestrator
created 01M38YSQQ5DQ05MQ21B5DCCJZ6  merged  -  Index
created 01M38YSQS830A0HTFQ9H8KRZ4D  todo  -  Query
imported openspec:add-search: 2 created, 0 updated, 0 unchanged, 8 events
```

Re-importing is safe: tickets are matched by task reference, no duplicate
is ever created, and new task lines are appended to existing checklists
(existing lines, titles, labels and statuses are never changed). Run it
again whenever a change's `tasks.md` grows.

`agentboard close-merged --as <actor>` closes every open `merged` ticket
whose `pr` link points at a merged pull request, with the ticket's
`decision` link as the disposition when it has one and `--no-decision`
otherwise, and lists the tickets whose PR is not merged yet or that could
not be closed (for example because of an open `DECISION:` comment). It asks
GitHub through `gh pr view`, so it needs `gh` on the PATH and authenticated
for the repository; without `gh` it exits 1 when there is anything to
check.

## Sync between machines

`.board/` is its own git repository, so the board moves between machines
(a desktop and a laptop, say) without touching the host project. Give it a
remote once:

```
git -C .board remote add origin <url-of-an-empty-repository>
agentboard sync
```

On another machine, clone the host project, then clone the board into it
with `git clone <board-url> .board` (the host `.gitignore` already ignores
it).

`agentboard sync` stages only new event files and `.board/.gitignore`,
commits them as the fixed identity `agentboard <agentboard@localhost>`
(never your git identity, and only when something is staged), runs
`git pull --rebase` from the upstream remote (or `origin`, or the only
remote), pushes (retrying once if the remote moved in between) and folds
the events that arrived. Event files are add-only and named by their
content, so two machines that both added events always merge without
conflict and end up with identical boards. Without a remote, `sync` commits
and reports that no remote is configured, exiting 0. It warns (without
failing) when the host repository tracks anything under `.board`.

`sync` exits 3 and leaves things for a human when:

- git reports a conflict (only possible on non-event paths such as
  `.board/.gitignore`); the rebase is left in place: resolve it, `git add`,
  `git rebase --continue` (or `--abort`) and run `sync` again;
- a rebase, merge or cherry-pick is already in progress in `.board`;
- `.board` is on a detached HEAD;
- something you staged yourself in `.board` is still staged (sync commits
  only its own paths; commit or unstage it);
- the remote is unreachable or rejects the pull or push.

It exits 5 without staging anything when event files recorded in the
board's git history are missing from `events/` (restore them from git), 2
when `.board` is not itself the top level of a git repository, and 1 when
there are several remotes and none is the upstream or `origin`.

Sync is for machines that take turns, not for several people editing at
once.

## Rebuild and checking the cache

The cache is derived from the events and every command catches it up
before it runs, so you rarely need these:

```
agentboard rebuild           # refold every event file into the cache
agentboard rebuild --check   # compare the cache with a fresh fold; change nothing
```

`rebuild` reports counts of folded, rejected, malformed, corrupt and
unknown-kind events, keeps every actor's inbox cursor, and lists any event
it made effective behind an actor's cursor (that cursor is moved back so
`inbox` delivers the event). `rebuild --check` exits 1 when the cache
differs from the events (naming the differing rows), when there is no cache
file, or when the file is not a cache of the running version; it never
modifies the cache.

## Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | success |
| 1 | usage error, missing actor, refused text or close disposition, or `rebuild --check` found a difference |
| 2 | board not found or unreadable |
| 3 | sync problem that needs a human |
| 4 | action rejected by board state: `invalid-transition`, `already-assigned`, `not-assignee`, `unknown-ticket`, `needs-task-link`, `checklist-index` |
| 5 | event log or cache integrity problem, or the cache still locked after the busy timeout and one retry |

## MCP server

`agentboard mcp` serves the board to MCP clients over stdio, with one tool
per command, named `board_<command>` with spaces and hyphens turned into
underscores: `board_new`, `board_show`, `board_list`, `board_claim`,
`board_release`, `board_move`, `board_comment`, `board_handoff`,
`board_link`, `board_checklist_tick`, `board_checklist_untick`,
`board_close`, `board_inbox`, `board_import_change` and
`board_close_merged`. `init`, `watch`, `rebuild`, `sync`, `mcp` and
`version` are not exposed: they are run by a human or an orchestrator in a
shell. Calling an unknown or excluded tool name returns a tool error with
`exitCode` 1 and `reason` `usage`.

- Tool input schemas come from the same command registry as the CLI, with
  the same arguments (flag names without the leading `--`, for example
  `{"id": "01M38YRHC3", "as": "impl-1"}`), the same required fields and
  the same validation; `--json` is implied.
- The actor of a call is, in order: the call's `as` argument, the default
  given to the server as `agentboard mcp --as <actor>`, then
  `AGENTBOARD_ACTOR` in the server's environment. With none of them a
  writing tool fails exactly as the CLI does (exit code 1,
  `missing-actor`).
- A successful call returns the same JSON document the CLI prints with
  `--json`, as text and as structured content. Structured content must be
  an object, so an array result (`board_list`, `board_show` with `raw`)
  arrives as `{"items": [...]}`.
- A failed call returns a tool error (`isError` true) whose structured
  content is `{exitCode, reason, message}`, with the exit code the CLI
  would have used, for example `exitCode` 4, `reason` `already-assigned`
  and a message naming the holder.
- The server locates the board once at start-up, from its working
  directory, by the usual discovery rules, and exits 2 before serving
  anything if there is none. Every call catches up with events written
  since by any process and runs the same single transaction as the CLI, so
  MCP and CLI writers can race safely.

For Claude Code, put this in `.mcp.json` at the project root (one actor per
agent; drop `--as` to have each call pass `as`, or to use
`AGENTBOARD_ACTOR`):

```json
{
  "mcpServers": {
    "agentboard": {
      "command": "npx",
      "args": ["-y", "@bendechrai/agentboard", "mcp", "--as", "impl-1"]
    }
  }
}
```

The package is not on npm yet. Until it is, build from source (see
"Install and run") and point the server at the built file instead:

```json
{
  "mcpServers": {
    "agentboard": {
      "command": "node",
      "args": ["/path/to/agentboard/dist/cli.js", "mcp", "--as", "impl-1"]
    }
  }
}
```

## What the board is not

- **Not a secret store.** `new`, `comment` and `handoff` refuse text that
  looks like a secret (private key PEM headers, AWS access key ids, GitHub
  tokens, long base64 strings after `token`, `secret`, `password` or
  `key`), exiting 1 with the pattern name and never echoing the text.
  `--allow-secret-like` overrides this for a false positive. Board events
  are synced and kept forever; never put credentials in them.
- **Not the record of completion.** `tasks.md` checkboxes, ticked in the
  PR that does the work, record what was built. The board records who
  holds the work and its state in flight.
- **Not where decisions live.** A `DECISION:` in a thread must be promoted
  to a spec delta or ADR before the ticket closes.
- **Not a source of scope.** Tickets reference planned tasks; ad hoc
  tickets must be linked to one before implementation starts.
- **Not a multi-user server.** It is local and offline; `sync` moves it
  between machines that take turns.

## Contributing

Behavior changes go through an OpenSpec change proposal under
`openspec/changes/` before implementation; decisions are recorded in
`docs/adr/`. See CONTRIBUTING.md for the workflow and `docs/STATUS.md` for
where the build is.
