/**
 * Fixtures for the board sharing tests (add-board-sharing): a host-model
 * board built with git plumbing only (so tests of `sync`, `remote` and
 * model detection do not depend on `init`), events committed into it, a
 * standalone board built without `init` (so tests that need a standalone
 * board inside a git host do not depend on `init`'s model choice),
 * standalone boards whose `.git` is a file (a separate git directory; a
 * submodule of the host), a `git` shim on the PATH that reports another
 * version and delegates to the real one, a `git` shim that kills the
 * process that ran it at a chosen step (the crash tests of `init` and
 * `sync`), a `git` shim that records every command line it is given, a
 * `GIT_SSH_COMMAND` shim that records every call git makes to it, a second
 * clone joining a published board with plumbing only, failing hooks in a
 * host repository, and read-only snapshots of refs, worktrees and
 * directories to prove that a command changed nothing. Every repository
 * is on local disk; nothing touches the network.
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';

import { sha256Hex } from '../../events/canonical.js';
import { putEvent } from '../../store/__tests__/helpers.js';
import { BOARD_GITIGNORE_LINES, initBoard } from '../init.js';
import { git, gitRepo, makeBoardDir, tempDir } from './helpers.js';
import { gitWith, syncEnv, type Env } from './sync-helpers.js';

/** The ref that holds a host-model board's history. */
export const BOARD_REF = 'refs/agentboard/board';

/**
 * The id of the deterministic empty-board commit (board-events "Board ref
 * in the host repository") in a SHA-1 repository, as computed by
 * `EMPTY_BOARD_SCRIPT` (which `host-init.test.ts` also runs), by
 * `emptyBoardCommit` below, and by `init`.
 */
export const EMPTY_BOARD_COMMIT_ID = '7d5236e13b813df769a361c585f25a01259b020a';

/**
 * A throwaway POSIX shell script that computes the empty-board commit with
 * plumbing only (`git hash-object`, `git mktree`, `git commit-tree`), run in
 * any git repository; it prints the commit id. Independent of every
 * agentboard module, so it checks `init` and `emptyBoardCommit` alike.
 */
export const EMPTY_BOARD_SCRIPT = [
  '#!/bin/sh',
  'set -e',
  "ignore=$(printf 'cache.sqlite\\ncache.sqlite-wal\\ncache.sqlite-shm\\n' | git hash-object -w --stdin)",
  "keep=$(printf '' | git hash-object -w --stdin)",
  'events=$(printf \'100644 blob %s\\t.gitkeep\\n\' "$keep" | git mktree)',
  'root=$(printf \'100644 blob %s\\t.gitignore\\n040000 tree %s\\tevents\\n\' "$ignore" "$events" | git mktree)',
  'GIT_AUTHOR_NAME=agentboard GIT_AUTHOR_EMAIL=agentboard@localhost \\',
  'GIT_COMMITTER_NAME=agentboard GIT_COMMITTER_EMAIL=agentboard@localhost \\',
  "GIT_AUTHOR_DATE='@0 +0000' GIT_COMMITTER_DATE='@0 +0000' \\",
  'git commit-tree "$root" -m \'agentboard: empty board\'',
  '',
].join('\n');

/** The fixed identity and time of the deterministic empty-board commit. */
const EMPTY_COMMIT_ENV: Env = {
  GIT_AUTHOR_NAME: 'agentboard',
  GIT_AUTHOR_EMAIL: 'agentboard@localhost',
  GIT_COMMITTER_NAME: 'agentboard',
  GIT_COMMITTER_EMAIL: 'agentboard@localhost',
  GIT_AUTHOR_DATE: '@0 +0000',
  GIT_COMMITTER_DATE: '@0 +0000',
};

/**
 * A host repository at `<temp>/host` (one commit on `main`) whose committed
 * `.gitignore` lists `.board/`, so a board worktree never dirties it.
 */
export function hostRepo(root = join(tempDir(), 'host')): string {
  gitRepo(root);
  writeFileSync(join(root, '.gitignore'), '.board/\n');
  git(root, 'add', '.gitignore');
  git(root, 'commit', '-q', '-m', 'ignore the board');
  return root;
}

/**
 * The deterministic empty-board commit (board-events "Board ref in the
 * host repository") written into the repository at `repo` with plumbing
 * only: blobs for `.gitignore` (`BOARD_GITIGNORE_LINES`) and
 * `events/.gitkeep`, two `mktree`s and one `commit-tree` as
 * `agentboard <agentboard@localhost>` at time 0 with the message
 * `agentboard: empty board`. Returns the commit id.
 */
export function emptyBoardCommit(repo: string, env: Env = syncEnv()): string {
  const run = (...args: string[]): string =>
    gitWith(repo, { ...env, ...EMPTY_COMMIT_ENV }, ...args).trim();
  const ignore = BOARD_GITIGNORE_LINES.map((line) => `${line}\n`).join('');
  const ignoreBlob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: repo,
    env: { ...env },
    input: ignore,
    encoding: 'utf8',
  }).trim();
  const keepBlob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: repo,
    env: { ...env },
    input: '',
    encoding: 'utf8',
  }).trim();
  const eventsTree = execFileSync('git', ['mktree'], {
    cwd: repo,
    env: { ...env },
    input: `100644 blob ${keepBlob}\t.gitkeep\n`,
    encoding: 'utf8',
  }).trim();
  const rootTree = execFileSync('git', ['mktree'], {
    cwd: repo,
    env: { ...env },
    input: `100644 blob ${ignoreBlob}\t.gitignore\n040000 tree ${eventsTree}\tevents\n`,
    encoding: 'utf8',
  }).trim();
  return run('commit-tree', rootTree, '-m', 'agentboard: empty board');
}

/**
 * A host-model board (add-board-sharing design.md, decisions 1 and 2) at
 * `<root>/.board`, built with plumbing: the empty-board commit under
 * `refs/agentboard/board`, a linked worktree on a detached HEAD at that
 * ref, locked with the reason `agentboard board`. `root` defaults to a
 * fresh `hostRepo()`. Returns the host root, the board directory and the
 * commit of the ref.
 */
export function hostBoard(
  env: Env = syncEnv(),
  root: string = hostRepo(),
): { root: string; dir: string; commit: string } {
  const commit = emptyBoardCommit(root, env);
  git(root, 'update-ref', BOARD_REF, commit, '');
  const dir = join(root, '.board');
  git(root, 'worktree', 'add', '-q', '--detach', dir, BOARD_REF);
  git(root, 'worktree', 'lock', '--reason', 'agentboard board', dir);
  return { root, dir, commit };
}

/**
 * A standalone board whose `.git` is a file (board-events "Board model
 * detection": standalone whether `.git` is a directory or a file): the
 * working tree at `<root>/.board`, made with
 * `git init --separate-git-dir <temp>/board-git`, holding `.gitignore` and
 * `events/.gitkeep` as `init` writes them, nothing committed, on the unborn
 * branch `main`. `root` may be a git repository. Returns the board
 * directory and the separate git directory the `.git` file names.
 */
export function separateGitDirBoard(root = tempDir()): { dir: string; gitDir: string } {
  const dir = makeBoardDir(root);
  const gitDir = join(tempDir(), 'board-git');
  git(root, 'init', '-q', '--separate-git-dir', gitDir, dir);
  writeFileSync(join(dir, '.gitignore'), BOARD_GITIGNORE_LINES.map((line) => `${line}\n`).join(''));
  writeFileSync(join(dir, 'events', '.gitkeep'), '');
  return { dir, gitDir };
}

/**
 * A submodule-style board: a standalone board repository (one commit with
 * `.gitignore` and `events/.gitkeep`) added to a fresh `hostRepo()` as the
 * submodule `.board` with `git submodule add --force`, so `.board/.git` is
 * a file naming `<host>/.git/modules/.board`, the host's index holds
 * `.board` as a gitlink and `.gitmodules`, and the board's `origin` is the
 * source repository with `main` tracking it. Returns the host root, the
 * board directory, the git directory the `.git` file names and the source
 * repository.
 */
export function submoduleBoard(env: Env = syncEnv()): {
  host: string;
  dir: string;
  gitDir: string;
  source: string;
} {
  const source = initBoard({ cwd: tempDir(), env }).dir;
  git(source, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(source, 'add', '-A');
  git(source, 'commit', '-q', '-m', 'board');
  const host = hostRepo();
  git(
    host,
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '--force',
    '-q',
    source,
    '.board',
  );
  return {
    host,
    dir: join(host, '.board'),
    gitDir: join(host, '.git', 'modules', '.board'),
    source,
  };
}

/**
 * Writes `event` as an event file of the host-model board at `dir`,
 * commits it there (fixed identity, hooks skipped) and moves
 * `refs/agentboard/board` to the new HEAD, as a completed `sync` leaves
 * them. Returns the event hash.
 */
export function commitHostEvent(dir: string, event: unknown, env: Env = syncEnv()): string {
  const hash = putEvent(join(dir, 'events'), event);
  const run = (...args: string[]): string =>
    gitWith(dir, { ...env, ...EMPTY_COMMIT_ENV }, ...args).trim();
  run('add', '--', 'events');
  run('commit', '-q', '--no-verify', '-m', 'agentboard sync: 1 event file');
  run('update-ref', BOARD_REF, run('rev-parse', 'HEAD'));
  return hash;
}

/** The absolute path of the real `git` on the current PATH. */
export function realGit(): string {
  return execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
}

/**
 * A directory holding a `git` shim that answers `git --version` with
 * `git version <version>` and delegates every other invocation to the real
 * git (tasks.md: tests that simulate an older git use a shim on PATH).
 * Prepend it to `PATH`.
 */
export function gitShim(version: string): string {
  const dir = join(tempDir(), 'shim-bin');
  mkdirSync(dir);
  const script = join(dir, 'git');
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then',
      `  echo "git version ${version}"`,
      '  exit 0',
      'fi',
      `exec '${realGit()}' "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(script, 0o755);
  return dir;
}

/** `env` with `gitShim(version)` first on its PATH. */
export function withGitShim(env: Env, version: string): Env {
  return { ...env, PATH: `${gitShim(version)}:${env.PATH ?? process.env.PATH ?? ''}` };
}

/**
 * A `GIT_SSH_COMMAND` shim that appends one line with its arguments to
 * `log` on every call and exits 255 without connecting anywhere. A remote
 * whose URL is `ssh://` (or `host:path`) makes git run it for any network
 * operation, so an empty (or missing) log proves that no such operation
 * was attempted.
 */
export function sshShim(): { command: string; log: string; calls: () => string[] } {
  const dir = tempDir();
  const log = join(dir, 'ssh-calls.log');
  const script = join(dir, 'ssh-shim');
  writeFileSync(script, ['#!/bin/sh', `echo "$@" >> '${log}'`, 'exit 255', ''].join('\n'));
  chmodSync(script, 0o755);
  return {
    command: script,
    log,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []),
  };
}

/** An SSH URL that resolves to nothing; with `sshShim`, git never gets past the shim. */
export const SSH_URL = 'git@example.invalid:me/project.git';

/** Every ref of the repository at `repo` with its target, as one text. */
export function refs(repo: string): string {
  return git(repo, 'for-each-ref', '--format=%(refname) %(objectname)');
}

/** `git worktree list --porcelain` of the repository at `repo`. */
export function worktrees(repo: string): string {
  return git(repo, 'worktree', 'list', '--porcelain');
}

/**
 * Whether `name` is a file git holds only while it works: a `<name>.lock`
 * (every ref, index, config and packed-refs write, and
 * `objects/maintenance.lock`) or `gc.pid`. A `git commit` or `git fetch`
 * starts `git maintenance run --auto --detach`, which takes
 * `objects/maintenance.lock` before it detaches and releases it after the
 * command that started it has returned, so on a loaded machine the lock
 * can still be there when the command's caller looks.
 */
export function isGitTransient(name: string): boolean {
  return name.endsWith('.lock') || name === 'gc.pid';
}

/** How long `snapshotDir` waits by default for git's transient files to go. */
export const SNAPSHOT_SETTLE_MS = 10_000;

/** Blocks the thread for `ms` milliseconds. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Thrown inside a walk when a file vanished between its listing and its read. */
class Vanished extends Error {}

/**
 * One walk of `dir` for `snapshotDir`, or null when a git transient file
 * is present or a file vanished mid-walk; with `last`, the walk as it
 * stands (a vanished file then throws).
 */
function walkOnce(dir: string, last: boolean): string[] | null {
  const out: string[] = [];
  let transient = false;
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      if (name.startsWith('cache.sqlite')) {
        continue;
      }
      if (isGitTransient(name)) {
        transient = true;
      }
      const path = join(current, name);
      try {
        if (statSync(path).isDirectory()) {
          walk(path);
        } else {
          out.push(`${relative(dir, path)} ${sha256Hex(readFileSync(path))}`);
        }
      } catch (error) {
        if (!last && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Vanished(path);
        }
        throw error;
      }
    }
  };
  try {
    walk(dir);
  } catch (error) {
    if (error instanceof Vanished) {
      return null;
    }
    throw error;
  }
  return transient && !last ? null : out.sort();
}

/**
 * Every file under `dir` (recursively, symlinks followed, the SQLite cache
 * and its companions left out because opening a board creates them) as
 * `<relative path> <sha256>` lines, sorted. The snapshot is taken once git
 * has settled: while a git transient file (`isGitTransient`) is present,
 * or a file vanishes during the walk, it walks again, for up to
 * `settleMs`, then takes the walk as it stands. Nothing is left out for it: a lock file still there at the
 * deadline is in the snapshot, so a lock a command leaks still fails the
 * comparison, as does any change to an event file, ref or worktree
 * registration.
 */
export function snapshotDir(dir: string, settleMs: number = SNAPSHOT_SETTLE_MS): string[] {
  const deadline = Date.now() + settleMs;
  for (;;) {
    const out = walkOnce(dir, Date.now() >= deadline);
    if (out !== null) {
      return out;
    }
    sleepSync(20);
  }
}

/** `realpathSync(path)`. */
export function real(path: string): string {
  return realpathSync(path);
}

/**
 * A standalone board at `<root>/.board` built without `init`, as `init`
 * made every board before the host model existed: `.gitignore` holding
 * `BOARD_GITIGNORE_LINES`, an empty `events/.gitkeep`, `git init` in it
 * (nothing committed, on the unborn branch `main`), and `.board/` appended
 * to `<root>/.gitignore` when no line of it ignores the board. `root` may be
 * a git repository (the board is then a standalone board inside a git host)
 * or a plain directory. Returns the board directory.
 */
export function standaloneBoard(root: string = tempDir()): string {
  const dir = makeBoardDir(root);
  git(dir, 'init', '-q');
  writeFileSync(join(dir, '.gitignore'), BOARD_GITIGNORE_LINES.map((line) => `${line}\n`).join(''));
  writeFileSync(join(dir, 'events', '.gitkeep'), '');
  const ignore = join(root, '.gitignore');
  const content = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
  const lines = content.split('\n').map((line) => line.trim());
  if (!['.board/', '.board', '/.board/', '/.board'].some((entry) => lines.includes(entry))) {
    const separator = content === '' || content.endsWith('\n') ? '' : '\n';
    writeFileSync(ignore, `${content}${separator}.board/\n`);
  }
  return dir;
}

/** `git clone` of `remote` into `<temp>/<name>`; returns the clone's root. */
export function cloneHost(remote: string, name = 'clone'): string {
  const root = join(tempDir(), name);
  git(tempDir(), 'clone', '-q', remote, root);
  return root;
}

/** Pushes `refs/agentboard/board` of the repository at `root` to `remote` (a name or URL), as a completed `sync` does. */
export function pushBoardRef(root: string, remote = 'origin'): void {
  git(root, 'push', '-q', remote, `${BOARD_REF}:${BOARD_REF}`);
}

/** The id of the root commit of `ref` in `repo`. */
export function rootCommit(repo: string, ref = BOARD_REF): string {
  return git(repo, 'rev-list', '--max-parents=0', ref).trim();
}

/** The full id `ref` resolves to in `repo`, or null when it does not exist. */
export function refCommit(repo: string, ref = BOARD_REF): string | null {
  try {
    return git(repo, 'rev-parse', '--quiet', '--verify', `${ref}^{commit}`).trim();
  } catch {
    return null;
  }
}

/** One entry of `git worktree list --porcelain`. */
export interface WorktreeEntry {
  readonly path: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly detached: boolean;
  /** The lock reason, an empty string for a lock without one, or null when unlocked. */
  readonly locked: string | null;
  readonly prunable: boolean;
}

/** Every entry of `git worktree list --porcelain` of the repository at `repo`. */
export function worktreeEntries(repo: string): WorktreeEntry[] {
  return worktrees(repo)
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block !== '')
    .map((block) => {
      const lines = block.split('\n');
      const value = (key: string): string | null => {
        const line = lines.find((l) => l === key || l.startsWith(`${key} `));
        return line === undefined ? null : line.slice(key.length).trim();
      };
      return {
        path: value('worktree') ?? '',
        head: value('HEAD'),
        branch: value('branch'),
        detached: lines.includes('detached'),
        locked: value('locked'),
        prunable: lines.some((l) => l === 'prunable' || l.startsWith('prunable ')),
      };
    });
}

/**
 * The worktree entry whose path is `dir` (compared as realpaths when the
 * directory exists, else textually), or null when it is not registered.
 */
export function worktreeEntry(repo: string, dir: string): WorktreeEntry | null {
  const wanted = existsSync(dir) ? realpathSync(dir) : dir;
  return (
    worktreeEntries(repo).find((entry) => {
      const path = existsSync(entry.path) ? realpathSync(entry.path) : entry.path;
      return path === wanted;
    }) ?? null
  );
}

/** Where a `killingGitShim` strikes: before or after the matching git command runs. */
export type KillWhen = 'before' | 'after';

/**
 * A directory holding a `git` shim that delegates every invocation to the
 * real git, except that the `nth` invocation (the first by default) whose
 * arguments contain the words of `trigger` in order (for example
 * `['update-ref', 'refs/agentboard/board']` or `['worktree', 'add']`) kills
 * the process that ran it with SIGKILL, `before` running the real git (so
 * the command never happens) or `after` it has completed (so its effect is
 * on disk and nothing later happens). Earlier matching invocations run
 * unchanged (a counter file records them). Prepend it to `PATH`;
 * `withKillingGitShim` does. The shim is a `#!/bin/sh` script, so `$PPID`
 * is the process that spawned git: `init` or `sync` run through
 * `spawnCli`. The killed process's git child goes on for a few seconds in
 * the background, which the caller never waits for.
 */
export function killingGitShim(trigger: readonly string[], when: KillWhen, nth = 1): string {
  const dir = join(tempDir(), 'killing-shim-bin');
  mkdirSync(dir);
  const counter = join(dir, 'matches');
  // Only the fixed words are quoted: the `*` on either side must stay a glob.
  const pattern = `*${JSON.stringify(trigger.join(' '))}*`;
  const kill = 'kill -KILL "$PPID"; sleep 5; exit 1';
  writeFileSync(
    join(dir, 'git'),
    [
      '#!/bin/sh',
      'case " $* " in',
      `  ${pattern})`,
      `    n=$(cat '${counter}' 2>/dev/null || echo 0)`,
      '    n=$((n + 1))',
      `    echo "$n" > '${counter}'`,
      `    if [ "$n" -eq ${String(nth)} ]; then`,
      when === 'before' ? `      ${kill}` : `      '${realGit()}' "$@"; ${kill}`,
      '    fi',
      '    ;;',
      'esac',
      `exec '${realGit()}' "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(join(dir, 'git'), 0o755);
  return dir;
}

/** `env` with `killingGitShim(trigger, when, nth)` first on its PATH. */
export function withKillingGitShim(
  env: Env,
  trigger: readonly string[],
  when: KillWhen,
  nth = 1,
): Env {
  return {
    ...env,
    PATH: `${killingGitShim(trigger, when, nth)}:${env.PATH ?? process.env.PATH ?? ''}`,
  };
}

/**
 * A directory holding a `git` shim that delegates every invocation to the
 * real git, except that before each of the first `times` invocations (one
 * by default) whose arguments contain the words of `trigger` in order it
 * runs the shell text `before` (with `GIT` set to the real git's path and
 * the same working directory and environment), then runs the real
 * command. Later matching invocations run unchanged (a counter file
 * records them). Prepend it to `PATH`; `withGitShimBefore` does. Used to
 * make another process win a race, for example creating
 * `refs/agentboard/board` just before `init`'s create-only `update-ref`,
 * moving the ref just before `sync`'s compare-and-swap, or pushing to the
 * remote just before `sync`'s push.
 */
export function gitShimBefore(trigger: readonly string[], before: string, times = 1): string {
  const dir = join(tempDir(), 'before-shim-bin');
  mkdirSync(dir);
  const counter = join(dir, 'matches');
  writeFileSync(
    join(dir, 'git'),
    [
      '#!/bin/sh',
      `GIT='${realGit()}'`,
      'case " $* " in',
      `  *${JSON.stringify(trigger.join(' '))}*)`,
      `    n=$(cat '${counter}' 2>/dev/null || echo 0)`,
      '    n=$((n + 1))',
      `    echo "$n" > '${counter}'`,
      `    if [ "$n" -le ${String(times)} ]; then`,
      `      ${before}`,
      '    fi',
      '    ;;',
      'esac',
      'exec "$GIT" "$@"',
      '',
    ].join('\n'),
  );
  chmodSync(join(dir, 'git'), 0o755);
  return dir;
}

/** `env` with `gitShimBefore(trigger, before, times)` first on its PATH. */
export function withGitShimBefore(
  env: Env,
  trigger: readonly string[],
  before: string,
  times = 1,
): Env {
  return {
    ...env,
    PATH: `${gitShimBefore(trigger, before, times)}:${env.PATH ?? process.env.PATH ?? ''}`,
  };
}

/**
 * A directory holding a `git` shim that appends one line per invocation,
 * its arguments as given (`$*`), to `log`, then delegates to the real git.
 * `calls()` reads the lines back. Prepend it to `PATH`;
 * `withRecordingGitShim` does. Proves which commands a `sync` ran (the
 * fetch refspec, `--no-tags`, the compare-and-swap old values, a push
 * without force, `core.hooksPath` on every command).
 */
export function recordingGitShim(): { dir: string; log: string; calls: () => string[] } {
  const dir = join(tempDir(), 'recording-shim-bin');
  mkdirSync(dir);
  const log = join(dir, 'git-calls.log');
  writeFileSync(
    join(dir, 'git'),
    ['#!/bin/sh', `echo "$*" >> '${log}'`, `exec '${realGit()}' "$@"`, ''].join('\n'),
  );
  chmodSync(join(dir, 'git'), 0o755);
  return {
    dir,
    log,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []),
  };
}

/** `env` with a `recordingGitShim` first on its PATH, and the shim's `calls`. */
export function withRecordingGitShim(env: Env): { env: Env; calls: () => string[] } {
  const shim = recordingGitShim();
  return {
    env: { ...env, PATH: `${shim.dir}:${env.PATH ?? process.env.PATH ?? ''}` },
    calls: shim.calls,
  };
}

/**
 * A second clone of `remote` at `<temp>/<name>` joined to the board
 * published there, with plumbing only (so tests of `sync` do not depend
 * on `init`): `git clone`, `git fetch --no-tags origin
 * refs/agentboard/board:refs/agentboard/board`, a locked worktree at
 * `<clone>/.board` on a detached HEAD at the ref. The remote must hold
 * `refs/agentboard/board`. Returns the clone's root and board directory.
 */
export function joinHostBoard(remote: string, name = 'clone'): { root: string; dir: string } {
  const root = cloneHost(remote, name);
  git(root, 'fetch', '-q', '--no-tags', 'origin', `${BOARD_REF}:${BOARD_REF}`);
  const dir = join(root, '.board');
  git(root, 'worktree', 'add', '-q', '--detach', dir, BOARD_REF);
  git(root, 'worktree', 'lock', '--reason', 'agentboard board', dir);
  return { root, dir };
}

/**
 * A hook named `name` (`pre-commit`, `pre-push`, ...) in `<gitDir>/hooks`
 * that records its run in a marker file and exits with `status` (1 by
 * default, so a command that runs it fails). Returns the marker's path:
 * it exists once the hook has run.
 */
export function installHook(gitDir: string, name: string, status = 1): string {
  const marker = join(tempDir(), `${name}-ran`);
  const hooks = join(gitDir, 'hooks');
  mkdirSync(hooks, { recursive: true });
  const hook = join(hooks, name);
  writeFileSync(
    hook,
    [
      '#!/bin/sh',
      'cat >/dev/null 2>&1',
      `echo ran > '${marker}'`,
      `exit ${String(status)}`,
      '',
    ].join('\n'),
  );
  chmodSync(hook, 0o755);
  return marker;
}
