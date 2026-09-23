import { describe, expect, it } from 'vitest';

import { compareHlc, decodeHlc, encodeHlc, nextHlc, type Hlc } from '../hlc.js';

// Small deterministic PRNG so property tests are reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ACTORS = ['a', 'b', 'B', 'impl', 'impl2', 'reviewer', 'test-author'];

function randomHlc(rand: () => number): Hlc {
  return {
    wall: Math.floor(rand() * 4),
    counter: Math.floor(rand() * 3),
    actor: ACTORS[Math.floor(rand() * ACTORS.length)] as string,
  };
}

// Reference order written out independently of the implementation.
function refCompare(a: Hlc, b: Hlc): number {
  if (a.wall !== b.wall) return a.wall < b.wall ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.actor !== b.actor) return a.actor < b.actor ? -1 : 1;
  return 0;
}

describe('nextHlc', () => {
  it('starts at counter 0 on an empty board', () => {
    expect(nextHlc(null, 1000, 'a')).toEqual({ wall: 1000, counter: 0, actor: 'a' });
  });

  it('carries the wall forward when the clock moved backwards (spec scenario)', () => {
    expect(nextHlc({ wall: 1000, counter: 0, actor: 'x' }, 900, 'b')).toEqual({
      wall: 1000,
      counter: 1,
      actor: 'b',
    });
  });

  it('increments the counter when the clock reads the same millisecond', () => {
    expect(nextHlc({ wall: 1000, counter: 3, actor: 'x' }, 1000, 'b')).toEqual({
      wall: 1000,
      counter: 4,
      actor: 'b',
    });
  });

  it('resets the counter when the clock moves forwards', () => {
    expect(nextHlc({ wall: 1000, counter: 5, actor: 'x' }, 1001, 'b')).toEqual({
      wall: 1001,
      counter: 0,
      actor: 'b',
    });
  });

  it('ignores the previous actor', () => {
    const a = nextHlc({ wall: 10, counter: 0, actor: 'zzz' }, 5, 'a');
    const b = nextHlc({ wall: 10, counter: 0, actor: 'aaa' }, 5, 'a');
    expect(a).toEqual(b);
  });

  it.each([
    ['a negative wall', -1, 'a'],
    ['a fractional wall', 1.5, 'a'],
    ['NaN', Number.NaN, 'a'],
    ['an unsafe wall', Number.MAX_SAFE_INTEGER + 1, 'a'],
    ['an empty actor', 1000, ''],
  ])('rejects %s with RangeError', (_name, wall, actor) => {
    expect(() => nextHlc(null, wall, actor)).toThrow(RangeError);
  });

  it('always produces a timestamp after the previous one, over random clocks', () => {
    const rand = mulberry32(42);
    let prev: Hlc | null = null;
    for (let i = 0; i < 5000; i += 1) {
      // Clock wanders forwards and backwards by up to 50 ms.
      const now = 100_000 + Math.floor(rand() * 100) - 50 + Math.floor(i / 10);
      const actor = ACTORS[i % ACTORS.length] as string;
      const cur = nextHlc(prev, now, actor);
      expect(cur.actor).toBe(actor);
      if (prev === null) {
        expect(cur).toEqual({ wall: now, counter: 0, actor });
      } else {
        expect(cur.wall).toBe(Math.max(prev.wall, now));
        expect(cur.counter).toBe(now > prev.wall ? 0 : prev.counter + 1);
        expect(cur.wall > prev.wall || (cur.wall === prev.wall && cur.counter > prev.counter)).toBe(
          true,
        );
      }
      prev = cur;
    }
  });
});

describe('compareHlc', () => {
  it('orders by wall first', () => {
    expect(
      compareHlc({ wall: 1, counter: 9, actor: 'z' }, { wall: 2, counter: 0, actor: 'a' }),
    ).toBe(-1);
    expect(
      compareHlc({ wall: 2, counter: 0, actor: 'a' }, { wall: 1, counter: 9, actor: 'z' }),
    ).toBe(1);
  });

  it('then by counter', () => {
    expect(
      compareHlc({ wall: 1, counter: 1, actor: 'z' }, { wall: 1, counter: 2, actor: 'a' }),
    ).toBe(-1);
    expect(
      compareHlc({ wall: 1, counter: 2, actor: 'a' }, { wall: 1, counter: 1, actor: 'z' }),
    ).toBe(1);
  });

  it('then by actor in UTF-16 code unit order', () => {
    expect(
      compareHlc({ wall: 1, counter: 1, actor: 'B' }, { wall: 1, counter: 1, actor: 'a' }),
    ).toBe(-1);
    expect(
      compareHlc({ wall: 1, counter: 1, actor: 'impl' }, { wall: 1, counter: 1, actor: 'impl2' }),
    ).toBe(-1);
    expect(
      compareHlc({ wall: 1, counter: 1, actor: 'b' }, { wall: 1, counter: 1, actor: 'a' }),
    ).toBe(1);
  });

  it('returns 0 only for equal timestamps', () => {
    expect(
      compareHlc({ wall: 1, counter: 1, actor: 'a' }, { wall: 1, counter: 1, actor: 'a' }),
    ).toBe(0);
  });

  it('is a total order that agrees with the reference order over random inputs', () => {
    const rand = mulberry32(7);
    const samples = Array.from({ length: 200 }, () => randomHlc(rand));
    for (const a of samples) {
      for (const b of samples.slice(0, 40)) {
        const got = compareHlc(a, b);
        expect(got).toBe(refCompare(a, b));
        // Antisymmetry.
        expect(compareHlc(b, a)).toBe(-got === 0 ? 0 : -got);
        // Zero iff all fields equal.
        expect(got === 0).toBe(a.wall === b.wall && a.counter === b.counter && a.actor === b.actor);
      }
    }
  });

  it('is transitive over random triples', () => {
    const rand = mulberry32(99);
    for (let i = 0; i < 3000; i += 1) {
      const a = randomHlc(rand);
      const b = randomHlc(rand);
      const c = randomHlc(rand);
      if (compareHlc(a, b) <= 0 && compareHlc(b, c) <= 0) {
        expect(compareHlc(a, c)).toBeLessThanOrEqual(0);
      }
    }
  });

  it('sorts shuffled inputs to the same sequence', () => {
    const rand = mulberry32(3);
    const samples = Array.from({ length: 100 }, () => randomHlc(rand));
    const expected = [...samples].sort(refCompare);
    for (let round = 0; round < 10; round += 1) {
      const shuffled = [...samples].sort(() => rand() - 0.5);
      expect([...shuffled].sort(compareHlc)).toEqual(expected);
    }
  });
});

describe('encodeHlc and decodeHlc', () => {
  it('encodes with fixed-width wall and counter', () => {
    expect(encodeHlc({ wall: 1469918176385, counter: 2, actor: 'impl' })).toBe(
      '0001469918176385-0000000000000002-impl',
    );
    expect(encodeHlc({ wall: 0, counter: 0, actor: 'a' })).toBe(
      '0000000000000000-0000000000000000-a',
    );
  });

  it('decodes what it encodes, including actors containing hyphens', () => {
    for (const ts of [
      { wall: 1469918176385, counter: 2, actor: 'impl' },
      { wall: 0, counter: 0, actor: 'test-author' },
      { wall: Number.MAX_SAFE_INTEGER, counter: Number.MAX_SAFE_INTEGER, actor: 'a-b-c' },
    ]) {
      expect(decodeHlc(encodeHlc(ts))).toEqual(ts);
    }
  });

  it('decodes a hand-written wire form', () => {
    expect(decodeHlc('0000000000001000-0000000000000001-test-author')).toEqual({
      wall: 1000,
      counter: 1,
      actor: 'test-author',
    });
  });

  it('orders encoded strings as compareHlc orders their values', () => {
    const rand = mulberry32(11);
    for (let i = 0; i < 2000; i += 1) {
      const a = {
        wall: Math.floor(rand() * 20_000),
        counter: Math.floor(rand() * 200),
        actor: ACTORS[i % 7] as string,
      };
      const b = {
        wall: Math.floor(rand() * 20_000),
        counter: Math.floor(rand() * 200),
        actor: ACTORS[(i * 3) % 7] as string,
      };
      const ea = encodeHlc(a);
      const eb = encodeHlc(b);
      const stringOrder = ea < eb ? -1 : ea > eb ? 1 : 0;
      expect(stringOrder).toBe(compareHlc(a, b));
    }
  });

  it.each([
    ['a negative wall', { wall: -1, counter: 0, actor: 'a' }],
    ['a fractional counter', { wall: 1, counter: 0.5, actor: 'a' }],
    ['an empty actor', { wall: 1, counter: 0, actor: '' }],
  ])('encode rejects %s with RangeError', (_name, ts) => {
    expect(() => encodeHlc(ts)).toThrow(RangeError);
  });

  it.each([
    ['garbage', 'garbage'],
    ['short numeric parts', '1-2-a'],
    ['an empty actor', '0001469918176385-0000000000000002-'],
    ['a non-digit in the wall', '000146991817638x-0000000000000002-a'],
    ['a missing actor part', '0001469918176385-0000000000000002'],
    ['a wall above the safe integer range', '9999999999999999-0000000000000000-a'],
    ['a long counter', '0001469918176385-00000000000000002-a'],
    ['empty input', ''],
  ])('decode rejects %s', (_name, input) => {
    expect(() => decodeHlc(input)).toThrow(Error);
  });
});
