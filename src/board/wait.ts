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
import { TTL_MAX_MS, TTL_MIN_MS } from '../events/schema.js';
import type { Board } from '../store/board.js';
import { catchUp, readTicket } from '../store/cache.js';
import { readWatermark } from '../store/engine.js';
import { BoardError } from '../store/errors.js';
import { readEventFile } from '../store/eventfile.js';
import { NoWrite, runCommand, type Decision, type TxContext } from '../store/transaction.js';
import { claimTicket, type ClaimedOutcome, type QueuedOutcome } from './actions.js';
import { TIMEOUT_MAX_MS, TIMEOUT_MIN_MS } from './leases.js';
import { requireActor } from './lookup.js';
import { runTicker, type TickerTimers, type TimerHandle, type WatchDir } from './ticker.js';

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
  /**
   * The monotonic clock the deadline is measured on, in milliseconds from
   * any origin; defaults to `performance.now`. The deadline is its reading
   * at the start of the wait plus `timeout`, and "the deadline has passed"
   * is decided on it alone, so a wall clock (`now`) stepped back or
   * forward never delays or advances the end of the wait. `now` is still
   * the clock of every catch-up and command (grant slot times are walls).
   */
  readonly monotonic?: () => number;
  /**
   * A test seam, called synchronously immediately before each step that
   * catches up: `'wake'` before a wake's catch-up, `'claim'` before the
   * claim a wake makes instead (step 3d), and `'end'` before each attempt
   * of the transaction that ends a wait at the deadline or on a signal
   * (step 3c). An error it throws is that step's error (so a test throws
   * `BoardError(5, 'busy')` to simulate a step that could not take the
   * write lock), and events it writes are what that step's catch-up finds.
   * Defaults to none.
   */
  readonly beforeStep?: (step: 'wake' | 'claim' | 'end') => void;
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
 * 1. Reads the monotonic clock once; the deadline is that reading plus
 *    `timeout` (see `WaitOptions.monotonic`).
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
 *    c. the monotonic clock has reached the deadline, or `signal` has
 *       aborted: the wait ends with one more transaction (`runCommand`,
 *       clock `now`) that decides after its own catch-up, because that
 *       catch-up can write a grant to the actor or fold a hand-off to it
 *       that the wake did not see:
 *       - the actor is now the assignee, at the deadline: no event; the
 *         wait resolves as (a) or (b) would (exit 0: the actor holds the
 *         ticket and must renew);
 *       - the actor is now the assignee, on a signal: writes
 *         `ticket.release` (a plain release by the assignee, so the next
 *         waiter is granted) and rejects with `BoardError(4,
 *         'wait-interrupted')` whose message is exactly
 *         `the wait for ticket <id> was interrupted after the ticket was given to you; you released it, so it passes to the next waiter`;
 *       - the actor is still queued: writes `ticket.queue.leave` and
 *         rejects with `BoardError(4, 'wait-timeout')` at the deadline or
 *         `BoardError(4, 'wait-interrupted')` on a signal, each naming the
 *         ticket id;
 *       - otherwise (it left the queue elsewhere meanwhile): no event, and
 *         the same rejection.
 *       A transaction that fails `BoardError(5, 'busy')` is attempted once
 *       more (the board's busy policy: the busy timeout and one retry);
 *       if that fails too the wait rejects with `BoardError(5, 'busy')`
 *       whose message names `agentboard unqueue <id> --as <actor>`, the
 *       actor still queued. Because (a) is checked first, a grant due
 *       exactly at the deadline is written by that wake's catch-up and
 *       wins;
 *    d. the actor is neither queued nor the assignee, and the ticket is
 *       unassigned with an empty queue (its join was rejected, for example
 *       because a release with an earlier wall arrived late): claims
 *       instead, `claimTicket(board, actor, { id, ttl, wait: true }, {
 *       now })`, and resolves with that `ClaimedOutcome`; when that claim
 *       joins instead (another actor took the ticket meanwhile), the actor
 *       is queued again and the wait goes on (`onQueued` is not called
 *       again);
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
export async function waitForGrant(
  board: Board,
  actor: string,
  input: WaitInput,
  options: WaitOptions,
): Promise<WaitOutcome> {
  requireActor(actor);
  const { ttl, timeout } = input;
  if (!Number.isSafeInteger(ttl) || ttl < TTL_MIN_MS || ttl > TTL_MAX_MS) {
    throw new BoardError(
      1,
      'usage',
      `invalid ttl ${String(ttl)}: a ttl is a whole number of milliseconds from ${String(TTL_MIN_MS)} (30s) to ${String(TTL_MAX_MS)} (7d)`,
    );
  }
  if (!Number.isSafeInteger(timeout) || timeout < TIMEOUT_MIN_MS || timeout > TIMEOUT_MAX_MS) {
    throw new BoardError(
      1,
      'usage',
      `invalid timeout ${String(timeout)}: a timeout is a whole number of milliseconds from ${String(TIMEOUT_MIN_MS)} (1s) to ${String(TIMEOUT_MAX_MS)} (1d)`,
    );
  }
  const now = options.now ?? Date.now;
  const monotonic = options.monotonic ?? ((): number => performance.now());
  const timers = options.timers ?? globalTimers;
  const { signal } = options;

  // Step 1: the deadline (monotonic), then the claim or join.
  const deadline = monotonic() + timeout;
  const first = claimTicket(board, actor, { id: input.id, ttl, wait: true }, { now });
  if (first.queued !== true) {
    return first;
  }
  const id = first.ticket;
  options.onQueued?.(first);

  // Step 2: the wait. `settled` holds the outcome once a wake has decided it;
  // `inner` stops the ticker, and the wait's own timeouts live here.
  let settled: { value: WaitOutcome } | { error: unknown } | null = null;
  const inner = new AbortController();
  let deadlineTimer: TimerHandle | null = null;
  let dueTimer: TimerHandle | null = null;

  const clearTimers = (): void => {
    if (dueTimer !== null) {
      timers.clearTimeout(dueTimer);
      dueTimer = null;
    }
    if (deadlineTimer !== null) {
      timers.clearTimeout(deadlineTimer);
      deadlineTimer = null;
    }
  };
  const finish = (outcome: { value: WaitOutcome } | { error: unknown }): void => {
    settled = outcome;
    signal.removeEventListener('abort', wake);
    clearTimers();
    inner.abort();
  };

  /**
   * Re-arms the wait's two timeouts after a wake at wall `t` and monotonic
   * `m` that goes on waiting: one for exactly the cache's grant watermark
   * when it falls before the deadline, and one for the deadline itself,
   * `deadline - m` away. The deadline timeout covers any later watermark,
   * which is what clamps a far-off one; re-arming it from the monotonic
   * clock on every wake means a timer that fired a fraction early (Node's
   * timers run on the loop's cached millisecond clock) is simply set again
   * for the remainder.
   */
  const arm = (t: number, m: number): void => {
    clearTimers();
    const watermark = readWatermark(board.db);
    if (watermark !== null && watermark > t && watermark < deadline) {
      dueTimer = timers.setTimeout(() => {
        dueTimer = null;
        wake();
      }, watermark - t);
    }
    deadlineTimer = timers.setTimeout(() => {
      deadlineTimer = null;
      wake();
    }, Math.max(1, Math.ceil(deadline - m)));
  };

  /** The outcome of an actor that holds `ticket`: granted, or handed (a retried claim). */
  const holding = (ticket: Ticket): WaitOutcome => {
    const { lease } = ticket;
    if (lease !== null && isGrant(board, lease.event)) {
      return { queued: false, grant: lease.event, acceptBy: lease.expiresAt, ticket };
    }
    return { hash: null, events: [], ticket, queued: false };
  };

  /**
   * Step 3c: the transaction that ends the wait at the deadline or on a
   * signal. It decides after its own catch-up, which can have written a
   * grant to the actor or folded a hand-off to it since the wake's read.
   * Attempted twice when `busy`.
   */
  const end = (interrupted: boolean): void => {
    let held: WaitOutcome | null = null;
    let released = false;
    const operation = (ctx: TxContext): Decision => {
      const ticket = ctx.ticket(id);
      if (ticket === null) {
        throw new BoardError(4, 'unknown-ticket', `ticket ${id} is no longer on the board`);
      }
      if (ticket.assignee === actor) {
        if (interrupted) {
          released = true;
          return { ok: true, event: { kind: 'ticket.release', ticket: id, body: {} } };
        }
        held = holding(ticket);
        throw new NoWrite('the actor holds the ticket: nothing to leave');
      }
      if (ticket.queue.some((waiter) => waiter.actor === actor)) {
        return { ok: true, event: { kind: 'ticket.queue.leave', ticket: id, body: {} } };
      }
      throw new NoWrite('the actor left the queue elsewhere: nothing to leave');
    };
    for (let attempt = 1; ; attempt += 1) {
      try {
        options.beforeStep?.('end');
        runCommand(board, actor, operation, { now });
        break;
      } catch (error) {
        if (error instanceof NoWrite) {
          break;
        }
        if (error instanceof BoardError && error.exitCode === 5 && error.reason === 'busy') {
          if (attempt === 1) {
            continue;
          }
          throw new BoardError(
            5,
            'busy',
            `the board cache stayed locked while ending the wait for ticket ${id}, so you are still in its queue: leave it with 'agentboard unqueue ${id} --as ${actor}'`,
          );
        }
        throw error;
      }
    }
    const outcome = (): WaitOutcome | null => held;
    const holds = outcome();
    if (holds !== null) {
      finish({ value: holds });
      return;
    }
    if (released) {
      throw new BoardError(
        4,
        'wait-interrupted',
        `the wait for ticket ${id} was interrupted after the ticket was given to you; you released it, so it passes to the next waiter`,
      );
    }
    if (interrupted) {
      throw new BoardError(
        4,
        'wait-interrupted',
        `the wait for ticket ${id} was interrupted; you left its queue`,
      );
    }
    throw new BoardError(
      4,
      'wait-timeout',
      `the wait for ticket ${id} timed out after ${String(timeout)} ms; you left its queue`,
    );
  };

  /** One wake (step 3). Never throws: every error ends the wait or is a warning. */
  function wake(): void {
    if (settled !== null) {
      return;
    }
    const t = now();
    const m = monotonic();
    try {
      options.beforeStep?.('wake');
      catchUp(board, { now: t });
    } catch (error) {
      if (error instanceof BoardError && error.exitCode === 5 && error.reason === 'busy') {
        options.onWarning?.(error.message);
        return;
      }
      finish({ error });
      return;
    }
    try {
      const ticket = readTicket(board.db, id);
      if (ticket === null) {
        throw new BoardError(4, 'unknown-ticket', `ticket ${id} is no longer on the board`);
      }
      if (ticket.assignee === actor) {
        finish({ value: holding(ticket) });
        return;
      }
      if (signal.aborted || m >= deadline) {
        end(signal.aborted);
        return;
      }
      if (!ticket.queue.some((waiter) => waiter.actor === actor)) {
        if (ticket.assignee === null && ticket.queue.length === 0) {
          options.beforeStep?.('claim');
          const claimed = claimTicket(board, actor, { id, ttl, wait: true }, { now });
          if (claimed.queued !== true) {
            finish({ value: claimed });
            return;
          }
          // Another actor took the ticket between the read and the claim:
          // the actor is queued again and the wait goes on.
        } else {
          throw new BoardError(
            4,
            'invalid-queue',
            `${actor} is no longer waiting for ticket ${id}: it left the queue elsewhere, or its grant lapsed and passed on`,
          );
        }
      }
      arm(t, m);
    } catch (error) {
      finish({ error });
    }
  }

  deadlineTimer = timers.setTimeout(() => {
    deadlineTimer = null;
    wake();
  }, timeout);
  signal.addEventListener('abort', wake);
  try {
    await runTicker({
      signal: inner.signal,
      examine: wake,
      dir: board.eventsDir,
      timers,
      ...(options.watchDir === undefined ? {} : { watchDir: options.watchDir }),
      ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
      ...(options.fsWatch === undefined ? {} : { fsWatch: options.fsWatch }),
    });
  } catch (error) {
    // Unreachable in practice: `wake` never throws. Cleanup all the same.
    finish({ error });
  }
  // Read through a call: `settled` is assigned inside `finish`, which the
  // compiler's narrowing of the variable itself does not see.
  const result = (): { value: WaitOutcome } | { error: unknown } | null => settled;
  const outcome = result() ?? {
    // Unreachable: the ticker stops only through `finish`.
    error: new Error(`the wait for ticket ${id} stopped without an outcome`),
  };
  if ('error' in outcome) {
    throw outcome.error;
  }
  return outcome.value;
}

/** True when the event file `hash` is an applied-kind `ticket.grant`. */
function isGrant(board: Board, hash: string): boolean {
  const read = readEventFile(board.eventsDir, `${hash}.json`);
  return read.status === 'ok' && read.input.event.kind === 'ticket.grant';
}

/** The global timers (the default `WaitOptions.timers`). */
const globalTimers: TickerTimers = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => {
    clearInterval(handle as NodeJS.Timeout);
  },
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
};
