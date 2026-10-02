/**
 * `agentboard health` as a library operation (board-insights: "Health
 * command"; add-board-insights design.md: "The `health` command"). The checks themselves are the pure `healthReport` of
 * `src/view/health.ts`; this module only gathers its input from a board
 * and, on request, runs the store's `checkCache`.
 */

import type { Board } from '../store/board.js';
import { comparePositions } from '../store/cursors.js';
import { inSnapshot, loadState } from '../store/engine.js';
import { recordedPositions } from '../store/folded.js';
import { checkCache, type CheckResult } from '../store/rebuild.js';
import {
  DEFAULT_THRESHOLDS,
  healthReport,
  type HealthCheck,
  type HealthReport,
  type HealthThresholds,
} from '../view/health.js';
import type { BoardModel, EventView } from '../view/types.js';
import { createEventCache, type EventCache } from './feed.js';

export type { HealthCheck, HealthReport, HealthThresholds };

/** Options of `boardHealth`. */
export interface BoardHealthOptions {
  /**
   * The thresholds, in milliseconds. A threshold left out (or the whole
   * object left out) is its `DEFAULT_THRESHOLDS` value: `staleAfter` 2
   * hours, `blockedAfter` 24 hours. The CLI parses `--stale-after` and
   * `--blocked-after` with `parseDuration` and passes only those given.
   */
  readonly thresholds?: Partial<HealthThresholds>;
  /**
   * True to run the cache check (`--check`): the store's `checkCache`, the
   * same comparison as `rebuild --check`. Default false.
   */
  readonly check?: boolean;
  /**
   * The current time in milliseconds since the Unix epoch; defaults to
   * `Date.now()`, read once. Every age of the report is measured from it,
   * and it is the report's `now` and the check's `ranAt`.
   */
  readonly now?: number;
  /**
   * The event cache that event bodies are read through (`EventCache.get`,
   * so a file is read at most once per cache); defaults to a new cache
   * (`createEventCache()`). Tests pass a cache over a counting reader.
   */
  readonly cache?: EventCache;
}

/**
 * The health report of `board` (board-insights: "Health command"), for
 * the `health` command and the MCP tool `board_health`.
 *
 * Reads, and never writes:
 * - ticket state (tickets, comments, links) from the cache, and
 * - event bodies only from the event files of applied events (the
 *   `folded` rows with `folded = 1`, of any ticket, closed or open; the
 *   cache has no event-to-ticket index, so the files of closed tickets'
 *   events may be read and are then ignored), through `options.cache`. It
 *   never reads the file of a rejected, unknown-kind or malformed event,
 *   and never reads any file twice (the cache keeps what it read).
 *
 * All cache reads are made within one read snapshot (a deferred read
 * transaction, as `inSnapshot`), so the tickets and the events used belong
 * to the same board state, and a concurrent writer on another connection
 * is never blocked by it. The transaction is committed before this function
 * returns (or before the check runs), so no transaction is open on
 * `board.db` afterwards. It does not run catch-up itself: the board is
 * expected to be opened as any read command opens it (`openBoard` with
 * catch-up), which the CLI and the MCP server do.
 *
 * The result deep-equals `healthReport({ model, now, thresholds })` where
 * `model` is the board's tickets and its well-formed events with their
 * outcomes in fold order (as `loadSnapshot` gives them; events of closed
 * tickets may be left out, since no check looks at them), `now` and
 * `thresholds` as resolved from `options`, with:
 * - `late`: always null (a one-shot command cannot observe arrival order);
 * - `check`: null unless `options.check`; then, after the snapshot has
 *   been committed, `checkCache(board)` runs (it takes the write lock for
 *   the length of a full refold into memory, exactly as `rebuild --check`,
 *   and always rolls back) and `check` is
 *   `{ ranAt: now, matches: result.ok, differingRows: result.differences.length }`.
 *   A cache that differs is a finding, not a failure.
 *
 * Writes no event, no cursor and no cache row; needs no actor.
 *
 * @throws BoardError exit 5 `integrity` when a file recorded as
 *   well-formed is not (`EventCache.get`), and exit 5 `busy` when the check
 *   cannot take the write lock within the busy timeout.
 */
export function boardHealth(board: Board, options?: BoardHealthOptions): HealthReport {
  const now = options?.now ?? Date.now();
  const thresholds: HealthThresholds = {
    staleAfter: options?.thresholds?.staleAfter ?? DEFAULT_THRESHOLDS.staleAfter,
    blockedAfter: options?.thresholds?.blockedAfter ?? DEFAULT_THRESHOLDS.blockedAfter,
  };
  const model = loadApplied(board, options?.cache ?? createEventCache());
  let check: HealthCheck | null = null;
  if (options?.check === true) {
    // After the snapshot has been committed: checkCache takes the write lock.
    const result = checkCache(board);
    check = checkSummary(result, now);
  }
  return healthReport({ model, now, thresholds, late: null, check });
}

/**
 * The tickets of `board` and its applied events in fold order, read in one
 * read snapshot. Only the files of applied events are read, through
 * `cache`, and each at most once (the hashes of `folded` are distinct).
 */
function loadApplied(board: Board, cache: EventCache): Pick<BoardModel, 'tickets' | 'events'> {
  const { db, eventsDir } = board;
  return inSnapshot(db, () => {
    const { tickets } = loadState(db);
    const events = recordedPositions(db, { effectiveOnly: true })
      .sort(comparePositions)
      .map((row): EventView => {
        const event = cache.get(eventsDir, row.hash);
        return {
          hash: row.hash,
          kind: event.kind,
          ticket: 'ticket' in event && typeof event.ticket === 'string' ? event.ticket : null,
          actor: event.actor,
          ts: event.ts,
          outcome: 'applied',
          reason: null,
          event,
        };
      });
    return { tickets, events };
  });
}

/** The part of the store's `CheckResult` a health check reports. */
export type CacheCheckOutcome = Pick<CheckResult, 'ok' | 'differences'>;

/**
 * The summary of one cache comparison run at `ranAt`: `{ ranAt, matches:
 * result.ok, differingRows: result.differences.length }`. Pure.
 */
export function checkSummary(result: CacheCheckOutcome, ranAt: number): HealthCheck {
  return { ranAt, matches: result.ok, differingRows: result.differences.length };
}
