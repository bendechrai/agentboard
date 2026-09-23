/**
 * `rebuild` and `rebuild --check` as library functions (board-cache:
 * "Rebuild"). CLI wiring is task group 3.
 */

import type { DatabaseSync } from 'node:sqlite';

import type { JsonValue } from '../events/canonical.js';
import type { Rejected, UnknownReport } from '../events/fold.js';
import type { Board } from './board.js';
import type { DumpTable } from './cache.js';
import type { CorruptFile, MalformedFile } from './eventfile.js';

/**
 * Counts and details of a full refold. Every file listed by
 * `listEventFiles` is counted in exactly one of `folded`, `rejected`,
 * `malformed`, `corrupt` and `unknown`.
 */
export interface RebuildReport {
  /** Well-formed known-kind events applied (including `board.meta`). */
  folded: number;
  rejected: number;
  malformed: number;
  corrupt: number;
  unknown: number;
  /** In fold order. */
  rejectedEvents: Rejected[];
  /** In fold order. */
  unknownEvents: UnknownReport[];
  /** By file name. */
  malformedFiles: MalformedFile[];
  /** By file name. */
  corruptFiles: CorruptFile[];
}

/**
 * `agentboard rebuild`: in one `BEGIN IMMEDIATE` transaction on `board.db`,
 * deletes every row of the derived tables (all but `cursors`, whose rows are
 * kept), then folds every event file in deterministic order and writes the
 * rows, `folded` and `meta` exactly as catch-up would. Rebuilding twice on
 * the same event files yields byte-identical `dumpCache` output, equal to
 * the dump of any other cache built from those files. Does not reap
 * temporary files.
 */
export function rebuild(board: Board): RebuildReport {
  void board;
  throw new Error('not implemented');
}

/** One row that differs between the live cache and a fresh rebuild. */
export interface CacheDifference {
  table: DumpTable;
  /**
   * The row's primary key as text: the id for `tickets`, `<ticket>#<seq>`
   * for `comments` and `links`, the hash for `folded`, the key for `meta`.
   */
  key: string;
  /** The ticket id for `tickets`, `comments` and `links` rows; else null. */
  ticket: string | null;
  /** The live row (column name to value), or null when only the rebuild has it. */
  live: Record<string, JsonValue> | null;
  /** The rebuilt row, or null when only the live cache has it. */
  rebuilt: Record<string, JsonValue> | null;
}

/**
 * Compares the derived tables of two caches row by row (the rows `dumpCache`
 * covers). Returns one entry per primary key whose row is missing on one
 * side or differs in any column, sorted by table (in `DUMP_TABLES` order)
 * then key. Empty exactly when the two dumps are identical. Read-only.
 */
export function diffCaches(live: DatabaseSync, rebuilt: DatabaseSync): CacheDifference[] {
  void live;
  void rebuilt;
  throw new Error('not implemented');
}

/** Result of `checkCache`. */
export interface CheckResult {
  /** True when there is no difference. The CLI exits 1 when false. */
  ok: boolean;
  differences: CacheDifference[];
  /** Report of the rebuild into the temporary database. */
  report: RebuildReport;
}

/**
 * `agentboard rebuild --check`: rebuilds from the event files into a
 * temporary database (`openCache(':memory:')`), compares it with the live
 * cache using `diffCaches`, and closes the temporary database. Never writes
 * to the live cache or to the board directory, never runs catch-up and never
 * reaps temporary files, so an event file the live cache has not folded yet
 * shows up as a difference.
 */
export function checkCache(board: Board): CheckResult {
  void board;
  throw new Error('not implemented');
}
