import { describe, expect, it } from 'vitest';

import {
  CanonicalError,
  canonicalDecode,
  canonicalEncode,
  canonicalHash,
  sha256Hex,
  type CanonicalErrorCode,
} from '../canonical.js';

const utf8 = new TextEncoder();
const bytes = (text: string): Uint8Array => utf8.encode(text);
const text = (data: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(data);

// Built from char codes so the test source stays plain ASCII and no editor or
// tool can rewrite an escape sequence.
const BACKSLASH = String.fromCharCode(92);
const E_ACUTE = String.fromCharCode(0xe9);
const BOM = [0xef, 0xbb, 0xbf];

function codeOf(fn: () => unknown): CanonicalErrorCode | 'no-error' | 'wrong-error-type' {
  try {
    fn();
  } catch (error) {
    if (error instanceof CanonicalError) {
      return error.code;
    }
    return 'wrong-error-type';
  }
  return 'no-error';
}

describe('canonicalEncode', () => {
  it('returns a Uint8Array', () => {
    expect(canonicalEncode({ a: 1 })).toBeInstanceOf(Uint8Array);
  });

  it('sorts top-level keys', () => {
    expect(text(canonicalEncode({ b: 1, a: 2 }))).toBe('{"a":2,"b":1}');
  });

  it('sorts keys at every depth, including inside arrays, and keeps array order', () => {
    const value = { z: [{ d: 1, c: 2 }, 3, 1], y: { b: { y: 1, x: 2 }, a: null } };
    expect(text(canonicalEncode(value))).toBe(
      '{"y":{"a":null,"b":{"x":2,"y":1}},"z":[{"c":2,"d":1},3,1]}',
    );
  });

  it('produces identical bytes for objects built with different key insertion orders', () => {
    const first: Record<string, unknown> = {};
    first.kind = 'ticket.comment';
    first.actor = 'impl';
    first.body = { text: 'hi', extra: { q: 1, p: [true, false] } };
    first.v = 1;

    const second: Record<string, unknown> = {};
    second.v = 1;
    second.body = { extra: { p: [true, false], q: 1 }, text: 'hi' };
    second.actor = 'impl';
    second.kind = 'ticket.comment';

    expect(canonicalEncode(first)).toEqual(canonicalEncode(second));
    expect(text(canonicalEncode(first))).toBe(
      '{"actor":"impl","body":{"extra":{"p":[true,false],"q":1},"text":"hi"},"kind":"ticket.comment","v":1}',
    );
  });

  it('is independent of insertion order over many permutations', () => {
    const keys = ['kind', 'v', 'a', 'B', '_', 'zz', 'z', 'ticket', 'actor', 'ts'];
    const expected = text(canonicalEncode(Object.fromEntries(keys.map((k, i) => [k, i]))));
    let seed = 7;
    for (let round = 0; round < 50; round += 1) {
      const shuffled = [...keys];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        const j = seed % (i + 1);
        const tmp = shuffled[i] as string;
        shuffled[i] = shuffled[j] as string;
        shuffled[j] = tmp;
      }
      const obj: Record<string, number> = {};
      for (const k of shuffled) {
        obj[k] = keys.indexOf(k);
      }
      expect(text(canonicalEncode(obj))).toBe(expected);
    }
  });

  it('orders keys by UTF-16 code unit order', () => {
    // Code units: "" < "B" (0x42) < "_" (0x5f) < "a" (0x61) < "aa".
    expect(text(canonicalEncode({ a: 1, aa: 2, _: 3, B: 4, '': 5 }))).toBe(
      '{"":5,"B":4,"_":3,"a":1,"aa":2}',
    );
    // A supplementary character starts with a high surrogate (0xd83d), which
    // sorts before U+FFFF in UTF-16 code unit order (unlike code point order).
    const high = String.fromCharCode(0xffff);
    const emoji = String.fromCodePoint(0x1f600);
    const encoded = text(canonicalEncode({ [high]: 1, [emoji]: 2 }));
    expect(encoded).toBe(`{"${emoji}":2,"${high}":1}`);
  });

  it('writes no whitespace', () => {
    const out = text(canonicalEncode({ a: [1, 2, { b: 'c d' }], e: {} }));
    expect(out).toBe('{"a":[1,2,{"b":"c d"}],"e":{}}');
  });

  it('encodes primitives and empty containers as JSON.stringify does', () => {
    expect(text(canonicalEncode(null))).toBe('null');
    expect(text(canonicalEncode(true))).toBe('true');
    expect(text(canonicalEncode(false))).toBe('false');
    expect(text(canonicalEncode(0))).toBe('0');
    expect(text(canonicalEncode(-42))).toBe('-42');
    expect(text(canonicalEncode('s'))).toBe('"s"');
    expect(text(canonicalEncode([]))).toBe('[]');
    expect(text(canonicalEncode({}))).toBe('{}');
  });

  it('writes -0 as 0', () => {
    expect(text(canonicalEncode({ n: -0 }))).toBe('{"n":0}');
  });

  it('accepts the largest safe integers', () => {
    expect(text(canonicalEncode([Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]))).toBe(
      '[9007199254740991,-9007199254740991]',
    );
  });

  it('emits non-ASCII characters as raw UTF-8 bytes, not escapes', () => {
    const out = canonicalEncode({ t: `caf${E_ACUTE}` });
    expect([...out]).toEqual([...bytes('{"t":"caf'), 0xc3, 0xa9, ...bytes('"}')]);
  });

  it('escapes quotes, backslashes and control characters as JSON.stringify does', () => {
    const value = { s: `q"b${BACKSLASH}n\nt\tz${String.fromCharCode(1)}` };
    expect(text(canonicalEncode(value))).toBe(JSON.stringify(value));
  });

  it('accepts null-prototype objects', () => {
    const obj = Object.create(null) as Record<string, number>;
    obj.b = 2;
    obj.a = 1;
    expect(text(canonicalEncode(obj))).toBe('{"a":1,"b":2}');
  });

  it.each([
    ['a fractional number', 1.5],
    ['a small fraction', 0.1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['an unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['a large exponent integer', 1e21],
    ['a float nested in an object', { a: { b: [1, 2.5] } }],
    ['a float in an event body', { v: 1, body: { index: 0.5 } }],
  ])('rejects %s with code float', (_name, value) => {
    expect(codeOf(() => canonicalEncode(value))).toBe('float');
  });

  class Point {
    x = 1;
  }
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;

  it.each([
    ['undefined', undefined],
    ['an undefined property value', { a: undefined }],
    ['an undefined array element', [1, undefined]],
    ['a function', () => 1],
    ['a symbol', Symbol('s')],
    ['a bigint', 1n],
    ['a Date', new Date(0)],
    ['a Map', new Map([['a', 1]])],
    ['a class instance', new Point()],
    ['a cyclic structure', cyclic],
  ])('rejects %s with code unsupported-type', (_name, value) => {
    expect(codeOf(() => canonicalEncode(value))).toBe('unsupported-type');
  });
});

describe('canonicalDecode', () => {
  it.each([
    ['an object', '{"a":2,"b":[1,{"c":null}],"d":true}'],
    ['an empty object', '{}'],
    ['an array', '[1,"x",false]'],
    ['a string', '"hi"'],
    ['a negative integer', '-7'],
    ['null', 'null'],
  ])('decodes canonical %s', (_name, input) => {
    expect(canonicalDecode(bytes(input))).toEqual(JSON.parse(input));
  });

  it('decodes raw UTF-8 characters', () => {
    const input = Uint8Array.from([...bytes('{"t":"caf'), 0xc3, 0xa9, ...bytes('"}')]);
    expect(canonicalDecode(input)).toEqual({ t: `caf${E_ACUTE}` });
  });

  it('round-trips what canonicalEncode produces', () => {
    const value = { z: [{ d: 1, c: 'x' }], a: { n: -3, t: `caf${E_ACUTE}`, q: null, f: false } };
    expect(canonicalDecode(canonicalEncode(value))).toEqual(value);
  });

  it.each([
    ['an invalid byte', [0x22, 0xff, 0x22]],
    ['a truncated sequence', [0x22, 0xc3, 0x22]],
    ['an encoded surrogate', [0x22, 0xed, 0xa0, 0x80, 0x22]],
  ])('rejects %s with code invalid-utf8', (_name, input) => {
    expect(codeOf(() => canonicalDecode(Uint8Array.from(input)))).toBe('invalid-utf8');
  });

  it.each([
    ['empty input', ''],
    ['an unterminated object', '{'],
    ['a missing value', '{"a":}'],
    ['single quotes', "{'a':1}"],
    ['a bare word', 'undefined'],
    ['two values', '1 2'],
    ['a trailing comma', '[1,]'],
  ])('rejects %s with code invalid-json', (_name, input) => {
    expect(codeOf(() => canonicalDecode(bytes(input)))).toBe('invalid-json');
  });

  it.each([
    ['at the top level', '{"a":1,"a":1}'],
    ['with different values', '{"a":1,"a":2}'],
    ['in a nested object', '{"x":{"a":1,"a":2}}'],
    ['inside an array', '[{"a":1,"a":2}]'],
    ['even when whitespace also makes it non-canonical', '{ "a":1, "a":2 }'],
  ])('rejects a duplicate key %s with code duplicate-key', (_name, input) => {
    expect(codeOf(() => canonicalDecode(bytes(input)))).toBe('duplicate-key');
  });

  it.each([
    ['a fraction', '{"a":1.5}'],
    ['an integral value written with a fraction', '{"a":1.0}'],
    ['an exponent', '{"a":1e3}'],
    ['an uppercase exponent in an array', '[2E1]'],
    ['an unsafe integer', '9007199254740992'],
  ])('rejects %s with code float', (_name, input) => {
    expect(codeOf(() => canonicalDecode(bytes(input)))).toBe('float');
  });

  it.each([
    ['unsorted keys', bytes('{"b":1,"a":2}')],
    ['unsorted nested keys', bytes('{"a":{"d":1,"c":2}}')],
    ['whitespace after a colon', bytes('{"a": 1}')],
    ['whitespace in an array', bytes('[1, 2]')],
    ['leading whitespace', bytes(' {}')],
    ['a trailing newline', bytes('{}\n')],
    ['a byte order mark', Uint8Array.from([...BOM, ...bytes('{}')])],
    ['an escaped non-ASCII character', bytes(`"caf${BACKSLASH}u00e9"`)],
    ['an escaped solidus', bytes(`"${BACKSLASH}/"`)],
    ['negative zero', bytes('-0')],
  ])('rejects %s with code non-canonical', (_name, input) => {
    expect(codeOf(() => canonicalDecode(input))).toBe('non-canonical');
  });
});

describe('sha256Hex and canonicalHash', () => {
  it('hashes the empty byte string to the well-known SHA-256 value', () => {
    // printf '' | shasum -a 256
    expect(sha256Hex(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('matches an independently computed golden hash for a small object', () => {
    // printf '%s' '{"a":"x","b":1}' | shasum -a 256
    expect(canonicalHash({ b: 1, a: 'x' })).toBe(
      'cdab067e9f3beb32d1252cfd63e492592fecbf591b0d08cadb24bb17f3864246',
    );
  });

  it('matches an independently computed golden hash for a full event', () => {
    // printf '%s' '{"actor":"orch","body":{"task":{"item":"1","ref":"add-board-core","source":"openspec"},"title":"Canonical fold"},"kind":"ticket.create","ticket":"01ARYZ6S41TSV4RRFFQ69G5FAV","ts":{"actor":"orch","counter":0,"wall":1469918176385},"v":1}' | shasum -a 256
    const event = {
      v: 1,
      kind: 'ticket.create',
      ticket: '01ARYZ6S41TSV4RRFFQ69G5FAV',
      actor: 'orch',
      ts: { wall: 1469918176385, counter: 0, actor: 'orch' },
      body: {
        title: 'Canonical fold',
        task: { source: 'openspec', ref: 'add-board-core', item: '1' },
      },
    };
    expect(canonicalHash(event)).toBe(
      'b0b02e4ba3ba1a1b60427fd176d6e2ce4a1e5a903e8b4002d824778e7124d478',
    );
  });

  it('matches an independently computed golden hash for non-ASCII text', () => {
    // printf '{"t":"caf\303\251"}' | shasum -a 256
    expect(canonicalHash({ t: `caf${E_ACUTE}` })).toBe(
      'd8071006e6a933a716d4c7516f211ad469701f336132f9f38ba66b6d337d21be',
    );
  });

  it('is the SHA-256 of the canonical bytes', () => {
    const value = { z: 1, a: [true, null, 'x'] };
    expect(canonicalHash(value)).toBe(sha256Hex(canonicalEncode(value)));
  });

  it('is stable across key insertion order and repeated calls', () => {
    const a = canonicalHash({ x: 1, y: { p: 2, q: 3 } });
    const b = canonicalHash({ y: { q: 3, p: 2 }, x: 1 });
    expect(a).toBe(b);
    expect(canonicalHash({ x: 1, y: { p: 2, q: 3 } })).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different values', () => {
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }));
    expect(canonicalHash({ a: '1' })).not.toBe(canonicalHash({ a: 1 }));
  });

  it('rejects floats like canonicalEncode', () => {
    expect(codeOf(() => canonicalHash({ a: 0.5 }))).toBe('float');
  });
});
