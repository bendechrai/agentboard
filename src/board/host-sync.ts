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
 */

import type { Board } from '../store/board.js';
import type { BoardModelInfo } from './model.js';
import type { SyncOptions, SyncResult } from './sync.js';

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
  void board;
  void info;
  void options;
  throw new Error('not implemented');
}
