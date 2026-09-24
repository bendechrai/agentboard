/**
 * Fixture builders for the view-model tests: events built with explicit
 * walls, folded with the store's own pure fold, and turned into the
 * `EventView` list (with outcomes) and tickets a snapshot would give.
 */

import type { JsonValue } from '../../events/json.js';
import {
  applyEvent,
  compareFoldOrder,
  type BoardState,
  type FoldInput,
  type Ticket,
} from '../../events/fold.js';
import type {
  BoardEvent,
  Status,
  TaskRef,
  TicketChecklistAddItem,
  TicketCloseBody,
  TicketCreateBody,
  TicketLinkBody,
} from '../../events/schema.js';
import type { BoardModel, EventView } from '../types.js';

export const T1 = '01ARYZ6S41TSV4RRFFQ69G5FAV';
export const T2 = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
export const T3 = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
export const T4 = '01C0000000ACTAV9WEVGEMMVRZ';
export const T5 = '01D0000000ACTAV9WEVGEMMVRZ';
export const T6 = '01E0000000ACTAV9WEVGEMMVRZ';
export const T7 = '01F0000000ACTAV9WEVGEMMVRZ';

export const TASK: TaskRef = { source: 'openspec', ref: 'add-board-web', item: '1' };
export const TASK2: TaskRef = { source: 'openspec', ref: 'add-board-web', item: '2' };
export const OTHER: TaskRef = { source: 'openspec', ref: 'add-board-tui', item: '1' };

/** Options for one built event. */
export interface Opts {
  /** Defaults to `orch`. */
  actor?: string;
  /** Defaults to 10 more than the previous event built (starting at 1000000). */
  wall?: number;
  counter?: number;
}

let seq = 0;
let lastWall = 1_000_000;

/** A fresh 64-character lowercase hex hash, unique per built event. */
function nextHash(): string {
  seq += 1;
  return seq.toString(16).padStart(64, '0');
}

function stamp(o: Opts): { actor: string; ts: { wall: number; counter: number; actor: string } } {
  const actor = o.actor ?? 'orch';
  const wall = o.wall ?? lastWall + 10;
  lastWall = Math.max(lastWall, wall);
  return { actor, ts: { wall, counter: o.counter ?? 0, actor } };
}

function input(event: BoardEvent): FoldInput {
  return { hash: nextHash(), event };
}

/** Event builders, one per kind. */
export const E = {
  create(ticket: string, body: TicketCreateBody, o: Opts = {}): FoldInput {
    return input({ v: 1, kind: 'ticket.create', ticket, ...stamp(o), body });
  },
  comment(ticket: string, text: string, o: Opts = {}): FoldInput {
    return input({ v: 1, kind: 'ticket.comment', ticket, ...stamp(o), body: { text } });
  },
  move(ticket: string, to: Status, o: Opts = {}): FoldInput {
    return input({ v: 1, kind: 'ticket.move', ticket, ...stamp(o), body: { to } });
  },
  assign(ticket: string, to: string, o: Opts = {}): FoldInput {
    return input({ v: 1, kind: 'ticket.assign', ticket, ...stamp(o), body: { to } });
  },
  claim(ticket: string, o: Opts = {}): FoldInput {
    return input({ v: 1, kind: 'ticket.claim', ticket, ...stamp(o), body: {} });
  },
  release(ticket: string, o: Opts = {}): FoldInput {
    return input({ v: 1, kind: 'ticket.release', ticket, ...stamp(o), body: {} });
  },
  handoff(ticket: string, to: string, status: Status, note: string, o: Opts = {}): FoldInput {
    return input({
      v: 1,
      kind: 'ticket.handoff',
      ticket,
      ...stamp(o),
      body: { to, status, note },
    });
  },
  link(ticket: string, body: TicketLinkBody, o: Opts = {}): FoldInput {
    return input({ v: 1, kind: 'ticket.link', ticket, ...stamp(o), body });
  },
  close(ticket: string, body: TicketCloseBody, o: Opts = {}): FoldInput {
    return input({ v: 1, kind: 'ticket.close', ticket, ...stamp(o), body });
  },
  check(ticket: string, index: number, done: boolean, o: Opts = {}): FoldInput {
    return input({ v: 1, kind: 'ticket.checklist', ticket, ...stamp(o), body: { index, done } });
  },
  addLines(ticket: string, items: TicketChecklistAddItem[], o: Opts = {}): FoldInput {
    return input({ v: 1, kind: 'ticket.checklist.add', ticket, ...stamp(o), body: { items } });
  },
  meta(key: string, value: JsonValue, o: Opts = {}): FoldInput {
    return input({ v: 1, kind: 'board.meta', ...stamp(o), body: { key, value } });
  },
  unknown(ticket: string | null, o: Opts = {}): FoldInput {
    const base = { v: 1 as const, kind: 'ticket.future', ...stamp(o), body: { x: 1 } };
    return { hash: nextHash(), event: ticket === null ? base : { ...base, ticket } };
  },
};

/**
 * Folds `inputs` one event at a time in fold order with `applyEvent`,
 * recording each event's outcome, and returns the model a snapshot of that
 * board would give. `head` is the greatest applied event; `id` is a
 * placeholder (position ids belong to the feed); `late` is as given.
 */
export function model(inputs: readonly FoldInput[], late: string[] = []): BoardModel {
  const ordered = [...inputs].sort(compareFoldOrder);
  const state: BoardState = { tickets: {}, meta: {} };
  const events: EventView[] = [];
  let head: string | null = null;
  for (const { hash, event } of ordered) {
    const outcome = applyEvent(state, { hash, event });
    const ticket = 'ticket' in event && event.ticket !== undefined ? event.ticket : null;
    const base = { hash, kind: event.kind, ticket, actor: event.actor, ts: { ...event.ts }, event };
    if (outcome.status === 'applied') {
      head = hash;
      events.push({ ...base, outcome: 'applied', reason: null });
    } else if (outcome.status === 'rejected') {
      events.push({ ...base, outcome: 'rejected', reason: outcome.rejected.reason });
    } else {
      events.push({ ...base, outcome: 'unknown', reason: null });
    }
  }
  return {
    tickets: state.tickets,
    meta: state.meta,
    events,
    head,
    id: `${head ?? 'none'}.${'0'.repeat(64)}`,
    late,
  };
}

/** The ticket `id` of `m`, failing the test when it is missing. */
export function ticketOf(m: BoardModel, id: string): Ticket {
  const ticket = m.tickets[id];
  if (ticket === undefined) {
    throw new Error(`fixture has no ticket ${id}`);
  }
  return ticket;
}
