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
 * is older than the window), or an old event that a refold turns from
 * rejected into effective, is caught when it is folded: whatever changes
 * `folded` (catch-up in any command, or `rebuild`) calls
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

import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

import { compareHlc, type Hlc } from '../events/hlc.js';
import { recordedPositions } from './folded.js';

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
   * Empty for a cursor that never delivered anything. A reset
   * (`resetLateCursors`) keeps the seen set unchanged, including a reset to
   * a null position, so `position` null with a non-empty `seen` is a valid,
   * stored state.
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
  return compareHlc(a.ts, b.ts) || compareText(a.hash, b.hash);
}

/**
 * The stored cursor of `actor`, or the empty cursor (`position` null, `seen`
 * empty) when the actor has no `cursors` row. Reads on `db` as it is: the
 * caller provides the transaction or snapshot.
 */
export function readCursor(db: DatabaseSync, actor: string): Cursor {
  const row = db
    .prepare('SELECT last_wall, last_counter, last_actor, last_hash FROM cursors WHERE actor = ?')
    .get(actor);
  if (row === undefined) {
    return { actor, position: null, seen: [] };
  }
  const position = rowPosition(row);
  const seen = db
    .prepare('SELECT hash, wall FROM cursor_seen WHERE actor = ?')
    .all(actor)
    .map((r) => ({ hash: String(r.hash), wall: Number(r.wall) }));
  return { actor, position, seen: sortSeen(seen) };
}

/**
 * Stores `cursor`: upserts the actor's `cursors` row from `cursor.position`
 * (all four columns null when it is null) and makes the actor's
 * `cursor_seen` rows equal to `cursor.seen`. The update is incremental:
 * rows whose hash is in both the stored and the new seen set are left
 * untouched (same row, same rowid), hashes no longer in the set are
 * deleted and new ones inserted, so an advance costs the size of the
 * change, not of the whole set. The caller holds the write transaction.
 * Never touches another actor's rows or any derived table.
 */
export function writeCursor(db: DatabaseSync, cursor: Cursor): void {
  const p = cursor.position;
  db.prepare(
    `INSERT INTO cursors (actor, last_wall, last_counter, last_actor, last_hash)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (actor) DO UPDATE SET
       last_wall = excluded.last_wall, last_counter = excluded.last_counter,
       last_actor = excluded.last_actor, last_hash = excluded.last_hash`,
  ).run(
    cursor.actor,
    p?.ts.wall ?? null,
    p?.ts.counter ?? null,
    p?.ts.actor ?? null,
    p?.hash ?? null,
  );
  db.prepare('DELETE FROM cursor_seen WHERE actor = ?').run(cursor.actor);
  const insert = db.prepare('INSERT INTO cursor_seen (actor, hash, wall) VALUES (?, ?, ?)');
  for (const s of cursor.seen) {
    insert.run(cursor.actor, s.hash, s.wall);
  }
}

/**
 * The delivery rule. True when an effective event at `event` is due to the
 * cursor's actor:
 *
 * - false when `event.hash` is in `cursor.seen`;
 * - otherwise true when `cursor.position` is null;
 * - otherwise false when `event` is the position itself (equal hash and
 *   timestamp): a position is always an effective event that was
 *   delivered (an advance only moves it onto a delivered event, and a
 *   reset only onto an effective one, which the delivery invariant says
 *   was delivered), even if it has since left the seen set;
 * - otherwise true when `event` sorts after `cursor.position`;
 * - otherwise (at or before the position) true exactly when
 *   `event.ts.wall >= cursor.position.ts.wall - SEEN_WINDOW_MS`: a late
 *   event inside the window that the actor has not seen. Older events are
 *   never due here; `resetLateCursors` handles them when they are folded.
 *
 * Membership in the seen set is a constant-time lookup (a `Set` of the
 * hashes, built once per cursor, not a scan of `cursor.seen` per call), so
 * listing the pending events of a board is linear in the events examined.
 *
 * Pure.
 */
export function isPending(cursor: Cursor, event: CursorPosition): boolean {
  if (cursor.seen.some((s) => s.hash === event.hash)) {
    return false;
  }
  const position = cursor.position;
  if (position === null) {
    return true;
  }
  const order = comparePositions(event, position);
  if (order === 0) {
    return false;
  }
  return order > 0 || event.ts.wall >= position.ts.wall - SEEN_WINDOW_MS;
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
  const last = delivered.at(-1);
  if (last === undefined) {
    return { actor: cursor.actor, position: cursor.position, seen: [...cursor.seen] };
  }
  const position =
    cursor.position !== null && comparePositions(cursor.position, last) > 0
      ? cursor.position
      : last;
  const floor = position.ts.wall - SEEN_WINDOW_MS;
  const byHash = new Map<string, number>();
  for (const s of cursor.seen) {
    byHash.set(s.hash, s.wall);
  }
  for (const d of delivered) {
    byHash.set(d.hash, d.ts.wall);
  }
  const seen = [...byHash]
    .filter(([, wall]) => wall >= floor)
    .map(([hash, wall]) => ({ hash, wall }));
  return { actor: cursor.actor, position, seen: sortSeen(seen) };
}

/**
 * Moves back every cursor that an event slipped behind unseen.
 * Called, under the write lock, by whatever changes `folded` (catch-up and
 * `rebuild`), after the derived rows are up to date, with `arrived`: every
 * event that became effective in that call, that is every event it
 * recorded for the first time as applied (`folded` 1), plus every event
 * already recorded whose `folded` flag went from 0 to 1 in a refold (a previously rejected event made effective by a
 * late event, for example a comment rejected as `unknown-ticket` until its
 * ticket's late `ticket.create` arrived); in any order. The command
 * transaction's own event never needs it, since it sorts after every folded
 * event. Events recorded as rejected, unknown kind or malformed are not
 * passed: they are not effective, and if a later arrival makes one
 * effective, that refold passes it then.
 *
 * Board-concurrency ("Inbox never misses an event"): whenever an event
 * becomes effective at a position behind an actor's cursor and outside its
 * seen window, that cursor is moved back so the event is delivered.
 *
 * For each stored cursor with a position `P`, the events of `arrived` that
 * sort before `P` with `ts.wall < P.ts.wall - SEEN_WINDOW_MS` are late for
 * that actor (later-arriving events inside the window are left to
 * `isPending`). Exactly at the boundary, `ts.wall === P.ts.wall -
 * SEEN_WINDOW_MS`, an event is inside the window and not late; one
 * millisecond older is late. When there is at least one, the cursor's
 * position is set to the greatest EFFECTIVE event (a `folded` row with
 * `folded` 1) that sorts strictly before the earliest late event, or to
 * null when there is none; its seen set is kept unchanged. Never onto a
 * rejected, unknown-kind or malformed event: such an event was never
 * delivered, and if it later became effective, `isPending` (which treats
 * the position as delivered) would skip it for good. The late
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
  if (arrived.length === 0) {
    return [];
  }
  const ordered = [...new Map(arrived.map((a) => [a.hash, a])).values()].sort(comparePositions);
  const rows = db
    .prepare('SELECT actor, last_wall, last_counter, last_actor, last_hash FROM cursors')
    .all();
  const cursors = rows
    .map((row) => ({ actor: String(row.actor), position: rowPosition(row) }))
    .sort((a, b) => compareText(a.actor, b.actor));
  const found: LateEvent[] = [];
  const move = db.prepare(
    `UPDATE cursors SET last_wall = ?, last_counter = ?, last_actor = ?, last_hash = ?
     WHERE actor = ?`,
  );
  for (const { actor, position } of cursors) {
    if (position === null) {
      continue;
    }
    const floor = position.ts.wall - SEEN_WINDOW_MS;
    const late = ordered.filter(
      (event) => comparePositions(event, position) < 0 && event.ts.wall < floor,
    );
    const earliest = late[0];
    if (earliest === undefined) {
      continue;
    }
    const back = positionBefore(db, earliest);
    move.run(
      back?.ts.wall ?? null,
      back?.ts.counter ?? null,
      back?.ts.actor ?? null,
      back?.hash ?? null,
      actor,
    );
    for (const event of late) {
      found.push({ actor, hash: event.hash, ts: event.ts, cursor: position });
    }
  }
  return found;
}

/** `<` order on strings (UTF-16 code units), as -1, 0 or 1. */
function compareText(a: string, b: string): -1 | 0 | 1 {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/** A seen set sorted by hash. */
function sortSeen(seen: SeenHash[]): SeenHash[] {
  return seen.sort((a, b) => compareText(a.hash, b.hash));
}

/** The position stored in a `cursors` row, or null when its columns are null. */
function rowPosition(row: Record<string, SQLOutputValue>): CursorPosition | null {
  const { last_wall: wall, last_counter: counter, last_actor: actor, last_hash: hash } = row;
  if (
    typeof wall !== 'number' ||
    typeof counter !== 'number' ||
    typeof actor !== 'string' ||
    typeof hash !== 'string'
  ) {
    return null;
  }
  return { hash, ts: { wall, counter, actor } };
}

/**
 * The greatest effective event (`folded` 1) recorded in `folded` that sorts
 * strictly before `event`, or null when there is none. Rejected,
 * unknown-kind and malformed events are never returned (see
 * `resetLateCursors`).
 */
function positionBefore(db: DatabaseSync, event: CursorPosition): CursorPosition | null {
  let best: CursorPosition | null = null;
  for (const recorded of recordedPositions(db, { maxWall: event.ts.wall })) {
    const candidate = { hash: recorded.hash, ts: recorded.ts };
    if (
      comparePositions(candidate, event) < 0 &&
      (best === null || comparePositions(candidate, best) > 0)
    ) {
      best = candidate;
    }
  }
  return best;
}
