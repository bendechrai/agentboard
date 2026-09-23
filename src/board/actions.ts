/**
 * Writing operations on an existing ticket: `claim`, `release`, `move`,
 * `comment`, `handoff`, `link`, `checklist tick|untick` and `close`
 * (board-cli: "Status state machine", "Claim, release and handoff", "Close
 * requires a decision disposition"; board-openspec-integration:
 * "Decisions are promoted, not buried", "Completion truth stays in
 * tasks").
 *
 * Every operation here:
 * - runs through `runCommand` (one `BEGIN IMMEDIATE` transaction), so its
 *   validation sees the state after catch-up, under the write lock;
 * - resolves `id` (full id or prefix of at least 6 characters) inside that
 *   transaction with `resolveTicketId`, refusing with exit 1
 *   `id-too-short` or `ambiguous-id`, or exit 4 `unknown-ticket`;
 * - relies on the fold's own rules (through `runCommand`) for the state
 *   machine and assignment checks, so a refusal is exit 4 with the fold
 *   rejection reason (`invalid-transition`, `already-assigned`,
 *   `not-assignee`, `checklist-index`, `needs-task-link`) and writes
 *   nothing;
 * - throws `BoardError(1, 'missing-actor')` when `actor` is empty.
 */

import type { TaskRef, Status } from '../events/schema.js';
import type { Board } from '../store/board.js';
import type { TaskReminder } from './reminder.js';
import { notImplemented } from './stub.js';
import type { WriteOptions, WriteOutcome } from './types.js';

/**
 * `claim`: writes `ticket.claim`, assigning the ticket to `actor`.
 *
 * - Unassigned: the claim is written.
 * - Already assigned to `actor` (a retried claim): succeeds without
 *   writing anything, returning `hash: null` and the current ticket.
 * - Assigned to someone else: `BoardError(4, 'already-assigned')` whose
 *   message names the current assignee; nothing is written.
 */
export function claimTicket(
  board: Board,
  actor: string,
  input: { id: string },
  options?: WriteOptions,
): WriteOutcome {
  throw notImplemented(board, actor, input, options);
}

/**
 * `release`: writes `ticket.release`, clearing the assignment. Refused by
 * the fold with exit 4 `not-assignee` unless `actor` is the assignee (an
 * unassigned ticket included).
 */
export function releaseTicket(
  board: Board,
  actor: string,
  input: { id: string },
  options?: WriteOptions,
): WriteOutcome {
  throw notImplemented(board, actor, input, options);
}

/**
 * `move`: writes `ticket.move` with an explicit target.
 *
 * - `to` given: that target. The state machine decides (exit 4
 *   `invalid-transition`, including a move to the current status and every
 *   move out of `merged`; exit 4 `needs-task-link` for a ticket without a
 *   task reference entering `implementing`).
 * - `to` omitted on a `blocked` ticket: the remembered origin
 *   (`blockedFrom`); the event still names it.
 * - `to` omitted on any other ticket: `BoardError(1, 'missing-status')`
 *   saying a target status is required unless the ticket is blocked.
 */
export function moveTicket(
  board: Board,
  actor: string,
  input: { id: string; to?: Status | undefined },
  options?: WriteOptions,
): WriteOutcome {
  throw notImplemented(board, actor, input, options);
}

/**
 * `comment`: writes `ticket.comment`. Empty text is `BoardError(1,
 * 'usage')`; secret-looking text is refused with `refuseSecretLike` (exit
 * 1 `secret-like`, nothing written) unless `allowSecretLike`. Comments on a
 * closed ticket are accepted.
 */
export function commentTicket(
  board: Board,
  actor: string,
  input: { id: string; text: string; allowSecretLike?: boolean | undefined },
  options?: WriteOptions,
): WriteOutcome {
  throw notImplemented(board, actor, input, options);
}

/** Input of `handoffTicket`. */
export interface HandoffInput {
  id: string;
  /** New assignee; non-empty. */
  to: string;
  /** Target status; equal to the current status means reassignment only. */
  status: Status;
  /** Becomes a comment by `actor`; non-empty. */
  note: string;
  allowSecretLike?: boolean | undefined;
}

/**
 * `handoff`: writes exactly one `ticket.handoff` event that assigns `to`,
 * moves to `status` (no transition when it equals the current status) and
 * adds `note` as a comment by `actor`. An invalid transition is exit 4 and
 * writes nothing. Empty `to` or `note` is `BoardError(1, 'usage')`; the
 * note is checked with `refuseSecretLike` unless `allowSecretLike`.
 */
export function handoffTicket(
  board: Board,
  actor: string,
  input: HandoffInput,
  options?: WriteOptions,
): WriteOutcome {
  throw notImplemented(board, actor, input, options);
}

/**
 * What `link` attaches: a task reference (replacing the ticket's task and
 * clearing its ad hoc reason), a PR (URL string or positive number) or a
 * decision record path (stored as given, not checked for existence).
 */
export type LinkTarget = { task: TaskRef } | { pr: string | number } | { decision: string };

/**
 * `link`: writes `ticket.link` with the one target. An empty `pr` string,
 * a `pr` number that is not a positive safe integer, or an empty
 * `decision` is `BoardError(1, 'usage')`.
 */
export function linkTicket(
  board: Board,
  actor: string,
  input: { id: string; target: LinkTarget },
  options?: WriteOptions,
): WriteOutcome {
  throw notImplemented(board, actor, input, options);
}

/** Result of `setChecklistItem`; also the `checklist tick|untick --json` document. */
export interface ChecklistOutcome extends WriteOutcome {
  /**
   * For a tick, the tasks-file reminder (`taskReminder` with the host
   * project root, the parent of `board.dir`, and the ticket after the
   * event); null for an untick.
   */
  reminder: TaskReminder | null;
}

/**
 * `checklist tick` (`done: true`) and `checklist untick` (`done: false`):
 * writes `ticket.checklist` for the 0-based `index`. Out of range
 * (negative or not less than the checklist length) is exit 4
 * `checklist-index`. Updates only the ticket's own checklist; the tasks
 * file is never written.
 */
export function setChecklistItem(
  board: Board,
  actor: string,
  input: { id: string; index: number; done: boolean },
  options?: WriteOptions,
): ChecklistOutcome {
  throw notImplemented(board, actor, input, options);
}

/** How a ticket is closed: `--decision-recorded-in <path>` or `--no-decision`. */
export type CloseInput =
  | { id: string; decisionRecordedIn: string; cwd?: string | undefined }
  | { id: string; noDecision: true };

/** The comment prefix that marks a decision (board-openspec-integration). */
export const DECISION_PREFIX = 'DECISION:';

/** The comment prefix that retracts the same actor's earlier decisions. */
export const RETRACTED_PREFIX = 'RETRACTED:';

/**
 * The comments of a ticket that still block a `--no-decision` close: every
 * comment (handoff notes included) whose text starts with
 * `DECISION_PREFIX` (case-sensitive, at the very start of the text) and
 * that is not followed, later in the comment list, by a comment by the
 * same actor starting with `RETRACTED_PREFIX`. One `RETRACTED:` comment
 * retracts every earlier `DECISION:` comment by its actor. Returned in
 * comment order. Pure.
 */
export function openDecisions(
  comments: readonly { actor: string; text: string }[],
): { actor: string; text: string }[] {
  throw notImplemented(comments);
}

/**
 * `close`: writes `ticket.close` with the disposition.
 *
 * - `decisionRecordedIn`: the path must exist, resolved against `cwd`
 *   (default `process.cwd()`); otherwise `BoardError(1,
 *   'decision-path-missing')` naming the path as given. The path is stored
 *   as given.
 * - `noDecision`: refused with `BoardError(1, 'unpromoted-decision')` when
 *   `openDecisions(ticket.comments)` is not empty; the message quotes each
 *   such comment and states the rule (a decision made in a ticket must be
 *   recorded in a spec delta or ADR and named with
 *   `--decision-recorded-in`, or retracted with a `RETRACTED:` comment by
 *   the same actor).
 * - The fold refuses a close unless the ticket is in `merged` or `blocked`
 *   and not already closed: exit 4 `invalid-transition`.
 */
export function closeTicket(
  board: Board,
  actor: string,
  input: CloseInput,
  options?: WriteOptions,
): WriteOutcome {
  throw notImplemented(board, actor, input, options);
}
