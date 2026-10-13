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

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { openBoard } from '../store/board.js';
import { BoardError } from '../store/errors.js';
import { boardExists, locateBoard, type LocateOptions } from '../store/locate.js';
import {
  HOST_MODEL_GIT_FLOOR,
  firstErrorLine,
  gitRunner,
  gitVersion,
  isGitFailure,
  meetsGitFloor,
  type GitRunner,
} from './git.js';
import {
  AGENTBOARD_GIT_SUBDIR,
  addBoardWorktree,
  boardWorktreeLocked,
  registeredAt,
  removeLeftoverWorktree,
  withInitLock,
  type HostInitOptions,
} from './host-init.js';
import { resolveRemoteTarget } from './host-sync.js';
import { countEvents, hasInTreeGitDir, ignoreBoardInHost, initBoard, type InitResult } from './init.js';
import { BOARD_REF, detectBoardModel, type BoardModelInfo } from './model.js';
import { ambiguousRemoteError, boardRemote, chooseRemote, type ChosenRemote } from './remote.js';
import { syncBoard, type SyncResult } from './sync.js';
import {
  EVENT_PATH,
  checkCommittedEventsPresent,
  checkNothingInProgress,
  headExists,
  plural,
  syncFailed,
  unmergedPaths,
  zList,
} from './sync-steps.js';
import { asciiText, type Env } from './text.js';

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

/** The name of an event file. */
const EVENT_FILE = /^[0-9a-f]{64}\.json$/;

/** The command a human runs again after fixing what a refusal names. */
const AGAIN = 'agentboard init --into-host';

/**
 * The name of the kept old repository for the moment `now`:
 * `standalone-` followed by the UTC time as `YYYYMMDDTHHMMSSZ` (so
 * `standalone-20261013T153000Z` for 2026-10-13 15:30:00 UTC), plain ASCII,
 * no separators other than `T` and `Z`, sortable by time, the same shape
 * as `staleBoardName` in `host-init.ts`. Pure.
 */
export function standaloneKeptName(now: Date): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return (
    `${STANDALONE_KEPT_PREFIX}${pad(now.getUTCFullYear(), 4)}${pad(now.getUTCMonth() + 1)}` +
    `${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}` +
    `${pad(now.getUTCSeconds())}Z`
  );
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
  return join(migratingDir(hostDir, options), String(pid ?? process.pid));
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
  /**
   * True when a rebase is stopped in the worktree (`rebase-merge` or
   * `rebase-apply` exists in its git directory): a move that stopped on a
   * conflict in step 3, left for a human. False when not registered.
   */
  readonly rebasing: boolean;
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
  const base = migratingDir(hostDir, options);
  if (!existsSync(base)) {
    return [];
  }
  const git = gitRunner(hostDir, { env: options?.env });
  return readdirSync(base)
    .sort()
    .map((name) => {
      const path = join(base, name);
      const pid = /^[1-9][0-9]*$/.test(name) ? Number(name) : null;
      const registered = registeredAt(git, path) !== null;
      const head = registered && existsSync(path) ? commitOf(git, path, 'HEAD') : null;
      return {
        path,
        pid,
        alive: pid !== null && processAlive(pid),
        registered,
        head,
        rebasing: registered && existsSync(path) && rebaseStopped(git, path),
      };
    });
}

/**
 * Removes every temporary worktree under `<git common dir>/agentboard/migrating/`
 * that holds nothing a re-run needs: its pid is not running
 * (`MigratingWorktree.alive` false, which a pid that is not a number
 * counts as), it has no rebase state (`rebasing` false), and it is either
 * not registered (a plain directory) or registered with a HEAD equal to
 * `MIGRATING_REF` (nothing was integrated in it yet). Each is
 * unregistered (unlocked and removed by force when registered, as
 * `removeLeftoverWorktree` does) and deleted from disk. Left alone: one
 * whose pid is alive (another move in progress on this host, beyond the
 * init lock's 60 second stale limit); one with a rebase stopped in it (a
 * conflict a human resolves there, see `moveBoardIntoHost` step 3); one
 * whose HEAD differs from `MIGRATING_REF` or whose ref is gone (a rebase
 * finished in it, which the re-run adopts). Also deletes `MIGRATING_REF`
 * when no temporary worktree remains at all. Returns the paths removed,
 * ascending. Never throws for a missing directory; nothing else in the
 * repository changes.
 */
export function removeDeadMigratingWorktrees(hostDir: string, options?: HostInitOptions): string[] {
  const git = hostGit(hostDir, options);
  const migratingRef = refValue(git, MIGRATING_REF);
  const removed: string[] = [];
  for (const worktree of findMigratingWorktrees(hostDir, options)) {
    if (worktree.alive || worktree.rebasing) {
      continue;
    }
    // A registered worktree whose HEAD left the temporary ref (or whose
    // ref is gone) holds a finished rebase: the re-run adopts it.
    if (worktree.registered && worktree.head !== null && worktree.head !== migratingRef) {
      continue;
    }
    removeLeftoverWorktree(git, worktree.path);
    removed.push(worktree.path);
  }
  // The ref is deleted only when it exists: a move runs this pass before
  // its step 2, and an `update-ref -d` of a missing ref would be a no-op
  // that a shim or a trace could mistake for the end of step 4.
  if (migratingRef !== '' && findMigratingWorktrees(hostDir, options).length === 0) {
    git.attempt('update-ref', '-d', MIGRATING_REF);
  }
  return removed.sort();
}

/**
 * Finishes a move that was interrupted after the old `.board` was renamed
 * away and before the temporary worktree was moved into place (design.md
 * decision 9, "Resuming"): when `dir` (`<hostDir>/.board`) is missing and
 * exactly one temporary worktree under `<git common dir>/agentboard/migrating/`
 * is registered, present, has a dead pid, no rebase state and a HEAD
 * equal to `refs/agentboard/board`, `git worktree move` it to `dir` and
 * lock it with `WORKTREE_LOCK_REASON`; returns true. Otherwise changes
 * nothing and returns false (also when `dir` exists, when the worktree's
 * HEAD differs from the ref, when a rebase is stopped in it, or when its
 * pid is alive). The other adoption, of a temporary worktree whose rebase
 * finished while `.board` is still standalone, is part of
 * `moveBoardIntoHost` (step 3).
 */
export function adoptMigratingWorktree(
  hostDir: string,
  dir: string,
  options?: HostInitOptions,
): boolean {
  const candidate = resumable(hostDir, dir, options);
  if (candidate === null) {
    return false;
  }
  const git = hostGit(hostDir, options);
  git.run('worktree', 'move', candidate, dir);
  addBoardWorktree(hostDir, dir, options);
  return true;
}

/**
 * The one temporary worktree `adoptMigratingWorktree` would move into
 * place (registered, present, dead pid, no rebase state, HEAD at
 * `BOARD_REF`), or null when `dir` exists or there is not exactly one.
 * Read-only, so the decision to resume is taken before the init lock.
 */
function resumable(hostDir: string, dir: string, options?: HostInitOptions): string | null {
  if (existsSync(dir)) {
    return null;
  }
  const ref = refValue(gitRunner(hostDir, { env: options?.env }), BOARD_REF);
  if (ref === '') {
    return null;
  }
  const candidates = findMigratingWorktrees(hostDir, options).filter(
    (w) => w.registered && existsSync(w.path) && !w.alive && !w.rebasing && w.head === ref,
  );
  return candidates.length === 1 ? (candidates[0]?.path ?? null) : null;
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
  const missing: string[] = [];
  const different: string[] = [];
  if (!existsSync(from)) {
    return { missing, different };
  }
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (!entry.isFile() || !EVENT_FILE.test(entry.name)) {
      continue;
    }
    const copy = join(to, entry.name);
    if (!existsSync(copy)) {
      missing.push(entry.name);
    } else if (!readFileSync(join(from, entry.name)).equals(readFileSync(copy))) {
      different.push(entry.name);
    }
  }
  return { missing: missing.sort(), different: different.sort() };
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
 *    When a remote is chosen: `fetch --no-tags --no-write-fetch-head
 *    <remote> +refs/heads/<branch>:refs/remotes/<remote>/<branch>` in
 *    `dir` (so the remote-tracking ref holds the remote's tip whatever the
 *    remote's fetch refspec is; without `FETCH_HEAD`, so a refusal leaves
 *    the board repository byte for byte as it was); a failure
 *    (unreachable, no such branch on the remote when the local branch has
 *    commits) is `BoardError(3, 'sync-failed')` naming the remote and
 *    git's first error line. Then HEAD must be an ancestor of (or equal
 *    to) that tip (`merge-base --is-ancestor HEAD
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
 * First, leftovers (`findMigratingWorktrees(hostRoot)`): a dead-pid
 * temporary worktree with a rebase stopped in it (a move that stopped on
 * a conflict in step 3) is never removed: `BoardError(3,
 * 'sync-in-progress')` whose message names its path and the human steps
 * of step 3 (resolve, `git add`, `git rebase --continue` in that
 * worktree, then `agentboard init --into-host` again; the texts
 * `git rebase --continue` and `agentboard init --into-host` appear),
 * with nothing changed: the old `.board` untouched, the worktree, its
 * rebase state and `MIGRATING_REF` as they were. Otherwise
 * `removeDeadMigratingWorktrees(hostRoot)` removes the temporaries that
 * hold nothing (the message names what was removed), and a dead-pid
 * temporary worktree without rebase state whose HEAD differs from
 * `MIGRATING_REF` (or whose ref is gone: a rebase finished in it, by the
 * move before it was killed or by a human's `git rebase --continue`) is
 * adopted: steps 2 and the `worktree add` of step 3 are skipped and the
 * move goes on in it from the integration of step 3 (its rebases are
 * no-ops for what is already integrated), through steps 4 to 7; `action`
 * is `moved`. Then the host `.gitignore` entry
 * (`ignoreBoardInHost(hostRoot)` when the parent of `dir` is the top level
 * of a working tree, as `initBoard`). Each git command line below is given
 * as the move runs it, after the runner's `-c` prefix, so a shim on the
 * PATH can match it:
 *
 * 2. `fetch --no-tags --no-write-fetch-head <dir>
 *    +<source tip>:refs/agentboard/migrating` run in `hostRoot` (`<dir>`
 *    the standalone repository as a local path, `<source tip>` the ref of
 *    step 5; without `FETCH_HEAD`, so the host's own is left alone), so
 *    `MIGRATING_REF` holds the source tip in the host's object store. No
 *    other command of the move has the text `:refs/agentboard/migrating`
 *    in its arguments.
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
 *    path, the temporary worktree's path and the human steps: resolve
 *    the paths, `git add` them and `git rebase --continue` in that
 *    worktree (or `git rebase --abort`), then run
 *    `agentboard init --into-host` again (the texts `git rebase
 *    --continue` and `agentboard init --into-host` appear); the old
 *    `.board` is untouched and still standalone, `refs/agentboard/board`
 *    keeps the value it had (absent stays absent), and `MIGRATING_REF`
 *    and the temporary worktree stay. A re-run while the rebase is still
 *    stopped exits 3 `sync-in-progress` with the same instructions and
 *    removes nothing (see "leftovers" above); a re-run after the human
 *    finished the rebase adopts the worktree and completes the move with
 *    every event (the resolved `.gitignore` as the human left it). A
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
 * nothing can be adopted, `BoardError(2, 'board-not-found')`. The
 * adoption of a temporary worktree whose rebase finished while `.board`
 * is still standalone is described under "leftovers" above.
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
  const { dir, source } = locateBoard(options);
  const env: Env = options?.env ?? process.env;
  const cwd = options?.cwd ?? process.cwd();
  checkGit(env, cwd);
  const hostRoot = dirname(dir);
  if (source !== 'git' || !hasInTreeGitDir(hostRoot, env)) {
    throw new BoardError(
      1,
      'no-host-repository',
      `${source === 'env' ? `the board named by AGENTBOARD_DIR, ${asciiText(dir)},` : `the board at ${asciiText(dir)}`} ` +
        'was not found through a git repository with its .git directory inside its working ' +
        `tree, so there is no host repository to move it into; unset AGENTBOARD_DIR and run ${AGAIN} ` +
        'at the root of the main checkout of the project',
    );
  }
  if (!boardExists(dir)) {
    // Only a move interrupted between keeping the old board aside and
    // moving its worktree into place leaves no board here; everything
    // else is a missing board, refused before any lock is taken.
    if (resumable(hostRoot, dir, { env }) !== null) {
      const remote = hostRemote(hostRoot, env);
      const resumed = withInitLock(
        hostRoot,
        () =>
          adoptMigratingWorktree(hostRoot, dir, { env })
            ? resumedMove(dir, hostRoot, remote, env)
            : null,
        { env },
      );
      if (resumed !== null) {
        return resumed;
      }
    }
    throw notFound(dir);
  }
  const info = detectBoardModel(dir, { env });
  if (info.model === 'host') {
    return unchangedBoard(dir, info, env);
  }
  if (info.model !== 'standalone') {
    return repairedBoard(initBoard(options));
  }
  const plan = checkStandalone(dir, info, env);
  const remote = hostRemote(hostRoot, env);
  const outcome = withInitLock(hostRoot, () => lockedMove(dir, hostRoot, plan, remote, env), { env });
  return outcome === 'repair' ? repairedBoard(initBoard(options)) : outcome;
}

/** Step 1, check 3: the refusal of a missing board, as `findBoard` words it for a board found through git. */
function notFound(dir: string): BoardError {
  return new BoardError(
    2,
    'board-not-found',
    `no board found at ${dir} (<git common dir>/../.board); run agentboard init to create one`,
  );
}

/** Step 1, check 1: git runs and meets the host model's floor. */
function checkGit(env: Env, cwd: string): void {
  const version = gitVersion(env, cwd);
  if (version === null) {
    throw new BoardError(
      1,
      'git-missing',
      'agentboard init needs git (the board is kept in a git repository), but git could not be run',
    );
  }
  if (!meetsGitFloor(version)) {
    const found = `${String(version.major)}.${String(version.minor)}.${String(version.patch)}`;
    const floor = `${String(HOST_MODEL_GIT_FLOOR.major)}.${String(HOST_MODEL_GIT_FLOOR.minor)}`;
    throw new BoardError(
      1,
      'git-too-old',
      `git ${found} was found, but a board in the host repository needs git ${floor} or later; ` +
        `upgrade git and run ${AGAIN} again`,
    );
  }
}

/** What step 1 learned about the standalone board, for steps 2 to 7. */
interface MovePlan {
  /** The ref step 2 fetches from the standalone repository: the remote-tracking ref of its branch, else the branch. */
  readonly sourceTip: string;
  /** The raw `remote.<name>.url` of the chosen remote, or null without one. */
  readonly oldRemoteUrl: string | null;
}

/** Step 1, check 4 (standalone) and 5: the standalone board can be moved without losing an event. */
function checkStandalone(dir: string, info: BoardModelInfo, env: Env): MovePlan {
  const git = gitRunner(dir, { env });
  checkNothingInProgress(git, dir);
  const branch = git.attempt('symbolic-ref', '--quiet', '--short', 'HEAD');
  if (isGitFailure(branch)) {
    throw new BoardError(
      3,
      'detached-head',
      `the board repository at ${asciiText(dir)} has a detached HEAD; check out its branch ` +
        `(git -C ${asciiText(dir)} switch main) and run ${AGAIN} again`,
    );
  }
  if (!headExists(git)) {
    throw new BoardError(
      4,
      'unsynced',
      `the board repository at ${asciiText(dir)} has no commit yet, so its events are not ` +
        `committed; run agentboard sync first, then ${AGAIN} again`,
    );
  }
  checkCommittedEventsPresent(git, { dir });
  const modified = zList(
    git.run('diff', '--name-only', '-z', '--diff-filter=M', 'HEAD', '--', 'events'),
  )
    .filter((path) => EVENT_PATH.test(path))
    .sort();
  if (modified.length > 0) {
    throw new BoardError(
      5,
      'integrity',
      `${plural(modified.length, 'committed event file')} in ${asciiText(dir)} differ from their ` +
        `committed content: ${modified.map((p) => asciiText(p)).join(', ')}; event files are ` +
        'named by their content and never change, so nothing was moved; restore them with ' +
        modified.map((p) => `git -C ${asciiText(dir)} checkout -- ${asciiText(p)}`).join(' and '),
    );
  }
  const pending = git
    .run('status', '--porcelain', '--untracked-files=all', '--', 'events')
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter((path) => path !== '' && !basename(path).startsWith('.tmp-'));
  if (pending.length > 0) {
    throw new BoardError(
      4,
      'unsynced',
      `${plural(pending.length, 'event file')} in ${asciiText(join(dir, 'events'))} ` +
        `${pending.length === 1 ? 'is' : 'are'} not committed; run agentboard sync first, ` +
        `then ${AGAIN} again`,
    );
  }

  const choice = boardRemote(info, { env });
  if (choice.ambiguous) {
    throw ambiguousRemoteError(choice, 'init');
  }
  const remote = choice.chosen;
  if (remote === null) {
    return { sourceTip: `refs/heads/${branch.trim()}`, oldRemoteUrl: null };
  }
  const name = remote.name;
  const tracking = `refs/remotes/${name}/${branch.trim()}`;
  const fetched = git.attempt(
    'fetch',
    '--no-tags',
    '--no-write-fetch-head',
    name,
    `+refs/heads/${branch.trim()}:${tracking}`,
  );
  if (isGitFailure(fetched)) {
    throw syncFailed(`fetching ${asciiText(branch.trim())} from ${asciiText(name)}`, fetched);
  }
  if (!isAncestor(git, 'HEAD', tracking)) {
    throw new BoardError(
      4,
      'unsynced',
      `the branch ${asciiText(branch.trim())} of the board repository at ${asciiText(dir)} has ` +
        `commits that ${asciiText(name)} does not; run agentboard sync first, then ${AGAIN} again`,
    );
  }
  const url = git.attempt('config', '--get', `remote.${name}.url`);
  return { sourceTip: tracking, oldRemoteUrl: isGitFailure(url) ? null : url.trim() };
}

/** Step 1, check 6: the host repository's remote, refused when ambiguous. */
function hostRemote(hostRoot: string, env: Env): ChosenRemote | null {
  const branch = gitRunner(hostRoot, { env }).attempt('symbolic-ref', '--quiet', '--short', 'HEAD');
  const choice = chooseRemote(hostRoot, isGitFailure(branch) ? null : branch.trim(), { env });
  if (choice.ambiguous) {
    throw ambiguousRemoteError(choice, 'init');
  }
  return choice.chosen;
}

/**
 * Steps 2 to 7, under the init lock. Returns `repair` when the board is
 * no longer standalone nor healthy, so the caller repairs it as `initBoard`
 * does once the lock is released (`initBoard` takes the lock itself).
 */
function lockedMove(
  dir: string,
  hostRoot: string,
  plan: MovePlan,
  remote: ChosenRemote | null,
  env: Env,
): IntoHostResult | 'repair' {
  if (!boardExists(dir)) {
    if (adoptMigratingWorktree(hostRoot, dir, { env })) {
      return resumedMove(dir, hostRoot, remote, env);
    }
    throw notFound(dir);
  }
  const info = detectBoardModel(dir, { env });
  if (info.model === 'host') {
    return unchangedBoard(dir, info, env);
  }
  if (info.model !== 'standalone') {
    return 'repair';
  }
  const host = hostGit(hostRoot, { env });
  const scratch = join(commonDir(host, hostRoot), AGENTBOARD_GIT_SUBDIR);

  // Leftovers of earlier moves: a stopped rebase waits for a human, what
  // holds nothing is removed, and a finished rebase is adopted. A
  // temporary named by this process's own pid is one an earlier call in
  // this process left (it holds the lock alone and runs one move at a
  // time), so it is treated as a dead one here, although the helpers
  // report it alive.
  const done = (w: MigratingWorktree): boolean => !w.alive || w.pid === process.pid;
  const leftovers = findMigratingWorktrees(hostRoot, { env });
  const stopped = leftovers.find((w) => done(w) && w.rebasing);
  if (stopped !== undefined) {
    throw new BoardError(
      3,
      'sync-in-progress',
      `an earlier ${AGAIN} stopped on a conflict, and its rebase is still in progress in the ` +
        `temporary worktree at ${asciiText(stopped.path)}; resolve the conflict, git add the paths ` +
        `and git rebase --continue (or git rebase --abort) in ${asciiText(stopped.path)}, then ` +
        `run ${AGAIN} again; the board at ${asciiText(dir)} is untouched`,
    );
  }
  const removed = removeDeadMigratingWorktrees(hostRoot, { env });
  const migratingRef = refValue(host, MIGRATING_REF);
  for (const own of leftovers.filter(
    (w) => w.pid === process.pid && !w.rebasing && (w.head === null || w.head === migratingRef),
  )) {
    removeLeftoverWorktree(host, own.path);
    removed.push(own.path);
  }
  const adoptable = findMigratingWorktrees(hostRoot, { env }).find(
    (w) => done(w) && !w.rebasing && w.registered && w.head !== null && w.head !== migratingRef,
  );
  const hostGitignore = ignoreBoardInHost(hostRoot);

  // 2. The source tip into the temporary ref; 3. the temporary worktree.
  let temp: string;
  if (adoptable === undefined) {
    host.run('fetch', '--no-tags', '--no-write-fetch-head', dir, `+${plan.sourceTip}:${MIGRATING_REF}`);
    temp = migratingWorktreePath(hostRoot, process.pid, { env });
    mkdirSync(dirname(temp), { recursive: true });
    host.run('worktree', 'add', '--detach', temp, MIGRATING_REF);
  } else {
    temp = adoptable.path;
  }
  const worktree = gitRunner(temp, { env, disableHooks: true });
  const old = refValue(host, BOARD_REF);
  if (old !== '' && !isAncestor(worktree, BOARD_REF, 'HEAD')) {
    rebaseOnto(host, worktree, dir, temp, BOARD_REF, `the local ${BOARD_REF}`);
  }
  const warnings: string[] = [];
  let joined = false;
  if (remote !== null) {
    const target = resolveRemoteTarget(remote.name, remote.url, hostRoot);
    const listed = worktree.attempt('ls-remote', target, BOARD_REF);
    if (isGitFailure(listed)) {
      warnings.push(
        `the host remote ${asciiText(remote.name)} could not be reached (${firstErrorLine(listed)}); ` +
          `the board is moved anyway, and agentboard sync publishes it once ${asciiText(remote.name)} ` +
          'can be reached',
      );
    } else if (listed.trim() !== '') {
      const fetched = worktree.attempt('fetch', '--no-tags', target, BOARD_REF);
      if (isGitFailure(fetched)) {
        discardTemporary(host, temp);
        throw syncFailed(`fetching ${BOARD_REF} from ${asciiText(remote.name)}`, fetched);
      }
      if (!isAncestor(worktree, 'FETCH_HEAD', 'HEAD')) {
        rebaseOnto(host, worktree, dir, temp, 'FETCH_HEAD', `what ${asciiText(remote.name)} holds`);
      }
      joined = true;
    }
  }

  // 4. The compare-and-swap, then the temporary ref goes.
  const head = worktree.run('rev-parse', 'HEAD').trim();
  if (isGitFailure(host.attempt('update-ref', BOARD_REF, head, old))) {
    discardTemporary(host, temp);
    throw new BoardError(
      3,
      'sync-failed',
      `updating ${BOARD_REF} in the host repository failed because something else moved it ` +
        `meanwhile; nothing was moved; run ${AGAIN} again`,
    );
  }
  host.run('update-ref', '-d', MIGRATING_REF);

  // 5. Every old event file, byte for byte.
  const check = verifyEventFiles(join(dir, 'events'), join(temp, 'events'));
  if (check.missing.length > 0 || check.different.length > 0) {
    discardTemporary(host, temp);
    const names = (list: readonly string[]): string => list.map((n) => asciiText(n)).join(', ');
    throw new BoardError(
      5,
      'integrity',
      `the new worktree at ${asciiText(temp)} did not hold every event file of ${asciiText(dir)} ` +
        `byte for byte (${check.missing.length > 0 ? `missing: ${names(check.missing)}` : ''}` +
        `${check.missing.length > 0 && check.different.length > 0 ? '; ' : ''}` +
        `${check.different.length > 0 ? `different: ${names(check.different)}` : ''}); nothing was ` +
        `moved and the board at ${asciiText(dir)} is untouched; run ${AGAIN} again`,
    );
  }

  // 6. Keep the old repository, move the worktree into place, lock it.
  const keptAt = freshKeptName(scratch, new Date());
  renameSync(dir, keptAt);
  host.run('worktree', 'move', temp, dir);
  addBoardWorktree(hostRoot, dir, { env });

  // 7. Publish and catch up.
  const sync = syncNow(dir, env);
  const lines = [
    `moved the board at ${asciiText(dir)} into the host repository (host model: a worktree of ` +
      `the host repository at ${BOARD_REF})`,
    ...keptLines(keptAt, plan.oldRemoteUrl),
  ];
  if (removed.length > 0) {
    lines.push(`removed ${removed.map((p) => asciiText(p)).join(', ')}, left by an interrupted move`);
  }
  lines.push(...sync.message.split('\n'));
  return {
    dir,
    created: false,
    model: 'host',
    joined,
    remote: remote?.name ?? null,
    events: countEvents(dir),
    hostGitignore,
    warnings: [...warnings, ...sync.warnings],
    repair: null,
    message: lines.join('\n'),
    action: 'moved',
    keptAt,
    oldRemoteUrl: plan.oldRemoteUrl,
    sync,
  };
}

/** The move finished by `adoptMigratingWorktree` (action `resumed`): step 7 and the report. */
function resumedMove(
  dir: string,
  hostRoot: string,
  remote: ChosenRemote | null,
  env: Env,
): IntoHostResult {
  const scratch = join(commonDir(gitRunner(hostRoot, { env }), hostRoot), AGENTBOARD_GIT_SUBDIR);
  const keptAt = newestKept(scratch);
  const oldRemoteUrl = keptAt === null ? null : keptRemoteUrl(keptAt, env);
  const sync = syncNow(dir, env);
  const lines = [
    `finished moving the board at ${asciiText(dir)} into the host repository (host model: a ` +
      `worktree of the host repository at ${BOARD_REF}): moved the worktree of an interrupted ` +
      'move into place',
    ...(keptAt === null
      ? ['no kept copy of the old board repository was found']
      : keptLines(keptAt, oldRemoteUrl)),
    ...sync.message.split('\n'),
  ];
  return {
    dir,
    created: false,
    model: 'host',
    joined: false,
    remote: remote?.name ?? null,
    events: countEvents(dir),
    hostGitignore: null,
    warnings: [...sync.warnings],
    repair: null,
    message: lines.join('\n'),
    action: 'resumed',
    keptAt,
    oldRemoteUrl,
    sync,
  };
}

/** A board already in the host repository (action `unchanged`), the lock restored as `initBoard` does. */
function unchangedBoard(dir: string, info: BoardModelInfo, env: Env): IntoHostResult {
  const hostRoot = dirname(dir);
  const choice = boardRemote(info, { env });
  const remote = choice.chosen?.name ?? null;
  let changed = 'nothing changed';
  if (!boardWorktreeLocked(hostRoot, dir, { env })) {
    // Finishes a move or an init interrupted after the worktree was moved
    // or added and before its lock: locks it.
    addBoardWorktree(hostRoot, dir, { env });
    changed = 'restored the worktree lock that an interrupted init had not set';
  }
  return {
    dir,
    created: false,
    model: 'host',
    joined: false,
    remote,
    events: countEvents(dir),
    hostGitignore: null,
    warnings: [],
    repair: null,
    message:
      `the board at ${asciiText(dir)} is already in the host repository (host model: its ` +
      `history is ${BOARD_REF}; ${remote === null ? 'no remote configured' : `remote: ${asciiText(remote)}`}); ` +
      changed,
    action: 'unchanged',
    keptAt: null,
    oldRemoteUrl: null,
    sync: null,
  };
}

/** The result of `initBoard` on a broken link or a non-repository `.board` (action `repaired`). */
function repairedBoard(base: InitResult): IntoHostResult {
  return {
    ...base,
    action: base.repair === null ? 'unchanged' : 'repaired',
    keptAt: null,
    oldRemoteUrl: null,
    sync: null,
  };
}

/** The message lines naming the kept repository, the old remote and what the other clones do. */
function keptLines(keptAt: string, oldRemoteUrl: string | null): string[] {
  return [
    `the old board repository is kept at ${asciiText(keptAt)}`,
    oldRemoteUrl === null
      ? 'the old board had no remote'
      : `its remote was ${asciiText(oldRemoteUrl)} (as written in its configuration)`,
    `every other clone of the project runs ${AGAIN} too; retire the old remote once they all have`,
  ];
}

/** `syncBoard` on the board at `dir`, closed afterwards whatever happens. */
function syncNow(dir: string, env: Env): SyncResult {
  const board = openBoard(dir);
  try {
    return syncBoard(board, { env });
  } finally {
    board.close();
  }
}

/**
 * Rebases the temporary worktree's HEAD onto `onto`. A conflict is left in
 * place for a human (the worktree and `MIGRATING_REF` stay); any other
 * failure removes the worktree.
 */
function rebaseOnto(
  host: GitRunner,
  worktree: GitRunner,
  dir: string,
  temp: string,
  onto: string,
  what: string,
): void {
  const out = worktree.attempt('rebase', '--no-verify', onto);
  if (!isGitFailure(out)) {
    return;
  }
  const conflicted = unmergedPaths(worktree);
  if (conflicted.length > 0) {
    throw new BoardError(
      3,
      'sync-conflict',
      `integrating ${what} stopped on a conflict in the temporary worktree at ${asciiText(temp)}: ` +
        `${conflicted.map((p) => asciiText(p)).join(', ')}; resolve them, git add them and ` +
        `git rebase --continue (or git rebase --abort) in ${asciiText(temp)}, then run ${AGAIN} ` +
        `again; the board at ${asciiText(dir)} is untouched`,
    );
  }
  discardTemporary(host, temp);
  throw syncFailed(`integrating ${what}`, out);
}

/** Removes the temporary worktree at `temp` and the temporary ref after a refusal in steps 3 to 5. */
function discardTemporary(host: GitRunner, temp: string): void {
  removeLeftoverWorktree(host, temp);
  host.attempt('update-ref', '-d', MIGRATING_REF);
}

/** A runner for the host repository at `hostDir` with its hooks disabled. */
function hostGit(hostDir: string, options?: HostInitOptions): GitRunner {
  return gitRunner(hostDir, { env: options?.env, disableHooks: true });
}

/** The git common directory of the repository at `hostDir`, absolute. Creates nothing. */
function commonDir(git: GitRunner, hostDir: string): string {
  return resolve(hostDir, git.run('rev-parse', '--git-common-dir').trim());
}

/** `<git common dir>/agentboard/migrating` of the repository at `hostDir`. Creates nothing. */
function migratingDir(hostDir: string, options?: HostInitOptions): string {
  const git = gitRunner(hostDir, { env: options?.env });
  return join(commonDir(git, hostDir), AGENTBOARD_GIT_SUBDIR, MIGRATING_DIR);
}

/** The full id `ref` holds in the repository `git` runs in, or the empty string when it does not exist. */
function refValue(git: GitRunner, ref: string): string {
  const out = git.attempt('rev-parse', '--quiet', '--verify', `${ref}^{commit}`);
  return isGitFailure(out) ? '' : out.trim();
}

/** The full id of the commit `rev` names in the worktree at `cwd`, or null. */
function commitOf(git: GitRunner, cwd: string, rev: string): string | null {
  const out = git.attemptIn(cwd, 'rev-parse', '--quiet', '--verify', `${rev}^{commit}`);
  return isGitFailure(out) ? null : out.trim();
}

/** Whether `ancestor` is an ancestor of (or equal to) `descendant` in the repository `git` runs in. */
function isAncestor(git: GitRunner, ancestor: string, descendant: string): boolean {
  return !isGitFailure(git.attempt('merge-base', '--is-ancestor', ancestor, descendant));
}

/** Whether a rebase is stopped in the worktree at `cwd` (`rebase-merge` or `rebase-apply` in its git directory). */
function rebaseStopped(git: GitRunner, cwd: string): boolean {
  const gitDir = git.attemptIn(cwd, 'rev-parse', '--absolute-git-dir');
  if (isGitFailure(gitDir)) {
    return false;
  }
  return ['rebase-merge', 'rebase-apply'].some((name) => existsSync(join(gitDir.trim(), name)));
}

/** Whether a process with `pid` is running: `kill(pid, 0)` succeeds, or fails for a reason other than ESRCH. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code !== 'ESRCH';
  }
}

/** `<scratch>/<standaloneKeptName(now)>`, with `-2`, `-3`, ... appended while the name is taken. */
function freshKeptName(scratch: string, now: Date): string {
  const base = join(scratch, standaloneKeptName(now));
  let candidate = base;
  for (let n = 2; existsSync(candidate); n += 1) {
    candidate = `${base}-${String(n)}`;
  }
  return candidate;
}

/** The newest kept repository (`standalone-*`, the greatest name) under `scratch`, or null. */
function newestKept(scratch: string): string | null {
  if (!existsSync(scratch)) {
    return null;
  }
  const names = readdirSync(scratch)
    .filter((name) => name.startsWith(STANDALONE_KEPT_PREFIX))
    .sort();
  const newest = names[names.length - 1];
  return newest === undefined ? null : join(scratch, newest);
}

/** The raw URL of the remote the kept standalone repository at `kept` would sync with, or null. */
function keptRemoteUrl(kept: string, env: Env): string | null {
  const info = detectBoardModel(kept, { env });
  if (info.model !== 'standalone') {
    return null;
  }
  const name = boardRemote(info, { env }).chosen?.name;
  if (name === undefined) {
    return null;
  }
  const url = gitRunner(kept, { env }).attempt('config', '--get', `remote.${name}.url`);
  return isGitFailure(url) ? null : url.trim();
}
