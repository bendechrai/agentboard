/**
 * `rebuild` and `rebuild --check` as library functions (board-cache:
 * "Rebuild"). CLI wiring is task group 3.
 */

import type { DatabaseSync } from 'node:sqlite';

import type { JsonValue } from '../events/canonical.js';
import type { Rejected, UnknownReport } from '../events/fold.js';
import type { Board } from './board.js';
import { DUMP_TABLES, openCache, type DumpTable } from './cache.js';
import {
  beginImmediate,
  inImmediate,
  jsonText,
  refold,
  rollback,
  tableRows,
  type KeyedRow,
  type RefoldResult,
} from './engine.js';
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
  return toReport(inImmediate(board.db, () => refold(board.db, board.eventsDir)));
}

function toReport(result: RefoldResult): RebuildReport {
  return {
    folded: result.applied.length,
    rejected: result.rejected.length,
    malformed: result.malformed.length,
    corrupt: result.corrupt.length,
    unknown: result.unknown.length,
    rejectedEvents: result.rejected,
    unknownEvents: result.unknown,
    malformedFiles: result.malformed,
    corruptFiles: result.corrupt,
  };
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
  const differences: CacheDifference[] = [];
  for (const table of DUMP_TABLES) {
    const byKey = (db: DatabaseSync): Map<string, KeyedRow> =>
      new Map(tableRows(db, table).map((keyed) => [keyed.key, keyed]));
    const left = byKey(live);
    const right = byKey(rebuilt);
    const keys = [...new Set([...left.keys(), ...right.keys()])].sort();
    for (const key of keys) {
      const a = left.get(key);
      const b = right.get(key);
      if (a !== undefined && b !== undefined && jsonText(a.row) === jsonText(b.row)) {
        continue;
      }
      differences.push({
        table,
        key,
        ticket: (a ?? b)?.ticket ?? null,
        live: a?.row ?? null,
        rebuilt: b?.row ?? null,
      });
    }
  }
  return differences;
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
 * cache using `diffCaches`, and closes the temporary database.
 *
 * It holds the write lock on the live connection (`BEGIN IMMEDIATE` on
 * `board.db`, with the busy retry, then `BoardError(5, 'busy')`) across the
 * listing of `events/`, the refold and the diff, and then rolls back. A
 * concurrent writer is therefore either fully committed (file and rows) or
 * not started, so `--check` never reports a false divergence while writers
 * run; waiting for the lock is expected. Under the lock, an event file the
 * live cache has not folded can only come from a crashed command, and it
 * shows up as a real difference.
 *
 * Never writes to the live cache (the transaction is always rolled back) or
 * to the board directory, never runs catch-up and never reaps temporary
 * files.
 */
export function checkCache(board: Board): CheckResult {
  const temp = openCache(':memory:');
  try {
    // The live write lock spans listing, refold and diff, so a concurrent
    // writer is either fully committed (file and rows) or not started.
    beginImmediate(board.db);
    try {
      const report = toReport(inImmediate(temp, () => refold(temp, board.eventsDir)));
      const differences = diffCaches(board.db, temp);
      return { ok: differences.length === 0, differences, report };
    } finally {
      rollback(board.db);
    }
  } finally {
    temp.close();
  }
}
