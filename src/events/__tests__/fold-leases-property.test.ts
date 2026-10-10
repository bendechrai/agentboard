/**
 * Property tests for leases, the waiting queue and grants (add-claim-leases
 * task 1.3; board-events: "Claim leases", "Waiting queue", "Grants";
 * board-concurrency: "Property: one effective takeover per lease",
 * "Property: grants follow join order").
 *
 * A simulation drives one ticket with random claims (plain, leased and
 * takeovers filled from the lease the actor sees), renews, releases, forced
 * releases, joins, leaves and window settings, written with random walls
 * (clocks up to 59 seconds off) and some delivered late, as `sync` would.
 * At random clock points every due grant is materialised, as catch-up will.
 *
 * The oracle is `Model`, an independent restatement of the spec's rules for
 * one ticket written for this test: it derives due grants itself (so the
 * grants written never come from the code under test) and predicts every
 * outcome, which the fold must match event by event. On top of that the
 * properties of the spec are asserted directly: byte-identical folds over
 * sampled read orders, grants in join order among remaining waiters, the
 * reservation passing on at exactly window plus tolerance, grace expiry at
 * exactly grace plus tolerance, at most one takeover per lease, and no
 * takeover or lapse grant before the named lease's `expiresAt +
 * LEASE_SKEW_MS`.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { canonicalEncode, canonicalHash, type JsonValue } from '../canonical.js';
import {
  applyEvent,
  compareFoldOrder,
  fold,
  type BoardState,
  type FoldInput,
  type FoldResult,
  type Ticket,
} from '../fold.js';
import type { Hlc } from '../hlc.js';
import type { BoardEvent, TicketGrantEvent } from '../schema.js';

const T1 = '01ARYZ6S41TSV4RRFFQ69G5FAV';
const SKEW = 60_000;
const DEFAULT_WINDOW = 120_000;
const ACTORS = ['a', 'b', 'c', 'd'] as const;
const START = 10_000_000;

// Property runs fold up to a few hundred events many times; under a loaded
// machine (the whole suite with coverage) they can exceed vitest's 5 second
// default, so they carry an explicit timeout.
const PROPERTY_TIMEOUT_MS = 120_000;

function input(event: BoardEvent): FoldInput {
  return { hash: canonicalHash(event), event };
}

function at(actor: string, wall: number): { actor: string; ts: Hlc } {
  return { actor, ts: { wall, counter: 0, actor } };
}

const CREATE = input({
  v: 1,
  kind: 'ticket.create',
  ticket: T1,
  ...at('orch', 1),
  body: { title: 'Merge lock' },
});

function emptyState(): BoardState {
  return { tickets: {}, meta: Object.create(null) as Record<string, JsonValue> };
}

function unique(inputs: readonly FoldInput[]): FoldInput[] {
  return [...new Map(inputs.map((i) => [i.hash, i])).values()];
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

function shuffle<T>(items: readonly T[], seed: number): T[] {
  let a = seed >>> 0;
  const rand = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The oracle: the spec's rules for one ticket, restated independently.

interface ModelLease {
  ttl: number;
  expiresAt: number;
  event: string;
  confirmed: boolean;
}

interface ModelWaiter {
  actor: string;
  ttl: number;
  event: string;
  joined: Hlc;
}

class Model {
  exists = false;
  assignee: string | null = null;
  lease: ModelLease | null = null;
  queue: ModelWaiter[] = [];
  /** The latest applied release or forced release. */
  freed: { at: number; event: string } | null = null;
  window = DEFAULT_WINDOW;

  clone(): Model {
    const copy = new Model();
    copy.exists = this.exists;
    copy.assignee = this.assignee;
    copy.lease = this.lease === null ? null : { ...this.lease };
    copy.queue = this.queue.map((w) => ({ ...w, joined: { ...w.joined } }));
    copy.freed = this.freed === null ? null : { ...this.freed };
    copy.window = this.window;
    return copy;
  }

  /** `Ticket.available` as board-cache defines it. */
  available(): { at: number; event: string } | null {
    if (this.assignee === null) {
      return this.freed;
    }
    return this.lease === null
      ? null
      : { at: this.lease.expiresAt + SKEW, event: this.lease.event };
  }

  /** The grant due now, derived from board-events "Grants". */
  due(): TicketGrantEvent | null {
    const head = this.queue[0];
    const available = this.available();
    if (head === undefined || available === null) {
      return null;
    }
    const wall = Math.max(available.at, head.joined.wall) + 1;
    const after =
      this.assignee === null
        ? { released: available.event }
        : {
            lease: {
              holder: this.assignee,
              expiresAt: (this.lease as ModelLease).expiresAt,
              event: (this.lease as ModelLease).event,
            },
          };
    return {
      v: 1,
      kind: 'ticket.grant',
      ticket: T1,
      actor: 'agentboard',
      ts: { wall, counter: 0, actor: 'agentboard' },
      body: { to: head.actor, ttl: head.ttl, window: this.window, after },
    };
  }

  /** Applies one event; returns the rejection reason, or null when applied. */
  apply(item: FoldInput): string | null {
    const e = item.event as BoardEvent;
    if (e.kind === 'board.meta') {
      if (e.body.key === 'queue.window') {
        const v = e.body.value;
        this.window =
          typeof v === 'number' && Number.isSafeInteger(v) && v >= 30_000 && v <= 600_000
            ? v
            : DEFAULT_WINDOW;
      }
      return null;
    }
    if (e.kind === 'ticket.create') {
      if (this.exists) return 'duplicate-create';
      this.exists = true;
      return null;
    }
    if (!this.exists) return 'unknown-ticket';
    const actor = e.actor;
    switch (e.kind) {
      case 'ticket.claim': {
        if (this.assignee === actor) return 'already-assigned';
        if (this.queue.length > 0) return 'queued';
        if (this.assignee !== null) {
          const s = e.body.supersedes;
          const ok =
            s !== undefined &&
            this.lease !== null &&
            s.holder === this.assignee &&
            s.expiresAt === this.lease.expiresAt &&
            s.event === this.lease.event &&
            e.ts.wall >= this.lease.expiresAt + SKEW;
          if (!ok) return 'already-assigned';
        }
        this.assignee = actor;
        const own = e.body.lease;
        this.lease =
          own === undefined
            ? null
            : { ttl: own.ttl, expiresAt: own.expiresAt, event: item.hash, confirmed: false };
        return null;
      }
      case 'ticket.renew':
        if (this.assignee !== actor) return 'not-assignee';
        this.lease = {
          ttl: e.body.ttl,
          expiresAt: e.body.expiresAt,
          event: item.hash,
          confirmed: true,
        };
        return null;
      case 'ticket.release':
        if (this.assignee !== actor) return 'not-assignee';
        this.assignee = null;
        this.lease = null;
        this.freed = { at: e.ts.wall, event: item.hash };
        return null;
      case 'ticket.release.force':
        if (this.assignee !== e.body.holder) return 'holder-changed';
        this.assignee = null;
        this.lease = null;
        this.freed = { at: e.ts.wall, event: item.hash };
        return null;
      case 'ticket.queue.join':
        if (
          this.assignee === actor ||
          this.queue.some((w) => w.actor === actor) ||
          (this.assignee === null && this.queue.length === 0)
        ) {
          return 'invalid-queue';
        }
        this.queue.push({ actor, ttl: e.body.ttl, event: item.hash, joined: { ...e.ts } });
        return null;
      case 'ticket.queue.leave': {
        const index = this.queue.findIndex((w) => w.actor === actor);
        if (index < 0) return 'invalid-queue';
        this.queue.splice(index, 1);
        return null;
      }
      case 'ticket.handoff':
      case 'ticket.assign': {
        // The simulation hands off only within the current status (todo),
        // so no transition check applies: always applied.
        const to = e.body.to;
        this.assignee = to;
        this.lease = null;
        this.queue = this.queue.filter((w) => w.actor !== to);
        return null;
      }
      case 'ticket.grant': {
        const derived = this.due();
        if (derived === null || !sameBytes(derived, e)) {
          return 'stale-grant';
        }
        this.queue.shift();
        this.assignee = e.body.to;
        this.lease = {
          ttl: e.body.ttl,
          expiresAt: e.ts.wall + e.body.window,
          event: item.hash,
          confirmed: false,
        };
        return null;
      }
      default:
        throw new Error(`the simulation does not write ${e.kind}`);
    }
  }
}

function sameBytes(a: unknown, b: unknown): boolean {
  const decoder = new TextDecoder();
  return decoder.decode(canonicalEncode(a)) === decoder.decode(canonicalEncode(b));
}

/** The model after folding `inputs` in fold order. */
function modelOf(inputs: readonly FoldInput[]): Model {
  const model = new Model();
  for (const item of unique(inputs).sort(compareFoldOrder)) {
    model.apply(item);
  }
  return model;
}

/**
 * Every grant due at or before `now` and missing from `inputs`, derived by
 * the model at the position it would take, in order (a later grant can
 * depend on an earlier one): what catch-up writes.
 */
function materialise(inputs: readonly FoldInput[], now: number): FoldInput[] {
  const added: FoldInput[] = [];
  for (let guard = 0; guard < 1000; guard += 1) {
    const next = firstMissingGrant([...inputs, ...added], now);
    if (next === null) {
      return added;
    }
    added.push(next);
  }
  throw new Error('materialise did not terminate');
}

function firstMissingGrant(inputs: readonly FoldInput[], now: number): FoldInput | null {
  const ordered = unique(inputs).sort(compareFoldOrder);
  const model = new Model();
  for (let i = 0; i <= ordered.length; i += 1) {
    const next = ordered[i];
    const grant = model.due();
    if (grant !== null && grant.ts.wall <= now) {
      const item = input(grant);
      if (next === undefined || compareFoldOrder(item, next) < 0) {
        return item;
      }
    }
    if (next !== undefined) {
      model.apply(next);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The simulation.

type Act =
  | { op: 'claim'; actor: number; ttl: number | null; grace: number }
  | { op: 'renew'; actor: number | null; ttl: number }
  | { op: 'release'; actor: number | null }
  | { op: 'force'; actor: number; holder: number | null }
  | { op: 'join'; actor: number; ttl: number }
  | { op: 'leave'; actor: number }
  | { op: 'handoff'; actor: number | null; to: number }
  | { op: 'assign'; to: number }
  | { op: 'window'; value: number }
  | { op: 'materialise' }
  | { op: 'deliver' };

interface Step {
  dt: number;
  skew: number;
  late: boolean;
  act: Act;
}

const actorIndex = fc.integer({ min: 0, max: ACTORS.length - 1 });
const ttlArb = fc.constantFrom(30_000, 60_000, 120_000, 600_000, 1_800_000);
const graceArb = fc.constantFrom(30_000, 120_000, 600_000);
/** Usually null (the holder the actor sees), sometimes a random actor. */
const holderOrAnyone = fc.oneof(
  { weight: 3, arbitrary: fc.constant(null) },
  { weight: 1, arbitrary: actorIndex },
);

const actArb: fc.Arbitrary<Act> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      op: fc.constant('claim' as const),
      actor: actorIndex,
      ttl: fc.option(ttlArb, { freq: 4 }),
      grace: graceArb,
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      op: fc.constant('renew' as const),
      actor: holderOrAnyone,
      ttl: ttlArb,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ op: fc.constant('release' as const), actor: holderOrAnyone }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      op: fc.constant('force' as const),
      actor: actorIndex,
      holder: fc.option(actorIndex, { freq: 3 }),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({ op: fc.constant('join' as const), actor: actorIndex, ttl: ttlArb }),
  },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('leave' as const), actor: actorIndex }) },
  {
    weight: 1,
    arbitrary: fc.record({
      op: fc.constant('handoff' as const),
      actor: holderOrAnyone,
      to: actorIndex,
    }),
  },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('assign' as const), to: actorIndex }) },
  {
    weight: 1,
    arbitrary: fc.record({
      op: fc.constant('window' as const),
      value: fc.constantFrom(30_000, 120_000, 300_000, 5000),
    }),
  },
  { weight: 3, arbitrary: fc.constant({ op: 'materialise' as const }) },
  { weight: 1, arbitrary: fc.constant({ op: 'deliver' as const }) },
);

const stepArb: fc.Arbitrary<Step> = fc.record({
  dt: fc.oneof(
    fc.integer({ min: 0, max: 5000 }),
    fc.integer({ min: 0, max: 400_000 }),
    fc.constantFrom(30_000, 60_000, 90_000, 120_000, 180_000, 180_001),
  ),
  skew: fc.oneof(
    { weight: 3, arbitrary: fc.constant(0) },
    { weight: 1, arbitrary: fc.integer({ min: -59_000, max: 59_000 }) },
  ),
  late: fc.oneof(
    { weight: 4, arbitrary: fc.constant(false) },
    { weight: 1, arbitrary: fc.constant(true) },
  ),
  act: actArb,
});

/** The actor at `index`, or for null the holder `view` shows (else `a`). */
function actorOr(index: number | null, view: Model): string {
  return index === null ? (view.assignee ?? 'a') : (ACTORS[index] as string);
}

/** What the actors and the materialiser see, and what exists in the end. */
interface Run {
  all: FoldInput[];
  now: number;
  grantsWritten: number;
}

/**
 * Plays `steps`: each act is decided on the fold of what has been delivered
 * so far (an actor fills `supersedes` from the lease it sees, and a forced
 * release names the holder it sees), written at the real time plus the
 * writer's skew, and either delivered at once or held back until a
 * `deliver` step (a late sync). Materialise steps write every grant due by
 * the real time from what has been delivered.
 */
function simulate(steps: readonly Step[]): Run {
  let now = START;
  const delivered: FoldInput[] = [CREATE];
  const pending: FoldInput[] = [];
  const grants = new Map<string, FoldInput>();
  const visible = (): FoldInput[] => [...delivered, ...grants.values()];
  const writeGrants = (): void => {
    for (const grant of materialise(visible(), now)) {
      grants.set(grant.hash, grant);
    }
  };

  for (const step of steps) {
    now += step.dt;
    const { act } = step;
    if (act.op === 'materialise') {
      writeGrants();
      continue;
    }
    if (act.op === 'deliver') {
      delivered.push(...pending.splice(0));
      continue;
    }
    const wall = Math.max(2, now + step.skew);
    const view = modelOf(visible());
    let event: BoardEvent;
    switch (act.op) {
      case 'claim': {
        const actor = ACTORS[act.actor] as string;
        const body: {
          lease?: { ttl: number; grace: number; expiresAt: number };
          supersedes?: { holder: string; expiresAt: number; event: string };
        } = {};
        if (act.ttl !== null) {
          body.lease = {
            ttl: act.ttl,
            grace: act.grace,
            expiresAt: wall + Math.min(act.ttl, act.grace),
          };
        }
        if (view.assignee !== null && view.assignee !== actor && view.lease !== null) {
          body.supersedes = {
            holder: view.assignee,
            expiresAt: view.lease.expiresAt,
            event: view.lease.event,
          };
        }
        event = { v: 1, kind: 'ticket.claim', ticket: T1, ...at(actor, wall), body };
        break;
      }
      case 'renew':
        event = {
          v: 1,
          kind: 'ticket.renew',
          ticket: T1,
          ...at(actorOr(act.actor, view), wall),
          body: { ttl: act.ttl, expiresAt: wall + act.ttl },
        };
        break;
      case 'release':
        event = {
          v: 1,
          kind: 'ticket.release',
          ticket: T1,
          ...at(actorOr(act.actor, view), wall),
          body: {},
        };
        break;
      case 'force': {
        const holder =
          act.holder === null ? (view.assignee ?? 'nobody') : (ACTORS[act.holder] as string);
        event = {
          v: 1,
          kind: 'ticket.release.force',
          ticket: T1,
          ...at(ACTORS[act.actor] as string, wall),
          body: { holder, reason: 'holder is gone' },
        };
        break;
      }
      case 'join':
        event = {
          v: 1,
          kind: 'ticket.queue.join',
          ticket: T1,
          ...at(ACTORS[act.actor] as string, wall),
          body: { ttl: act.ttl },
        };
        break;
      case 'leave':
        event = {
          v: 1,
          kind: 'ticket.queue.leave',
          ticket: T1,
          ...at(ACTORS[act.actor] as string, wall),
          body: {},
        };
        break;
      case 'handoff':
        event = {
          v: 1,
          kind: 'ticket.handoff',
          ticket: T1,
          ...at(actorOr(act.actor, view), wall),
          body: { to: ACTORS[act.to] as string, status: 'todo', note: 'over to you' },
        };
        break;
      case 'assign':
        event = {
          v: 1,
          kind: 'ticket.assign',
          ticket: T1,
          ...at('orch', wall),
          body: { to: ACTORS[act.to] as string },
        };
        break;
      case 'window':
        event = {
          v: 1,
          kind: 'board.meta',
          ...at('orch', wall),
          body: { key: 'queue.window', value: act.value },
        };
        break;
    }
    (step.late ? pending : delivered).push(input(event));
  }
  delivered.push(...pending.splice(0));
  writeGrants();
  return { all: visible(), now, grantsWritten: grants.size };
}

// ---------------------------------------------------------------------------
// Checks.

/** Counts across all runs, to prove the properties are not vacuous. */
const seen = {
  appliedGrants: 0,
  staleGrants: 0,
  releaseGrants: 0,
  graceLapseGrants: 0,
  passedOnGrants: 0,
  renewLapseGrants: 0,
  takeovers: 0,
  rejectedTakeovers: 0,
  forcedReleases: 0,
  queuedRefusals: 0,
  handoffsToWaiters: 0,
};

/** The `expiresAt` of the lease set by `setter`, recomputed from its own body. */
function expiryOf(setter: FoldInput | undefined): number {
  const e = setter?.event as BoardEvent | undefined;
  switch (e?.kind) {
    case 'ticket.claim':
      if (e.body.lease === undefined) break;
      return e.ts.wall + Math.min(e.body.lease.ttl, e.body.lease.grace);
    case 'ticket.renew':
      return e.ts.wall + e.body.ttl;
    case 'ticket.grant':
      return e.ts.wall + e.body.window;
    default:
      break;
  }
  throw new Error('a lease was named that no claim, renew or grant set');
}

/**
 * Walks `all` in fold order with `applyEvent`, asserting at every position
 * that the fold agrees with the model and that the spec's properties hold.
 */
function checkWalk(all: readonly FoldInput[]): BoardState {
  const ordered = unique(all).sort(compareFoldOrder);
  const byHash = new Map(ordered.map((i) => [i.hash, i]));
  const state = emptyState();
  const model = new Model();
  const takeoversPerLease = new Map<string, number>();

  for (const item of ordered) {
    const e = item.event as BoardEvent;
    const prior = model.clone();
    const expected = model.apply(item);
    const outcome = applyEvent(state, item);
    const reason = outcome.status === 'rejected' ? outcome.rejected.reason : null;
    expect({ hash: item.hash, kind: e.kind, reason }).toEqual({
      hash: item.hash,
      kind: e.kind,
      reason: expected,
    });

    if (e.kind === 'ticket.grant') {
      if (reason === null) {
        seen.appliedGrants += 1;
        // Join order: the grantee is the earliest-joined waiter still queued.
        const head = prior.queue[0] as ModelWaiter;
        expect(e.body.to).toBe(head.actor);
        expect(prior.queue.every((w) => compareHlcOrHash(head, w) <= 0)).toBe(true);
        expect(e.body.window).toBe(prior.window);
        const { after } = e.body;
        if ('released' in after) {
          seen.releaseGrants += 1;
          expect(prior.assignee).toBeNull();
          const release = byHash.get(after.released)?.event as BoardEvent | undefined;
          expect(
            release?.kind === 'ticket.release' || release?.kind === 'ticket.release.force',
          ).toBe(true);
          expect(e.ts.wall).toBe(Math.max(release?.ts.wall ?? NaN, head.joined.wall) + 1);
        } else {
          // A lapse grant: never before the named lease's expiry plus the tolerance.
          const setter = byHash.get(after.lease.event);
          expect(after.lease.expiresAt).toBe(expiryOf(setter));
          expect(after.lease.holder).toBe(prior.assignee);
          expect(e.ts.wall).toBeGreaterThanOrEqual(after.lease.expiresAt + SKEW);
          expect(e.ts.wall).toBe(Math.max(after.lease.expiresAt + SKEW, head.joined.wall) + 1);
          const setterKind = (setter?.event as BoardEvent).kind;
          if (setterKind === 'ticket.grant') {
            // The reservation passes on at exactly the window plus the tolerance.
            seen.passedOnGrants += 1;
            const previous = setter?.event as TicketGrantEvent;
            expect(e.ts.wall).toBe(
              Math.max(previous.ts.wall + previous.body.window + SKEW, head.joined.wall) + 1,
            );
          } else if (setterKind === 'ticket.claim') {
            // Grace expiry without renew at exactly the grace plus the tolerance.
            seen.graceLapseGrants += 1;
            expect(prior.lease?.confirmed).toBe(false);
          } else {
            seen.renewLapseGrants += 1;
          }
        }
        expect(e.ts.counter).toBe(0);
      } else {
        seen.staleGrants += 1;
      }
    }

    if (e.kind === 'ticket.claim') {
      if (
        prior.assignee !== null &&
        prior.assignee !== e.actor &&
        e.body.supersedes !== undefined
      ) {
        if (reason === null) {
          seen.takeovers += 1;
          const lease = prior.lease as ModelLease;
          expect(e.ts.wall).toBeGreaterThanOrEqual(lease.expiresAt + SKEW);
          const count = (takeoversPerLease.get(lease.event) ?? 0) + 1;
          takeoversPerLease.set(lease.event, count);
          expect(count).toBe(1);
        } else {
          seen.rejectedTakeovers += 1;
        }
      }
      if (reason === 'queued') {
        seen.queuedRefusals += 1;
      }
    }
    if (e.kind === 'ticket.release.force' && reason === null) {
      seen.forcedReleases += 1;
    }

    if ((e.kind === 'ticket.handoff' || e.kind === 'ticket.assign') && reason === null) {
      if (prior.queue.some((w) => w.actor === e.body.to)) {
        seen.handoffsToWaiters += 1;
      }
    }

    // The fold's ticket agrees with the model at every position, and the
    // assignee is never queued.
    const ticket = state.tickets[T1];
    if (ticket !== undefined) {
      expect(ticket.queue.some((w) => w.actor === ticket.assignee)).toBe(false);
      expect(snapshot(ticket)).toEqual({
        assignee: model.assignee,
        lease: model.lease,
        queue: model.queue,
        available: model.available(),
      });
    }
    if (outcome.status === 'rejected') {
      expect(ticket === undefined ? null : snapshot(ticket)).toEqual(
        prior.exists
          ? {
              assignee: prior.assignee,
              lease: prior.lease,
              queue: prior.queue,
              available: prior.available(),
            }
          : null,
      );
    }
  }
  return state;
}

function snapshot(ticket: Ticket): unknown {
  return {
    assignee: ticket.assignee,
    lease: ticket.lease,
    queue: ticket.queue,
    available: ticket.available,
  };
}

/** Fold order between two waiters' joins (timestamp, then hash). */
function compareHlcOrHash(a: ModelWaiter, b: ModelWaiter): number {
  return compareFoldOrder(
    { hash: a.event, event: { ...CREATE.event, ts: a.joined } as BoardEvent },
    { hash: b.event, event: { ...CREATE.event, ts: b.joined } as BoardEvent },
  );
}

describe('property: grants follow join order and folds converge', () => {
  it(
    'random leases, queues, takeovers, forced releases and materialised grants',
    { timeout: PROPERTY_TIMEOUT_MS },
    () => {
      fc.assert(
        fc.property(
          fc.array(stepArb, { minLength: 5, maxLength: 60 }),
          fc.array(fc.integer(), { minLength: 3, maxLength: 3 }),
          (steps, seeds) => {
            const run = simulate(steps);
            const reference = fold(run.all);
            const expected = bytesOf(reference);
            // Sampled read orders fold to byte-identical results.
            for (const seed of seeds) {
              expect(bytesOf(fold(shuffle(run.all, seed)))).toBe(expected);
            }
            // The step-by-step walk is the fold, and agrees with the model.
            const walked = checkWalk(run.all);
            expect(new TextDecoder().decode(canonicalEncode(walked))).toBe(
              new TextDecoder().decode(canonicalEncode(reference.state)),
            );
            // Every grant the materialiser wrote is either applied or stale.
            for (const r of reference.rejected) {
              if (r.kind === 'ticket.grant') {
                expect(r.reason).toBe('stale-grant');
              }
            }
            // Nothing more is due at the final clock: materialising is idempotent.
            expect(materialise(run.all, run.now)).toEqual([]);
          },
        ),
        { numRuns: 300 },
      );
      // The properties above held on runs that exercised every rule.
      for (const [name, count] of Object.entries(seen)) {
        expect({ name, exercised: count > 0 }).toEqual({ name, exercised: true });
      }
    },
  );
});

describe('property: one effective takeover per lease', () => {
  it(
    'at most one takeover naming a lease applies, in every sampled read order',
    { timeout: PROPERTY_TIMEOUT_MS },
    () => {
      const claim = input({
        v: 1,
        kind: 'ticket.claim',
        ticket: T1,
        ...at('h', 1_000_000),
        body: { lease: { ttl: 1_800_000, grace: 120_000, expiresAt: 1_120_000 } },
      });
      const lease = { holder: 'h', expiresAt: 1_120_000, event: claim.hash };
      const eventArb: fc.Arbitrary<FoldInput> = fc
        .record({
          kind: fc.constantFrom('takeover', 'takeover', 'takeover', 'renew', 'release', 'force'),
          actor: fc.constantFrom('h', 'a', 'b', 'c'),
          wall: fc.integer({ min: 1_000_001, max: 1_400_000 }),
        })
        .map(({ kind, actor, wall }): FoldInput => {
          switch (kind) {
            case 'takeover':
              return input({
                v: 1,
                kind: 'ticket.claim',
                ticket: T1,
                ...at(actor, wall),
                body: { supersedes: lease },
              });
            case 'renew':
              return input({
                v: 1,
                kind: 'ticket.renew',
                ticket: T1,
                ...at(actor, wall),
                body: { ttl: 60_000, expiresAt: wall + 60_000 },
              });
            case 'release':
              return input({
                v: 1,
                kind: 'ticket.release',
                ticket: T1,
                ...at(actor, wall),
                body: {},
              });
            default:
              return input({
                v: 1,
                kind: 'ticket.release.force',
                ticket: T1,
                ...at(actor, wall),
                body: { holder: 'h', reason: 'stale' },
              });
          }
        });
      fc.assert(
        fc.property(
          fc.array(eventArb, { minLength: 1, maxLength: 12 }),
          fc.array(fc.integer(), { minLength: 4, maxLength: 4 }),
          (events, seeds) => {
            const all = [CREATE, claim, ...events];
            const reference = fold(all);
            const expected = bytesOf(reference);
            for (const seed of seeds) {
              expect(bytesOf(fold(shuffle(all, seed)))).toBe(expected);
            }
            // At most one takeover per lease, none before the claimable time
            // (asserted by the walk, which counts takeovers per lease).
            const before = seen.takeovers;
            checkWalk(all);
            expect(seen.takeovers - before).toBeLessThanOrEqual(1);
          },
        ),
        { numRuns: 300 },
      );
    },
  );
});
