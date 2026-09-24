/**
 * `watch` (board-cli: "Command surface"; design.md: "`watch`"): a stream of
 * an actor's pending inbox entries that never acknowledges them.
 */

import type { Board } from '../store/board.js';
import type { InboxEntry } from './inbox.js';

/** Interval of the polling fallback, in milliseconds. */
export const WATCH_POLL_MS = 2000;

/** Options of `watchInbox`. */
export interface WatchOptions {
  /** Stops the watch. Aborting resolves the promise (after cleanup). */
  readonly signal: AbortSignal;
  /**
   * Receives the entries each tick found that this watch has not passed
   * on before, in fold order. Never called with an empty array.
   */
  onEntries(entries: readonly InboxEntry[]): void;
  /** Polling interval; defaults to `WATCH_POLL_MS`. */
  readonly pollMs?: number;
  /**
   * When false, `fs.watch` is not used and only polling runs (tests of the
   * fallback). Defaults to true.
   */
  readonly fsWatch?: boolean;
}

/**
 * `watch --as <actor>`.
 *
 * A tick is: `readInbox(board, actor, { peek: true })` (which runs the same
 * catch-up as any command), then `onEntries` with the entries whose hash
 * this watch has not passed on yet, in fold order; those hashes are then
 * remembered for the life of the watch, so no entry is passed on twice.
 * The stored cursor is never advanced (watch is a stream, not an
 * acknowledgement; the actor runs `inbox` to acknowledge), and entries that
 * a concurrent `inbox` acknowledges are simply no longer pending.
 *
 * Runs one tick at once, before waiting for anything (so the actor's
 * pending entries are printed first), even when `signal` is already
 * aborted. Then, until `signal` aborts, runs a tick whenever `fs.watch` on
 * `board.eventsDir` reports a change (unless `fsWatch` is false) and every
 * `pollMs` milliseconds regardless, because `fs.watch` is unreliable on
 * network filesystems and coalesces events on macOS. Ticks never overlap.
 * An `error` from the `fs.watch` watcher closes it and polling continues.
 *
 * On abort: closes the watcher, clears the timer and resolves; nothing is
 * left that keeps the event loop alive. When a tick throws (for example
 * `BoardError(5, 'busy')`), the same cleanup happens and the promise
 * rejects with that error. Does not close `board`.
 *
 * @throws BoardError exit 1 `missing-actor` (as a rejection) when `actor`
 *   is empty, before the first tick.
 */
export function watchInbox(board: Board, actor: string, options: WatchOptions): Promise<void> {
  void board;
  void actor;
  void options;
  return Promise.reject(new Error('not implemented'));
}
