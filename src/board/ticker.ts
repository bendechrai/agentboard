/**
 * The shared tick loop of `watch` and the board feed (board-feed: "Board-wide
 * change feed"; design.md: "One ticker for `watch` and the feed";
 * add-board-web task 2.1).
 *
 * The loop is the one `watchInbox` used to run on its own: one tick at
 * start, then a tick after each `fs.watch` notification on a directory
 * (coalesced over `FS_SETTLE_MS`) and every `pollMs` milliseconds
 * regardless, never two ticks at once, transient `busy` failures reported
 * as warnings, and full cleanup on abort. What a tick does is the caller's
 * `examine` function: `watchInbox` (`src/board/watch.ts`) and `watchBoard`
 * (`src/board/feed.ts`) are two examiners run by this loop, and
 * `watchInbox` keeps no timer or watcher of its own once it runs on it.
 *
 * Timers and the directory watcher are injectable so the loop can be
 * tested with a fake clock; the defaults are the global timers and
 * `fs.watch`.
 */

/** Interval of the polling fallback, in milliseconds (the default `pollMs`). */
export const TICK_POLL_MS = 2000;

/**
 * Delay between a directory notification and the tick it triggers, so the
 * burst of notifications one event write produces (temporary file, rename)
 * becomes one tick.
 */
export const FS_SETTLE_MS = 25;

/** An opaque timer handle, as returned by the injected timer functions. */
export type TimerHandle = unknown;

/**
 * The timer functions the ticker uses. The default is the global
 * `setInterval`, `clearInterval`, `setTimeout` and `clearTimeout`. The
 * ticker uses exactly one interval (the poll, created once after the first
 * tick) and at most one pending timeout at a time (the settle delay).
 */
export interface TickerTimers {
  setInterval(callback: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** A directory watcher started by `TickerOptions.watchDir`. */
export interface DirWatcher {
  /** Stops the watcher. Calling it more than once is harmless. */
  close(): void;
}

/**
 * Starts watching `dir`: `onChange` is called for every change notification
 * and `onError` when the watcher fails (after which it delivers nothing
 * more). May throw when watching is unavailable. The default wraps
 * `fs.watch(dir, onChange)` and its `error` event.
 */
export type WatchDir = (dir: string, onChange: () => void, onError: () => void) => DirWatcher;

/** Options of `runTicker`. */
export interface TickerOptions {
  /** Stops the loop. Aborting resolves the promise (after cleanup). */
  readonly signal: AbortSignal;
  /**
   * One tick. Synchronous. A tick that throws `BoardError` of exit code 5
   * and reason `busy` is reported through `onWarning` and the loop carries
   * on; any other error is handled as described on `onFailure`.
   */
  examine(): void;
  /** The directory to watch (the board's `events/`). */
  readonly dir: string;
  /** Polling interval; defaults to `TICK_POLL_MS`. */
  readonly pollMs?: number;
  /**
   * When false, no directory watcher is started and only polling runs.
   * Defaults to true.
   */
  readonly fsWatch?: boolean;
  /**
   * Receives the error message of each tick that failed with
   * `BoardError(5, 'busy')`, as one plain ASCII line without a newline.
   * Defaults to ignoring it.
   */
  onWarning?(line: string): void;
  /**
   * Receives every other error a tick throws; the loop then carries on at
   * the next tick (the server's behavior, design.md: "A tick failure does
   * not stop the server"). When absent (the `watch` behavior), such an
   * error stops the loop: the same cleanup as on abort happens and the
   * promise rejects with that error.
   */
  onFailure?(error: unknown): void;
  /** Timer functions; defaults to the global timers. */
  readonly timers?: TickerTimers;
  /** Directory watcher factory; defaults to one built on `fs.watch`. */
  readonly watchDir?: WatchDir;
}

/**
 * Runs the tick loop until `signal` aborts.
 *
 * 1. Runs one tick at once, synchronously, before `runTicker` returns and
 *    before waiting for anything, even when `signal` is already aborted.
 *    If `signal` is aborted when that tick ends (already, or by the tick
 *    itself), or that tick stopped the loop, no timer and no watcher is
 *    ever created.
 * 2. Otherwise creates the poll interval (`pollMs`) and, unless `fsWatch`
 *    is false, the directory watcher on `dir`. A notification schedules one
 *    tick `FS_SETTLE_MS` later unless one is already scheduled, so a burst
 *    of notifications within the settle delay gives one tick. When the
 *    watcher reports an error it is closed and polling continues; when
 *    `watchDir` throws, polling alone continues.
 * 3. Ticks never overlap: a tick requested (by the interval, the settle
 *    timeout or anything else) while a tick is running does not run, and
 *    is not queued; the next notification or poll runs the next tick.
 * 4. On abort: removes the abort listener, closes the watcher, clears the
 *    interval and any pending settle timeout, and resolves. Nothing is left
 *    that keeps the event loop alive, and no tick runs afterwards.
 *
 * Errors: see `TickerOptions.examine` and `TickerOptions.onFailure`.
 */
export function runTicker(options: TickerOptions): Promise<void> {
  void options;
  throw new Error('not implemented');
}
