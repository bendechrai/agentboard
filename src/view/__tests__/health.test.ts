import { describe, expect, it } from 'vitest';

import type { FoldInput } from '../../events/fold.js';
import { ticketCard } from '../columns.js';
import {
  DEFAULT_THRESHOLDS,
  healthReport,
  parseDuration,
  type HealthCheck,
  type HealthEventRef,
  type HealthThresholds,
  type LateArrival,
} from '../health.js';
import type { BoardModel } from '../types.js';
import {
  E,
  OTHER,
  T1,
  T2,
  T3,
  T4,
  T5,
  T6,
  T7,
  TASK,
  model,
  ticketOf,
  type Opts,
} from './helpers.js';

// add-board-insights task 1.1; board-insights: "Health report", "Durations".

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Event options with an explicit wall (and counter), so ages are exact. */
function at(wall: number, actor = 'orch', counter = 0): Opts {
  return { wall, actor, counter };
}

/** The `HealthEventRef` of a built event. */
function ref(input: FoldInput): HealthEventRef {
  return { hash: input.hash, kind: input.event.kind, actor: input.event.actor, ts: input.event.ts };
}

function report(
  m: BoardModel,
  now: number,
  thresholds: HealthThresholds = DEFAULT_THRESHOLDS,
): ReturnType<typeof healthReport> {
  return healthReport({ model: m, now, thresholds });
}

/**
 * Events that take `ticket` (created with `TASK` at `wall`) through
 * `tests`, `implementing` and `review` to `merged`, one wall apart.
 */
function toMerged(ticket: string, wall: number): FoldInput[] {
  return [
    E.create(ticket, { title: `t ${ticket}`, task: TASK }, at(wall)),
    E.move(ticket, 'tests', at(wall + 1)),
    E.move(ticket, 'implementing', at(wall + 2)),
    E.move(ticket, 'review', at(wall + 3)),
    E.move(ticket, 'merged', at(wall + 4)),
  ];
}

describe('DEFAULT_THRESHOLDS', () => {
  it('is 2 hours stale and 24 hours blocked', () => {
    expect(DEFAULT_THRESHOLDS).toEqual({ staleAfter: 7_200_000, blockedAfter: 86_400_000 });
    expect(Object.isFrozen(DEFAULT_THRESHOLDS)).toBe(true);
  });
});

describe('parseDuration', () => {
  it.each([
    ['1m', MINUTE],
    ['30m', 30 * MINUTE],
    ['2h', 2 * HOUR],
    ['24h', DAY],
    ['1d', DAY],
    ['7d', 7 * DAY],
    ['99999m', 99_999 * MINUTE],
    ['99999h', 99_999 * HOUR],
    ['99999d', 99_999 * DAY],
    ['10000h', 10_000 * HOUR],
  ])('accepts %j as %d ms', (text, ms) => {
    expect(parseDuration(text)).toBe(ms);
  });

  // Ruling on add-board-insights group 1: leading zeros are accepted on a
  // positive value (still at most 5 digits); a zero value is refused
  // however many zeros it is written with.
  it.each([
    ['01h', HOUR],
    ['007m', 7 * MINUTE],
    ['00001d', DAY],
    ['09999m', 9_999 * MINUTE],
  ])('accepts leading zeros on a positive value: %j as %d ms', (text, ms) => {
    expect(parseDuration(text)).toBe(ms);
  });

  it.each(['0h', '000m', '00000d', '000001h'])(
    'refuses a zero value or more than 5 digits, whatever the leading zeros: %j',
    (text) => {
      expect(parseDuration(text)).toBeNull();
    },
  );

  it.each([
    '0h',
    '0m',
    '0d',
    '00000h',
    '100000m',
    '123456d',
    '2hours',
    '2hr',
    'h',
    'm',
    '-1h',
    '+1h',
    '1.5h',
    '1e3m',
    '2H',
    '2M',
    '2D',
    '2s',
    '2w',
    '2',
    '',
    ' 2h',
    '2h ',
    '2 h',
    'h2',
    '2h2h',
    '0x10m',
    // A fullwidth digit two (U+FF12) is not an ASCII digit.
    `${String.fromCharCode(0xff12)}h`,
  ])('refuses %j', (text) => {
    expect(parseDuration(text)).toBeNull();
  });
});

describe('healthReport: echo and optional server data', () => {
  const m = model([E.create(T1, { title: 'x', task: TASK }, at(0))]);

  it('echoes now and the thresholds, and has null late and check when not supplied', () => {
    const thresholds = { staleAfter: 5 * MINUTE, blockedAfter: HOUR };
    expect(healthReport({ model: m, now: 1234, thresholds })).toEqual({
      now: 1234,
      thresholds: { staleAfter: 5 * MINUTE, blockedAfter: HOUR },
      staleClaims: [],
      stuckBlocked: [],
      unpromotedDecisions: [],
      closeMerged: { ready: [], heldByDecision: [], missingPr: [] },
      late: null,
      check: null,
    });
  });

  it('has null late and check when given null', () => {
    const r = healthReport({
      model: m,
      now: 1,
      thresholds: DEFAULT_THRESHOLDS,
      late: null,
      check: null,
    });
    expect(r.late).toBeNull();
    expect(r.check).toBeNull();
  });

  it('carries the supplied late arrivals in the order given and the check result', () => {
    const late: LateArrival[] = [
      { hash: 'b'.repeat(64), kind: 'ticket.comment', ticket: T1, type: 'late', observedAt: 900 },
      { hash: 'a'.repeat(64), kind: 'board.meta', ticket: null, type: 'removed', observedAt: 800 },
    ];
    const check: HealthCheck = { ranAt: 950, matches: false, differingRows: 3 };
    const r = healthReport({ model: m, now: 1000, thresholds: DEFAULT_THRESHOLDS, late, check });
    expect(r.late).toEqual(late);
    expect(r.check).toEqual(check);
  });

  it('gives an empty report for an empty board', () => {
    const empty = model([]);
    const r = report(empty, 10 * DAY);
    expect(r.staleClaims).toEqual([]);
    expect(r.stuckBlocked).toEqual([]);
    expect(r.unpromotedDecisions).toEqual([]);
    expect(r.closeMerged).toEqual({ ready: [], heldByDecision: [], missingPr: [] });
  });
});

describe('healthReport: stale claims', () => {
  it('scenario "Idle holder is stale": a reviewer comment does not reset the holder', () => {
    const claim = E.claim(T1, at(0, 'impl-1', 1));
    const m = model([
      E.create(T1, { title: 'login', task: TASK }, at(0, 'orch', 0)),
      claim,
      E.comment(T1, 'any news?', at(7_000_000, 'reviewer')),
    ]);
    const now = 7_300_000;
    expect(report(m, now).staleClaims).toEqual([
      {
        ticket: ticketCard(ticketOf(m, T1), now),
        assignee: 'impl-1',
        since: ref(claim),
        idleMs: 7_300_000,
      },
    ]);
  });

  it('scenario "Active holder is not stale": the holder commenting resets idle time', () => {
    const m = model([
      E.create(T1, { title: 'login', task: TASK }, at(0, 'orch', 0)),
      E.claim(T1, at(0, 'impl-1', 1)),
      E.comment(T1, 'working on it', at(7_000_000, 'impl-1')),
    ]);
    expect(report(m, 7_300_000).staleClaims).toEqual([]);
  });

  it('includes a claim idle for exactly staleAfter and excludes one a millisecond short', () => {
    const own = E.comment(T1, 'working on it', at(7_000_000, 'impl-1'));
    const m = model([
      E.create(T1, { title: 'login', task: TASK }, at(0, 'orch', 0)),
      E.claim(T1, at(0, 'impl-1', 1)),
      own,
    ]);
    const exact = report(m, 7_300_000, { staleAfter: 300_000, blockedAfter: DAY });
    expect(exact.staleClaims).toEqual([
      {
        ticket: ticketCard(ticketOf(m, T1), 7_300_000),
        assignee: 'impl-1',
        since: ref(own),
        idleMs: 300_000,
      },
    ]);
    expect(report(m, 7_300_000, { staleAfter: 300_001, blockedAfter: DAY }).staleClaims).toEqual(
      [],
    );
  });

  interface IdleCase {
    name: string;
    /** Events after the create of T1 (by `orch` at wall 0, counter 0). */
    events: () => { inputs: FoldInput[]; since: FoldInput };
    assignee: string;
  }

  const idleCases: IdleCase[] = [
    {
      name: 'an assign makes the assignee: idle from the assign, not their earlier comment',
      assignee: 'impl-1',
      events: () => {
        const assign = E.assign(T1, 'impl-1', at(2000));
        return {
          inputs: [E.comment(T1, 'I can take it', at(1000, 'impl-1')), assign],
          since: assign,
        };
      },
    },
    {
      name: 'a handoff makes its target the assignee: idle from the handoff by another actor',
      assignee: 'rev',
      events: () => {
        const handoff = E.handoff(T1, 'rev', 'todo', 'yours', at(5000, 'impl-1'));
        return { inputs: [E.claim(T1, at(0, 'impl-1', 1)), handoff], since: handoff };
      },
    },
    {
      name: "the target's own later event after a handoff",
      assignee: 'rev',
      events: () => {
        const own = E.comment(T1, 'on it', at(6000, 'rev'));
        return {
          inputs: [
            E.claim(T1, at(0, 'impl-1', 1)),
            E.handoff(T1, 'rev', 'todo', 'yours', at(5000, 'impl-1')),
            own,
          ],
          since: own,
        };
      },
    },
    {
      name: 'a handoff back to the current holder by another actor restarts the clock',
      assignee: 'impl-1',
      events: () => {
        const back = E.handoff(T1, 'impl-1', 'todo', 'still yours', at(9000, 'reviewer'));
        return {
          inputs: [E.claim(T1, at(0, 'impl-1', 1)), E.comment(T1, 'x', at(4000, 'impl-1')), back],
          since: back,
        };
      },
    },
    {
      name: "the holder's rejected event does not count",
      assignee: 'impl-1',
      events: () => {
        const claim = E.claim(T1, at(0, 'impl-1', 1));
        return { inputs: [claim, E.move(T1, 'merged', at(9000, 'impl-1'))], since: claim };
      },
    },
    {
      name: "the holder's event on another ticket does not count",
      assignee: 'impl-1',
      events: () => {
        const claim = E.claim(T1, at(0, 'impl-1', 1));
        return {
          inputs: [
            claim,
            E.create(T2, { title: 'other', task: TASK }, at(100)),
            E.comment(T2, 'busy here', at(9000, 'impl-1')),
          ],
          since: claim,
        };
      },
    },
    {
      name: "any kind of the holder's own applied event counts (a pr link)",
      assignee: 'impl-1',
      events: () => {
        const link = E.link(T1, { pr: 42 }, at(9000, 'impl-1'));
        return { inputs: [E.claim(T1, at(0, 'impl-1', 1)), link], since: link };
      },
    },
    {
      name: 'release and claim again: idle from the latest claim',
      assignee: 'impl-1',
      events: () => {
        const again = E.claim(T1, at(8000, 'impl-1'));
        return {
          inputs: [E.claim(T1, at(0, 'impl-1', 1)), E.release(T1, at(1000, 'impl-1')), again],
          since: again,
        };
      },
    },
    {
      name: "another actor's rejected claim does not restart the holder's clock",
      assignee: 'impl-1',
      events: () => {
        const claim = E.claim(T1, at(0, 'impl-1', 1));
        return { inputs: [claim, E.claim(T1, at(9000, 'impl-2'))], since: claim };
      },
    },
  ];

  it.each(idleCases)('idle rule: $name', ({ events, assignee }) => {
    const { inputs, since } = events();
    const m = model([E.create(T1, { title: 'login', task: TASK }, at(0, 'orch', 0)), ...inputs]);
    const now = since.event.ts.wall + 3 * HOUR;
    expect(report(m, now).staleClaims).toEqual([
      { ticket: ticketCard(ticketOf(m, T1), now), assignee, since: ref(since), idleMs: 3 * HOUR },
    ]);
  });

  it('leaves out unassigned, merged and closed tickets, and keeps a blocked holder', () => {
    const m = model([
      // T1: unassigned, created long ago.
      E.create(T1, { title: 'free', task: TASK }, at(0)),
      // T2: merged with an idle assignee.
      ...toMerged(T2, 10),
      E.assign(T2, 'impl-2', at(20)),
      // T3: blocked with an idle holder: still a stale claim.
      E.create(T3, { title: 'blocked', task: TASK }, at(30)),
      E.claim(T3, at(31, 'impl-3')),
      E.move(T3, 'blocked', at(32, 'impl-3')),
      // T4: blocked and closed with an idle holder.
      E.create(T4, { title: 'closed', task: TASK }, at(40)),
      E.claim(T4, at(41, 'impl-4')),
      E.move(T4, 'blocked', at(42, 'impl-4')),
      E.close(T4, { noDecision: true }, at(43)),
    ]);
    const r = report(m, 10 * DAY);
    expect(r.staleClaims.map((s) => [s.ticket.id, s.assignee])).toEqual([[T3, 'impl-3']]);
  });

  it('orders by idle time descending, then ticket id ascending', () => {
    const m = model([
      E.create(T1, { title: 'a', task: TASK }, at(0)),
      E.create(T2, { title: 'b', task: TASK }, at(0)),
      E.create(T3, { title: 'c', task: TASK }, at(0)),
      E.claim(T1, at(2 * HOUR, 'x')),
      E.claim(T3, at(0, 'y', 1)),
      E.claim(T2, at(0, 'z', 1)),
    ]);
    const r = report(m, 5 * HOUR);
    expect(r.staleClaims.map((s) => [s.ticket.id, s.idleMs])).toEqual([
      [T2, 5 * HOUR],
      [T3, 5 * HOUR],
      [T1, 3 * HOUR],
    ]);
  });

  it('clamps a negative idle time (a wall in the future) to 0', () => {
    const claim = E.claim(T1, at(10_000_000, 'impl-1'));
    const m = model([E.create(T1, { title: 'skew', task: TASK }, at(9_000_000)), claim]);
    const now = 5_000_000;
    expect(report(m, now, { staleAfter: 0, blockedAfter: DAY }).staleClaims).toEqual([
      {
        ticket: ticketCard(ticketOf(m, T1), now),
        assignee: 'impl-1',
        since: ref(claim),
        idleMs: 0,
      },
    ]);
    expect(report(m, now, { staleAfter: 1, blockedAfter: DAY }).staleClaims).toEqual([]);
  });
});

describe('healthReport: stuck in blocked', () => {
  const B = 10_000_000;

  /** T1 created with a task and moved to `implementing` before `B`. */
  function implementing(): FoldInput[] {
    return [
      E.create(T1, { title: 'login', task: TASK }, at(0)),
      E.move(T1, 'tests', at(1000)),
      E.move(T1, 'implementing', at(2000)),
    ];
  }

  it('scenario "Blocked for a day": moved from implementing 25 hours ago', () => {
    const block = E.move(T1, 'blocked', at(B, 'impl-1'));
    const m = model([...implementing(), block]);
    const now = B + 25 * HOUR;
    expect(report(m, now).stuckBlocked).toEqual([
      {
        ticket: ticketCard(ticketOf(m, T1), now),
        blockedFrom: 'implementing',
        since: ref(block),
        blockedMs: 25 * HOUR,
        latestComment: null,
      },
    ]);
  });

  it('includes exactly blockedAfter and excludes 23 hours with the defaults', () => {
    const m = model([...implementing(), E.move(T1, 'blocked', at(B))]);
    expect(report(m, B + DAY).stuckBlocked.map((s) => s.blockedMs)).toEqual([DAY]);
    expect(report(m, B + DAY - 1).stuckBlocked).toEqual([]);
    expect(report(m, B + 23 * HOUR).stuckBlocked).toEqual([]);
  });

  it('counts a handoff with status blocked as the entry into blocked, with its note as the latest comment', () => {
    const handoff = E.handoff(T1, 'human', 'blocked', 'need prod credentials', at(B, 'impl-1'));
    const m = model([...implementing(), handoff]);
    const now = B + 25 * HOUR;
    expect(report(m, now).stuckBlocked).toEqual([
      {
        ticket: ticketCard(ticketOf(m, T1), now),
        blockedFrom: 'implementing',
        since: ref(handoff),
        blockedMs: 25 * HOUR,
        latestComment: {
          actor: 'impl-1',
          ts: handoff.event.ts,
          text: 'need prod credentials',
          hash: handoff.hash,
        },
      },
    ]);
  });

  it('does not restart the clock on a comment, a reassignment while blocked or a rejected move', () => {
    const block = E.move(T1, 'blocked', at(B, 'impl-1'));
    const later = E.comment(T1, 'still waiting on creds', at(B + 22 * HOUR, 'reviewer'));
    const m = model([
      ...implementing(),
      block,
      E.handoff(T1, 'orch-2', 'blocked', 'take this over', at(B + 20 * HOUR, 'impl-1')),
      E.move(T1, 'blocked', at(B + 21 * HOUR, 'orch-2')),
      later,
    ]);
    const now = B + 25 * HOUR;
    const stuck = report(m, now).stuckBlocked;
    expect(stuck).toHaveLength(1);
    expect(stuck[0]?.since).toEqual(ref(block));
    expect(stuck[0]?.blockedMs).toBe(25 * HOUR);
    expect(stuck[0]?.latestComment).toEqual({
      actor: 'reviewer',
      ts: later.event.ts,
      text: 'still waiting on creds',
      hash: later.hash,
    });
  });

  it('measures from the latest entry after leaving and re-entering blocked', () => {
    const again = E.move(T1, 'blocked', at(B + 5 * HOUR));
    const m = model([
      ...implementing(),
      E.move(T1, 'blocked', at(B)),
      E.move(T1, 'implementing', at(B + HOUR)),
      E.move(T1, 'review', at(B + 2 * HOUR)),
      again,
    ]);
    const now = B + 5 * HOUR + DAY;
    expect(report(m, now).stuckBlocked).toEqual([
      {
        ticket: ticketCard(ticketOf(m, T1), now),
        blockedFrom: 'review',
        since: ref(again),
        blockedMs: DAY,
        latestComment: null,
      },
    ]);
  });

  it('leaves out tickets not in blocked and closed blocked tickets', () => {
    const m = model([
      E.create(T1, { title: 'todo', task: TASK }, at(0)),
      E.create(T2, { title: 'closed', task: TASK }, at(0)),
      E.move(T2, 'blocked', at(10)),
      E.close(T2, { noDecision: true }, at(20)),
    ]);
    expect(report(m, 30 * DAY).stuckBlocked).toEqual([]);
  });

  it('orders by blocked time descending, then ticket id ascending', () => {
    const m = model([
      E.create(T1, { title: 'a', task: TASK }, at(0)),
      E.create(T2, { title: 'b', task: TASK }, at(0)),
      E.create(T3, { title: 'c', task: TASK }, at(0)),
      E.move(T1, 'blocked', at(DAY)),
      E.move(T3, 'blocked', at(100)),
      E.move(T2, 'blocked', at(100)),
    ]);
    const r = report(m, 3 * DAY + 100);
    expect(r.stuckBlocked.map((s) => [s.ticket.id, s.blockedMs, s.blockedFrom])).toEqual([
      [T2, 3 * DAY, 'todo'],
      [T3, 3 * DAY, 'todo'],
      [T1, 2 * DAY + 100, 'todo'],
    ]);
  });

  it('clamps a negative blocked age to 0', () => {
    const m = model([
      E.create(T1, { title: 'skew', task: TASK }, at(B)),
      E.move(T1, 'blocked', at(B + 10)),
    ]);
    const r = report(m, 0, { staleAfter: HOUR, blockedAfter: 0 });
    expect(r.stuckBlocked.map((s) => s.blockedMs)).toEqual([0]);
    expect(report(m, 0, { staleAfter: HOUR, blockedAfter: 1 }).stuckBlocked).toEqual([]);
  });
});

describe('healthReport: unpromoted decisions', () => {
  it('scenario "Decision without a decision link": listed until a decision link is added', () => {
    const inputs = [
      E.create(T1, { title: 'auth', task: TASK }, at(0)),
      E.comment(T1, 'DECISION: use sessions', at(10, 'impl-1')),
    ];
    const before = model(inputs);
    expect(report(before, 100).unpromotedDecisions).toEqual([
      {
        ticket: ticketCard(ticketOf(before, T1), 100),
        decisions: [{ actor: 'impl-1', text: 'DECISION: use sessions' }],
      },
    ]);
    const after = model([...inputs, E.link(T1, { decision: 'docs/adr/0009.md' }, at(20))]);
    expect(report(after, 100).unpromotedDecisions).toEqual([]);
  });

  it('uses openDecisions: retracted decisions do not count, handoff notes do', () => {
    const m = model([
      E.create(T1, { title: 'retracted', task: TASK }, at(0)),
      E.comment(T1, 'DECISION: use JWT', at(10, 'impl-1')),
      E.comment(T1, 'RETRACTED: see below', at(20, 'impl-1')),
      E.create(T2, { title: 'note', task: TASK }, at(0)),
      E.handoff(T2, 'rev', 'todo', 'DECISION: keep the old schema', at(30, 'impl-2')),
      E.comment(T2, 'decision: lowercase is not one', at(40, 'rev')),
    ]);
    expect(report(m, 100).unpromotedDecisions).toEqual([
      {
        ticket: ticketCard(ticketOf(m, T2), 100),
        decisions: [{ actor: 'impl-2', text: 'DECISION: keep the old schema' }],
      },
    ]);
  });

  it('covers open tickets in any status and orders by ticket id; closed tickets are left out', () => {
    const m = model([
      ...toMerged(T3, 0),
      E.link(T3, { pr: 7 }, at(10)),
      E.comment(T3, 'DECISION: merged one', at(11, 'a')),
      E.create(T1, { title: 'todo', task: TASK }, at(0)),
      E.comment(T1, 'DECISION: todo one', at(12, 'b')),
      E.create(T2, { title: 'closed', task: TASK }, at(0)),
      E.move(T2, 'blocked', at(13)),
      E.comment(T2, 'DECISION: closed one', at(14, 'c')),
      E.close(T2, { noDecision: true }, at(15)),
    ]);
    const r = report(m, 100);
    expect(r.unpromotedDecisions.map((u) => [u.ticket.id, u.decisions])).toEqual([
      [T1, [{ actor: 'b', text: 'DECISION: todo one' }]],
      [T3, [{ actor: 'a', text: 'DECISION: merged one' }]],
    ]);
  });
});

describe('healthReport: close-merged candidates', () => {
  it('scenario "close-merged candidates": ready, heldByDecision and missingPr', () => {
    const m = model([
      ...toMerged(T1, 0),
      E.link(T1, { pr: 12 }, at(10)),
      ...toMerged(T2, 0),
      E.link(T2, { pr: 'https://github.com/o/r/pull/13' }, at(11)),
      E.comment(T2, 'DECISION: pin the version', at(12, 'impl-2')),
      ...toMerged(T3, 0),
    ]);
    const now = 1000;
    expect(report(m, now).closeMerged).toEqual({
      ready: [
        {
          ticket: ticketCard(ticketOf(m, T1), now),
          prs: [12],
          decisions: [],
          decisionLinked: false,
        },
      ],
      heldByDecision: [
        {
          ticket: ticketCard(ticketOf(m, T2), now),
          prs: ['https://github.com/o/r/pull/13'],
          decisions: [{ actor: 'impl-2', text: 'DECISION: pin the version' }],
          decisionLinked: false,
        },
      ],
      missingPr: [
        { ticket: ticketCard(ticketOf(m, T3), now), prs: [], decisions: [], decisionLinked: false },
      ],
    });
  });

  it('a decision link makes an open decision ready; missingPr ignores decisions; prs keep link order', () => {
    const m = model([
      // T4: pr, open decision, decision link -> ready.
      ...toMerged(T4, 0),
      E.link(T4, { pr: 1 }, at(10)),
      E.comment(T4, 'DECISION: a', at(11, 'x')),
      E.link(T4, { decision: 'docs/adr/0001.md' }, at(12)),
      // T5: no pr, open decision -> missingPr.
      ...toMerged(T5, 0),
      E.comment(T5, 'DECISION: b', at(13, 'y')),
      // T6: two pr links (one repeated) -> ready, in link order.
      ...toMerged(T6, 0),
      E.link(T6, { pr: 'b' }, at(14)),
      E.link(T6, { pr: 'a' }, at(15)),
      E.link(T6, { pr: 'b' }, at(16)),
      // T7: in review with a pr link -> nowhere.
      E.create(T7, { title: 'review', task: OTHER }, at(0)),
      E.move(T7, 'tests', at(1)),
      E.move(T7, 'implementing', at(2)),
      E.move(T7, 'review', at(3)),
      E.link(T7, { pr: 9 }, at(17)),
    ]);
    const r = report(m, 1000);
    expect(r.closeMerged.ready.map((c) => [c.ticket.id, c.prs, c.decisionLinked])).toEqual([
      [T4, [1], true],
      [T6, ['b', 'a', 'b'], false],
    ]);
    expect(r.closeMerged.ready[0]?.decisions).toEqual([{ actor: 'x', text: 'DECISION: a' }]);
    expect(r.closeMerged.heldByDecision).toEqual([]);
    expect(r.closeMerged.missingPr.map((c) => [c.ticket.id, c.decisions])).toEqual([
      [T5, [{ actor: 'y', text: 'DECISION: b' }]],
    ]);
  });

  it('orders each list by ticket id ascending', () => {
    const m = model([...toMerged(T3, 0), ...toMerged(T1, 0), ...toMerged(T2, 0)]);
    expect(report(m, 1000).closeMerged.missingPr.map((c) => c.ticket.id)).toEqual([T1, T2, T3]);
  });
});

describe('healthReport: closed tickets appear in no section', () => {
  it('excludes a closed merged ticket and a closed blocked ticket everywhere', () => {
    const m = model([
      // T1: merged, assigned, pr link, open decision, closed.
      ...toMerged(T1, 0),
      E.assign(T1, 'impl-1', at(10)),
      E.link(T1, { pr: 5 }, at(11)),
      E.comment(T1, 'DECISION: closed anyway', at(12, 'impl-1')),
      E.close(T1, { decision: 'docs/adr/0002.md' }, at(13)),
      // T2: blocked for days, assigned, open decision, closed.
      E.create(T2, { title: 'blocked', task: TASK }, at(0)),
      E.claim(T2, at(1, 'impl-2')),
      E.move(T2, 'blocked', at(2, 'impl-2')),
      E.comment(T2, 'DECISION: abandon', at(3, 'impl-2')),
      E.close(T2, { noDecision: true }, at(4)),
    ]);
    const r = report(m, 100 * DAY, { staleAfter: 1, blockedAfter: 1 });
    expect(r.staleClaims).toEqual([]);
    expect(r.stuckBlocked).toEqual([]);
    expect(r.unpromotedDecisions).toEqual([]);
    expect(r.closeMerged).toEqual({ ready: [], heldByDecision: [], missingPr: [] });
  });
});
