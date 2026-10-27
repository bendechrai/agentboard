/**
 * The foreground wait of `claim --wait --timeout` (board-cli: "Waiting on
 * the command line"; add-claim-leases design.md: "Waiting on the CLI,
 * never over MCP"): join the queue of a held ticket and block, on the
 * watch machinery, until the ticket is granted to the actor, the timeout
 * passes or the wait is interrupted.
 *
 * Only the command line waits. `board_claim` over MCP and the synchronous
 * `runCli` call `claimTicket` with `wait`, which joins and returns at once.
 */

import type { Ticket } from '../events/fold.js';
import type { Board } from '../store/board.js';
import type { ClaimedOutcome, QueuedOutcome } from './actions.js';
import type { TickerTimers, WatchDir } from './ticker.js';

/** Input of `waitForGrant`. */
export interface WaitInput {
  /** The ticket id or a unique prefix of at least 6 characters. */
  id: string;
  /**
   * The lease to ask for, in milliseconds (`--ttl`, parsed with
   * `parseTtl`): a safe integer in `TTL_MIN_MS`..`TTL_MAX_MS`, else
   * `BoardError(1, 'usage')`. It is the ttl of the join (and so of the
   * grant), and of the claim when the wait claims at once or instead.
   */
  ttl: number;
  /**
   * How long to wait, in milliseconds (`--timeout`, parsed with
   * `parseTimeout`): a safe integer in `TIMEOUT_MIN_MS`..`TIMEOUT_MAX_MS`
   * (1 second to 1 day), else `BoardError(1, 'usage')`.
   */
  timeout: number;
}

/** Options of `waitForGrant`. */
export interface WaitOptions {
  /**
   * Interrupts the wait (SIGINT or SIGTERM on the command line). See
   * `waitForGrant`, step 3.
   */
  readonly signal: AbortSignal;
  /**
   * Called exactly once, synchronously, when the actor is in the queue at
   * the start of the wait (it has just joined, or was already queued),
   * with the `QueuedOutcome` of that moment, before any wake; never called
   * when the wait claims at once or the actor already holds the ticket.
   * The CLI prints the position from it.
   */
  onQueued?(outcome: QueuedOutcome): void;
  /**
   * Receives one plain ASCII line for each wake whose catch-up failed with
   * `BoardError(5, 'busy')`; the wait carries on at its next wake, as
   * `watch` does (`WatchOptions.onWarning`).
   */
  onWarning?(line: string): void;
  /**
   * The clock, in milliseconds since the epoch; defaults to `Date.now`.
   * Every catch-up and command the wait runs is given a reading of it
   * (`CatchUpOptions.now`, `WriteOptions.now`), and the deadline and the
   * due-grant timer are computed from it, so a test can drive the whole
   * wait from one fake clock.
   */
  readonly now?: () => number;
  /**
   * Timer functions for every timer of the wait: the watch machinery's
   * poll and settle timers (passed to `runTicker`) and the wait's own
   * timeouts for the next due grant and the deadline. Defaults to the
   * global timers.
   */
  readonly timers?: TickerTimers;
  /** Directory watcher factory, passed to `runTicker`; defaults to `fs.watch`. */
  readonly watchDir?: WatchDir;
  /** Polling interval of the watch machinery; defaults to `TICK_POLL_MS`. */
  readonly pollMs?: number;
  /** When false, no directory watcher is started (`runTicker`'s `fsWatch`). */
  readonly fsWatch?: boolean;
}

/**
 * The result of a wait that ended with a grant to the actor: also the
 * `--json` final document of a granted `claim --wait`, with exactly these
 * four keys in this order.
 */
export interface GrantedOutcome {
  queued: false;
  /** The hash of the applied `ticket.grant` to the actor (the lease's `event`). */
  grant: string;
  /**
   * The grant's lease expiry (`ticket.lease.expiresAt`, the grant's wall
   * plus its window), in milliseconds: the actor must renew before it.
   */
  acceptBy: number;
  /** The ticket after the wait, as `readTicket` returns it. */
  ticket: Ticket;
}

/**
 * The result of `waitForGrant`: a `ClaimedOutcome` (with `queued: false`)
 * when the actor claimed the ticket (at once, or instead after its join
 * was rejected) or already held it, a `GrantedOutcome` when the ticket was
 * granted to it.
 */
export type WaitOutcome = ClaimedOutcome | GrantedOutcome;

/**
 * `claim <id> --ttl <d> --wait --timeout <d>` on the command line
 * (board-cli: "Waiting on the command line").
 *
 * Checks before the board is read, each `BoardError(1, ...)` and writing
 * nothing: an empty actor (`missing-actor`); `ttl` out of range (`usage`);
 * `timeout` out of range (`usage`).
 *
 * Then:
 *
 * 1. Reads the clock once; the deadline is that reading plus `timeout`.
 *    Runs `claimTicket(board, actor, { id, ttl, wait: true }, { now })`.
 *    When that holds the ticket (claimed at once, or a retried claim by
 *    the assignee), resolves with its `ClaimedOutcome` at once, leaving no
 *    timer, watcher or abort listener behind and never calling
 *    `onQueued`. Its refusals (`unknown-ticket`, ...) reject as they are.
 * 2. Otherwise the actor is queued (it joined, or was already queued):
 *    calls `onQueued` with the `QueuedOutcome`, then blocks on the watch
 *    machinery (`runTicker` with `timers`, `watchDir`, `pollMs` and
 *    `fsWatch`). It wakes only on: a directory notification (after the
 *    ticker's settle delay), the ticker's poll, a timeout set for exactly
 *    the cache's grant watermark (`readWatermark`, the slot time of the
 *    next grant due on the board) when there is one, never later than the
 *    deadline (so a watermark days away never overflows a timer: it is
 *    clamped to the deadline), a timeout for exactly the deadline, and the
 *    abort of `signal`. Each wake runs one catch-up at a fresh clock
 *    reading (`catchUp(board, { now })`, which writes every grant due at
 *    that reading), re-arms the watermark timeout from the watermark after
 *    that catch-up, and reads the ticket. The wait creates no other timer
 *    and never re-runs a catch-up without a wake, so the number of
 *    catch-ups is bounded by the number of wakes (no busy loop).
 * 3. After each wake's catch-up, the first of these that applies ends the
 *    wait:
 *    a. the ticket's assignee is the actor and its lease's `event` is an
 *       applied `ticket.grant` to the actor: resolves with the
 *       `GrantedOutcome` (`grant` = `lease.event`, `acceptBy` =
 *       `lease.expiresAt`);
 *    b. the assignee is the actor otherwise (a hand-off or assign to a
 *       waiter): resolves with `{ hash: null, events: [], ticket, queued:
 *       false }`, writing nothing;
 *    c. the clock has reached the deadline (`now >= deadline`), or
 *       `signal` has aborted: when the actor is still queued, writes
 *       `ticket.queue.leave` (`unqueueTicket` with `{ now }`); then
 *       rejects with `BoardError(4, 'wait-timeout')` at the deadline, or
 *       `BoardError(4, 'wait-interrupted')` on abort, each naming the
 *       ticket id in its message. Because (a) is checked first, a grant
 *       due exactly at the deadline is written by that wake's catch-up and
 *       wins;
 *    d. the actor is neither queued nor the assignee, and the ticket is
 *       unassigned with an empty queue (its join was rejected, for example
 *       because a release with an earlier wall arrived late): claims
 *       instead, `claimTicket(board, actor, { id, ttl, wait: true }, {
 *       now })`, and resolves with that `ClaimedOutcome`;
 *    e. the actor is neither queued nor the assignee otherwise: rejects
 *       with `BoardError(4, 'invalid-queue')`, writing nothing.
 *    Otherwise the wait goes on.
 * 4. Whenever it ends (resolved or rejected), the ticker is stopped (its
 *    watcher closed, its interval cleared), the wait's own timeouts are
 *    cleared and its abort listener removed: nothing is left that keeps
 *    the event loop alive. A `signal` already aborted when the wait
 *    reaches step 2 ends it at once by step 3c (the join written in step
 *    1 is left again). Does not close `board`.
 *
 * Every refusal is a `BoardError` with a literal reason (`wait-timeout`,
 * `wait-interrupted`, `invalid-queue`), so the hint table's source scan
 * (`src/guidance/__tests__/hints.test.ts`) finds it.
 *
 * Errors of a wake other than `BoardError(5, 'busy')` (reported through
 * `onWarning`, the wait carrying on) end the wait with that error, after
 * the same cleanup.
 */
export function waitForGrant(
  board: Board,
  actor: string,
  input: WaitInput,
  options: WaitOptions,
): Promise<WaitOutcome> {
  void board;
  void actor;
  void input;
  void options;
  return Promise.reject(new Error('not implemented'));
}
