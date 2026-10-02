/**
 * Ticket lookup shared by the board operations. Internal: not re-exported
 * from `src/index.ts`.
 */

import type { DatabaseSync } from 'node:sqlite';

import type { Ticket } from '../events/fold.js';
import { readTicket } from '../store/cache.js';
import { stmt } from '../store/engine.js';
import { BoardError } from '../store/errors.js';
import { resolveTicketId } from './resolve.js';

/**
 * Resolves `text` (a full id or a prefix) with `resolveTicketId` against
 * the ticket ids in the cache and returns the ticket. Only the ids that
 * start with the upper-cased text are read, which is all `resolveTicketId`
 * looks at, so the result and every refusal are exactly those of
 * `resolveTicketId` over the whole state. Reads on `db` as it is: the
 * caller provides the transaction or snapshot.
 */
export function resolveTicket(db: DatabaseSync, text: string): Ticket {
  const wanted = text.toUpperCase();
  const tickets: Record<string, Ticket> = {};
  const rows = stmt(db, 'SELECT id FROM tickets WHERE substr(id, 1, ?) = ?').all(
    wanted.length,
    wanted,
  );
  for (const row of rows) {
    const id = String(row.id);
    // resolveTicketId reads only the keys of `tickets`.
    tickets[id] = { id } as Ticket;
  }
  const id = resolveTicketId({ tickets, meta: {} }, text);
  const ticket = readTicket(db, id);
  if (ticket === null) {
    throw new Error(`ticket ${id} vanished from the cache while it was read`);
  }
  return ticket;
}

/** `BoardError(1, 'missing-actor')` for an empty actor, before anything else. */
export function requireActor(actor: string): void {
  if (actor === '') {
    throw new BoardError(1, 'missing-actor', 'an actor is required to write to the board');
  }
}

/** The ticket of a `runCommand` result, which is null only for `board.meta`. */
export function ticketOf(ticket: Ticket | null): Ticket {
  if (ticket === null) {
    throw new Error('a ticket event produced no ticket');
  }
  return ticket;
}
