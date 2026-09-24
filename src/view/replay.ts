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

import {
  applyEvent,
  type ApplyOutcome,
  type BoardState,
  type FoldInput,
  type RejectionReason,
} from '../events/fold.js';
import type { JsonValue } from '../events/json.js';
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
  const checkpoints: ReplayCheckpoint[] = [];
  const state = emptyState();
  events.forEach((input, index) => {
    applyEvent(state, input);
    const count = index + 1;
    if (count % CHECKPOINT_INTERVAL === 0) {
      checkpoints.push({ count, state: cloneState(state) });
    }
  });
  return checkpoints;
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
 * not above `index` (the event at `index` is always folded, to give its
 * outcome), so a seek takes at most 500 fold steps; the
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
  if (!Number.isInteger(index) || index < 0 || index >= events.length) {
    throw new RangeError(`replay index ${String(index)} is outside 0..${String(events.length - 1)}`);
  }
  const count = index + 1;
  // Start at or before `index`, so the event at `index` is folded here and
  // its outcome is known.
  let start: ReplayCheckpoint | null = null;
  for (const checkpoint of checkpoints ?? []) {
    if (checkpoint.count <= index && (start === null || checkpoint.count > start.count)) {
      start = checkpoint;
    }
  }
  const state = start === null ? emptyState() : cloneState(start.state);
  let outcome: ApplyOutcome = { status: 'applied' };
  for (let i = start === null ? 0 : start.count; i < count; i += 1) {
    const input = events[i];
    if (input !== undefined) {
      outcome = applyEvent(state, input);
    }
  }
  // The fold shares `board.meta` values with the events it applied, so the
  // result is a copy.
  return {
    index,
    state: cloneState(state),
    outcome: outcome.status,
    reason: outcome.status === 'rejected' ? outcome.rejected.reason : null,
  };
}

/** An empty board, as `fold` starts from (a null-prototype `meta`). */
function emptyState(): BoardState {
  return { tickets: {}, meta: Object.create(null) as Record<string, JsonValue> };
}

/** A deep copy of `state` sharing no object with it; `meta` keeps its null prototype. */
function cloneState(state: BoardState): BoardState {
  return { tickets: cloneData(state.tickets), meta: cloneData(state.meta) };
}

/**
 * A deep copy of plain data (arrays, objects, primitives). Each object copy
 * keeps its original's prototype, and keys are defined rather than
 * assigned, so a `__proto__` key stays an ordinary entry.
 */
function cloneData<T>(value: T): T {
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) => cloneData(item)) as T;
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const copy = Object.create(Object.getPrototypeOf(value) as object | null) as Record<
    string,
    unknown
  >;
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(copy, key, {
      value: cloneData(item),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy as T;
}
