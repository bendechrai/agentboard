/**
 * Activity feed entries (board-view-model: "Activity feed entries"). Pure
 * and browser-safe; see `types.ts`.
 */

import type { Hlc } from '../events/hlc.js';
import type { BoardModel } from './types.js';

/** One line of the activity feed. */
export interface FeedEntry {
  hash: string;
  kind: string;
  actor: string;
  ts: Hlc;
  /** The event's ticket id; null for `board.meta`. */
  ticket: string | null;
  /**
   * The current title of that ticket (from the model's tickets); null for
   * `board.meta` or when the ticket is not in the model.
   */
  title: string | null;
  /**
   * The change: the ticket's current task reference as `<source>:<ref>`
   * (no item); null when the ticket has no task, for `board.meta`, or when
   * the ticket is not in the model.
   */
  change: string | null;
  /** `describeEvent(event)`. */
  summary: string;
  /** True when the model's `late` list holds this event's hash. */
  late: boolean;
}

/** Filters for `feedEntries`; every filter given must match (AND). */
export interface FeedFilters {
  /** Matches entries whose `change` is exactly this `<source>:<ref>` text. */
  change?: string;
  /** Matches entries whose actor is exactly this actor. */
  actor?: string;
  /**
   * Matches entries whose kind is in this list. Absent means every kind;
   * an empty list matches nothing.
   */
  kinds?: readonly string[];
}

/**
 * The activity feed: one entry per event of `model.events` whose outcome
 * is `applied` (rejected and unknown-kind events are left out), newest
 * first, that is the reverse of the model's fold order, keeping only the
 * entries that pass `filters`. Fields as documented on `FeedEntry`.
 */
export function feedEntries(
  model: Pick<BoardModel, 'events' | 'tickets' | 'late'>,
  filters: FeedFilters = {},
): FeedEntry[] {
  throw new Error(
    `not implemented: feedEntries(${String(model.events.length)}, ${String(Object.keys(filters).length)})`,
  );
}
