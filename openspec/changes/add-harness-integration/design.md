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
5. **TOML by marked block, not parse.** `.codex/config.toml` gets a block
   between `# agentboard:start v<N>` and `# agentboard:end` holding
   `[mcp_servers.agentboard]`. Install refuses when a table of that name
   exists outside the markers (a line scan for the header). Avoids a
   dependency and preserves user bytes. Alternative: a TOML library that
   round-trips comments; none is dependency-free and comment-preserving.
6. **Separate `claude-hooks` target**, auto-selected beside `claude`, so
   `--target claude` alone still writes only the skill, and users can skip
   hooks with an explicit `--target` list.
7. **Hook executable.** Default `npx -y @bendechrai/agentboard hook ...`;
   with `--mcp-command <exe>` the hooks run `<exe> hook ...`. `npx` adds
   hundreds of milliseconds per call, which matters for `PreToolUse`, so the
   README recommends a local executable when hooks are enabled.
8. **Prompts only on a real terminal** (stdin and stdout TTY, no `--json`);
   anything else keeps today's non-interactive behavior, so scripts and CI
   do not change. `init` defaults its question to No; the bare-project
   prompt takes an explicit list and treats empty as none.
9. **Verification is part of the product.** A sandbox suite creates a temp
   project per target, runs the built CLI for real and asserts files, `check`,
   idempotency and refusal. Harness smoke tests use config-loading commands
   only (for example `claude mcp list`, `codex mcp list`), never a model
   call, and are reported as skipped, not passed, when the CLI is absent.

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
  `--target` without `claude-hooks` or `AGENTBOARD_HOOKS=off` removes it.
- **Subagents and worktrees** -> they inherit the environment, so share the
  actor and its claims (a subagent edit counts as the parent's claimed
  work); board discovery uses the payload `cwd`, which finds the board
  from linked worktrees. A subagent that should be a distinct actor must set
  its own `AGENTBOARD_ACTOR`.
- **Editing the user's settings.json** -> merge only owned entries, refuse
  invalid JSON or an unexpected `hooks` shape, preserve everything else.
- **Harness config formats drift** (Codex, Cursor, Gemini change often) ->
  smoke tests in the sandbox suite and a recorded-doc date in each target's
  rendered text; a failing smoke test blocks release.
- **Auto-selecting `claude-hooks` changes what `agents install` touches** ->
  warn-only default, called out as BREAKING (minor) in the proposal.

## Migration Plan

Existing installs are unaffected until `agents install` runs again; `check`
does not report `claude-hooks` unless it was installed. Rollback: delete the
three marked entries, or install with an explicit `--target` list.

## Open Questions

- Should `--mcp-command` be renamed (for example `--command`) now that it
  also sets the hook executable? Keeping it avoids a breaking rename; a
  later alias is possible without changing these specs.
- An ADR (0012) recording decisions 2 and 3 is planned in task group 1.
