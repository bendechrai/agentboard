import { describe, expect, it } from 'vitest';

import { canonicalEncode, type JsonValue } from '../canonical.js';
import {
  compareFoldOrder,
  fold,
  isTransitionAllowed,
  type FoldInput,
  type FoldResult,
  type Ticket,
} from '../fold.js';
import type { Hlc } from '../hlc.js';
import type {
  Status,
  TaskRef,
  TicketCloseBody,
  TicketCreateBody,
  TicketLinkBody,
} from '../schema.js';

const T1 = '01ARYZ6S41TSV4RRFFQ69G5FAV';
const T2 = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const T3 = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const NEVER_CREATED = '01CAAAAAAAAAAAAAAAAAAAAAAA';

const TASK: TaskRef = { source: 'openspec', ref: 'add-board-core', item: '1' };
const OTHER_TASK: TaskRef = { source: 'speckit', ref: '001-photo-albums', item: 'phase-2' };

const hex = (n: number): string => n.toString(16).padStart(64, '0');

interface Opts {
  actor?: string;
  wall?: number;
  counter?: number;
  hash?: string;
}

// Every built event gets a fresh hash and, unless given, a wall later than
// every event built before it, so array build order equals fold order unless
// a test says otherwise.
let seq = 0;
function stamp(o: Opts): { hash: string; actor: string; ts: Hlc } {
  seq += 1;
  const actor = o.actor ?? 'orch';
  return {
    hash: o.hash ?? hex(seq),
    actor,
    ts: { wall: o.wall ?? 100_000 + seq * 10, counter: o.counter ?? 0, actor },
  };
}

const E = {
  create(
    ticket: string,
    body: TicketCreateBody = { title: 'Ticket', task: TASK },
    o: Opts = {},
  ): FoldInput {
    const s = stamp(o);
    return {
      hash: s.hash,
      event: { v: 1, kind: 'ticket.create', ticket, actor: s.actor, ts: s.ts, body },
    };
  },
  comment(ticket: string, text: string, o: Opts = {}): FoldInput {
    const s = stamp(o);
    return {
      hash: s.hash,
      event: { v: 1, kind: 'ticket.comment', ticket, actor: s.actor, ts: s.ts, body: { text } },
    };
  },
  move(ticket: string, to: Status, o: Opts = {}): FoldInput {
    const s = stamp(o);
    return {
      hash: s.hash,
      event: { v: 1, kind: 'ticket.move', ticket, actor: s.actor, ts: s.ts, body: { to } },
    };
  },
  assign(ticket: string, to: string, o: Opts = {}): FoldInput {
    const s = stamp(o);
    return {
      hash: s.hash,
      event: { v: 1, kind: 'ticket.assign', ticket, actor: s.actor, ts: s.ts, body: { to } },
    };
  },
  claim(ticket: string, o: Opts = {}): FoldInput {
    const s = stamp(o);
    return {
      hash: s.hash,
      event: { v: 1, kind: 'ticket.claim', ticket, actor: s.actor, ts: s.ts, body: {} },
    };
  },
  release(ticket: string, o: Opts = {}): FoldInput {
    const s = stamp(o);
    return {
      hash: s.hash,
      event: { v: 1, kind: 'ticket.release', ticket, actor: s.actor, ts: s.ts, body: {} },
    };
  },
  handoff(ticket: string, to: string, status: Status, note: string, o: Opts = {}): FoldInput {
    const s = stamp(o);
    return {
      hash: s.hash,
      event: {
        v: 1,
        kind: 'ticket.handoff',
        ticket,
        actor: s.actor,
        ts: s.ts,
        body: { to, status, note },
      },
    };
  },
  link(ticket: string, body: TicketLinkBody, o: Opts = {}): FoldInput {
    const s = stamp(o);
    return {
      hash: s.hash,
      event: { v: 1, kind: 'ticket.link', ticket, actor: s.actor, ts: s.ts, body },
    };
  },
  close(ticket: string, body: TicketCloseBody, o: Opts = {}): FoldInput {
    const s = stamp(o);
    return {
      hash: s.hash,
      event: { v: 1, kind: 'ticket.close', ticket, actor: s.actor, ts: s.ts, body },
    };
  },
  checklist(ticket: string, index: number, done: boolean, o: Opts = {}): FoldInput {
    const s = stamp(o);
    return {
      hash: s.hash,
      event: {
        v: 1,
        kind: 'ticket.checklist',
        ticket,
        actor: s.actor,
        ts: s.ts,
        body: { index, done },
      },
    };
  },
  meta(key: string, value: JsonValue, o: Opts = {}): FoldInput {
    const s = stamp(o);
    return {
      hash: s.hash,
      event: { v: 1, kind: 'board.meta', actor: s.actor, ts: s.ts, body: { key, value } },
    };
  },
  unknown(ticket: string, kind: string, body: Record<string, JsonValue>, o: Opts = {}): FoldInput {
    const s = stamp(o);
    return { hash: s.hash, event: { v: 1, kind, ticket, actor: s.actor, ts: s.ts, body } };
  },
};

function ticketOf(result: FoldResult, id: string): Ticket {
  const t = result.state.tickets[id];
  if (t === undefined) {
    throw new Error(`ticket ${id} not in state`);
  }
  return t;
}

function tsOf(input: FoldInput): Hlc {
  return input.event.ts;
}

/** Events that take a new ticket (with a task) to `status`. Blocked is blocked from `tests`. */
function reach(ticket: string, status: Status): FoldInput[] {
  const paths: Record<Status, Status[]> = {
    todo: [],
    tests: ['tests'],
    implementing: ['tests', 'implementing'],
    review: ['tests', 'implementing', 'review'],
    merged: ['tests', 'implementing', 'review', 'merged'],
    blocked: ['tests', 'blocked'],
  };
  return [
    E.create(ticket, { title: 'T', task: TASK }),
    ...paths[status].map((s) => E.move(ticket, s)),
  ];
}

const ALL: Status[] = ['todo', 'tests', 'implementing', 'review', 'merged', 'blocked'];

// Hand-written from board-cli "Status state machine" (blocked origin: tests).
const ALLOWED_FROM: Record<Status, Status[]> = {
  todo: ['tests', 'blocked'],
  tests: ['implementing', 'blocked'],
  implementing: ['review', 'blocked'],
  review: ['implementing', 'tests', 'merged', 'blocked'],
  merged: [],
  blocked: ['tests', 'blocked'],
};

describe('fold: basics', () => {
  it('folds no events to an empty board', () => {
    expect(fold([])).toEqual({
      state: { tickets: {}, meta: {} },
      rejected: [],
      unknown: [],
      latest: null,
    });
  });

  it('creates a ticket with every field defaulted', () => {
    const c = E.create(T1, { title: 'Minimal' }, { actor: 'orch' });
    const result = fold([c]);
    expect(result.rejected).toEqual([]);
    expect(result.state.tickets).toEqual({
      [T1]: {
        id: T1,
        title: 'Minimal',
        description: null,
        status: 'todo',
        blockedFrom: null,
        assignee: null,
        labels: [],
        task: null,
        adhoc: null,
        checklist: [],
        comments: [],
        links: [],
        closed: false,
        disposition: null,
        createdBy: 'orch',
        createdAt: tsOf(c),
        version: 1,
        updatedAt: tsOf(c),
      },
    });
  });

  it('creates a ticket from a full body', () => {
    const c = E.create(T1, {
      title: 'Canonical fold',
      description: 'group 1',
      labels: ['change:add-board-core', 'group:1'],
      task: TASK,
      checklist: ['1.1 canonical', '1.2 ulid'],
    });
    const t = ticketOf(fold([c]), T1);
    expect(t.description).toBe('group 1');
    expect(t.labels).toEqual(['change:add-board-core', 'group:1']);
    expect(t.task).toEqual(TASK);
    expect(t.adhoc).toBeNull();
    expect(t.checklist).toEqual([
      { text: '1.1 canonical', done: false },
      { text: '1.2 ulid', done: false },
    ]);
  });

  it('creates an ad hoc ticket', () => {
    const t = ticketOf(fold([E.create(T1, { title: 'x', adhoc: 'build broke' })]), T1);
    expect(t.adhoc).toBe('build broke');
    expect(t.task).toBeNull();
  });

  it('stores a task reference from a source with no adapter as given (spec scenario)', () => {
    const t = ticketOf(fold([E.create(T1, { title: 'Albums', task: OTHER_TASK })]), T1);
    expect(t.task).toEqual(OTHER_TASK);
  });

  it('keeps tickets independent', () => {
    const result = fold([E.create(T1), E.create(T2), E.comment(T1, 'only on T1')]);
    expect(ticketOf(result, T1).comments).toHaveLength(1);
    expect(ticketOf(result, T2).comments).toHaveLength(0);
    expect(ticketOf(result, T2).version).toBe(1);
  });

  it('produces state that serializes canonically', () => {
    const result = fold([
      E.create(T1, { title: 'x', task: TASK, checklist: ['a'] }),
      E.comment(T1, 'hi'),
      E.link(T1, { pr: 3 }),
      E.meta('columns', ['a', 'b']),
    ]);
    expect(() => canonicalEncode(result.state)).not.toThrow();
  });
});

describe('fold: ordering', () => {
  const base = (hash: string, wall: number, counter: number, actor: string): FoldInput => ({
    hash,
    event: {
      v: 1,
      kind: 'ticket.claim',
      ticket: T1,
      actor,
      ts: { wall, counter, actor },
      body: {},
    },
  });

  it('compareFoldOrder orders by wall, then counter, then actor, then hash', () => {
    expect(compareFoldOrder(base(hex(9), 1, 9, 'z'), base(hex(1), 2, 0, 'a'))).toBe(-1);
    expect(compareFoldOrder(base(hex(9), 2, 1, 'z'), base(hex(1), 2, 2, 'a'))).toBe(-1);
    expect(compareFoldOrder(base(hex(9), 2, 2, 'a'), base(hex(1), 2, 2, 'b'))).toBe(-1);
    expect(compareFoldOrder(base(hex(1), 2, 2, 'a'), base(hex(9), 2, 2, 'a'))).toBe(-1);
    expect(compareFoldOrder(base(hex(9), 2, 2, 'a'), base(hex(1), 2, 2, 'a'))).toBe(1);
    expect(compareFoldOrder(base(hex(1), 2, 2, 'B'), base(hex(1), 2, 2, 'a'))).toBe(-1);
    expect(compareFoldOrder(base(hex(5), 2, 2, 'a'), base(hex(5), 2, 2, 'a'))).toBe(0);
  });

  it('applies events in fold order, not array order', () => {
    const c = E.create(T1, undefined, { wall: 100 });
    const first = E.comment(T1, 'first', { wall: 200 });
    const second = E.comment(T1, 'second', { wall: 300 });
    const t = ticketOf(fold([second, first, c]), T1);
    expect(t.comments.map((x) => x.text)).toEqual(['first', 'second']);
  });

  it('uses the counter when walls tie', () => {
    const c = E.create(T1, undefined, { wall: 100 });
    const a = E.comment(T1, 'counter 2', { wall: 200, counter: 2, hash: hex(1) });
    const b = E.comment(T1, 'counter 1', { wall: 200, counter: 1, hash: hex(2) });
    expect(ticketOf(fold([a, c, b]), T1).comments.map((x) => x.text)).toEqual([
      'counter 1',
      'counter 2',
    ]);
  });

  it('concurrent claims fold to one winner: the earlier timestamp, whatever the hashes (spec scenario)', () => {
    const c = E.create(T1, undefined, { wall: 100 });
    const early = E.claim(T1, { actor: 'impl-b', wall: 200, hash: 'f'.repeat(64) });
    const late = E.claim(T1, { actor: 'impl-a', wall: 201, hash: '0'.repeat(64) });
    const result = fold([late, c, early]);
    expect(ticketOf(result, T1).assignee).toBe('impl-b');
    expect(result.rejected).toEqual([
      { hash: late.hash, kind: 'ticket.claim', ticket: T1, reason: 'already-assigned' },
    ]);
  });

  it('breaks a wall and counter tie by actor before hash', () => {
    const c = E.create(T1, undefined, { wall: 100 });
    const bob = E.claim(T1, { actor: 'bob', wall: 200, hash: '0'.repeat(64) });
    const alice = E.claim(T1, { actor: 'alice', wall: 200, hash: 'f'.repeat(64) });
    const result = fold([bob, alice, c]);
    expect(ticketOf(result, T1).assignee).toBe('alice');
    expect(result.rejected.map((r) => r.hash)).toEqual([bob.hash]);
  });

  it('breaks a full timestamp tie by hash', () => {
    const c = E.create(T1, undefined, { wall: 100 });
    const high = E.assign(T1, 'high', { actor: 'orch', wall: 200, hash: 'b'.repeat(64) });
    const low = E.assign(T1, 'low', { actor: 'orch', wall: 200, hash: 'a'.repeat(64) });
    // The later assign in fold order wins; 'bbbb...' folds after 'aaaa...'.
    expect(ticketOf(fold([high, low, c]), T1).assignee).toBe('high');
    expect(ticketOf(fold([c, low, high]), T1).assignee).toBe('high');
  });
});

describe('fold: report', () => {
  it('lists rejected events in fold order with hash, kind, ticket and reason', () => {
    const c = E.create(T1);
    const badMove = E.move(T1, 'merged');
    const badRelease = E.release(T1, { actor: 'x' });
    const orphan = E.comment(NEVER_CREATED, 'hello');
    const result = fold([orphan, badRelease, c, badMove]);
    expect(result.rejected).toEqual([
      { hash: badMove.hash, kind: 'ticket.move', ticket: T1, reason: 'invalid-transition' },
      { hash: badRelease.hash, kind: 'ticket.release', ticket: T1, reason: 'not-assignee' },
      {
        hash: orphan.hash,
        kind: 'ticket.comment',
        ticket: NEVER_CREATED,
        reason: 'unknown-ticket',
      },
    ]);
  });

  it('folds an event given twice (same hash) only once', () => {
    const c = E.create(T1);
    const comment = E.comment(T1, 'once');
    const result = fold([c, comment, c, comment]);
    expect(result.rejected).toEqual([]);
    expect(ticketOf(result, T1).comments).toHaveLength(1);
    expect(ticketOf(result, T1).version).toBe(2);
  });

  it('reports latest as the greatest timestamp of any input, including rejected and unknown ones', () => {
    const c = E.create(T1, undefined, { wall: 100 });
    const rejected = E.move(T1, 'merged', { wall: 500, counter: 3, actor: 'z' });
    const unknown = E.unknown(T1, 'ticket.estimate', { points: 1 }, { wall: 400 });
    const meta = E.meta('k', 1, { wall: 300 });
    expect(fold([rejected, c, unknown, meta]).latest).toEqual({
      wall: 500,
      counter: 3,
      actor: 'z',
    });
    const later = E.unknown(T1, 'ticket.estimate', { points: 2 }, { wall: 900 });
    expect(fold([rejected, later, c]).latest).toEqual(tsOf(later));
  });
});

describe('fold: unknown-ticket', () => {
  const orphans: [string, () => FoldInput][] = [
    ['ticket.comment', () => E.comment(NEVER_CREATED, 'x')],
    ['ticket.move', () => E.move(NEVER_CREATED, 'tests')],
    ['ticket.assign', () => E.assign(NEVER_CREATED, 'a')],
    ['ticket.claim', () => E.claim(NEVER_CREATED)],
    ['ticket.release', () => E.release(NEVER_CREATED)],
    ['ticket.handoff', () => E.handoff(NEVER_CREATED, 'r', 'tests', 'n')],
    ['ticket.link', () => E.link(NEVER_CREATED, { pr: 1 })],
    ['ticket.close', () => E.close(NEVER_CREATED, { noDecision: true })],
    ['ticket.checklist', () => E.checklist(NEVER_CREATED, 0, true)],
  ];

  it.each(orphans)(
    'rejects %s for a ticket that was never created, creating nothing',
    (kind, make) => {
      const orphan = make();
      const result = fold([E.create(T1), orphan]);
      expect(result.rejected).toEqual([
        { hash: orphan.hash, kind, ticket: NEVER_CREATED, reason: 'unknown-ticket' },
      ]);
      expect(Object.keys(result.state.tickets)).toEqual([T1]);
    },
  );

  it('holds aside an event that folds before its create and does not re-apply it', () => {
    const early = E.comment(T1, 'too early', { wall: 50 });
    const c = E.create(T1, undefined, { wall: 100 });
    const result = fold([c, early]);
    expect(result.rejected).toEqual([
      { hash: early.hash, kind: 'ticket.comment', ticket: T1, reason: 'unknown-ticket' },
    ]);
    const t = ticketOf(result, T1);
    expect(t.comments).toEqual([]);
    expect(t.version).toBe(1);
    expect(t.updatedAt).toEqual(tsOf(c));
  });
});

describe('fold: duplicate-create', () => {
  it('rejects a second create for the same id and keeps the first in fold order', () => {
    const second = E.create(T1, { title: 'second', adhoc: 'x' }, { wall: 200 });
    const first = E.create(T1, { title: 'first', task: TASK }, { wall: 100 });
    const result = fold([second, first]);
    expect(result.rejected).toEqual([
      { hash: second.hash, kind: 'ticket.create', ticket: T1, reason: 'duplicate-create' },
    ]);
    const t = ticketOf(result, T1);
    expect(t.title).toBe('first');
    expect(t.task).toEqual(TASK);
    expect(t.adhoc).toBeNull();
    expect(t.version).toBe(1);
    expect(t.createdAt).toEqual(tsOf(first));
  });
});

describe('fold: version and updatedAt', () => {
  it('counts one create, two comments and one rejected move as version 3 (spec scenario)', () => {
    const c = E.create(T1);
    const c1 = E.comment(T1, 'one');
    const c2 = E.comment(T1, 'two');
    const bad = E.move(T1, 'merged');
    const result = fold([c, c1, c2, bad]);
    const t = ticketOf(result, T1);
    expect(t.version).toBe(3);
    expect(t.updatedAt).toEqual(tsOf(c2));
    expect(result.rejected.map((r) => r.reason)).toEqual(['invalid-transition']);
  });

  it('does not let a rejected event between applied ones affect the count', () => {
    const events = [
      E.create(T1),
      E.comment(T1, 'a'),
      E.release(T1, { actor: 'nobody' }),
      E.comment(T1, 'b'),
    ];
    const t = ticketOf(fold(events), T1);
    expect(t.version).toBe(3);
    expect(t.updatedAt).toEqual(tsOf(events[3] as FoldInput));
  });

  it('counts every applied known kind once', () => {
    const events = [
      E.create(T1, { title: 't', task: TASK, checklist: ['a'] }),
      E.comment(T1, 'c'),
      E.move(T1, 'tests'),
      E.assign(T1, 'someone'),
      E.release(T1, { actor: 'someone' }),
      E.claim(T1, { actor: 'impl' }),
      E.handoff(T1, 'impl2', 'implementing', 'go'),
      E.link(T1, { pr: 4 }),
      E.checklist(T1, 0, true),
      E.move(T1, 'review'),
      E.move(T1, 'merged'),
      E.close(T1, { noDecision: true }),
    ];
    const result = fold(events);
    expect(result.rejected).toEqual([]);
    const t = ticketOf(result, T1);
    expect(t.version).toBe(12);
    expect(t.updatedAt).toEqual(tsOf(events[11] as FoldInput));
  });

  it('does not count unknown kinds or board.meta', () => {
    const c = E.create(T1);
    const t = ticketOf(
      fold([c, E.unknown(T1, 'ticket.estimate', { points: 3 }), E.meta('k', 'v')]),
      T1,
    );
    expect(t.version).toBe(1);
    expect(t.updatedAt).toEqual(tsOf(c));
  });
});

describe('isTransitionAllowed', () => {
  for (const from of ALL.filter((s) => s !== 'blocked')) {
    for (const to of ALL) {
      const expected = ALLOWED_FROM[from].includes(to);
      it(`${from} -> ${to} is ${expected ? 'allowed' : 'refused'}`, () => {
        expect(isTransitionAllowed(from, to, null)).toBe(expected);
      });
    }
  }

  for (const origin of ['todo', 'tests', 'implementing', 'review'] as Status[]) {
    for (const to of ALL) {
      const expected = to === origin || to === 'blocked';
      it(`blocked (from ${origin}) -> ${to} is ${expected ? 'allowed' : 'refused'}`, () => {
        expect(isTransitionAllowed('blocked', to, origin)).toBe(expected);
      });
    }
  }
});

describe('fold: every move transition', () => {
  for (const from of ALL) {
    for (const to of ALL) {
      const allowed = ALLOWED_FROM[from].includes(to);
      it(`move ${from} -> ${to} is ${allowed ? 'applied' : 'rejected invalid-transition'}`, () => {
        const setup = reach(T1, from);
        const before = ticketOf(fold(setup), T1);
        expect(before.status).toBe(from);
        const mv = E.move(T1, to, { actor: 'mover' });
        const result = fold([...setup, mv]);
        const t = ticketOf(result, T1);
        if (allowed) {
          expect(result.rejected).toEqual([]);
          expect(t.status).toBe(to);
          expect(t.version).toBe(before.version + 1);
          expect(t.updatedAt).toEqual(tsOf(mv));
          if (to === 'blocked') {
            expect(t.blockedFrom).toBe(from === 'blocked' ? 'tests' : from);
          } else {
            expect(t.blockedFrom).toBeNull();
          }
        } else {
          expect(result.rejected).toEqual([
            { hash: mv.hash, kind: 'ticket.move', ticket: T1, reason: 'invalid-transition' },
          ]);
          expect(t).toEqual(before);
        }
      });
    }
  }
});

describe('fold: blocked remembers where it came from', () => {
  it('returns an implementing ticket to implementing (spec scenario)', () => {
    const events = [...reach(T1, 'implementing'), E.move(T1, 'blocked')];
    const blocked = ticketOf(fold(events), T1);
    expect(blocked.status).toBe('blocked');
    expect(blocked.blockedFrom).toBe('implementing');
    const result = fold([...events, E.move(T1, 'implementing')]);
    expect(result.rejected).toEqual([]);
    expect(ticketOf(result, T1).status).toBe('implementing');
    expect(ticketOf(result, T1).blockedFrom).toBeNull();
  });

  it.each(['todo', 'tests', 'review'] as Status[])(
    'returns a ticket blocked from %s only to %s',
    (origin) => {
      const events = [...reach(T1, origin), E.move(T1, 'blocked')];
      for (const to of ALL.filter((s) => s !== origin && s !== 'blocked')) {
        const mv = E.move(T1, to);
        const result = fold([...events, mv]);
        expect(result.rejected).toEqual([
          { hash: mv.hash, kind: 'ticket.move', ticket: T1, reason: 'invalid-transition' },
        ]);
      }
      const back = fold([...events, E.move(T1, origin)]);
      expect(back.rejected).toEqual([]);
      expect(ticketOf(back, T1).status).toBe(origin);
    },
  );

  it('keeps the original origin through blocked -> blocked', () => {
    const events = [...reach(T1, 'review'), E.move(T1, 'blocked'), E.move(T1, 'blocked')];
    const t = ticketOf(fold(events), T1);
    expect(t.blockedFrom).toBe('review');
    const back = fold([...events, E.move(T1, 'review')]);
    expect(back.rejected).toEqual([]);
    expect(ticketOf(back, T1).status).toBe('review');
  });

  it('remembers a new origin after a second block', () => {
    const events = [
      ...reach(T1, 'tests'),
      E.move(T1, 'blocked'),
      E.move(T1, 'tests'),
      E.move(T1, 'implementing'),
      E.move(T1, 'blocked'),
    ];
    expect(ticketOf(fold(events), T1).blockedFrom).toBe('implementing');
    const wrong = E.move(T1, 'tests');
    expect(fold([...events, wrong]).rejected.map((r) => r.hash)).toEqual([wrong.hash]);
  });

  it('applies the origin rule to handoff out of blocked', () => {
    const events = [...reach(T1, 'implementing'), E.move(T1, 'blocked')];
    const wrong = E.handoff(T1, 'rev', 'review', 'skip ahead');
    expect(fold([...events, wrong]).rejected).toEqual([
      { hash: wrong.hash, kind: 'ticket.handoff', ticket: T1, reason: 'invalid-transition' },
    ]);
    const right = fold([...events, E.handoff(T1, 'impl2', 'implementing', 'unblocked')]);
    expect(right.rejected).toEqual([]);
    expect(ticketOf(right, T1).status).toBe('implementing');
    expect(ticketOf(right, T1).blockedFrom).toBeNull();
  });

  it('records the origin when a handoff blocks', () => {
    const t = ticketOf(
      fold([...reach(T1, 'tests'), E.handoff(T1, 'orch', 'blocked', 'stuck')]),
      T1,
    );
    expect(t.status).toBe('blocked');
    expect(t.blockedFrom).toBe('tests');
  });
});

describe('fold: merged is terminal', () => {
  it.each(ALL)('rejects a move from merged to %s', (to) => {
    const setup = reach(T1, 'merged');
    const mv = E.move(T1, to);
    const result = fold([...setup, mv]);
    expect(result.rejected).toEqual([
      { hash: mv.hash, kind: 'ticket.move', ticket: T1, reason: 'invalid-transition' },
    ]);
    expect(ticketOf(result, T1).status).toBe('merged');
  });

  it('rejects a handoff out of merged with no effects', () => {
    const setup = reach(T1, 'merged');
    const before = ticketOf(fold(setup), T1);
    const h = E.handoff(T1, 'someone', 'implementing', 'reopen');
    const result = fold([...setup, h]);
    expect(result.rejected).toEqual([
      { hash: h.hash, kind: 'ticket.handoff', ticket: T1, reason: 'invalid-transition' },
    ]);
    expect(ticketOf(result, T1)).toEqual(before);
  });
});

describe('fold: needs-task-link', () => {
  const adhoc = (): FoldInput[] => [
    E.create(T1, { title: 'x', adhoc: 'hotfix' }),
    E.move(T1, 'tests'),
  ];

  it('rejects moving an ad hoc ticket into implementing (spec scenario)', () => {
    const setup = adhoc();
    const mv = E.move(T1, 'implementing');
    const result = fold([...setup, mv]);
    expect(result.rejected).toEqual([
      { hash: mv.hash, kind: 'ticket.move', ticket: T1, reason: 'needs-task-link' },
    ]);
    expect(ticketOf(result, T1).status).toBe('tests');
  });

  it('rejects a ticket with neither task nor adhoc the same way', () => {
    const setup = [E.create(T1, { title: 'bare' }), E.move(T1, 'tests')];
    const mv = E.move(T1, 'implementing');
    const result = fold([...setup, mv]);
    expect(result.rejected).toEqual([
      { hash: mv.hash, kind: 'ticket.move', ticket: T1, reason: 'needs-task-link' },
    ]);
  });

  it('rejects a handoff into implementing with none of its effects', () => {
    const setup = adhoc();
    const before = ticketOf(fold(setup), T1);
    const h = E.handoff(T1, 'impl', 'implementing', 'go');
    const result = fold([...setup, h]);
    expect(result.rejected).toEqual([
      { hash: h.hash, kind: 'ticket.handoff', ticket: T1, reason: 'needs-task-link' },
    ]);
    expect(ticketOf(result, T1)).toEqual(before);
  });

  it('reports invalid-transition before needs-task-link', () => {
    const c = E.create(T1, { title: 'x', adhoc: 'hotfix' });
    const mv = E.move(T1, 'implementing');
    const result = fold([c, mv]);
    expect(result.rejected).toEqual([
      { hash: mv.hash, kind: 'ticket.move', ticket: T1, reason: 'invalid-transition' },
    ]);
  });

  it('allows implementing once a task is linked, and clears adhoc', () => {
    const result = fold([...adhoc(), E.link(T1, { task: TASK }), E.move(T1, 'implementing')]);
    expect(result.rejected).toEqual([]);
    const t = ticketOf(result, T1);
    expect(t.status).toBe('implementing');
    expect(t.task).toEqual(TASK);
    expect(t.adhoc).toBeNull();
  });

  it('does not apply to other statuses', () => {
    const result = fold([
      E.create(T1, { title: 'x', adhoc: 'h' }),
      E.move(T1, 'blocked'),
      E.move(T1, 'todo'),
    ]);
    expect(result.rejected).toEqual([]);
  });
});

describe('fold: claim, release and assign', () => {
  it('claim assigns the ticket to the claiming actor', () => {
    const result = fold([E.create(T1), E.claim(T1, { actor: 'impl' })]);
    expect(result.rejected).toEqual([]);
    expect(ticketOf(result, T1).assignee).toBe('impl');
  });

  it('rejects a claim on an assigned ticket with already-assigned', () => {
    const setup = [E.create(T1), E.claim(T1, { actor: 'impl' })];
    const second = E.claim(T1, { actor: 'reviewer' });
    const result = fold([...setup, second]);
    expect(result.rejected).toEqual([
      { hash: second.hash, kind: 'ticket.claim', ticket: T1, reason: 'already-assigned' },
    ]);
    expect(ticketOf(result, T1).assignee).toBe('impl');
  });

  it('rejects a claim by the current assignee too', () => {
    const setup = [E.create(T1), E.claim(T1, { actor: 'impl' })];
    const again = E.claim(T1, { actor: 'impl' });
    const result = fold([...setup, again]);
    expect(result.rejected.map((r) => [r.hash, r.reason])).toEqual([
      [again.hash, 'already-assigned'],
    ]);
  });

  it('rejects a claim after an assign', () => {
    const setup = [E.create(T1), E.assign(T1, 'reviewer')];
    const cl = E.claim(T1, { actor: 'impl' });
    const result = fold([...setup, cl]);
    expect(result.rejected.map((r) => [r.hash, r.reason])).toEqual([[cl.hash, 'already-assigned']]);
  });

  it('release by the assignee clears the assignment and allows a new claim', () => {
    const result = fold([
      E.create(T1),
      E.claim(T1, { actor: 'impl' }),
      E.release(T1, { actor: 'impl' }),
      E.claim(T1, { actor: 'reviewer' }),
    ]);
    expect(result.rejected).toEqual([]);
    expect(ticketOf(result, T1).assignee).toBe('reviewer');
  });

  it('rejects release by a non-assignee with not-assignee', () => {
    const setup = [E.create(T1), E.claim(T1, { actor: 'impl' })];
    const rel = E.release(T1, { actor: 'reviewer' });
    const result = fold([...setup, rel]);
    expect(result.rejected).toEqual([
      { hash: rel.hash, kind: 'ticket.release', ticket: T1, reason: 'not-assignee' },
    ]);
    expect(ticketOf(result, T1).assignee).toBe('impl');
  });

  it('rejects release of an unassigned ticket with not-assignee', () => {
    const c = E.create(T1);
    const rel = E.release(T1, { actor: 'impl' });
    const result = fold([c, rel]);
    expect(result.rejected).toEqual([
      { hash: rel.hash, kind: 'ticket.release', ticket: T1, reason: 'not-assignee' },
    ]);
  });

  it('assign sets and overrides the assignee regardless of actor', () => {
    const result = fold([
      E.create(T1),
      E.claim(T1, { actor: 'impl' }),
      E.assign(T1, 'reviewer', { actor: 'orch' }),
    ]);
    expect(result.rejected).toEqual([]);
    expect(ticketOf(result, T1).assignee).toBe('reviewer');
  });
});

describe('fold: handoff', () => {
  it('applies assignee, status and comment as one event (spec scenario)', () => {
    const setup = [...reach(T1, 'implementing'), E.claim(T1, { actor: 'impl' })];
    const before = ticketOf(fold(setup), T1);
    const h = E.handoff(T1, 'reviewer', 'review', 'green, 96%', { actor: 'impl' });
    const result = fold([...setup, h]);
    expect(result.rejected).toEqual([]);
    const t = ticketOf(result, T1);
    expect(t.assignee).toBe('reviewer');
    expect(t.status).toBe('review');
    expect(t.comments).toEqual([{ actor: 'impl', ts: tsOf(h), text: 'green, 96%', hash: h.hash }]);
    expect(t.version).toBe(before.version + 1);
    expect(t.updatedAt).toEqual(tsOf(h));
  });

  it('does not require the handing-off actor to be the assignee', () => {
    const result = fold([
      ...reach(T1, 'tests'),
      E.claim(T1, { actor: 'author' }),
      E.handoff(T1, 'impl', 'implementing', 'n', { actor: 'orch' }),
    ]);
    expect(result.rejected).toEqual([]);
    expect(ticketOf(result, T1).assignee).toBe('impl');
  });

  it('rejects a handoff to a status the state machine refuses, with none of its effects', () => {
    const setup = [...reach(T1, 'tests'), E.claim(T1, { actor: 'author' })];
    const before = ticketOf(fold(setup), T1);
    const h = E.handoff(T1, 'reviewer', 'review', 'skip', { actor: 'author' });
    const result = fold([...setup, h]);
    expect(result.rejected).toEqual([
      { hash: h.hash, kind: 'ticket.handoff', ticket: T1, reason: 'invalid-transition' },
    ]);
    expect(ticketOf(result, T1)).toEqual(before);
  });

  it('rejects a handoff that keeps the same status', () => {
    const setup = reach(T1, 'implementing');
    const h = E.handoff(T1, 'impl2', 'implementing', 'swap');
    const result = fold([...setup, h]);
    expect(result.rejected).toEqual([
      { hash: h.hash, kind: 'ticket.handoff', ticket: T1, reason: 'invalid-transition' },
    ]);
  });

  it('interleaves handoff notes with comments in fold order', () => {
    const events = [
      ...reach(T1, 'implementing'),
      E.comment(T1, 'before', { actor: 'a' }),
      E.handoff(T1, 'rev', 'review', 'note', { actor: 'b' }),
      E.comment(T1, 'after', { actor: 'c' }),
    ];
    const t = ticketOf(fold(events), T1);
    expect(t.comments.map((c) => [c.actor, c.text])).toEqual([
      ['a', 'before'],
      ['b', 'note'],
      ['c', 'after'],
    ]);
  });
});

describe('fold: comments and links', () => {
  it('records comment actor, timestamp, text and hash', () => {
    const c = E.create(T1);
    const cm = E.comment(T1, 'hello', { actor: 'reviewer' });
    const t = ticketOf(fold([c, cm]), T1);
    expect(t.comments).toEqual([{ actor: 'reviewer', ts: tsOf(cm), text: 'hello', hash: cm.hash }]);
  });

  it('appends pr and decision links in fold order, keeping duplicates', () => {
    const c = E.create(T1);
    const l1 = E.link(T1, { pr: 12 }, { actor: 'impl' });
    const l2 = E.link(T1, { decision: 'docs/adr/0002.md' }, { actor: 'rev' });
    const l3 = E.link(T1, { pr: 'https://github.com/o/r/pull/12' }, { actor: 'impl' });
    const l4 = E.link(T1, { pr: 12 }, { actor: 'impl' });
    const t = ticketOf(fold([l3, c, l1, l4, l2]), T1);
    expect(t.links).toEqual([
      { type: 'pr', pr: 12, actor: 'impl', ts: tsOf(l1), hash: l1.hash },
      { type: 'decision', path: 'docs/adr/0002.md', actor: 'rev', ts: tsOf(l2), hash: l2.hash },
      {
        type: 'pr',
        pr: 'https://github.com/o/r/pull/12',
        actor: 'impl',
        ts: tsOf(l3),
        hash: l3.hash,
      },
      { type: 'pr', pr: 12, actor: 'impl', ts: tsOf(l4), hash: l4.hash },
    ]);
    expect(t.task).toEqual(TASK);
  });

  it('replaces the task reference on a task link', () => {
    const t = ticketOf(
      fold([E.create(T1, { title: 'x', task: TASK }), E.link(T1, { task: OTHER_TASK })]),
      T1,
    );
    expect(t.task).toEqual(OTHER_TASK);
    expect(t.links).toEqual([]);
  });
});

describe('fold: checklist', () => {
  const setup = (): FoldInput[] => [
    E.create(T1, { title: 'x', task: TASK, checklist: ['a', 'b', 'c'] }),
  ];

  it('ticks and unticks an item', () => {
    const ticked = fold([...setup(), E.checklist(T1, 2, true)]);
    expect(ticketOf(ticked, T1).checklist).toEqual([
      { text: 'a', done: false },
      { text: 'b', done: false },
      { text: 'c', done: true },
    ]);
    const unticked = fold([...setup(), E.checklist(T1, 2, true), E.checklist(T1, 2, false)]);
    expect(ticketOf(unticked, T1).checklist.map((i) => i.done)).toEqual([false, false, false]);
    expect(ticketOf(unticked, T1).version).toBe(3);
  });

  it('counts setting an item to its current value as applied', () => {
    const result = fold([...setup(), E.checklist(T1, 0, false)]);
    expect(result.rejected).toEqual([]);
    expect(ticketOf(result, T1).version).toBe(2);
  });

  it.each([
    ['equal to the length', 3],
    ['beyond the length', 10],
    ['negative', -1],
  ])(
    'rejects an index %s with checklist-index and leaves the ticket unchanged (spec scenario)',
    (_name, index) => {
      const base = setup();
      const before = ticketOf(fold(base), T1);
      const ck = E.checklist(T1, index, true);
      const result = fold([...base, ck]);
      expect(result.rejected).toEqual([
        { hash: ck.hash, kind: 'ticket.checklist', ticket: T1, reason: 'checklist-index' },
      ]);
      expect(ticketOf(result, T1)).toEqual(before);
    },
  );

  it('rejects any index on a ticket with no checklist', () => {
    const c = E.create(T1);
    const ck = E.checklist(T1, 0, true);
    expect(fold([ck, c]).rejected.map((r) => r.reason)).toEqual(['checklist-index']);
  });
});

describe('fold: close', () => {
  it('closes a merged ticket with no decision', () => {
    const result = fold([...reach(T1, 'merged'), E.close(T1, { noDecision: true })]);
    expect(result.rejected).toEqual([]);
    const t = ticketOf(result, T1);
    expect(t.closed).toBe(true);
    expect(t.disposition).toEqual({ noDecision: true });
    expect(t.status).toBe('merged');
  });

  it('closes a blocked ticket with a decision path', () => {
    const result = fold([...reach(T1, 'blocked'), E.close(T1, { decision: 'docs/adr/0003.md' })]);
    expect(result.rejected).toEqual([]);
    const t = ticketOf(result, T1);
    expect(t.closed).toBe(true);
    expect(t.disposition).toEqual({ decision: 'docs/adr/0003.md' });
    expect(t.status).toBe('blocked');
  });

  it.each(['todo', 'tests', 'implementing', 'review'] as Status[])(
    'rejects closing a ticket in %s',
    (status) => {
      const setup = reach(T1, status);
      const before = ticketOf(fold(setup), T1);
      const cl = E.close(T1, { noDecision: true });
      const result = fold([...setup, cl]);
      expect(result.rejected).toEqual([
        { hash: cl.hash, kind: 'ticket.close', ticket: T1, reason: 'invalid-transition' },
      ]);
      expect(ticketOf(result, T1)).toEqual(before);
    },
  );

  it('rejects closing an already closed ticket and keeps the first disposition', () => {
    const setup = [...reach(T1, 'merged'), E.close(T1, { noDecision: true })];
    const second = E.close(T1, { decision: 'docs/adr/0004.md' });
    const result = fold([...setup, second]);
    expect(result.rejected).toEqual([
      { hash: second.hash, kind: 'ticket.close', ticket: T1, reason: 'invalid-transition' },
    ]);
    expect(ticketOf(result, T1).disposition).toEqual({ noDecision: true });
  });
});

describe('fold: unknown kinds are preserved', () => {
  it('lists a ticket.estimate event and leaves known state unaffected (spec scenario)', () => {
    const known = [E.create(T1), E.comment(T1, 'hi')];
    const estimate = E.unknown(T1, 'ticket.estimate', { points: 3 });
    const without = fold(known);
    const withUnknown = fold([estimate, ...known]);
    expect(withUnknown.state).toEqual(without.state);
    expect(withUnknown.rejected).toEqual([]);
    expect(withUnknown.unknown).toEqual([
      { hash: estimate.hash, kind: 'ticket.estimate', event: estimate.event },
    ]);
  });

  it('lists unknown events for tickets that do not exist without rejecting them', () => {
    const orphan = E.unknown(NEVER_CREATED, 'ticket.estimate', {});
    const result = fold([orphan]);
    expect(result.rejected).toEqual([]);
    expect(result.state.tickets).toEqual({});
    expect(result.unknown.map((u) => u.hash)).toEqual([orphan.hash]);
  });

  it('lists several unknown events in fold order', () => {
    const b = E.unknown(T1, 'ticket.vote', { up: true }, { wall: 300 });
    const a = E.unknown(T1, 'ticket.estimate', { points: 1 }, { wall: 200 });
    const result = fold([b, E.create(T1, undefined, { wall: 100 }), a]);
    expect(result.unknown.map((u) => [u.kind, u.hash])).toEqual([
      ['ticket.estimate', a.hash],
      ['ticket.vote', b.hash],
    ]);
  });
});

describe('fold: board.meta', () => {
  it('keeps the last value per key in fold order', () => {
    const late = E.meta('columns', ['x'], { wall: 300 });
    const early = E.meta('columns', ['a', 'b'], { wall: 200 });
    const other = E.meta('name', 'board', { wall: 250 });
    const result = fold([late, other, early]);
    expect(result.state.meta).toEqual({ columns: ['x'], name: 'board' });
    expect(result.state.tickets).toEqual({});
    expect(result.rejected).toEqual([]);
  });

  it('does not change the fixed state machine', () => {
    const setup = [E.meta('columns', ['todo', 'done']), E.create(T1)];
    const mv = E.move(T1, 'merged');
    const result = fold([mv, ...setup]);
    expect(result.rejected.map((r) => r.hash)).toEqual([mv.hash]);
  });
});

// Deterministic PRNG for the property test.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)] as T;
}

function randomHash(rand: () => number): string {
  let out = '';
  for (let i = 0; i < 64; i += 1) {
    out += Math.floor(rand() * 16).toString(16);
  }
  return out;
}

function randomEvents(seed: number, count: number): FoldInput[] {
  const rand = mulberry32(seed);
  const tickets = [T1, T2, T3, NEVER_CREATED];
  const actors = ['a', 'b', 'c'];
  const events: FoldInput[] = [];
  // Creates are mostly early so that most later events have a ticket.
  for (const t of [T1, T2, T3]) {
    const body: TicketCreateBody =
      rand() < 0.7
        ? { title: `t ${t}`, task: TASK, checklist: ['x', 'y'] }
        : { title: `adhoc ${t}`, adhoc: 'why' };
    events.push(
      E.create(t, body, {
        wall: Math.floor(rand() * 3),
        actor: pick(rand, actors),
        hash: randomHash(rand),
      }),
    );
  }
  for (let i = 0; i < count; i += 1) {
    // Small ranges force wall, counter and actor collisions.
    const o: Opts = {
      wall: Math.floor(rand() * 40),
      counter: Math.floor(rand() * 3),
      actor: pick(rand, actors),
      hash: randomHash(rand),
    };
    const t = pick(rand, tickets);
    const r = rand();
    if (r < 0.05) events.push(E.create(t, { title: 'dup', task: OTHER_TASK }, o));
    else if (r < 0.15) events.push(E.comment(t, `c${String(i)}`, o));
    else if (r < 0.35) events.push(E.move(t, pick(rand, ALL), o));
    else if (r < 0.42) events.push(E.assign(t, pick(rand, actors), o));
    else if (r < 0.52) events.push(E.claim(t, o));
    else if (r < 0.6) events.push(E.release(t, o));
    else if (r < 0.7)
      events.push(E.handoff(t, pick(rand, actors), pick(rand, ALL), `h${String(i)}`, o));
    else if (r < 0.76)
      events.push(
        E.link(t, pick(rand, [{ task: TASK }, { pr: i + 1 }, { decision: `d${String(i)}` }]), o),
      );
    else if (r < 0.8)
      events.push(
        E.close(t, pick(rand, [{ noDecision: true as const }, { decision: 'docs/adr/x.md' }]), o),
      );
    else if (r < 0.9) events.push(E.checklist(t, Math.floor(rand() * 4) - 1, rand() < 0.5, o));
    else if (r < 0.95) events.push(E.unknown(t, 'ticket.estimate', { points: i }, o));
    else events.push(E.meta(pick(rand, ['columns', 'name']), i, o));
  }
  // A few exact duplicates (same hash, same event).
  events.push(events[5] as FoldInput, events[17] as FoldInput);
  return events;
}

function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

describe('fold: determinism', () => {
  it.each([1, 2, 3, 4, 5])(
    'folds shuffled orders of the same event set to identical canonical results (seed %i)',
    (seed) => {
      const events = randomEvents(seed, 150);
      const reference = fold(events);
      // Guard against a vacuous property: the set exercises rejections, tickets and unknowns.
      expect(reference.rejected.length).toBeGreaterThan(0);
      expect(Object.keys(reference.state.tickets).length).toBeGreaterThan(0);
      const referenceBytes = canonicalEncode({
        state: reference.state,
        rejected: reference.rejected,
        unknown: reference.unknown,
        latest: reference.latest,
      });
      const rand = mulberry32(seed * 1000 + 1);
      for (let round = 0; round < 25; round += 1) {
        const result = fold(shuffle(events, rand));
        expect(result).toEqual(reference);
        const bytes = canonicalEncode({
          state: result.state,
          rejected: result.rejected,
          unknown: result.unknown,
          latest: result.latest,
        });
        expect(bytes).toEqual(referenceBytes);
      }
    },
  );

  it('does not mutate its input', () => {
    const events = randomEvents(9, 60);
    const snapshot = JSON.stringify(events);
    fold(events);
    fold(shuffle(events, mulberry32(4)));
    expect(JSON.stringify(events)).toBe(snapshot);
  });
});
