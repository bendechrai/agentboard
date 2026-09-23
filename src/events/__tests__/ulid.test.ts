import { describe, expect, it } from 'vitest';

import {
  ULID_LENGTH,
  ULID_MAX_TIME,
  encodeTime,
  isUlid,
  monotonicFactory,
  newUlid,
  parseUlid,
  type RandomSource,
} from '../ulid.js';

// Published examples (https://github.com/ulid/spec and
// https://github.com/ulid/javascript README):
// - ulid(1469918176385) === "01ARYZ6S41TSV4RRFFQ69G5FAV"
// - ulid() example "01ARZ3NDEKTSV4RRFFQ69G5FAV"
// - largest valid ULID "7ZZZZZZZZZZZZZZZZZZZZZZZZZ" = epoch time 2^48 - 1
// Values below were recomputed independently with a throwaway Python base32
// encoder: time part of 1469918176385 is 01ARYZ6S41; "01ARZ3NDEK" decodes to
// 1469922850259; "TSV4RRFFQ69G5FAV" is the 80-bit value with bytes
// d6 76 4c 61 ef b9 93 02 bd 5b, and that value plus one encodes as
// "TSV4RRFFQ69G5FAW"; bytes 00 01 02 .. 09 encode as "000G40R40M30E209".
const PUBLISHED_TIME = 1469918176385;
const PUBLISHED_ULID = '01ARYZ6S41TSV4RRFFQ69G5FAV';
const PUBLISHED_RANDOM_BYTES = [0xd6, 0x76, 0x4c, 0x61, 0xef, 0xb9, 0x93, 0x02, 0xbd, 0x5b];
const SPEC_EXAMPLE = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const MAX_ULID = '7ZZZZZZZZZZZZZZZZZZZZZZZZZ';

interface Recorder {
  source: RandomSource;
  calls: number[];
}

function fixedRandom(values: readonly number[]): Recorder {
  const calls: number[] = [];
  return {
    calls,
    source: (byteLength: number) => {
      calls.push(byteLength);
      return Uint8Array.from(values);
    },
  };
}

function expectStrictlyIncreasing(values: readonly string[]): void {
  for (let i = 1; i < values.length; i += 1) {
    const prev = values[i - 1] as string;
    const cur = values[i] as string;
    if (!(prev < cur)) {
      throw new Error(`not strictly increasing at ${String(i)}: ${prev} then ${cur}`);
    }
  }
}

describe('constants', () => {
  it('match the ULID spec', () => {
    expect(ULID_LENGTH).toBe(26);
    expect(ULID_MAX_TIME).toBe(2 ** 48 - 1);
  });
});

describe('encodeTime', () => {
  it('encodes the published example timestamp', () => {
    expect(encodeTime(PUBLISHED_TIME)).toBe('01ARYZ6S41');
  });

  it('encodes the maximum timestamp as the published maximum time part', () => {
    expect(encodeTime(ULID_MAX_TIME)).toBe('7ZZZZZZZZZ');
  });

  it('encodes zero and small values with leading zeros', () => {
    expect(encodeTime(0)).toBe('0000000000');
    expect(encodeTime(1)).toBe('0000000001');
    expect(encodeTime(32)).toBe('0000000010');
    // 150000 = 4*32^3 + 18*32^2 + 15*32 + 16 -> 4 J F G
    expect(encodeTime(150000)).toBe('0000004JFG');
  });

  it.each([-1, 1.5, ULID_MAX_TIME + 1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects %s with RangeError',
    (ms) => {
      expect(() => encodeTime(ms)).toThrow(RangeError);
    },
  );
});

describe('monotonicFactory', () => {
  it('reproduces the published example value from its random bytes', () => {
    const random = fixedRandom(PUBLISHED_RANDOM_BYTES);
    const ulid = monotonicFactory(random.source);
    expect(ulid(PUBLISHED_TIME)).toBe(PUBLISHED_ULID);
    expect(random.calls).toEqual([10]);
  });

  it('increments the random part within the same millisecond without new randomness', () => {
    const random = fixedRandom(PUBLISHED_RANDOM_BYTES);
    const ulid = monotonicFactory(random.source);
    expect(ulid(PUBLISHED_TIME)).toBe(PUBLISHED_ULID);
    expect(ulid(PUBLISHED_TIME)).toBe('01ARYZ6S41TSV4RRFFQ69G5FAW');
    expect(ulid(PUBLISHED_TIME)).toBe('01ARYZ6S41TSV4RRFFQ69G5FAX');
    expect(random.calls).toEqual([10]);
  });

  it('encodes random bytes big-endian', () => {
    const ulid = monotonicFactory(fixedRandom([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]).source);
    expect(ulid(0)).toBe('0000000000000G40R40M30E209');
  });

  it('carries when incrementing', () => {
    const ulid = monotonicFactory(fixedRandom([0, 0, 0, 0, 0, 0, 0, 0, 0, 31]).source);
    expect(ulid(1000)).toBe(`${encodeTime(1000)}000000000000000Z`);
    expect(ulid(1000)).toBe(`${encodeTime(1000)}0000000000000010`);
  });

  it('draws fresh randomness when time advances', () => {
    const random = fixedRandom([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const ulid = monotonicFactory(random.source);
    expect(ulid(1000)).toBe(`${encodeTime(1000)}0000000000000000`);
    expect(ulid(1000)).toBe(`${encodeTime(1000)}0000000000000001`);
    expect(ulid(1001)).toBe(`${encodeTime(1001)}0000000000000000`);
    expect(random.calls).toEqual([10, 10]);
  });

  it('stays monotonic when the clock moves backwards', () => {
    const random = fixedRandom([0, 0, 0, 0, 0, 0, 0, 0, 0, 5]);
    const ulid = monotonicFactory(random.source);
    const first = ulid(2000);
    const second = ulid(1000);
    expect(second > first).toBe(true);
    expect(second).toBe(`${encodeTime(2000)}0000000000000006`);
    expect(random.calls).toEqual([10]);
  });

  it('throws on random-part overflow and leaves its state unchanged', () => {
    const ulid = monotonicFactory(
      fixedRandom([255, 255, 255, 255, 255, 255, 255, 255, 255, 255]).source,
    );
    expect(ulid(5000)).toBe(`${encodeTime(5000)}ZZZZZZZZZZZZZZZZ`);
    expect(() => ulid(5000)).toThrow(Error);
    expect(() => ulid(4999)).toThrow(Error);
    expect(ulid(5001)).toBe(`${encodeTime(5001)}ZZZZZZZZZZZZZZZZ`);
  });

  it('rejects an out-of-range now with RangeError', () => {
    const ulid = monotonicFactory(fixedRandom([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).source);
    expect(() => ulid(-1)).toThrow(RangeError);
    expect(() => ulid(ULID_MAX_TIME + 1)).toThrow(RangeError);
    expect(() => ulid(10.5)).toThrow(RangeError);
  });

  it('defaults now to Date.now()', () => {
    const ulid = monotonicFactory();
    const before = Date.now();
    const id = ulid();
    const after = Date.now();
    const parsed = parseUlid(id);
    expect(parsed).not.toBeNull();
    expect(parsed?.time).toBeGreaterThanOrEqual(before);
    expect(parsed?.time).toBeLessThanOrEqual(after);
  });

  it('is strictly monotonic over 10,000 calls in one millisecond', () => {
    const ulid = monotonicFactory();
    const ids: string[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      ids.push(ulid(PUBLISHED_TIME));
    }
    expectStrictlyIncreasing(ids);
    expect(new Set(ids).size).toBe(10_000);
    for (const id of ids) {
      expect(id.slice(0, 10)).toBe('01ARYZ6S41');
    }
  });

  it('is strictly monotonic over 10,000 calls with a jittering clock', () => {
    const ulid = monotonicFactory();
    const ids: string[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      // Moves forwards overall but steps backwards regularly.
      ids.push(ulid(1_000_000 + Math.floor(i / 3) - (i % 5)));
    }
    expectStrictlyIncreasing(ids);
    expect(ids.every((id) => isUlid(id))).toBe(true);
  });

  it('keeps independent state per generator', () => {
    const a = monotonicFactory(fixedRandom([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).source);
    const b = monotonicFactory(fixedRandom([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).source);
    expect(a(1000)).toBe(b(1000));
    a(1000);
    expect(b(1000)).toBe(`${encodeTime(1000)}0000000000000001`);
  });
});

describe('newUlid', () => {
  it('is strictly monotonic over 10,000 calls on the real clock', () => {
    const ids: string[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      ids.push(newUlid());
    }
    expectStrictlyIncreasing(ids);
    expect(ids.every((id) => isUlid(id))).toBe(true);
  });

  it('carries the current time', () => {
    const before = Date.now();
    const parsed = parseUlid(newUlid());
    const after = Date.now();
    expect(parsed?.time).toBeGreaterThanOrEqual(before);
    // The shared generator may have carried an earlier call's millisecond
    // forward, which is never later than now.
    expect(parsed?.time).toBeLessThanOrEqual(after);
  });

  it('rejects an invalid now with RangeError', () => {
    expect(() => newUlid(-5)).toThrow(RangeError);
  });
});

describe('parseUlid', () => {
  it('parses the published example with a known timestamp', () => {
    expect(parseUlid(PUBLISHED_ULID)).toEqual({ time: PUBLISHED_TIME, random: 'TSV4RRFFQ69G5FAV' });
  });

  it('parses the spec example', () => {
    expect(parseUlid(SPEC_EXAMPLE)).toEqual({ time: 1469922850259, random: 'TSV4RRFFQ69G5FAV' });
  });

  it('parses the largest valid ULID', () => {
    expect(parseUlid(MAX_ULID)).toEqual({ time: ULID_MAX_TIME, random: 'ZZZZZZZZZZZZZZZZ' });
  });

  it('round-trips generated timestamps', () => {
    const ulid = monotonicFactory();
    for (const t of [0, 1, 31, 32, 1_000_000, PUBLISHED_TIME, ULID_MAX_TIME]) {
      expect(parseUlid(ulid(t))?.time).toBe(t);
    }
  });

  it.each([
    ['empty', ''],
    ['too short (published invalid example)', '01ARYZ6S41TSV4RRFFQ69G5FA'],
    ['too long', '01ARYZ6S41TSV4RRFFQ69G5FAVX'],
    ['lowercase', '01aryz6s41tsv4rrffq69g5fav'],
    ['containing I', '01ARYZ6S41TSV4RRFFQ69G5FAI'],
    ['containing L', '01ARYZ6S41TSV4RRFFQ69G5FAL'],
    ['containing O', '01ARYZ6S41TSV4RRFFQ69G5FAO'],
    ['containing U', '01ARYZ6S41TSV4RRFFQ69G5FAU'],
    ['containing a space', '01ARYZ6S41 SV4RRFFQ69G5FAV'],
    ['above the 48-bit timestamp', '80000000000000000000000000'],
    ['far above the 48-bit timestamp', 'ZZZZZZZZZZZZZZZZZZZZZZZZZZ'],
  ])('returns null for %s', (_name, input) => {
    expect(parseUlid(input)).toBeNull();
    expect(isUlid(input)).toBe(false);
  });
});

describe('isUlid', () => {
  it.each([PUBLISHED_ULID, SPEC_EXAMPLE, MAX_ULID, '00000000000000000000000000'])(
    'accepts %s',
    (input) => {
      expect(isUlid(input)).toBe(true);
    },
  );

  it('sorts ULIDs from later milliseconds after earlier ones', () => {
    const ulid = monotonicFactory(
      fixedRandom([255, 255, 255, 255, 255, 255, 255, 255, 255, 255]).source,
    );
    const early = ulid(1000);
    const later = monotonicFactory(fixedRandom([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).source)(1001);
    expect(early < later).toBe(true);
  });
});
