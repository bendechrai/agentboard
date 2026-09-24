# Design

## Context

The `mcp-json` target owns the `mcpServers.agentboard` key of `.mcp.json`.
It has no version marker (JSON has no comments), so `agents check` decides
`current` or `modified` by comparing the entry with the one the installer
would write. Today that is a single fixed entry, the `npx` one.

## Decisions

### The flag names an executable, not a command line
`--mcp-command` takes one executable (a name on the PATH or an absolute
path) and the arguments are always `["mcp"]`. Accepting a whole command
line would need quoting rules to split it into `command` and `args`, and a
path containing spaces would then be ambiguous. Every realistic local setup
(`npm link`, a global install, a wrapper script) exposes an executable that
takes `mcp` as its first argument. The value must be non-empty and must not
contain a newline; it is written as given, never resolved or checked for
existence, because `.mcp.json` is read on other machines too.

### Two managed shapes, both recognised
The managed entry is either the default `npx` entry or `{command: <any
non-empty string>, args: ["mcp"]}` with no other keys. Recognising both
means a project that chose a local command is not dragged back to `npx` by
a later `agents install` run, and `agents check` can run in CI for projects
using either. The key `mcpServers.agentboard` is already agentboard's, so
treating any `["mcp"]` entry under it as managed takes nothing from the
user that the existing ownership rule does not.

### Reinstall rules
- No existing entry: write the requested shape (`npx` by default).
- Existing managed entry, no `--mcp-command`: leave it unchanged.
- Existing managed entry, `--mcp-command X`: unchanged if it already runs
  `X`, otherwise updated to `X` (no `--force` needed, it is agentboard's).
- Existing unrecognised entry: refused as `entry-differs` unless `--force`.

### Alternatives considered
- Auto-detecting a linked install (for example when the running binary is
  not inside an npm cache). Rejected: it is guesswork, and the file is
  shared with collaborators whose setup may differ.
- An `AGENTBOARD_MCP_COMMAND` environment variable. Rejected for now: a
  flag is explicit at the one moment the file is written; an environment
  default can be added later without changing the entry format.
