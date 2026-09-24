/**
 * Folding the event log into board state (board-events: "Deterministic
 * ordering", "Fold semantics", "Unknown kinds are preserved"; board-cli:
 * "Status state machine", "Claim, release and handoff";
 * board-openspec-integration: "Tickets reference tasks").
 *
 * Pure: the result is a function of the set of inputs only, never of their
 * order in the array or of any clock.
 */

import type { JsonValue } from './canonical.js';
import { compareHlc, type Hlc } from './hlc.js';
import {
  isKnownEvent,
  type BoardEvent,
  type Status,
  type TaskRef,
  type TicketCreateEvent,
  type TicketEvent,
  type UnknownKindEvent,
} from './schema.js';

/**
 * One event to fold, with the lowercase hex SHA-256 of its canonical bytes
 * (its file name without `.json`). The event must already have passed
 * `validateEvent`; the fold does not re-validate it or re-check the hash.
 * Inputs with the same `hash` are the same event: only one is folded and
 * reported.
 */
export interface FoldInput {
  hash: string;
  event: BoardEvent | UnknownKindEvent;
}

/** Why an otherwise well-formed event was not applied. */
export type RejectionReason =
  | 'unknown-ticket'
  | 'duplicate-create'
  | 'invalid-transition'
  | 'already-assigned'
  | 'not-assignee'
  | 'checklist-index'
  | 'needs-task-link';

/** An event the fold refused. It stays in the log and in this report. */
export interface Rejected {
  hash: string;
  kind: string;
  /** The event's ticket id (only ticket kinds can be rejected). */
  ticket: string;
  reason: RejectionReason;
}

/** A well-formed event of a kind this version does not define. */
export interface UnknownReport {
  hash: string;
  kind: string;
  event: UnknownKindEvent;
}

/** A comment on a ticket, from `ticket.comment` or a `ticket.handoff` note. */
export interface TicketComment {
  /** Actor of the event that added it. */
  actor: string;
  /** `ts` of that event. */
  ts: Hlc;
  /** The comment text, or the handoff note. */
  text: string;
  /** Hash of that event. */
  hash: string;
}

/** A PR or decision link added by `ticket.link` (task links set `task`). */
export type TicketLink =
  | { type: 'pr'; pr: string | number; actor: string; ts: Hlc; hash: string }
  | { type: 'decision'; path: string; actor: string; ts: Hlc; hash: string };

/** One checklist line. */
export interface ChecklistItem {
  text: string;
  done: boolean;
}

/** How a ticket was closed: exactly the body of its `ticket.close` event. */
export type CloseDisposition = { decision: string } | { noDecision: true };

/**
 * Folded state of one ticket. Every field is always present (absent values
 * are `null` or empty arrays, never `undefined`), so the state serializes
 * with `canonicalEncode`.
 */
export interface Ticket {
  id: string;
  title: string;
  /** From create; `null` when not given. */
  description: string | null;
  /** Starts at `todo`. */
  status: Status;
  /** While `status` is `blocked`: the status it was blocked from; else null. */
  blockedFrom: Status | null;
  assignee: string | null;
  /** From create, as given; `[]` when not given. */
  labels: string[];
  /** From create or the latest `ticket.link` with a task; else null. */
  task: TaskRef | null;
  /** From create; cleared to null when a task link is applied. */
  adhoc: string | null;
  /**
   * From create, all `done: false` (`[]` when not given), followed by the
   * items of each applied `ticket.checklist.add`, in fold order.
   */
  checklist: ChecklistItem[];
  /** In fold order. */
  comments: TicketComment[];
  /** PR and decision links in fold order; duplicates are kept. */
  links: TicketLink[];
  closed: boolean;
  /** Set by the applied `ticket.close`; null while open. */
  disposition: CloseDisposition | null;
  /** Actor of the `ticket.create`. */
  createdBy: string;
  /** `ts` of the `ticket.create`. */
  createdAt: Hlc;
  /** Count of applied (not rejected) known-kind events for this ticket, create included. */
  version: number;
  /** `ts` of the last applied known-kind event for this ticket. */
  updatedAt: Hlc;
}

/** Folded board. Plain objects only, so it serializes with `canonicalEncode`. */
export interface BoardState {
  /** Keyed by ticket id. */
  tickets: Record<string, Ticket>;
  /** `board.meta` settings: for each key, the value of the last such event in fold order. */
  meta: Record<string, JsonValue>;
}

/** Result of `fold`. */
export interface FoldResult {
  state: BoardState;
  /** Rejected events, in fold order. */
  rejected: Rejected[];
  /** Unknown-kind events, in fold order. */
  unknown: UnknownReport[];
  /**
   * `ts` of the greatest input in fold order (applied, rejected, unknown or
   * `board.meta` alike), or null for no inputs. This is the `prev` for
   * `nextHlc` when writing the next event.
   */
  latest: Hlc | null;
}

/**
 * Fold order: ascending by `event.ts.wall`, then `event.ts.counter`, then
 * `event.ts.actor` (UTF-16 code unit order), then `hash` (string order).
 * Total for inputs with distinct hashes. Returns 0 only for equal hashes.
 */
export function compareFoldOrder(a: FoldInput, b: FoldInput): -1 | 0 | 1 {
  const byTs = compareHlc(a.event.ts, b.event.ts);
  if (byTs !== 0) {
    return byTs;
  }
  if (a.hash < b.hash) {
    return -1;
  }
  return a.hash > b.hash ? 1 : 0;
}

/** Forward transitions of the state machine; `blocked` is handled separately. */
const FORWARD: Record<Exclude<Status, 'blocked'>, readonly Status[]> = {
  todo: ['tests'],
  tests: ['implementing'],
  implementing: ['review'],
  review: ['implementing', 'tests', 'merged'],
  merged: [],
};

/**
 * Whether the state machine permits moving from `from` to `to`, where
 * `blockedFrom` is the ticket's remembered origin (used only when `from`
 * is `blocked`). Permitted:
 * - `todo` -> `tests`; `tests` -> `implementing`; `implementing` -> `review`;
 * - `review` -> `implementing`, `review` -> `tests`, `review` -> `merged`;
 * - any status except `merged` and `blocked` -> `blocked`;
 * - `blocked` -> `blockedFrom` only.
 * Everything else is refused, including every move to the current status
 * (`from === to`, `blocked` -> `blocked` included) and every move out of
 * `merged` (terminal).
 */
export function isTransitionAllowed(from: Status, to: Status, blockedFrom: Status | null): boolean {
  if (from === 'blocked') {
    return to === blockedFrom;
  }
  if (to === 'blocked') {
    return from !== 'merged';
  }
  return FORWARD[from].includes(to);
}

/**
 * Folds events into board state.
 *
 * Inputs are de-duplicated by `hash`, sorted by `compareFoldOrder`, and
 * applied one at a time against the state produced by all earlier events.
 * An applied known-kind ticket event increments that ticket's `version` and
 * sets its `updatedAt` to the event's `ts`; a rejected event changes nothing
 * and is appended to `rejected`.
 *
 * Per kind, for ticket id `t` (every kind below except `ticket.create` is
 * first rejected with `unknown-ticket` when no ticket `t` exists yet in fold
 * order; it is not re-applied if a create comes later):
 * - `ticket.create`: `duplicate-create` if `t` exists. Otherwise creates the
 *   ticket as documented on `Ticket`, status `todo`, unassigned, version 1.
 * - `ticket.comment`: appends a comment.
 * - `ticket.move`: `invalid-transition` unless `isTransitionAllowed(status,
 *   to, blockedFrom)`; then `needs-task-link` if `to` is `implementing` and
 *   `task` is null. Moving to `blocked` records the previous status in
 *   `blockedFrom`; leaving `blocked` clears it.
 * - `ticket.assign`: sets `assignee` to `body.to` unconditionally.
 * - `ticket.claim`: `already-assigned` if `assignee` is not null (even when
 *   it is the claiming actor); otherwise `assignee` becomes the event actor.
 * - `ticket.release`: `not-assignee` unless `assignee` equals the event
 *   actor (so releasing an unassigned ticket is refused); otherwise
 *   `assignee` becomes null.
 * - `ticket.handoff`: when `body.status` equals the current status (any
 *   status, `blocked` and `merged` included) it is a reassignment: no
 *   transition checks, status and `blockedFrom` untouched. Otherwise the
 *   same checks as a move to `body.status`, in the same order; if either
 *   fails the whole event is rejected and none of its effects apply. When
 *   applied, as one event: `assignee` = `body.to`, status moves as for
 *   `ticket.move` (if it changes), and a comment with `text` = `body.note`
 *   by the event actor is appended. No assign, move or comment event is
 *   synthesized; version goes up by exactly 1.
 * - `ticket.link`: `task` sets `task` (replacing any earlier one) and clears
 *   `adhoc`; `pr` and `decision` append to `links`.
 * - `ticket.close`: `invalid-transition` if the ticket is already closed or
 *   its status is neither `merged` nor `blocked`; otherwise sets `closed`
 *   and `disposition`. Status is unchanged. The fold does not apply the
 *   decision-comment rule; that is the CLI's `close` check. Events after a
 *   close are folded by their own rules.
 * - `ticket.checklist`: `checklist-index` if `index` is negative or not less
 *   than the checklist length; otherwise sets that item's `done` (setting
 *   it to its current value still counts as applied).
 * - `ticket.checklist.add`: appends `body.items` to the checklist in array
 *   order, each as `{ text, done }` copied from the item; never rejected
 *   once the ticket exists (it may be closed), and counts as one applied
 *   event (version goes up by exactly 1, however many items).
 * - `board.meta`: sets `state.meta[key] = value`; never rejected; affects no
 *   ticket.
 * - Unknown kinds: appended to `unknown`; affect no ticket and are never
 *   rejected, whether their `ticket` exists, does not exist, or is absent.
 */
export function fold(inputs: readonly FoldInput[]): FoldResult {
  const byHash = new Map<string, FoldInput>();
  for (const input of inputs) {
    if (!byHash.has(input.hash)) {
      byHash.set(input.hash, input);
    }
  }
  const ordered = [...byHash.values()].sort(compareFoldOrder);

  // A null prototype keeps a meta key such as "__proto__" an ordinary entry.
  const meta = Object.create(null) as Record<string, JsonValue>;
  const state: BoardState = { tickets: {}, meta };
  const rejected: Rejected[] = [];
  const unknown: UnknownReport[] = [];

  for (const input of ordered) {
    const outcome = applyEvent(state, input);
    if (outcome.status === 'rejected') {
      rejected.push(outcome.rejected);
    } else if (outcome.status === 'unknown') {
      unknown.push(outcome.unknown);
    }
  }

  const last = ordered.at(-1);
  return { state, rejected, unknown, latest: last === undefined ? null : { ...last.event.ts } };
}

/** Outcome of applying one event with `applyEvent`. */
export type ApplyOutcome =
  | { status: 'applied' }
  | { status: 'rejected'; rejected: Rejected }
  | { status: 'unknown'; unknown: UnknownReport };

/**
 * One step of `fold`: applies `input` to `state` (mutating it only when the
 * event is applied) by exactly the per-kind rules documented on `fold`.
 * `fold` is this function applied to the de-duplicated inputs in fold order,
 * starting from an empty state; callers that keep state elsewhere (the
 * cache) use it to apply or validate a single event against the state at
 * that event's position. `state.tickets` need only hold the event's ticket,
 * when it exists.
 */
export function applyEvent(state: BoardState, input: FoldInput): ApplyOutcome {
  const { hash, event } = input;
  if (!isKnownEvent(event)) {
    return { status: 'unknown', unknown: { hash, kind: event.kind, event } };
  }
  if (event.kind === 'board.meta') {
    state.meta[event.body.key] = event.body.value;
    return { status: 'applied' };
  }
  const reason = applyTicketEvent(state.tickets, hash, event);
  if (reason !== null) {
    return {
      status: 'rejected',
      rejected: { hash, kind: event.kind, ticket: event.ticket, reason },
    };
  }
  return { status: 'applied' };
}

/**
 * Applies one ticket event to `tickets`, returning the rejection reason, or
 * null when it was applied (and counted in the ticket's version).
 */
function applyTicketEvent(
  tickets: Record<string, Ticket>,
  hash: string,
  event: TicketEvent,
): RejectionReason | null {
  const ticket: Ticket | undefined = tickets[event.ticket];
  if (event.kind === 'ticket.create') {
    if (ticket !== undefined) {
      return 'duplicate-create';
    }
    tickets[event.ticket] = createTicket(event);
    return null;
  }
  if (ticket === undefined) {
    return 'unknown-ticket';
  }
  const reason = applyToTicket(ticket, hash, event);
  if (reason === null) {
    ticket.version += 1;
    ticket.updatedAt = { ...event.ts };
  }
  return reason;
}

function createTicket(event: TicketCreateEvent): Ticket {
  const { body } = event;
  return {
    id: event.ticket,
    title: body.title,
    description: body.description ?? null,
    status: 'todo',
    blockedFrom: null,
    assignee: null,
    labels: [...(body.labels ?? [])],
    task: body.task === undefined ? null : copyTaskRef(body.task),
    adhoc: body.adhoc ?? null,
    checklist: (body.checklist ?? []).map((text) => ({ text, done: false })),
    comments: [],
    links: [],
    closed: false,
    disposition: null,
    createdBy: event.actor,
    createdAt: { ...event.ts },
    version: 1,
    updatedAt: { ...event.ts },
  };
}

function copyTaskRef(ref: TaskRef): TaskRef {
  return { source: ref.source, ref: ref.ref, item: ref.item };
}

/**
 * Applies a non-create event to an existing ticket, mutating it only when
 * the event is accepted. Returns the rejection reason, or null.
 */
function applyToTicket(
  ticket: Ticket,
  hash: string,
  event: Exclude<TicketEvent, TicketCreateEvent>,
): RejectionReason | null {
  const { actor, ts } = event;
  switch (event.kind) {
    case 'ticket.comment':
      ticket.comments.push({ actor, ts: { ...ts }, text: event.body.text, hash });
      return null;
    case 'ticket.move':
      return moveTo(ticket, event.body.to);
    case 'ticket.assign':
      ticket.assignee = event.body.to;
      return null;
    case 'ticket.claim':
      if (ticket.assignee !== null) {
        return 'already-assigned';
      }
      ticket.assignee = actor;
      return null;
    case 'ticket.release':
      if (ticket.assignee !== actor) {
        return 'not-assignee';
      }
      ticket.assignee = null;
      return null;
    case 'ticket.handoff': {
      const { to, status, note } = event.body;
      // A handoff to the current status is a reassignment, not a transition.
      const reason = status === ticket.status ? null : moveTo(ticket, status);
      if (reason === null) {
        ticket.assignee = to;
        ticket.comments.push({ actor, ts: { ...ts }, text: note, hash });
      }
      return reason;
    }
    case 'ticket.link': {
      const { body } = event;
      if ('task' in body) {
        ticket.task = copyTaskRef(body.task);
        ticket.adhoc = null;
      } else if ('pr' in body) {
        ticket.links.push({ type: 'pr', pr: body.pr, actor, ts: { ...ts }, hash });
      } else {
        ticket.links.push({ type: 'decision', path: body.decision, actor, ts: { ...ts }, hash });
      }
      return null;
    }
    case 'ticket.close':
      if (ticket.closed || (ticket.status !== 'merged' && ticket.status !== 'blocked')) {
        return 'invalid-transition';
      }
      ticket.closed = true;
      ticket.disposition =
        'decision' in event.body ? { decision: event.body.decision } : { noDecision: true };
      return null;
    case 'ticket.checklist': {
      const item: ChecklistItem | undefined = ticket.checklist[event.body.index];
      if (item === undefined) {
        return 'checklist-index';
      }
      item.done = event.body.done;
      return null;
    }
    case 'ticket.checklist.add':
      for (const item of event.body.items) {
        ticket.checklist.push({ text: item.text, done: item.done });
      }
      return null;
  }
}

/**
 * Moves `ticket` to `to` when the state machine and the task-link rule allow
 * it, recording or clearing the blocked origin. Returns the rejection reason,
 * or null when moved.
 */
function moveTo(ticket: Ticket, to: Status): RejectionReason | null {
  if (!isTransitionAllowed(ticket.status, to, ticket.blockedFrom)) {
    return 'invalid-transition';
  }
  if (to === 'implementing' && ticket.task === null) {
    return 'needs-task-link';
  }
  ticket.blockedFrom = to === 'blocked' ? ticket.status : null;
  ticket.status = to;
  return null;
}
