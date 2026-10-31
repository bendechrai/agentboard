/**
 * `agentboard sync` (board-concurrency: "Sync converges"; board-cache:
 * "Cache is not synced"; add-board-core design.md: "Git sync model"; risk "Host project
 * forgets `.board/` in its gitignore").
 *
 * A standalone board directory is its own git repository (`initBoard`
 * makes it one outside a git host). `sync` commits new event files, pulls
 * with rebase from the board's remote, pushes, and then folds whatever
 * arrived into the cache. Event files are add-only and named by the hash
 * of their content, so two clones never produce a conflicting change to
 * the same event path; any conflict git does report is handed to a human
 * with exit 3. The board's model is decided by `detectBoardModel`
 * (board-events "Board model detection"): a host-model board (a worktree
 * of the host repository at `refs/agentboard/board`) is synced by
 * `syncHostBoard` (`src/board/host-sync.ts`) through that ref, and one
 * whose link to the host is broken is refused with exit 2 before anything
 * is staged. The standalone path below is unchanged by the host model; the
 * steps both models share (the preconditions, the commit of ADR 0005, the
 * host tracking warning) live in `src/board/sync-steps.ts`.
 */

import type { Board } from '../store/board.js';
import { catchUp } from '../store/cache.js';
import { BoardError } from '../store/errors.js';
import {
  GIT_IDENTITY,
  gitRunner,
  isGitFailure,
  withoutUserinfo,
  type GitRunner,
} from './git.js';
import { syncHostBoard } from './host-sync.js';
import { detectBoardModel, type BoardModelInfo } from './model.js';
import { ambiguousRemoteError, chooseRemote } from './remote.js';
import {
  checkCommittedEventsPresent,
  checkNothingForeignStaged,
  checkNothingInProgress,
  eventFileNames,
  hostTrackedPaths,
  hostWarning,
  plural,
  stageAndCommit,
  syncCommitMessage,
  syncFailed,
  unmergedPaths,
} from './sync-steps.js';
import { asciiText, type Env } from './text.js';

export { syncCommitMessage };

/**
 * The fixed identity every git command run by `sync` is given (as
 * `-c user.name=<name> -c user.email=<email>`), so that `sync` commits and
 * rebases on a machine with no git identity configured, and so board
 * commits are recognisably machine-made. It is used for the commit `sync`
 * makes (author and committer) and as the committer of commits replayed by
 * `pull --rebase`; the user's own identity, if any, is never consulted.
 * The same value as `GIT_IDENTITY`, which every git command of agentboard
 * uses.
 */
export const SYNC_IDENTITY: typeof GIT_IDENTITY = GIT_IDENTITY;

/** Options for `syncBoard`. */
export interface SyncOptions {
  /**
   * Environment for the git child processes. Defaults to `process.env`.
   * Whatever is given, the git runner (`gitRunner` in `src/board/git.ts`)
   * removes the variables that would point git at another repository
   * (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`,
   * `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`,
   * `GIT_NAMESPACE`, `GIT_PREFIX`), so running from inside a host git hook
   * still syncs the board repository, and sets `GIT_TERMINAL_PROMPT=0` so a
   * remote needing credentials fails instead of waiting for input.
   */
  env?: Env | undefined;
}

/** The sharing model a `sync` ran under (`detectBoardModel`: `host` or `standalone`; the other two models are refused). */
export type SyncModel = 'host' | 'standalone';

/** Result of `syncBoard`; also the `sync --json` document. */
export interface SyncResult {
  /** Absolute path of the board directory (`board.dir`). */
  dir: string;
  /**
   * The model the board was synced as: `standalone` (a repository of its
   * own, pulled and pushed on its branch) or `host` (a worktree of the host
   * repository, synced through `refs/agentboard/board`; see
   * `syncHostBoard`).
   */
  model: SyncModel;
  /**
   * The ref that holds the board's history in the host repository,
   * `refs/agentboard/board`, for a host-model board; null for a standalone
   * board (its history is `branch`).
   */
  ref: string | null;
  /**
   * Host model: the full hex id `refs/agentboard/board` holds when sync
   * returns, which equals the worktree's HEAD (board-events "Board ref in
   * the host repository"), on every path that returns, including the
   * no-remote path and a sync that committed nothing. Null for a
   * standalone board.
   */
  refCommit: string | null;
  /**
   * Full hex id of the commit on the branch that contains the events sync
   * committed, as it is when sync returns: after any `pull --rebase` has
   * replayed the local commit onto what arrived, this is the replayed
   * commit, not the one made in step 2 (in the divergent clones scenario it
   * equals the board repository's HEAD after sync). Null when sync
   * committed nothing (no empty commit is ever made).
   */
  commit: string | null;
  /** Number of `events/*.json` files added by that commit (0 when `commit` is null). */
  committedEvents: number;
  /**
   * Name of the remote synced with, or null when the board repository has
   * no remote (the no-remote path).
   */
  remote: string | null;
  /**
   * Standalone: the current branch name (`main`, for example). Host model:
   * null (the worktree is on a detached HEAD by design; a branch checked
   * out there is refused with `board-on-branch`).
   */
  branch: string | null;
  /**
   * Standalone: true when a pull ran and completed. Host model: true when
   * the fetch found `refs/agentboard/board` on the remote and its history
   * was integrated (whether or not anything new arrived). False on the
   * no-remote path, and when the remote has no board ref yet.
   */
  pulled: boolean;
  /** True when a push ran and completed (false on the no-remote path). */
  pushed: boolean;
  /**
   * True when this sync set the branch's upstream (`push -u`) because none
   * was configured. Always false for a host-model board, which never
   * creates or moves a branch and sets no upstream.
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
 * working directory, through `gitRunner` with the environment described in
 * `SyncOptions.env` and the fixed prefix
 * `-c user.name=<SYNC_IDENTITY.name> -c user.email=<SYNC_IDENTITY.email>
 * -c commit.gpgsign=false`; git is run with `execFileSync`, never a shell.
 *
 * Preconditions, checked before anything is staged:
 * 1. `git` can be run, else `BoardError(1, 'git-missing')`.
 * 2. The board's model (`detectBoardModel`) is not a broken host link:
 *    else `BoardError(2, 'board-link-broken')` naming the directory, what
 *    is wrong with the link and that `agentboard init` repairs it. Then
 *    the board directory is the top level of a git repository or worktree
 *    (a board whose directory is not a repository, or which is only a
 *    subdirectory of the host repository, is refused rather than synced
 *    through the host): else `BoardError(2, 'board-not-a-repository')`
 *    naming the directory and saying `agentboard init` or `git init` there
 *    makes it one. Nothing is created. A host-model board stops here and
 *    continues in `syncHostBoard`, whose preconditions and steps replace
 *    the rest of this list (its result has `model` `host`).
 * 3. No rebase, merge or cherry-pick is in progress in the board
 *    repository (for example one left by an earlier conflicted sync), else
 *    `BoardError(3, 'sync-in-progress')` naming the directory and telling
 *    the human to finish it (`git rebase --continue`) or abort it
 *    (`git rebase --abort`) first. Nothing is staged or committed.
 * 4. HEAD is on a branch (possibly unborn), else
 *    `BoardError(3, 'detached-head')` (standalone boards only, ADR 0012: a
 *    host-model board is detached by design).
 * 5. Every event file recorded in HEAD's tree (`events/<hash>.json`) is
 *    present in `events/` (board-concurrency scenario "Deleted event file
 *    is not synced"). Otherwise nothing is staged, committed, pulled or
 *    pushed and `BoardError(5, 'integrity')` is thrown, naming every missing
 *    file (as `events/<name>`) and how to restore them
 *    (`git -C <board dir> checkout -- events/<name>`). Event files are
 *    add-only, so a deletion is never propagated.
 *
 * Steps:
 * 1. Stage: `git add --ignore-removal` of `events` (excluding temporary
 *    files, `events/.tmp-*`) and of `.gitignore` when it exists. Nothing
 *    else in the board directory is ever staged, so `cache.sqlite`,
 *    `cache.sqlite-wal` and `cache.sqlite-shm` are never committed even when
 *    `.gitignore` is missing or does not list them. Deletions are never
 *    staged (a missing committed event file already stopped sync at
 *    precondition 5).
 * 2. Commit only when something is staged under sync's own paths (the
 *    same pathspec as step 1: `events` excluding `events/.tmp-*`, and
 *    `.gitignore`): one commit, limited by that pathspec
 *    (`git commit -- <pathspec>`), message
 *    `syncCommitMessage(<events/*.json paths added>)`, hooks skipped
 *    (`--no-verify`). Anything else already staged in the board repository
 *    (a stray file, a modification of another tracked file) is neither
 *    committed nor pushed by sync and is still staged afterwards; when only
 *    such content is staged, no commit is made. `committedEvents` counts
 *    the event files of this commit.
 * 3. Remote: `chooseRemote` for the board repository and its branch
 *    (board-concurrency "Sync converges"): the remote named by
 *    `git config agentboard.remote` when set; else the remote of the
 *    branch's configured upstream when there is one (an upstream remote of
 *    `.` is ignored); otherwise `origin` when it exists; otherwise the only
 *    remote. With no remote at all this is the no-remote path: stop here
 *    and return with `remote: null`, `pulled` and `pushed` false, `arrived`
 *    empty and a message containing `no remote configured`. Exit 0. Several
 *    remotes and none chosen: `ambiguousRemoteError`, exit 1
 *    `ambiguous-remote` naming them and `git config agentboard.remote
 *    <name>` (after the commit). A configured remote that the repository
 *    does not have is used as named, so reaching it fails with exit 3.
 * 4. Pull: first, when anything is still staged after step 2 (content
 *    sync does not commit), `BoardError(3, 'sync-failed')` naming those
 *    paths and saying to commit or unstage them in the board repository;
 *    nothing is pulled or pushed and they stay staged. Then, when the
 *    branch exists on the remote,
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
 *    upstream at all (`upstreamSet: true`; a branch whose upstream another
 *    rule overrode keeps its upstream). Push hooks are not skipped. A rejected
 *    push (the remote moved between pull and push) is retried once from
 *    step 4, so what arrived in between is pulled, reported in `arrived`
 *    and folded; a second rejection, or any other push failure, is
 *    `BoardError(3, 'sync-failed')`.
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
  const env = options?.env ?? process.env;
  const git = gitRunner(board.dir, { env });
  const dir = board.dir;

  // Preconditions.
  try {
    git.run('--version');
  } catch {
    throw new BoardError(
      1,
      'git-missing',
      'agentboard sync needs git (the board is a git repository of its own), but git could not be run',
    );
  }
  const info = checkRepository(dir, env);
  if (info.model === 'host') {
    return syncHostBoard(board, info, options);
  }
  checkNothingInProgress(git, dir);
  const branch = currentBranch(git);
  checkCommittedEventsPresent(git, board);

  const hostTracked = hostTrackedPaths(git, dir);
  const warnings = hostTracked.length > 0 ? [hostWarning(dir, hostTracked)] : [];

  // 1. Stage. 2. Commit when something is staged.
  const { commit, committedEvents } = stageAndCommit(git, board);
  const committedLine = (id: string | null): string =>
    id === null
      ? 'nothing new to commit'
      : `committed ${plural(committedEvents, 'event file')} (${id.slice(0, 12)})`;
  const lines = [committedLine(commit)];
  const base = {
    dir,
    model: 'standalone' as const,
    ref: null,
    refCommit: null,
    commit,
    committedEvents,
    branch,
    hostTracked,
    warnings,
  };

  // 3. Remote.
  const choice = chooseRemote(dir, branch, { env });
  if (choice.ambiguous) {
    throw ambiguousRemoteError(choice);
  }
  const remote = choice.chosen?.name ?? null;
  if (remote === null) {
    lines.push(`no remote configured; the board repository at ${dir} was not pulled or pushed`);
    return {
      ...base,
      remote: null,
      pulled: false,
      pushed: false,
      upstreamSet: false,
      arrived: [],
      refolded: false,
      message: lines.join('\n'),
    };
  }

  // 4. Pull and 5. push, retried once when the push is rejected.
  checkNothingForeignStaged(git, dir);
  const before = new Set(eventFileNames(board));
  const upstreamSet = !hasUpstream(git, branch);
  let pulled = false;
  for (let attempt = 1; ; attempt += 1) {
    if (remoteHasBranch(git, remote, branch)) {
      pull(git, dir, remote, branch);
      pulled = true;
    }
    if (push(git, remote, branch, upstreamSet, attempt === 2)) {
      break;
    }
  }
  const arrived = eventFileNames(board)
    .filter((name) => !before.has(name))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();

  // 6. Catch-up.
  const report = catchUp(board);
  // A rebase replays the local commit: report the commit on the branch now.
  const onBranch = commit === null ? null : git.run('rev-parse', 'HEAD').trim();

  // A remote named by URL (`agentboard.remote`, `branch.<b>.remote`) is
  // shown without its user information; git was given the name as it is.
  const shown = withoutUserinfo(remote);
  lines.push(
    pulled
      ? `pulled ${branch} from ${shown}: ${plural(arrived.length, 'event')} arrived`
      : `${shown} has no branch ${branch} yet; nothing to pull`,
  );
  lines.push(`pushed ${branch} to ${shown}${upstreamSet ? ' and set it as the upstream' : ''}`);
  lines[0] = committedLine(onBranch);
  return {
    ...base,
    commit: onBranch,
    remote: shown,
    pulled,
    pushed: true,
    upstreamSet,
    arrived,
    refolded: report.refolded,
    message: lines.join('\n'),
  };
}

/**
 * Precondition 2: the board's link to the host is not broken, and the
 * board directory is the top level of a repository or worktree. Returns
 * what `detectBoardModel` found (`host` or `standalone`). `init --remote`
 * refuses an existing board the same way.
 */
export function checkRepository(dir: string, env: Env): BoardModelInfo {
  const info = detectBoardModel(dir, { env });
  if (info.model === 'broken-host-link') {
    throw new BoardError(
      2,
      'board-link-broken',
      `the board at ${dir} is a worktree of the host repository whose link is broken ` +
        `(${info.detail ?? 'the link cannot be read'}); run agentboard init to repair it`,
    );
  }
  if (info.model === 'not-a-repository') {
    throw new BoardError(
      2,
      'board-not-a-repository',
      `the board at ${dir} is not a git repository of its own; run agentboard init ` +
        `(or git init in ${dir}) to make it one`,
    );
  }
  return info;
}

/** Precondition 4: HEAD is on a branch, possibly unborn. */
function currentBranch(git: GitRunner): string {
  const ref = git.attempt('symbolic-ref', '--quiet', '--short', 'HEAD');
  if (isGitFailure(ref)) {
    throw new BoardError(
      3,
      'detached-head',
      'the board repository has a detached HEAD; check out a branch (git switch main) and run agentboard sync again',
    );
  }
  return ref.trim();
}

/** Whether `branch` has a configured upstream (`branch.<branch>.remote` and `.merge`, whatever the remote). */
function hasUpstream(git: GitRunner, branch: string): boolean {
  const remote = git.attempt('config', '--get', `branch.${branch}.remote`);
  const merge = git.attempt('config', '--get', `branch.${branch}.merge`);
  return !isGitFailure(remote) && !isGitFailure(merge);
}

/** Whether `branch` exists on `remote` (contacts the remote). */
function remoteHasBranch(git: GitRunner, remote: string, branch: string): boolean {
  const out = git.attempt('ls-remote', '--heads', remote, `refs/heads/${branch}`);
  if (isGitFailure(out)) {
    throw syncFailed(`reaching ${remote}`, out, git);
  }
  return out.trim() !== '';
}

/** Step 4: pull with rebase, mapping a conflict and any other failure. */
function pull(git: GitRunner, dir: string, remote: string, branch: string): void {
  const out = git.attempt('pull', '--quiet', '--rebase', '--no-autostash', remote, branch);
  if (!isGitFailure(out)) {
    return;
  }
  const conflicted = unmergedPaths(git);
  if (conflicted.length > 0) {
    throw new BoardError(
      3,
      'sync-conflict',
      `pulling from ${asciiText(withoutUserinfo(remote))} stopped on a conflict in the board repository at ${dir}: ` +
        `${conflicted.map((p) => asciiText(p)).join(', ')}; resolve them, git add them and ` +
        'git rebase --continue (or git rebase --abort), then run agentboard sync again',
    );
  }
  throw syncFailed(`pulling from ${remote}`, out, git);
}

/**
 * Step 5: push. Returns false when the push was rejected and may be
 * retried (`last` false); throws on any other failure or a last rejection.
 */
function push(
  git: GitRunner,
  remote: string,
  branch: string,
  setUpstream: boolean,
  last: boolean,
): boolean {
  const args = ['push', '--porcelain', ...(setUpstream ? ['-u'] : []), remote, branch];
  const out = git.attempt(...args);
  if (!isGitFailure(out)) {
    return true;
  }
  const rejected = out.stdout.split('\n').some((line) => line.startsWith('!'));
  if (rejected && !last) {
    return false;
  }
  throw syncFailed(`pushing to ${remote}`, out, git);
}
