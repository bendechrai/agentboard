/**
 * `agentboard sync` for a host-model board (board-concurrency "Sync
 * converges"; board-events "Board ref in the host repository";
 * add-board-sharing design.md decision 4; ADR 0012). The board is a linked
 * worktree of the host repository on a detached HEAD, and its history is
 * the ref `refs/agentboard/board` (`BOARD_REF`) in the host repository.
 * `sync` commits as ADR 0005 says, makes the local ref equal to HEAD with
 * a compare-and-swap, fetches the ref from the host's remote into the
 * worktree's own `FETCH_HEAD`, rebases onto it when it holds commits HEAD
 * does not, pushes `HEAD:refs/agentboard/board` without force (one retry
 * on rejection), then folds what arrived into the cache. It never creates
 * or moves a branch, and no hook of the host runs for any of its commands.
 *
 * `syncBoard` (`src/board/sync.ts`) is the one entry point for both models:
 * it detects the model and calls `syncHostBoard` for a host-model board.
 * The steps both models share are in `src/board/sync-steps.ts`.
 */

import type { Board } from '../store/board.js';
import { catchUp } from '../store/cache.js';
import { BoardError } from '../store/errors.js';
import {
  HOST_MODEL_GIT_FLOOR,
  gitRunner,
  gitVersion,
  isGitFailure,
  meetsGitFloor,
  type GitRunner,
} from './git.js';
import { BOARD_REF, type BoardModelInfo } from './model.js';
import { ambiguousRemoteError, boardRemote } from './remote.js';
import type { SyncOptions, SyncResult } from './sync.js';
import {
  checkCommittedEventsPresent,
  checkNothingInProgress,
  eventFileNames,
  hostTrackedPaths,
  hostWarning,
  plural,
  stageAndCommit,
  syncFailed,
  unmergedPaths,
} from './sync-steps.js';
import { asciiText, type Env } from './text.js';

/**
 * The host-model path of `agentboard sync`, for a board whose model
 * `detectBoardModel` reported as `host` (`info.model === 'host'`,
 * `info.gitDir` the realpath of the host's git common directory). Every
 * git command runs in the board directory through `gitRunner` with
 * `options.env` (sanitised as `SyncOptions.env` describes), the fixed
 * identity and `commit.gpgsign=false`, and with hooks disabled
 * (`disableHooks: true`, so `-c core.hooksPath=<empty directory>` is on
 * every command, the directory being `agentboard-no-hooks` under the
 * worktree's git directory, `<host git common dir>/worktrees/<name>/`);
 * `git config core.hooksPath` of the host is never written.
 *
 * Preconditions, in this order, each checked before anything is staged:
 * 1. `git` can be run (checked by `syncBoard`, exit 1 `git-missing`) and
 *    `gitVersion` meets `HOST_MODEL_GIT_FLOOR` (2.32), else
 *    `BoardError(1, 'git-too-old')` whose message names the version found
 *    (`<major>.<minor>.<patch>`), says the host model needs git 2.32 or
 *    later (the text `2.32` appears) and that upgrading git is the fix.
 *    Nothing is staged, committed or fetched. (The spec delta puts this
 *    refusal in the exit 1 class, with `ambiguous-remote` and
 *    `git-missing`.)
 * 2. No rebase, merge, cherry-pick or revert is in progress in the
 *    worktree's git directory (`rebase-merge`, `rebase-apply`,
 *    `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD` under
 *    `git rev-parse --absolute-git-dir`), else
 *    `BoardError(3, 'sync-in-progress')` with the same message as the
 *    standalone path (names the board directory, `git rebase --continue`
 *    and `git rebase --abort`).
 * 3. HEAD is detached (`git symbolic-ref --quiet HEAD` fails), else
 *    `BoardError(3, 'board-on-branch')` whose message names the branch
 *    checked out, the board directory, and the fix
 *    `git -C <board dir> switch --detach refs/agentboard/board` (the text
 *    `switch --detach refs/agentboard/board` appears). Nothing is staged.
 * 4. Every event file in HEAD's tree is present in `events/`, else
 *    `BoardError(5, 'integrity')` exactly as the standalone path (names
 *    every missing `events/<name>` and `git -C <board dir> checkout --
 *    events/<name>`), nothing staged.
 *
 * Steps (each git command line is given as `sync` runs it, after the
 * runner's `-c` prefix, so a shim on the PATH can match it):
 * 1. Stage and commit exactly as the standalone path (ADR 0005):
 *    `add --ignore-removal -- events :(exclude)events/.tmp-* [.gitignore]`,
 *    then, only when something of those paths is staged,
 *    `commit --quiet --no-verify -m <syncCommitMessage(n)> -- <same pathspec>`;
 *    anything else staged stays staged and uncommitted. `commit` and
 *    `committedEvents` report it as in `SyncResult`.
 * 2. Integrate the local ref. Read the ref
 *    (`rev-parse --quiet --verify refs/agentboard/board^{commit}`; a
 *    missing ref, deleted by hand, reads as empty and is created again
 *    from HEAD). When the ref exists, is not an ancestor of HEAD
 *    (`merge-base --is-ancestor refs/agentboard/board HEAD` fails) and
 *    holds a commit this worktree's HEAD never pointed at (the worktree
 *    HEAD's reflog, `rev-list -g HEAD`, does not list it: someone fetched
 *    into the ref by hand), `rebase --no-verify refs/agentboard/board`; a
 *    conflict is `BoardError(3, 'sync-conflict')` as in step 5. A ref
 *    value that the reflog does list is a stale value of this worktree
 *    (left by a sync killed between a rebase and its `update-ref`, or by
 *    a human who finished a conflicted rebase with `git rebase
 *    --continue`): its commits were replayed into HEAD, so no rebase runs
 *    and the ref is simply moved. Then, when the ref differs from HEAD,
 *    `update-ref refs/agentboard/board <HEAD> <old>` with `<old>` the
 *    value read before the rebase (the empty string when the ref was
 *    missing, which is create-only). When that compare-and-swap fails
 *    (something moved the ref in between: a hand-run
 *    `git fetch origin +refs/agentboard/board:refs/agentboard/board`),
 *    this step is repeated once from reading the ref; a second failure is
 *    `BoardError(3, 'sync-failed')` naming the ref. After this step the ref
 *    equals HEAD.
 * 3. Remote: `boardRemote(info)` (board-concurrency "Sync converges":
 *    `agentboard.remote` in the host repository, the upstream of the
 *    branch checked out in the host's main worktree, `origin`, the only
 *    remote). Ambiguous: `ambiguousRemoteError(choice)`, exit 1
 *    `ambiguous-remote`, after the commit and the local ref update. No
 *    remote: stop here, exit 0, `remote` null, `pulled` and `pushed` false,
 *    `arrived` empty, the message's second line
 *    `no remote configured; the board at <dir> was not fetched or pushed`.
 *    The catch-up of step 7 still runs.
 * 4. Fetch: `fetch --no-tags <remote> refs/agentboard/board`. No
 *    destination in the refspec, so the result is the worktree's own
 *    `FETCH_HEAD` (`<worktree git dir>/FETCH_HEAD`, never the main
 *    checkout's) and no remote-tracking ref is written (nothing appears
 *    under `refs/remotes/`). A failure because the remote has no such ref
 *    (`ls-remote <remote> refs/agentboard/board` lists nothing, checked
 *    first) skips to step 6 with `pulled` false; any other failure
 *    (unreachable remote, a configured remote that does not exist) is
 *    `BoardError(3, 'sync-failed')` with git's first error line, the
 *    commit of step 1 kept.
 * 5. Integrate what was fetched: when `FETCH_HEAD` is not an ancestor of
 *    HEAD, `rebase --no-verify FETCH_HEAD`. A rebase that stops on a
 *    conflict (any unmerged path) is left exactly as git left it for a
 *    human and is `BoardError(3, 'sync-conflict')` whose message names
 *    every unmerged path, the board directory, `git add`,
 *    `git rebase --continue` and `git rebase --abort`; the local ref, every
 *    branch, the index and the working tree of every other worktree of the
 *    host are unchanged (the next `sync` exits 3 `sync-in-progress`).
 *    Histories with different roots (an offline-created empty board
 *    meeting a board that began as a standalone board) rebase the same
 *    way: the empty-board root adds the same `.gitignore` and
 *    `events/.gitkeep`, which git applies and drops. Then
 *    `update-ref refs/agentboard/board <HEAD> <old>` as in step 2 (one
 *    repeat, then `sync-failed`; the repeat reads the ref again and
 *    treats it as step 2 does). `pulled` is true when this step ran (the
 *    remote had the ref), whether or not anything new arrived.
 * 6. Push: `push --porcelain --no-verify <remote> HEAD:refs/agentboard/board`,
 *    never `--force`, `-f`, `--mirror` or `--all`. A rejection (a porcelain
 *    line starting with `!`: the remote moved) is retried once from step 4,
 *    so what arrived in between is integrated and reported in `arrived`; a
 *    second rejection, or any other push failure, is
 *    `BoardError(3, 'sync-failed')` with git's first error line. `pushed`
 *    is true when a push completed (also when it was already up to date).
 * 7. Catch-up: `catchUp(board)`, so every arrived event is in the cache
 *    (`refolded` as `CatchUpReport.refolded`).
 *
 * The host tracking check of the standalone path runs too (`hostTracked`,
 * `warnings`).
 *
 * Result (`SyncResult`): `model` `host`; `ref` `refs/agentboard/board`;
 * `refCommit` the full id the ref holds when sync returns (equal to HEAD;
 * also on the no-remote path); `branch` null; `upstreamSet` false;
 * `commit` the commit on HEAD that holds the events of step 1 after any
 * rebase replayed it (null when nothing was committed); `arrived` the
 * event files present when the steps are done and absent before step 2
 * (so what a rebase onto a hand-fetched ref brings counts too, even on
 * the no-remote path), ascending; `message` lines,
 * in order: `committed <n> event file(s) (<12 hex of commit>)` or
 * `nothing new to commit`; then on the no-remote path the line of step 3,
 * else `fetched refs/agentboard/board from <remote>: <n> event(s) arrived`
 * when step 5 ran or `<remote> has no refs/agentboard/board yet; nothing
 * to fetch` when it did not; then `pushed refs/agentboard/board to
 * <remote>`. Counts use `<n> event` for 1 and `<n> events` otherwise
 * (`1 event file`, `2 event files`, `0 events arrived`, `1 event arrived`).
 * No line mentions a retry, so the text is the same whether or not a push
 * was retried.
 *
 * Invariant (board-events "Board ref in the host repository"): when this
 * function returns, and after every `BoardError` it throws except
 * `sync-conflict`, `refs/agentboard/board` equals the worktree's HEAD; a
 * process killed between any step and the next `update-ref` leaves HEAD
 * ahead of the ref, and the next `sync` repairs that in step 2 with no
 * commit lost. Never modifies a branch, a tag, the index or the working
 * tree of any other worktree of the host; never writes the host's
 * configuration.
 */
export function syncHostBoard(
  board: Board,
  info: BoardModelInfo,
  options?: SyncOptions,
): SyncResult {
  const env = options?.env ?? process.env;
  const dir = board.dir;
  const git = gitRunner(dir, { env, disableHooks: true });

  // Preconditions.
  checkGitFloor(env, dir);
  checkNothingInProgress(git, dir);
  checkDetached(git, dir);
  checkCommittedEventsPresent(git, board);

  const hostTracked = hostTrackedPaths(git, dir);
  const warnings = hostTracked.length > 0 ? [hostWarning(dir, hostTracked)] : [];

  // 1. Stage and commit.
  const { commit, committedEvents } = stageAndCommit(git, board);
  const before = new Set(eventFileNames(board));

  // 2. Make the local ref equal to HEAD.
  let refCommit = integrateLocalRef(git, dir);

  // 3. Remote.
  const choice = boardRemote(info, { env, disableHooks: true });
  if (choice.ambiguous) {
    throw ambiguousRemoteError(choice);
  }
  const remote = choice.chosen?.name ?? null;

  // 4. Fetch, 5. integrate and 6. push, retried once when the push is rejected.
  let pulled = false;
  if (remote !== null) {
    for (let attempt = 1; ; attempt += 1) {
      if (remoteHasRef(git, remote)) {
        fetchRef(git, remote);
        if (!isAncestor(git, 'FETCH_HEAD', 'HEAD')) {
          rebaseOnto(git, dir, 'FETCH_HEAD', `what ${asciiText(remote)} holds`);
        }
        refCommit = integrateLocalRef(git, dir);
        pulled = true;
      }
      if (push(git, remote, attempt === 2)) {
        break;
      }
    }
  }
  const arrived = eventFileNames(board)
    .filter((name) => !before.has(name))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();

  // 7. Catch-up.
  const report = catchUp(board);
  // A rebase replays the local commit: report the commit on HEAD now.
  const onHead = commit === null ? null : git.run('rev-parse', 'HEAD').trim();

  const lines = [
    onHead === null
      ? 'nothing new to commit'
      : `committed ${plural(committedEvents, 'event file')} (${onHead.slice(0, 12)})`,
  ];
  if (remote === null) {
    lines.push(`no remote configured; the board at ${dir} was not fetched or pushed`);
  } else {
    lines.push(
      pulled
        ? `fetched ${BOARD_REF} from ${remote}: ${plural(arrived.length, 'event')} arrived`
        : `${remote} has no ${BOARD_REF} yet; nothing to fetch`,
      `pushed ${BOARD_REF} to ${remote}`,
    );
  }
  return {
    dir,
    model: 'host',
    ref: BOARD_REF,
    refCommit,
    commit: onHead,
    committedEvents,
    remote,
    branch: null,
    pulled,
    pushed: remote !== null,
    upstreamSet: false,
    arrived,
    refolded: report.refolded,
    hostTracked,
    warnings,
    message: lines.join('\n'),
  };
}

/** Precondition 1: the git found meets the host model's floor. */
function checkGitFloor(env: Env, dir: string): void {
  const version = gitVersion(env, dir);
  if (version === null || meetsGitFloor(version)) {
    return;
  }
  const found = `${String(version.major)}.${String(version.minor)}.${String(version.patch)}`;
  const floor = `${String(HOST_MODEL_GIT_FLOOR.major)}.${String(HOST_MODEL_GIT_FLOOR.minor)}`;
  throw new BoardError(
    1,
    'git-too-old',
    `git ${found} was found, but the board at ${dir} is in the host repository, which needs ` +
      `git ${floor} or later; upgrade git and run agentboard sync again`,
  );
}

/** Precondition 3: the worktree is on a detached HEAD, not a branch. */
function checkDetached(git: GitRunner, dir: string): void {
  const branch = git.attempt('symbolic-ref', '--quiet', '--short', 'HEAD');
  if (isGitFailure(branch)) {
    return;
  }
  throw new BoardError(
    3,
    'board-on-branch',
    `the board worktree at ${dir} has the branch ${asciiText(branch.trim())} checked out, but a ` +
      `board in the host repository is synced through ${BOARD_REF} on a detached HEAD; ` +
      `run git -C ${dir} switch --detach ${BOARD_REF} and then agentboard sync again`,
  );
}

/** The full id `BOARD_REF` holds, or the empty string when it does not exist. */
function refValue(git: GitRunner): string {
  const out = git.attempt('rev-parse', '--quiet', '--verify', `${BOARD_REF}^{commit}`);
  return isGitFailure(out) ? '' : out.trim();
}

/** Whether `ancestor` is an ancestor of (or equal to) `descendant`. */
function isAncestor(git: GitRunner, ancestor: string, descendant: string): boolean {
  return !isGitFailure(git.attempt('merge-base', '--is-ancestor', ancestor, descendant));
}

/**
 * Whether the worktree's HEAD ever pointed at `commit` (its reflog lists
 * it). A worktree without a HEAD reflog never did.
 */
function headEverWas(git: GitRunner, commit: string): boolean {
  const log = git.attempt('rev-list', '-g', 'HEAD');
  return !isGitFailure(log) && log.split('\n').some((line) => line.trim() === commit);
}

/**
 * Steps 2 and 5's ref update: makes `BOARD_REF` equal to HEAD with a
 * compare-and-swap, rebasing HEAD onto the ref first when the ref holds
 * commits HEAD never had (the contract on `syncHostBoard`). Returns the
 * value the ref holds afterwards, which is HEAD.
 */
function integrateLocalRef(git: GitRunner, dir: string): string {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const old = refValue(git);
    let head = git.run('rev-parse', 'HEAD').trim();
    if (old === head) {
      return head;
    }
    if (old !== '' && !isAncestor(git, BOARD_REF, 'HEAD') && !headEverWas(git, old)) {
      rebaseOnto(git, dir, BOARD_REF, `the local ${BOARD_REF}`);
      head = git.run('rev-parse', 'HEAD').trim();
      if (old === head) {
        return head;
      }
    }
    if (!isGitFailure(git.attempt('update-ref', BOARD_REF, head, old))) {
      return head;
    }
  }
  throw new BoardError(
    3,
    'sync-failed',
    `updating ${BOARD_REF} in the host repository failed twice because something else kept ` +
      `moving it; run agentboard sync again`,
  );
}

/**
 * Rebases HEAD onto `onto` (`rebase --no-verify <onto>`), leaving a
 * conflicted rebase in place for a human.
 */
function rebaseOnto(git: GitRunner, dir: string, onto: string, what: string): void {
  const out = git.attempt('rebase', '--no-verify', onto);
  if (!isGitFailure(out)) {
    return;
  }
  const conflicted = unmergedPaths(git);
  if (conflicted.length > 0) {
    throw new BoardError(
      3,
      'sync-conflict',
      `rebasing onto ${what} stopped on a conflict in the board worktree at ${dir}: ` +
        `${conflicted.map((p) => asciiText(p)).join(', ')}; resolve them, git add them and ` +
        `git rebase --continue (or git rebase --abort) in ${dir}, then run agentboard sync again`,
    );
  }
  throw syncFailed(`rebasing onto ${what}`, out);
}

/** Step 4, first half: whether `remote` has `BOARD_REF` (contacts the remote). */
function remoteHasRef(git: GitRunner, remote: string): boolean {
  const out = git.attempt('ls-remote', remote, BOARD_REF);
  if (isGitFailure(out)) {
    throw syncFailed(`reaching ${asciiText(remote)}`, out);
  }
  return out.trim() !== '';
}

/** Step 4, second half: `fetch --no-tags <remote> refs/agentboard/board` into the worktree's `FETCH_HEAD`. */
function fetchRef(git: GitRunner, remote: string): void {
  const out = git.attempt('fetch', '--no-tags', remote, BOARD_REF);
  if (isGitFailure(out)) {
    throw syncFailed(`fetching ${BOARD_REF} from ${asciiText(remote)}`, out);
  }
}

/**
 * Step 6: push. Returns false when the push was rejected and may be
 * retried (`last` false); throws on any other failure or a last rejection.
 */
function push(git: GitRunner, remote: string, last: boolean): boolean {
  const out = git.attempt('push', '--porcelain', '--no-verify', remote, `HEAD:${BOARD_REF}`);
  if (!isGitFailure(out)) {
    return true;
  }
  const rejected = out.stdout.split('\n').some((line) => line.startsWith('!'));
  if (rejected && !last) {
    return false;
  }
  throw syncFailed(`pushing ${BOARD_REF} to ${asciiText(remote)}`, out);
}
