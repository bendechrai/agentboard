import { describe, expect, it } from 'vitest';

import type { BoardState, Ticket } from '../../events/fold.js';
import { formatTaskRef, parseTaskRef } from '../../events/schema.js';
import {
  MIN_PREFIX_LENGTH,
  TASK_REF_FORM,
  parseTaskFilter,
  resolveTicketId,
  taskRefFromArgs,
} from '../resolve.js';
import { expectBoardError } from './helpers.js';

const A = '01J9K3AAAAAAAAAAAAAAAAAAAA';
const B = '01J9K3BBBBBBBBBBBBBBBBBBBB';
const C = '01J9K4CCCCCCCCCCCCCCCCCCCC';

function state(...ids: string[]): BoardState {
  const tickets: Record<string, Ticket> = {};
  for (const id of ids) {
    tickets[id] = { id } as Ticket;
  }
  return { tickets, meta: {} };
}

describe('resolveTicketId', () => {
  it('requires prefixes of at least 6 characters', () => {
    expect(MIN_PREFIX_LENGTH).toBe(6);
  });

  it('returns an exact id', () => {
    expect(resolveTicketId(state(A, B, C), A)).toBe(A);
  });

  it('resolves a unique prefix (scenario: prefix resolves a ticket)', () => {
    expect(resolveTicketId(state(A, C), '01J9K3')).toBe(A);
    expect(resolveTicketId(state(A, B, C), '01J9K3A')).toBe(A);
    expect(resolveTicketId(state(A, B, C), '01J9K4')).toBe(C);
  });

  it('is case-insensitive', () => {
    expect(resolveTicketId(state(A, C), '01j9k3a')).toBe(A);
    expect(resolveTicketId(state(A, C), A.toLowerCase())).toBe(A);
  });

  it('refuses an ambiguous prefix with exit 1, listing both full ids', () => {
    const err = expectBoardError(
      () => resolveTicketId(state(C, B, A), '01J9K3'),
      1,
      'ambiguous-id',
    );
    expect(err.message).toContain(A);
    expect(err.message).toContain(B);
    expect(err.message).not.toContain(C);
    expect(err.message.indexOf(A)).toBeLessThan(err.message.indexOf(B));
  });

  it('refuses a prefix shorter than 6 characters even when it is unique', () => {
    const err = expectBoardError(() => resolveTicketId(state(A), '01J9K'), 1, 'id-too-short');
    expect(err.message).toContain('6');
  });

  it('reports an unknown ticket with exit 4', () => {
    const err = expectBoardError(() => resolveTicketId(state(A), '01NOPE00'), 4, 'unknown-ticket');
    expect(err.message).toContain('01NOPE00');
    expectBoardError(() => resolveTicketId(state(), A), 4, 'unknown-ticket');
  });
});

describe('taskRefFromArgs', () => {
  it('returns undefined when no task argument is given', () => {
    expect(taskRefFromArgs({})).toBeUndefined();
  });

  it('parses --task', () => {
    expect(taskRefFromArgs({ task: 'speckit:001-photo-albums#phase-2' })).toEqual({
      source: 'speckit',
      ref: '001-photo-albums',
      item: 'phase-2',
    });
  });

  it('--change X --group N is exactly --task openspec:X#N', () => {
    const short = taskRefFromArgs({ change: 'add-board-core', group: '3' });
    const long = taskRefFromArgs({ task: 'openspec:add-board-core#3' });
    expect(short).toEqual({ source: 'openspec', ref: 'add-board-core', item: '3' });
    expect(short).toEqual(long);
    expect(formatTaskRef(short ?? { source: '', ref: '', item: '' })).toBe(
      'openspec:add-board-core#3',
    );
  });

  it.each([
    'add-board-core-3',
    'openspec:add-board-core',
    'Open Spec:x#1',
    ':x#1',
    'openspec:#3',
    'openspec:x#',
  ])('refuses the malformed reference %j with exit 1, showing the form', (task) => {
    expect(parseTaskRef(task)).toBeNull();
    const err = expectBoardError(() => taskRefFromArgs({ task }), 1, 'malformed-task-ref');
    expect(TASK_REF_FORM).toBe('<source>:<ref>#<item>');
    expect(err.message).toContain(TASK_REF_FORM);
    expect(err.message).toContain(task);
  });

  it.each(['0', '03', '-1', 'x', '3a', ''])('refuses the group %j', (group) => {
    expectBoardError(
      () => taskRefFromArgs({ change: 'add-board-core', group }),
      1,
      'malformed-task-ref',
    );
  });

  it('refuses an empty change or one containing #', () => {
    expectBoardError(() => taskRefFromArgs({ change: '', group: '3' }), 1, 'malformed-task-ref');
    expectBoardError(() => taskRefFromArgs({ change: 'a#b', group: '3' }), 1, 'malformed-task-ref');
  });

  it('needs --change and --group together', () => {
    expectBoardError(() => taskRefFromArgs({ change: 'add-board-core' }), 1, 'usage');
    expectBoardError(() => taskRefFromArgs({ group: '3' }), 1, 'usage');
  });

  it('refuses --task together with --change or --group', () => {
    const task = 'openspec:add-board-core#3';
    expectBoardError(() => taskRefFromArgs({ task, change: 'x', group: '1' }), 1, 'usage');
    expectBoardError(() => taskRefFromArgs({ task, group: '1' }), 1, 'usage');
  });
});

describe('parseTaskFilter', () => {
  it('parses a full reference', () => {
    expect(parseTaskFilter('openspec:add-board-core#3')).toEqual({
      source: 'openspec',
      ref: 'add-board-core',
      item: '3',
    });
  });

  it('parses a reference without an item', () => {
    const filter = parseTaskFilter('openspec:add-board-core');
    expect(filter).toEqual({ source: 'openspec', ref: 'add-board-core' });
    expect('item' in filter).toBe(false);
  });

  it.each(['add-board-core', 'Open Spec:x', 'openspec:', ':x', 'openspec:x#'])(
    'refuses %j with exit 1',
    (text) => {
      const err = expectBoardError(() => parseTaskFilter(text), 1, 'malformed-task-ref');
      expect(err.message).toContain('<source>:<ref>[#<item>]');
    },
  );
});
