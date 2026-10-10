/**
 * The ticket as the JSON documents of the CLI (`--json`), the MCP tools and
 * the web API carry it.
 */

import type { Ticket } from '../events/fold.js';

/**
 * A ticket in a JSON document: the folded `Ticket` without `available`.
 * `available` is internal fold state (when the ticket became available, for
 * deriving grants), kept in the fold and the cache but not part of the
 * specified output.
 */
export type TicketDocument = Omit<Ticket, 'available'>;

/** A copy of `ticket` without `available`, sharing its other values. */
export function ticketDocument(ticket: Ticket): TicketDocument {
  const document: TicketDocument & Partial<Pick<Ticket, 'available'>> = { ...ticket };
  delete document.available;
  return document;
}
