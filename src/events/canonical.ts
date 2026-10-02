/**
 * Canonical JSON for board events (board-events: "Event files are immutable
 * and content-addressed"; add-board-core design.md: "Canonical JSON").
 *
 * The canonical encoding of a value is the byte sequence that names an event
 * file, so it must be identical for equal values regardless of how they were
 * built. Pure: no IO, no clock, no randomness.
 */

import { createHash } from 'node:crypto';

import type { JsonValue } from './json.js';

export type { JsonObject, JsonValue } from './json.js';

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
  return new TextEncoder().encode(encodeValue(value, new Set()));
}

/** Canonical text of `value`; `ancestors` holds the containers being encoded, to detect cycles. */
function encodeValue(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new CanonicalError('float', `number ${String(value)} is not a safe integer`);
    }
    return JSON.stringify(value);
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    throw new CanonicalError('unsupported-type', `cannot encode a ${describe(value)}`);
  }
  const isArray = Array.isArray(value);
  const proto: unknown = Object.getPrototypeOf(value);
  if (!isArray && proto !== Object.prototype && proto !== null) {
    throw new CanonicalError('unsupported-type', `cannot encode a ${describe(value)}`);
  }
  ancestors.add(value);
  let text: string;
  if (isArray) {
    // for-of rather than map, so holes are visited (as undefined) and rejected.
    const parts: string[] = [];
    for (const item of value as unknown[]) {
      parts.push(encodeValue(item, ancestors));
    }
    text = `[${parts.join(',')}]`;
  } else {
    const record = value as Record<string, unknown>;
    const parts = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encodeValue(record[key], ancestors)}`);
    text = `{${parts.join(',')}}`;
  }
  ancestors.delete(value);
  return text;
}

function describe(value: unknown): string {
  return typeof value === 'object' ? 'cyclic or non-plain object' : typeof value;
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
  let text: string;
  try {
    // ignoreBOM keeps a leading byte order mark in the text, so it is later
    // reported as non-canonical rather than silently dropped.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new CanonicalError('invalid-utf8', 'input is not well-formed UTF-8');
  }
  const parser = new StrictParser(text.startsWith(BOM) ? text.slice(BOM.length) : text);
  const value = parser.parseDocument();
  if (parser.duplicateKey !== null) {
    throw new CanonicalError('duplicate-key', `duplicate object key ${parser.duplicateKey}`);
  }
  if (parser.float !== null) {
    throw new CanonicalError('float', `number ${parser.float} is not a safe integer`);
  }
  if (!sameBytes(canonicalEncode(value), bytes)) {
    throw new CanonicalError('non-canonical', 'input is valid JSON but not in canonical form');
  }
  return value;
}

const BOM = String.fromCharCode(0xfeff);

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

const NUMBER_TOKEN = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
// Raw control characters are not allowed inside a JSON string (RFC 8259).
// eslint-disable-next-line no-control-regex
const STRING_TOKEN = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
const LITERAL_TOKEN = /true|false|null/y;
const WHITESPACE = /[ \t\n\r]*/y;

/**
 * RFC 8259 recursive-descent parser. Syntax errors throw `invalid-json`
 * immediately; the first duplicate key and the first float are recorded
 * instead, so that the caller can apply the documented precedence once the
 * whole input is known to be JSON.
 */
class StrictParser {
  duplicateKey: string | null = null;
  float: string | null = null;
  private pos = 0;

  constructor(private readonly text: string) {}

  parseDocument(): JsonValue {
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.pos !== this.text.length) {
      this.fail();
    }
    return value;
  }

  private parseValue(): JsonValue {
    this.skipWhitespace();
    const ch = this.text[this.pos];
    if (ch === '{') {
      return this.parseObject();
    }
    if (ch === '[') {
      return this.parseArray();
    }
    if (ch === '"') {
      return this.parseString();
    }
    const literal = this.match(LITERAL_TOKEN);
    if (literal !== null) {
      return JSON.parse(literal) as JsonValue;
    }
    const number = this.match(NUMBER_TOKEN) ?? this.fail();
    const parsed = Number(number);
    if (this.float === null && (/[.eE]/.test(number) || !Number.isSafeInteger(parsed))) {
      this.float = number;
    }
    return parsed;
  }

  private parseObject(): JsonValue {
    this.pos += 1;
    const entries: [string, JsonValue][] = [];
    const seen = new Set<string>();
    if (!this.consume('}')) {
      do {
        this.skipWhitespace();
        const key = this.parseString();
        if (seen.has(key) && this.duplicateKey === null) {
          this.duplicateKey = JSON.stringify(key);
        }
        seen.add(key);
        this.skipWhitespace();
        this.expect(':');
        entries.push([key, this.parseValue()]);
      } while (this.consume(','));
      this.expect('}');
    }
    // fromEntries defines own properties, so a "__proto__" key stays data.
    return Object.fromEntries(entries) as JsonValue;
  }

  private parseArray(): JsonValue {
    this.pos += 1;
    const items: JsonValue[] = [];
    if (!this.consume(']')) {
      do {
        items.push(this.parseValue());
      } while (this.consume(','));
      this.expect(']');
    }
    return items;
  }

  private parseString(): string {
    return JSON.parse(this.match(STRING_TOKEN) ?? this.fail()) as string;
  }

  /** Skips whitespace, then consumes `ch` if it is next. */
  private consume(ch: string): boolean {
    this.skipWhitespace();
    if (this.text[this.pos] === ch) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expect(ch: string): void {
    if (!this.consume(ch)) {
      this.fail();
    }
  }

  private skipWhitespace(): void {
    this.match(WHITESPACE);
  }

  private match(token: RegExp): string | null {
    token.lastIndex = this.pos;
    const found = token.exec(this.text);
    if (found === null) {
      return null;
    }
    this.pos = token.lastIndex;
    return found[0];
  }

  private fail(): never {
    throw new CanonicalError('invalid-json', `invalid JSON at offset ${String(this.pos)}`);
  }
}

/**
 * Lowercase hex SHA-256 of `bytes` (64 characters). This is the event file
 * name (without `.json`) for a file with these bytes.
 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Lowercase hex SHA-256 of `canonicalEncode(value)`. Equal values give equal
 * hashes whatever their key insertion order.
 *
 * @throws CanonicalError exactly as `canonicalEncode` does.
 */
export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalEncode(value));
}
