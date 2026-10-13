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

import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { sha256Hex } from '../events/canonical.js';
import { BoardError } from '../store/errors.js';
import {
  firstErrorLine,
  gitRunner,
  isGitFailure,
  type GitRunner,
  type GitRunnerOptions,
} from './git.js';
import { BOARD_REF, detectBoardModel } from './model.js';
import { asciiText } from './text.js';

/**
 * Lines of the `.gitignore` that `init` writes inside the board directory,
 * in this order, each followed by a newline: the cache file and its SQLite
 * WAL and shared-memory companions, so `sync` never commits them. Also
 * exported from `src/board/init.ts`.
 */
export const BOARD_GITIGNORE_LINES = [
  'cache.sqlite',
  'cache.sqlite-wal',
  'cache.sqlite-shm',
] as const;

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

/**
 * The lock file `withInitLock` holds under `AGENTBOARD_GIT_SUBDIR` while an
 * `init` makes or repairs the host-model board, so two `init` processes on
 * one host never race `git worktree add` (which can register two worktrees
 * for one path). Removed when the holder is done.
 */
export const INIT_LOCK_FILE = 'init.lock';

/** A lock whose holder is gone, or older than this, is broken by the next `init`. */
const STALE_LOCK_MS = 60_000;

/** Options of every function in this module. */
export type HostInitOptions = Pick<GitRunnerOptions, 'env'>;

/** The fixed time of the deterministic empty-board commit. */
const EPOCH = '@0 +0000';

/** The name of a committed event file. */
const EVENT_FILE = /^[0-9a-f]{64}\.json$/;

/**
 * The name of a kept-aside board directory for the moment `now`:
 * `stale-board-` followed by the UTC time as `YYYYMMDDTHHMMSSZ` (so
 * `stale-board-20261012T153000Z` for 2026-10-12 15:30:00 UTC), plain
 * ASCII, no separators other than `T` and `Z`, sortable by time. Pure.
 */
export function staleBoardName(now: Date): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return (
    `${STALE_BOARD_PREFIX}${pad(now.getUTCFullYear(), 4)}${pad(now.getUTCMonth() + 1)}` +
    `${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}` +
    `${pad(now.getUTCSeconds())}Z`
  );
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
  const git = gitRunner(hostDir, {
    env: { ...(options?.env ?? process.env), GIT_AUTHOR_DATE: EPOCH, GIT_COMMITTER_DATE: EPOCH },
    disableHooks: true,
  });
  const ignore = BOARD_GITIGNORE_LINES.map((line) => `${line}\n`).join('');
  const ignoreBlob = git.runInput(ignore, 'hash-object', '-w', '--stdin').trim();
  const keepBlob = git.runInput('', 'hash-object', '-w', '--stdin').trim();
  const eventsTree = git.runInput(`100644 blob ${keepBlob}\t.gitkeep\n`, 'mktree').trim();
  const rootTree = git
    .runInput(
      `100644 blob ${ignoreBlob}\t.gitignore\n040000 tree ${eventsTree}\tevents\n`,
      'mktree',
    )
    .trim();
  return git.run('commit-tree', rootTree, '-m', EMPTY_BOARD_COMMIT_MESSAGE).trim();
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
  const git = hostGit(hostDir, options);
  const local = commitOf(git, BOARD_REF);
  if (local !== null) {
    return { commit: local, source: 'local', warnings: [] };
  }
  const warnings: string[] = [];
  if (remote !== null) {
    const listed = git.attempt('ls-remote', remote, BOARD_REF);
    if (isGitFailure(listed)) {
      warnings.push(
        `the remote ${asciiText(remote)} could not be reached (${firstErrorLine(listed)}); ` +
          'created a new empty board, and the next agentboard sync joins any board there',
      );
    } else if (listed.trim() !== '') {
      git.run('fetch', '--no-tags', remote, `${BOARD_REF}:${BOARD_REF}`);
      const fetched = git.run('rev-parse', '--verify', `${BOARD_REF}^{commit}`).trim();
      return { commit: fetched, source: 'remote', warnings };
    }
  }
  const commit = writeEmptyBoardCommit(hostDir, options);
  try {
    git.run('update-ref', BOARD_REF, commit, '');
  } catch (error) {
    // Another process created the ref in between: use what it made.
    const raced = commitOf(git, BOARD_REF);
    if (raced === null) {
      throw error;
    }
    return { commit: raced, source: 'local', warnings };
  }
  return { commit, source: 'created', warnings };
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
  const git = hostGit(hostDir, options);
  const entry = registeredAt(git, dir);
  if (entry === null) {
    try {
      git.run('worktree', 'add', '--detach', dir, BOARD_REF);
    } catch (error) {
      // Another process added the worktree in between: not an error.
      if (registeredAt(git, dir) === null) {
        throw error;
      }
    }
  } else if (!existsSync(dir)) {
    git.run('worktree', 'add', '-f', '-f', '--detach', dir, BOARD_REF);
  }
  lockWorktree(git, dir);
  disableSparseCheckout(dir, options);
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
 * 1. For a `broken-host-link` whose `.git` file names a git directory that
 *    is missing (the host was moved together with its `.board`):
 *    `git worktree repair <dir>` in `hostDir`. When `detectBoardModel(dir)`
 *    is then `host`, the repair is done: method `worktree-repair`, nothing
 *    copied, nothing kept aside, and the worktree is locked when it is not.
 *    A `.git` file naming a directory that exists (a `.board` copied from
 *    another clone, whose repository still has it) skips this step:
 *    `git worktree repair` would otherwise rewrite that other repository's
 *    worktree entry to point here.
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
 *    one rename; a numeric suffix keeps two copies kept in one second
 *    apart), the fresh worktree is moved into place with
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
  const git = hostGit(hostDir, options);
  const env = options?.env;
  if (detectBoardModel(dir, { env }).model === 'broken-host-link' && gitfileTargetMissing(dir)) {
    git.attempt('worktree', 'repair', dir);
    if (detectBoardModel(dir, { env }).model === 'host') {
      lockWorktree(git, dir);
      return { method: 'worktree-repair', copied: [], skipped: [], keptAt: null, source: null };
    }
  }

  const ref = ensureBoardRef(hostDir, remote, options);
  const scratch = agentboardGitDir(git, hostDir);
  const repairing = join(scratch, REPAIRING_WORKTREE);
  removeLeftoverWorktree(git, repairing);
  git.run('worktree', 'add', '--detach', repairing, BOARD_REF);
  const { copied, skipped } = carryOverEvents(join(dir, 'events'), join(repairing, 'events'));
  const keptAt = freshStaleName(scratch, new Date());
  renameSync(dir, keptAt);
  git.run('worktree', 'move', repairing, dir);
  lockWorktree(git, dir);
  disableSparseCheckout(dir, options);
  return { method: 'fresh-worktree', copied, skipped, keptAt, source: ref.source };
}

/**
 * Finishes a repair that was interrupted after the old directory was
 * renamed away and before the fresh worktree was moved into place: when
 * `dir` is missing and `<git common dir>/agentboard/repairing` is a
 * registered, present worktree, `git worktree move` it to `dir` (its
 * `events/` holds what the repair carried over). Returns true when it did.
 * Otherwise changes nothing and returns false.
 */
export function adoptRepairingWorktree(
  hostDir: string,
  dir: string,
  options?: HostInitOptions,
): boolean {
  const git = hostGit(hostDir, options);
  const repairing = join(agentboardGitDir(git, hostDir), REPAIRING_WORKTREE);
  if (existsSync(dir) || !existsSync(repairing) || registeredAt(git, repairing) === null) {
    return false;
  }
  git.run('worktree', 'move', repairing, dir);
  return true;
}

/**
 * Runs `fn` while holding `<git common dir>/agentboard/init.lock` of the
 * repository at `hostDir`, so that two `init` processes on one host make
 * or repair the board one after the other (design.md decision 2: the loser
 * of the create-only `update-ref` uses the winner's ref; without the lock,
 * two `git worktree add` of one path can both succeed and register two
 * worktrees). The file holds the holder's pid; a lock whose holder is no
 * longer running (an `init` that was killed) or that is older than a
 * minute is broken. Waits in 50 ms steps. The lock is removed when `fn`
 * returns or throws.
 */
export function withInitLock<T>(hostDir: string, fn: () => T, options?: HostInitOptions): T {
  const lock = join(agentboardGitDir(hostGit(hostDir, options), hostDir), INIT_LOCK_FILE);
  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx' });
      break;
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'EEXIST') {
        throw error;
      }
    }
    if (lockIsStale(lock)) {
      rmSync(lock, { force: true });
    } else {
      sleep(50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

/** True when the holder named in `lock` is not running, or the file is older than `STALE_LOCK_MS`. */
function lockIsStale(lock: string): boolean {
  try {
    const stats = statSync(lock);
    if (Date.now() - stats.mtimeMs > STALE_LOCK_MS) {
      return true;
    }
    const pid = Number(readFileSync(lock, 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0) {
      return false;
    }
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // ESRCH: no such process. Anything else (EPERM, a vanished file): keep waiting.
    return (error as { code?: unknown }).code === 'ESRCH';
  }
}

/** Blocks the current thread for `ms` milliseconds. */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A runner for the host repository at `hostDir` with its hooks disabled. */
function hostGit(hostDir: string, options?: HostInitOptions): GitRunner {
  return gitRunner(hostDir, { env: options?.env, disableHooks: true });
}

/** The full id of the commit `rev` names in the repository `git` runs in, or null. */
function commitOf(git: GitRunner, rev: string): string | null {
  const out = git.attempt('rev-parse', '--quiet', '--verify', `${rev}^{commit}`);
  return isGitFailure(out) ? null : out.trim();
}

/** `<git common dir>/agentboard` of the repository at `hostDir`, created when missing. */
function agentboardGitDir(git: GitRunner, hostDir: string): string {
  const common = resolve(hostDir, git.run('rev-parse', '--git-common-dir').trim());
  const dir = join(common, AGENTBOARD_GIT_SUBDIR);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** One entry of `git worktree list --porcelain`. */
interface WorktreeEntry {
  readonly path: string;
  readonly locked: boolean;
}

/**
 * Every worktree of the repository `git` runs in.
 *
 * @throws BoardError exit 1, reason `git-missing`, when git cannot be run.
 */
function listWorktrees(git: GitRunner): WorktreeEntry[] {
  const out = git.attempt('worktree', 'list', '--porcelain');
  if (isGitFailure(out)) {
    throw out.status === null
      ? new BoardError(1, 'git-missing', 'agentboard init needs git, but git could not be run')
      : new Error(`git worktree list failed: ${firstErrorLine(out)}`);
  }
  return out
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block !== '')
    .map((block) => {
      const lines = block.split('\n');
      const path =
        lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length) ?? '';
      return {
        path,
        locked: lines.some((line) => line === 'locked' || line.startsWith('locked ')),
      };
    });
}

/**
 * The worktree entry registered at exactly `dir`, compared as realpaths
 * (of the parent when the directory itself is missing), or null.
 */
function registeredAt(git: GitRunner, dir: string): WorktreeEntry | null {
  const wanted = comparablePath(dir);
  return listWorktrees(git).find((entry) => comparablePath(entry.path) === wanted) ?? null;
}

/** `path` as a realpath; when it is missing, its parent's realpath joined with its name. */
function comparablePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return join(realpathOrSelf(dirname(path)), basename(path));
  }
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Locks the worktree at `dir` with `WORKTREE_LOCK_REASON` unless it is already locked (any reason). */
function lockWorktree(git: GitRunner, dir: string): void {
  if (registeredAt(git, dir)?.locked !== false) {
    return;
  }
  try {
    git.run('worktree', 'lock', '--reason', WORKTREE_LOCK_REASON, dir);
  } catch (error) {
    // Another process locked it in between: not an error.
    if (registeredAt(git, dir)?.locked !== true) {
      throw error;
    }
  }
}

/** `git sparse-checkout disable` in the worktree at `dir` when sparse checkout is enabled for it. */
function disableSparseCheckout(dir: string, options?: HostInitOptions): void {
  const worktree = gitRunner(dir, { env: options?.env, disableHooks: true });
  const sparse = worktree.attempt('config', '--get', 'core.sparseCheckout');
  if (!isGitFailure(sparse) && sparse.trim() === 'true') {
    worktree.run('sparse-checkout', 'disable');
  }
}

/** True when `<dir>/.git` is a file whose `gitdir:` target does not exist. */
function gitfileTargetMissing(dir: string): boolean {
  try {
    const target = /^gitdir:\s*(.*)$/m.exec(readFileSync(join(dir, '.git'), 'utf8'))?.[1]?.trim();
    return target !== undefined && !existsSync(resolve(dir, target));
  } catch {
    return false;
  }
}

/**
 * Removes the `repairing` worktree or directory a previous, interrupted
 * repair left at `path`: unregistered (unlocked and removed by force when
 * it is registered) and deleted from disk.
 */
function removeLeftoverWorktree(git: GitRunner, path: string): void {
  if (registeredAt(git, path) !== null) {
    git.attempt('worktree', 'unlock', path);
    git.attempt('worktree', 'remove', '--force', '--force', path);
  }
  rmSync(path, { recursive: true, force: true });
}

/**
 * Copies every event file of `from` that `to` lacks and whose content
 * hashes to its name; returns the copied and the skipped names, ascending.
 * Dot-named entries (`.gitkeep`, temporaries) and subdirectories are
 * ignored; a missing `from` copies nothing.
 */
function carryOverEvents(from: string, to: string): { copied: string[]; skipped: string[] } {
  const copied: string[] = [];
  const skipped: string[] = [];
  if (!existsSync(from)) {
    return { copied, skipped };
  }
  for (const entry of readdirSync(from, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    if (!entry.isFile() || entry.name.startsWith('.')) {
      continue;
    }
    const content = readFileSync(join(from, entry.name));
    if (!EVENT_FILE.test(entry.name) || sha256Hex(content) !== entry.name.slice(0, 64)) {
      skipped.push(entry.name);
      continue;
    }
    if (!existsSync(join(to, entry.name))) {
      copyFileSync(join(from, entry.name), join(to, entry.name));
      copied.push(entry.name);
    }
  }
  return { copied, skipped };
}

/** `<scratch>/<staleBoardName(now)>`, with `-2`, `-3`, ... appended while the name is taken. */
function freshStaleName(scratch: string, now: Date): string {
  const base = join(scratch, staleBoardName(now));
  let candidate = base;
  for (let n = 2; existsSync(candidate); n += 1) {
    candidate = `${base}-${String(n)}`;
  }
  return candidate;
}
