# Status

A cold-start handover doc: what exists, what to do next, how to run the
build loop with or without an orchestrator, and what is not yet decided.
Written for a newcomer (human or agent) opening this repository for the
first time. See README.md for what the product is, CONTRIBUTING.md for the
full workflow, and docs/adr/ for design decisions.

## What exists

- The project scaffold: TypeScript CLI (`src/cli.ts`, library surface in
  `src/index.ts`), ESLint/Prettier/tsup/vitest config, the root Makefile
  (`make check`, `make hooks`, `make check-in-docker`, `make check-floor`),
  the pre-push hook, and Docker dev toolchain files.
- ADRs in `docs/adr/`: 0001 (the event log is the source of truth, SQLite
  a disposable cache), 0002 (one transaction per command, event file
  inside it), 0003 (inbox cursors as a position plus a seen set), 0004
  (source-neutral task reference) and 0005 (sync commits only its own
  paths, as a fixed identity).
- The `add-board-core` OpenSpec change is complete and archived as
  `openspec/changes/archive/2026-09-24-add-board-core/`; its requirements
  are the main specs in `openspec/specs/` (board-cache, board-cli,
  board-concurrency, board-events, board-openspec-integration). Its deltas
  were clarified by ruling commits during the build
  (`git log --oneline -- openspec/changes/add-board-core` on history before
  the archive lists them). Every CLI command, the MCP server
  (`agentboard mcp`), the concurrency and crash property tests, and the
  documentation (README usage, ADRs 0002 to 0005, "Using agentboard in a
  project" in CONTRIBUTING.md) are merged into `staging`.
- The `add-agent-guidance` OpenSpec change (generated help, `help agents`,
  error hints, `agents install`/`agents check` for Claude Code skills,
  `AGENTS.md`, OpenSpec config and `.mcp.json`, and the guide over MCP) is
  proposed; its task group 1 is in progress. It depends on
  `add-board-core` groups 3 and 9, both merged.

## What to do next

1. Continue `add-agent-guidance` (group 1 is in progress), one task group
   at a time, then archive it.
2. A human reviews `staging` and promotes it to `main` (a merge-commit PR
   from `staging`), then publishes the npm package.

Each task group uses the three-role loop from CONTRIBUTING.md
("Three-agent workflow per task group"):

1. `git fetch origin` before cutting anything; branches are cut from
   `origin/staging`, never from a local `staging` ref.
2. Cut one feature branch per task group (`<area>/<group-slug>`), then one
   worktree per agent:
   `git worktree add -b <area>/<group-slug> ../agentboard-<group-slug> origin/staging`
   for the first role, and `git worktree add ../agentboard-<group-slug>-impl <area>/<group-slug>`
   for later roles.
3. Run the three roles in order, each in its own worktree, on the same
   branch: test author (red tests + compile stubs only) -> implementer
   (green tests, no test edits) -> reviewer (different model; spec
   conformance, test quality, lint, coverage table).
4. `make check` must pass before the implementer hands off and again before
   the reviewer signs off; the reviewer states the `make check` result in
   the PR body (its report becomes the PR body).
5. Only the reviewer opens the PR against `staging`, after APPROVE or
   APPROVE WITH NITS and after `make check`, `make check-in-docker` and
   `make check-floor` pass, with auto-merge enabled
   (`gh pr merge --auto --squash`); no approvals are required, so opening
   the PR is the merge decision.
6. Tick the completed tasks in `tasks.md` once the group has landed on
   `staging`.

### Orchestrator pattern (with a coordinator)

A coordinating instance holds the task list and, for each task group,
dispatches one agent per role in turn, each in its own worktree it creates
for that agent. The orchestrator never edits code itself and never lets two
agents share a worktree. Between dispatches it is the one that reads
`inbox`/board state or `tasks.md` to decide what is next (see README.md,
"The orchestrator inbox protocol"). When a reviewer needs a second
opinion, it reports back to the orchestrator rather than spawning its own sub-agent; the
orchestrator spawns a second reviewer, in its own worktree, and relays
whichever ruling should govern (approve, or send back to implementer/test
author with the blocking findings).

### Running the loop without a coordinator

A single instance may play all three roles for a task group, but must do so
sequentially, in three separate worktrees (one per role, created and torn
down as it moves from role to role), and must not skip the review step by
merging its own implementer work directly. Each role's work is committed
before the next role starts, so the sequence is: create the test-author
worktree, write and commit red tests plus stubs, remove that worktree (or
leave it; the branch is what matters); create the implementer worktree from
the same branch, make tests green, commit; create the reviewer worktree
from the same branch, run `make check`, review conformance and test
quality, and only then open the PR. The instance must judge its own review
honestly (as if it were a different model) rather than rubber-stamping its
own implementation.

## Decisions that live only in history

None known. Rulings made during groups 1 to 7 were recorded as spec delta
changes in `add-board-core` (see its git log) and, where they are design
decisions rather than requirements, as ADRs 0002 to 0005.

## Gaps found during a cold-start read

None open. The six gaps found on 2026-09-23 (exported API definition,
branch naming per group, model assignment per role, who opens the PR,
definition of done, stale local staging) are closed in CONTRIBUTING.md
("Branch model", "Three-agent workflow per task group", "Models", "STOP
protocol", "Definition of done for a task group", "One worktree per
agent", "Pull requests"), in design.md ("Interfaces (sketch)") and in the
tasks.md preamble.
