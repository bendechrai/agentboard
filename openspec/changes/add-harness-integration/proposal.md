# Proposal

## Why

`agents install` today writes guidance that an agent may or may not
follow, for three harnesses (Claude Code, anything that reads `AGENTS.md`,
and `.mcp.json` clients). Guidance is advisory: agents forget to check the
inbox, edit without claiming and stop without a handoff. Claude Code can
enforce the loop through hooks, and Codex, Cursor, Gemini CLI and Copilot
each have their own instruction and MCP files that agentboard does not
write. A new user in a bare project also gets a bare failure from `agents
install`, and `init` only prints a hint.

## What Changes

- New `agentboard hook <event>` command (`session-start`, `stop`,
  `pre-tool-use`) with a fail-open, read-only, time-boxed contract. It is
  warn-only by default; `--strict` blocks.
- New `agents install` targets: `claude-hooks` (merged non-destructively into
  `.claude/settings.json`, marked, checked by `agents check`), `codex`
  (`.codex/config.toml` MCP block), `cursor` (`.cursor/rules/agentboard.mdc`
  and `.cursor/mcp.json`), `gemini` (`GEMINI.md` block and
  `.gemini/settings.json` MCP entry) and `copilot`
  (`.github/copilot-instructions.md` block), all with the existing marker,
  refuse-unless-`--force` and `check` semantics. New flag `--hooks-strict`.
- In a bare project, `agents install` prompts for targets on a terminal;
  non-interactive runs keep the no-targets failure.
- `init` offers to run `agents install` on a terminal, with `--agents` and
  `--no-agents` for scripts; otherwise it prints the hint as now.
- A verification requirement: every target is exercised in a scratch
  project (install, check, idempotency, refusal, and a harness smoke test
  where the harness CLI exists) before it ships.
- **BREAKING (minor, pre-1.0):** auto-detection with `.claude/` now also
  installs `claude-hooks`, which makes `agents install` modify
  `.claude/settings.json`. Hooks are warn-only unless `--hooks-strict`.

## Capabilities

### New Capabilities
- `board-harness-hooks`: the `hook` command contract, actor resolution, each
  event's behavior, and the hooks written into Claude settings.

### Modified Capabilities
- `board-agent-guidance`: new install targets, bare-project prompt,
  non-clobbering rules and `check` for them, harness MCP entries, the
  sandbox verification requirement, `hook` excluded from MCP.
- `board-cli`: command surface (`hook`, `init` flags), the `hook` exit-code
  exception, `hook` excluded from MCP, and `init` offering the install.

## Impact

- Code: `src/guidance/install.ts`, `check.ts`, `markers.ts`,
  `installed-text.ts`, a new hook module under `src/board/` or
  `src/guidance/`, `src/cli/registry.ts`, `src/board/init.ts`, a small TTY
  prompt helper.
- Tests: a sandbox suite creating temporary projects per target.
- Docs: README (install section, hooks, the risks), the agent guide, STATUS.md.
- No schema or event changes; no new runtime dependency (a TOML parser is not
  needed, see design.md).
- Overlaps `add-claim-leases` and its known gap (STATUS.md): both restate
  `board-cli` "Command surface" and "MCP server". Whichever is archived
  second re-syncs that text.
- Out of scope: the release workflow (already landed in #66 as
  `.github/workflows/release.yml`; any prepack build script is a separate
  follow-up), VS Code `.vscode/mcp.json`, user-level (global) harness config.
