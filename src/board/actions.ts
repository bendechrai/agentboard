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
 *   `not-assignee`, `checklist-index`, `needs-scope-disposition`,
 *   `already-linked`) and writes nothing;
 * - throws `BoardError(1, 'missing-actor')` when `actor` is empty.
 */

import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { openDecisions } from '../events/decisions.js';
import { leaseGrace, type Ticket } from '../events/fold.js';
import {
  LEASE_SKEW_MS,
  TTL_MAX_MS,
  TTL_MIN_MS,
  type Status,
  type TaskRef,
  type TicketClaimBody,
} from '../events/schema.js';
import { asciiText } from './text.js';
import type { Board } from '../store/board.js';
import { BoardError } from '../store/errors.js';
import {
  NoWrite,
  alreadyLinkedMessage,
  runCommand,
  type ProposedEvent,
  type ProposedEvents,
  type TxContext,
} from '../store/transaction.js';
import { isoTime } from './leases.js';
import { requireActor, resolveTicket, ticketOf } from './lookup.js';
import { treePath, type TreePathOptions } from './paths.js';
import { taskReminder, type TaskReminder } from './reminder.js';
import { taskRefFromArgs, type TaskArgs } from './resolve.js';
import { refuseSecretLike } from './secrets.js';
import type { WriteOptions, WriteOutcome } from './types.js';

// openDecisions and the decision prefixes live in the pure module
// src/events/decisions.ts and are re-exported here as part of the library
// API.
export { DECISION_PREFIX, RETRACTED_PREFIX, openDecisions } from '../events/decisions.js';

/**
 * Runs one writing command on the ticket named by `id`: resolves it inside
 * the command transaction and writes the event `build` proposes for it.
 * `build` may throw to refuse (the transaction is rolled back).
 */
function writeTicketEvent(
  board: Board,
  actor: string,
  id: string,
  build: (ticket: Ticket, ctx: TxContext) => ProposedEvent,
  options: WriteOptions | undefined,
): WriteOutcome {
  return writeTicketEvents(board, actor, id, (ticket, ctx) => [build(ticket, ctx)], options);
}

/**
 * As `writeTicketEvent`, for a command that writes one or two events in
 * one transaction (a scope disposition and then its move or close):
 * `runCommand` folds them in memory in order, so a refusal of either
 * writes nothing. `build` also receives the transaction context (the
 * clock and the first event's timestamp) for the lease commands.
 */
function writeTicketEvents(
  board: Board,
  actor: string,
  id: string,
  build: (ticket: Ticket, ctx: TxContext) => ProposedEvents,
  options: WriteOptions | undefined,
): WriteOutcome {
  requireActor(actor);
  const result = runCommand(
    board,
    actor,
    (ctx) => ({ ok: true, events: build(resolveTicket(board.db, id), ctx) }),
    options,
  );
  return {
    hash: result.hash,
    events: result.events.map((written) => written.hash),
    ticket: ticketOf(result.ticket),
  };
}

/**
 * Thrown inside the claim transaction when nothing needs writing (the
 * actor already holds the ticket, or is already queued), carrying the
 * result read in that transaction; `runCommand` commits the catch-up and
 * `claimTicket` returns the outcome. Never escapes this module.
 */
class ClaimNoWrite extends NoWrite {
  readonly outcome: ClaimOutcome;

  constructor(outcome: ClaimOutcome) {
    super('the claim has nothing to write');
    this.outcome = outcome;
  }
}

/**
 * `ttl` must be a safe integer in `TTL_MIN_MS`..`TTL_MAX_MS` (milliseconds),
 * else `BoardError(1, 'usage')`, exactly `invalid ttl: a ttl is a whole
 * number of milliseconds from 30000 (30s) to 604800000 (7d)`, which does
 * not repeat the number given; the command line parser has already
 * refused a malformed duration, so this covers library callers.
 */
function checkTtl(ttl: number): void {
  if (!Number.isSafeInteger(ttl) || ttl < TTL_MIN_MS || ttl > TTL_MAX_MS) {
    throw new BoardError(
      1,
      'usage',
      `invalid ttl ${String(ttl)}: a ttl is a whole number of milliseconds from ${String(TTL_MIN_MS)} (30s) to ${String(TTL_MAX_MS)} (7d)`,
    );
  }
}

/** The `QueuedOutcome` of `actor` queued on `ticket`, in its key order. */
function queuedOutcome(ticket: Ticket, actor: string): QueuedOutcome {
  return {
    queued: true,
    position: ticket.queue.findIndex((waiter) => waiter.actor === actor) + 1,
    holder: ticket.assignee,
    ticket: ticket.id,
  };
}

/**
 * The refusal of a `claim` by the state of the ticket (board-cli: "Claim,
 * release and handoff", "Lease and queue hints"): a `BoardError` with exit
 * code 4 and reason `already-assigned` or `queued`, carrying what the hint
 * needs, since a plain `BoardError` carries no details. `hintFor`
 * (`src/guidance/hints.ts`) reads `lease` to name the time from which the
 * ticket can be claimed.
 */
export class ClaimRefusedError extends BoardError {
  /** The assignee at the time of the refusal, or null (a free ticket with waiters). */
  readonly holder: string | null;
  /**
   * For `already-assigned` on a ticket held under a lease: its `expiresAt`
   * and `claimableAt` (`expiresAt + LEASE_SKEW_MS`); null otherwise.
   */
  readonly lease: { readonly expiresAt: number; readonly claimableAt: number } | null;

  constructor(
    reason: 'already-assigned' | 'queued',
    message: string,
    holder: string | null,
    lease: { readonly expiresAt: number; readonly claimableAt: number } | null,
  ) {
    super(4, reason, message);
    this.name = 'ClaimRefusedError';
    this.holder = holder;
    this.lease = lease;
  }
}

/** Input of `claimTicket`. */
export interface ClaimInput {
  id: string;
  /**
   * `--ttl`: the lease to ask for, in milliseconds (the registry parses the
   * duration with `parseTtl`). Must be a safe integer in
   * `TTL_MIN_MS`..`TTL_MAX_MS`, else `BoardError(1, 'usage')`.
   */
  ttl?: number | undefined;
  /**
   * `--wait`: join the queue when the ticket cannot be claimed at once,
   * without blocking (the foreground wait of the CLI is built on top of
   * this). Needs `ttl`.
   */
  wait?: boolean | undefined;
}

/**
 * The result of a claim that holds the ticket (it was written, or the
 * actor already held it): the ordinary `WriteOutcome`, plus `queued: false`
 * exactly when `wait` was given (absent otherwise, so a plain claim's
 * document is unchanged).
 */
export type ClaimedOutcome = WriteOutcome & { queued?: false };

/**
 * The result of a `claim` with `wait` that joined (or was already in) the
 * queue: exactly these four keys, in this order, and also the `--json`
 * document and the MCP structured content (board-cli: "Lease and queue
 * tools over MCP", scenario "MCP wait returns at once").
 */
export interface QueuedOutcome {
  queued: true;
  /** The actor's 1-based position in the queue after the join. */
  position: number;
  /** The assignee, or null when the ticket is unassigned (it has waiters). */
  holder: string | null;
  /** The full ticket id. */
  ticket: string;
}

/** Result of `claimTicket`. */
export type ClaimOutcome = ClaimedOutcome | QueuedOutcome;

/**
 * `claim` (board-cli: "Claim, release and handoff", "Leases on the command
 * line", "Waiting on the command line"; add-claim-leases design.md:
 * "Command-time validation matches the fold", "Takeover rule").
 *
 * Checks before the board is read, each `BoardError(1, ...)`, writing
 * nothing: an empty actor (`missing-actor`); `ttl` given and not a safe
 * integer in `TTL_MIN_MS`..`TTL_MAX_MS` (`usage`); `wait` without `ttl`
 * (`usage`, naming `--ttl`).
 *
 * Then, in the command transaction (`runCommand`: catch-up, which writes
 * the grants due at its clock `t`, then the decision, where the event's
 * hybrid timestamp `ts` is built before the decision so it can be
 * validated), with `ticket` the resolved ticket after catch-up and `lease`
 * its lease, in this order:
 *
 * 1. `ticket.assignee === actor` (a retried claim, with or without `ttl`
 *    or `wait`): nothing is written; the result is `{ hash: null, events:
 *    [], ticket }` (plus `queued: false` with `wait`), the lease unchanged.
 * 2. `wait` and the actor is already queued: nothing is written; the
 *    result is the `QueuedOutcome` with its current position.
 * 3. `ticket.assignee === null` and the queue is empty: writes
 *    `ticket.claim` with body `{}` without `ttl`, else `{ lease: { ttl,
 *    grace, expiresAt } }` with `grace = leaseGrace(meta)` (the board's
 *    `lease.grace` as folded, default 120000) and `expiresAt = ts.wall +
 *    min(ttl, grace)`. Result: the `WriteOutcome` (plus `queued: false`
 *    with `wait`).
 * 4. `wait` (the ticket is held, by anyone else and under any lease or
 *    none, or it has waiters): writes `ticket.queue.join` with body `{ ttl
 *    }`, and returns the `QueuedOutcome` (position = queue length after
 *    the join, holder = `ticket.assignee`). A ticket whose lease is
 *    already claimable is joined, not taken over: its grant follows from
 *    the queue.
 * 5. The queue is not empty: `ClaimRefusedError('queued', ...)` whose
 *    message is `ticket <id> has <n> actor(s) waiting for it, who have
 *    priority`, nothing written.
 * 6. Held by another actor under a lease with `ts.wall >= lease.expiresAt
 *    + LEASE_SKEW_MS` and `t >= lease.expiresAt + LEASE_SKEW_MS` (the local
 *    clock too, so the writer is never looser than the fold, even when a
 *    folded event from a fast clock has pushed the hybrid timestamp
 *    ahead): a takeover. Without `ttl` it is refused with `BoardError(1,
 *    'usage')` naming `--ttl` (a takeover always carries its own lease, so
 *    the new hold can lapse too), nothing written. With `ttl` it writes
 *    `ticket.claim` with body `{ lease: { ttl, grace, expiresAt },
 *    supersedes: { holder: ticket.assignee, expiresAt: lease.expiresAt,
 *    event: lease.event } }`; callers never supply `supersedes`.
 * 7. Otherwise (held by another actor without a lease, or under a lease
 *    not yet claimable by both readings): `ClaimRefusedError(
 *    'already-assigned', ...)`, nothing written, whose message is
 *    `ticket <id> is already assigned to <holder>` without a lease and
 *    `ticket <id> is already assigned to <holder> (lease expires <iso
 *    expiresAt>, claimable from <iso expiresAt + LEASE_SKEW_MS>)` with one
 *    (`isoTime`; the holder through `asciiText`), and whose `lease` is
 *    `{ expiresAt, claimableAt }` or null.
 *
 * Every event is validated with the fold's own rules against `ts` before
 * its file is written, so a refusal writes no event file and no temporary
 * file; a refusal still commits what the catch-up did (board-cache: "One
 * command, one transaction").
 */
export function claimTicket(
  board: Board,
  actor: string,
  input: ClaimInput & { wait?: false | undefined },
  options?: WriteOptions,
): ClaimedOutcome;
export function claimTicket(
  board: Board,
  actor: string,
  input: ClaimInput,
  options?: WriteOptions,
): ClaimOutcome;
export function claimTicket(
  board: Board,
  actor: string,
  input: ClaimInput,
  options?: WriteOptions,
): ClaimOutcome {
  requireActor(actor);
  const { ttl } = input;
  const wait = input.wait === true;
  if (ttl !== undefined) {
    checkTtl(ttl);
  }
  if (wait && ttl === undefined) {
    throw new BoardError(1, 'usage', 'claim --wait needs --ttl <duration>, the lease to ask for');
  }
  // The result of a claim that holds the ticket: `queued: false` only with wait.
  const held = (outcome: WriteOutcome): ClaimedOutcome =>
    wait ? { ...outcome, queued: false } : outcome;
  let joined = false;
  try {
    const outcome = writeTicketEvent(
      board,
      actor,
      input.id,
      (ticket, ctx) => {
        const { lease } = ticket;
        const id = ticket.id;
        if (ticket.assignee === actor) {
          throw new ClaimNoWrite(held({ hash: null, events: [], ticket }));
        }
        if (wait && ticket.queue.some((waiter) => waiter.actor === actor)) {
          throw new ClaimNoWrite(queuedOutcome(ticket, actor));
        }
        const leaseBody = (): { lease: { ttl: number; grace: number; expiresAt: number } } => {
          const grace = leaseGrace(ctx.meta());
          return {
            lease: { ttl: ttl ?? 0, grace, expiresAt: ctx.ts.wall + Math.min(ttl ?? 0, grace) },
          };
        };
        if (ticket.assignee === null && ticket.queue.length === 0) {
          const body: TicketClaimBody = ttl === undefined ? {} : leaseBody();
          return { kind: 'ticket.claim', ticket: id, body };
        }
        if (wait) {
          joined = true;
          return { kind: 'ticket.queue.join', ticket: id, body: { ttl: ttl ?? 0 } };
        }
        const holder = ticket.assignee;
        if (ticket.queue.length > 0) {
          throw new ClaimRefusedError(
            'queued',
            `ticket ${id} has ${String(ticket.queue.length)} actor(s) waiting for it, who have priority`,
            holder,
            null,
          );
        }
        if (holder === null) {
          // Unreachable: a free ticket with an empty queue is claimed above.
          throw new Error(`ticket ${id} is free with no waiters and was not claimed`);
        }
        const assigned = `ticket ${id} is already assigned to ${asciiText(holder)}`;
        if (lease === null) {
          throw new ClaimRefusedError('already-assigned', assigned, holder, null);
        }
        // The fold's takeover rule against the event's own timestamp, and
        // the local clock too, so the writer is never looser than the fold.
        const claimableAt = lease.expiresAt + LEASE_SKEW_MS;
        if (ctx.ts.wall < claimableAt || ctx.now < claimableAt) {
          throw new ClaimRefusedError(
            'already-assigned',
            `${assigned} (lease expires ${isoTime(lease.expiresAt)}, claimable from ${isoTime(claimableAt)})`,
            holder,
            { expiresAt: lease.expiresAt, claimableAt },
          );
        }
        if (ttl === undefined) {
          throw new BoardError(
            1,
            'usage',
            `taking over the lapsed lease of ticket ${id} needs --ttl <duration>: a takeover carries its own lease, so the new hold lapses too`,
          );
        }
        return {
          kind: 'ticket.claim',
          ticket: id,
          body: {
            ...leaseBody(),
            supersedes: { holder, expiresAt: lease.expiresAt, event: lease.event },
          },
        };
      },
      options,
    );
    return joined ? queuedOutcome(outcome.ticket, actor) : held(outcome);
  } catch (error) {
    if (error instanceof ClaimNoWrite) {
      return error.outcome;
    }
    throw error;
  }
}

/** Input of `renewTicket`. */
export interface RenewInput {
  id: string;
  /**
   * `--ttl` in milliseconds (a safe integer in `TTL_MIN_MS`..`TTL_MAX_MS`,
   * else `BoardError(1, 'usage')`); omitted means the ttl of the current
   * lease.
   */
  ttl?: number | undefined;
}

/**
 * `renew` (board-cli: "Leases on the command line"): writes `ticket.renew`
 * with body `{ ttl, expiresAt: ts.wall + ttl }`, where `ttl` is
 * `input.ttl` or, when omitted, `ticket.lease.ttl` (the ttl the holder
 * asked for, or the grant's ttl for a grantee accepting a grant). The
 * renew sets the lease (it does not extend it) and confirms it, also after
 * the lease expired when nothing took the ticket over before it.
 *
 * Refusals, writing nothing, in this order:
 * - `actor` is not the assignee (the ticket is held by another actor, or
 *   unassigned): `BoardError(4, 'not-assignee')`, the fold's own rejection,
 *   with or without `input.ttl` and with or without a lease, so a former
 *   holder learns it lost the lock;
 * - the actor is the assignee, `input.ttl` is omitted and the ticket has
 *   no lease: `BoardError(1, 'usage')` saying `--ttl` is needed;
 * - `input.ttl` out of range: `BoardError(1, 'usage')`, before the board
 *   is read.
 *
 * @throws BoardError exit 1 `missing-actor` when `actor` is empty.
 */
export function renewTicket(
  board: Board,
  actor: string,
  input: RenewInput,
  options?: WriteOptions,
): WriteOutcome {
  requireActor(actor);
  if (input.ttl !== undefined) {
    checkTtl(input.ttl);
  }
  return writeTicketEvent(
    board,
    actor,
    input.id,
    (ticket, ctx) => {
      if (ticket.assignee !== actor) {
        // The fold's own refusal, raised before the usage check so a former
        // holder learns it lost the lock whether or not it gave --ttl.
        throw new BoardError(
          4,
          'not-assignee',
          `ticket.renew on ticket ${ticket.id} refused: not-assignee`,
        );
      }
      const ttl = input.ttl ?? ticket.lease?.ttl;
      if (ttl === undefined) {
        throw new BoardError(
          1,
          'usage',
          `ticket ${ticket.id} has no lease to renew: give the lease with --ttl <duration>`,
        );
      }
      return {
        kind: 'ticket.renew',
        ticket: ticket.id,
        body: { ttl, expiresAt: ctx.ts.wall + ttl },
      };
    },
    options,
  );
}

/**
 * `unqueue` (board-cli: "Waiting on the command line"): writes
 * `ticket.queue.leave` (empty body), removing `actor` from the ticket's
 * queue. When `actor` is not queued it is the fold's rejection,
 * `BoardError(4, 'invalid-queue')`, and nothing is written.
 *
 * @throws BoardError exit 1 `missing-actor` when `actor` is empty.
 */
export function unqueueTicket(
  board: Board,
  actor: string,
  input: { id: string },
  options?: WriteOptions,
): WriteOutcome {
  return writeTicketEvent(
    board,
    actor,
    input.id,
    (ticket) => ({ kind: 'ticket.queue.leave', ticket: ticket.id, body: {} }),
    options,
  );
}

/** Input of `releaseTicket`. */
export interface ReleaseInput {
  id: string;
  /** `--force`: break another actor's hold (needs `reason`). */
  force?: boolean | undefined;
  /** `--reason`: why the hold is broken; only with `force`. */
  reason?: string | undefined;
  /** Skips the secret-pattern refusal of the reason. */
  allowSecretLike?: boolean | undefined;
}

/**
 * `release` (board-cli: "Claim, release and handoff", "Forced release on
 * the command line").
 *
 * Without `force` (and without `reason`): writes `ticket.release`,
 * clearing the assignment and the lease. Refused by the fold with exit 4
 * `not-assignee` unless `actor` is the assignee (an unassigned ticket
 * included).
 *
 * With `force`: writes `ticket.release.force` with body `{ holder:
 * ticket.assignee, reason }`, clearing the assignee and the lease and
 * leaving the status unchanged (with waiters, the grant to the head waiter
 * is then due at once). Any actor may force a release; there is no
 * allowlist.
 *
 * Refusals, writing nothing:
 * - `reason` given without `force`, or `force` with `reason` undefined or
 *   empty: `BoardError(1, 'usage')`, before the board is read;
 * - a reason matching a secret pattern: `refuseSecretLike` (exit 1
 *   `secret-like`, naming the pattern) unless `allowSecretLike`, before
 *   the board is read;
 * - `force` by the assignee itself: `BoardError(1, 'usage')` whose message
 *   says to run `release` without `--force` (the words `without --force`
 *   appear);
 * - `force` on an unassigned ticket: `BoardError(4, 'not-assignee')`.
 *
 * @throws BoardError exit 1 `missing-actor` when `actor` is empty.
 */
export function releaseTicket(
  board: Board,
  actor: string,
  input: ReleaseInput,
  options?: WriteOptions,
): WriteOutcome {
  requireActor(actor);
  const force = input.force === true;
  const { reason } = input;
  if (!force) {
    if (reason !== undefined) {
      throw new BoardError(1, 'usage', 'release takes --reason only with --force');
    }
    return writeTicketEvent(
      board,
      actor,
      input.id,
      (ticket) => ({ kind: 'ticket.release', ticket: ticket.id, body: {} }),
      options,
    );
  }
  if (reason === undefined || reason === '') {
    throw new BoardError(
      1,
      'usage',
      'release --force needs a non-empty --reason <text> saying why the hold is broken',
    );
  }
  refuseSecretLike([reason], input.allowSecretLike === true);
  return writeTicketEvent(
    board,
    actor,
    input.id,
    (ticket) => {
      const holder = ticket.assignee;
      if (holder === actor) {
        throw new BoardError(
          1,
          'usage',
          `you hold ticket ${ticket.id} yourself: give it up with release without --force`,
        );
      }
      if (holder === null) {
        throw new BoardError(
          4,
          'not-assignee',
          `ticket ${ticket.id} is not assigned, so there is no hold to break`,
        );
      }
      return { kind: 'ticket.release.force', ticket: ticket.id, body: { holder, reason } };
    },
    options,
  );
}

/**
 * The scope disposition a `move <id> merged` or a `close` gives on the
 * same command (board-cli: "Scope disposition on the command line";
 * board-openspec-integration: "Scope disposition at merge and close"; ADR
 * 0013): the planned task the work delivered (`--task`, or `--change` with
 * `--group`, parsed by `taskRefFromArgs`) or the reason it was never
 * planned (`--unplanned <reason>`, non-empty).
 */
export type ScopeDisposition = { task: TaskRef } | { unplanned: string };

/**
 * The disposition flags of `move` and `close` as given on the command
 * line: the task arguments of `link` (`TaskArgs`), `--unplanned` and
 * `--allow-secret-like`.
 */
export interface DispositionArgs extends TaskArgs {
  unplanned?: string | undefined;
  /** Skips the secret-pattern refusal of the unplanned reason. */
  allowSecretLike?: boolean | undefined;
}

/**
 * Turns the disposition flags of `move` or `close` into a
 * `ScopeDisposition`, or undefined when none of `task`, `change`, `group`
 * and `unplanned` is given. Needs no board: the registry `run` of `move`
 * and `close` calls it before `ctx.board()`, so every refusal below is
 * exit 1 before the board is opened (design.md section 5), and writes
 * nothing.
 *
 * - `task`, `change` and `group`: exactly `taskRefFromArgs`, with its
 *   reasons and messages (`malformed-task-ref` showing
 *   `<source>:<ref>#<item>` exactly as `link` does; `usage` for `--change`
 *   without `--group` and the reverse).
 * - `unplanned` together with any of the task arguments: `BoardError(1,
 *   'usage')` whose message names both `--task` (or `--change`) and
 *   `--unplanned`. (The parser's exclusive group refuses this first on the
 *   CLI and over MCP; the check here covers library callers.)
 * - `unplanned` empty: `BoardError(1, 'usage')` saying the unplanned
 *   reason must not be empty.
 * - `unplanned` matching a secret pattern: `refuseSecretLike([unplanned],
 *   allowSecretLike === true)` (exit 1 `secret-like`, naming the pattern
 *   and never the text) unless `allowSecretLike`.
 *
 * Pure apart from the thrown refusals.
 */
export function scopeDispositionFromArgs(args: DispositionArgs): ScopeDisposition | undefined {
  const { unplanned } = args;
  const taskGiven =
    args.task !== undefined || args.change !== undefined || args.group !== undefined;
  if (unplanned !== undefined && taskGiven) {
    throw new BoardError(
      1,
      'usage',
      'give at most one scope disposition: --task (or --change with --group), or --unplanned',
    );
  }
  const task = taskRefFromArgs(args);
  if (task !== undefined) {
    return { task };
  }
  if (unplanned === undefined) {
    return undefined;
  }
  checkUnplannedReason(unplanned, args.allowSecretLike);
  return { unplanned };
}

/**
 * The checks on an unplanned reason that need no board: empty is
 * `BoardError(1, 'usage')`, and a reason matching a secret pattern is
 * refused by `refuseSecretLike` (exit 1 `secret-like`) unless
 * `allowSecretLike`.
 */
function checkUnplannedReason(reason: string, allowSecretLike: boolean | undefined): void {
  if (reason === '') {
    throw new BoardError(1, 'usage', 'the unplanned reason must not be empty');
  }
  refuseSecretLike([reason], allowSecretLike === true);
}

/**
 * The checks on a disposition that need no board (see `moveTicket` and
 * `closeTicket`): a task reference needs none; an unplanned reason goes
 * through `checkUnplannedReason`.
 */
function checkDisposition(
  disposition: ScopeDisposition,
  allowSecretLike: boolean | undefined,
): void {
  if ('unplanned' in disposition) {
    checkUnplannedReason(disposition.unplanned, allowSecretLike);
  }
}

/**
 * The event a disposition writes before its move or close: the
 * `ticket.link` exactly as `linkTicket` writes it, or the
 * `ticket.unplanned` with the reason.
 */
function dispositionEvent(ticket: Ticket, disposition: ScopeDisposition): ProposedEvent {
  return 'task' in disposition
    ? { kind: 'ticket.link', ticket: ticket.id, body: { task: { ...disposition.task } } }
    : { kind: 'ticket.unplanned', ticket: ticket.id, body: { reason: disposition.unplanned } };
}

/** Whether `ticket` has a scope disposition: a task reference or an unplanned disposition. */
function disposed(ticket: Ticket): boolean {
  return ticket.task !== null || ticket.unplanned !== null;
}

/** Input of `moveTicket`. */
export interface MoveInput {
  id: string;
  /** Target status; omitted only to return a blocked ticket to its origin. */
  to?: Status | undefined;
  /**
   * The scope disposition written before the move, in the same
   * transaction (see `moveTicket`). Accepted only with `to` equal to
   * `merged`.
   */
  disposition?: ScopeDisposition | undefined;
  /** Skips the secret-pattern refusal of an unplanned reason. */
  allowSecretLike?: boolean | undefined;
}

/**
 * `move`: writes `ticket.move` with an explicit target, preceded, when a
 * scope disposition is given, by its `ticket.link` or `ticket.unplanned`
 * in the same transaction (board-cli: "Scope disposition on the command
 * line"; board-cache: "One command, one transaction").
 *
 * - `to` given: that target. The state machine decides (exit 4
 *   `invalid-transition`, including a move to the current status and every
 *   move out of `merged`; exit 4 `needs-scope-disposition` for a ticket
 *   with neither a task reference nor an unplanned disposition entering
 *   `merged`; an ad hoc ticket enters `implementing` like any other).
 * - `to` omitted on a `blocked` ticket: the remembered origin
 *   (`blockedFrom`); the event still names it.
 * - `to` omitted on any other ticket: `BoardError(1, 'missing-status')`
 *   saying a target status is required unless the ticket is blocked.
 *
 * With `disposition` (design.md sections 4 to 6):
 * - `to` is not `merged` (any other status, or omitted, including the
 *   target-less return from `blocked`): `BoardError(1, 'usage')` saying a
 *   disposition applies only to a move to `merged`; nothing is written and
 *   the ticket is not read. The registry `run` makes this check before
 *   `ctx.board()`, so on the CLI it is refused before the board is opened.
 * - `{ unplanned }`: empty is `BoardError(1, 'usage')`; secret-looking is
 *   refused with `refuseSecretLike` (exit 1 `secret-like`) unless
 *   `allowSecretLike`; both before the ticket is read. Otherwise the
 *   operation proposes `[ticket.unplanned {reason}, ticket.move {to:
 *   'merged'}]`.
 * - `{ task }`: the operation proposes `[ticket.link {task}, ticket.move
 *   {to: 'merged'}]`, the link exactly as `linkTicket` writes it (so a
 *   ticket already linked gets its reference replaced, and its ad hoc
 *   reason and unplanned disposition cleared).
 * - The two events are folded in memory in that order by `runCommand`, so
 *   the fold's own order applies: `already-linked` (an unplanned reason on
 *   a ticket with a task reference) comes before `invalid-transition`, and
 *   `invalid-transition` before `needs-scope-disposition`. Any refusal
 *   writes neither event, not even a temporary file.
 * - On success `WriteOutcome.events` lists the disposition's hash then the
 *   move's, `hash` is the move's, and `ticket` is the ticket after both.
 *
 * Without `disposition` nothing changes: a ticket linked earlier with
 * `link`, or given an unplanned disposition earlier, enters `merged` with
 * no flag, and a planned ticket is unaffected.
 */
export function moveTicket(
  board: Board,
  actor: string,
  input: MoveInput,
  options?: WriteOptions,
): WriteOutcome {
  requireActor(actor);
  const { disposition } = input;
  if (disposition !== undefined) {
    if (input.to !== 'merged') {
      throw new BoardError(
        1,
        'usage',
        'a scope disposition (--task, --change with --group, or --unplanned) applies only to a move to merged',
      );
    }
    checkDisposition(disposition, input.allowSecretLike);
  }
  return writeTicketEvents(
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
      const move: ProposedEvent = { kind: 'ticket.move', ticket: ticket.id, body: { to } };
      return disposition === undefined ? [move] : [dispositionEvent(ticket, disposition), move];
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
   * project root, the parent of `board.dir`, the ticket after the event,
   * and the number of active, not removed, lines before the ticked one, so
   * a line removed by a reconcile never shifts the mapping); null for an
   * untick.
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
  // The tasks file holds only the active lines, so the reminder counts the
  // active lines before the ticked one (removed lines keep their index).
  const active = outcome.ticket.checklist
    .slice(0, input.index)
    .filter((line) => line.removed !== true).length;
  const reminder = input.done ? taskReminder(dirname(board.dir), outcome.ticket, active) : null;
  return { ...outcome, reminder };
}

/**
 * The scope disposition part of `CloseInput`: optional on every close,
 * needed by an undisposed ticket (see `closeTicket`).
 */
export interface CloseScope {
  /** Written before the `ticket.close`, in the same transaction. */
  disposition?: ScopeDisposition | undefined;
  /** Skips the secret-pattern refusal of an unplanned reason. */
  allowSecretLike?: boolean | undefined;
}

/**
 * How a ticket is closed: the decision disposition (`--decision-recorded-in
 * <path>` or `--no-decision`) and, optionally, the scope disposition.
 */
export type CloseInput = (
  ({ id: string; decisionRecordedIn: string } & TreePathOptions) | { id: string; noDecision: true }
) &
  CloseScope;

/**
 * `close`: writes `ticket.close` with the decision disposition, preceded,
 * when a scope disposition is given, by its `ticket.link` or
 * `ticket.unplanned` in the same transaction (board-cli: "Scope
 * disposition on the command line"; board-openspec-integration: "Scope
 * disposition at merge and close").
 *
 * - `decisionRecordedIn`: resolved with `treePath` (`cwd`, `env`); outside
 *   the working tree is `BoardError(1, 'path-outside-tree')`; the
 *   resolved file must exist, otherwise `BoardError(1,
 *   'decision-path-missing')`, exactly `the decision record given with
 *   --decision-recorded-in does not exist`, which does not repeat the
 *   path. The event records
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
 * - The scope disposition is the CLI's check, not the fold's (design.md
 *   section 5): a ticket with neither a task reference nor an unplanned
 *   disposition, closed without `disposition`, is `BoardError(4,
 *   'needs-scope-disposition')` naming the ticket, in any closable status
 *   (`blocked`, and `merged` for a ticket that got there outside
 *   agentboard); nothing is written. A ticket linked earlier, or given an
 *   unplanned disposition earlier, needs nothing more; a planned ticket is
 *   unaffected.
 * - `disposition: { task }`: the operation proposes `[ticket.link {task},
 *   ticket.close]`, the link as `linkTicket` writes it. `disposition: {
 *   unplanned }`: empty is `BoardError(1, 'usage')` and secret-looking is
 *   refused with `refuseSecretLike` unless `allowSecretLike`, both before
 *   the ticket is read; otherwise `[ticket.unplanned {reason},
 *   ticket.close]`. A `ticket.unplanned` on a ticket with a task reference
 *   is `BoardError(4, 'already-linked')` with the message `runCommand`
 *   gives the fold's rejection (naming the reference), thrown before the
 *   decision guard; nothing is written. On success `WriteOutcome.events`
 *   lists the disposition's hash then the close's, and `hash` is the
 *   close's.
 *
 * Check order (design.md sections 5 and 6): usage errors (neither or both
 * decision dispositions and both scope dispositions, at the parser; a
 * malformed task reference, an empty or secret-like unplanned reason,
 * before the board is opened) first; then the path checks
 * (`path-outside-tree`, then `decision-path-missing`); then closability
 * (exit 4 `invalid-transition` for a ticket not in `merged` or `blocked`,
 * or already closed: only the `ticket.close` is proposed, so this holds
 * whatever disposition was given); then the scope disposition (exit 4
 * `needs-scope-disposition`, or `already-linked` for an unplanned reason on
 * a linked ticket); only then, for a closable and disposed ticket, the
 * decision guard (exit 1 `unpromoted-decision`). So `--no-decision` on a
 * `todo` ticket with an open `DECISION:` comment is exit 4
 * `invalid-transition`, and on an undisposed `blocked` ticket with an open
 * `DECISION:` comment it is exit 4 `needs-scope-disposition`, becoming
 * exit 1 `unpromoted-decision` once `--unplanned` is given; on a linked
 * `blocked` ticket with an open `DECISION:` comment, `--unplanned` is exit
 * 4 `already-linked`.
 */
export function closeTicket(
  board: Board,
  actor: string,
  input: CloseInput,
  options?: WriteOptions,
): WriteOutcome {
  requireActor(actor);
  const { disposition } = input;
  if (disposition !== undefined) {
    checkDisposition(disposition, input.allowSecretLike);
  }
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
  return writeTicketEvents(
    board,
    actor,
    input.id,
    (ticket) => {
      // A ticket that cannot be closed is left to the fold's own
      // invalid-transition refusal, which comes before the scope
      // disposition and the decision guard.
      const closable =
        !ticket.closed && (ticket.status === 'merged' || ticket.status === 'blocked');
      const close: ProposedEvent = { kind: 'ticket.close', ticket: ticket.id, body };
      if (!closable) {
        // Only the close is proposed, so the refusal is invalid-transition
        // whatever disposition was given (design.md section 6).
        return [close];
      }
      if (disposition === undefined && !disposed(ticket)) {
        throw new BoardError(
          4,
          'needs-scope-disposition',
          `ticket ${ticket.id} cannot be closed: needs-scope-disposition (it has neither a ` +
            'task reference nor an unplanned disposition; give --task or --unplanned)',
        );
      }
      if (disposition !== undefined && 'unplanned' in disposition && ticket.task !== null) {
        // The fold's own refusal of the ticket.unplanned, raised here so it
        // comes before the decision guard, with the message runCommand
        // gives that rejection.
        throw new BoardError(
          4,
          'already-linked',
          alreadyLinkedMessage('ticket.unplanned', ticket.id, ticket.task),
        );
      }
      const open = 'noDecision' in body ? openDecisions(ticket.comments) : [];
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
      return disposition === undefined ? [close] : [dispositionEvent(ticket, disposition), close];
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
