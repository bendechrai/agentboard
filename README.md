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

Requires Node 22.16 or later (the store uses `node:sqlite` and its
`DatabaseSync.isTransaction`, added in 22.16), `git` on the
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
The examples below write `agentboard`. `npm link` installs into the
global prefix of the Node version that is active when you run it, so
after switching Node versions (with nvm, for example) run `npm link`
again, or `agentboard` is not found.

To use the linked build in another project, run this at that project's
root:

```
agentboard init
agentboard agents install --mcp-command agentboard
```

`--mcp-command agentboard` registers the MCP server in `.mcp.json` as
the linked `agentboard` command. Without it, `agents install --target
mcp-json` writes an entry that runs `npx -y @bendechrai/agentboard mcp`,
which fails until the package is published, because `npx` fetches the
package from the npm registry rather than using the link (see
"Installing agent guidance into a project" and "MCP server").

`agentboard` with no command, `agentboard --help` and `agentboard help`
print the list of commands; see "Getting help" below.

## Getting help

Help is generated from the same command registry that drives the parser
and the MCP tools, so it always matches the commands the running version
accepts. None of it needs a board or an actor.

```
agentboard                     # the overview: every command, grouped, with its summary
agentboard --help              # the same (so do -h and help)
agentboard help claim          # one command's help
agentboard claim --help        # the same
agentboard help --json         # the overview as a JSON array of registry entries
agentboard help handoff --json # one command's registry entry as a JSON object
```

The overview lists the commands in five groups (ticket lifecycle, change
awareness, planning integration, maintenance, setup) and ends with the line
`Agents: run 'agentboard help agents' before first use.` A command's help
shows its synopsis, summary and description, every argument and flag with
its type and whether it is required, the global flags (`--json`, `--as`),
the exit codes it can produce with their reasons, and examples. `--json`
goes after the command, like every other flag. `--help` and `-h` work
anywhere before a lone `--`, for example `agentboard handoff 01M38Y --help`.

An unknown command or flag exits 1, names the token, suggests up to three
commands or flags within an edit distance of 2, and points to the help:

```
$ agentboard clam 01J9K3 --as impl
agentboard: unknown command clam; did you mean claim? run 'agentboard help' to list the commands
hint: see the commands with 'agentboard help'
$ agentboard list --stauts todo
agentboard: unknown flag --stauts for list; did you mean --status? run 'agentboard help list' to list its flags
hint: check the arguments with 'agentboard help list'
```

A two-word command is suggested when its first word is close enough
(`checklist tik` suggests `checklist tick` and `checklist untick`).

## The agent guide

`agentboard help agents` prints a plain ASCII guide of at most 150 lines,
stamped with the version, written for a coding agent that has never seen
the board: what the board is and is not, the actor rule, finding work
(`inbox`, `list`), claiming before starting, handing off and blocking with
a comment, the `DECISION:` convention and why `close` needs a disposition,
how tickets map to planning tasks (including the OpenSpec flow), using the
MCP tools instead of the shell when they are available, and the exit codes.

```
agentboard help agents
agentboard help agents --role orchestrator
```

`--role` appends a checklist for one role: `orchestrator`, `test-author`,
`implementer` or `reviewer`. Any other role exits 1 and lists the four.
The test suite parses every guide line that begins with `agentboard `
against the command registry, so the guide cannot name a command or flag
that the CLI does not accept. The same text is served over MCP (see "MCP
server"), and the guidance that `agents install` writes into a project
points agents here.

## Set up a project

Run `init` once at the root of the project's main checkout:

```
$ agentboard init
created the board at /path/to/project/.board
Next: run 'agentboard agents install' so this project's coding agents learn to use the board.
```

This creates `.board/`, which is itself a small git repository holding
`events/` (with an empty `.gitkeep`) and a `.gitignore` that excludes the
cache (`cache.sqlite` and its `-wal` and `-shm` files). `init` also adds a
`.board/` entry to the host project's `.gitignore` when it is missing, so
board activity never touches the host project's history; commit that
`.gitignore` change. Running `init` again changes nothing and exits 0.
Either way its last line suggests `agentboard agents install` (see
"Installing agent guidance into a project"); `init --json` prints only
its JSON document.

Every command finds the board without being told where it is:

1. `AGENTBOARD_DIR`, when set;
2. otherwise, inside a git repository, `.board` next to the git common dir
   (`git rev-parse --git-common-dir`), so every linked worktree of the
   project sees the main checkout's board with no configuration;
3. otherwise `./.board`.

A command run inside `.board` itself uses that board. When no board is
found, commands exit 2 naming the path they looked at.

## Installing agent guidance into a project

`agentboard agents install` writes short guidance into the project so
that the coding agents working in it know the board exists and follow
its rules. The installed text is a pointer, not a copy of the guide: it
says when to use the board, states the five rules an agent must never
break (always pass an actor; claim before working; hand off or block with
a comment before stopping; never mark completion on the board instead of
in the tasks file; promote `DECISION:` comments before closing) and sends
the agent to `agentboard help agents` for everything else, so it does not
go stale when the CLI changes.

```
agentboard agents install                                  # auto-detect the targets
agentboard agents install --target claude --target agents-md
agentboard agents install --target mcp-json                # never auto-selected
agentboard agents install --mcp-command agentboard         # also register a linked agentboard in .mcp.json
agentboard agents install --force                          # overwrite content agentboard does not own
agentboard agents check                                    # is the installed guidance current?
```

It writes into the root of the current working tree (`git rev-parse
--show-toplevel`, or the current directory outside git), not into the main
checkout that holds `.board`: the files are ordinary project changes that
belong on the branch you are working on, so commit them. It needs no board
and no actor, and runs no git command that changes anything.

The targets (`--target` is repeatable; they are always processed in this
order):

| Target      | File                                | What agentboard owns and writes |
| ----------- | ----------------------------------- | ------------------------------- |
| `claude`    | `.claude/skills/agentboard/SKILL.md` | the whole file: a Claude Code skill, `name: agentboard`, whose description triggers on claiming, handing off or blocking work, checking what other agents are doing, recording a decision and applying or archiving an OpenSpec change; marked `<!-- agentboard-guidance: v<N> -->` |
| `agents-md` | `AGENTS.md`                          | the block between `<!-- agentboard:start v<N> -->` and `<!-- agentboard:end -->`, appended to the file (or a new file) and replaced in place on later installs |
| `openspec`  | `openspec/config.yaml`               | `guidance` entries beginning `agentboard:` under `operations.apply` (claim the group's ticket before implementing, hand off or block before stopping, tick `tasks.md` in the implementing PR) and `operations.archive` (run `close-merged` first and archive only when no ticket of the change is open; promote `DECISION:` comments), each followed by the comment `# agentboard-guidance: v<N>` |
| `mcp-json`  | `.mcp.json`                          | the `mcpServers.agentboard` entry: `npx -y @bendechrai/agentboard mcp`, or `<executable> mcp` with `--mcp-command <executable>` |

With no `--target`, it selects `claude` when `.claude/` exists,
`agents-md` when `AGENTS.md` exists and `openspec` when
`openspec/config.yaml` exists, and prints each choice with its reason.
`mcp-json` is never auto-selected, because registering a server changes
what every session in the project loads: it is installed only when asked
for with `--target mcp-json` or `--mcp-command`. When nothing is detected
it exits 1 (reason `no-targets`) and lists the four targets.

### The MCP entry and `--mcp-command`

The `mcp-json` target writes one of two entry shapes, and both are
agentboard's own (managed) entry:

```json
{ "command": "npx", "args": ["-y", "@bendechrai/agentboard", "mcp"] }
```

by default, which works once the package is published to npm, or, with
`--mcp-command <executable>`:

```json
{ "command": "<executable>", "args": ["mcp"] }
```

for a linked or local install: `--mcp-command agentboard` after `npm
link`, or an absolute path such as `/opt/agentboard/bin/agentboard`. The
value is one executable, a name on the PATH or a path, and `mcp` is
always its only argument. It is written as given, never resolved or
checked for existence, because `.mcp.json` is also read on other
machines. Giving `--mcp-command` selects the `mcp-json` target in
addition to the explicit or auto-detected ones, and the output says so:

```
$ agentboard agents install --mcp-command agentboard
selected claude: .claude/ exists
selected mcp-json: requested with --mcp-command
created claude .claude/skills/agentboard/SKILL.md
created mcp-json .mcp.json
agents install: 2 created, 0 updated, 0 unchanged, 0 refused (guidance v1) in /path/to/project
```

An existing `mcpServers.agentboard` entry is managed when it is exactly
the `npx` entry, or exactly `{"command": <non-empty string>, "args":
["mcp"]}` with no other keys. On a later install:

- without `--mcp-command`, a managed entry of either shape is left
  unchanged (reported `unchanged`); it is not switched back to `npx`;
- with `--mcp-command <executable>`, a managed entry that already runs
  that executable is left unchanged, and one of either shape that runs
  anything else is replaced (reported `updated`), without `--force`;
- any other entry (an extra key such as `env`, other arguments such as
  `--as impl-1`) is refused as `entry-differs`, with or without
  `--mcp-command`, unless `--force` is given, which replaces it with the
  requested shape.

`--force` does not turn a managed local entry back into the `npx` one,
since there is nothing to override; to return to `npx`, delete the
`agentboard` entry and run `agents install --target mcp-json` again.

An `--mcp-command` value that is empty or contains a newline, or a
missing value, is a usage error: exit 1 with reason `usage`, and nothing
is written.

```
$ agentboard agents install
selected claude: .claude/ exists
selected openspec: openspec/config.yaml exists
created claude .claude/skills/agentboard/SKILL.md
updated openspec openspec/config.yaml
agents install: 1 created, 1 updated, 0 unchanged, 0 refused (guidance v1) in /path/to/project
```

Each target reports `created`, `updated`, `unchanged` or `refused`.
Reinstalling with the same guidance version changes no byte of any file
and reports every target `unchanged`; after an upgrade it rewrites only
agentboard's own region. `<N>` is the guidance version (`GUIDANCE_VERSION`),
an integer bumped only when the installed text changes, not on every
release. `--json` prints `{root, version, autoDetected, targets, refused}`,
with one `{target, path, reason, action, refusal, message, manual}` per
target.

Installed guidance never clobbers your content. Everything in `AGENTS.md`
and `SKILL.md` outside agentboard's region is kept byte for byte.
`openspec/config.yaml` and `.mcp.json` are rewritten through a YAML or
JSON serializer: every other key, value, entry and comment is kept in
order, but insignificant formatting (indentation, quoting style) may be
normalized. When the `operations` key is added to the template that
`openspec init` generates, it goes at the end, after the commented
examples.

A target is refused (nothing is written for it, the message names the
file, the other targets are still processed, and the command exits 1)
when:

- `SKILL.md` exists without the `agentboard-guidance` marker (someone
  else's skill);
- `AGENTS.md` has agentboard markers that are not exactly one well-formed
  start and end pair;
- `operations`, `operations.<op>` or its `guidance` in
  `openspec/config.yaml` is not the map or list OpenSpec expects; the
  lines to add by hand are printed (and are in `manual` with `--json`);
- `.mcp.json` already has an `mcpServers.agentboard` entry that is not
  a managed entry (reason `entry-differs`; an added `env` or other
  arguments count, see "The MCP entry and `--mcp-command`").

`--force` overrides those four: it overwrites the foreign `SKILL.md`,
removes the malformed marker lines (and nothing else) and appends a fresh
block, replaces the wrongly typed YAML value, or replaces the differing
server entry. These refusals are never overridden, even with `--force`:

- `openspec/config.yaml` is missing (run `openspec init` first; agentboard
  never creates it) or cannot be parsed, or `.mcp.json` is not a JSON
  object with an `mcpServers` object;
- outside the tree: the target path, with symlinks resolved, is outside
  the working tree (a `.claude` symlink to another directory, for
  example); nothing outside the tree is read, created or written;
- not a file: the path is a directory, or a parent of it is not a
  directory (`EISDIR`, `ENOTDIR`);
- unwritable: reading or writing the file, or creating its directory,
  fails with `EACCES` or `EPERM`. An `unchanged` target is not refused for
  a read-only file.

`agentboard agents check` inspects every target that has an agentboard
marker or managed entry in the current working tree and reports each as:

- `current`: exactly what `agents install` would write now;
- `stale`: installed by a different guidance version;
- `modified`: its managed text differs from what its recorded version
  renders (edited by hand), its version or markers cannot be read, or the
  file cannot be read; for `mcp-json`, which carries no version, the entry
  is not a managed entry.

For `mcp-json`, a managed entry of either shape (the `npx` entry, or any
executable with exactly `["mcp"]` as its arguments) is `current`, so a
project using a linked build can run `agents check` in its own checks
too.

```
$ agentboard agents check
current claude .claude/skills/agentboard/SKILL.md (installed v1, current v1)
current openspec openspec/config.yaml (installed v1, current v1)
current mcp-json .mcp.json (installed unknown, current v1)
```

It exits 0 when every target found is current (or when none is found,
which it says) and 1 otherwise, with a line on stderr counting the targets
that are not current, so a project can run it in its own checks; `agents
install` brings them up to date. `--json` prints an array of `{target,
path, state, installedVersion, currentVersion}` (`installedVersion` is
null when it is unknown, and always for `mcp-json`).

This repository installs its own guidance the same way: see "Using
agentboard in a project" in CONTRIBUTING.md.

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
  with `--` would be read as a flag, so it goes after a lone `--`:
  `comment <id> --as a -- "--force was needed"`.
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
To follow the whole board rather than one actor's inbox, use
`agentboard top` (see "Watching the board in a terminal").

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

## Watching the board in a browser

`agentboard serve` starts a small, read-only web server for the board and
prints a URL to open in a browser. The page shows the whole board and keeps
itself up to date as agents write, including events that arrive late
through `sync`, with no reload:

- **Board**: one column per status, one card per ticket (title, short id
  with the full id as its tooltip, assignee, task reference or an "ad hoc"
  badge, labels, checklist progress, open decisions, a "from <status>"
  badge on a blocked ticket and a "closed" badge on a closed one), cards
  that just changed highlighted.
  Filter by change and by assignee; closed tickets are hidden unless you
  ask for them.
- **Feed**: every applied event on the board as a one-line summary,
  newest first, filterable by change, actor and event kind. Events that arrived late
  through `sync` are marked.
- **Ticket detail** (click a card or a feed entry): the ticket's fields,
  checklist, links and close disposition, its conversation (comments and
  hand-off notes, with `DECISION:` comments highlighted and retracted ones
  flagged), and every event on it with its outcome, including rejected
  ones with their reason (for example a claim that lost a race,
  `already-assigned`).
- **Lanes**: one lane per actor with the tickets they hold and when they
  were last seen, refreshed at least every 10 seconds.

The current view and its filters live in the URL hash (`#/board`,
`#/feed`, `#/ticket/<id>`, `#/lanes`), so a reload keeps them.

### Starting it

Run it from anywhere inside the project, like any other command:

```
$ agentboard serve
serving /home/me/project/.board read-only at http://127.0.0.1:54311/#token=hzU-J7pLcQxvMQCgXAsoeqFd9WSEPMU2vG6PHqUTWoM
```

Open that URL, the whole of it, in a browser. The server runs until you
stop it with Ctrl-C (SIGINT) or SIGTERM, then exits 0.

- `--port <n>` listens on port `n` (0 to 65535). Without it the operating
  system picks a free port, which is fine: the token changes at every start,
  so the URL changes anyway. A port that is already in use exits 1 with
  reason `port-in-use`.
- `--open` also asks the system to open the URL in your default browser.
  If that fails you get a warning on stderr and the server keeps running.
- `--json` prints one JSON line instead of the `serving` line, and nothing
  else on stdout:

  ```
  {"url":"http://127.0.0.1:54311/#token=hzU-...","port":54311,"token":"hzU-...","writable":false}
  ```

`serve` writes no event and needs no actor (`--as` is accepted and
ignored). It never moves an inbox cursor; the only change it makes to the
board is the cache catch-up every read command does. It is not exposed as
an MCP tool.

### Security model

The server is meant for your own machine, with a browser that also has
arbitrary web sites open. What it does:

- **Loopback only.** It listens on `127.0.0.1` and nothing else, so no
  other machine can reach it.
- **A new token every run.** At start-up it draws 32 random bytes (43
  characters of base64url). Every request under `/api/`, the live stream
  included, needs exactly one `Authorization: Bearer <token>` header;
  anything else is 401 `unauthorized`. A request with two `Authorization`
  headers is refused too. A `?token=` query parameter and cookies are
  ignored. Tokens are compared in constant time and are never logged,
  written to disk or sent back in any response.
- **The token travels in the URL fragment.** The start-up URL ends in
  `#token=<token>`. Browsers never send the fragment to a server or put it
  in a `Referer`. The page moves the token into the tab's `sessionStorage`
  (key `agentboard-token`), removes the fragment from the address bar, and
  sends the token as the bearer header on every API and stream request.
  The page itself and its script and stylesheet need no token: they are the
  same files for every board and contain no board data.
- **No cookies.** The server never sets one. Browsers share cookies
  between every port of `127.0.0.1`, so a cookie would have been sent to
  any other local server as well (see ADR 0006).
- **Host check.** Every request must carry exactly one `Host` header that
  is exactly `127.0.0.1:<port>` or `localhost:<port>`; anything else is 403
  `forbidden-host`. This stops DNS rebinding, where a web site points its
  own domain at `127.0.0.1` to talk to local servers.
- **No cross-origin access.** No response carries any
  `Access-Control-Allow-*` header, and every method but `GET` is refused,
  so CORS preflights never succeed. On `/api/*` the token is checked
  before the method, so a preflight or any other non-`GET` request without
  a token is 401 `unauthorized` (405 with a valid token); on the page and
  its assets a non-`GET` request is 405 `method-not-allowed`.
- **Security headers on every response**, errors included: a strict
  `Content-Security-Policy` (only the server's own script, style and
  connections; no framing), `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`,
  `Cross-Origin-Opener-Policy: same-origin` (the tab that opened the
  start-up URL keeps a window handle, but it is severed: it reports
  `closed` and cannot navigate or script the page) and
  `Cross-Origin-Resource-Policy: same-origin` (no other origin can embed a
  response), plus `Cache-Control: no-store` on API and stream responses.
- **Read-only.** There is no write route, and board text (titles,
  comments, actor names) is always shown as text, never as HTML.

What it does not protect against:

- **Other users of the machine, if you use `--open`.** `--open` passes
  the URL, token included, on a command line. On macOS, and on Linux
  unless `/proc` is mounted with `hidepid`, every local user can read every
  process's command line with `ps`. On macOS, `open` hands the URL to the
  browser by Apple Event, so only the short-lived `open` process shows it.
  On Linux, `xdg-open` starts the browser with the URL as an argument; if
  no browser was running, that browser process can keep the URL in its
  command line for as long as it runs. In that case the token does not
  keep other users' processes out. On a shared machine, copy the printed
  URL into the browser by hand instead of using `--open`.
- **Your own account.** Anyone who can read your terminal or your shell
  scrollback can see the token. The token protects against web pages and,
  when you do not use `--open` on a shared machine, other users'
  processes; it does not protect against you.
- **Browser history.** The page drops the fragment at once, but a browser
  may still have recorded the first URL, token included, in its history.
  Only your account can read that, and the token is dead once the server
  stops.
- **Script in the page.** The token sits in `sessionStorage`, where script
  of the page's own origin could read it. The Content-Security-Policy
  admits only the server's own script and board text is never rendered as
  markup, so there is no known way to inject any.
- **Idle authenticated streams.** A client holding the token can open up
  to 64 streams; one that never reads its first message can keep about the
  size of the board in memory until it disconnects.
- **Large boards.** The page loads every event at start-up; it is built
  for boards of up to about 20,000 events.

A new tab has no token: `sessionStorage` belongs to one tab. Reloading a
tab keeps working, but a tab you open by hand, or a tab left open across a
server restart (the token changes every run), shows "Open the URL printed
by agentboard serve". Open the URL from the terminal again.

### The JSON API

Scripts can read the same data the page does. Every route is `GET`, needs
the bearer header and answers JSON (errors are the same `ErrorDocument`
the CLI prints with `--json`, with a hint):

| Route | Answer |
| ----- | ------ |
| `/api/session` | `{version, boardDir, writable, actor}` (`writable` false, `actor` null) |
| `/api/board` | `{tickets, meta, id}`: every ticket, open and closed, the board meta and the feed position id |
| `/api/tickets/<id>` | `{ticket, events}` for a full id or a unique prefix of at least 6 characters; 400 `id-too-short` or `ambiguous-id`, 404 `unknown-ticket` |
| `/api/events?after=<hash>&limit=<n>` | `{events, next}`: well-formed events in fold order with their outcome, `limit` 1000 by default and at most 5000; pass `next` as `after` for the next page (null on the last) |
| `/api/actors` | the agent lanes |
| `/api/stream?since=<id>` | Server-Sent Events: `append` and `resync` events with position ids, a `problem` event on a tick failure; resumes from `Last-Event-ID` or `since` |

Start the server in one terminal with `agentboard serve --port 4477
--json`, copy the `token` from its line, and in another terminal:

```
$ TOKEN=<token>
$ curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4477/api/session
{"version":"0.0.1","boardDir":"/home/me/project/.board","writable":false,"actor":null}
$ curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:4477/api/events?limit=100"
$ curl -s -N -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4477/api/stream
retry: 2000

event: append
id: fd5752a1...
data: {"type":"append","id":"fd5752a1...","events":[...],"tickets":[...]}
```

### Troubleshooting

- **The page says "Open the URL printed by agentboard serve".** The tab
  has no token or a stale one (a new tab, or the server was restarted).
  Open the full URL from the terminal, including `#token=...`.
- **`port-in-use`.** Something else listens on that port. Omit `--port`,
  or pass `--port 0`, and let the system choose.
- **403 `forbidden-host`.** The request did not reach the server as
  `127.0.0.1:<port>` or `localhost:<port>`, for example through a proxy,
  another host name or `[::1]`. Use the printed URL as it is.
- **401 `unauthorized` from curl.** Send exactly one `Authorization:
  Bearer <token>` header with the token of the running server; a query
  parameter or a cookie does not count.
- **405 `method-not-allowed`.** The server answers only `GET` (curl's
  `-I` sends `HEAD`).
- **Nothing updates.** The page reconnects to the stream on its own and
  shows a banner when the server reports a problem (for example a corrupt
  event file); the server keeps running and recovers once it is fixed. If
  the server was stopped, restart it and open the new URL.
- **No board found.** Like any command, `serve` exits 2 outside a project
  with a board; run it inside the project or set `AGENTBOARD_DIR`.

## Watching the board in a terminal

`agentboard top` shows the whole board full screen in the terminal you run
it in, in the spirit of `top(1)`, and keeps it up to date as agents write.
It is the terminal counterpart of `serve`, for when a browser is awkward
(for example over SSH on the machine where the agents run), and it shows
the same data: both are built on the same board feed and view-model (see
ADR 0007).

```
$ agentboard top
agentboard top  todo:3 tests:1 implementing:0 review:0 blocked:0 merged:0  last~
todo 3      |tests 1     |implement~ 0|review 0    |blocked 0   |merged 0
Parse config|Write fold ~|            |            |            |
-           |test-1      |            |            |            |
Add cache l~|            |            |            |            |
impl-1      |            |            |            |            |
...
[1 board] 2 feed 3 lanes  tab  hjkl move  enter open  c closed  ? help  q quit
```

The first line shows the ticket count per status, the time since the last
event and the board directory; the last line shows the keys of what you
are looking at. Text that does not fit is cut and ends in `~`. Between
them is one of three views, or a ticket's detail over the current view:

- **Board** (`1`): one column per status (`todo`, `tests`, `implementing`,
  `review`, `blocked`, `merged`), each headed by its status and card
  count. A card takes two lines, the title and then the assignee (`-`
  when unassigned); the detail shows the full id. The selected card is
  shown inverse, a card that changed in the last 5 seconds bold, a
  closed card dim. Closed tickets are hidden until you press `c`. When
  the terminal is at least 140 columns wide, the activity feed is shown
  in a 40-column pane to the right of the columns.
- **Feed** (`2`): every applied event on the board, one line each, newest
  first: how long ago, the actor, the short ticket id and a summary
  (`5m ago   impl 01ARYZ6S41 claimed`). Events that arrived late through
  `sync` are marked `late`.
- **Lanes** (`3`): one block per actor, with when it was last seen and the
  tickets it holds (short id, status and title).
- **Detail** (Enter): the ticket's fields (id, title, status, assignee,
  task reference, labels, description), checklist, links and close
  disposition, then its conversation: comments as `<actor>: <text>`,
  hand-offs as `<actor> -> <to> (<status>): <text>`, system lines (created,
  claimed, moved) indented. Decisions are marked `[DECISION]`, retracted
  decisions `[DECISION, retracted]` and retractions `[RETRACTED]`. Long
  lines wrap rather than being cut.

### Keys

| Key | What it does |
| --- | ------------ |
| `1`, `2`, `3` | board, feed, lanes (closes an open detail) |
| Tab | the next view: board, feed, lanes, then board again |
| arrows, or `h` `j` `k` `l` | move the selection: left and right between board columns, up and down within a column, the feed or the lanes; in a detail, up and down scroll one line |
| Enter | open the detail of the selected card, of the selected feed entry's ticket, or of the first ticket the selected lane holds |
| Escape, Backspace | close the detail (the selection is kept) |
| Page Up, Page Down | scroll the detail or the feed by a screen |
| `c` | show or hide closed tickets |
| `?` | show or hide the key help (Escape also hides it) |
| `q`, Ctrl-C | quit |

Any other key is ignored. The selection follows the item it is on, so a
card that moves to another column as agents work stays selected.

### Live updates

`top` follows the board with the same feed as `serve`: an event written
by any process (an agent's CLI or MCP call, another shell, a `sync`)
appears within about 2 seconds, with no key press. When `sync` brings in
events that sort before ones already shown, or a claim is refolded as
having lost a race, `top` reloads the board and marks the late events
`late` in the feed. Relative times ("5m ago") are refreshed at least
every 10 seconds. While the board's cache is locked by another command
the key line starts with `busy`, and it clears on the next update; any
other failure (for example a corrupt event file) restores the terminal,
then prints the error and its hint and exits with the error's exit code
(5 for an integrity problem).

`top` is read-only: it writes no event and never moves an inbox cursor,
so it needs no actor (`--as` is accepted and ignored). Use the CLI in
another shell to act on what you see. It runs until you press `q` or
Ctrl-C, or it receives SIGINT or SIGTERM, then restores the terminal and
exits 0. It is not exposed as an MCP tool.

### Terminal requirements

- **An interactive terminal.** Standard input and standard output must
  both be a terminal, and `TERM` must not be `dumb`. Otherwise (piped,
  redirected, run from a script or a CI job) `top` exits 1 with reason
  `not-a-tty` before opening the board, writes nothing to stdout and
  prints a hint on stderr. Use `agentboard list` for a snapshot of the
  board, or `agentboard watch --as <actor>` for a line stream of one
  actor's inbox. With `--json`, the failure is the usual JSON error
  document on stdout:

  ```
  $ agentboard top --json | cat
  {"error":{"exitCode":1,"reason":"not-a-tty","message":"agentboard top needs an interactive terminal: standard input and output must be a terminal, and TERM must not be dumb","hint":"top needs an interactive terminal; for a snapshot of the board use 'agentboard list', and for a line stream 'agentboard watch --as <actor>'"}}
  ```

- **At least 60 columns by 15 rows.** In a smaller terminal the screen
  shows only `terminal too small: need 60x15, have <c>x<r>`; `top` keeps
  running and redraws as soon as the terminal is big enough again.
- **Plain ASCII.** Like every human output of the CLI, board text is shown
  as ASCII, with other characters escaped; `serve` shows them in full.
- **Colors.** A few markers are colored (decisions, `late`, `busy`). Set
  `NO_COLOR` to any non-empty value for no color at all; bold, dim and
  inverse remain, so the selection still shows.

`top` uses only the alternate screen, cursor positioning and a few text
attributes, which every common terminal emulator and multiplexer supports
(see ADR 0008), and it restores the terminal on every way out: raw mode
off, cursor shown, alternate screen left, and your previous screen
content back. If a terminal is ever left in a bad state anyway (no echo,
no cursor, keys not working), type `reset` and press Enter.

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

## Error hints

Every refusal also says what to run next. The CLI prints the hint on
stderr, on a line beginning `hint: ` after the error line:

```
$ agentboard claim 01M38YRHC3 --as reviewer
agentboard: ticket 01M38YRHC32109EYJ1TPDZPQ2N is already assigned to impl
hint: another actor holds this ticket, so do not work on it: see who with 'agentboard show 01M38YRHC3', or find your own work with 'agentboard inbox --as reviewer'
```

A missing actor hints both `--as` and `AGENTBOARD_ACTOR`;
`needs-task-link` hints `agentboard link <id> --task
<source>:<ref>#<item> --as <actor>`; a close refused by the decision rule
hints `--decision-recorded-in <path>`. Every rejection reason has a hint,
including those of exit codes 2, 3 and 5 (`board-not-found`, for example,
hints `agentboard init`); only an unexpected failure has none.

With `--json`, stdout carries the error as one JSON document with the
hint as a field, and stderr still has the error and `hint: ` lines:

```
{"error":{"exitCode":4,"reason":"already-assigned","message":"ticket 01M38YRHC32109EYJ1TPDZPQ2N is already assigned to impl","hint":"another actor holds this ticket, so do not work on it: see who with 'agentboard show 01M38YRHC3', or find your own work with 'agentboard inbox --as reviewer'"}}
```

MCP tool errors carry the same `hint` field (see "MCP server"). There a
suggested command that is a tool is written as a tool call, such as
`board_inbox {"as":"reviewer"}`, and the actor advice names the `as`
argument and `agentboard mcp --as <actor>`.

## Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | success |
| 1 | usage error (including an unknown command or flag), missing actor, refused text or close disposition, `rebuild --check` found a difference, an `agents install` target was refused or nothing was detected, `agents check` found guidance that is not current, `serve` could not use its port (`port-in-use`), or `top` was not run in an interactive terminal (`not-a-tty`) |
| 2 | board not found or unreadable |
| 3 | sync problem that needs a human |
| 4 | action rejected by board state: `invalid-transition`, `already-assigned`, `not-assignee`, `unknown-ticket`, `duplicate-create`, `needs-task-link`, `checklist-index` |
| 5 | event log or cache integrity problem, or the cache still locked after the busy timeout and one retry |

## MCP server

`agentboard mcp` serves the board to MCP clients over stdio, with one tool
per command, named `board_<command>` with spaces and hyphens turned into
underscores: `board_new`, `board_show`, `board_list`, `board_claim`,
`board_release`, `board_move`, `board_comment`, `board_handoff`,
`board_link`, `board_checklist_tick`, `board_checklist_untick`,
`board_close`, `board_inbox`, `board_import_change` and
`board_close_merged`. `init`, `watch`, `serve`, `top`, `rebuild`, `sync`,
`mcp`, `version`, `help`, `agents install` and `agents check` are not exposed:
they are run by a human or an orchestrator in a shell (`agents install`
and `agents check` write and read files in the caller's working tree,
which a tool call must not do, and the guide reaches MCP clients as
described below instead of through `help`). Calling an unknown or excluded
tool name returns a tool error with `exitCode` 1, `reason` `usage` and a
hint to call `tools/list`.

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
  content is `{exitCode, reason, message, hint}`, with the exit code the
  CLI would have used, for example `exitCode` 4, `reason`
  `already-assigned`, a message naming the holder and a hint naming the
  tools to call next (see "Error hints"). The text content is the message
  followed by a `hint: ` line.
- The server locates the board once at start-up, from its working
  directory, by the usual discovery rules, and exits 2 before serving
  anything if there is none. Every call catches up with events written
  since by any process and runs the same single transaction as the CLI, so
  MCP and CLI writers can race safely.

The server also teaches its clients how to use the board, since `help` is
not a tool:

- Its `instructions` (sent when a client connects) are a summary of the
  agent guide of at most 2000 characters: the rules an agent must never
  break, written in terms of the tools, ending by naming the resource
  `agentboard://guide`.
- The resource `agentboard://guide` (MIME type `text/plain`) is the full
  guide, identical to the stdout of `agentboard help agents` for the same
  version.
- The resources `agentboard://guide/orchestrator`,
  `agentboard://guide/test-author`, `agentboard://guide/implementer` and
  `agentboard://guide/reviewer` are the guide with that role's checklist,
  identical to `agentboard help agents --role <role>`.
- Reading any other URI fails with the MCP InvalidParams error (-32602).

For Claude Code, register the server in `.mcp.json` at the project root
with `agents install` (see "The MCP entry and `--mcp-command`"). It
writes one of two entries. `agentboard agents install --target mcp-json`
writes the `npx` entry, which works once the package is published:

```json
{
  "mcpServers": {
    "agentboard": {
      "command": "npx",
      "args": ["-y", "@bendechrai/agentboard", "mcp"]
    }
  }
}
```

The package is not on npm yet. Until it is, build from source and `npm
link` it (see "Install and run"), then run `agentboard agents install
--mcp-command agentboard`, which writes an entry that runs the linked
command instead (`--mcp-command` also takes an absolute path to an
executable):

```json
{
  "mcpServers": {
    "agentboard": {
      "command": "agentboard",
      "args": ["mcp"]
    }
  }
}
```

A hand-written entry pointing at the build is no longer needed; both
entries are agentboard's own, so `agents check` reports either as
`current` and a later `agents install` keeps it.

Both entries have no actor: each call then passes `as`, or the server
uses `AGENTBOARD_ACTOR`. To give the server a default actor, one per
agent, add `--as` to the arguments by hand (for example `"args": ["mcp",
"--as", "impl-1"]`). A hand-edited entry is no longer a managed one, so
`agents check` reports it as `modified` and `agents install` refuses it
as `entry-differs` unless `--force` is given, which replaces it.

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
