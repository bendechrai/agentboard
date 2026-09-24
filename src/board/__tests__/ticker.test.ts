/**
 * The shared tick loop (board-feed: "Board-wide change feed"; design.md:
 * "One ticker for `watch` and the feed"). Task 2.1: no overlap and cleanup
 * on abort, driven by an injected clock and an injected directory watcher.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { BoardError } from '../../store/errors.js';
import {
  FS_SETTLE_MS,
  TICK_POLL_MS,
  runTicker,
  type DirWatcher,
  type TickerTimers,
  type WatchDir,
} from '../ticker.js';

interface Timer {
  id: number;
  callback: () => void;
  ms: number;
  due: number;
  repeat: boolean;
}

/** A manual clock implementing `TickerTimers`. */
class FakeClock implements TickerTimers {
  now = 0;
  private next = 1;
  readonly timers = new Map<number, Timer>();
  intervalsCreated = 0;
  timeoutsCreated = 0;

  setInterval(callback: () => void, ms: number): number {
    this.intervalsCreated += 1;
    return this.add(callback, ms, true);
  }
  clearInterval(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  setTimeout(callback: () => void, ms: number): number {
    this.timeoutsCreated += 1;
    return this.add(callback, ms, false);
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  private add(callback: () => void, ms: number, repeat: boolean): number {
    const id = this.next;
    this.next += 1;
    this.timers.set(id, { id, callback, ms, due: this.now + ms, repeat });
    return id;
  }

  /** Pending timers (intervals and timeouts). */
  get pending(): number {
    return this.timers.size;
  }

  intervals(): Timer[] {
    return [...this.timers.values()].filter((t) => t.repeat);
  }

  /** Advances the clock by `ms`, firing every timer that falls due, in due order. */
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.timers.values()]
        .filter((t) => t.due <= end)
        .sort((a, b) => a.due - b.due || a.id - b.id)[0];
      if (due === undefined) {
        break;
      }
      this.now = due.due;
      if (due.repeat) {
        due.due += due.ms;
      } else {
        this.timers.delete(due.id);
      }
      due.callback();
    }
    // A callback may itself have advanced the clock further.
    this.now = Math.max(this.now, end);
  }

  /** Fires every interval once, now, whatever its due time. */
  fireIntervals(): void {
    for (const t of this.intervals()) {
      t.callback();
    }
  }
}

/** An injectable directory watcher that records what happens to it. */
class FakeWatch {
  readonly started: string[] = [];
  closed = 0;
  onChange: (() => void) | null = null;
  onError: (() => void) | null = null;
  throwOnStart = false;

  readonly watchDir: WatchDir = (dir, onChange, onError): DirWatcher => {
    if (this.throwOnStart) {
      throw new Error('watching unavailable');
    }
    this.started.push(dir);
    this.onChange = onChange;
    this.onError = onError;
    return {
      close: () => {
        this.closed += 1;
      },
    };
  };

  notify(): void {
    this.onChange?.();
  }
}

function aborted(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

/** Lets pending promise callbacks run. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Tracks whether a promise has settled, and how. */
function track(promise: Promise<void>): { state: () => 'pending' | 'resolved' | 'rejected' } {
  let state: 'pending' | 'resolved' | 'rejected' = 'pending';
  promise.then(
    () => {
      state = 'resolved';
    },
    () => {
      state = 'rejected';
    },
  );
  return { state: () => state };
}

const DIR = '/nonexistent/board/events';

describe('ticker constants', () => {
  it('polls every 2 seconds and settles notifications over 25 ms', () => {
    expect(TICK_POLL_MS).toBe(2000);
    expect(FS_SETTLE_MS).toBe(25);
  });
});

describe('runTicker', () => {
  it('runs one tick at once, synchronously, even when already aborted, and creates nothing', async () => {
    const clock = new FakeClock();
    const fake = new FakeWatch();
    let ticks = 0;
    const done = runTicker({
      signal: aborted(),
      dir: DIR,
      examine: () => {
        ticks += 1;
      },
      timers: clock,
      watchDir: fake.watchDir,
    });
    expect(ticks).toBe(1);
    await done;
    expect(clock.intervalsCreated).toBe(0);
    expect(clock.timeoutsCreated).toBe(0);
    expect(fake.started).toEqual([]);
  });

  it('creates nothing when the first tick aborts the signal', async () => {
    const clock = new FakeClock();
    const fake = new FakeWatch();
    const controller = new AbortController();
    let ticks = 0;
    await runTicker({
      signal: controller.signal,
      dir: DIR,
      examine: () => {
        ticks += 1;
        controller.abort();
      },
      timers: clock,
      watchDir: fake.watchDir,
    });
    expect(ticks).toBe(1);
    expect(clock.pending).toBe(0);
    expect(fake.started).toEqual([]);
  });

  it('polls every pollMs (TICK_POLL_MS by default) and watches the directory', async () => {
    const clock = new FakeClock();
    const fake = new FakeWatch();
    const controller = new AbortController();
    let ticks = 0;
    const done = runTicker({
      signal: controller.signal,
      dir: DIR,
      examine: () => {
        ticks += 1;
      },
      timers: clock,
      watchDir: fake.watchDir,
    });
    expect(ticks).toBe(1);
    expect(fake.started).toEqual([DIR]);
    expect(clock.intervals().map((t) => t.ms)).toEqual([TICK_POLL_MS]);
    clock.advance(TICK_POLL_MS - 1);
    expect(ticks).toBe(1);
    clock.advance(1);
    expect(ticks).toBe(2);
    clock.advance(3 * TICK_POLL_MS);
    expect(ticks).toBe(5);
    controller.abort();
    await done;
  });

  it('uses the given pollMs', async () => {
    const clock = new FakeClock();
    const controller = new AbortController();
    let ticks = 0;
    const done = runTicker({
      signal: controller.signal,
      dir: DIR,
      pollMs: 50,
      fsWatch: false,
      examine: () => {
        ticks += 1;
      },
      timers: clock,
    });
    clock.advance(200);
    expect(ticks).toBe(5);
    controller.abort();
    await done;
  });

  it('turns a burst of notifications within the settle delay into one tick, 25 ms later', async () => {
    const clock = new FakeClock();
    const fake = new FakeWatch();
    const controller = new AbortController();
    let ticks = 0;
    const done = runTicker({
      signal: controller.signal,
      dir: DIR,
      examine: () => {
        ticks += 1;
      },
      timers: clock,
      watchDir: fake.watchDir,
    });
    fake.notify();
    clock.advance(10);
    fake.notify();
    fake.notify();
    clock.advance(FS_SETTLE_MS - 11);
    expect(ticks).toBe(1);
    clock.advance(1);
    expect(ticks).toBe(2);
    clock.advance(100);
    expect(ticks).toBe(2);
    // A later notification schedules a new tick.
    fake.notify();
    clock.advance(FS_SETTLE_MS);
    expect(ticks).toBe(3);
    controller.abort();
    await done;
  });

  it('does not watch when fsWatch is false', async () => {
    const clock = new FakeClock();
    const fake = new FakeWatch();
    const controller = new AbortController();
    const done = runTicker({
      signal: controller.signal,
      dir: DIR,
      fsWatch: false,
      examine: () => undefined,
      timers: clock,
      watchDir: fake.watchDir,
    });
    expect(fake.started).toEqual([]);
    expect(clock.intervals()).toHaveLength(1);
    controller.abort();
    await done;
  });

  it('keeps polling when the watcher cannot start or reports an error', async () => {
    for (const failure of ['start', 'error'] as const) {
      const clock = new FakeClock();
      const fake = new FakeWatch();
      fake.throwOnStart = failure === 'start';
      const controller = new AbortController();
      let ticks = 0;
      const done = runTicker({
        signal: controller.signal,
        dir: DIR,
        examine: () => {
          ticks += 1;
        },
        timers: clock,
        watchDir: fake.watchDir,
      });
      if (failure === 'error') {
        fake.onError?.();
        expect(fake.closed).toBeGreaterThanOrEqual(1);
      }
      clock.advance(2 * TICK_POLL_MS);
      expect(ticks, failure).toBe(3);
      controller.abort();
      await done;
    }
  });
});

describe('runTicker: ticks never overlap', () => {
  it('a tick requested while one runs does not run inside it, and is not queued', async () => {
    const clock = new FakeClock();
    const fake = new FakeWatch();
    const controller = new AbortController();
    let depth = 0;
    let maxDepth = 0;
    let ticks = 0;
    let reenter = false;
    const done = runTicker({
      signal: controller.signal,
      dir: DIR,
      examine: () => {
        depth += 1;
        ticks += 1;
        maxDepth = Math.max(maxDepth, depth);
        if (reenter) {
          reenter = false;
          // Everything that can request a tick fires while this one runs.
          clock.fireIntervals();
          fake.notify();
          clock.advance(FS_SETTLE_MS);
        }
        depth -= 1;
      },
      timers: clock,
      watchDir: fake.watchDir,
    });
    reenter = true;
    clock.advance(TICK_POLL_MS);
    expect(maxDepth).toBe(1);
    // The poll tick ran; the requests made during it ran nothing.
    expect(ticks).toBe(2);
    // Nothing was queued: no tick runs until the next poll.
    clock.advance(TICK_POLL_MS - FS_SETTLE_MS - 1);
    expect(ticks).toBe(2);
    clock.advance(FS_SETTLE_MS + 1);
    expect(ticks).toBe(3);
    controller.abort();
    await done;
  });
});

describe('runTicker: cleanup', () => {
  it('on abort clears the interval and a pending settle timeout, closes the watcher and resolves', async () => {
    const clock = new FakeClock();
    const fake = new FakeWatch();
    const controller = new AbortController();
    let ticks = 0;
    const done = runTicker({
      signal: controller.signal,
      dir: DIR,
      examine: () => {
        ticks += 1;
      },
      timers: clock,
      watchDir: fake.watchDir,
    });
    const settled = track(done);
    fake.notify();
    // The interval and the settle timeout are pending.
    expect(clock.pending).toBe(2);
    await flush();
    expect(settled.state()).toBe('pending');
    controller.abort();
    await flush();
    expect(settled.state()).toBe('resolved');
    expect(clock.pending).toBe(0);
    expect(fake.closed).toBeGreaterThanOrEqual(1);
    // Nothing runs any more, whatever happens next.
    fake.notify();
    clock.advance(10 * TICK_POLL_MS);
    expect(ticks).toBe(1);
  });

  it('a busy tick is a warning and the loop carries on', async () => {
    const clock = new FakeClock();
    const controller = new AbortController();
    const warnings: string[] = [];
    let ticks = 0;
    const done = runTicker({
      signal: controller.signal,
      dir: DIR,
      fsWatch: false,
      examine: () => {
        ticks += 1;
        if (ticks === 2) {
          throw new BoardError(5, 'busy', 'the board cache is locked');
        }
      },
      onWarning: (line) => warnings.push(line),
      timers: clock,
    });
    const settled = track(done);
    clock.advance(2 * TICK_POLL_MS);
    await flush();
    expect(ticks).toBe(3);
    expect(warnings).toEqual(['the board cache is locked']);
    expect(settled.state()).toBe('pending');
    controller.abort();
    await done;
  });

  it('a busy first tick is a warning too, and the loop starts', async () => {
    const clock = new FakeClock();
    const controller = new AbortController();
    const warnings: string[] = [];
    let ticks = 0;
    const done = runTicker({
      signal: controller.signal,
      dir: DIR,
      fsWatch: false,
      examine: () => {
        ticks += 1;
        if (ticks === 1) {
          throw new BoardError(5, 'busy', 'locked');
        }
      },
      onWarning: (line) => warnings.push(line),
      timers: clock,
    });
    clock.advance(TICK_POLL_MS);
    expect(ticks).toBe(2);
    expect(warnings).toEqual(['locked']);
    controller.abort();
    await done;
  });

  it('any other error stops the loop with the same cleanup and rejects with it', async () => {
    const clock = new FakeClock();
    const fake = new FakeWatch();
    const controller = new AbortController();
    const boom = new BoardError(5, 'integrity', 'broken');
    let ticks = 0;
    const done = runTicker({
      signal: controller.signal,
      dir: DIR,
      examine: () => {
        ticks += 1;
        if (ticks === 2) {
          throw boom;
        }
      },
      timers: clock,
      watchDir: fake.watchDir,
    });
    const settled = track(done);
    fake.notify();
    clock.advance(TICK_POLL_MS);
    await flush();
    expect(settled.state()).toBe('rejected');
    await expect(done).rejects.toBe(boom);
    expect(clock.pending).toBe(0);
    expect(fake.closed).toBeGreaterThanOrEqual(1);
    clock.advance(10 * TICK_POLL_MS);
    expect(ticks).toBe(2);
    controller.abort();
  });

  it('an error in the first tick rejects without creating anything', async () => {
    const clock = new FakeClock();
    const fake = new FakeWatch();
    const boom = new Error('first');
    const done = runTicker({
      signal: new AbortController().signal,
      dir: DIR,
      examine: () => {
        throw boom;
      },
      timers: clock,
      watchDir: fake.watchDir,
    });
    await expect(done).rejects.toBe(boom);
    expect(clock.pending).toBe(0);
    expect(fake.started).toEqual([]);
  });

  it('with onFailure, other errors are passed on and the loop carries on', async () => {
    const clock = new FakeClock();
    const controller = new AbortController();
    const failures: unknown[] = [];
    const warnings: string[] = [];
    let ticks = 0;
    const boom = new Error('transient');
    const done = runTicker({
      signal: controller.signal,
      dir: DIR,
      fsWatch: false,
      examine: () => {
        ticks += 1;
        if (ticks <= 2) {
          throw boom;
        }
      },
      onFailure: (error) => failures.push(error),
      onWarning: (line) => warnings.push(line),
      timers: clock,
    });
    const settled = track(done);
    clock.advance(2 * TICK_POLL_MS);
    await flush();
    expect(ticks).toBe(3);
    expect(failures).toEqual([boom, boom]);
    expect(warnings).toEqual([]);
    expect(settled.state()).toBe('pending');
    controller.abort();
    await done;
    expect(clock.pending).toBe(0);
  });
});

describe('watchInbox runs on the ticker (task 2.1)', () => {
  it('src/board/watch.ts uses runTicker and keeps no timer or watcher of its own', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'watch.ts'),
      'utf8',
    );
    expect(source).toMatch(/\brunTicker\s*\(/);
    expect(source).not.toMatch(/\bsetInterval\s*\(|\bsetTimeout\s*\(/);
    expect(source).not.toMatch(/from\s+'node:fs'/);
  });
});
