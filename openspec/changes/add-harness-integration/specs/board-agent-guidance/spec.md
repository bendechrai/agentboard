## MODIFIED Requirements

### Requirement: Help is not an MCP tool
The `help`, `agents install`, `agents check` and `hook` commands SHALL be excluded
from the MCP server's tools, like the other setup commands: MCP clients
receive the agent guide through the server's `instructions` and the
`agentboard://guide` resource instead, and installing guidance writes files
into the host project, which a tool call from any agent must not do.

#### Scenario: No board_help tool
- **WHEN** an MCP client lists the tools of `agentboard mcp`
- **THEN** no tool named `board_help` is listed

### Requirement: Installing guidance into a host project
`agentboard agents install [--target <t>]... [--command <executable>]
[--hooks-strict] [--global] [--force]` SHALL write agent
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
  running `npx -y @bendechrai/agentboard mcp`, or, when `--command
  <executable>` is given, `{"command": "<executable>", "args": ["mcp"]}`;
- `claude-hooks`: the Claude Code hooks of board-harness-hooks, in
  `.claude/settings.json`;
- `codex`: the `AGENTS.md` block, shared with `agents-md`, plus the exact
  `codex mcp add` command for the MCP server printed on stdout; with
  `--global`, also a marked MCP block in Codex's global `config.toml`
  (`$CODEX_HOME/config.toml`, default `~/.codex/config.toml`);
- `cursor`: `.cursor/rules/agentboard.mdc`, an always-applied Cursor rule,
  and an `agentboard` entry under `mcpServers` in `.cursor/mcp.json`;
- `antigravity`: the `AGENTS.md` block, shared with `agents-md` (the
  Antigravity CLI `agy` reads `AGENTS.md` or `GEMINI.md` workspace rules), plus
  the exact `agy mcp add` command printed on stdout; with `--global`, also an
  `agentboard` entry in Antigravity's global MCP config
  (`~/.gemini/config/mcp_config.json`);
- `copilot`: a managed block in `.github/copilot-instructions.md`, created
  if absent.
The MCP entries of `codex`, `cursor` and `antigravity` follow "Harness MCP
entries" and "Global harness config is never edited by default".
The `claude`, `agents-md`, `cursor` and `copilot` text SHALL state the rules an agent must never
break (always pass an actor; claim before working; hand off or block with a
comment before stopping; never mark completion on the board instead of in
the tasks file; promote `DECISION:` comments before closing) and SHALL
direct the agent to `agentboard help agents` for everything else. With no
`--target`, the command SHALL select `claude` when
`.claude/` exists, `agents-md` when `AGENTS.md` exists, `openspec` when
`openspec/config.yaml` exists, `codex` when `.codex/` exists, `cursor` when
`.cursor/` exists, `antigravity` when `.agents/` exists and
`copilot` when `.github/copilot-instructions.md` exists, SHALL never
auto-select `mcp-json` or `claude-hooks` (hooks are opt-in with `--target
claude-hooks`), and SHALL report each selected target and the
reason. When nothing is selected and stdin and stdout are both terminals
(and `--json` is not given), it SHALL list the targets numbered and ask
which to create, as a comma-separated list of numbers or names; an empty
answer or an unknown token SHALL exit 1 listing the targets and write
nothing, and each chosen target is reported as selected by the prompt.
When nothing is selected and the session is not interactive it SHALL exit 1
listing the targets, as before. `--hooks-strict` SHALL write the hooks in
strict mode (see board-harness-hooks) and has no effect without
`claude-hooks`. Giving `--command` SHALL select the
`mcp-json` target in addition to the explicit or auto-detected ones, and
the output SHALL name `--command` as the reason. `--mcp-command <executable>` SHALL remain a deprecated alias of
`--command`, behaving identically and printing a one-line deprecation notice
on stderr. `--command` sets the executable for every MCP entry and for the
hooks. An empty
`--command` value or one containing a newline SHALL exit 1 with reason
`usage` and write nothing. The command SHALL NOT require a board and
SHALL NOT run git commands that modify anything. `init` SHALL end its
output with a line suggesting `agentboard agents install`.

#### Scenario: Install the Claude skill
- **WHEN** `agentboard agents install --target claude` runs in a project with no `.claude/skills/agentboard`
- **THEN** `.claude/skills/agentboard/SKILL.md` exists with frontmatter name `agentboard`, the five rules, the text `agentboard help agents`, and the guidance version marker

#### Scenario: Auto-detection
- **WHEN** `agentboard agents install` runs in a project that has `.claude/` and `openspec/config.yaml` but no `AGENTS.md`
- **THEN** the `claude` and `openspec` targets are installed, `agents-md` and `mcp-json` are not, and the output names each selected target and why

#### Scenario: Bare project on a terminal
- **WHEN** `agentboard agents install` runs on a terminal in a project with no `.claude/`, `AGENTS.md`, `openspec/config.yaml` or other detected target, and the answer is `1,3`
- **THEN** exactly the first and third listed targets are installed and the output names the prompt as the reason

#### Scenario: Bare project, empty answer
- **WHEN** the same command runs and the answer is empty
- **THEN** nothing is written and it exits 1 listing the targets

#### Scenario: Bare project without a terminal
- **WHEN** the same command runs with stdin from `/dev/null`
- **THEN** it does not prompt, exits 1 listing the targets, and writes nothing

#### Scenario: Hooks are opt-in
- **WHEN** `agentboard agents install` runs in a project that has `.claude/`
- **THEN** `claude` is installed and `claude-hooks` is not, and `.claude/settings.json` is not created or modified

#### Scenario: Deprecated alias
- **WHEN** `agentboard agents install --mcp-command agentboard` runs
- **THEN** the result is identical to `--command agentboard` and stderr has a deprecation line naming `--command`

#### Scenario: Reinstall is idempotent
- **WHEN** `agents install` runs twice with the same targets and version
- **THEN** the second run changes no file byte and reports each target as up to date

#### Scenario: Local MCP command
- **WHEN** `agentboard agents install --command agentboard` runs in a project with no `.mcp.json`
- **THEN** `.mcp.json` contains `mcpServers.agentboard` equal to `{"command": "agentboard", "args": ["mcp"]}` and the output names `mcp-json` as selected by `--command`

### Requirement: Installed guidance never clobbers user content
Each target SHALL own only its marked region: the whole of `SKILL.md` only
when it carries the `<!-- agentboard-guidance: v<N> -->` marker; the text
between `<!-- agentboard:start v<N> -->` and `<!-- agentboard:end -->` in
`AGENTS.md`; `guidance` list entries beginning with `agentboard:` in
`openspec/config.yaml`; the `mcpServers.agentboard` key in `.mcp.json` and `.cursor/mcp.json`, and with
`--global` in `~/.gemini/config/mcp_config.json`; hook entries of `.claude/settings.json` whose
command ends with `# agentboard-hooks: v<N>`; the text between
`# agentboard:start v<N>` and `# agentboard:end` in Codex's global
`config.toml` (with `--global` only); the
whole of `.cursor/rules/agentboard.mdc` only when it carries the
`<!-- agentboard-guidance: v<N> -->` marker; and the same `AGENTS.md`
markers in `.github/copilot-instructions.md`.
In every markdown, TOML and text file, everything outside the owned region SHALL be
preserved byte for byte. In `openspec/config.yaml` and every JSON file, which
are rewritten through a YAML or JSON serializer, every key, value, entry,
comment and their order outside the owned entries SHALL be preserved, while
insignificant formatting (indentation, quoting style) MAY be normalized. A `SKILL.md` or `agentboard.mdc` at the target path without the marker, a
malformed marker pair in `AGENTS.md`, the copilot file or
`config.toml`, a `[mcp_servers.agentboard]` table in `config.toml` outside
the markers, a `.claude/settings.json` that is not valid JSON or whose
`hooks` value has an unexpected shape, a non-list value at a `guidance` key,
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

#### Scenario: Existing settings and hooks survive
- **WHEN** `.claude/settings.json` has `permissions` and a user `PreToolUse` hook and `agents install --target claude-hooks` runs
- **THEN** the file keeps every key and the user hook in order and gains only the agentboard hook entries

#### Scenario: Foreign Codex table is refused
- **WHEN** the global `config.toml` (in a scratch `CODEX_HOME`) already has a hand-written `[mcp_servers.agentboard]` table outside the markers
- **THEN** `agents install --target codex --global` exits 1 naming the file, leaves it unchanged and still processes other targets

#### Scenario: Foreign Cursor rule is refused
- **WHEN** `.cursor/rules/agentboard.mdc` exists without the marker
- **THEN** `agents install --target cursor` refuses that file, and with `--force` replaces it

#### Scenario: Foreign skill file is not overwritten
- **WHEN** `.claude/skills/agentboard/SKILL.md` exists without the agentboard marker
- **THEN** `agents install --target claude` exits 1 naming the file and leaves it unchanged

### Requirement: Checking installed guidance
`agentboard agents check` SHALL inspect every target, including
`claude-hooks`, `codex`, `cursor`, `antigravity` and `copilot`, that has an
agentboard marker or managed entry in the current working tree and report
each as `current`, `stale` (installed with a different guidance version) or
`modified` (the managed text differs from what its recorded version renders,
or its version or markers cannot be read). It SHALL exit 0 when
all found targets are current, and 1 otherwise, so it can run in a
project's own checks. With `--json` it SHALL print an array of
`{target, path, state, installedVersion, currentVersion}`.

#### Scenario: Hand-edited hook is modified
- **WHEN** an installed agentboard hook command in `.claude/settings.json` is edited but keeps its marker
- **THEN** `agents check` reports `claude-hooks` as `modified` and exits 1

#### Scenario: Missing hook is modified
- **WHEN** the `Stop` agentboard hook is deleted but the other two remain
- **THEN** `agents check` reports `claude-hooks` as `modified`

#### Scenario: Stale skill after upgrade
- **WHEN** the skill was installed with guidance version 1 and the running CLI has guidance version 2
- **THEN** `agents check` reports the `claude` target as `stale` and exits 1

## ADDED Requirements

### Requirement: Global harness config is never edited by default
The MCP configuration of `codex` (`$CODEX_HOME/config.toml`) and
`antigravity` (`~/.gemini/config/mcp_config.json`) is global to the user,
not to the project. `agents install` SHALL NOT read or write either file
unless `--global` is given together with an explicit `--target codex` or
`--target antigravity`; `--global` with those targets chosen by
auto-detection or by the prompt, or without either target, SHALL exit 1
with reason `usage` and write nothing. Without `--global` these targets SHALL
print the exact command that registers the server (`codex mcp add agentboard
-- <command> mcp` or `agy mcp add agentboard <command> mcp`, with the
`--command` executable or `npx -y @bendechrai/agentboard`) and write only
their project files. With `--global`, the edit SHALL follow the marker,
refusal, `--force` and `check` rules of the other targets, and SHALL NOT
alter any other entry or key of the global file. `agents check --global`
SHALL also inspect these files; plain `agents check` SHALL NOT read them.

#### Scenario: Default prints the command
- **WHEN** `agents install --target codex --target antigravity` runs with a scratch `HOME` and `CODEX_HOME`
- **THEN** stdout contains the `codex mcp add` and `agy mcp add` commands, and neither global file exists afterwards

#### Scenario: Global edit is explicit
- **WHEN** `agents install --target codex --global` runs with a scratch `CODEX_HOME` holding other MCP servers
- **THEN** only the marked agentboard block is added and every other byte is unchanged

#### Scenario: Global needs an explicit target
- **WHEN** `agents install --global` runs with no `--target`
- **THEN** it exits 1 with reason `usage` and writes nothing

#### Scenario: Antigravity global entry
- **WHEN** `agents install --target antigravity --global` runs with a scratch `HOME` and `agy mcp list` is then run with the same `HOME`
- **THEN** `agentboard` is listed, and a pre-existing unmanaged `agentboard` entry is refused as `entry-differs` without `--force`

### Requirement: Antigravity rules stay within size limits
The `AGENTS.md` block written for `antigravity` is the same block as for
`agents-md`, and SHALL be at most 4096 bytes (the Antigravity CLI reads at
most 24 KB per rules file and 20000 tokens in aggregate). `agents check`
SHALL print a warning, without changing its exit code, when an `AGENTS.md`
at the project root is larger than 24 KB. A project-level Antigravity skills
or plugins registration is not written (see design.md).

#### Scenario: Block size
- **WHEN** the `AGENTS.md` block is rendered
- **THEN** it is at most 4096 bytes

#### Scenario: Oversized rules file warns
- **WHEN** `AGENTS.md` is 30 KB, including a current agentboard block, and `agents check` runs
- **THEN** it warns that Antigravity reads at most 24 KB per file, and the exit code is still 0

### Requirement: Harness MCP entries
The `agentboard` MCP entries written for `codex` (`[mcp_servers.agentboard]`
with `command` and `args`, global), `cursor` and `antigravity` (global) SHALL carry the same
command and args as the `.mcp.json` entry would (the default `npx` entry,
or `--command`), SHALL be managed under the rules of "Managed MCP
entry", and `--command` SHALL update them without `--force`. An
unmanaged entry SHALL be refused as `entry-differs`. `agents check` SHALL
report them like the `.mcp.json` entry.

#### Scenario: Local command reaches every harness
- **WHEN** `agentboard agents install --target cursor --command agentboard` runs, and the printed `codex mcp add` and `agy mcp add` commands are inspected
- **THEN** the cursor entry and both printed commands run `agentboard` with args `mcp`

#### Scenario: Unmanaged Cursor entry is refused
- **WHEN** `.cursor/mcp.json` has `mcpServers.agentboard` with an extra `env` key
- **THEN** the `cursor` target is refused as `entry-differs` and the file is unchanged

### Requirement: Harness targets are verified in a sandbox project
No harness target SHALL ship until its verification passes in a scratch
project: a temporary directory outside the repository, initialised as a git
repository, in which the built CLI is run for real. For each of
`claude-hooks`, `codex`, `cursor`, `antigravity` and `copilot` the
verification SHALL cover a fresh install, `agents check` reporting
`current`, a second install changing no byte, preservation of pre-existing
user content, refusal of foreign content without `--force`, and `stale` and
`modified` detection, and config-format validation of every written JSON,
TOML and mdc file. The suite SHALL also determine, and record in the target's
test, whether Codex reads `AGENTS.md`.

#### Scenario: Sandbox install and check
- **WHEN** the sandbox suite installs each target into a fresh temporary project
- **THEN** every expected file exists, `agents check --json` lists each target `current`, and the temporary project is removed afterwards

#### Scenario: Sandbox idempotency
- **WHEN** the sandbox suite installs a second time
- **THEN** every file in the project is byte-identical to the first run's result

#### Scenario: Sandbox refusal
- **WHEN** the sandbox suite pre-creates a foreign file or key for each target
- **THEN** each target is refused without `--force`, its file is byte-identical afterwards, and `--force` replaces it

### Requirement: Harness tests never reach a model or a real home
No test run by `make check`, CI or the default test command SHALL make a
model request on any harness. Smoke tests SHALL use only commands that load
configuration and exit: `claude mcp list`, `codex mcp list`, `codex
--version`, `agy mcp list`, `agy --help`, `cursor-agent --help` or their
equivalents. A live model test SHALL exist only as a manual test behind an
explicit environment flag (`AGENTBOARD_LIVE_HARNESS`), with a short single
prompt per harness; a live `claude` smoke test is permitted by default
when the `claude` CLI is present, but `cursor-agent` (free plan, about 25
short headless runs, run with `--model auto`), `agy` (about 5 requests
before a week-long refresh) and `codex exec` SHALL run only behind the flag.
Every harness process SHALL run with `HOME` (and `CODEX_HOME`, `XDG_CONFIG_HOME`)
set to a directory inside the sandbox, and the suite SHALL fail when the
real `~/.codex`, `~/.gemini`, `~/.cursor` or `~/.claude` has a file whose
modification time or content hash changed during the run. Smoke tests for a
harness whose binary is missing (including the Copilot CLI, which has only
file-level tests) SHALL be reported `skipped (harness not installed)`, never
as passed.

#### Scenario: Default run makes no model call
- **WHEN** the default test command runs with the harness CLIs installed and the flag unset
- **THEN** no `codex exec`, no `agy -p` and no `cursor-agent` prompt is started, and `claude` is used only for a live smoke test if one is enabled

#### Scenario: Scratch home
- **WHEN** a smoke test runs `agy mcp list` or `codex mcp list`
- **THEN** its environment has `HOME` and `CODEX_HOME` inside the sandbox, and the real home config files are unchanged

#### Scenario: Write outside the sandbox fails the suite
- **WHEN** a test (or the code under test) modifies a file under the real `~/.codex`
- **THEN** the suite's guard fails the run and names the file

#### Scenario: Live tests are opt-in
- **WHEN** `AGENTBOARD_LIVE_HARNESS` is unset
- **THEN** the live tests for `cursor-agent`, `agy` and `codex exec` are skipped and reported as skipped

#### Scenario: Missing binary
- **WHEN** a harness binary is not on the path
- **THEN** its smoke tests are reported as skipped, not passed
