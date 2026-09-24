/**
 * Shared input types of the board view-model (board-view-model: "Pure
 * view-model layer").
 *
 * Every module under `src/view/` is pure and browser-safe: it reads no
 * clock (the current time `now`, in milliseconds since the Unix epoch, is
 * always a parameter), performs no IO, uses no randomness, never modifies
 * its inputs, and imports no `node:` module directly or transitively (the
 * layering test in `src/__tests__/layering.test.ts` enforces this; only
 * `import type` is exempt, because it is erased at build time). Equal
 * inputs give deep-equal outputs. The web client, the terminal UI
 * (`add-board-tui`) and the insights (`add-board-insights`) all build their
 * view data with these functions.
 */

import type { JsonValue } from '../events/canonical.js';
import type { RejectionReason, Ticket } from '../events/fold.js';
import type { Hlc } from '../events/hlc.js';
import type { BoardEvent, UnknownKindEvent } from '../events/schema.js';

/**
 * How the fold treated a well-formed event: `applied` (it changed the
 * board), `rejected` (a known kind the fold refused, with a reason) or
 * `unknown` (a kind this version does not define; preserved, never
 * folded).
 */
export type EventOutcome = 'applied' | 'rejected' | 'unknown';

/**
 * One well-formed event with its fold outcome, as the snapshot loader, the
 * events API (`/api/events`) and the board feed deliver it. The same shape
 * is sent as JSON, so every field is always present.
 */
export interface EventView {
  /** Lowercase hex SHA-256 of the event's canonical bytes (its file name). */
  hash: string;
  /** `event.kind`. */
  kind: string;
  /** `event.ticket`, or null when the event has none (`board.meta`). */
  ticket: string | null;
  /** `event.actor`. */
  actor: string;
  /** `event.ts`. */
  ts: Hlc;
  outcome: EventOutcome;
  /** The rejection reason when `outcome` is `rejected`; otherwise null. */
  reason: RejectionReason | null;
  /** The event itself, as validated. */
  event: BoardEvent | UnknownKindEvent;
}

/**
 * The client-side model of a board: what a snapshot (`/api/board` plus
 * every page of `/api/events`) gives, kept current by applying feed
 * messages (`applyFeedMessage`, add-board-web task 2.3).
 */
export interface BoardModel {
  /** Every ticket, open and closed, keyed by id (as `BoardState.tickets`). */
  tickets: Record<string, Ticket>;
  /** The board `meta` settings (as `BoardState.meta`). */
  meta: Record<string, JsonValue>;
  /**
   * Every well-formed event (applied, rejected and unknown alike) in fold
   * order (`compareFoldOrder`). Every view-model function that takes events
   * relies on this order and does not re-sort.
   */
  events: EventView[];
  /**
   * Hash of the head: the greatest applied event in fold order, or null
   * when no event is applied.
   */
  head: string | null;
  /** The feed position id `<head>.<digest>` of the same snapshot (board-feed). */
  id: string;
  /**
   * Hashes of the events this model records as late arrivals (the `late`
   * events of the resync that led to its reload), in the order the resync
   * listed them; empty when none. `feedEntries` marks these entries `late`.
   */
  late: string[];
}
