/**
 * `agentboard init` (board-events: "Board directory per project"; add-board-core design.md:
 * "Git sync model").
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { BoardError } from '../store/errors.js';
import { boardExists, locateBoard, type LocateOptions } from '../store/locate.js';

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
  const { dir, source } = locateBoard(options);
  if (boardExists(dir)) {
    return {
      dir,
      created: false,
      hostGitignore: null,
      message: `board already exists at ${dir}; nothing changed`,
    };
  }
  const env = { ...(options?.env ?? process.env) };
  const git = (cwd: string, ...args: string[]): void => {
    execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  };
  try {
    git(options?.cwd ?? process.cwd(), '--version');
  } catch {
    throw new BoardError(
      1,
      'git-missing',
      'agentboard init needs git (the board is a git repository of its own), but git could not be run',
    );
  }
  // The events directory is created last: it is what makes the board exist,
  // so an interrupted init is completed by running init again.
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, '.git'))) {
    git(dir, 'init', '-q');
  }
  writeIfMissing(join(dir, '.gitignore'), BOARD_GITIGNORE_LINES.map((l) => `${l}\n`).join(''));
  mkdirSync(join(dir, 'events'), { recursive: true });
  writeIfMissing(join(dir, 'events', '.gitkeep'), '');
  const hostGitignore = source === 'env' ? null : ignoreBoardInHost(dirname(dir));
  return { dir, created: true, hostGitignore, message: `created the board at ${dir}` };
}

/** Writes `content` to `path` unless a file is already there. */
function writeIfMissing(path: string, content: string): void {
  if (!existsSync(path)) {
    writeFileSync(path, content);
  }
}

/** Lines of a host `.gitignore` that already ignore the board directory. */
const HOST_ENTRIES = new Set(['.board/', '.board', '/.board/', '/.board']);

/**
 * Adds `HOST_GITIGNORE_ENTRY` to `<hostRoot>/.gitignore` unless a line
 * already ignores the board; returns the file's path when it was created or
 * appended to, else null.
 */
function ignoreBoardInHost(hostRoot: string): string | null {
  const path = join(hostRoot, '.gitignore');
  if (!existsSync(path)) {
    writeFileSync(path, `${HOST_GITIGNORE_ENTRY}\n`);
    return path;
  }
  const content = readFileSync(path, 'utf8');
  if (content.split('\n').some((line) => HOST_ENTRIES.has(line.trim()))) {
    return null;
  }
  const separator = content === '' || content.endsWith('\n') ? '' : '\n';
  appendFileSync(path, `${separator}${HOST_GITIGNORE_ENTRY}\n`);
  return path;
}
