/**
 * Board columns and cards (board-view-model: "Board columns and cards").
 * Pure and browser-safe; see `types.ts`.
 */

import type { Ticket } from '../events/fold.js';
import type { Status } from '../events/schema.js';

/**
 * The board's column order. Not `STATUSES` order: `blocked` comes before
 * the terminal `merged` column.
 */
export const BOARD_COLUMNS: readonly Status[] = [
  'todo',
  'tests',
  'implementing',
  'review',
  'blocked',
  'merged',
];

/** A card counts as changed while `now - updatedAt.wall` is below this (5 seconds). */
export const CHANGED_WINDOW_MS = 5000;

/** Number of leading id characters shown as a card's short id. */
export const SHORT_ID_LENGTH = 10;

/** One ticket as a card on the board or in an agent lane. */
export interface Card {
  /** The full ticket id. */
  id: string;
  /** The first `SHORT_ID_LENGTH` (10) characters of the id. */
  shortId: string;
  title: string;
  /** The ticket's current status (the column it belongs to). */
  status: Status;
  /** The assignee, or null when unassigned. */
  assignee: string | null;
  /**
   * The task reference in text form `<source>:<ref>#<item>` (as
   * `formatTaskRef`), or null when the ticket has no task.
   */
  task: string | null;
  /** The ad hoc marker: true when the ticket has an ad hoc reason (`Ticket.adhoc` not null). */
  adhoc: boolean;
  /** A copy of the ticket's labels, in order. */
  labels: string[];
  /** Checklist progress: lines done and the total number of lines. */
  checklist: { done: number; total: number };
  /** While blocked, the status it was blocked from (`Ticket.blockedFrom`); else null. */
  blockedFrom: Status | null;
  closed: boolean;
  /** `openDecisions(ticket.comments).length` (see `src/events/decisions.ts`). */
  openDecisions: number;
  /**
   * True when the ticket changed within the last 5 seconds before `now`:
   * `now - ticket.updatedAt.wall < CHANGED_WINDOW_MS`. A wall in the future
   * (a negative difference) counts as changed.
   */
  changed: boolean;
}

/** One board column: a status and its cards. */
export interface Column {
  status: Status;
  cards: Card[];
}

/**
 * Filters for `boardColumns`; every filter given must match (AND). An
 * absent filter matches every ticket.
 */
export interface BoardFilters {
  /**
   * Task reference filter. `<source>:<ref>#<item>` (any text that
   * `parseTaskRef` accepts) matches tickets whose task has exactly that
   * source, ref and item. Otherwise the text is split at its first `:` into
   * `<source>` and `<ref>` and matches tickets whose task has that source
   * and ref, whatever the item. Text with no `:` matches no ticket. A
   * ticket with no task never matches.
   */
  task?: string;
  /** Matches tickets whose assignee is exactly this actor. */
  assignee?: string;
  /** When true, closed tickets are included; by default they are left out. */
  includeClosed?: boolean;
}

/**
 * The card of one ticket at time `now` (milliseconds since the Unix
 * epoch), with every field as documented on `Card`.
 */
export function ticketCard(ticket: Ticket, now: number): Card {
  throw new Error(`not implemented: ticketCard(${ticket.id}, ${String(now)})`);
}

/**
 * The board: exactly one column per status, in `BOARD_COLUMNS` order,
 * always all six (a column with no matching ticket has no cards). Each
 * column holds `ticketCard(ticket, now)` for every ticket in that status
 * that passes `filters`, most recently updated first: descending by
 * `updatedAt` compared as `compareHlc` does (wall, then counter, then
 * actor), and by ascending id (string order) when two `updatedAt` are
 * equal. Closed tickets are left out unless `filters.includeClosed` is
 * true. The key under which a ticket is stored is ignored; `Ticket.id` is
 * used.
 */
export function boardColumns(
  tickets: Readonly<Record<string, Ticket>>,
  now: number,
  filters: BoardFilters = {},
): Column[] {
  throw new Error(
    `not implemented: boardColumns(${String(Object.keys(tickets).length)}, ${String(now)}, ${String(Object.keys(filters).length)})`,
  );
}
