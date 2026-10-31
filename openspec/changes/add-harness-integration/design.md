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
3. **Fail open and be fast.** Hook mode is read-only, never syncs, never
   catches up (no fold, no due grant, no reaping, no cache rebuild), has a 2
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

10. **The agent guide gains no line.** Since `add-claim-leases`, the
   orchestrator output of `help agents --role orchestrator` is exactly at
   the 180-line limit, and every line added to the guide body lands in all
   four role outputs. The change makes room rather than raising the limit:
   it adds `hook` to the guide's list of commands that are not MCP tools by
   reflowing the existing lines, and documents hooks, `--hooks-strict` and
   `AGENTBOARD_HOOKS=off` in the README and in `help hook` instead. Agents
   meet hooks only through hook output, which names the commands to run,
   while hooks are installed and tuned by a human, who reads the README.
   Raising the limit would reopen a budget `add-claim-leases` (ADR 0014)
   has just settled, for text that every agent would read on every start.
11. **Hooks respect leases and the mutex recipe.** A ticket the actor holds
   is one it is the assignee of, whatever its lease state (as `claim`
   treats it); `session-start` shows each held ticket with the `list`
   assignee token so an unconfirmed or lapsed lease is visible; `stop`
   names `release` first for a ticket held under a lease, because a lock is
   released when done; no hook ever claims, renews or queues, so a hook is
   never the background process the worker rules forbid.

12. **One guidance version, raised only for changed text.** Ben decided
   on PR #67 that a target whose installed text is unchanged keeps its
   version and is not reported `stale`, and that a new target installs at
   the then-current version. The existing design has one constant,
   `GUIDANCE_VERSION`, which every marker records and `agents check`
   compares with `N != v`. This change alters no existing text, so the
   constant stays 3 and the new targets install with version 3 markers;
   no per-target version table is needed. The rule is written into
   "Installing guidance into a host project" and "Checking installed
   guidance". Limit: a later change that alters one target's text while
   others stay unchanged would, with one constant, mark them all stale;
   such a change would have to introduce per-target versions in its own
   delta.

## Re-sync with the main specs

Re-synced on 2026-10-31 with the main specs as of `a455011` (after the
archives of `add-claim-leases`, `guard-stale-temporary`,
`keep-cursors-on-upgrade` and `no-echo-refusals`). The MODIFIED text
restates the current main text of board-cli "Command surface", "Exit
codes" and "MCP server" and board-agent-guidance "Help is not an MCP
tool", "Installing guidance into a host project", "Installed guidance
never clobbers user content" and "Checking installed guidance" (those four
are unchanged in main since 0.2.0), so archiving keeps `renew`,
`unqueue`, `config`, the lease flags, CLI-only flags and the `config` MCP
exclusion. Places where the main specs forced a change of substance:

- **Hooks never catch up.** board-cli "Due grants are written during
  catch-up" makes every command except `rebuild` write due grants, which
  contradicts "the hook writes no events". The change keeps the hook
  read-only and adds `hook` to that requirement's exceptions (MODIFIED).
  Consequence: `session-start` does not deliver a grant that is due but
  not yet written (Ben confirmed this on PR #67). A cache of another schema
  version counts as unreadable, since opening it would recreate it
  (`keep-cursors-on-upgrade`).
- **The guidance version stays 3.** The branch planned
  `GUIDANCE_VERSION` 4, which would have reported every 0.3.0 install
  `stale` although this change alters no existing target's text. Decided
  by Ben on PR #67 (decision 12): the version is raised only when an
  existing target's installed text changes.
- **Cursor and Copilot carry the mutex short form.** "Mutex ticket recipe"
  puts a short form in all installed project guidance; to keep the
  proposal's "same rules in every target", the `cursor` rule and the
  `copilot` block are the `AGENTS.md` block's text (codex and antigravity
  already use that block), with the recipe's line limits. The block is
  2868 bytes at 0.3.0, within the 4096-byte Antigravity cap.
- **Hook output follows leases and the mutex recipe** (decision 11): the
  held-ticket line shows lease state, "since its latest claim" becomes
  "since it last became the assignee" (a grant makes an assignee without
  a claim), and `stop` names `release` for a leased ticket.
- **No refused input is repeated** (`no-echo-refusals`): an unknown hook
  event or argument, an unknown answer at the bare-project prompt, and an
  empty or multi-line `--command` are refused without repeating the input.
- **The guide line budget** (decision 10): no guide line is added.
- **ADR 0016**, since 0014 and 0015 are taken.

## Rulings from task group 1 (test author)

Taken while writing the group 1 tests, posted as `DECISION:` comments on
the group's ticket and pinned by the tests and the stub contracts in
`src/board/hook.ts`:

- **Routing.** The executable hands `agentboard hook ...` to the hook
  runner before the ordinary parser (as it does for `mcp`), so an
  argument error is the hook's exit 0 and one line, never the parser's
  exit 1. `agentboard hook --help` and `help hook` still print the help.
  The registry entry's `run`, reachable only through the in-process
  `runCli`, refuses with `streaming-command` like `mcp`.
- **The budget runs from the process start** (`performance.timeOrigin`),
  so Node's start-up counts against it and the 3 second bound of the
  "Time budget" scenario holds on a loaded machine; stdin is read only
  until the deadline and then let go.
- **Actor names.** A resolved name that a writing command could not use
  (the reserved `agentboard`, a secret pattern, outside the actor form
  `^[A-Za-z0-9][A-Za-z0-9._@-]{0,31}$` of `actor-secret-check`, which is
  not merged yet) is no actor: the hook is silent (session-start prints
  its no-actor line) and never repeats it. When `actor-secret-check`
  lands, the hook should call its check instead of its own copy.
- **No-actor line.** session-start prints it only where a board is found
  (the cache is not needed), as one JSON document
  `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":...}}`;
  with no board it prints nothing.
- **Escape hatch.** Only the exact value `off`; it is checked first, so
  even an argument error is silent and stdin is not read.
- **Payload `cwd`.** Used when it is a non-empty string naming an existing
  directory (relative to the process directory), else the process
  directory; `AGENTBOARD_DIR` still wins, as in every discovery.
- **Flags.** `--json` is accepted and changes nothing (the answer is the
  protocol); `--as` has its own help line (`actorHelp`), not "ignored".
- **Unreadable cache** includes a file that is not SQLite; a missing cache
  is never created.
- **Holding** is computed on the cache as it is: a grant that is due but
  not written makes no one the holder (the grantee holds once a catching-up
  command writes it). Held tickets are listed in ticket id order.
- **The guide line moves to group 1.** Adding `hook` to the MCP
  exclusions (task 1.2) makes the existing tests that require the guide
  and the `mcp` description to name every excluded command fail, so the
  reflow that adds `hook` to the guide's list of commands that are not
  tools (decision 10, no line added) is done in task 1.2, not 7.1;
  task 7.1 keeps the README and checks the line counts.

## Rulings from review round 1 of task group 1

- **Fail open beyond the runner.** A removed process directory and a
  stdout or stderr that is closed or failing (EPIPE, ENOSPC) are failures
  of the hook like any other: exit 0, at most one stderr line, no stack
  trace. So `src/cli.ts` reads `process.cwd()` inside the hook's guard (a
  missing directory leaves only the payload `cwd` for discovery) and the
  hook path ignores stream errors.
- **The budget covers discovery.** `git rev-parse` in board discovery is
  bounded by the time left; a `git` that does not answer in time counts as
  git failing (discovery falls back to `./.board`, the usual rule when git
  fails), so the hook still answers within the budget.
- **No stderr line names the payload `cwd` or the actor**, on every path
  (unreadable, missing, older or locked cache, out of time), not only on
  argument errors.
- **WAL checkpoint limit.** The inspect-only open is read-write (a
  `readOnly` connection leaves empty `-wal` and `-shm` files behind on a
  clean cache). After an unclean shutdown that left a non-empty `-wal`,
  the hook's connection is the last to close and checkpoints the log into
  `cache.sqlite`: the content is the same, the bytes are not. Accepted
  and recorded in the spec delta rather than fixed in this change;
  `rebuild --check` has the same property.

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
- Decided by Ben on PR #67: `hook session-start` does not catch up or
  write due grants; hooks stay read-only (decision 3).
