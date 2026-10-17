# Proposal

## Why

Sharing a board between machines is half built. `sync` exists, but getting
two clones onto one board is manual git: create an empty repository
somewhere, `git -C .board remote add origin <url>`, then
`git clone <url> .board` on every other machine. Most projects that use
agentboard are already git repositories with a remote that every
collaborator can reach, so the board can ride along with the project's own
remote and access control, with no second repository and no setup at all.

## What Changes

- **Board in the host repository (the default for new boards in a git
  project).** The board's commits live in the host repository's own object
  store under the hidden ref `refs/agentboard/board` (the namespace
  `refs/agentboard/*` is reserved for agentboard). It is not a branch: no
  CI push triggers, no branch protection, no branch-list noise, and
  `git clone` and `git fetch` without an explicit refspec never fetch it, so
  contributors who do not use agentboard never see it. `.board/` becomes a
  linked git worktree of the host repository, on a detached HEAD, still at
  the root of the main checkout and still ignored by the host `.gitignore`.
- **`init` joins an existing board.** On a second clone, `agentboard init`
  finds `refs/agentboard/board` on the host's remote, fetches it, creates
  the worktree and folds the events. When the remote has no board (or there
  is no remote), it creates a new empty board whose first commit is
  identical in every clone; the first `sync` pushes the ref.
- **`sync` in the host model** commits as today (ADR 0005), fetches
  `refs/agentboard/board` from the host's remote, rebases onto it, pushes
  `HEAD:refs/agentboard/board` and retries once when rejected, with the
  same exit codes and conflict handling. Remote selection keeps today's
  rules (upstream, then `origin`, then the only remote), applied to the
  host repository and the branch of its main checkout, with a new override
  `git config agentboard.remote <name>` for repositories with several
  remotes.
- **Standalone boards stay supported**, unchanged for every board that
  exists today. They are what `init` creates outside a git repository, with
  `AGENTBOARD_DIR`, on a git older than the host model's floor (2.32), and
  with the new `agentboard init --remote <url>`, which keeps the board in a
  separate repository (for example to keep it out of a public project):
  it clones an existing board, or initialises and pushes to an empty
  remote, creates a missing local path as a bare repository first, and
  tells the user to create the repository when a non-local URL does not
  exist. On an existing standalone board without a remote it sets the
  remote and syncs.
- **Migration:** `agentboard init --into-host` moves a standalone board
  into the host repository, keeping its whole history. It refuses while the
  standalone board has events that are not committed or not pushed, keeps
  the old repository until the move has succeeded, and is safe to run
  again.
- **New `agentboard remote` command** shows which model the board uses,
  where its history lives, and the remote `sync` would use and why. It is
  read-only and never contacts the network.
- `init` repairs a host-model `.board` whose link to the host repository is
  broken (the host was moved, or a stale `.board` was copied into a fresh
  clone), carrying over every event file.
- `remote` joins `init` and `sync` in the commands left out of the MCP tool
  list.
- README ("Sync between machines", "Set up a project"), CONTRIBUTING.md,
  the landing site and the agent guide's list of excluded MCP commands are
  updated. A new ADR (0012) records the decision and amends ADR 0001.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `board-events`: "Board directory per project" (two sharing models, what
  `init` creates where); new requirements for the board ref in the host
  repository and for detecting a board's model.
- `board-concurrency`: "Sync converges" covers both models and the remote
  override; a new requirement that moving a board into the host repository
  loses no event, including when several clones move.
- `board-cli`: "Command surface" (`init --remote`, `init --into-host`,
  `remote`), "MCP server" (`remote` excluded); new requirements for `init`
  setting up and joining a shared board, `init --remote`,
  `init --into-host` and the `remote` command.

## Non-Goals

- Moving a board out of the host repository into a separate one.
- Several boards per project, or a configurable ref name.
- Sharing over anything but git, or any hosted service.
- Changing how events are written, folded or cached.
- Rewriting or compacting board history.

## Impact

- `src/board/init.ts` (both models, join, repair, `--remote`,
  `--into-host`), `src/board/sync.ts` (model detection, host-model sync,
  remote override), a new shared git module and the `remote` command under
  `src/board/`, `src/cli/registry.ts`, `src/mcp/tools.ts`,
  `src/guidance/hints.ts` and `src/guidance/guide.ts`.
- Compatibility: existing standalone boards and their `sync` are
  unchanged. A host-model board needs git 2.32 or later; agentboard
  versions without this change see a host-model `.board` as a board but
  their `sync` refuses it (exit 3 `detached-head`), so every machine
  sharing a host-model board must upgrade.
- Overlaps `add-harness-integration` (`init [--agents | --no-agents]`,
  `hook`) and `add-claim-leases` on `board-cli` "Command surface" and "MCP
  server"; see tasks.md.
- README.md, CONTRIBUTING.md, docs/index.html, STATUS.md, a new ADR.
- No new runtime dependency.
