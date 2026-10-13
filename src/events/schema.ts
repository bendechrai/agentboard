/**
 * Event envelope, kind bodies, task references and the event validator
 * (board-events: "Event envelope", "Task reference", "Event kinds",
 * "Unknown kinds are preserved"; board-cli: "Status state machine").
 *
 * Pure: no IO. The validator takes the value produced by `canonicalDecode`
 * (or any other `unknown`) and never throws.
 */

import type { JsonValue } from './json.js';
import type { Hlc } from './hlc.js';
import { isUlid } from './ulid.js';

/** The schema version this code writes and folds. */
export const SCHEMA_VERSION = 1;

/**
 * Clock skew tolerance of the lease rules, in milliseconds (board-events:
 * "Claim leases", "Grants"). A lease that expires at `expiresAt` can be
 * taken over, and makes a grant due, only from `expiresAt + LEASE_SKEW_MS`.
 */
export const LEASE_SKEW_MS = 60_000;

/** Smallest `ttl` (claim lease, renew, queue join, grant), inclusive: 30 seconds. */
export const TTL_MIN_MS = 30_000;

/** Largest `ttl`, inclusive: 7 days. */
export const TTL_MAX_MS = 604_800_000;

/**
 * Smallest grace (a claim lease's `grace`, the `lease.grace` setting) and
 * window (a grant's `window`, the `queue.window` setting), inclusive: 30
 * seconds.
 */
export const SETTING_MIN_MS = 30_000;

/** Largest grace or window, inclusive: 10 minutes. */
export const SETTING_MAX_MS = 600_000;

/** Grace of a leased claim when `lease.grace` is missing or out of range: 2 minutes. */
export const GRACE_DEFAULT_MS = 120_000;

/** Window of a grant when `queue.window` is missing or out of range: 2 minutes. */
export const WINDOW_DEFAULT_MS = 120_000;

/** `board.meta` key of the grace given to a leased claim (board-events: "Board lease settings"). */
export const LEASE_GRACE_KEY = 'lease.grace';

/** `board.meta` key of the acceptance window given to a grant. */
export const QUEUE_WINDOW_KEY = 'queue.window';

/**
 * The reserved system actor (board-events: "Reserved system actor"). It is
 * the actor of every `ticket.grant` and of no other event.
 */
export const SYSTEM_ACTOR = 'agentboard';

/** Pattern of an event hash: 64 lowercase hex characters. */
export const EVENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

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
  const colon = text.indexOf(':');
  const hash = text.lastIndexOf('#');
  if (colon < 0 || hash < colon) {
    return null;
  }
  const ref = {
    source: text.slice(0, colon),
    ref: text.slice(colon + 1, hash),
    item: text.slice(hash + 1),
  };
  return taskRefProblems(ref, '').length === 0 ? ref : null;
}

/**
 * Formats a task reference as `<source>:<ref>#<item>`, with no validation
 * or escaping. `parseTaskRef(formatTaskRef(r))` deep-equals `r` for every
 * valid `r` whose `item` contains no `#`.
 */
export function formatTaskRef(ref: TaskRef): string {
  return `${ref.source}:${ref.ref}#${ref.item}`;
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

/** `ticket.release` and `ticket.queue.leave` carry an empty body `{}`. */
export type EmptyBody = Record<string, never>;

/**
 * The lease a `ticket.claim` asks for. All three are integer milliseconds:
 * `ttl` in `TTL_MIN_MS`..`TTL_MAX_MS`, `grace` in
 * `SETTING_MIN_MS`..`SETTING_MAX_MS`, and `expiresAt` exactly the event's
 * `ts.wall + min(ttl, grace)`.
 */
export interface ClaimLease {
  ttl: number;
  grace: number;
  expiresAt: number;
}

/**
 * The lease generation a takeover claim replaces: the holder, the lease's
 * `expiresAt` and the hash of the event that set the lease (64 lowercase
 * hex characters).
 */
export interface LeaseRef {
  /** Non-empty actor name. */
  holder: string;
  /** Non-negative safe integer. */
  expiresAt: number;
  /** Matches `EVENT_HASH_PATTERN`. */
  event: string;
}

/**
 * `ticket.claim`: the event's actor claims the ticket. Both fields are
 * optional; a claim with neither has the empty body `{}`, byte for byte the
 * claim written before leases existed.
 */
export interface TicketClaimBody {
  lease?: ClaimLease;
  supersedes?: LeaseRef;
}

/**
 * `ticket.renew`: the assignee confirms or resets its lease. `ttl` in
 * `TTL_MIN_MS`..`TTL_MAX_MS`; `expiresAt` exactly `ts.wall + ttl`.
 */
export interface TicketRenewBody {
  ttl: number;
  expiresAt: number;
}

/** `ticket.release.force`: an actor breaks `holder`'s hold, saying why. */
export interface TicketReleaseForceBody {
  /** Non-empty actor name of the holder being released. */
  holder: string;
  /** Non-empty. */
  reason: string;
}

/** `ticket.queue.join`: the actor waits for the ticket, asking for a lease of `ttl`. */
export interface TicketQueueJoinBody {
  /** In `TTL_MIN_MS`..`TTL_MAX_MS`. */
  ttl: number;
}

/**
 * What made the ticket available for a grant: exactly one of `released`
 * (the hash of the applied `ticket.release` or `ticket.release.force`) or
 * `lease` (the lapsed lease).
 */
export type GrantAfter = { released: string } | { lease: LeaseRef };

/**
 * `ticket.grant`, written only by `SYSTEM_ACTOR`: the ticket passes to the
 * head waiter `to`, with the `ttl` of its join and the acceptance `window`
 * (in `SETTING_MIN_MS`..`SETTING_MAX_MS`).
 */
export interface TicketGrantBody {
  /** Non-empty actor name. */
  to: string;
  /** In `TTL_MIN_MS`..`TTL_MAX_MS`. */
  ttl: number;
  /** In `SETTING_MIN_MS`..`SETTING_MAX_MS`. */
  window: number;
  after: GrantAfter;
}

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

/** One line appended by `ticket.checklist.add`. */
export interface TicketChecklistAddItem {
  /** Non-empty. */
  text: string;
  done: boolean;
}

/**
 * `ticket.checklist.add` (written when re-importing a change adds lines):
 * `items` is a non-empty array of checklist lines, appended by the fold in
 * array order after the ticket's existing lines.
 */
export interface TicketChecklistAddBody {
  items: TicketChecklistAddItem[];
}

/**
 * One changed line of a `ticket.reconcile`: checklist line `index` (0-based,
 * any safe integer here, range-checked by the fold) gets `text` (non-empty)
 * and `done`.
 */
export interface TicketReconcileUpdate {
  index: number;
  text: string;
  done: boolean;
}

/**
 * `ticket.reconcile` (board-events: "Reconcile events";
 * board-openspec-integration: "Reconcile on re-import"): the whole
 * difference between a ticket and its task group in one event, applied by
 * the fold in one step.
 *
 * - `title`: optional; the new title (non-empty), present only when the
 *   title changes.
 * - `updated`: lines whose text changes, each with its new text and done
 *   flag, in ascending `index` order as the command writes them; may be
 *   empty.
 * - `removed`: indices of lines marked removed, ascending as written; may
 *   be empty.
 * - `added`: lines appended, in tasks file order; may be empty.
 * - `forced`: true when `import-change --force` wrote a reconcile the guard
 *   would have blocked; false otherwise.
 * - `holder`: optional; the ticket's assignee when a forced reconcile was
 *   written on an assigned ticket (so the inbox entry names it in
 *   `affects`). Present only when `forced` is true.
 * - `source`: the tasks file and the SHA-256 of its bytes, written as
 *   `<root-relative path>@sha256:<64 lowercase hex>` (for example
 *   `openspec/changes/add-x/tasks.md@sha256:9f86...`); the schema checks
 *   only that it is a non-empty string.
 *
 * At least one of `title`, `updated`, `removed` and `added` is present and
 * non-empty.
 */
export interface TicketReconcileBody {
  title?: string;
  updated: TicketReconcileUpdate[];
  removed: number[];
  added: TicketChecklistAddItem[];
  forced: boolean;
  holder?: string;
  source: string;
}

/**
 * `ticket.renumber`: the ticket's task item moves from `from` to `to`
 * (both non-empty), with its `group:<n>` label (board-events: "Renumber and
 * supersede events").
 */
export interface TicketRenumberBody {
  from: string;
  to: string;
}

/**
 * `ticket.supersede`: the ticket no longer stands for any group of its
 * change; `reason` (non-empty) says why. Nothing else about the ticket
 * changes.
 */
export interface TicketSupersedeBody {
  reason: string;
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
export type TicketClaimEvent = TicketEnvelope<'ticket.claim', TicketClaimBody>;
export type TicketRenewEvent = TicketEnvelope<'ticket.renew', TicketRenewBody>;
export type TicketReleaseEvent = TicketEnvelope<'ticket.release', EmptyBody>;
export type TicketReleaseForceEvent = TicketEnvelope<
  'ticket.release.force',
  TicketReleaseForceBody
>;
export type TicketQueueJoinEvent = TicketEnvelope<'ticket.queue.join', TicketQueueJoinBody>;
export type TicketQueueLeaveEvent = TicketEnvelope<'ticket.queue.leave', EmptyBody>;
export type TicketGrantEvent = TicketEnvelope<'ticket.grant', TicketGrantBody>;
export type TicketHandoffEvent = TicketEnvelope<'ticket.handoff', TicketHandoffBody>;
export type TicketLinkEvent = TicketEnvelope<'ticket.link', TicketLinkBody>;
export type TicketCloseEvent = TicketEnvelope<'ticket.close', TicketCloseBody>;
export type TicketChecklistEvent = TicketEnvelope<'ticket.checklist', TicketChecklistBody>;
export type TicketChecklistAddEvent = TicketEnvelope<
  'ticket.checklist.add',
  TicketChecklistAddBody
>;
export type TicketReconcileEvent = TicketEnvelope<'ticket.reconcile', TicketReconcileBody>;
export type TicketRenumberEvent = TicketEnvelope<'ticket.renumber', TicketRenumberBody>;
export type TicketSupersedeEvent = TicketEnvelope<'ticket.supersede', TicketSupersedeBody>;

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
  | TicketRenewEvent
  | TicketReleaseEvent
  | TicketReleaseForceEvent
  | TicketQueueJoinEvent
  | TicketQueueLeaveEvent
  | TicketGrantEvent
  | TicketHandoffEvent
  | TicketLinkEvent
  | TicketCloseEvent
  | TicketChecklistEvent
  | TicketChecklistAddEvent
  | TicketReconcileEvent
  | TicketRenumberEvent
  | TicketSupersedeEvent;

/** Discriminated union of every known event, narrowed by `kind`. */
export type BoardEvent = TicketEvent | BoardMetaEvent;

/** The kinds defined by this schema version. */
export const KNOWN_KINDS = [
  'ticket.create',
  'ticket.comment',
  'ticket.move',
  'ticket.assign',
  'ticket.claim',
  'ticket.renew',
  'ticket.release',
  'ticket.release.force',
  'ticket.queue.join',
  'ticket.queue.leave',
  'ticket.grant',
  'ticket.handoff',
  'ticket.link',
  'ticket.close',
  'ticket.checklist',
  'ticket.checklist.add',
  'ticket.reconcile',
  'ticket.renumber',
  'ticket.supersede',
  'board.meta',
] as const;

/** A kind defined by this schema version. */
export type KnownKind = (typeof KNOWN_KINDS)[number];

/** True when `kind` is one of `KNOWN_KINDS`. */
export function isKnownKind(kind: string): kind is KnownKind {
  return (KNOWN_KINDS as readonly string[]).includes(kind);
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
  return isKnownKind(event.kind);
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
 * - `ticket.claim`: two optional keys.
 *   - `lease`: not an object is `body.lease`. `ttl` missing, not a safe
 *     integer or outside `TTL_MIN_MS`..`TTL_MAX_MS` is `body.lease.ttl`;
 *     `grace` likewise outside `SETTING_MIN_MS`..`SETTING_MAX_MS` is
 *     `body.lease.grace`; `expiresAt` missing or not a non-negative safe
 *     integer is `body.lease.expiresAt`, and so is an `expiresAt` that is
 *     not exactly `ts.wall + min(ttl, grace)`, a check made only when
 *     `ttl`, `grace` and `ts.wall` are themselves valid (no cascade). Any
 *     other key of the lease is `body.lease.<key>`.
 *   - `supersedes`: not an object is `body.supersedes`; `holder` not a
 *     non-empty string is `body.supersedes.holder`; `expiresAt` not a
 *     non-negative safe integer is `body.supersedes.expiresAt`; `event` not
 *     matching `EVENT_HASH_PATTERN` is `body.supersedes.event`; any other
 *     key is `body.supersedes.<key>`. Missing parts are reported the same
 *     way.
 * - `ticket.renew`: `ttl` (safe integer in `TTL_MIN_MS`..`TTL_MAX_MS`,
 *   else `body.ttl`) and `expiresAt` (non-negative safe integer, else
 *   `body.expiresAt`), both required; an `expiresAt` that is not exactly
 *   `ts.wall + ttl` is `body.expiresAt`, checked only when `ttl` and
 *   `ts.wall` are valid.
 * - `ticket.release`, `ticket.queue.leave`: no keys.
 * - `ticket.release.force`: `holder` and `reason` non-empty strings, both
 *   required.
 * - `ticket.queue.join`: `ttl` required, as for `ticket.renew`.
 * - `ticket.grant`: `to` non-empty string, `ttl` as for `ticket.renew`,
 *   `window` a safe integer in `SETTING_MIN_MS`..`SETTING_MAX_MS` (else
 *   `body.window`) and `after`, all required. `after` missing or not an
 *   object is `body.after`; zero or both of `released` and `lease` is one
 *   reason `body.after`; `released` not matching `EVENT_HASH_PATTERN` is
 *   `body.after.released`; `lease` is checked like `supersedes` above under
 *   `body.after.lease` (not an object: `body.after.lease`; parts:
 *   `body.after.lease.holder`, `.expiresAt`, `.event`, other keys
 *   `body.after.lease.<key>`); any other key of `after` is
 *   `body.after.<key>`.
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
 * - `ticket.checklist.add`: `items` required, an array (else `body.items`)
 *   with at least one element (an empty array is one reason
 *   `body.items`). Each element must be an object (else `body.items.<i>`)
 *   with `text` a non-empty string (else `body.items.<i>.text`, also when
 *   missing) and `done` a boolean (else `body.items.<i>.done`, also when
 *   missing); any other key of an element is reported as
 *   `body.items.<i>.<key>`, and any other body key as `body.<key>`.
 * - `ticket.reconcile`: `updated`, `removed`, `added`, `forced` and
 *   `source` required, `title` and `holder` optional.
 *   - `title`: a non-empty string, else `body.title`.
 *   - `updated`: an array, else `body.updated`; each element an object
 *     (else `body.updated.<i>`) with `index` a safe integer (else
 *     `body.updated.<i>.index`; a negative index is well-formed here and
 *     rejected by the fold), `text` a non-empty string (else
 *     `body.updated.<i>.text`) and `done` a boolean (else
 *     `body.updated.<i>.done`), each also when missing; any other key is
 *     `body.updated.<i>.<key>`.
 *   - `removed`: an array (else `body.removed`) of safe integers (else
 *     `body.removed.<i>`).
 *   - `added`: an array (else `body.added`) whose elements are checked
 *     exactly like `ticket.checklist.add` items, under `body.added.<i>`.
 *   - `forced`: a boolean, else `body.forced`.
 *   - `holder`: a non-empty string, else `body.holder`; also `body.holder`
 *     when it is present and `forced` is not `true`.
 *   - `source`: a non-empty string, else `body.source`.
 *   - When `title` is absent and `updated`, `removed` and `added` are all
 *     empty arrays (and each is an array), one reason `body`: the event
 *     changes nothing.
 *   - Any other key is `body.<key>`.
 * - `ticket.renumber`: `from` and `to` non-empty strings, both required.
 * - `ticket.supersede`: `reason` non-empty string, required.
 * - `board.meta`: `key` non-empty string and `value` (any JSON value,
 *   including null) both required.
 *
 * Reserved actor (board-events: "Reserved system actor"): an event of any
 * kind other than `ticket.grant`, known or unknown, whose `actor` is
 * `SYSTEM_ACTOR`, and a `ticket.grant` whose valid `actor` is anything
 * else, are malformed with one reason `actor`.
 *
 * Unknown kinds: only the envelope (including the reserved actor rule) is
 * checked, and `body` must be an object.
 *
 * Every applicable reason is returned (a missing field yields exactly one
 * reason, not a cascade); order is unspecified.
 */
export function validateEvent(value: unknown): ValidationResult {
  if (!isObject(value)) {
    return { ok: false, reasons: [{ field: '', message: 'event is not a JSON object' }] };
  }
  const reasons: MalformedReason[] = [];
  const report: Report = (field, message) => {
    reasons.push({ field, message });
  };

  if (value.v !== SCHEMA_VERSION) {
    report('v', `must be ${String(SCHEMA_VERSION)}`);
  }
  const kind = isNonEmptyString(value.kind) ? value.kind : null;
  if (kind === null) {
    report('kind', 'must be a non-empty string');
  }
  checkTicket(value, kind, report);
  const actor = isNonEmptyString(value.actor) ? value.actor : null;
  if (actor === null) {
    report('actor', 'must be a non-empty string');
  }
  checkTs(value.ts, actor, report);
  checkReservedActor(kind, actor, report);
  const body = value.body;
  if (!isObject(body)) {
    report('body', 'must be a JSON object');
  } else if (kind !== null && isKnownKind(kind)) {
    BODY_CHECKS[kind](body, report, validWall(value.ts));
  }
  reportExtraKeys(value, ENVELOPE_KEYS, '', report);

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }
  // Every rule of the matching type has been checked above.
  return kind !== null && isKnownKind(kind)
    ? { ok: true, known: true, event: value as unknown as BoardEvent }
    : { ok: true, known: false, event: value as unknown as UnknownKindEvent };
}

type JsonRecord = Record<string, unknown>;
type Report = (field: string, message: string) => void;

/**
 * The reserved actor rule: only `ticket.grant` may be written by
 * `SYSTEM_ACTOR`, and a grant only by it. Checked only for a valid actor; a
 * grant's actor is checked whatever the rest of the event holds.
 */
function checkReservedActor(kind: string | null, actor: string | null, report: Report): void {
  if (actor === null) {
    return;
  }
  if (kind === 'ticket.grant' && actor !== SYSTEM_ACTOR) {
    report('actor', `a ticket.grant must be written by ${SYSTEM_ACTOR}`);
  } else if (kind !== 'ticket.grant' && actor === SYSTEM_ACTOR) {
    report('actor', `${SYSTEM_ACTOR} is reserved for ticket.grant`);
  }
}

/** `ts.wall` when `ts` is an object with a valid wall, else null (no cascade). */
function validWall(ts: unknown): number | null {
  return isObject(ts) && isNonNegativeSafeInteger(ts.wall) ? (ts.wall as number) : null;
}

const ENVELOPE_KEYS = ['v', 'kind', 'ticket', 'actor', 'ts', 'body'];
const TS_KEYS = ['wall', 'counter', 'actor'];
const TASK_REF_KEYS = ['source', 'ref', 'item'];

function isObject(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function isNonNegativeSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isStatus(value: unknown): boolean {
  return (STATUSES as readonly unknown[]).includes(value);
}

/** Reports `<prefix><key>` for every key of `obj` not in `allowed`. */
function reportExtraKeys(
  obj: JsonRecord,
  allowed: readonly string[],
  prefix: string,
  report: Report,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      report(`${prefix}${key}`, 'unexpected field');
    }
  }
}

/** `ticket` is absent on board.meta, required on other known kinds, optional otherwise. */
function checkTicket(event: JsonRecord, kind: string | null, report: Report): void {
  if (!Object.hasOwn(event, 'ticket')) {
    if (kind !== null && kind !== 'board.meta' && isKnownKind(kind)) {
      report('ticket', 'is required');
    }
  } else if (kind === 'board.meta') {
    report('ticket', 'must be absent on board.meta');
  } else if (!(typeof event.ticket === 'string' && isUlid(event.ticket))) {
    report('ticket', 'must be a ULID');
  }
}

function checkTs(ts: unknown, actor: string | null, report: Report): void {
  if (!isObject(ts)) {
    report('ts', 'must be a JSON object');
    return;
  }
  if (!isNonNegativeSafeInteger(ts.wall)) {
    report('ts.wall', 'must be a non-negative safe integer');
  }
  if (!isNonNegativeSafeInteger(ts.counter)) {
    report('ts.counter', 'must be a non-negative safe integer');
  }
  if (!isNonEmptyString(ts.actor)) {
    report('ts.actor', 'must be a non-empty string');
  } else if (actor !== null && ts.actor !== actor) {
    report('ts.actor', 'must equal actor');
  }
  reportExtraKeys(ts, TS_KEYS, 'ts.', report);
}

/** Problems with a task reference at `path` (`''` for a bare value), as reasons. */
function taskRefProblems(value: unknown, path: string): MalformedReason[] {
  const at = (key: string): string => (path === '' ? key : `${path}.${key}`);
  if (!isObject(value)) {
    return [{ field: path, message: 'task reference must be a JSON object' }];
  }
  const problems: MalformedReason[] = [];
  if (!(typeof value.source === 'string' && TASK_SOURCE_PATTERN.test(value.source))) {
    problems.push({ field: at('source'), message: `must match ${String(TASK_SOURCE_PATTERN)}` });
  }
  for (const key of ['ref', 'item']) {
    if (!isNonEmptyString(value[key])) {
      problems.push({ field: at(key), message: 'must be a non-empty string' });
    }
  }
  reportExtraKeys(value, TASK_REF_KEYS, `${path}.`, (field, message) => {
    problems.push({ field, message });
  });
  return problems;
}

/** A body field check: returns true when `value` is acceptable. */
type FieldRule = (value: unknown) => boolean;

const nonEmptyString: FieldRule = isNonEmptyString;
const anyValue: FieldRule = () => true;

/**
 * Checks a body against field rules and reports `body.<key>` for a missing
 * required field, a field breaking its rule, and any unlisted key.
 */
function checkFields(
  body: JsonRecord,
  required: Record<string, FieldRule>,
  optional: Record<string, FieldRule>,
  report: Report,
): void {
  for (const [key, rule] of Object.entries(required)) {
    if (!Object.hasOwn(body, key) || !rule(body[key])) {
      report(`body.${key}`, 'missing or invalid');
    }
  }
  for (const [key, rule] of Object.entries(optional)) {
    if (Object.hasOwn(body, key) && !rule(body[key])) {
      report(`body.${key}`, 'invalid');
    }
  }
  reportExtraKeys(body, [...Object.keys(required), ...Object.keys(optional)], 'body.', report);
}

/** Checks an optional array of non-empty strings, reporting the array or each bad element. */
function checkStringList(body: JsonRecord, key: string, report: Report): void {
  if (!Object.hasOwn(body, key)) {
    return;
  }
  const list = body[key];
  if (!Array.isArray(list)) {
    report(`body.${key}`, 'must be an array of non-empty strings');
    return;
  }
  list.forEach((item: unknown, i) => {
    if (!isNonEmptyString(item)) {
      report(`body.${key}.${String(i)}`, 'must be a non-empty string');
    }
  });
}

/**
 * Checks a body that must name exactly one of `targets`. Reports `body` when
 * zero or several are present; otherwise checks the one present with its rule.
 */
function checkExactlyOne(
  body: JsonRecord,
  targets: Record<string, (value: unknown, report: Report) => void>,
  report: Report,
): void {
  const present = Object.keys(targets).filter((key) => Object.hasOwn(body, key));
  const [only] = present;
  if (only === undefined || present.length > 1) {
    report('body', `must have exactly one of ${Object.keys(targets).join(', ')}`);
  } else {
    targets[only]?.(body[only], report);
  }
  reportExtraKeys(body, Object.keys(targets), 'body.', report);
}

function checkTaskRef(value: unknown, report: Report): void {
  for (const problem of taskRefProblems(value, 'body.task')) {
    report(problem.field, problem.message);
  }
}

/** Checks one `ticket.checklist.add` item: an object with non-empty `text` and boolean `done`. */
function checkChecklistAddItem(item: unknown, field: string, report: Report): void {
  if (!isObject(item)) {
    report(field, 'must be an object with text and done');
    return;
  }
  if (!isNonEmptyString(item.text)) {
    report(`${field}.text`, 'missing or not a non-empty string');
  }
  if (typeof item.done !== 'boolean') {
    report(`${field}.done`, 'missing or not a boolean');
  }
  reportExtraKeys(item, ['text', 'done'], `${field}.`, report);
}

function fieldCheck(key: string, rule: FieldRule): (value: unknown, report: Report) => void {
  return (value, report) => {
    if (!rule(value)) {
      report(`body.${key}`, 'invalid');
    }
  };
}

/** True for a safe integer in `min`..`max` inclusive. */
function inRange(min: number, max: number): FieldRule {
  return (value) =>
    Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

const isTtl = inRange(TTL_MIN_MS, TTL_MAX_MS);
const isSetting = inRange(SETTING_MIN_MS, SETTING_MAX_MS);
const isEventHash: FieldRule = (value) =>
  typeof value === 'string' && EVENT_HASH_PATTERN.test(value);

/**
 * Checks a nested object at `path` against field rules, all required:
 * reports `path` when it is not an object, `<path>.<key>` for a missing or
 * invalid field and for any unlisted key. Returns the object when it is one.
 */
function checkNested(
  value: unknown,
  path: string,
  rules: Record<string, FieldRule>,
  report: Report,
): JsonRecord | null {
  if (!isObject(value)) {
    report(path, 'must be a JSON object');
    return null;
  }
  for (const [key, rule] of Object.entries(rules)) {
    if (!Object.hasOwn(value, key) || !rule(value[key])) {
      report(`${path}.${key}`, 'missing or invalid');
    }
  }
  reportExtraKeys(value, Object.keys(rules), `${path}.`, report);
  return value;
}

/** Checks a `LeaseRef` (a claim's `supersedes`, a grant's `after.lease`) at `path`. */
function checkLeaseRef(value: unknown, path: string, report: Report): void {
  checkNested(
    value,
    path,
    { holder: nonEmptyString, expiresAt: isNonNegativeSafeInteger, event: isEventHash },
    report,
  );
}

/**
 * Checks a claim's `lease` at `body.lease`, including `expiresAt = wall +
 * min(ttl, grace)` when `ttl`, `grace` and `wall` are all valid.
 */
function checkClaimLease(value: unknown, wall: number | null, report: Report): void {
  const lease = checkNested(
    value,
    'body.lease',
    { ttl: isTtl, grace: isSetting, expiresAt: isNonNegativeSafeInteger },
    report,
  );
  if (lease === null || wall === null || !isTtl(lease.ttl) || !isSetting(lease.grace)) {
    return;
  }
  const expected = wall + Math.min(lease.ttl as number, lease.grace as number);
  if (isNonNegativeSafeInteger(lease.expiresAt) && lease.expiresAt !== expected) {
    report('body.lease.expiresAt', `must be ts.wall + min(ttl, grace) = ${String(expected)}`);
  }
}

/** Checks a grant's `after`: exactly one of `released` (an event hash) or `lease`. */
function checkGrantAfter(value: unknown, report: Report): void {
  if (!isObject(value)) {
    report('body.after', 'must be a JSON object');
    return;
  }
  const hasReleased = Object.hasOwn(value, 'released');
  const hasLease = Object.hasOwn(value, 'lease');
  if (hasReleased === hasLease) {
    report('body.after', 'must have exactly one of released, lease');
  } else if (hasReleased) {
    if (!isEventHash(value.released)) {
      report('body.after.released', 'must be an event hash');
    }
  } else {
    checkLeaseRef(value.lease, 'body.after.lease', report);
  }
  reportExtraKeys(value, ['released', 'lease'], 'body.after.', report);
}

/** Checks one `updated` line of a `ticket.reconcile` at `field`. */
function checkReconcileUpdate(item: unknown, field: string, report: Report): void {
  if (!isObject(item)) {
    report(field, 'must be an object with index, text and done');
    return;
  }
  if (!Number.isSafeInteger(item.index)) {
    report(`${field}.index`, 'missing or not an integer');
  }
  if (!isNonEmptyString(item.text)) {
    report(`${field}.text`, 'missing or not a non-empty string');
  }
  if (typeof item.done !== 'boolean') {
    report(`${field}.done`, 'missing or not a boolean');
  }
  reportExtraKeys(item, ['index', 'text', 'done'], `${field}.`, report);
}

/**
 * Checks the array `body.<key>` with `element` for each item. Returns the
 * array's length, or null when it is not an array (reported).
 */
function checkArray(
  body: JsonRecord,
  key: string,
  element: (item: unknown, field: string, report: Report) => void,
  report: Report,
): number | null {
  const value = body[key];
  if (!Array.isArray(value)) {
    report(`body.${key}`, 'missing or not an array');
    return null;
  }
  value.forEach((item: unknown, i) => {
    element(item, `body.${key}.${String(i)}`, report);
  });
  return value.length;
}

/** Checks a `ticket.reconcile` body (see `validateEvent`). */
function checkReconcile(body: JsonRecord, report: Report): void {
  const hasTitle = Object.hasOwn(body, 'title');
  if (hasTitle && !isNonEmptyString(body.title)) {
    report('body.title', 'must be a non-empty string');
  }
  const lengths = [
    checkArray(body, 'updated', checkReconcileUpdate, report),
    checkArray(
      body,
      'removed',
      (item, field, r) => {
        if (!Number.isSafeInteger(item)) {
          r(field, 'must be an integer');
        }
      },
      report,
    ),
    checkArray(body, 'added', checkChecklistAddItem, report),
  ];
  if (typeof body.forced !== 'boolean') {
    report('body.forced', 'missing or not a boolean');
  }
  if (Object.hasOwn(body, 'holder')) {
    if (!isNonEmptyString(body.holder)) {
      report('body.holder', 'must be a non-empty string');
    } else if (body.forced !== true) {
      report('body.holder', 'only allowed when forced is true');
    }
  }
  if (!isNonEmptyString(body.source)) {
    report('body.source', 'missing or not a non-empty string');
  }
  if (!hasTitle && lengths.every((length) => length === 0)) {
    report('body', 'a reconcile must change the title or at least one line');
  }
  reportExtraKeys(
    body,
    ['title', 'updated', 'removed', 'added', 'forced', 'holder', 'source'],
    'body.',
    report,
  );
}

/** A body check; `wall` is the event's valid `ts.wall`, or null. */
type BodyCheck = (body: JsonRecord, report: Report, wall: number | null) => void;

const BODY_CHECKS: Record<KnownKind, BodyCheck> = {
  'ticket.create': (body, report) => {
    checkFields(
      body,
      { title: nonEmptyString },
      {
        description: (v) => typeof v === 'string',
        labels: anyValue,
        checklist: anyValue,
        task: anyValue,
        adhoc: nonEmptyString,
      },
      report,
    );
    checkStringList(body, 'labels', report);
    checkStringList(body, 'checklist', report);
    if (Object.hasOwn(body, 'task')) {
      checkTaskRef(body.task, report);
      if (isNonEmptyString(body.adhoc)) {
        report('body.adhoc', 'must not be present together with task');
      }
    }
  },
  'ticket.comment': (body, report) => {
    checkFields(body, { text: nonEmptyString }, {}, report);
  },
  'ticket.move': (body, report) => {
    checkFields(body, { to: isStatus }, {}, report);
  },
  'ticket.assign': (body, report) => {
    checkFields(body, { to: nonEmptyString }, {}, report);
  },
  'ticket.claim': (body, report, wall) => {
    if (Object.hasOwn(body, 'lease')) {
      checkClaimLease(body.lease, wall, report);
    }
    if (Object.hasOwn(body, 'supersedes')) {
      checkLeaseRef(body.supersedes, 'body.supersedes', report);
    }
    reportExtraKeys(body, ['lease', 'supersedes'], 'body.', report);
  },
  'ticket.renew': (body, report, wall) => {
    checkFields(body, { ttl: isTtl, expiresAt: isNonNegativeSafeInteger }, {}, report);
    if (wall !== null && isTtl(body.ttl) && isNonNegativeSafeInteger(body.expiresAt)) {
      const expected = wall + (body.ttl as number);
      if (body.expiresAt !== expected) {
        report('body.expiresAt', `must be ts.wall + ttl = ${String(expected)}`);
      }
    }
  },
  'ticket.release': (body, report) => {
    checkFields(body, {}, {}, report);
  },
  'ticket.release.force': (body, report) => {
    checkFields(body, { holder: nonEmptyString, reason: nonEmptyString }, {}, report);
  },
  'ticket.queue.join': (body, report) => {
    checkFields(body, { ttl: isTtl }, {}, report);
  },
  'ticket.queue.leave': (body, report) => {
    checkFields(body, {}, {}, report);
  },
  'ticket.grant': (body, report) => {
    checkFields(
      body,
      { to: nonEmptyString, ttl: isTtl, window: isSetting, after: anyValue },
      {},
      report,
    );
    if (Object.hasOwn(body, 'after')) {
      checkGrantAfter(body.after, report);
    }
  },
  'ticket.handoff': (body, report) => {
    checkFields(body, { to: nonEmptyString, status: isStatus, note: nonEmptyString }, {}, report);
  },
  'ticket.link': (body, report) => {
    checkExactlyOne(
      body,
      {
        task: checkTaskRef,
        pr: fieldCheck(
          'pr',
          (v) => isNonEmptyString(v) || (Number.isSafeInteger(v) && (v as number) > 0),
        ),
        decision: fieldCheck('decision', nonEmptyString),
      },
      report,
    );
  },
  'ticket.close': (body, report) => {
    checkExactlyOne(
      body,
      {
        decision: fieldCheck('decision', nonEmptyString),
        noDecision: fieldCheck('noDecision', (v) => v === true),
      },
      report,
    );
  },
  'ticket.checklist': (body, report) => {
    checkFields(
      body,
      { index: Number.isSafeInteger, done: (v) => typeof v === 'boolean' },
      {},
      report,
    );
  },
  'ticket.checklist.add': (body, report) => {
    const items = body.items;
    if (!Array.isArray(items) || items.length === 0) {
      report('body.items', 'missing or not a non-empty array');
    } else {
      items.forEach((item: unknown, i) => {
        checkChecklistAddItem(item, `body.items.${String(i)}`, report);
      });
    }
    reportExtraKeys(body, ['items'], 'body.', report);
  },
  'ticket.reconcile': checkReconcile,
  'ticket.renumber': (body, report) => {
    checkFields(body, { from: nonEmptyString, to: nonEmptyString }, {}, report);
  },
  'ticket.supersede': (body, report) => {
    checkFields(body, { reason: nonEmptyString }, {}, report);
  },
  'board.meta': (body, report) => {
    checkFields(body, { key: nonEmptyString, value: anyValue }, {}, report);
  },
};
