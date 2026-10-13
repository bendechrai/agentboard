# 12. Board history in the host repository, under a hidden ref

Date: 2026-10-12

## Status

Accepted. Amends ADR 0001 and ADR 0005 (see Consequences).

## Context

ADR 0001 made the board an append-only event log in `.board/`, and the
board-events spec made `.board/` a git repository of its own so that its
history is versioned and synced independently of the host project. That
works, but sharing a board is manual: someone creates an empty repository,
runs `git -C .board remote add origin <url>`, and every other machine runs
`git clone <url> .board`. Most projects that use agentboard are git
repositories with a remote that every collaborator can already reach, with
access control already set up.

The board's history must still stay out of the project's own history:
board commits are machine-made, frequent, and of no interest to people who
do not use agentboard. They must not trigger CI, be subject to branch
protection, show up in branch lists or pull requests, or be fetched by
every contributor.

## Decision

For a project that is a git repository, the board's commits live in the
host repository's object store under the ref `refs/agentboard/board`, and
`.board/` is a linked worktree of the host repository on a detached HEAD,
still at the root of the main checkout and still ignored by the host
`.gitignore`. The namespace `refs/agentboard/*` is reserved for agentboard.
This is the default for new boards in a git project with git 2.32 or
later.

- Sharing needs no setup: the board travels over the host's existing
  remote and credentials. `agentboard init` in a second clone fetches the
  ref and creates the worktree; with no board on the remote it creates an
  empty board whose first commit is identical in every clone, and the
  first `sync` pushes it.
- `sync` commits as ADR 0005 says, fetches `refs/agentboard/board`,
  rebases onto it, pushes `HEAD:refs/agentboard/board` without force and
  retries once, with the same exit codes. agentboard updates the ref with a
  compare-and-swap after every step that moves HEAD, so the ref, not the
  worktree, keeps the history reachable.
- The worktree is locked so `git worktree prune` and `remove` leave it
  alone, and the host's git hooks never run for board commands.
- Standalone boards (a repository of their own) remain supported: outside
  a git repository, with `AGENTBOARD_DIR`, on older git, and on request with
  `agentboard init --remote <url>`, for example to keep the board out of a
  public project. Existing boards stay standalone until moved with
  `agentboard init --into-host`, which keeps their history.

## Rationale

A ref outside `refs/heads/` and `refs/tags/` is ordinary git: every server
stores and transfers it, `git gc` keeps what it points to, and it is
invisible to everything that works on branches. `git clone` and
`git fetch` without an explicit refspec only fetch branches and tags, so
contributors who do not use agentboard never download the board. CI
systems trigger on branch and tag pushes, branch protection and rulesets
match branches and tags, and stale-branch bots list branches, so none of
them see it. The board gets the host's access control for free, which is
also its main limit: anyone who can fetch the project can fetch the board.

A detached HEAD with agentboard moving the ref is used rather than a HEAD
that points at the ref or a local branch: the first is undocumented
porcelain behavior that a human's `git checkout` silently breaks, and the
second puts a branch in every branch list and in `git push --all`.

## Consequences

- ADR 0001's statement that `.board/` is its own git repository holds only
  for standalone boards. The event log, its file format and the fold are
  unchanged; only where the board's git history is stored changes.
- ADR 0005's commit rules apply unchanged to both models. Its refusal of a
  detached HEAD applies to standalone boards only; a host-model board is
  detached by design and `sync` instead refuses one that has a branch
  checked out.
- A host-model board needs git 2.32 or later (the oldest version on which
  `git worktree repair` fixes a host moved together with its `.board`).
  Older agentboard versions refuse to sync it, so every machine sharing it
  must upgrade.
- A board in a public repository is readable by anyone. Projects that need
  a private board use a separate repository (`init --remote`).
- `git push --mirror` from a stale clone can rewind the remote ref; other
  clones restore their events on their next `sync`.
- Hosts that restrict custom refs (Gerrit without a permission on the
  namespace) cannot hold a host-model board; such projects use a separate
  repository.
- The `.board` worktree appears in `git worktree list` and in tools that
  list worktrees, locked with the reason `agentboard board`.

## Alternatives considered

**A git submodule for `.board`.** Rejected: a submodule pins a commit in
the host's tree, so every `sync` would leave the host working tree dirty
(or need a host commit per sync), and it still needs a second repository
with its own URL and access setup.

**A real orphan branch (for example `agentboard`).** Rejected: pushes to
it trigger `on: push` CI, it is subject to branch protection and rulesets,
stale-branch bots and branch lists show it, people open pull requests
against it, and every contributor fetches it with a plain `git fetch`.

**git subtree.** Rejected: it merges the board's history into the host's
history, so board commits appear in the project's log and pull requests,
which is exactly what must not happen.

**A committed configuration file holding the board's remote URL.**
Rejected: it removes the per-clone `remote add`, but still needs a second
repository to create, host and grant access to, and puts tool
configuration into the project's tree.
