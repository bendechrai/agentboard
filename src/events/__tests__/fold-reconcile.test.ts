/**
 * Table tests for the re-import kinds in the fold (add-claim-leases tasks
 * 8.1 and 8.2; board-events: "Reconcile events", "Renumber and supersede
 * events", and the modified "Event kinds").
 *
 * Every event carries its real content hash. Expected states are written
 * out by hand from the spec.
 */

import { describe, expect, it } from 'vitest';

import { canonicalEncode, canonicalHash } from '../canonical.js';
import { fold, type FoldInput, type FoldResult, type Ticket } from '../fold.js';
import type { BoardEvent, TaskRef, TicketReconcileBody } from '../schema.js';

const T1 = '01ARYZ6S41TSV4RRFFQ69G5FAV';
const T2 = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const TASK: TaskRef = { source: 'openspec', ref: 'add-x', item: '5' };
const SOURCE = `openspec/changes/add-x/tasks.md@sha256:${'0'.repeat(64)}`;

function input(event: BoardEvent): FoldInput {
  return { hash: canonicalHash(event), event };
}

function ts(actor: string, wall: number): { actor: string; ts: BoardEvent['ts'] } {
  return { actor, ts: { wall, counter: 0, actor } };
}

const E = {
  create(
    wall: number,
    checklist: string[],
    extra: { task?: TaskRef; labels?: string[]; ticket?: string } = {},
  ): FoldInput {
    return input({
      v: 1,
      kind: 'ticket.create',
      ticket: extra.ticket ?? T1,
      ...ts('orch', wall),
      body: {
        title: 'Old title',
        checklist,
        task: extra.task ?? TASK,
        labels: extra.labels ?? ['change:add-x', `group:${(extra.task ?? TASK).item}`],
      },
    });
  },
  reconcile(wall: number, body: Partial<TicketReconcileBody>, ticket = T1): FoldInput {
    return input({
      v: 1,
      kind: 'ticket.reconcile',
      ticket,
      ...ts('orch', wall),
      body: { updated: [], removed: [], added: [], forced: false, source: SOURCE, ...body },
    });
  },
  tick(wall: number, index: number, done = true, actor = 'impl'): FoldInput {
    return input({
      v: 1,
      kind: 'ticket.checklist',
      ticket: T1,
      ...ts(actor, wall),
      body: { index, done },
    });
  },
  renumber(wall: number, from: string, to: string, ticket = T1): FoldInput {
    return input({
      v: 1,
      kind: 'ticket.renumber',
      ticket,
      ...ts('orch', wall),
      body: { from, to },
    });
  },
  supersede(wall: number, reason: string, ticket = T1): FoldInput {
    return input({
      v: 1,
      kind: 'ticket.supersede',
      ticket,
      ...ts('orch', wall),
      body: { reason },
    });
  },
  claim(wall: number, actor: string): FoldInput {
    return input({ v: 1, kind: 'ticket.claim', ticket: T1, ...ts(actor, wall), body: {} });
  },
  comment(wall: number, actor: string, text: string): FoldInput {
    return input({ v: 1, kind: 'ticket.comment', ticket: T1, ...ts(actor, wall), body: { text } });
  },
  move(wall: number, to: 'tests' | 'implementing' | 'review' | 'merged'): FoldInput {
    return input({ v: 1, kind: 'ticket.move', ticket: T1, ...ts('impl', wall), body: { to } });
  },
  close(wall: number): FoldInput {
    return input({
      v: 1,
      kind: 'ticket.close',
      ticket: T1,
      ...ts('orch', wall),
      body: { noDecision: true },
    });
  },
};

function ticketOf(result: FoldResult, id = T1): Ticket {
  const t = result.state.tickets[id];
  if (t === undefined) {
    throw new Error(`no ticket ${id}`);
  }
  return t;
}

function reasons(result: FoldResult): string[] {
  return result.rejected.map((r) => r.reason);
}

function json(value: unknown): string {
  return new TextDecoder().decode(canonicalEncode(value as never));
}

const ABC = ['1.1 A', '1.2 B', '1.3 C'];

describe('fold: ticket.reconcile (board-events: "Reconcile events")', () => {
  it('scenario: reconcile applies the whole diff in one event', () => {
    const create = E.create(1, ABC);
    const before = ticketOf(fold([create]));
    const result = fold([
      create,
      E.reconcile(2, {
        title: 'New title',
        updated: [{ index: 1, text: '1.2 B revised', done: false }],
        removed: [2],
        added: [{ text: '1.4 D', done: false }],
      }),
    ]);
    const t = ticketOf(result);
    expect(result.rejected).toEqual([]);
    expect(t.title).toBe('New title');
    expect(t.checklist).toEqual([
      { text: '1.1 A', done: false },
      { text: '1.2 B revised', done: false },
      { text: '1.3 C', done: false, removed: true },
      { text: '1.4 D', done: false },
    ]);
    expect(t.checklist.filter((line) => line.removed !== true).map((l) => l.text)).toEqual([
      '1.1 A',
      '1.2 B revised',
      '1.4 D',
    ]);
    expect(t.version).toBe(before.version + 1);
    expect(t.updatedAt).toEqual({ wall: 2, counter: 0, actor: 'orch' });
  });

  it('scenario: a tick on a removed line is rejected checklist-index', () => {
    const tick = E.tick(3, 2);
    const result = fold([E.create(1, ABC), E.reconcile(2, { removed: [2] }), tick]);
    expect(result.rejected).toEqual([
      { hash: tick.hash, kind: 'ticket.checklist', ticket: T1, reason: 'checklist-index' },
    ]);
    expect(ticketOf(result).checklist[2]).toEqual({ text: '1.3 C', done: false, removed: true });
    expect(ticketOf(result).version).toBe(2);
  });

  it('an untick of a removed line is rejected too', () => {
    const result = fold([
      E.create(1, ABC),
      E.tick(2, 2),
      E.reconcile(3, { removed: [2] }),
      E.tick(4, 2, false),
    ]);
    expect(reasons(result)).toEqual(['checklist-index']);
    expect(ticketOf(result).checklist[2]).toEqual({ text: '1.3 C', done: true, removed: true });
  });

  it('scenario: a reconcile naming a line already removed is rejected and changes nothing', () => {
    const create = E.create(1, ABC);
    const first = E.reconcile(2, { removed: [2] });
    const before = ticketOf(fold([create, first]));
    const second = E.reconcile(3, {
      title: 'Other',
      removed: [2],
      added: [{ text: '1.9 Z', done: true }],
    });
    const result = fold([create, first, second]);
    expect(result.rejected).toEqual([
      { hash: second.hash, kind: 'ticket.reconcile', ticket: T1, reason: 'checklist-index' },
    ]);
    expect(ticketOf(result)).toEqual(before);
  });

  it.each([
    ['an updated index beyond the checklist', { updated: [{ index: 3, text: 'x', done: false }] }],
    ['a removed index beyond the checklist', { removed: [3] }],
    ['a negative updated index', { updated: [{ index: -1, text: 'x', done: false }] }],
    ['a negative removed index', { removed: [-1] }],
    ['an index removed twice', { removed: [1, 1] }],
    [
      'an index updated twice',
      {
        updated: [
          { index: 0, text: 'x', done: false },
          { index: 0, text: 'y', done: true },
        ],
      },
    ],
    [
      'an index both updated and removed',
      { updated: [{ index: 0, text: 'x', done: false }], removed: [0] },
    ],
    ['an updated line that was removed', { updated: [{ index: 2, text: 'back', done: false }] }],
  ])('rejects %s with checklist-index, the whole event unapplied', (_name, body) => {
    const create = E.create(1, ABC);
    const removeC = E.reconcile(2, { removed: [2] });
    const before = ticketOf(fold([create, removeC]));
    const bad = E.reconcile(3, {
      title: 'Not applied',
      added: [{ text: 'n', done: false }],
      ...body,
    });
    const result = fold([create, removeC, bad]);
    expect(reasons(result)).toEqual(['checklist-index']);
    expect(ticketOf(result)).toEqual(before);
  });

  it('keeps every index: a line added after a removal is ticked at its own index', () => {
    const result = fold([
      E.create(1, ABC),
      E.reconcile(2, { removed: [0], added: [{ text: '1.4 D', done: false }] }),
      E.tick(3, 3),
      E.tick(4, 1),
    ]);
    expect(result.rejected).toEqual([]);
    expect(ticketOf(result).checklist).toEqual([
      { text: '1.1 A', done: false, removed: true },
      { text: '1.2 B', done: true },
      { text: '1.3 C', done: false },
      { text: '1.4 D', done: true },
    ]);
  });

  it('a tick written before the reconcile keeps its meaning: it ticks the old line', () => {
    const result = fold([
      E.create(1, ABC),
      E.tick(2, 2),
      E.reconcile(3, { removed: [2], added: [{ text: '1.3 C again', done: false }] }),
    ]);
    expect(ticketOf(result).checklist).toEqual([
      { text: '1.1 A', done: false },
      { text: '1.2 B', done: false },
      { text: '1.3 C', done: true, removed: true },
      { text: '1.3 C again', done: false },
    ]);
  });

  it('sets the done flag of updated lines from the event and keeps them active', () => {
    const result = fold([
      E.create(1, ABC),
      E.tick(2, 0),
      E.reconcile(3, {
        updated: [
          { index: 0, text: '1.1 A reworded', done: false },
          { index: 2, text: '1.3 C reworded', done: true },
        ],
      }),
    ]);
    expect(ticketOf(result).checklist).toEqual([
      { text: '1.1 A reworded', done: false },
      { text: '1.2 B', done: false },
      { text: '1.3 C reworded', done: true },
    ]);
    expect(ticketOf(result).title).toBe('Old title');
  });

  it('writes no removed key for a line that was never removed', () => {
    const t = ticketOf(fold([E.create(1, ABC), E.reconcile(2, { title: 'Renamed' })]));
    expect(json(t.checklist)).toBe(
      '[{"done":false,"text":"1.1 A"},{"done":false,"text":"1.2 B"},{"done":false,"text":"1.3 C"}]',
    );
    expect(t.title).toBe('Renamed');
    expect(t.version).toBe(2);
  });

  it('writes "removed":true in the canonical JSON of a removed line', () => {
    const t = ticketOf(fold([E.create(1, ['1.1 A']), E.reconcile(2, { removed: [0] })]));
    expect(json(t.checklist)).toBe('[{"done":false,"removed":true,"text":"1.1 A"}]');
  });

  it('ignores forced, holder and source in the state', () => {
    const plain = fold([E.create(1, ABC), E.reconcile(2, { removed: [1] })]);
    const forced = fold([
      E.create(1, ABC),
      E.reconcile(2, { removed: [1], forced: true, holder: 'impl', source: 'other@sha256:1' }),
    ]);
    expect(json(ticketOf(forced))).toBe(json(ticketOf(plain)));
  });

  it('applies to a closed ticket like any checklist event (the command never writes one)', () => {
    const result = fold([
      E.create(1, ['1.1 A']),
      E.move(2, 'tests'),
      E.move(3, 'implementing'),
      E.move(4, 'review'),
      E.move(5, 'merged'),
      E.close(6),
      E.reconcile(7, { added: [{ text: '1.2 B', done: false }] }),
    ]);
    expect(result.rejected).toEqual([]);
    expect(ticketOf(result).checklist).toHaveLength(2);
  });

  it('on an unknown ticket is rejected unknown-ticket', () => {
    const result = fold([E.reconcile(2, { removed: [0] })]);
    expect(reasons(result)).toEqual(['unknown-ticket']);
  });

  it('does not touch the status, assignee, labels, task or comments', () => {
    const base = [
      E.create(1, ABC),
      E.claim(2, 'impl'),
      E.move(3, 'tests'),
      E.comment(4, 'impl', 'hi'),
    ];
    const before = ticketOf(fold(base));
    const after = ticketOf(
      fold([...base, E.reconcile(5, { removed: [0], added: [{ text: 'x', done: true }] })]),
    );
    expect({
      status: after.status,
      assignee: after.assignee,
      labels: after.labels,
      task: after.task,
      comments: after.comments,
      superseded: after.superseded,
    }).toEqual({
      status: before.status,
      assignee: before.assignee,
      labels: before.labels,
      task: before.task,
      comments: before.comments,
      superseded: null,
    });
  });
});

describe('fold: ticket.renumber (board-events: "Renumber and supersede events")', () => {
  it('scenario: renumber keeps the work with the ticket', () => {
    const base = [
      E.create(1, ABC),
      E.claim(2, 'impl'),
      E.comment(3, 'impl', 'first'),
      E.comment(4, 'orch', 'second'),
      E.tick(5, 1),
    ];
    const before = ticketOf(fold(base));
    const result = fold([...base, E.renumber(6, '5', '6')]);
    const t = ticketOf(result);
    expect(result.rejected).toEqual([]);
    expect(t.task).toEqual({ source: 'openspec', ref: 'add-x', item: '6' });
    expect(t.labels).toEqual(['change:add-x', 'group:6']);
    expect(t.labels).not.toContain('group:5');
    expect(t.assignee).toBe('impl');
    expect(t.comments).toEqual(before.comments);
    expect(t.checklist).toEqual(before.checklist);
    expect(t.title).toBe(before.title);
    expect(t.status).toBe(before.status);
    expect(t.version).toBe(before.version + 1);
  });

  it('scenario: a stale renumber is rejected stale-import', () => {
    const stale = E.renumber(3, '5', '6');
    const result = fold([E.create(1, ABC), E.renumber(2, '5', '6'), stale]);
    expect(result.rejected).toEqual([
      { hash: stale.hash, kind: 'ticket.renumber', ticket: T1, reason: 'stale-import' },
    ]);
    expect(ticketOf(result).task?.item).toBe('6');
    expect(ticketOf(result).version).toBe(2);
  });

  it('rejects a renumber of a ticket without a task reference', () => {
    const create = input({
      v: 1,
      kind: 'ticket.create',
      ticket: T1,
      ...ts('orch', 1),
      body: { title: 'ad hoc', adhoc: 'spike' },
    });
    expect(reasons(fold([create, E.renumber(2, '5', '6')]))).toEqual(['stale-import']);
  });

  it('rejects a renumber of a superseded ticket', () => {
    const result = fold([E.create(1, ABC), E.supersede(2, 'gone'), E.renumber(3, '5', '6')]);
    expect(reasons(result)).toEqual(['stale-import']);
    expect(ticketOf(result).task?.item).toBe('5');
  });

  it('swaps two tickets without a temporary number (items need not be unique)', () => {
    const two = E.create(1, ['2.1 x'], { task: { ...TASK, item: '2' }, ticket: T1 });
    const three = E.create(2, ['3.1 y'], { task: { ...TASK, item: '3' }, ticket: T2 });
    const result = fold([two, three, E.renumber(3, '2', '3', T1), E.renumber(4, '3', '2', T2)]);
    expect(result.rejected).toEqual([]);
    expect(ticketOf(result, T1).task?.item).toBe('3');
    expect(ticketOf(result, T1).labels).toEqual(['change:add-x', 'group:3']);
    expect(ticketOf(result, T2).task?.item).toBe('2');
    expect(ticketOf(result, T2).labels).toEqual(['change:add-x', 'group:2']);
  });

  it('replaces the group label in place, keeping the other labels and their order', () => {
    const result = fold([
      E.create(1, ABC, { labels: ['x', 'group:5', 'change:add-x', 'group:5'] }),
      E.renumber(2, '5', '7'),
    ]);
    expect(ticketOf(result).labels).toEqual(['x', 'group:7', 'change:add-x', 'group:7']);
  });

  it('appends group:<to> when the ticket has no group:<from> label', () => {
    const result = fold([E.create(1, ABC, { labels: ['change:add-x'] }), E.renumber(2, '5', '6')]);
    expect(ticketOf(result).labels).toEqual(['change:add-x', 'group:6']);
  });

  it('renumbers a closed ticket', () => {
    const result = fold([
      E.create(1, ['1.1 A']),
      E.move(2, 'tests'),
      E.move(3, 'implementing'),
      E.move(4, 'review'),
      E.move(5, 'merged'),
      E.close(6),
      E.renumber(7, '5', '4'),
    ]);
    expect(result.rejected).toEqual([]);
    expect(ticketOf(result).task?.item).toBe('4');
  });
});

describe('fold: ticket.supersede (board-events: "Renumber and supersede events")', () => {
  it('scenario: supersede keeps the record', () => {
    const base = [
      E.create(1, ABC),
      E.claim(2, 'impl'),
      E.move(3, 'tests'),
      E.move(4, 'implementing'),
      E.tick(5, 0),
      E.comment(6, 'impl', 'working'),
    ];
    const before = ticketOf(fold(base));
    const result = fold([...base, E.supersede(7, 'group removed from tasks.md')]);
    const t = ticketOf(result);
    expect(result.rejected).toEqual([]);
    expect(t.superseded).toBe('group removed from tasks.md');
    expect(t).toEqual({
      ...before,
      superseded: 'group removed from tasks.md',
      version: before.version + 1,
      updatedAt: { wall: 7, counter: 0, actor: 'orch' },
    });
    expect(t.status).toBe('implementing');
    expect(t.assignee).toBe('impl');
  });

  it('a new ticket is not superseded', () => {
    expect(ticketOf(fold([E.create(1, ABC)])).superseded).toBeNull();
  });

  it('rejects a second supersede with stale-import, keeping the first reason', () => {
    const second = E.supersede(3, 'again');
    const result = fold([E.create(1, ABC), E.supersede(2, 'first'), second]);
    expect(result.rejected).toEqual([
      { hash: second.hash, kind: 'ticket.supersede', ticket: T1, reason: 'stale-import' },
    ]);
    expect(ticketOf(result).superseded).toBe('first');
  });

  it('still folds other events on a superseded ticket by their own rules', () => {
    const result = fold([
      E.create(1, ABC),
      E.supersede(2, 'gone'),
      E.claim(3, 'impl'),
      E.comment(4, 'impl', 'still here'),
      E.tick(5, 0),
    ]);
    expect(result.rejected).toEqual([]);
    expect(ticketOf(result)).toMatchObject({ assignee: 'impl', superseded: 'gone' });
  });
});
