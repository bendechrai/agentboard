# Spec Delta

## MODIFIED Requirements

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
the tasks file; promote `DECISION:` comments before closing) and SHALL
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
- **THEN** `.claude/skills/agentboard/SKILL.md` exists with frontmatter name `agentboard`, the five rules, the text `agentboard help agents`, and the guidance version marker

#### Scenario: Auto-detection
- **WHEN** `agentboard agents install` runs in a project that has `.claude/` and `openspec/config.yaml` but no `AGENTS.md`
- **THEN** the `claude` and `openspec` targets are installed, `agents-md` and `mcp-json` are not, and the output names each selected target and why

#### Scenario: Reinstall is idempotent
- **WHEN** `agents install` runs twice with the same targets and version
- **THEN** the second run changes no file byte and reports each target as up to date

#### Scenario: Local MCP command
- **WHEN** `agentboard agents install --mcp-command agentboard` runs in a project with no `.mcp.json`
- **THEN** `.mcp.json` contains `mcpServers.agentboard` equal to `{"command": "agentboard", "args": ["mcp"]}` and the output names `mcp-json` as selected by `--mcp-command`

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

## ADDED Requirements

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
