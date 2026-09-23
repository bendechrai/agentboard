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
import type { Hlc } from './hlc.js';
import type { BoardEvent, Status, TaskRef, UnknownKindEvent } from './schema.js';

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
  /** From create, all `done: false`; `[]` when not given. */
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
  void a;
  void b;
  throw new Error('not implemented');
}

/**
 * Whether the state machine permits moving from `from` to `to`, where
 * `blockedFrom` is the ticket's remembered origin (used only when `from`
 * is `blocked`). Permitted:
 * - `todo` -> `tests`; `tests` -> `implementing`; `implementing` -> `review`;
 * - `review` -> `implementing`, `review` -> `tests`, `review` -> `merged`;
 * - any status except `merged` -> `blocked` (including `blocked` itself);
 * - `blocked` -> `blockedFrom` (and to no other status except `blocked`).
 * Everything else is refused, including other self-transitions such as
 * `todo` -> `todo`, and every move out of `merged` (terminal).
 */
export function isTransitionAllowed(from: Status, to: Status, blockedFrom: Status | null): boolean {
  void from;
  void to;
  void blockedFrom;
  throw new Error('not implemented');
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
 *   `task` is null. Moving to `blocked` from a non-blocked status records
 *   `blockedFrom`; `blocked` -> `blocked` keeps the original `blockedFrom`;
 *   leaving `blocked` clears it.
 * - `ticket.assign`: sets `assignee` to `body.to` unconditionally.
 * - `ticket.claim`: `already-assigned` if `assignee` is not null (even when
 *   it is the claiming actor); otherwise `assignee` becomes the event actor.
 * - `ticket.release`: `not-assignee` unless `assignee` equals the event
 *   actor (so releasing an unassigned ticket is refused); otherwise
 *   `assignee` becomes null.
 * - `ticket.handoff`: the same checks as a move to `body.status`, in the
 *   same order; if either fails the whole event is rejected and none of its
 *   effects apply. Otherwise, as one event: `assignee` = `body.to`, status
 *   moves as for `ticket.move`, and a comment with `text` = `body.note` by
 *   the event actor is appended. No assign, move or comment event is
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
 * - `board.meta`: sets `state.meta[key] = value`; never rejected; affects no
 *   ticket.
 * - Unknown kinds: appended to `unknown`; affect no ticket and are never
 *   rejected, whether or not their ticket exists.
 */
export function fold(inputs: readonly FoldInput[]): FoldResult {
  void inputs;
  throw new Error('not implemented');
}
