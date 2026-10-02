import { afterEach, describe, expect, it, vi } from 'vitest';

import { monotonicFactory, newUlid } from '../ulid.js';

// The default random source is the global Web Crypto getRandomValues,
// looked up on globalThis.crypto at call time.

describe('ulid default random source', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Replaces the global `crypto` with an object whose `getRandomValues`
   * fills the array with `byte`, and returns that mock.
   */
  function fillWith(byte: number): ReturnType<typeof vi.fn<(array: Uint8Array) => Uint8Array>> {
    const getRandomValues = vi.fn((array: Uint8Array): Uint8Array => array.fill(byte));
    vi.stubGlobal('crypto', { getRandomValues });
    return getRandomValues;
  }

  it('draws 10 bytes from globalThis.crypto.getRandomValues for a fresh random part', () => {
    const spy = fillWith(0xff);
    const ulid = monotonicFactory()(1_000);
    expect(ulid.slice(10)).toBe('ZZZZZZZZZZZZZZZZ');
    expect(spy).toHaveBeenCalledTimes(1);
    const [array] = spy.mock.calls[0] ?? [];
    expect(array).toBeInstanceOf(Uint8Array);
    expect((array as Uint8Array).byteLength).toBe(10);
  });

  it('reads bytes big-endian from the global source', () => {
    fillWith(0);
    expect(monotonicFactory()(1_000).slice(10)).toBe('0000000000000000');
  });

  it('is used by newUlid, looked up at call time rather than at module load', () => {
    const spy = fillWith(0xff);
    const ulid = newUlid(Date.UTC(2100, 0, 1));
    expect(spy).toHaveBeenCalled();
    expect(ulid.slice(10)).toBe('ZZZZZZZZZZZZZZZZ');
  });

  it('does not call the random source within the same millisecond', () => {
    const spy = fillWith(0);
    const next = monotonicFactory();
    next(5_000);
    next(5_000);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
