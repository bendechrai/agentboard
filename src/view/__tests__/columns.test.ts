import { describe, expect, it } from 'vitest';

import type { FoldInput, Ticket } from '../../events/fold.js';
import type { Status, TaskRef } from '../../events/schema.js';
import {
  BOARD_COLUMNS,
  CHANGED_WINDOW_MS,
  SHORT_ID_LENGTH,
  boardColumns,
  ticketCard,
  type Card,
  type Column,
} from '../columns.js';
import { E, OTHER, T1, T2, T3, T4, T5, T6, T7, TASK, TASK2, model, ticketOf } from './helpers.js';

const ORDER: Status[] = ['todo', 'tests', 'implementing', 'review', 'blocked', 'merged'];

/** Moves along the state machine from `todo` to `to` (any status but blocked). */
function path(ticket: string, to: Status): FoldInput[] {
  const steps: Status[] = ['tests', 'implementing', 'review', 'merged'];
  const out: FoldInput[] = [];
  for (const step of steps) {
    if (ORDER.indexOf(to) < ORDER.indexOf(step) || to === 'todo') {
      break;
    }
    out.push(E.move(ticket, step));
  }
  return out;
}

const ids = (column: Column | undefined): string[] => (column?.cards ?? []).map((c) => c.id);
const col = (columns: Column[], status: Status): Column | undefined =>
  columns.find((c) => c.status === status);

const create = (ticket: string, task: TaskRef = TASK, title = 'Ticket'): FoldInput =>
  E.create(ticket, { title, task });

describe('boardColumns: columns (board-view-model: "Board columns and cards")', () => {
  it('exports the column order todo, tests, implementing, review, blocked, merged', () => {
    expect([...BOARD_COLUMNS]).toEqual(ORDER);
    expect(CHANGED_WINDOW_MS).toBe(5000);
    expect(SHORT_ID_LENGTH).toBe(10);
  });

  it('returns all six columns in order, empty ones included, for an empty board', () => {
    expect(boardColumns({}, 0)).toEqual(ORDER.map((status) => ({ status, cards: [] })));
  });

  it('puts each ticket in the column of its status, blocked before merged', () => {
    const m = model([
      create(T1),
      create(T2),
      ...path(T2, 'tests'),
      create(T3),
      ...path(T3, 'implementing'),
      create(T4),
      ...path(T4, 'review'),
      create(T5),
      ...path(T5, 'merged'),
      create(T6),
      E.move(T6, 'blocked'),
    ]);
    const columns = boardColumns(m.tickets, 0);
    expect(columns.map((c) => c.status)).toEqual(ORDER);
    expect(columns.map(ids)).toEqual([[T1], [T2], [T3], [T4], [T6], [T5]]);
    for (const column of columns) {
      for (const card of column.cards) {
        expect(card.status).toBe(column.status);
      }
    }
  });

  it('scenario Blocked card remembers its origin', () => {
    const m = model([create(T1), ...path(T1, 'implementing'), E.move(T1, 'blocked')]);
    const columns = boardColumns(m.tickets, 0);
    expect(ids(col(columns, 'blocked'))).toEqual([T1]);
    expect(ids(col(columns, 'implementing'))).toEqual([]);
    expect(col(columns, 'blocked')?.cards[0]?.blockedFrom).toBe('implementing');
  });

  it('a card that is not blocked has no blocked origin', () => {
    const m = model([create(T1), E.move(T1, 'blocked'), E.move(T1, 'todo')]);
    expect(col(boardColumns(m.tickets, 0), 'todo')?.cards[0]?.blockedFrom).toBeNull();
  });

  it('scenario Closed tickets are hidden by default', () => {
    const m = model([
      create(T1),
      ...path(T1, 'merged'),
      create(T2),
      ...path(T2, 'merged'),
      E.close(T2, { noDecision: true }),
    ]);
    expect(ids(col(boardColumns(m.tickets, 0), 'merged'))).toEqual([T1]);
    expect(ids(col(boardColumns(m.tickets, 0, {}), 'merged'))).toEqual([T1]);
    expect(ids(col(boardColumns(m.tickets, 0, { includeClosed: false }), 'merged'))).toEqual([T1]);
    const all = boardColumns(m.tickets, 0, { includeClosed: true });
    expect(ids(col(all, 'merged')).sort()).toEqual([T1, T2].sort());
    expect(col(all, 'merged')?.cards.find((c) => c.id === T2)?.closed).toBe(true);
    expect(col(all, 'merged')?.cards.find((c) => c.id === T1)?.closed).toBe(false);
  });

  it('hides a closed blocked ticket too', () => {
    const m = model([create(T1), E.move(T1, 'blocked'), E.close(T1, { noDecision: true })]);
    expect(ids(col(boardColumns(m.tickets, 0), 'blocked'))).toEqual([]);
    expect(ids(col(boardColumns(m.tickets, 0, { includeClosed: true }), 'blocked'))).toEqual([T1]);
  });

  it('orders cards most recently updated first', () => {
    const m = model([
      create(T1, TASK, 'one'),
      create(T2, TASK, 'two'),
      create(T3, TASK, 'three'),
      E.comment(T1, 'bump', { wall: 5_000_000 }),
      E.comment(T3, 'bump', { wall: 4_000_000 }),
    ]);
    expect(ids(col(boardColumns(m.tickets, 0), 'todo'))).toEqual([T1, T3, T2]);
  });

  it('orders equal walls by counter, then actor, then ascending id', () => {
    const m = model([
      E.create(T1, { title: 'a', task: TASK }, { wall: 100, counter: 0, actor: 'a' }),
      E.create(T2, { title: 'b', task: TASK }, { wall: 100, counter: 1, actor: 'a' }),
      E.create(T3, { title: 'c', task: TASK }, { wall: 100, counter: 0, actor: 'b' }),
      E.create(T5, { title: 'e', task: TASK }, { wall: 50, counter: 0, actor: 'x' }),
      E.create(T4, { title: 'd', task: TASK }, { wall: 50, counter: 0, actor: 'x' }),
    ]);
    expect(ids(col(boardColumns(m.tickets, 0), 'todo'))).toEqual([T2, T3, T1, T4, T5]);
  });

  it('uses Ticket.id, not the record key', () => {
    const m = model([create(T1)]);
    const ticket = ticketOf(m, T1);
    expect(ids(col(boardColumns({ 'some-key': ticket }, 0), 'todo'))).toEqual([T1]);
  });
});

describe('boardColumns and ticketCard: card fields', () => {
  it('carries id, short id, title, status, assignee, task, labels and checklist progress', () => {
    const m = model([
      E.create(T1, {
        title: 'Build the feed',
        task: TASK,
        labels: ['web', 'feed', 'web'],
        checklist: ['one', 'two', 'three'],
      }),
      E.check(T1, 0, true),
      E.check(T1, 2, true),
      E.check(T1, 2, false),
      E.addLines(T1, [
        { text: 'four', done: true },
        { text: 'five', done: false },
      ]),
      E.claim(T1, { actor: 'impl-1' }),
    ]);
    const [card] = col(boardColumns(m.tickets, 0), 'todo')?.cards ?? [];
    expect(card).toMatchObject({
      id: T1,
      shortId: T1.slice(0, 10),
      title: 'Build the feed',
      status: 'todo',
      assignee: 'impl-1',
      task: 'openspec:add-board-web#1',
      adhoc: false,
      labels: ['web', 'feed', 'web'],
      checklist: { done: 2, total: 5 },
      blockedFrom: null,
      closed: false,
      openDecisions: 0,
    });
    expect(card?.shortId).toBe('01ARYZ6S41');
  });

  it('has exactly the documented fields', () => {
    const m = model([create(T1)]);
    const card = ticketCard(ticketOf(m, T1), 0);
    expect(Object.keys(card).sort()).toEqual(
      [
        'adhoc',
        'assignee',
        'blockedFrom',
        'changed',
        'checklist',
        'closed',
        'id',
        'labels',
        'openDecisions',
        'shortId',
        'status',
        'task',
        'title',
      ].sort(),
    );
  });

  it('shows no assignee, no labels and an empty checklist as null, [] and 0 of 0', () => {
    const m = model([create(T1)]);
    expect(ticketCard(ticketOf(m, T1), 0)).toMatchObject({
      assignee: null,
      labels: [],
      checklist: { done: 0, total: 0 },
    });
  });

  it('marks an ad hoc ticket and gives it no task text', () => {
    const m = model([E.create(T1, { title: 'x', adhoc: 'hotfix' })]);
    expect(ticketCard(ticketOf(m, T1), 0)).toMatchObject({ task: null, adhoc: true });
  });

  it('a ticket with neither task nor ad hoc reason has no task and no marker', () => {
    const m = model([E.create(T1, { title: 'x' })]);
    expect(ticketCard(ticketOf(m, T1), 0)).toMatchObject({ task: null, adhoc: false });
  });

  it('a task link replaces the ad hoc marker with the task text', () => {
    const m = model([
      E.create(T1, { title: 'x', adhoc: 'hotfix' }),
      E.link(T1, { task: { source: 'speckit', ref: '001-albums', item: 'phase-2' } }),
    ]);
    expect(ticketCard(ticketOf(m, T1), 0)).toMatchObject({
      task: 'speckit:001-albums#phase-2',
      adhoc: false,
    });
  });

  it('counts open DECISION: comments as openDecisions defines them, hand-off notes included', () => {
    const m = model([
      create(T1),
      E.comment(T1, 'DECISION: one', { actor: 'a' }),
      E.comment(T1, 'DECISION: two', { actor: 'b' }),
      E.comment(T1, 'decision: not a decision', { actor: 'b' }),
      E.comment(T1, 'RETRACTED: one', { actor: 'a' }),
      E.comment(T1, 'DECISION: three', { actor: 'a' }),
      E.handoff(T1, 'rev', 'todo', 'DECISION: four', { actor: 'c' }),
      E.comment(T1, 'RETRACTED: not yours', { actor: 'd' }),
    ]);
    expect(ticketCard(ticketOf(m, T1), 0).openDecisions).toBe(3);
  });

  it('is changed while the last update is less than 5 seconds before now', () => {
    const m = model([
      E.create(T1, { title: 'x', task: TASK }, { wall: 1_000 }),
      E.comment(T1, 'bump', { wall: 2_000_000 }),
    ]);
    const ticket = ticketOf(m, T1);
    expect(ticket.updatedAt.wall).toBe(2_000_000);
    expect(ticketCard(ticket, 2_000_000).changed).toBe(true);
    expect(ticketCard(ticket, 2_004_999).changed).toBe(true);
    expect(ticketCard(ticket, 2_005_000).changed).toBe(false);
    expect(ticketCard(ticket, 9_000_000).changed).toBe(false);
  });

  it('counts an update with a wall in the future as changed', () => {
    const m = model([E.create(T1, { title: 'x', task: TASK }, { wall: 2_000_000 })]);
    expect(ticketCard(ticketOf(m, T1), 1_000_000).changed).toBe(true);
  });

  it('boardColumns passes now to every card', () => {
    const m = model([
      E.create(T1, { title: 'old', task: TASK }, { wall: 1_000 }),
      E.create(T2, { title: 'new', task: TASK }, { wall: 100_000 }),
    ]);
    const cards = col(boardColumns(m.tickets, 102_000), 'todo')?.cards ?? [];
    expect(cards.map((c) => [c.id, c.changed])).toEqual([
      [T2, true],
      [T1, false],
    ]);
  });

  it('boardColumns cards equal ticketCard for the same ticket and now', () => {
    const m = model([create(T1), E.claim(T1, { actor: 'impl' })]);
    const [card] = col(boardColumns(m.tickets, 123), 'todo')?.cards ?? [];
    expect(card).toEqual(ticketCard(ticketOf(m, T1), 123));
  });

  it('does not share the labels array with the ticket', () => {
    const m = model([E.create(T1, { title: 'x', task: TASK, labels: ['a'] })]);
    const ticket: Ticket = ticketOf(m, T1);
    const card: Card = ticketCard(ticket, 0);
    expect(card.labels).toEqual(ticket.labels);
    expect(card.labels).not.toBe(ticket.labels);
  });
});

describe('boardColumns: filters', () => {
  // T1: TASK, impl. T2: TASK2, rev. T3: OTHER, impl. T4: ad hoc, impl.
  // T5: TASK, unassigned. T6: TASK, impl, merged and closed. T7: TASK, rev, blocked.
  const m = model([
    create(T1, TASK),
    E.claim(T1, { actor: 'impl' }),
    create(T2, TASK2),
    E.claim(T2, { actor: 'rev' }),
    create(T3, OTHER),
    E.claim(T3, { actor: 'impl' }),
    E.create(T4, { title: 'x', adhoc: 'hotfix' }),
    E.claim(T4, { actor: 'impl' }),
    create(T5, TASK),
    create(T6, TASK),
    ...path(T6, 'merged'),
    E.assign(T6, 'impl'),
    E.close(T6, { noDecision: true }),
    create(T7, TASK),
    E.move(T7, 'blocked'),
    E.assign(T7, 'rev'),
  ]);
  const all = (filters: Parameters<typeof boardColumns>[2]): string[] =>
    boardColumns(m.tickets, 0, filters)
      .flatMap((c) => c.cards.map((card) => card.id))
      .sort();

  it('no filter shows every open ticket', () => {
    expect(all({})).toEqual([T1, T2, T3, T4, T5, T7].sort());
  });

  it('filters by <source>:<ref>, whatever the item', () => {
    expect(all({ task: 'openspec:add-board-web' })).toEqual([T1, T2, T5, T7].sort());
    expect(all({ task: 'openspec:add-board-tui' })).toEqual([T3]);
  });

  it('filters by <source>:<ref>#<item> exactly', () => {
    expect(all({ task: 'openspec:add-board-web#2' })).toEqual([T2]);
    expect(all({ task: 'openspec:add-board-web#1' })).toEqual([T1, T5, T7].sort());
    expect(all({ task: 'openspec:add-board-web#9' })).toEqual([]);
  });

  it('a task filter never matches a prefix of the ref or another source', () => {
    expect(all({ task: 'openspec:add-board' })).toEqual([]);
    expect(all({ task: 'speckit:add-board-web' })).toEqual([]);
  });

  it('a task filter with no colon matches nothing', () => {
    expect(all({ task: 'add-board-web' })).toEqual([]);
  });

  it('filters by assignee exactly', () => {
    expect(all({ assignee: 'impl' })).toEqual([T1, T3, T4].sort());
    expect(all({ assignee: 'rev' })).toEqual([T2, T7].sort());
    expect(all({ assignee: 'imp' })).toEqual([]);
  });

  it('combines task and assignee with AND', () => {
    expect(all({ task: 'openspec:add-board-web', assignee: 'impl' })).toEqual([T1]);
    expect(all({ task: 'openspec:add-board-web', assignee: 'rev' })).toEqual([T2, T7].sort());
    expect(all({ task: 'openspec:add-board-tui', assignee: 'rev' })).toEqual([]);
  });

  it('combines filters with includeClosed', () => {
    expect(all({ assignee: 'impl', includeClosed: true })).toEqual([T1, T3, T4, T6].sort());
    expect(all({ task: 'openspec:add-board-web', assignee: 'impl', includeClosed: true })).toEqual(
      [T1, T6].sort(),
    );
  });

  it('keeps all six columns when a filter empties some', () => {
    const columns = boardColumns(m.tickets, 0, { assignee: 'nobody' });
    expect(columns).toEqual(ORDER.map((status) => ({ status, cards: [] })));
  });
});
