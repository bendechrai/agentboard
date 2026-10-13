/**
 * The host-model half of `agentboard init` (board-events: "Board directory
 * per project", "Board ref in the host repository"; board-cli:
 * "Initialising and joining a shared board"; add-board-sharing design.md:
 * decisions 2, 3 and 7): creating the deterministic empty board with
 * plumbing, finding or making `refs/agentboard/board` (local ref, else the
 * remote's, else a new empty board), adding and locking the `.board`
 * worktree, and repairing a board whose link to the host is broken.
 * `initBoard` in `src/board/init.ts` decides the model and calls these;
 * nothing here reads the cache or writes event files other than copying
 * them during a repair.
 *
 * Every git command runs through `gitRunner` with the sanitised environment
 * and the fixed identity, with the host's hooks disabled (board-events
 * "Board ref in the host repository": hooks never run for the board).
 */

import type { GitRunnerOptions } from './git.js';

/** The reason the board worktree is locked with (`git worktree lock --reason`). */
export const WORKTREE_LOCK_REASON = 'agentboard board';

/** The message of the deterministic empty-board commit. */
export const EMPTY_BOARD_COMMIT_MESSAGE = 'agentboard: empty board';

/**
 * The directory agentboard keeps under the host's git common directory
 * (`<git common dir>/agentboard/`) for temporary worktrees and kept-aside
 * board directories. Inside the git directory, so the host's `git status`
 * never shows it and nothing can `git add` it.
 */
export const AGENTBOARD_GIT_SUBDIR = 'agentboard';

/** The name of the temporary worktree a repair builds under `AGENTBOARD_GIT_SUBDIR`. */
export const REPAIRING_WORKTREE = 'repairing';

/** The prefix of a kept-aside board directory: `stale-board-<UTC timestamp>`. */
export const STALE_BOARD_PREFIX = 'stale-board-';

/** Options of every function in this module. */
export type HostInitOptions = Pick<GitRunnerOptions, 'env'>;

/**
 * The name of a kept-aside board directory for the moment `now`:
 * `stale-board-` followed by the UTC time as `YYYYMMDDTHHMMSSZ` (so
 * `stale-board-20261012T153000Z` for 2026-10-12 15:30:00 UTC), plain
 * ASCII, no separators other than `T` and `Z`, sortable by time. Pure.
 */
export function staleBoardName(now: Date): string {
  void now;
  throw new Error('not implemented');
}

/**
 * Writes the deterministic empty-board commit (board-events "Board ref in
 * the host repository"; design.md decision 2) into the object store of the
 * repository at `hostDir` with plumbing only, and returns its id:
 * `git hash-object -w` of `.gitignore` holding `BOARD_GITIGNORE_LINES` (one
 * per line, each followed by a newline) and of the empty `events/.gitkeep`,
 * `git mktree` for `events` and for the root (`.gitignore` as mode 100644,
 * `events` as a tree), then `git commit-tree` with no parent, author and
 * committer `GIT_IDENTITY` at `@0 +0000` (1970-01-01T00:00:00Z) and the
 * message `EMPTY_BOARD_COMMIT_MESSAGE`. The id is the same in every
 * repository (`7d5236e13b813df769a361c585f25a01259b020a` for SHA-1
 * repositories). Creates no ref: the caller does with a create-only
 * `update-ref`. Safe to call again: git writes the same objects.
 *
 * @throws the git child process error when a plumbing command fails.
 */
export function writeEmptyBoardCommit(hostDir: string, options?: HostInitOptions): string {
  void hostDir;
  void options;
  throw new Error('not implemented');
}

/** Where `ensureBoardRef` found the history it put under `BOARD_REF`. */
export type BoardRefSource = 'local' | 'remote' | 'created';

/** Result of `ensureBoardRef`. */
export interface BoardRefOutcome {
  /** The full hex id `BOARD_REF` points to when the function returns. */
  readonly commit: string;
  /**
   * `local` when the ref already existed (nothing was fetched, the remote
   * was not contacted); `remote` when it was fetched from `remote`
   * (joining the shared board); `created` when a new empty board was
   * written (the remote has no board, is unreachable, or there is none).
   */
  readonly source: BoardRefSource;
  /**
   * Plain ASCII lines, without the `agentboard: ` prefix. One line when the
   * remote could not be reached: it names the remote and says the next
   * `agentboard sync` joins any board there. Empty otherwise.
   */
  readonly warnings: readonly string[];
}

/**
 * Finds or makes `BOARD_REF` in the repository at `hostDir` (design.md
 * decision 7, "find or make the ref"), in this order:
 *
 * 1. The local ref exists (`git rev-parse --verify refs/agentboard/board`):
 *    source `local`; the remote is not contacted, whatever it holds.
 * 2. Else, when `remote` is not null:
 *    `git ls-remote <remote> refs/agentboard/board`. When it lists the ref,
 *    `git fetch --no-tags <remote> refs/agentboard/board:refs/agentboard/board`
 *    (into the local ref, no remote-tracking ref): source `remote`. When
 *    it lists nothing, step 3. When `ls-remote` fails (the remote cannot be
 *    reached): step 3 with the warning described in `BoardRefOutcome`.
 * 3. Else `writeEmptyBoardCommit` and
 *    `git update-ref refs/agentboard/board <commit> ""` (the empty old
 *    value means create-only): source `created`. When that `update-ref`
 *    fails because another process created the ref in between, the ref is
 *    read again and used as in step 1 (source `local`).
 *
 * Never pushes. Never creates a branch or tag. Runs no command in a
 * worktree, so it works before `.board` exists.
 */
export function ensureBoardRef(
  hostDir: string,
  remote: string | null,
  options?: HostInitOptions,
): BoardRefOutcome {
  void hostDir;
  void remote;
  void options;
  throw new Error('not implemented');
}

/**
 * Makes `dir` (`<hostDir>/.board`) the locked board worktree of the
 * repository at `hostDir`, on a detached HEAD at `BOARD_REF` (design.md
 * decision 2), idempotently:
 *
 * - When `dir` is not a registered worktree:
 *   `git worktree add --detach <dir> refs/agentboard/board`.
 * - When `dir` is registered (`git worktree list --porcelain` has an entry
 *   whose path is exactly `dir`, compared as realpaths) but the directory
 *   is missing (deleted with `rm -rf`, prunable or locked):
 *   `git worktree add -f -f --detach <dir> refs/agentboard/board`, and only
 *   then; a registered entry at another path is never forced.
 * - When `dir` is registered and present: nothing is added. A worktree
 *   with a branch checked out is left as it is (`sync` refuses it with
 *   `board-on-branch`).
 * - Then `git worktree lock --reason "agentboard board" <dir>` unless the
 *   entry is already locked (any reason).
 * - Then, when sparse checkout is enabled in the host
 *   (`core.sparseCheckout` true for the new worktree),
 *   `git -C <dir> sparse-checkout disable`, so every event file is checked
 *   out.
 *
 * A failure of `worktree add` because another process added the worktree
 * in between is not an error when the entry is then found registered at
 * `dir`. `.board/events` appears only with the checkout, so a half-made
 * board is never mistaken for a board.
 *
 * @throws BoardError exit 1, reason `git-missing`, when git cannot be run;
 *   otherwise the git child process error of a failing command.
 */
export function addBoardWorktree(hostDir: string, dir: string, options?: HostInitOptions): void {
  void hostDir;
  void dir;
  void options;
  throw new Error('not implemented');
}

/** How `repairBoardLink` repaired the board. */
export type RepairMethod = 'worktree-repair' | 'fresh-worktree';

/** Result of `repairBoardLink`; also `InitResult.repair`. */
export interface RepairOutcome {
  /**
   * `worktree-repair` when `git worktree repair` alone fixed the link (a
   * host moved together with its `.board`): nothing was copied or kept
   * aside. `fresh-worktree` when a new worktree was built and moved into
   * place.
   */
  readonly method: RepairMethod;
  /**
   * Event file names (`<hash>.json`, ascending) copied from the old
   * directory into the fresh worktree's `events/` because it lacked them.
   * Empty for `worktree-repair`.
   */
  readonly copied: readonly string[];
  /**
   * Event file names (ascending) of the old directory that were not copied
   * because their content does not hash to their name (a file whose name
   * is not `<64 hex>.json` counts). Each is also reported as a warning.
   * Empty for `worktree-repair`.
   */
  readonly skipped: readonly string[];
  /**
   * Absolute path of the kept old directory,
   * `<host git common dir>/agentboard/stale-board-<UTC timestamp>`
   * (`staleBoardName`), for `fresh-worktree`; null for `worktree-repair`.
   */
  readonly keptAt: string | null;
  /**
   * Where the fresh worktree's history came from (`ensureBoardRef`), for
   * `fresh-worktree`; null for `worktree-repair`.
   */
  readonly source: BoardRefSource | null;
}

/**
 * Repairs the board directory `dir` (`<hostDir>/.board`) whose model is
 * `broken-host-link` or `not-a-repository` (board-cli "Initialising and
 * joining a shared board"; design.md decision 7), with `remote` the
 * remote chosen in the host repository (null when there is none):
 *
 * 1. For `broken-host-link` only: `git worktree repair <dir>` in `hostDir`.
 *    When `detectBoardModel(dir)` is then `host`, the repair is done:
 *    method `worktree-repair`, nothing copied, nothing kept aside, and the
 *    worktree is locked when it is not.
 * 2. Otherwise a fresh worktree: `ensureBoardRef(hostDir, remote)` (the
 *    local ref, else the remote's, else a new empty board), then
 *    `git worktree add --detach <git common dir>/agentboard/repairing refs/agentboard/board`
 *    (a leftover `repairing` worktree or directory from an interrupted
 *    repair is removed first). Every `events/<name>.json` of the old
 *    directory that the fresh worktree lacks is copied in when its content
 *    hashes (SHA-256, lower-case hex) to `<name>`; one that does not is
 *    skipped and reported; event files are content-addressed, so a copy
 *    never changes an existing event. Then the old directory is renamed to
 *    `<git common dir>/agentboard/<staleBoardName(now)>` (same file system,
 *    one rename), the fresh worktree is moved into place with
 *    `git worktree move <repairing> <dir>`, locked with
 *    `WORKTREE_LOCK_REASON`, and sparse checkout is disabled as
 *    `addBoardWorktree` does. Copied files are left uncommitted for the
 *    next `sync`. Method `fresh-worktree`.
 *
 * The old directory is never deleted and never modified. The cache file
 * and its companions in the old directory are not copied. Never pushes.
 *
 * @throws BoardError exit 1, reason `git-missing`, when git cannot be run;
 *   otherwise the git child process error of a failing command (the old
 *   directory is then still in place, untouched).
 */
export function repairBoardLink(
  hostDir: string,
  dir: string,
  remote: string | null,
  options?: HostInitOptions,
): RepairOutcome {
  void hostDir;
  void dir;
  void remote;
  void options;
  throw new Error('not implemented');
}
