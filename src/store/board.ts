/**
 * The `Board` handle: the paths of one board and an open cache connection.
 * Every store operation takes one.
 */

import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { CACHE_FILE, catchUp, openCache, type CatchUpReport } from './cache.js';
import { BoardError } from './errors.js';
import { boardExists } from './locate.js';

/** An open board. Obtain with `openBoard`; release with `close`. */
export interface Board {
  /** Absolute path of the board directory (the `.board` directory). */
  readonly dir: string;
  /** Absolute path of `<dir>/events`. */
  readonly eventsDir: string;
  /** Absolute path of `<dir>/cache.sqlite` (see `CACHE_FILE`). */
  readonly cachePath: string;
  /** The cache connection, prepared by `openCache`. */
  readonly db: DatabaseSync;
  /**
   * What opening did to bring the cache up to date: the report of the
   * catch-up (or initial build) run by `openBoard`, or null when opened with
   * `catchUp: false`.
   */
  readonly opened: CatchUpReport | null;
  /** Closes the connection. Idempotent. */
  close(): void;
}

/** Options for `openBoard`. */
export interface OpenBoardOptions {
  /**
   * When true (the default), `openBoard` runs `catchUp` before returning,
   * so a deleted, new or stale cache is rebuilt or extended from the event
   * files transparently. When false the cache is opened (and created empty
   * if absent) but no event file is read and no temporary file is reaped;
   * `rebuild --check` uses this so it never modifies the live cache.
   */
  catchUp?: boolean;
  /** Clock for temp reaping, in ms since the epoch. Defaults to `Date.now()`. */
  now?: number;
}

/**
 * Opens the board at `dir` (normally `findBoard().dir`).
 *
 * `dir` is resolved to an absolute path. Opens `<dir>/cache.sqlite` with
 * `openCache` (creating it when absent), then, unless `catchUp` is false,
 * runs `catchUp`, whose report becomes `opened`. A deleted cache therefore
 * comes back with the same rows as before, as long as the event files are
 * unchanged. Opening a cache that already has the current schema, when
 * catch-up finds nothing to fold or reap, never takes the write lock, so a
 * reader is not blocked by a writer holding `BEGIN IMMEDIATE`.
 *
 * @throws BoardError exit 2, reason `board-not-found`, naming `dir`, when
 *   `boardExists(dir)` is false. Nothing is created in that case.
 */
export function openBoard(dir: string, options?: OpenBoardOptions): Board {
  const abs = resolve(dir);
  if (!boardExists(abs)) {
    throw new BoardError(2, 'board-not-found', `no board found at ${abs} (no events directory)`);
  }
  const cachePath = join(abs, CACHE_FILE);
  const db = openCache(cachePath);
  let closed = false;
  const board: { -readonly [K in keyof Board]: Board[K] } = {
    dir: abs,
    eventsDir: join(abs, 'events'),
    cachePath,
    db,
    opened: null,
    close(): void {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };
  if (options?.catchUp !== false) {
    try {
      board.opened = catchUp(board, { now: options?.now ?? Date.now() });
    } catch (error) {
      board.close();
      throw error;
    }
  }
  return board;
}
