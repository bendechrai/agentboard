/**
 * Reading fold positions from the `folded` table, for cursors and `inbox`.
 * Internal (not re-exported from `src/index.ts`).
 *
 * `folded.position` holds `encodeHlc(ts)` of every well-formed event (null
 * for malformed files). Its first 16 characters are the zero-padded wall,
 * so wall bounds are applied in SQL on that prefix alone (digits compare
 * the same under any collation); the exact fold order, which also depends
 * on the actor and the hash, is always decided in JavaScript with
 * `compareHlc`, never by SQLite's collation.
 */

import type { DatabaseSync } from 'node:sqlite';

import { decodeHlc, type Hlc } from '../events/hlc.js';

/** A recorded event's hash and timestamp. */
export interface RecordedPosition {
  hash: string;
  ts: Hlc;
  /** True for an applied (effective) event, `folded.folded = 1`. */
  effective: boolean;
}

/** Bounds for `recordedPositions`, inclusive, on `ts.wall`. */
export interface WallBounds {
  minWall?: number | undefined;
  maxWall?: number | undefined;
  /** Only applied events (`folded.folded = 1`). */
  effectiveOnly?: boolean | undefined;
}

/** The 16-digit zero-padded wall prefix of an encoded timestamp. */
function wallPrefix(wall: number): string {
  return String(Math.max(0, wall)).padStart(16, '0');
}

/**
 * Every well-formed event recorded in `folded` whose wall lies within
 * `bounds`, in no particular order. Reads `db` as it is (the caller
 * provides the transaction or snapshot).
 */
export function recordedPositions(db: DatabaseSync, bounds: WallBounds = {}): RecordedPosition[] {
  const where = ['position IS NOT NULL'];
  const params: string[] = [];
  if (bounds.effectiveOnly === true) {
    where.push('folded = 1');
  }
  if (bounds.minWall !== undefined) {
    where.push('substr(position, 1, 16) >= ?');
    params.push(wallPrefix(bounds.minWall));
  }
  if (bounds.maxWall !== undefined) {
    where.push('substr(position, 1, 16) <= ?');
    params.push(wallPrefix(bounds.maxWall));
  }
  return db
    .prepare(`SELECT hash, folded, position FROM folded WHERE ${where.join(' AND ')}`)
    .all(...params)
    .map((row) => ({
      hash: String(row.hash),
      ts: decodeHlc(String(row.position)),
      effective: row.folded === 1,
    }));
}

/** The position of one recorded well-formed event, or null. */
export function recordedPosition(db: DatabaseSync, hash: string): RecordedPosition | null {
  const row = db
    .prepare('SELECT hash, folded, position FROM folded WHERE hash = ? AND position IS NOT NULL')
    .get(hash);
  return row === undefined
    ? null
    : { hash, ts: decodeHlc(String(row.position)), effective: row.folded === 1 };
}

/**
 * The effective events (`folded` 1) whose hash is not in `known`, in no
 * particular order. Only those rows have their position decoded.
 */
export function effectiveExcept(
  db: DatabaseSync,
  known: ReadonlySet<string>,
): { hash: string; ts: Hlc }[] {
  const out: { hash: string; ts: Hlc }[] = [];
  for (const row of db
    .prepare('SELECT hash, position FROM folded WHERE folded = 1 AND position IS NOT NULL')
    .all()) {
    const hash = String(row.hash);
    if (!known.has(hash)) {
      out.push({ hash, ts: decodeHlc(String(row.position)) });
    }
  }
  return out;
}

/**
 * `PRAGMA data_version` of the connection: changes whenever another
 * connection commits to the database (never for this connection's own
 * commits).
 */
export function dataVersion(db: DatabaseSync): number {
  return Number(db.prepare('PRAGMA data_version').get()?.data_version);
}

/**
 * The change marker of `watch` and the board feed: `PRAGMA data_version`
 * (moves when another connection commits) and `total_changes()` (moves
 * when this connection changes rows, including commits by other callers
 * sharing the `Board`, which `data_version` never counts). Reads no table.
 */
export function changeMarker(db: DatabaseSync): string {
  const row = db.prepare('SELECT total_changes() AS n').get();
  return `${String(dataVersion(db))}:${String(row?.n)}`;
}
