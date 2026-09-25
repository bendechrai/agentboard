/**
 * What only a running server knows about health, as units (board-insights:
 * "Health in the web app"; add-board-insights task 3.1): the observed log
 * of late and removed events (at most 100, newest first, with observation
 * times, kind and ticket kept for removed hashes), the cache check summary,
 * and the single-flight cache checker reusing a result for 30 seconds,
 * with an injected clock and a comparison the test completes by hand.
 */

import { describe, expect, it } from 'vitest';

import type { CacheDifference } from '../../store/rebuild.js';
import { BoardError } from '../../store/errors.js';
import type { HealthCheck } from '../../view/health.js';
import type { AppendMessage, EventView, ResyncMessage } from '../../view/types.js';
import {
  CHECK_REUSE_MS,
  LATE_LIMIT,
  checkSummary,
  createCacheChecker,
  createObservedLog,
  type CacheCheckOutcome,
} from '../health.js';

const T1 = '01ARYZ6S41TSV4RRFFQ69G5FAV';
const T2 = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

/** A 64-hex hash made from `n`. */
function hash(n: number): string {
  return n.toString(16).padStart(64, '0');
}

/** An applied comment view with hash `hash(n)` on `ticket`. */
function view(n: number, ticket: string | null = T1, kind = 'ticket.comment'): EventView {
  const ts = { wall: 1000 + n, counter: 0, actor: 'impl-1' };
  const event =
    ticket === null
      ? {
          v: 1 as const,
          kind: 'board.meta' as const,
          actor: 'impl-1',
          ts,
          body: { key: 'k', value: n },
        }
      : {
          v: 1 as const,
          kind: 'ticket.comment' as const,
          ticket,
          actor: 'impl-1',
          ts,
          body: { text: String(n) },
        };
  return {
    hash: hash(n),
    kind,
    ticket,
    actor: 'impl-1',
    ts,
    outcome: 'applied',
    reason: null,
    event,
  };
}

function append(views: EventView[]): AppendMessage {
  return { type: 'append', id: `${hash(0)}.${hash(0)}`, events: views, tickets: [], meta: null };
}

function resync(late: EventView[], removed: string[]): ResyncMessage {
  return { type: 'resync', id: `${hash(0)}.${hash(0)}`, late, removed };
}

const DIFF: CacheDifference = { table: 'tickets', key: T1, ticket: T1, live: null, rebuilt: {} };

describe('constants', () => {
  it('keeps at most 100 observations and reuses a check for 30 seconds', () => {
    expect(LATE_LIMIT).toBe(100);
    expect(CHECK_REUSE_MS).toBe(30_000);
  });
});

describe('createObservedLog', () => {
  it('starts empty and records nothing for appends', () => {
    const log = createObservedLog();
    expect(log.list()).toEqual([]);
    log.observe(append([view(1), view(2)]), 5000);
    expect(log.list()).toEqual([]);
  });

  it('records each late event of a resync with its hash, kind, ticket and observation time', () => {
    const log = createObservedLog();
    log.observe(append([view(1)]), 5000);
    log.observe(resync([view(9, T2)], []), 6000);
    expect(log.list()).toEqual([
      { hash: hash(9), kind: 'ticket.comment', ticket: T2, type: 'late', observedAt: 6000 },
    ]);
  });

  it('keeps the kind and ticket of a removed hash from the message that delivered it', () => {
    const log = createObservedLog();
    log.observe(append([view(1, T1, 'ticket.claim'), view(2, T2)]), 5000);
    log.observe(resync([], [hash(1)]), 7000);
    expect(log.list()).toEqual([
      { hash: hash(1), kind: 'ticket.claim', ticket: T1, type: 'removed', observedAt: 7000 },
    ]);
  });

  it('keeps the kind and ticket of an event first seen as late, and a null ticket', () => {
    const log = createObservedLog();
    log.observe(resync([view(3, null, 'board.meta')], []), 5000);
    log.observe(resync([], [hash(3)]), 6000);
    expect(log.list()[0]).toEqual({
      hash: hash(3),
      kind: 'board.meta',
      ticket: null,
      type: 'removed',
      observedAt: 6000,
    });
  });

  it('gives a removed hash it never saw kind "" and ticket null', () => {
    const log = createObservedLog();
    log.observe(resync([], [hash(42)]), 6000);
    expect(log.list()).toEqual([
      { hash: hash(42), kind: '', ticket: null, type: 'removed', observedAt: 6000 },
    ]);
  });

  it('lists newest first: late then removed within a message are observed in that order', () => {
    const log = createObservedLog();
    log.observe(append([view(1), view(2)]), 1000);
    log.observe(resync([view(10), view(11)], [hash(1)]), 2000);
    log.observe(resync([view(12)], [hash(2)]), 3000);
    expect(log.list().map((e) => [e.hash, e.type, e.observedAt])).toEqual([
      [hash(2), 'removed', 3000],
      [hash(12), 'late', 3000],
      [hash(1), 'removed', 2000],
      [hash(11), 'late', 2000],
      [hash(10), 'late', 2000],
    ]);
  });

  it('keeps only the newest 100, dropping the oldest', () => {
    const log = createObservedLog();
    log.observe(
      resync(
        Array.from({ length: 60 }, (_, i) => view(100 + i)),
        [],
      ),
      1000,
    );
    log.observe(
      resync(
        Array.from({ length: 60 }, (_, i) => view(200 + i)),
        [],
      ),
      2000,
    );
    const list = log.list();
    expect(list).toHaveLength(100);
    expect(list[0]?.hash).toBe(hash(259));
    expect(list[59]?.hash).toBe(hash(200));
    expect(list[60]?.hash).toBe(hash(159));
    expect(list[99]?.hash).toBe(hash(120));
    expect(list.map((e) => e.hash)).not.toContain(hash(119));
  });

  it('honours a smaller limit', () => {
    const log = createObservedLog(2);
    log.observe(resync([view(1), view(2), view(3)], []), 1000);
    expect(log.list().map((e) => e.hash)).toEqual([hash(3), hash(2)]);
  });

  it('returns copies: changing a listed entry does not change the log', () => {
    const log = createObservedLog();
    log.observe(resync([view(1)], []), 1000);
    const first = log.list();
    const entry = first[0];
    expect(entry).toBeDefined();
    if (entry !== undefined) {
      entry.kind = 'changed';
    }
    first.pop();
    expect(log.list()).toEqual([
      { hash: hash(1), kind: 'ticket.comment', ticket: T1, type: 'late', observedAt: 1000 },
    ]);
  });
});

describe('checkSummary', () => {
  it('reports a match with 0 differing rows', () => {
    expect(checkSummary({ ok: true, differences: [] }, 1234)).toEqual({
      ranAt: 1234,
      matches: true,
      differingRows: 0,
    });
  });

  it('counts the differing rows', () => {
    expect(checkSummary({ ok: false, differences: [DIFF, DIFF, DIFF] }, 99)).toEqual({
      ranAt: 99,
      matches: false,
      differingRows: 3,
    });
  });
});

/** A comparison the test completes by hand, counting its runs. */
function manualCheck(): {
  check: () => Promise<CacheCheckOutcome>;
  runs: () => number;
  resolve: (outcome: CacheCheckOutcome) => void;
  reject: (error: unknown) => void;
} {
  let runs = 0;
  let settle: { resolve: (o: CacheCheckOutcome) => void; reject: (e: unknown) => void } | null =
    null;
  return {
    check: () => {
      runs += 1;
      return new Promise<CacheCheckOutcome>((resolve, reject) => {
        settle = { resolve, reject };
      });
    },
    runs: () => runs,
    resolve: (outcome) => {
      settle?.resolve(outcome);
    },
    reject: (error) => {
      settle?.reject(error);
    },
  };
}

/** Lets pending promise callbacks run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

describe('createCacheChecker', () => {
  it('runs nothing when created and has no result', () => {
    const manual = manualCheck();
    const checker = createCacheChecker({ check: manual.check, now: () => 0 });
    expect(manual.runs()).toBe(0);
    expect(checker.last()).toBeNull();
    expect(manual.runs()).toBe(0);
  });

  it('scenario: two together and a third 10 seconds later share one comparison', async () => {
    let now = 1_000_000;
    const manual = manualCheck();
    const checker = createCacheChecker({ check: manual.check, now: () => now });
    const first = checker.run();
    const second = checker.run();
    await flush();
    expect(manual.runs()).toBe(1);
    manual.resolve({ ok: true, differences: [] });
    const expected: HealthCheck = { ranAt: 1_000_000, matches: true, differingRows: 0 };
    expect(await first).toEqual(expected);
    expect(await second).toEqual(expected);
    now += 10_000;
    expect(await checker.run()).toEqual(expected);
    expect(manual.runs()).toBe(1);
    expect(checker.last()).toEqual(expected);
  });

  it('reuses a result up to 29999 ms old and runs again at 30000 ms', async () => {
    let now = 50_000;
    let runs = 0;
    const checker = createCacheChecker({
      check: () => {
        runs += 1;
        return { ok: runs === 1, differences: runs === 1 ? [] : [DIFF] };
      },
      now: () => now,
    });
    expect(await checker.run()).toEqual({ ranAt: 50_000, matches: true, differingRows: 0 });
    now = 50_000 + 29_999;
    expect((await checker.run()).ranAt).toBe(50_000);
    expect(runs).toBe(1);
    now = 50_000 + 30_000;
    expect(await checker.run()).toEqual({ ranAt: 80_000, matches: false, differingRows: 1 });
    expect(runs).toBe(2);
    expect(checker.last()).toEqual({ ranAt: 80_000, matches: false, differingRows: 1 });
  });

  it('takes ranAt when the comparison starts, not when it ends', async () => {
    let now = 10_000;
    const manual = manualCheck();
    const checker = createCacheChecker({ check: manual.check, now: () => now });
    const pending = checker.run();
    await flush();
    now = 15_000;
    manual.resolve({ ok: true, differences: [] });
    expect((await pending).ranAt).toBe(10_000);
  });

  it('honours a custom reuse window', async () => {
    let now = 0;
    let runs = 0;
    const checker = createCacheChecker({
      check: () => {
        runs += 1;
        return { ok: true, differences: [] };
      },
      now: () => now,
      reuseMs: 1000,
    });
    await checker.run();
    now = 999;
    await checker.run();
    expect(runs).toBe(1);
    now = 1000;
    await checker.run();
    expect(runs).toBe(2);
  });

  it('fails every waiter with the error, keeps nothing, and runs again on the next request', async () => {
    const manual = manualCheck();
    const checker = createCacheChecker({ check: manual.check, now: () => 7 });
    const a = checker.run();
    const b = checker.run();
    await flush();
    const busy = new BoardError(5, 'busy', 'the board is busy');
    manual.reject(busy);
    await expect(a).rejects.toBe(busy);
    await expect(b).rejects.toBe(busy);
    expect(checker.last()).toBeNull();
    const c = checker.run();
    await flush();
    expect(manual.runs()).toBe(2);
    manual.resolve({ ok: true, differences: [] });
    expect(await c).toEqual({ ranAt: 7, matches: true, differingRows: 0 });
  });

  it('turns a synchronous throw into a rejection', async () => {
    const checker = createCacheChecker({
      check: () => {
        throw new Error('boom');
      },
      now: () => 0,
    });
    await expect(checker.run()).rejects.toThrow('boom');
    expect(checker.last()).toBeNull();
  });

  it('runs again after a synchronous throw, and a success is then kept', async () => {
    let runs = 0;
    const checker = createCacheChecker({
      check: () => {
        runs += 1;
        if (runs === 1) {
          throw new Error('busy');
        }
        return { ok: true, differences: [] };
      },
      now: () => 5,
    });
    await expect(checker.run()).rejects.toThrow('busy');
    expect(await checker.run()).toEqual({ ranAt: 5, matches: true, differingRows: 0 });
    expect(runs).toBe(2);
    expect(await checker.run()).toEqual({ ranAt: 5, matches: true, differingRows: 0 });
    expect(runs).toBe(2);
  });

  it('keeps the previous result when a later run fails', async () => {
    let now = 0;
    let fail = false;
    const checker = createCacheChecker({
      check: () => {
        if (fail) {
          throw new Error('busy');
        }
        return { ok: true, differences: [] };
      },
      now: () => now,
    });
    await checker.run();
    fail = true;
    now = 40_000;
    await expect(checker.run()).rejects.toThrow('busy');
    expect(checker.last()).toEqual({ ranAt: 0, matches: true, differingRows: 0 });
  });

  it('gives results that do not alias the kept one', async () => {
    const checker = createCacheChecker({
      check: () => ({ ok: true, differences: [] }),
      now: () => 0,
    });
    const result = await checker.run();
    result.differingRows = 99;
    expect(checker.last()?.differingRows).toBe(0);
  });
});
