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

import { dirname, isAbsolute, resolve } from 'node:path';

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
  EVENT_PATH,
  checkCommittedEventsPresent,
  checkNothingForeignStaged,
  checkNothingInProgress,
  hostTrackedPaths,
  hostWarning,
  plural,
  remoteMessage,
  stageAndCommit,
  syncFailed,
  unmergedPaths,
  zList,
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
 *    `committedEvents` report it as in `SyncResult`. Then, as the
 *    standalone path does before its pull (`checkNothingForeignStaged`),
 *    anything still staged (`diff --cached --name-only -z` not empty) is
 *    `BoardError(3, 'sync-failed')` with the standalone message (the
 *    board directory, the paths, `restore --staged`), on every path
 *    including the no-remote one: the rebases of steps 2 and 5 cannot run
 *    over it, and sync never commits it. The commit of step 1 is kept and
 *    the next sync moves the ref to it.
 * 2. Integrate the local ref. Read the ref
 *    (`rev-parse --quiet --verify refs/agentboard/board^{commit}`; a
 *    missing ref, deleted by hand, reads as empty and is created again
 *    from HEAD). When the ref exists and is not an ancestor of HEAD
 *    (`merge-base --is-ancestor refs/agentboard/board HEAD` fails),
 *    `rebase --no-verify refs/agentboard/board`, unless the ref is a stale
 *    value of this worktree, which is moved to HEAD without a rebase. The
 *    ref is stale exactly when (a) it equals `ORIG_HEAD` of the worktree
 *    (`rev-parse --quiet --verify ORIG_HEAD`; `git rebase` sets it to the
 *    pre-rebase HEAD), (b) that commit is not a descendant of HEAD
 *    (`merge-base --is-ancestor HEAD ORIG_HEAD` fails: a `reset --hard
 *    <older>` also sets `ORIG_HEAD`, to the newer commit, and must
 *    rebase) and (c) HEAD's tree holds every event file of the ref's
 *    tree (`diff --no-renames --name-only --diff-filter=A HEAD
 *    refs/agentboard/board -- events` prints nothing; never without
 *    `--no-renames`, which would pair two similar events as a rename).
 *    That is the state a sync killed between a rebase and its
 *    `update-ref` leaves, and the state a human leaves by finishing a
 *    conflicted rebase with `git rebase --continue`; rebasing onto the
 *    ref again would conflict a second time. Everything else rebases: a
 *    hand fetch into the ref whatever it changed (an event, a similar
 *    event, only `.gitignore`), an aborted rebase (`--abort` restores
 *    HEAD and `ORIG_HEAD` to the pre-rebase commit), a `checkout` or
 *    `reset --hard` of an older commit. A conflict is
 *    `BoardError(3, 'sync-conflict')` as in step 5, and the ref keeps the
 *    value it had (the hand-fetched history stays reachable through it).
 *    An ancestor test alone would not do: the rebased HEAD does not
 *    descend from the pre-rebase commit, so it would re-conflict after a
 *    human's `rebase --continue` and rebase again after a kill. Then,
 *    when the ref
 *    differs from HEAD, `update-ref refs/agentboard/board <HEAD> <old>`
 *    with `<old>` the value read before the rebase (the empty string when
 *    the ref was missing, which is create-only). When that compare-and-swap
 *    fails (something moved the ref in between: a hand-run
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
 *    the message's second line
 *    `no remote configured; the board at <dir> was not fetched or pushed`.
 *    The catch-up of step 7 still runs. A remote whose URL is a relative
 *    path (`git remote add origin ../project.git`, which git would
 *    resolve from `.board`, one directory too deep) is resolved against
 *    the host's top level for the commands of steps 4 to 6 (for example
 *    `-c remote.<name>.url=<absolute path>` on each of them, or the
 *    absolute path as the remote argument); `git remote get-url` still
 *    prints the relative URL afterwards.
 * 4. Fetch: `fetch --no-tags <remote> refs/agentboard/board`. No
 *    destination in the refspec, so the result is the worktree's own
 *    `FETCH_HEAD` (`<worktree git dir>/FETCH_HEAD`, never the main
 *    checkout's) and no remote-tracking ref is written (nothing appears
 *    under `refs/remotes/`). A failure because the remote has no such ref
 *    (`ls-remote <remote> refs/agentboard/board` lists nothing, checked
 *    first) skips to step 6 with `pulled` false; any other failure of the
 *    `ls-remote` or of the fetch (unreachable remote, a configured remote
 *    that does not exist, a fetch that fails after the ref was listed) is
 *    `BoardError(3, 'sync-failed')` whose message names what failed
 *    (`fetching refs/agentboard/board from <remote>`) and git's first
 *    error line, the commit of step 1 kept.
 * 5. Integrate what was fetched: when `FETCH_HEAD` is not an ancestor of
 *    HEAD, `rebase --no-verify FETCH_HEAD`. A rebase that stops on a
 *    conflict (any unmerged path) is left exactly as git left it for a
 *    human and is `BoardError(3, 'sync-conflict')` whose message names
 *    every unmerged path, the board directory, `git add`,
 *    `git rebase --continue` and `git rebase --abort`; the local ref, every
 *    branch, the index and the working tree of every other worktree of the
 *    host are unchanged (the next `sync` exits 3 `sync-in-progress`). A
 *    rebase that fails for another reason (an untracked file in `.board`
 *    that the fetched commits would overwrite) leaves HEAD where it was
 *    and is `BoardError(3, 'sync-failed')` with git's first error line
 *    (which names the file). Histories with different roots (an
 *    offline-created empty board meeting a board that began as a
 *    standalone board) rebase the same way: the empty-board root adds the
 *    same `.gitignore` and `events/.gitkeep`, which git applies and
 *    drops. Then `update-ref refs/agentboard/board <HEAD> <old>` as in
 *    step 2 (one repeat, then `sync-failed`; the repeat reads the ref
 *    again and treats it as step 2 does). `pulled` is true when this step
 *    ran (the remote had the ref), whether or not anything new arrived.
 * 6. Push: `push --porcelain --no-verify <remote> HEAD:refs/agentboard/board`,
 *    never `--force`, `-f`, `--mirror` or `--all`. A rejection because the
 *    remote moved (a porcelain line starting with `!` whose reason is
 *    `[rejected]`: non-fast-forward, fetch first; or `[remote rejected]`
 *    with a ref update that lost to a concurrent push received at the
 *    same time: `failed to update ref`, `failed to lock`, `incorrect old
 *    value provided`, `cannot lock ref`) is retried once from
 *    step 4, so what arrived in between is integrated and reported in
 *    `arrived`; a second such rejection is `BoardError(3, 'sync-failed')`.
 *    Any other refusal by the remote (`[remote rejected]`: a `pre-receive` hook, a
 *    host that does not accept custom refs) is not retried: exactly one
 *    push, then `BoardError(3, 'sync-failed')` whose message names the
 *    remote and carries the remote's reason as git printed it (the text
 *    of the porcelain line's reason and of the `remote:` lines, so a
 *    hook's own message appears). Any other push failure is
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
 * event files the rebases of steps 2 and 5 added to HEAD's tree
 * (`diff --no-renames --name-only --diff-filter=A <HEAD after step 1>
 * HEAD -- events`, names without `.json`, ascending; `--no-renames` so a
 * local event similar to an arrived one never hides it as a rename), so what a rebase onto a hand-fetched
 * ref brings counts too, even on the no-remote path, while an event this
 * process committed, or that another writer of this clone wrote while
 * the sync ran (it stays untracked for the next sync), never does;
 * `message` lines,
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
 * Guarantee on the ref (board-events "Board ref in the host repository"):
 * `refs/agentboard/board` equals the worktree's HEAD when this function
 * returns, and after the refusals `sync-conflict` (a step 5 conflict: the
 * ref was moved to HEAD before the fetch, and the failed rebase moved
 * nothing; a step 2 conflict: the ref keeps the hand-fetched value, HEAD
 * the local commits, so nothing is lost either way),
 * `sync-in-progress` and `board-on-branch` (nothing ran). After
 * `sync-failed` the ref may lag HEAD (the staged-content refusal after
 * the commit of step 1, a compare-and-swap that failed twice, a rebase
 * that failed without a conflict); no commit is lost, and the next sync
 * repairs it in step 2. A process killed between any step and its
 * `update-ref` likewise leaves HEAD ahead of the ref, repaired by the
 * next sync with no commit lost. Nothing serialises two syncs of one
 * clone: inside the rebase window the second exits 3 `sync-in-progress`;
 * outside it they collide on git's `index.lock` and the loser exits 5
 * with git's error, as two standalone syncs do, with the ref at HEAD and
 * nothing lost (design.md decision 4, known limit). Never modifies a
 * branch, a tag, the index or the working tree of any other worktree of
 * the host; never writes the host's configuration.
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

  // 1. Stage and commit; then nothing foreign may stay staged.
  const { commit, committedEvents } = stageAndCommit(git, board);
  checkNothingForeignStaged(git, dir);
  const committedHead = git.run('rev-parse', 'HEAD').trim();

  // 2. Make the local ref equal to HEAD.
  let refCommit = integrateLocalRef(git, dir);

  // 3. Remote.
  const choice = boardRemote(info, { env, disableHooks: true });
  if (choice.ambiguous) {
    throw ambiguousRemoteError(choice);
  }
  const remote = choice.chosen?.name ?? null;
  // A relative path URL would resolve from `.board`, one directory too
  // deep: the commands get the path resolved against the host's top level.
  const target =
    remote === null ? null : remoteTarget(remote, choice.chosen?.url ?? null, info, dir);

  // 4. Fetch, 5. integrate and 6. push, retried once when the push is rejected.
  let pulled = false;
  if (remote !== null && target !== null) {
    for (let attempt = 1; ; attempt += 1) {
      if (remoteHasRef(git, remote, target)) {
        fetchRef(git, remote, target);
        if (!isAncestor(git, 'FETCH_HEAD', 'HEAD')) {
          rebaseOnto(git, dir, 'FETCH_HEAD', `what ${asciiText(remote)} holds`);
        }
        refCommit = integrateLocalRef(git, dir);
        pulled = true;
      }
      if (push(git, remote, target, attempt === 2)) {
        break;
      }
    }
  }
  // What the rebases of steps 2 and 5 added to HEAD's tree: never an
  // event this process committed or a writer added meanwhile.
  const arrived = eventsAdded(git, committedHead, 'HEAD')
    .map((path) => path.slice('events/'.length, -'.json'.length))
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
 * Whether the ref at `value` is a stale value of this worktree, which is
 * moved to HEAD without a rebase (the contract on `syncHostBoard`): it
 * equals the worktree's `ORIG_HEAD` (the commit the last rebase started
 * from), that commit is not a descendant of HEAD (a `reset --hard` to an
 * older commit sets `ORIG_HEAD` to the newer one, which must rebase), and
 * HEAD's tree holds every event file of the ref's tree, compared without
 * rename detection (two similar events would otherwise pair as a rename
 * and hide the one HEAD lacks). That is what a sync killed between its
 * rebase and its `update-ref`, or a human's `git rebase --continue`,
 * leaves; rebasing onto the ref again would conflict a second time.
 */
function staleRefOfThisWorktree(git: GitRunner, value: string): boolean {
  const origHead = git.attempt('rev-parse', '--quiet', '--verify', 'ORIG_HEAD^{commit}');
  if (isGitFailure(origHead) || origHead.trim() !== value) {
    return false;
  }
  if (isAncestor(git, 'HEAD', value)) {
    return false;
  }
  return eventsAdded(git, 'HEAD', BOARD_REF).length === 0;
}

/**
 * The event files (`events/<hash>.json`) that `to`'s tree holds and
 * `from`'s does not, without rename detection.
 */
function eventsAdded(git: GitRunner, from: string, to: string): string[] {
  const added = git.run(
    'diff',
    '--no-renames',
    '--name-only',
    '-z',
    '--diff-filter=A',
    from,
    to,
    '--',
    'events',
  );
  return zList(added).filter((path) => EVENT_PATH.test(path));
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
    if (old !== '' && !isAncestor(git, BOARD_REF, 'HEAD') && !staleRefOfThisWorktree(git, old)) {
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
  throw syncFailed(`rebasing onto ${what}`, out, git);
}

/**
 * The remote argument of the fetch, `ls-remote` and push commands: the
 * remote's name, or, when its URL is a relative path (one git would
 * resolve from `.board`, a directory too deep), that path resolved
 * against the host's top level (the parent of the host's git directory).
 * The configuration is never rewritten.
 */
function remoteTarget(
  remote: string,
  url: string | null,
  info: BoardModelInfo,
  dir: string,
): string {
  const top = info.gitDir === null ? dirname(dir) : dirname(info.gitDir);
  return resolveRemoteTarget(remote, url, top);
}

/**
 * The remote argument of a fetch, `ls-remote` or push run in a worktree of
 * the host at `top`: `remote` itself, or, when `url` (its fetch URL) is a
 * relative path, that path resolved against `top`, so a command run in
 * `.board` (or a temporary worktree under `.git`) reaches the repository
 * `git remote add origin ../project.git` meant. `init --into-host`
 * resolves the host remote the same way. Pure.
 */
export function resolveRemoteTarget(remote: string, url: string | null, top: string): string {
  if (url === null || url === '' || !isRelativePathUrl(url)) {
    return remote;
  }
  return resolve(top, url);
}

/**
 * Whether git treats `url` as a relative local path: no `<scheme>://`, no
 * `<host>:<path>` form (a colon before the first slash), not absolute.
 */
function isRelativePathUrl(url: string): boolean {
  if (url.includes('://') || isAbsolute(url)) {
    return false;
  }
  const slash = url.indexOf('/');
  const colon = url.indexOf(':');
  return colon === -1 || (slash !== -1 && slash < colon);
}

/** Step 4, first half: whether the remote has `BOARD_REF` (contacts the remote). */
function remoteHasRef(git: GitRunner, remote: string, target: string): boolean {
  const out = git.attempt('ls-remote', target, BOARD_REF);
  if (isGitFailure(out)) {
    throw syncFailed(`reaching ${remote}`, out, git);
  }
  return out.trim() !== '';
}

/** Step 4, second half: `fetch --no-tags <remote> refs/agentboard/board` into the worktree's `FETCH_HEAD`. */
function fetchRef(git: GitRunner, remote: string, target: string): void {
  const out = git.attempt('fetch', '--no-tags', target, BOARD_REF);
  if (isGitFailure(out)) {
    throw syncFailed(`fetching ${BOARD_REF} from ${remote}`, out, git);
  }
}

/** A porcelain `!` line of `git push`: `!\t<from>:<to>\t<reason>`. */
const PUSH_REFUSAL = /^!\t[^\t]*\t(.*)$/;

/**
 * The reason of a `[remote rejected]` line that means the remote's ref
 * moved while the push was being received (receive-pack lost the ref
 * update to a concurrent push: the files backend's `failed to update ref`
 * or `failed to lock`, the transaction's `incorrect old value provided`,
 * `cannot lock ref ... is at <new> but expected <old>`, and `reference
 * already exists` when the other push created the ref between this
 * push's advertisement and its ref update, as two clones moving their
 * boards into one host at the same time do): a race, retried like a
 * `[rejected]` non-fast-forward, not a refusal.
 */
const LOST_RACE =
  /failed to (update|lock)|cannot lock|incorrect old value|but expected|reference already exists/i;

/**
 * Step 6: push. Returns false when the remote moved (a `[rejected]`
 * porcelain line, or a `[remote rejected]` one whose reason is
 * `LOST_RACE`) and the push may be retried (`last` false); throws on a
 * last such rejection, on a refusal by the remote (any other
 * `[remote rejected]`: a hook, a host that refuses the ref), which is
 * never retried and whose message carries the remote's reason and
 * `remote:` lines, and on any other failure.
 */
function push(git: GitRunner, remote: string, target: string, last: boolean): boolean {
  const out = git.attempt('push', '--porcelain', '--no-verify', target, `HEAD:${BOARD_REF}`);
  if (!isGitFailure(out)) {
    return true;
  }
  const reasons = out.stdout
    .split('\n')
    .map((line) => PUSH_REFUSAL.exec(line)?.[1]?.trim() ?? null)
    .filter((reason): reason is string => reason !== null);
  const what = `pushing ${BOARD_REF} to ${remote}`;
  const moved = (reason: string): boolean =>
    reason.startsWith('[rejected]') ||
    (reason.startsWith('[remote rejected]') && LOST_RACE.test(reason));
  if (reasons.some(moved)) {
    if (!last) {
      return false;
    }
    throw syncFailed(what, out, git);
  }
  const refused = reasons.find((reason) => reason.startsWith('[remote rejected]'));
  if (refused !== undefined) {
    // The remote's own lines may quote a URL with credentials (a hook
    // echoing the push URL): the whole message is sanitised like git's own
    // lines, raw first and escaped afterwards (`remoteMessage`).
    const said = out.stderr
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('remote:'))
      .map((line) => line.slice('remote:'.length).trim())
      .filter((line) => line !== '');
    throw new BoardError(
      3,
      'sync-failed',
      remoteMessage(
        `${what} failed: the remote refused it (${refused})` +
          `${said.length > 0 ? `: ${said.join('; ')}` : ''}; fix what the remote names ` +
          `(a hook, or a host that does not accept refs/agentboard/*; see agentboard init --remote), ` +
          'then run agentboard sync again',
        git,
      ),
    );
  }
  throw syncFailed(what, out, git);
}
