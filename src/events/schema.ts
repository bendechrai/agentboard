/**
 * Event envelope, kind bodies, task references and the event validator
 * (board-events: "Event envelope", "Task reference", "Event kinds",
 * "Unknown kinds are preserved"; board-cli: "Status state machine").
 *
 * Pure: no IO. The validator takes the value produced by `canonicalDecode`
 * (or any other `unknown`) and never throws.
 */

import type { JsonValue } from './canonical.js';
import type { Hlc } from './hlc.js';

/** The schema version this code writes and folds. */
export const SCHEMA_VERSION = 1;

/** Ticket statuses, in board order. `merged` is terminal. */
export const STATUSES = ['todo', 'tests', 'implementing', 'review', 'merged', 'blocked'] as const;

/** A ticket status. */
export type Status = (typeof STATUSES)[number];

/**
 * Link from a ticket to the planning artifact it implements.
 *
 * - `source`: matches `^[a-z][a-z0-9-]*$` (`openspec` for OpenSpec).
 * - `ref`: non-empty string (for `openspec`, the change directory name).
 * - `item`: non-empty string (for `openspec`, the task group number in
 *   decimal, for example `"3"`).
 *
 * No other properties are allowed. The schema does not interpret `ref` or
 * `item` beyond being non-empty strings; any source is accepted.
 */
export interface TaskRef {
  source: string;
  ref: string;
  item: string;
}

/** Pattern every `TaskRef.source` must match. */
export const TASK_SOURCE_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Parses the text form `<source>:<ref>#<item>`.
 *
 * `source` is everything before the first `:`; the remainder is split at its
 * last `#` into `ref` (before) and `item` (after). So `ref` may contain `:`
 * and `#`, and `item` never contains `#`.
 *
 * Returns `null` when there is no `:`, no `#` after the `:`, or when the
 * parts break the `TaskRef` rules (source pattern, non-empty ref and item).
 * Examples: `openspec:add-board-core#3` gives
 * `{ source: 'openspec', ref: 'add-board-core', item: '3' }`;
 * `add-board-core-3` and `Open Spec:x#1` give `null`.
 */
export function parseTaskRef(text: string): TaskRef | null {
  void text;
  throw new Error('not implemented');
}

/**
 * Formats a task reference as `<source>:<ref>#<item>`, with no validation
 * or escaping. `parseTaskRef(formatTaskRef(r))` deep-equals `r` for every
 * valid `r` whose `item` contains no `#`.
 */
export function formatTaskRef(ref: TaskRef): string {
  void ref;
  throw new Error('not implemented');
}

/** `ticket.create`: `title` required; everything else optional. */
export interface TicketCreateBody {
  /** Non-empty. */
  title: string;
  /** Any string, including empty. */
  description?: string;
  /** Each label a non-empty string. Kept as given (order, duplicates). */
  labels?: string[];
  /** Must not be present together with `adhoc`. */
  task?: TaskRef;
  /** Non-empty reason the ticket has no task. Not together with `task`. */
  adhoc?: string;
  /** Checklist lines, each a non-empty string, all initially not done. */
  checklist?: string[];
}

/** `ticket.comment`. */
export interface TicketCommentBody {
  /** Non-empty. */
  text: string;
}

/** `ticket.move`. The target is always explicit in the event. */
export interface TicketMoveBody {
  to: Status;
}

/** `ticket.assign`. */
export interface TicketAssignBody {
  /** Non-empty actor name. */
  to: string;
}

/** `ticket.claim` and `ticket.release` carry an empty body `{}`. */
export type EmptyBody = Record<string, never>;

/** `ticket.handoff`: assign, move and comment in one event. */
export interface TicketHandoffBody {
  /** Non-empty actor name of the new assignee. */
  to: string;
  status: Status;
  /** Non-empty; becomes a comment attributed to the event's actor. */
  note: string;
}

/**
 * `ticket.link`: exactly one of `task`, `pr` or `decision`.
 * `pr` is a non-empty string (URL) or a positive safe integer (PR number);
 * `decision` is a non-empty path string.
 */
export type TicketLinkBody = { task: TaskRef } | { pr: string | number } | { decision: string };

/**
 * `ticket.close`: exactly one of `decision` (non-empty path string) or
 * `noDecision` (the literal `true`).
 */
export type TicketCloseBody = { decision: string } | { noDecision: true };

/** `ticket.checklist`: `index` any safe integer, range-checked by the fold. */
export interface TicketChecklistBody {
  index: number;
  done: boolean;
}

/** `board.meta`: `key` non-empty; `value` any JSON value, including null. */
export interface BoardMetaBody {
  key: string;
  value: JsonValue;
}

interface TicketEnvelope<K extends string, B> {
  v: 1;
  kind: K;
  /** ULID of the ticket (see `isUlid`). */
  ticket: string;
  /** Non-empty. */
  actor: string;
  /** `ts.actor` always equals `actor`. */
  ts: Hlc;
  body: B;
}

export type TicketCreateEvent = TicketEnvelope<'ticket.create', TicketCreateBody>;
export type TicketCommentEvent = TicketEnvelope<'ticket.comment', TicketCommentBody>;
export type TicketMoveEvent = TicketEnvelope<'ticket.move', TicketMoveBody>;
export type TicketAssignEvent = TicketEnvelope<'ticket.assign', TicketAssignBody>;
export type TicketClaimEvent = TicketEnvelope<'ticket.claim', EmptyBody>;
export type TicketReleaseEvent = TicketEnvelope<'ticket.release', EmptyBody>;
export type TicketHandoffEvent = TicketEnvelope<'ticket.handoff', TicketHandoffBody>;
export type TicketLinkEvent = TicketEnvelope<'ticket.link', TicketLinkBody>;
export type TicketCloseEvent = TicketEnvelope<'ticket.close', TicketCloseBody>;
export type TicketChecklistEvent = TicketEnvelope<'ticket.checklist', TicketChecklistBody>;

/** `board.meta` is the only kind without a `ticket` field. */
export interface BoardMetaEvent {
  v: 1;
  kind: 'board.meta';
  actor: string;
  ts: Hlc;
  body: BoardMetaBody;
}

/** Every event kind defined by this schema version. */
export type TicketEvent =
  | TicketCreateEvent
  | TicketCommentEvent
  | TicketMoveEvent
  | TicketAssignEvent
  | TicketClaimEvent
  | TicketReleaseEvent
  | TicketHandoffEvent
  | TicketLinkEvent
  | TicketCloseEvent
  | TicketChecklistEvent;

/** Discriminated union of every known event, narrowed by `kind`. */
export type BoardEvent = TicketEvent | BoardMetaEvent;

/** The kinds defined by this schema version. */
export const KNOWN_KINDS = [
  'ticket.create',
  'ticket.comment',
  'ticket.move',
  'ticket.assign',
  'ticket.claim',
  'ticket.release',
  'ticket.handoff',
  'ticket.link',
  'ticket.close',
  'ticket.checklist',
  'board.meta',
] as const;

/** A kind defined by this schema version. */
export type KnownKind = (typeof KNOWN_KINDS)[number];

/** True when `kind` is one of `KNOWN_KINDS`. */
export function isKnownKind(kind: string): kind is KnownKind {
  void kind;
  throw new Error('not implemented');
}

/**
 * A well-formed event whose `kind` is not in `KNOWN_KINDS` (written by a
 * newer version). Its envelope obeys the same rules as a ticket event
 * except that `ticket` is optional (a ULID when present), so later versions
 * can add board-level kinds; its body is any JSON object and is not
 * inspected.
 */
export interface UnknownKindEvent {
  v: 1;
  kind: string;
  ticket?: string;
  actor: string;
  ts: Hlc;
  body: Record<string, JsonValue>;
}

/** True when `event.kind` is one of `KNOWN_KINDS`. */
export function isKnownEvent(event: BoardEvent | UnknownKindEvent): event is BoardEvent {
  void event;
  throw new Error('not implemented');
}

/**
 * One reason an event is malformed.
 *
 * `field` is the dot-separated path of the offending field from the event
 * root, with array indexes as path segments: for example `actor`,
 * `ts.wall`, `body.task.source`, `body.labels.1`, or the name of an
 * unexpected extra field such as `extra` or `body.extra`. It is `body` for
 * rules about the body as a whole (body not an object, `ticket.link` without
 * exactly one target, `ticket.close` without exactly one disposition), and
 * the empty string when the event itself is not an object.
 * `message` is a human-readable ASCII explanation.
 */
export interface MalformedReason {
  field: string;
  message: string;
}

/**
 * Result of `validateEvent`. `known` separates events of a defined kind
 * (folded) from well-formed events of an unknown kind (preserved and
 * reported, never folded into ticket state).
 */
export type ValidationResult =
  | { ok: true; known: true; event: BoardEvent }
  | { ok: true; known: false; event: UnknownKindEvent }
  | { ok: false; reasons: MalformedReason[] };

/**
 * Validates a decoded event. Never throws.
 *
 * Envelope rules (each violation is one reason with the given field):
 * - `''`: the value is not a plain object (no other reasons are reported).
 * - `v`: missing or not exactly the number 1.
 * - `kind`: missing or not a non-empty string. When `kind` is invalid the
 *   body is not checked.
 * - `ticket`: for `board.meta`, must be absent; for every other known kind,
 *   required and a ULID per `isUlid`; for an unknown kind, optional and a
 *   ULID when present.
 * - `actor`: missing or not a non-empty string.
 * - `ts`: missing or not an object. Otherwise `ts.wall` and `ts.counter`
 *   must be non-negative safe integers, `ts.actor` a non-empty string equal
 *   to `actor` (the equality check is made only when `actor` is itself
 *   valid), and any other key is reported as `ts.<key>`.
 * - `body`: missing or not an object.
 * - Any other top-level key is reported as `<key>`.
 *
 * Body rules for known kinds (fields relative to `body.`; any key not listed
 * is reported as `body.<key>`):
 * - `ticket.create`: `title` required non-empty string; `description`
 *   string; `labels` array (else `body.labels`) of non-empty strings (else
 *   `body.labels.<i>`); `checklist` likewise; `task` a TaskRef (not an
 *   object: `body.task`; a bad or missing part: `body.task.source`,
 *   `body.task.ref`, `body.task.item`; an extra part: `body.task.<key>`);
 *   `adhoc` non-empty string. `task` and `adhoc` both present is one reason
 *   with field `body.adhoc`. Neither present is well-formed.
 * - `ticket.comment`: `text` required non-empty string.
 * - `ticket.move`: `to` required, one of `STATUSES`.
 * - `ticket.assign`: `to` required non-empty string.
 * - `ticket.claim`, `ticket.release`: no keys.
 * - `ticket.handoff`: `to` non-empty string, `status` one of `STATUSES`,
 *   `note` non-empty string; all required.
 * - `ticket.link`: exactly one of `task` (TaskRef, reported as for create),
 *   `pr` (non-empty string or positive safe integer) or `decision`
 *   (non-empty string); zero or several present is one reason `body`.
 * - `ticket.close`: exactly one of `decision` (non-empty string) or
 *   `noDecision` (must be `true`, else `body.noDecision`); zero or both is
 *   one reason `body`.
 * - `ticket.checklist`: `index` a safe integer (negative is well-formed
 *   here and rejected by the fold), `done` a boolean; both required.
 * - `board.meta`: `key` non-empty string and `value` (any JSON value,
 *   including null) both required.
 *
 * Unknown kinds: only the envelope is checked, and `body` must be an object.
 *
 * Every applicable reason is returned (a missing field yields exactly one
 * reason, not a cascade); order is unspecified.
 */
export function validateEvent(value: unknown): ValidationResult {
  void value;
  throw new Error('not implemented');
}
