/**
 * The `Board` handle: the paths of one board and an open cache connection.
 * Every store operation takes one.
 */

import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { CACHE_FILE, catchUp, openCache, type CatchUpReport } from './cache.js';
import { BoardError } from './errors.js';
import type { WriteHooks } from './eventfile.js';
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
  /**
   * Passed to `openCache` as `prepare` (default true). False opens the
   * cache for inspection only: it must exist and be a cache of
   * `CACHE_SCHEMA_VERSION`, and the file is never created or modified
   * (`BoardError(5, 'no-cache')` or `BoardError(5, 'schema-mismatch')`
   * otherwise, see `OpenCacheOptions`). With `prepare: false`, catch-up is
   * never run, whatever `catchUp` says. `rebuild --check` opens this way.
   */
  prepare?: boolean;
  /**
   * The clock reading passed to `catchUp` as `now`: for temp reaping and
   * for deciding which grants are due. Defaults to `Date.now()`.
   */
  now?: number;
  /** Passed to `catchUp` as `onWriteLock` (the lock probe). */
  onWriteLock?: () => void;
  /** Passed to `catchUp` as `hooks` (crash injection in grant writes). */
  hooks?: WriteHooks;
  /** Passed to `catchUp` as `onReadEventFile` (the read probe). */
  onReadEventFile?: (name: string) => void;
}

/**
 * Opens the board at `dir` (normally `findBoard().dir`).
 *
 * `dir` is resolved to an absolute path. Opens `<dir>/cache.sqlite` with
 * `openCache` (creating it when absent), then, unless `catchUp` is false,
 * runs `catchUp` (with `now`, `onWriteLock` and `hooks` from the options),
 * whose report becomes `opened`, so opening also writes the grants due at
 * `now`. A deleted cache therefore
 * comes back with the same rows as before, as long as the event files are
 * unchanged. Opening a cache that already has the current schema, when
 * catch-up finds nothing to fold, reap or grant, never takes the write lock, so a
 * reader is not blocked by a writer holding `BEGIN IMMEDIATE`. With
 * `prepare: false` the cache is only inspected (`openCache` with `prepare:
 * false`) and catch-up never runs.
 *
 * @throws BoardError exit 5, reason `no-cache` or `schema-mismatch`, from
 *   `openCache` with `prepare: false`.
 * @throws BoardError exit 2, reason `board-not-found`, naming `dir`, when
 *   `boardExists(dir)` is false. Nothing is created in that case.
 */
export function openBoard(dir: string, options?: OpenBoardOptions): Board {
  const abs = resolve(dir);
  if (!boardExists(abs)) {
    throw new BoardError(2, 'board-not-found', `no board found at ${abs} (no events directory)`);
  }
  const cachePath = join(abs, CACHE_FILE);
  const prepare = options?.prepare !== false;
  const db = openCache(cachePath, { prepare });
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
  if (prepare && options?.catchUp !== false) {
    try {
      board.opened = catchUp(board, {
        now: options?.now ?? Date.now(),
        ...(options?.onWriteLock === undefined ? {} : { onWriteLock: options.onWriteLock }),
        ...(options?.hooks === undefined ? {} : { hooks: options.hooks }),
      });
    } catch (error) {
      board.close();
      throw error;
    }
  }
  return board;
}
