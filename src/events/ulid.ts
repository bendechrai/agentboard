/**
 * ULID ticket ids (design.md: "Ids: hand-rolled ULID"), following
 * https://github.com/ulid/spec.
 *
 * A ULID is 26 characters of Crockford base32
 * (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`): 10 characters encoding a 48-bit
 * millisecond Unix timestamp, big-endian, then 16 characters encoding 80 bits
 * of randomness, big-endian. The largest valid ULID is
 * `7ZZZZZZZZZZZZZZZZZZZZZZZZZ` (timestamp 2^48 - 1).
 *
 * This module only ever produces and accepts the canonical form: uppercase,
 * no `I`, `L`, `O` or `U`, first character `0` to `7`. Lowercase input is not
 * a ULID here (callers that accept user-typed prefixes normalise first).
 *
 * Browser-safe (add-board-web task 1.1): this module imports no `node:`
 * module. Its default random source is the global Web Crypto
 * `crypto.getRandomValues` (present in Node 22 and every browser), looked
 * up on `globalThis.crypto` each time random bytes are needed (not
 * captured at module load), so the pure fold that reaches this module
 * through `schema.ts` can be bundled for the browser. The bytes contract
 * is unchanged: 10 random bytes per fresh random part.
 */

import { getRandomValues } from 'node:crypto';

/** Crockford base32 alphabet, in digit order. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Canonical ULID: first character 0-7, then 25 Crockford base32 characters. */
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;
const RANDOM_BYTES = 10;
const RANDOM_LIMIT = 1n << 80n;

/** Length of a ULID string. */
export const ULID_LENGTH = 26;

/** Largest timestamp a ULID can carry: 2^48 - 1. */
export const ULID_MAX_TIME = 281474976710655;

/**
 * Supplies `byteLength` cryptographically random bytes. The generator always
 * asks for exactly 10 bytes and uses the returned array as the 80-bit random
 * component, big-endian (byte 0 most significant).
 */
export type RandomSource = (byteLength: number) => Uint8Array;

/** Generates ULIDs; see `monotonicFactory`. */
export type UlidGenerator = (now?: number) => string;

/**
 * Encodes a millisecond timestamp as the 10-character time part.
 *
 * @throws RangeError when `ms` is not an integer in `[0, ULID_MAX_TIME]`.
 */
export function encodeTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > ULID_MAX_TIME) {
    throw new RangeError(`ULID time must be an integer in [0, ${String(ULID_MAX_TIME)}]`);
  }
  let rest = ms;
  let out = '';
  for (let i = 0; i < TIME_LENGTH; i += 1) {
    out = ALPHABET.charAt(rest % 32) + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

/** Encodes an 80-bit unsigned integer as 16 Crockford base32 characters. */
function encodeRandom(value: bigint): string {
  let rest = value;
  let out = '';
  for (let i = 0; i < RANDOM_LENGTH; i += 1) {
    out = ALPHABET.charAt(Number(rest & 31n)) + out;
    rest >>= 5n;
  }
  return out;
}

function defaultRandom(byteLength: number): Uint8Array {
  return getRandomValues(new Uint8Array(byteLength));
}

/**
 * Returns a monotonic ULID generator.
 *
 * Each call takes `now` (milliseconds since the Unix epoch; defaults to
 * `Date.now()`) and returns a ULID. Every ULID returned by one generator is
 * strictly greater, as a string, than the previous one it returned:
 * - When `now` is greater than the timestamp of the previous ULID (or on the
 *   first call), the result has time part `encodeTime(now)` and a fresh random
 *   part from `random(10)`.
 * - Otherwise (same millisecond, or the clock moved backwards), the result
 *   reuses the previous ULID's time part and its random part is the previous
 *   random part plus one, as an 80-bit unsigned integer; `random` is not
 *   called.
 *
 * @param random defaults to the global Web Crypto
 *   `globalThis.crypto.getRandomValues` over a new 10-byte `Uint8Array`.
 * @throws RangeError when `now` is not an integer in `[0, ULID_MAX_TIME]`.
 * @throws Error when incrementing the random part would overflow 80 bits;
 *   the generator's state is left unchanged.
 */
export function monotonicFactory(random: RandomSource = defaultRandom): UlidGenerator {
  let lastTime = -1;
  let lastRandom = 0n;
  return (now = Date.now()) => {
    const timePart = encodeTime(now);
    if (now > lastTime) {
      lastTime = now;
      lastRandom = random(RANDOM_BYTES).reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
      return timePart + encodeRandom(lastRandom);
    }
    const next = lastRandom + 1n;
    if (next >= RANDOM_LIMIT) {
      throw new Error('ULID random part overflow within one millisecond');
    }
    lastRandom = next;
    return encodeTime(lastTime) + encodeRandom(next);
  };
}

const sharedGenerator = monotonicFactory();

/**
 * Returns a new ULID from a module-level monotonic generator (created with
 * the default random source), so ULIDs from one process are strictly
 * increasing. Same `now` semantics and errors as the generator returned by
 * `monotonicFactory`.
 */
export function newUlid(now?: number): string {
  return sharedGenerator(now);
}

/** Components of a parsed ULID. */
export interface ParsedUlid {
  /** Milliseconds since the Unix epoch encoded in the first 10 characters. */
  time: number;
  /** The last 16 characters (the random part), unchanged. */
  random: string;
}

/**
 * Parses a ULID. Returns `null` for anything `isUlid` rejects.
 */
export function parseUlid(text: string): ParsedUlid | null {
  if (!isUlid(text)) {
    return null;
  }
  let time = 0;
  for (const ch of text.slice(0, TIME_LENGTH)) {
    time = time * 32 + ALPHABET.indexOf(ch);
  }
  return { time, random: text.slice(TIME_LENGTH) };
}

/**
 * True when `text` is exactly 26 characters of uppercase Crockford base32
 * whose first character is `0` to `7` (so the timestamp fits 48 bits).
 */
export function isUlid(text: string): boolean {
  return ULID_PATTERN.test(text);
}
