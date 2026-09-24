# Contributing to agentboard

How work moves through this repository, for humans and coding agents alike.
Specs in `openspec/` define behavior; ADRs in `docs/adr/` record decisions.

## Branch model

- `main` is the release branch. It only ever receives pull requests from
  `staging`. GitHub rulesets cannot express "only from staging", so this is
  a rule of the project: a PR into `main` with any other head branch is
  closed unmerged.
- `staging` is the integration branch and the repository default. All work
  is opened as a PR into `staging`.
- Feature branches are named `<area>/<group-slug>`, one branch per task
  group of an OpenSpec change (for example `events/canonical-fold`,
  `store/sqlite-cache`, `cli/core-commands`). All three roles commit on
  that one branch, and follow-up rounds for the same group stay on it.
- Always `git fetch origin` first and cut branches from `origin/staging`,
  never from a local `staging` ref, which can be stale.
- Agents never commit or push to `main` or `staging` directly. Both branches
  are protected by rulesets: changes land only through a PR, force pushes
  and deletions are blocked.
- Feature-to-staging PRs are squash-merged, so each lands on `staging` as a
  single commit. Staging-to-main promotion PRs are merged with a merge
  commit and never squashed, so `main` stays a superset of `staging`'s
  commits and no back-merge PR from `main` into `staging` is ever needed.

## Three-agent workflow per task group

Each task group in an OpenSpec change's `tasks.md` is delivered by three
separate agents, in order, on the same feature branch. One agent per role.
An agent must not spawn sub-agents; a reviewer needing a second opinion
reports to the orchestrator, which spawns another reviewer with its own
worktree.

1. **Test author.** Writes tests from the spec deltas, `design.md` and the
   task group, covering the edge cases and failure modes the spec names. It
   defines the exported API of the group as compile-only stubs (types and
   function signatures throwing "not implemented") with full doc comments
   stating each contract; this first commit is the authoritative API for
   the group. `tasks.md` names files and behaviors, not signatures, by
   design. Red tests are expected at this stage. The test author does not
   implement behavior. Because the tests are red by design at hand-off, the
   test author runs the pre-push subset (`make build typecheck lint ascii
   validate-specs`), not the full `make check`; the full green suite is the
   implementer's and reviewer's obligation.
2. **Implementer.** Makes the tests green by writing production code. The
   implementer must not edit test files and must not change the stubs'
   signatures; a signature change goes through the STOP protocol below. If
   a test contradicts the spec, or cannot pass without violating it, the
   implementer stops and reports the conflict instead of working around it
   (see "STOP protocol").
3. **Reviewer.** Runs on a different model from the implementer, so the
   review is independent. It checks conformance to the spec scenarios, test
   quality (do the tests actually pin the behavior, would a wrong
   implementation still pass, are failure paths covered), lint cleanliness
   and the coverage table. It verifies golden files and recorded fixtures
   independently (recomputing at least one with a throwaway program that
   does not use the package under review) rather than trusting the values
   committed. Its report (`REVIEW.md`, uncommitted) is used as the PR body.
   Blocking findings go back to the implementer (code) or test author
   (tests). The verdict is one of APPROVE, APPROVE WITH NITS or REQUEST
   CHANGES.

`make check` must pass before the implementer hands off and again before
the reviewer signs off.

### Models

The test author and the implementer use the strongest model available.
The reviewer uses a different model from the implementer. For groups that
are security-critical or concurrency-critical the orchestrator may run a
second reviewer on the strongest model, in its own worktree. The PR body
records the model used for each role.

### STOP protocol

When the implementer finds that a test contradicts a spec requirement, is
internally inconsistent, or forces a change to an exported signature, it
stops, keeps its work committed locally, and reports the exact test, what
it asserts and why it is wrong. The orchestrator (or the human) rules. A
ruling is applied either by the test author, who changes the tests, or by
a spec delta (an OpenSpec change or an update to the change in progress),
never by bending the implementation to a wrong test. Rulings are recorded
in the PR body.

### Definition of done for a task group

A task group is done when all of its tasks are ticked in `tasks.md` with
accurate Verify lines, the branch has been reviewed and merged into
`staging`, and every decision taken during the group is recorded in a spec
delta or an ADR rather than only in a review, a ticket or a chat.

## One worktree per agent

Every agent (test author, implementer, reviewer, or any other) works in its
own git worktree. Agents may run from a directory other than this
repository's own checkout, so create a worktree explicitly rather than
assuming one, and fetch first so the branch is cut from the remote
`staging`, never from a stale local ref:

```
git fetch origin
git worktree add -b <area>/<group-slug> ../agentboard-<group-slug> origin/staging
```

For a branch that already exists on the remote (a later role joining a
group), use `git worktree add ../agentboard-<group-slug> <area>/<group-slug>`
after the fetch. Agents do not spawn sub-agents.

Never run `git checkout` or `git switch` in a checkout shared with another
running agent: a concurrent branch switch lands commits on the wrong branch
and corrupts history. The orchestrator removes stale worktrees with
`git worktree prune`.

## Coverage gate

`npm run test` runs vitest with coverage. Thresholds (statements, branches,
functions, lines) are set in `vitest.config.ts` and currently require 90%
across the board; a run that falls under any of them fails. To change a
threshold, edit `vitest.config.ts` in the same PR as the code that
motivates it and justify the change in the PR body. The reviewer pushes
back on lowering a threshold for convenience.

## Pull requests

- Every PR targets `staging` (release PRs target `main` from `staging`).
- Only the reviewer opens a feature PR, only after a verdict of APPROVE or
  APPROVE WITH NITS, and only after running `make check`,
  `make check-in-docker` and `make check-floor` (the oldest supported Node)
  to completion, with `REVIEW.md` (including all three results) as the PR
  body. Because no status checks are required, auto-merge
  fires as soon as the PR is opened: opening the PR is the merge decision.
  The one exception: test-only follow-ups on already-approved code may be
  opened by the test author.
- Feature-to-staging PRs are squash-merged; the PR title becomes the commit
  subject, so write it like one. Enable auto-merge when opening the PR
  (`gh pr merge --auto --squash`).
- Staging-to-main promotion PRs are merged with a merge commit (never
  squashed), so that `main` remains a superset of `staging`'s commit
  history. Enable auto-merge when opening the PR (`gh pr merge --auto --merge`).
- Auto-merge merges once all required checks are green; nobody merges
  manually around a red check.
- No approving review is required, so that agent PRs can merge on green. A
  human reviews `staging` periodically and before each release to `main`.
- Head branches are deleted automatically after merge.

## Commit messages

- Imperative mood, short subject ("Add event log writer for ticket
  creation"), then a body explaining what and why when not obvious.
- No attribution trailers of any kind (no `Co-authored-by`, no "Generated
  with" lines).
- Never commit secrets or plaintext fixtures that look like real project
  data.

## Docs

All docs, specs, ADRs and READMEs use plain ASCII only: no em dashes, no
curly quotes, no other special punctuation. Use `-` and straight quotes.
`make ascii` enforces this locally.

## Code style

TypeScript, strict mode, ESLint flat config with `typescript-eslint`
strict + stylistic rules. `@typescript-eslint/no-explicit-any` is an error:
do not use `any`; use a precise type, `unknown` with narrowing, or a
generic instead.

## OpenSpec

- Every behavior change starts with an OpenSpec change proposal under
  `openspec/changes/` (proposal, design where needed, spec deltas and
  tasks) before any implementation.
- After editing anything under `openspec/`, and always before pushing, run
  `make validate-specs` (which runs
  `npx --yes @fission-ai/openspec@latest validate --all --no-interactive`).
  Bare `validate` is a no-op when non-interactive.
- Tick tasks in `tasks.md` as task groups land.
- When every task in a change is complete and merged, archive the change so
  its deltas are folded into the main specs, in its own PR.

## Using agentboard in a project

This section is for host projects that coordinate their agents with
agentboard (including this repository, once it runs its own loop on the
board). See README.md for the full command reference.

- Run `agentboard init` once per clone, at the root of the main checkout.
  It creates `.board/` (its own git repository) and adds `.board/` to the
  project's `.gitignore`; commit that `.gitignore` entry. Linked worktrees
  find the main checkout's board on their own, so worktrees need no setup.
- The board never enters the host repository's history, so `make hooks`
  and the pre-push checks are unaffected: nothing under `.board/` is
  staged, linted or tested. Board history is synced separately with
  `agentboard sync`.
- Run `agentboard import-change <name> --as orchestrator` whenever a new
  OpenSpec change is merged into `staging`, and again whenever its
  `tasks.md` gains lines. It creates one ticket per task group; a second
  run creates nothing new and only appends new checklist lines.
- Coordination goes through the board, decisions go back into specs:
  agents claim their ticket, hand off with a note, and record decisions as
  `DECISION:` comments that are promoted to a spec delta or ADR before the
  ticket closes. Completion is still recorded by ticking `tasks.md` in the
  implementing PR, never by the board.
- Every agent passes `--as <role-instance>` (or sets `AGENTBOARD_ACTOR`);
  the board never guesses who is acting.

## Before you push

Run `make check` from the repository root (or `make check-in-docker` for
the pinned toolchain). It builds, typechecks, lints and tests.

## Verification is local (initial build)

GitHub Actions CI is not enabled while the project is being built. Nothing
runs automatically on push or on a PR.

Before every push, run `make check` (native), or `make check-in-docker` for
the pinned toolchain. The pre-push hook enforces the fast subset of this
(build, typecheck, lint, ascii, validate-specs; tests are not included in
the pre-push hook because they are slower, but are still required by
`make check` before finishing any task). Install the hook once per
clone/worktree with `make hooks`. Reviewers must run `make check` before
opening a PR and state the result in the PR body.

Because no status checks are required on `staging` or `main`, PRs
auto-merge immediately on open (0 approvals required). The reviewer's local
`make check` run is the only gate, so do not open a PR, and do not push,
without it passing.
