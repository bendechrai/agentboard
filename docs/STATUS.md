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
- No board functionality is implemented yet. `src/` contains no code under
  `src/events/` or `src/store/`; task group 1 (events, canonical JSON and
  fold) has not been started.

## What to do next

Start task group 1 (`openspec/changes/add-board-core/tasks.md`, section 1:
"Events, canonical JSON and fold") using the three-role loop from
CONTRIBUTING.md ("Three-agent workflow per task group"):

1. Fetch and update local `staging` (`git fetch origin staging:staging` or
   equivalent) before cutting anything from it -- a stale local `staging`
   ref will silently branch from an old commit.
2. Cut one feature branch per task group from the up-to-date `staging`
   (`<area>/<topic>` naming, e.g. `events/fold`), then create a worktree per
   agent from this directory:
   `git worktree add ../agentboard-events-fold events/fold`.
3. Run the three roles in order, each in its own worktree, on the same
   branch: test author (red tests + compile stubs only) -> implementer
   (green tests, no test edits) -> reviewer (different model; spec
   conformance, test quality, lint, coverage table).
4. `make check` must pass before the implementer hands off and again before
   the reviewer signs off; the reviewer states the `make check` result in
   the PR body (its report becomes the PR body).
5. Open the PR against `staging` with auto-merge enabled
   (`gh pr merge --auto --squash`); no approvals are required, so the
   reviewer's local `make check` run is the only gate.
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

- GAP: `src/events/{canonical,ulid,schema,hlc,fold}.ts` are named in
  tasks.md and their behavior is described in prose (design.md and the
  `board-events` spec delta), but no exported function signatures, type
  names or module exports are given. A test author has to invent the exact
  API shape before writing stubs, which the implementer might read
  differently. -> Should be documented as an "Interfaces" section in
  design.md, or the test author's first commit should be treated as the
  API proposal that the reviewer checks against the spec's behavior (not
  against a signature written down anywhere).
- GAP: No branch-naming convention ties a task group number to a branch
  name. CONTRIBUTING.md gives the `<area>/<topic>` pattern with generic
  examples (`cli/init`, `core/event-log`) but does not map tasks.md's nine
  groups to specific branch names. -> CONTRIBUTING.md, "Branch model", or a
  short table added to tasks.md itself.
- GAP: The reviewer is required to "run on a different model from the
  other two" but nothing records which models are used for which role, or
  how that assignment is made or enforced by an orchestrator. -> CONTRIBUTING.md,
  "Three-agent workflow per task group".
- GAP: It is not stated who opens the PR or when: whether the implementer
  opens it once tests are green and the reviewer only edits the body and
  merges, or whether the reviewer opens it after review, since auto-merge
  triggers immediately on open with no required checks. -> CONTRIBUTING.md,
  "Pull requests".
- GAP: "Done" for a task group is assembled from several sections
  (CONTRIBUTING.md's three-role loop and coverage gate, tasks.md's
  checkbox instruction) but is never stated as a single rule in one place.
  -> CONTRIBUTING.md or a short preamble note in tasks.md.
- GAP: A freshly created worktree can be cut from a stale local `staging`
  ref (this was observed directly while writing this document: the local
  `staging` branch was one commit behind `origin/staging` until fetched).
  CONTRIBUTING.md's "One worktree per agent" section does not say to
  fetch/update `staging` first. -> CONTRIBUTING.md, "One worktree per
  agent".
