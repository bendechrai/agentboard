# Design

## Context

`agents install` (src/guidance) owns marked regions in `SKILL.md`,
`AGENTS.md`, `openspec/config.yaml` and `.mcp.json`, refuses foreign
content unless `--force`, and `agents check` reports `current`, `stale` or
`modified`. Harness files differ in format (markdown, JSON, TOML, mdc) but
every one fits "marked block in text" or "owned key in JSON". Claude Code
hooks run a shell command on an event, pass JSON on stdin, and treat exit 0
as continue and exit 2 as block (stderr is fed back to the agent). See
proposal.md for motivation.

## Goals / Non-Goals

**Goals:** reuse the existing region, refusal and check machinery for every
new target; make hooks safe to leave on; make each target provably loadable.

**Non-Goals:** user-level config under `~`; enforcement for harnesses
without hooks; the release workflow; a general TOML library.

## Decisions

1. **One command, `hook <event>`, not shell snippets.** Logic lives in
   tested TypeScript behind the registry. Alternative: inline shell in
   settings.json; rejected as untestable and hard to version. The command
   is excluded from MCP and exempt from the usual exit codes (0 and 2 are the
   harness protocol; the usual 2 "board not found" would otherwise block).
2. **Hooks are warn-only by default; `--hooks-strict` is an explicit opt-in.**
   Warn output goes to the agent as context (`session-start`, `pre-tool-use`)
   or to the user as a `systemMessage` (`stop`).
3. **Fail open and be fast.** Hook mode is read-only, never syncs, has a 2
   second internal deadline and a settings `timeout` of 5 seconds, and
   treats every error as "allow". A hook that cannot do its job must be
   invisible rather than a reason the agent cannot edit.
4. **Ownership marker for hooks is a shell comment** (`# agentboard-hooks:
   v<N>`) at the end of each command string, since JSON has no comments. The
   whole entry is owned if its command ends with the marker; `check` renders
   the three expected commands for the recorded version and mode and
   compares.
5. **Global MCP config is never edited by default.** Codex
   (`$CODEX_HOME/config.toml`) and Antigravity (`~/.gemini/config/mcp_config.json`)
   keep MCP servers in the user's global config, shared by all projects.
   `agents install` prints the exact `codex mcp add` / `agy mcp add` command
   instead, and edits the file only for an explicit `--target` with `--global`.
   Alternative: write it silently; rejected as surprising and unsafe.
   Under `--global`, Codex's `config.toml` gets a block between `# agentboard:start v<N>` and `# agentboard:end` holding
   `[mcp_servers.agentboard]`. Install refuses when a table of that name
   exists outside the markers (a line scan for the header). Avoids a
   dependency and preserves user bytes. Alternative: a TOML library that
   round-trips comments; none is dependency-free and comment-preserving.
5a. **Antigravity reuses the `AGENTS.md` block.** `agy` reads `AGENTS.md` or
   `GEMINI.md` workspace rules from the cwd up to the repo root (24 KB per file,
   20000 tokens in total), so no new rules file is written and the block is
   capped at 4096 bytes with a check warning for an oversized `AGENTS.md`.
   `.agents/skills.json` and `.agents/plugins.json` are not written: `agy
   --help` documents no schema for them (see Open Questions). The
   global MCP file format is confirmed by the sandbox suite with `agy mcp add`
   into a scratch HOME before the `--global` edit is implemented.
6. **Separate, opt-in `claude-hooks` target**, never auto-selected, so
   `agents install` never edits `.claude/settings.json` unless asked with
   `--target claude-hooks`. Alternative: auto-select beside `claude`;
   rejected because hooks change agent behavior.
7. **Hook executable, set by `--command`.** `--command` is the neutral name
   for what `--mcp-command` did; `--mcp-command` remains a deprecated alias.
   Default `npx -y @bendechrai/agentboard hook ...`;
   with `--command <exe>` the hooks run `<exe> hook ...`. `npx` adds
   hundreds of milliseconds per call, which matters for `PreToolUse`, so the
   README recommends a local executable when hooks are enabled.
8. **Prompts only on a real terminal** (stdin and stdout TTY, no `--json`);
   anything else keeps today's non-interactive behavior, so scripts and CI
   do not change. `init` defaults its question to Yes (Enter installs); the bare-project
   prompt takes an explicit list and treats empty as none.
9. **Verification is part of the product, and free of model calls.** A
   sandbox suite creates a temp project per target, runs the built CLI for
   real and asserts files, `check`, idempotency, refusal and config format.
   Smoke tests use config-loading commands only (`claude mcp list`, `codex mcp
   list`, `codex --version`, `agy mcp list`, `--help`), run with HOME and
   CODEX_HOME in the sandbox, and are skipped, not passed, when the binary is
   absent. A guard fails the suite on any change to the real `~/.codex`,
   `~/.gemini`, `~/.cursor` or `~/.claude`. Live model tests are manual, behind
   `AGENTBOARD_LIVE_HARNESS`; cursor-agent (about 25 free headless runs, use
   `--model auto`) and agy (about 5 requests, then a week) have tiny quotas,
   and `codex exec` costs money, so none runs by default; `claude` may.

## Risks / Trade-offs

- **PreToolUse is intrusive and adds latency to every edit** -> warn-only
  default, rate-limited warnings (once per 10 minutes per session),
  matcher limited to file-writing tools, 2 second deadline, read-only cache
  lookup, local executable recommended over `npx`, and `AGENTBOARD_HOOKS=off`.
- **Stop blocking can loop** -> strict mode blocks at most once per stop
  (`stop_hook_active` true always allows); warn mode never blocks.
- **Actor identity must be resolvable** -> `AGENTBOARD_ACTOR`/`--as` only;
  unresolved means silent allow (one explanatory line at session start).
  Never inferred from the OS user, matching board-cli.
- **Work not tied to a ticket** (quick fixes, docs) -> the warning says
  carrying on is fine, strict mode is for projects that mean it, and
  not installing `claude-hooks` or `AGENTBOARD_HOOKS=off` removes it.
- **Subagents and worktrees** -> they inherit the environment, so share the
  actor and its claims (a subagent edit counts as the parent's claimed
  work); board discovery uses the payload `cwd`, which finds the board
  from linked worktrees. A subagent that should be a distinct actor must set
  its own `AGENTBOARD_ACTOR`.
- **Editing the user's settings.json** -> merge only owned entries, refuse
  invalid JSON or an unexpected `hooks` shape, preserve everything else.
- **Harness config formats drift** (Codex, Cursor, Antigravity change often)
  -> config-format validation and non-model smoke tests in the sandbox suite;
  a failure blocks release.
- **Editing a user's global config** -> never by default; `--global` plus an
  explicit target, marked and refused when foreign, tests run on a scratch
  HOME with a guard on the real one.
- **Antigravity may prefer `GEMINI.md` over `AGENTS.md`** -> the sandbox suite
  records which `agy` reads when both exist; the block is small enough for
  either.

## Migration Plan

Existing installs are unaffected until `agents install` runs again; `check`
does not report `claude-hooks` unless it was installed. Rollback: delete the
three marked entries, or install with an explicit `--target` list.

## Open Questions

- Antigravity project registration (`.agents/skills.json`,
  `.agents/plugins.json`) is left out because `--help` shows no schema; add it
  in a follow-up if the schema is documented.
- Whether Codex reads `AGENTS.md` is confirmed in the sandbox suite; if it does
  not, the `codex` target only prints its command and the spec changes.
- An ADR (0016) recording decisions 2 and 3 is planned in task group 1.
