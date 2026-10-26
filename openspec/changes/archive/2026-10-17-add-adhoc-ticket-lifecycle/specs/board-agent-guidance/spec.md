## MODIFIED Requirements

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
create an issue, task file or task reference only to satisfy a move); and
using the MCP tools instead of the shell when they
are available. `agentboard help agents --role <role>` SHALL print the guide
followed by a checklist for that role, where role is one of
`orchestrator`, `test-author`, `implementer` or `reviewer`; the
orchestrator checklist SHALL say to give the scope disposition of an ad hoc
ticket when merging or closing it. Every line of
guide output that begins with `agentboard ` SHALL parse successfully
against the command registry. The guide SHALL NOT say that an ad hoc
ticket cannot enter `implementing`, and SHALL NOT name `needs-task-link`.

#### Scenario: Guide examples are valid commands
- **WHEN** every line beginning with `agentboard ` is extracted from the output of `help agents` and of `help agents --role` for each role and parsed against the registry
- **THEN** every line parses without an unknown command or flag error

#### Scenario: Unknown role
- **WHEN** `agentboard help agents --role tester` runs
- **THEN** it exits 1 and lists the four valid roles

#### Scenario: Guide explains ad hoc tickets
- **WHEN** `agentboard help agents` runs
- **THEN** its tickets and planning tasks section says an ad hoc ticket is worked normally, shows a `move <id> merged` line with `--unplanned` that parses, names `--task`, says never to create an issue, task file or task reference only to move a ticket, lists `needs-scope-disposition` and `already-linked` among the exit 4 reasons, does not contain `needs-task-link`, and every output (with and without `--role`) is at most 180 lines

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
- **THEN** each has a non-empty hint template, `needs-scope-disposition` and `already-linked` are in the set, and `needs-task-link` is not

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
- **WHEN** `agentboard agents install --target claude --target agents-md` runs with the guidance version of this change
- **THEN** `SKILL.md` and the `AGENTS.md` block each state the ad hoc rule, contain no text saying an ad hoc ticket cannot enter `implementing`, carry a guidance version one higher than before this change, and `agents check` reports installations of the earlier version as `stale`
