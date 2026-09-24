import { describe, expect, it } from 'vitest';

import { ticketCard } from '../columns.js';
import { agentLanes, type Lane } from '../lanes.js';
import { E, T1, T2, T3, T4, TASK, model, ticketOf } from './helpers.js';

const actors = (lanes: Lane[]): string[] => lanes.map((l) => l.actor);
const lane = (lanes: Lane[], actor: string): Lane | undefined =>
  lanes.find((l) => l.actor === actor);

describe('agentLanes (board-view-model: "Agent lanes")', () => {
  it('scenario Last seen', () => {
    const m = model([
      E.create(T1, { title: 'x', task: TASK }, { actor: 'orch', wall: 900_000 }),
      E.comment(T1, 'hi', { actor: 'impl-1', wall: 1_000_000 }),
    ]);
    expect(lane(agentLanes(m, 1_300_000), 'impl-1')?.lastSeenMs).toBe(300_000);
  });

  it('scenario Assignee without events', () => {
    const m = model([
      E.create(T1, { title: 'x', task: TASK }, { actor: 'orch' }),
      E.claim(T1, { actor: 'test-1' }),
      E.handoff(T1, 'reviewer-1', 'tests', 'yours', { actor: 'test-1' }),
    ]);
    const now = 5_000_000;
    const reviewer = lane(agentLanes(m, now), 'reviewer-1');
    expect(reviewer).toEqual({
      actor: 'reviewer-1',
      tickets: [ticketCard(ticketOf(m, T1), now)],
      lastEvent: null,
      lastSeenMs: null,
    });
  });

  it('gives the last applied event of the actor with hash, kind, ticket and ts', () => {
    const create = E.create(T1, { title: 'x', task: TASK }, { actor: 'impl' });
    const claim = E.claim(T1, { actor: 'impl' });
    const rejected = E.claim(T1, { actor: 'impl' });
    const unknown = E.unknown(T1, { actor: 'impl' });
    const m = model([create, claim, rejected, unknown]);
    const impl = lane(agentLanes(m, 0), 'impl');
    expect(impl?.lastEvent).toEqual({
      hash: claim.hash,
      kind: 'ticket.claim',
      ticket: T1,
      ts: claim.event.ts,
    });
  });

  it('counts board.meta as an applied event, with a null ticket', () => {
    const meta = E.meta('project', 'x', { actor: 'orch', wall: 2_000_000 });
    const m = model([meta]);
    expect(agentLanes(m, 2_000_500)).toEqual([
      {
        actor: 'orch',
        tickets: [],
        lastEvent: { hash: meta.hash, kind: 'board.meta', ticket: null, ts: meta.event.ts },
        lastSeenMs: 500,
      },
    ]);
  });

  it('clamps a wall in the future to a last seen of 0', () => {
    const m = model([E.create(T1, { title: 'x', task: TASK }, { actor: 'impl', wall: 2_000_000 })]);
    expect(lane(agentLanes(m, 1_000_000), 'impl')?.lastSeenMs).toBe(0);
    expect(lane(agentLanes(m, 2_000_000), 'impl')?.lastSeenMs).toBe(0);
  });

  it('makes no lane for an actor with only rejected or unknown-kind events', () => {
    const m = model([
      E.create(T1, { title: 'x', task: TASK }, { actor: 'orch' }),
      E.claim(T1, { actor: 'a' }),
      E.claim(T1, { actor: 'loser' }),
      E.unknown(T1, { actor: 'future' }),
      E.unknown(null, { actor: 'future' }),
    ]);
    expect(actors(agentLanes(m, 0)).sort()).toEqual(['a', 'orch']);
  });

  it('makes no lane for the assignee of a closed ticket only', () => {
    const m = model([
      E.create(T1, { title: 'x', task: TASK }, { actor: 'orch' }),
      E.move(T1, 'blocked', { actor: 'orch' }),
      E.assign(T1, 'gone', { actor: 'orch' }),
      E.close(T1, { noDecision: true }, { actor: 'orch' }),
    ]);
    expect(actors(agentLanes(m, 0))).toEqual(['orch']);
  });

  it('holds only the open tickets assigned to the actor, most recently updated first', () => {
    const m = model([
      E.create(T1, { title: 'one', task: TASK }, { actor: 'orch' }),
      E.create(T2, { title: 'two', task: TASK }, { actor: 'orch' }),
      E.create(T3, { title: 'three', task: TASK }, { actor: 'orch' }),
      E.create(T4, { title: 'four', task: TASK }, { actor: 'orch' }),
      E.claim(T1, { actor: 'impl' }),
      E.claim(T2, { actor: 'impl' }),
      E.claim(T3, { actor: 'other' }),
      E.assign(T4, 'impl', { actor: 'orch' }),
      E.move(T4, 'blocked', { actor: 'impl' }),
      E.close(T4, { noDecision: true }, { actor: 'impl' }),
      E.comment(T1, 'bump', { actor: 'orch' }),
    ]);
    const now = 42;
    const impl = lane(agentLanes(m, now), 'impl');
    expect(impl?.tickets).toEqual([
      ticketCard(ticketOf(m, T1), now),
      ticketCard(ticketOf(m, T2), now),
    ]);
    expect(lane(agentLanes(m, now), 'orch')?.tickets).toEqual([]);
  });

  it('orders lanes by last event in reverse fold order, then lanes without events by name', () => {
    const m = model([
      E.create(T1, { title: 'x', task: TASK }, { actor: 'orch', wall: 10 }),
      E.create(T2, { title: 'y', task: TASK }, { actor: 'orch', wall: 11 }),
      E.create(T3, { title: 'z', task: TASK }, { actor: 'orch', wall: 12 }),
      E.assign(T1, 'zed', { actor: 'orch', wall: 13 }),
      E.assign(T2, 'amy', { actor: 'orch', wall: 14 }),
      E.comment(T3, 'a', { actor: 'bob', wall: 20 }),
      E.comment(T3, 'b', { actor: 'cat', wall: 30, counter: 0 }),
      E.comment(T3, 'c', { actor: 'ann', wall: 30, counter: 1 }),
      E.comment(T3, 'd', { actor: 'bob', wall: 25 }),
      E.assign(T3, 'mia', { actor: 'orch', wall: 15 }),
    ]);
    expect(actors(agentLanes(m, 100))).toEqual(['ann', 'cat', 'bob', 'orch', 'amy', 'mia', 'zed']);
  });

  it('breaks an equal wall and counter by actor, as fold order does', () => {
    const m = model([
      E.create(T1, { title: 'x', task: TASK }, { actor: 'orch', wall: 10 }),
      E.comment(T1, 'a', { actor: 'b-actor', wall: 20 }),
      E.comment(T1, 'b', { actor: 'a-actor', wall: 20 }),
    ]);
    expect(actors(agentLanes(m, 100))).toEqual(['b-actor', 'a-actor', 'orch']);
  });

  it('is empty for an empty board', () => {
    expect(agentLanes({ events: [], tickets: {} }, 0)).toEqual([]);
  });

  it('lanes have exactly the documented fields', () => {
    const m = model([E.create(T1, { title: 'x', task: TASK }, { actor: 'orch' })]);
    const [first] = agentLanes(m, 0);
    expect(Object.keys(first ?? {}).sort()).toEqual([
      'actor',
      'lastEvent',
      'lastSeenMs',
      'tickets',
    ]);
  });
});
