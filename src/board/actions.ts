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

import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Ticket } from '../events/fold.js';
import type { TaskRef, Status } from '../events/schema.js';
import { asciiText } from './text.js';
import type { Board } from '../store/board.js';
import { BoardError } from '../store/errors.js';
import { runCommand, type ProposedEvent } from '../store/transaction.js';
import { requireActor, resolveTicket, ticketOf } from './lookup.js';
import { treePath, type TreePathOptions } from './paths.js';
import { taskReminder, type TaskReminder } from './reminder.js';
import { refuseSecretLike } from './secrets.js';
import type { WriteOptions, WriteOutcome } from './types.js';

/**
 * Runs one writing command on the ticket named by `id`: resolves it inside
 * the command transaction and writes the event `build` proposes for it.
 * `build` may throw to refuse (the transaction is rolled back).
 */
function writeTicketEvent(
  board: Board,
  actor: string,
  id: string,
  build: (ticket: Ticket) => ProposedEvent,
  options: WriteOptions | undefined,
): WriteOutcome {
  requireActor(actor);
  const result = runCommand(
    board,
    actor,
    () => ({ ok: true, event: build(resolveTicket(board.db, id)) }),
    options,
  );
  return { hash: result.hash, ticket: ticketOf(result.ticket) };
}

/**
 * Thrown inside the claim transaction when the actor already holds the
 * ticket, so the transaction is rolled back and `claimTicket` reports the
 * ticket as read in it without writing an event. Never escapes this module.
 */
class AlreadyHeld extends Error {
  readonly ticket: Ticket;

  constructor(ticket: Ticket) {
    super(`ticket ${ticket.id} is already held by its claimant`);
    this.ticket = ticket;
  }
}

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
  try {
    return writeTicketEvent(
      board,
      actor,
      input.id,
      (ticket) => {
        if (ticket.assignee === actor) {
          throw new AlreadyHeld(ticket);
        }
        return { kind: 'ticket.claim', ticket: ticket.id, body: {} };
      },
      options,
    );
  } catch (error) {
    if (error instanceof AlreadyHeld) {
      return { hash: null, ticket: error.ticket };
    }
    throw error;
  }
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
  return writeTicketEvent(
    board,
    actor,
    input.id,
    (ticket) => ({ kind: 'ticket.release', ticket: ticket.id, body: {} }),
    options,
  );
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
  return writeTicketEvent(
    board,
    actor,
    input.id,
    (ticket) => {
      const to = input.to ?? (ticket.status === 'blocked' ? ticket.blockedFrom : null);
      if (to === null) {
        throw new BoardError(
          1,
          'missing-status',
          `a target status is required: ticket ${ticket.id} is ${ticket.status}, not blocked`,
        );
      }
      return { kind: 'ticket.move', ticket: ticket.id, body: { to } };
    },
    options,
  );
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
  requireActor(actor);
  if (input.text === '') {
    throw new BoardError(1, 'usage', 'the comment text must not be empty');
  }
  refuseSecretLike([input.text], input.allowSecretLike === true);
  return writeTicketEvent(
    board,
    actor,
    input.id,
    (ticket) => ({ kind: 'ticket.comment', ticket: ticket.id, body: { text: input.text } }),
    options,
  );
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
  requireActor(actor);
  if (input.to === '') {
    throw new BoardError(1, 'usage', 'handoff needs a non-empty --to');
  }
  if (input.note === '') {
    throw new BoardError(1, 'usage', 'handoff needs a non-empty --note');
  }
  refuseSecretLike([input.note], input.allowSecretLike === true);
  return writeTicketEvent(
    board,
    actor,
    input.id,
    (ticket) => ({
      kind: 'ticket.handoff',
      ticket: ticket.id,
      body: { to: input.to, status: input.status, note: input.note },
    }),
    options,
  );
}

/**
 * What `link` attaches: a task reference (replacing the ticket's task and
 * clearing its ad hoc reason), a PR (URL string or positive number) or a
 * decision record path (passed through `treePath` and recorded
 * root-relative; not checked for existence).
 */
export type LinkTarget = { task: TaskRef } | { pr: string | number } | { decision: string };

/**
 * `link`: writes `ticket.link` with the one target. An empty `pr` string,
 * a `pr` number that is not a positive safe integer, or an empty
 * `decision` is `BoardError(1, 'usage')`. A `decision` path is resolved
 * with `treePath` (using `input.cwd` and `input.env`) and the event records
 * its `recorded` form; a path outside the working tree is exit 1
 * `path-outside-tree`; the path need not exist.
 */
export function linkTicket(
  board: Board,
  actor: string,
  input: { id: string; target: LinkTarget } & TreePathOptions,
  options?: WriteOptions,
): WriteOutcome {
  requireActor(actor);
  const target = linkBody(input.target, input);
  return writeTicketEvent(
    board,
    actor,
    input.id,
    (ticket) => ({ kind: 'ticket.link', ticket: ticket.id, body: target }),
    options,
  );
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
  const outcome = writeTicketEvent(
    board,
    actor,
    input.id,
    (ticket) => ({
      kind: 'ticket.checklist',
      ticket: ticket.id,
      body: { index: input.index, done: input.done },
    }),
    options,
  );
  const reminder = input.done
    ? taskReminder(dirname(board.dir), outcome.ticket, input.index)
    : null;
  return { ...outcome, reminder };
}

/** How a ticket is closed: `--decision-recorded-in <path>` or `--no-decision`. */
export type CloseInput =
  ({ id: string; decisionRecordedIn: string } & TreePathOptions) | { id: string; noDecision: true };

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
  const lastRetraction = new Map<string, number>();
  comments.forEach((comment, index) => {
    if (comment.text.startsWith(RETRACTED_PREFIX)) {
      lastRetraction.set(comment.actor, index);
    }
  });
  return comments
    .filter(
      (comment, index) =>
        comment.text.startsWith(DECISION_PREFIX) &&
        (lastRetraction.get(comment.actor) ?? -1) < index,
    )
    .map((comment) => ({ actor: comment.actor, text: comment.text }));
}

/**
 * `close`: writes `ticket.close` with the disposition.
 *
 * - `decisionRecordedIn`: resolved with `treePath` (`cwd`, `env`); outside
 *   the working tree is `BoardError(1, 'path-outside-tree')`; the
 *   resolved file must exist, otherwise `BoardError(1,
 *   'decision-path-missing')` naming the path as given. The event records
 *   the root-relative `recorded` form (with `/` separators), so a close run
 *   from a subdirectory records the same path as one run from the root.
 * - `noDecision`: refused with `BoardError(1, 'unpromoted-decision')` when
 *   `openDecisions(ticket.comments)` is not empty; the message quotes each
 *   such comment and states the rule (a decision made in a ticket must be
 *   recorded in a spec delta or ADR and named with
 *   `--decision-recorded-in`, or retracted with a `RETRACTED:` comment by
 *   the same actor).
 * - The fold refuses a close unless the ticket is in `merged` or `blocked`
 *   and not already closed: exit 4 `invalid-transition`.
 *
 * Check order (group 3 round 2 ruling): usage errors (neither or both
 * dispositions, at the parser) first; then the path checks
 * (`path-outside-tree`, then `decision-path-missing`); then closability
 * (exit 4 `invalid-transition` for a ticket not in `merged` or `blocked`,
 * or already closed); only then, for a closable ticket, the decision guard
 * (exit 1 `unpromoted-decision`). So `--no-decision` on a `todo` ticket
 * with an open `DECISION:` comment is exit 4 `invalid-transition`.
 */
export function closeTicket(
  board: Board,
  actor: string,
  input: CloseInput,
  options?: WriteOptions,
): WriteOutcome {
  requireActor(actor);
  let body: { decision: string } | { noDecision: true } = { noDecision: true };
  if ('decisionRecordedIn' in input) {
    const path = treePath(input.decisionRecordedIn, input);
    if (!existsSync(path.absolute)) {
      throw new BoardError(
        1,
        'decision-path-missing',
        `the decision record ${asciiText(input.decisionRecordedIn)} does not exist`,
      );
    }
    body = { decision: path.recorded };
  }
  return writeTicketEvent(
    board,
    actor,
    input.id,
    (ticket) => {
      // A ticket that cannot be closed is left to the fold's own
      // invalid-transition refusal, which comes before the decision guard.
      const closable =
        !ticket.closed && (ticket.status === 'merged' || ticket.status === 'blocked');
      const open = closable && 'noDecision' in body ? openDecisions(ticket.comments) : [];
      if (open.length > 0) {
        const quoted = open.map((c) => `  ${asciiText(c.actor)}: "${asciiText(c.text)}"`);
        throw new BoardError(
          1,
          'unpromoted-decision',
          [
            `ticket ${ticket.id} cannot be closed with --no-decision; it has decision comments:`,
            ...quoted,
            'A decision made in a ticket must be recorded in a spec delta or ADR and named ' +
              'with --decision-recorded-in <path>, or retracted with a RETRACTED: comment ' +
              'by the same actor.',
          ].join('\n'),
        );
      }
      return { kind: 'ticket.close', ticket: ticket.id, body };
    },
    options,
  );
}

/** The `ticket.link` body for a target, after the checks `linkTicket` documents. */
function linkBody(target: LinkTarget, where: TreePathOptions): LinkTarget {
  if ('task' in target) {
    return { task: { ...target.task } };
  }
  if ('pr' in target) {
    const pr = target.pr;
    if (typeof pr === 'string' ? pr === '' : !(Number.isSafeInteger(pr) && pr > 0)) {
      throw new BoardError(
        1,
        'usage',
        'a pr link needs a non-empty URL or a positive whole PR number',
      );
    }
    return { pr };
  }
  return { decision: treePath(target.decision, where).recorded };
}
