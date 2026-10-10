/**
 * `dueGrants`: the grants due at a clock reading and missing from an event
 * set (add-claim-leases task 2.1; board-cli: "Due grants are written during
 * catch-up"; board-events: "Grants").
 *
 * Expected grants are written out by hand from board-events "Grants" (slot
 * time `max(F, J) + 1`, `F` the release wall or the lease's `expiresAt +
 * 60000`), never taken from `dueGrant`, except where a test contrasts the
 * latest-state derivation with the one at the grant's own position.
 */

import { describe, expect, it } from 'vitest';

import { canonicalEncode, canonicalHash } from '../canonical.js';
import { dueGrant, fold, type FoldInput } from '../fold.js';
import { dueGrants } from '../grants.js';
import type { BoardEvent, TicketGrantBody, TicketGrantEvent } from '../schema.js';

const T1 = '01ARYZ6S41TSV4RRFFQ69G5FAV';
const T2 = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const SKEW = 60_000;
const WINDOW = 120_000;
const GRACE = 120_000;
const TTL = 1_800_000;

function input(event: BoardEvent): FoldInput {
  return { hash: canonicalHash(event), event };
}

function at(actor: string, wall: number): { actor: string; ts: BoardEvent['ts'] } {
  return { actor, ts: { wall, counter: 0, actor } };
}

const E = {
  create(wall: number, ticket = T1): FoldInput {
    return input({
      v: 1,
      kind: 'ticket.create',
      ticket,
      ...at('orch', wall),
      body: { title: 'Merge lock' },
    });
  },
  claim(actor: string, wall: number, ticket = T1): FoldInput {
    return input({ v: 1, kind: 'ticket.claim', ticket, ...at(actor, wall), body: {} });
  },
  leased(actor: string, wall: number, ttl = TTL, grace = GRACE): FoldInput {
    return input({
      v: 1,
      kind: 'ticket.claim',
      ticket: T1,
      ...at(actor, wall),
      body: { lease: { ttl, grace, expiresAt: wall + Math.min(ttl, grace) } },
    });
  },
  renew(actor: string, wall: number, ttl = TTL): FoldInput {
    return input({
      v: 1,
      kind: 'ticket.renew',
      ticket: T1,
      ...at(actor, wall),
      body: { ttl, expiresAt: wall + ttl },
    });
  },
  join(actor: string, wall: number, ttl: number, ticket = T1): FoldInput {
    return input({ v: 1, kind: 'ticket.queue.join', ticket, ...at(actor, wall), body: { ttl } });
  },
  leave(actor: string, wall: number): FoldInput {
    return input({ v: 1, kind: 'ticket.queue.leave', ticket: T1, ...at(actor, wall), body: {} });
  },
  release(actor: string, wall: number, ticket = T1): FoldInput {
    return input({ v: 1, kind: 'ticket.release', ticket, ...at(actor, wall), body: {} });
  },
  window(wall: number, value: number): FoldInput {
    return input({
      v: 1,
      kind: 'board.meta',
      ...at('orch', wall),
      body: { key: 'queue.window', value },
    });
  },
};

/** The grant event with slot time `wall`, written out by hand. */
function grant(wall: number, body: TicketGrantBody, ticket = T1): TicketGrantEvent {
  return {
    v: 1,
    kind: 'ticket.grant',
    ticket,
    actor: 'agentboard',
    ts: { wall, counter: 0, actor: 'agentboard' },
    body,
  };
}

/**
 * T1 held by `h` (a plain claim), waiters `a`, `b` and `c` (ttls 600000,
 * 900000 and 1200000), released by `h` at 5000.
 */
function releasedWithThreeWaiters(): { inputs: FoldInput[]; release: FoldInput } {
  const release = E.release('h', 5000);
  return {
    inputs: [
      E.create(1000),
      E.claim('h', 2000),
      E.join('a', 3000, 600_000),
      E.join('b', 3500, 900_000),
      E.join('c', 4000, 1_200_000),
      release,
    ],
    release,
  };
}

/** The chain of grants after `releasedWithThreeWaiters` when nobody renews. */
function expectedChain(release: FoldInput): TicketGrantEvent[] {
  const s1 = 5001;
  const g1 = grant(s1, {
    to: 'a',
    ttl: 600_000,
    window: WINDOW,
    after: { released: release.hash },
  });
  const s2 = s1 + WINDOW + SKEW + 1;
  const g2 = grant(s2, {
    to: 'b',
    ttl: 900_000,
    window: WINDOW,
    after: { lease: { holder: 'a', expiresAt: s1 + WINDOW, event: canonicalHash(g1) } },
  });
  const s3 = s2 + WINDOW + SKEW + 1;
  const g3 = grant(s3, {
    to: 'c',
    ttl: 1_200_000,
    window: WINDOW,
    after: { lease: { holder: 'b', expiresAt: s2 + WINDOW, event: canonicalHash(g2) } },
  });
  return [g1, g2, g3];
}

describe('dueGrants: nothing due', () => {
  it('returns nothing for no events, an empty queue, or a holder without a lease', () => {
    expect(dueGrants([], 10_000_000)).toEqual([]);
    expect(dueGrants([E.create(1000), E.claim('h', 2000), E.release('h', 3000)], 1e12)).toEqual([]);
    expect(
      dueGrants([E.create(1000), E.claim('h', 2000), E.join('a', 3000, 600_000)], 1e12),
    ).toEqual([]);
  });

  it('does not return a grant whose slot time is after the clock', () => {
    const { inputs } = releasedWithThreeWaiters();
    expect(dueGrants(inputs, 5000)).toEqual([]);
    expect(dueGrants(inputs, 5001)).toHaveLength(1);
  });

  it('does not return a grace lapse grant before claim wall + grace + tolerance + 1', () => {
    const claim = E.leased('h', 1000);
    const inputs = [E.create(0), claim, E.join('b', 2000, 600_000)];
    const slot = 1000 + GRACE + SKEW + 1;
    expect(dueGrants(inputs, slot - 1)).toEqual([]);
    const expected = grant(slot, {
      to: 'b',
      ttl: 600_000,
      window: WINDOW,
      after: { lease: { holder: 'h', expiresAt: 1000 + GRACE, event: claim.hash } },
    });
    expect(dueGrants(inputs, slot)).toEqual([input(expected)]);
  });
});

describe('dueGrants: exact grants', () => {
  it('derives the grant to the head waiter after a release, named by its canonical hash', () => {
    const { inputs, release } = releasedWithThreeWaiters();
    const result = dueGrants(inputs, 5001);
    const expected = grant(5001, {
      to: 'a',
      ttl: 600_000,
      window: WINDOW,
      after: { released: release.hash },
    });
    expect(result).toEqual([{ hash: canonicalHash(expected), event: expected }]);
    expect(canonicalEncode(result[0]?.event)).toEqual(canonicalEncode(expected));
  });

  it('returns a chain of three lapsed grants in order when the clock is past every slot', () => {
    const { inputs, release } = releasedWithThreeWaiters();
    const chain = expectedChain(release);
    expect(dueGrants(inputs, 10_000_000)).toEqual(chain.map(input));
  });

  it('stops the chain at the first grant whose slot is after the clock', () => {
    const { inputs, release } = releasedWithThreeWaiters();
    const [g1, g2, g3] = expectedChain(release) as [
      TicketGrantEvent,
      TicketGrantEvent,
      TicketGrantEvent,
    ];
    expect(dueGrants(inputs, g2.ts.wall - 1)).toEqual([input(g1)]);
    expect(dueGrants(inputs, g2.ts.wall)).toEqual([input(g1), input(g2)]);
    expect(dueGrants(inputs, g3.ts.wall - 1)).toEqual([input(g1), input(g2)]);
  });

  it('returns nothing more once the result is added, and the fold applies every grant', () => {
    const { inputs } = releasedWithThreeWaiters();
    const result = dueGrants(inputs, 10_000_000);
    expect(dueGrants([...inputs, ...result], 10_000_000)).toEqual([]);
    const folded = fold([...inputs, ...result]);
    expect(folded.rejected).toEqual([]);
    expect(folded.state.tickets[T1]).toMatchObject({ assignee: 'c', queue: [] });
  });

  it('returns only the missing tail of a chain whose first grant is present', () => {
    const { inputs, release } = releasedWithThreeWaiters();
    const [g1, g2, g3] = expectedChain(release).map(input);
    expect(dueGrants([...inputs, g1 as FoldInput], 10_000_000)).toEqual([g2, g3]);
    expect(dueGrants([...inputs, g1 as FoldInput, g3 as FoldInput], 10_000_000)).toEqual([g2]);
  });

  it('orders grants on several tickets by fold order', () => {
    const r1 = E.release('h', 5000, T1);
    const r2 = E.release('k', 4000, T2);
    const inputs = [
      E.create(1000, T1),
      E.create(1001, T2),
      E.claim('h', 2000, T1),
      E.claim('k', 2001, T2),
      E.join('a', 3000, 600_000, T1),
      E.join('b', 3001, 600_000, T2),
      r1,
      r2,
    ];
    const expected = [
      grant(4001, { to: 'b', ttl: 600_000, window: WINDOW, after: { released: r2.hash } }, T2),
      grant(5001, { to: 'a', ttl: 600_000, window: WINDOW, after: { released: r1.hash } }, T1),
    ];
    expect(dueGrants(inputs, 6000)).toEqual(expected.map(input));
  });

  it('depends on the set of inputs only, not their order or duplicates', () => {
    const { inputs } = releasedWithThreeWaiters();
    const expected = dueGrants(inputs, 10_000_000);
    expect(dueGrants([...inputs].reverse(), 10_000_000)).toEqual(expected);
    expect(dueGrants([...inputs, ...inputs.slice(2)], 10_000_000)).toEqual(expected);
  });
});

describe('dueGrants: each grant is derived at its own fold position', () => {
  it('a renew written after the slot does not suppress the lapse grant', () => {
    const claim = E.leased('h', 1000);
    const renew = E.renew('h', 200_000);
    const inputs = [E.create(0), claim, E.join('b', 2000, 600_000), renew];
    const slot = 1000 + GRACE + SKEW + 1;
    const expected = grant(slot, {
      to: 'b',
      ttl: 600_000,
      window: WINDOW,
      after: { lease: { holder: 'h', expiresAt: 1000 + GRACE, event: claim.hash } },
    });
    // The latest state has the renewed lease, so deriving from it would
    // give no grant until that lease lapses.
    const latest = fold(inputs).state;
    const ticket = latest.tickets[T1];
    if (ticket === undefined) {
      throw new Error('T1 was not folded');
    }
    expect(ticket.lease?.event).toBe(renew.hash);
    expect(dueGrant(ticket, latest.meta)?.ts.wall).toBe(200_000 + TTL + SKEW + 1);
    // At the grant's own position the grace lease had lapsed.
    expect(dueGrants(inputs, 250_000)).toEqual([input(expected)]);
    const after = fold([...inputs, input(expected)]);
    expect(after.state.tickets[T1]?.assignee).toBe('b');
    expect(after.rejected).toEqual([
      { hash: renew.hash, kind: 'ticket.renew', ticket: T1, reason: 'not-assignee' },
    ]);
  });

  it('uses the queue.window in effect at the grant position, not a later one', () => {
    const release = E.release('h', 5000);
    const base = [E.create(1000), E.claim('h', 2000), E.join('a', 3000, 600_000), release];
    const later = dueGrants([...base, E.window(6000, 300_000)], 7000);
    expect(later).toEqual([
      input(
        grant(5001, { to: 'a', ttl: 600_000, window: WINDOW, after: { released: release.hash } }),
      ),
    ]);
    const earlier = dueGrants([...base, E.window(4000, 300_000)], 7000);
    expect(earlier).toEqual([
      input(
        grant(5001, { to: 'a', ttl: 600_000, window: 300_000, after: { released: release.hash } }),
      ),
    ]);
  });

  it('a leave written after the slot does not suppress the grant to the leaver', () => {
    const release = E.release('h', 5000);
    const leave = E.leave('a', 7000);
    const inputs = [E.create(1000), E.claim('h', 2000), E.join('a', 3000, 600_000), release, leave];
    expect(fold(inputs).state.tickets[T1]?.queue).toEqual([]);
    const expected = grant(5001, {
      to: 'a',
      ttl: 600_000,
      window: WINDOW,
      after: { released: release.hash },
    });
    expect(dueGrants(inputs, 8000)).toEqual([input(expected)]);
    const after = fold([...inputs, input(expected)]);
    expect(after.rejected.map((r) => [r.hash, r.reason])).toEqual([[leave.hash, 'invalid-queue']]);
  });
});

describe('dueGrants: grants with equal timestamps', () => {
  /**
   * T1 and T2 are both released at 5000 with one waiter each, so both
   * grants have the timestamp (5001, 0, agentboard) and only their hashes
   * order them. T1 gains its waiter first; T2's waiter asks for `ttl`.
   */
  function tied(ttl: number): { inputs: FoldInput[]; g1: FoldInput; g2: FoldInput } {
    const r1 = E.release('h', 5000, T1);
    const r2 = E.release('k', 5000, T2);
    const inputs = [
      E.create(1000, T1),
      E.create(1001, T2),
      E.claim('h', 2000, T1),
      E.claim('k', 2001, T2),
      E.join('a', 3000, 600_000, T1),
      E.join('b', 3001, ttl, T2),
      r1,
      r2,
    ];
    const g1 = input(
      grant(5001, { to: 'a', ttl: 600_000, window: WINDOW, after: { released: r1.hash } }, T1),
    );
    const g2 = input(
      grant(5001, { to: 'b', ttl, window: WINDOW, after: { released: r2.hash } }, T2),
    );
    return { inputs, g1, g2 };
  }

  /** The first T2 ttl (from 600000, in steps of 1000) giving the wanted hash order. */
  function tiedWith(t1First: boolean): ReturnType<typeof tied> {
    for (let ttl = 600_000; ttl < 700_000; ttl += 1000) {
      const case_ = tied(ttl);
      if (case_.g1.hash < case_.g2.hash === t1First) {
        return case_;
      }
    }
    throw new Error('no ttl gives that hash order');
  }

  for (const t1First of [true, false]) {
    const label = t1First ? "T1's grant hashes lower" : "T2's grant hashes lower";

    it(`orders them by hash when ${label}`, () => {
      const { inputs, g1, g2 } = tiedWith(t1First);
      expect(g1.event.ts).toEqual(g2.event.ts);
      const expected = t1First ? [g1, g2] : [g2, g1];
      expect(dueGrants(inputs, 6000)).toEqual(expected);
      expect(dueGrants([...inputs].reverse(), 6000)).toEqual(expected);
    });

    it(`returns only the missing one when the other is present (${label})`, () => {
      const { inputs, g1, g2 } = tiedWith(t1First);
      expect(dueGrants([...inputs, g1], 6000)).toEqual([g2]);
      expect(dueGrants([...inputs, g2], 6000)).toEqual([g1]);
      const folded = fold([...inputs, g1, g2]);
      expect(folded.rejected).toEqual([]);
      expect(folded.state.tickets[T1]?.assignee).toBe('a');
      expect(folded.state.tickets[T2]?.assignee).toBe('b');
    });
  }
});
