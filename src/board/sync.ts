/**
 * `agentboard sync` (board-concurrency: "Sync converges"; board-cache:
 * "Cache is not synced"; design.md: "Git sync model"; risk "Host project
 * forgets `.board/` in its gitignore").
 *
 * The board directory is its own git repository (`initBoard` makes it one).
 * `sync` commits new event files, pulls with rebase from the board's
 * remote, pushes, and then folds whatever arrived into the cache. Event
 * files are add-only and named by the hash of their content, so two clones
 * never produce a conflicting change to the same event path; any conflict
 * git does report is handed to a human with exit 3.
 */

import type { Board } from '../store/board.js';
import { BoardError } from '../store/errors.js';
import type { Env } from './text.js';

/**
 * The fixed identity every git command run by `sync` is given (as
 * `-c user.name=<name> -c user.email=<email>`), so that `sync` commits and
 * rebases on a machine with no git identity configured, and so board
 * commits are recognisably machine-made. It is used for the commit `sync`
 * makes (author and committer) and as the committer of commits replayed by
 * `pull --rebase`; the user's own identity, if any, is never consulted.
 */
export const SYNC_IDENTITY = { name: 'agentboard', email: 'agentboard@localhost' } as const;

/**
 * Subject of the commit `sync` makes: `agentboard sync: <n> event file(s)`,
 * where `<n>` is the number of `events/*.json` paths added by the commit
 * (`file` when `n` is 1, `files` otherwise, including 0 for a commit that
 * only carries `.gitignore` or `events/.gitkeep`). No body.
 */
export function syncCommitMessage(eventFiles: number): string {
  void eventFiles;
  throw new Error('not implemented');
}

/** Options for `syncBoard`. */
export interface SyncOptions {
  /**
   * Environment for the git child processes. Defaults to `process.env`.
   * Whatever is given, `sync` removes the variables that would point git at
   * another repository (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
   * `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`,
   * `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_NAMESPACE`, `GIT_PREFIX`), so
   * running from inside a host git hook still syncs the board repository,
   * and sets `GIT_TERMINAL_PROMPT=0` so a remote needing credentials fails
   * instead of waiting for input.
   */
  env?: Env | undefined;
}

/** Result of `syncBoard`; also the `sync --json` document. */
export interface SyncResult {
  /** Absolute path of the board directory (`board.dir`). */
  dir: string;
  /**
   * Full hex id of the commit `sync` made, or null when nothing was staged
   * (no empty commit is ever made).
   */
  commit: string | null;
  /** Number of `events/*.json` files added by that commit (0 when `commit` is null). */
  committedEvents: number;
  /**
   * Name of the remote synced with, or null when the board repository has
   * no remote (the no-remote path).
   */
  remote: string | null;
  /** Current branch name (`main`, for example). */
  branch: string;
  /** True when a pull ran and completed (false on the no-remote path). */
  pulled: boolean;
  /** True when a push ran and completed (false on the no-remote path). */
  pushed: boolean;
  /**
   * True when this sync set the branch's upstream (`push -u`) because none
   * was configured.
   */
  upstreamSet: boolean;
  /**
   * Hashes (file names without `.json`) of the event files that the pull
   * brought into `events/` (present after the pull, absent before it),
   * ascending. Every one of them has been recorded in the cache by the
   * catch-up that ends `sync`, so the next command (for example `list`)
   * sees them without any further step.
   */
  arrived: string[];
  /**
   * True when that catch-up refolded the derived tables (an arrived event
   * sorted before the cache's last position), see `CatchUpReport.refolded`.
   */
  refolded: boolean;
  /**
   * Paths under the board directory that the host project's git repository
   * tracks, relative to the host repository's top level, forward slashes,
   * ascending (a gitlink entry for the board directory itself counts, as
   * `.board`). Empty when there is no host repository or it tracks nothing
   * there.
   */
  hostTracked: string[];
  /**
   * Plain ASCII warnings, one per problem, without the `agentboard: `
   * prefix. Currently at most one: when `hostTracked` is non-empty, a line
   * that contains the word `warning`, says the host repository tracks paths
   * under the board, names the first of them and the count, and tells the
   * user to untrack them (`git rm -r --cached <board path>`) and keep
   * `.board/` in the host `.gitignore`. A warning never changes the exit
   * code.
   */
  warnings: string[];
  /**
   * One or more human-readable ASCII lines (newline-separated, no trailing
   * newline) saying what happened: what was committed (or that nothing
   * was), then either `no remote configured` (literally, on the no-remote
   * path) or what was pulled (including the number of events that arrived)
   * and pushed.
   */
  message: string;
}

/**
 * `agentboard sync`. Every git command runs with the board directory as its
 * working directory, the environment described in `SyncOptions.env`, and
 * `-c user.name=<SYNC_IDENTITY.name> -c user.email=<SYNC_IDENTITY.email>
 * -c commit.gpgsign=false`; git is run with `execFileSync`, never a shell.
 *
 * Preconditions, checked before anything is staged:
 * 1. `git` can be run, else `BoardError(1, 'git-missing')`.
 * 2. The board directory is the top level of its own git repository (a
 *    board whose directory is not a repository, or which is only a
 *    subdirectory of the host repository, is refused rather than synced
 *    through the host): else `BoardError(2, 'board-not-a-repository')`
 *    naming the directory and saying `agentboard init` or `git init` there
 *    makes it one. Nothing is created.
 * 3. No rebase, merge or cherry-pick is in progress in the board
 *    repository (for example one left by an earlier conflicted sync), else
 *    `BoardError(3, 'sync-in-progress')` naming the directory and telling
 *    the human to finish it (`git rebase --continue`) or abort it
 *    (`git rebase --abort`) first. Nothing is staged or committed.
 * 4. HEAD is on a branch (possibly unborn), else
 *    `BoardError(3, 'detached-head')`.
 *
 * Steps:
 * 1. Stage: `git add --ignore-removal` of `events` (excluding temporary
 *    files, `events/.tmp-*`) and of `.gitignore` when it exists. Nothing
 *    else in the board directory is ever staged, so `cache.sqlite`,
 *    `cache.sqlite-wal` and `cache.sqlite-shm` are never committed even when
 *    `.gitignore` is missing or does not list them. Deletions are not
 *    staged: event files are add-only.
 * 2. Commit only when something is staged: one commit, message
 *    `syncCommitMessage(<events/*.json paths added>)`, hooks skipped
 *    (`--no-verify`). `commit` and `committedEvents` report it.
 * 3. Remote: the remote of the branch's configured upstream when there is
 *    one; otherwise `origin` when it exists; otherwise the only remote.
 *    With no remote at all this is the no-remote path: stop here and return
 *    with `remote: null`, `pulled` and `pushed` false, `arrived` empty and a
 *    message containing `no remote configured`. Exit 0. Several remotes, no
 *    upstream and no `origin`: `BoardError(1, 'ambiguous-remote')` naming
 *    them (after the commit).
 * 4. Pull: when the branch exists on the remote,
 *    `git pull --rebase --no-autostash <remote> <branch>`; when it does not
 *    (a fresh, empty remote), no pull. Before the pull `sync` lists
 *    `events/`; `arrived` is the set of event files present after the pull
 *    and not before.
 *    - When the pull stops on a conflict (any unmerged path, on any file,
 *      event file or not): the repository is left exactly as git left it
 *      (rebase in progress, conflicted paths unmerged) for a human to
 *      resolve; `sync` does not abort the rebase. Throws
 *      `BoardError(3, 'sync-conflict')` whose message names every unmerged
 *      path (relative to the board directory) and the board directory, and
 *      says to resolve them, `git add` them and `git rebase --continue` (or
 *      `git rebase --abort`), then run `agentboard sync` again.
 *    - When the pull fails for another reason (remote unreachable, refused,
 *      a tracked file with uncommitted changes blocking the rebase):
 *      `BoardError(3, 'sync-failed')` with git's first error line; the
 *      local commit from step 2 is kept.
 * 5. Push: `git push <remote> <branch>`, with `-u` when the branch had no
 *    upstream (`upstreamSet: true`). A rejected push (the remote moved
 *    between pull and push) is retried once from step 4; a second
 *    rejection, or any other push failure, is `BoardError(3,
 *    'sync-failed')`.
 * 6. Catch-up: `catchUp(board)`, so every arrived event is folded into the
 *    cache now (with a refold when one sorts before the last position).
 *
 * Host tracking check (on every path that returns, before step 1's result
 * is reported): `git ls-files -z --full-name -- <board dir>` run in the
 * parent of the board directory. When that directory is not inside a git
 * repository, or git fails, `hostTracked` is empty. When it lists paths,
 * `hostTracked` holds them and `warnings` the warning described there; sync
 * still succeeds.
 *
 * Never modifies the host repository. Never reads or prints the cache or
 * event contents.
 */
export function syncBoard(board: Board, options?: SyncOptions): SyncResult {
  void board;
  void options;
  throw new BoardError(1, 'not-implemented', 'agentboard sync is not implemented yet');
}
