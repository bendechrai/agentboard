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
  rawErrorLine,
  withoutUserinfo,
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
  remoteErrorLine,
  remoteMessage,
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
 * (`boardGitDir` of step 1; round 4 ruling 3), written right after
 * `worktree add` and before `HEAD_RECORD`: a re-run adopts the worktree
 * only when the record names the repository at `.board` now and, with a
 * `HEAD_RECORD`, that repository's history still holds the HEAD the move
 * began from (see `belongsToBoard`). A worktree without the record (made
 * by older code; round 5 ruling 5) counts as this board's when the tip it
 * integrated, the value of `MIGRATING_REF`, is an ancestor of (or equal
 * to) the board's source tip, else it is removed and named as left by a
 * move of another board. Its content is the identity alone, with no
 * newline, as agentboard 0.2.0 wrote and compares it.
 */
const SOURCE_RECORD = 'agentboard-source';

/**
 * The file in a temporary worktree's git directory that records the HEAD
 * commit of the standalone repository at step 1 of the move that made the
 * worktree (`MovePlan.head`): the full object name and a newline, written
 * right after `SOURCE_RECORD` (a separate file, so 0.2.0 still reads its
 * own record unchanged). A re-run adopts a worktree carrying it only when
 * that commit is an ancestor of, or equal to, the HEAD of the repository
 * at `.board` now, the test step 6 applies before the rename, so a board
 * replaced at the same path whose git directory reuses the old one's
 * inode, or a board whose history was rewritten, never has its temporary
 * adopted, and only when the tip it integrated is in that repository's
 * source tip (`belongsToBoard`). A worktree with `SOURCE_RECORD` and no
 * `HEAD_RECORD` was made by 0.2.0 and is judged by the tip it integrated
 * instead; an adopted worktree gains the records it lacks. Both records
 * are written before anything is integrated, so a kill between or during
 * the writes leaves a worktree whose HEAD is still `MIGRATING_REF`,
 * removed as a plain leftover without its records being read; every
 * record write, there and on adoption, is atomic (`writeRecord`), so no
 * kill leaves an empty or partial record.
 */
const HEAD_RECORD = 'agentboard-source-head';

/**
 * The file in a temporary worktree's git directory that records the
 * source tip the worktree has integrated: the full object name and a
 * newline of the value `MIGRATING_REF` is set to for it. Written right
 * after `HEAD_RECORD` (the worktree is checked out at that value),
 * rewritten whenever the move advances `MIGRATING_REF` for this worktree
 * (after the replay of what reached the board since), and written on
 * adoption when the worktree lacks it, with the value it was judged by.
 * It exists because `MIGRATING_REF` is one ref for the whole host: a
 * worktree whose pid looks alive is skipped by a run, which makes its own
 * worktree and sets the ref, so once that pid is dead a later run would
 * judge the older worktree against the newer one's tip (review round 2).
 * Read by the rules of `HEAD_RECORD`; a worktree without it (made before
 * the record existed) is judged against `MIGRATING_REF` only when it is
 * the only entry under `migrating/` before the run removes any leftover,
 * else it is not adoptable (see `belongsToBoard`).
 */
const TIP_RECORD = 'agentboard-source-tip';

/**
 * The file in a temporary worktree's git directory that records the value
 * of `BOARD_REF` in the host immediately before the compare-and-swap of
 * step 4: the full object name the swap compares against and a newline,
 * or the zero object name of the board's hash algorithm (git's own
 * convention for "no ref") when the ref does not exist. Written with
 * `writeRecord` on every pass through step 4, for a fresh and for an
 * adopted temporary (an adopted one's record is rewritten with the value
 * the adopting run compares against), before the swap rather than after,
 * so a kill between a successful swap and the write never leaves the
 * update without its record; a kill between the write and the swap leaves
 * a record beside a ref that does not hold the temporary's HEAD, which
 * the leftover pass ignores. Read by the rules of `HEAD_RECORD`
 * (`nameRecord`). It exists because a move killed, or refused at step 6,
 * after step 4 leaves the temporary's HEAD in the local ref without
 * publishing it: a re-run with another board at `.board` sets the ref
 * back to this value (deleting it for the zero object name) with
 * `update-ref BOARD_REF <recorded> <HEAD>`, so nothing of that board
 * reaches the board now at `.board` or the host's remote (see
 * `undoForeignUpdates`).
 */
const BEFORE_RECORD = 'agentboard-board-before';

/**
 * The file in a temporary worktree's git directory that marks a temporary
 * of another board whose update of `BOARD_REF` the leftover pass is
 * setting back (ruling 7): written with `writeRecord` immediately before
 * the reset command and removed again when the reset loses its
 * compare-and-swap, so a kill between the reset and the removal of the
 * temporary leaves a dead temporary carrying the marker whose HEAD is no
 * longer in the ref, which the next run removes and names as left by a
 * move of another board, whatever its HEAD, printing no reset line (the
 * killed run made the reset). A marked temporary whose HEAD is still in
 * the ref (a kill between the marker and the reset command) is judged
 * again as any candidate. Its content is the HEAD the reset compared
 * against and a newline; only its presence is read.
 */
const UNDONE_RECORD = 'agentboard-board-undone';

/**
 * The file in a temporary worktree's git directory that records a replay
 * in progress (round 4 ruling 2): its two lines are the worktree's HEAD
 * when the `cherry-pick` started and the tip of `MIGRATING_FETCH_REF` it
 * replays up to. It is written before the `cherry-pick` and removed once
 * `MIGRATING_REF` has been advanced, so a run that stops in between (a
 * conflict left for a human, a kill) leaves the next run able to tell a
 * finished replay (the human's `git cherry-pick --continue` or `--skip`
 * of a pick they resolved by keeping our side, or a kill after the
 * `cherry-pick` completed: every event file of the range in HEAD's tree,
 * whether or not HEAD moved, round 6 ruling 1) from an abandoned one
 * (`git cherry-pick --abort` returns HEAD to the recorded start, so an
 * event file of the range is missing): the finished one counts as
 * integrated up to the recorded tip and is never replayed again (the
 * human's resolution of a replayed commit would conflict with the same
 * commit replayed once more), the abandoned one is replayed again. The
 * record is also removed when a replay stops for a reason the move
 * cannot skip (round 6 ruling 2), so the next run replays the whole
 * range again.
 */
const REPLAY_RECORD = 'agentboard-replay';

/**
 * The operation stopped in a temporary worktree, by the markers in its
 * git directory: `rebase` for `rebase-merge` or `rebase-apply`;
 * `cherry-pick` for `CHERRY_PICK_HEAD` or a `sequencer` directory, with
 * or without the other (round 5 ruling 1: a multi-commit cherry-pick
 * killed between two picks leaves `sequencer` alone, one killed while a
 * pick is committed leaves both).
 */
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
   * (`rebase-merge`, `rebase-apply`, `CHERRY_PICK_HEAD` or a `sequencer`
   * directory exists in its git directory, round 5 ruling 1): a move that
   * stopped on a conflict in step 3, or on a conflict of the replay of an
   * adopted worktree (round 4 ruling 2), left for a human, or a replay
   * interrupted by a kill, which the move quits and runs again itself
   * (see `moveBoardIntoHost`, "leftovers"). False when not registered.
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
 * worktree remains at all. The worktree at `keep`, when given, is left
 * alone whatever its HEAD: the evidence of this board's unpublished
 * update, which `moveBoardIntoHost` removes itself once its own temporary
 * carries the record (design.md "Carry the record forward"). Returns the
 * paths removed, ascending. Never throws for a missing directory; nothing
 * else in the repository changes.
 */
export function removeDeadMigratingWorktrees(
  hostDir: string,
  options?: HostInitOptions,
  keep?: string,
): string[] {
  const git = hostGit(hostDir, options);
  const migratingRef = refValue(git, MIGRATING_REF);
  const removed: string[] = [];
  // The ref may be gone while worktrees remain: then every registered
  // HEAD differs from it and is kept for the re-run to judge.
  for (const worktree of findMigratingWorktrees(hostDir, options)) {
    if (worktree.alive || worktree.rebasing || worktree.path === keep) {
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
   * which is the remote they retire), without its user information
   * (`withoutUserinfo`; board-cli "Remote URLs are shown without
   * credentials"), for `moved`, read from the kept repository for
   * `resumed`; null when the standalone board had no remote, and for
   * `unchanged` and `repaired`.
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
 * worktree with a rebase stopped in it (a move that stopped on a
 * conflict in step 3), or with a cherry-pick stopped in it that a human
 * is in the middle of (a stop of the replay below with an unmerged path,
 * with the index differing from HEAD: a resolution staged and not yet
 * continued, or with the working tree differing from the index: a `git
 * reset` that left the conflict markers in place, round 6 ruling 2), is
 * never removed and never quit: `BoardError(3, 'sync-in-progress')`
 * whose message names its path and the human steps (resolve, `git add`,
 * then `git rebase --continue` for a stopped rebase or `git cherry-pick
 * --continue` for a stopped cherry-pick, in that worktree, then
 * `agentboard init --into-host` again; the text of the matching
 * `--continue` command and `agentboard init --into-host` appear; for a
 * stopped cherry-pick the message also names `git cherry-pick --skip`
 * and `git commit --allow-empty`, the two ways out of a pick git reports
 * as empty, and `git cherry-pick --abort`; round 5 ruling 2, round 6
 * ruling 1), with nothing changed: the old `.board` untouched, the
 * worktree, its rebase or cherry-pick state, `MIGRATING_REF` and
 * `MIGRATING_FETCH_REF` as they were, and nothing published. An
 * unstaged change to a tracked file of a temporary (`git diff
 * --name-only` not empty: conflict markers a `git reset` left in place,
 * or an edit by hand) is refused in one of two ways, by what git left
 * (orchestrator ruling, round 6): with cherry-pick state still present
 * (a reset on an earlier pick of a sequence keeps the sequencer) it is a
 * human's conflict in progress, the `sync-in-progress` refusal above
 * naming `git cherry-pick --continue`, `--skip` and `--abort`; with no
 * cherry-pick state left (a reset on the last pick drops
 * `CHERRY_PICK_HEAD` and the sequencer with it; an edit by hand in a
 * worktree with nothing in progress) it is `BoardError(3,
 * 'sync-failed')` before anything is quit, replayed or carried over,
 * whose message names the worktree, the files and the steps (commit,
 * stash or discard them, `git -C <temp> checkout -- <path>`, then
 * `agentboard init --into-host` again; implementer decision, round 6).
 * Either way nothing is quit, the worktree stays adoptable with its
 * state and HEAD as they were, and the refs, `.board` and the remote are
 * untouched. A dead-pid
 * temporary with cherry-pick state that no human is in the middle of
 * (nothing unmerged, the index equal to HEAD and the working tree equal
 * to the index, `git diff --quiet` and `git diff --cached --quiet` both
 * clean: the move's own replay interrupted by a kill between two picks,
 * leaving `sequencer` alone, or while a pick was committed, leaving
 * `CHERRY_PICK_HEAD` too; round 5 rulings 1 and 2) is not a refusal: the
 * move runs `cherry-pick --quit` in it (HEAD and the commits already
 * picked stay), and it is then treated like any other temporary without
 * such state: removed when its HEAD is still `MIGRATING_REF`, adopted and
 * replayed again from the recorded integrated tip otherwise (the commits
 * already picked becoming empty and skipped, so a kill anywhere in a
 * multi-commit replay is completed by the re-run with every event, each
 * once). Then, before any leftover is removed or adopted, what an
 * unfinished move of another board put into the local
 * `refs/agentboard/board` is undone or refused (`undoForeignUpdates`):
 * every dead temporary without rebase or cherry-pick state whose HEAD is
 * an ancestor of, or equal to, the ref, a plain leftover included, is
 * judged by the adoption test below; one of another board whose HEAD
 * equals the ref and whose `agentboard-board-before` record (the ref's
 * value before its step 4 swap, written immediately before the swap) is
 * well formed has the ref set back to that value by compare-and-swap
 * (deleted for the zero object name), said in the message, the rest
 * judged again against the new value; one of another board without such
 * a record, or whose HEAD the ref has moved past, is `BoardError(3,
 * 'sync-failed')` naming the ref, the temporary and the `git update-ref`
 * remedy, nothing changed; a reset that loses its compare-and-swap is the
 * same exit saying the ref moved meanwhile. A temporary whose update was
 * set back is removed and named as left by a move of another board
 * whatever its HEAD, also when a kill between the reset and the removal
 * left it marked (`agentboard-board-undone`) for this run; one whose
 * record equals its HEAD is removed and named the same way with no
 * command run and no line; a refusal after resets made earlier in the
 * run says they were kept; a live temporary of another board whose HEAD
 * is in the ref is `BoardError(3, 'sync-in-progress')` naming it, before
 * any reset; every dead temporary of another board whose HEAD was in the
 * ref as the run began is removed and named as another board's once the
 * chain is done, also one whose update a reset made for another
 * temporary undid (ruling 13). Then the evidence of this board's own
 * unpublished update is found (design.md "Carry the record forward"):
 * the first by name of the dead temporaries of this board whose HEAD is
 * an ancestor of, or equal to, the ref (ruling 14; the others are plain
 * leftovers). It is kept through the leftover pass (renamed to
 * `<pid>-kept` when named by this process's pid, which the fresh
 * temporary takes), adopted when it integrated something, and otherwise
 * removed, named as left by an interrupted move, only after this run's
 * swap of step 4 succeeded; at that swap, when `<old>` still equals the
 * value the leftover pass read, the record written is the evidence's own
 * `agentboard-board-before` when its HEAD equals the ref (so it never
 * names this board's unpublished commits), or none when its HEAD is a
 * strict ancestor (another writer added commits on top, review round 2)
 * or it has no well formed record, so a later run with another board
 * refuses rather than resets or integrates. A live temporary of this
 * board is left alone (ruling 15). Otherwise `removeDeadMigratingWorktrees(hostRoot)`
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
 * `git rev-parse --absolute-git-dir` in it, right after `worktree add`)
 * and then the HEAD commit that repository had at step 1 (the full object
 * name and a newline in the file `agentboard-source-head` beside it). It
 * belongs when the identity names the repository at `dir` now (round 4
 * ruling 3; checked first, and no git command runs when it differs; a
 * record that cannot be read names no repository), the recorded HEAD is
 * an ancestor of, or equal to, that repository's HEAD (the test of step
 * 6, so a board replaced at the same path even where the file system
 * reuses the inode, or one whose history was rewritten since, is another
 * board) and the tip it integrated, recorded in its own file
 * `agentboard-source-tip` (the value `MIGRATING_REF` was set to for it,
 * rewritten when the move advances the ref for it), is an ancestor of,
 * or equal to, the repository's source tip (so a remote force-reset past
 * what the temporary integrated, or a replacement forked from the board
 * at or after the recorded HEAD, is another board too); a recorded HEAD
 * or tip that is not a full object name, that the repository lacks or
 * that cannot be read counts as not an ancestor. A temporary without a
 * tip record (made before the record existed) is judged against the
 * shared `MIGRATING_REF` only when it is the only entry under
 * `migrating/` before the run removes any leftover, else it is not
 * adoptable, because another run may have set the ref while this one's
 * pid looked alive. All three records are written atomically (a
 * temporary file in the git directory renamed onto the record), at step
 * 3 and when an adopted temporary gains the ones it lacks. One of another
 * board is never adopted: without rebase
 * or cherry-pick state it is removed like a dead leftover and the message
 * names it, saying it was left by a move of another board (not the one at
 * `dir`, or one whose history no longer holds where that move began);
 * with such state it is the `sync-in-progress` refusal above, whose
 * message says the same. One with the identity record only (made by
 * 0.2.0) is this board's when the identity names the repository and the
 * tip it integrated (`MIGRATING_REF`) is an ancestor of, or equal to,
 * the source tip of `.board`; one with no record (made by older code;
 * round 5 ruling 5) when that tip is in the source tip's history. Neither
 * is refused for its format; adopted, its resolution is kept and the
 * records it lacks are written with this run's identity and HEAD, so the
 * next run judges it by the full test. Otherwise it is removed and named
 * the same way. The
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
 * runs); otherwise, first every untracked `events/*.json` of the
 * worktree whose content equals the blob of the same path in the fresh
 * tip's tree is removed (one copied in by the step 5 carry-over of an
 * earlier run that stopped before the rename, since committed by the
 * standalone board; the pick re-creates it, and git refuses to overwrite
 * an untracked file even with identical content; round 5 ruling 3; a
 * file the fresh tip lacks or holds with other content is left for step
 * 5), then `cherry-pick <base>..refs/agentboard/migrating-fetch`
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
 *    written into the worktree's git directory, then the
 *    `agentboard-source-head` record of its HEAD at step 1 (see
 *    "leftovers" above).
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
 * 4. The record `agentboard-board-before` in the temporary's git
 *    directory (`<old>` as a full object name, or the zero object name
 *    when the ref does not exist, and a newline; atomic, rewritten for an
 *    adopted temporary), then
 *    `update-ref refs/agentboard/board <HEAD of the worktree> <old>` in
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
    throw syncFailed(`fetching ${branch.trim()} from ${name}`, fetched, git);
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
  return {
    sourceTip: tracking,
    oldRemoteUrl: isGitFailure(url) ? null : withoutUserinfo(url.trim()),
    gitDir,
    head,
  };
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

  // Leftovers of earlier moves: the move's own replay interrupted by a
  // kill is quit (round 5 ruling 2), a stopped rebase or a cherry-pick a
  // human is in the middle of waits for them, what holds nothing is
  // removed, one left by a move of another board is removed, and a
  // finished rebase of this board is adopted.
  const board = gitRunner(dir, { env });
  // Every entry under `migrating/` before this run removes any leftover: a
  // temporary without a `TIP_RECORD` is judged against the shared
  // `MIGRATING_REF` only when it is the only one, since a leftover of any
  // kind may be the one that last set the ref.
  const entriesBefore = findMigratingWorktrees(hostRoot, { env }).map((w) => w.path);
  const belongs = (path: string): boolean =>
    belongsToBoard(
      host,
      board,
      path,
      plan,
      refValue(host, MIGRATING_REF),
      entriesBefore.length === 1 && entriesBefore[0] === path,
    );
  for (const interrupted of findMigratingWorktrees(hostRoot, { env }).filter(
    (w) =>
      dead(w) &&
      w.rebasing &&
      stoppedOperation(host, w.path) === 'cherry-pick' &&
      nothingStaged(host, w.path),
  )) {
    // HEAD and the picks already made stay; the replay runs again below,
    // the commits already picked becoming empty and skipped.
    host.attemptIn(interrupted.path, 'cherry-pick', '--quit');
  }
  const stopped = findMigratingWorktrees(hostRoot, { env }).find((w) => dead(w) && w.rebasing);
  if (stopped !== undefined) {
    throw stoppedInTemporary(host, stopped.path, dir, belongs(stopped.path));
  }
  // What an unfinished move of another board put into the local ref is
  // undone (or refused) before any leftover is removed or adopted; the
  // temporaries whose update was set back are then removed and named as
  // left by a move of another board, whatever their HEAD.
  const undone = undoForeignUpdates(host, hostRoot, dir, plan, belongs, env);
  const foreign: string[] = [];
  for (const path of undone.paths) {
    removeLeftoverWorktree(host, path);
    foreign.push(path);
  }
  // The evidence of this board's own unpublished update (design.md "Carry
  // the record forward"): the first, by the byte order of names, dead
  // temporary of this board whose HEAD is an ancestor of, or equal to,
  // the ref as the leftover pass finds it (ruling 14). The ref then
  // already holds this board's commits, so the value this run's swap
  // compares against is not the undo point; the record to write at step
  // 4 is that temporary's own when its HEAD equals the ref
  // (`carriedRecord`), and none (null) when it has no well formed record
  // or when its HEAD is a strict ancestor (another writer added commits
  // on top, review round 2): nothing is written then, so a later run
  // with another board refuses rather than resets or integrates. The
  // temporary is kept, not removed or adopted away, until this run's
  // swap has succeeded with that record in place, so a run that stops
  // before then leaves the evidence for the next. One named by this
  // process's own pid is renamed first, as the fresh temporary of this
  // run takes that path.
  const refAtLeftover = refValue(host, BOARD_REF);
  const evidence =
    refAtLeftover === ''
      ? undefined
      : findMigratingWorktrees(hostRoot, { env }).find(
          (w) =>
            dead(w) &&
            !w.rebasing &&
            w.registered &&
            w.head !== null &&
            isAncestor(host, w.head, refAtLeftover) &&
            belongs(w.path),
        );
  let evidencePath = evidence?.path;
  let carriedRecord: string | null = null;
  if (evidence !== undefined) {
    const record = nameRecord(host, evidence.path, BEFORE_RECORD, plan.head.length);
    carriedRecord = record.present && evidence.head === refAtLeftover ? record.name : null;
    if (evidence.pid === process.pid) {
      evidencePath = `${evidence.path}-kept`;
      host.run('worktree', 'move', evidence.path, evidencePath);
    }
  }
  const removed = removeDeadMigratingWorktrees(hostRoot, { env }, evidencePath);
  // The source tip the adopted temporary worktree integrated (what the
  // ref records; the fetch of step 2 never moves it): the base of the
  // replay of what reached the standalone board since.
  const oldSource = refValue(host, MIGRATING_REF);
  // A temporary named by this process's own pid was left by an earlier
  // call in this process; the helper leaves it alone, the move treats it
  // as dead: removed when nothing was integrated in it, adopted otherwise.
  for (const own of findMigratingWorktrees(hostRoot, { env }).filter(
    (w) =>
      w.pid === process.pid &&
      w.path !== evidencePath &&
      !w.rebasing &&
      (w.head === null || w.head === oldSource),
  )) {
    removeLeftoverWorktree(host, own.path);
    removed.push(own.path);
  }
  removed.sort();
  // A temporary that integrated something is adopted only when it was
  // made from the repository at `dir` now and from its history (round 4
  // ruling 3 and the step 6 ancestry test; a temporary of an earlier
  // version by the tip it integrated, round 5 ruling 5): one made from a
  // board replaced or rewritten since is removed and named. An adopted
  // temporary of an earlier version gains the records it lacks, with this
  // run's identity and HEAD, so the next run judges it by the full test.
  let adoptable: MigratingWorktree | undefined;
  for (const candidate of findMigratingWorktrees(hostRoot, { env }).filter(
    (w) => dead(w) && !w.rebasing && w.registered && w.head !== null && w.head !== oldSource,
  )) {
    if (adoptable === undefined && belongs(candidate.path)) {
      adoptable = candidate;
      if (!sourceRecord(host, candidate.path).present) {
        writeRecord(host, candidate.path, SOURCE_RECORD, plan.gitDir ?? '');
      }
      if (!nameRecord(host, candidate.path, HEAD_RECORD, plan.head.length).present) {
        writeRecord(host, candidate.path, HEAD_RECORD, `${plan.head}\n`);
      }
      if (!nameRecord(host, candidate.path, TIP_RECORD, plan.head.length).present) {
        writeRecord(host, candidate.path, TIP_RECORD, `${oldSource}\n`);
      }
    } else if (candidate.path !== evidencePath) {
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
    writeRecord(host, temp, HEAD_RECORD, `${plan.head}\n`);
    writeRecord(host, temp, TIP_RECORD, `${refValue(host, MIGRATING_REF)}\n`);
  } else {
    temp = adoptable.path;
  }
  const worktree = gitRunner(temp, { env, disableHooks: true });
  if (adopted) {
    // Source commits the adopted worktree lacks (synced to the old remote
    // since it integrated `integrated`) are replayed onto it; a replay a
    // human finished by hand counts as integrated up to its tip.
    const fresh = refValue(host, MIGRATING_FETCH_REF);
    // An unstaged change to a tracked file (a conflict a human reset
    // without resolving, which on the last pick of a sequence also makes
    // git drop its cherry-pick state, leaving the markers in a worktree
    // with nothing in progress; an edit by hand) is never carried into
    // the move, replayed over or published by the sync of step 7 (round 6
    // ruling 2): the human settles it first, the worktree stays adoptable.
    const dirty = zList(worktree.run('diff', '--name-only', '-z')).sort();
    if (dirty.length > 0) {
      throw new BoardError(
        3,
        'sync-failed',
        `the temporary worktree at ${asciiText(temp)} has local changes to ` +
          `${dirty.map((p) => asciiText(p)).join(', ')} (a conflict left unresolved, or an edit ` +
          'by hand), which the move cannot carry over or replay onto; commit, stash or discard ' +
          `them there (git -C ${asciiText(temp)} checkout -- <path>), then run ${AGAIN} again; ` +
          `the board at ${asciiText(dir)} is untouched`,
      );
    }
    const integrated = finishedReplay(host, worktree, temp, oldSource) ?? oldSource;
    if (fresh !== integrated && !isAncestor(worktree, MIGRATING_FETCH_REF, 'HEAD')) {
      replayFreshCommits(host, worktree, dir, temp, integrated, fresh);
    }
    host.run('update-ref', MIGRATING_REF, fresh);
    // The tip the worktree has integrated is now `fresh`: the record
    // follows the ref, so a later run judges this worktree by its own tip.
    writeRecord(host, temp, TIP_RECORD, `${fresh}\n`);
    removeRecord(host, temp, REPLAY_RECORD);
  }
  const old = refValue(host, BOARD_REF);
  if (old !== '' && !isAncestor(worktree, BOARD_REF, 'HEAD')) {
    rebaseOnto(host, hostRoot, env, worktree, dir, temp, adopted, [BOARD_REF], `the local ${BOARD_REF}`);
  }
  const warnings: string[] = [];
  let joined = false;
  if (remote !== null) {
    const target = resolveRemoteTarget(remote.name, remote.url, hostRoot);
    refreshLock(lock);
    const listed = worktree.attempt('ls-remote', target, BOARD_REF);
    if (isGitFailure(listed)) {
      warnings.push(
        remoteMessage(
          `the host remote ${remote.name} could not be reached (${rawErrorLine(listed)}); ` +
            `the board is moved anyway, and agentboard sync publishes it once ${remote.name} ` +
            'can be reached',
          worktree,
        ),
      );
    } else if (listed.trim() !== '') {
      const fetched = worktree.attempt('fetch', '--no-tags', target, BOARD_REF);
      if (isGitFailure(fetched)) {
        if (!adopted) {
          discardTemporary(host, hostRoot, temp, env);
        }
        // `host` (the same repository): the temporary worktree may be gone.
        throw syncFailed(`fetching ${BOARD_REF} from ${remote.name}`, fetched, host);
      }
      if (!isAncestor(worktree, 'FETCH_HEAD', 'HEAD')) {
        rebaseOnto(
          host,
          hostRoot,
          env,
          worktree,
          dir,
          temp,
          adopted,
          ['FETCH_HEAD'],
          `what ${asciiText(withoutUserinfo(remote.name))} holds`,
        );
      }
      joined = true;
    }
  }

  // 4. The value the swap compares against, recorded in the temporary so
  // a re-run with another board can set the ref back; then the
  // compare-and-swap, then the host .gitignore entry.
  const head = worktree.run('rev-parse', 'HEAD').trim();
  const resuming = evidencePath !== undefined && old === refAtLeftover;
  if (!resuming) {
    writeRecord(host, temp, BEFORE_RECORD, `${old === '' ? zeroObjectName(plan) : old}\n`);
  } else if (carriedRecord === null) {
    removeRecord(host, temp, BEFORE_RECORD);
  } else {
    writeRecord(host, temp, BEFORE_RECORD, `${carriedRecord}\n`);
  }
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
  // The evidence has served: this temporary now carries its record and
  // holds the ref, so the leftover goes as a plain leftover does.
  if (resuming && evidencePath !== undefined && evidencePath !== temp) {
    removeLeftoverWorktree(host, evidencePath);
    removed.push(evidencePath);
    removed.sort();
  }
  const hostGitignore = ignoreBoardInHost(hostRoot);

  // 5. Every old event file, carried over hash-verified.
  const carried = carryOverEventFiles(join(dir, 'events'), join(temp, 'events'));
  if (carried.mismatched.length > 0) {
    throw mismatchedEvents(carried.mismatched, join(dir, 'events'), temp, false);
  }

  // 6. Keep the old repository, move the worktree into place, lock it,
  // carry over what landed in the rename window.
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
        `(not the one at ${asciiText(dir)}, or one whose history no longer holds where that move ` +
        'began), so nothing of it was adopted',
    );
  }
  lines.push(...undone.lines);
  const sync = syncOrFail(dir, hostRoot, [...lines, ...warnings], keptAt, plan.oldRemoteUrl, env);
  lines.push(...sync.message.split('\n'));
  return {
    dir,
    created: false,
    model: 'host',
    joined,
    remote: remote === null ? null : withoutUserinfo(remote.name),
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
 * already holds makes git stop with an empty result: exactly that stop
 * (`CHERRY_PICK_HEAD` present, no unmerged path, the index equal to HEAD;
 * round 6 ruling 2) is skipped (`cherry-pick --skip`) and the sequence
 * goes on. A conflict is left in place for a human: `BoardError(3,
 * 'sync-conflict')` naming the unmerged paths, the worktree and the human
 * steps with `git cherry-pick --continue` (or `--abort`, which returns
 * the worktree to the HEAD it started from), run after the untracked
 * event files the fresh tip holds with the same content were removed
 * from the worktree (round 5 ruling 3); the worktree, the record,
 * `MIGRATING_REF` (still the integrated tip) and `MIGRATING_FETCH_REF`
 * stay. Any other stop (a pick refused over a local change of a tracked
 * file, whose `sequencer` git leaves behind without `CHERRY_PICK_HEAD`;
 * anything else git reports) is never skipped: the move runs
 * `cherry-pick --quit` in the worktree (HEAD and the picks already made
 * stay, the local change untouched), removes the record (so the next
 * run replays the whole range again from the integrated tip, the picks
 * already made becoming empty and skipped, and no commit is dropped),
 * and throws `BoardError(3, 'sync-failed')` with git's first error line,
 * the adopted worktree kept and adoptable, `MIGRATING_REF` still the
 * integrated tip, nothing published. The caller advances `MIGRATING_REF`
 * and removes the record once the replay succeeded; the `sync` of step 7
 * therefore never commits or publishes a conflict marker.
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
  removeUntrackedEventsHeldBy(worktree, temp, fresh);
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
    if (!emptyStop(worktree, temp) || skipped >= Number(limit)) {
      // Any other stop (a pick refused over a local change of a tracked
      // file, whose sequencer git leaves behind; anything else): never
      // skipped. The sequence is quit (HEAD, the picks already made and
      // the local change stay), the record goes so the next run replays
      // the whole range again, and the worktree stays adoptable (round
      // 6 ruling 2), so no pick is ever dropped and no conflict marker
      // reaches the sync of step 7.
      worktree.attempt('cherry-pick', '--quit');
      removeRecord(host, temp, REPLAY_RECORD);
      const dirty = zList(worktree.run('diff', '--name-only', '-z')).sort();
      const local =
        dirty.length === 0
          ? ''
          : `; the temporary worktree at ${asciiText(temp)} has local changes to ` +
            `${dirty.map((p) => asciiText(p)).join(', ')}, which the replay cannot apply over: ` +
            `commit, stash or discard them there (git -C ${asciiText(temp)} checkout -- <path>), ` +
            `then run ${AGAIN} again`;
      throw new BoardError(
        3,
        'sync-failed',
        `replaying the events synced to the old remote since the earlier move failed: ` +
          `${remoteErrorLine(out, worktree)}${local}`,
      );
    }
    // Git's own empty stop: the commit's patch is already in HEAD (one
    // the human finished by hand); never kept as an empty commit.
    out = worktree.attempt('cherry-pick', '--skip');
  }
}

/**
 * True when git stopped the cherry-pick in the worktree at `temp` on a
 * pick it reports as empty: `CHERRY_PICK_HEAD` present, no unmerged path
 * and the index equal to HEAD (round 6 ruling 2). Only that stop is
 * skipped by the move; a sequencer left without `CHERRY_PICK_HEAD` (a
 * pick refused over a local change) is not.
 */
function emptyStop(worktree: GitRunner, temp: string): boolean {
  const gitDir = worktreeGitDir(worktree, temp);
  return (
    gitDir !== null &&
    existsSync(join(gitDir, 'CHERRY_PICK_HEAD')) &&
    unmergedPaths(worktree).length === 0 &&
    !isGitFailure(worktree.attempt('diff', '--cached', '--quiet'))
  );
}

/**
 * Before a replay (round 5 ruling 3): removes every untracked
 * `events/*.json` of the worktree at `temp` whose content equals the blob
 * of the same path in the tree of `fresh` (one copied in by the step 5
 * carry-over of an earlier run that stopped before the rename, since
 * committed by the standalone board), because git refuses a pick that
 * would overwrite an untracked file, even with identical content, and the
 * pick re-creates it. A file the fresh tip lacks, or holds with other
 * content, is left for step 5.
 */
function removeUntrackedEventsHeldBy(worktree: GitRunner, temp: string, fresh: string): void {
  const untracked = zList(
    worktree.run('ls-files', '-z', '--others', '--exclude-standard', '--', 'events'),
  ).filter((path) => EVENT_PATH.test(path));
  for (const path of untracked) {
    const held = worktree.attempt('rev-parse', '--verify', '--quiet', `${fresh}:${path}`);
    if (isGitFailure(held)) {
      continue;
    }
    const local = worktree.attempt('hash-object', '--', join(temp, path));
    if (!isGitFailure(local) && local.trim() === held.trim()) {
      rmSync(join(temp, path), { force: true });
    }
  }
}

/**
 * The tip a replay recorded in `REPLAY_RECORD` of the adopted worktree at
 * `temp` reached, when that replay finished without the move advancing
 * `MIGRATING_REF` (the human's `git cherry-pick --continue`, a
 * resolution that kept our side and skipped the then empty pick, or a
 * kill after the `cherry-pick` completed): every event file the range
 * `<oldSource>..<tip>` adds is in HEAD's tree, whether or not HEAD left
 * the recorded start (round 6 ruling 1: a range whose only commit the
 * human resolved by keeping our side adds no event and moves HEAD
 * nowhere, and is integrated all the same; a `git cherry-pick --abort`
 * is told apart by the record being removed when nothing of the range
 * is in HEAD). Null, and the record removed, when there is no record,
 * when no cherry-pick is stopped and an event file of the range is
 * missing from HEAD (the sequence was quit half way, or aborted before
 * an event commit was applied): the replay then runs again from
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
  const tip = record.split('\n')[1];
  if (tip === undefined || tip === '' || refValue(worktree, tip) === '') {
    return null;
  }
  // Whether HEAD left `start` does not decide: a range whose only pick
  // the human resolved by keeping our side (then skipped) adds no event
  // and moves HEAD nowhere, and is integrated all the same (round 6
  // ruling 1); an abort shows as an event file of the range missing.
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
 * another board (`belongs` false: not the repository at `dir`, or one
 * whose history no longer holds the HEAD that move began from, the
 * judgement of `belongsToBoard`), which the re-run will not adopt either
 * way. The text does not say which test failed: the remedy is the same.
 */
function stoppedInTemporary(
  host: GitRunner,
  path: string,
  dir: string,
  belongs: boolean,
): BoardError {
  const operation = stoppedOperation(host, path) ?? 'rebase';
  const origin = belongs
    ? ''
    : ` (that worktree was left by a move of another board, not the one at ${asciiText(dir)} now ` +
      'or one whose history no longer holds where that move began, so finishing it moves nothing ' +
      'of this board)';
  const steps =
    operation === 'cherry-pick'
      ? 'git cherry-pick --continue (for a pick git reports as empty, git cherry-pick --skip drops it or git commit --allow-empty keeps it; git cherry-pick --abort returns to where the replay started)'
      : 'git rebase --continue (or git rebase --abort)';
  return new BoardError(
    3,
    'sync-in-progress',
    `an earlier ${AGAIN} stopped on a conflict, and its ${operation} is still in progress in the ` +
      `temporary worktree at ${asciiText(path)}${origin}; resolve the conflict, git add the paths ` +
      `and ${steps} in ${asciiText(path)}, then run ${AGAIN} again; the board at ` +
      `${asciiText(dir)} is untouched`,
  );
}

/** What `undoForeignUpdates` did: the output lines of the resets, in the order made, and the temporaries to remove and name as another board's. */
interface UndoneUpdates {
  readonly lines: string[];
  readonly paths: string[];
}

/**
 * Undoes what an unfinished move of another board put into the local
 * `BOARD_REF`, in the leftover pass, before any leftover is removed or
 * adopted. A move killed, or refused at step 6, after its step 4 swap
 * leaves a dead temporary whose HEAD is in the local ref without having
 * published it (nothing after step 4 moves the temporary's HEAD).
 *
 * First, a temporary named by a live pid (not this process), without
 * rebase or cherry-pick state, whose HEAD is in the ref and which is not
 * this board's (`belongs`, `belongsToBoard`) is `BoardError(3,
 * 'sync-in-progress')` naming it, before any reset (ruling 6): another
 * move may be running, or the pid was reused, and either way its commits
 * are not integrated. A live temporary of this board is left alone.
 *
 * Then a dead temporary carrying `UNDONE_RECORD` whose HEAD is not in the
 * ref (a kill between a reset and the removal) is returned for removal
 * and naming, with no reset line (ruling 7).
 *
 * Then every dead temporary without rebase or cherry-pick state
 * (`stoppedInTemporary` has already refused for those) whose HEAD is an
 * ancestor of, or equal to, the ref is a candidate, a plain leftover
 * (HEAD still `MIGRATING_REF`, as in a host whose remote has no board
 * ref) included, each judged once by `belongs`:
 *
 * - this board's: nothing happens here; the ref's commits are this
 *   board's history, which step 3 integrates, and the temporary is
 *   removed, kept as the evidence or adopted by the rules that follow;
 * - another board's, with the ref equal to its HEAD and a well formed
 *   `BEFORE_RECORD` equal to that HEAD: the ref's content was there
 *   independently of that move, so no command runs and no line is
 *   printed; the temporary is returned for removal and naming (ruling 8);
 * - another board's, with the ref equal to its HEAD and a well formed
 *   `BEFORE_RECORD` naming the zero object name or a commit of the host:
 *   the temporary is marked with `UNDONE_RECORD`, the ref is set back to
 *   the recorded value with the compare-and-swap `update-ref BOARD_REF
 *   <recorded> <HEAD>` (which deletes the ref for the zero object name),
 *   a line says so, and the remaining candidates are judged again against
 *   the new value, so a chain of such updates is undone newest first; the
 *   temporary is returned for removal and naming, whatever its HEAD;
 * - another board's otherwise: `BoardError(3, 'sync-failed')` naming the
 *   ref, the temporary and the `git update-ref` remedy, saying why (no
 *   well formed record, as from a version that did not write it; a
 *   recorded value that is not a commit of the host, ruling 11; or the
 *   ref moved on past the HEAD of every such candidate, naming the one
 *   whose HEAD is the furthest along, ruling 10), taken before anything
 *   is removed, so the temporary stays as the evidence and the next run
 *   judges again. The refusal says which resets this run already made,
 *   when it made any (ruling 9). A reset that loses its compare-and-swap
 *   (something moved the ref after it was read) is the same exit saying
 *   the ref moved meanwhile, the marker removed again; resets already
 *   made stay, each was exact.
 *
 * When the chain is done, every dead temporary of another board whose
 * HEAD was in the ref as the run began is returned for removal and
 * naming (ruling 13): one not set back itself had its update undone by
 * a reset made for another temporary.
 *
 * Nothing is removed here: a refusal part way through a chain leaves the
 * temporaries already set back in place, their HEAD no longer in the ref
 * and their marker set, for the next run.
 */
function undoForeignUpdates(
  host: GitRunner,
  hostRoot: string,
  dir: string,
  plan: MovePlan,
  belongs: (path: string) => boolean,
  env: Env,
): UndoneUpdates {
  const lines: string[] = [];
  const paths: string[] = [];
  const resets: string[] = [];
  const judged = new Map<string, boolean>();
  const ours = (path: string): boolean => {
    let verdict = judged.get(path);
    if (verdict === undefined) {
      verdict = belongs(path);
      judged.set(path, verdict);
    }
    return verdict;
  };
  const inRef = (worktree: MigratingWorktree, ref: string): worktree is MigratingWorktree & { head: string } =>
    !worktree.rebasing &&
    worktree.registered &&
    worktree.head !== null &&
    ref !== '' &&
    isAncestor(host, worktree.head, ref);
  const initial = refValue(host, BOARD_REF);
  const found = findMigratingWorktrees(hostRoot, { env });
  const live = found.find((w) => !dead(w) && inRef(w, initial) && !ours(w.path));
  if (live !== undefined) {
    throw liveForeignTemporary(live.path, dir);
  }
  for (const marked of found.filter(
    (w) => dead(w) && !w.rebasing && w.registered && hasRecord(host, w.path, UNDONE_RECORD) && !inRef(w, initial),
  )) {
    paths.push(marked.path);
  }
  // Every dead temporary of another board whose HEAD is in the ref as the
  // run begins is named as another board's once the chain is done
  // (ruling 13): one not set back itself had its update undone by a reset
  // made for another temporary (two temporaries of one board holding the
  // ref after a kill between a resume's swap and its removal of the
  // evidence), or the chain ended in a refusal, which removes nothing.
  const foreignAtStart = found.filter((w) => dead(w) && inRef(w, initial) && !ours(w.path)).map((w) => w.path);
  const done = (): UndoneUpdates => {
    for (const path of foreignAtStart) {
      if (!paths.includes(path)) {
        paths.push(path);
      }
    }
    return { lines, paths };
  };
  for (;;) {
    const ref = refValue(host, BOARD_REF);
    if (ref === '') {
      return done();
    }
    const candidates = findMigratingWorktrees(hostRoot, { env }).filter(
      (w): w is MigratingWorktree & { head: string } =>
        dead(w) && !paths.includes(w.path) && inRef(w, ref) && !ours(w.path),
    );
    if (candidates.length === 0) {
      return done();
    }
    const equal = candidates.find((w) => w.head === ref);
    if (equal === undefined) {
      // The ref holds every candidate's HEAD and more: name the one
      // furthest along (a descendant of the others, where they are related).
      const furthest = candidates.reduce((best, w) => (isAncestor(host, best.head, w.head) ? w : best));
      throw cannotSetBack(furthest.path, dir, 'the ref has moved on past what that move put into it', resets);
    }
    const record = nameRecord(host, equal.path, BEFORE_RECORD, plan.head.length);
    if (!record.present || record.name === null) {
      throw cannotSetBack(equal.path, dir, "that move left no record of the ref's value before it", resets);
    }
    if (record.name === equal.head) {
      paths.push(equal.path);
      continue;
    }
    const zero = record.name === zeroObjectName(plan);
    if (!zero && refValue(host, record.name) === '') {
      throw cannotSetBack(
        equal.path,
        dir,
        'the value that move recorded for the ref is not a commit in the host repository',
        resets,
      );
    }
    writeRecord(host, equal.path, UNDONE_RECORD, `${equal.head}\n`);
    if (isGitFailure(host.attempt('update-ref', BOARD_REF, record.name, equal.head))) {
      removeRecord(host, equal.path, UNDONE_RECORD);
      throw new BoardError(
        3,
        'sync-failed',
        `setting ${BOARD_REF} in the host repository back to its value before the interrupted move ` +
          `at ${asciiText(equal.path)} failed because something else moved it meanwhile; nothing was ` +
          `removed, the board at ${asciiText(dir)} is untouched and the temporary worktree is kept; ` +
          `run ${AGAIN} again`,
      );
    }
    lines.push(
      zero
        ? `deleted ${BOARD_REF} in the host repository, as before the interrupted move at ` +
            `${asciiText(equal.path)}, which had created it for another board and not published it`
        : `set ${BOARD_REF} in the host repository back to its value before the interrupted move at ` +
            `${asciiText(equal.path)}, which had updated it for another board and not published it`,
    );
    paths.push(equal.path);
    resets.push(equal.path);
  }
}

/**
 * The refusal of `undoForeignUpdates` when the ref cannot be set back for
 * the temporary at `path`, `why` saying what is missing and `kept` the
 * temporaries whose update this run already set back (ruling 9).
 */
function cannotSetBack(path: string, dir: string, why: string, kept: readonly string[]): BoardError {
  const changed = keptResets(kept);
  return new BoardError(
    3,
    'sync-failed',
    `the interrupted move at ${asciiText(path)} put commits of another board (not the one at ` +
      `${asciiText(dir)}, or one whose history no longer holds where that move began) into ` +
      `${BOARD_REF} in the host repository without publishing them, and ${why}, so the move cannot ` +
      `set the ref back by itself; ${changed} set it back by hand with git update-ref -d ` +
      `${BOARD_REF} when the host's remote holds the board or the ref did not exist before that ` +
      `move, else with git update-ref ${BOARD_REF} <its earlier commit>, then run ${AGAIN} again`,
  );
}

/** The clause of `cannotSetBack` saying what the run changed: nothing, or the resets already made for the temporaries `kept`. */
function keptResets(kept: readonly string[]): string {
  if (kept.length === 0) {
    return 'nothing was changed;';
  }
  const moves = kept.length === 1 ? 'move' : 'moves';
  return (
    `${BOARD_REF} was set back for the interrupted ${moves} at ` +
    `${kept.map((p) => asciiText(p)).join(', ')} earlier in this run, and nothing else was changed;`
  );
}

/** The refusal of `undoForeignUpdates` for a live temporary of another board whose HEAD is in the ref (ruling 6). */
function liveForeignTemporary(path: string, dir: string): BoardError {
  return new BoardError(
    3,
    'sync-in-progress',
    `the temporary worktree at ${asciiText(path)} was made by a move that may still be running ` +
      '(its process is alive) and put commits of another board (not the one at ' +
      `${asciiText(dir)}, or one whose history no longer holds where that move began) into ` +
      `${BOARD_REF} in the host repository without publishing them; nothing was changed; run ` +
      `${AGAIN} again once that move has finished`,
  );
}

/** Whether the file `name` exists in the git directory of the worktree at `path`. */
function hasRecord(host: GitRunner, path: string, name: string): boolean {
  const gitDir = worktreeGitDir(host, path);
  return gitDir !== null && existsSync(join(gitDir, name));
}

/** The zero object name of the board's hash algorithm: as many `0` digits as a full object name of it (`plan.head`) has. */
function zeroObjectName(plan: MovePlan): string {
  return '0'.repeat(plan.head.length);
}

/**
 * Whether the temporary worktree at `path` was made from the standalone
 * repository the move checked in step 1 and from the history it has now,
 * by the records it carries:
 *
 * - `SOURCE_RECORD` and `HEAD_RECORD`: the identity equals that
 *   repository's git directory identity (round 4 ruling 3; checked first,
 *   so no git command runs when it differs), the recorded HEAD is an
 *   ancestor of, or equal to, the repository's HEAD (`plan.head`), the
 *   test step 6 applies before the rename, and the tip the worktree
 *   integrated is in the repository's source tip (the check of the rows
 *   below). The third test is needed because the worktree integrated the
 *   source tip, the remote-tracking ref when the board has a remote,
 *   which may be ahead of HEAD, and the recorded HEAD says nothing about
 *   the commits between the two: without it a remote force-reset past
 *   those commits since the move began, or a replacement forked from the
 *   board at or after the recorded HEAD, would have commits only the
 *   worktree holds published in the host ref. A recorded HEAD that is not
 *   a full object name of the repository's hash algorithm (the length of
 *   `plan.head`), that the repository does not have as a commit, or that
 *   cannot be read counts as not an ancestor: in doubt the move does not
 *   adopt.
 * - `SOURCE_RECORD` only (made by agentboard 0.2.0): the identity equals,
 *   and the tip the worktree integrated (`integrated`, the value of
 *   `MIGRATING_REF`) is an ancestor of, or equal to, the source tip of
 *   that repository (`plan.sourceTip` in `board`, what step 2 fetches),
 *   which a replaced `.board` does not have in its history.
 * - no `SOURCE_RECORD` (made by older code; round 5 ruling 5): the tip it
 *   integrated is in the source tip's history, whatever `HEAD_RECORD`
 *   says.
 *
 * A `SOURCE_RECORD` that cannot be read equals no identity, so the
 * worktree is another board's in both rows that have one.
 *
 * The tip the worktree integrated is what its `TIP_RECORD` names (a
 * present but malformed or unreadable record names none, so the check
 * fails). A worktree without the record, made before the record existed,
 * has only the shared `MIGRATING_REF` (`sharedTip`) to go by, and that is
 * its own tip only when it is the only entry under `migrating/` (`alone`:
 * nothing else can have set the ref since it was made); beside any other
 * entry its tip is unknown and it is not adoptable.
 */
function belongsToBoard(
  host: GitRunner,
  board: GitRunner,
  path: string,
  plan: MovePlan,
  sharedTip: string,
  alone: boolean,
): boolean {
  const record = sourceRecord(host, path);
  if (record.present && record.identity !== (plan.gitDir ?? '')) {
    return false;
  }
  const tip = nameRecord(host, path, TIP_RECORD, plan.head.length);
  const integrated = tip.present ? tip.name : alone ? sharedTip : null;
  if (!record.present) {
    return integratedTipInBoard(board, plan, integrated);
  }
  const head = nameRecord(host, path, HEAD_RECORD, plan.head.length);
  if (!head.present) {
    return integratedTipInBoard(board, plan, integrated);
  }
  return (
    head.name !== null &&
    isAncestor(board, head.name, plan.head) &&
    integratedTipInBoard(board, plan, integrated)
  );
}

/**
 * Round 5 ruling 5 and test 3: whether `integrated`, the tip a temporary
 * integrated, is an ancestor of, or equal to, the board's source tip;
 * false when the tip is unknown (null or empty), so no git command runs.
 */
function integratedTipInBoard(board: GitRunner, plan: MovePlan, integrated: string | null): boolean {
  return integrated !== null && integrated !== '' && isAncestor(board, integrated, plan.sourceTip);
}

/**
 * The `SOURCE_RECORD` of the temporary worktree at `path`: absent, or
 * present with `identity` its content (a trailing newline removed), null
 * when the file cannot be read (a directory, a permission error), which
 * equals no identity and so names another board rather than throwing a
 * raw file error.
 */
function sourceRecord(
  host: GitRunner,
  path: string,
): { present: false } | { present: true; identity: string | null } {
  const gitDir = worktreeGitDir(host, path);
  if (gitDir === null || !existsSync(join(gitDir, SOURCE_RECORD))) {
    return { present: false };
  }
  try {
    return { present: true, identity: readFileSync(join(gitDir, SOURCE_RECORD), 'utf8').replace(/\n$/, '') };
  } catch {
    return { present: true, identity: null };
  }
}

/**
 * The record `record` (`HEAD_RECORD` or `TIP_RECORD`) of the temporary
 * worktree at `path`: absent, or present with `name` the recorded object
 * name when it is well formed and null when it is not. Well formed is the
 * file's content, with at most one trailing newline removed, being
 * exactly `hashLength` lowercase hexadecimal digits (a full object name
 * of the board's hash algorithm): an abbreviated name, a ref name, a
 * revision expression, a second line or a file that cannot be read is
 * malformed, and never reaches a git command.
 */
function nameRecord(
  host: GitRunner,
  path: string,
  record: string,
  hashLength: number,
): { present: false } | { present: true; name: string | null } {
  const gitDir = worktreeGitDir(host, path);
  if (gitDir === null || !existsSync(join(gitDir, record))) {
    return { present: false };
  }
  let content: string;
  try {
    content = readFileSync(join(gitDir, record), 'utf8');
  } catch {
    return { present: true, name: null };
  }
  const name = content.replace(/\n$/, '');
  const wellFormed = name.length === hashLength && /^[0-9a-f]+$/.test(name);
  return { present: true, name: wellFormed ? name : null };
}

/** The git directory of the worktree at `path` (`<common dir>/worktrees/<name>`), or null when it is not one. */
function worktreeGitDir(host: GitRunner, path: string): string | null {
  const out = host.attemptIn(path, 'rev-parse', '--absolute-git-dir');
  return isGitFailure(out) ? null : out.trim();
}

/**
 * Writes `content` to the file `name` in the git directory of the worktree
 * at `path`, atomically: the content goes to a temporary file in that
 * directory, renamed onto `name`, so a reader sees the old state or the
 * whole new record and never an empty or partial one. A kill in the
 * middle of a truncating write of an adopted temporary's record would
 * otherwise leave an empty `HEAD_RECORD`, judged malformed by the next
 * run, which would remove the temporary, with the human's resolution, as
 * another board's. The temporary file's name is never a record's name,
 * so a leftover of an interrupted write is never read as one.
 */
function writeRecord(host: GitRunner, path: string, name: string, content: string): void {
  const gitDir = worktreeGitDir(host, path);
  if (gitDir !== null) {
    const partial = join(gitDir, `.tmp-${name}-${String(process.pid)}`);
    writeFileSync(partial, content);
    renameSync(partial, join(gitDir, name));
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
  const kept = keptAt === null ? null : keptRemoteUrl(keptAt, env);
  const oldRemoteUrl = kept === null ? null : withoutUserinfo(kept);
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
    remote: remote === null ? null : withoutUserinfo(remote.name),
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
      `history is ${BOARD_REF}; ${remote === null ? 'no remote configured' : `remote: ${asciiText(withoutUserinfo(remote))}`}); ` +
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
    remote: remote === null ? null : withoutUserinfo(remote),
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
  hostRoot: string,
  env: Env,
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
    discardTemporary(host, hostRoot, temp, env);
  }
  throw syncFailed(`integrating ${what}`, out, worktree);
}

/**
 * Removes the temporary worktree at `temp` after a refusal in step 3, the
 * temporary refs when no temporary worktree remains (a leftover kept as
 * the evidence of this board's unpublished update, see `lockedMove`, keeps
 * the tip it was judged by) and an empty `migrating` directory.
 */
function discardTemporary(host: GitRunner, hostRoot: string, temp: string, env: Env): void {
  removeLeftoverWorktree(host, temp);
  if (findMigratingWorktrees(hostRoot, { env }).length === 0) {
    deleteTemporaryRefs(host);
  }
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
 * `cherry-pick` when `CHERRY_PICK_HEAD` or a `sequencer` directory does
 * (the replay of an adopted worktree, round 4 ruling 2; a multi-commit
 * replay killed between two picks leaves only the sequencer, round 5
 * ruling 1), else null.
 */
function stoppedOperation(git: GitRunner, cwd: string): StoppedOperation | null {
  const gitDir = worktreeGitDir(git, cwd);
  if (gitDir === null) {
    return null;
  }
  if (['rebase-merge', 'rebase-apply'].some((name) => existsSync(join(gitDir, name)))) {
    return 'rebase';
  }
  return ['CHERRY_PICK_HEAD', 'sequencer'].some((name) => existsSync(join(gitDir, name)))
    ? 'cherry-pick'
    : null;
}

/**
 * True when nothing in the worktree at `path` is a human's work in
 * progress: no unmerged path, an index equal to HEAD and a working tree
 * equal to the index (`git diff --cached --quiet` and `git diff --quiet`
 * both clean). A cherry-pick stopped in such a worktree is the move's own
 * replay interrupted by a kill (round 5 ruling 2), which the move quits
 * and runs again; one with a staged resolution, or with unstaged changes
 * (round 6 ruling 2), is left to the human.
 */
function nothingStaged(host: GitRunner, path: string): boolean {
  const unmerged = host.attemptIn(path, 'diff', '--name-only', '--diff-filter=U');
  return (
    !isGitFailure(unmerged) &&
    unmerged.trim() === '' &&
    !isGitFailure(host.attemptIn(path, 'diff', '--cached', '--quiet')) &&
    // A `git reset` after a conflict leaves the markers in the working
    // tree with a clean index: a human's work, never quit (round 6 ruling 2).
    !isGitFailure(host.attemptIn(path, 'diff', '--quiet'))
  );
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
