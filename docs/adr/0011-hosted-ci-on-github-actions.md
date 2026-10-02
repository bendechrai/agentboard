# 11. Hosted CI on GitHub Actions

Date: 2026-10-02

## Status

Accepted

## Context

agentboard is public and accepts pull requests from forks. Its checks
(`make check`: build, typecheck, lint, tests with coverage, the ASCII check
and spec validation) run locally, enforced for the maintainer's own pushes
by the pre-push hook. Nothing runs them for a contributor who has not
installed the hook, and nothing records a result on a pull request.

The package supports Node 22.16 and later. `make check-floor` covers the
floor in Docker, but only when someone runs it, and no check covers the
newer Node release lines users install.

`main` takes pull requests only from `staging`. GitHub rulesets can require
a pull request and a merge method, but cannot restrict the head branch.

## Decision

- **A CI workflow** (`.github/workflows/ci.yml`) runs `make check` on every
  pull request, forks included, and on every push to `staging` and `main`.
  It runs on Node 22.16 (the engines floor) and on the latest 22, 24 and 26,
  with `fail-fast` off so one line's failure does not hide another's.
- **The checks are required** on `staging` and `main` by their rulesets, so a
  pull request merges only when every Node line passes.
- **A `promotion source` job** runs on pull requests into `main` and fails
  unless the head is `staging` in this repository. It is required on
  `main`, which turns the promotion rule into an enforced check.
- **Local checks stay.** `make check` before a pull request, the pre-push
  hook, `make check-in-docker` and `make check-floor` are unchanged, and the
  maintainer still runs the checks locally before merging a contribution.
  CI repeats them on a clean machine; it does not replace them.
- **Least privilege.** The workflow has read-only `contents` permission and
  no secrets, so it is safe to run on pull requests from forks. GitHub's
  approval for first-time contributors' workflow runs stays on.

## Consequences

- Every pull request shows a pass or fail result for each supported Node
  line, and a regression on the floor or a newer line is caught before it
  merges.
- A pull request waits for CI, a few minutes for the slowest Node line,
  before it can merge.
- A pull request into `main` from any branch other than `staging` cannot
  merge.
- Releasing to npm is decided separately: this workflow never publishes.
