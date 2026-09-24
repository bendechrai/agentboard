# Design

## Context

`add-board-core` defines a command registry (`src/cli/registry.ts`) that
describes every command once and drives both the CLI parser and the MCP
tool definitions. This change adds help and agent guidance on top of that
registry and adds installers that write short pointers into a host
project. See proposal.md for motivation.

## Goals / Non-Goals

**Goals:**
- An agent with no prior knowledge can go from `agentboard --help` to
  correct protocol use without reading this repository.
- Nothing an agent reads can drift from what the running CLI accepts.
- Installed host-project files are small, idempotent to reinstall, never
  clobber user-written content, and detectably stale.

**Non-Goals:**
- Man pages, shell completion, localized text.
- A Spec Kit adapter (separate change).

## Decisions

### Help is rendered from the registry
Help text for a command is built from its registry entry: synopsis,
summary, each positional and flag with type, required or optional, and
description, the exit codes it can produce, and one example. The registry
entry gains `description`, `examples` and `exitCodes` fields for this. No
command has hand-written help, so a flag cannot be added without appearing
in help.

### The guide is code, tested against the registry
The agent guide is a template in `src/guidance/guide.ts`. A test extracts
every line of the guide that starts with `agentboard ` and parses it with
the real argument parser, failing on any unknown command or flag. This is
the drift guard: renaming a flag breaks the build until the guide is fixed.

### Installed text is a pointer, not a copy
The skill and `AGENTS.md` block state when to use the board and the five
rules an agent must never break, then tell the agent to run
`agentboard help agents` for the rest. Copying the full guide into the host
project would go stale on every CLI upgrade. Each installed artifact
carries a guidance format version (an integer, `GUIDANCE_VERSION`, bumped
only when installed text changes, not on every package release), which is
what `agents check` compares.

### Ownership markers
- `.claude/skills/agentboard/SKILL.md` is owned whole by agentboard and
  carries the marker comment `<!-- agentboard-guidance: v<N> -->`. A file at
  that path without the marker is user content and is never overwritten
  without `--force`.
- `AGENTS.md` is shared: agentboard owns only the text between
  `<!-- agentboard:start v<N> -->` and `<!-- agentboard:end -->`.
- `openspec/config.yaml`: agentboard owns only `guidance` list entries
  under `operations.apply` and `operations.archive` whose text begins with
  `agentboard:`. Editing uses the `yaml` package's Document API, which
  preserves comments, key order and unrelated formatting. A hand-rolled
  line editor was considered and rejected: the file is user-edited YAML
  with comments, and a wrong edit there breaks the user's OpenSpec setup.
- `.mcp.json`: agentboard owns only the `mcpServers.agentboard` key.

### Where files are written
Installers write under the root of the current working tree
(`git rev-parse --show-toplevel`, or the current directory outside git),
not under the main checkout that holds `.board`. The files are normal
project changes that belong on the branch the agent is working on.

### Auto-detection
With no `--target`, `agents install` selects `claude` when `.claude/`
exists, `agents-md` when `AGENTS.md` exists, and `openspec` when
`openspec/config.yaml` exists, and says which it chose and why. `mcp-json`
is never auto-selected, because registering a server changes what every
session in the project loads.

## Risks / Trade-offs

- [OpenSpec changes its config schema] -> the installer only touches
  `operations.<op>.guidance`; if the key path has a non-list value it
  refuses with exit 1 and prints the lines to add by hand.
- [Guide grows until agents skim it] -> the guide is capped at 150 lines
  by a test; role detail goes in `help agents --role <role>`.
- [Two agents install concurrently in different worktrees] -> each writes
  its own working tree; merging identical managed blocks is a no-op.
