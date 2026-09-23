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
- Feature branches are named `<area>/<topic>` (for example `cli/init`,
  `core/event-log`) and are cut from the current `staging`.
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
   adds only the minimum compile stubs (types, function signatures throwing
   "not implemented") needed for the tests to build. Red tests are expected
   at this stage. The test author does not implement behavior.
2. **Implementer.** Makes the tests green by writing production code. The
   implementer must not edit test files. If a test contradicts the spec, or
   cannot pass without violating it, the implementer stops and reports the
   conflict instead of working around it; the test author or a human
   resolves it, and the spec wins unless a change proposal says otherwise.
3. **Reviewer.** Runs on a different model from the other two. It checks
   conformance to the spec scenarios, test quality (do the tests actually
   pin the behavior, would a wrong implementation still pass, are failure
   paths covered), lint cleanliness and the coverage table. Its report is
   used as the PR body. Blocking findings go back to the implementer (code)
   or test author (tests).

`make check` must pass before the implementer hands off and again before
the reviewer signs off.

## One worktree per agent

Every agent (test author, implementer, reviewer, or any other) works in its
own git worktree. Agents may run from a directory other than this
repository's own checkout, so create a worktree explicitly rather than
assuming one:

```
git worktree add ../agentboard-<branch> <branch>
```

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
