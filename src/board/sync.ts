/**
 * `agentboard sync` (board-concurrency: "Sync converges"; board-cache:
 * "Cache is not synced"; add-board-core design.md: "Git sync model"; risk "Host project
 * forgets `.board/` in its gitignore").
 *
 * The board directory is its own git repository (`initBoard` makes it one).
 * `sync` commits new event files, pulls with rebase from the board's
 * remote, pushes, and then folds whatever arrived into the cache. Event
 * files are add-only and named by the hash of their content, so two clones
 * never produce a conflicting change to the same event path; any conflict
 * git does report is handed to a human with exit 3.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { Board } from '../store/board.js';
import { catchUp } from '../store/cache.js';
import { BoardError } from '../store/errors.js';
import { asciiText, type Env } from './text.js';

/**
 * The fixed identity every git command run by `sync` is given (as
 * `-c user.name=<name> -c user.email=<email>`), so that `sync` commits and
 * rebases on a machine with no git identity configured, and so board
 * commits are recognisably machine-made. It is used for the commit `sync`
 * makes (author and committer) and as the committer of commits replayed by
 * `pull --rebase`; the user's own identity, if any, is never consulted.
 */
export const SYNC_IDENTITY = { name: 'agentboard', email: 'agentboard@localhost' } as const;

/**
 * Subject of the commit `sync` makes: `agentboard sync: <n> event file(s)`,
 * where `<n>` is the number of `events/*.json` paths added by the commit
 * (`file` when `n` is 1, `files` otherwise, including 0 for a commit that
 * only carries `.gitignore` or `events/.gitkeep`). No body.
 */
export function syncCommitMessage(eventFiles: number): string {
  return `agentboard sync: ${String(eventFiles)} event ${eventFiles === 1 ? 'file' : 'files'}`;
}

/** Options for `syncBoard`. */
export interface SyncOptions {
  /**
   * Environment for the git child processes. Defaults to `process.env`.
   * Whatever is given, `sync` removes the variables that would point git at
   * another repository (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
   * `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`,
   * `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_NAMESPACE`, `GIT_PREFIX`), so
   * running from inside a host git hook still syncs the board repository,
   * and sets `GIT_TERMINAL_PROMPT=0` so a remote needing credentials fails
   * instead of waiting for input.
   */
  env?: Env | undefined;
}

/** Result of `syncBoard`; also the `sync --json` document. */
export interface SyncResult {
  /** Absolute path of the board directory (`board.dir`). */
  dir: string;
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
  /** Current branch name (`main`, for example). */
  branch: string;
  /** True when a pull ran and completed (false on the no-remote path). */
  pulled: boolean;
  /** True when a push ran and completed (false on the no-remote path). */
  pushed: boolean;
  /**
   * True when this sync set the branch's upstream (`push -u`) because none
   * was configured.
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
 * working directory, the environment described in `SyncOptions.env`, and
 * `-c user.name=<SYNC_IDENTITY.name> -c user.email=<SYNC_IDENTITY.email>
 * -c commit.gpgsign=false`; git is run with `execFileSync`, never a shell.
 *
 * Preconditions, checked before anything is staged:
 * 1. `git` can be run, else `BoardError(1, 'git-missing')`.
 * 2. The board directory is the top level of its own git repository (a
 *    board whose directory is not a repository, or which is only a
 *    subdirectory of the host repository, is refused rather than synced
 *    through the host): else `BoardError(2, 'board-not-a-repository')`
 *    naming the directory and saying `agentboard init` or `git init` there
 *    makes it one. Nothing is created.
 * 3. No rebase, merge or cherry-pick is in progress in the board
 *    repository (for example one left by an earlier conflicted sync), else
 *    `BoardError(3, 'sync-in-progress')` naming the directory and telling
 *    the human to finish it (`git rebase --continue`) or abort it
 *    (`git rebase --abort`) first. Nothing is staged or committed.
 * 4. HEAD is on a branch (possibly unborn), else
 *    `BoardError(3, 'detached-head')`.
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
 * 3. Remote: the remote of the branch's configured upstream when there is
 *    one; otherwise `origin` when it exists; otherwise the only remote.
 *    With no remote at all this is the no-remote path: stop here and return
 *    with `remote: null`, `pulled` and `pushed` false, `arrived` empty and a
 *    message containing `no remote configured`. Exit 0. Several remotes, no
 *    upstream and no `origin`: `BoardError(1, 'ambiguous-remote')` naming
 *    them (after the commit).
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
 *    upstream (`upstreamSet: true`). Push hooks are not skipped. A rejected
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
  const git = gitRunner(board.dir, options?.env ?? process.env);
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
  checkOwnRepository(git, dir);
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
  const base = { dir, commit, committedEvents, branch, hostTracked, warnings };

  // 3. Remote.
  const upstream = upstreamOf(git, branch);
  const remote = chooseRemote(git, upstream);
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
  const upstreamSet = upstream === null;
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

  lines.push(
    pulled
      ? `pulled ${branch} from ${remote}: ${plural(arrived.length, 'event')} arrived`
      : `${remote} has no branch ${branch} yet; nothing to pull`,
  );
  lines.push(`pushed ${branch} to ${remote}${upstreamSet ? ' and set it as the upstream' : ''}`);
  lines[0] = committedLine(onBranch);
  return {
    ...base,
    commit: onBranch,
    remote,
    pulled,
    pushed: true,
    upstreamSet,
    arrived,
    refolded: report.refolded,
    message: lines.join('\n'),
  };
}

/** Variables that would point git at a repository other than the board's. */
const REPOSITORY_VARIABLES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
] as const;

/** A git command that failed: its exit status and its captured output. */
interface GitFailure {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs git in the board directory (or another directory) with the sync environment. */
interface GitRunner {
  /** Runs git with `args` and returns stdout; throws the child process error on failure. */
  run(...args: string[]): string;
  /** Like `run`, but in `cwd`. */
  runIn(cwd: string, ...args: string[]): string;
  /** Runs git and returns stdout, or the failure instead of throwing. */
  attempt(...args: string[]): string | GitFailure;
}

function gitRunner(dir: string, given: Env): GitRunner {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(given)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  for (const key of REPOSITORY_VARIABLES) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete env[key];
  }
  env.GIT_TERMINAL_PROMPT = '0';
  // The fixed identity wins over any identity in the environment.
  env.GIT_AUTHOR_NAME = SYNC_IDENTITY.name;
  env.GIT_AUTHOR_EMAIL = SYNC_IDENTITY.email;
  env.GIT_COMMITTER_NAME = SYNC_IDENTITY.name;
  env.GIT_COMMITTER_EMAIL = SYNC_IDENTITY.email;
  const prefix = [
    '-c',
    `user.name=${SYNC_IDENTITY.name}`,
    '-c',
    `user.email=${SYNC_IDENTITY.email}`,
    '-c',
    'commit.gpgsign=false',
  ];
  const runIn = (cwd: string, ...args: string[]): string =>
    execFileSync('git', [...prefix, ...args], {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
    });
  return {
    run: (...args) => runIn(dir, ...args),
    runIn,
    attempt(...args) {
      try {
        return runIn(dir, ...args);
      } catch (error) {
        return asFailure(error);
      }
    },
  };
}

function asFailure(error: unknown): GitFailure {
  const e = error as { status?: unknown; stdout?: unknown; stderr?: unknown };
  return {
    status: typeof e.status === 'number' ? e.status : null,
    stdout: typeof e.stdout === 'string' ? e.stdout : '',
    stderr: typeof e.stderr === 'string' ? e.stderr : error instanceof Error ? error.message : '',
  };
}

function failed(result: string | GitFailure): result is GitFailure {
  return typeof result !== 'string';
}

/** NUL-separated output as a list, without empty entries. */
function zList(text: string): string[] {
  return text.split('\0').filter((entry) => entry !== '');
}

function plural(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? '' : 's'}`;
}

/** The first `fatal:` or `error:` line of git's stderr, else its first line. */
function firstErrorLine(failure: GitFailure): string {
  const all = `${failure.stderr}\n${failure.stdout}`
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const line = all.find((l) => /^(fatal|error):/.test(l)) ?? all[0] ?? 'git failed';
  return asciiText(line);
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Precondition 2: the board directory is the top level of its own repository. */
function checkOwnRepository(git: GitRunner, dir: string): void {
  const top = git.attempt('rev-parse', '--show-toplevel');
  if (failed(top) || realpathOrSelf(top.trim()) !== realpathOrSelf(dir)) {
    throw new BoardError(
      2,
      'board-not-a-repository',
      `the board at ${dir} is not a git repository of its own; run agentboard init ` +
        `(or git init in ${dir}) to make it one`,
    );
  }
}

/** Precondition 3: no rebase, merge, cherry-pick or revert is stopped in the board repository. */
function checkNothingInProgress(git: GitRunner, dir: string): void {
  const gitDir = git.run('rev-parse', '--absolute-git-dir').trim();
  const markers = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];
  if (markers.some((name) => existsSync(join(gitDir, name)))) {
    throw new BoardError(
      3,
      'sync-in-progress',
      `a rebase or merge is in progress in the board repository at ${dir}; finish it ` +
        `(resolve, git add, git rebase --continue) or abort it (git rebase --abort) ` +
        `in ${dir}, then run agentboard sync again`,
    );
  }
}

/** Precondition 4: HEAD is on a branch, possibly unborn. */
function currentBranch(git: GitRunner): string {
  const ref = git.attempt('symbolic-ref', '--quiet', '--short', 'HEAD');
  if (failed(ref)) {
    throw new BoardError(
      3,
      'detached-head',
      'the board repository has a detached HEAD; check out a branch (git switch main) and run agentboard sync again',
    );
  }
  return ref.trim();
}

const EVENT_PATH = /^events\/[^/]+\.json$/;

function headExists(git: GitRunner): boolean {
  return !failed(git.attempt('rev-parse', '--quiet', '--verify', 'HEAD^{commit}'));
}

/** Precondition 5: every event file recorded in HEAD is present in `events/`. */
function checkCommittedEventsPresent(git: GitRunner, board: Board): void {
  if (!headExists(git)) {
    return;
  }
  const committed = zList(git.run('ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', 'events'));
  const missing = committed
    .filter((path) => EVENT_PATH.test(path))
    .filter((path) => !existsSync(join(board.dir, path)))
    .sort();
  if (missing.length > 0) {
    const names = missing.map((p) => asciiText(p));
    throw new BoardError(
      5,
      'integrity',
      `${plural(missing.length, 'committed event file')} missing from ${board.dir}: ` +
        `${names.join(', ')}; event files are add-only, so nothing was synced; restore them with ` +
        names.map((p) => `git -C ${board.dir} checkout -- ${p}`).join(' and '),
    );
  }
}

/** Event file names (`<hash>.json`) currently in the events directory. */
function eventFileNames(board: Board): string[] {
  return readdirSync(board.eventsDir).filter(
    (name) => name.endsWith('.json') && !name.startsWith('.'),
  );
}

/** Steps 1 and 2: stage new event files and `.gitignore`, and commit them when any is staged. */
function stageAndCommit(
  git: GitRunner,
  board: Board,
): { commit: string | null; committedEvents: number } {
  const own = ['events', ':(exclude)events/.tmp-*'];
  if (existsSync(join(board.dir, '.gitignore'))) {
    own.push('.gitignore');
  }
  git.run('add', '--ignore-removal', '--', ...own);
  const staged = zList(git.run('diff', '--cached', '--name-only', '-z', '--', ...own));
  if (staged.length === 0) {
    return { commit: null, committedEvents: 0 };
  }
  const added = zList(
    git.run('diff', '--cached', '--name-only', '--diff-filter=A', '-z', '--', ...own),
  );
  const committedEvents = added.filter((path) => EVENT_PATH.test(path)).length;
  // The pathspec limits the commit to sync's own paths: anything else
  // already staged stays staged and uncommitted.
  git.run(
    'commit',
    '--quiet',
    '--no-verify',
    '-m',
    syncCommitMessage(committedEvents),
    '--',
    ...own,
  );
  return { commit: git.run('rev-parse', 'HEAD').trim(), committedEvents };
}

/**
 * Refuses to pull while content other than sync's own is staged in the
 * board repository: `pull --rebase` cannot run over it, and sync never
 * commits it.
 */
function checkNothingForeignStaged(git: GitRunner, dir: string): void {
  const foreign = zList(git.run('diff', '--cached', '--name-only', '-z')).sort();
  if (foreign.length > 0) {
    throw new BoardError(
      3,
      'sync-failed',
      `the board repository at ${dir} has staged changes that agentboard sync does not commit: ` +
        `${foreign.map((p) => asciiText(p)).join(', ')}; commit them or unstage them ` +
        `(git -C ${dir} restore --staged <path>) in the board repository, then run agentboard sync again`,
    );
  }
}

/** The remote of the branch's configured upstream, or null when it has none. */
function upstreamOf(git: GitRunner, branch: string): string | null {
  const remote = git.attempt('config', '--get', `branch.${branch}.remote`);
  const merge = git.attempt('config', '--get', `branch.${branch}.merge`);
  if (failed(remote) || failed(merge)) {
    return null;
  }
  return remote.trim();
}

/** Step 3: the remote to sync with, or null when there is none. */
function chooseRemote(git: GitRunner, upstream: string | null): string | null {
  if (upstream !== null) {
    return upstream;
  }
  const remotes = git
    .run('remote')
    .split('\n')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  if (remotes.includes('origin')) {
    return 'origin';
  }
  if (remotes.length <= 1) {
    return remotes[0] ?? null;
  }
  throw new BoardError(
    1,
    'ambiguous-remote',
    `the board repository has several remotes (${remotes.map((r) => asciiText(r)).join(', ')}), ` +
      'no upstream and no origin; set an upstream (git push -u <remote> <branch>) and run agentboard sync again',
  );
}

function syncFailed(what: string, failure: GitFailure): BoardError {
  return new BoardError(3, 'sync-failed', `${what} failed: ${firstErrorLine(failure)}`);
}

/** Whether `branch` exists on `remote` (contacts the remote). */
function remoteHasBranch(git: GitRunner, remote: string, branch: string): boolean {
  const out = git.attempt('ls-remote', '--heads', remote, `refs/heads/${branch}`);
  if (failed(out)) {
    throw syncFailed(`reaching ${asciiText(remote)}`, out);
  }
  return out.trim() !== '';
}

/** Step 4: pull with rebase, mapping a conflict and any other failure. */
function pull(git: GitRunner, dir: string, remote: string, branch: string): void {
  const out = git.attempt('pull', '--quiet', '--rebase', '--no-autostash', remote, branch);
  if (!failed(out)) {
    return;
  }
  const conflicted = zList(git.run('diff', '--name-only', '--diff-filter=U', '-z')).sort();
  if (conflicted.length > 0) {
    throw new BoardError(
      3,
      'sync-conflict',
      `pulling from ${asciiText(remote)} stopped on a conflict in the board repository at ${dir}: ` +
        `${conflicted.map((p) => asciiText(p)).join(', ')}; resolve them, git add them and ` +
        'git rebase --continue (or git rebase --abort), then run agentboard sync again',
    );
  }
  throw syncFailed(`pulling from ${asciiText(remote)}`, out);
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
  if (!failed(out)) {
    return true;
  }
  const rejected = out.stdout.split('\n').some((line) => line.startsWith('!'));
  if (rejected && !last) {
    return false;
  }
  throw syncFailed(`pushing to ${asciiText(remote)}`, out);
}

/**
 * Paths under the board directory tracked by the host repository (run in
 * the parent of the board directory), or none when there is no host
 * repository or git fails there.
 */
function hostTrackedPaths(git: GitRunner, dir: string): string[] {
  const real = realpathOrSelf(dir);
  const parent = dirname(real);
  try {
    return zList(git.runIn(parent, 'ls-files', '-z', '--full-name', '--', real)).sort();
  } catch {
    return [];
  }
}

function hostWarning(dir: string, tracked: readonly string[]): string {
  const first = asciiText(tracked[0] ?? '');
  const name = asciiText(basename(dir));
  const others = tracked.length > 1 ? ` and ${String(tracked.length - 1)} more` : '';
  return (
    `warning: the host repository tracks ${plural(tracked.length, 'path')} under the board ` +
    `(${first}${others}); untrack them with git rm -r --cached ${name} ` +
    `(run in ${asciiText(dirname(dir))}) and keep ${name}/ in the host .gitignore`
  );
}
