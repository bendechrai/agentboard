/**
 * `watch` (board-cli: "Command surface"; design.md: "`watch`"): a stream of
 * an actor's pending inbox entries that never acknowledges them.
 */

import { watch, type FSWatcher } from 'node:fs';

import type { Board } from '../store/board.js';
import { BoardError } from '../store/errors.js';
import { readInbox, type InboxEntry } from './inbox.js';

/** Interval of the polling fallback, in milliseconds. */
export const WATCH_POLL_MS = 2000;

/**
 * Delay between an `fs.watch` notification and the tick it triggers, so the
 * burst of notifications one event write produces (temporary file, rename)
 * becomes one tick.
 */
const FS_SETTLE_MS = 25;

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
  if (actor === '') {
    return Promise.reject(
      new BoardError(
        1,
        'missing-actor',
        'watch needs an actor: pass --as <actor> or set AGENTBOARD_ACTOR',
      ),
    );
  }
  const { signal, onEntries } = options;
  const passed = new Set<string>();
  return new Promise<void>((resolve, reject) => {
    let watcher: FSWatcher | null = null;
    let poll: NodeJS.Timeout | null = null;
    let settle: NodeJS.Timeout | null = null;
    let stopped = false;

    const stop = (): void => {
      stopped = true;
      signal.removeEventListener('abort', onAbort);
      watcher?.close();
      watcher = null;
      if (poll !== null) {
        clearInterval(poll);
      }
      if (settle !== null) {
        clearTimeout(settle);
      }
    };
    function onAbort(): void {
      stop();
      resolve();
    }
    // Synchronous from start to end, so two ticks can never overlap; only
    // the timers and the watcher call it, and `stop` removes all of them.
    const tick = (): void => {
      try {
        const fresh = readInbox(board, actor, { peek: true }).entries.filter(
          (entry) => !passed.has(entry.hash),
        );
        for (const entry of fresh) {
          passed.add(entry.hash);
        }
        if (fresh.length > 0) {
          onEntries(fresh);
        }
      } catch (error) {
        stop();
        reject(error as Error);
      }
    };

    tick();
    if (stopped) {
      return;
    }
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    poll = setInterval(tick, options.pollMs ?? WATCH_POLL_MS);
    if (options.fsWatch !== false) {
      try {
        const w = watch(board.eventsDir, () => {
          if (settle === null) {
            settle = setTimeout(() => {
              settle = null;
              tick();
            }, FS_SETTLE_MS);
          }
        });
        // Closing twice (here, then in `stop`) is harmless.
        w.on('error', () => {
          w.close();
        });
        watcher = w;
      } catch {
        // fs.watch is unavailable here; polling alone continues.
      }
    }
  });
}
