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
import { isUlid } from './ulid.js';

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

/** One line appended by `ticket.checklist.add`. */
export interface TicketChecklistAddItem {
  /** Non-empty. */
  text: string;
  done: boolean;
}

/**
 * `ticket.checklist.add` (added by the group 7 ruling for re-import):
 * `items` is a non-empty array of checklist lines, appended by the fold in
 * array order after the ticket's existing lines.
 */
export interface TicketChecklistAddBody {
  items: TicketChecklistAddItem[];
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
export type TicketChecklistAddEvent = TicketEnvelope<
  'ticket.checklist.add',
  TicketChecklistAddBody
>;

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
  | TicketChecklistEvent
  | TicketChecklistAddEvent;

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
  'ticket.checklist.add',
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
 * - `ticket.checklist.add`: `items` required, an array (else `body.items`)
 *   with at least one element (an empty array is one reason
 *   `body.items`). Each element must be an object (else `body.items.<i>`)
 *   with `text` a non-empty string (else `body.items.<i>.text`, also when
 *   missing) and `done` a boolean (else `body.items.<i>.done`, also when
 *   missing); any other key of an element is reported as
 *   `body.items.<i>.<key>`, and any other body key as `body.<key>`.
 * - `board.meta`: `key` non-empty string and `value` (any JSON value,
 *   including null) both required.
 *
 * Unknown kinds: only the envelope is checked, and `body` must be an object.
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
  const body = value.body;
  if (!isObject(body)) {
    report('body', 'must be a JSON object');
  } else if (kind !== null && isKnownKind(kind)) {
    BODY_CHECKS[kind](body, report);
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

function fieldCheck(key: string, rule: FieldRule): (value: unknown, report: Report) => void {
  return (value, report) => {
    if (!rule(value)) {
      report(`body.${key}`, 'invalid');
    }
  };
}

const BODY_CHECKS: Record<KnownKind, (body: JsonRecord, report: Report) => void> = {
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
  'ticket.claim': (body, report) => {
    checkFields(body, {}, {}, report);
  },
  'ticket.release': (body, report) => {
    checkFields(body, {}, {}, report);
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
  'ticket.checklist.add': () => {
    throw new Error('not implemented');
  },
  'board.meta': (body, report) => {
    checkFields(body, { key: nonEmptyString, value: anyValue }, {}, report);
  },
};
