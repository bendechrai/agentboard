/**
 * `applyFeedMessage` (board-view-model: "Applying feed messages"),
 * including the property "Append equals reload" over seeded random boards.
 */

import { describe, expect, it } from 'vitest';

import type { FoldInput, Ticket } from '../../events/fold.js';
import type { Status } from '../../events/schema.js';
import { applyFeedMessage } from '../apply.js';
import type { AppendMessage, BoardModel, EventView, ResyncMessage } from '../types.js';
import { E, T1, T2, T3, TASK, model } from './helpers.js';

/**
 * The append message a feed would send for the events of `after` beyond
 * the first `from` (all applied): those events, the state in `after` of
 * each ticket they name (once, ascending by id), `after.meta` when one is
 * a `board.meta`, and `after.id`.
 */
function appendOf(after: BoardModel, from: number): AppendMessage {
  const events = after.events.slice(from);
  const ids = [...new Set(events.flatMap((e) => (e.ticket === null ? [] : [e.ticket])))].sort();
  return {
    type: 'append',
    id: after.id,
    events,
    tickets: ids.map((id) => after.tickets[id]).filter((t): t is Ticket => t !== undefined),
    meta: events.some((e) => e.kind === 'board.meta') ? after.meta : null,
  };
}

/** Mulberry32: a small seeded PRNG, so failures are reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TICKETS = [T1, T2, T3];
const ACTORS = ['a', 'b', 'c'];
const STATUSES: Status[] = ['todo', 'tests', 'implementing', 'review', 'merged', 'blocked'];

/**
 * A random board of `n` applied events (candidates the fold would reject
 * are dropped, so every event is effective, as the feed delivers them).
 */
function randomEvents(seed: number, n: number): FoldInput[] {
  const rand = prng(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;
  const accepted: FoldInput[] = [];
  let guard = 0;
  while (accepted.length < n && guard < n * 50) {
    guard += 1;
    const ticket = pick(TICKETS);
    const actor = pick(ACTORS);
    const choice = Math.floor(rand() * 11);
    const o = { actor };
    const candidate = [
      () => E.create(ticket, { title: `t${String(guard)}`, task: TASK, checklist: ['x', 'y'] }, o),
      () => E.comment(ticket, pick(['hi', 'DECISION: d', 'RETRACTED: r']), o),
      () => E.move(ticket, pick(STATUSES), o),
      () => E.claim(ticket, o),
      () => E.release(ticket, o),
      () => E.assign(ticket, pick(ACTORS), o),
      () => E.handoff(ticket, pick(ACTORS), pick(STATUSES), 'note', o),
      () => E.check(ticket, Math.floor(rand() * 3), rand() < 0.5, o),
      () => E.addLines(ticket, [{ text: 'more', done: false }], o),
      () => E.meta(pick(['k1', 'k2']), Math.floor(rand() * 5), o),
      () => E.link(ticket, { pr: Math.floor(rand() * 100) }, o),
    ][choice];
    if (candidate === undefined) {
      continue;
    }
    const event = candidate();
    const trial = model([...accepted, event]);
    if (trial.events.at(-1)?.hash === event.hash && trial.events.at(-1)?.outcome === 'applied') {
      accepted.push(event);
    }
  }
  return accepted;
}

describe('applyFeedMessage: append', () => {
  it('scenario Append equals reload: a snapshot model plus an append of three events', () => {
    const before = [
      E.create(T1, { title: 'one', task: TASK }),
      E.comment(T1, 'hello', { actor: 'impl' }),
    ];
    const added = [
      E.claim(T1, { actor: 'impl' }),
      E.create(T2, { title: 'two', task: TASK }),
      E.move(T1, 'tests', { actor: 'impl' }),
    ];
    const snapshot = model(before);
    const later = model([...before, ...added]);
    const message = appendOf(later, snapshot.events.length);
    expect(message.events).toHaveLength(3);
    const result = applyFeedMessage(snapshot, message);
    expect(result).toEqual({ model: later, reload: false, late: [] });
  });

  it('property: snapshot plus append deep-equals a later snapshot (seeded random boards)', () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const events = randomEvents(seed, 24);
      const rand = prng(seed * 7919);
      const cut = Math.floor(rand() * (events.length + 1));
      const snapshot = model(events.slice(0, cut));
      const later = model(events);
      const copy = structuredClone(snapshot);
      const message = appendOf(later, snapshot.events.length);
      const messageCopy = structuredClone(message);
      const result = applyFeedMessage(snapshot, message);
      expect(result.model, `seed ${String(seed)} cut ${String(cut)}`).toEqual(later);
      expect(result.reload).toBe(false);
      // Inputs are not modified.
      expect(snapshot).toEqual(copy);
      expect(message).toEqual(messageCopy);
    }
  });

  it('property: several appends in a row equal one later snapshot', () => {
    for (let seed = 100; seed < 130; seed += 1) {
      const events = randomEvents(seed, 30);
      const rand = prng(seed);
      const cuts = [0, 0, 0]
        .map(() => Math.floor(rand() * (events.length + 1)))
        .sort((x, y) => x - y);
      let current = model(events.slice(0, cuts[0]));
      for (const end of [...cuts.slice(1), events.length]) {
        const step = model(events.slice(0, end));
        current = applyFeedMessage(current, appendOf(step, current.events.length)).model;
        expect(current, `seed ${String(seed)} end ${String(end)}`).toEqual(step);
      }
    }
  });

  it('an append with no event keeps the head and takes the id', () => {
    const empty = model([]);
    const message: AppendMessage = {
      type: 'append',
      id: `none.${'0'.repeat(64)}`,
      events: [],
      tickets: [],
      meta: null,
    };
    expect(applyFeedMessage(empty, message)).toEqual({ model: empty, reload: false, late: [] });
    const some = model([E.create(T1, { title: 'x', task: TASK })]);
    const id = `${some.head ?? ''}.${'1'.repeat(64)}`;
    const result = applyFeedMessage(some, { ...message, id });
    expect(result.model).toEqual({ ...some, id });
  });

  it('keeps the late marks of the model', () => {
    const before = [E.create(T1, { title: 'one', task: TASK })];
    const late = before.map((e) => e.hash);
    const snapshot = model(before, late);
    const later = model([...before, E.comment(T1, 'x')], late);
    const result = applyFeedMessage(snapshot, appendOf(later, 1));
    expect(result.model).toEqual(later);
    expect(result.model.late).toEqual(late);
  });

  it('keeps the meta when the message carries none, and replaces it when it does', () => {
    const before = [E.meta('k', 1), E.create(T1, { title: 'one', task: TASK })];
    const snapshot = model(before);
    const comment = model([...before, E.comment(T1, 'x')]);
    expect(applyFeedMessage(snapshot, appendOf(comment, 2)).model.meta).toEqual({ k: 1 });
    const meta = model([...before, E.meta('j', 2)]);
    expect(applyFeedMessage(snapshot, appendOf(meta, 2)).model.meta).toEqual({ k: 1, j: 2 });
  });

  it('is deterministic', () => {
    const before = [E.create(T1, { title: 'one', task: TASK })];
    const snapshot = model(before);
    const message = appendOf(model([...before, E.claim(T1, { actor: 'a' })]), 1);
    const first = applyFeedMessage(structuredClone(snapshot), structuredClone(message));
    const second = applyFeedMessage(structuredClone(snapshot), structuredClone(message));
    expect(second).toEqual(first);
  });
});

describe('applyFeedMessage: resync', () => {
  it('returns the same model unchanged, asks for a reload and lists the late hashes in order', () => {
    const inputs = [E.create(T1, { title: 'one', task: TASK }), E.comment(T1, 'x')];
    const m = model(inputs);
    const copy = structuredClone(m);
    const late: EventView[] = model([E.comment(T1, 'late 1'), E.comment(T1, 'late 2')]).events;
    const message: ResyncMessage = {
      type: 'resync',
      id: `${'d'.repeat(64)}.${'e'.repeat(64)}`,
      late,
      removed: ['f'.repeat(64)],
    };
    const result = applyFeedMessage(m, message);
    expect(result.model).toBe(m);
    expect(m).toEqual(copy);
    expect(result.reload).toBe(true);
    expect(result.late).toEqual(late.map((e) => e.hash));
  });

  it('a resync with nothing late asks for a reload with no late hash', () => {
    const m = model([]);
    const result = applyFeedMessage(m, { type: 'resync', id: m.id, late: [], removed: [] });
    expect(result).toEqual({ model: m, reload: true, late: [] });
  });
});
