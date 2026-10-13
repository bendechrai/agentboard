/**
 * `agentboard init --remote <url>` (board-cli: "Board in a separate
 * repository"; add-board-sharing design.md: decision 8; ADR 0012): a
 * standalone board (a git repository of its own) shared through the
 * repository at `<url>`, for a board that must stay out of its host
 * repository (a public project, a git host that refuses custom refs).
 *
 * `initBoardWithRemote` is the entry point; `initBoard`
 * (`src/board/init.ts`) is unchanged and the registry dispatches to one or
 * the other on the `--remote` flag. The board it leaves behind is an
 * ordinary standalone board: `sync`, `remote` and model detection treat it
 * exactly as one made by hand with `git clone <url> .board`.
 *
 * Every git command runs through `gitRunner` with the sanitised
 * environment and the fixed identity (ADR 0005). The board repository's
 * own hooks run as git normally runs them, as for every standalone board;
 * the host repository's hooks never run, because no command runs in it.
 */

import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { openBoard } from '../store/board.js';
import { BoardError } from '../store/errors.js';
import { boardExists, locateBoard, type LocateOptions } from '../store/locate.js';
import { firstErrorLine, gitRunner, gitVersion, isGitFailure, type GitRunner } from './git.js';
import {
  countEvents,
  hasInTreeGitDir,
  ignoreBoardInHost,
  writeStandaloneRepository,
  type InitResult,
} from './init.js';
import { BOARD_REF, type BoardModelInfo } from './model.js';
import { ambiguousRemoteError, boardRemote } from './remote.js';
import { checkRepository, syncBoard, type SyncResult } from './sync.js';
import { plural } from './sync-steps.js';
import { asciiText, type Env } from './text.js';

/**
 * What `initBoardWithRemote` did:
 * - `cloned`: `.board` did not exist and `<url>` held a board; it was
 *   cloned and its events folded. No `sync` ran.
 * - `created`: `.board` did not exist and `<url>` was an empty
 *   repository (created first when it was a missing local path); a new
 *   standalone board was made, `origin` added and `sync` run.
 * - `attached`: `.board` was a standalone board with no remote; `origin`
 *   was added and `sync` run.
 * - `unchanged`: `.board` was a standalone board whose chosen remote
 *   already had the URL; nothing was done, not even a `sync`.
 */
export type InitRemoteAction = 'cloned' | 'created' | 'attached' | 'unchanged';

/**
 * Result of `initBoardWithRemote`; also the `init --remote <url> --json`
 * document: every field of `InitResult` (board-cli "Initialising and
 * joining a shared board": `dir`, `created`, `model`, `joined`, `remote`,
 * `events`, `hostGitignore`, `warnings`, `repair`, `message`) plus the
 * three below. The exact key set of the JSON document is the ten keys of
 * `InitResult` and `action`, `remoteUrl`, `sync`.
 */
export interface InitRemoteResult extends InitResult {
  /** See `InitRemoteAction`. */
  readonly action: InitRemoteAction;
  /**
   * The URL the board's `origin` has when `initBoardWithRemote` returns
   * (`git -C <dir> remote get-url origin` prints it): `originUrl(url,
   * base)`, so an absolute path for a local path given relative or
   * absolute, the `file://` URL as given, and any other URL as given. On
   * `unchanged`, the URL the remote already had.
   */
  readonly remoteUrl: string;
  /**
   * The result of the `sync` that `created` and `attached` ran (its
   * `remote` is `origin`, `pushed` true), or null for `cloned` and
   * `unchanged`, which run no `sync`.
   */
  readonly sync: SyncResult | null;
}

/**
 * Whether git treats `url` as a local path (add-board-sharing design.md,
 * decision 8): it starts with `file://`, or it has no `:` before its first
 * `/` (git's rule for the `<host>:<path>` form; a URL with a scheme has
 * `://`, so its colon comes first). So `/abs/x.git`, `./x.git`,
 * `../x.git`, `x.git`, `dir/host:x.git` and `file:///x.git` are local;
 * `host:x.git`, `git@host:x.git`, `ssh://host/x.git`, `https://host/x.git`
 * and `git://host/x.git` are not. Leading and trailing whitespace is not
 * trimmed. Pure.
 */
export function isLocalUrl(url: string): boolean {
  if (url.startsWith(FILE_SCHEME)) {
    return true;
  }
  const colon = url.indexOf(':');
  const slash = url.indexOf('/');
  return colon === -1 || (slash !== -1 && slash < colon);
}

/**
 * The absolute file system path of a local `url` (`isLocalUrl`), or null
 * for any other URL: a `file://` URL without its scheme and host part,
 * where the host part is empty or `localhost` (`file:///abs/x.git` and
 * `file://localhost/abs/x.git` are both `/abs/x.git`; a `file://` URL
 * with any other host names no path on this machine and is null, and
 * `initBoardWithRemote` refuses it as usage), an absolute path as it is,
 * and a relative path resolved against `base` with `path.resolve`
 * (`../x.git` from `/a/b` is `/a/x.git`). `base` is the directory
 * `initBoardWithRemote` resolves relative paths against (see there). Pure.
 */
export function localPath(url: string, base: string): string | null {
  if (!isLocalUrl(url)) {
    return null;
  }
  if (url.startsWith(FILE_SCHEME)) {
    return url.slice(FILE_SCHEME.length);
  }
  return isAbsolute(url) ? url : resolve(base, url);
}

/**
 * The URL `initBoardWithRemote` stores as the board's `origin` for `url`:
 * `localPath(url, base)` for a local path that is not a `file://` URL (so
 * the stored URL is absolute and does not depend on the directory a later
 * `sync` runs in, and no `pushurl` or `insteadOf` rewrite is bypassed by
 * resolving it at sync time, the known limit of design.md decision 4); the
 * `file://` URL as given; any other URL as given. Pure.
 */
export function originUrl(url: string, base: string): string {
  const path = localPath(url, base);
  return path === null || url.startsWith(FILE_SCHEME) ? url : path;
}

/**
 * `agentboard init --remote <url>`: sets up a standalone board at the
 * directory discovery names (`locateBoard` with `options`, as `initBoard`),
 * shared through the repository at `url`. Needs no actor. Never creates a
 * host-model board, whatever the host is: inside a git repository with
 * git 2.32 or later it still creates a standalone board, and leaves the
 * host repository's refs, worktree list, index and working tree untouched
 * apart from the host `.gitignore` entry described below.
 *
 * Relative local paths are resolved against `base`: the parent of the
 * board directory when discovery's source is `git` (the host's top level,
 * the same directory from every linked worktree of the host, as the
 * host-model `sync` resolves a relative remote URL), else `options.cwd`
 * (`process.cwd()` by default); the stored `origin` URL is
 * `originUrl(url, base)` (absolute for a path).
 *
 * In this order, writing nothing until a step says so:
 *
 * 1. `url` empty or whitespace only, `url` starting with `-` (git would
 *    read it as an option: `--upload-pack=<command>` run against the
 *    host's own `origin`), or a `file://` URL whose host part is neither
 *    empty nor `localhost`: `BoardError(1, 'usage')` naming `--remote`
 *    and the value, before any git command runs with the value (the host
 *    repository's remote is never contacted; nothing is created). Every
 *    git command that is given the URL (`ls-remote`, `clone`) passes it
 *    after `--`. `git` cannot be run: `BoardError(1, 'git-missing')` as
 *    `initBoard`.
 * 2. `dir` exists and is a board (`boardExists`):
 *    - `detectBoardModel(dir)` is `host`: `BoardError(1, 'board-in-host')`
 *      naming `dir`, saying the board is already shared through the host
 *      repository at `refs/agentboard/board` (that text appears) and that
 *      `agentboard remote` shows it; nothing changes.
 *    - `standalone` with no remote (`boardRemote(info).chosen` null and
 *      `remotes` empty): `git remote add origin <originUrl>` in `dir`,
 *      then `syncBoard` on the board (which commits every uncommitted
 *      event file, pulls when the remote already holds the branch, pushes
 *      and sets the upstream); `action` `attached`, `created` false,
 *      `joined` false, `remote` `origin`, `sync` the result, `events` the
 *      count after the sync, `hostGitignore` null, `warnings` the sync's
 *      warnings, and a message that names `dir`, `origin` and the URL and
 *      ends with the sync's message lines. A `sync` failure (any
 *      `BoardError` it throws: `sync-failed`, `sync-conflict`, ...)
 *      propagates unchanged, with the remote kept and the sync's local
 *      commit kept.
 *    - `standalone` with several remotes and none chosen
 *      (`boardRemote(info).ambiguous`): `ambiguousRemoteError(choice,
 *      'init')`, exit 1 `ambiguous-remote` naming the remotes and
 *      `agentboard init`; nothing changes (no sync, no push, the remotes
 *      as they were).
 *    - `standalone` whose chosen remote (`boardRemote(info).chosen`) has
 *      exactly the URL `originUrl(url, base)`, compared against the URL
 *      `git remote get-url` prints and against the raw configuration
 *      value `remote.<name>.url` (a `url.<base>.insteadOf` rewrite
 *      changes the former, not the latter): `action` `unchanged`, exit
 *      0, nothing done (no `sync`: an uncommitted event file stays
 *      uncommitted, the remote receives nothing), `created` false,
 *      `remote` the chosen remote's name, `sync` null, `hostGitignore`
 *      null, and a message saying the board already has that remote and
 *      that nothing changed.
 *    - `standalone` whose chosen remote has another URL:
 *      `BoardError(1, 'remote-mismatch')` naming the remote, both URLs
 *      (the one it has and `originUrl(url, base)`) and
 *      `git -C <dir> remote set-url <name> <url>` (the text
 *      `remote set-url` appears); nothing changes. When the chosen remote
 *      is one `agentboard.remote` names and the repository does not have
 *      (`chosen.url` null), the message names `agentboard.remote` and the
 *      missing name instead and does not suggest `remote set-url`, which
 *      would fail.
 *    - `broken-host-link` or `not-a-repository`: not this command's job;
 *      `BoardError(2, 'board-link-broken')` for a broken link (it is a
 *      host worktree; `agentboard init` repairs it) and
 *      `BoardError(2, 'board-not-a-repository')` for a non-repository,
 *      each with the message `sync` gives; nothing changes.
 * 3. `dir` does not exist, or is an empty directory (which counts as
 *    absent). When `dir` exists and is not a board and not an empty
 *    directory (a directory holding any entry but no `events/`, a regular
 *    file, a symbolic link that does not resolve to a board directory):
 *    `BoardError(2, 'board-not-a-repository')` naming `dir` and telling
 *    the user to move it aside (the word `move` appears), before any
 *    write: no bare repository, no temporary directory, no host
 *    `.gitignore` entry, and whatever `dir` holds is left byte for byte.
 *    A `.board-clone-*` sibling left by an interrupted earlier run is
 *    removed now, and the result's message names it. When `isLocalUrl(url)`
 *    and `localPath(url, base)` does not exist, `git init --bare` creates
 *    it (with every missing parent directory), before anything else is
 *    written. Then `git ls-remote -- <originUrl>`:
 *    - it fails (a non-local URL that does not exist or cannot be read, a
 *      local path that is not a repository): `BoardError(3,
 *      'remote-unreachable')` naming the URL, quoting git's first error
 *      line (`firstErrorLine`), telling the user to create an empty
 *      repository at the URL (the word `create` appears), for example on
 *      their git host, and to check their access (the word `access`
 *      appears; GitHub answers "Repository not found" for both). Nothing
 *      is created: no `dir`, no host `.gitignore` entry, no temporary
 *      directory.
 *    - it prints no refs (an empty repository): a new standalone board at
 *      `dir` exactly as `initBoard` creates one (`events/.gitkeep`, the
 *      board `.gitignore`, `git init`, no commit), the host `.gitignore`
 *      entry as `initBoard` writes it (when discovery's source is `git`
 *      and the parent of `dir` is the top level of a working tree;
 *      `hostGitignore` names the file it created or appended to, else
 *      null), `git remote add origin <originUrl>`, then `syncBoard`, whose
 *      first push creates the branch on the remote (`.gitignore` and
 *      `events/.gitkeep`) and sets the upstream. `action` `created`,
 *      `created` true, `joined` false, `remote` `origin`, `events` 0 (or
 *      the count a pull brought, when another clone pushed to the remote
 *      between the `ls-remote` and the push), `sync` the result, and a
 *      message naming `dir`, the standalone model, `origin` and the URL,
 *      ending with the sync's message lines. A `sync` failure propagates
 *      unchanged, the board, its `origin` and the sync's commit kept.
 *    - it lists at least one branch: `git clone -- <originUrl> <temporary>`
 *      into a fresh temporary directory beside `dir` (a sibling in the
 *      parent of `dir` named `.board-clone-<random>`, so the rename below
 *      is on one file system), then the clone's working tree is checked
 *      for an `events/` directory.
 *      When the remote's HEAD names no branch of the clone (git warns
 *      "remote HEAD refers to nonexistent ref" and checks nothing out:
 *      a bare repository whose HEAD is `main` that received only
 *      `master`) and the remote has exactly one branch, that branch is
 *      checked out as the clone's branch (tracking `origin`) before the
 *      check; when that checkout fails (the branch's tree cannot be
 *      read), the temporary directory is removed and the refusal is
 *      `BoardError(1, 'not-a-board')` quoting git, never a raw error.
 *      With `events/` present, the temporary directory is renamed
 *      to `dir`, the host `.gitignore` entry is written as above, and the
 *      board is opened once so its events are folded into the cache
 *      (`openBoard(dir).close()`): `action` `cloned`, `created` true,
 *      `joined` true, `remote` `origin`, `events` the number of event
 *      files, `sync` null, and a message naming `dir`, the URL and the
 *      event count (`cloned` and the count appear). Without `events/`,
 *      the temporary directory is removed and `BoardError(1,
 *      'not-a-board')` names the URL and the branch, says the repository
 *      holds no board (no `events/` directory) and that `--remote` needs
 *      an empty repository or one that holds a board; nothing is left
 *      behind: no `dir`, no temporary directory, no host `.gitignore`
 *      entry. A failed `git clone` (a remote whose objects are missing,
 *      found only now because `ls-remote` reads refs alone) is removed
 *      the same way and reported as `BoardError(3, 'remote-unreachable')`
 *      quoting git's first error line.
 *
 * In every case `model` is `standalone` and `repair` null. The board the
 * command leaves is one `agentboard remote` reports as `standalone` with
 * `origin` at `remoteUrl`, and `agentboard sync` syncs it on its branch.
 */
export function initBoardWithRemote(url: string, options?: LocateOptions): InitRemoteResult {
  if (url.trim() === '') {
    throw new BoardError(
      1,
      'usage',
      'agentboard init --remote needs the URL or local path of the repository that holds the board (--remote <url>)',
    );
  }
  const { dir, source } = locateBoard(options);
  const env: Env = options?.env ?? process.env;
  const cwd = options?.cwd ?? process.cwd();
  if (gitVersion(env, cwd) === null) {
    throw new BoardError(
      1,
      'git-missing',
      'agentboard init needs git (the board is kept in a git repository), but git could not be run',
    );
  }
  // A relative path is resolved against the host's top level when discovery
  // found the board through git (the same directory from every linked
  // worktree), else against the current directory.
  const base = source === 'git' ? dirname(dir) : cwd;
  const remoteUrl = originUrl(url, base);

  if (boardExists(dir)) {
    return existingBoard(dir, remoteUrl, env);
  }
  const writeHostGitignore = source === 'git' && hasInTreeGitDir(dirname(dir), env);
  const path = localPath(url, base);
  if (path !== null && !existsSync(path)) {
    createBareRepository(path, env);
  }
  const git = gitRunner(base, { env });
  const refs = git.attempt('ls-remote', remoteUrl);
  if (isGitFailure(refs)) {
    throw new BoardError(
      3,
      'remote-unreachable',
      `the repository at ${asciiText(remoteUrl)} cannot be read (${firstErrorLine(refs)}); ` +
        'create an empty repository there (for example on your git host) and check your ' +
        'access to it, then run agentboard init --remote again',
    );
  }
  return refs.trim() === ''
    ? createBoard(dir, remoteUrl, writeHostGitignore, env)
    : cloneBoard(dir, remoteUrl, writeHostGitignore, env);
}

/** The prefix of a `file://` URL. */
const FILE_SCHEME = 'file://';

/** The ten keys of `InitResult` that every `init --remote` result shares, for a standalone board. */
function standaloneBase(dir: string, events: number): Omit<InitResult, 'created' | 'joined' | 'remote' | 'message' | 'warnings'> {
  return { dir, model: 'standalone', events, hostGitignore: null, repair: null };
}

/**
 * Step 2 of `initBoardWithRemote`: `dir` is an existing board. A host-model
 * board, a broken link and a non-repository are refused; a standalone board
 * without a remote is attached to `remoteUrl` and synced; one whose chosen
 * remote has that URL is left as it is; any other URL is a mismatch.
 */
function existingBoard(dir: string, remoteUrl: string, env: Env): InitRemoteResult {
  const info = checkRepository(dir, env);
  if (info.model === 'host') {
    throw new BoardError(
      1,
      'board-in-host',
      `the board at ${dir} is already shared through the host repository at ${BOARD_REF}, ` +
        'which --remote does not apply to; agentboard remote shows how it is shared, and nothing changed',
    );
  }
  const choice = boardRemote(info, { env });
  if (choice.ambiguous) {
    throw ambiguousRemoteError(choice, 'init');
  }
  const chosen = choice.chosen;
  if (chosen === null) {
    return attachBoard(dir, info, remoteUrl, env);
  }
  if (chosen.url === remoteUrl) {
    return {
      ...standaloneBase(dir, countEvents(dir)),
      action: 'unchanged',
      created: false,
      joined: false,
      remote: chosen.name,
      remoteUrl,
      sync: null,
      warnings: [],
      message:
        `board already exists at ${asciiText(dir)} (standalone model) with the remote ` +
        `${asciiText(chosen.name)} at ${asciiText(remoteUrl)}; nothing changed`,
    };
  }
  throw new BoardError(
    1,
    'remote-mismatch',
    `the board at ${dir} already has the remote ${asciiText(chosen.name)} at ` +
      `${chosen.url === null ? 'no URL (no such remote)' : asciiText(chosen.url)}, not ` +
      `${asciiText(remoteUrl)}; keep it, or change it with git -C ${dir} remote set-url ` +
      `${asciiText(chosen.name)} ${asciiText(remoteUrl)}; nothing changed`,
  );
}

/** A standalone board with no remote: `origin` is added at `remoteUrl` and the board is synced. */
function attachBoard(
  dir: string,
  info: BoardModelInfo,
  remoteUrl: string,
  env: Env,
): InitRemoteResult {
  gitRunner(info.dir, { env }).run('remote', 'add', 'origin', remoteUrl);
  const sync = syncNow(dir, env);
  return {
    ...standaloneBase(dir, countEvents(dir)),
    action: 'attached',
    created: false,
    joined: false,
    remote: 'origin',
    remoteUrl,
    sync,
    warnings: [...sync.warnings],
    message:
      `attached the board at ${asciiText(dir)} (standalone model) to the remote origin at ` +
      `${asciiText(remoteUrl)}\n${sync.message}`,
  };
}

/**
 * Step 3 of `initBoardWithRemote` for an empty remote: a new standalone
 * board as `initBoard` makes one, the host `.gitignore` entry, `origin`
 * at `remoteUrl` and a `sync`, whose first push creates the branch there.
 */
function createBoard(
  dir: string,
  remoteUrl: string,
  writeHostGitignore: boolean,
  env: Env,
): InitRemoteResult {
  writeStandaloneRepository(dir, env);
  const hostGitignore = writeHostGitignore ? ignoreBoardInHost(dirname(dir)) : null;
  gitRunner(dir, { env }).run('remote', 'add', 'origin', remoteUrl);
  const sync = syncNow(dir, env);
  return {
    ...standaloneBase(dir, countEvents(dir)),
    hostGitignore,
    action: 'created',
    created: true,
    joined: false,
    remote: 'origin',
    remoteUrl,
    sync,
    warnings: [...sync.warnings],
    message:
      `created the board at ${asciiText(dir)} (standalone model: a git repository of its own, ` +
      `shared through the remote origin at ${asciiText(remoteUrl)})\n${sync.message}`,
  };
}

/**
 * Step 3 of `initBoardWithRemote` for a remote with a branch: a clone into
 * a temporary sibling of `dir`, renamed to `dir` once its working tree
 * holds `events/`; a clone that fails or holds no board is removed.
 */
function cloneBoard(
  dir: string,
  remoteUrl: string,
  writeHostGitignore: boolean,
  env: Env,
): InitRemoteResult {
  const parent = dirname(dir);
  mkdirSync(parent, { recursive: true });
  // A sibling of the board directory, so the rename below stays on one
  // file system; a dot name keeps it out of the way while it exists.
  const temporary = mkdtempSync(join(parent, '.board-clone-'));
  try {
    const git = gitRunner(temporary, { env });
    const cloned = git.attempt('clone', '--quiet', '--', remoteUrl, temporary);
    if (isGitFailure(cloned)) {
      throw new BoardError(
        3,
        'remote-unreachable',
        `the repository at ${asciiText(remoteUrl)} could not be cloned (${firstErrorLine(cloned)}); ` +
          'create an empty repository there (for example on your git host) and check your ' +
          'access to it, then run agentboard init --remote again',
      );
    }
    checkoutOnlyBranch(git);
    if (!isDirectory(join(temporary, 'events'))) {
      const branch = currentBranch(git);
      throw new BoardError(
        1,
        'not-a-board',
        `the repository at ${asciiText(remoteUrl)} holds no board: ` +
          `${branch === null ? 'its default branch' : `its branch ${asciiText(branch)}`} has no ` +
          'events/ directory; --remote needs an empty repository, or one that holds a board',
      );
    }
    renameSync(temporary, dir);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  const hostGitignore = writeHostGitignore ? ignoreBoardInHost(parent) : null;
  // Folds the events into the cache, so the next command sees them.
  openBoard(dir).close();
  const events = countEvents(dir);
  return {
    ...standaloneBase(dir, events),
    hostGitignore,
    action: 'cloned',
    created: true,
    joined: true,
    remote: 'origin',
    remoteUrl,
    sync: null,
    warnings: [],
    message:
      `cloned the board at ${asciiText(dir)} from ${asciiText(remoteUrl)} (standalone model: ` +
      `a git repository of its own) with ${plural(events, 'event')}`,
  };
}

/**
 * When the clone checked nothing out because the remote's HEAD names a
 * branch the remote does not have, and the remote has exactly one branch,
 * checks that branch out, tracking `origin`.
 */
function checkoutOnlyBranch(git: GitRunner): void {
  if (!isGitFailure(git.attempt('rev-parse', '--quiet', '--verify', 'HEAD^{commit}'))) {
    return;
  }
  const branches = git
    .run('for-each-ref', '--format=%(refname:strip=3)', 'refs/remotes/origin/')
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => name !== '' && name !== 'HEAD');
  const only = branches.length === 1 ? branches[0] : undefined;
  if (only !== undefined) {
    git.run('checkout', '--quiet', '-b', only, '--track', `origin/${only}`);
  }
}

/** The current branch of the repository `git` runs in, or null when HEAD is detached. */
function currentBranch(git: GitRunner): string | null {
  const ref = git.attempt('symbolic-ref', '--quiet', '--short', 'HEAD');
  return isGitFailure(ref) ? null : ref.trim();
}

/** `git init --bare` at `path`, with every missing parent directory. */
function createBareRepository(path: string, env: Env): void {
  mkdirSync(dirname(path), { recursive: true });
  gitRunner(dirname(path), { env }).run('init', '--quiet', '--bare', path);
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

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
