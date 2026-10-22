/**
 * Board model detection (board-events: "Board model detection";
 * add-board-sharing design.md: decision 6). One function, used by `init`,
 * `sync` and `remote`, decides whether a board directory is a host-model
 * board (a linked worktree of the host repository), a standalone board (a
 * repository of its own that is not a linked worktree, whether its `.git` is
 * a directory or a file), a host-model board whose link is broken, or no
 * repository at all. Commands that only read or write events never call it,
 * so a broken link never stops the board itself.
 */

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { gitRunner, isGitFailure } from './git.js';
import { asciiText, type Env } from './text.js';

/**
 * The ref that holds a host-model board's history in the host repository.
 * Every ref under `BOARD_REF_NAMESPACE` is reserved for agentboard.
 */
export const BOARD_REF = 'refs/agentboard/board';

/** The ref namespace reserved for agentboard in a host repository. */
export const BOARD_REF_NAMESPACE = 'refs/agentboard/';

/**
 * The sharing model of a board directory, with `<parent>` the directory
 * that contains it:
 * - `host`: the board directory is the top level of a linked worktree whose
 *   git common directory is the git common directory of `<parent>`;
 * - `standalone`: the board directory is the top level of a repository that
 *   is not a linked worktree (its git common directory is its git
 *   directory, after resolving), whether `.git` is a directory or a file
 *   naming a git directory elsewhere (`git init --separate-git-dir`, a
 *   submodule of the host);
 * - `broken-host-link`: the board directory contains a `.git` file whose
 *   target is missing, or is a linked worktree whose git common directory
 *   is not `<parent>`'s (the host was moved, or a `.board` was copied from
 *   another clone);
 * - `not-a-repository`: none of the above (no `.git` at all, or a plain
 *   subdirectory of the host repository).
 */
export type BoardModel = 'host' | 'standalone' | 'broken-host-link' | 'not-a-repository';

/** How each model is named for a human (`agentboard remote`, `init`). */
export const MODEL_TEXT: Readonly<Record<BoardModel, string>> = {
  host: 'host',
  standalone: 'standalone',
  'broken-host-link': 'broken host link',
  'not-a-repository': 'not a repository',
};

/** What `detectBoardModel` found. */
export interface BoardModelInfo {
  /** The board directory as given, resolved to an absolute path (not its realpath). */
  readonly dir: string;
  readonly model: BoardModel;
  /**
   * Where the board's history lives: for `host`, the realpath of the host
   * repository's git common directory; for `standalone`, the realpath of
   * the board's own git directory (`<dir>/.git`, or the directory a `.git`
   * file names); null for the other two.
   */
  readonly gitDir: string | null;
  /**
   * For `broken-host-link`, one plain ASCII line saying what is wrong: that
   * the `.git` file's target is missing (naming it), or that the board is a
   * worktree of another repository (naming its git common directory).
   * Every path in it is a realpath, however `dir` was given. Null for
   * every other model.
   */
  readonly detail: string | null;
}

/** Options of `detectBoardModel`. */
export interface DetectOptions {
  /** Environment for the git child processes (sanitised as `gitRunner` does). Defaults to `process.env`. */
  readonly env?: Env | undefined;
}

/**
 * Decides the model of the board directory `dir` (board-events "Board model
 * detection"), with `git rev-parse --show-toplevel --git-common-dir
 * --absolute-git-dir` run in `dir` and `git rev-parse --git-common-dir` run
 * in its parent, every path resolved with `realpath` before it is compared,
 * so a temporary directory behind a symlink, or `dir` given through one,
 * detects the same as its real path:
 *
 * - `host` when the first call succeeds, its top level is `dir`, its git
 *   directory is not its common directory (a linked worktree), and its
 *   common directory is the parent's;
 * - `standalone` when the first call succeeds, its top level is `dir`, and
 *   its git directory is its common directory (not a linked worktree),
 *   wherever that directory lies: `dir/.git`, or the directory a `.git`
 *   file names (`git init --separate-git-dir`, a submodule of the host,
 *   whose git directory is `<host>/.git/modules/<name>`);
 * - `broken-host-link` when `dir/.git` is a file and the first call fails
 *   (its target is missing), or when `dir` is a linked worktree whose
 *   common directory is not the parent's (the parent not being a
 *   repository counts);
 * - `not-a-repository` otherwise: no `dir/.git`, or `dir` is only a
 *   subdirectory of some repository (the first call's top level is not
 *   `dir`).
 *
 * A standalone board is never told apart by where its git directory is, so
 * every board that synced before the host model existed keeps syncing
 * unchanged.
 *
 * Reads nothing but git's answers and whether `dir/.git` is a file; writes
 * nothing. Never throws for a missing or odd directory; git failing to run
 * at all is reported as `not-a-repository`.
 */
export function detectBoardModel(dir: string, options?: DetectOptions): BoardModelInfo {
  const absolute = resolve(dir);
  const real = realpathOrSelf(absolute);
  const result = (
    model: BoardModel,
    gitDir: string | null = null,
    detail: string | null = null,
  ): BoardModelInfo => ({ dir: absolute, model, gitDir, detail });
  const dotGitIsFile = isFile(join(real, '.git'));

  const git = gitRunner(real, { env: options?.env });
  const first = git.attempt(
    'rev-parse',
    '--show-toplevel',
    '--git-common-dir',
    '--absolute-git-dir',
  );
  if (isGitFailure(first)) {
    if (first.status !== null && dotGitIsFile) {
      return result('broken-host-link', null, missingTargetDetail(real));
    }
    return result('not-a-repository');
  }
  const [top = '', common = '', gitDir = ''] = first.split('\n').map((line) => line.trim());
  if (realpathOrSelf(resolve(real, top)) !== real) {
    return result('not-a-repository');
  }
  const realCommon = realpathOrSelf(resolve(real, common));
  const realGitDir = realpathOrSelf(resolve(real, gitDir));

  if (realGitDir !== realCommon) {
    // A linked worktree: of the parent's repository, or of another one.
    const parentCommon = git.attemptIn(dirname(real), 'rev-parse', '--git-common-dir');
    if (!isGitFailure(parentCommon)) {
      const realParentCommon = realpathOrSelf(resolve(dirname(real), parentCommon.trim()));
      if (realParentCommon === realCommon) {
        return result('host', realCommon);
      }
    }
    // Every path in the detail is a realpath, however `dir` was given.
    return result(
      'broken-host-link',
      null,
      `the board at ${asciiText(real)} is a worktree of another repository ` +
        `(its git directory is ${asciiText(realCommon)}, not the one of ${asciiText(dirname(real))})`,
    );
  }
  // Not a linked worktree: a repository of its own, wherever its git
  // directory lies (`dir/.git`, or the directory a `.git` file names: a
  // separate git dir, a submodule of the host).
  return result('standalone', realGitDir);
}

/** The detail of a `.git` file whose `gitdir:` target git could not open. */
function missingTargetDetail(real: string): string {
  const file = join(real, '.git');
  const target = gitdirTarget(file);
  return target === ''
    ? `the .git file at ${asciiText(file)} names a git directory that is missing`
    : `the .git file at ${asciiText(file)} names the missing git directory ${asciiText(target)}`;
}

/** The `gitdir:` target written in the `.git` file at `file`, or an empty string when it cannot be read. */
function gitdirTarget(file: string): string {
  try {
    return /^gitdir:\s*(.*)$/m.exec(readFileSync(file, 'utf8'))?.[1]?.trim() ?? '';
  } catch {
    return '';
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
