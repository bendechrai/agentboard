/**
 * Durations and lease display on the command line (board-cli: "Leases on
 * the command line", "Waiting on the command line", "Board settings
 * command"; add-claim-leases design.md: "Display is the only other place
 * the clock is read").
 *
 * The parsers turn the duration arguments of `claim`, `renew` and
 * `config set` into milliseconds, refusing anything else with
 * `BoardError(1, 'usage')`. The display helpers compute a lease's state
 * from a clock reading passed in by the caller (`list` and `show` read the
 * local clock once per command); nothing here reads a clock itself, and
 * nothing here is stored in the cache or used by the fold.
 */

import type { Lease, Ticket } from '../events/fold.js';

/** The longest `--timeout` of `claim --wait`: one day. */
export const TIMEOUT_MAX_MS = 86_400_000;

/** The shortest `--timeout` of `claim --wait`: one second. */
export const TIMEOUT_MIN_MS = 1_000;

/**
 * `--ttl <duration>` of `claim` and `renew` (and the `ttl` argument of
 * `board_claim` and `board_renew`), in milliseconds.
 *
 * Accepted: exactly 1 to 5 ASCII digits followed by one of `s`, `m`, `h`
 * or `d` (seconds, minutes, hours, days; leading zeros allowed), whose
 * value is between `TTL_MIN_MS` (30 seconds) and `TTL_MAX_MS` (7 days)
 * inclusive. So `30s`, `10m`, `2h` and `7d` are 30000, 600000, 7200000 and
 * 604800000.
 *
 * Refused with `BoardError(1, 'usage')`: anything else, for example `29s`
 * and `8d` (out of range), `0m`, `m` (no digits), `-1m`, `10min`, `1.5h`,
 * `30S`, ` 30s`, `100000s` (six digits) and the empty string. The message
 * is exactly
 * `invalid --ttl <text>: a ttl is <n>s, <n>m, <n>h or <n>d with <n> of 1 to 5 digits, from 30s to 7d`
 * with `<text>` passed through `asciiText`.
 *
 * Pure.
 */
export function parseTtl(text: string): number {
  void text;
  throw new Error('not implemented');
}

/**
 * `--timeout <duration>` of `claim --wait` (CLI only), in milliseconds:
 * the same form as `parseTtl` (1 to 5 digits and `s`, `m`, `h` or `d`),
 * between `TIMEOUT_MIN_MS` (1 second) and `TIMEOUT_MAX_MS` (1 day)
 * inclusive. So `1s`, `30s`, `10m` and `1d` are accepted, and `0s`, `2d`,
 * `25h`, `10min`, `m` and `-1m` are refused with `BoardError(1, 'usage')`
 * whose message is exactly
 * `invalid --timeout <text>: a timeout is <n>s, <n>m, <n>h or <n>d with <n> of 1 to 5 digits, from 1s to 1d`.
 * Pure.
 */
export function parseTimeout(text: string): number {
  void text;
  throw new Error('not implemented');
}

/**
 * The value of `config set <key> <value>`, in milliseconds: 1 to 5 digits
 * followed by `s` or `m` only, between `SETTING_MIN_MS` (30 seconds) and
 * `SETTING_MAX_MS` (10 minutes) inclusive. So `30s`, `90s`, `5m`, `600s`
 * and `10m` are accepted, and `29s`, `11m`, `1h`, `0m`, `5min`, `m` and
 * `-1m` are refused with `BoardError(1, 'usage')` whose message is exactly
 * `invalid value <text>: a setting is <n>s or <n>m with <n> of 1 to 5 digits, from 30s to 10m`.
 * Pure.
 */
export function parseSetting(text: string): number {
  void text;
  throw new Error('not implemented');
}

/**
 * A duration in milliseconds written in the largest unit that divides it
 * exactly, among `d`, `h`, `m` and `s` (board-view-model: "Activity feed
 * entries", the ttl rule), else in `ms`: 604800000 is `7d`, 7200000 `2h`,
 * 1800000 `30m`, 90000 `90s`, 30500 `30500ms`, 0 `0s`. Used for ttls,
 * windows and settings in `show`, `config get` and `config set`. Pure.
 */
export function formatDuration(ms: number): string {
  void ms;
  throw new Error('not implemented');
}

/**
 * The remaining time of a live lease, for the `list` assignee token
 * (`+<remaining>`): `ms` rounded down in the largest unit among `d`, `h`,
 * `m` and `s` that is not larger than it, so 1800000 is `30m`, 1799999
 * `29m`, 120000 `2m`, 90000 `1m`, 60001 `1m`, 59999 `59s`, 3600000 `1h`,
 * 90000000 `1d`, and anything under one second (0 included) `0s`. Pure.
 */
export function formatRemaining(ms: number): string {
  void ms;
  throw new Error('not implemented');
}

/** `ms` as an ISO 8601 UTC time with milliseconds (`new Date(ms).toISOString()`). Pure. */
export function isoTime(ms: number): string {
  void ms;
  throw new Error('not implemented');
}

/**
 * The state of a lease at a clock reading (board-cli: "Leases on the
 * command line"): `live` while `now < expiresAt`; `expired` from
 * `expiresAt` until `expiresAt + LEASE_SKEW_MS` (exclusive); `claimable`
 * from `expiresAt + LEASE_SKEW_MS` on.
 */
export type LeaseState = 'live' | 'expired' | 'claimable';

/**
 * A ticket's lease as `show --json` and `list --json` carry it: the folded
 * `Lease` (`ttl`, `expiresAt`, `event`, `confirmed`) plus the `state` at
 * the command's clock and `claimableAt`, the time from which another
 * actor may take it over (`expiresAt + LEASE_SKEW_MS`). Computed at read
 * time; never stored.
 */
export interface LeaseDocument extends Lease {
  state: LeaseState;
  claimableAt: number;
}

/**
 * The `LeaseDocument` of `lease` at `now`: a fresh object with the four
 * fields of `lease` copied, then `state` (see `LeaseState`) and
 * `claimableAt` = `lease.expiresAt + LEASE_SKEW_MS`, in that key order.
 * Pure.
 */
export function leaseDocument(lease: Lease, now: number): LeaseDocument {
  void lease;
  void now;
  throw new Error('not implemented');
}

/**
 * The assignee column of a `list` line (board-cli: "Leases on the command
 * line"): one token, the assignee (through `asciiText`) or `-` when
 * unassigned, then, when the ticket has a lease, `*` when it is not
 * confirmed, then `+<formatRemaining(expiresAt - now)>` while it is
 * `live`, `!expired` while `expired` and `!claimable` once `claimable`;
 * then `^<n>` when `n` > 0 actors are waiting. Examples: `merger-1*+2m^3`,
 * `impl-1+25m`, `impl-2*!expired`, `impl-3!claimable`, `merger-1^2` (held
 * without a lease, two waiters), `-^1` (unassigned with a waiter), `impl`
 * and `-`. Pure.
 */
export function assigneeToken(ticket: Ticket, now: number): string {
  void ticket;
  void now;
  throw new Error('not implemented');
}
