# Spec Delta

## Purpose

Defines how agentboard teaches agents to use it: help generated from the
command registry, the agent guide, error hints, guidance installed into a
host project for its agents and for OpenSpec, and guide delivery over MCP.

## ADDED Requirements

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
`agentboard help agents` SHALL print a plain ASCII guide of at most 150
lines, stamped with the package version, containing these sections: what
the board is and is not (not a secret store, not the record of completion);
the actor rule; finding work (`inbox`, `list`); claiming before starting;
handing off and moving to `blocked` with a comment; the `DECISION:`
convention and why `close` needs a decision disposition; how tickets map to
planning tasks, including the OpenSpec flow (`import-change` after
proposing, claim the group's ticket before applying, tick `tasks.md` in the
implementing PR); and using the MCP tools instead of the shell when they
are available. `agentboard help agents --role <role>` SHALL print the guide
followed by a checklist for that role, where role is one of
`orchestrator`, `test-author`, `implementer` or `reviewer`. Every line of
guide output that begins with `agentboard ` SHALL parse successfully
against the command registry.

#### Scenario: Guide examples are valid commands
- **WHEN** every line beginning with `agentboard ` is extracted from the output of `help agents` and of `help agents --role` for each role and parsed against the registry
- **THEN** every line parses without an unknown command or flag error

#### Scenario: Unknown role
- **WHEN** `agentboard help agents --role tester` runs
- **THEN** it exits 1 and lists the four valid roles

### Requirement: Error hints
Every exit 1 and exit 4 refusal SHALL include a hint naming a command that
moves the caller forward: for example `already-assigned` hints
`agentboard show <id>` and `agentboard inbox --as <actor>`; a missing actor
hints both `--as` and `AGENTBOARD_ACTOR`; `needs-task-link` hints
`agentboard link <id> --task <source>:<ref>#<item> --as <actor>`; a close
refused by the decision rule hints `--decision-recorded-in <path>`. The CLI
SHALL print the hint on stderr on a line beginning `hint: `. MCP tool errors
SHALL carry it as a `hint` field alongside `exitCode`, `reason` and
`message`. Every rejection reason defined by the board SHALL have a hint.

#### Scenario: Claim race loser is told what to do
- **WHEN** `agentboard claim T1 --as reviewer` fails because `impl` holds T1
- **THEN** stderr contains a `hint: ` line naming `agentboard inbox --as reviewer`

#### Scenario: No reason without a hint
- **WHEN** the set of rejection reasons is enumerated from the source
- **THEN** each has a non-empty hint template

### Requirement: Installing guidance into a host project
`agentboard agents install [--target <t>]... [--force]` SHALL write agent
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
  running `npx -y @bendechrai/agentboard mcp`.
The `claude` and `agents-md` text SHALL state the rules an agent must never
break (always pass an actor; claim before working; hand off or block with a
comment before stopping; never mark completion on the board instead of in
the tasks file; promote `DECISION:` comments before closing) and SHALL
direct the agent to `agentboard help agents` for everything else. With no
`--target`, the command SHALL select `claude` when `.claude/` exists,
`agents-md` when `AGENTS.md` exists and `openspec` when
`openspec/config.yaml` exists, SHALL never auto-select `mcp-json`, and SHALL
report each selected target and the reason; when nothing is selected it
SHALL exit 1 listing the targets. The command SHALL NOT require a board and
SHALL NOT run git commands that modify anything. `init` SHALL end its
output with a line suggesting `agentboard agents install`.

#### Scenario: Install the Claude skill
- **WHEN** `agentboard agents install --target claude` runs in a project with no `.claude/skills/agentboard`
- **THEN** `.claude/skills/agentboard/SKILL.md` exists with frontmatter name `agentboard`, the five rules, the text `agentboard help agents`, and the guidance version marker

#### Scenario: Auto-detection
- **WHEN** `agentboard agents install` runs in a project that has `.claude/` and `openspec/config.yaml` but no `AGENTS.md`
- **THEN** the `claude` and `openspec` targets are installed, `agents-md` and `mcp-json` are not, and the output names each selected target and why

#### Scenario: Reinstall is idempotent
- **WHEN** `agents install` runs twice with the same targets and version
- **THEN** the second run changes no file byte and reports each target as up to date

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
or an existing `mcpServers.agentboard` entry that differs from the managed
one SHALL cause that target to be refused with exit 1 and a message naming
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
each as `current`, `stale` (older guidance version or differing managed
text) or `modified` (managed region edited by hand). It SHALL exit 0 when
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
`agentboard help agents` as that resource with MIME type `text/plain`.

#### Scenario: Client reads the guide
- **WHEN** an MCP client reads the resource `agentboard://guide`
- **THEN** its text is identical to the stdout of `agentboard help agents` for the same version
