/**
 * Decoding raw terminal input bytes into keys (board-tui: "Keys";
 * add-board-tui task 1.1).
 *
 * Pure and browser-safe like the view-model: no IO, no clock, no
 * randomness, and no `node:` import, directly or transitively (the layering
 * test in `src/__tests__/layering.test.ts` enforces this). The terminal
 * driver (group 2) feeds every chunk it reads from stdin in raw mode to
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
  throw new Error(
    `not implemented: decodeKeys(${String(input.length)}, ${String(pending.length)})`,
  );
}

/**
 * The keys of `pending` bytes when no more input follows: `[{ name:
 * 'escape' }]` when `pending` is exactly one ESC byte (a lone Escape key
 * press), otherwise an empty list (an incomplete sequence is unknown and
 * ignored). Pure.
 */
export function flushKeys(pending: Uint8Array): Key[] {
  throw new Error(`not implemented: flushKeys(${String(pending.length)})`);
}
