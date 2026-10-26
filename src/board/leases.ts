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
import {
  LEASE_SKEW_MS,
  SETTING_MAX_MS,
  SETTING_MIN_MS,
  TTL_MAX_MS,
  TTL_MIN_MS,
} from '../events/schema.js';
import { BoardError } from '../store/errors.js';
import { asciiText } from './text.js';

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
  return parseDuration(text, {
    units: 'smhd',
    min: TTL_MIN_MS,
    max: TTL_MAX_MS,
    message: (given) =>
      `invalid --ttl ${given}: a ttl is <n>s, <n>m, <n>h or <n>d with <n> of 1 to 5 digits, from 30s to 7d`,
  });
}

/** How a duration argument is parsed (see `parseDuration`). */
interface DurationForm {
  /** The unit letters accepted, each of `s`, `m`, `h` and `d`. */
  units: string;
  /** The smallest accepted value, in milliseconds. */
  min: number;
  /** The largest accepted value, in milliseconds. */
  max: number;
  /** The usage message for a refused text (already through `asciiText`). */
  message: (given: string) => string;
}

/** Milliseconds per unit letter. */
const UNIT_MS: Readonly<Record<string, number>> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * `text` as milliseconds when it is exactly 1 to 5 ASCII digits followed
 * by one of `form.units` and its value is within `form.min`..`form.max`;
 * otherwise `BoardError(1, 'usage')` with `form.message`.
 */
function parseDuration(text: string, form: DurationForm): number {
  const match = /^([0-9]{1,5})([a-z])$/.exec(text);
  const unit = match?.[2] ?? '';
  if (match === null || !form.units.includes(unit)) {
    throw new BoardError(1, 'usage', form.message(asciiText(text)));
  }
  const ms = Number(match[1]) * (UNIT_MS[unit] ?? 0);
  if (ms < form.min || ms > form.max) {
    throw new BoardError(1, 'usage', form.message(asciiText(text)));
  }
  return ms;
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
  return parseDuration(text, {
    units: 'smhd',
    min: TIMEOUT_MIN_MS,
    max: TIMEOUT_MAX_MS,
    message: (given) =>
      `invalid --timeout ${given}: a timeout is <n>s, <n>m, <n>h or <n>d with <n> of 1 to 5 digits, from 1s to 1d`,
  });
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
  return parseDuration(text, {
    units: 'sm',
    min: SETTING_MIN_MS,
    max: SETTING_MAX_MS,
    message: (given) =>
      `invalid value ${given}: a setting is <n>s or <n>m with <n> of 1 to 5 digits, from 30s to 10m`,
  });
}

/**
 * A duration in milliseconds written in the largest unit that divides it
 * exactly, among `d`, `h`, `m` and `s` (board-view-model: "Activity feed
 * entries", the ttl rule), else in `ms`: 604800000 is `7d`, 7200000 `2h`,
 * 1800000 `30m`, 90000 `90s`, 30500 `30500ms`, 0 `0s`. Used for ttls,
 * windows and settings in `show`, `config get` and `config set`. Pure.
 */
export function formatDuration(ms: number): string {
  if (ms === 0) {
    return '0s';
  }
  for (const unit of ['d', 'h', 'm', 's']) {
    const size = UNIT_MS[unit] ?? 1;
    if (ms % size === 0) {
      return `${String(ms / size)}${unit}`;
    }
  }
  return `${String(ms)}ms`;
}

/**
 * The remaining time of a live lease, for the `list` assignee token
 * (`+<remaining>`): `ms` rounded down in the largest unit among `d`, `h`,
 * `m` and `s` that is not larger than it, so 1800000 is `30m`, 1799999
 * `29m`, 120000 `2m`, 90000 `1m`, 60001 `1m`, 59999 `59s`, 3600000 `1h`,
 * 90000000 `1d`, and anything under one second (0 included) `0s`. Pure.
 */
export function formatRemaining(ms: number): string {
  for (const unit of ['d', 'h', 'm']) {
    const size = UNIT_MS[unit] ?? 1;
    if (ms >= size) {
      return `${String(Math.floor(ms / size))}${unit}`;
    }
  }
  return `${String(Math.max(0, Math.floor(ms / 1000)))}s`;
}

/** `ms` as an ISO 8601 UTC time with milliseconds (`new Date(ms).toISOString()`). Pure. */
export function isoTime(ms: number): string {
  return new Date(ms).toISOString();
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
  const claimableAt = lease.expiresAt + LEASE_SKEW_MS;
  return {
    ttl: lease.ttl,
    expiresAt: lease.expiresAt,
    event: lease.event,
    confirmed: lease.confirmed,
    state: leaseState(lease, now),
    claimableAt,
  };
}

/** The `LeaseState` of `lease` at `now` (see `LeaseState`). Pure. */
export function leaseState(lease: Lease, now: number): LeaseState {
  if (now < lease.expiresAt) {
    return 'live';
  }
  return now < lease.expiresAt + LEASE_SKEW_MS ? 'expired' : 'claimable';
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
  const { lease } = ticket;
  let token = ticket.assignee === null ? '-' : asciiText(ticket.assignee);
  if (lease !== null) {
    const state = leaseState(lease, now);
    token += lease.confirmed ? '' : '*';
    token += state === 'live' ? `+${formatRemaining(lease.expiresAt - now)}` : `!${state}`;
  }
  if (ticket.queue.length > 0) {
    token += `^${String(ticket.queue.length)}`;
  }
  return token;
}
