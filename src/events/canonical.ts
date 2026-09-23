/**
 * Canonical JSON for board events (board-events: "Event files are immutable
 * and content-addressed"; design.md: "Canonical JSON").
 *
 * The canonical encoding of a value is the byte sequence that names an event
 * file, so it must be identical for equal values regardless of how they were
 * built. Pure: no IO, no clock, no randomness.
 */

/** A JSON value as it appears in an event. Numbers are always safe integers. */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

/** A JSON object. Keys are unique by construction. */
export interface JsonObject {
  [key: string]: JsonValue;
}

/**
 * Why a value could not be encoded or a byte sequence could not be decoded.
 *
 * - `float`: a number that is not a safe integer (has a fractional part, is
 *   NaN or +/-Infinity, or has an absolute value above
 *   `Number.MAX_SAFE_INTEGER`). On decode, also any number token written
 *   with a `.`, `e` or `E`, whatever its value (so `1.0` and `1e3` are
 *   `float`).
 * - `unsupported-type`: on encode, a value that is not null, a boolean, a
 *   number, a string, an array or a plain object (prototype
 *   `Object.prototype` or `null`): for example `undefined` (including as an
 *   object property value or array element), a function, a symbol, a bigint,
 *   a `Date`, a `Map`, a class instance, or a cyclic structure.
 * - `invalid-utf8`: on decode, the bytes are not well-formed UTF-8.
 * - `invalid-json`: on decode, the text is not a single JSON value (RFC 8259),
 *   including empty input.
 * - `duplicate-key`: on decode, some object (at any depth) has the same key
 *   twice.
 * - `non-canonical`: on decode, the input is valid JSON without duplicate keys
 *   or floats, but is not byte-identical to `canonicalEncode` of the value it
 *   denotes (whitespace, unsorted keys, a leading UTF-8 byte order mark
 *   (reported as `non-canonical`, not `invalid-json`), a trailing newline, escapes that the encoder would not produce such as `\u00e9` or
 *   `\/`, `-0`, and so on).
 */
export type CanonicalErrorCode =
  | 'float'
  | 'unsupported-type'
  | 'invalid-utf8'
  | 'invalid-json'
  | 'duplicate-key'
  | 'non-canonical';

/** Thrown by `canonicalEncode`, `canonicalDecode` and `canonicalHash`. */
export class CanonicalError extends Error {
  readonly code: CanonicalErrorCode;

  constructor(code: CanonicalErrorCode, message: string) {
    super(message);
    this.name = 'CanonicalError';
    this.code = code;
  }
}

/**
 * Encodes `value` as canonical JSON, returned as UTF-8 bytes.
 *
 * Rules:
 * - Object keys are sorted at every depth by UTF-16 code unit order (the
 *   order of the default `Array.prototype.sort`), so key insertion order
 *   never affects the output.
 * - No insignificant whitespace; no trailing newline; no byte order mark.
 * - Strings are written exactly as `JSON.stringify` writes them (so non-ASCII
 *   characters are emitted as raw UTF-8, not as `\u` escapes), and the text
 *   is encoded as UTF-8.
 * - Numbers must be safe integers and are written as `JSON.stringify` writes
 *   them (`-0` is written as `0`).
 * - Array element order is preserved.
 *
 * @throws CanonicalError with code `float` for any number that is not a safe
 *   integer, or `unsupported-type` for any value that is not JSON (see
 *   `CanonicalErrorCode`). Nothing is returned partially.
 */
export function canonicalEncode(value: unknown): Uint8Array {
  void value;
  throw new Error('not implemented');
}

/**
 * Decodes bytes that must already be canonical JSON.
 *
 * Succeeds only when `canonicalEncode(result)` would be byte-identical to
 * `bytes`. Objects in the result are plain objects.
 *
 * @throws CanonicalError. When several problems are present the first
 *   applicable code in this precedence order is used: `invalid-utf8`,
 *   `invalid-json`, `duplicate-key`, `float`, `non-canonical`.
 */
export function canonicalDecode(bytes: Uint8Array): JsonValue {
  void bytes;
  throw new Error('not implemented');
}

/**
 * Lowercase hex SHA-256 of `bytes` (64 characters). This is the event file
 * name (without `.json`) for a file with these bytes.
 */
export function sha256Hex(bytes: Uint8Array): string {
  void bytes;
  throw new Error('not implemented');
}

/**
 * Lowercase hex SHA-256 of `canonicalEncode(value)`. Equal values give equal
 * hashes whatever their key insertion order.
 *
 * @throws CanonicalError exactly as `canonicalEncode` does.
 */
export function canonicalHash(value: unknown): string {
  void value;
  throw new Error('not implemented');
}
