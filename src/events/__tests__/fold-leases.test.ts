/**
 * Table tests for the lease, queue and grant rules of the fold
 * (add-claim-leases tasks 1.2 and 1.3; board-events: "Claim leases",
 * "Forced release", "Waiting queue", "Grants", "Board lease settings" and
 * the modified "Fold semantics").
 *
 * Every event carries its real content hash (`canonicalHash`), so the
 * `event` of a lease, a `supersedes` and an `after` are what a board would
 * hold. Expected grants are written out by hand from the spec, never taken
 * from `dueGrant`, except where a test says it derives one.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { canonicalEncode, canonicalHash, type JsonValue } from '../canonical.js';
import {
  applyEvent,
  dueGrant,
  fold,
  leaseGrace,
  queueWindow,
  type BoardState,
  type FoldInput,
  type FoldResult,
  type Ticket,
} from '../fold.js';
import type {
  BoardEvent,
  ClaimLease,
  LeaseRef,
  Status,
  TaskRef,
  TicketClaimBody,
  TicketGrantBody,
  TicketGrantEvent,
} from '../schema.js';

const T1 = '01ARYZ6S41TSV4RRFFQ69G5FAV';
const T2 = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const TASK: TaskRef = { source: 'openspec', ref: 'merge-lock', item: '1' };

const GRACE = 120_000;
const TTL = 1_800_000;
const WINDOW = 120_000;

/** A fold input for `event`, named by its real hash. */
function input(event: BoardEvent): FoldInput {
  return { hash: canonicalHash(event), event };
}

function ts(actor: string, wall: number, counter = 0): { actor: string; ts: BoardEvent['ts'] } {
  return { actor, ts: { wall, counter, actor } };
}

const E = {
  create(wall = 0, ticket = T1): FoldInput {
    return input({
      v: 1,
      kind: 'ticket.create',
      ticket,
      ...ts('orch', wall),
      body: { title: 'Merge lock', task: TASK },
    });
  },
  claim(actor: string, wall: number, body: TicketClaimBody = {}, ticket = T1): FoldInput {
    return input({ v: 1, kind: 'ticket.claim', ticket, ...ts(actor, wall), body });
  },
  /** A claim with a lease of `ttl` and `grace`, expiring at `wall + min(ttl, grace)`. */
  leased(actor: string, wall: number, ttl = TTL, grace = GRACE, extra: TicketClaimBody = {}) {
    const lease: ClaimLease = { ttl, grace, expiresAt: wall + Math.min(ttl, grace) };
    return E.claim(actor, wall, { lease, ...extra });
  },
  renew(actor: string, wall: number, ttl = TTL, counter = 0, ticket = T1): FoldInput {
    return input({
      v: 1,
      kind: 'ticket.renew',
      ticket,
      ...ts(actor, wall, counter),
      body: { ttl, expiresAt: wall + ttl },
    });
  },
  release(actor: string, wall: number, ticket = T1): FoldInput {
    return input({ v: 1, kind: 'ticket.release', ticket, ...ts(actor, wall), body: {} });
  },
  force(actor: string, wall: number, holder: string, reason = 'gone', ticket = T1): FoldInput {
    return input({
      v: 1,
      kind: 'ticket.release.force',
      ticket,
      ...ts(actor, wall),
      body: { holder, reason },
    });
  },
  join(actor: string, wall: number, ttl = TTL, counter = 0, ticket = T1): FoldInput {
    return input({
      v: 1,
      kind: 'ticket.queue.join',
      ticket,
      ...ts(actor, wall, counter),
      body: { ttl },
    });
  },
  leave(actor: string, wall: number, ticket = T1): FoldInput {
    return input({ v: 1, kind: 'ticket.queue.leave', ticket, ...ts(actor, wall), body: {} });
  },
  handoff(actor: string, wall: number, to: string, status: Status, ticket = T1): FoldInput {
    return input({
      v: 1,
      kind: 'ticket.handoff',
      ticket,
      ...ts(actor, wall),
      body: { to, status, note: 'over to you' },
    });
  },
  assign(actor: string, wall: number, to: string, ticket = T1): FoldInput {
    return input({ v: 1, kind: 'ticket.assign', ticket, ...ts(actor, wall), body: { to } });
  },
  move(actor: string, wall: number, to: Status, ticket = T1): FoldInput {
    return input({ v: 1, kind: 'ticket.move', ticket, ...ts(actor, wall), body: { to } });
  },
  comment(actor: string, wall: number, text: string, ticket = T1): FoldInput {
    return input({ v: 1, kind: 'ticket.comment', ticket, ...ts(actor, wall), body: { text } });
  },
  meta(key: string, value: JsonValue, wall: number): FoldInput {
    return input({ v: 1, kind: 'board.meta', ...ts('orch', wall), body: { key, value } });
  },
  grant(event: TicketGrantEvent): FoldInput {
    return input(event);
  },
};

/** A grant event written out by hand: actor `agentboard`, counter 0. */
function grantEvent(wall: number, body: TicketGrantBody, ticket = T1): TicketGrantEvent {
  return {
    v: 1,
    kind: 'ticket.grant',
    ticket,
    actor: 'agentboard',
    ts: { wall, counter: 0, actor: 'agentboard' },
    body,
  };
}

/** `supersedes` / `after.lease` naming the lease set by `setter`, held by `holder`. */
function leaseRef(holder: string, expiresAt: number, setter: FoldInput): LeaseRef {
  return { holder, expiresAt, event: setter.hash };
}

function ticketOf(result: FoldResult, id = T1): Ticket {
  const t = result.state.tickets[id];
  if (t === undefined) {
    throw new Error(`ticket ${id} not in state`);
  }
  return t;
}

function reasonOf(result: FoldResult, item: FoldInput): string | null {
  return result.rejected.find((r) => r.hash === item.hash)?.reason ?? null;
}

/** Folds `inputs` and returns the grant due on T1 at the end, as `dueGrant` derives it. */
function due(inputs: readonly FoldInput[], id = T1): TicketGrantEvent | null {
  const { state } = fold(inputs);
  return dueGrant(ticketOf({ state, rejected: [], unknown: [], latest: null }, id), state.meta);
}

function bytesOf(result: FoldResult): string {
  return new TextDecoder().decode(
    canonicalEncode({
      state: result.state,
      rejected: result.rejected,
      unknown: result.unknown,
      latest: result.latest,
    }),
  );
}

/** Every permutation of a short list. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) {
    return [[...items]];
  }
  const out: T[][] = [];
  items.forEach((item, i) => {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) {
      out.push([item, ...tail]);
    }
  });
  return out;
}

/** Asserts every read order of `inputs` folds to the same bytes, and returns the fold. */
function foldEveryOrder(inputs: readonly FoldInput[]): FoldResult {
  const reference = fold(inputs);
  const expected = bytesOf(reference);
  for (const order of permutations(inputs)) {
    expect(bytesOf(fold(order))).toBe(expected);
  }
  return reference;
}

// ---------------------------------------------------------------------------

describe('fold: a new ticket has no lease, no queue and no availability', () => {
  it('creates with lease null, queue [] and available null', () => {
    const t = ticketOf(fold([E.create()]));
    expect({ lease: t.lease, queue: t.queue, available: t.available }).toEqual({
      lease: null,
      queue: [],
      available: null,
    });
  });

  it('a plain claim leaves the lease null and nothing available', () => {
    const t = ticketOf(fold([E.create(), E.claim('h', 1000)]));
    expect(t.assignee).toBe('h');
    expect(t.lease).toBeNull();
    expect(t.available).toBeNull();
  });
});

describe('fold: claim leases', () => {
  it('a leased claim holds the ticket under an unconfirmed grace lease', () => {
    const claim = E.leased('h', 1_000_000);
    const result = fold([E.create(), claim]);
    const t = ticketOf(result);
    expect(result.rejected).toEqual([]);
    expect(t.assignee).toBe('h');
    expect(t.lease).toEqual({
      ttl: TTL,
      expiresAt: 1_120_000,
      event: claim.hash,
      confirmed: false,
    });
    expect(t.available).toEqual({ at: 1_180_000, event: claim.hash });
  });

  it('a lease shorter than the grace expires at the ttl', () => {
    const claim = E.leased('h', 1_000_000, 60_000, 120_000);
    expect(ticketOf(fold([E.create(), claim])).lease).toEqual({
      ttl: 60_000,
      expiresAt: 1_060_000,
      event: claim.hash,
      confirmed: false,
    });
  });

  it('unconfirmed claim lapses after its grace (spec scenario)', () => {
    const claim = E.leased('h', 1_000_000);
    const takeover = E.claim('c', 1_180_000, {
      supersedes: leaseRef('h', 1_120_000, claim),
    });
    const result = fold([E.create(), claim, takeover]);
    expect(result.rejected).toEqual([]);
    expect(ticketOf(result).assignee).toBe('c');
    expect(ticketOf(result).lease).toBeNull();
    expect(ticketOf(result).available).toBeNull();
  });

  it('a takeover one millisecond before expiresAt + LEASE_SKEW_MS is rejected', () => {
    const claim = E.leased('h', 1_000_000);
    const takeover = E.claim('c', 1_179_999, { supersedes: leaseRef('h', 1_120_000, claim) });
    const result = fold([E.create(), claim, takeover]);
    expect(reasonOf(result, takeover)).toBe('already-assigned');
    expect(ticketOf(result).assignee).toBe('h');
    expect(ticketOf(result).lease?.event).toBe(claim.hash);
  });

  it('a takeover with its own lease takes that lease, unconfirmed', () => {
    const claim = E.leased('h', 1_000_000);
    const takeover = E.leased('c', 1_200_000, 600_000, 300_000, {
      supersedes: leaseRef('h', 1_120_000, claim),
    });
    const t = ticketOf(fold([E.create(), claim, takeover]));
    expect(t.assignee).toBe('c');
    expect(t.lease).toEqual({
      ttl: 600_000,
      expiresAt: 1_500_000,
      event: takeover.hash,
      confirmed: false,
    });
    expect(t.available).toEqual({ at: 1_560_000, event: takeover.hash });
  });

  it('first renew confirms the requested ttl (spec scenario)', () => {
    const claim = E.leased('h', 1_000_000, TTL, GRACE);
    const renew = E.renew('h', 1_060_000, TTL);
    const takeover = E.claim('c', 1_180_000, { supersedes: leaseRef('h', 1_120_000, claim) });
    const result = fold([E.create(), claim, renew, takeover]);
    const t = ticketOf(result);
    expect(t.lease).toEqual({ ttl: TTL, expiresAt: 2_860_000, event: renew.hash, confirmed: true });
    expect(t.available).toEqual({ at: 2_920_000, event: renew.hash });
    expect(reasonOf(result, takeover)).toBe('already-assigned');
    expect(t.assignee).toBe('h');
  });

  it('takeover inside the tolerance is rejected (spec scenario)', () => {
    // A lease expiring at 1600000: claimed at 1000000 with ttl and grace 600000.
    const claim = E.leased('h', 1_000_000, 600_000, 600_000);
    const inside = E.claim('c', 1_630_000, { supersedes: leaseRef('h', 1_600_000, claim) });
    expect(reasonOf(fold([E.create(), claim, inside]), inside)).toBe('already-assigned');
    const edge = E.claim('c', 1_659_999, { supersedes: leaseRef('h', 1_600_000, claim) });
    expect(reasonOf(fold([E.create(), claim, edge]), edge)).toBe('already-assigned');
    const exact = E.claim('c', 1_660_000, { supersedes: leaseRef('h', 1_600_000, claim) });
    const result = fold([E.create(), claim, exact]);
    expect(reasonOf(result, exact)).toBeNull();
    expect(ticketOf(result).assignee).toBe('c');
  });

  it('renew before expiry beats a later takeover, in every read order (spec scenario)', () => {
    const claim = E.leased('h', 1_000_000, 600_000, 600_000);
    const renew = E.renew('h', 1_500_000, TTL);
    const takeover = E.claim('c', 1_700_000, { supersedes: leaseRef('h', 1_600_000, claim) });
    const result = foldEveryOrder([E.create(), claim, renew, takeover]);
    expect(reasonOf(result, renew)).toBeNull();
    expect(reasonOf(result, takeover)).toBe('already-assigned');
    expect(ticketOf(result).assignee).toBe('h');
    expect(ticketOf(result).lease).toEqual({
      ttl: TTL,
      expiresAt: 3_300_000,
      event: renew.hash,
      confirmed: true,
    });
  });

  it('claim without supersedes on an expired lease is rejected (spec scenario)', () => {
    const claim = E.leased('h', 1_000_000);
    const late = E.claim('c', 9_000_000);
    expect(reasonOf(fold([E.create(), claim, late]), late)).toBe('already-assigned');
  });

  it.each([
    ['another holder', { holder: 'x' }],
    ['another expiresAt', { expiresAt: 1_120_001 }],
    ['another lease event', { event: 'b'.repeat(64) }],
  ])('a takeover naming %s is rejected already-assigned', (_name, patch) => {
    const claim = E.leased('h', 1_000_000);
    const takeover = E.claim('c', 2_000_000, {
      supersedes: { ...leaseRef('h', 1_120_000, claim), ...patch },
    });
    const result = fold([E.create(), claim, takeover]);
    expect(reasonOf(result, takeover)).toBe('already-assigned');
    expect(ticketOf(result).assignee).toBe('h');
  });

  it('a holder without a lease cannot be taken over, whatever supersedes says', () => {
    const claim = E.claim('h', 1_000_000);
    const takeover = E.claim('c', 9_000_000, {
      supersedes: { holder: 'h', expiresAt: 1_000_000, event: claim.hash },
    });
    expect(reasonOf(fold([E.create(), claim, takeover]), takeover)).toBe('already-assigned');
  });

  it('a claim on an unassigned ticket ignores supersedes and takes its own lease', () => {
    const claim = E.leased('c', 1_000_000, TTL, GRACE, {
      supersedes: { holder: 'h', expiresAt: 5, event: 'c'.repeat(64) },
    });
    const result = fold([E.create(), claim]);
    expect(result.rejected).toEqual([]);
    expect(ticketOf(result).assignee).toBe('c');
    expect(ticketOf(result).lease?.event).toBe(claim.hash);
  });

  it('a claim by the assignee is rejected already-assigned and keeps the lease', () => {
    const claim = E.leased('h', 1_000_000);
    const again = E.leased('h', 1_010_000, 600_000);
    const result = fold([E.create(), claim, again]);
    expect(reasonOf(result, again)).toBe('already-assigned');
    expect(ticketOf(result).lease?.event).toBe(claim.hash);
  });

  it('two racing takeovers of one lease: the earlier in fold order wins, in every read order', () => {
    const claim = E.leased('h', 1_000_000);
    const ref = leaseRef('h', 1_120_000, claim);
    const first = E.claim('c', 1_200_000, { supersedes: ref });
    const second = E.claim('d', 1_200_001, { supersedes: ref });
    const result = foldEveryOrder([E.create(), claim, second, first]);
    expect(ticketOf(result).assignee).toBe('c');
    expect(reasonOf(result, first)).toBeNull();
    expect(reasonOf(result, second)).toBe('already-assigned');
  });

  it('a takeover replaces a renewed (confirmed) lease once it lapses', () => {
    const claim = E.leased('h', 1_000_000);
    const renew = E.renew('h', 1_010_000, 600_000);
    const takeover = E.claim('c', 1_670_000, { supersedes: leaseRef('h', 1_610_000, renew) });
    const result = fold([E.create(), claim, renew, takeover]);
    expect(reasonOf(result, takeover)).toBeNull();
    expect(ticketOf(result).assignee).toBe('c');
  });

  it('renew by another actor is rejected not-assignee (spec scenario)', () => {
    const claim = E.leased('h', 1_000_000);
    const renew = E.renew('c', 1_010_000);
    const result = fold([E.create(), claim, renew]);
    expect(reasonOf(result, renew)).toBe('not-assignee');
    expect(ticketOf(result).lease?.event).toBe(claim.hash);
  });

  it('renew of an unassigned ticket is rejected not-assignee', () => {
    const renew = E.renew('h', 1_010_000);
    expect(reasonOf(fold([E.create(), renew]), renew)).toBe('not-assignee');
  });

  it('a renew after expiry is accepted when nothing took over before it', () => {
    const claim = E.leased('h', 1_000_000);
    const renew = E.renew('h', 5_000_000, 60_000);
    const result = fold([E.create(), claim, renew]);
    expect(reasonOf(result, renew)).toBeNull();
    expect(ticketOf(result).lease).toEqual({
      ttl: 60_000,
      expiresAt: 5_060_000,
      event: renew.hash,
      confirmed: true,
    });
  });

  it('a renew sets the lease rather than extending it', () => {
    const claim = E.leased('h', 1_000_000);
    const long = E.renew('h', 1_010_000, 3_600_000);
    const short = E.renew('h', 1_020_000, 60_000);
    expect(ticketOf(fold([E.create(), claim, long, short])).lease?.expiresAt).toBe(1_080_000);
  });

  it('a renew gives a holder without a lease a confirmed lease', () => {
    const renew = E.renew('h', 1_010_000, 60_000);
    const t = ticketOf(fold([E.create(), E.claim('h', 1_000_000), renew]));
    expect(t.lease).toEqual({
      ttl: 60_000,
      expiresAt: 1_070_000,
      event: renew.hash,
      confirmed: true,
    });
  });

  it('a renew after a takeover is rejected for the old holder', () => {
    const claim = E.leased('h', 1_000_000);
    const takeover = E.claim('c', 1_180_000, { supersedes: leaseRef('h', 1_120_000, claim) });
    const renew = E.renew('h', 1_190_000);
    const result = foldEveryOrder([E.create(), claim, takeover, renew]);
    expect(reasonOf(result, renew)).toBe('not-assignee');
  });

  it('hand-off clears the lease (spec scenario)', () => {
    const claim = E.leased('h', 1_000_000);
    const t = ticketOf(fold([E.create(), claim, E.handoff('h', 1_010_000, 'r', 'todo')]));
    expect(t.assignee).toBe('r');
    expect(t.lease).toBeNull();
    expect(t.available).toBeNull();
  });

  it('a rejected hand-off leaves the lease', () => {
    const claim = E.leased('h', 1_000_000);
    const t = ticketOf(fold([E.create(), claim, E.handoff('h', 1_010_000, 'r', 'merged')]));
    expect(t.assignee).toBe('h');
    expect(t.lease?.event).toBe(claim.hash);
  });

  it('assign clears the lease', () => {
    const claim = E.leased('h', 1_000_000);
    const t = ticketOf(fold([E.create(), claim, E.assign('orch', 1_010_000, 'r')]));
    expect(t.assignee).toBe('r');
    expect(t.lease).toBeNull();
  });

  it('release clears the lease and records when the ticket became available', () => {
    const claim = E.leased('h', 1_000_000);
    const release = E.release('h', 1_010_000);
    const t = ticketOf(fold([E.create(), claim, release]));
    expect(t.assignee).toBeNull();
    expect(t.lease).toBeNull();
    expect(t.available).toEqual({ at: 1_010_000, event: release.hash });
  });

  it('availability follows the latest release after a later claim and release', () => {
    const r1 = E.release('h', 1_010_000);
    const r2 = E.release('k', 1_030_000);
    const t = ticketOf(
      fold([E.create(), E.claim('h', 1_000_000), r1, E.claim('k', 1_020_000), r2]),
    );
    expect(t.available).toEqual({ at: 1_030_000, event: r2.hash });
  });

  it('no other kind changes the lease, and a lease never changes the status', () => {
    const claim = E.leased('h', 1_000_000);
    const result = fold([
      E.create(),
      claim,
      E.move('h', 1_001_000, 'tests'),
      E.comment('x', 1_002_000, 'hello'),
      E.meta('queue.window', 300_000, 1_003_000),
      E.claim('x', 2_000_000),
      E.release('x', 2_000_001),
    ]);
    const t = ticketOf(result);
    expect(t.status).toBe('tests');
    expect(t.lease).toEqual({
      ttl: TTL,
      expiresAt: 1_120_000,
      event: claim.hash,
      confirmed: false,
    });
    expect(t.assignee).toBe('h');
  });

  it('leased claim, renew and takeover each count once in version', () => {
    const claim = E.leased('h', 1_000_000);
    const renew = E.renew('h', 1_010_000, 60_000);
    const takeover = E.claim('c', 1_130_000, { supersedes: leaseRef('h', 1_070_000, renew) });
    const t = ticketOf(fold([E.create(), claim, renew, takeover]));
    expect(t.version).toBe(4);
    expect(t.updatedAt).toEqual(takeover.event.ts);
    expect(t.status).toBe('todo');
  });
});

describe('fold: forced release', () => {
  it('releases a claim without a lease, status unchanged (spec scenario)', () => {
    const force = E.force('orch', 2_000_000, 'h', 'h crashed');
    const result = fold([
      E.create(),
      E.claim('h', 1_000_000),
      E.move('h', 1_001_000, 'tests'),
      force,
    ]);
    const t = ticketOf(result);
    expect(reasonOf(result, force)).toBeNull();
    expect(t.assignee).toBeNull();
    expect(t.status).toBe('tests');
    expect(t.lease).toBeNull();
    expect(t.available).toEqual({ at: 2_000_000, event: force.hash });
    expect(t.version).toBe(4);
  });

  it('is rejected holder-changed after the holder handed off (spec scenario)', () => {
    const force = E.force('orch', 2_000_000, 'h');
    const result = foldEveryOrder([
      E.create(),
      E.claim('h', 1_000_000),
      E.handoff('h', 1_500_000, 'r', 'todo'),
      force,
    ]);
    expect(reasonOf(result, force)).toBe('holder-changed');
    expect(ticketOf(result).assignee).toBe('r');
  });

  it('is rejected holder-changed on an unassigned ticket', () => {
    const force = E.force('orch', 2_000_000, 'h');
    expect(reasonOf(fold([E.create(), force]), force)).toBe('holder-changed');
  });

  it('releases a live, unexpired lease and clears it', () => {
    const claim = E.leased('h', 1_000_000);
    const force = E.force('orch', 1_001_000, 'h');
    const t = ticketOf(fold([E.create(), claim, E.renew('h', 1_000_500), force]));
    expect(t.assignee).toBeNull();
    expect(t.lease).toBeNull();
  });

  it('is applied when written by the holder itself (the command refuses that, not the fold)', () => {
    const force = E.force('h', 1_001_000, 'h');
    expect(reasonOf(fold([E.create(), E.claim('h', 1_000_000), force]), force)).toBeNull();
  });

  it('racing a takeover: the forced release naming the old holder loses', () => {
    const claim = E.leased('h', 1_000_000);
    const takeover = E.claim('c', 1_180_000, { supersedes: leaseRef('h', 1_120_000, claim) });
    const force = E.force('orch', 1_190_000, 'h');
    const result = foldEveryOrder([E.create(), claim, takeover, force]);
    expect(reasonOf(result, force)).toBe('holder-changed');
    expect(ticketOf(result).assignee).toBe('c');
  });
});

describe('board lease settings: leaseGrace and queueWindow', () => {
  const meta = (key: string, value: JsonValue): Record<string, JsonValue> => ({ [key]: value });

  it.each([
    [30_000, 30_000],
    [300_000, 300_000],
    [600_000, 600_000],
    [29_999, 120_000],
    [600_001, 120_000],
    [5000, 120_000],
    [0, 120_000],
    [-300_000, 120_000],
    [300_000.5, 120_000],
    ['300000', 120_000],
    [null, 120_000],
    [true, 120_000],
    [[300_000], 120_000],
    [{ ms: 300_000 }, 120_000],
  ] as [JsonValue, number][])('a setting of %j means %i', (value, expected) => {
    expect(leaseGrace(meta('lease.grace', value))).toBe(expected);
    expect(queueWindow(meta('queue.window', value))).toBe(expected);
  });

  it('a missing setting means the default of 120000', () => {
    expect(leaseGrace({})).toBe(120_000);
    expect(queueWindow({})).toBe(120_000);
    const nullProto = Object.create(null) as Record<string, JsonValue>;
    expect(queueWindow(nullProto)).toBe(120_000);
  });

  it('each reads only its own key', () => {
    expect(leaseGrace({ 'queue.window': 300_000 })).toBe(120_000);
    expect(queueWindow({ 'lease.grace': 300_000 })).toBe(120_000);
  });

  it('the fold never reads lease.grace: a claim keeps the grace it recorded', () => {
    const claim = E.leased('h', 1_000_000, TTL, GRACE);
    const t = ticketOf(fold([E.create(), E.meta('lease.grace', 300_000, 1), claim]));
    expect(t.lease?.expiresAt).toBe(1_120_000);
  });
});

describe('fold: the waiting queue', () => {
  const held = (): FoldInput[] => [E.create(), E.claim('h', 500)];

  it('join order is fold order (spec scenario)', () => {
    const a = E.join('a', 1000);
    const b = E.join('b', 900);
    const t = ticketOf(fold([...held(), a, b]));
    expect(t.queue).toEqual([
      { actor: 'b', ttl: TTL, event: b.hash, joined: b.event.ts },
      { actor: 'a', ttl: TTL, event: a.hash, joined: a.event.ts },
    ]);
  });

  it('same wall ties break on the timestamp, the same in every read order (spec scenario)', () => {
    const b = E.join('b', 1000);
    const a = E.join('a', 1000);
    const result = foldEveryOrder([...held(), b, a]);
    expect(ticketOf(result).queue.map((w) => w.actor)).toEqual(['a', 'b']);
    const late = E.join('a', 1000, TTL, 1);
    const result2 = foldEveryOrder([...held(), late, E.join('b', 1000, TTL, 0)]);
    expect(ticketOf(result2).queue.map((w) => w.actor)).toEqual(['b', 'a']);
  });

  it('a queue-jumping claim is refused queued (spec scenario)', () => {
    const claim = E.leased('h', 1_000_000);
    const takeover = E.claim('x', 1_200_000, { supersedes: leaseRef('h', 1_120_000, claim) });
    const result = fold([E.create(), claim, E.join('a', 1_010_000), takeover]);
    expect(reasonOf(result, takeover)).toBe('queued');
    expect(ticketOf(result).assignee).toBe('h');
  });

  it('a plain claim on a freed ticket with waiters is refused queued', () => {
    const claim = E.claim('x', 3000);
    const result = fold([...held(), E.join('a', 1000), E.release('h', 2000), claim]);
    expect(reasonOf(result, claim)).toBe('queued');
    expect(ticketOf(result).assignee).toBeNull();
  });

  it('a claim by the assignee with waiters is still already-assigned', () => {
    const claim = E.claim('h', 3000);
    expect(reasonOf(fold([...held(), E.join('a', 1000), claim]), claim)).toBe('already-assigned');
  });

  it('a join on a free ticket is refused invalid-queue (spec scenario)', () => {
    const join = E.join('a', 1000);
    const result = fold([E.create(), join]);
    expect(reasonOf(result, join)).toBe('invalid-queue');
    expect(ticketOf(result).queue).toEqual([]);
  });

  it('a join by the assignee is refused invalid-queue', () => {
    const join = E.join('h', 1000);
    expect(reasonOf(fold([...held(), join]), join)).toBe('invalid-queue');
  });

  it('a second join by a queued actor is refused invalid-queue and keeps its place', () => {
    const first = E.join('a', 1000);
    const second = E.join('a', 3000, 60_000);
    const result = fold([...held(), first, E.join('b', 2000), second]);
    expect(reasonOf(result, second)).toBe('invalid-queue');
    expect(ticketOf(result).queue.map((w) => [w.actor, w.ttl])).toEqual([
      ['a', TTL],
      ['b', TTL],
    ]);
  });

  it('a leave by an actor not queued is refused invalid-queue', () => {
    const leave = E.leave('a', 1000);
    expect(reasonOf(fold([...held(), leave]), leave)).toBe('invalid-queue');
    const byHolder = E.leave('h', 1000);
    expect(reasonOf(fold([...held(), byHolder]), byHolder)).toBe('invalid-queue');
  });

  it('leave removes the actor, and a rejoin goes to the back', () => {
    const rejoin = E.join('a', 4000, 60_000);
    const result = fold([
      ...held(),
      E.join('a', 1000),
      E.join('b', 2000),
      E.leave('a', 3000),
      rejoin,
    ]);
    expect(result.rejected).toEqual([]);
    expect(ticketOf(result).queue.map((w) => w.actor)).toEqual(['b', 'a']);
    expect(ticketOf(result).queue[1]).toEqual({
      actor: 'a',
      ttl: 60_000,
      event: rejoin.hash,
      joined: rejoin.event.ts,
    });
  });

  it('a join on a freed ticket that still has waiters is accepted', () => {
    const join = E.join('b', 2500);
    const result = fold([...held(), E.join('a', 1000), E.release('h', 2000), join]);
    expect(reasonOf(result, join)).toBeNull();
    expect(ticketOf(result).queue.map((w) => w.actor)).toEqual(['a', 'b']);
  });

  it('hand-off is not constrained by the queue', () => {
    const handoff = E.handoff('h', 2000, 'x', 'todo');
    const result = fold([...held(), E.join('a', 1000), handoff]);
    expect(reasonOf(result, handoff)).toBeNull();
    expect(ticketOf(result).assignee).toBe('x');
    expect(ticketOf(result).queue.map((w) => w.actor)).toEqual(['a']);
  });

  it('joins and leaves count in version and never change status or assignee', () => {
    const t = ticketOf(fold([...held(), E.join('a', 1000), E.leave('a', 2000)]));
    expect(t.version).toBe(4);
    expect(t.assignee).toBe('h');
    expect(t.status).toBe('todo');
  });
});

describe('dueGrant and grants', () => {
  /** h holds T1 (plain claim at 1000); a joins at 2000 and b at 3000. */
  function queued(): { base: FoldInput[]; a: FoldInput; b: FoldInput } {
    const a = E.join('a', 2000, 600_000);
    const b = E.join('b', 3000, 900_000);
    return { base: [E.create(), E.claim('h', 1000), a, b], a, b };
  }

  it('release grants to the head waiter (spec scenario)', () => {
    const { base } = queued();
    const release = E.release('h', 5000);
    const expected = grantEvent(5001, {
      to: 'a',
      ttl: 600_000,
      window: WINDOW,
      after: { released: release.hash },
    });
    expect(due([...base, release])).toEqual(expected);
    const grant = E.grant(expected);
    const result = foldEveryOrder([...base, release, grant]);
    const t = ticketOf(result);
    expect(reasonOf(result, grant)).toBeNull();
    expect(t.assignee).toBe('a');
    expect(t.lease).toEqual({
      ttl: 600_000,
      expiresAt: 125_001,
      event: grant.hash,
      confirmed: false,
    });
    expect(t.queue.map((w) => w.actor)).toEqual(['b']);
    expect(t.available).toEqual({ at: 185_001, event: grant.hash });
    expect(t.version).toBe(6);
    expect(t.updatedAt).toEqual({ wall: 5001, counter: 0, actor: 'agentboard' });
  });

  it('derives canonical bytes equal to the hand-written grant', () => {
    const { base } = queued();
    const release = E.release('h', 5000);
    const derived = due([...base, release]);
    const expected = grantEvent(5001, {
      to: 'a',
      ttl: 600_000,
      window: WINDOW,
      after: { released: release.hash },
    });
    expect(derived).not.toBeNull();
    expect(canonicalEncode(derived)).toEqual(canonicalEncode(expected));
  });

  it('a forced release names itself in after.released', () => {
    const { base } = queued();
    const force = E.force('orch', 7000, 'h');
    expect(due([...base, force])).toEqual(
      grantEvent(7001, { to: 'a', ttl: 600_000, window: WINDOW, after: { released: force.hash } }),
    );
  });

  it('grace expiry without renew: due at the claim wall + grace + 60000 + 1, not before', () => {
    const claim = E.leased('h', 1_000_000, TTL, GRACE);
    const b = E.join('b', 1_010_000, 900_000);
    const derived = due([E.create(), claim, b]);
    expect(derived).toEqual(
      grantEvent(1_180_001, {
        to: 'b',
        ttl: 900_000,
        window: WINDOW,
        after: { lease: leaseRef('h', 1_120_000, claim) },
      }),
    );
    const early = E.grant({ ...grantEvent(1_180_000, derived?.body ?? GRANT_PLACEHOLDER) });
    const r = fold([E.create(), claim, b, early]);
    expect(reasonOf(r, early)).toBe('stale-grant');
    expect(ticketOf(r).assignee).toBe('h');
  });

  it('the first join on a lapsed lease makes the grant due at that join wall + 1', () => {
    const claim = E.leased('h', 1_000_000);
    const a = E.join('a', 1_500_000);
    expect(due([E.create(), claim, a])?.ts).toEqual({
      wall: 1_500_001,
      counter: 0,
      actor: 'agentboard',
    });
  });

  it('reservation passes on non-acceptance (spec scenario)', () => {
    const { base } = queued();
    const release = E.release('h', 5000);
    const first = E.grant(
      grantEvent(5001, {
        to: 'a',
        ttl: 600_000,
        window: WINDOW,
        after: { released: release.hash },
      }),
    );
    const next = due([...base, release, first]);
    expect(next).toEqual(
      grantEvent(5001 + 120_000 + 60_000 + 1, {
        to: 'b',
        ttl: 900_000,
        window: WINDOW,
        after: { lease: leaseRef('a', 125_001, first) },
      }),
    );
    const second = E.grant(next ?? grantEvent(0, GRANT_PLACEHOLDER));
    const result = foldEveryOrder([...base, release, first, second]);
    expect(ticketOf(result).assignee).toBe('b');
    expect(ticketOf(result).queue).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it('acceptance in time keeps the grant (spec scenario)', () => {
    const { base } = queued();
    const release = E.release('h', 5000);
    const first = E.grant(
      grantEvent(5001, {
        to: 'a',
        ttl: 600_000,
        window: WINDOW,
        after: { released: release.hash },
      }),
    );
    const accept = E.renew('a', 5001 + 119_999, 600_000);
    const t = ticketOf(fold([...base, release, first, accept]));
    expect(t.lease).toEqual({
      ttl: 600_000,
      expiresAt: 125_000 + 600_000,
      event: accept.hash,
      confirmed: true,
    });
    // The next grant is due only when the confirmed lease lapses.
    expect(due([...base, release, first, accept])).toEqual(
      grantEvent(725_000 + 60_000 + 1, {
        to: 'b',
        ttl: 900_000,
        window: WINDOW,
        after: { lease: leaseRef('a', 725_000, accept) },
      }),
    );
    // Or when a releases.
    const done = E.release('a', 200_000);
    expect(due([...base, release, first, accept, done])).toEqual(
      grantEvent(200_001, {
        to: 'b',
        ttl: 900_000,
        window: WINDOW,
        after: { released: done.hash },
      }),
    );
  });

  it('a renew before the lapse moves the slot time', () => {
    const claim = E.leased('h', 1_000_000);
    const b = E.join('b', 1_010_000);
    const renew = E.renew('h', 1_100_000, 600_000);
    expect(due([E.create(), claim, b, renew])?.ts.wall).toBe(1_700_000 + 60_000 + 1);
  });

  it('stale grant after a late renew, on every replica (spec scenario)', () => {
    const { base } = queued();
    const release = E.release('h', 5000);
    const first = E.grant(
      grantEvent(5001, {
        to: 'a',
        ttl: 600_000,
        window: WINDOW,
        after: { released: release.hash },
      }),
    );
    // Written by a replica that had not seen a's renew.
    const toB = E.grant(due([...base, release, first]) ?? grantEvent(0, GRANT_PLACEHOLDER));
    // a's renew, synced late, with a wall before the grant's slot time.
    const renew = E.renew('a', 100_000, 600_000);
    const result = foldEveryOrder([...base, release, first, toB, renew]);
    expect(reasonOf(result, renew)).toBeNull();
    expect(reasonOf(result, toB)).toBe('stale-grant');
    expect(ticketOf(result).assignee).toBe('a');
    expect(ticketOf(result).queue.map((w) => w.actor)).toEqual(['b']);
  });

  it('identical grants from two writers: same bytes and hash, folded once (spec scenario)', () => {
    const { base, a, b } = queued();
    const release = E.release('h', 5000);
    // Two replicas that received the same events in different orders.
    const replica1 = fold([...base, release]);
    const replica2 = fold([release, b, a, ...base.slice(0, 2)]);
    const g1 = dueGrant(ticketOf(replica1), replica1.state.meta);
    const g2 = dueGrant(ticketOf(replica2), replica2.state.meta);
    expect(g1).not.toBeNull();
    expect(canonicalEncode(g1)).toEqual(canonicalEncode(g2));
    expect(canonicalHash(g1)).toBe(canonicalHash(g2));
    const grant = E.grant(g1 ?? grantEvent(0, GRANT_PLACEHOLDER));
    const result = fold([...base, release, grant, { ...grant }]);
    expect(result.rejected).toEqual([]);
    expect(ticketOf(result).version).toBe(6);
  });

  it('a ticket freed while its queue is empty has no grant due', () => {
    expect(due([E.create(), E.claim('h', 1000), E.release('h', 2000)])).toBeNull();
    expect(due([E.create(), E.claim('h', 1000), E.force('o', 2000, 'h')])).toBeNull();
    expect(due([E.create(), E.leased('h', 1000)])).toBeNull();
    expect(due([E.create()])).toBeNull();
  });

  it('a holder without a lease never lapses: no grant is due', () => {
    expect(due([E.create(), E.claim('h', 1000), E.join('a', 2000)])).toBeNull();
    const handedOff = [
      E.create(),
      E.leased('h', 1000),
      E.join('a', 2000),
      E.handoff('h', 3000, 'r', 'todo'),
    ];
    expect(due(handedOff)).toBeNull();
  });

  it('after the last waiter is granted and lapses, nothing more is due', () => {
    const base = [E.create(), E.claim('h', 1000), E.join('a', 2000)];
    const release = E.release('h', 5000);
    const grant = E.grant(
      grantEvent(5001, { to: 'a', ttl: TTL, window: WINDOW, after: { released: release.hash } }),
    );
    expect(due([...base, release, grant])).toBeNull();
  });

  it('a chain of three lapsed grants passes the reservation along the queue in join order', () => {
    const base = [
      E.create(),
      E.claim('h', 1000),
      E.join('a', 2000, 60_000),
      E.join('b', 3000, 90_000),
      E.join('c', 4000, 120_000),
    ];
    const release = E.release('h', 5000);
    const g1 = E.grant(
      grantEvent(5001, { to: 'a', ttl: 60_000, window: WINDOW, after: { released: release.hash } }),
    );
    const g2 = E.grant(
      grantEvent(185_002, {
        to: 'b',
        ttl: 90_000,
        window: WINDOW,
        after: { lease: leaseRef('a', 125_001, g1) },
      }),
    );
    const g3 = E.grant(
      grantEvent(365_003, {
        to: 'c',
        ttl: 120_000,
        window: WINDOW,
        after: { lease: leaseRef('b', 305_002, g2) },
      }),
    );
    expect(due([...base, release])).toEqual(g1.event);
    expect(due([...base, release, g1])).toEqual(g2.event);
    expect(due([...base, release, g1, g2])).toEqual(g3.event);
    const result = foldEveryOrder([...base, release, g3, g1, g2]);
    expect(result.rejected).toEqual([]);
    expect(ticketOf(result).assignee).toBe('c');
    expect(ticketOf(result).queue).toEqual([]);
    expect(due([...base, release, g1, g2, g3])).toBeNull();
  });

  it('a waiter that leaves before its grant is skipped: the grant goes to the next', () => {
    const { base } = queued();
    const leave = E.leave('a', 4000);
    const release = E.release('h', 5000);
    expect(due([...base, leave, release])).toEqual(
      grantEvent(5001, {
        to: 'b',
        ttl: 900_000,
        window: WINDOW,
        after: { released: release.hash },
      }),
    );
  });

  it('a waiter that leaves after the grant was written makes it stale', () => {
    const { base } = queued();
    const release = E.release('h', 5000);
    const grant = E.grant(
      grantEvent(5001, {
        to: 'a',
        ttl: 600_000,
        window: WINDOW,
        after: { released: release.hash },
      }),
    );
    const leave = E.leave('a', 5000);
    const result = foldEveryOrder([...base, release, leave, grant]);
    expect(reasonOf(result, grant)).toBe('stale-grant');
    expect(ticketOf(result).assignee).toBeNull();
    expect(ticketOf(result).queue.map((w) => w.actor)).toEqual(['b']);
  });

  describe('a grant that differs from the derived one is rejected stale-grant', () => {
    const { base } = queued();
    const release = E.release('h', 5000);
    const good: TicketGrantEvent = grantEvent(5001, {
      to: 'a',
      ttl: 600_000,
      window: WINDOW,
      after: { released: release.hash },
    });
    const variants: [string, TicketGrantEvent][] = [
      ['one ms early', { ...good, ts: { ...good.ts, wall: 5000 } }],
      ['one ms late', { ...good, ts: { ...good.ts, wall: 5002 } }],
      ['counter 1', { ...good, ts: { ...good.ts, counter: 1 } }],
      ['to the second waiter', { ...good, body: { ...good.body, to: 'b' } }],
      ['to a stranger', { ...good, body: { ...good.body, to: 'x' } }],
      ['another ttl', { ...good, body: { ...good.body, ttl: 900_000 } }],
      ['another window', { ...good, body: { ...good.body, window: 300_000 } }],
      [
        'naming another release',
        { ...good, body: { ...good.body, after: { released: 'd'.repeat(64) } } },
      ],
      [
        'naming a lease instead of the release',
        {
          ...good,
          body: {
            ...good.body,
            after: { lease: { holder: 'h', expiresAt: 1, event: release.hash } },
          },
        },
      ],
    ];

    it.each(variants)('%s', (_name, event) => {
      const grant = E.grant(event);
      const result = fold([...base, release, grant]);
      expect(reasonOf(result, grant)).toBe('stale-grant');
      expect(ticketOf(result).assignee).toBeNull();
      expect(ticketOf(result).version).toBe(5);
    });

    it('the exact derived grant is applied', () => {
      const grant = E.grant(good);
      expect(reasonOf(fold([...base, release, grant]), grant)).toBeNull();
    });

    it('a grant when nothing is due is stale', () => {
      const grant = E.grant(good);
      const result = fold([...base, grant]);
      expect(reasonOf(result, grant)).toBe('stale-grant');
      expect(ticketOf(result).assignee).toBe('h');
    });

    it('a grant for a ticket that does not exist is unknown-ticket', () => {
      const grant = E.grant({ ...good, ticket: T2 });
      expect(reasonOf(fold([...base, release, grant]), grant)).toBe('unknown-ticket');
    });
  });

  it('window changed by a setting (spec scenario)', () => {
    const { base } = queued();
    const release = E.release('h', 5000);
    expect(due([E.meta('queue.window', 300_000, 4000), ...base, release])?.body.window).toBe(
      300_000,
    );
  });

  it('out-of-range setting is ignored (spec scenario)', () => {
    const { base } = queued();
    const release = E.release('h', 5000);
    expect(due([E.meta('queue.window', 5000, 4000), ...base, release])?.body.window).toBe(WINDOW);
  });

  it('the window is the setting as folded at the grant position, not a later one', () => {
    const claim = E.leased('h', 1_000_000);
    const a = E.join('a', 1_010_000);
    // Lapse at 1120000 + 60000; the setting lands between expiry and slot.
    const before = E.meta('queue.window', 300_000, 1_150_000);
    const grant = due([E.create(), claim, a, before]);
    expect(grant?.ts.wall).toBe(1_180_001);
    expect(grant?.body.window).toBe(300_000);
    const applied = E.grant(grant ?? grantEvent(0, GRANT_PLACEHOLDER));
    const after = E.meta('queue.window', 600_000, 1_190_000);
    const result = fold([E.create(), claim, a, before, applied, after]);
    expect(reasonOf(result, applied)).toBeNull();
    expect(ticketOf(result).lease?.expiresAt).toBe(1_180_001 + 300_000);
  });

  it('a grant written with an older window becomes stale when a setting lands before it', () => {
    const claim = E.leased('h', 1_000_000);
    const a = E.join('a', 1_010_000);
    const written = E.grant(due([E.create(), claim, a]) ?? grantEvent(0, GRANT_PLACEHOLDER));
    expect(written.event.kind === 'ticket.grant' && written.event.body.window).toBe(WINDOW);
    const setting = E.meta('queue.window', 300_000, 1_150_000);
    const result = foldEveryOrder([E.create(), claim, a, written, setting]);
    expect(reasonOf(result, written)).toBe('stale-grant');
  });

  it('dueGrant returns a fresh object that shares nothing with the ticket or meta', () => {
    const { base } = queued();
    const { state } = fold([...base, E.release('h', 5000)]);
    const ticket = state.tickets[T1] as Ticket;
    const snapshot = JSON.stringify({ ticket, meta: state.meta });
    const grant = dueGrant(ticket, state.meta);
    if (grant === null) throw new Error('expected a grant');
    grant.body.to = 'mutated';
    grant.ts.wall = 0;
    if ('released' in grant.body.after) grant.body.after.released = 'x';
    expect(JSON.stringify({ ticket, meta: state.meta })).toBe(snapshot);
  });

  it('applyEvent validates a grant against the state it is given', () => {
    const { base } = queued();
    const release = E.release('h', 5000);
    const { state } = fold([...base, release]);
    const grant = E.grant(
      grantEvent(5001, {
        to: 'a',
        ttl: 600_000,
        window: WINDOW,
        after: { released: release.hash },
      }),
    );
    const copy = structuredClone(state) as BoardState;
    expect(applyEvent(copy, grant)).toEqual({ status: 'applied' });
    expect(copy.tickets[T1]?.assignee).toBe('a');
    const stale = structuredClone(state) as BoardState;
    stale.meta['queue.window'] = 300_000;
    expect(applyEvent(stale, grant)).toEqual({
      status: 'rejected',
      rejected: { hash: grant.hash, kind: 'ticket.grant', ticket: T1, reason: 'stale-grant' },
    });
    expect(stale.tickets[T1]?.assignee).toBeNull();
  });
});

/** A well-formed grant body used only where a derivation was expected but missing. */
const GRANT_PLACEHOLDER: TicketGrantBody = {
  to: 'missing',
  ttl: TTL,
  window: WINDOW,
  after: { released: '0'.repeat(64) },
};

describe('the fold reads no clock', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('folds leases, queues, grants and forced releases with every clock throwing', () => {
    const claim = E.leased('h', 1_000_000);
    const a = E.join('a', 1_010_000);
    const b = E.join('b', 1_020_000);
    // Derived before the clocks are replaced.
    const g1 = E.grant(due([E.create(), claim, a, b]) ?? grantEvent(0, GRANT_PLACEHOLDER));
    const inputs = [
      E.create(),
      claim,
      a,
      b,
      g1,
      E.renew('a', 1_190_000, 600_000),
      E.force('orch', 1_200_000, 'a', 'stuck'),
      E.meta('queue.window', 300_000, 1_200_001),
    ];
    const reference = bytesOf(fold(inputs));

    const RealDate = Date;
    class ThrowingDate extends RealDate {
      constructor() {
        super();
        throw new Error('the fold read the clock (new Date)');
      }

      static override now(): number {
        throw new Error('the fold read the clock (Date.now)');
      }
    }
    vi.stubGlobal('Date', ThrowingDate);
    vi.spyOn(performance, 'now').mockImplementation(() => {
      throw new Error('the fold read the clock (performance.now)');
    });
    vi.spyOn(process, 'hrtime').mockImplementation(() => {
      throw new Error('the fold read the clock (process.hrtime)');
    });

    // Restored before anything else runs, so the test runner (which reads
    // the clock itself) never sees the throwing clocks, even on failure.
    let result: FoldResult;
    let grant: TicketGrantEvent | null;
    let window: number;
    let grace: number;
    try {
      result = fold([...inputs].reverse());
      grant = dueGrant(result.state.tickets[T1] as Ticket, result.state.meta);
      window = queueWindow(result.state.meta);
      grace = leaseGrace(result.state.meta);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }

    expect(bytesOf(result)).toBe(reference);
    expect(ticketOf(result).assignee).toBeNull();
    expect(grant?.body.to).toBe('b');
    expect(grant?.body.window).toBe(300_000);
    expect(window).toBe(300_000);
    expect(grace).toBe(GRACE);
  });
});
