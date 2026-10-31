# Proposal

## Why

`agents install` today writes guidance that an agent may or may not
follow, for three harnesses (Claude Code, anything that reads `AGENTS.md`,
and `.mcp.json` clients). Guidance is advisory: agents forget to check the
inbox, edit without claiming and stop without a handoff. Claude Code can
enforce the loop through hooks, and Codex, Cursor, the Antigravity CLI and Copilot
each have their own instruction and MCP files that agentboard does not
write. A new user in a bare project also gets a bare failure from `agents
install`, and `init` only prints a hint.

## What Changes

- New `agentboard hook <event>` command (`session-start`, `stop`,
  `pre-tool-use`) with a fail-open, read-only, time-boxed contract (it never
  catches up, so it writes no due grant). It is warn-only by default;
  `--strict` blocks. Its output respects leases and the mutex recipe.
- New `agents install` targets: `claude-hooks` (merged non-destructively into
  `.claude/settings.json`, marked, checked by `agents check`), `codex`
  and `antigravity` (the shared `AGENTS.md` block plus the exact `codex mcp
  add` / `agy mcp add` command; their MCP config is global, so it is edited
  only with `--target ... --global`), `cursor`
  (`.cursor/rules/agentboard.mdc` and `.cursor/mcp.json`) and `copilot`
  (`.github/copilot-instructions.md` block), all with the existing marker,
  refuse-unless-`--force` and `check` semantics, and every project
  guidance text carries the mutex short form. New flag `--hooks-strict`.
  `GUIDANCE_VERSION` stays 3: it is raised only when an existing
  target's installed text changes, and new targets install at the
  current version, so existing installs are not reported stale.
- In a bare project, `agents install` prompts for targets on a terminal;
  non-interactive runs keep the no-targets failure.
- `init` offers to run `agents install` on a terminal, with `--agents` and
  `--no-agents` for scripts; otherwise it prints the hint as now.
- A verification requirement: every target is exercised in a scratch
  project (install, check, idempotency, refusal, config validation) before it
  ships, with harness smoke tests limited to non-model commands, a scratch
  HOME, and live model tests only behind an opt-in flag.
- New neutral `--command <executable>` flag sets the executable for MCP
  entries and hooks; `--mcp-command` stays as a deprecated alias.
- `claude-hooks` is opt-in (`--target claude-hooks`), never auto-selected.

## Capabilities

### New Capabilities
- `board-harness-hooks`: the `hook` command contract, actor resolution, each
  event's behavior, and the hooks written into Claude settings.

### Modified Capabilities
- `board-agent-guidance`: new install targets, bare-project prompt,
  non-clobbering rules and `check` for them, harness MCP entries, the
  sandbox verification requirement, `hook` excluded from MCP, the rule for
  when the guidance version is raised, and the mutex short form in the `cursor` and `copilot` texts.
- `board-cli`: command surface (`hook`, `init` flags), the `hook` exit-code
  exception, `hook` excluded from MCP, `hook` excepted from writing due
  grants during catch-up, and `init` offering the install.

## Impact

- Code: `src/guidance/install.ts`, `check.ts`, `markers.ts`,
  `installed-text.ts`, a new hook module under `src/board/` or
  `src/guidance/`, `src/cli/registry.ts`, `src/board/init.ts`, a small TTY
  prompt helper.
- Tests: a sandbox suite creating temporary projects per target.
- Docs: README (install section, hooks, the risks), `help hook`, the
  agent guide's list of non-tool commands (no new line), STATUS.md.
- No schema or event changes; no new runtime dependency (a TOML parser is not
  needed, see design.md).
- Re-synced on 2026-10-31 with the main specs as of `a455011`, after the
  archives of `add-claim-leases`, `guard-stale-temporary`,
  `keep-cursors-on-upgrade` and `no-echo-refusals`; design.md "Re-sync
  with the main specs" lists what that forced.
- The agent guide gains no line: the orchestrator output is at its
  180-line limit (design.md decision 10).
- ADR 0016 (0014 and 0015 are taken).
- Out of scope: the release workflow (already landed in #66 as
  `.github/workflows/release.yml`; any prepack build script is a separate
  follow-up), VS Code `.vscode/mcp.json`, user-level (global) harness config.
