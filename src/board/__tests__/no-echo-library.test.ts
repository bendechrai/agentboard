/**
 * The library entry points repeat no refused input (no-echo-refusals tasks
 * 1.2 and 1.3; design.md "Audit" rows 12 to 17, 22 to 24 and 28 to 31;
 * board-cli "Refusals never repeat the refused input" and "Ticket ids in
 * refusals"): the id shape helper, ticket id resolution, the pure parsers
 * of task references and import targets, and the setting, ttl and timeout
 * checks that library callers reach without the command line parsers
 * refusing first. Each is called directly; the message is the design's
 * exact text and contains no part of the refused key, text or number
 * (other than the bounds it states).
 */

import { describe, expect, it, vi } from 'vitest';

import {
  AWS_KEY_ID,
  GITHUB_TOKEN,
  HEX_40,
  LONG_WORD,
  TOKEN_FIXTURES,
  expectNoLeak,
} from '../../__tests__/harness/secret-fixtures.js';
import type { BoardState, Ticket } from '../../events/fold.js';
import { BoardError } from '../../store/errors.js';
import { claimTicket } from '../actions.js';
import { getConfig, setConfig } from '../config.js';
import { parseImportTarget } from '../import.js';
import {
  MIN_PREFIX_LENGTH,
  isIdShaped,
  parseTaskFilter,
  resolveTicketId,
  taskRefFromArgs,
} from '../resolve.js';
import { waitForGrant } from '../wait.js';
import { create, eventCount, expectBoardError, setup } from './helpers.js';

// Machines under load: the refusal loops spawn and parse many times.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const NOT_AN_ID =
  'no ticket matches the id given, which is not a ticket id: an id is 26 characters of ' +
  'Crockford base32 (digits and letters other than I, L, O and U), or a unique prefix of ' +
  'at least 6 of them';

/** A board state holding tickets with these ids and nothing else. */
function boardState(...ids: string[]): BoardState {
  const tickets: Record<string, Ticket> = {};
  for (const id of ids) {
    tickets[id] = { id } as Ticket;
  }
  return { tickets, meta: {} };
}

/** The message of a BoardError `fn` throws with this exit code and reason. */
function messageOf(fn: () => unknown, exitCode: number, reason: string): string {
  return expectBoardError(fn, exitCode, reason).message;
}

describe('isIdShaped', () => {
  it('is true for 1 to 26 Crockford base32 characters in either case, the first 0 to 7', () => {
    for (const text of [
      '0',
      '7',
      '01J9K3',
      '01j9k3',
      '01J9K3ZZZZ',
      '0123456789ABCDEFGHJKMNPQRS',
      '0123456789abcdefghjkmnpqrs',
      '7TVWXYZ',
      '7tvwxyz',
      `7${'Z'.repeat(25)}`,
      `7${'z'.repeat(25)}`,
    ]) {
      expect(isIdShaped(text), text).toBe(true);
    }
  });

  it('is false for the empty string, more than 26 characters, I, L, O, U and any other character', () => {
    for (const text of [
      '',
      'Z'.repeat(27),
      `7${'Z'.repeat(26)}`,
      // Review round 1, F2: a first character of 8 to Z is no ULID.
      '8',
      '9',
      'Z',
      'z',
      'TVWXYZ',
      'tvwxyz',
      'Z'.repeat(26),
      `8${'0'.repeat(25)}`,
      'KZQ4XK9M2PVB8RT3NH6WD5YCFJ',
      'JBSWY3DPEHPK3PXP',
      'jbswy3dpehpk3pxp',
      // Review round 1, F3: no Unicode upper-casing into the alphabet
      // (U+017F LATIN SMALL LETTER LONG S upper-cases to S, U+FB06 LATIN
      // SMALL LIGATURE ST to ST).
      `01${String.fromCharCode(0x17f, 0x17f)}ABCDEFGH23`,
      `01${String.fromCharCode(0x17f)}`,
      `0${String.fromCharCode(0xfb06).repeat(12)}`,
      `01J9K3${String.fromCharCode(0xfb06)}`,
      '01J9K3I',
      '01J9K3L',
      '01J9K3O',
      '01J9K3U',
      '01j9k3i',
      '01j9k3l',
      '01j9k3o',
      '01j9k3u',
      '01NOPE0000',
      '01J9K3 ',
      ' 01J9K3',
      '01J9-K3',
      '01J9_K3',
      '01J9:K3',
      '01J9/K3',
      '01J9K3\n',
      `01J9K3${String.fromCharCode(0xe9)}`,
    ]) {
      expect(isIdShaped(text), JSON.stringify(text)).toBe(false);
    }
  });

  it('is false for every token fixture', () => {
    for (const f of TOKEN_FIXTURES) {
      expect(isIdShaped(f.value), f.name).toBe(false);
    }
  });
});

describe('resolveTicketId', () => {
  it('names an id-shaped unknown id or short prefix as given', () => {
    const state = boardState('01J9K3AAAAAAAAAAAAAAAAAAAA', '01J9K4CCCCCCCCCCCCCCCCCCCC');
    expect(messageOf(() => resolveTicketId(state, '01j9k3zzzz'), 4, 'unknown-ticket')).toBe(
      'no ticket matches 01j9k3zzzz',
    );
    const max = `7${'Z'.repeat(25)}`;
    expect(messageOf(() => resolveTicketId(state, max), 4, 'unknown-ticket')).toBe(
      `no ticket matches ${max}`,
    );
    expect(messageOf(() => resolveTicketId(state, '01j9k'), 1, 'id-too-short')).toBe(
      `ticket id prefix 01j9k is too short: give at least ${String(MIN_PREFIX_LENGTH)} characters`,
    );
  });

  it('never names text that is not id-shaped', () => {
    const state = boardState('01J9K3AAAAAAAAAAAAAAAAAAAA', '01J9K4CCCCCCCCCCCCCCCCCCCC');
    for (const text of [
      ...TOKEN_FIXTURES.map((f) => f.value),
      'Z'.repeat(27),
      'Z'.repeat(26),
      '01NOPE0000',
      `01${String.fromCharCode(0x17f, 0x17f)}ABCDEFGH23`,
      `0${String.fromCharCode(0xfb06).repeat(12)}`,
    ]) {
      const message = messageOf(() => resolveTicketId(state, text), 4, 'unknown-ticket');
      expect(message).toBe(NOT_AN_ID);
    }
    for (const text of [
      'gh_p1',
      'AKIL',
      'a:b',
      '',
      'ZZZZZ',
      'JBSWY',
      `0${String.fromCharCode(0x17f)}`,
    ]) {
      const message = messageOf(() => resolveTicketId(state, text), 1, 'id-too-short');
      expect(message).toBe('the ticket id given is too short: give at least 6 characters');
    }
  });
});

describe('the pure parsers of task arguments and import targets', () => {
  it('taskRefFromArgs: --task, --change and --group', () => {
    for (const f of TOKEN_FIXTURES) {
      const messages = [
        messageOf(() => taskRefFromArgs({ task: f.value }), 1, 'malformed-task-ref'),
        messageOf(
          () => taskRefFromArgs({ change: `${f.value}#2`, group: '1' }),
          1,
          'malformed-task-ref',
        ),
        messageOf(() => taskRefFromArgs({ change: 'c', group: f.value }), 1, 'malformed-task-ref'),
      ];
      expect(messages).toEqual([
        'malformed task reference: --task expects <source>:<ref>#<item>, for example openspec:add-board-core#3',
        'malformed change name: --change must be non-empty and contain no #',
        'malformed group: --group must be a positive decimal number such as 3',
      ]);
      expectNoLeak(f.name, messages, [f]);
    }
    expect(
      messageOf(() => taskRefFromArgs({ change: '', group: '1' }), 1, 'malformed-task-ref'),
    ).toBe('malformed change name: --change must be non-empty and contain no #');
  });

  it('parseTaskFilter', () => {
    for (const text of [...TOKEN_FIXTURES.map((f) => f.value), `${GITHUB_TOKEN}#1`, 'Bad:x']) {
      expect(messageOf(() => parseTaskFilter(text), 1, 'malformed-task-ref')).toBe(
        'malformed task filter: --task expects <source>:<ref>[#<item>]',
      );
    }
  });

  it('parseImportTarget', () => {
    for (const f of TOKEN_FIXTURES) {
      const messages = [
        messageOf(() => parseImportTarget(`${f.value}#1`), 1, 'malformed-task-ref'),
        messageOf(() => parseImportTarget(`Bad_${f.value}:x`), 1, 'malformed-task-ref'),
      ];
      expect(messages).toEqual([
        'the change given to import-change names an item (it contains #); import-change takes a whole change or <source>:<ref>',
        'the task source given to import-change must match /^[a-z][a-z0-9-]*$/',
      ]);
      expectNoLeak(f.name, messages, [f]);
    }
    expect(messageOf(() => parseImportTarget(`${LONG_WORD}:`), 1, 'usage')).toBe(
      'the change given to import-change names no ref after its source',
    );
  });
});

describe('library entry points with numbers and keys (rows 28 to 31)', () => {
  const SETTING_RANGE =
    'a setting is a whole number of milliseconds from 30000 (30s) to 600000 (10m)';
  const TTL_MESSAGE =
    'invalid ttl: a ttl is a whole number of milliseconds from 30000 (30s) to 604800000 (7d)';
  const TIMEOUT_MESSAGE =
    'invalid timeout: a timeout is a whole number of milliseconds from 1000 (1s) to 86400000 (1d)';
  /** Refused numbers whose digits appear in none of the messages above. */
  const NUMBERS = [999, 987_654_321, 123_456_789_012, 1.5, -42];

  it('an unknown setting key, to setConfig and getConfig (row 28)', () => {
    const { board } = setup();
    for (const key of [GITHUB_TOKEN, AWS_KEY_ID, HEX_40, LONG_WORD, 'lease.grase']) {
      const messages = [
        messageOf(() => setConfig(board, 'orch', { key, value: 60_000 }), 1, 'usage'),
        messageOf(() => getConfig(board, key), 1, 'usage'),
      ];
      for (const message of messages) {
        expect(message).toBe('unknown setting: the keys are lease.grace and queue.window');
      }
    }
    expect(eventCount(board)).toBe(0);
  });

  it('a setting value out of range names the key, not the number (row 29)', () => {
    const { board } = setup();
    for (const value of NUMBERS) {
      const message = messageOf(
        () => setConfig(board, 'orch', { key: 'queue.window', value }),
        1,
        'usage',
      );
      expect(message).toBe(`invalid value for queue.window: ${SETTING_RANGE}`);
      expect(message).not.toContain(String(value));
    }
    expect(eventCount(board)).toBe(0);
  });

  it('a ttl out of range to claimTicket (row 30)', () => {
    const { board } = setup();
    const ticket = create(board);
    const before = eventCount(board);
    for (const ttl of NUMBERS) {
      const message = messageOf(() => claimTicket(board, 'a', { id: ticket.id, ttl }), 1, 'usage');
      expect(message).toBe(TTL_MESSAGE);
      expect(message).not.toContain(String(ttl));
    }
    expect(eventCount(board)).toBe(before);
  });

  it('a ttl or timeout out of range to waitForGrant (rows 30 and 31)', async () => {
    const { board } = setup();
    const ticket = create(board);
    const before = eventCount(board);
    const signal = new AbortController().signal;
    for (const n of NUMBERS) {
      const ttlError = await waitForGrant(
        board,
        'a',
        { id: ticket.id, ttl: n, timeout: 5_000 },
        { signal },
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(ttlError).toBeInstanceOf(BoardError);
      expect((ttlError as BoardError).reason).toBe('usage');
      expect((ttlError as BoardError).message).toBe(TTL_MESSAGE);
      const timeoutError = await waitForGrant(
        board,
        'a',
        { id: ticket.id, ttl: 60_000, timeout: n },
        { signal },
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(timeoutError).toBeInstanceOf(BoardError);
      expect((timeoutError as BoardError).reason).toBe('usage');
      expect((timeoutError as BoardError).message).toBe(TIMEOUT_MESSAGE);
      expect((timeoutError as BoardError).message).not.toContain(String(n));
    }
    expect(eventCount(board)).toBe(before);
  });
});
