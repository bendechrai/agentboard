/**
 * The foreground wait of `claim --wait --timeout` (add-claim-leases task
 * 4.1; board-cli: "Waiting on the command line"; design.md: "Waiting on
 * the CLI, never over MCP").
 *
 * In process, on one fake clock: `FakeClock` is both the `now` and the
 * `timers` of `waitForGrant` (so the watch machinery's poll and settle
 * timers and the wait's own due-grant and deadline timeouts all run on
 * it), and it moves vitest's fake `Date` with it, so every other actor's
 * write in a test (made through a second `Board` handle on the same
 * directory) and every default clock reading agree with it. The
 * directory watcher is `FakeWatch`: nothing reaches the wait except the
 * notifications a test sends, the polls and the timeouts. Nothing here
 * sleeps or depends on real time.
 *
 * Grant times are computed from the formulas of board-events "Grants"
 * (slot S = max(F, J) + 1, F = release wall or lapse expiresAt + 60000,
 * window 120000), not from the implementation.
 */

import { getEventListeners } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canonicalDecode } from '../../events/canonical.js';
import { validateEvent, type BoardEvent } from '../../events/schema.js';
import type { Board } from '../../store/board.js';
import { readTicket } from '../../store/cache.js';
import { BoardError } from '../../store/errors.js';
import { P, eventNames, ev, putEvent } from '../../store/__tests__/helpers.js';
import {
  claimTicket,
  handoffTicket,
  releaseTicket,
  renewTicket,
  unqueueTicket,
  type QueuedOutcome,
} from '../actions.js';
import { FS_SETTLE_MS, type TickerTimers, type WatchDir } from '../ticker.js';
import { waitForGrant, type WaitOptions, type WaitOutcome } from '../wait.js';
import { create, openTracked, setup } from './helpers.js';

/** The base clock of every test. */
const T0 = 1_700_000_000_000;
const SKEW = 60_000;
const GRACE = 120_000;
const WINDOW = 120_000;
const TTL = 1_800_000;
/** A poll interval long enough that no poll falls inside a test unless it says so. */
const NO_POLL = 86_400_000;
/** Node runs a timer whose delay is above this after 1 ms instead. */
const MAX_DELAY = 2_147_483_647;
/** Firings after which `FakeClock` declares a busy loop. */
const FIRING_LIMIT = 100_000;

interface Timer {
  id: number;
  callback: () => void;
  ms: number;
  due: number;
  repeat: boolean;
}

/**
 * A manual clock: `now` and `TickerTimers` for the wait, and vitest's fake
 * `Date` for everything else. Delays behave as in Node: one above
 * `MAX_DELAY`, below 1 or not finite runs after 1 ms.
 */
class FakeClock implements TickerTimers {
  t: number;
  /** Calls of `now` (the wait's clock readings). */
  reads = 0;
  /** Timer callbacks run. */
  fired = 0;
  /** True once `FIRING_LIMIT` firings ran within one advance. */
  runaway = false;
  private next = 1;
  private readonly timers = new Map<number, Timer>();

  constructor(t: number) {
    this.t = t;
    vi.setSystemTime(t);
  }

  readonly now = (): number => {
    this.reads += 1;
    return this.t;
  };

  setInterval(callback: () => void, ms: number): number {
    return this.add(callback, ms, true);
  }
  clearInterval(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  setTimeout(callback: () => void, ms: number): number {
    return this.add(callback, ms, false);
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Timers (intervals and timeouts) not cleared. */
  get pending(): number {
    return this.timers.size;
  }

  /** Sets the clock to `t` without running any timer (a suspended process). */
  jumpTo(t: number): void {
    this.t = Math.max(this.t, t);
    vi.setSystemTime(this.t);
  }

  /**
   * Runs every timer due at or before `end`, in due order, each at its due
   * time (or at the current time when that is later), then sets the clock
   * to `end`.
   */
  advanceTo(end: number): void {
    let count = 0;
    for (;;) {
      const timer = [...this.timers.values()]
        .filter((x) => x.due <= end)
        .sort((a, b) => a.due - b.due || a.id - b.id)[0];
      if (timer === undefined) {
        break;
      }
      count += 1;
      if (count > FIRING_LIMIT) {
        this.runaway = true;
        break;
      }
      this.jumpTo(timer.due);
      if (timer.repeat) {
        timer.due = this.t + timer.ms;
      } else {
        this.timers.delete(timer.id);
      }
      this.fired += 1;
      timer.callback();
    }
    this.jumpTo(end);
  }

  private add(callback: () => void, ms: number, repeat: boolean): number {
    const id = this.next;
    this.next += 1;
    const delay = Number.isFinite(ms) && ms >= 1 && ms <= MAX_DELAY ? Math.floor(ms) : 1;
    this.timers.set(id, { id, callback, ms: delay, due: this.t + delay, repeat });
    return id;
  }
}

/** A directory watcher that reports a change only when the test says so. */
class FakeWatch {
  started = 0;
  private readonly listeners = new Map<number, () => void>();
  private next = 1;

  readonly watchDir: WatchDir = (_dir, onChange) => {
    this.started += 1;
    const id = this.next;
    this.next += 1;
    this.listeners.set(id, onChange);
    return {
      close: () => {
        this.listeners.delete(id);
      },
    };
  };

  /** Watchers started and not closed. */
  get open(): number {
    return this.listeners.size;
  }

  /** Reports one change to every open watcher. */
  notify(): void {
    for (const listener of [...this.listeners.values()]) {
      listener();
    }
  }
}

interface Tracked {
  done: boolean;
  value: WaitOutcome | undefined;
  error: unknown;
}

let board: Board;
/** A second handle on the same board, for the other actors. */
let other: Board;
let clock: FakeClock;
let watch: FakeWatch;
let queued: QueuedOutcome[];
let controller: AbortController;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  clock = new FakeClock(T0);
  board = setup().board;
  other = openTracked(board.dir);
  watch = new FakeWatch();
  queued = [];
  controller = new AbortController();
});

afterEach(() => {
  controller.abort();
  vi.useRealTimers();
});

/** Lets promise callbacks run (real event loop turn; no timers involved). */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

/** Starts a wait by `merger-2` (or `actor`) on `id` and tracks its settlement. */
function start(
  id: string,
  timeout: number,
  extra: Partial<WaitOptions> & { actor?: string; ttl?: number } = {},
): Tracked {
  const { actor = 'merger-2', ttl = 600_000, ...rest } = extra;
  const tracked: Tracked = { done: false, value: undefined, error: undefined };
  waitForGrant(
    board,
    actor,
    { id, ttl, timeout },
    {
      signal: controller.signal,
      now: clock.now,
      monotonic: () => clock.t,
      timers: clock,
      watchDir: watch.watchDir,
      pollMs: NO_POLL,
      onQueued: (outcome) => {
        queued.push(outcome);
      },
      ...rest,
    },
  ).then(
    (value) => {
      tracked.done = true;
      tracked.value = value;
    },
    (error: unknown) => {
      tracked.done = true;
      tracked.error = error;
    },
  );
  return tracked;
}

/** Advances the fake clock to `t` and lets the wait react. */
async function at(t: number): Promise<void> {
  clock.advanceTo(t);
  await flush();
}

/** The settled value, failing when the wait is pending or rejected. */
function resolved(tracked: Tracked): WaitOutcome {
  expect(tracked.done).toBe(true);
  expect(tracked.error).toBeUndefined();
  if (tracked.value === undefined) {
    throw new Error('no value');
  }
  return tracked.value;
}

/** The rejection, which must be a BoardError with this exit code and reason. */
function rejected(tracked: Tracked, exitCode: number, reason: string): BoardError {
  expect(tracked.done).toBe(true);
  expect(tracked.error).toBeInstanceOf(BoardError);
  const err = tracked.error as BoardError;
  expect({ exitCode: err.exitCode, reason: err.reason }).toEqual({ exitCode, reason });
  return err;
}

/** Every well-formed event of the board, in wall order. */
function events(): BoardEvent[] {
  return eventNames(board.eventsDir)
    .map((name) => {
      const bytes = readFileSync(join(board.eventsDir, name));
      const result = validateEvent(canonicalDecode(new Uint8Array(bytes)));
      if (!result.ok || !result.known) {
        throw new Error(`not a well-formed known event: ${name}`);
      }
      return result.event;
    })
    .sort((a, b) => a.ts.wall - b.ts.wall || a.ts.counter - b.ts.counter);
}

/** The events of `kind`. */
function eventsOf(kind: string): BoardEvent[] {
  return events().filter((e) => e.kind === kind);
}

/** The event in the file named by `hash`. */
function eventOf(hash: string): BoardEvent {
  const bytes = readFileSync(join(board.eventsDir, `${hash}.json`));
  const result = validateEvent(canonicalDecode(new Uint8Array(bytes)));
  if (!result.ok || !result.known) {
    throw new Error(`not a well-formed known event: ${hash}`);
  }
  return result.event;
}

/** The ticket in the waiter's cache, which every end of a wait leaves caught up. */
function ticketNow(id: string): NonNullable<ReturnType<typeof readTicket>> {
  const ticket = readTicket(board.db, id);
  if (ticket === null) {
    throw new Error(`no ticket ${id}`);
  }
  return ticket;
}

/** The hashes of the grant files, in wall order. */
function grantHashes(): string[] {
  return eventNames(board.eventsDir)
    .map((name) => name.replace(/\.json$/, ''))
    .filter((hash) => eventOf(hash).kind === 'ticket.grant')
    .sort((a, b) => eventOf(a).ts.wall - eventOf(b).ts.wall);
}

/** A fresh mutex ticket created at the current clock. */
function lock(): string {
  return create(other, { title: 'Merge lock', adhoc: 'merge lock' }).id;
}

/** `merger-1` holds `id` with a plain claim (no lease) at the current clock. */
function held(id: string): void {
  claimTicket(other, 'merger-1', { id });
}

/** `merger-1` holds `id` under an unconfirmed 30m lease at the current clock. */
function leased(id: string): void {
  claimTicket(other, 'merger-1', { id, ttl: TTL });
}

describe('validation, before the board is read', () => {
  it.each([
    ['ttl below 30s', { ttl: 29_999, timeout: 30_000 }],
    ['ttl above 7d', { ttl: 604_800_001, timeout: 30_000 }],
    ['timeout below 1s', { ttl: TTL, timeout: 999 }],
    ['timeout above 1d', { ttl: TTL, timeout: 86_400_001 }],
    ['timeout not an integer', { ttl: TTL, timeout: 1500.5 }],
  ])('%s: exit 1 usage, nothing written', async (_name, input) => {
    const id = lock();
    held(id);
    const before = eventNames(board.eventsDir);
    const tracked = start(id, input.timeout, { ttl: input.ttl });
    await flush();
    rejected(tracked, 1, 'usage');
    expect(eventNames(board.eventsDir)).toEqual(before);
    expect(queued).toEqual([]);
    expect(clock.pending).toBe(0);
    expect(watch.started).toBe(0);
  });

  it('an empty actor: exit 1 missing-actor', async () => {
    const id = lock();
    held(id);
    const tracked = start(id, 30_000, { actor: '' });
    await flush();
    rejected(tracked, 1, 'missing-actor');
  });

  it('an unknown ticket: exit 4 unknown-ticket, no timer or watcher left', async () => {
    const tracked = start('01CAAAAAAAAAAAAAAAAAAAAAAA', 30_000);
    await flush();
    rejected(tracked, 4, 'unknown-ticket');
    expect(clock.pending).toBe(0);
    expect(watch.open).toBe(0);
  });
});

describe('claims at once when it can', () => {
  it('a free ticket with no waiters: the claim --ttl result, no join, no onQueued, nothing left running', async () => {
    const id = lock();
    clock.jumpTo(T0 + 5000);
    const tracked = start(id, 600_000, { ttl: TTL });
    await flush();
    const out = resolved(tracked);
    expect('grant' in out).toBe(false);
    if ('grant' in out) {
      return;
    }
    expect(out.queued).toBe(false);
    expect(out.hash).not.toBeNull();
    const claim = eventOf(String(out.hash));
    expect(claim).toMatchObject({ kind: 'ticket.claim', actor: 'merger-2', ticket: id });
    expect(claim.body).toEqual({
      lease: { ttl: TTL, grace: GRACE, expiresAt: T0 + 5000 + GRACE },
    });
    expect(eventsOf('ticket.queue.join')).toEqual([]);
    expect(queued).toEqual([]);
    expect(clock.pending).toBe(0);
    expect(watch.open).toBe(0);
  });

  it('the actor already holds the ticket: hash null, nothing written', async () => {
    const id = lock();
    claimTicket(other, 'merger-2', { id, ttl: TTL });
    const before = eventNames(board.eventsDir);
    const tracked = start(id, 600_000);
    await flush();
    const out = resolved(tracked);
    expect(out).toMatchObject({ hash: null, events: [], queued: false });
    expect(eventNames(board.eventsDir)).toEqual(before);
    expect(queued).toEqual([]);
    expect(clock.pending).toBe(0);
  });
});

describe('joins and prints the position', () => {
  it('a held ticket: writes one join with the ttl and reports position 1, then blocks', async () => {
    const id = lock();
    held(id);
    clock.jumpTo(T0 + 1000);
    const tracked = start(id, 600_000, { ttl: TTL });
    await flush();
    expect(tracked.done).toBe(false);
    expect(queued).toEqual([{ queued: true, position: 1, holder: 'merger-1', ticket: id }]);
    const joins = eventsOf('ticket.queue.join');
    expect(joins).toHaveLength(1);
    expect(joins[0]).toMatchObject({ actor: 'merger-2', body: { ttl: TTL } });
    expect(joins[0]?.ts.wall).toBe(T0 + 1000);
    expect(watch.open).toBe(1);
  });

  it('behind another waiter: position 2', async () => {
    const id = lock();
    held(id);
    claimTicket(other, 'merger-3', { id, ttl: TTL, wait: true });
    clock.jumpTo(T0 + 1000);
    const tracked = start(id, 600_000);
    await flush();
    expect(tracked.done).toBe(false);
    expect(queued).toEqual([{ queued: true, position: 2, holder: 'merger-1', ticket: id }]);
  });

  it('already queued: no second join, the current position', async () => {
    const id = lock();
    held(id);
    claimTicket(other, 'merger-2', { id, ttl: TTL, wait: true });
    const before = eventNames(board.eventsDir);
    clock.jumpTo(T0 + 1000);
    const tracked = start(id, 600_000);
    await flush();
    expect(tracked.done).toBe(false);
    expect(eventNames(board.eventsDir)).toEqual(before);
    expect(queued).toEqual([{ queued: true, position: 1, holder: 'merger-1', ticket: id }]);
  });

  it('the join catches up first: a grant due to an earlier waiter is written, and the grantee is the holder', async () => {
    const id = lock();
    held(id);
    claimTicket(other, 'merger-3', { id, ttl: TTL, wait: true });
    clock.jumpTo(T0 + 1000);
    // The release makes the grant to merger-3 due at T0 + 1001.
    releaseTicket(other, 'merger-1', { id });
    clock.jumpTo(T0 + 2000);
    const tracked = start(id, 600_000);
    await flush();
    expect(tracked.done).toBe(false);
    expect(eventsOf('ticket.grant')).toHaveLength(1);
    expect(queued).toEqual([{ queued: true, position: 1, holder: 'merger-3', ticket: id }]);
  });
});

describe('scenario: waiter is granted on release (wake on an event)', () => {
  it('a change notification wakes it; it writes the grant and resolves with it', async () => {
    const id = lock();
    held(id);
    clock.jumpTo(T0 + 1000);
    const tracked = start(id, 600_000, { ttl: TTL });
    await flush();
    clock.jumpTo(T0 + 5000);
    releaseTicket(other, 'merger-1', { id });
    await flush();
    // No notification yet, no poll and nothing due on a timer: still waiting.
    expect(tracked.done).toBe(false);
    watch.notify();
    await at(T0 + 5000 + FS_SETTLE_MS);
    const out = resolved(tracked);
    expect('grant' in out).toBe(true);
    if (!('grant' in out)) {
      return;
    }
    expect(Object.keys(out)).toEqual(['queued', 'grant', 'acceptBy', 'ticket']);
    const grants = eventsOf('ticket.grant');
    expect(grants).toHaveLength(1);
    const g = eventOf(out.grant);
    expect(g).toMatchObject({
      kind: 'ticket.grant',
      actor: 'agentboard',
      ticket: id,
      body: { to: 'merger-2', ttl: TTL, window: WINDOW },
    });
    // S = max(release wall, join wall) + 1.
    expect(g.ts.wall).toBe(T0 + 5001);
    expect(out.queued).toBe(false);
    expect(out.acceptBy).toBe(T0 + 5001 + WINDOW);
    expect(out.ticket.assignee).toBe('merger-2');
    expect(out.ticket.queue).toEqual([]);
    expect(out.ticket.lease).toEqual({
      ttl: TTL,
      expiresAt: T0 + 5001 + WINDOW,
      event: out.grant,
      confirmed: false,
    });
    expect(clock.pending).toBe(0);
    expect(watch.open).toBe(0);
  });

  it('without a notification, the next poll wakes it', async () => {
    const id = lock();
    held(id);
    clock.jumpTo(T0 + 1000);
    const tracked = start(id, 600_000, { pollMs: 60_000 });
    await flush();
    clock.jumpTo(T0 + 5000);
    releaseTicket(other, 'merger-1', { id });
    await at(T0 + 1000 + 59_999);
    expect(tracked.done).toBe(false);
    await at(T0 + 1000 + 60_000);
    const out = resolved(tracked);
    expect(out).toMatchObject({ queued: false, acceptBy: T0 + 5001 + WINDOW });
  });

  it('the grant already written by another command is observed, not written twice', async () => {
    const id = lock();
    held(id);
    clock.jumpTo(T0 + 1000);
    const tracked = start(id, 600_000);
    await flush();
    clock.jumpTo(T0 + 5000);
    releaseTicket(other, 'merger-1', { id });
    clock.jumpTo(T0 + 6000);
    // Any command on another handle catches up and writes the due grant.
    claimTicket(other, 'merger-3', { id, ttl: TTL, wait: true });
    const written = grantHashes();
    expect(written).toHaveLength(1);
    watch.notify();
    await at(T0 + 6000 + FS_SETTLE_MS);
    const out = resolved(tracked);
    expect(out).toMatchObject({ queued: false, grant: written[0], acceptBy: T0 + 5001 + WINDOW });
    expect(grantHashes()).toEqual(written);
  });
});

describe('wakes at the next due grant time with no new event', () => {
  it('a grace lease that lapses: granted at exactly S, not one millisecond before', async () => {
    const id = lock();
    leased(id);
    clock.jumpTo(T0 + 1000);
    const tracked = start(id, 3_600_000, { ttl: TTL });
    await flush();
    const slot = T0 + GRACE + SKEW + 1;
    await at(slot - 1);
    expect(tracked.done).toBe(false);
    expect(eventsOf('ticket.grant')).toEqual([]);
    await at(slot);
    const out = resolved(tracked);
    expect('grant' in out).toBe(true);
    if (!('grant' in out)) {
      return;
    }
    const g = eventOf(out.grant);
    expect(g.ts.wall).toBe(slot);
    expect(g.body).toMatchObject({
      to: 'merger-2',
      after: { lease: { holder: 'merger-1', expiresAt: T0 + GRACE } },
    });
    expect(out.acceptBy).toBe(slot + WINDOW);
    expect(watch.started).toBe(1);
  });

  it('two due times in turn: the grant to the waiter ahead, then, when it lapses, the grant to this one', async () => {
    const id = lock();
    leased(id);
    clock.jumpTo(T0 + 1000);
    claimTicket(other, 'a', { id, ttl: 600_000, wait: true });
    clock.jumpTo(T0 + 2000);
    const tracked = start(id, 3_600_000, { ttl: TTL });
    await flush();
    expect(queued[0]?.position).toBe(2);
    const s1 = T0 + GRACE + SKEW + 1;
    const s2 = s1 + WINDOW + SKEW + 1;
    await at(s1 - 1);
    expect(eventsOf('ticket.grant')).toEqual([]);
    await at(s1);
    expect(tracked.done).toBe(false);
    const first = eventsOf('ticket.grant');
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ body: { to: 'a' } });
    expect(first[0]?.ts.wall).toBe(s1);
    await at(s2 - 1);
    expect(tracked.done).toBe(false);
    await at(s2);
    const out = resolved(tracked);
    expect(out).toMatchObject({ queued: false, acceptBy: s2 + WINDOW });
    expect(eventsOf('ticket.grant').map((g) => g.ts.wall)).toEqual([s1, s2]);
    // Two due-time wakes and nothing else: no poll, no notification.
    expect(clock.fired).toBeLessThanOrEqual(2);
  });

  it('a renew by the holder before the lapse moves the due time: no grant at the old one', async () => {
    const id = lock();
    leased(id);
    clock.jumpTo(T0 + 1000);
    const tracked = start(id, 3_600_000);
    await flush();
    clock.jumpTo(T0 + 60_000);
    renewTicket(other, 'merger-1', { id, ttl: 600_000 });
    watch.notify();
    await at(T0 + 60_000 + FS_SETTLE_MS);
    await at(T0 + GRACE + SKEW + 1);
    expect(tracked.done).toBe(false);
    expect(eventsOf('ticket.grant')).toEqual([]);
    const slot = T0 + 60_000 + 600_000 + SKEW + 1;
    await at(slot - 1);
    expect(tracked.done).toBe(false);
    await at(slot);
    expect(resolved(tracked)).toMatchObject({ queued: false, acceptBy: slot + WINDOW });
  });
});

describe('scenario: wait times out (exactly at the boundary)', () => {
  it('still waiting at deadline - 1 with nothing written; at the deadline it leaves and rejects wait-timeout', async () => {
    const id = lock();
    held(id);
    clock.jumpTo(T0 + 500);
    const tracked = start(id, 30_000);
    await flush();
    const before = eventNames(board.eventsDir);
    await at(T0 + 500 + 29_999);
    expect(tracked.done).toBe(false);
    expect(eventNames(board.eventsDir)).toEqual(before);
    await at(T0 + 500 + 30_000);
    const err = rejected(tracked, 4, 'wait-timeout');
    expect(err.message).toContain(id);
    const leaves = eventsOf('ticket.queue.leave');
    expect(leaves).toHaveLength(1);
    expect(leaves[0]).toMatchObject({ actor: 'merger-2', ticket: id, body: {} });
    expect(leaves[0]?.ts.wall).toBe(T0 + 500 + 30_000);
    expect(ticketNow(id).queue).toEqual([]);
    expect(ticketNow(id).assignee).toBe('merger-1');
    expect(clock.pending).toBe(0);
    expect(watch.open).toBe(0);
  });

  it('a grant due exactly at the deadline wins: granted, no leave', async () => {
    const id = lock();
    leased(id);
    const slot = T0 + GRACE + SKEW + 1;
    clock.jumpTo(slot - 30_000);
    const tracked = start(id, 30_000);
    await flush();
    await at(slot - 1);
    expect(tracked.done).toBe(false);
    await at(slot);
    expect(resolved(tracked)).toMatchObject({ queued: false, acceptBy: slot + WINDOW });
    expect(eventsOf('ticket.queue.leave')).toEqual([]);
  });

  it('the deadline is measured from the start of the wait, not from the join', async () => {
    const id = lock();
    held(id);
    clock.jumpTo(T0 + 10_000);
    const tracked = start(id, 1000);
    await flush();
    await at(T0 + 10_999);
    expect(tracked.done).toBe(false);
    await at(T0 + 11_000);
    rejected(tracked, 4, 'wait-timeout');
  });
});

describe('interrupted (SIGINT or SIGTERM)', () => {
  it('leaves the queue and rejects wait-interrupted, never resolving', async () => {
    const id = lock();
    held(id);
    clock.jumpTo(T0 + 1000);
    const tracked = start(id, 600_000);
    await flush();
    clock.jumpTo(T0 + 7000);
    controller.abort();
    await flush();
    const err = rejected(tracked, 4, 'wait-interrupted');
    expect(err.message).toContain(id);
    const leaves = eventsOf('ticket.queue.leave');
    expect(leaves).toHaveLength(1);
    expect(leaves[0]).toMatchObject({ actor: 'merger-2', ticket: id });
    expect(leaves[0]?.ts.wall).toBe(T0 + 7000);
    expect(ticketNow(id).queue).toEqual([]);
    expect(clock.pending).toBe(0);
    expect(watch.open).toBe(0);
  });

  it('an already aborted signal: the join is left again at once', async () => {
    const id = lock();
    held(id);
    controller.abort();
    const tracked = start(id, 600_000);
    await flush();
    rejected(tracked, 4, 'wait-interrupted');
    expect(eventsOf('ticket.queue.join')).toHaveLength(1);
    expect(eventsOf('ticket.queue.leave')).toHaveLength(1);
    expect(ticketNow(id).queue).toEqual([]);
    expect(clock.pending).toBe(0);
    expect(watch.open).toBe(0);
  });

  it('a grant already due when the signal arrives is reported (the actor holds the ticket), no leave', async () => {
    const id = lock();
    held(id);
    clock.jumpTo(T0 + 1000);
    const tracked = start(id, 600_000);
    await flush();
    clock.jumpTo(T0 + 5000);
    releaseTicket(other, 'merger-1', { id });
    clock.jumpTo(T0 + 6000);
    controller.abort();
    await flush();
    expect(resolved(tracked)).toMatchObject({ queued: false, acceptBy: T0 + 5001 + WINDOW });
    expect(eventsOf('ticket.queue.leave')).toEqual([]);
  });
});

describe('the actor stops being a waiter', () => {
  it('scenario: join rejected because the ticket became free (a late release with an earlier wall): claims instead', async () => {
    const id = lock();
    held(id);
    clock.jumpTo(T0 + 2000);
    const tracked = start(id, 600_000, { ttl: TTL });
    await flush();
    expect(queued).toHaveLength(1);
    // A release by merger-1 written elsewhere at T0 + 1000 arrives now.
    putEvent(
      board.eventsDir,
      ev({ kind: 'ticket.release', ticket: id, body: {} }, 'merger-1', T0 + 1000),
    );
    clock.jumpTo(T0 + 3000);
    watch.notify();
    await at(T0 + 3000 + FS_SETTLE_MS);
    const out = resolved(tracked);
    expect('grant' in out).toBe(false);
    if ('grant' in out) {
      return;
    }
    expect(out.queued).toBe(false);
    expect(out.hash).not.toBeNull();
    const claim = eventOf(String(out.hash));
    expect(claim).toMatchObject({ kind: 'ticket.claim', actor: 'merger-2', ticket: id });
    expect(claim.body).toMatchObject({ lease: { ttl: TTL, grace: GRACE } });
    expect(out.ticket.assignee).toBe('merger-2');
    expect(out.ticket.queue).toEqual([]);
    expect(eventsOf('ticket.grant')).toEqual([]);
    expect(clock.pending).toBe(0);
    expect(watch.open).toBe(0);
  });

  it('a hand-off to the waiter: resolves as a retried claim (hash null), writing nothing', async () => {
    const id = lock();
    held(id);
    clock.jumpTo(T0 + 1000);
    const tracked = start(id, 600_000);
    await flush();
    clock.jumpTo(T0 + 2000);
    handoffTicket(other, 'merger-1', { id, to: 'merger-2', status: 'todo', note: 'yours' });
    const before = eventNames(board.eventsDir);
    watch.notify();
    await at(T0 + 2000 + FS_SETTLE_MS);
    const out = resolved(tracked);
    expect(out).toMatchObject({ hash: null, events: [], queued: false });
    expect(out.ticket.assignee).toBe('merger-2');
    expect(eventNames(board.eventsDir)).toEqual(before);
  });

  it('scenario: waiter no longer queued (unqueue elsewhere): rejects invalid-queue, writing nothing', async () => {
    const id = lock();
    held(id);
    clock.jumpTo(T0 + 1000);
    const tracked = start(id, 600_000);
    await flush();
    clock.jumpTo(T0 + 2000);
    unqueueTicket(other, 'merger-2', { id });
    const before = eventNames(board.eventsDir);
    watch.notify();
    await at(T0 + 2000 + FS_SETTLE_MS);
    rejected(tracked, 4, 'invalid-queue');
    expect(eventNames(board.eventsDir)).toEqual(before);
    expect(clock.pending).toBe(0);
    expect(watch.open).toBe(0);
  });

  it('its grant lapsed and passed on while it was suspended: rejects invalid-queue', async () => {
    const id = lock();
    held(id);
    clock.jumpTo(T0 + 1000);
    const tracked = start(id, 3_600_000);
    await flush();
    clock.jumpTo(T0 + 2000);
    claimTicket(other, 'merger-3', { id, ttl: TTL, wait: true });
    clock.jumpTo(T0 + 3000);
    releaseTicket(other, 'merger-1', { id });
    const s1 = T0 + 3001;
    const s2 = s1 + WINDOW + SKEW + 1;
    // The process was suspended past both grants.
    clock.jumpTo(s2 + 5000);
    watch.notify();
    await at(s2 + 5000 + FS_SETTLE_MS);
    rejected(tracked, 4, 'invalid-queue');
    expect(eventsOf('ticket.grant').map((g) => [g.body, g.ts.wall])).toEqual([
      [expect.objectContaining({ to: 'merger-2' }), s1],
      [expect.objectContaining({ to: 'merger-3' }), s2],
    ]);
    expect(eventsOf('ticket.queue.leave')).toEqual([]);
  });
});

describe('no busy loop', () => {
  it('an idle wait: wakes only at its polls and the deadline, with a bounded number of clock readings', async () => {
    const id = lock();
    held(id);
    clock.jumpTo(T0 + 1000);
    const tracked = start(id, 600_000, { pollMs: 60_000 });
    await flush();
    const readsAtStart = clock.reads;
    expect(readsAtStart).toBeLessThanOrEqual(5);
    await at(T0 + 1000 + 600_000);
    rejected(tracked, 4, 'wait-timeout');
    expect(clock.runaway).toBe(false);
    // Ten polls (the last at the deadline) and the deadline timeout.
    expect(clock.fired).toBeLessThanOrEqual(11);
    expect(clock.reads - readsAtStart).toBeLessThanOrEqual(5 * (clock.fired + 1));
    expect(clock.pending).toBe(0);
  });

  it('notifications: one catch-up per settled notification, and a burst within the settle delay is one', async () => {
    const id = lock();
    held(id);
    clock.jumpTo(T0 + 1000);
    const tracked = start(id, 600_000);
    await flush();
    const readsAtStart = clock.reads;
    for (let i = 0; i < 20; i += 1) {
      clock.jumpTo(T0 + 2000 + i * 1000);
      claimTicket(other, `w-${String(i)}`, { id, ttl: TTL, wait: true });
      watch.notify();
      watch.notify();
      watch.notify();
      await at(T0 + 2000 + i * 1000 + FS_SETTLE_MS);
    }
    expect(tracked.done).toBe(false);
    expect(clock.fired).toBeLessThanOrEqual(20);
    expect(clock.reads - readsAtStart).toBeLessThanOrEqual(5 * 20);
  });

  it('a grant watermark beyond the largest timer delay is clamped to the deadline (no 1 ms re-arming)', async () => {
    const id = lock();
    // A claim written on a machine whose clock is 30 days ahead: its
    // grace lapses, and the grant to a waiter is due, about 30 days on.
    const far = T0 + 30 * 86_400_000;
    putEvent(
      board.eventsDir,
      ev(
        {
          kind: 'ticket.claim',
          ticket: id,
          body: { lease: { ttl: TTL, grace: GRACE, expiresAt: far + GRACE } },
        },
        'merger-1',
        far,
      ),
    );
    clock.jumpTo(T0 + 1000);
    const tracked = start(id, 86_400_000, { pollMs: 3_600_000 });
    await flush();
    expect(queued).toHaveLength(1);
    await at(T0 + 1000 + 86_400_000);
    rejected(tracked, 4, 'wait-timeout');
    expect(clock.runaway).toBe(false);
    // 24 hourly polls, the deadline, and at most one re-armed watermark timer per wake.
    expect(clock.fired).toBeLessThanOrEqual(50);
    expect(clock.pending).toBe(0);
  });

  it('a far but representable watermark (a confirmed 7d lease) does not fire before the deadline', async () => {
    const id = lock();
    claimTicket(other, 'merger-1', { id, ttl: 604_800_000 });
    renewTicket(other, 'merger-1', { id });
    clock.jumpTo(T0 + 1000);
    const tracked = start(id, 86_400_000, { pollMs: NO_POLL });
    await flush();
    await at(T0 + 1000 + 86_400_000 - 1);
    expect(tracked.done).toBe(false);
    expect(clock.fired).toBe(0);
    await at(T0 + 1000 + 86_400_000);
    rejected(tracked, 4, 'wait-timeout');
    expect(clock.fired).toBeLessThanOrEqual(2);
    expect(clock.pending).toBe(0);
    expect(eventsOf('ticket.grant')).toEqual([]);
  });
});

/*
 * Review round 1 (orchestrator ruling on reviewer-4-2's findings): the
 * transaction that ends a wait decides after its own catch-up, the
 * deadline is monotonic, a busy end is retried once, and the cleanup and
 * error paths are pinned. Races are injected through
 * `WaitOptions.beforeStep`, which runs immediately before the step it
 * names, so what it writes is exactly what that step's catch-up finds.
 */

/** The `beforeStep` seam running `inject` once, at the first `step`; records every step. */
function seam(
  on: 'wake' | 'claim' | 'end',
  inject: () => void,
): { steps: string[]; beforeStep: (step: 'wake' | 'claim' | 'end') => void } {
  const steps: string[] = [];
  let done = false;
  return {
    steps,
    beforeStep: (step) => {
      steps.push(step);
      if (step === on && !done) {
        done = true;
        inject();
      }
    },
  };
}

/** An event written by another process at `wall`, as a late file. */
function late(proposed: Parameters<typeof ev>[0], actor: string, wall: number): string {
  return putEvent(board.eventsDir, ev(proposed, actor, wall));
}

const RELEASED = (id: string): string =>
  `the wait for ticket ${id} was interrupted after the ticket was given to you; you released it, so it passes to the next waiter`;

describe('review round 1: the ending transaction decides after its own catch-up', () => {
  it('a grant whose slot passes between the deadline wake and the leave: exit 0 granted, no leave', async () => {
    const id = lock();
    leased(id);
    const slot = T0 + GRACE + SKEW + 1;
    clock.jumpTo(T0 + 1000);
    const hook = seam('end', () => {
      clock.jumpTo(slot);
    });
    const tracked = start(id, slot - 1 - (T0 + 1000), { beforeStep: hook.beforeStep });
    await flush();
    await at(slot - 1);
    expect(hook.steps).toContain('end');
    const out = resolved(tracked);
    expect(out).toMatchObject({ queued: false, acceptBy: slot + WINDOW });
    expect(eventsOf('ticket.queue.leave')).toEqual([]);
    expect(eventsOf('ticket.grant').map((g) => g.ts.wall)).toEqual([slot]);
    expect(ticketNow(id).assignee).toBe('merger-2');
  });

  it('a release by another process landing before the leave at the deadline: exit 0 granted', async () => {
    const id = lock();
    held(id);
    clock.jumpTo(T0 + 1000);
    const deadline = T0 + 31_000;
    const hook = seam('end', () => {
      late({ kind: 'ticket.release', ticket: id, body: {} }, 'merger-1', deadline - 5);
    });
    const tracked = start(id, 30_000, { beforeStep: hook.beforeStep });
    await flush();
    await at(deadline);
    expect(hook.steps).toContain('end');
    expect(resolved(tracked)).toMatchObject({
      queued: false,
      acceptBy: deadline - 5 + 1 + WINDOW,
    });
    expect(eventsOf('ticket.queue.leave')).toEqual([]);
    expect(ticketNow(id).assignee).toBe('merger-2');
  });

  it('scenario: hand-off racing the deadline: exit 0 as a retried claim, nothing written', async () => {
    const id = lock();
    held(id);
    clock.jumpTo(T0 + 1000);
    const deadline = T0 + 31_000;
    const hook = seam('end', () => {
      late(P.handoff(id, 'merger-2', 'todo', 'yours'), 'merger-1', deadline - 5);
    });
    const tracked = start(id, 30_000, { beforeStep: hook.beforeStep });
    await flush();
    const before = eventNames(board.eventsDir).length + 1;
    await at(deadline);
    expect(hook.steps).toContain('end');
    expect(resolved(tracked)).toMatchObject({ hash: null, events: [], queued: false });
    expect(eventNames(board.eventsDir)).toHaveLength(before);
    expect(ticketNow(id).assignee).toBe('merger-2');
  });

  it('scenario: grant racing SIGINT: releases it to the next waiter and exits 4 wait-interrupted saying so', async () => {
    const id = lock();
    held(id);
    clock.jumpTo(T0 + 1000);
    const hook = seam('end', () => {
      late({ kind: 'ticket.release', ticket: id, body: {} }, 'merger-1', clock.t - 5);
    });
    const tracked = start(id, 600_000, { beforeStep: hook.beforeStep });
    await flush();
    clock.jumpTo(T0 + 1500);
    claimTicket(other, 'merger-3', { id, ttl: TTL, wait: true });
    clock.jumpTo(T0 + 5000);
    controller.abort();
    await flush();
    expect(hook.steps).toContain('end');
    const err = rejected(tracked, 4, 'wait-interrupted');
    expect(err.message).toBe(RELEASED(id));
    const releases = eventsOf('ticket.release').filter((e) => e.actor === 'merger-2');
    expect(releases).toHaveLength(1);
    expect(eventsOf('ticket.queue.leave')).toEqual([]);
    // The next command grants the ticket to the next waiter.
    clock.jumpTo(T0 + 6000);
    claimTicket(other, 'merger-4', { id, ttl: TTL, wait: true });
    const grants = eventsOf('ticket.grant');
    expect(grants.map((g) => (g.body as { to: string }).to)).toEqual(['merger-2', 'merger-3']);
    expect(readTicket(other.db, id)?.assignee).toBe('merger-3');
  });

  it('scenario: hand-off racing SIGTERM: releases it and exits 4 wait-interrupted saying so', async () => {
    const id = lock();
    held(id);
    clock.jumpTo(T0 + 1000);
    const hook = seam('end', () => {
      late(P.handoff(id, 'merger-2', 'todo', 'yours'), 'merger-1', clock.t - 5);
    });
    const tracked = start(id, 600_000, { beforeStep: hook.beforeStep });
    await flush();
    clock.jumpTo(T0 + 5000);
    controller.abort();
    await flush();
    const err = rejected(tracked, 4, 'wait-interrupted');
    expect(err.message).toBe(RELEASED(id));
    expect(eventsOf('ticket.release').filter((e) => e.actor === 'merger-2')).toHaveLength(1);
    expect(ticketNow(id).assignee).toBeNull();
  });

  it('scenario: unqueue racing the deadline: exit 4 wait-timeout, nothing more written (already correct at 090db5f)', async () => {
    const id = lock();
    held(id);
    clock.jumpTo(T0 + 1000);
    const deadline = T0 + 31_000;
    const hook = seam('end', () => {
      late({ kind: 'ticket.queue.leave', ticket: id, body: {} }, 'merger-2', deadline - 1);
    });
    const tracked = start(id, 30_000, { beforeStep: hook.beforeStep });
    await flush();
    await at(deadline);
    expect(hook.steps).toContain('end');
    rejected(tracked, 4, 'wait-timeout');
    expect(eventsOf('ticket.queue.leave')).toHaveLength(1);
    expect(eventsOf('ticket.release')).toEqual([]);
    expect(ticketNow(id)).toMatchObject({ assignee: 'merger-1', queue: [] });
  });
});

describe('review round 1: the deadline is monotonic', () => {
  it('a wall clock stepped back an hour does not delay it', async () => {
    const id = lock();
    held(id);
    clock.jumpTo(T0 + 1000);
    let back = 0;
    const tracked = start(id, 30_000, { now: () => clock.now() - back });
    await flush();
    back = 3_600_000;
    await at(T0 + 31_000 - 1);
    expect(tracked.done).toBe(false);
    await at(T0 + 31_000);
    rejected(tracked, 4, 'wait-timeout');
    expect(ticketNow(id).queue).toEqual([]);
    expect(clock.pending).toBe(0);
  });

  it('a wall clock stepped forward an hour does not advance it', async () => {
    const id = lock();
    held(id);
    clock.jumpTo(T0 + 1000);
    let ahead = 0;
    const tracked = start(id, 30_000, { now: () => clock.now() + ahead });
    await flush();
    ahead = 3_600_000;
    watch.notify();
    await at(T0 + 2000);
    expect(tracked.done).toBe(false);
    expect(eventsOf('ticket.queue.leave')).toEqual([]);
    await at(T0 + 31_000 - 1);
    expect(tracked.done).toBe(false);
    await at(T0 + 31_000);
    rejected(tracked, 4, 'wait-timeout');
  });
});

describe('review round 1: a busy ending transaction', () => {
  const busy = (): BoardError =>
    new BoardError(5, 'busy', 'the board cache stayed locked by another process; try again');

  it('busy once: retried, the leave is written and the wait times out as usual', async () => {
    const id = lock();
    held(id);
    let fails = 1;
    const steps: string[] = [];
    const tracked = start(id, 5000, {
      beforeStep: (step) => {
        steps.push(step);
        if (step === 'end' && fails > 0) {
          fails -= 1;
          throw busy();
        }
      },
    });
    await flush();
    await at(T0 + 5000);
    expect(steps.filter((x) => x === 'end')).toHaveLength(2);
    rejected(tracked, 4, 'wait-timeout');
    expect(eventsOf('ticket.queue.leave')).toHaveLength(1);
  });

  it('busy twice: exit 5 busy naming unqueue, still queued, no third attempt', async () => {
    const id = lock();
    held(id);
    const steps: string[] = [];
    const tracked = start(id, 5000, {
      beforeStep: (step) => {
        steps.push(step);
        if (step === 'end') {
          throw busy();
        }
      },
    });
    await flush();
    await at(T0 + 5000);
    const err = rejected(tracked, 5, 'busy');
    expect(err.message).toContain(`agentboard unqueue ${id} --as merger-2`);
    expect(steps.filter((x) => x === 'end')).toHaveLength(2);
    expect(eventsOf('ticket.queue.leave')).toEqual([]);
    expect(ticketNow(id).queue.map((w) => w.actor)).toEqual(['merger-2']);
    expect(clock.pending).toBe(0);
    expect(watch.open).toBe(0);
  });
});

describe('review round 1: the other paths of a wake (already correct at 090db5f)', () => {
  it('a busy catch-up is a warning and the wait carries on to its grant', async () => {
    const id = lock();
    held(id);
    clock.jumpTo(T0 + 1000);
    const warnings: string[] = [];
    let wakes = 0;
    const tracked = start(id, 600_000, {
      onWarning: (line) => {
        warnings.push(line);
      },
      beforeStep: (step) => {
        if (step === 'wake') {
          wakes += 1;
          if (wakes === 2) {
            throw new BoardError(
              5,
              'busy',
              'the board cache stayed locked by another process; try again',
            );
          }
        }
      },
    });
    await flush();
    watch.notify();
    await at(T0 + 1000 + FS_SETTLE_MS);
    expect(warnings).toEqual(['the board cache stayed locked by another process; try again']);
    expect(tracked.done).toBe(false);
    clock.jumpTo(T0 + 5000);
    releaseTicket(other, 'merger-1', { id });
    watch.notify();
    await at(T0 + 5000 + FS_SETTLE_MS);
    expect(resolved(tracked)).toMatchObject({ queued: false, acceptBy: T0 + 5001 + WINDOW });
  });

  it('any other error of a wake ends the wait with it, leaving nothing behind', async () => {
    const id = lock();
    held(id);
    const boom = new Error('boom');
    let wakes = 0;
    const tracked = start(id, 600_000, {
      beforeStep: (step) => {
        if (step === 'wake') {
          wakes += 1;
          if (wakes === 2) {
            throw boom;
          }
        }
      },
    });
    await flush();
    watch.notify();
    await at(T0 + FS_SETTLE_MS);
    expect(tracked.done).toBe(true);
    expect(tracked.error).toBe(boom);
    expect(clock.pending).toBe(0);
    expect(watch.open).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('a ticket that vanishes from the cache mid-wait: exit 4 unknown-ticket', async () => {
    const id = lock();
    held(id);
    const tracked = start(id, 600_000);
    await flush();
    for (const table of ['waiters', 'comments', 'links']) {
      other.db.prepare(`DELETE FROM ${table} WHERE ticket = ?`).run(id);
    }
    other.db.prepare('DELETE FROM tickets WHERE id = ?').run(id);
    watch.notify();
    await at(T0 + FS_SETTLE_MS);
    rejected(tracked, 4, 'unknown-ticket');
    expect(clock.pending).toBe(0);
    expect(watch.open).toBe(0);
  });

  it('claim instead, but the ticket was taken meanwhile: queued again, the wait goes on to a grant', async () => {
    const id = lock();
    held(id);
    clock.jumpTo(T0 + 2000);
    const hook = seam('claim', () => {
      late(P.claim(id), 'merger-3', clock.t - 1);
    });
    const tracked = start(id, 600_000, { ttl: TTL, beforeStep: hook.beforeStep });
    await flush();
    late({ kind: 'ticket.release', ticket: id, body: {} }, 'merger-1', T0 + 1000);
    clock.jumpTo(T0 + 3000);
    watch.notify();
    await at(T0 + 3000 + FS_SETTLE_MS);
    expect(hook.steps).toContain('claim');
    expect(tracked.done).toBe(false);
    expect(queued).toHaveLength(1);
    expect(eventsOf('ticket.queue.join').filter((e) => e.actor === 'merger-2')).toHaveLength(2);
    expect(ticketNow(id)).toMatchObject({ assignee: 'merger-3' });
    expect(ticketNow(id).queue.map((w) => w.actor)).toEqual(['merger-2']);
    clock.jumpTo(T0 + 4000);
    releaseTicket(other, 'merger-3', { id });
    watch.notify();
    await at(T0 + 4000 + FS_SETTLE_MS);
    expect(resolved(tracked)).toMatchObject({ queued: false, acceptBy: T0 + 4001 + WINDOW });
  });

  it.each([
    ['granted', 'grant'],
    ['timed out', 'timeout'],
    ['claimed at once', 'free'],
  ])('the abort listener is removed when the wait ends %s', async (_name, how) => {
    const id = lock();
    if (how !== 'free') {
      held(id);
    }
    clock.jumpTo(T0 + 1000);
    const tracked = start(id, 30_000);
    await flush();
    if (how === 'grant') {
      clock.jumpTo(T0 + 2000);
      releaseTicket(other, 'merger-1', { id });
      watch.notify();
      await at(T0 + 2000 + FS_SETTLE_MS);
    } else if (how === 'timeout') {
      await at(T0 + 31_000);
    }
    expect(tracked.done).toBe(true);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});

describe('review round 1 addendum (reviewer-4-1; already correct at 090db5f)', () => {
  it('a wait granted on a notification while a due-grant timer is pending leaves no timer and no abort listener', async () => {
    const id = lock();
    leased(id);
    clock.jumpTo(T0 + 1000);
    const tracked = start(id, 3_600_000);
    await flush();
    // The grace lapse of merger-1's lease is due at T0 + 180001: a timer is armed for it.
    expect(clock.pending).toBeGreaterThan(0);
    clock.jumpTo(T0 + 5000);
    releaseTicket(other, 'merger-1', { id });
    watch.notify();
    await at(T0 + 5000 + FS_SETTLE_MS);
    expect(resolved(tracked)).toMatchObject({ queued: false, acceptBy: T0 + 5001 + WINDOW });
    expect(clock.pending).toBe(0);
    expect(watch.open).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    // Nothing fires later either.
    await at(T0 + 3_600_000);
    expect(clock.fired).toBeLessThanOrEqual(1);
  });

  it('no leave is written at the deadline when the actor is no longer queued', async () => {
    const id = lock();
    held(id);
    clock.jumpTo(T0 + 1000);
    const tracked = start(id, 30_000);
    await flush();
    clock.jumpTo(T0 + 2000);
    // Left elsewhere, with no notification reaching the wait.
    unqueueTicket(other, 'merger-2', { id });
    expect(eventsOf('ticket.queue.leave')).toHaveLength(1);
    await at(T0 + 31_000);
    expect(tracked.done).toBe(true);
    expect(tracked.error).toBeInstanceOf(BoardError);
    expect((tracked.error as BoardError).exitCode).toBe(4);
    expect(eventsOf('ticket.queue.leave')).toHaveLength(1);
    expect(eventsOf('ticket.release')).toEqual([]);
  });
});
