/**
 * Decoding raw terminal input bytes into keys (board-tui: "Keys").
 *
 * Pure and browser-safe like the view-model: no IO, no clock, no
 * randomness, and no `node:` import, directly or transitively (the layering
 * test in `src/__tests__/layering.test.ts` enforces this). The terminal
 * driver (`terminal.ts`) feeds every chunk it reads from stdin in raw mode to
 * `decodeKeys`, keeps the returned `pending` bytes for the next chunk, and
 * calls `flushKeys` when no further byte arrives shortly after a chunk
 * that left bytes pending (so a lone Escape key press is not held back).
 */

/** The keys `top` distinguishes, other than printable characters. */
export type NamedKey =
  | 'enter'
  | 'escape'
  | 'backspace'
  | 'tab'
  | 'ctrl-c'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'pageup'
  | 'pagedown';

/** A decoded key: a named key, or one printable ASCII character. */
export type Key =
  | { name: NamedKey }
  | {
      name: 'char';
      /** Exactly one character from 0x20 (space) to 0x7E (`~`). */
      char: string;
    };

/** The result of decoding one chunk of input. */
export interface DecodeResult {
  /** The keys decoded, in input order. */
  keys: Key[];
  /**
   * The bytes at the end of the input that start an escape sequence not
   * yet complete, to be passed back as `pending` with the next chunk (or
   * to `flushKeys`). Empty when nothing is pending. Never longer than
   * `MAX_SEQUENCE_BYTES`.
   */
  pending: Uint8Array;
}

/**
 * The longest escape sequence kept pending, in bytes (ESC included). A CSI
 * sequence that reaches this length without its final byte is dropped (it
 * is unknown), and decoding resumes after it.
 */
export const MAX_SEQUENCE_BYTES = 16;

const ESC = 27;
const CSI_INTRODUCER = 0x5b; // [
const SS3_INTRODUCER = 0x4f; // O
const EMPTY = new Uint8Array(0);

/** The arrow keys by the final byte of `ESC [ X` or `ESC O X` (A to D). */
const ARROWS: Readonly<Record<number, NamedKey>> = {
  0x41: 'up',
  0x42: 'down',
  0x43: 'right',
  0x44: 'left',
};

/** The key of a single byte outside an escape sequence, or null when it is ignored. */
function byteKey(byte: number): Key | null {
  if (byte >= 0x20 && byte <= 0x7e) {
    return { name: 'char', char: String.fromCharCode(byte) };
  }
  switch (byte) {
    case 0x0d:
    case 0x0a:
      return { name: 'enter' };
    case 0x09:
      return { name: 'tab' };
    case 0x7f:
    case 0x08:
      return { name: 'backspace' };
    case 0x03:
      return { name: 'ctrl-c' };
    default:
      return null;
  }
}

/** The key of a complete CSI sequence (parameter bytes and final byte), or null. */
function csiKey(params: Uint8Array, final: number): Key | null {
  if (params.length === 0) {
    const arrow = ARROWS[final];
    return arrow === undefined ? null : { name: arrow };
  }
  if (params.length === 1 && final === 0x7e) {
    if (params[0] === 0x35) {
      return { name: 'pageup' };
    }
    if (params[0] === 0x36) {
      return { name: 'pagedown' };
    }
  }
  return null;
}

/**
 * The outcome of reading a CSI sequence starting at `start` (its ESC):
 * `next` is where decoding resumes, `key` the key decoded (or null), and
 * `pending` true when the input ended before the sequence did.
 */
interface SequenceRead {
  next: number;
  key: Key | null;
  pending: boolean;
}

function readCsi(bytes: Uint8Array, start: number): SequenceRead {
  let j = start + 2;
  for (;;) {
    if (j - start >= MAX_SEQUENCE_BYTES) {
      return { next: j, key: null, pending: false };
    }
    const byte = bytes[j];
    if (byte === undefined) {
      return { next: j, key: null, pending: true };
    }
    if (byte >= 0x20 && byte <= 0x3f) {
      j += 1;
    } else if (byte >= 0x40 && byte <= 0x7e) {
      return { next: j + 1, key: csiKey(bytes.subarray(start + 2, j), byte), pending: false };
    } else {
      return { next: j, key: null, pending: false };
    }
  }
}

function readEscape(bytes: Uint8Array, start: number): SequenceRead {
  const second = bytes[start + 1];
  if (second === undefined) {
    return { next: start + 1, key: null, pending: true };
  }
  if (second === CSI_INTRODUCER) {
    return readCsi(bytes, start);
  }
  if (second === SS3_INTRODUCER) {
    const third = bytes[start + 2];
    if (third === undefined) {
      return { next: start + 2, key: null, pending: true };
    }
    const arrow = ARROWS[third];
    return { next: start + 3, key: arrow === undefined ? null : { name: arrow }, pending: false };
  }
  return { next: start + 1, key: { name: 'escape' }, pending: false };
}

/**
 * Decodes `input`, preceded by the `pending` bytes of the previous call
 * (empty by default), into keys. Pure: neither array is modified. The
 * bytes (pending followed by input) are read left to right:
 *
 * - 0x20 to 0x7E: `{ name: 'char', char }` with that character.
 * - 0x0D (CR) and 0x0A (LF): `enter`, each one (CR LF gives two).
 * - 0x09: `tab`. 0x7F and 0x08: `backspace`. 0x03: `ctrl-c`.
 * - Any other byte below 0x20 except 0x1B, and every byte from 0x80 up
 *   (including every byte of a UTF-8 sequence): ignored, one byte at a
 *   time.
 * - 0x1B (ESC), then by the next byte:
 *   - none (ESC is the last byte): ESC is returned in `pending`.
 *   - `[` (CSI): the sequence is ESC `[`, then any number of parameter and
 *     intermediate bytes 0x20 to 0x3F, then one final byte 0x40 to 0x7E.
 *     `ESC [ A`, `B`, `C`, `D` (no parameter bytes) are `up`, `down`,
 *     `right`, `left`; `ESC [ 5 ~` is `pageup` and `ESC [ 6 ~` is
 *     `pagedown`. Every other complete CSI sequence (with modifiers such
 *     as `ESC [ 1 ; 5 A`, `ESC [ 3 ~`, `ESC [ Z`) is consumed and ignored.
 *     When the input ends before the final byte, the sequence so far is
 *     returned in `pending`, unless it already has `MAX_SEQUENCE_BYTES`
 *     bytes, in which case it is dropped. When a byte outside 0x20 to
 *     0x7E appears before the final byte, the sequence so far is dropped
 *     and decoding resumes at that byte.
 *   - `O` (SS3): the next byte completes the sequence. `ESC O A`, `B`,
 *     `C`, `D` are `up`, `down`, `right`, `left`; any other byte after
 *     `ESC O` is consumed with it and the sequence ignored. When the input
 *     ends right after `ESC O`, those two bytes are returned in `pending`.
 *   - any other byte (another ESC included): the first ESC is the
 *     `escape` key, and decoding resumes at that next byte (so ESC `q`
 *     gives `escape` then `q`).
 *
 * A sequence split across chunks at any byte decodes exactly as when it
 * arrives in one chunk, given the `pending` bytes are passed back.
 */
export function decodeKeys(
  input: Uint8Array,
  pending: Uint8Array = new Uint8Array(0),
): DecodeResult {
  const bytes = new Uint8Array(pending.length + input.length);
  bytes.set(pending, 0);
  bytes.set(input, pending.length);
  const keys: Key[] = [];
  let i = 0;
  while (i < bytes.length) {
    const byte = bytes[i] ?? 0;
    if (byte !== ESC) {
      const key = byteKey(byte);
      if (key !== null) {
        keys.push(key);
      }
      i += 1;
      continue;
    }
    const read = readEscape(bytes, i);
    if (read.pending) {
      return { keys, pending: bytes.slice(i) };
    }
    if (read.key !== null) {
      keys.push(read.key);
    }
    i = read.next;
  }
  return { keys, pending: EMPTY.slice() };
}

/**
 * The keys of `pending` bytes when no more input follows: `[{ name:
 * 'escape' }]` when `pending` is exactly one ESC byte (a lone Escape key
 * press), otherwise an empty list (an incomplete sequence is unknown and
 * ignored). Pure.
 */
export function flushKeys(pending: Uint8Array): Key[] {
  return pending.length === 1 && pending[0] === ESC ? [{ name: 'escape' }] : [];
}
