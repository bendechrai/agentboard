/**
 * Replay (board-insights: "Replay"; add-board-insights task 1.2). Pure and
 * browser-safe; see `types.ts`.
 *
 * Replay rebuilds the board at any position of the event log with the
 * store's own pure fold (`applyEvent` and `fold` from
 * `src/events/fold.ts`), never with a second implementation of the state
 * machine. Positions follow the log's fold order, so an event synced late
 * appears at its fold position, not when it arrived.
 */

import type { BoardState, FoldInput, RejectionReason } from '../events/fold.js';
import type { EventOutcome } from './types.js';

/** A checkpoint is kept after every this many events (500). */
export const CHECKPOINT_INTERVAL = 500;

/** The folded state after a whole number of checkpoint intervals. */
export interface ReplayCheckpoint {
  /**
   * How many events (from the start of the list) were folded into `state`:
   * a positive multiple of `CHECKPOINT_INTERVAL`.
   */
  count: number;
  /** Equal to `fold(events.slice(0, count)).state`. */
  state: BoardState;
}

/** The board at one replay position. */
export interface ReplayState {
  /** The position: the index of the last event folded. */
  index: number;
  /**
   * The board after folding the first `index + 1` events of the list:
   * deep-equal to `fold(events.slice(0, index + 1)).state`, however the
   * position was reached and whether or not checkpoints were given. A new
   * object, sharing nothing with the inputs or the checkpoints.
   */
  state: BoardState;
  /**
   * How the fold treated the event at `index`, recomputed by the replay
   * (the `outcome` of an `EventView` in the input is ignored), so an event
   * that is rejected in fold order shows as `rejected`.
   */
  outcome: EventOutcome;
  /** The rejection reason when `outcome` is `rejected`; otherwise null. */
  reason: RejectionReason | null;
}

/**
 * The checkpoints of `events` (taken to be in fold order, as
 * `BoardModel.events`; an `EventView` list is accepted as is): one per
 * whole `CHECKPOINT_INTERVAL` of events, that is with `count` 500, 1000,
 * ... up to and including `events.length` when it is a multiple of 500, in
 * ascending `count` order. Empty for fewer than 500 events. Computed with
 * one pass of the store's fold; memory is one state per checkpoint. Pure:
 * `events` is not modified.
 */
export function replayCheckpoints(events: readonly FoldInput[]): ReplayCheckpoint[] {
  void events;
  throw new Error('not implemented');
}

/**
 * The board at position `index` of `events` (board-insights: "Replay"):
 * the state obtained by folding the first `index + 1` events of the list,
 * which is taken to be in fold order (as `BoardModel.events`) and is not
 * re-sorted, with the store's fold, starting from an empty board. Hashes
 * in the list are distinct, as in `BoardModel.events`.
 *
 * When `checkpoints` (from `replayCheckpoints` of the same list) is given,
 * folding starts from a copy of the checkpoint with the greatest `count`
 * not above `index + 1`, so a seek takes at most 499 fold steps; the
 * result is deep-equal to the one computed without checkpoints. Neither
 * `events` nor `checkpoints` is modified, and the result shares no object
 * with them.
 *
 * Throws a `RangeError` when `index` is not an integer with
 * `0 <= index < events.length` (so always for an empty list).
 */
export function replayState(
  events: readonly FoldInput[],
  index: number,
  checkpoints?: readonly ReplayCheckpoint[],
): ReplayState {
  void events;
  void index;
  void checkpoints;
  throw new Error('not implemented');
}
