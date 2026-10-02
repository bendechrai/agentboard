# Contributing to agentboard

Thanks for your interest in agentboard. This guide covers setting up a
development checkout, how changes are proposed and reviewed, and the
conventions the project follows. It applies to humans and coding agents
alike.

Specs in `openspec/` define behavior and are the source of truth. ADRs in
`docs/adr/` record design decisions. `docs/STATUS.md` is a short
orientation: what exists and what is planned next.

## Getting set up

You need Node 22.16 or later and `git`. Docker is optional, for the
pinned-toolchain checks below.

```
git clone https://github.com/bendechrai/agentboard.git
cd agentboard
npm ci
make hooks
make check
```

`make hooks` points git at the tracked `.githooks/` directory, so the
pre-push hook runs; run it once per clone and once per worktree.

To try your build as a command, run `npm link` in the checkout. It puts
`agentboard` on your PATH (for the Node version active at the time; run it
again after switching versions). See "Install and run" in README.md for
using a linked build in another project.

## Making a change

- **Bug fixes, docs and tests** that do not change specified behavior can
  go straight to a pull request.
- **Behavior changes** start with an OpenSpec change proposal under
  `openspec/changes/` (proposal, design where needed, spec deltas and
  tasks), merged before any implementation. If you are unsure whether
  something counts as a behavior change, open an issue first.
- **Design decisions** that are not themselves requirements are recorded
  as an ADR in `docs/adr/`.

After editing anything under `openspec/`, run `make validate-specs`
(`openspec validate --all --no-interactive`). When every task of a change
is merged, the change is archived in its own pull request, which folds its
deltas into the main specs.

## Branches and pull requests

- `staging` is the default branch and the integration branch. Every pull
  request targets `staging`.
- `main` is the release branch. It receives only promotion pull requests
  from `staging`, merged with a merge commit so `main` stays a superset of
  `staging`.
- Nobody pushes to `main` or `staging` directly; both are protected.
- Name branches `<area>/<slug>`, for example `store/sqlite-cache` or
  `docs/web-actions`. For an OpenSpec change, use one branch per task
  group.
- Pull requests into `staging` are squash-merged, and the PR title becomes
  the commit subject, so write it like one.
- In the PR description, say what changed and why, link the spec
  requirement or ADR it implements where there is one, and state the
  result of `make check`.

## Checks

Run the checks locally before you open a pull request. GitHub Actions
(`.github/workflows/ci.yml`) then runs `make check` on every pull request
and every push to `staging` and `main`, on the oldest supported Node and
each newer release line, and a pull request merges only when it passes. A
maintainer also runs the checks locally on every pull request before
merging it. Pull requests into `main` that do not come from `staging`
fail the `promotion source` check.

- `make check` builds, typechecks, lints, runs the tests with coverage,
  checks for non-ASCII bytes and validates the specs. It must pass before
  you open a pull request.
- `make check-in-docker` runs the same checks in the pinned toolchain
  container, and `make check-floor` runs them on the oldest supported Node.
  Run both for changes that touch the store, concurrency, process
  handling or the Node floor.
- The pre-push hook runs the fast subset (`make build typecheck lint ascii
  validate-specs`). Tests are left to `make check` because they are
  slower.
- Coverage thresholds are set in `vitest.config.ts` (90% for statements,
  branches, functions and lines). A change that lowers a threshold
  explains why in the PR description.

## Releasing

Releases are published to npm as `@bendechrai/agentboard` from `main`.

1. In a pull request into `staging`, bump the version in both
   `package.json` (`npm version <x.y.z> --no-git-tag-version`, which also
   updates `package-lock.json`) and `src/version.ts`. A test fails when the
   two differ.
2. Promote `staging` to `main`.
3. Publish from `main` and tag the release `v<x.y.z>`.

Until 1.0, a minor version may change commands, flags and output; a patch
version does not.

## Conventions

- **Commit messages:** imperative mood, a short subject ("Add event log
  writer for ticket creation"), and a body explaining what and why when it
  is not obvious. No attribution trailers (`Co-authored-by`, "Generated
  with" lines).
- **Plain ASCII** in all docs, specs, ADRs, READMEs and source: no em
  dashes, curly quotes or other special punctuation. `make ascii` enforces
  this.
- **TypeScript** in strict mode, linted with `typescript-eslint` strict and
  stylistic rules. `any` is an error: use a precise type, `unknown` with
  narrowing, or a generic.
- **Comments describe the code as it is.** Explain behavior and the reason
  for it in the present tense. How the code came to be belongs in commit
  messages, ADRs and archived OpenSpec changes, not in comments.
- **No secrets**, and no plaintext fixtures that look like real project
  data.

## Developing with coding agents

agentboard is built by coding agents, using the workflow below. You do not
need to follow it to contribute, but agent-driven contributions should, and
it is the workflow agentboard is designed to support.

### Three roles per task group

Each task group of an OpenSpec change's `tasks.md` is delivered by three
agents, in order, on the same branch:

1. **Test author.** Writes tests from the spec deltas, `design.md` and the
   task group, covering the edge cases and failure modes the spec names. It
   defines the group's exported API as compile-only stubs (types and
   function signatures that throw "not implemented") with doc comments
   stating each contract. Red tests are expected at this stage, so the test
   author runs the pre-push subset rather than the full `make check`.
2. **Implementer.** Makes the tests green with production code, without
   editing test files or changing the stubs' signatures. If a test
   contradicts the spec, or cannot pass without violating it, the
   implementer stops and reports the conflict (see "STOP protocol").
3. **Reviewer.** Runs on a different model from the implementer. It checks
   conformance to the spec scenarios, test quality (do the tests pin the
   behavior, would a wrong implementation still pass, are failure paths
   covered), lint and coverage. It recomputes at least one golden file or
   recorded fixture with a throwaway program that does not use the code
   under review. Its verdict is APPROVE, APPROVE WITH NITS or REQUEST
   CHANGES, and its report becomes the PR description.

The test author and implementer use the strongest model available. For
security-critical or concurrency-critical groups, a second reviewer on the
strongest model reviews independently. The PR description records the
model used for each role.

An orchestrator agent, if there is one, dispatches the roles in turn and
reads the board or `tasks.md` to decide what is next (see README.md, "The
orchestrator inbox protocol"). Agents do not spawn sub-agents; a reviewer
that wants a second opinion asks the orchestrator. Without an
orchestrator, one agent may play all three roles, sequentially and in
separate worktrees, committing each role's work before starting the next
and reviewing its own work as strictly as a different model would.

### STOP protocol

When the implementer finds that a test contradicts a spec requirement, is
internally inconsistent, or forces a change to an exported signature, it
stops, keeps its work committed, and reports the exact test, what it
asserts and why it is wrong. The orchestrator or a human rules, and the
ruling is applied by the test author changing the tests or by a spec
delta, never by bending the implementation to a wrong test.

### Definition of done for a task group

A task group is done when all of its tasks are ticked in `tasks.md` with
accurate Verify lines, the branch has been reviewed and merged into
`staging`, and every decision taken during the group is recorded in a spec
delta or an ADR rather than only in a review, a ticket or a chat.

### One worktree per agent

Every agent works in its own git worktree, so concurrent agents never
switch branches under each other. Worktrees live in a container folder
beside the checkout, `../agentboard.worktrees/`, one subfolder per
worktree named after its branch with `/` replaced by `-`. Keep them out of
the checkout itself, where vitest, tsc and eslint would see a second copy
of the project. Cut branches from the remote, which is never stale:

```
git fetch origin
git worktree add -b <area>/<slug> ../agentboard.worktrees/<area>-<slug> origin/staging
```

A later role joins an existing branch with
`git worktree add ../agentboard.worktrees/<area>-<slug>-<role> <area>/<slug>`.
Run `make hooks` in each new worktree, and remove the worktree with
`git worktree remove` once its branch is merged or abandoned.

### Coordinating on the board

This repository coordinates its own agents with agentboard:

- `agentboard init` once per clone, at the root of the main checkout,
  creates `.board/` (its own git repository, ignored by this one). Linked
  worktrees find it on their own.
- `agentboard import-change <name> --as orchestrator` creates one ticket
  per task group of a merged OpenSpec change; run it again when `tasks.md`
  gains lines.
- Agents claim their ticket, hand off with a note, and record decisions as
  `DECISION:` comments that are promoted to a spec delta or ADR before the
  ticket closes. Completion is recorded by ticking `tasks.md` in the
  implementing pull request, not on the board.
- Every agent passes `--as <role-instance>` (or sets `AGENTBOARD_ACTOR`).
- New agents start with `agentboard help agents --role <role>`, or the
  `agentboard://guide/<role>` resource over MCP.

The guidance in `.claude/skills/agentboard/SKILL.md` and
`openspec/config.yaml` is written by `agentboard agents install`. Do not
edit its managed regions by hand; run `agentboard agents check` after
upgrading and `agents install` again when it reports `stale`.

## License

By contributing, you agree that your contributions are licensed under the
MIT License (see LICENSE).
