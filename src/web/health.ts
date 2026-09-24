/**
 * What only a running server knows about the board's health
 * (board-insights: "Health in the web app"; design.md: "Server additions",
 * "Late arrivals", "Cache check"; add-board-insights task 3.1): the late
 * and removed events its feed observed, and the on-request cache check.
 * The server (`src/web/server.ts`) owns one `ObservedLog` and one
 * `CacheChecker` for its whole life and answers `GET /api/health` and
 * `GET /api/health/check` from them.
 *
 * Decisions recorded here (test author, add-board-insights group 3):
 * - Observation order. Within one `resync`, the late events are observed
 *   first, in the message's (fold) order, then the removed hashes, in the
 *   message's order; messages are observed in the order the feed delivers
 *   them. The log lists entries newest first, that is in the reverse of
 *   observation order, so the last removed hash of the latest resync comes
 *   first. When more than the limit (100) have been observed, the oldest
 *   are dropped.
 * - Removed hashes carry only a hash in the feed. The log remembers the
 *   kind and ticket of every event it has seen in any feed message
 *   (`append` events and `resync` late events), and gives a removed entry
 *   the kind and ticket it remembered for that hash. The server's feed
 *   starts without a position, so its first message is an `append` of
 *   every effective event and every later removed hash has been seen. A
 *   removed hash never seen gets kind `""` and ticket null.
 * - `observedAt` is the server's clock (`ServerOptions.now`) read once per
 *   message, when the feed delivers it.
 * - Cache check timing. `ranAt` is the server's clock read when the
 *   comparison starts. A result is reused while `now() - ranAt` is less
 *   than `CHECK_REUSE_MS` (30 seconds); at exactly 30 seconds a request
 *   runs the comparison again.
 * - Single flight. A request that arrives while a comparison runs waits
 *   for that comparison and gets its result (or its failure); it never
 *   starts a second one.
 * - Failure. When the comparison throws (for example `BoardError(5,
 *   'busy')` when the write lock cannot be taken), every request waiting
 *   on it fails with that error, which the server answers with
 *   `httpStatus(error)` and `errorDocument(error, API_HINT_CONTEXT)`
 *   (`src/web/api.ts`). A failure is not kept: `last()` is unchanged and
 *   the next request runs the comparison again.
 * - The comparison never runs except through `CacheChecker.run`, which the
 *   server calls only for `GET /api/health/check`. `GET /api/health`
 *   reports `last()`, and never runs it.
 *
 * Overlap with add-board-insights group 2: `checkSummary` maps the
 * store's `CheckResult` to the report's `HealthCheck`; the `health`
 * command (`src/board/health.ts`) needs the same mapping for `--check`.
 * Whichever lands second should reuse the other's function.
 */

import type { CheckResult } from '../store/rebuild.js';
import type { HealthCheck, LateArrival } from '../view/health.js';
import type { FeedMessage } from '../view/types.js';

/** At most this many observed late or removed events are kept (100). */
export const LATE_LIMIT = 100;

/** A cache check result younger than this is reused: 30 seconds. */
export const CHECK_REUSE_MS = 30_000;

/** The body of `GET /api/health`. */
export interface HealthResponse {
  /** `ObservedLog.list()`: newest first, at most `LATE_LIMIT`. */
  late: LateArrival[];
  /** `CacheChecker.last()`: the last successful check, or null. */
  check: HealthCheck | null;
}

/**
 * The late and removed events a running server's feed reported since the
 * server started.
 */
export interface ObservedLog {
  /**
   * Records one feed message delivered at `observedAt` (milliseconds since
   * the Unix epoch). An `append` adds no entry but remembers the kind and
   * ticket of each of its events; a `resync` adds one entry of type `late`
   * per late event (its hash, kind and ticket) and one entry of type
   * `removed` per removed hash (with the remembered kind and ticket, see
   * the module comment), each with `observedAt`. Never throws.
   */
  observe(message: FeedMessage, observedAt: number): void;
  /**
   * The entries, newest first (see the module comment), at most the
   * log's limit: new objects, so changing them does not change the log.
   */
  list(): LateArrival[];
}

/**
 * A new, empty `ObservedLog` keeping at most `limit` entries (default
 * `LATE_LIMIT`).
 */
export function createObservedLog(limit: number = LATE_LIMIT): ObservedLog {
  void limit;
  throw new Error('not implemented');
}

/** The part of the store's `CheckResult` a health check reports. */
export type CacheCheckOutcome = Pick<CheckResult, 'ok' | 'differences'>;

/**
 * The summary of one cache comparison run at `ranAt`: `{ ranAt, matches:
 * result.ok, differingRows: result.differences.length }`. Pure.
 */
export function checkSummary(result: CacheCheckOutcome, ranAt: number): HealthCheck {
  void result;
  void ranAt;
  throw new Error('not implemented');
}

/** Options of `createCacheChecker`. */
export interface CacheCheckerOptions {
  /**
   * Runs the comparison of `rebuild --check` once. The server passes a
   * function calling the store's `checkCache(board)` (or its own
   * `ServerOptions.checkCache`). It may return its result directly or as a
   * promise; either way `run` is asynchronous.
   */
  check: () => CacheCheckOutcome | Promise<CacheCheckOutcome>;
  /** The clock, in milliseconds since the Unix epoch. */
  now: () => number;
  /** Reuse window; default `CHECK_REUSE_MS`. */
  reuseMs?: number;
}

/** The on-request, single-flight, briefly cached cache check. */
export interface CacheChecker {
  /**
   * The current check result:
   * - when a comparison is running, the promise of that comparison (the
   *   same outcome for every caller);
   * - else, when `last()` is not null and `now() - last().ranAt` is less
   *   than the reuse window, `last()` without running anything;
   * - else it reads `now()` as `ranAt`, calls `check` once and, when it
   *   succeeds, keeps and resolves with `checkSummary(result, ranAt)`.
   * Rejects with the error `check` threw or rejected with (see the module
   * comment); nothing is kept then. Every caller gets a value deep-equal
   * to the kept result.
   */
  run(): Promise<HealthCheck>;
  /** The last successful result, or null when none has succeeded. Never runs `check`. */
  last(): HealthCheck | null;
}

/** A new `CacheChecker`; creating it runs nothing. */
export function createCacheChecker(options: CacheCheckerOptions): CacheChecker {
  void options;
  throw new Error('not implemented');
}
