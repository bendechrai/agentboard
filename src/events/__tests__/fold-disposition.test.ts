/**
 * The scope disposition in the fold (add-adhoc-ticket-lifecycle task 1.2;
 * board-events: "Fold semantics" and "Unplanned disposition";
 * board-openspec-integration: "Scope disposition at merge and close"):
 * a move or hand-off into `merged` needs a task reference or an unplanned
 * disposition (`needs-scope-disposition`), `ticket.unplanned` records the
 * disposition unless the ticket is linked (`already-linked`), a task link
 * clears it, and `ticket.close` is left without the rule. Every scenario
 * of the two requirements is a table row or a test here; the ad hoc moves
 * through the work statuses are in fold.test.ts.
 */

import { describe, expect, it } from 'vitest';

import { applyEvent, fold, type BoardState, type FoldInput, type Ticket } from '../fold.js';
import type { Hlc } from '../hlc.js';
import type { JsonValue } from '../json.js';
import type {
  Status,
  TaskRef,
  TicketCloseBody,
  TicketCreateBody,
  TicketLinkBody,
} from '../schema.js';

const T1 = '01ARYZ6S41TSV4RRFFQ69G5FAV';
const T2 = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const NEVER_CREATED = '01CAAAAAAAAAAAAAAAAAAAAAAA';

const TASK: TaskRef = { source: 'openspec', ref: 'add-login', item: '2' };

const hex = (n: number): string => n.toString(16).padStart(64, '0');

interface Opts {
  actor?: string;
  wall?: number;
  counter?: number;
}

let seq = 0;
function stamp(o: Opts): { hash: string; actor: string; ts: Hlc } {
  seq += 1;
  const actor = o.actor ?? 'orch';
  return {
    hash: hex(seq),
    actor,
    ts: { wall: o.wall ?? 100_000 + seq * 10, counter: o.counter ?? 0, actor },
  };
}

const E = {
  create(ticket: string, body: TicketCreateBody, o: Opts = {}): FoldInput {
    const s = stamp(o);
    return {
      hash: s.hash,
      event: { v: 1, kind: 'ticket.create', ticket, actor: s.actor, ts: s.ts, body },
    };
  },
  move(ticket: string, to: Status, o: Opts = {}): FoldInput {
    const s = stamp(o);
    return {
      hash: s.hash,
      event: { v: 1, kind: 'ticket.move', ticket, actor: s.actor, ts: s.ts, body: { to } },
    };
  },
  claim(ticket: string, o: Opts = {}): FoldInput {
    const s = stamp(o);
    return {
      hash: s.hash,
      event: { v: 1, kind: 'ticket.claim', ticket, actor: s.actor, ts: s.ts, body: {} },
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
  unplanned(ticket: string, reason: string, o: Opts = {}): FoldInput {
    const s = stamp(o);
    return {
      hash: s.hash,
      event: { v: 1, kind: 'ticket.unplanned', ticket, actor: s.actor, ts: s.ts, body: { reason } },
    };
  },
  comment(ticket: string, text: string, o: Opts = {}): FoldInput {
    const s = stamp(o);
    return {
      hash: s.hash,
      event: { v: 1, kind: 'ticket.comment', ticket, actor: s.actor, ts: s.ts, body: { text } },
    };
  },
};

function ticketOf(state: BoardState, id: string): Ticket {
  const t = state.tickets[id];
  if (t === undefined) {
    throw new Error(`ticket ${id} not in state`);
  }
  return t;
}

/** An ad hoc ticket (reason `hotfix`) created and moved to `status`. */
function adhocIn(status: Status, ticket = T1): FoldInput[] {
  const paths: Record<Status, Status[]> = {
    todo: [],
    tests: ['tests'],
    implementing: ['tests', 'implementing'],
    review: ['tests', 'implementing', 'review'],
    merged: ['tests', 'implementing', 'review', 'merged'],
    blocked: ['tests', 'blocked'],
  };
  return [
    E.create(ticket, { title: 'Fix login redirect', adhoc: 'hotfix' }),
    ...paths[status].map((s) => E.move(ticket, s)),
  ];
}

describe('fold: undisposed ticket cannot enter merged', () => {
  it('scenario: a move to merged from review is rejected with needs-scope-disposition', () => {
    const setup = adhocIn('review');
    const mv = E.move(T1, 'merged');
    const result = fold([...setup, mv]);
    expect(result.rejected).toEqual([
      { hash: mv.hash, kind: 'ticket.move', ticket: T1, reason: 'needs-scope-disposition' },
    ]);
    const t = ticketOf(result.state, T1);
    expect(t.status).toBe('review');
    expect(t.task).toBeNull();
    expect(t.unplanned).toBeNull();
  });

  it('scenario: a hand-off with status merged is rejected the same way, with none of its effects', () => {
    const setup = adhocIn('review');
    const before = ticketOf(fold(setup).state, T1);
    const h = E.handoff(T1, 'merger', 'merged', 'landed', { actor: 'reviewer' });
    const result = fold([...setup, h]);
    expect(result.rejected).toEqual([
      { hash: h.hash, kind: 'ticket.handoff', ticket: T1, reason: 'needs-scope-disposition' },
    ]);
    expect(ticketOf(result.state, T1)).toEqual(before);
  });

  it('a rejected move changes neither version nor updatedAt', () => {
    const setup = adhocIn('review');
    const before = ticketOf(fold(setup).state, T1);
    const result = fold([...setup, E.move(T1, 'merged')]);
    const t = ticketOf(result.state, T1);
    expect(t.version).toBe(before.version);
    expect(t.updatedAt).toEqual(before.updatedAt);
  });

  it('a ticket with neither task nor adhoc is refused the same way', () => {
    const setup = [
      E.create(T1, { title: 'bare' }),
      E.move(T1, 'tests'),
      E.move(T1, 'implementing'),
      E.move(T1, 'review'),
    ];
    const mv = E.move(T1, 'merged');
    expect(fold([...setup, mv]).rejected).toEqual([
      { hash: mv.hash, kind: 'ticket.move', ticket: T1, reason: 'needs-scope-disposition' },
    ]);
  });

  it('reports invalid-transition before needs-scope-disposition', () => {
    for (const status of ['todo', 'tests', 'implementing', 'blocked'] as const) {
      const setup = adhocIn(status);
      const mv = E.move(T1, 'merged');
      const result = fold([...setup, mv]);
      expect(result.rejected, status).toEqual([
        { hash: mv.hash, kind: 'ticket.move', ticket: T1, reason: 'invalid-transition' },
      ]);
    }
  });

  it('applies to no status but merged: tests, implementing, review and blocked need nothing', () => {
    const result = fold([
      E.create(T1, { title: 'x', adhoc: 'h' }),
      E.move(T1, 'tests'),
      E.move(T1, 'implementing'),
      E.move(T1, 'review'),
      E.move(T1, 'blocked'),
      E.move(T1, 'review'),
      E.handoff(T1, 'impl', 'implementing', 'again'),
    ]);
    expect(result.rejected).toEqual([]);
    expect(ticketOf(result.state, T1).status).toBe('implementing');
  });

  it('scenario: a planned ticket enters merged with no disposition, exactly as before', () => {
    const result = fold([
      E.create(T1, { title: 'Login form', task: TASK }),
      E.move(T1, 'tests'),
      E.move(T1, 'implementing'),
      E.move(T1, 'review'),
      E.move(T1, 'merged'),
      E.close(T1, { noDecision: true }),
    ]);
    expect(result.rejected).toEqual([]);
    const t = ticketOf(result.state, T1);
    expect(t.status).toBe('merged');
    expect(t.closed).toBe(true);
    expect(t.unplanned).toBeNull();
  });

  it('scenario: a ticket linked earlier needs nothing more', () => {
    const result = fold([
      ...adhocIn('implementing'),
      E.link(T1, { task: TASK }),
      E.move(T1, 'review'),
      E.move(T1, 'merged'),
    ]);
    expect(result.rejected).toEqual([]);
    const t = ticketOf(result.state, T1);
    expect(t.status).toBe('merged');
    expect(t.task).toEqual(TASK);
    expect(t.adhoc).toBeNull();
  });

  it('a hand-off into merged applies once the ticket is disposed', () => {
    const result = fold([
      ...adhocIn('review'),
      E.unplanned(T1, 'hotfix, no plan', { actor: 'reviewer' }),
      E.handoff(T1, 'merger', 'merged', 'landed', { actor: 'reviewer' }),
    ]);
    expect(result.rejected).toEqual([]);
    const t = ticketOf(result.state, T1);
    expect(t.status).toBe('merged');
    expect(t.assignee).toBe('merger');
    expect(t.comments.map((c) => c.text)).toEqual(['landed']);
  });

  it('applyEvent reports the rejection and leaves the given state unchanged', () => {
    const state = fold(adhocIn('review')).state;
    const before = JSON.stringify(state);
    const mv = E.move(T1, 'merged');
    expect(applyEvent(state, mv)).toEqual({
      status: 'rejected',
      rejected: { hash: mv.hash, kind: 'ticket.move', ticket: T1, reason: 'needs-scope-disposition' },
    });
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe('fold: ticket.unplanned', () => {
  it('scenario: unplanned then merged applies both, keeps adhoc and counts two versions', () => {
    const setup = adhocIn('review');
    const before = ticketOf(fold(setup).state, T1);
    const u = E.unplanned(T1, 'hotfix', { actor: 'orch' });
    const result = fold([...setup, u, E.move(T1, 'merged', { actor: 'orch' })]);
    expect(result.rejected).toEqual([]);
    const t = ticketOf(result.state, T1);
    expect(t.status).toBe('merged');
    expect(t.unplanned).toEqual({ reason: 'hotfix', actor: 'orch', ts: u.event.ts });
    expect(t.adhoc).toBe('hotfix');
    expect(t.task).toBeNull();
    expect(t.version).toBe(before.version + 2);
  });

  it('copies the timestamp rather than sharing it with the event', () => {
    const setup = adhocIn('review');
    const u = E.unplanned(T1, 'hotfix');
    const t = ticketOf(fold([...setup, u]).state, T1);
    expect(t.unplanned?.ts).toEqual(u.event.ts);
    expect(t.unplanned?.ts).not.toBe(u.event.ts);
  });

  it('scenario: unplanned on a linked ticket is rejected with already-linked and the ticket is unchanged', () => {
    const setup = [
      E.create(T1, { title: 'Login form', task: TASK }),
      E.move(T1, 'tests'),
      E.move(T1, 'implementing'),
    ];
    const before = ticketOf(fold(setup).state, T1);
    const u = E.unplanned(T1, 'y');
    const result = fold([...setup, u]);
    expect(result.rejected).toEqual([
      { hash: u.hash, kind: 'ticket.unplanned', ticket: T1, reason: 'already-linked' },
    ]);
    expect(ticketOf(result.state, T1)).toEqual(before);
  });

  it('is rejected with already-linked after a task link too, and the earlier disposition stays cleared', () => {
    const setup = [...adhocIn('review'), E.unplanned(T1, 'first'), E.link(T1, { task: TASK })];
    const u = E.unplanned(T1, 'second');
    const result = fold([...setup, u]);
    expect(result.rejected).toEqual([
      { hash: u.hash, kind: 'ticket.unplanned', ticket: T1, reason: 'already-linked' },
    ]);
    const t = ticketOf(result.state, T1);
    expect(t.unplanned).toBeNull();
    expect(t.task).toEqual(TASK);
  });

  it('scenario: a later task link clears the disposition and the ad hoc reason', () => {
    const result = fold([
      ...adhocIn('review'),
      E.unplanned(T1, 'hotfix'),
      E.move(T1, 'merged'),
      E.link(T1, { task: TASK }),
    ]);
    expect(result.rejected).toEqual([]);
    const t = ticketOf(result.state, T1);
    expect(t.task).toEqual(TASK);
    expect(t.adhoc).toBeNull();
    expect(t.unplanned).toBeNull();
    expect(t.status).toBe('merged');
  });

  it('pr and decision links leave the disposition alone', () => {
    const setup = adhocIn('review');
    const u = E.unplanned(T1, 'hotfix');
    const result = fold([
      ...setup,
      u,
      E.move(T1, 'merged'),
      E.link(T1, { pr: 42 }),
      E.link(T1, { decision: 'adr/0013.md' }),
    ]);
    expect(result.rejected).toEqual([]);
    const t = ticketOf(result.state, T1);
    expect(t.unplanned).toEqual({ reason: 'hotfix', actor: 'orch', ts: u.event.ts });
    expect(t.links).toHaveLength(2);
  });

  it('scenario: a disposition without its move is a valid state, and a later move needs nothing', () => {
    const setup = adhocIn('review');
    const u = E.unplanned(T1, 'hotfix', { actor: 'orch' });
    const partial = fold([...setup, u]);
    expect(partial.rejected).toEqual([]);
    const t = ticketOf(partial.state, T1);
    expect(t.status).toBe('review');
    expect(t.unplanned).toEqual({ reason: 'hotfix', actor: 'orch', ts: u.event.ts });

    const later = fold([...setup, u, E.move(T1, 'merged', { actor: 'other' })]);
    expect(later.rejected).toEqual([]);
    expect(ticketOf(later.state, T1).status).toBe('merged');
  });

  it('a second unplanned replaces the first: reason, actor and ts', () => {
    const setup = adhocIn('review');
    const first = E.unplanned(T1, 'first thought', { actor: 'a' });
    const second = E.unplanned(T1, 'on reflection', { actor: 'b' });
    const result = fold([...setup, first, second]);
    expect(result.rejected).toEqual([]);
    const t = ticketOf(result.state, T1);
    expect(t.unplanned).toEqual({ reason: 'on reflection', actor: 'b', ts: second.event.ts });
    expect(t.version).toBe(6);
  });

  it.each(['todo', 'tests', 'implementing', 'review', 'merged', 'blocked'] as Status[])(
    'applies in %s, changing only the disposition, version and updatedAt',
    (status) => {
      const setup =
        status === 'merged'
          ? [...adhocIn('review'), E.unplanned(T1, 'x'), E.move(T1, 'merged')]
          : adhocIn(status);
      const before = ticketOf(fold(setup).state, T1);
      const u = E.unplanned(T1, 'why', { actor: 'reviewer' });
      const result = fold([...setup, u]);
      expect(result.rejected).toEqual([]);
      const t = ticketOf(result.state, T1);
      expect(t).toEqual({
        ...before,
        unplanned: { reason: 'why', actor: 'reviewer', ts: u.event.ts },
        version: before.version + 1,
        updatedAt: u.event.ts,
      });
    },
  );

  it('applies on a closed ticket too', () => {
    const setup = [...adhocIn('blocked'), E.close(T1, { noDecision: true })];
    const before = ticketOf(fold(setup).state, T1);
    const u = E.unplanned(T1, 'abandoned: superseded');
    const result = fold([...setup, u]);
    expect(result.rejected).toEqual([]);
    const t = ticketOf(result.state, T1);
    expect(t.closed).toBe(true);
    expect(t.disposition).toEqual({ noDecision: true });
    expect(t.unplanned?.reason).toBe('abandoned: superseded');
    expect(t.version).toBe(before.version + 1);
  });

  it('leaves the assignee alone', () => {
    const result = fold([
      ...adhocIn('review'),
      E.claim(T1, { actor: 'impl' }),
      E.unplanned(T1, 'x', { actor: 'orch' }),
    ]);
    expect(result.rejected).toEqual([]);
    expect(ticketOf(result.state, T1).assignee).toBe('impl');
  });

  it('is held aside with unknown-ticket before its create', () => {
    const u = E.unplanned(NEVER_CREATED, 'x');
    const result = fold([E.create(T1, { title: 'x', adhoc: 'h' }), u]);
    expect(result.rejected).toEqual([
      { hash: u.hash, kind: 'ticket.unplanned', ticket: NEVER_CREATED, reason: 'unknown-ticket' },
    ]);
    expect(Object.keys(result.state.tickets)).toEqual([T1]);
  });

  it('keeps tickets independent: a disposition on one does not dispose another', () => {
    const result = fold([
      ...adhocIn('review', T1),
      ...adhocIn('review', T2),
      E.unplanned(T1, 'x'),
      E.move(T1, 'merged'),
      E.move(T2, 'merged'),
    ]);
    expect(result.rejected.map((r) => [r.ticket, r.reason])).toEqual([
      [T2, 'needs-scope-disposition'],
    ]);
    expect(ticketOf(result.state, T1).status).toBe('merged');
    expect(ticketOf(result.state, T2).status).toBe('review');
    expect(ticketOf(result.state, T2).unplanned).toBeNull();
  });

  it('is null at create, whether the ticket is planned or ad hoc', () => {
    const result = fold([
      E.create(T1, { title: 'x', task: TASK }),
      E.create(T2, { title: 'y', adhoc: 'h' }),
    ]);
    expect(ticketOf(result.state, T1).unplanned).toBeNull();
    expect(ticketOf(result.state, T2).unplanned).toBeNull();
  });

  it('applyEvent applies it to the given state and reports applied', () => {
    const state = fold(adhocIn('review')).state;
    const u = E.unplanned(T1, 'hotfix', { actor: 'orch' });
    expect(applyEvent(state, u)).toEqual({ status: 'applied' });
    expect(ticketOf(state, T1).unplanned).toEqual({
      reason: 'hotfix',
      actor: 'orch',
      ts: u.event.ts,
    });
  });
});

describe('fold: close is left without the scope disposition rule', () => {
  it('scenario: a close of an undisposed ad hoc ticket from blocked still folds', () => {
    // A log written before the disposition existed: ad hoc, blocked, closed
    // with no decision, no task link and no ticket.unplanned.
    const result = fold([...adhocIn('blocked'), E.close(T1, { noDecision: true })]);
    expect(result.rejected).toEqual([]);
    const t = ticketOf(result.state, T1);
    expect(t.closed).toBe(true);
    expect(t.disposition).toEqual({ noDecision: true });
    expect(t.status).toBe('blocked');
    expect(t.task).toBeNull();
    expect(t.unplanned).toBeNull();
    expect(t.adhoc).toBe('hotfix');
  });

  it('closes an undisposed ad hoc ticket with a decision path from blocked', () => {
    const result = fold([...adhocIn('blocked'), E.close(T1, { decision: 'adr/0007.md' })]);
    expect(result.rejected).toEqual([]);
    expect(ticketOf(result.state, T1).disposition).toEqual({ decision: 'adr/0007.md' });
  });

  it('closes a merged ticket that was disposed as unplanned, keeping the disposition', () => {
    const setup = adhocIn('review');
    const u = E.unplanned(T1, 'hotfix');
    const result = fold([
      ...setup,
      u,
      E.move(T1, 'merged'),
      E.close(T1, { noDecision: true }),
      E.comment(T1, 'post-close note'),
    ]);
    expect(result.rejected).toEqual([]);
    const t = ticketOf(result.state, T1);
    expect(t.closed).toBe(true);
    expect(t.unplanned?.reason).toBe('hotfix');
    expect(t.comments.map((c) => c.text)).toEqual(['post-close note']);
  });

  it('still refuses a close from a work status with invalid-transition', () => {
    const setup = [...adhocIn('review'), E.unplanned(T1, 'x')];
    const cl = E.close(T1, { noDecision: true });
    expect(fold([...setup, cl]).rejected).toEqual([
      { hash: cl.hash, kind: 'ticket.close', ticket: T1, reason: 'invalid-transition' },
    ]);
  });
});

describe('fold: the disposition serializes canonically', () => {
  it('produces plain JSON values for the unplanned field', () => {
    const result = fold([...adhocIn('review'), E.unplanned(T1, 'hotfix'), E.move(T1, 'merged')]);
    const value = JSON.parse(JSON.stringify(result.state)) as {
      tickets: Record<string, { unplanned: JsonValue }>;
    };
    expect(value.tickets[T1]?.unplanned).toEqual({
      reason: 'hotfix',
      actor: 'orch',
      ts: { wall: expect.any(Number) as number, counter: 0, actor: 'orch' },
    });
  });
});
