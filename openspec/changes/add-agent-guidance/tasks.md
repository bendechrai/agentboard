# Tasks

Depends on `add-board-core` groups 3 (command registry) and 9 (`mcp`). Every
group is delivered by a test author, an implementer and a reviewer in turn
(see CONTRIBUTING.md), on one branch per group cut from `origin/staging`.
Verification for every task includes `make check` passing with coverage at
or above 90 percent.

## 1. Generated help

- [x] 1.1 Extend registry entries with `description`, `examples` and `exitCodes`, and implement the help renderer (`src/guidance/help.ts`) for the overview and per-command help, including `--json`, and verify with tests that every registry command renders synopsis, flags, exit codes and an example, that `--help` works with no board and no actor, and that the overview ends with the agents line
- [x] 1.2 Implement unknown command and flag suggestions (edit distance 2, at most three) and verify with tests for a misspelled command, a misspelled flag and a token with no close match

## 2. Agent guide and hints

- [x] 2.1 Implement `help agents` and `help agents --role <role>` from `src/guidance/guide.ts` and verify with tests that every `agentboard ` line parses against the registry, the output is ASCII, at most 150 lines, version-stamped, contains each required section, and an unknown role exits 1 listing the valid roles
- [x] 2.2 Add hint templates for every rejection reason and usage error, print them on stderr as `hint: ` lines, and verify with a test that enumerates every reason and fails on any without a hint, plus scenario tests for already-assigned, missing actor, needs-task-link and the decision rule

## 3. Installing guidance

- [ ] 3.1 Implement `agents install` targets `claude` and `agents-md` with markers, `GUIDANCE_VERSION`, working-tree root resolution, auto-detection and `--force`, and verify with tests for fresh install, idempotent reinstall (no byte changes), upgrade of a managed block with surrounding user text preserved, refusal of a foreign `SKILL.md`, a malformed marker pair, and auto-detection reporting
- [ ] 3.2 Add the `yaml` package with `npm install` and implement the `openspec` target (apply and archive guidance entries prefixed `agentboard:`) and the `mcp-json` target, and verify with tests against a fixture copy of the OpenSpec-generated `config.yaml` that all comments survive in order, that reinstall is a no-op, that a non-list `guidance` value is refused with the manual lines printed, and that a differing `mcpServers.agentboard` entry is refused without `--force`
- [ ] 3.3 Implement `agents check` with `current`, `stale` and `modified` states and `--json`, and the `init` suggestion line, and verify with tests for each state and exit code

## 4. Guide over MCP

- [x] 4.1 Serve the guide summary as MCP `instructions` and the full guide as resource `agentboard://guide`, and verify with a test that spawns the server, checks the instructions length and the resource name in them, and compares the resource text to `help agents` stdout

## 5. Documentation

- [ ] 5.1 Document `agents install`, `agents check` and `help agents` in README.md (including the project's own use of them) and verify with `make ascii` and by running `agents install` on a fresh temporary project with `.claude/` and OpenSpec initialized
