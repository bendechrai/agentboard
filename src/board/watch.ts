/**
 * `watch` (board-cli: "Command surface"; design.md: "`watch`"): a stream of
 * an actor's pending inbox entries that never acknowledges them.
 */

import { watch, type FSWatcher } from 'node:fs';

import type { Board } from '../store/board.js';
import { catchUp } from '../store/cache.js';
import { isPending, readCursor } from '../store/cursors.js';
import { inSnapshot } from '../store/engine.js';
import { BoardError } from '../store/errors.js';
import { readEventFile, type ReadOutcome } from '../store/eventfile.js';
import { dataVersion, effectiveExcept } from '../store/folded.js';
import type { InboxEntry } from './inbox.js';
import { toEntries } from './pending.js';

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
  /**
   * Reads one event file, with the contract of `readEventFile`
   * (`src/store/eventfile.ts`), which is the default. Every event file the
   * watch reads to build entries is read through this function (catch-up's
   * own reading of newly written files is not), so tests can count the
   * reads of a tick.
   */
  readonly readEventFile?: (eventsDir: string, name: string) => ReadOutcome;
  /**
   * Receives one plain ASCII line (without a newline) for each tick that
   * failed with a transient `BoardError` of exit code 5 and reason `busy`;
   * the watch then carries on at its next tick. Defaults to ignoring it.
   * The CLI prints it to stderr as `agentboard: <line>`.
   */
  onWarning?(line: string): void;
}

/**
 * `watch --as <actor>`.
 *
 * The first tick runs the same catch-up as any command and passes on
 * every entry pending for the actor's stored cursor (as
 * `readInbox(board, actor, { peek: true })` lists them), in fold order.
 *
 * Later ticks do bounded work. The watch remembers every effective event
 * it has examined (passed on or not), and the connection's
 * `PRAGMA data_version` as of its last examination. A later tick runs
 * catch-up; when that catch-up folded nothing and no other connection has
 * committed since (`data_version` unchanged), the tick ends there, reading
 * no event file and no `folded` row. Otherwise it lists the effective
 * events it has not examined yet (from `folded`, without reading files):
 * exactly the events newly folded as applied or newly turned effective,
 * whether they sort after everything examined so far or behind it (a late
 * arrival, or a rejected event made effective by one). Of those, it passes
 * on, in fold order, the ones pending for the actor's stored cursor
 * (`isPending`), reading one event file per entry passed on (see
 * `WatchOptions.readEventFile`), and marks them all examined. No event is
 * examined twice, so no entry is passed on twice.
 *
 * The examined set is not pruned. Pruning it by the seen-set window would
 * make an old examined event look new at the next listing and pass it on
 * a second time, so it grows with the effective events of the board over
 * the life of the watch: one 64-character hash per event (about 1 MB per
 * 10,000 events).
 *
 * The stored cursor is never written (watch is a stream, not an
 * acknowledgement; the actor runs `inbox` to acknowledge), and entries that
 * a concurrent `inbox` acknowledges before the watch reaches them are
 * simply no longer pending.
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
 * left that keeps the event loop alive. When a tick throws
 * `BoardError(5, 'busy')` (the cache stayed locked past the busy timeout
 * and its retry), the watch calls `onWarning` with the error's message and
 * carries on: the next tick picks up whatever that one missed. When a tick
 * throws anything else, the same cleanup as on abort happens and the
 * promise rejects with that error. Does not close `board`.
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
  const read = options.readEventFile ?? readEventFile;
  const { db } = board;
  // Every effective event examined so far, and `data_version` at the time.
  const examined = new Set<string>();
  let version: number | null = null;

  /** One tick's examination; the watch state changes only if it succeeds. */
  const examine = (): void => {
    const report = catchUp(board);
    const current = dataVersion(db);
    if (
      version !== null &&
      current === version &&
      report.applied.length === 0 &&
      !report.refolded
    ) {
      return;
    }
    const { fresh, entries } = inSnapshot(db, () => {
      const cursor = readCursor(db, actor);
      const unseen = effectiveExcept(db, examined);
      const due = unseen.filter((p) => isPending(cursor, p));
      return { fresh: unseen, entries: toEntries(board, due, read) };
    });
    version = current;
    for (const p of fresh) {
      examined.add(p.hash);
    }
    if (entries.length > 0) {
      onEntries(entries);
    }
  };

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
        examine();
      } catch (error) {
        if (error instanceof BoardError && error.exitCode === 5 && error.reason === 'busy') {
          options.onWarning?.(error.message);
          return;
        }
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
