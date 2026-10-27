# board-agent-guidance Specification

## Purpose
Defines how agentboard teaches agents to use it: help generated from the
command registry, the agent guide, error hints, guidance installed into a
host project for its agents and for OpenSpec, and guide delivery over MCP.

## Requirements

### Requirement: Generated help
`agentboard help`, `agentboard --help`, `agentboard -h` and `agentboard`
with no arguments SHALL print a top-level overview to stdout and exit 0:
one line per command with its summary, grouped as ticket lifecycle, change
awareness, planning integration, maintenance and setup, ending with the
line `Agents: run 'agentboard help agents' before first use.`
`agentboard help <command>` and `agentboard <command> --help` SHALL print
that command's help and exit 0, without requiring an actor or a board.
Command help SHALL be rendered from the command's registry entry and SHALL
contain the synopsis, the summary, every positional argument and flag with
its type and whether it is required, the exit codes the command can
produce with their meaning, and at least one example. With `--json`, help
SHALL print the registry entry (or, for the overview, the array of entries)
as one JSON document.

#### Scenario: Help without a board
- **WHEN** `agentboard claim --help` runs in a directory with no board and no `AGENTBOARD_ACTOR`
- **THEN** it prints claim's synopsis, flags including `--as`, exit codes including 4 `already-assigned`, and an example, and exits 0

#### Scenario: Every registry command has help
- **WHEN** `agentboard help <command>` runs for each command in the registry
- **THEN** each exits 0 and prints a synopsis, at least one example and the exit codes section

#### Scenario: Machine-readable help
- **WHEN** `agentboard help handoff --json` runs
- **THEN** stdout is one JSON object whose flags include `to`, `status` and `note`, each marked required

### Requirement: Help is not an MCP tool
The `help`, `agents install` and `agents check` commands SHALL be excluded
from the MCP server's tools, like the other setup commands: MCP clients
receive the agent guide through the server's `instructions` and the
`agentboard://guide` resource instead, and installing guidance writes files
into the host project, which a tool call from any agent must not do.

#### Scenario: No board_help tool
- **WHEN** an MCP client lists the tools of `agentboard mcp`
- **THEN** no tool named `board_help` is listed

### Requirement: Unknown command suggestions
An unknown command or unknown flag SHALL exit 1, name the unknown token,
suggest up to three registry commands or flags within an edit distance of
2 (a two-word command is also suggested when its first word is within that
distance), and point to `agentboard help`. `--help` and `-h` anywhere before
a lone `--` SHALL request help for the command named before them.

#### Scenario: Misspelled command
- **WHEN** `agentboard clam 01J9K3 --as impl` runs
- **THEN** it exits 1, names `clam`, and suggests `claim`

### Requirement: Agent guide
`agentboard help agents` SHALL print a plain ASCII guide of at most 180
lines, stamped with the package version, containing these sections: what
the board is and is not (not a secret store, not the record of completion);
the actor rule; finding work (`inbox`, `list`); claiming before starting;
handing off and moving to `blocked` with a comment; the `DECISION:`
convention and why `close` needs a decision disposition; how tickets map to
planning tasks, including the OpenSpec flow (`import-change` after
proposing, claim the group's ticket before applying, tick `tasks.md` in the
implementing PR) and ad hoc tickets (worked like any other ticket; the task
link or the unplanned disposition is given by whoever merges or closes the
ticket, with `--task` or `--unplanned` on `move <id> merged` or `close`; never
create an issue, task file or task reference only to satisfy a move);
mutex tickets (see "Mutex ticket recipe"); and
using the MCP tools instead of the shell when they
are available. `agentboard help agents --role <role>` SHALL print the guide
followed by a checklist for that role, where role is one of
`orchestrator`, `test-author`, `implementer` or `reviewer`; the
orchestrator checklist SHALL say to give the scope disposition of an ad hoc
ticket when merging or closing it. The test-author, implementer and
reviewer checklists SHALL include the worker rules for mutex tickets, and
the orchestrator checklist the queue-runner rules (see "Mutex ticket
recipe"). Every line of
guide output that begins with `agentboard ` SHALL parse successfully
against the command registry. The guide SHALL NOT say that an ad hoc
ticket cannot enter `implementing`.

#### Scenario: Guide examples are valid commands
- **WHEN** every line beginning with `agentboard ` is extracted from the output of `help agents` and of `help agents --role` for each role and parsed against the registry
- **THEN** every line parses without an unknown command or flag error

#### Scenario: Unknown role
- **WHEN** `agentboard help agents --role tester` runs
- **THEN** it exits 1 and lists the four valid roles

#### Scenario: Guide explains ad hoc tickets
- **WHEN** `agentboard help agents` runs
- **THEN** its tickets and planning tasks section says an ad hoc ticket is worked normally, shows a `move <id> merged` line with `--unplanned` that parses, names `--task`, says never to create an issue, task file or task reference only to move a ticket, lists `needs-scope-disposition` and `already-linked` among the exit 4 reasons, does not contain `needs-task-link`, and every output (with and without `--role`) is at most 180 lines

#### Scenario: Guide contains the mutex recipe
- **WHEN** `agentboard help agents` and `help agents --role <role>` run for each role
- **THEN** the guide has a section titled `Mutex tickets`, each output is at most 180 lines, and each role checklist has its mutex lines

### Requirement: Error hints
Every exit 1 and exit 4 refusal SHALL include a hint naming a command that
moves the caller forward: for example `already-assigned` hints
`agentboard show <id>` and `agentboard inbox --as <actor>`; a missing actor
hints both `--as` and `AGENTBOARD_ACTOR`; `needs-scope-disposition` hints
the refused command (`move <id> merged`, or `close <id>` with the
disposition flags it was given) with `--task <source>:<ref>#<item>` and
with `--unplanned "<reason>"`, and says not to create an issue or task
only to satisfy it; `already-linked` hints the command without
`--unplanned`; a close
refused by the decision rule hints `--decision-recorded-in <path>`. The CLI
SHALL print the hint on stderr on a line beginning `hint: `. MCP tool errors
SHALL carry it as a `hint` field alongside `exitCode`, `reason` and
`message`. Every rejection reason defined by the board SHALL have a hint.

#### Scenario: Claim race loser is told what to do
- **WHEN** `agentboard claim T1 --as reviewer` fails because `impl` holds T1
- **THEN** stderr contains a `hint: ` line naming `agentboard inbox --as reviewer`

#### Scenario: No reason without a hint
- **WHEN** the set of rejection reasons is enumerated from the source
- **THEN** each has a non-empty hint template, and `needs-scope-disposition` and `already-linked` are in the set

#### Scenario: Missing disposition hint
- **WHEN** `agentboard move T1 merged --as orch` is refused with `needs-scope-disposition`
- **THEN** stderr has a `hint: ` line containing `agentboard move T1 merged --task <source>:<ref>#<item> --as orch` and `agentboard move T1 merged --unplanned "<reason>" --as orch`, each of which parses against the registry

### Requirement: Installing guidance into a host project
`agentboard agents install [--target <t>]... [--mcp-command <executable>]
[--force]` SHALL write agent
guidance into the root of the current working tree (the output of
`git rev-parse --show-toplevel`, or the current directory outside git),
where `<t>` is one of:
- `claude`: `.claude/skills/agentboard/SKILL.md`, a Claude Code skill with
  frontmatter `name: agentboard` and a description that triggers on
  coordinating work between agents, claiming or handing off tasks, and
  checking what other agents are doing;
- `agents-md`: a managed block in `AGENTS.md`, created if absent;
- `openspec`: `guidance` entries under `operations.apply` and
  `operations.archive` in `openspec/config.yaml` (apply: claim the task
  group's ticket before implementing, hand off or block when stopping, tick
  `tasks.md` in the implementing PR; archive: no open tickets may remain
  for the change, run `close-merged` first);
- `mcp-json`: an `agentboard` entry under `mcpServers` in `.mcp.json`
  running `npx -y @bendechrai/agentboard mcp`, or, when `--mcp-command
  <executable>` is given, `{"command": "<executable>", "args": ["mcp"]}`.
The `claude` and `agents-md` text SHALL state the rules an agent must never
break (always pass an actor; claim before working; hand off or block with a
comment before stopping; never mark completion on the board instead of in
the tasks file; promote `DECISION:` comments before closing; never create
an issue, task file or task reference only to move a ticket, but work an
ad hoc ticket normally and give its task link or unplanned disposition
when merging or closing it) and SHALL
direct the agent to `agentboard help agents` for everything else. With no
`--target`, the command SHALL select `claude` when `.claude/` exists,
`agents-md` when `AGENTS.md` exists and `openspec` when
`openspec/config.yaml` exists, SHALL never auto-select `mcp-json`, and SHALL
report each selected target and the reason; when nothing is selected it
SHALL exit 1 listing the targets. Giving `--mcp-command` SHALL select the
`mcp-json` target in addition to the explicit or auto-detected ones, and
the output SHALL name `--mcp-command` as the reason. An empty
`--mcp-command` value or one containing a newline SHALL exit 1 with reason
`usage` and write nothing. The command SHALL NOT require a board and
SHALL NOT run git commands that modify anything. `init` SHALL end its
output with a line suggesting `agentboard agents install`.

#### Scenario: Install the Claude skill
- **WHEN** `agentboard agents install --target claude` runs in a project with no `.claude/skills/agentboard`
- **THEN** `.claude/skills/agentboard/SKILL.md` exists with frontmatter name `agentboard`, the six rules, the text `agentboard help agents`, and the guidance version marker

#### Scenario: Auto-detection
- **WHEN** `agentboard agents install` runs in a project that has `.claude/` and `openspec/config.yaml` but no `AGENTS.md`
- **THEN** the `claude` and `openspec` targets are installed, `agents-md` and `mcp-json` are not, and the output names each selected target and why

#### Scenario: Reinstall is idempotent
- **WHEN** `agents install` runs twice with the same targets and version
- **THEN** the second run changes no file byte and reports each target as up to date

#### Scenario: Local MCP command
- **WHEN** `agentboard agents install --mcp-command agentboard` runs in a project with no `.mcp.json`
- **THEN** `.mcp.json` contains `mcpServers.agentboard` equal to `{"command": "agentboard", "args": ["mcp"]}` and the output names `mcp-json` as selected by `--mcp-command`

#### Scenario: Installed guidance covers ad hoc tickets
- **WHEN** `agentboard agents install --target claude --target agents-md` runs with guidance version 2
- **THEN** `SKILL.md` and the `AGENTS.md` block each state the ad hoc rule, contain no text saying an ad hoc ticket cannot enter `implementing`, carry the guidance version marker `v2`, and `agents check` reports installations of guidance version 1 as `stale`

### Requirement: Installed guidance never clobbers user content
Each target SHALL own only its marked region: the whole of `SKILL.md` only
when it carries the `<!-- agentboard-guidance: v<N> -->` marker; the text
between `<!-- agentboard:start v<N> -->` and `<!-- agentboard:end -->` in
`AGENTS.md`; `guidance` list entries beginning with `agentboard:` in
`openspec/config.yaml`; and the `mcpServers.agentboard` key in `.mcp.json`.
In `AGENTS.md` and `SKILL.md`, everything outside the owned region SHALL be
preserved byte for byte. In `openspec/config.yaml` and `.mcp.json`, which
are rewritten through a YAML or JSON serializer, every key, value, entry,
comment and their order outside the owned entries SHALL be preserved, while
insignificant formatting (indentation, quoting style) MAY be normalized. A `SKILL.md` at the target path without the marker, a
malformed marker pair in `AGENTS.md`, a non-list value at a `guidance` key,
or an existing `mcpServers.agentboard` entry that is not a managed entry
(see "Managed MCP entry") SHALL cause that target to be refused with exit 1 and a message naming
the file, unless `--force` is given, and other targets SHALL still be
processed.

#### Scenario: User content in AGENTS.md survives
- **WHEN** `AGENTS.md` contains user text before and after an existing managed block and `agents install --target agents-md` runs with a newer guidance version
- **THEN** only the text between the markers changes and the user text is byte-identical

#### Scenario: OpenSpec config comments survive
- **WHEN** `openspec/config.yaml` is the commented template OpenSpec generates and `agents install --target openspec` runs
- **THEN** the file gains the agentboard guidance entries and every original comment line is still present in order

#### Scenario: Foreign skill file is not overwritten
- **WHEN** `.claude/skills/agentboard/SKILL.md` exists without the agentboard marker
- **THEN** `agents install --target claude` exits 1 naming the file and leaves it unchanged

### Requirement: Checking installed guidance
`agentboard agents check` SHALL inspect every target that has an
agentboard marker or managed entry in the current working tree and report
each as `current`, `stale` (installed with a different guidance version) or
`modified` (the managed text differs from what its recorded version renders,
or its version or markers cannot be read). It SHALL exit 0 when
all found targets are current, and 1 otherwise, so it can run in a
project's own checks. With `--json` it SHALL print an array of
`{target, path, state, installedVersion, currentVersion}`.

#### Scenario: Stale skill after upgrade
- **WHEN** the skill was installed with guidance version 1 and the running CLI has guidance version 2
- **THEN** `agents check` reports the `claude` target as `stale` and exits 1

### Requirement: Guide over MCP
The `mcp` server SHALL send, as its server `instructions`, a summary of the
agent guide of at most 2000 characters that ends by naming the resource
`agentboard://guide`, and SHALL expose the full output of
`agentboard help agents` as that resource with MIME type `text/plain`. It
SHALL also expose each role's checklist, the output of
`agentboard help agents --role <role>`, as `agentboard://guide/<role>`,
because `help` is not an MCP tool. Reading any other URI SHALL fail with the
MCP InvalidParams error the SDK uses for an unknown resource.

#### Scenario: Client reads the guide
- **WHEN** an MCP client reads the resource `agentboard://guide`
- **THEN** its text is identical to the stdout of `agentboard help agents` for the same version

### Requirement: Managed MCP entry
An `mcpServers.agentboard` entry in `.mcp.json` SHALL be a managed entry
when it is exactly the default `npx` entry, or exactly
`{"command": <non-empty string>, "args": ["mcp"]}` with no other keys.
`agents install` SHALL leave an existing managed entry unchanged when
`--mcp-command` is not given, SHALL leave it unchanged when it already runs
the given executable, and SHALL replace it with the requested entry,
without `--force`, when `--mcp-command` names a different executable.
`agents check` SHALL report a managed entry of either shape as `current`
and any other entry as `modified`; `installedVersion` stays null for this
target.

#### Scenario: Reinstall keeps a local command
- **WHEN** `.mcp.json` has `mcpServers.agentboard` equal to `{"command": "agentboard", "args": ["mcp"]}` and `agentboard agents install --target mcp-json` runs without `--mcp-command`
- **THEN** the file is unchanged, the target is reported unchanged, and `agents check` reports it `current`

#### Scenario: Switching the command
- **WHEN** `.mcp.json` has the default `npx` entry and `agentboard agents install --mcp-command /opt/agentboard/bin/agentboard` runs
- **THEN** the entry becomes `{"command": "/opt/agentboard/bin/agentboard", "args": ["mcp"]}` and the target is reported updated, without `--force`

#### Scenario: Unrecognised entry is still refused
- **WHEN** `mcpServers.agentboard` is `{"command": "agentboard", "args": ["mcp"], "env": {"X": "1"}}` and `agentboard agents install --mcp-command agentboard` runs
- **THEN** the target is refused as `entry-differs`, the file is unchanged, and the command exits 1

### Requirement: Mutex ticket recipe
The guide section `Mutex tickets` SHALL describe, with commands that
parse against the registry:
- what a mutex ticket is: one standing ad hoc ticket per lock, never
  closed while the lock is in use;
- acquiring: `claim <id> --ttl <duration>`, then `renew <id>` as the first
  action of real work (an unconfirmed claim lapses after the grace
  period), with a ttl longer than the critical section, renewing at about
  half the ttl and immediately before the critical step, and stopping if
  `renew` fails with `not-assignee` (the lock was lost);
- releasing with `release` when done, including on failure;
- worker rules: never wait on a mutex in a loop and never claim from a
  background process; either wait in the foreground with
  `claim <id> --ttl <duration> --wait --timeout <duration>` (CLI only) and
  renew on return, or report ready (a comment or a hand-off to the
  orchestrator) and stop; over MCP, `board_claim` with `wait` only joins
  the queue, and the grant arrives in `board_inbox`;
- orchestrator rules: for merge-style mutexes where agents cannot block,
  act as the single queue runner, dispatching one holder at a time and
  dispatching the next only when the ticket is released or its holder's
  lease lapses; set `queue.window` and `lease.grace` with `config set`
  when the defaults do not fit; handle stale holds by waiting for the
  lease to lapse, or with `release --force --reason` after checking the
  holder is gone, never by impersonating the holder with `--as`;
- that across machines the lock is only as strong as `sync` (sync before
  claiming and before the critical step), while within one machine it is
  exact;
- a wait that ends without a grant: exit 4 `wait-timeout` or
  `wait-interrupted` means the actor does not hold the ticket, so it does
  not run the critical step, and retries the wait or reports;
- over MCP, the grantee accepts a grant by calling `board_renew` within the
  accept window, or the grant passes on to the next waiter.

The section SHALL follow `Tickets and planning tasks` and precede `Using
the MCP tools`, and its command lines SHALL pass `--as`. Read with line
breaks as spaces and ignoring case, it SHALL contain these phrases:
`standing`, `ad hoc`, `never close` (as in never closed), `first action of
real work`, `grace period`, `longer than the critical section`, `half the
ttl`, `before the critical step`, `not-assignee`, `on failure`, `never wait
on a mutex in a loop`, `background process`, `foreground`, `CLI only`,
`report ready`, `only joins the queue`, `board_claim`, `board_inbox`,
`queue runner`, `one holder at a time`, `lapse`, `queue.window`,
`lease.grace`, `impersonat` (as in never by impersonating the holder),
`sync`, `before claiming`, `exact`, `wait-timeout`, `wait-interrupted`,
`do not hold`, `do not run the critical step`, `retry`, `report`,
`board_renew`, `accept window` and `passes on`. The worker step of the test-author,
implementer and reviewer checklists SHALL contain `mutex`, `in a loop`,
`background process` and `report ready`; the queue-runner step of the
orchestrator checklist SHALL contain `mutex`, `queue runner` and `one
holder at a time`.

The installed `claude` and `agents-md` guidance SHALL contain a short form
of the recipe (the worker rules, the claim, renew, wait and release
commands, and the pointer to `agentboard help agents`), the MCP server
`instructions` summary SHALL contain the worker rules in one or two
sentences while staying within 2000 characters, and the guidance version
SHALL be 3, so `agents check` reports version 2 installations as `stale`.
In `SKILL.md` the short form is a section headed `## Mutex tickets` after
the rules and before `## Everything else`; in the AGENTS.md block it is a
paragraph introduced by the line `Mutex tickets:` after the rules and
before the pointer to the full guide. Both contain, with line breaks as
spaces and ignoring case, `never wait on a mutex in a loop`, `background
process`, `report ready`, `first action of real work`, `only joins the
queue` and `board_inbox`, and in backticks a `claim` with `--ttl`, a
`renew`, a `claim` with `--ttl`, `--wait` and `--timeout`, and a
`release`, each passing `--as`. The skill stays at most 45 lines and the
block at most 40. The summary contains `never wait on a mutex`, `in a
loop`, `background process`, `only joins the queue`, `board_renew`,
`accept window` and `passes on`. The installed short forms also contain
`board_renew`.

#### Scenario: Mutex lines in every role checklist
- **WHEN** `agentboard help agents --role <role>` runs for each role
- **THEN** the test-author, implementer and reviewer checklists each have a step with the worker rules, and the orchestrator checklist a step saying to act as the queue runner of a mutex, dispatching one holder at a time

#### Scenario: Recipe commands parse
- **WHEN** every line beginning with `agentboard ` in the mutex section is parsed against the registry
- **THEN** each parses, and the section includes `claim` with `--ttl`, `renew`, `claim` with `--wait` and `--timeout`, `release`, `release` with `--force` and `--reason`, and `config set`

#### Scenario: Installed skill carries the recipe
- **WHEN** `agentboard agents install --target claude` runs with guidance version 3
- **THEN** `SKILL.md` contains a `Mutex tickets` section with the worker rules and the claim, renew, wait and release commands, and the version 3 marker

#### Scenario: MCP instructions carry the worker rule
- **WHEN** an MCP client connects to `agentboard mcp`
- **THEN** the server instructions say never to wait on a mutex in a loop or claim from a background process, and are at most 2000 characters

#### Scenario: Version 2 installs are stale
- **WHEN** `agents check` runs where the skill was installed with guidance version 2
- **THEN** it reports the `claude` target as `stale` and exits 1
