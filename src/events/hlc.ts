/**
 * Hybrid timestamps (board-events: "Hybrid timestamp construction",
 * "Deterministic ordering"; design.md: "Hybrid timestamp").
 *
 * Pure: the wall clock is always passed in.
 */

/**
 * The `ts` field of every event. `wall` is milliseconds since the Unix epoch
 * and `counter` a tie-breaker; both are non-negative safe integers. `actor`
 * repeats the event's actor and is a non-empty string.
 */
export interface Hlc {
  wall: number;
  counter: number;
  actor: string;
}

/**
 * Builds the timestamp for a new event written by `actor`.
 *
 * - `prev` is the timestamp of the board's latest known event (the maximum in
 *   fold order), or `null` for an empty board.
 * - When `prev` is `null` or `wallMs > prev.wall`, the result is
 *   `{ wall: wallMs, counter: 0, actor }`.
 * - Otherwise (`prev.wall >= wallMs`: same millisecond or the clock moved
 *   backwards) the result is `{ wall: prev.wall, counter: prev.counter + 1,
 *   actor }`.
 *
 * The result therefore always compares greater than `prev` on
 * `(wall, counter)`. `prev.actor` is ignored.
 *
 * @throws RangeError when `wallMs` is not a non-negative safe integer or
 *   `actor` is empty.
 */
export function nextHlc(prev: Hlc | null, wallMs: number, actor: string): Hlc {
  void prev;
  void wallMs;
  void actor;
  throw new Error('not implemented');
}

/**
 * Total order on timestamps: ascending by `wall`, then `counter`, then
 * `actor` by UTF-16 code unit order (the order of the `<` operator on
 * strings). Returns 0 only when all three fields are equal.
 */
export function compareHlc(a: Hlc, b: Hlc): -1 | 0 | 1 {
  void a;
  void b;
  throw new Error('not implemented');
}

/**
 * Text wire form of a timestamp, used where a single sortable string is
 * needed (cursors, cache columns):
 * `<wall as 16 decimal digits, zero-padded>-<counter as 16 decimal digits,
 * zero-padded>-<actor>`, for example
 * `0001469918176385-0000000000000002-impl`.
 *
 * Because the numeric parts are fixed width, comparing two encoded strings
 * with `<` gives the same order as `compareHlc` on the decoded values.
 *
 * @throws RangeError when `wall` or `counter` is not a non-negative safe
 *   integer or `actor` is empty.
 */
export function encodeHlc(ts: Hlc): string {
  void ts;
  throw new Error('not implemented');
}

/**
 * Inverse of `encodeHlc`. The actor is everything after the second `-` and
 * may itself contain `-`.
 *
 * @throws Error when `text` is not in the form `encodeHlc` produces (wrong
 *   digit counts, non-digits, empty actor, or a value above
 *   `Number.MAX_SAFE_INTEGER`).
 */
export function decodeHlc(text: string): Hlc {
  void text;
  throw new Error('not implemented');
}
