/**
 * The `unplannedScope` section of the health report (board-insights:
 * "Unplanned scope in the health report", the modified "Health report";
 * add-adhoc-ticket-lifecycle design.md section 7; ADR 0013): which tickets
 * are unplanned scope, what each entry carries, the window and the total,
 * the order, and the card's unplanned marker.
 *
 * One expected section is recomputed by `oracle`, a walk over the raw
 * event list that uses neither `healthReport` nor the fold.
 */

import { describe, expect, it } from 'vitest';

import { compareFoldOrder, type FoldInput } from '../../events/fold.js';
import { isKnownEvent, type Status } from '../../events/schema.js';
import { ticketCard } from '../columns.js';
import {
  DEFAULT_THRESHOLDS,
  healthReport,
  type HealthEventRef,
  type HealthReport,
  type HealthThresholds,
  type UnplannedScopeEntry,
} from '../health.js';
import type { BoardModel } from '../types.js';
import { E, T1, T2, T3, T4, T5, T6, T7, TASK, model, ticketOf, type Opts } from './helpers.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** A fixed `now`, late enough for every fixture wall to be positive. */
const NOW = 50 * DAY;

/** Event options with an explicit wall (and counter), so ages are exact. */
function at(wall: number, actor = 'orch', counter = 0): Opts {
  return { wall, actor, counter };
}

/** The `HealthEventRef` of a built event. */
function ref(input: FoldInput): HealthEventRef {
  return { hash: input.hash, kind: input.event.kind, actor: input.event.actor, ts: input.event.ts };
}

/** Thresholds with the given window and the other two defaults. */
function within(unplannedWithin: number): HealthThresholds {
  return { ...DEFAULT_THRESHOLDS, unplannedWithin };
}

function report(m: BoardModel, now = NOW, thresholds = DEFAULT_THRESHOLDS): HealthReport {
  return healthReport({ model: m, now, thresholds });
}

/**
 * An ad hoc ticket created 10 walls before `u` and moved to `review`, then
 * `ticket.unplanned` at wall `u` and the move to `merged` one wall later
 * (the order the command writes them). `unplanned` is the disposition.
 */
function mergedUnplanned(
  ticket: string,
  u: number,
  reason = 'production hotfix',
  adhoc = 'hotfix',
): { inputs: FoldInput[]; unplanned: FoldInput; move: FoldInput } {
  const unplanned = E.unplanned(ticket, reason, at(u));
  const move = E.move(ticket, 'merged', at(u + 1));
  return {
    inputs: [
      E.create(ticket, { title: `t ${ticket}`, adhoc }, at(u - 10)),
      E.move(ticket, 'tests', at(u - 9)),
      E.move(ticket, 'implementing', at(u - 8)),
      E.move(ticket, 'review', at(u - 7)),
      unplanned,
      move,
    ],
    unplanned,
    move,
  };
}

/**
 * An ad hoc ticket created 10 walls before `u`, blocked, then
 * `ticket.unplanned` at wall `u` and closed with no decision one wall later.
 */
function closedUnplanned(
  ticket: string,
  u: number,
  reason = 'abandoned',
  adhoc = 'spike',
): { inputs: FoldInput[]; unplanned: FoldInput; close: FoldInput } {
  const unplanned = E.unplanned(ticket, reason, at(u));
  const close = E.close(ticket, { noDecision: true }, at(u + 1));
  return {
    inputs: [
      E.create(ticket, { title: `t ${ticket}`, adhoc }, at(u - 10)),
      E.move(ticket, 'blocked', at(u - 9)),
      unplanned,
      close,
    ],
    unplanned,
    close,
  };
}

/**
 * An ad hoc ticket closed from `blocked` at wall `c` with no task link and
 * no `ticket.unplanned`: what a board written before ADR 0013 holds.
 */
function closedUndisclosed(
  ticket: string,
  c: number,
  adhoc = 'spike',
): { inputs: FoldInput[]; close: FoldInput } {
  const close = E.close(ticket, { noDecision: true }, at(c));
  return {
    inputs: [
      E.create(ticket, { title: `t ${ticket}`, adhoc }, at(c - 10)),
      E.move(ticket, 'blocked', at(c - 9)),
      close,
    ],
    close,
  };
}

/** The expected entry of `ticket` in `m`. */
function entry(
  m: BoardModel,
  ticket: string,
  fields: Pick<UnplannedScopeEntry, 'adhoc' | 'reason' | 'outcome' | 'ageMs'> & {
    since: FoldInput;
  },
  now = NOW,
): UnplannedScopeEntry {
  return {
    ticket: ticketCard(ticketOf(m, ticket), now),
    adhoc: fields.adhoc,
    reason: fields.reason,
    outcome: fields.outcome,
    since: ref(fields.since),
    ageMs: fields.ageMs,
  };
}

describe('scenario "Window and total"', () => {
  it('counts every unplanned merge and lists those within 7 days, most recent first', () => {
    const one = mergedUnplanned(T1, NOW - DAY, 'one');
    const six = mergedUnplanned(T2, NOW - 6 * DAY, 'six');
    const ten = mergedUnplanned(T3, NOW - 10 * DAY, 'ten');
    const m = model([...ten.inputs, ...one.inputs, ...six.inputs]);
    const { unplannedScope } = report(m);
    expect(unplannedScope.total).toBe(3);
    expect(unplannedScope.tickets).toEqual([
      entry(m, T1, { adhoc: 'hotfix', reason: 'one', outcome: 'merged', since: one.unplanned, ageMs: DAY }),
      entry(m, T2, {
        adhoc: 'hotfix',
        reason: 'six',
        outcome: 'merged',
        since: six.unplanned,
        ageMs: 6 * DAY,
      }),
    ]);
  });

  it('a wider window lists all three and a narrower one none, with the same total', () => {
    const m = model([
      ...mergedUnplanned(T1, NOW - DAY).inputs,
      ...mergedUnplanned(T2, NOW - 6 * DAY).inputs,
      ...mergedUnplanned(T3, NOW - 10 * DAY).inputs,
    ]);
    const wide = report(m, NOW, within(30 * DAY)).unplannedScope;
    expect(wide.total).toBe(3);
    expect(wide.tickets.map((t) => t.ticket.id)).toEqual([T1, T2, T3]);
    const narrow = report(m, NOW, within(HOUR)).unplannedScope;
    expect(narrow.total).toBe(3);
    expect(narrow.tickets).toEqual([]);
  });

  it('includes a disposition a millisecond younger than the window and excludes one exactly as old', () => {
    const u = NOW - WEEK;
    const m = model(mergedUnplanned(T1, u).inputs);
    // Exactly `unplannedWithin` old: not listed (the window is exclusive).
    const exact = report(m, u + WEEK).unplannedScope;
    expect(exact.total).toBe(1);
    expect(exact.tickets).toEqual([]);
    // One millisecond younger: listed.
    const younger = report(m, u + WEEK - 1).unplannedScope;
    expect(younger.tickets.map((t) => [t.ticket.id, t.ageMs])).toEqual([[T1, WEEK - 1]]);
    // The same boundary with a window given explicitly.
    expect(report(m, u + HOUR, within(HOUR)).unplannedScope.tickets).toEqual([]);
    expect(report(m, u + HOUR - 1, within(HOUR)).unplannedScope.tickets).toHaveLength(1);
  });

  it('clamps a disposition with a wall in the future to age 0 and lists it first', () => {
    const future = mergedUnplanned(T2, NOW + 5000, 'from a fast clock');
    const past = mergedUnplanned(T1, NOW - HOUR, 'earlier');
    const m = model([...past.inputs, ...future.inputs]);
    const { unplannedScope } = report(m);
    expect(unplannedScope.tickets).toEqual([
      entry(m, T2, {
        adhoc: 'hotfix',
        reason: 'from a fast clock',
        outcome: 'merged',
        since: future.unplanned,
        ageMs: 0,
      }),
      entry(m, T1, {
        adhoc: 'hotfix',
        reason: 'earlier',
        outcome: 'merged',
        since: past.unplanned,
        ageMs: HOUR,
      }),
    ]);
  });

  it('orders by the disposition wall descending, then by ticket id ascending', () => {
    const m = model([
      ...mergedUnplanned(T3, NOW - 1000).inputs,
      ...mergedUnplanned(T1, NOW - 1000).inputs,
      ...mergedUnplanned(T2, NOW - 500).inputs,
    ]);
    expect(report(m).unplannedScope.tickets.map((t) => [t.ticket.id, t.ageMs])).toEqual([
      [T2, 500],
      [T1, 1000],
      [T3, 1000],
    ]);
  });
});

describe('scenario "Closed tickets are included"', () => {
  it('lists a ticket closed from blocked with --unplanned, although closed tickets are in no other section', () => {
    const u = NOW - HOUR;
    const unplanned = E.unplanned(T1, 'abandoned', at(u));
    const m = model([
      // A claim, a DECISION: and a stay in blocked, so every other section
      // would list it (at zero thresholds) were it open.
      E.create(T1, { title: 't', adhoc: 'spike' }, at(u - 10)),
      E.claim(T1, at(u - 9, 'impl-1')),
      E.comment(T1, 'DECISION: drop it', at(u - 8, 'impl-1')),
      E.move(T1, 'blocked', at(u - 7, 'impl-1')),
      unplanned,
      E.close(T1, { noDecision: true }, at(u + 1)),
    ]);
    expect(m.events.filter((e) => e.outcome !== 'applied')).toEqual([]);
    const r = report(m, NOW, { staleAfter: 0, blockedAfter: 0, unplannedWithin: WEEK });
    expect(r.unplannedScope).toEqual({
      total: 1,
      tickets: [
        entry(m, T1, {
          adhoc: 'spike',
          reason: 'abandoned',
          outcome: 'closed',
          since: unplanned,
          ageMs: HOUR,
        }),
      ],
    });
    expect(r.staleClaims).toEqual([]);
    expect(r.stuckBlocked).toEqual([]);
    expect(r.unpromotedDecisions).toEqual([]);
    expect(r.closeMerged).toEqual({ ready: [], heldByDecision: [], missingPr: [] });
    expect(r.unplannedScope.tickets[0]?.ticket.closed).toBe(true);
  });

  it('measures a closed merged ticket from its disposition with outcome merged', () => {
    const merged = mergedUnplanned(T1, NOW - 2 * DAY);
    const close = E.close(T1, { decision: 'adr/0013.md' }, at(NOW - DAY));
    const m = model([...merged.inputs, close]);
    expect(report(m).unplannedScope.tickets).toEqual([
      entry(m, T1, {
        adhoc: 'hotfix',
        reason: 'production hotfix',
        outcome: 'merged',
        since: merged.unplanned,
        ageMs: 2 * DAY,
      }),
    ]);
  });

  it('measures from the latest applied disposition when a second one replaced the first', () => {
    const merged = mergedUnplanned(T1, NOW - 3 * DAY, 'first wording');
    const again = E.unplanned(T1, 'second wording', at(NOW - DAY));
    const m = model([...merged.inputs, again]);
    expect(ticketOf(m, T1).unplanned?.reason).toBe('second wording');
    expect(report(m).unplannedScope.tickets).toEqual([
      entry(m, T1, {
        adhoc: 'hotfix',
        reason: 'second wording',
        outcome: 'merged',
        since: again,
        ageMs: DAY,
      }),
    ]);
  });
});

describe('scenario "Ticket closed before this change"', () => {
  it('counts an ad hoc ticket closed from blocked with no link and no disposition, with a null reason, from its close', () => {
    const old = closedUndisclosed(T1, NOW - 3 * DAY, 'spike: new parser');
    const m = model(old.inputs);
    expect(ticketOf(m, T1).unplanned).toBeNull();
    const r = report(m);
    expect(r.unplannedScope).toEqual({
      total: 1,
      tickets: [
        entry(m, T1, {
          adhoc: 'spike: new parser',
          reason: null,
          outcome: 'closed',
          since: old.close,
          ageMs: 3 * DAY,
        }),
      ],
    });
    expect(r.unplannedScope.tickets[0]?.since.kind).toBe('ticket.close');
  });

  it('counts it in the total outside the window too', () => {
    const m = model(closedUndisclosed(T1, NOW - 30 * DAY).inputs);
    expect(report(m).unplannedScope).toEqual({ total: 1, tickets: [] });
  });

  it('does not count a planned ticket closed from blocked, nor an ad hoc ticket closed after a link', () => {
    const m = model([
      E.create(T1, { title: 'planned', task: TASK }, at(NOW - 20)),
      E.move(T1, 'blocked', at(NOW - 19)),
      E.close(T1, { noDecision: true }, at(NOW - 18)),
      E.create(T2, { title: 'linked', adhoc: 'found it' }, at(NOW - 17)),
      E.link(T2, { task: TASK }, at(NOW - 16)),
      E.move(T2, 'blocked', at(NOW - 15)),
      E.close(T2, { noDecision: true }, at(NOW - 14)),
    ]);
    expect(ticketOf(m, T2).adhoc).toBeNull();
    expect(report(m).unplannedScope).toEqual({ total: 0, tickets: [] });
  });
});

describe('scenario "Linked and in-flight tickets are not unplanned scope"', () => {
  it('counts neither an undisposed ad hoc ticket in review nor one merged with --task', () => {
    const m = model([
      E.create(T1, { title: 'in review', adhoc: 'seen in production' }, at(NOW - 50)),
      E.move(T1, 'tests', at(NOW - 49)),
      E.move(T1, 'implementing', at(NOW - 48)),
      E.move(T1, 'review', at(NOW - 47)),
      E.create(T2, { title: 'linked at merge', adhoc: 'linked later' }, at(NOW - 40)),
      E.move(T2, 'tests', at(NOW - 39)),
      E.move(T2, 'implementing', at(NOW - 38)),
      E.move(T2, 'review', at(NOW - 37)),
      E.link(T2, { task: { source: 'openspec', ref: 'add-login', item: '2' } }, at(NOW - 36)),
      E.move(T2, 'merged', at(NOW - 35)),
    ]);
    expect(ticketOf(m, T2).status).toBe('merged');
    expect(ticketOf(m, T2).task).not.toBeNull();
    expect(report(m).unplannedScope).toEqual({ total: 0, tickets: [] });
  });

  it('leaves the section once a disposed ticket is linked to a task', () => {
    const merged = mergedUnplanned(T1, NOW - DAY);
    const before = model(merged.inputs);
    expect(before.events.at(-1)?.outcome).toBe('applied');
    expect(report(before).unplannedScope.total).toBe(1);
    const link = E.link(T1, { task: TASK }, at(NOW - HOUR));
    const after = model([...merged.inputs, link]);
    expect(after.events.at(-1)?.outcome).toBe('applied');
    expect(ticketOf(after, T1).unplanned).toBeNull();
    expect(report(after).unplannedScope).toEqual({ total: 0, tickets: [] });
  });

  it('does not count an unplanned disposition on an open ticket outside merged', () => {
    // A command that died between its disposition and its move leaves this.
    const m = model([
      E.create(T1, { title: 'orphaned disposition', adhoc: 'hotfix' }, at(NOW - 50)),
      E.move(T1, 'tests', at(NOW - 49)),
      E.move(T1, 'implementing', at(NOW - 48)),
      E.move(T1, 'review', at(NOW - 47)),
      E.unplanned(T1, 'production hotfix', at(NOW - 46)),
      E.create(T2, { title: 'blocked with a disposition', adhoc: 'spike' }, at(NOW - 40)),
      E.move(T2, 'blocked', at(NOW - 39)),
      E.unplanned(T2, 'abandoned', at(NOW - 38)),
    ]);
    expect(ticketOf(m, T1).unplanned?.reason).toBe('production hotfix');
    expect(ticketOf(m, T2).unplanned?.reason).toBe('abandoned');
    expect(report(m).unplannedScope).toEqual({ total: 0, tickets: [] });
  });

  it('ignores a rejected ticket.unplanned', () => {
    const m = model([
      E.create(T1, { title: 'planned', task: TASK }, at(NOW - 50)),
      E.move(T1, 'tests', at(NOW - 49)),
      E.move(T1, 'implementing', at(NOW - 48)),
      E.move(T1, 'review', at(NOW - 47)),
      // Rejected: already-linked.
      E.unplanned(T1, 'not really', at(NOW - 46)),
      E.move(T1, 'merged', at(NOW - 45)),
    ]);
    expect(m.events[4]?.outcome).toBe('rejected');
    expect(report(m).unplannedScope).toEqual({ total: 0, tickets: [] });
  });
});

describe('the report shape', () => {
  it('echoes unplannedWithin in the thresholds and gives an empty section on an empty board', () => {
    const r = healthReport({ model: model([]), now: NOW, thresholds: within(3 * DAY) });
    expect(r.thresholds).toEqual({ ...DEFAULT_THRESHOLDS, unplannedWithin: 3 * DAY });
    expect(r.unplannedScope).toEqual({ total: 0, tickets: [] });
  });

  it('carries the card of the ticket as the other sections do', () => {
    const merged = mergedUnplanned(T1, NOW - HOUR);
    const m = model(merged.inputs);
    const [only] = report(m).unplannedScope.tickets;
    expect(only?.ticket).toEqual(ticketCard(ticketOf(m, T1), NOW));
    expect(Object.keys(only ?? {}).sort()).toEqual(
      ['adhoc', 'ageMs', 'outcome', 'reason', 'since', 'ticket'].sort(),
    );
  });
});

describe('ticketCard: the unplanned marker (design.md section 8)', () => {
  it('is { reason } for a ticket with an unplanned disposition, beside the ad hoc marker', () => {
    const m = model(mergedUnplanned(T1, NOW - HOUR, 'hotfix reason').inputs);
    const card = ticketCard(ticketOf(m, T1), NOW);
    expect(card.unplanned).toEqual({ reason: 'hotfix reason' });
    expect(card.adhoc).toBe(true);
    expect(card.task).toBeNull();
  });

  it('is null without a disposition, and null again once a task link clears it', () => {
    const m = model([E.create(T1, { title: 'x', adhoc: 'hotfix' }, at(NOW - 10))]);
    expect(ticketCard(ticketOf(m, T1), NOW).unplanned).toBeNull();
    const merged = mergedUnplanned(T2, NOW - HOUR);
    const linked = model([...merged.inputs, E.link(T2, { task: TASK }, at(NOW - 5))]);
    expect(ticketCard(ticketOf(linked, T2), NOW)).toMatchObject({
      unplanned: null,
      adhoc: false,
      task: 'openspec:add-board-web#1',
    });
  });
});

/** What the oracle derives for one unplanned scope ticket. */
interface OracleEntry {
  id: string;
  adhoc: string | null;
  reason: string | null;
  outcome: 'merged' | 'closed';
  since: string;
  ageMs: number;
}

/**
 * Recomputes the section from the raw event list without `healthReport`
 * or the fold: a direct walk of the events in fold order keeping, per
 * ticket, only what the rule needs. Valid for fixtures with no rejected
 * event (every event is assumed applied).
 */
function oracle(
  inputs: readonly FoldInput[],
  now: number,
  unplannedWithin: number,
): { total: number; tickets: OracleEntry[] } {
  interface Seen {
    adhoc: string | null;
    task: boolean;
    unplanned: { reason: string; hash: string; wall: number } | null;
    status: Status;
    closed: boolean;
    close: { hash: string; wall: number } | null;
  }
  const seen = new Map<string, Seen>();
  for (const { hash, event } of [...inputs].sort(compareFoldOrder)) {
    if (!isKnownEvent(event)) {
      throw new Error(`oracle: unknown kind ${event.kind}`);
    }
    if (event.kind === 'board.meta') {
      continue;
    }
    if (event.kind === 'ticket.create') {
      seen.set(event.ticket, {
        adhoc: event.body.adhoc ?? null,
        task: event.body.task !== undefined,
        unplanned: null,
        status: 'todo',
        closed: false,
        close: null,
      });
      continue;
    }
    const s = seen.get(event.ticket);
    if (s === undefined) {
      throw new Error(`oracle: event before create for ${event.ticket}`);
    }
    switch (event.kind) {
      case 'ticket.move':
        s.status = event.body.to;
        break;
      case 'ticket.handoff':
        s.status = event.body.status;
        break;
      case 'ticket.link':
        if ('task' in event.body) {
          s.task = true;
          s.adhoc = null;
          s.unplanned = null;
        }
        break;
      case 'ticket.unplanned':
        s.unplanned = { reason: event.body.reason, hash, wall: event.ts.wall };
        break;
      case 'ticket.close':
        s.closed = true;
        s.close = { hash, wall: event.ts.wall };
        break;
      default:
        break;
    }
  }
  const all: { entry: OracleEntry; wall: number }[] = [];
  for (const [id, s] of seen) {
    if (s.task) {
      continue;
    }
    const outcome = s.status === 'merged' ? 'merged' : 'closed';
    if (s.unplanned !== null && (s.status === 'merged' || s.closed)) {
      const { reason, hash, wall } = s.unplanned;
      all.push({
        entry: { id, adhoc: s.adhoc, reason, outcome, since: hash, ageMs: Math.max(0, now - wall) },
        wall,
      });
    } else if (s.closed && s.adhoc !== null && s.unplanned === null && s.close !== null) {
      const { hash, wall } = s.close;
      all.push({
        entry: { id, adhoc: s.adhoc, reason: null, outcome, since: hash, ageMs: Math.max(0, now - wall) },
        wall,
      });
    }
  }
  const tickets = all
    .filter((e) => e.entry.ageMs < unplannedWithin)
    .sort((a, b) => b.wall - a.wall || (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0))
    .map((e) => e.entry);
  return { total: all.length, tickets };
}

describe('recomputed by an independent oracle', () => {
  /**
   * T1 merged unplanned 2 days ago; T2 closed unplanned from blocked 3
   * hours ago; T3 closed undisclosed 9 days ago; T4 ad hoc in review; T5
   * merged with a task link; T6 merged unplanned then linked; T7 merged
   * unplanned 8 days ago and closed since.
   */
  function inputs(): FoldInput[] {
    return [
      ...mergedUnplanned(T1, NOW - 2 * DAY, 'two days').inputs,
      ...closedUnplanned(T2, NOW - 3 * HOUR, 'three hours').inputs,
      ...closedUndisclosed(T3, NOW - 9 * DAY, 'old spike').inputs,
      E.create(T4, { title: 't4', adhoc: 'in flight' }, at(NOW - 100)),
      E.move(T4, 'tests', at(NOW - 99)),
      E.move(T4, 'implementing', at(NOW - 98)),
      E.move(T4, 'review', at(NOW - 97)),
      E.create(T5, { title: 't5', adhoc: 'linked at merge' }, at(NOW - 90)),
      E.move(T5, 'tests', at(NOW - 89)),
      E.move(T5, 'implementing', at(NOW - 88)),
      E.move(T5, 'review', at(NOW - 87)),
      E.link(T5, { task: TASK }, at(NOW - 86)),
      E.move(T5, 'merged', at(NOW - 85)),
      ...mergedUnplanned(T6, NOW - 4 * DAY, 'then linked').inputs,
      E.link(T6, { task: TASK }, at(NOW - 3 * DAY)),
      ...mergedUnplanned(T7, NOW - 8 * DAY, 'eight days').inputs,
      E.close(T7, { noDecision: true }, at(NOW - 7 * DAY)),
    ];
  }

  function flatten(r: HealthReport): { total: number; tickets: OracleEntry[] } {
    return {
      total: r.unplannedScope.total,
      tickets: r.unplannedScope.tickets.map((t) => ({
        id: t.ticket.id,
        adhoc: t.adhoc,
        reason: t.reason,
        outcome: t.outcome,
        since: t.since.hash,
        ageMs: t.ageMs,
      })),
    };
  }

  it('the fixture has no rejected event, so the oracle walk is exact', () => {
    const m = model(inputs());
    expect(m.events.filter((e) => e.outcome !== 'applied')).toEqual([]);
  });

  it.each([
    ['the default window', WEEK],
    ['a 30 day window', 30 * DAY],
    ['a 1 hour window', HOUR],
  ])('matches the oracle with %s', (_name, unplannedWithin) => {
    const events = inputs();
    const m = model(events);
    const want = oracle(events, NOW, unplannedWithin);
    expect(flatten(report(m, NOW, within(unplannedWithin)))).toEqual(want);
    // The oracle itself sees what the scenarios say it should.
    if (unplannedWithin === WEEK) {
      expect(want.total).toBe(4);
      expect(want.tickets.map((t) => [t.id, t.reason])).toEqual([
        [T2, 'three hours'],
        [T1, 'two days'],
      ]);
    }
  });
});
