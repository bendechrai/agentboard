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
 */

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
  void ms;
  throw new Error('not implemented');
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
 * @param random defaults to `crypto.getRandomValues` over 10 bytes.
 * @throws RangeError when `now` is not an integer in `[0, ULID_MAX_TIME]`.
 * @throws Error when incrementing the random part would overflow 80 bits;
 *   the generator's state is left unchanged.
 */
export function monotonicFactory(random?: RandomSource): UlidGenerator {
  void random;
  throw new Error('not implemented');
}

/**
 * Returns a new ULID from a module-level monotonic generator (created with
 * the default random source), so ULIDs from one process are strictly
 * increasing. Same `now` semantics and errors as the generator returned by
 * `monotonicFactory`.
 */
export function newUlid(now?: number): string {
  void now;
  throw new Error('not implemented');
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
  void text;
  throw new Error('not implemented');
}

/**
 * True when `text` is exactly 26 characters of uppercase Crockford base32
 * whose first character is `0` to `7` (so the timestamp fits 48 bits).
 */
export function isUlid(text: string): boolean {
  void text;
  throw new Error('not implemented');
}
