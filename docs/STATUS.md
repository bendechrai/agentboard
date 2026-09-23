# Status

A cold-start handover doc: what exists, what to do next, how to run the
build loop with or without an orchestrator, and what is not yet decided.
Written for a newcomer (human or agent) opening this repository for the
first time. See README.md for what the product is, CONTRIBUTING.md for the
full workflow, and docs/adr/ for design decisions.

## What exists

- The project scaffold: TypeScript CLI skeleton (`src/cli.ts`, `src/index.ts`,
  one placeholder test), ESLint/Prettier/tsup/vitest config, the root
  Makefile (`make check`, `make hooks`, `make check-in-docker`), the
  pre-push hook, and Docker dev toolchain files.
- `docs/adr/0001-event-log-source-of-truth.md`, the accepted decision behind
  the whole design: an append-only, content-addressed event log under
  `.board/events/` is the source of truth; a SQLite cache is a disposable,
  rebuildable read cache derived from it.
- The `add-board-core` OpenSpec change (proposal, design, five spec deltas
  under `openspec/changes/add-board-core/specs/`, and `tasks.md` with 9 task
  groups) is proposed AND merged into `staging` (PR #1, squash-merged as
  `b458f34`). Its specs are not yet in `openspec/specs/` (that only happens
  when the change is archived after implementation), and `openspec/changes/archive/`
  is currently empty.
- `add-board-core` was amended (PR #5) so tickets carry a source-neutral
  task reference (`openspec:<change>#<group>`) instead of OpenSpec-only
  `change`/`group` fields, and the MCP server (group 9) is fully specified
  and no longer optional.
- The `add-agent-guidance` OpenSpec change (generated help, `help agents`,
  error hints, `agents install`/`agents check` for Claude Code skills,
  `AGENTS.md`, OpenSpec config and `.mcp.json`, and the guide over MCP) is
  proposed. It depends on `add-board-core` groups 3 and 9 and is built
  after that change.
- No board functionality is implemented yet. `src/` contains no code under
  `src/events/` or `src/store/`; task group 1 (events, canonical JSON and
  fold) has not been started.

## What to do next

Start task group 1 (`openspec/changes/add-board-core/tasks.md`, section 1:
"Events, canonical JSON and fold") using the three-role loop from
CONTRIBUTING.md ("Three-agent workflow per task group"):

1. `git fetch origin` before cutting anything; branches are cut from
   `origin/staging`, never from a local `staging` ref.
2. Cut one feature branch per task group (`<area>/<group-slug>`, e.g.
   `events/canonical-fold`), then one worktree per agent:
   `git worktree add -b events/canonical-fold ../agentboard-canonical-fold origin/staging`
   for the first role, and `git worktree add ../agentboard-canonical-fold-impl events/canonical-fold`
   for later roles.
3. Run the three roles in order, each in its own worktree, on the same
   branch: test author (red tests + compile stubs only) -> implementer
   (green tests, no test edits) -> reviewer (different model; spec
   conformance, test quality, lint, coverage table).
4. `make check` must pass before the implementer hands off and again before
   the reviewer signs off; the reviewer states the `make check` result in
   the PR body (its report becomes the PR body).
5. Only the reviewer opens the PR against `staging`, after APPROVE or
   APPROVE WITH NITS and after both `make check` and `make check-in-docker`
   pass, with auto-merge enabled (`gh pr merge --auto --squash`); no
   approvals are required, so opening the PR is the merge decision.
6. Tick the completed tasks in `tasks.md` once the group has landed on
   `staging`.

### Orchestrator pattern (with a coordinator)

A coordinating instance holds the task list and, for each task group,
dispatches one agent per role in turn, each in its own worktree it creates
for that agent. The orchestrator never edits code itself and never lets two
agents share a worktree. Between dispatches it is the one that reads
`inbox`/board state (once the board exists) or `tasks.md` (until then) to
decide what is next. When a reviewer needs a second opinion, it reports
back to the orchestrator rather than spawning its own sub-agent; the
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

None found. Everything needed to start task group 1 that this document
found was recorded in the repository (README.md, CLAUDE.md,
CONTRIBUTING.md, docs/adr/, and the `add-board-core` change under
`openspec/changes/`). Anything not fully specified is listed below as a
GAP rather than assumed from outside knowledge.

## Gaps found during a cold-start read

None open. The six gaps found on 2026-09-23 (exported API definition,
branch naming per group, model assignment per role, who opens the PR,
definition of done, stale local staging) are closed in CONTRIBUTING.md
("Branch model", "Three-agent workflow per task group", "Models", "STOP
protocol", "Definition of done for a task group", "One worktree per
agent", "Pull requests"), in design.md ("Interfaces (sketch)") and in the
tasks.md preamble.
