# Proposal

## Why

`agentboard agents install --target mcp-json` always writes an
`mcpServers.agentboard` entry that runs `npx -y @bendechrai/agentboard mcp`.
That only works once the package is published to npm. A user who runs
agentboard from a local build (`npm link`, or a checkout on the PATH) gets
an entry that fails at start-up, because `npx` resolves the package from
the registry, not from the global link. Today the workaround is to write
the entry by hand, after which `agents check` reports the `mcp-json` target
as `modified` forever and `agents install --target mcp-json` refuses it as
`entry-differs`.

## What Changes

- `agents install` gains `--mcp-command <executable>`. With it, the
  `mcp-json` target writes `{"command": "<executable>", "args": ["mcp"]}`
  (for example `--mcp-command agentboard` for a linked install) instead of
  the `npx` entry. Giving the flag selects the `mcp-json` target.
- An existing `mcpServers.agentboard` entry of either managed shape (the
  `npx` entry, or any executable with exactly `["mcp"]` as its arguments) is
  recognised as agentboard's own: `agents check` reports it `current`, and a
  reinstall without `--mcp-command` leaves it unchanged instead of refusing
  it or reverting it to `npx`. With `--mcp-command`, a managed entry naming a
  different executable is updated without `--force`.
- Entries of any other shape (extra keys such as `env`, other arguments)
  are still refused as `entry-differs` unless `--force` is given, as today.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `board-agent-guidance`: the `agents install` synopsis and target
  selection, what counts as the managed `.mcp.json` entry, and how
  `agents check` classifies it.

## Impact

- `src/guidance/install.ts`, `src/guidance/check.ts`,
  `src/guidance/installed-text.ts` and the `agents install` registry entry
  (flag, description, examples, exit codes); the help drift guard covers
  the new example.
- README.md: the MCP and "Installing agent guidance" sections, and the
  from-source install instructions, which can now recommend
  `agents install --mcp-command agentboard` after `npm link`.
- No new dependencies. No change to installed Markdown or OpenSpec text,
  so `GUIDANCE_VERSION` stays 1.
