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

import { leaseGrace, queueWindow } from '../events/fold.js';
import { SETTING_MAX_MS, SETTING_MIN_MS } from '../events/schema.js';
import type { JsonValue } from '../events/canonical.js';
import type { Board } from '../store/board.js';
import { inSnapshot, loadMeta } from '../store/engine.js';
import { BoardError } from '../store/errors.js';
import { runCommand } from '../store/transaction.js';
import { requireActor } from './lookup.js';
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
 * - `key` not one of `SETTING_KEYS`: exactly `unknown setting: the keys
 *   are lease.grace and queue.window`;
 * - `value` not a safe integer in `SETTING_MIN_MS`..`SETTING_MAX_MS`:
 *   exactly `invalid value for <key>: a setting is a whole number of
 *   milliseconds from 30000 (30s) to 600000 (10m)` (the key is checked by
 *   then).
 * Neither message repeats the key or the number given (board-cli
 * "Refusals never repeat the refused input"): the library entry point
 * follows the same rule as the command line parsers that refuse first.
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
  requireActor(actor);
  const key = settingKey(input.key);
  const { value } = input;
  if (!Number.isSafeInteger(value) || value < SETTING_MIN_MS || value > SETTING_MAX_MS) {
    throw new BoardError(
      1,
      'usage',
      `invalid value for ${key}: a setting is a whole number of milliseconds from ${String(SETTING_MIN_MS)} (30s) to ${String(SETTING_MAX_MS)} (10m)`,
    );
  }
  const result = runCommand(
    board,
    actor,
    () => ({ ok: true, event: { kind: 'board.meta', body: { key, value } } }),
    options,
  );
  return { hash: result.hash, key, value };
}

/** `text` as a `SettingKey`, or `BoardError(1, 'usage')` listing the keys (not the text). */
function settingKey(text: string): SettingKey {
  const found = SETTING_KEYS.find((key) => key === text);
  if (found === undefined) {
    throw new BoardError(
      1,
      'usage',
      `unknown setting: the keys are ${SETTING_KEYS.join(' and ')}`,
    );
  }
  return found;
}

/**
 * The effective setting `key` in `meta`: the fold's value and whether the
 * default is in effect (no stored value, or one the fold ignores).
 */
function effective(meta: Readonly<Record<string, JsonValue>>, key: SettingKey): ConfigSetting {
  const value = key === 'lease.grace' ? leaseGrace(meta) : queueWindow(meta);
  const stored = Object.hasOwn(meta, key) ? meta[key] : undefined;
  const used =
    typeof stored === 'number' &&
    Number.isSafeInteger(stored) &&
    stored >= SETTING_MIN_MS &&
    stored <= SETTING_MAX_MS;
  return { key, value, default: !used };
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
  const keys = key === undefined ? SETTING_KEYS : [settingKey(key)];
  const meta = inSnapshot(board.db, () => loadMeta(board.db));
  return { settings: keys.map((k) => effective(meta, k)) };
}
