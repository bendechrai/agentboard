/**
 * `agentboard init` (board-events: "Board directory per project"; design.md:
 * "Git sync model").
 */

import type { LocateOptions } from '../store/locate.js';
import { notImplemented } from './stub.js';

/**
 * Lines of the `.gitignore` that `init` writes inside the board directory,
 * in this order, each followed by a newline: the cache file and its SQLite
 * WAL and shared-memory companions, so `sync` never commits them.
 */
export const BOARD_GITIGNORE_LINES = [
  'cache.sqlite',
  'cache.sqlite-wal',
  'cache.sqlite-shm',
] as const;

/** The entry `init` adds to the host project's `.gitignore`. */
export const HOST_GITIGNORE_ENTRY = '.board/';

/** Result of `initBoard`; also the `init --json` document. */
export interface InitResult {
  /** Absolute path of the board directory (from `locateBoard`). */
  dir: string;
  /** False when a board already existed there and nothing was touched. */
  created: boolean;
  /**
   * Absolute path of the host `.gitignore` that `init` created or
   * appended to, or null when it did not touch one (already listed the
   * entry, the board already existed, or discovery came from
   * `AGENTBOARD_DIR`).
   */
  hostGitignore: string | null;
  /** One human-readable ASCII line describing what happened. */
  message: string;
}

/**
 * Creates the board where discovery says it belongs (`locateBoard` with
 * `options`; a missing board is not an error here).
 *
 * When `boardExists(dir)` is already true, nothing is created or modified
 * (not even the host `.gitignore`) and the result has `created: false`,
 * `hostGitignore: null` and a message saying the board already exists at
 * `dir`; the CLI exits 0.
 *
 * Otherwise, creating only what is missing and never overwriting an
 * existing file:
 * 1. `dir` and `dir/events`, with an empty `dir/events/.gitkeep`, so the
 *    directory survives a git clone. `events/` holds nothing else.
 * 2. `dir/.gitignore` containing `BOARD_GITIGNORE_LINES`, one per line.
 * 3. A git repository in `dir` (`git init` run in `dir`, when `dir/.git`
 *    does not exist). No commit is made.
 * 4. When discovery's source is `git` or `cwd`: the host `.gitignore` is
 *    `<parent of dir>/.gitignore`. When no line of it, trimmed, equals
 *    `.board/`, `.board`, `/.board/` or `/.board`, the line `.board/` is
 *    appended (after a newline when the file does not end with one), or the
 *    file is created containing `.board/\n`. Existing content is kept byte
 *    for byte. When the source is `env` no host file is touched.
 *
 * The result has `created: true`, `hostGitignore` as described, and a
 * message naming `dir`.
 *
 * @throws BoardError exit 1, reason `git-missing`, naming `git`, when the
 *   `git` executable cannot be run; in that case nothing is created.
 */
export function initBoard(options?: LocateOptions): InitResult {
  throw notImplemented(options);
}
