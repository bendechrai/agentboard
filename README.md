# agentboard

A local, offline, conflict-free ticket board for AI agents working on one
project.

Website: https://bendechrai.github.io/agentboard/

[![The agentboard landing page: a ticket board your agents can share](docs/media/hero.jpg)](https://bendechrai.github.io/agentboard/)

Status: early development. Every command below, including the MCP server,
is implemented and tested, but until 1.0 commands, flags and output may
still change between minor versions.

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

See `adr/` for the reasoning behind the design, starting with
`adr/0001-event-log-source-of-truth.md`.

## Install and run

Requires Node 22.16 or later (the store uses `node:sqlite` and its
`DatabaseSync.isTransaction`, added in 22.16), `git` on the
PATH for board discovery and `sync`, and the GitHub CLI `gh` on the PATH
only for `close-merged`.

Run it with `npx`, no install required:

```
npx @bendechrai/agentboard <command> [arguments]
```

or install it globally to get an `agentboard` command:

```
npm install -g @bendechrai/agentboard
```

(The `agentboard` package name on npm was already taken by an unrelated
project, so this ships as the scoped package `@bendechrai/agentboard`; the
command it installs is still called `agentboard`.)

To run it from a checkout of this repository instead (for example while
working on agentboard itself), build it:

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
which fetches the published package from the npm registry rather than
using the link (see
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
agentboard help config         # both config commands (config set and config get)
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

An unknown command or flag exits 1, suggests up to three commands or flags
within an edit distance of 2, and points to the help. The refusal does not
repeat the unknown token (a token pasted into the wrong place must not land
in a terminal or a log); an unknown flag is named by its position among the
arguments instead:

```
$ agentboard clam 01J9K3 --as impl
agentboard: unknown command; did you mean claim? run 'agentboard help' to list the commands
hint: see the commands with 'agentboard help'
$ agentboard list --stauts todo
agentboard: unknown flag at argument 2 for list; did you mean --status? run 'agentboard help list' to list its flags
hint: check the arguments with 'agentboard help list'
```

A two-word command is suggested when its first word is close enough
(`checklist tik` suggests `checklist tick` and `checklist untick`).

## The agent guide

`agentboard help agents` prints a plain ASCII guide of at most 180 lines,
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
created the board at /path/to/project/.board (host model: a worktree of the host repository at refs/agentboard/board); a new empty board; agentboard sync publishes it to origin, where everyone who can fetch the remote can read it
Next: run 'agentboard agents install' so this project's coding agents learn to use the board.
```

A board's history is kept in git in one of two models:

- **Host model**, the default inside a git repository with git 2.32 or
  later: the board's commits live in the project's own repository under
  the hidden ref `refs/agentboard/board`, and `.board/` is a linked
  worktree of that repository on a detached HEAD, locked with the reason
  `agentboard board` so `git worktree prune` and `git worktree remove`
  leave it alone. The ref is not a branch: it triggers no CI, falls under
  no branch protection, appears in no branch list, and a plain `git clone`
  or `git fetch` never transfers it, so contributors who do not use
  agentboard never see it. Sharing needs no setup: the board travels over
  the project's remote and credentials (see "Sync between machines").
- **Standalone model**: `.board/` is a small git repository of its own.
  `init` creates one outside a git repository, when `AGENTBOARD_DIR` is
  set, when git is older than 2.32, or when the repository's `.git`
  directory is not inside its working tree (a bare repository with linked
  worktrees, `git init --separate-git-dir`, a submodule); it says so in
  each case. Every board made before the host model existed is one.
  `init --remote <url>` creates a standalone board shared through a
  repository of its own, for a board that must stay out of a public
  project.

In both models `.board/` holds `events/` (with an empty `.gitkeep`) and a
`.gitignore` that excludes the cache (`cache.sqlite` and its `-wal` and
`-shm` files). Inside a git repository `init` also adds a `.board/` entry
to the host project's `.gitignore` when it is missing, so board activity
never touches the host project's history; commit that `.gitignore`
change. Running `init` again changes nothing and exits 0, naming the
board's model, where its history lives and the remote `sync` would use;
an interrupted `init` is completed by running it again. With several
remotes and none chosen (no `origin`, no upstream on the main checkout's
branch, no `agentboard.remote`), `init` exits 1 (`ambiguous-remote`) and
creates nothing: set `git config agentboard.remote <name>` and run it
again. Either way its last line suggests `agentboard agents install` (see
"Installing agent guidance into a project"); `init --json` prints only
its JSON document, with `dir`, `created`, `model`, `joined`, `remote`,
`events`, `hostGitignore`, `warnings`, `repair` and `message`.

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
says when to use the board, states the six rules an agent must never
break (always pass an actor; claim before working; hand off or block with
a comment before stopping; never mark completion on the board instead of
in the tasks file; promote `DECISION:` comments before closing; never
create an issue, task file or task reference only to move a ticket, and
give an ad hoc ticket its scope with `--unplanned` or `--task` when it is
merged or closed) and sends
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
agents install: 2 created, 0 updated, 0 unchanged, 0 refused (guidance v2) in /path/to/project
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
agents install: 1 created, 1 updated, 0 unchanged, 0 refused (guidance v2) in /path/to/project
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

This repository installs its own guidance the same way: see "Coordinating
on the board" in CONTRIBUTING.md.

## The actor rule

Every command that writes, and `inbox` and `watch` (which keep a per-actor
cursor), needs an actor: `--as <actor>` or, as the fallback, the
`AGENTBOARD_ACTOR` environment variable. With neither, the command exits 1
and says so. The actor is never inferred from the OS user. Every command
accepts `--as`, so an agent can pass it on every call; a command that needs
no actor checks a given name (below) and does not otherwise use it.

The one exception is `serve`: it needs no actor, ignores
`AGENTBOARD_ACTOR`, and accepts write actions from its web page only when
`--as <actor>` is given on its own command line, writing every event as
that actor (see "Acting from the browser").

Use one stable name per role instance, for example `orchestrator`,
`test-1`, `impl-1`, `reviewer-1`.

An actor name is recorded on every event and shared with every clone of
the board, so it is checked before anything is written. A name passes when
it matches none of the secret patterns of "No secrets on the board" and
has the actor form: 1 to 32 ASCII letters, digits, `.`, `_`, `-` or `@`,
the first a letter or digit (`impl-1`, `Ben`, `ben.dechrai`, `test_author`,
`ben@laptop`). Every command checks a given `--as`, reads included; a
command that needs an actor also checks `AGENTBOARD_ACTOR` when it falls
back to it (a command that needs no actor ignores the variable and never
repeats it); `handoff` checks `--to`; over MCP the `as` and `to` arguments
and `agentboard mcp --as` are checked the same way. A name that fails is
refused with exit 1 and reason `invalid-actor` before the board is opened,
the refusal names where the name came from (`--as`, `AGENTBOARD_ACTOR` or
`--to`) and never the name itself, and `--allow-secret-like` does not
apply: choose another name. The reserved actor `agentboard` is refused as
before (exit 1, `usage`).

Events already on a board are not checked: a ticket held by a name that
can no longer be passed is handed on by another actor with
`release <id> --force --reason "<why>" --as <actor>` (see "Forced
release") or claimed once its lease is claimable, and
`list --assignee <name>` still finds its tickets, whatever the name.

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

An ad hoc ticket is worked like any other: it is claimed, moved through
`tests`, `implementing` and `review`, blocked and handed off with the same
commands. What it needs is a **scope disposition** when it leaves the
flow: whoever moves it to `merged`, or closes it, says on that command
either which planned task the work turned out to deliver (`--task
<source>:<ref>#<item>`, or `--change <name> --group <n>`, validated as
`link` validates them) or why it was never planned (`--unplanned
<reason>`). Without one the move is refused with exit 4 and
`needs-scope-disposition`, and the hint names both flags:

```
$ agentboard move 01M38YRHC32109EYJ1TPDZPQ2N merged --as reviewer-1
agentboard: ticket.move on ticket 01M38YRHC32109EYJ1TPDZPQ2N refused: needs-scope-disposition
hint: merging needs the scope of the work: run 'agentboard move 01M38YRHC32109EYJ1TPDZPQ2N merged --task <source>:<ref>#<item> --as reviewer-1' (or --change <name> --group <n>) naming the planned task it delivered, or 'agentboard move 01M38YRHC32109EYJ1TPDZPQ2N merged --unplanned "<reason>" --as reviewer-1' saying why it was never planned; do not create an issue or task only to satisfy this

$ agentboard move 01M38YRHC32109EYJ1TPDZPQ2N merged --unplanned "production hotfix" --as reviewer-1
01M38YRHC32109EYJ1TPDZPQ2N  merged  impl-1  [unplanned] Fix typo in footer
```

`--unplanned` writes a `ticket.unplanned` event with the reason, and then
the move, in one transaction (both or neither); `--task` writes the same
`ticket.link` that `link` would. A ticket linked earlier with `link`, or
one that already has an unplanned disposition, needs nothing more, and
`--unplanned` on a ticket that names a planned task is refused with exit
4, `already-linked`. `close` takes the same flags (see "Decisions and
closing tickets"). Never create an issue, task file or task reference
only to move a ticket: the disposition is the honest answer to "was this
planned, and if so, where?", and unplanned scope is shown in `list`,
`show`, the web app and `health` rather than blocked (ADR 0013).

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
`<id>  <status>  <assignee or ->  <title>`, with `[adhoc]`, `[unplanned]`
(in place of `[adhoc]` once the unplanned disposition is recorded) and
`[closed]` markers; a ticket with a task reference shows neither of the
first two. `show` prints the `adhoc: <reason>` line and, after it,
`unplanned: <reason> (by <actor>)`; `--json` carries the `unplanned`
object (`reason`, `actor`, `ts`) or null.

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
  exactly one wins. `--ttl` makes the claim a lease that lapses unless it
  is renewed, and `--wait` joins the ticket's queue instead of failing (see
  "Leases, the waiting queue and mutex tickets").
- `release` clears the assignment; only the assignee may release (else
  exit 4, `not-assignee`), except with `--force --reason <text>`, which
  breaks another actor's hold and records who did it and why (see "Forced
  release").
- `handoff` does three things in one event: assigns `--to`, moves to
  `--status` (subject to the state machine; naming the current status only
  reassigns) and records `--note` as a comment by the actor. If the move is
  not permitted, nothing is written and it exits 4.
- `move <id> <status>` and `move <id>` (leave `blocked`) change status only.
  Blocking is a `move` to `blocked` plus a `comment` saying why.
  `move <id> merged` also takes `--task <source>:<ref>#<item>` (or
  `--change <name> --group <n>`) or `--unplanned <reason>`, at most one
  of them, as the scope disposition of a ticket that has no task
  reference yet, and `--allow-secret-like` for a reason that looks like
  a secret.
  Without one, a ticket that has neither a task reference nor an unplanned
  disposition is refused with exit 4, `needs-scope-disposition`; a
  disposition flag with any target but `merged` exits 1 (`usage`) before
  the board is read. `handoff --status merged` is refused the same way and
  its hint points at `move`.
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
actor with no cursor yet receives every event on the board. A line
beginning `GRANTED: ` is a ticket granted to you from a queue, and one
beginning `LOST: ` an event that took a ticket from you (see "Reading
leases and queues").

`agentboard watch --as <actor>` prints the same entries as they arrive
(using `fs.watch` with a 2 second polling fallback) until stopped with
Ctrl-C. It never advances the cursor: watching is not acknowledging, so run
`inbox` to acknowledge what you have acted on.
To follow the whole board rather than one actor's inbox, use
`agentboard top` (see "Watching the board in a terminal").

## Leases, the waiting queue and mutex tickets

A plain claim never ends on its own: only `release` by the holder,
`handoff` or `assign` moves the ticket on. That is right for a task group,
but not for a ticket used as a lock (a merge lock, say), where a holder
that crashes, is killed or simply forgets stalls everyone behind it. For
that, a claim can carry a **lease** that lapses unless the holder keeps
showing it is acting, waiters can join a fair **queue**, and someone who is
not the holder can break a stale hold with an audited **forced release**.
None of this changes a ticket's status, and leases and the queue constrain
only `claim`: every other command works on a leased ticket as before. A
claim without `--ttl` writes the same event as it always did.

If the board is shared between machines, upgrade every machine before
anyone uses `--ttl`, `--wait`, `release --force` or `config set` (see
"Upgrading a board shared between machines"), and note that a lock held
across machines is only as strong as `sync` (see "Clocks, skew and several
machines").

### Leases: `claim --ttl` and `renew`

```
agentboard claim <id> --ttl 30m --as merger-1     # hold it under a 30 minute lease
agentboard renew <id> --as merger-1               # confirm it: the first action of real work
agentboard renew <id> --ttl 1h --as merger-1      # set it to an hour from now
```

`claim --ttl` asks for a lease, but the lease starts as a short **grace
lease**: the board's `lease.grace` setting (2 minutes unless changed with
`config`). Only the holder's first `renew` confirms it and extends it to
the requested ttl. A claim that is never confirmed lapses after the grace
period (the examples in this section ran on a board with `lease.grace`
set to 30 seconds, see "Board settings"):

```
$ agentboard claim 01M5XZK37D --ttl 30m --as merger-1
01M5XZK37D4090R6TRCNDZ332Q  todo  merger-1  [adhoc] Merge lock
confirm the lease with 'agentboard renew 01M5XZK37D4090R6TRCNDZ332Q --as merger-1' before 2026-10-27T06:09:10.553Z
```

This is the liveness rule. A claim proves only that some process ran
`claim`, not that anyone is about to do the work: a background polling
loop can win a lock for an idle agent and sit on it. With a grace lease,
such a claim protects the ticket for the grace period only, and a crashed
or idle holder that did renew loses the lock when its ttl runs out. The
pattern is: claim, then renew as the first action of real work, renew
again at about half the ttl and immediately before the critical step, and
pick a ttl longer than the critical section. There is no flag for "I am
really acting now": the board could not check it, so it would be passed by
habit (ADR 0014).

`renew` sets (not extends) the lease to `--ttl` from now, or to the ttl
the claim asked for, and confirms it. It is accepted from the assignee
only: anyone else gets exit 4 `not-assignee` and the hint "the lock was
lost", whatever the arguments, so a holder whose lock was taken over,
granted on or force-released learns it from its next `renew` and stops.
The assignee renewing a ticket that has no lease, without `--ttl`, gets
exit 1 `usage`. A renew after the lease expired is still accepted as long
as nobody has taken the ticket over or been granted it.

A ttl is 1 to 5 digits followed by `s`, `m`, `h` or `d`, from 30 seconds
to 7 days (`30s`, `10m`, `7d`; not `10min`, `29s` or `8d`). A refused ttl,
timeout or setting is reported by its form and never repeated, so a token
pasted into the wrong place does not end up in a terminal or a log.

### Taking over a lapsed lease

A lease has three states, computed from your clock when you read it:
`live` before it expires, `expired` for the 60 seconds after that (the
clock skew tolerance, see "Clocks, skew and several machines"), and then
`claimable`. A claim with `--ttl` on a claimable ticket with nobody
waiting takes it over:

```
$ agentboard list
01M5XZK37D4090R6TRCNDZ332Q  todo  merger-1*!claimable  [adhoc] Merge lock
$ agentboard claim 01M5XZK37D --ttl 30m --as merger-4
01M5XZK37D4090R6TRCNDZ332Q  todo  merger-4  [adhoc] Merge lock
confirm the lease with 'agentboard renew 01M5XZK37D4090R6TRCNDZ332Q --as merger-4' before 2026-10-27T06:12:35.242Z
```

The takeover claim records the lease it supersedes (holder, expiry and
the event that set it), so it applies only to that exact lease: a holder
that renewed in time keeps the lock, whatever order the events arrive in,
and of several racing takeovers exactly one wins. A takeover needs
`--ttl` (exit 1 `usage` without it), because a hold taken over without a
lease would never lapse. Before the lease is claimable, a claim is refused
with exit 4 `already-assigned`, naming the holder, the expiry and the time
from which the ticket can be claimed:

```
$ agentboard claim 01M5XZK37D --ttl 30m --as merger-2
agentboard: ticket 01M5XZK37D4090R6TRCNDZ332Q is already assigned to merger-1 (lease expires 2026-10-27T06:09:10.553Z, claimable from 2026-10-27T06:10:10.553Z)
hint: another actor holds this ticket, so do not work on it: see who with 'agentboard show 01M5XZK37D', or find your own work with 'agentboard inbox --as merger-2'; it can be claimed from 2026-10-27T06:10:10.553Z, or wait in its queue with 'agentboard claim 01M5XZK37D --ttl <duration> --wait --timeout <duration> --as merger-2'
```

### The waiting queue and grants

`claim --ttl <d> --wait` (and, on the command line, `--timeout`) on a
ticket that is held, or has waiters, does not fail: the actor joins the
ticket's queue. That holds even when the holder's lease is already
claimable: the waiter joins rather than taking over, and its grant follows
at once. Waiters are served in the order they joined, and while anyone is
waiting, a claim without `--wait` (a takeover included) is refused with
exit 4 `queued`: waiters have priority. `unqueue <id>` leaves the queue
(exit 4 `invalid-queue` when you are not in it). A hand-off or assign to a
waiter takes it out of the queue.

When the ticket becomes available (released, force-released, or its lease
lapsed), the head waiter is **granted** it. A grant is an event written by
the reserved actor `agentboard` (no command accepts `--as agentboard`) that
makes the waiter the holder with an unconfirmed lease of the board's
`queue.window` (2 minutes by default). The grantee accepts by running
`renew`, exactly like confirming a grace lease. If it does not, the grant
lapses after the window plus the 60 second tolerance and passes to the next
waiter, so a waiter that died never stalls the queue.

There is no daemon. A grant is a pure function of the events and is written
by whichever command next opens the board and catches up once it is due
(every such command except `rebuild`, including `list`, `show`, `inbox` and
a waiting `claim --wait`), timestamped with the moment it became due rather
than the moment it was written. Every writer derives the same bytes, so two
processes or two machines writing the same grant produce one file. A read
command takes the write lock only when a grant is actually due. If nobody
runs a command for a while, a grant can be written after its window has
already passed, and the next grant follows straight away.

### Waiting on the command line

On the command line `--wait` also needs `--ttl` and `--timeout` (1 second
to 1 day), and the claim blocks in the foreground until it ends:

```
$ agentboard claim 01M5XZK37D --ttl 30m --wait --timeout 5m --as merger-2
queued for 01M5XZK37D4090R6TRCNDZ332Q at position 1, held by merger-1
01M5XZK37D4090R6TRCNDZ332Q  todo  merger-2  [adhoc] Merge lock
accept the grant with 'agentboard renew 01M5XZK37D4090R6TRCNDZ332Q --as merger-2' before 2026-10-27T06:12:10.554Z
```

- When the ticket is free with nobody waiting, it claims at once, exactly
  as `claim --ttl`.
- Otherwise it joins the queue, prints its position, and waits, waking on
  new events (as `watch` does) and at the time the next grant falls due, so
  it writes the grant to itself without any other process running.
- Granted, it exits 0 and prints the `renew` that accepts the grant and the
  time by which to run it. Exit 0 always means you hold the ticket; you
  still have to `renew` within the window.
- When `--timeout` passes first, it leaves the queue and exits 4
  `wait-timeout`. SIGINT or SIGTERM leave the queue too and exit 4
  `wait-interrupted`, never 0. If the ticket was granted or handed to it in
  the same moment, it holds it at a timeout (and exits 0), and on a signal
  it releases it again so the next waiter is served, and says so. So
  `agentboard claim ... --wait --timeout 10m && merge` never merges without
  the lock.
- Killed with SIGKILL, it stays queued; its grant then lapses after one
  window and passes on.
- If it left the queue elsewhere (`unqueue` from another shell) or its
  grant passed on, it exits 4 `invalid-queue`.

The timeout is measured on a monotonic clock, so a wall clock stepped
during the wait does not move it. With `--json` the waiting claim prints
one JSON document per line, as `watch --json` does: the queued document
`{queued, position, holder, ticket}`, then the claim result, the grant
document `{queued: false, grant, acceptBy, ticket}` or the error.

Over MCP nothing blocks: `board_claim` with `wait` (and `ttl`) joins the
queue and returns `{queued: true, position, holder, ticket}` at once (or
the ordinary claim result, with `queued` false, when it claimed), and has
no `timeout` argument. The grant arrives through `board_inbox` as a
`ticket.grant` entry whose `to` is the grantee, who accepts it by calling
`board_renew` within the window.

### Forced release

```
agentboard release <id> --force --reason "merger-1 crashed" --as orchestrator
```

`--force` with a non-empty `--reason` lets an actor that is not the holder
break the hold. It is recorded as its own event kind,
`ticket.release.force`, naming the actor, the previous holder and the
reason; `show` displays it, and the previous holder's inbox gets it as a
line beginning `LOST: `. With waiters, the head waiter is granted the
ticket. `--force` without a reason, `--reason` without `--force`, and
`--force` by the holder itself exit 1 `usage`; `--force` on a ticket
nobody holds exits 4 `not-assignee`. The reason is checked for secrets like
a comment (`--allow-secret-like` overrides), before the board is opened.

Any actor may force a release: actors are self-asserted, so a list of
allowed actors would only teach agents to pass `--as orchestrator`, the
impersonation this replaces (ADR 0014). What it buys is the record of who
broke the lock and why. Reserve it for the orchestrator or a human, after
checking that the holder is really gone; often waiting for the lease to
lapse is enough.

### Board settings: `config`

```
agentboard config set queue.window 5m --as orchestrator
agentboard config set lease.grace 1m --as orchestrator
agentboard config get
```

`lease.grace` is the grace a `claim --ttl` gets before it must be
confirmed, and `queue.window` the time a granted waiter has to accept.
Both are from 30 seconds to 10 minutes (`<n>s` or `<n>m`), default 2
minutes, and are stored as `board.meta` events, so every machine sharing
the board gets them through `sync`. `config get` prints both (or one)
and marks defaults:

```
$ agentboard config get
lease.grace 30s
queue.window 2m (default)
```

A claim records the grace in effect when it was written, and a grant uses
the window in effect at its position in the log, so changing a setting
never shortens a lease already granted. `config` needs a shell: it is not
an MCP tool.

### Reading leases and queues

`list` keeps the assignee column as one token: the holder, `*` while the
lease is unconfirmed, then `+<remaining>` for a live lease, or
`!expired` or `!claimable`, then `^<n>` when `n` actors are waiting (`-^2`
for a free ticket with waiters):

```
$ agentboard list
01M5XZK37D4090R6TRCNDZ332Q  todo  merger-1*+20s^1  [adhoc] Merge lock
01M5XZK3JBDJ0V696VBZGFPSND  todo  merger-a+29m^1  [adhoc] Release lock
```

`show` adds a `lease:` line (state, `(grace)` while unconfirmed, ttl,
expiry and the time from which it can be claimed), the queue with join
times, a `granted:` line while a grant is not yet accepted, a `next
grant:` line naming the waiter the ticket goes to next if nothing changes
(and from when), the last takeover and the last forced release:

```
$ agentboard show 01M5XZK3JB
...
assignee: merger-a
lease: live, ttl 30m, expires 2026-10-27T06:40:41.372Z, claimable from 2026-10-27T06:41:41.372Z
next grant: merger-b at 2026-10-27T06:41:41.373Z, accept by 2026-10-27T06:43:41.373Z
queue:
  1 merger-b (joined 2026-10-27T06:10:38.991Z, ttl 30m)
```

With `--json` a ticket carries `lease` (null, or `{ttl, expiresAt, event,
confirmed, state, claimableAt}`) and `queue` (the waiters in order). The
lease state is worked out from your clock when you read it and never
stored. Inbox entries gain `affects`, the previous holder of a forced
release, a takeover or a grant after a lapse; a grant's `to` is the
grantee and a forced release's `note` its reason. Human inbox lines begin
`GRANTED: ` for a grant to you and `LOST: ` when you are the one affected:

```
$ agentboard inbox --as merger-2
...
GRANTED: 01M5XZK37D4090R6TRCNDZ332Q  ticket.grant  agentboard  to merger-2
$ agentboard inbox --as releaser-1
...
LOST: 01M5XZK3JBDJ0V696VBZGFPSND  ticket.release.force  orchestrator  note releaser-1 crashed mid-tag (pid gone)
```

The web app's activity feed and `top` describe the same events
(`claimed (lease 30m)`, `renewed lease (30m)`, `joined the queue`, a grant,
a takeover, a forced release), but have no lease or queue controls.

### Mutex tickets

A lock is one standing ad hoc ticket, created once and never closed while
the lock is in use:

```
agentboard new "Merge lock" --adhoc "mutex for merges into staging" --as orchestrator
```

**CLI workers.** A worker that can block runs the critical section like
this:

```
agentboard claim <lock> --ttl 30m --wait --timeout 10m --as impl-1 || exit 1
trap 'agentboard release <lock> --as impl-1' EXIT
trap 'exit 1' INT TERM
agentboard renew <lock> --as impl-1 || exit 1
npm test && agentboard renew <lock> --as impl-1 && gh pr merge 42 --squash
```

The wait exits 0 only when `impl-1` holds the lock. The first `renew`
accepts the grant (or confirms the grace lease when the lock was free) as
the first action of real work; the second comes immediately before the
critical step, so a lock lost during the tests stops the merge; and the
`trap` releases the lock when the script ends, whether the merge
succeeded, failed or the script was interrupted.

Exit 4 `wait-timeout` or `wait-interrupted` from the wait means the worker
does not hold the lock: it does not run the critical step, and either waits
again or reports. `renew` failing with `not-assignee` means the lock was
lost (it lapsed and passed on, or was force-released): stop. Use a ttl
longer than the critical section, and no longer than you can afford to lose
the lock for if the script is killed: a `trap` does not run on SIGKILL or a
crash, and then the lease, not `release`, is the backstop. Renew at about
half the ttl if the section is long. Never wait on a mutex in a loop of
plain claims and never claim from a background process: the first is unfair
(whoever polls at the right moment wins) and the second is exactly the idle
hold that leases exist to end.

**An orchestrator running the queue over MCP.** Agents behind MCP cannot
block, and an agent that has stopped does not read its inbox. There the
orchestrator is the single queue runner, dispatching one holder at a time.
A worker ready to merge either reports ready (a comment or a hand-off to
the orchestrator) and stops, or joins the queue and stops:

```
board_claim {"id": "<lock>", "ttl": "30m", "wait": true, "as": "impl-1"}
  -> {"queued": true, "position": 1, "holder": "impl-2", "ticket": "<lock>"}
```

On a free lock (unassigned, nobody waiting) the same call claims it at once
and returns the ordinary claim result with `queued` false, holding a grace
lease that lapses in `lease.grace` (2 minutes by default) unless renewed:
the worker must then call `board_renew` straight away and go on with the
critical step. With `queued` true it has joined the queue, stops, and waits
for the grant to arrive in `board_inbox`.

The orchestrator reads its own inbox (`board_inbox` returns every event on
the board, grants to others included, and writes any grant that has fallen
due) and, when it sees the `ticket.grant` with `to` `impl-1`, dispatches
`impl-1` again, which accepts with `board_renew {"id": "<lock>", "as":
"impl-1"}` as its first call, merges and calls `board_release`. If the
dispatch takes longer than the window, the grant passes to the next waiter,
so give dispatch time:

```
agentboard config set queue.window 10m --as orchestrator
```

For workers that only report ready, the orchestrator claims nothing
itself: it dispatches the next ready worker (which claims with `--ttl` and
renews as above) only once the lock is released or its holder's lease
lapses. For a hold that looks stale it checks `show <lock>`, waits for
the lease to become claimable or, after checking that the holder is gone,
runs `release <lock> --force --reason "<why>"`, and never impersonates the
holder with `--as`. `agentboard help agents` carries the same recipe for
agents, and `agents install` puts a short form of it into a project's
guidance.

### Clocks, skew and several machines

The fold never reads a clock. A lease lapsing, a takeover and a grant
passing on are all decided from the timestamps written in the events,
plus a fixed tolerance of 60 seconds: a takeover is valid only when its
own timestamp is at least 60 seconds past the lease's expiry, and a grant
after a lapse or a non-acceptance is due 60 seconds after the lease or
window ran out. Your clock is read only to stamp new events, to decide
whether a due grant or a takeover may be written yet, and to show a
lease's state in `list` and `show`.

- **On one machine** every timestamp comes from one clock, so leases,
  takeovers and grants happen exactly at the stated times, never earlier,
  and the lock is exact.
- **Across machines** whose clocks differ by at most 60 seconds, a
  takeover or grant is never written before the lease really lapsed, and a
  grantee always gets at least its window of real time. A larger skew can
  shorten a lease or a window by the excess; `show` displays the times
  involved.
- **The lock is only as strong as `sync`.** Each machine decides from the
  events it has. A renew written in time on one machine but synced late
  still wins: once both machines have synced, a takeover or grant another
  machine wrote in the meantime is rejected (`already-assigned` or
  `stale-grant`) on both, and the board converges, but for a while both
  machines may have believed they held the lock. Sync before claiming and
  again before the critical step.
- **A known limit:** a waiter that leaves the queue (at its timeout, say)
  on one machine can be overruled by a release synced late from another
  machine with an earlier timestamp. The fold then grants the ticket to the
  waiter that already left. Its command had already exited 4, so it never
  ran the critical step; nobody accepts the grant, so it lapses after the
  window and passes to the next waiter. The ticket sits idle for one
  window plus the tolerance; the lock is never held twice.

### Upgrading a board shared between machines

Every machine that writes to a shared board must run a version that
understands leases before any actor uses `--ttl`, `--wait`, `release
--force` or `config set`. An older version reports a leased claim as
malformed and keeps the new kinds (`ticket.renew`, `ticket.queue.join`,
`ticket.queue.leave`, `ticket.grant`, `ticket.release.force`) as unknown
events without folding them, so on that machine a leased ticket looks
unassigned and a second actor could claim it there: the machines then
disagree about who holds the lock. Nothing is lost: once the machine is
upgraded, the same events fold as they do everywhere else, with no
migration. Plain claims are unchanged, so a board where nobody uses the
new flags works with mixed versions. The upgrade also changes the cache
schema: the first command rebuilds the cache from the events. An upgrade
keeps each actor's inbox position, so the next `inbox` returns only what
that actor has not been given, and the first `inbox` after it also returns
any event the old version did not apply (an event of a kind it did not
know, synced from a machine that was upgraded first), wherever that event
sits relative to the cursor. Before the new version first runs on a
machine, stop every long-running process of the old version there
(`watch`, `serve`, `top`, `mcp`): one left running keeps its connection
to the cache and can fold the rebuilt cache with the old version's rules,
and the events it does not know are then delivered only after
`agentboard rebuild`. Downgrading to an older version, or a cache whose
cursor tables are not in the shape the running version expects, still
loses the cursors, and each actor's next `inbox` then returns the whole
board once. With the old version's processes stopped, no event is skipped
either way.

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
  in every worktree and clone. A missing file exits 1. The close form of
  `agentboard serve --as <actor>` has no current directory, so there a
  relative path resolves against the working tree root instead.
- `--no-decision` is refused (exit 1, quoting the comments) while the
  ticket has a `DECISION:` comment that its author has not retracted with a
  later comment beginning `RETRACTED:`.
- Only tickets in `merged` or `blocked` can be closed. Closed tickets drop
  out of `list` unless `--closed` is given.

`close` also takes the scope disposition of "Tickets and task references"
when the ticket has neither a task reference nor an unplanned disposition,
which in practice means an ad hoc ticket closed from `blocked` (a ticket
in `merged` already has one): `--task <source>:<ref>#<item>` (or
`--change <name> --group <n>`) or `--unplanned <reason>`, beside the
decision flag:

```
agentboard close 01M38YRHC3 --as orchestrator --no-decision --unplanned "abandoned: superseded"
agentboard close 01M38YRHC3 --as orchestrator --no-decision --task openspec:add-login#2
```

Without one the close is refused with exit 4, `needs-scope-disposition`,
and the hint repeats the decision flag you gave; `--unplanned` on a ticket
that names a planned task exits 4, `already-linked`. The checks run in
this order: the arguments (both or neither decision flag, two
dispositions, a malformed reference, an empty or secret-like reason, all
exit 1 before the board is opened), then the decision record path
(`path-outside-tree`, `decision-path-missing`, exit 1), then whether the
ticket can be closed
(`invalid-transition`), then the scope disposition, then the decision
rule (`unpromoted-decision`). The disposition event and the close are
written in one transaction, both or neither.

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

Re-importing makes the tickets follow a revised `tasks.md`, and never
moves work between groups. Tickets are paired with groups by identity:
first by title, then by their task lines (Jaccard similarity of at least
0.5, with every rival at least 0.2 lower), and only then by group number.
A ticket whose group moved is renumbered (`ticket.renumber`, which moves
its task item and `group:<n>` label and nothing else); a paired ticket gets
one `ticket.reconcile` with its group's title and lines (lines matched by
task number, then by text; removed lines are kept on the ticket, marked
removed, so checklist indices never change meaning; new lines are
appended); a new group gets a new ticket; and a ticket whose group is gone
is marked superseded (`ticket.supersede`), never rewritten or closed. A
re-import never changes a ticket's status or assignee, and an unchanged
tasks file writes nothing.

Two cases refuse with exit 4. A reconcile that would remove or reword a
line done on the ticket, or reword the lines of a ticket held in `tests`,
`implementing` or `review`, is blocked for that ticket
(`reconcile-blocked`, every other group is still imported); `--force`
writes it anyway, recorded as forced and delivered to the holder's inbox.
A pairing that is ambiguous (for example a group split in two) writes
nothing at all (`reconcile-ambiguous`); edit a group title so each ticket's
group is clear. `--dry-run` (with or without `--json`) shows the pairing,
renumbers, line changes, blocks and supersedes and writes nothing:

```
$ agentboard import-change add-search --dry-run --as orchestrator
created group 1: Schema
updated 01M38YSQQ5DQ05MQ21B5DCCJZ6  merged  -  Index
  paired by title (score 1.00)
  renumbered from group 1 to 2
dry run openspec:add-search: 1 created, 1 updated, 0 unchanged, nothing written
```

`agentboard close-merged --as <actor>` closes every open `merged` ticket
whose `pr` link points at a merged pull request, with the ticket's
`decision` link as the disposition when it has one and `--no-decision`
otherwise, and lists the tickets whose PR is not merged yet or that could
not be closed (for example because of an open `DECISION:` comment). It asks
GitHub through `gh pr view`, so it needs `gh` on the PATH and authenticated
for the repository; without `gh` it exits 1 when there is anything to
check. `agentboard health` shows beforehand which `merged` tickets it
will consider, which an open decision will hold back, and which it can
never close because they have no `pr` link (see "Board health").

## Sync between machines

A host-model board rides along with the project's own remote. On the
machine that created it:

```
agentboard sync
```

commits the new event files and pushes `refs/agentboard/board` to the
remote. On another machine (or in a second clone), clone the project and
run `agentboard init` at its root: it finds `refs/agentboard/board` on
the remote, fetches it, creates the `.board` worktree at it and folds the
events, so `agentboard list` shows the tickets before any `sync`:

```
$ git clone <project-url> project && cd project
$ agentboard init
created the board at /path/to/project/.board (host model: a worktree of the host repository at refs/agentboard/board); joined 5 events from origin
```

When the remote has no board yet, or cannot be reached (`init` warns and
carries on), `init` creates a new empty board whose first commit is the
same in every clone, and the first `sync` publishes it or joins the board
that appeared in the meantime. Everyone who can fetch the project's remote
can fetch the board: a project whose repository is public, or whose git
host refuses pushes to custom refs, keeps its board in a repository of its
own with `init --remote <url>`. The host model needs git 2.32 or later on
every machine that shares the board; `init` on an older git falls back to
a standalone board and says so, and older agentboard versions refuse to
sync a host-model board.

`init` also repairs a host-model `.board` whose link to the repository is
broken: a checkout moved to another directory is relinked in place, and a
`.board` copied from another clone is rebuilt as a fresh worktree of this
clone with every event file carried over (one whose content does not match
its name is skipped and reported), the copy kept under
`.git/agentboard/stale-board-<timestamp>`.

A standalone board (`.board/` as a repository of its own) moves between
machines without touching the host project: it is shared through a
repository of its own, set up on every machine with
`agentboard init --remote <url>` ("Keeping the board in a separate
repository", below). Boards made before the host model existed are
standalone and keep working as they are.

Whichever model a shared board uses, upgrade agentboard on every machine
that shares it before an ad hoc ticket is moved past `tests`. The 0.1.0
release still refuses an ad hoc ticket's move into `implementing`, so on
a machine running it the board folds differently (the ticket falls back
to `tests` there) until it is upgraded; it keeps the `ticket.unplanned`
event as an unknown kind, so nothing is lost, and once it is upgraded
the board folds as it does everywhere else, with no migration. Leases,
the queue, forced release and `config set` have the same requirement:
upgrade every machine before anyone uses them (see "Upgrading a board
shared between machines"), and remember that a lock held across machines
is only as strong as `sync` ("Clocks, skew and several machines").

`agentboard sync` stages only new event files and `.board/.gitignore`,
commits them as the fixed identity `agentboard <agentboard@localhost>`
(never your git identity, and only when something is staged), integrates
what the remote holds with a rebase, pushes (retrying once if the remote
moved in between) and folds the events that arrived. Event files are
add-only and named by their content, so two machines that both added
events always merge without conflict and end up with identical boards.
Without a remote, `sync` commits and reports that no remote is configured,
exiting 0. It warns (without failing) when the host repository tracks
anything under `.board`. The steps after the commit depend on the model:

- Host model (`.board` is a worktree of the host repository, its history
  the ref `refs/agentboard/board`): `sync` first makes the local
  `refs/agentboard/board` equal to the worktree's HEAD (rebasing HEAD onto
  the ref when someone fetched into it by hand), then fetches
  `refs/agentboard/board` from the host's remote into the worktree's own
  `FETCH_HEAD` (no remote-tracking ref, no tags), rebases onto it when it
  holds commits the worktree does not, updates the local ref with a
  compare-and-swap, and pushes `HEAD:refs/agentboard/board` without force.
  It never creates or moves a branch, and the host's git hooks
  (`pre-commit`, `pre-rebase`, `pre-push`, `post-checkout`, ...) do not
  run for the board: every command runs with an empty hooks directory,
  and nothing is written to the host's configuration. `agentboard remote`
  shows the ref and the commit it holds.
- Standalone model (`.board` is a repository of its own): `sync` runs
  `git pull --rebase` from its remote and pushes its branch, setting the
  upstream only when the branch has none; the board repository's own
  hooks run as git normally runs them.

`sync` chooses the remote in this order: the one named by
`git config agentboard.remote <name>` in the repository that holds the
board's history (the host repository, or the standalone board
repository), the upstream of the current branch (for the host model, the
branch checked out in the host's main checkout; an upstream remote of `.`
is ignored), `origin`, then the only remote. `agentboard.remote` is for
repositories with several remotes, such as a fork workflow with `fork` and
`upstream` and no `origin`; setting it never changes the branch's upstream,
so your own `git pull` behaves as before.

What `sync` does when it cannot finish, and what a human does next:

- 3 `sync-conflict`: git reported a conflict (only possible on non-event
  paths such as `.board/.gitignore`). The rebase is left in place in
  `.board`: resolve it, `git add` the paths, `git rebase --continue` (or
  `git rebase --abort`) and run `sync` again. Until then every `sync`
  exits 3 `sync-in-progress`.
- 3 `sync-in-progress`: a rebase, merge or cherry-pick is already in
  progress in `.board`; finish or abort it there.
- 3 `board-on-branch` (host model): someone ran `git switch` in `.board`,
  so the worktree is on a branch instead of the detached HEAD the board
  ref needs. Run `git -C .board switch --detach refs/agentboard/board`
  (delete the branch if it was only a scratch one) and `sync` again.
- 3 `detached-head` (standalone model): `.board` is on a detached HEAD;
  check out its branch (`git -C .board switch main`) and `sync` again.
- 3 `sync-failed`: the remote is unreachable, rejected the push twice, or
  `agentboard.remote` names a remote that does not exist; or (standalone)
  something you staged yourself in `.board` is still staged (`sync`
  commits only its own paths; commit or unstage it). The local commit is
  kept; fix what the message names and `sync` again. A host that refuses
  pushes to custom refs (Gerrit without a push permission on
  `refs/agentboard/*`; GitHub and GitLab accept them) fails here on the
  first push, is not retried, and the message carries the remote's own
  reason (a hook's text): keep such a board in a repository of its own
  with `init --remote <url>` ("Keeping the board in a separate
  repository", below).
- 2 `board-link-broken` (host model): `.board` is a worktree whose link
  to the host repository is broken (the checkout was moved, or `.board`
  was copied from another clone); `agentboard init` repairs it. 2
  `board-not-a-repository`: `.board` is not itself the top level of a git
  repository or worktree.
- 1 `git-too-old` (host model): the git found is older than 2.32, which
  a board in the host repository needs; upgrade git (nothing is staged).
  1 `ambiguous-remote`: there are several remotes and none is chosen;
  `sync` has committed locally, so set `agentboard.remote` and run it
  again.
- 5 `integrity`: event files recorded in the board's git history are
  missing from `events/`; nothing is staged (a deletion is never synced).
  Restore them from git as the message says. Exit 5 without a reason is
  an unexpected git failure; the one to expect is two `sync` processes
  of one clone colliding on git's `index.lock` (nothing serialises them;
  inside a rebase the second exits 3 `sync-in-progress` instead). The
  ref equals HEAD afterwards and nothing is lost: run `sync` again.

Two cautions for the host model. Never `git push --mirror` from a working
clone: it rewinds the remote's `refs/agentboard/board` to that clone's
board; the other clones restore their own events on their next `sync`,
but an event whose only copy was on the remote is lost (a `--mirror` push
from a backup clone made with `git clone --mirror` carries the board, as
intended). And a board in a public repository is readable by anyone who
can clone it; a project that needs a private board, or whose git host
refuses custom refs, keeps it in a repository of its own with
`init --remote <url>`, described next (`agentboard init --into-host`
moves it the other way, into the host repository).

To see how a board is shared without changing anything:

```
agentboard remote
```

It prints the board directory, its model (`host` when the board is a
worktree of the host repository with its history under
`refs/agentboard/board`, `standalone` when `.board` is a repository of its
own, `broken host link`, or `not a repository`), where the history lives,
the remote `sync` would use with its URL and the rule that chose it, and
every remote of that repository. A broken link or an ambiguous choice comes
with how to fix it. `remote` is read-only, never contacts the network and
exits 0 whenever a board exists (problems are in its output), so it is safe
to run when something is wrong. `--json` prints one object with `dir`,
`model`, `gitDir`, `ref`, `refCommit`, `branch`, `head`, `remote`,
`remotes` and `problems`. It needs no actor and is not exposed as an MCP
tool.

Sync is for machines that take turns, not for several people editing at
once.

### Keeping the board in a separate repository

A board in the host repository is readable by anyone who can fetch the
project, and needs a git host that accepts pushes to custom refs. When
either rules the host model out (a public project whose board should stay
private; a host that refuses custom refs), keep the board in a repository
of its own: a standalone board (`.board/` as a git repository of its own,
as every board was before the host model) shared through any empty git
repository you can push to. Create that repository first (a private one on
your git host, or a local bare repository on a shared disk), then, at the
root of the project:

```
agentboard init --remote <url>
```

`<url>` is anything `git clone` accepts: an SSH or HTTPS URL, or a local
path, absolute or relative (a relative path is resolved against the
project's top level, from any worktree, and stored absolute, so `sync`
reaches it from any directory). A local path that does not exist is
created as a bare repository first, so two checkouts on one machine, or on
one shared disk, need nothing but the path. What `init --remote` does
depends on what it finds:

- The repository is empty: it creates a standalone board, adds `<url>` as
  `origin` and runs `sync`, whose first push creates the branch there.
- The repository already holds a board (another clone pushed it): it
  clones it into `.board` and folds the events, so `agentboard list`
  shows the tickets before any `sync`; nothing is pushed.
- `.board` is already a standalone board with no remote (made before this
  command existed, or offline): `<url>` becomes its `origin` and `sync`
  commits and pushes its events. Existing standalone boards join in with
  the same command and are otherwise unchanged.
- `.board` already has that remote: nothing changes, exit 0.

It exits 3 `remote-unreachable` when the repository cannot be read (create
it and check your access: a git host answers the same for a missing
repository and for one you cannot read), 1 `not-a-board` when the
repository holds a branch without an `events/` directory (nothing is left
behind), 1 `remote-mismatch` when `.board` already has a remote with
another URL (the message names `git -C .board remote set-url`), and 1
`board-in-host` when `.board` is in the host repository. When the `sync`
it runs fails (the first push refused, say), `init` exits with that
failure's code and reason; the board and its `origin` are kept, so the
next `sync` finishes the job. None of these refusals repeats the URL you
gave (a URL with credentials is the usual way a secret reaches a command
line): they say "the URL given" and write `<url>` in any suggested
command, and a git error line quoted by `init`, `sync` or `init
--into-host` has every configured remote or proxy URL replaced by
`<url>` and any URL credential by `<redacted>`. Success output and
`agentboard remote` show a remote URL without its user information
(`https://host/x.git` for `https://user:token@host/x.git`); git's
configuration keeps the URL as you wrote it.

On every other machine, clone the project and run the same command:

```
$ git clone <project-url> project && cd project
$ agentboard init --remote ../boards/project.git
cloned the board at /path/to/project/.board from /path/to/boards/project.git (standalone model: a git repository of its own) with 5 events
```

Inside a git project the board is still a standalone board, never a
host-model one, whatever the git version: `init --remote` writes the host
`.gitignore` entry and nothing else to the host repository (no ref, no
worktree, and the project's own remote is never contacted). `agentboard
remote` then reports `model: standalone` with `origin` at the stored URL,
and `sync` runs the standalone steps above. `git -C .board remote add
origin <url>` followed by `sync` still works too. This repository's own
board stays standalone for exactly this reason (CONTRIBUTING.md,
"Coordinating on the board").

### Moving a board into the host repository

A standalone board (one made before the host model existed, or with
`init --remote`) moves into the host repository, history and all, with
the counterpart of `init --remote`, run at the root of the main checkout:

```
agentboard init --into-host
```

Afterwards `.board` is a locked worktree of the host repository whose
history is `refs/agentboard/board`, exactly as `init` creates in a git
project, and the `sync` that the move runs publishes it on the project's
own remote. It needs git 2.32 or later and no actor. Read the caveat above
first: once moved, everyone who can fetch the project can fetch the board.

The move never loses an event. Before changing anything it checks the
standalone board and refuses when a move could drop something:

- Exit 4 `unsynced`: an event file is not committed (untracked or
  staged), the board has no commit yet, or its branch has commits that
  its remote does not. Run `agentboard sync` first, so the remote's branch
  (the source of the move, which may hold other clones' events too) is
  complete.
- Exit 3 `sync-in-progress` or `detached-head`: a rebase or merge is in
  progress in `.board`, or its HEAD is not on a branch, as `sync` refuses;
  finish or abort it, or check out the branch.
- Exit 3 `sync-failed`: the board's remote cannot be reached (it is fetched
  first, to compare).
- Exit 5 `integrity`: a committed event file is missing from `events/` or
  differs from its committed content. Event files never change, so this
  is damage to repair before anything is moved.
- Exit 1 `no-host-repository`: the board was not found through a git
  repository with its `.git` directory inside its working tree (outside a
  git repository, with `AGENTBOARD_DIR` set, a bare repository with
  worktrees, a `--separate-git-dir` repository, a submodule); exit 1
  `git-too-old` for git before 2.32; exit 1 `ambiguous-remote` when the
  host's remote cannot be chosen (see "Sync between machines").

A refusal writes nothing: no ref, no directory under `.git/agentboard`,
`.board` as it was. When the checks pass, the move fetches the board's
history into the host repository under a scratch ref
(`refs/agentboard/migrating-fetch`, the only ref a fetch of the move ever
writes), records it as `refs/agentboard/migrating` (the tip the temporary
worktree has integrated; both refs live as long as the worktree does),
checks it out in a temporary worktree under
`.git/agentboard/migrating/<pid>`, integrates
any `refs/agentboard/board` the host or its remote already has (another
clone moved first: this clone's history is rebased onto it, as `sync`
would), sets `refs/agentboard/board`, carries over every event file of
the old `.board/events` that the new worktree lacks (hash-verified, so an
event written while the move ran is not left behind; a file whose content
does not match its name is exit 5 `integrity`, with nothing moved), checks
that `.board` is still the repository it examined (and that its history
only grew), and only then moves the old repository aside and the new
worktree into place, deletes both temporary refs and carries over
anything that landed in between. The old repository is kept, never
deleted, at `.git/agentboard/standalone-<UTC timestamp>`, inside the git
directory where the host's `git status` never shows it; the output names
it and the old remote's URL as written in its configuration. The host
`.gitignore` gets the `.board/` entry once `refs/agentboard/board` is
set, so a refusal leaves the host's working tree as it was.

```
$ agentboard init --into-host
moved the board at /path/to/project/.board into the host repository (host model: a worktree of the host repository at refs/agentboard/board)
the old board repository is kept at /path/to/project/.git/agentboard/standalone-20261013T152817Z
its remote was git@example.com:me/board.git (as written in its configuration)
every other clone of the project runs agentboard init --into-host too; retire the old remote once they all have
nothing new to commit
origin has no refs/agentboard/board yet; nothing to fetch
pushed refs/agentboard/board to origin
```

Running it again afterwards exits 0 saying the board is already in the
host repository, and changes nothing. With `--json` the document is the
`init` document plus `action` (`moved`; `resumed` after an interrupted
move; `unchanged` for a board already in the host; `repaired` for a
broken link, repaired as `init` repairs it), `keptAt`, `oldRemoteUrl` and
`sync` (the result of the `sync` it ran, else null).

Every clone moves. Each clone of the project that holds the standalone
board runs `agentboard init --into-host` itself, first clone first. The
second clone's move finds `refs/agentboard/board` on the project's remote
(the first clone's) and rebases its own history onto it, so events synced
to the old board remote after the first move are carried over too. A
clone that has not moved yet keeps syncing through the old remote;
`agentboard remote` shows `standalone` there and `host` where the move is
done. A fresh clone needs no move: `agentboard init` joins the host-model
board. Retire the old remote (delete the repository, or keep it as an
archive) once `agentboard remote` reports `host` in every clone; until
then a clone that has not moved still pushes there, and those events reach
the host-model board only when that clone moves.

When the histories being integrated conflict (both sides changed
`.board/.gitignore` differently; event files never conflict), the move
exits 3 `sync-conflict`, leaves the rebase in its temporary worktree for
you with the old `.board` untouched and `refs/agentboard/board` unchanged,
and names the worktree and the steps: resolve the paths, `git add` them
and `git rebase --continue` in that worktree, then run
`agentboard init --into-host` again, which adopts the finished rebase and
completes the move (`git rebase --abort` instead returns the worktree to
where the move started, so the next run begins again and stops on the
same conflict). While the rebase is still in progress a
re-run exits 3 `sync-in-progress` naming the same path and removes
nothing. A move killed at any point is resumed by running it again:
`.board` is either still the old standalone board or becomes the
host-model board, with every event and exactly one kept repository. A
re-run that picks up an interrupted move's worktree replays onto it,
with `git cherry-pick`, exactly the commits that reached the old remote
since (`refs/agentboard/migrating` records what the worktree has
integrated, and only a finished replay advances it), and never discards
what a human resolved there. When that replay conflicts (a third clone
changed the `.gitignore` line you resolved), the move exits 3
`sync-conflict` naming the worktree and the steps: resolve the paths,
`git add` them and `git cherry-pick --continue` in that worktree, then
run `agentboard init --into-host` again, which completes the move with
every event and applies nothing twice. Resolving by keeping your own side
leaves a pick with nothing to commit: `git cherry-pick --skip` drops it
(`git commit --allow-empty` keeps it as an empty commit), while
`--continue` stops on that empty pick again until it is skipped, and on a
replay of several commits the next pick may stop in its turn.
`git cherry-pick --abort` instead returns the worktree to your
resolution, and what the next run does with it depends on what the
replay carried: commits that add events are replayed onto it once more,
for you to resolve again; a replay whose commits add no event (the other
clone's `.gitignore` edit and nothing else) counts as done once aborted,
so aborting it declines that edit and the move completes without it. A
replay killed part way, with nothing of yours staged or edited in the
worktree, is quit and run again by the next run on its own; one you
edited or reset in is left for you, with the same steps (`git cherry-pick
--skip` to keep your side, `--continue` after resolving). A pick that
cannot apply over a local change of yours, or a change left in the
worktree with no pick in progress (a `git reset` on the last pick of a
replay), exits 3 `sync-failed` naming the file, with nothing dropped and
nothing published until the change is out of the way: discard it
(`git checkout -- <path>` in that worktree) or stash it, and the next
run replays the pick again for you to resolve; committing it instead
makes the replayed pick conflict with your commit, a second stop for the
same conflict. A worktree left
by a move of a board that was
replaced since (another standalone board at `.board`) is never adopted,
even when the replacement's git directory reuses the old one's inode
number, as ext4 usually does; and a board whose history was rewritten
since, so that it no longer holds the commit the move began from or the
tip the worktree integrated, counts as another board. Briefly: a worktree
is adopted only when the git directory it recorded is the one at `.board`
now and both its recorded starting HEAD and its integrated tip are in that
board's history. One that is not adopted is removed and named:

```
removed /path/to/project/.git/agentboard/migrating/4242, left by a move of another board (not the one at /path/to/project/.board, or one whose history no longer holds where that move began), so nothing of it was adopted
```

When a rebase or cherry-pick is stopped in such a worktree, the
`sync-in-progress` refusal says so instead (same exit code, reason and
hint), with `(that worktree was left by a move of another board, not the
one at /path/to/project/.board now or one whose history no longer holds
where that move began, so finishing it moves nothing of this board)` after
the path, and removes nothing. Worktrees made by 0.2.0 are still adopted
when they are this board's. Leftovers of a dead move that hold nothing are
removed and named
(plain `agentboard init` removes them too, and reports a move whose
`sync` has not completed without finishing it), and a move that is still
running on the same host is never touched. When the final `sync` fails
(the project's remote unreachable, a host that refuses custom refs), the
move is done and `init` exits with the failure's code, still naming the
kept repository and the old remote (with `--json`, `keptAt` and
`oldRemoteUrl` are in the error document); the next
`agentboard init --into-host` resumes the move by running the `sync`
again, and `agentboard sync` publishes the board too.

Rolling a move back. The kept repository is the complete old board, so a
move is undone by hand in that clone. Copy out the events written since
the move first (event files are named by their content, so copying is
safe and never overwrites anything different), because removing the
worktree deletes its files:

```
cp .board/events/*.json .git/agentboard/standalone-<timestamp>/events/
git worktree unlock .board
git worktree remove --force .board
mv .git/agentboard/standalone-<timestamp> .board
agentboard sync
```

`agentboard remote` then reports `standalone` again, with the old remote,
and the `sync` commits and pushes the copied events there. Delete
`refs/agentboard/board` locally and on the remote if the host model is
being given up altogether (`git update-ref -d refs/agentboard/board` and
`git push origin :refs/agentboard/board`); a clone that stays host-model
is unaffected either way, and the next `init --into-host` in the rolled
back clone integrates whatever the ref holds by then.

## Watching the board in a browser

`agentboard serve` starts a small web server for the board and prints a
URL to open in a browser. The page shows the whole board and keeps itself
up to date as agents write, including events that arrive late through
`sync`, with no reload. It is read-only unless you start it with
`--as <actor>`, which lets the page act on tickets as that actor (see
"Acting from the browser" below):

- **Board**: one column per status, one card per ticket (title, short id
  with the full id as its tooltip, assignee, task reference or an "ad hoc"
  badge (an "unplanned" badge with the reason once the unplanned
  disposition is recorded), labels, checklist progress, open decisions, a "from <status>"
  badge on a blocked ticket and a "closed" badge on a closed one), cards
  that just changed highlighted.
  Filter by change and by assignee; closed tickets are hidden unless you
  ask for them.
- **Feed**: every applied event on the board as a one-line summary,
  newest first, filterable by change, actor and event kind. Events that arrived late
  through `sync` are marked.
- **Ticket detail** (click a card or a feed entry): the ticket's fields
  (an `Unplanned` field, `<reason> (by <actor>)`, right after `Task` when
  the ticket has an unplanned disposition), a "Description" section
  rendered as Markdown (see "Markdown descriptions" below), checklist,
  links and close disposition, its conversation (comments and
  hand-off notes, with `DECISION:` comments highlighted and retracted ones
  flagged), and every event on it with its outcome, including rejected
  ones with their reason (for example a claim that lost a race,
  `already-assigned`).
- **Lanes**: one lane per actor with the tickets they hold and when they
  were last seen, refreshed at least every 10 seconds.
- **Health**, **Replay** and **Graph**: what is going wrong on the board,
  the board at any past position of its event log, and who hands work to
  whom. See "Board health" and "Replay and the hand-off graph".

The current view and its filters live in the URL hash (`#/board`,
`#/feed`, `#/ticket/<id>`, `#/lanes`, `#/health`, `#/replay`,
`#/graph`), so a reload keeps them.

### Starting it

Run it from anywhere inside the project, like any other command:

```
$ agentboard serve
serving /home/me/project/.board read-only at http://127.0.0.1:54311/#token=hzU-J7pLcQxvMQCgXAsoeqFd9WSEPMU2vG6PHqUTWoM
```

Run from an interactive terminal, `serve` then opens that URL in your
default browser (see "When the browser opens" below). Otherwise, or if you
closed the tab, open the URL, the whole of it, in a browser yourself. The
server runs until you stop it with Ctrl-C (SIGINT) or SIGTERM, then exits
0.

- `--port <n>` listens on port `n` (0 to 65535). Without it the operating
  system picks a free port, which is fine: the token changes at every start,
  so the URL changes anyway. A port that is already in use exits 1 with
  reason `port-in-use`.
- `--open` always asks the system to open the URL in your default
  browser, whatever the environment (see below).
- `--no-open` never opens a browser. Use it on a shared machine (see
  "Security model") or whenever you would rather copy the URL yourself.
  Giving both `--open` and `--no-open` exits 1 with reason `usage` before
  the board is looked up or a port is bound.
- `--json` prints one JSON line instead of the `serving` line, and nothing
  else on stdout:

  ```
  {"url":"http://127.0.0.1:54311/#token=hzU-...","port":54311,"token":"hzU-...","writable":false,"actor":null}
  ```

- `--as <actor>` turns on write mode, with every write made as that actor
  (see "Acting from the browser"). The line then reads `serving <board
  dir> as <actor> at <url>`, and the JSON line has `"writable":true` and
  `"actor":"<actor>"`. An empty value (`--as ''`) exits 1 with reason
  `usage`.

Without `--as`, `serve` writes no event and needs no actor. Only an
explicit `--as` on the `serve` command line enables writes: `serve`
ignores `AGENTBOARD_ACTOR`, so starting a viewer from a shell where an
agent's actor is set still gives you a read-only server. `serve` never
moves an inbox cursor; apart from the events of accepted write actions,
the only change it makes to the board is the cache catch-up every read
command does. It is not exposed as an MCP tool.

#### When the browser opens

The start-up line is always printed first, exactly as above; the browser is
opened after it. Nothing more is printed when it opens, so the output a
script reads does not change. With neither `--open` nor `--no-open`,
`serve` opens the browser only when all of these hold:

- stdout is a terminal (not a pipe or a file, so `agentboard serve | cat`
  or a process supervisor reading its output opens nothing);
- `--json` is not given;
- the `CI` environment variable is unset or empty (any other value, `0`
  and `false` included, counts as set);
- it is not an SSH session: `SSH_CONNECTION`, `SSH_CLIENT` and `SSH_TTY`
  are all unset or empty. Over SSH the server listens on the remote
  machine's loopback, which a browser on either machine could not usefully
  open;
- on platforms other than macOS and Windows, `DISPLAY` or
  `WAYLAND_DISPLAY` is set and not empty, so there is a graphical session
  for `xdg-open` to use.

`--open` skips these checks and always tries; `--no-open` never tries. The
opener is `open` on macOS, `start` through `cmd` on Windows and `xdg-open`
elsewhere, looked up on `PATH`. If it is missing or fails you get one
warning line on stderr and the server keeps running.

### Markdown descriptions

A ticket's description is rendered as Markdown in the ticket detail view:
CommonMark plus the GitHub extensions for tables, task lists,
strikethrough and autolink literals (footnotes stay text). The Markdown is
parsed into a syntax tree and turned into page elements from an
allow-list, never into HTML: no HTML string is built or inserted, so raw
HTML in a description (`<img>`, `<script>` and the like) is shown
literally, as the text the author wrote. What that means in practice:

- **Links.** A link becomes a link only for an absolute `http:`, `https:`
  or `mailto:` URL (an `http:` or `https:` URL must have `//` right after
  the scheme, and leading whitespace is refused); any other URL,
  `javascript:`, `data:` and relative ones included, is shown as its text.
  A link opens in a new tab with no opener and no referrer
  (`target="_blank"`, `rel="noopener noreferrer"`).
- **Images.** An image is never loaded: it is shown as a link to the image
  URL (under the same rule) labelled with its alt text, or with the URL
  when there is no alt text, so the page requests nothing from another
  origin.
- **Task lists.** A task list item shows a checkbox that cannot be changed.
- **Headings and code.** Headings are shifted down three levels (`#` is an
  `h4`, `###` and deeper an `h6`) so they sit under the view's own
  headings, and a code block keeps the first word of its info string as a
  `data-lang` attribute, without syntax highlighting.
- **Limits.** Anything nested deeper than 32 levels (block quotes, lists,
  emphasis and the like) is shown as its source text, and a description
  longer than 16384 characters is not parsed at all and is shown as plain
  text, as is any description the renderer fails on.

Titles, labels, comments, hand-off notes, actor names and paths stay plain
text, and `top` is unchanged.

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
  `Access-Control-Allow-*` header, and every method but `GET` is refused
  (except `POST` to the action endpoints), so CORS preflights never
  succeed. On `/api/*` the token is checked before the method, so a
  preflight or any other request without a token is 401 `unauthorized`
  (405 with a valid token and the wrong method); on the page and its
  assets a non-`GET` request is 405 `method-not-allowed`.
- **Security headers on every response**, errors included: a strict
  `Content-Security-Policy` (only the server's own script, style and
  connections; no framing), `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`,
  `Cross-Origin-Opener-Policy: same-origin` (the tab that opened the
  start-up URL keeps a window handle, but it is severed: it reports
  `closed` and cannot navigate or script the page) and
  `Cross-Origin-Resource-Policy: same-origin` (no other origin can embed a
  response), plus `Cache-Control: no-store` on API and stream responses.
- **Read-only unless started with `--as`.** Without `--as` there is no
  write route (every action is 405 `read-only`). With it, the only writes
  are the action endpoints of "Acting from the browser", behind the checks
  described there. Board text (titles, comments, actor names) is always
  shown as text, never as HTML; a description is rendered as Markdown
  into elements (see "Markdown descriptions"), still never as HTML.

What it does not protect against:

- **Other users of the machine, whenever `serve` opens the browser.**
  Opening the browser, which `serve` does by default from an interactive
  terminal as well as with `--open`, passes the URL, token included, on a
  command line. On macOS, and on Linux unless `/proc` is mounted with
  `hidepid`, every local user can read every process's command line with
  `ps`. On macOS, `open` hands the URL to the browser by Apple Event, so
  only the short-lived `open` process shows it. On Linux, `xdg-open`
  starts the browser with the URL as an argument; if no browser was
  running, that browser process can keep the URL in its command line for
  as long as it runs. In that case the token does not keep other users'
  processes out. On a shared machine, start the server with `--no-open`
  and copy the printed URL into the browser by hand, which keeps the token
  off every command line. `serve` already skips the browser in an SSH
  session and in CI, the places most likely to be shared, but it cannot
  tell that a local desktop is shared (see ADR 0010).
- **Your own account.** Anyone who can read your terminal or your shell
  scrollback can see the token. The token protects against web pages and,
  when you use `--no-open` on a shared machine, other users' processes; it
  does not protect against you.
- **Browser history.** The page drops the fragment at once, but a browser
  may still have recorded the first URL, token included, in its history.
  Only your account can read that, and the token is dead once the server
  stops.
- **Script in the page.** The token sits in `sessionStorage`, where script
  of the page's own origin could read it. The Content-Security-Policy
  admits only the server's own script and is unchanged by Markdown
  descriptions: a description is interpreted as Markdown into elements
  from an allow-list of node types (see "Markdown descriptions"), and no
  HTML string is ever built or inserted into the page. A test
  (`src/web/__tests__/client-source.test.ts`) scans every module under
  `src/web/client/` for `dangerouslySetInnerHTML`,
  `innerHTML`, `outerHTML`, `insertAdjacentHTML` and `document.write` and
  fails on any match, so this does not rest on review alone. Every other
  board text is shown as text, and the token handling is unchanged, so
  there is no known way to inject script.
- **Idle authenticated streams.** A client holding the token can open up
  to 64 streams; one that never reads its first message can keep about the
  size of the board in memory until it disconnects.
- **Large boards.** The page loads every event at start-up; it is built
  for boards of up to about 20,000 events.

A new tab has no token: `sessionStorage` belongs to one tab. Reloading a
tab keeps working, but a tab you open by hand, or a tab left open across a
server restart (the token changes every run), shows "Open the URL printed
by agentboard serve". Open the URL from the terminal again.

### Acting from the browser

Start the server with `--as <actor>` to answer a question, unblock a
ticket, take over a stale claim, hand work back to an agent or close a
merged ticket from the page you are reading:

```
$ agentboard serve --as ben
serving /home/me/project/.board as ben at http://127.0.0.1:4477/#token=vYtNk7ld4gs4Wye8GFsIMZfinx8G98Nuw9kDouLDx-M
$ agentboard serve --json --as ben
{"url":"http://127.0.0.1:4479/#token=z0CcOj6ITtQLkb4uydBc0v1RM43phOLInwLm4holzKs","port":4479,"token":"z0CcOj6ITtQLkb4uydBc0v1RM43phOLInwLm4holzKs","writable":true,"actor":"ben"}
```

- **The actor is fixed when the server starts.** Every event written
  through the server carries the `--as` actor. No request can choose or
  change it: an action body with an `as` property is refused with 400
  `usage`, whatever its value. To act as someone else, stop the server and
  start it again with another `--as`. A hand-off's `to` is the one other
  actor name a request carries: it is checked like `--to` on the CLI ("The
  actor rule") and refused with 400 `invalid-actor`, never echoed, with no
  override from the browser.
- **Only `--as` enables writes.** `AGENTBOARD_ACTOR` is ignored by
  `serve` (a deliberate exception to "The actor rule"): with it set and no
  `--as`, the server is read-only, `/api/session` reports `writable` false
  and `actor` null, and every action is 405 `read-only`.
- **The same rules as the CLI.** Each action runs the registry command of
  the same name, with its arguments converted and checked by the same code
  as an MCP tool call and its operation run in its single `BEGIN
  IMMEDIATE` transaction. Validation, refusals and the event written are
  the CLI's.

#### The controls

The header shows `acting as <actor>`, and the ticket detail
(`#/ticket/<id>`) gains an Actions panel:

- a **Comment** box;
- **Move to**, listing only the statuses the state machine permits from
  the current one (a blocked ticket offers only the status it was blocked
  from; a merged ticket offers nothing); for a ticket with neither a task
  reference nor an unplanned disposition, choosing `merged` adds a
  **Scope** select (`unplanned reason`, then `task reference`) and a
  **Value** input, sent as the `unplanned` or `task` property;
- **Claim** and **Release** buttons;
- a **hand-off** form: To, Status (the current status first, which makes
  the hand-off a reassignment, then the permitted moves) and Note;
- **Link to**: a task reference (`openspec:add-login#1`), a pull request
  (a URL or number) or a decision path, one per submission;
- **Close**, with exactly one disposition: "Decision recorded in" with a
  decision path, or "No decision", plus the same Scope and Value fields
  for a ticket with neither a task reference nor an unplanned disposition;
- a checkbox per checklist line: checking it ticks the line, unchecking it
  unticks it. A tick on a ticket with a task reference shows the reminder
  to tick the line in `tasks.md` too.

A success is shown at once, without waiting for the live stream (which
then confirms it). A refusal is shown beside the control that made it,
with the same message and hint the CLI prints, and the form keeps what you
typed. The hint is rendered for the server's actor, so it is the command
you would type in a shell:

```
ticket 01M3D3ZT8FBSMYMBR4MSYHJ85H is already assigned to impl-1
another actor holds this ticket, so do not work on it: see who with 'agentboard show 01M3D3ZT8FBSMYMBR4MSYHJ85H', or find your own work with 'agentboard inbox --as ben'
```

When the refusal is `busy` (another process held the board cache past the
busy timeout), it also offers a **Retry** button, which posts the same
action again. While an action waits for the cache lock, up to the busy
timeout twice, this server answers nothing else, as a CLI command would
wait. The page never checks an action itself beyond choosing what to
offer: a stale page submitting on an old view gets the refusal the board
gives at write time (for example `invalid-transition`). A read-only server's
page has no Actions panel and no checkboxes.

**Close and link paths are relative to the working tree root.** On the
CLI a relative `--decision-recorded-in` or `--decision` path resolves
against the current directory. The browser has none, so the server uses
the root of the working tree that contains the directory `serve` was
started in (`git rev-parse --show-toplevel`, or that directory outside
git). Started in `/home/me/project/src`, a close with the path
`docs/adr/0002-sessions.md` names `/home/me/project/docs/adr/0002-sessions.md`
and is recorded as `docs/adr/0002-sessions.md`. As on the CLI, a close's
path must exist on the machine running `serve` and lie inside the tree,
and "No decision" is refused with `unpromoted-decision`, quoting the
comments, while the ticket has an open `DECISION:` comment.

**No secret-like override.** Comments, hand-off notes and unplanned
reasons are checked
against the same secret patterns as the CLI and refused with 400
`secret-like` and the pattern name, never echoing the text. The page has
no equivalent of `--allow-secret-like`, and a body that contains the
`allow-secret-like` property is refused with 400 `usage`: the browser is
where pasted text is most likely to be a real credential. Write a false
positive with the CLI and `--allow-secret-like`.

#### The action endpoints

The page posts to `POST /api/actions/<action>`, where `<action>` is the
command name with the space written as `-`. The body is one JSON object
with the same properties as the command's MCP tool (see "MCP server"),
without `as`:

| Action | Body |
| ------ | ---- |
| `comment` | `{"id", "text"}` |
| `move` | `{"id", "status"}`; without `status`, a blocked ticket returns to the status it was blocked from; with `"status": "merged"`, at most one of `"task"`, `"change"` with `"group"` or `"unplanned"` as the scope disposition |
| `claim` | `{"id"}` |
| `release` | `{"id"}` |
| `handoff` | `{"id", "to", "status", "note"}` |
| `checklist-tick` | `{"id", "index"}`, `index` an integer counted from 0 |
| `checklist-untick` | `{"id", "index"}` |
| `link` | `{"id"}` and exactly one of `"task"`, `"change"` with `"group"`, `"pr"` or `"decision"` |
| `close` | `{"id"}` and exactly one of `"decision-recorded-in": "<path>"` or `"no-decision": true`, plus at most one of `"task"`, `"change"` with `"group"` or `"unplanned"` as the scope disposition |

`id` is a full ticket id or a unique prefix of at least 6 characters, as
on the CLI. The properties `as`, `json` and `allow-secret-like` are
refused with 400 `usage` whatever their value, as are unknown properties,
wrong types and a body that is not one JSON object. Any other action name
is 404 `not-found`.

A success is 200 with the document the command prints with `--json`:
`{hash, ticket}` for every action (`hash` is null when nothing was written,
as for a claim by the ticket's current holder), plus `reminder` for a
checklist tick or untick. A refusal writes nothing and is an
`ErrorDocument` with the CLI hint for the server's actor:

| Status | When |
| ------ | ---- |
| 400 | a refusal with exit code 1: `usage`, `invalid-actor` (a hand-off's `to`), `secret-like`, `unpromoted-decision`, `decision-path-missing`, `path-outside-tree`, `id-too-short`, `ambiguous-id`, ... |
| 409 | a refusal by board state (exit code 4): `already-assigned`, `not-assignee`, `invalid-transition`, `needs-scope-disposition`, `already-linked`, `checklist-index`, `unknown-ticket`, ... |
| 503 | `busy`: the cache stayed locked; try again |
| 500 | anything else |
| 405 | `read-only` (a server without `--as`), or `method-not-allowed` for another method on an action path (`Allow: POST`) |
| 404 | `not-found`: not one of the nine actions |
| 403 | `csrf-failed` (below), or `forbidden-host` |
| 413 | `body-too-large` |
| 401 | `unauthorized` |

Note that `unknown-ticket` is 409 for an action (it is exit code 4) but
404 on the `GET` routes. From a script, with the token of the running
server:

```
$ curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"id":"01M3D3ZT8F","text":"Merged the form behind a flag."}' \
    http://127.0.0.1:4477/api/actions/comment
{"hash":"e52d8502deefacb776263e78fe5ad764a61606cdc2f879ef5cf79876eae5297d","ticket":{"id":"01M3D3ZT8FBSMYMBR4MSYHJ85H","title":"Add login form",...}}
$ curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"id":"01M3D3ZT8F","status":"merged"}' http://127.0.0.1:4477/api/actions/move
{"error":{"exitCode":4,"reason":"invalid-transition","message":"ticket.move on ticket 01M3D3ZT8FBSMYMBR4MSYHJ85H refused: invalid-transition","hint":"check the current status with 'agentboard show 01M3D3ZT8F' and the permitted moves with 'agentboard help move'"}}
```

A write made through the server reaches every open page through the live
stream, like a write from any other process.

#### Cross-site request forgery

A cross-site request forgery needs a credential that the browser attaches
on its own. The server has none: there is no cookie, and the token is
accepted only in the `Authorization: Bearer` header, which only the page's
own script sets, from its own tab's `sessionStorage`. A page on another
origin (another site, or another port on `127.0.0.1`) cannot read that
storage, and cannot send an `Authorization` header or a JSON body without
a CORS preflight, which the server never approves. A form post or a
`no-cors` fetch carries no token and gets 401, even with the token in a
cookie. So the bearer check of every request is itself the CSRF defence,
and there is no separate CSRF token or header. In addition, every `POST`,
after the Host and token checks and before anything else is decided about
it:

- must carry exactly one `Content-Type` header, `application/json`, whose
  only permitted parameter is `charset=utf-8` (letter case ignored, the
  value optionally quoted). Anything else, including a form encoding,
  `text/plain` or another charset such as `utf-16`, is 403 `csrf-failed`:
  the body is always decoded as UTF-8, and a JSON content type is a second,
  independent reason for a browser to preflight any cross-origin write;
- when it has an `Origin` header, must have exactly one, equal to
  `http://127.0.0.1:<port>` or `http://localhost:<port>` and naming the
  same host as the `Host` header; anything else, `null` and another port
  included, is 403 `csrf-failed`. Browsers send `Origin` on every `POST`;
  a request without one is not from a browser and is accepted, since it
  already proved the token;
- must have a body of at most 64 KiB, else 413 `body-too-large` (a
  resource bound: the largest real action is a few KiB).

```
$ curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -H 'Origin: https://attacker.example' -d '{"id":"01M3D3ZT8F","text":"x"}' \
    http://127.0.0.1:4477/api/actions/comment
{"error":{"exitCode":1,"reason":"csrf-failed","message":"an action sent with an Origin header must come from the page of this server, at the same address as the Host header","hint":"an action must be posted by the page of this server, or by a script that sends no Origin header, with Content-Type: application/json; see 'agentboard help serve'"}}
```

A refused request writes nothing.

#### What the URL grants

The start-up URL of a server started with `--as` is a credential to write
as that actor: anyone who has it (or the token in it) can comment, move,
claim, release, hand off, tick, link and close as that actor until the
server stops, and every event looks exactly as if that actor had run the
command. The token changes at every start, so stopping the server revokes
it. Everything under "What it does not protect against" applies with that
higher stake: use `--no-open` on a shared machine, and do not paste the
URL anywhere. Start a writable server only while you use it, and a
read-only one to just watch. See ADR 0009 for the write-mode decisions.

### The JSON API

Scripts can read the same data the page does. Every route here is `GET`
(the only other routes are the `POST` action endpoints of "Acting from the
browser"), needs the bearer header and answers JSON (errors are the same `ErrorDocument`
the CLI prints with `--json`, with a hint):

| Route | Answer |
| ----- | ------ |
| `/api/session` | `{version, boardDir, writable, actor}`: `writable` true and `actor` the `--as` actor when started with `--as`, else false and null |
| `/api/board` | `{tickets, meta, id}`: every ticket, open and closed, the board meta and the feed position id |
| `/api/tickets/<id>` | `{ticket, events}` for a full id or a unique prefix of at least 6 characters; 400 `id-too-short` or `ambiguous-id`, 404 `unknown-ticket` |
| `/api/events?after=<hash>&limit=<n>` | `{events, next}`: well-formed events in fold order with their outcome, `limit` 1000 by default and at most 5000; pass `next` as `after` for the next page (null on the last) |
| `/api/actors` | the agent lanes |
| `/api/health` | `{late, check}`: the late and removed events this server has observed (see "Board health") and the last cache check, or null; never runs the check |
| `/api/health/check` | runs the cache check (as `rebuild --check`) and answers `{ranAt, matches, differingRows}`; one run at a time, and a result less than 30 seconds old is returned without running again |
| `/api/stream?since=<id>` | Server-Sent Events: `append` and `resync` events with position ids, a `problem` event on a tick failure; resumes from `Last-Event-ID` or `since` |

Start the server in one terminal with `agentboard serve --port 4477
--json`, copy the `token` from its line, and in another terminal:

```
$ TOKEN=<token>
$ curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4477/api/session
{"version":"0.1.0","boardDir":"/home/me/project/.board","writable":false,"actor":null}
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
- **The browser did not open.** `serve` opens it only from an
  interactive terminal outside CI and SSH, and off macOS and Windows only
  with a display (see "When the browser opens"). Open the printed URL by
  hand, or pass `--open` to try anyway; a warning on stderr means the
  system opener was missing or failed.
- **`port-in-use`.** Something else listens on that port. Omit `--port`,
  or pass `--port 0`, and let the system choose.
- **403 `forbidden-host`.** The request did not reach the server as
  `127.0.0.1:<port>` or `localhost:<port>`, for example through a proxy,
  another host name or `[::1]`. Use the printed URL as it is.
- **401 `unauthorized` from curl.** Send exactly one `Authorization:
  Bearer <token>` header with the token of the running server; a query
  parameter or a cookie does not count.
- **405 `method-not-allowed`.** The server answers only `GET`, plus `POST`
  to `/api/actions/<action>` (curl's `-I` sends `HEAD`).
- **405 `read-only`.** The server was started without `--as`. Stop it and
  start `agentboard serve --as <actor>`, or run the command in a shell.
- **403 `csrf-failed`.** An action was posted without exactly one
  `Content-Type: application/json` header (only `charset=utf-8` may
  follow it), or with an `Origin` other than the page's own. Scripts send
  JSON and leave `Origin` out.
- **413 `body-too-large`.** An action body is at most 64 KiB.
- **503 `busy` on an action.** Another process held the board cache for
  longer than the busy timeout. Press Retry beside the control, or post
  again.
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

## Board health

The health report answers what a supervising human or an orchestrator
asks of a board: which claims have gone quiet, which tickets have sat in
`blocked`, which `DECISION:` comments still need promoting, and what
`close-merged` will make of the tickets in `merged`. It is one pure
function over the board, used by the `health` command, the MCP tool
`board_health` and the Health view of `agentboard serve`, so the three
never disagree. It writes nothing.

### The checks

Every age is the time now minus the wall clock of the event it is
measured from, and 0 when that event's clock is ahead of yours. Only
applied events count (a claim that lost a race changes nothing), and a
closed ticket appears in no section but the unplanned scope.

| Section | What it lists | Default threshold |
| ------- | ------------- | ----------------- |
| Stale claims | Open tickets not in `merged` with an assignee who has been idle for at least the threshold | 2 hours (`--stale-after`) |
| Stuck in blocked | Open tickets in `blocked` that entered `blocked` at least the threshold ago, with the status they were blocked from and their latest comment | 24 hours (`--blocked-after`) |
| Unpromoted decisions | Open tickets, in any status, with at least one open `DECISION:` comment and no `decision` link | none |
| close-merged: ready | Open tickets in `merged` with a `pr` link, and either no open decision or a `decision` link | none |
| close-merged: held by a decision | Open tickets in `merged` with a `pr` link, an open decision and no `decision` link | none |
| close-merged: missing a PR link | Open tickets in `merged` with no `pr` link | none |
| Unplanned scope | Tickets in `merged` or closed with an unplanned disposition, and ad hoc tickets closed with no disposition at all, with their reasons: those disposed of less than the window ago are listed, all of them are counted | 7 days (`--unplanned-within`) |
| Late arrivals | Events a running `serve` saw arrive late or be removed (web only) | none |
| Cache check | Whether the cache matches the event log, run only on request | none |

- **Idle** is measured from the later of the assignee's own latest event
  on the ticket (of any kind) and the latest claim, hand-off or assign on
  the ticket, the event that made them the assignee. Other actors'
  events do not count: a reviewer commenting on a ticket does not make
  its implementer look busy. A blocked ticket with an assignee can be
  both a stale claim and stuck in blocked.
- **Entering `blocked`** is a `move` to `blocked` or a `handoff` with
  `--status blocked`. A hand-off with `--status blocked` on a ticket that
  is already blocked only reassigns it and does not restart the clock;
  nor does a comment. The latest comment shown is the ticket's last one,
  hand-off notes included, which by convention says why.
- **Open decisions** are exactly the ones `close` refuses `--no-decision`
  for: `DECISION:` comments their author has not retracted with a later
  `RETRACTED:` comment. Promote them to a spec delta or ADR and record it
  with `link <id> --decision <path>`.
- **close-merged candidates.** Whether a pull request is merged is known
  only to `close-merged`, which asks GitHub through `gh`; the report never
  claims it. `ready` tickets are closed by `close-merged` once `gh`
  reports their PR merged; `held by a decision` tickets would be skipped
  by the decision rule; `missing a PR link` tickets are never considered
  by `close-merged` and need `link <id> --pr <ref>` or a manual `close`.
- **Unplanned scope** is the one section that includes closed tickets,
  because closed is where unplanned work ends up, and the one section
  that is information, not a finding to fix: it is what "Tickets and task
  references" disclosed instead of blocking. A ticket is unplanned scope
  when it has an unplanned disposition and is in `merged` or closed, or
  when it is closed with an ad hoc reason and neither a task reference
  nor an unplanned disposition (closed before the disposition existed).
  Its age is measured from the applied `ticket.unplanned`, or from the
  `ticket.close` for an undisclosed close, which is reported with no
  reason. A ticket later linked to a task leaves the section. `total`
  counts every such ticket whatever its age; the list holds those less
  than the window old, most recent first.
- **Late arrivals** are what a running server observed since it started:
  events that `sync` delivered with a position before events already
  shown, and events removed from the fold in a resync (for example a
  claim refolded as having lost a race). The server keeps the last 100,
  newest first, each with its kind, ticket and when it was seen, in memory
  only. The `health` command always reports `late` as null, because a
  one-shot command cannot observe arrival order.
- **The cache check** is the comparison `rebuild --check` makes: whether
  the cache matches a fresh fold of the event log, and how many rows
  differ. It holds the write lock for the length of a full refold into
  memory, so it briefly pauses writers and never runs on its own: only
  `health --check` or the Health view's button runs it. A cache that
  differs is a finding, not a failure; fix it with `agentboard rebuild`.

Stale claims and stuck tickets are listed longest first and unplanned
scope most recent first (then by id); every other ticket section is in
ticket id order.

### The `health` command

```
agentboard health [--stale-after <duration>] [--blocked-after <duration>] [--unplanned-within <duration>] [--check] [--json]
```

A duration is `<n>m`, `<n>h` or `<n>d` (minutes, hours or days) with `<n>`
a whole number from 1 to 99999, so `30m`, `2h` or `7d`. Anything else,
such as `2hours`, `1.5h`, `0h` or `90s`, exits 1 with reason `usage`,
before the board is even opened:

```
$ agentboard health --stale-after 2hours
agentboard: invalid --stale-after: a duration is <n>m, <n>h or <n>d with <n> a positive integer of at most 5 digits (for example 30m, 2h or 1d)
hint: check the arguments with 'agentboard help health'
```

Each section is printed with its count, then one line per ticket in the
`list` format followed by the finding. On a board with a quiet claim, a
blocked ticket and a merged ticket without a PR link, with both
thresholds lowered to a minute:

```
$ agentboard health --stale-after 1m --blocked-after 1m
thresholds: stale after 1m, blocked after 1m
stale claims: 2
01M3CCGMG08YEDKBQEK7JMHSWS  implementing  impl-1  Parse config  last active 1m ago (ticket.move by impl-1)
01M3CCGMJX1A05M6YYB8H3X0R7  blocked  impl-2  Add cache layer  last active 1m ago (ticket.comment by impl-2)
stuck in blocked: 1
01M3CCGMJX1A05M6YYB8H3X0R7  blocked  impl-2  Add cache layer  blocked 1m ago from implementing; latest comment by impl-2: waiting on the storage schema from the reviewer
unpromoted decisions: 1
01M3CCGMRS6KWXWMHWPBVJJMDZ  todo  -  Query parser  1 open decision, no decision link
close-merged ready: 1
01M3CCGMVYJXEDVPFRFV7JTT08  merged  reviewer-1  Ranking  pr 42
close-merged held by decision: 0
close-merged missing pr: 1
01M3CCGMNHZ78NN5F74QME13B1  merged  reviewer-1  Index documents  no pr link
unplanned scope: 0 in the last 7d (0 in all)
cache check: not run
```

The unplanned scope section comes after the close-merged ones, with the
window in its heading. On a board where the ad hoc ticket of "Tickets and
task references" was merged as unplanned two hours earlier, and another
ad hoc ticket was closed from `blocked` with `--unplanned` three days
earlier, it reads:

```
unplanned scope: 2 in the last 7d (2 in all)
01M38YRHC32109EYJ1TPDZPQ2N  merged  impl-1  [unplanned] Fix typo in footer  merged 2h ago, unplanned: production hotfix
01M38YRHDJDH9E02WN42FFWFMT  blocked  -  [unplanned] [closed] Try a new parser  closed 3d ago, unplanned: abandoned: superseded
```

An ad hoc ticket closed before the disposition existed ends `closed 3d
ago, no reason recorded (ad hoc: <reason>)`. `--unplanned-within 30d`
widens the list; the count in parentheses is always all of it.

`--check` adds the cache check. `--json` prints the report as one JSON
document with the keys `now`, `thresholds` (in milliseconds:
`staleAfter`, `blockedAfter`, `unplannedWithin`),
`staleClaims`, `stuckBlocked`, `unpromotedDecisions`, `closeMerged`
(`ready`, `heldByDecision`, `missingPr`), `unplannedScope` (`total`, and
`tickets` within the window, each with the ticket's card, `adhoc` (the
creation reason), `reason` (the unplanned reason, null for an undisclosed
close), `outcome` (`merged` or `closed`), `since` and `ageMs`), `late`
and `check`. Each finding
carries the ticket's card (as the web page shows it) and, for stale,
blocked and unplanned tickets, the event its age was measured from
(`since`, with its hash, kind, actor and clock) and the age in
milliseconds (`idleMs`, `blockedMs`, `ageMs`). An excerpt of the same
board's report:

```
$ agentboard health --stale-after 1m --blocked-after 1m --check --json | jq '{thresholds, staleClaims: [.staleClaims[] | {ticket: .ticket.shortId, assignee, idleMs}], stuckBlocked: [.stuckBlocked[] | {ticket: .ticket.shortId, blockedFrom, blockedMs}], missingPr: [.closeMerged.missingPr[].ticket.shortId], unplannedScope: {total: .unplannedScope.total, tickets: [.unplannedScope.tickets[] | {ticket: .ticket.shortId, reason, outcome, ageMs}]}, late, check}'
{
  "thresholds": {
    "staleAfter": 60000,
    "blockedAfter": 60000,
    "unplannedWithin": 604800000
  },
  "staleClaims": [
    {
      "ticket": "01M3CCGMG0",
      "assignee": "impl-1",
      "idleMs": 68781
    },
    {
      "ticket": "01M3CCGMJX",
      "assignee": "impl-2",
      "idleMs": 68236
    }
  ],
  "stuckBlocked": [
    {
      "ticket": "01M3CCGMJX",
      "blockedFrom": "implementing",
      "blockedMs": 68349
    }
  ],
  "missingPr": [
    "01M3CCGMNH"
  ],
  "unplannedScope": {
    "total": 0,
    "tickets": []
  },
  "late": null,
  "check": {
    "ranAt": 1790343471569,
    "matches": true,
    "differingRows": 0
  }
}
```

`health` exits 0 whatever the report contains, a differing cache and
unplanned scope included: findings are data, so read the report (or `jq`
the JSON) rather than the exit code. It exits 1 (`usage`) for an unknown
flag or a malformed duration, 2 when there is no board, and 5 for an integrity
problem in the event log or cache, or when `--check` cannot take the
write lock within the busy timeout. It needs no actor (`--as` is
accepted and ignored). It reads ticket state from the cache and the file
of every applied event on the board (once each, closed tickets' included,
since the cache does not record which ticket an event belongs to), all in
one read snapshot, so it does not block writers unless `--check` is
given.

Run it before archiving a change and when choosing what to dispatch; the
orchestrator checklist of the agent guide says so too.

### Over MCP: `board_health`

The MCP tool `board_health` is the same command. Its optional arguments
are `stale-after`, `blocked-after` and `unplanned-within` (duration
strings) and `check` (a boolean), and it returns the document `health
--json` prints: a call with `{"stale-after": "30m"}` returns what
`agentboard health --stale-after 30m --json` prints, and one with
`{"unplanned-within": "30d"}` lists the unplanned scope of the last 30
days under `unplannedScope`. A malformed duration is a tool error with
`exitCode` 1 and `reason` `usage`.

### In the browser

The Health view of `agentboard serve` (`#/health`) shows the same
sections, computed in the browser from the board the page already holds,
re-evaluated on every change and every 10 seconds, plus two things only
the server knows:

- **Thresholds.** Three inputs, `Stale after`, `Blocked after` and
  `Unplanned within`, take the same durations as the command and are kept
  in the URL (`#/health?stale=30m&blocked=2d&unplanned=30d`). An invalid
  value is flagged and the report keeps the last valid one. The unplanned
  scope section is styled as information, like the cache check when it
  matches, not as a warning like stale claims and stuck tickets.
- **Late arrivals**, from `GET /api/health`, with when each was observed.
- **Run cache check**, a button that calls `GET /api/health/check`. The
  server runs one check at a time: a request that arrives while one runs
  waits for it and gets its result, and a result less than 30 seconds
  old is returned without running again. A failed check (for example
  `busy`) is shown as an error and not kept, so the next press tries
  again. Nothing else ever runs it.

Both routes are behind the same token and Host checks as every other API
route (see "Security model" and "The JSON API").

## Replay and the hand-off graph

Two more views of `agentboard serve` show how the board got where it is.

**Replay** (`#/replay`) rebuilds the board at any past position of the
event log, in the browser, with the same fold the store uses, so an
event that was rejected at the time (a claim that lost a race) replays as
rejected. When the view opens it takes a copy of the event list and
starts at the present; events that arrive while you replay update the
live board, not the copy, and reopening the view takes a new copy.

- A slider over positions, `Event <n> of <total>`, and `Step back` and
  `Step forward`.
- `Play` and `Pause` at 1, 4 or 16 events per second; play stops by
  itself at the last event.
- The event at the current position: its actor, a one-line description
  and its outcome, with the reason when it was rejected.
- The board columns of the replayed state, as on the live board (closed
  tickets hidden).
- `Back to live` returns to the board.

Replay follows the log's fold order, not the order events reached you: an
event synced late appears at its fold position, which is the only
history the log can reproduce. Scrubbing stays fast on large boards
because the page keeps a folded state every 500 events and folds forward
from the nearest one.

**The hand-off graph** (`#/graph`) shows actors as nodes on a circle, in
name order, and hand-offs as directed arrows from the actor who ran
`handoff` to its `--to`, labelled with how many there were and thicker
as the count grows. A hand-off to yourself (a status change with a note)
is a loop beside the node. Each node's tooltip gives its sent and
received totals, and a table under the graph lists every edge. Only
applied `handoff` events count: claims, releases and assigns are not
hand-offs.

- **Change** limits the graph to hand-offs on tickets of one change,
  `<source>:<ref>` (for example `openspec:add-search`, any group).
- **Since** limits it to hand-offs in the last hour, day, 7 days or 30
  days.
- Both are kept in the URL (`#/graph?change=openspec:add-search&since=7d`).
- When a hand-off arrives live, its arrow is animated for 3 seconds.

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
modifies the cache. Neither ever writes an event: they are the only
commands that open the board without writing a queue grant that has
fallen due (see "The waiting queue and grants").

## Error hints

Every refusal also says what to run next. The CLI prints the hint on
stderr, on a line beginning `hint: ` after the error line:

```
$ agentboard claim 01M38YRHC3 --as reviewer
agentboard: ticket 01M38YRHC32109EYJ1TPDZPQ2N is already assigned to impl
hint: another actor holds this ticket, so do not work on it: see who with 'agentboard show 01M38YRHC3', or find your own work with 'agentboard inbox --as reviewer'
```

A missing actor hints both `--as` and `AGENTBOARD_ACTOR`;
`needs-scope-disposition` hints both forms of the refused command,
`agentboard move <id> merged --task <source>:<ref>#<item> --as <actor>`
(or `--change <name> --group <n>`) and `agentboard move <id> merged
--unplanned "<reason>" --as <actor>` (for `close`, with the decision flag
you gave), ending with
"do not create an issue or task only to satisfy this";
`already-linked` names the task the ticket is linked to and the same
command without `--unplanned`; a close refused by the decision rule
hints `--decision-recorded-in <path>`. Every rejection reason has a hint,
including those of exit codes 2, 3 and 5 (`board-not-found`, for example,
hints `agentboard init`); only an unexpected failure has none.

With `--json`, stdout carries the error as one JSON document with the
hint as a field, and stderr still has the error and `hint: ` lines:

```
{"error":{"exitCode":4,"reason":"already-assigned","message":"ticket 01M38YRHC32109EYJ1TPDZPQ2N is already assigned to impl","hint":"another actor holds this ticket, so do not work on it: see who with 'agentboard show 01M38YRHC3', or find your own work with 'agentboard inbox --as reviewer'"}}
```

The refusals of the web app's actions (see "Acting from the browser")
carry the same hint, rendered for the server's `--as` actor, so a claim
refused `already-assigned` hints `agentboard inbox --as <that actor>`.
The server's own refusals have hints too: `read-only` names `agentboard
serve --as <actor>`, and `csrf-failed` and `body-too-large` say what an
action request must look like.

MCP tool errors carry the same `hint` field (see "MCP server"). There a
suggested command that is a tool is written as a tool call, such as
`board_inbox {"as":"reviewer"}`, and the actor advice names the `as`
argument and `agentboard mcp --as <actor>`.

## Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | success |
| 1 | usage error (including an unknown command or flag), missing actor, a refused actor name (`invalid-actor`: a secret pattern or not of the actor form), refused text or close disposition, `rebuild --check` found a difference, an `agents install` target was refused or nothing was detected, `agents check` found guidance that is not current, `serve` could not use its port (`port-in-use`) or was given an empty `--as` or both `--open` and `--no-open`, or `top` was not run in an interactive terminal (`not-a-tty`) |
| 2 | board not found or unreadable |
| 3 | sync problem that needs a human |
| 4 | action rejected by board state: `invalid-transition`, `already-assigned`, `queued`, `not-assignee`, `invalid-queue`, `wait-timeout`, `wait-interrupted`, `unknown-ticket`, `duplicate-create`, `needs-scope-disposition`, `already-linked`, `checklist-index`, `reconcile-blocked`, `reconcile-ambiguous` |
| 5 | event log or cache integrity problem, or the cache still locked after the busy timeout and one retry |

## MCP server

`agentboard mcp` serves the board to MCP clients over stdio, with one tool
per command, named `board_<command>` with spaces and hyphens turned into
underscores: `board_new`, `board_show`, `board_list`, `board_claim`,
`board_renew`, `board_unqueue`, `board_release`, `board_move`,
`board_comment`, `board_handoff`, `board_link`, `board_checklist_tick`,
`board_checklist_untick`, `board_close`, `board_inbox`,
`board_import_change`, `board_close_merged` and `board_health`. `init`,
`watch`, `serve`, `top`, `rebuild`, `sync`, `remote`, `config set`, `config
get`, `mcp`, `version`, `help`, `agents install` and `agents check` are
not exposed: they are run by a human or an orchestrator in a shell (`init`,
`sync` and `remote` run git against the host's configuration, `config`
changes settings for the whole board, `agents
install` and `agents check` write and read files in the caller's working
tree, which a tool call must not do, and the guide reaches MCP clients as
described below instead of through `help`). Calling an unknown or excluded
tool name returns a tool error with `exitCode` 1, `reason` `usage` and a
hint to call `tools/list`.

- Tool input schemas come from the same command registry as the CLI, with
  the same arguments (flag names without the leading `--`, for example
  `{"id": "01M38YRHC3", "as": "impl-1"}`), the same required fields and
  the same validation; `--json` is implied. A flag the CLI marks as
  command-line only (`claim --timeout`) is not in the schema, and passing
  it is a tool error with `exitCode` 1 and `reason` `usage`.
- No tool call blocks waiting on another actor: `board_claim` with `wait`
  joins the queue and returns `{queued, position, holder, ticket}` at once,
  and the grant arrives through `board_inbox` (see "Waiting on the command
  line").
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

To use a local build instead, for example while working on agentboard
itself, `npm link` it (see "Install and run"), then run `agentboard agents
install --mcp-command agentboard`, which writes an entry that runs the
linked command (`--mcp-command` also takes an absolute path to an
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

Both entries are agentboard's own, so `agents check` reports either as
`current` and a later `agents install` keeps it.

Both entries have no actor: each call then passes `as`, or the server
uses `AGENTBOARD_ACTOR`. To give the server a default actor, one per
agent, add `--as` to the arguments by hand (for example `"args": ["mcp",
"--as", "impl-1"]`). An entry edited this way is not a managed one, so
`agents check` reports it as `modified` and `agents install` refuses it
as `entry-differs` unless `--force` is given, which replaces it.

## What the board is not

- **Not a secret store.** `new`, `comment` and `handoff` refuse text that
  looks like a secret (private key PEM headers, AWS access key ids, GitHub
  tokens, long base64 strings after `token`, `secret`, `password` or
  `key`), exiting 1 with the pattern name and never echoing the text.
  `--allow-secret-like` overrides this for a false positive (on the CLI
  and over MCP only; the web app has no override). Board events are synced
  and kept forever; never put credentials in them.
- **Not the record of completion.** `tasks.md` checkboxes, ticked in the
  PR that does the work, record what was built. The board records who
  holds the work and its state in flight.
- **Not where decisions live.** A `DECISION:` in a thread must be promoted
  to a spec delta or ADR before the ticket closes.
- **Not a source of scope.** Every ticket names the planned task it
  delivers, or discloses that its work was unplanned before it is merged
  or closed; unplanned scope is shown, with its reason, never blocked
  (ADR 0013).
- **Not a multi-user server.** It is local and offline; `sync` moves it
  between machines that take turns.

## Contributing

Behavior changes go through an OpenSpec change proposal under
`openspec/changes/` before implementation; decisions are recorded in
`adr/`. See CONTRIBUTING.md for the workflow and `STATUS.md` for
the current state of the project.
