/**
 * Folding the event log into board state (board-events: "Deterministic
 * ordering", "Fold semantics", "Unknown kinds are preserved"; board-cli:
 * "Status state machine", "Claim, release and handoff";
 * board-openspec-integration: "Tickets reference tasks or are ad hoc",
 * "Scope disposition at merge and close").
 *
 * Pure: the result is a function of the set of inputs only, never of their
 * order in the array or of any clock. Every lease, queue and grant decision
 * is made from event timestamps and bodies alone (board-events: "Fold
 * semantics"). This module stays browser-safe: nothing it reaches may
 * import a `node:` specifier (src/__tests__/layering.test.ts), so a written
 * grant is compared with the derived one structurally, field by field, and
 * never through `canonical.ts` (which imports `node:crypto`).
 */

import type { JsonValue } from './json.js';
import { compareHlc, type Hlc } from './hlc.js';
import {
  GRACE_DEFAULT_MS,
  LEASE_GRACE_KEY,
  LEASE_SKEW_MS,
  QUEUE_WINDOW_KEY,
  SETTING_MAX_MS,
  SETTING_MIN_MS,
  SYSTEM_ACTOR,
  WINDOW_DEFAULT_MS,
  isKnownEvent,
  type BoardEvent,
  type GrantAfter,
  type TicketClaimEvent,
  type TicketGrantEvent,
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

/**
 * Why an otherwise well-formed event was not applied. `needs-task-link` is
 * not a reason: no rule depends on a task reference for a move into any
 * status but `merged` (board-events: "Fold semantics"; ADR 0013).
 */
export type RejectionReason =
  | 'unknown-ticket'
  | 'duplicate-create'
  | 'invalid-transition'
  | 'already-assigned'
  | 'not-assignee'
  | 'checklist-index'
  | 'needs-scope-disposition'
  | 'already-linked'
  | 'queued'
  | 'holder-changed'
  | 'invalid-queue'
  | 'stale-grant';

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

/**
 * A ticket's lease (board-events: "Claim leases"). Set by an applied leased
 * `ticket.claim` (`ttl` and `expiresAt` from its `body.lease`, unconfirmed),
 * an applied `ticket.renew` (its `ttl` and `expiresAt`, confirmed) or an
 * applied `ticket.grant` (its `ttl`, `expiresAt` = grant wall + `window`,
 * unconfirmed).
 */
export interface Lease {
  /** The ttl the holder asked for, in milliseconds. */
  ttl: number;
  /** When the lease expires, in milliseconds since the epoch. */
  expiresAt: number;
  /** Hash of the event that set this lease. */
  event: string;
  /** False until the holder's first renew; true after any applied renew. */
  confirmed: boolean;
}

/** One waiter of a ticket's queue, from its applied `ticket.queue.join`. */
export interface Waiter {
  actor: string;
  /** The `ttl` of the join, given to the grant. */
  ttl: number;
  /** Hash of the join event. */
  event: string;
  /** `ts` of the join event. */
  joined: Hlc;
}

/**
 * When, and by which event, the ticket becomes or became available for a
 * grant (board-cache: `available_at`, `available_event`). Derived from the
 * other fields after every applied event:
 * - unassigned: the latest applied `ticket.release` or
 *   `ticket.release.force` (`at` its wall, `event` its hash), or null when
 *   there has been none;
 * - assigned with a lease: `at` = `lease.expiresAt + LEASE_SKEW_MS`, `event`
 *   = `lease.event` (the lease lapses then);
 * - assigned without a lease: null (it never lapses).
 */
export interface Availability {
  at: number;
  event: string;
}

/** How a ticket was closed: exactly the body of its `ticket.close` event. */
export type CloseDisposition = { decision: string } | { noDecision: true };

/**
 * The unplanned scope disposition of a ticket (board-events: "Unplanned
 * disposition"): set by the latest applied `ticket.unplanned` (its
 * `body.reason`, its `actor` and its `ts`, copied), cleared by an applied
 * task link. Serialized to the cache `tickets.unplanned` column as
 * canonical JSON (board-cache: "Cache schema").
 */
export interface UnplannedDisposition {
  /** `body.reason` of the event. */
  reason: string;
  /** `actor` of the event. */
  actor: string;
  /** `ts` of the event. */
  ts: Hlc;
}

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
  /** The current lease, or null (see `Lease`); null at create. */
  lease: Lease | null;
  /** Waiters in fold order of their join events; `[]` at create. */
  queue: Waiter[];
  /** See `Availability`; null at create. */
  available: Availability | null;
  /** From create, as given; `[]` when not given. */
  labels: string[];
  /** From create or the latest `ticket.link` with a task; else null. */
  task: TaskRef | null;
  /** From create; cleared to null when a task link is applied. */
  adhoc: string | null;
  /**
   * The unplanned scope disposition, or null: null at create, set by an
   * applied `ticket.unplanned` (replacing any earlier one), cleared to null
   * when a task link is applied. Never set while `task` is non-null, and
   * `adhoc` is untouched by it (see `UnplannedDisposition`).
   */
  unplanned: UnplannedDisposition | null;
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
 *   to, blockedFrom)`; then `needs-scope-disposition` if `to` is `merged`
 *   and both `task` and `unplanned` are null (board-events: "Fold
 *   semantics", scenario "Undisposed ticket cannot enter merged"). No rule
 *   depends on `task` for any other target: an ad hoc ticket moves
 *   `todo` -> `tests` -> `implementing` -> `review` and is blocked freely.
 *   Moving to `blocked` records the previous status in `blockedFrom`;
 *   leaving `blocked` clears it.
 * - `ticket.assign`: sets `assignee` to `body.to` unconditionally, clears
 *   `lease`, and removes `body.to` from `queue` when it is queued (the
 *   assignee is never queued; the order of the other waiters is kept).
 * - `ticket.claim` by actor `A` (board-events: "Claim leases", "Waiting
 *   queue"), checked in this order:
 *   1. `assignee` is `A`: `already-assigned` (a retried claim).
 *   2. `queue` is not empty: `queued`.
 *   3. `assignee` is null: applied; `assignee` = `A`, `lease` = the
 *      claim's own lease (`{ttl, expiresAt, event: <claim hash>,
 *      confirmed: false}`) or null without one; any `supersedes` is ignored.
 *   4. Otherwise (held by another actor) a takeover: applied only when
 *      `body.supersedes` is present, `supersedes.holder` equals `assignee`,
 *      `lease` is not null with `expiresAt` equal to `supersedes.expiresAt`
 *      and `event` equal to `supersedes.event`, and `ts.wall >=
 *      lease.expiresAt + LEASE_SKEW_MS`; then as in 3. Else
 *      `already-assigned`.
 * - `ticket.renew`: `not-assignee` unless `assignee` equals the event
 *   actor; otherwise `lease` = `{ttl, expiresAt, event: <renew hash>,
 *   confirmed: true}`, whether or not the previous lease expired or
 *   existed.
 * - `ticket.release`: `not-assignee` unless `assignee` equals the event
 *   actor (so releasing an unassigned ticket is refused); otherwise
 *   `assignee` and `lease` become null.
 * - `ticket.release.force`: `holder-changed` unless `assignee` equals
 *   `body.holder` (an unassigned ticket included); otherwise `assignee` and
 *   `lease` become null. Status is unchanged. The event actor is not
 *   checked.
 * - `ticket.queue.join` by `A`: `invalid-queue` when `A` is the assignee,
 *   `A` is already queued, or the ticket is unassigned with an empty queue;
 *   otherwise appends `{actor: A, ttl, event: <hash>, joined: ts}` to
 *   `queue` (which therefore stays in fold order of the joins).
 * - `ticket.queue.leave` by `A`: `invalid-queue` unless `A` is queued;
 *   otherwise removes `A` from `queue`.
 * - `ticket.grant`: `stale-grant` unless the event equals `dueGrant(ticket,
 *   state.meta)` for the state at its position, compared structurally:
 *   every envelope field (`v`, `kind`, `ticket`, `actor`, `ts.wall`,
 *   `ts.counter`, `ts.actor`) and every body field (`to`, `ttl`, `window`,
 *   and `after` with exactly the same key, `released` or `lease`, and the
 *   same `holder`, `expiresAt` and `event`) equal, which for validated
 *   events is the same as equal canonical bytes (a null derivation is stale
 *   too); otherwise `assignee` =
 *   `body.to`, the head waiter is removed from `queue`, and `lease` =
 *   `{ttl: body.ttl, expiresAt: ts.wall + body.window, event: <grant
 *   hash>, confirmed: false}`.
 * - `ticket.handoff`: when `body.status` equals the current status (any
 *   status, `blocked` and `merged` included) it is a reassignment: no
 *   transition checks, status and `blockedFrom` untouched. Otherwise the
 *   same checks as a move to `body.status`, in the same order; if either
 *   fails the whole event is rejected and none of its effects apply. When
 *   applied, as one event: `assignee` = `body.to`, `lease` = null, status
 *   moves as for `ticket.move` (if it changes), and a comment with `text` =
 *   `body.note` by the event actor is appended. No assign, move or comment
 *   event is synthesized; version goes up by exactly 1. The queue does not
 *   constrain a handoff, but an applied handoff whose `body.to` is queued
 *   removes it from `queue` in the same step (the other waiters keep their
 *   order); one to an actor not queued leaves `queue` unchanged.
 *
 * After every applied ticket event `available` is recomputed as
 * `Availability` documents; no kind other than claim, renew, release,
 * forced release, assign, handoff and grant changes `lease`, and only join,
 * leave, grant, and an assign or handoff to a queued actor change `queue`.
 * So the assignee is never in `queue` at any fold position.
 * - `ticket.link`: `task` sets `task` (replacing any earlier one) and clears
 *   `adhoc` and `unplanned`; `pr` and `decision` append to `links`.
 * - `ticket.unplanned`: `already-linked` when `task` is not null (the
 *   ticket is unchanged); otherwise sets `unplanned` to `{ reason:
 *   body.reason, actor, ts }` (a copy of `ts`), replacing any earlier
 *   disposition, and changes nothing else (`adhoc`, status, assignee and
 *   the closed flag are untouched). Applied in any status, open or closed,
 *   so a second disposition records a new reason and a disposition without
 *   its move (a command that died after this file) is a valid state
 *   (board-events: "Unplanned disposition").
 * - `ticket.close`: `invalid-transition` if the ticket is already closed or
 *   its status is neither `merged` nor `blocked`; otherwise sets `closed`
 *   and `disposition`. Status is unchanged. The fold does not apply the
 *   decision-comment rule or the scope disposition rule to a close; both
 *   are the CLI's `close` checks, so a close of an undisposed ad hoc ticket
 *   written by an earlier version still folds. Events after a close are
 *   folded by their own rules.
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
  const reason = applyTicketEvent(state, hash, event);
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
  state: BoardState,
  hash: string,
  event: TicketEvent,
): RejectionReason | null {
  const { tickets } = state;
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
  const reason = applyToTicket(ticket, hash, event, state.meta);
  if (reason === null) {
    ticket.version += 1;
    ticket.updatedAt = { ...event.ts };
    updateAvailability(ticket, hash, event);
  }
  return reason;
}

/**
 * Recomputes `available` after an applied event, as `Availability`
 * documents. An unassigned ticket became so only by a release or a forced
 * release, so it keeps the availability that event set until it is held
 * again.
 */
function updateAvailability(ticket: Ticket, hash: string, event: TicketEvent): void {
  if (ticket.assignee !== null) {
    const { lease } = ticket;
    ticket.available =
      lease === null ? null : { at: lease.expiresAt + LEASE_SKEW_MS, event: lease.event };
  } else if (event.kind === 'ticket.release' || event.kind === 'ticket.release.force') {
    ticket.available = { at: event.ts.wall, event: hash };
  }
}

/** Removes `actor` from `ticket.queue` when it is queued, keeping the order of the rest. */
function dequeue(ticket: Ticket, actor: string): void {
  ticket.queue = ticket.queue.filter((waiter) => waiter.actor !== actor);
}

/**
 * The `ticket.claim` rules of `fold`, in order: a retried claim, the queue,
 * a free ticket, then a takeover of an expired lease.
 */
function claim(ticket: Ticket, hash: string, event: TicketClaimEvent): RejectionReason | null {
  const { actor, body } = event;
  if (ticket.assignee === actor) {
    return 'already-assigned';
  }
  if (ticket.queue.length > 0) {
    return 'queued';
  }
  if (ticket.assignee !== null && !takesOver(ticket, event)) {
    return 'already-assigned';
  }
  ticket.assignee = actor;
  ticket.lease =
    body.lease === undefined
      ? null
      : { ttl: body.lease.ttl, expiresAt: body.lease.expiresAt, event: hash, confirmed: false };
  return null;
}

/**
 * Whether a claim on a ticket held by another actor takes over its lease:
 * `supersedes` names the current holder and lease generation exactly, and
 * the claim's wall is at least the tolerance past that lease's expiry.
 */
function takesOver(ticket: Ticket, event: TicketClaimEvent): boolean {
  const { supersedes } = event.body;
  const { lease } = ticket;
  return (
    supersedes !== undefined &&
    lease !== null &&
    supersedes.holder === ticket.assignee &&
    supersedes.expiresAt === lease.expiresAt &&
    supersedes.event === lease.event &&
    event.ts.wall >= lease.expiresAt + LEASE_SKEW_MS
  );
}

/** Whether two grant events are equal field by field (equal canonical bytes once validated). */
function sameGrant(a: TicketGrantEvent, b: TicketGrantEvent): boolean {
  return (
    a.v === b.v &&
    a.kind === b.kind &&
    a.ticket === b.ticket &&
    a.actor === b.actor &&
    a.ts.wall === b.ts.wall &&
    a.ts.counter === b.ts.counter &&
    a.ts.actor === b.ts.actor &&
    a.body.to === b.body.to &&
    a.body.ttl === b.body.ttl &&
    a.body.window === b.body.window &&
    sameAfter(a.body.after, b.body.after)
  );
}

function sameAfter(a: GrantAfter, b: GrantAfter): boolean {
  if ('released' in a) {
    return 'released' in b && a.released === b.released;
  }
  return (
    'lease' in b &&
    a.lease.holder === b.lease.holder &&
    a.lease.expiresAt === b.lease.expiresAt &&
    a.lease.event === b.lease.event
  );
}

/** Applies a `ticket.grant` equal to the derived one, else `stale-grant`. */
function grant(
  ticket: Ticket,
  hash: string,
  event: TicketGrantEvent,
  meta: Readonly<Record<string, JsonValue>>,
): RejectionReason | null {
  const derived = dueGrant(ticket, meta);
  if (derived === null || !sameGrant(derived, event)) {
    return 'stale-grant';
  }
  const { to, ttl, window } = event.body;
  ticket.assignee = to;
  dequeue(ticket, to);
  ticket.lease = { ttl, expiresAt: event.ts.wall + window, event: hash, confirmed: false };
  return null;
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
    unplanned: null,
    checklist: (body.checklist ?? []).map((text) => ({ text, done: false })),
    comments: [],
    links: [],
    closed: false,
    disposition: null,
    lease: null,
    queue: [],
    available: null,
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
  meta: Readonly<Record<string, JsonValue>>,
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
      ticket.lease = null;
      dequeue(ticket, event.body.to);
      return null;
    case 'ticket.claim':
      return claim(ticket, hash, event);
    case 'ticket.renew':
      if (ticket.assignee !== actor) {
        return 'not-assignee';
      }
      ticket.lease = {
        ttl: event.body.ttl,
        expiresAt: event.body.expiresAt,
        event: hash,
        confirmed: true,
      };
      return null;
    case 'ticket.release':
      if (ticket.assignee !== actor) {
        return 'not-assignee';
      }
      ticket.assignee = null;
      ticket.lease = null;
      return null;
    case 'ticket.release.force':
      if (ticket.assignee !== event.body.holder) {
        return 'holder-changed';
      }
      ticket.assignee = null;
      ticket.lease = null;
      return null;
    case 'ticket.queue.join':
      if (
        ticket.assignee === actor ||
        ticket.queue.some((waiter) => waiter.actor === actor) ||
        (ticket.assignee === null && ticket.queue.length === 0)
      ) {
        return 'invalid-queue';
      }
      ticket.queue.push({ actor, ttl: event.body.ttl, event: hash, joined: { ...ts } });
      return null;
    case 'ticket.queue.leave':
      if (!ticket.queue.some((waiter) => waiter.actor === actor)) {
        return 'invalid-queue';
      }
      dequeue(ticket, actor);
      return null;
    case 'ticket.grant':
      return grant(ticket, hash, event, meta);
    case 'ticket.handoff': {
      const { to, status, note } = event.body;
      // A handoff to the current status is a reassignment, not a transition.
      const reason = status === ticket.status ? null : moveTo(ticket, status);
      if (reason === null) {
        ticket.assignee = to;
        ticket.lease = null;
        dequeue(ticket, to);
        ticket.comments.push({ actor, ts: { ...ts }, text: note, hash });
      }
      return reason;
    }
    case 'ticket.unplanned':
      if (ticket.task !== null) {
        return 'already-linked';
      }
      ticket.unplanned = { reason: event.body.reason, actor, ts: { ...ts } };
      return null;
    case 'ticket.link': {
      const { body } = event;
      if ('task' in body) {
        ticket.task = copyTaskRef(body.task);
        ticket.adhoc = null;
        ticket.unplanned = null;
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
 * Moves `ticket` to `to` when the state machine and the scope disposition
 * rule allow it, recording or clearing the blocked origin. Returns the
 * rejection reason, or null when moved. The state machine is checked
 * first (`invalid-transition`), then, for `to === 'merged'` only, the
 * scope disposition (`needs-scope-disposition` when `task` and `unplanned`
 * are both null). Shared by `ticket.move` and a `ticket.handoff` that
 * changes status, so a hand-off into `merged` obeys the same rule.
 */
function moveTo(ticket: Ticket, to: Status): RejectionReason | null {
  if (!isTransitionAllowed(ticket.status, to, ticket.blockedFrom)) {
    return 'invalid-transition';
  }
  if (to === 'merged' && ticket.task === null && ticket.unplanned === null) {
    return 'needs-scope-disposition';
  }
  ticket.blockedFrom = to === 'blocked' ? ticket.status : null;
  ticket.status = to;
  return null;
}

/**
 * The grace a leased claim records (board-events: "Board lease settings"):
 * `meta['lease.grace']` when it is a safe integer in
 * `SETTING_MIN_MS`..`SETTING_MAX_MS` inclusive, otherwise (missing, out of
 * range, or not an integer) `GRACE_DEFAULT_MS`. Pure.
 */
export function leaseGrace(meta: Readonly<Record<string, JsonValue>>): number {
  return setting(meta, LEASE_GRACE_KEY, GRACE_DEFAULT_MS);
}

/** `meta[key]` when it is a safe integer in the setting range, else `fallback`. */
function setting(meta: Readonly<Record<string, JsonValue>>, key: string, fallback: number): number {
  const value = Object.hasOwn(meta, key) ? meta[key] : undefined;
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= SETTING_MIN_MS &&
    value <= SETTING_MAX_MS
    ? value
    : fallback;
}

/**
 * The acceptance window of a grant (board-events: "Board lease settings"):
 * `meta['queue.window']` when it is a safe integer in
 * `SETTING_MIN_MS`..`SETTING_MAX_MS` inclusive, otherwise
 * `WINDOW_DEFAULT_MS`. Pure.
 */
export function queueWindow(meta: Readonly<Record<string, JsonValue>>): number {
  return setting(meta, QUEUE_WINDOW_KEY, WINDOW_DEFAULT_MS);
}

/**
 * The grant due for `ticket` (board-events: "Grants"), derived from the
 * ticket and the board settings as folded at the grant's position, or null
 * when none is due. Pure: reads no clock; whether the grant's slot time
 * has come is the caller's question. The fold calls it with the state just
 * before a `ticket.grant` and applies that grant only when it is equal to
 * the result, compared field by field (see `fold`); catch-up uses it to
 * write grants.
 *
 * Null when `ticket.queue` is empty, or `ticket.available` is null (an
 * assigned ticket without a lease never lapses). Otherwise, with `head =
 * ticket.queue[0]`, `F = ticket.available.at` and `S = max(F,
 * head.joined.wall) + 1`, the event
 *
 * ```
 * { v: 1, kind: 'ticket.grant', ticket: ticket.id, actor: SYSTEM_ACTOR,
 *   ts: { wall: S, counter: 0, actor: SYSTEM_ACTOR },
 *   body: { to: head.actor, ttl: head.ttl, window: queueWindow(meta),
 *           after } }
 * ```
 *
 * where `after` is `{ released: ticket.available.event }` when the ticket
 * is unassigned, and `{ lease: { holder: ticket.assignee, expiresAt:
 * ticket.lease.expiresAt, event: ticket.lease.event } }` when it is held
 * under a lease (whose lapse is `F`). The result is a fresh object that
 * shares nothing with `ticket` or `meta`.
 */
export function dueGrant(
  ticket: Ticket,
  meta: Readonly<Record<string, JsonValue>>,
): TicketGrantEvent | null {
  const [head] = ticket.queue;
  const { available, assignee, lease } = ticket;
  if (head === undefined || available === null) {
    return null;
  }
  let after: GrantAfter;
  if (assignee === null) {
    after = { released: available.event };
  } else if (lease === null) {
    return null;
  } else {
    after = { lease: { holder: assignee, expiresAt: lease.expiresAt, event: lease.event } };
  }
  const wall = Math.max(available.at, head.joined.wall) + 1;
  return {
    v: 1,
    kind: 'ticket.grant',
    ticket: ticket.id,
    actor: SYSTEM_ACTOR,
    ts: { wall, counter: 0, actor: SYSTEM_ACTOR },
    body: { to: head.actor, ttl: head.ttl, window: queueWindow(meta), after },
  };
}
