# Tasks

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

This change and `add-claim-leases` both restate `board-cli` "Command
surface" and "MCP server"; re-sync that text with the main spec before
archiving whichever lands second.

## 1. Hook command contract (`hooks/command`)

- [ ] 1.1 Test author: write tests for every scenario of "Hook command and protocol" and "Hook actor resolution" (no board, garbage payload, 2 second budget with a locked cache, `AGENTBOARD_HOOKS=off`, read-only byte comparison, worktree discovery, missing actor), and stubs for the hook module and registry entry. Verify: tests compile, are red, and pre-push subset passes
- [ ] 1.2 Implementer: add the `hook` registry entry (events, `--strict`, exit codes 0 and 2, MCP exclusion), the stdin reader, the deadline wrapper and actor resolution. Verify: the group 1 tests pass, `agentboard help hook` renders, `board_hook` is refused over MCP, the layering test passes
- [ ] 1.3 Reviewer: check conformance to the scenarios, that no code path in hook mode writes (other than the inbox cursor), and that every failure is fail-open. Verify: report with a verdict; at least one hook payload recomputed by a throwaway script
- [ ] 1.4 Write ADR 0012 recording warn-only default, strict opt-in and fail-open. Verify: `make ascii` and the ADR index in `adr/README.md` list it

## 2. Hook events (`hooks/events`)

- [ ] 2.1 Test author: tests for "Session start hook", "Stop hook" and "Pre-tool-use claim check", including the strict no-loop case, truncation at an entry boundary, the 10 minute warning rate limit and path exemptions. Verify: tests are red, pre-push subset passes
- [ ] 2.2 Implementer: implement the three events over the existing inbox and ticket queries, with the rate-limit state kept in the OS temp directory keyed by session id. Verify: group 2 tests pass; a 500 ticket board answers `pre-tool-use` in under 200 ms in a timing test run locally (not asserted in CI)
- [ ] 2.3 Reviewer (two, second on the strongest model): check against the Claude Code hook protocol, loop safety and latency. Verify: both reports; a hand-written payload for each event run against the built CLI

## 3. Claude hooks target (`guidance/claude-hooks`)

- [ ] 3.1 Test author: tests for "Hooks installed in Claude settings" and the settings.json clobber and check scenarios (preserved keys and user hooks, no duplicates, strict switch, local executable, invalid JSON refusal, hand-edit and missing-entry `modified`, stale). Also tests for the `--command` flag, the deprecated `--mcp-command` alias with its stderr notice, and that `claude-hooks` is never auto-selected. Verify: tests are red, pre-push subset passes
- [ ] 3.2 Implementer: add the `claude-hooks` target to install, check and the marker module; `--hooks-strict`; never auto-selected, only by `--target claude-hooks`; add `--command` (setting the executable of every MCP entry and the hooks) with `--mcp-command` as a deprecated alias. Verify: group 3 tests pass and reinstall is byte-identical
- [ ] 3.3 Reviewer: check non-destructive merge and marker round trip. Verify: report with verdict

## 4. Other harness targets (`guidance/harness-targets`)

- [ ] 4.1 Test author: tests for `codex`, `cursor`, `gemini` and `copilot` install, auto-detection, refusal (foreign TOML table, markerless mdc, unmanaged MCP entry), `--command` reaching each MCP entry, check states, and "Harness MCP entries". Verify: tests are red, pre-push subset passes
- [ ] 4.2 Implementer: implement the four targets with the existing block, owned-key and refusal helpers; the rendered rule text states the five rules and points to `agentboard help agents`. Verify: group 4 tests pass; every `agentboard ` line in the new texts parses against the registry
- [ ] 4.3 Reviewer: check no user bytes change outside owned regions in any target. Verify: report with verdict

## 5. Prompts (`guidance/prompts`)

- [ ] 5.1 Test author: tests for the bare-project prompt and "Init offers to install agent guidance" using a fake terminal (answers `1,3`, empty, unknown token, `y`, `n`, Enter installing) and real non-TTY runs (no stdin read, exit 1). Verify: tests are red, pre-push subset passes
- [ ] 5.2 Implementer: add the TTY prompt helper, the `init --agents/--no-agents` flags and the install-failure exit behavior. Verify: group 5 tests pass; `init --json` never prompts
- [ ] 5.3 Reviewer: check TTY detection and that nothing reads stdin in a script. Verify: report with verdict

## 6. Sandbox verification (`guidance/sandbox-verification`)

- [ ] 6.1 Test author: write the sandbox suite from "Harness targets are verified in a sandbox project": per target in a fresh `git init` temp project, real built CLI, install, `check --json`, second install byte comparison, pre-existing user content, foreign content refusal and `--force`, stale and modified; plus smoke tests (`claude`, `codex`, `gemini` config-loading commands, no model calls) that skip with an explicit message when the CLI is absent. Verify: suite runs red against stubs and skips cleanly without harness CLIs
- [ ] 6.2 Implementer: make the suite green and wire it into `make check` (smoke tests opt out in `make check-in-docker` where the harness CLIs are absent). Verify: suite passes locally; the temp directories are gone afterwards; skipped smoke tests are listed in the output
- [ ] 6.3 Reviewer: run each target by hand in a throwaway project with each harness CLI that is installed, confirm the harness loads the config, and record the harness versions in the PR description. Verify: report with a verdict and the versions

## 7. Docs and status (`docs/harness-integration`)

- [ ] 7.1 Document install targets, hooks (warn-only default, `--hooks-strict`, `AGENTBOARD_HOOKS=off`, the risks and recommended local executable) and the prompts in README.md and the agent guide. Verify: the README commands run as written in a sandbox project; `help agents` stays within its line limit and its `agentboard ` lines parse
- [ ] 7.2 Update STATUS.md: list this change under "What is next" and remove it once archived. Item 1 (publish 0.1.0, then a release workflow) is already resolved on `staging` (0.1.0 is on npm and `.github/workflows/release.yml` landed in #66), so confirm no such item remains rather than rewriting it. Verify: `make ascii` and a read of STATUS.md
- [ ] 7.3 Record in the PR description that a prepack build script, if still wanted, is a separate follow-up and not part of this change. Verify: the PR text says so

## 8. Integration

- [ ] 8.1 In a clean temporary project with `.claude/`, `AGENTS.md` and `.codex/`, run `agentboard init --agents`, `agents check`, one simulated session (`session-start`, an unclaimed `Edit` payload, a `stop` with a held ticket) and confirm warn-only behavior end to end. Verify: transcript attached to the final PR; `make check` and `make check-floor` pass
