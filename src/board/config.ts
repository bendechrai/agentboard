/**
 * Board settings: `config set <key> <value>` and `config get [<key>]`
 * (board-cli: "Board settings command"; board-events: "Board lease
 * settings"; add-claim-leases design.md: "Board settings").
 *
 * The two settings are `board.meta` values in milliseconds: `lease.grace`,
 * the grace a leased claim records, and `queue.window`, the acceptance
 * window of a grant. `config` is a setup command run in a shell; it is
 * not an MCP tool.
 */

import type { Board } from '../store/board.js';
import type { WriteOptions } from './types.js';

/** The setting keys `config` accepts, in this order. */
export const SETTING_KEYS = ['lease.grace', 'queue.window'] as const;

/** One of `SETTING_KEYS`. */
export type SettingKey = (typeof SETTING_KEYS)[number];

/** One effective setting, as `config get` reports it. */
export interface ConfigSetting {
  key: SettingKey;
  /** The effective value in milliseconds (`leaseGrace` or `queueWindow` of the folded meta). */
  value: number;
  /**
   * True when the default is in effect: no `board.meta` event set the key,
   * or the last one set a value the fold ignores (not a safe integer in
   * `SETTING_MIN_MS`..`SETTING_MAX_MS`).
   */
  default: boolean;
}

/** Result of `getConfig`; also the `config get --json` document. */
export interface ConfigResult {
  /** The requested setting, or both in `SETTING_KEYS` order. */
  settings: ConfigSetting[];
}

/** Result of `setConfig`; also the `config set --json` document. */
export interface ConfigSetResult {
  /** Hash of the `board.meta` event written. */
  hash: string;
  key: SettingKey;
  /** The value written, in milliseconds. */
  value: number;
}

/**
 * `config set <key> <value>`: writes one `board.meta` event `{key, value}`
 * through `runCommand`, with `value` in milliseconds (the registry parses
 * the duration with `parseSetting`).
 *
 * Refused before anything is written, with `BoardError(1, 'usage')`:
 * - `key` not one of `SETTING_KEYS`: the message names the key given
 *   (through `asciiText`) and lists `lease.grace` and `queue.window`;
 * - `value` not a safe integer in `SETTING_MIN_MS`..`SETTING_MAX_MS`.
 *
 * Setting a key to the value it already has still writes an event (the
 * history records every setting). The new value applies to claims written
 * and grants derived after the event in fold order; an existing claim
 * keeps the grace it recorded.
 *
 * @throws BoardError exit 1 `missing-actor` when `actor` is empty.
 */
export function setConfig(
  board: Board,
  actor: string,
  input: { key: string; value: number },
  options?: WriteOptions,
): ConfigSetResult {
  void board;
  void actor;
  void input;
  void options;
  throw new Error('not implemented');
}

/**
 * `config get [<key>]`: the effective value of `key`, or of both keys in
 * `SETTING_KEYS` order when `key` is undefined, read from the cache's
 * folded meta in one read snapshot (after the catch-up of the board open).
 * Needs no actor.
 *
 * @throws BoardError exit 1 `usage` for a key not in `SETTING_KEYS`, with
 *   the same message as `setConfig`.
 */
export function getConfig(board: Board, key?: string): ConfigResult {
  void board;
  void key;
  throw new Error('not implemented');
}
