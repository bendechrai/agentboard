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

import type { LocateOptions } from '../store/locate.js';
import type { InitResult } from './init.js';
import type { SyncResult } from './sync.js';

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
  void url;
  throw new Error('not implemented');
}

/**
 * The absolute file system path of a local `url` (`isLocalUrl`), or null
 * for any other URL: a `file://` URL without its `file://` prefix
 * (`file:///abs/x.git` is `/abs/x.git`), an absolute path as it is, and
 * a relative path resolved against `base` with `path.resolve` (`../x.git`
 * from `/a/b` is `/a/x.git`). `base` is the directory `initBoardWithRemote`
 * resolves relative paths against (see there). Pure.
 */
export function localPath(url: string, base: string): string | null {
  void url;
  void base;
  throw new Error('not implemented');
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
  void url;
  void base;
  throw new Error('not implemented');
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
 * 1. `url` empty or whitespace only: `BoardError(1, 'usage')` naming
 *    `--remote`. `git` cannot be run: `BoardError(1, 'git-missing')` as
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
 *    - `standalone` whose chosen remote (`boardRemote(info).chosen`) has
 *      exactly the URL `originUrl(url, base)`: `action` `unchanged`, exit
 *      0, nothing done (no `sync`: an uncommitted event file stays
 *      uncommitted, the remote receives nothing), `created` false,
 *      `remote` the chosen remote's name, `sync` null, `hostGitignore`
 *      null, and a message saying the board already has that remote and
 *      that nothing changed.
 *    - `standalone` whose chosen remote has another URL:
 *      `BoardError(1, 'remote-mismatch')` naming the remote, both URLs
 *      (the one it has and `originUrl(url, base)`) and
 *      `git -C <dir> remote set-url <name> <url>` (the text
 *      `remote set-url` appears); nothing changes.
 *    - `broken-host-link` or `not-a-repository`: not this command's job;
 *      `BoardError(2, 'board-link-broken')` for a broken link (it is a
 *      host worktree; `agentboard init` repairs it) and
 *      `BoardError(2, 'board-not-a-repository')` for a non-repository,
 *      each with the message `sync` gives; nothing changes.
 * 3. `dir` does not exist. When `isLocalUrl(url)` and
 *    `localPath(url, base)` does not exist, `git init --bare` creates it
 *    (with every missing parent directory), before anything else is
 *    written. Then `git ls-remote <originUrl>`:
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
 *    - it lists at least one branch: `git clone <originUrl> <temporary>`
 *      into a fresh temporary directory beside `dir` (a sibling in the
 *      parent of `dir`, so the rename below is on one file system), then
 *      the clone's working tree is checked for an `events/` directory.
 *      When the remote's HEAD names no branch of the clone (git warns
 *      "remote HEAD refers to nonexistent ref" and checks nothing out:
 *      a bare repository whose HEAD is `main` that received only
 *      `master`) and the remote has exactly one branch, that branch is
 *      checked out as the clone's branch (tracking `origin`) before the
 *      check. With `events/` present, the temporary directory is renamed
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
 *      entry. A failed `git clone` is removed the same way and reported
 *      as `remote-unreachable`.
 *
 * In every case `model` is `standalone` and `repair` null. The board the
 * command leaves is one `agentboard remote` reports as `standalone` with
 * `origin` at `remoteUrl`, and `agentboard sync` syncs it on its branch.
 */
export function initBoardWithRemote(url: string, options?: LocateOptions): InitRemoteResult {
  void url;
  void options;
  throw new Error('not implemented');
}
