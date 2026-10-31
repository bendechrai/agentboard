# Tasks

The MODIFIED text in this change's deltas (`board-cli` "Command surface",
"Exit codes", "MCP server" and "Due grants are written during catch-up";
`board-agent-guidance` "Help is not an MCP tool", "Installing guidance
into a host project", "Installed guidance never clobbers user content",
"Checking installed guidance" and "Mutex ticket recipe") was re-synced on
2026-10-31 with the main specs as of `a455011`, after the archives of
`add-board-sharing`, `add-adhoc-ticket-lifecycle`, `add-claim-leases`,
`guard-stale-temporary`, `keep-cursors-on-upgrade` and `no-echo-refusals`.
It keeps `remote`, `init --remote` and `--into-host`, the scope
disposition flags, `renew`, `unqueue`, `config`, the lease flags and the
CLI-only flags. `GUIDANCE_VERSION` stays 3, since this change alters no
existing target's installed text, and the new targets install at version
3 (board-agent-guidance "Installing guidance into a host project"). ADR
0014 and 0015 are taken, so this change's ADR (task 1.4) is 0016. The agent
guide gains no line (design.md decision 10). Every new refusal follows
board-cli "Refusals never repeat the refused input": its tests pass a
token-shaped value and assert it appears in no output.

Every group is delivered by a test author, an implementer and a reviewer in
turn (see CONTRIBUTING.md), on one branch per group named
`<area>/<group-slug>` and cut from `origin/staging`; the test author's first
commit defines the group's exported API as stubs. Verification for every
task includes `make check` passing with coverage at or above 90 percent;
groups 2 and 7 also run `make check-in-docker`. Group 2 touches process
handling, so it also runs `make check-floor`. Each group gets a reviewer on a
different model from its implementer; group 2 (hooks that can block the
agent) gets a second reviewer. Sandbox projects live in a temporary
directory outside the repository and are removed after each test.

Before archiving, re-sync the MODIFIED text again with any requirement
another archived change has touched since `a455011`.

## 1. Hook command contract (`hooks/command`)

- [x] 1.1 Test author: write tests for every scenario of "Hook command and protocol" and "Hook actor resolution" (no board, garbage payload, unknown event not repeated, 2 second budget with a locked cache, a cache of an earlier schema version left byte-identical, `AGENTBOARD_HOOKS=off`, read-only byte comparison including a due grant left unwritten, worktree discovery, missing actor, a lapsed lease still held, a queued actor holding nothing) and for board-cli "Due grants are written during catch-up" scenario "Hook writes no due grant", and stubs for the hook module and registry entry. Verify: tests compile, are red, and pre-push subset passes
- [x] 1.2 Implementer: add the `hook` registry entry (events, `--strict`, exit codes 0 and 2, MCP exclusion), the routing of `hook` in `src/cli.ts`, the stdin reader, the deadline wrapper (from the process start), actor resolution and a cache read that never catches up, rebuilds or reaps; add `hook` to the agent guide's list of commands that are not MCP tools by reflowing existing lines (design.md "Rulings from task group 1"). Verify: the group 1 tests pass, `agentboard help hook` renders, `board_hook` is refused over MCP, the layering test passes. Verified 2026-10-31: `make check` green (240 files, 7646 tests, coverage 96.97% statements, 91.15% branches); hook.test, hook-run.test and hook-processes.test (101 tests) passed 3 times in a row; `node dist/cli.js help hook` renders the three events, `--strict`, and exit codes 0 and 2; `board_hook` refused in src/mcp/__tests__/server.test.ts; layering.test, no-echo-source-scan.test, guide.test and remote-cli.test pass. Review round 1 (2026-10-31): the 7 red process tests (removed working directory, output closed or failing, slow discovery) made green by reading `process.cwd()` inside the hook guard, dropping stdout and stderr stream errors on the hook path, and bounding discovery's `git` child by the time left (`locateBoard` `timeoutMs`); `make check` green again and the three hook files passed 3 times
- [ ] 1.3 Reviewer: check conformance to the scenarios, that no code path in hook mode writes (other than the inbox cursor) or catches up, that no stderr line repeats input, and that every failure is fail-open. Verify: report with a verdict; at least one hook payload recomputed by a throwaway script
- [x] 1.4 Write ADR 0016 recording warn-only default, strict opt-in and fail-open. Verify: `make ascii` and the ADR index in `adr/README.md` list it. Verified 2026-10-31: `adr/0016-hooks-warn-only-strict-opt-in-fail-open.md` written, listed in `adr/README.md`, `make ascii` reports no non-ASCII bytes. Review round 1: "every failure exits 0" and "the 5 second timeout is never reached" corrected, the WAL checkpoint limit recorded

## 2. Hook events (`hooks/events`)

- [ ] 2.1 Test author: tests for "Session start hook", "Stop hook" and "Pre-tool-use claim check", including the strict no-loop case, truncation at an entry boundary, the 10 minute warning rate limit, path exemptions, the held-ticket line with its `list` assignee token, a ticket that became the actor's by a grant or hand-off, and `release` named for a ticket held under a lease. Verify: tests are red, pre-push subset passes
- [ ] 2.2 Implementer: implement the three events over the existing inbox and ticket queries, with the rate-limit state kept in the OS temp directory keyed by session id. Verify: group 2 tests pass; a 500 ticket board answers `pre-tool-use` in under 200 ms in a timing test run locally (not asserted in CI)
- [ ] 2.3 Reviewer (two, second on the strongest model): check against the Claude Code hook protocol, loop safety, latency, and that no hook message contradicts the mutex recipe (no hook claims, renews, queues or suggests waiting in a loop). Verify: both reports; a hand-written payload for each event run against the built CLI

## 3. Claude hooks target (`guidance/claude-hooks`)

- [ ] 3.1 Test author: tests for "Hooks installed in Claude settings" and the settings.json clobber and check scenarios (preserved keys and user hooks, no duplicates, strict switch, local executable, invalid JSON refusal, hand-edit and missing-entry `modified`, stale). Also tests for the `--command` flag, the deprecated `--mcp-command` alias with its stderr notice, and that `claude-hooks` is never auto-selected. Verify: tests are red, pre-push subset passes
- [ ] 3.2 Implementer: add the `claude-hooks` target to install, check and the marker module; `--hooks-strict`; never auto-selected, only by `--target claude-hooks`; add `--command` (setting the executable of every MCP entry and the hooks) with `--mcp-command` as a deprecated alias. Verify: group 3 tests pass and reinstall is byte-identical
- [ ] 3.3 Reviewer: check non-destructive merge and marker round trip. Verify: report with verdict

## 4. Other harness targets (`guidance/harness-targets`)

- [ ] 4.1 Test author: tests for `codex`, `cursor`, `antigravity` and `copilot` install, auto-detection, the printed `codex mcp add` / `agy mcp add` commands, `--global` (explicit target required, scratch `CODEX_HOME` and `HOME`, other entries untouched), refusal (foreign TOML table, markerless mdc, unmanaged MCP entries), `--command` reaching each MCP entry, the 4096 byte `AGENTS.md` block and the 24 KB warning, check states, "Harness MCP entries", the mutex short form in the `cursor` rule and `copilot` block with their line limits ("Mutex ticket recipe"), 0.3.0 (version 3) `claude` and `agents-md` installs still `current`, new targets carrying version 3 markers, adding a target leaving the others' state unchanged, and an empty or multi-line `--command` refused without repeating it. Verify: tests are red, pre-push subset passes
- [ ] 4.2 Implementer: implement the four targets with the existing block, owned-key and refusal helpers; the `cursor` rule body and the `copilot` block are the `AGENTS.md` block's text (the six rules, the mutex short form and the pointer to `agentboard help agents`); leave `GUIDANCE_VERSION` at 3 and the existing rendered texts byte-identical. Verify: group 4 tests pass; the rendered `SKILL.md` and `AGENTS.md` block are byte-identical to 0.3.0's; every `agentboard ` line in the new texts parses against the registry
- [ ] 4.3 Reviewer: check no user bytes change outside owned regions in any target. Verify: report with verdict

## 5. Prompts (`guidance/prompts`)

- [ ] 5.1 Test author: tests for the bare-project prompt and "Init offers to install agent guidance" using a fake terminal (answers `1,3`, empty, an unknown token-shaped answer that appears in no output, `y`, `n`, Enter installing, an `init` that fails neither asking nor installing) and real non-TTY runs (no stdin read, exit 1). Verify: tests are red, pre-push subset passes
- [ ] 5.2 Implementer: add the TTY prompt helper, the `init --agents/--no-agents` flags and the install-failure exit behavior. Verify: group 5 tests pass; `init --json` never prompts
- [ ] 5.3 Reviewer: check TTY detection and that nothing reads stdin in a script. Verify: report with verdict

## 6. Sandbox verification (`guidance/sandbox-verification`)

- [ ] 6.1 Test author: write the sandbox suite from "Harness targets are verified in a sandbox project" and "Harness tests never reach a model or a real home": per target in a fresh `git init` temp project, real built CLI, install, `check --json`, second install byte comparison, pre-existing user content, foreign content refusal and `--force`, stale and modified, config-format validation, whether Codex reads `AGENTS.md`, and `--global` edits against a scratch `HOME` and `CODEX_HOME`. Add the guard that fails the suite when the real `~/.codex`, `~/.gemini`, `~/.cursor` or `~/.claude` changes (hash and mtime snapshot before and after). Verify: suite runs red against stubs; the guard test fails when a deliberate write to a fake real-home path is injected
- [ ] 6.2 Test author: write the smoke tests with only non-model commands (`claude mcp list`, `codex mcp list`, `codex --version`, `agy mcp list` against a scratch `HOME`, `agy --help`, `cursor-agent --help`) that skip with `skipped (harness not installed)` when the binary is missing, and the manual live tests behind `AGENTBOARD_LIVE_HARNESS` (cursor-agent with `--model auto`, one short prompt; agy one short prompt; codex exec one short prompt; claude allowed by default). Verify: with the flag unset a test spy on process spawning shows no model-capable invocation of `codex exec`, `agy -p` or `cursor-agent`; Copilot has file-level tests only
- [ ] 6.3 Implementer: make the suite green and wire it into `make check` (smoke tests are skipped in `make check-in-docker` where the harness CLIs are absent). Verify: suite passes locally with claude 2.1.289, cursor-agent 2026.10.01, codex 0.160.0 and agy 1.2.17 installed; skipped tests are listed in the output; temp directories are gone afterwards; the real home config files are unchanged
- [ ] 6.4 Reviewer: run each target by hand in a throwaway project with each installed harness CLI and a scratch HOME, confirm the harness loads the config, and run the opt-in live tests once at most per harness. Verify: report with a verdict and the harness versions in the PR description

## 7. Docs and status (`docs/harness-integration`)

- [ ] 7.1 Document install targets, hooks (warn-only default, `--hooks-strict`, `AGENTBOARD_HOOKS=off`, the risks and recommended local executable) and the prompts in README.md and `help hook`; the agent guide's `hook` mention is added in task 1.2 (design.md "Rulings from task group 1"), so only confirm it. Verify: the README commands run as written in a sandbox project; `help agents` and each `--role` output have the same line count as before (154, and 180 for the orchestrator at 0.3.0) and their `agentboard ` lines parse
- [ ] 7.2 Update STATUS.md: list this change under "What is next" and remove it once archived. Item 1 (publish 0.1.0, then a release workflow) is already resolved on `staging` (0.1.0 is on npm and `.github/workflows/release.yml` landed in #66), so confirm no such item remains rather than rewriting it. Verify: `make ascii` and a read of STATUS.md
- [ ] 7.3 Record in the PR description that a prepack build script, if still wanted, is a separate follow-up and not part of this change. Verify: the PR text says so

## 8. Integration

- [ ] 8.1 In a clean temporary project with `.claude/`, `AGENTS.md` and `.codex/` (with a scratch `HOME` and `CODEX_HOME`), run `agentboard init --agents`, `agents check`, one simulated session (`session-start`, an unclaimed `Edit` payload, a `stop` with a held ticket) and confirm warn-only behavior end to end. Verify: transcript attached to the final PR; `make check` and `make check-floor` pass
