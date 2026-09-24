/**
 * `retryBusy` (src/store/engine.ts, internal): the retry loop that makes
 * every statement of a cache open wait on the busy timeout, including the
 * WAL switch that SQLite fails with SQLITE_BUSY without consulting the busy
 * handler (board-cache: "Cache connection settings").
 */

import { describe, expect, it } from 'vitest';

import { expectBoardError } from '../../board/__tests__/helpers.js';
import { BoardError } from '../errors.js';
import { isBusy, retryBusy } from '../engine.js';

/** An error shaped like node:sqlite's SQLITE_BUSY (errcode 5, or an extended code). */
function busy(errcode = 5): Error {
  return Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode });
}

describe('isBusy', () => {
  it('recognises SQLITE_BUSY and its extended codes only', () => {
    expect(isBusy(busy())).toBe(true);
    expect(isBusy(busy(5 | (2 << 8)))).toBe(true); // SQLITE_BUSY_SNAPSHOT
    expect(isBusy(busy(6))).toBe(false); // SQLITE_LOCKED
    expect(isBusy(new Error('database is locked'))).toBe(false);
    expect(isBusy(new BoardError(5, 'busy', 'x'))).toBe(false);
    expect(isBusy('busy')).toBe(false);
  });
});

describe('retryBusy', () => {
  it('returns at once when fn succeeds', () => {
    let calls = 0;
    expect(
      retryBusy(() => {
        calls += 1;
        return 'ok';
      }, Date.now() + 5000),
    ).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries a busy failure and returns the first success', () => {
    let calls = 0;
    const result = retryBusy(() => {
      calls += 1;
      if (calls < 4) {
        throw busy(calls === 2 ? 5 | (1 << 8) : 5);
      }
      return 42;
    }, Date.now() + 5000);
    expect(result).toBe(42);
    expect(calls).toBe(4);
  });

  it('throws BoardError(5, busy) once the deadline has passed, sleeping rather than spinning', () => {
    let calls = 0;
    const started = Date.now();
    expectBoardError(
      () =>
        retryBusy(() => {
          calls += 1;
          throw busy();
        }, started + 150),
      5,
      'busy',
    );
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(2000);
    expect(calls).toBeGreaterThan(1);
    // Sleeps of at least 1 ms between attempts: far fewer calls than a spin.
    expect(calls).toBeLessThan(200);
  });

  it('runs fn once even when the deadline has already passed', () => {
    let calls = 0;
    expect(
      retryBusy(() => {
        calls += 1;
        return 'late';
      }, Date.now() - 1000),
    ).toBe('late');
    expect(calls).toBe(1);
    calls = 0;
    expectBoardError(
      () =>
        retryBusy(() => {
          calls += 1;
          throw busy();
        }, Date.now() - 1000),
      5,
      'busy',
    );
    expect(calls).toBe(1);
  });

  it('propagates any other error at once, unchanged', () => {
    const errors: unknown[] = [
      new Error('disk I/O error'),
      busy(6),
      new BoardError(5, 'busy', 'from beginImmediate'),
    ];
    for (const error of errors) {
      let calls = 0;
      let thrown: unknown = null;
      try {
        retryBusy(() => {
          calls += 1;
          throw error;
        }, Date.now() + 5000);
      } catch (caught) {
        thrown = caught;
      }
      expect(thrown).toBe(error);
      expect(calls).toBe(1);
    }
  });
});
