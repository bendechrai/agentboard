/**
 * Duration parsers and lease display (add-claim-leases tasks 3.1 and 3.2;
 * board-cli: "Leases on the command line", "Waiting on the command line",
 * "Board settings command"): the ttl, timeout and setting forms and
 * ranges, the duration and remaining-time formats, the lease state at a
 * clock reading, and the `list` assignee token. All pure.
 */

import { describe, expect, it } from 'vitest';

import type { Lease, Ticket, Waiter } from '../../events/fold.js';
import { LEASE_SKEW_MS, TTL_MAX_MS, TTL_MIN_MS } from '../../events/schema.js';
import {
  TIMEOUT_MAX_MS,
  TIMEOUT_MIN_MS,
  assigneeToken,
  formatDuration,
  formatRemaining,
  isoTime,
  leaseDocument,
  parseSetting,
  parseTimeout,
  parseTtl,
} from '../leases.js';
import { expectBoardError } from './helpers.js';

const TTL_MESSAGE = (text: string): string =>
  `invalid --ttl ${text}: a ttl is <n>s, <n>m, <n>h or <n>d with <n> of 1 to 5 digits, from 30s to 7d`;
const TIMEOUT_MESSAGE = (text: string): string =>
  `invalid --timeout ${text}: a timeout is <n>s, <n>m, <n>h or <n>d with <n> of 1 to 5 digits, from 1s to 1d`;
// The refused value is never repeated: a token pasted as a value must not
// land in a terminal or a log (review round 2 ruling).
const SETTING_MESSAGE =
  'invalid value: a setting is <n>s or <n>m with <n> of 1 to 5 digits, from 30s to 10m';

describe('parseTtl', () => {
  it.each([
    ['30s', 30_000],
    ['10m', 600_000],
    ['7d', 604_800_000],
    ['2h', 7_200_000],
    ['90s', 90_000],
    ['1d', 86_400_000],
    ['168h', 604_800_000],
    ['10080m', 604_800_000],
    ['030s', 30_000],
    ['00001m', 60_000],
    ['99999s', 99_999_000],
  ])('accepts %s as %d ms', (text, ms) => {
    expect(parseTtl(text)).toBe(ms);
  });

  it('accepts exactly the bounds', () => {
    expect(parseTtl('30s')).toBe(TTL_MIN_MS);
    expect(parseTtl('7d')).toBe(TTL_MAX_MS);
  });

  it.each([
    '29s',
    '8d',
    '0m',
    '10min',
    'm',
    '-1m',
    '0s',
    '169h',
    '10081m',
    '1.5h',
    '30S',
    '30',
    ' 30s',
    '30s ',
    '+30s',
    '100000s',
    '',
    '1w',
    '30ms',
    '2h30m',
  ])('refuses %j with exit 1 usage naming the form and the 30s to 7d range', (text) => {
    const err = expectBoardError(() => parseTtl(text), 1, 'usage');
    expect(err.message).toBe(TTL_MESSAGE(text));
  });

  it('passes the refused text through asciiText', () => {
    const odd = `5${String.fromCharCode(0xe9)}`;
    const err = expectBoardError(() => parseTtl(odd), 1, 'usage');
    expect(err.message).toMatch(/^[\x20-\x7e]+$/);
    expect(err.message).toContain('5\\u00E9');
  });
});

describe('parseTimeout', () => {
  it.each([
    ['1s', 1000],
    ['30s', 30_000],
    ['10m', 600_000],
    ['24h', 86_400_000],
    ['1d', 86_400_000],
    ['1440m', 86_400_000],
    ['86400s', 86_400_000],
  ])('accepts %s as %d ms', (text, ms) => {
    expect(parseTimeout(text)).toBe(ms);
  });

  it('accepts exactly the bounds', () => {
    expect(parseTimeout('1s')).toBe(TIMEOUT_MIN_MS);
    expect(parseTimeout('1d')).toBe(TIMEOUT_MAX_MS);
  });

  it.each(['0s', '2d', '25h', '86401s', '1441m', '10min', 'm', '-1m', '', '1.5s', '100000s'])(
    'refuses %j with exit 1 usage naming the form and the 1s to 1d range',
    (text) => {
      const err = expectBoardError(() => parseTimeout(text), 1, 'usage');
      expect(err.message).toBe(TIMEOUT_MESSAGE(text));
    },
  );
});

describe('parseSetting', () => {
  it.each([
    ['30s', 30_000],
    ['90s', 90_000],
    ['5m', 300_000],
    ['600s', 600_000],
    ['10m', 600_000],
    ['2m', 120_000],
  ])('accepts %s as %d ms', (text, ms) => {
    expect(parseSetting(text)).toBe(ms);
  });

  it.each(['29s', '11m', '601s', '1h', '0m', '5min', 'm', '-1m', '', '1d', 'x'])(
    'refuses %j with exit 1 usage naming the form and the 30s to 10m range',
    (text) => {
      const err = expectBoardError(() => parseSetting(text), 1, 'usage');
      expect(err.message).toBe(SETTING_MESSAGE);
    },
  );
});

describe('formatDuration', () => {
  it.each([
    [604_800_000, '7d'],
    [86_400_000, '1d'],
    [7_200_000, '2h'],
    [3_600_000, '1h'],
    [1_800_000, '30m'],
    [5_400_000, '90m'],
    [120_000, '2m'],
    [90_000, '90s'],
    [30_000, '30s'],
    [30_500, '30500ms'],
    [0, '0s'],
  ])('writes %d as %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe('formatRemaining', () => {
  it.each([
    [1_800_000, '30m'],
    [1_799_999, '29m'],
    [120_000, '2m'],
    [90_000, '1m'],
    [60_001, '1m'],
    [60_000, '1m'],
    [59_999, '59s'],
    [1000, '1s'],
    [999, '0s'],
    [0, '0s'],
    [3_600_000, '1h'],
    [7_199_999, '1h'],
    [86_400_000, '1d'],
    [90_000_000, '1d'],
    [604_800_000, '7d'],
  ])('rounds %d down to %s', (ms, text) => {
    expect(formatRemaining(ms)).toBe(text);
  });
});

describe('isoTime', () => {
  it('is the ISO 8601 UTC time with milliseconds', () => {
    expect(isoTime(Date.UTC(2026, 9, 26, 12, 0, 0))).toBe('2026-10-26T12:00:00.000Z');
    expect(isoTime(Date.UTC(2026, 9, 26, 12, 0, 0) + 1)).toBe('2026-10-26T12:00:00.001Z');
    expect(isoTime(0)).toBe('1970-01-01T00:00:00.000Z');
  });
});

const LEASE: Lease = {
  ttl: 1_800_000,
  expiresAt: 1_000_000,
  event: 'e'.repeat(64),
  confirmed: false,
};

describe('leaseDocument', () => {
  it('is live before expiresAt', () => {
    expect(leaseDocument(LEASE, 999_999)).toEqual({
      ttl: 1_800_000,
      expiresAt: 1_000_000,
      event: 'e'.repeat(64),
      confirmed: false,
      state: 'live',
      claimableAt: 1_000_000 + LEASE_SKEW_MS,
    });
  });

  it('is expired from expiresAt until the tolerance, claimable from expiresAt + 60000', () => {
    expect(leaseDocument(LEASE, 1_000_000).state).toBe('expired');
    expect(leaseDocument(LEASE, 1_059_999).state).toBe('expired');
    expect(leaseDocument(LEASE, 1_060_000).state).toBe('claimable');
    expect(leaseDocument(LEASE, 9_000_000).state).toBe('claimable');
  });

  it('copies the lease, keeps confirmed, and does not change its argument', () => {
    const confirmed: Lease = { ...LEASE, confirmed: true };
    const doc = leaseDocument(confirmed, 0);
    expect(doc).toMatchObject({ confirmed: true, state: 'live', claimableAt: 1_060_000 });
    expect(confirmed).toEqual({ ...LEASE, confirmed: true });
    expect(Object.keys(doc)).toEqual([
      'ttl',
      'expiresAt',
      'event',
      'confirmed',
      'state',
      'claimableAt',
    ]);
  });
});

const TS = { wall: 1, counter: 0, actor: 'x' };

function ticket(assignee: string | null, lease: Lease | null, waiters = 0): Ticket {
  const queue: Waiter[] = Array.from({ length: waiters }, (_, i) => ({
    actor: `w-${String(i)}`,
    ttl: 60_000,
    event: String(i).repeat(64),
    joined: TS,
  }));
  return {
    id: '01ARYZ6S41TSV4RRFFQ69G5FAV',
    title: 't',
    description: null,
    status: 'todo',
    blockedFrom: null,
    assignee,
    lease,
    queue,
    available: null,
    labels: [],
    task: null,
    adhoc: 'x',
    unplanned: null,
    checklist: [],
    comments: [],
    links: [],
    closed: false,
    superseded: null,
    disposition: null,
    createdBy: 'x',
    createdAt: TS,
    version: 1,
    updatedAt: TS,
  };
}

describe('assigneeToken', () => {
  it('scenario: the spec example merger-1*+2m^3', () => {
    expect(assigneeToken(ticket('merger-1', { ...LEASE, expiresAt: 120_000 }, 3), 0)).toBe(
      'merger-1*+2m^3',
    );
  });

  it('a confirmed live lease has no star', () => {
    expect(
      assigneeToken(ticket('merger-1', { ...LEASE, confirmed: true, expiresAt: 1_800_000 }), 0),
    ).toBe('merger-1+30m');
  });

  it('expired and claimable replace the remaining time', () => {
    expect(assigneeToken(ticket('h', LEASE), 1_000_000)).toBe('h*!expired');
    expect(assigneeToken(ticket('h', LEASE), 1_060_000)).toBe('h*!claimable');
    expect(assigneeToken(ticket('h', { ...LEASE, confirmed: true }), 1_059_999)).toBe('h!expired');
  });

  it('a hold without a lease, a free ticket, and waiters without a lease', () => {
    expect(assigneeToken(ticket('impl', null), 0)).toBe('impl');
    expect(assigneeToken(ticket(null, null), 0)).toBe('-');
    expect(assigneeToken(ticket('merger-1', null, 2), 0)).toBe('merger-1^2');
    expect(assigneeToken(ticket(null, null, 1), 0)).toBe('-^1');
  });

  it('the remaining time is rounded down', () => {
    expect(assigneeToken(ticket('h', { ...LEASE, expiresAt: 90_000 }), 0)).toBe('h*+1m');
    expect(assigneeToken(ticket('h', { ...LEASE, expiresAt: 999 }), 0)).toBe('h*+0s');
  });

  it('passes the actor through asciiText', () => {
    const odd = `r${String.fromCharCode(0xe9)}`;
    expect(assigneeToken(ticket(odd, null), 0)).toBe('r\\u00E9');
  });
});
