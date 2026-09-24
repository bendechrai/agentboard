import { describe, expect, it } from 'vitest';

import { compareFoldOrder, fold, type FoldInput } from '../../events/fold.js';
import { STATUSES, type Status } from '../../events/schema.js';
import {
  CHECKPOINT_INTERVAL,
  replayCheckpoints,
  replayState,
  type ReplayCheckpoint,
} from '../replay.js';
import type { EventOutcome, EventView } from '../types.js';
import { E, OTHER, T1, T2, T3, T4, TASK, TASK2, model, type Opts } from './helpers.js';

// add-board-insights task 1.2; board-insights: "Replay".

/** A small deterministic PRNG (mulberry32), so every run sees the same sequences. */
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

const TICKETS = [T1, T2, T3, T4];
const ACTORS = ['a', 'b', 'c'];

/**
 * `length` random events over four tickets and three actors, in fold
 * order: every kind, valid and invalid transitions, duplicate creates,
 * events before their ticket's create, shared walls with counters, and
 * unknown kinds, so the fold applies, rejects and ignores events.
 */
function randomEvents(seed: number, length: number): EventView[] {
  const rnd = prng(seed);
  const pick = <T>(list: readonly T[]): T => {
    const item = list[Math.floor(rnd() * list.length)];
    if (item === undefined) {
      throw new Error('empty list');
    }
    return item;
  };
  const inputs: FoldInput[] = [];
  let wall = 1000;
  for (let i = 0; i < length; i += 1) {
    wall += pick([0, 0, 1, 7, 50]);
    const o: Opts = { wall, actor: pick(ACTORS), counter: Math.floor(rnd() * 3) };
    const ticket = pick(TICKETS);
    const status: Status = pick(STATUSES);
    const roll = rnd();
    if (roll < 0.1) {
      inputs.push(
        E.create(
          ticket,
          rnd() < 0.5 ? { title: 't', task: pick([TASK, OTHER]) } : { title: 't', adhoc: 'x' },
          o,
        ),
      );
    } else if (roll < 0.2) {
      inputs.push(E.comment(ticket, pick(['hi', 'DECISION: x', 'RETRACTED: y']), o));
    } else if (roll < 0.35) {
      inputs.push(E.move(ticket, status, o));
    } else if (roll < 0.45) {
      inputs.push(E.claim(ticket, o));
    } else if (roll < 0.5) {
      inputs.push(E.release(ticket, o));
    } else if (roll < 0.55) {
      inputs.push(E.assign(ticket, pick(ACTORS), o));
    } else if (roll < 0.7) {
      inputs.push(E.handoff(ticket, pick(ACTORS), status, 'note', o));
    } else if (roll < 0.77) {
      inputs.push(E.link(ticket, pick([{ task: TASK2 }, { pr: 3 }, { decision: 'd.md' }]), o));
    } else if (roll < 0.82) {
      inputs.push(E.close(ticket, rnd() < 0.5 ? { noDecision: true } : { decision: 'd.md' }, o));
    } else if (roll < 0.88) {
      inputs.push(E.check(ticket, Math.floor(rnd() * 4) - 1, rnd() < 0.5, o));
    } else if (roll < 0.92) {
      inputs.push(E.addLines(ticket, [{ text: 'l', done: rnd() < 0.5 }], o));
    } else if (roll < 0.96) {
      inputs.push(E.meta(pick(['k1', 'k2']), Math.floor(rnd() * 10), o));
    } else {
      inputs.push(E.unknown(rnd() < 0.5 ? ticket : null, o));
    }
  }
  return model(inputs).events;
}

/** The outcome `fold` gives the event at `index` when folding the prefix up to it. */
function foldOutcome(events: readonly FoldInput[], index: number): EventOutcome {
  const target = events[index];
  const result = fold(events.slice(0, index + 1));
  if (result.rejected.some((r) => r.hash === target?.hash)) {
    return 'rejected';
  }
  return result.unknown.some((u) => u.hash === target?.hash) ? 'unknown' : 'applied';
}

/**
 * Timeout for the two CPU-heavy property tests below. Each folds prefixes
 * of 1000+ event logs many times over; they take about a second on an idle
 * machine but approached vitest's 5 second default under load, so they get
 * an explicit, generous limit instead.
 */
const PROPERTY_TIMEOUT_MS = 60_000;

describe('CHECKPOINT_INTERVAL', () => {
  it('is 500 events', () => {
    expect(CHECKPOINT_INTERVAL).toBe(500);
  });
});

describe('replayCheckpoints', () => {
  it('is empty below 500 events', () => {
    expect(replayCheckpoints([])).toEqual([]);
    expect(replayCheckpoints(randomEvents(1, 499))).toEqual([]);
  });

  it('keeps one checkpoint per whole 500 events, each equal to a fold of that prefix', () => {
    for (const length of [500, 1000, 1234]) {
      const events = randomEvents(length, length);
      const checkpoints = replayCheckpoints(events);
      const counts = checkpoints.map((c) => c.count);
      expect(counts).toEqual(
        Array.from({ length: Math.floor(length / 500) }, (_, i) => (i + 1) * 500),
      );
      for (const checkpoint of checkpoints) {
        expect(checkpoint.state).toEqual(fold(events.slice(0, checkpoint.count)).state);
      }
    }
  });
});

describe('replayState', () => {
  it('scenario "Replay reaches the present": the last index equals the current board', () => {
    const inputs = [
      E.create(T1, { title: 'one', task: TASK, checklist: ['x'] }),
      E.create(T2, { title: 'two', task: OTHER }),
      E.claim(T1, { actor: 'impl' }),
      E.move(T1, 'tests'),
      E.handoff(T1, 'rev', 'implementing', 'go', { actor: 'impl' }),
      E.check(T1, 0, true),
      E.move(T2, 'blocked'),
      E.meta('project', 'agentboard'),
      E.unknown(T2),
      E.claim(T1, { actor: 'late' }),
    ];
    const m = model(inputs);
    const last = replayState(m.events, m.events.length - 1);
    expect(last.index).toBe(m.events.length - 1);
    expect(last.state.tickets).toEqual(m.tickets);
    expect(last.state.meta).toEqual(m.meta);
  });

  it('scenario "A rejected claim replays as rejected": the first claimant still holds it', () => {
    const inputs = [
      E.create(T1, { title: 'contested', task: TASK }),
      E.claim(T1, { actor: 'impl-1' }),
      E.claim(T1, { actor: 'impl-2' }),
      E.comment(T1, 'after'),
    ];
    const events = model(inputs).events;
    const first = replayState(events, 1);
    expect(first.outcome).toBe('applied');
    expect(first.reason).toBeNull();
    expect(first.state.tickets[T1]?.assignee).toBe('impl-1');
    const second = replayState(events, 2);
    expect(second.outcome).toBe('rejected');
    expect(second.reason).toBe('already-assigned');
    expect(second.state.tickets[T1]?.assignee).toBe('impl-1');
    expect(replayState(events, 3).state.tickets[T1]?.assignee).toBe('impl-1');
  });

  it('recomputes outcomes with the fold, ignoring the outcomes given in the list', () => {
    const inputs = [
      E.create(T1, { title: 'contested', task: TASK }),
      E.claim(T1, { actor: 'impl-1' }),
      E.claim(T1, { actor: 'impl-2' }),
      E.unknown(T1),
    ];
    const events = model(inputs).events.map((view): EventView => ({
      ...view,
      outcome: 'applied',
      reason: null,
    }));
    expect(replayState(events, 2)).toMatchObject({
      outcome: 'rejected',
      reason: 'already-assigned',
    });
    expect(replayState(events, 3)).toMatchObject({ outcome: 'unknown', reason: null });
  });

  it('accepts plain fold inputs in fold order', () => {
    const inputs = [E.create(T1, { title: 'x', task: TASK }), E.move(T1, 'tests')].sort(
      compareFoldOrder,
    );
    expect(replayState(inputs, 1).state).toEqual(fold(inputs).state);
  });

  it.each([
    ['a negative index', 3, -1],
    ['an index past the end', 3, 3],
    ['a fractional index', 3, 1.5],
    ['NaN', 3, Number.NaN],
    ['an infinite index', 3, Number.POSITIVE_INFINITY],
    ['any index of an empty list', 0, 0],
  ])('throws a RangeError for %s', (_name, length, index) => {
    const events = randomEvents(7, length);
    expect(() => replayState(events, index)).toThrow(RangeError);
    expect(() => replayState(events, index, replayCheckpoints(events))).toThrow(RangeError);
  });

  it('scenario "Seeking is path independent": 700 directly and by stepping back from 900', () => {
    const events = randomEvents(42, 1100);
    const checkpoints = replayCheckpoints(events);
    const direct = replayState(events, 700, checkpoints);
    let stepped = replayState(events, 900, checkpoints);
    for (let i = 899; i >= 700; i -= 1) {
      stepped = replayState(events, i, checkpoints);
    }
    expect(stepped).toEqual(direct);
    expect(replayState(events, 700)).toEqual(direct);
    expect(direct.state).toEqual(fold(events.slice(0, 701)).state);
  });

  it('never modifies the events or the checkpoints, and shares no state with them', () => {
    const events = randomEvents(9, 1050);
    const checkpoints = replayCheckpoints(events);
    const eventsBefore = structuredClone(events);
    const checkpointsBefore = structuredClone(checkpoints);
    const at = replayState(events, 999, checkpoints);
    const exact = replayState(events, 499, checkpoints);
    for (const result of [at, exact]) {
      for (const ticket of Object.values(result.state.tickets)) {
        ticket.title = 'mutated';
        ticket.comments.push({
          actor: 'm',
          ts: { wall: 0, counter: 0, actor: 'm' },
          text: 'm',
          hash: 'm',
        });
      }
      result.state.meta.mutated = true;
    }
    expect(events).toEqual(eventsBefore);
    expect(checkpoints).toEqual(checkpointsBefore);
    expect(replayState(events, 999, checkpoints).state).toEqual(fold(events.slice(0, 1000)).state);
    expect(replayState(events, 499, checkpoints).state).toEqual(fold(events.slice(0, 500)).state);
  });

  it(
    'property: at every index, with and without checkpoints, equals fold of the prefix',
    () => {
      for (const [seed, length] of [
        [101, 40],
        [202, 80],
        [303, 120],
        [404, 1060],
      ] as const) {
        const events = randomEvents(seed, length);
        const checkpoints: ReplayCheckpoint[] = replayCheckpoints(events);
        for (let index = 0; index < events.length; index += 1) {
          const expected = fold(events.slice(0, index + 1)).state;
          const outcome = foldOutcome(events, index);
          const withCheckpoints = replayState(events, index, checkpoints);
          expect(withCheckpoints.index).toBe(index);
          expect(withCheckpoints.state).toEqual(expected);
          expect(withCheckpoints.outcome).toBe(outcome);
          expect(withCheckpoints.reason === null).toBe(outcome !== 'rejected');
          if (length < 500 || index % 97 === 0 || index % 500 >= 498 || index % 500 <= 1) {
            expect(replayState(events, index)).toEqual(withCheckpoints);
          }
        }
      }
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    'property: stepping from a random position reaches the same state as seeking directly',
    () => {
      const rnd = prng(777);
      for (const seed of [11, 12, 13]) {
        const events = randomEvents(seed, 1040);
        const checkpoints = replayCheckpoints(events);
        for (let trial = 0; trial < 6; trial += 1) {
          const target = Math.floor(rnd() * events.length);
          const start = Math.floor(rnd() * events.length);
          const step = start < target ? 1 : -1;
          let current = replayState(events, start, checkpoints);
          for (let i = start; i !== target; i += step) {
            current = replayState(events, i + step, checkpoints);
          }
          expect(current).toEqual(replayState(events, target, checkpoints));
          expect(current).toEqual(replayState(events, target));
          expect(current.state).toEqual(fold(events.slice(0, target + 1)).state);
        }
      }
    },
    PROPERTY_TIMEOUT_MS,
  );
});
