/**
 * Agent lanes (board-view-model: "Agent lanes"). Pure and browser-safe;
 * see `types.ts`. "Last seen" is derived from events only; no presence
 * event exists.
 */

import type { Ticket } from '../events/fold.js';
import type { Hlc } from '../events/hlc.js';
import { ticketCard, type Card } from './columns.js';
import { byRecentUpdate, compareStrings } from './order.js';
import type { BoardModel, EventView } from './types.js';

/** The last applied event of an actor. */
export interface LaneEvent {
  hash: string;
  kind: string;
  /** The event's ticket, or null (`board.meta`). */
  ticket: string | null;
  ts: Hlc;
}

/** One actor's lane. */
export interface Lane {
  actor: string;
  /**
   * `ticketCard(ticket, now)` for every open (not closed) ticket whose
   * assignee is this actor, in the card order of `boardColumns` (most
   * recently updated first, then ascending id).
   */
  tickets: Card[];
  /** The actor's last applied event in fold order, or null when it has written none. */
  lastEvent: LaneEvent | null;
  /**
   * `now - lastEvent.ts.wall`, or 0 when that is negative (a wall in the
   * future); null when `lastEvent` is null.
   */
  lastSeenMs: number | null;
}

/**
 * One lane per actor that wrote an applied event (of any kind,
 * `board.meta` included) or is the assignee of an open ticket, and no
 * other. Order: lanes with a last event first, by that event in reverse
 * fold order (the actor who wrote most recently first); then lanes with
 * no last event, by actor name ascending (string order). Rejected and
 * unknown-kind events neither create a lane nor count as a last event.
 * `now` is milliseconds since the Unix epoch.
 */
export function agentLanes(model: Pick<BoardModel, 'events' | 'tickets'>, now: number): Lane[] {
  const last = new Map<string, { index: number; view: EventView }>();
  model.events.forEach((view, index) => {
    if (view.outcome === 'applied') {
      last.set(view.actor, { index, view });
    }
  });
  const assigned = new Map<string, Ticket[]>();
  for (const ticket of Object.values(model.tickets)) {
    if (!ticket.closed && ticket.assignee !== null) {
      const list = assigned.get(ticket.assignee) ?? [];
      list.push(ticket);
      assigned.set(ticket.assignee, list);
    }
  }
  const actors = [...new Set([...last.keys(), ...assigned.keys()])];
  actors.sort((a, b) => {
    const la = last.get(a)?.index ?? -1;
    const lb = last.get(b)?.index ?? -1;
    return lb - la || compareStrings(a, b);
  });
  return actors.map((actor) => {
    const view = last.get(actor)?.view;
    const tickets = (assigned.get(actor) ?? []).sort(byRecentUpdate).map((t) => ticketCard(t, now));
    if (view === undefined) {
      return { actor, tickets, lastEvent: null, lastSeenMs: null };
    }
    return {
      actor,
      tickets,
      lastEvent: { hash: view.hash, kind: view.kind, ticket: view.ticket, ts: view.ts },
      lastSeenMs: Math.max(0, now - view.ts.wall),
    };
  });
}
