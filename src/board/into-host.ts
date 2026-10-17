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

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { sha256Hex } from '../events/canonical.js';
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
  type GitFailure,
  type GitRunner,
} from './git.js';
import {
  AGENTBOARD_GIT_SUBDIR,
  INIT_LOCK_FILE,
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
 * The reserved, temporary ref that records the source tip the temporary
 * worktree has integrated (design.md decision 9, steps 2 and 3; round 4
 * ruling 1): set when the worktree is added and advanced to
 * `MIGRATING_FETCH_REF` only after a replay has integrated it, never by a
 * fetch alone, so a run that fetched and then stopped leaves the next run
 * replaying from the tip the worktree really holds. It lives as long as
 * the temporary worktree does: deleted in step 6 once the worktree is in
 * place (round 3 ruling 2); never left behind by a completed move,
 * deleted by a resumed move when it still exists, and removed by the
 * re-run after an interrupted one once no temporary worktree remains.
 */
export const MIGRATING_REF = 'refs/agentboard/migrating';

/**
 * The scratch ref step 2 fetches the source tip into (round 4 ruling 1):
 * the only ref a fetch of the move ever writes, overwritten by every run
 * (`+` refspec) and compared with `MIGRATING_REF` to decide the replay of
 * an adopted temporary worktree. Deleted together with `MIGRATING_REF`
 * (step 6, a resumed move, and the leftover pass once no temporary
 * worktree remains).
 */
export const MIGRATING_FETCH_REF = 'refs/agentboard/migrating-fetch';

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
 * The file in a temporary worktree's git directory that records the
 * identity of the standalone repository the worktree was made from
 * (`boardGitDir` of step 1; round 4 ruling 3): a re-run adopts the
 * worktree only when the record names the repository at `.board` now.
 */
const SOURCE_RECORD = 'agentboard-source';

/**
 * The file in a temporary worktree's git directory that records a replay
 * in progress (round 4 ruling 2): its two lines are the worktree's HEAD
 * when the `cherry-pick` started and the tip of `MIGRATING_FETCH_REF` it
 * replays up to. It is written before the `cherry-pick` and removed once
 * `MIGRATING_REF` has been advanced, so a run that stops in between (a
 * conflict left for a human, a kill) leaves the next run able to tell a
 * finished replay (the human's `git cherry-pick --continue`, or a kill
 * after the `cherry-pick` completed: HEAD moved on, every event file of
 * the range in HEAD's tree) from an abandoned one (`git cherry-pick
 * --abort` returns HEAD to the recorded start): the finished one counts
 * as integrated up to the recorded tip and is never replayed again (the
 * human's resolution of a replayed commit would conflict with the same
 * commit replayed once more), the abandoned one is replayed again.
 */
const REPLAY_RECORD = 'agentboard-replay';

/** The operation stopped in a temporary worktree, by the marker in its git directory. */
type StoppedOperation = 'rebase' | 'cherry-pick';

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
   * True when a rebase or a cherry-pick is stopped in the worktree
   * (`rebase-merge`, `rebase-apply` or `CHERRY_PICK_HEAD` exists in its
   * git directory): a move that stopped on a conflict in step 3, or on a
   * conflict of the replay of an adopted worktree (round 4 ruling 2),
   * left for a human. False when not registered.
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
 * counts as; one named by this process's own pid is left to the move,
 * which treats it as dead itself, since one process runs one move at a
 * time under the init lock), it has no rebase or cherry-pick state
 * (`rebasing` false), and it is either
 * not registered (a plain directory) or registered with a HEAD equal to
 * `MIGRATING_REF` (nothing was integrated in it yet). Each is
 * unregistered (unlocked and removed by force when registered, as
 * `removeLeftoverWorktree` does) and deleted from disk. Left alone: one
 * whose pid is alive (another move in progress on this host, beyond the
 * init lock's 60 second stale limit); one with a rebase or cherry-pick
 * stopped in it (a conflict a human resolves there, see
 * `moveBoardIntoHost` step 3); one whose HEAD differs from
 * `MIGRATING_REF` or whose ref is gone (a rebase finished in it, which
 * the re-run adopts when it belongs to the board at `.board`). Also
 * deletes `MIGRATING_REF` and `MIGRATING_FETCH_REF` when no temporary
 * worktree remains at all. Returns the paths removed, ascending. Never
 * throws for a missing directory; nothing else in the repository changes.
 */
export function removeDeadMigratingWorktrees(hostDir: string, options?: HostInitOptions): string[] {
  const git = hostGit(hostDir, options);
  const migratingRef = refValue(git, MIGRATING_REF);
  const removed: string[] = [];
  // The ref may be gone while worktrees remain: then every registered
  // HEAD differs from it and is kept for the re-run to judge.
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
  if (findMigratingWorktrees(hostDir, options).length === 0) {
    deleteTemporaryRefs(git);
  }
  return removed.sort();
}

/**
 * Deletes `MIGRATING_REF` and `MIGRATING_FETCH_REF`, each only when it
 * exists: a move runs the leftover pass before its step 2, and an
 * `update-ref -d` of a missing ref would be a no-op that a shim or a trace
 * could mistake for the deletions of step 6.
 */
function deleteTemporaryRefs(git: GitRunner): void {
  for (const ref of [MIGRATING_REF, MIGRATING_FETCH_REF]) {
    if (refValue(git, ref) !== '') {
      git.attempt('update-ref', '-d', ref);
    }
  }
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
 * What plain `init` and a move on a board already in the host do to the
 * leftovers of dead moves (design.md decision 9, ruling E; round 3 rulings
 * 3 and 4): every temporary worktree under
 * `<git common dir>/agentboard/migrating/` whose pid is dead (or this
 * process's own) and that has no rebase state is removed whatever its
 * HEAD (the board is in place, so there is nothing to adopt), and
 * `MIGRATING_REF` and `MIGRATING_FETCH_REF` are deleted when no temporary
 * remains. The `migrating`
 * directory, when it is then empty, goes only when no kept repository
 * (`STANDALONE_KEPT_PREFIX*`) exists under `<git common dir>/agentboard/`:
 * beside one it is the marker of a move whose `sync` of step 7 has not
 * completed (design.md decision 9, "Resuming"), left for
 * `moveBoardIntoHost` to resume, so the callers apply the marker rule
 * after this pass (plain `init` reports the pending move, a move resumes
 * it). A temporary with a rebase stopped in it, or a live pid, is left
 * alone. Returns the paths removed, ascending.
 */
export function cleanDeadMigratingWorktrees(hostDir: string, options?: HostInitOptions): string[] {
  const git = hostGit(hostDir, options);
  const removed: string[] = [];
  for (const worktree of findMigratingWorktrees(hostDir, options)) {
    if (!dead(worktree) || worktree.rebasing) {
      continue;
    }
    removeLeftoverWorktree(git, worktree.path);
    removed.push(worktree.path);
  }
  if (findMigratingWorktrees(hostDir, options).length === 0) {
    deleteTemporaryRefs(git);
  }
  if (!pendingMove(hostDir, options)) {
    removeEmptyMigratingDir(hostDir, options);
  }
  return removed.sort();
}

/**
 * True when the `migrating` directory of the host at `hostDir` exists,
 * holds no entry and a kept repository (`standalone-*`) exists beside it:
 * the marker of a move whose `sync` has not completed (design.md decision
 * 9, "Resuming"), which `moveBoardIntoHost` resumes and plain `init`
 * reports. Read-only.
 */
export function pendingMove(hostDir: string, options?: HostInitOptions): boolean {
  const base = migratingDir(hostDir, options);
  return (
    existsSync(base) &&
    readdirSync(base).length === 0 &&
    newestKept(join(commonDir(gitRunner(hostDir, { env: options?.env }), hostDir), AGENTBOARD_GIT_SUBDIR)) !== null
  );
}

/**
 * Removes `<git common dir>/agentboard/migrating` when it is empty: at the
 * end of step 7 (the marker of a move whose sync has not completed) and
 * after dead temporaries were cleaned. A directory that still holds an
 * entry (another move's temporary) or that is already gone is left alone.
 */
function removeEmptyMigratingDir(hostDir: string, options?: HostInitOptions): void {
  const base = migratingDir(hostDir, options);
  if (existsSync(base) && readdirSync(base).length === 0) {
    rmdirSync(base);
  }
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

/** The outcome of `carryOverEventFiles`. */
export interface EventCarryOver {
  /** Names (`<hash>.json`, ascending) copied from `from` into `to` because `to` lacked them. */
  readonly copied: readonly string[];
  /**
   * Names (ascending) of files in `from` whose content does not hash
   * (SHA-256, lower-case hex) to their name, or whose copy in `to` differs
   * from them byte for byte: never copied, never overwritten.
   */
  readonly mismatched: readonly string[];
}

/**
 * Step 5 of the move and its repeat after the rename (design.md decision
 * 9, orchestrator ruling A): the carry-over the repair of decision 7 does.
 * Every event file (`<64 hex>.json`; dot-named entries, temporaries and
 * subdirectories are ignored) of the directory `from` (the old
 * `.board/events`, or the kept repository's `events/`) that `to` (the new
 * worktree's `events/`) lacks is copied in when its content hashes to its
 * name (event files are content-addressed, so a copy can never change an
 * existing event); one whose content does not hash to its name, or whose
 * copy in `to` has different bytes, is reported in `mismatched` and left
 * alone. Copied files are left uncommitted for the `sync` of step 7. A
 * missing `from` copies nothing. Never deletes or overwrites anything.
 */
export function carryOverEventFiles(from: string, to: string): EventCarryOver {
  const copied: string[] = [];
  const mismatched: string[] = [];
  if (!existsSync(from)) {
    return { copied, mismatched };
  }
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (!entry.isFile() || !EVENT_FILE.test(entry.name)) {
      continue;
    }
    const content = readFileSync(join(from, entry.name));
    const copy = join(to, entry.name);
    if (sha256Hex(content) !== entry.name.slice(0, 64)) {
      mismatched.push(entry.name);
    } else if (!existsSync(copy)) {
      copyFileSync(join(from, entry.name), copy);
      copied.push(entry.name);
    } else if (!content.equals(readFileSync(copy))) {
      mismatched.push(entry.name);
    }
  }
  return { copied: copied.sort(), mismatched: mismatched.sort() };
}

/**
 * The failure of the `sync` of step 7 (orchestrator ruling C): a
 * `BoardError` with the sync's exit code and reason, whose message starts
 * with the move's lines (the board moved, the kept repository, the old
 * remote, the command for the other clones) and ends with the sync's
 * message, and which carries `keptAt` and `oldRemoteUrl` so the CLI's
 * `--json` error document (`errorDocument` in `src/cli/main.ts`) can
 * print them beside `exitCode`, `reason`, `message` and `hint`: the
 * document's `error` object gains the keys `keptAt` and `oldRemoteUrl`
 * exactly when the thrown error is a `MoveSyncFailure`.
 */
export class MoveSyncFailure extends BoardError {
  /** As `IntoHostResult.keptAt`. */
  readonly keptAt: string | null;
  /** As `IntoHostResult.oldRemoteUrl`. */
  readonly oldRemoteUrl: string | null;

  constructor(cause: BoardError, message: string, keptAt: string | null, oldRemoteUrl: string | null) {
    super(cause.exitCode, cause.reason, message);
    this.name = 'MoveSyncFailure';
    this.keptAt = keptAt;
    this.oldRemoteUrl = oldRemoteUrl;
  }
}

/**
 * What `moveBoardIntoHost` did:
 * - `moved`: the standalone board was moved into the host model in this
 *   run (steps 2 to 7).
 * - `resumed`: a move interrupted after the old repository was kept aside
 *   (between the rename and the `worktree move`, finished by
 *   `adoptMigratingWorktree`; or between the `worktree move` and the end
 *   of the `sync` of step 7, found by the `migrating` marker directory)
 *   was finished: the lock restored when missing, then step 7 ran.
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
 * and a move on one host take turns. The lock file's mtime is refreshed
 * (`utimes` to now) immediately before each network step (the
 * `ls-remote` and the fetch of step 3, the `sync` of step 7), so a move
 * that waits on a slow remote is not broken as stale at 60 seconds while
 * it is alive (ruling B). Under the lock the model is read again; a
 * `.board` that is a host-model board by then is `unchanged` (or
 * `resumed`, see "Resuming"). First, leftovers
 * (`findMigratingWorktrees(hostRoot)`; a temporary named by this
 * process's own pid counts as dead, ruling G): a dead-pid temporary
 * worktree with a rebase or a cherry-pick stopped in it (a move that
 * stopped on a conflict in step 3, or on a conflict of the replay below)
 * is never removed: `BoardError(3, 'sync-in-progress')` whose message
 * names its path and the human steps (resolve, `git add`, then
 * `git rebase --continue` for a stopped rebase or `git cherry-pick
 * --continue` for a stopped cherry-pick, in that worktree, then
 * `agentboard init --into-host` again; the text of the matching
 * `--continue` command and `agentboard init --into-host` appear), with
 * nothing changed: the old `.board` untouched, the worktree, its
 * rebase or cherry-pick state, `MIGRATING_REF` and `MIGRATING_FETCH_REF`
 * as they were. Otherwise `removeDeadMigratingWorktrees(hostRoot)`
 * removes the temporaries that hold nothing (the message names what was
 * removed), and a dead-pid temporary worktree without rebase or
 * cherry-pick state whose HEAD differs from `MIGRATING_REF` (or whose ref
 * is gone: a rebase finished in it, by the move before it was killed or
 * by a human's `git rebase --continue` or `git cherry-pick --continue`,
 * or a compare-and-swap lost in step 4) is adopted (ruling A) when it
 * belongs to the board at `dir`: every temporary worktree records the
 * identity of the standalone repository it was made from (the git
 * directory identity of step 1, as `boardGitDir` computes it, written to
 * the file `agentboard-source` in the temporary's own git directory,
 * `git rev-parse --absolute-git-dir` in it, right after `worktree add`),
 * and one whose record is missing or names another repository (`.board`
 * was replaced by another standalone board since that move) is never
 * adopted (round 4 ruling 3): without rebase or cherry-pick state it is
 * removed like a dead leftover and the message names it, saying it was
 * left by a move of another board; with such state it is the
 * `sync-in-progress` refusal above, whose message says the same. The
 * adoption, with `<old>` the value `MIGRATING_REF` holds (the source tip
 * the worktree integrated, kept until step 6): step 2 runs as in a first
 * run (the re-run's freshly fetched source tip lands in
 * `MIGRATING_FETCH_REF`, and `MIGRATING_REF` is left alone), the
 * `worktree add` of step 3 is skipped, and in the adopted worktree,
 * before the rebases of step 3, exactly the source commits that reached
 * the standalone board or its remote since the worktree integrated
 * `<old>` are replayed onto it (round 3 ruling 1; round 4 rulings 1 and
 * 2): nothing at all when `refs/agentboard/migrating-fetch` equals
 * `<old>` or is an ancestor of HEAD (no `cherry-pick` and no `rebase`
 * runs); otherwise `cherry-pick <base>..refs/agentboard/migrating-fetch`
 * in the worktree (`cherry-pick` takes no `--no-verify`; the runner's
 * `core.hooksPath` keeps the host's hooks out of it, as for every command
 * of the move; HEAD stays
 * the branch the commits land on, so git's `--abort` returns to the
 * HEAD the human resolved) with `<base>` `<old>` when `<old>` is an
 * ancestor of the fresh tip (the normal case: clones of one board share
 * history, so the merge base of HEAD and the fresh tip predates the
 * commits the human resolved and would replay them), else the merge base
 * of HEAD and the fresh tip when there is one, else every commit of the
 * fresh tip in order; a commit whose patch HEAD already holds (one the
 * human finished by hand after a conflict) is skipped (`cherry-pick
 * --skip` when git stops on it being empty, or left out beforehand),
 * never kept as an empty commit and never a refusal. Only after the
 * replay succeeded, or when none was needed, `update-ref
 * refs/agentboard/migrating <value of refs/agentboard/migrating-fetch>`
 * records that the worktree integrated the fresh tip; a run that fetches
 * and then stops (a kill, a lost lock, a conflict of the replay) leaves
 * `MIGRATING_REF` at `<old>`, so the next run replays from it and no
 * event synced to the old remote meanwhile is skipped. The replay never
 * applies a commit the worktree already integrated (the human's
 * resolution stays the ancestor of the result, and a commit the human
 * resolved appears once in the history). A cherry-pick that stops on a
 * conflict is left in place for a human and is `BoardError(3,
 * 'sync-conflict')` whose message names every unmerged path, the
 * worktree's path and the human steps: resolve the paths, `git add` them
 * and `git cherry-pick --continue` in that worktree (or `git cherry-pick
 * --abort`, which returns the worktree to the HEAD the human resolved;
 * the texts `git cherry-pick --continue` and `agentboard init
 * --into-host` appear, `git rebase --continue` does not), the old
 * `.board` untouched, `refs/agentboard/board` unchanged, the worktree,
 * `MIGRATING_REF` (still `<old>`) and `MIGRATING_FETCH_REF` kept; a
 * re-run while it is stopped is the `sync-in-progress` refusal above; a
 * re-run after `git cherry-pick --abort` adopts the worktree again (its
 * HEAD descends from the resolution, which is never discarded) and
 * replays again, conflicting again until the human finishes it; a re-run
 * after `git cherry-pick --continue` adopts it and completes the move
 * with every event (the already applied commits skipped). A cherry-pick
 * that fails for another reason is `BoardError(3, 'sync-failed')` with
 * git's first error line, the adopted worktree kept.
 * Then the rebases of step 3 onto the current local and remote board refs
 * run as in a first run (no-ops for what is already integrated), then
 * steps 4 to 7; `action` is `moved`. Nothing a human resolved in a
 * temporary worktree is ever discarded by a re-run. The host `.gitignore`
 * entry (`ignoreBoardInHost(hostRoot)` when the parent of `dir` is the top
 * level of a working tree, as `initBoard`) is written only after the
 * compare-and-swap of step 4 succeeded (ruling D), so a refusal of steps
 * 2 to 4 leaves the host's working tree as it was. Each git command line
 * below is given as the move runs it, after the runner's `-c` prefix, so
 * a shim on the PATH can match it:
 *
 * 2. `fetch --no-tags --no-write-fetch-head <dir>
 *    +<source tip>:refs/agentboard/migrating-fetch` run in `hostRoot`
 *    (`<dir>` the standalone repository as a local path, `<source tip>`
 *    the ref of step 5; without `FETCH_HEAD`, so the host's own is left
 *    alone), so `MIGRATING_FETCH_REF` holds the source tip in the host's
 *    object store (round 4 ruling 1: a fetch never writes
 *    `refs/agentboard/migrating`). No other command of the move has the
 *    text `:refs/agentboard/migrating` in its arguments.
 * 3. For a fresh temporary worktree, `update-ref refs/agentboard/migrating
 *    <value of refs/agentboard/migrating-fetch>` (what the worktree is
 *    about to integrate), then `worktree add --detach
 *    <migratingWorktreePath(hostRoot)> refs/agentboard/migrating` in
 *    `hostRoot` (the parent directories created first), then the
 *    `agentboard-source` record of the standalone repository's identity
 *    written into the worktree's git directory (see "leftovers" above).
 *    When that `worktree add` (or the `update-ref` before it) fails
 *    because `refs/agentboard/migrating-fetch` or
 *    `refs/agentboard/migrating` no longer exists (this move's init lock
 *    went stale while it stalled, another `init --into-host` or `init`
 *    took it and finished, deleting the refs and moving the board), it is
 *    `BoardError(3, 'sync-failed')` (round 3 ruling 5), never a raw git
 *    failure: the message says this move lost its init lock to another
 *    init that finished meanwhile (the word `lock` appears) and names
 *    `agentboard init --into-host` to run again (which reports the board
 *    the other init made); nothing of this run remains (no temporary
 *    directory, no worktree registered, no `MIGRATING_REF` or
 *    `MIGRATING_FETCH_REF` of its own) and `.board`, whatever the other
 *    init made it, is untouched. Any other failure of `worktree add` is
 *    the same refusal with git's first error line, and leaves the same
 *    nothing behind (round 4 ruling 5): a registration git wrote before
 *    failing (`git worktree list` naming the path) is removed
 *    (`worktree remove --force` or `worktree prune` after the directory
 *    is gone), the directory is deleted, the two refs are deleted when no
 *    other temporary remains, the `migrating` directory goes when this
 *    run created it, and `.board` is untouched, so the re-run adds a
 *    fresh worktree at the same path. Then, in that worktree, with `<old>` the value of
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
 *    rebase that fails for another reason (an untracked file in the
 *    temporary worktree that the commits would overwrite) is
 *    `BoardError(3, 'sync-failed')` with git's first error line, the
 *    temporary worktree and `MIGRATING_REF` removed (it holds nothing a
 *    human did), the old `.board` untouched. A fetch of the remote's ref
 *    that fails after the `ls-remote` listed it is `BoardError(3,
 *    'sync-failed')` naming `refs/agentboard/board` and the remote with
 *    git's first error line, the temporary removed the same way.
 * 4. `update-ref refs/agentboard/board <HEAD of the worktree> <old>` in
 *    `hostRoot` (the compare-and-swap against `<old>`, the value read in
 *    step 3 before any rebase; the empty old value creates the ref); a
 *    failure (something moved the ref in between, for example a hand
 *    fetch into it) is `BoardError(3, 'sync-failed')` naming the ref and
 *    `agentboard init --into-host`; the old `.board` is untouched, the
 *    host `.gitignore` unwritten, and the temporary worktree and
 *    `MIGRATING_REF` stay, so the re-run adopts it and integrates the
 *    ref's new value (it may hold a human's resolution). Then the host
 *    `.gitignore` entry. `MIGRATING_REF` is not deleted here (round 3
 *    ruling 2): it stays, holding the source tip the temporary was made
 *    from, until the worktree is in place in step 6, so a kill anywhere
 *    between the swap and that point leaves a re-run that adopts the
 *    temporary with the base of its replay (see "leftovers" above: with
 *    the tip unchanged nothing is replayed, and the merge base or
 *    `--root` are never needed).
 * 5. `carryOverEventFiles(<dir>/events, <temporary worktree>/events)`
 *    (ruling A): every event file of the old `.board` that the new
 *    worktree lacks (one written by a writer or a standalone `sync` after
 *    step 1, or after the temporary was made) is copied in, hash-verified,
 *    and committed by the `sync` of step 7, so no event present in
 *    `.board/events` at any point of the move is left behind; when any
 *    file is `mismatched` (its content does not hash to its name, or the
 *    worktree's copy differs), `BoardError(5, 'integrity')` naming every
 *    such file, the old `.board` untouched and still standalone, the
 *    temporary worktree and `MIGRATING_REF` left as they are for the
 *    re-run (which adopts or removes it by the leftover rules), and
 *    `refs/agentboard/board` at the value step 4 gave it (a correct board
 *    history).
 * 6. Immediately before the rename, `.board` is checked to be still the
 *    standalone repository of step 1 (`git rev-parse --absolute-git-dir`
 *    in it resolves, as a realpath with the directory's device and inode,
 *    to the git directory step 1 saw; the HEAD commit step 1 saw is still
 *    an ancestor of, or equal to, its HEAD, round 3 ruling 6, so a
 *    repository rebuilt at the same path with another history is refused
 *    even on a file system that reuses inode numbers, while a standalone
 *    `sync` that committed meanwhile, whose HEAD descends from it, is not
 *    a replacement and its event files are carried over below; and no
 *    worktree of the host is registered at `dir`); otherwise
 *    `BoardError(3, 'sync-failed')` saying `.board` changed meanwhile and
 *    to run `agentboard init --into-host` again, with nothing renamed and
 *    the temporary left for the re-run (ruling B). Then the old `.board`
 *    is renamed to `<git common dir>/agentboard/<standaloneKeptName(now)>`
 *    (same file system, one rename; a numeric suffix keeps two moves kept
 *    in one second apart), then `worktree move <temporary worktree>
 *    <dir>`, then `worktree lock --reason "agentboard board" <dir>`, then
 *    sparse checkout disabled as `addBoardWorktree` does, then
 *    `update-ref -d refs/agentboard/migrating` and then `update-ref -d
 *    refs/agentboard/migrating-fetch`, in that order (the temporary is in
 *    place and nothing can adopt it any more; a kill after either leaves
 *    a host-model board to resume, see "Resuming"). Then
 *    `carryOverEventFiles(<kept>/events, <dir>/events)` once more, for an
 *    event file that landed in the old `.board` between step 5 and the
 *    rename (the rename window): copied, hash-verified, committed by step
 *    7; a `mismatched` file there is `BoardError(5, 'integrity')` naming
 *    it and the kept repository, with the move done (the re-run resumes
 *    and repeats this carry-over). The old repository is never deleted
 *    and never modified (its cache file goes with it). The directory
 *    `<git common dir>/agentboard/migrating` stays (empty) until the end
 *    of step 7: it is the marker of a move whose `sync` has not completed.
 * 7. `syncBoard` on the board at `dir` (`openBoard`, closed afterwards),
 *    which commits the carried-over files, publishes
 *    `refs/agentboard/board` on the host's remote and catches the cache
 *    up; then the `migrating` marker directory is removed. When that
 *    `sync` throws a `BoardError` (`sync-failed` for an unreachable remote
 *    or a refused push, `sync-conflict`, `ambiguous-remote`), the move
 *    stays done (`.board` is the locked host-model worktree, the old
 *    repository is kept, `refs/agentboard/board` equals HEAD or lags it as
 *    `syncHostBoard` describes, the marker directory stays) and a
 *    `MoveSyncFailure` propagates (ruling C): the sync's exit code and
 *    reason, a message whose lines are the move's lines (`dir`, the kept
 *    repository's path, the old remote's URL, `agentboard init
 *    --into-host` for the other clones, the step 3 warning when there is
 *    one) followed by the sync's message, and `keptAt` and `oldRemoteUrl`
 *    as the result would carry them; so `init` exits with the failure's
 *    code and reason, prints the kept path and the old remote, and the
 *    `--json` error document carries `keptAt` and `oldRemoteUrl`. The next
 *    `agentboard init --into-host` is `resumed` (it runs the `sync`
 *    again), and `agentboard sync` publishes the board too.
 *
 * Resuming (design.md decision 9, ruling E): under the lock, when `dir`
 * is missing and `adoptMigratingWorktree(hostRoot, dir)` moves a
 * temporary worktree into place, or when `dir` is a host-model board and
 * the `migrating` marker directory exists, empty, beside a kept
 * repository (a move killed between the `worktree move` and the end of
 * step 7, or whose `sync` failed), the lock is restored when it is
 * missing, `MIGRATING_REF` and `MIGRATING_FETCH_REF` are deleted when
 * they still exist (a kill before the deletions of step 6), the
 * carry-over from the newest kept repository runs as in step 6, step 7
 * runs, and the action is `resumed`, `keptAt` the newest `standalone-*`
 * directory under `<git common dir>/agentboard/` (the greatest name, so
 * with several kept repositories, from several moves or a rollback, the
 * most recent one is used and the others are left alone; null when
 * there is none), `oldRemoteUrl` read from it. When `dir` is
 * missing and nothing can be adopted, `BoardError(2, 'board-not-found')`.
 * The adoption of a temporary worktree whose rebase finished while
 * `.board` is still standalone is described under "leftovers" above.
 *
 * On a host-model board with the `migrating` directory present (round 3
 * ruling 4; `hostBoardUnderLock`), the dead temporaries are cleaned
 * first, exactly as plain `init` cleans them (`cleanDeadMigratingWorktrees`:
 * every dead-pid or own-pid temporary without rebase or cherry-pick
 * state, whatever its HEAD, removed and named in the message; a stopped
 * rebase or cherry-pick or a live pid left alone), and only then does the
 * marker rule apply: the directory now empty beside a kept repository is
 * a move to resume (`resumed`, the carry-over and the `sync`, both
 * idempotent when nothing is pending, the marker removed afterwards);
 * empty without a kept repository it is removed in the same run and the
 * board is `unchanged` (round 4 ruling 4: plain `init` run afterwards
 * finds no directory and reports no pending move); still holding a
 * temporary (a stopped rebase, a live move) the board is `unchanged` and
 * the directory stays.
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
 * changes (no second kept repository, no ref or worktree added, no push),
 * except that dead-pid temporary worktrees without rebase state under
 * `<git common dir>/agentboard/migrating/` are removed, as plain `init`
 * removes them on a host-model board (ruling E; `initBoard`), after which
 * the marker rule above decides between `resumed` and `unchanged`.
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
      const remote = lenientHostRemote(hostRoot, env);
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
    // A healthy board is reported without the lock, unless the marker
    // directory of a move says there is something to resume or to clean.
    if (!existsSync(migratingDir(hostRoot, { env }))) {
      return unchangedBoard(dir, info, env, []);
    }
    const remote = lenientHostRemote(hostRoot, env);
    return withInitLock(hostRoot, () => hostBoardUnderLock(dir, hostRoot, remote, env), { env });
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
  /**
   * The identity of the standalone repository's git directory, re-checked
   * before the rename together with the HEAD commit step 1 saw (round 3
   * ruling 6: still an ancestor of, or equal to, the HEAD found then).
   */
  readonly gitDir: string | null;
  /** The HEAD commit of the standalone repository at step 1, still an ancestor of its HEAD at the rename. */
  readonly head: string;
}

/**
 * The identity of the git directory of the repository `git` runs in: its
 * realpath with the device and inode of that directory (a repository
 * replaced by another at the same path has the same realpath and a
 * different inode), or null when it is not a repository.
 */
function boardGitDir(git: GitRunner): string | null {
  const out = git.attempt('rev-parse', '--absolute-git-dir');
  if (isGitFailure(out)) {
    return null;
  }
  try {
    const path = realpathSync(out.trim());
    const stats = statSync(path);
    return `${path}:${String(stats.dev)}:${String(stats.ino)}`;
  } catch {
    return null;
  }
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

  const gitDir = boardGitDir(git);
  const head = git.run('rev-parse', 'HEAD').trim();
  const choice = boardRemote(info, { env });
  if (choice.ambiguous) {
    throw ambiguousRemoteError(choice, 'init');
  }
  const remote = choice.chosen;
  if (remote === null) {
    return { sourceTip: `refs/heads/${branch.trim()}`, oldRemoteUrl: null, gitDir, head };
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
  return { sourceTip: tracking, oldRemoteUrl: isGitFailure(url) ? null : url.trim(), gitDir, head };
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
 * The host repository's remote for a resumed move: null when the choice is
 * ambiguous (the `sync` of step 7 then refuses as `ambiguous-remote`, the
 * move done), so a resumption never refuses before it has tried.
 */
function lenientHostRemote(hostRoot: string, env: Env): ChosenRemote | null {
  const branch = gitRunner(hostRoot, { env }).attempt('symbolic-ref', '--quiet', '--short', 'HEAD');
  const choice = chooseRemote(hostRoot, isGitFailure(branch) ? null : branch.trim(), { env });
  return choice.ambiguous ? null : choice.chosen;
}

/** True for a temporary worktree a re-run may touch: its pid is dead, or it is this process's own (one move at a time under the lock). */
function dead(worktree: MigratingWorktree): boolean {
  return !worktree.alive || worktree.pid === process.pid;
}

/**
 * A host-model board found under the init lock with the `migrating`
 * marker directory present: the dead temporaries are removed first, as
 * plain `init` removes them (round 3 ruling 4), then a move whose `sync`
 * has not completed (the directory empty, and a kept repository to carry
 * over from) is resumed; otherwise the board is reported unchanged, with
 * the empty directory removed when no kept repository exists.
 */
function hostBoardUnderLock(
  dir: string,
  hostRoot: string,
  remote: ChosenRemote | null,
  env: Env,
): IntoHostResult {
  const info = detectBoardModel(dir, { env });
  const removed = cleanDeadMigratingWorktrees(hostRoot, { env });
  if (pendingMove(hostRoot, { env })) {
    if (!boardWorktreeLocked(hostRoot, dir, { env })) {
      addBoardWorktree(hostRoot, dir, { env });
    }
    return resumedMove(dir, hostRoot, remote, env, removed);
  }
  return unchangedBoard(dir, info, env, removed);
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
    return hostBoardUnderLock(dir, hostRoot, remote, env);
  }
  if (info.model !== 'standalone') {
    return 'repair';
  }
  const host = hostGit(hostRoot, { env });
  const scratch = join(commonDir(host, hostRoot), AGENTBOARD_GIT_SUBDIR);
  const lock = join(scratch, INIT_LOCK_FILE);

  // Leftovers of earlier moves: a stopped rebase or cherry-pick waits for
  // a human, what holds nothing is removed, one left by a move of another
  // board is removed, and a finished rebase of this board is adopted.
  const stopped = findMigratingWorktrees(hostRoot, { env }).find((w) => dead(w) && w.rebasing);
  if (stopped !== undefined) {
    throw stoppedInTemporary(host, stopped.path, dir, plan.gitDir);
  }
  const removed = removeDeadMigratingWorktrees(hostRoot, { env });
  // The source tip the adopted temporary worktree integrated (what the
  // ref records; the fetch of step 2 never moves it): the base of the
  // replay of what reached the standalone board since.
  const oldSource = refValue(host, MIGRATING_REF);
  // A temporary named by this process's own pid was left by an earlier
  // call in this process; the helper leaves it alone, the move treats it
  // as dead: removed when nothing was integrated in it, adopted otherwise.
  for (const own of findMigratingWorktrees(hostRoot, { env }).filter(
    (w) => w.pid === process.pid && !w.rebasing && (w.head === null || w.head === oldSource),
  )) {
    removeLeftoverWorktree(host, own.path);
    removed.push(own.path);
  }
  removed.sort();
  // A temporary that integrated something is adopted only when it was
  // made from the repository at `dir` now (round 4 ruling 3): one made
  // from a board replaced since is removed and named.
  const foreign: string[] = [];
  let adoptable: MigratingWorktree | undefined;
  for (const candidate of findMigratingWorktrees(hostRoot, { env }).filter(
    (w) => dead(w) && !w.rebasing && w.registered && w.head !== null && w.head !== oldSource,
  )) {
    if (adoptable === undefined && sourceRecord(host, candidate.path) === (plan.gitDir ?? '')) {
      adoptable = candidate;
    } else {
      removeLeftoverWorktree(host, candidate.path);
      foreign.push(candidate.path);
    }
  }
  if (foreign.length > 0 && findMigratingWorktrees(hostRoot, { env }).length === 0) {
    deleteTemporaryRefs(host);
  }

  // 2. The source tip into the scratch ref; 3. the temporary worktree.
  host.run(
    'fetch',
    '--no-tags',
    '--no-write-fetch-head',
    dir,
    `+${plan.sourceTip}:${MIGRATING_FETCH_REF}`,
  );
  const adopted = adoptable !== undefined;
  let temp: string;
  if (adoptable === undefined) {
    temp = migratingWorktreePath(hostRoot, process.pid, { env });
    const marker = dirname(temp);
    const hadMarker = existsSync(marker);
    mkdirSync(marker, { recursive: true });
    const added = addTemporaryWorktree(host, temp);
    if (isGitFailure(added)) {
      // The scratch ref is gone when another init took this move's stale
      // lock and finished; whatever git wrote before failing (a
      // registration, a checkout) goes with the directory, so nothing of
      // this run stays behind (round 4 ruling 5).
      removeLeftoverWorktree(host, temp);
      if (registeredAt(host, temp) !== null) {
        host.attempt('worktree', 'prune');
      }
      if (findMigratingWorktrees(hostRoot, { env }).length === 0) {
        deleteTemporaryRefs(host);
      }
      if (!hadMarker && existsSync(marker) && readdirSync(marker).length === 0) {
        rmdirSync(marker);
      }
      throw new BoardError(
        3,
        'sync-failed',
        `adding the temporary worktree at ${asciiText(temp)} failed (${firstErrorLine(added)}): ` +
          'this move lost its init lock to another init that finished meanwhile, or git ' +
          `refused the worktree; nothing of this run remains; run ${AGAIN} again`,
      );
    }
    writeRecord(host, temp, SOURCE_RECORD, plan.gitDir ?? '');
  } else {
    temp = adoptable.path;
  }
  const worktree = gitRunner(temp, { env, disableHooks: true });
  if (adopted) {
    // Source commits the adopted worktree lacks (synced to the old remote
    // since it integrated `integrated`) are replayed onto it; a replay a
    // human finished by hand counts as integrated up to its tip.
    const fresh = refValue(host, MIGRATING_FETCH_REF);
    const integrated = finishedReplay(host, worktree, temp, oldSource) ?? oldSource;
    if (fresh !== integrated && !isAncestor(worktree, MIGRATING_FETCH_REF, 'HEAD')) {
      replayFreshCommits(host, worktree, dir, temp, integrated, fresh);
    }
    host.run('update-ref', MIGRATING_REF, fresh);
    removeRecord(host, temp, REPLAY_RECORD);
  }
  const old = refValue(host, BOARD_REF);
  if (old !== '' && !isAncestor(worktree, BOARD_REF, 'HEAD')) {
    rebaseOnto(host, worktree, dir, temp, adopted, [BOARD_REF], `the local ${BOARD_REF}`);
  }
  const warnings: string[] = [];
  let joined = false;
  if (remote !== null) {
    const target = resolveRemoteTarget(remote.name, remote.url, hostRoot);
    refreshLock(lock);
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
        if (!adopted) {
          discardTemporary(host, temp);
        }
        throw syncFailed(`fetching ${BOARD_REF} from ${asciiText(remote.name)}`, fetched);
      }
      if (!isAncestor(worktree, 'FETCH_HEAD', 'HEAD')) {
        rebaseOnto(
          host,
          worktree,
          dir,
          temp,
          adopted,
          ['FETCH_HEAD'],
          `what ${asciiText(remote.name)} holds`,
        );
      }
      joined = true;
    }
  }

  // 4. The compare-and-swap, then the temporary ref goes, then the host
  // .gitignore entry.
  const head = worktree.run('rev-parse', 'HEAD').trim();
  if (isGitFailure(host.attempt('update-ref', BOARD_REF, head, old))) {
    throw new BoardError(
      3,
      'sync-failed',
      `updating ${BOARD_REF} in the host repository failed because something else moved it ` +
        `meanwhile; nothing was moved, the board at ${asciiText(dir)} is untouched and the ` +
        `temporary worktree at ${asciiText(temp)} is kept; run ${AGAIN} again, which integrates ` +
        "the ref's new value",
    );
  }
  const hostGitignore = ignoreBoardInHost(hostRoot);

  // 5. Every old event file, carried over hash-verified.
  const carried = carryOverEventFiles(join(dir, 'events'), join(temp, 'events'));
  if (carried.mismatched.length > 0) {
    throw mismatchedEvents(carried.mismatched, join(dir, 'events'), temp, false);
  }

  // 6. Keep the old repository, move the worktree into place, lock it,
  // carry over what landed in the rename window.
  const board = gitRunner(dir, { env });
  if (
    boardGitDir(board) !== plan.gitDir ||
    !isAncestor(board, plan.head, 'HEAD') ||
    registeredAt(host, dir) !== null
  ) {
    throw new BoardError(
      3,
      'sync-failed',
      `the board at ${asciiText(dir)} is not the repository the move checked (it was replaced ` +
        `meanwhile); nothing was renamed, and the temporary worktree at ${asciiText(temp)} is ` +
        `kept; run ${AGAIN} again`,
    );
  }
  const keptAt = freshKeptName(scratch, new Date());
  renameSync(dir, keptAt);
  host.run('worktree', 'move', temp, dir);
  addBoardWorktree(hostRoot, dir, { env });
  host.run('update-ref', '-d', MIGRATING_REF);
  host.run('update-ref', '-d', MIGRATING_FETCH_REF);
  const late = carryOverEventFiles(join(keptAt, 'events'), join(dir, 'events'));
  if (late.mismatched.length > 0) {
    throw mismatchedEvents(late.mismatched, join(keptAt, 'events'), dir, true);
  }

  // 7. Publish and catch up.
  const lines = [
    `moved the board at ${asciiText(dir)} into the host repository (host model: a worktree of ` +
      `the host repository at ${BOARD_REF})`,
    ...keptLines(keptAt, plan.oldRemoteUrl),
  ];
  if (removed.length > 0) {
    lines.push(`removed ${removed.map((p) => asciiText(p)).join(', ')}, left by an interrupted move`);
  }
  if (foreign.length > 0) {
    lines.push(
      `removed ${foreign.map((p) => asciiText(p)).join(', ')}, left by a move of another board ` +
        `(not the one at ${asciiText(dir)}), so nothing of it was adopted`,
    );
  }
  const sync = syncOrFail(dir, hostRoot, [...lines, ...warnings], keptAt, plan.oldRemoteUrl, env);
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

/**
 * The base of the replay of fresh source commits onto an adopted
 * worktree (round 3 ruling 1; round 4 rulings 1 and 2, see
 * `moveBoardIntoHost`, "leftovers"): the source tip the worktree
 * integrated (`oldSource`, the value of `MIGRATING_REF`) when it is an
 * ancestor of the fresh one in `MIGRATING_FETCH_REF`, so only the commits
 * that reached the board since are replayed; else the merge base of HEAD
 * and the fresh tip when the histories share a commit; else `--root`
 * (every commit of the fresh tip). Not called when the fresh tip equals
 * `oldSource` (nothing to replay). The replay itself is a `cherry-pick`
 * of `<base>..MIGRATING_FETCH_REF`, never a `rebase --onto`.
 */
function replayBase(worktree: GitRunner, oldSource: string): string | null {
  if (oldSource !== '' && isAncestor(worktree, oldSource, MIGRATING_FETCH_REF)) {
    return oldSource;
  }
  const base = worktree.attempt('merge-base', 'HEAD', MIGRATING_FETCH_REF);
  if (!isGitFailure(base) && base.trim() !== '') {
    return base.trim();
  }
  // The `--root` case of the design: no shared commit, every commit of
  // the fresh tip is replayed (`cherry-pick` has no `--root`, so the
  // commits are listed).
  return null;
}

/**
 * The replay of an adopted temporary worktree (round 4 rulings 1 and 2):
 * `cherry-pick <base>..refs/agentboard/migrating-fetch` in the worktree
 * (every commit of the fresh tip, oldest first, when `replayBase` finds
 * no base), with `REPLAY_RECORD` written first (the HEAD it starts from
 * and `fresh`, the tip it replays up to). A commit whose patch HEAD
 * already holds makes git stop with an empty result and no unmerged path:
 * it is skipped (`cherry-pick --skip`) and the sequence goes on. A
 * conflict is left in place for a human: `BoardError(3,
 * 'sync-conflict')` naming the unmerged paths, the worktree and the human
 * steps with `git cherry-pick --continue` (or `--abort`, which returns
 * the worktree to the HEAD it started from); the worktree, the record,
 * `MIGRATING_REF` (still the integrated tip) and `MIGRATING_FETCH_REF`
 * stay. Any other failure is `BoardError(3, 'sync-failed')` with git's
 * first error line, the adopted worktree kept (it may hold a human's
 * work). The caller advances `MIGRATING_REF` and removes the record once
 * the replay succeeded.
 */
function replayFreshCommits(
  host: GitRunner,
  worktree: GitRunner,
  dir: string,
  temp: string,
  integrated: string,
  fresh: string,
): void {
  const base = replayBase(worktree, integrated);
  const picks =
    base === null
      ? worktree
          .run('rev-list', '--reverse', '--topo-order', MIGRATING_FETCH_REF)
          .split('\n')
          .filter((id) => id !== '')
      : [`${base}..${MIGRATING_FETCH_REF}`];
  writeRecord(host, temp, REPLAY_RECORD, `${worktree.run('rev-parse', 'HEAD').trim()}\n${fresh}\n`);
  let out = worktree.attempt('cherry-pick', ...picks);
  // Each `--skip` advances the sequence by one commit, so the loop is
  // bounded by the number of commits replayed.
  const limit = worktree.run('rev-list', '--count', ...picks).trim();
  for (let skipped = 0; isGitFailure(out); skipped += 1) {
    const conflicted = unmergedPaths(worktree);
    if (conflicted.length > 0) {
      throw new BoardError(
        3,
        'sync-conflict',
        'replaying the events synced to the old remote since the earlier move stopped on a ' +
          `conflict in the temporary worktree at ${asciiText(temp)}: ` +
          `${conflicted.map((p) => asciiText(p)).join(', ')}; resolve them, git add them and ` +
          `git cherry-pick --continue in ${asciiText(temp)} (or git cherry-pick --abort, which ` +
          `returns that worktree to where the replay started), then run ${AGAIN} again; the ` +
          `board at ${asciiText(dir)} is untouched`,
      );
    }
    if (stoppedOperation(worktree, temp) !== 'cherry-pick' || skipped >= Number(limit)) {
      throw syncFailed('replaying the events synced to the old remote since the earlier move', out);
    }
    // The commit's patch is already in HEAD (one the human finished by
    // hand): never kept as an empty commit.
    out = worktree.attempt('cherry-pick', '--skip');
  }
}

/**
 * The tip a replay recorded in `REPLAY_RECORD` of the adopted worktree at
 * `temp` reached, when that replay finished without the move advancing
 * `MIGRATING_REF` (the human's `git cherry-pick --continue`, or a kill
 * after the `cherry-pick` completed): HEAD left the recorded start and
 * every event file the range `<oldSource>..<tip>` adds is in HEAD's tree.
 * Null, and the record removed, when there is no record, when HEAD is
 * still the recorded start (`git cherry-pick --abort`, or every commit
 * skipped), or when an event file of the range is missing from HEAD (the
 * sequence was quit half way): the replay then runs again from
 * `oldSource`, the commits already applied becoming empty and skipped.
 */
function finishedReplay(
  host: GitRunner,
  worktree: GitRunner,
  temp: string,
  oldSource: string,
): string | null {
  const record = readRecord(host, temp, REPLAY_RECORD);
  if (record === null) {
    return null;
  }
  removeRecord(host, temp, REPLAY_RECORD);
  const [start, tip] = record.split('\n');
  if (start === undefined || tip === undefined || tip === '' || refValue(worktree, tip) === '') {
    return null;
  }
  if (worktree.run('rev-parse', 'HEAD').trim() === start) {
    return null;
  }
  const inHead = new Set(zList(worktree.run('ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', 'events')));
  const added = zList(
    oldSource === '' || !isAncestor(worktree, oldSource, tip)
      ? worktree.run('ls-tree', '-r', '--name-only', '-z', tip, '--', 'events')
      : worktree.run('diff', '--name-only', '--diff-filter=A', '-z', oldSource, tip, '--', 'events'),
  ).filter((path) => EVENT_PATH.test(path));
  return added.every((path) => inHead.has(path)) ? tip : null;
}

/**
 * Step 3 for a fresh temporary worktree: `update-ref refs/agentboard/migrating
 * <value of refs/agentboard/migrating-fetch>` (what the worktree is about
 * to integrate), then `worktree add --detach <temp> refs/agentboard/migrating`.
 * A missing scratch ref (another init finished meanwhile) is reported as
 * a failure like git's own.
 */
function addTemporaryWorktree(host: GitRunner, temp: string): string | GitFailure {
  const fetched = refValue(host, MIGRATING_FETCH_REF);
  if (fetched === '') {
    return { status: 128, stdout: '', stderr: `fatal: ${MIGRATING_FETCH_REF} does not exist\n` };
  }
  const set = host.attempt('update-ref', MIGRATING_REF, fetched);
  if (isGitFailure(set)) {
    return set;
  }
  return host.attempt('worktree', 'add', '--detach', temp, MIGRATING_REF);
}

/**
 * The `sync-in-progress` refusal for a temporary worktree at `path` with a
 * rebase or cherry-pick stopped in it: names the path and the human steps
 * of the matching operation; says when the worktree was left by a move of
 * another board (its `SOURCE_RECORD` missing or not `gitDir`), which the
 * re-run will not adopt either way.
 */
function stoppedInTemporary(
  host: GitRunner,
  path: string,
  dir: string,
  gitDir: string | null,
): BoardError {
  const operation = stoppedOperation(host, path) ?? 'rebase';
  const origin =
    sourceRecord(host, path) === (gitDir ?? '')
      ? ''
      : ` (that worktree was left by a move of another board, not the one at ${asciiText(dir)} now, so finishing it moves nothing of this board)`;
  return new BoardError(
    3,
    'sync-in-progress',
    `an earlier ${AGAIN} stopped on a conflict, and its ${operation} is still in progress in the ` +
      `temporary worktree at ${asciiText(path)}${origin}; resolve the conflict, git add the paths ` +
      `and git ${operation} --continue (or git ${operation} --abort) in ${asciiText(path)}, then ` +
      `run ${AGAIN} again; the board at ${asciiText(dir)} is untouched`,
  );
}

/** The content of `SOURCE_RECORD` of the temporary worktree at `path`, or null when it has none. */
function sourceRecord(host: GitRunner, path: string): string | null {
  return readRecord(host, path, SOURCE_RECORD);
}

/** The git directory of the worktree at `path` (`<common dir>/worktrees/<name>`), or null when it is not one. */
function worktreeGitDir(host: GitRunner, path: string): string | null {
  const out = host.attemptIn(path, 'rev-parse', '--absolute-git-dir');
  return isGitFailure(out) ? null : out.trim();
}

/** Writes `content` to the file `name` in the git directory of the worktree at `path`. */
function writeRecord(host: GitRunner, path: string, name: string, content: string): void {
  const gitDir = worktreeGitDir(host, path);
  if (gitDir !== null) {
    writeFileSync(join(gitDir, name), content);
  }
}

/** The content of the file `name` in the git directory of the worktree at `path`, trimmed of a trailing newline; null when missing. */
function readRecord(host: GitRunner, path: string, name: string): string | null {
  const gitDir = worktreeGitDir(host, path);
  if (gitDir === null || !existsSync(join(gitDir, name))) {
    return null;
  }
  return readFileSync(join(gitDir, name), 'utf8').replace(/\n$/, '');
}

/** Removes the file `name` from the git directory of the worktree at `path`, when present. */
function removeRecord(host: GitRunner, path: string, name: string): void {
  const gitDir = worktreeGitDir(host, path);
  if (gitDir !== null) {
    rmSync(join(gitDir, name), { force: true });
  }
}

/** The `integrity` refusal of a carry-over that found files it cannot copy (step 5, or the rename window with `done`). */
function mismatchedEvents(
  names: readonly string[],
  from: string,
  to: string,
  done: boolean,
): BoardError {
  const list = names.map((n) => asciiText(n)).join(', ');
  return new BoardError(
    5,
    'integrity',
    `${plural(names.length, 'event file')} in ${asciiText(from)} cannot be carried over to ` +
      `${asciiText(to)}: ${list} (the content does not match the name, or the copy there differs); ` +
      (done
        ? `the move is done and the old repository is kept; fix the files and run ${AGAIN} again, ` +
          'which carries them over'
        : `nothing was moved, the board is untouched and the temporary worktree at ${asciiText(to)} ` +
          `is kept; fix the files (agentboard rebuild --check names corrupt ones) and run ${AGAIN} again`),
  );
}

/**
 * The move finished after the old repository was kept aside (action
 * `resumed`): the carry-over from the newest kept repository, step 7 and
 * the report.
 */
function resumedMove(
  dir: string,
  hostRoot: string,
  remote: ChosenRemote | null,
  env: Env,
  removed: readonly string[] = [],
): IntoHostResult {
  const scratch = join(commonDir(gitRunner(hostRoot, { env }), hostRoot), AGENTBOARD_GIT_SUBDIR);
  const keptAt = newestKept(scratch);
  const oldRemoteUrl = keptAt === null ? null : keptRemoteUrl(keptAt, env);
  // A kill before the deletions of step 6 leaves the temporary refs behind.
  deleteTemporaryRefs(hostGit(hostRoot, { env }));
  if (keptAt !== null) {
    const late = carryOverEventFiles(join(keptAt, 'events'), join(dir, 'events'));
    if (late.mismatched.length > 0) {
      throw mismatchedEvents(late.mismatched, join(keptAt, 'events'), dir, true);
    }
  }
  const lines = [
    `finished moving the board at ${asciiText(dir)} into the host repository (host model: a ` +
      `worktree of the host repository at ${BOARD_REF}): an earlier move was interrupted before ` +
      'its sync completed',
    ...(keptAt === null
      ? ['no kept copy of the old board repository was found']
      : keptLines(keptAt, oldRemoteUrl)),
  ];
  if (removed.length > 0) {
    lines.push(`removed ${removed.map((p) => asciiText(p)).join(', ')}, left by an interrupted move`);
  }
  const sync = syncOrFail(dir, hostRoot, lines, keptAt, oldRemoteUrl, env);
  lines.push(...sync.message.split('\n'));
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

/** A board already in the host repository (action `unchanged`), the lock restored as `initBoard` does; `removed` names the dead temporaries cleaned. */
function unchangedBoard(
  dir: string,
  info: BoardModelInfo,
  env: Env,
  removed: readonly string[],
): IntoHostResult {
  const hostRoot = dirname(dir);
  const choice = boardRemote(info, { env });
  const remote = choice.chosen?.name ?? null;
  let changed = 'nothing changed';
  if (!boardWorktreeLocked(hostRoot, dir, { env })) {
    // Finishes an init interrupted after the worktree was added and
    // before its lock: locks it.
    addBoardWorktree(hostRoot, dir, { env });
    changed = 'restored the worktree lock that an interrupted init had not set';
  }
  const lines = [
    `the board at ${asciiText(dir)} is already in the host repository (host model: its ` +
      `history is ${BOARD_REF}; ${remote === null ? 'no remote configured' : `remote: ${asciiText(remote)}`}); ` +
      changed,
  ];
  if (removed.length > 0) {
    lines.push(`removed ${removed.map((p) => asciiText(p)).join(', ')}, left by an interrupted move`);
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
    message: lines.join('\n'),
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

/**
 * Step 7: the lock refreshed, `syncBoard` on the board at `dir` (closed
 * afterwards), then the `migrating` marker directory removed. A failure
 * of the sync is rethrown as a `MoveSyncFailure` carrying `moveLines`,
 * `keptAt` and `oldRemoteUrl`; the marker stays, so the next run resumes.
 */
function syncOrFail(
  dir: string,
  hostRoot: string,
  moveLines: readonly string[],
  keptAt: string | null,
  oldRemoteUrl: string | null,
  env: Env,
): SyncResult {
  const scratch = join(commonDir(gitRunner(hostRoot, { env }), hostRoot), AGENTBOARD_GIT_SUBDIR);
  refreshLock(join(scratch, INIT_LOCK_FILE));
  const board = openBoard(dir);
  let sync: SyncResult;
  try {
    sync = syncBoard(board, { env });
  } catch (error) {
    if (error instanceof BoardError) {
      throw new MoveSyncFailure(
        error,
        [...moveLines, ...error.message.split('\n')].join('\n'),
        keptAt,
        oldRemoteUrl,
      );
    }
    throw error;
  } finally {
    board.close();
  }
  removeEmptyMigratingDir(hostRoot, { env });
  return sync;
}

/** Sets the init lock's mtime to now, so a move waiting on a remote is not taken for stale; a missing lock is ignored. */
function refreshLock(lock: string): void {
  try {
    const now = new Date();
    utimesSync(lock, now, now);
  } catch {
    // The lock is this process's own; a vanished file changes nothing here.
  }
}

/**
 * Rebases the temporary worktree's HEAD onto the upstream in `args` (the
 * step 3 integration of the local and the remote board refs; the replay
 * of an adopted worktree is `replayFreshCommits`, a cherry-pick). A
 * conflict is left in place for a human (the worktree and `MIGRATING_REF`
 * stay); any other failure removes the worktree unless it was adopted (it
 * may hold a human's work).
 */
function rebaseOnto(
  host: GitRunner,
  worktree: GitRunner,
  dir: string,
  temp: string,
  adopted: boolean,
  args: readonly string[],
  what: string,
): void {
  const out = worktree.attempt('rebase', '--no-verify', ...args);
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
  if (!adopted) {
    discardTemporary(host, temp);
  }
  throw syncFailed(`integrating ${what}`, out);
}

/** Removes the temporary worktree at `temp`, the temporary refs and an empty `migrating` directory after a refusal in step 3. */
function discardTemporary(host: GitRunner, temp: string): void {
  removeLeftoverWorktree(host, temp);
  deleteTemporaryRefs(host);
  const base = dirname(temp);
  if (existsSync(base) && readdirSync(base).length === 0) {
    rmdirSync(base);
  }
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

/** Whether a rebase or a cherry-pick is stopped in the worktree at `cwd` (see `stoppedOperation`). */
function rebaseStopped(git: GitRunner, cwd: string): boolean {
  return stoppedOperation(git, cwd) !== null;
}

/**
 * The operation stopped in the worktree at `cwd`: `rebase` when
 * `rebase-merge` or `rebase-apply` exists in its git directory,
 * `cherry-pick` when `CHERRY_PICK_HEAD` does (the replay of an adopted
 * worktree, round 4 ruling 2), else null.
 */
function stoppedOperation(git: GitRunner, cwd: string): StoppedOperation | null {
  const gitDir = worktreeGitDir(git, cwd);
  if (gitDir === null) {
    return null;
  }
  if (['rebase-merge', 'rebase-apply'].some((name) => existsSync(join(gitDir, name)))) {
    return 'rebase';
  }
  return existsSync(join(gitDir, 'CHERRY_PICK_HEAD')) ? 'cherry-pick' : null;
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
