import { describe, expect, it } from 'vitest';

import type { FoldInput } from '../../events/fold.js';
import type { TaskRef } from '../../events/schema.js';
import { handoffGraph, type HandoffRef } from '../graph.js';
import { E, T1, T2, T3, T4, T5, T6, T7, TASK, model } from './helpers.js';

// board-insights: "Hand-off graph".

function refOf(input: FoldInput): HandoffRef {
  const { event } = input;
  if (event.kind !== 'ticket.handoff' || !('ticket' in event) || !('body' in event)) {
    throw new Error('not a handoff');
  }
  const body = event.body as { status: HandoffRef['status']; note: string };
  return {
    hash: input.hash,
    ticket: event.ticket,
    ts: event.ts,
    status: body.status,
    note: body.note,
  };
}

const login = (item: string): TaskRef => ({ source: 'openspec', ref: 'add-login', item });

describe('handoffGraph', () => {
  it('is empty for no events', () => {
    expect(handoffGraph([])).toEqual({ nodes: [], edges: [] });
  });

  it('scenario "Counts per pair": edges with counts and node totals', () => {
    const first = E.handoff(T1, 'impl-1', 'todo', 'tests ready', { actor: 'test-1', wall: 100 });
    const second = E.handoff(T2, 'impl-1', 'todo', 'more tests', { actor: 'test-1', wall: 200 });
    const third = E.handoff(T1, 'reviewer-1', 'todo', 'please review', {
      actor: 'impl-1',
      wall: 300,
    });
    const m = model([
      E.create(T1, { title: 'one', task: TASK }, { wall: 10 }),
      E.create(T2, { title: 'two', task: TASK }, { wall: 10 }),
      first,
      second,
      third,
    ]);
    expect(handoffGraph(m.events)).toEqual({
      nodes: [
        { actor: 'impl-1', sent: 1, received: 2 },
        { actor: 'reviewer-1', sent: 0, received: 1 },
        { actor: 'test-1', sent: 2, received: 0 },
      ],
      edges: [
        { from: 'impl-1', to: 'reviewer-1', count: 1, latest: refOf(third) },
        { from: 'test-1', to: 'impl-1', count: 2, latest: refOf(second) },
      ],
    });
  });

  it('scenario "Claims are not hand-offs": claim, release and assign add no edge', () => {
    const m = model([
      E.create(T1, { title: 'one', task: TASK }),
      E.claim(T1, { actor: 'impl-1' }),
      E.release(T1, { actor: 'impl-1' }),
      E.claim(T1, { actor: 'impl-2' }),
      E.assign(T1, 'impl-3', { actor: 'impl-2' }),
      E.comment(T1, 'hi', { actor: 'impl-3' }),
      E.unknown(T1, { actor: 'impl-3' }),
    ]);
    expect(handoffGraph(m.events)).toEqual({ nodes: [], edges: [] });
  });

  it('does not count a rejected hand-off', () => {
    const m = model([
      E.create(T1, { title: 'one', task: TASK }),
      E.handoff(T1, 'rev', 'merged', 'skip ahead', { actor: 'impl-1' }),
      E.handoff(T9(), 'rev', 'todo', 'no such ticket', { actor: 'impl-1' }),
    ]);
    expect(m.events.filter((e) => e.kind === 'ticket.handoff').map((e) => e.outcome)).toEqual([
      'rejected',
      'rejected',
    ]);
    expect(handoffGraph(m.events)).toEqual({ nodes: [], edges: [] });
  });

  it('draws a hand-off to oneself as a self-loop, counted as sent and received', () => {
    const create = E.create(T1, { title: 'one', task: TASK });
    const self = E.handoff(T1, 'impl-1', 'tests', 'moving on', { actor: 'impl-1' });
    const m = model([create, self]);
    expect(handoffGraph(m.events)).toEqual({
      nodes: [{ actor: 'impl-1', sent: 1, received: 1 }],
      edges: [{ from: 'impl-1', to: 'impl-1', count: 1, latest: refOf(self) }],
    });
  });

  it('orders nodes by name and edges by from then to, in string order', () => {
    const m = model([
      E.create(T1, { title: 'one', task: TASK }),
      E.handoff(T1, 'b', 'todo', 'n', { actor: 'c' }),
      E.handoff(T1, 'a', 'todo', 'n', { actor: 'b' }),
      E.handoff(T1, 'C', 'todo', 'n', { actor: 'b' }),
      E.handoff(T1, 'c', 'todo', 'n', { actor: 'a' }),
    ]);
    const graph = handoffGraph(m.events);
    expect(graph.nodes.map((n) => n.actor)).toEqual(['C', 'a', 'b', 'c']);
    expect(graph.edges.map((e) => [e.from, e.to])).toEqual([
      ['a', 'c'],
      ['b', 'C'],
      ['b', 'a'],
      ['c', 'b'],
    ]);
  });

  it('scenario "Filter by change": only tickets whose task is <source>:<ref>#<item> count', () => {
    const counted: FoldInput[] = [];
    const handoff = (ticket: string, actor: string, count: boolean): FoldInput => {
      const input = E.handoff(ticket, 'rev', 'todo', `from ${ticket}`, { actor });
      if (count) {
        counted.push(input);
      }
      return input;
    };
    const m = model([
      E.create(T1, { title: 'login 1', task: login('1') }),
      E.create(T2, { title: 'login 2', task: login('2') }),
      E.create(T3, {
        title: 'longer ref',
        task: { source: 'openspec', ref: 'add-login-extra', item: '1' },
      }),
      E.create(T4, {
        title: 'other source',
        task: { source: 'jira', ref: 'add-login', item: '1' },
      }),
      E.create(T5, { title: 'ad hoc', adhoc: 'hotfix' }),
      E.create(T6, { title: 'linked later', adhoc: 'spike' }),
      E.create(T7, { title: 'relinked away', task: login('4') }),
      handoff(T1, 'a1', true),
      handoff(T2, 'a2', true),
      handoff(T3, 'a3', false),
      handoff(T4, 'a4', false),
      handoff(T5, 'a5', false),
      handoff(T6, 'a6', true),
      handoff(T7, 'a7', false),
      E.link(T6, { task: login('3') }),
      E.link(T7, { task: { source: 'openspec', ref: 'add-logout', item: '1' } }),
    ]);
    const graph = handoffGraph(m.events, { change: 'openspec:add-login' });
    expect(graph.edges.map((e) => [e.from, e.to, e.count])).toEqual([
      ['a1', 'rev', 1],
      ['a2', 'rev', 1],
      ['a6', 'rev', 1],
    ]);
    expect(graph.edges.map((e) => e.latest)).toEqual(counted.map(refOf));
    expect(handoffGraph(m.events, { change: 'openspec:add-login#1' })).toEqual({
      nodes: [],
      edges: [],
    });
    expect(handoffGraph(m.events).edges.map((e) => e.from)).toEqual([
      'a1',
      'a2',
      'a3',
      'a4',
      'a5',
      'a6',
      'a7',
    ]);
  });

  it('filters by a minimum wall, inclusive, and combines both filters', () => {
    const other: TaskRef = { source: 'openspec', ref: 'add-other', item: '1' };
    const m = model([
      E.create(T1, { title: 'login', task: login('1') }, { wall: 10 }),
      E.create(T2, { title: 'other', task: other }, { wall: 10 }),
      E.handoff(T1, 'rev', 'todo', 'a', { actor: 'x', wall: 100 }),
      E.handoff(T1, 'rev', 'todo', 'b', { actor: 'x', wall: 200 }),
      E.handoff(T2, 'rev', 'todo', 'c', { actor: 'y', wall: 250 }),
      E.handoff(T1, 'rev', 'todo', 'd', { actor: 'x', wall: 300 }),
    ]);
    const since200 = handoffGraph(m.events, { since: 200 });
    expect(since200.edges.map((e) => [e.from, e.to, e.count, e.latest.note])).toEqual([
      ['x', 'rev', 2, 'd'],
      ['y', 'rev', 1, 'c'],
    ]);
    expect(since200.nodes).toEqual([
      { actor: 'rev', sent: 0, received: 3 },
      { actor: 'x', sent: 2, received: 0 },
      { actor: 'y', sent: 1, received: 0 },
    ]);
    expect(handoffGraph(m.events, { since: 301 })).toEqual({ nodes: [], edges: [] });
    const both = handoffGraph(m.events, { since: 150, change: 'openspec:add-login' });
    expect(both.edges.map((e) => [e.from, e.count, e.latest.note])).toEqual([['x', 2, 'd']]);
    expect(handoffGraph(m.events, { since: 0 }).edges.map((e) => e.count)).toEqual([3, 1]);
  });

  it('derives a ticket task from applied events only (a rejected task link does not count)', () => {
    const m = model([
      E.handoff(T1, 'rev', 'todo', 'too early', { actor: 'x', wall: 10 }),
      E.link(T1, { task: login('1') }, { wall: 20 }),
      E.create(T1, { title: 'late create', adhoc: 'x' }, { wall: 30 }),
      E.handoff(T1, 'rev', 'todo', 'counted without a task', { actor: 'y', wall: 40 }),
    ]);
    expect(handoffGraph(m.events).edges.map((e) => e.from)).toEqual(['y']);
    expect(handoffGraph(m.events, { change: 'openspec:add-login' })).toEqual({
      nodes: [],
      edges: [],
    });
  });
});

/** An id with no create event. */
function T9(): string {
  return '01G0000000ACTAV9WEVGEMMVRZ';
}
