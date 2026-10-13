/**
 * `agentboard init --into-host` (board-cli: "Moving a standalone board into
 * the host repository"; board-concurrency: "Moving a board into the host
 * repository loses no event"; add-board-sharing design.md: decision 9 and
 * "Migration Plan"; ADR 0012): moves a standalone board (a git repository
 * of its own at `.board`) into the host model (a locked worktree of the
 * host repository at `refs/agentboard/board`), keeping its whole history,
 * refusing whenever the move could lose an event, keeping the old
 * repository aside, and resumable after an interruption.
 *
 * `moveBoardIntoHost` is the entry point; the registry dispatches to it on
 * the `--into-host` flag (`initBoard` and `initBoardWithRemote` are
 * unchanged). Every git command against the host repository runs through
 * `gitRunner` with the sanitised environment, the fixed identity and the
 * host's hooks disabled (`disableHooks: true`), as `host-init.ts` and
 * `host-sync.ts` do; the commands that inspect or fetch from the standalone
 * repository run in it as the standalone `sync` does (its own hooks run as
 * git runs them).
 *
 * Temporary paths live inside the host's git common directory
 * (`<git common dir>/agentboard/`), where the host's `git status` never
 * shows them and nothing can `git add` them. The temporary worktree is
 * named by the pid of the process that made it, and a leftover is removed
 * only when its pid is dead (the group 4 review note on `init --remote`'s
 * `.board-clone-*` cleanup, which deletes every leftover and so can make
 * a concurrent run fail), as `init.lock` treats its holder.
 */

import type { LocateOptions } from '../store/locate.js';
import type { HostInitOptions } from './host-init.js';
import type { InitResult } from './init.js';
import type { SyncResult } from './sync.js';

/**
 * The reserved, temporary ref the source tip is fetched into
 * (design.md decision 9, step 2). Deleted in step 4; never left behind by
 * a completed move, and removed by the re-run after an interrupted one.
 */
export const MIGRATING_REF = 'refs/agentboard/migrating';

/**
 * The directory under `<git common dir>/agentboard/` that holds the
 * temporary worktrees of moves: one subdirectory per move, named by the
 * pid of the process that made it (`migratingWorktreePath`).
 */
export const MIGRATING_DIR = 'migrating';

/** The prefix of a kept old repository: `standalone-<UTC timestamp>`. */
export const STANDALONE_KEPT_PREFIX = 'standalone-';

/**
 * The name of the kept old repository for the moment `now`:
 * `standalone-` followed by the UTC time as `YYYYMMDDTHHMMSSZ` (so
 * `standalone-20261013T153000Z` for 2026-10-13 15:30:00 UTC), plain ASCII,
 * no separators other than `T` and `Z`, sortable by time, the same shape
 * as `staleBoardName` in `host-init.ts`. Pure.
 */
export function standaloneKeptName(now: Date): string {
  void now;
  throw new Error('not implemented');
}

/**
 * `<git common dir>/agentboard/migrating/<pid>` of the repository at
 * `hostDir`, as an absolute path: the temporary worktree of the move run
 * by the process `pid` (`process.pid` by default). Creates nothing; the
 * parent directories are made by the move when it adds the worktree.
 */
export function migratingWorktreePath(
  hostDir: string,
  pid?: number,
  options?: HostInitOptions,
): string {
  void hostDir;
  void pid;
  void options;
  throw new Error('not implemented');
}

/** One temporary worktree directory found under `<git common dir>/agentboard/migrating/`. */
export interface MigratingWorktree {
  /** Absolute path of the directory. */
  readonly path: string;
  /** The pid its name carries, or null when the name is not a positive integer. */
  readonly pid: number | null;
  /** True when a process with that pid is running (`kill(pid, 0)` succeeds); false for a null pid. */
  readonly alive: boolean;
  /** True when the host repository lists the directory as a worktree (`git worktree list --porcelain`, compared as realpaths). */
  readonly registered: boolean;
  /**
   * The full id of the worktree's HEAD commit when it is registered and
   * present, else null.
   */
  readonly head: string | null;
}

/**
 * Every entry of `<git common dir>/agentboard/migrating/` of the repository
 * at `hostDir`, by name ascending; empty when the directory does not exist.
 * Read-only.
 */
export function findMigratingWorktrees(
  hostDir: string,
  options?: HostInitOptions,
): MigratingWorktree[] {
  void hostDir;
  void options;
  throw new Error('not implemented');
}

/**
 * Removes every temporary worktree under `<git common dir>/agentboard/migrating/`
 * whose pid is not running (`MigratingWorktree.alive` false, which a pid
 * that is not a number counts as): unregistered (unlocked and removed by
 * force when registered, as `removeLeftoverWorktree` does) and deleted
 * from disk. One whose pid is alive (another move in progress on this
 * host, beyond the init lock's 60 second stale limit) is left alone. Also
 * deletes `MIGRATING_REF` when no live worktree remains. Returns the paths
 * removed, ascending. Never throws for a missing directory; nothing else
 * in the repository changes.
 */
export function removeDeadMigratingWorktrees(hostDir: string, options?: HostInitOptions): string[] {
  void hostDir;
  void options;
  throw new Error('not implemented');
}

/**
 * Finishes a move that was interrupted after the old `.board` was renamed
 * away and before the temporary worktree was moved into place (design.md
 * decision 9, "Resuming"): when `dir` (`<hostDir>/.board`) is missing and
 * exactly one temporary worktree under `<git common dir>/agentboard/migrating/`
 * is registered, present, has a dead pid and a HEAD equal to
 * `refs/agentboard/board`, `git worktree move` it to `dir` and lock it
 * with `WORKTREE_LOCK_REASON`; returns true. Otherwise changes nothing and
 * returns false (also when `dir` exists, when the worktree's HEAD differs
 * from the ref, or when its pid is alive).
 */
export function adoptMigratingWorktree(
  hostDir: string,
  dir: string,
  options?: HostInitOptions,
): boolean {
  void hostDir;
  void dir;
  void options;
  throw new Error('not implemented');
}

/** The outcome of `verifyEventFiles`. */
export interface EventVerification {
  /** Names (`<hash>.json`, ascending) of `from` that `to` lacks. */
  readonly missing: readonly string[];
  /** Names (ascending) present in both whose bytes differ. */
  readonly different: readonly string[];
}

/**
 * Step 5 of the move (design.md decision 9): compares every event file
 * (`<64 hex>.json`; dot-named entries, temporaries and subdirectories are
 * ignored) of the directory `from` (the old `.board/events`) with the file
 * of the same name in `to` (the new worktree's `events/`), byte for byte,
 * and reports what is missing or differs. Both lists empty means every
 * event of `from` is in `to` with identical content. A missing `from`
 * reports nothing. Reads only; writes nothing. Pure apart from reading the
 * files.
 */
export function verifyEventFiles(from: string, to: string): EventVerification {
  void from;
  void to;
  throw new Error('not implemented');
}

/**
 * What `moveBoardIntoHost` did:
 * - `moved`: the standalone board was moved into the host model in this
 *   run (steps 2 to 7).
 * - `resumed`: a move interrupted between keeping the old repository
 *   aside and moving the temporary worktree into place was finished
 *   (`adoptMigratingWorktree`), then step 7 ran.
 * - `unchanged`: the board was already a healthy host-model board;
 *   nothing was done (the one exception of `initBoard`: an unlocked
 *   worktree is locked again).
 * - `repaired`: the board was a host-model board whose link was broken (or
 *   a non-repository `.board`), repaired exactly as `initBoard` repairs it
 *   (`repair` set); the standalone move did not apply.
 */
export type IntoHostAction = 'moved' | 'resumed' | 'unchanged' | 'repaired';

/**
 * Result of `moveBoardIntoHost`; also the `init --into-host --json`
 * document: every field of `InitResult` (board-cli "Initialising and
 * joining a shared board": `dir`, `created`, `model`, `joined`, `remote`,
 * `events`, `hostGitignore`, `warnings`, `repair`, `message`) plus the four
 * below. The exact key set of the JSON document is the ten keys of
 * `InitResult` and `action`, `keptAt`, `oldRemoteUrl`, `sync`.
 *
 * Of the `InitResult` fields: `model` is always `host`; `created` is false
 * (the board existed; it was moved, not made); `joined` is true when a
 * `refs/agentboard/board` fetched from the host's remote was integrated in
 * step 3 (another clone moved first), else false; `remote` is the name the
 * host repository's remote choice gives (board-concurrency "Sync
 * converges": `agentboard.remote`, the upstream of the main checkout's
 * branch, `origin`, the only remote), or null; `events` is the number of
 * event files in `.board/events` when the function returns;
 * `hostGitignore` names the host `.gitignore` when the move added the
 * `.board/` entry (missing from a board made by hand), else null;
 * `warnings` holds, in this order where they apply, the line of an
 * unreachable host remote (see step 3) and the warnings of the final
 * `sync`; `repair` is the repair outcome for `repaired`, else null.
 */
export interface IntoHostResult extends InitResult {
  /** See `IntoHostAction`. */
  readonly action: IntoHostAction;
  /**
   * Absolute path of the kept old repository,
   * `<host git common dir>/agentboard/standalone-<UTC timestamp>`
   * (`standaloneKeptName`, with `-2`, `-3`, ... appended while the name is
   * taken), for `moved` and `resumed` (the newest `standalone-*` directory
   * for `resumed`); null for `unchanged` and `repaired`.
   */
  readonly keptAt: string | null;
  /**
   * The URL of the standalone board's chosen remote as written in its
   * configuration (the raw `remote.<name>.url`, so a URL that
   * `url.<base>.insteadOf` rewrites is reported as the user wrote it,
   * which is the remote they retire) for `moved`, read from the kept
   * repository for `resumed`; null when the standalone board had no
   * remote, and for `unchanged` and `repaired`.
   */
  readonly oldRemoteUrl: string | null;
  /**
   * The result of the `sync` step 7 ran (`syncBoard` on the new host-model
   * board: `model` `host`), for `moved` and `resumed`; null for `unchanged`
   * and `repaired`, which run no `sync`.
   */
  readonly sync: SyncResult | null;
}

/**
 * `agentboard init --into-host`: moves the standalone board at the
 * directory discovery names (`locateBoard` with `options`, as `initBoard`)
 * into the host repository. Needs no actor.
 *
 * Step 1, checks, in this order, each before anything is written (no ref
 * under `refs/agentboard/`, no `<git common dir>/agentboard/` directory
 * and no init lock when it did not exist, `.board` byte for byte as it
 * was, the host's refs and worktree list unchanged):
 *
 * 1. `git` can be run, else `BoardError(1, 'git-missing')` as `initBoard`;
 *    `gitVersion` meets `HOST_MODEL_GIT_FLOOR` (2.32), else
 *    `BoardError(1, 'git-too-old')` whose message names the version found
 *    and says the host model needs git 2.32 or later (the text `2.32`
 *    appears), whatever the board or the directory is (also on a
 *    host-model board, and outside a git repository).
 * 2. Discovery's source is `git` and the host has an in-tree git directory
 *    (`hasInTreeGitDir(<parent of dir>)`), else
 *    `BoardError(1, 'no-host-repository')` whose message says the board
 *    was not found through a git repository with its `.git` directory
 *    inside its working tree (the words `git repository` appear; with
 *    `AGENTBOARD_DIR` set, the variable's name appears) and that the move
 *    runs at the root of the main checkout.
 * 3. The board exists (`boardExists(dir)`), else
 *    `BoardError(2, 'board-not-found')` naming `dir`, as every board
 *    command.
 * 4. `detectBoardModel(dir)`:
 *    - `host`: action `unchanged`, exit 0, nothing done (the lock restored
 *      when it is missing, as `initBoard`), the `InitResult` fields as
 *      `initBoard` reports an existing host-model board, and a message
 *      saying the board is already in the host repository (the words
 *      `already` and `host repository` appear). No `sync` runs.
 *    - `broken-host-link`, or `not-a-repository` (a `.board` that is not
 *      a repository): the repair of `initBoard` (under the init lock),
 *      action `repaired`, exit 0.
 *    - `standalone`: the move. With `<board git>` the runner for `dir`:
 *      no rebase, merge, cherry-pick or revert in progress in its git
 *      directory, else `BoardError(3, 'sync-in-progress')` with the
 *      message of `checkNothingInProgress`; HEAD on a branch, else
 *      `BoardError(3, 'detached-head')` with the message of `sync`; HEAD
 *      names a commit, else `BoardError(4, 'unsynced')` saying the board
 *      has no commit yet and to run `agentboard sync` first (that text
 *      appears); every event file in HEAD's tree is present in `events/`,
 *      else `BoardError(5, 'integrity')` with the message of
 *      `checkCommittedEventsPresent`; every present event file whose
 *      content differs from the committed blob of the same path (a
 *      content-addressed file modified in place: `git diff --name-only --
 *      events` not empty) is `BoardError(5, 'integrity')` naming the
 *      files; no event file is untracked or staged (`git status
 *      --porcelain -- events`, temporaries `events/.tmp-*` ignored, prints
 *      nothing), else `BoardError(4, 'unsynced')` whose message gives the
 *      count as `<n> event file(s)` and says to run `agentboard sync`
 *      first (the text `agentboard sync` appears).
 * 5. The standalone remote: `boardRemote(info)`. Ambiguous:
 *    `ambiguousRemoteError(choice, 'init')`, exit 1 `ambiguous-remote`.
 *    When a remote is chosen: `fetch --no-tags <remote>
 *    +refs/heads/<branch>:refs/remotes/<remote>/<branch>` in `dir` (so the
 *    remote-tracking ref holds the remote's tip whatever the remote's fetch
 *    refspec is); a failure (unreachable, no such branch on the remote
 *    when the local branch has commits) is `BoardError(3, 'sync-failed')`
 *    naming the remote and git's first error line. Then HEAD must be an
 *    ancestor of (or equal to) that tip (`merge-base --is-ancestor HEAD
 *    refs/remotes/<remote>/<branch>`), else `BoardError(4, 'unsynced')`
 *    saying the branch has commits the remote does not and to run
 *    `agentboard sync` first. The source tip is
 *    `refs/remotes/<remote>/<branch>` (it may hold other clones' events),
 *    else `refs/heads/<branch>`.
 * 6. The host remote: `chooseRemote(hostRoot, <the main checkout's
 *    branch>)` as `initBoard`; ambiguous: `ambiguousRemoteError(choice,
 *    'init')`, exit 1 `ambiguous-remote`, before anything is written.
 *
 * Steps 2 to 7 run under `withInitLock(hostRoot, ...)` (design.md decision
 * 2: `<git common dir>/agentboard/init.lock`), so two moves or an `init`
 * and a move on one host take turns. Under the lock the model is read
 * again; a `.board` that is a host-model board by then is `unchanged`.
 * First, leftovers: `removeDeadMigratingWorktrees(hostRoot)` (a temporary
 * worktree of a move killed before the rename, while `.board` is still
 * standalone, holds nothing that is not in the old board or the refs; the
 * message names what was removed). Then the host `.gitignore` entry
 * (`ignoreBoardInHost(hostRoot)` when the parent of `dir` is the top level
 * of a working tree, as `initBoard`). Each git command line below is given
 * as the move runs it, after the runner's `-c` prefix, so a shim on the
 * PATH can match it:
 *
 * 2. `fetch --no-tags <dir> +<source tip>:refs/agentboard/migrating` run
 *    in `hostRoot` (`<dir>` the standalone repository as a local path,
 *    `<source tip>` the ref of step 5), so `MIGRATING_REF` holds the source
 *    tip in the host's object store. No other command of the move has the
 *    text `:refs/agentboard/migrating` in its arguments.
 * 3. `worktree add --detach <migratingWorktreePath(hostRoot)>
 *    refs/agentboard/migrating` in `hostRoot` (the parent directories
 *    created first). Then, in that worktree, with `<old>` the value of
 *    `refs/agentboard/board` read now (the empty string when it does not
 *    exist): when the local ref exists and is not an ancestor of HEAD,
 *    `rebase --no-verify refs/agentboard/board` (the step 2 rule of
 *    `syncHostBoard` without its `ORIG_HEAD` exception, which cannot apply
 *    to a fresh worktree). Then the host remote, when there is one:
 *    `ls-remote <remote> refs/agentboard/board`; when it lists the ref,
 *    `fetch --no-tags <remote> refs/agentboard/board` (into the temporary
 *    worktree's own `FETCH_HEAD`) and, when `FETCH_HEAD` is not an ancestor
 *    of HEAD, `rebase --no-verify FETCH_HEAD`; `joined` is then true. When
 *    the `ls-remote` fails (the remote cannot be reached) the remote is
 *    treated as having no board ref: a warning names the remote and says
 *    the final `sync` publishes the board once it can be reached, and the
 *    move goes on (the `sync` of step 7 then fails as described there). A
 *    relative remote URL is resolved against the host's top level as
 *    `syncHostBoard` does. A rebase that stops on a conflict is left in
 *    place in the temporary worktree for a human and is
 *    `BoardError(3, 'sync-conflict')` whose message names every unmerged
 *    path, the temporary worktree's path and `git rebase --continue` (or
 *    `--abort`); the old `.board` is untouched and still standalone,
 *    `refs/agentboard/board` keeps the value it had (absent stays absent),
 *    and a re-run removes the temporary worktree and starts again. A
 *    rebase that fails for another reason is `BoardError(3, 'sync-failed')`
 *    with git's first error line, the temporary worktree removed.
 * 4. `update-ref refs/agentboard/board <HEAD of the worktree> <old>` in
 *    `hostRoot` (the compare-and-swap against the value seen in step 3;
 *    the empty old value creates the ref); a failure (something moved the
 *    ref in between) is `BoardError(3, 'sync-failed')` naming the ref, the
 *    temporary worktree removed and the old `.board` untouched. Then
 *    `update-ref -d refs/agentboard/migrating`.
 * 5. `verifyEventFiles(<dir>/events, <temporary worktree>/events)`: when
 *    anything is missing or differs, `BoardError(5, 'integrity')` naming
 *    every such file and the temporary worktree; the old `.board` is
 *    untouched and still standalone, the temporary worktree and
 *    `MIGRATING_REF` are removed (`refs/agentboard/board` keeps the value
 *    step 4 gave it: every commit of it is a correct board history).
 * 6. The old `.board` is renamed to
 *    `<git common dir>/agentboard/<standaloneKeptName(now)>` (same file
 *    system, one rename; a numeric suffix keeps two moves kept in one
 *    second apart), then `worktree move <temporary worktree> <dir>`, then
 *    `worktree lock --reason "agentboard board" <dir>`, then sparse
 *    checkout disabled as `addBoardWorktree` does. The old repository is
 *    never deleted and never modified (its cache file goes with it).
 * 7. `syncBoard` on the board at `dir` (`openBoard`, closed afterwards),
 *    which publishes `refs/agentboard/board` on the host's remote and
 *    catches the cache up. When that `sync` throws a `BoardError`
 *    (`sync-failed` for an unreachable remote or a refused push,
 *    `sync-conflict`, `ambiguous-remote`), the move stays done (`.board`
 *    is the locked host-model worktree, the old repository is kept,
 *    `refs/agentboard/board` equals HEAD or lags it as `syncHostBoard`
 *    describes) and the error propagates unchanged, so `init` exits with
 *    the failure's code and reason; the next `agentboard sync` publishes
 *    the board.
 *
 * Resuming (design.md decision 9): under the lock, when `dir` is missing
 * and `adoptMigratingWorktree(hostRoot, dir)` moves a temporary worktree
 * into place, step 7 runs and the action is `resumed`, `keptAt` the newest
 * `standalone-*` directory under `<git common dir>/agentboard/` (null when
 * there is none), `oldRemoteUrl` read from it. When `dir` is missing and
 * nothing can be adopted, `BoardError(2, 'board-not-found')`.
 *
 * Result for `moved`: `action` `moved`, `keptAt`, `oldRemoteUrl`, `sync`
 * as `IntoHostResult` says, and a message whose lines name `dir` and the
 * host model (`refs/agentboard/board`), the kept repository's path, the
 * old remote's URL (or that the board had no remote), that every other
 * clone of the project runs `agentboard init --into-host` too (that text
 * appears) and that the old remote can be retired once they have (the
 * word `retire` appears), then the sync's message lines. Plain ASCII, no
 * trailing newline.
 *
 * Running it again after success is `unchanged`: exit 0 and nothing
 * changes (no second kept repository, no ref or worktree added, no push).
 *
 * @throws BoardError as listed above.
 */
export function moveBoardIntoHost(options?: LocateOptions): IntoHostResult {
  void options;
  throw new Error('not implemented');
}
