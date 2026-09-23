/**
 * Board discovery (board-events: "Board discovery from any worktree";
 * design.md: "Board discovery").
 */

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { BoardError } from './errors.js';

/** Name of the board directory at the root of the main checkout. */
export const BOARD_DIR_NAME = '.board';

/** Environment variable that overrides discovery. */
export const BOARD_DIR_ENV = 'AGENTBOARD_DIR';

/** Where a candidate board path came from. */
export type BoardSource = 'env' | 'git' | 'cwd';

/** Result of discovery: an absolute path and the rule that produced it. */
export interface BoardLocation {
  /**
   * Absolute, normalized path of the board directory (the `.board`
   * directory itself, not its parent). It is not passed through
   * `fs.realpath`, so on a system where the temporary directory is behind a
   * symlink it may differ textually from a realpath of the same directory.
   */
  dir: string;
  source: BoardSource;
}

/** Inputs to discovery. Both default to the current process. */
export interface LocateOptions {
  /** Directory the command runs in. Defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * Environment to read `AGENTBOARD_DIR` from, and the environment the `git`
   * child process runs with. Defaults to `process.env`.
   */
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Resolves where the board should be, without checking that it exists.
 *
 * Resolution order:
 * 1. `AGENTBOARD_DIR` when set to a non-empty string: `path.resolve(cwd,
 *    value)`, source `env`. This wins even inside a git repository, and even
 *    when the path does not exist.
 * 2. Otherwise, when `git rev-parse --git-common-dir` succeeds when run in
 *    `cwd` (with `env` as its environment): the printed directory resolved
 *    against `cwd` to an absolute path, then its parent joined with
 *    `.board`, source `git`. Because the common dir is shared by every
 *    linked worktree, all worktrees of one repository (and every
 *    subdirectory of each) resolve to the main checkout's `.board`.
 * 3. Otherwise (not in a git repository, or `git` is not installed):
 *    `path.resolve(cwd, '.board')`, source `cwd`.
 *
 * Never throws for a missing board; `git` failing is not an error.
 */
export function locateBoard(options?: LocateOptions): BoardLocation {
  const cwd = options?.cwd ?? process.cwd();
  const env = options?.env ?? process.env;
  const override = env[BOARD_DIR_ENV];
  if (override !== undefined && override !== '') {
    return { dir: resolve(cwd, override), source: 'env' };
  }
  const commonDir = gitCommonDir(cwd, env);
  if (commonDir !== null) {
    return { dir: join(dirname(resolve(cwd, commonDir)), BOARD_DIR_NAME), source: 'git' };
  }
  return { dir: resolve(cwd, BOARD_DIR_NAME), source: 'cwd' };
}

/** `git rev-parse --git-common-dir` in `cwd`, or null when git fails or is absent. */
function gitCommonDir(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      env: { ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const dir = out.replace(/\r?\n$/, '');
    return dir === '' ? null : dir;
  } catch {
    return null;
  }
}

/**
 * True when `dir` holds a board: `<dir>/events` is a directory (board-events:
 * "a board SHALL be considered to exist when `<board>/events` is a
 * directory"). Never throws.
 */
export function boardExists(dir: string): boolean {
  try {
    return statSync(join(dir, 'events')).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `locateBoard`, then checks that a board exists there (`boardExists`).
 *
 * @throws BoardError with exit code 2 and reason `board-not-found` when it
 *   does not. The message names the absolute path looked at; when the
 *   source is `cwd` the message also contains the literal text `./.board`
 *   (board-events scenario "Missing board is reported").
 */
export function findBoard(options?: LocateOptions): BoardLocation {
  const location = locateBoard(options);
  if (!boardExists(location.dir)) {
    throw new BoardError(
      2,
      'board-not-found',
      `no board found at ${location.dir} (${SOURCE_TEXT[location.source]}); run agentboard init to create one`,
    );
  }
  return location;
}

/** How each discovery rule is named in the not-found message. */
const SOURCE_TEXT: Record<BoardSource, string> = {
  env: `from ${BOARD_DIR_ENV}`,
  git: `<git common dir>/../${BOARD_DIR_NAME}`,
  cwd: `./${BOARD_DIR_NAME}, not inside a git repository`,
};
