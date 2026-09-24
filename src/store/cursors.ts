/**
 * Per-actor inbox cursors (board-concurrency: "Inbox never misses an
 * event"; board-cache: "Cache is derived and disposable"; design.md:
 * "Cursors as position plus seen set").
 *
 * A cursor records what one actor has acknowledged through `inbox`. It is
 * the only state in the cache that cannot be derived from the event files,
 * so losing it (a deleted cache, a schema version change) only causes
 * events to be delivered again, never skipped.
 *
 * A cursor is a fold position (the last delivered event) plus a bounded
 * seen set: the hashes of the events delivered to the actor whose wall is
 * within `SEEN_WINDOW_MS` before the position's wall. A synced event with
 * an earlier timestamp than the position is still delivered, because its
 * hash is not in the seen set. An event that arrives even later (its wall
 * is older than the window) is caught when it is folded: whatever records
 * it in `folded` (catch-up in any command, or `rebuild`) calls
 * `resetLateCursors`, which moves the affected cursors back so the event is
 * delivered, and `rebuild` reports it.
 *
 * Storage. The position is the `cursors` row of the actor (columns as in
 * board-cache: `last_wall`, `last_counter`, `last_actor` hold the
 * position's timestamp and `last_hash` its hash; all four are null for a
 * cursor with no position). The seen set lives in a second table next to
 * it, `cursor_seen`:
 *
 * ```sql
 * CREATE TABLE cursor_seen (
 *   actor TEXT NOT NULL,
 *   hash  TEXT NOT NULL,
 *   wall  INTEGER NOT NULL,       -- ts.wall of the event, for pruning
 *   PRIMARY KEY (actor, hash)
 * );
 * ```
 *
 * `cursor_seen` is treated exactly like `cursors`: `openCache` creates it
 * (with `CREATE TABLE IF NOT EXISTS` on every open, so a cache created
 * before this table existed gains it without a schema version change) and
 * drops it with every other table when the schema version differs;
 * `rebuild` keeps its rows; `dumpCache`, `diffCaches` and `rebuild --check`
 * do not cover it. A cursor with no `cursors` row is the empty cursor
 * (position null, empty seen set); stray `cursor_seen` rows of an actor with
 * no `cursors` row are ignored.
 *
 * Fold order of positions is the fold's own: `compareHlc` on `ts`, then the
 * hash as a string.
 */

import type { DatabaseSync } from 'node:sqlite';

import type { Hlc } from '../events/hlc.js';

/** Width of the seen-set window in wall milliseconds: one hour. */
export const SEEN_WINDOW_MS = 3_600_000;

/** A fold position: an event's hash and timestamp. */
export interface CursorPosition {
  hash: string;
  ts: Hlc;
}

/** One member of a seen set: an event hash and its `ts.wall`. */
export interface SeenHash {
  hash: string;
  wall: number;
}

/** One actor's cursor. */
export interface Cursor {
  actor: string;
  /** The last delivered event, or null before the first delivery. */
  position: CursorPosition | null;
  /**
   * Delivered events within the window, sorted by hash, no duplicates.
   * Empty when `position` is null.
   */
  seen: SeenHash[];
}

/** An event found to have arrived after an actor's cursor had moved past it. */
export interface LateEvent {
  /** The actor whose cursor was reset. */
  actor: string;
  /** The late event. */
  hash: string;
  ts: Hlc;
  /** The actor's position before the reset. */
  cursor: CursorPosition;
}

/**
 * Compares two positions in fold order: `compareHlc(a.ts, b.ts)`, then the
 * hashes as strings. 0 only for equal hash and timestamp. Pure.
 */
export function comparePositions(a: CursorPosition, b: CursorPosition): -1 | 0 | 1 {
  void a;
  void b;
  throw new Error('not implemented');
}

/**
 * The stored cursor of `actor`, or the empty cursor (`position` null, `seen`
 * empty) when the actor has no `cursors` row. Reads on `db` as it is: the
 * caller provides the transaction or snapshot.
 */
export function readCursor(db: DatabaseSync, actor: string): Cursor {
  void db;
  void actor;
  throw new Error('not implemented');
}

/**
 * Stores `cursor`: upserts the actor's `cursors` row from `cursor.position`
 * (all four columns null when it is null) and replaces the actor's
 * `cursor_seen` rows with `cursor.seen`. The caller holds the write
 * transaction. Never touches another actor's rows or any derived table.
 */
export function writeCursor(db: DatabaseSync, cursor: Cursor): void {
  void db;
  void cursor;
  throw new Error('not implemented');
}

/**
 * The delivery rule. True when an effective event at `event` is due to the
 * cursor's actor:
 *
 * - false when `event.hash` is in `cursor.seen`;
 * - otherwise true when `cursor.position` is null;
 * - otherwise true when `event` sorts after `cursor.position`;
 * - otherwise (at or before the position) true exactly when
 *   `event.ts.wall >= cursor.position.ts.wall - SEEN_WINDOW_MS`: a late
 *   event inside the window that the actor has not seen. Older events are
 *   never due here; `resetLateCursors` handles them when they are folded.
 *
 * Pure.
 */
export function isPending(cursor: Cursor, event: CursorPosition): boolean {
  void cursor;
  void event;
  throw new Error('not implemented');
}

/**
 * The cursor after delivering `delivered` (the returned entries, in fold
 * order). Pure; returns `cursor` unchanged (an equal value) when
 * `delivered` is empty.
 *
 * - `position` becomes the greater, in fold order, of the old position and
 *   the last delivered event, so delivering only late events never moves a
 *   cursor backwards.
 * - `seen` becomes the old seen set plus every delivered event, then
 *   pruned to the members whose `wall >= position.ts.wall -
 *   SEEN_WINDOW_MS` (with the new position), sorted by hash, without
 *   duplicates.
 */
export function advanceCursor(cursor: Cursor, delivered: readonly CursorPosition[]): Cursor {
  void cursor;
  void delivered;
  throw new Error('not implemented');
}

/**
 * Moves back every cursor that an arriving event slipped behind unseen.
 * Called, under the write lock, by whatever records events in `folded` for
 * the first time (catch-up and `rebuild`), after the derived rows are up to
 * date, with the well-formed events it newly recorded (applied, rejected
 * or unknown kind; in any order). The command transaction's own event
 * never needs it, since it sorts after every folded event.
 *
 * For each stored cursor with a position `P`, the events of `arrived` that
 * sort before `P` with `ts.wall < P.ts.wall - SEEN_WINDOW_MS` are late for
 * that actor (later-arriving events inside the window are left to
 * `isPending`). When there is at least one, the cursor's position is set to
 * the greatest well-formed event recorded in `folded` (a row with a
 * non-null position) that sorts strictly before the earliest late event, or
 * to null when there is none; its seen set is kept unchanged. The late
 * event is therefore due again, and so is anything between the new and the
 * old position that is not in the seen set (redelivery, never a skip).
 *
 * Returns one `LateEvent` per (actor, late event), sorted by actor then
 * fold order of the event; empty when nothing was late. Changes no other
 * rows.
 */
export function resetLateCursors(
  db: DatabaseSync,
  arrived: readonly CursorPosition[],
): LateEvent[] {
  void db;
  void arrived;
  throw new Error('not implemented');
}
