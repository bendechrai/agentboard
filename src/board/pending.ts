/**
 * Building inbox entries, shared by `inbox` and `watch`. Internal: not
 * re-exported from `src/index.ts`.
 */

import type { DatabaseSync } from 'node:sqlite';

import { isKnownEvent, type BoardEvent } from '../events/schema.js';
import type { Board } from '../store/board.js';
import {
  SEEN_WINDOW_MS,
  comparePositions,
  isPending,
  type Cursor,
  type CursorPosition,
} from '../store/cursors.js';
import { BoardError } from '../store/errors.js';
import type { ReadOutcome } from '../store/eventfile.js';
import { recordedPositions } from '../store/folded.js';
import type { InboxEntry } from './inbox.js';

/** Reads one event file (the contract of `readEventFile`). */
export type EventReader = (eventsDir: string, name: string) => ReadOutcome;

/** The effective events pending for `cursor`, in no particular order. */
export function pendingPositions(db: DatabaseSync, cursor: Cursor): CursorPosition[] {
  // Nothing older than the window before the position can be pending.
  const minWall = cursor.position === null ? undefined : cursor.position.ts.wall - SEEN_WINDOW_MS;
  return recordedPositions(db, { effectiveOnly: true, minWall })
    .filter((p) => isPending(cursor, p))
    .map(({ hash, ts }) => ({ hash, ts }));
}

/**
 * Sorts `positions` in fold order and reads each event file (once, through
 * `read`) into an entry.
 */
export function toEntries(
  board: Board,
  positions: CursorPosition[],
  read: EventReader,
): InboxEntry[] {
  return positions.sort(comparePositions).map((p) => toEntry(board, p.hash, read));
}

/** The inbox entry of the effective event `hash`, read from its file. */
function toEntry(board: Board, hash: string, read: EventReader): InboxEntry {
  const outcome = read(board.eventsDir, `${hash}.json`);
  if (outcome.status !== 'ok' || !isKnownEvent(outcome.input.event)) {
    throw new BoardError(
      5,
      'integrity',
      `event ${hash} is recorded as applied but its file is not a well-formed known event`,
    );
  }
  return entryOf(hash, outcome.input.event);
}

/** Lifts the fields an orchestrator acts on out of `event`. */
function entryOf(hash: string, event: BoardEvent): InboxEntry {
  const entry: InboxEntry = {
    hash,
    kind: event.kind,
    ticket: event.kind === 'board.meta' ? null : event.ticket,
    from: event.actor,
    ts: event.ts,
    to: null,
    status: null,
    note: null,
    event,
  };
  switch (event.kind) {
    case 'ticket.handoff':
      return { ...entry, to: event.body.to, status: event.body.status, note: event.body.note };
    case 'ticket.assign':
      return { ...entry, to: event.body.to };
    case 'ticket.move':
      return { ...entry, status: event.body.to };
    case 'ticket.comment':
      return { ...entry, note: event.body.text };
    default:
      return entry;
  }
}
