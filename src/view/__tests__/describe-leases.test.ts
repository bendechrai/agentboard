/**
 * Feed summaries of the lease, queue and grant events (add-claim-leases
 * task 6.2; board-view-model: "Activity feed entries", scenarios "Lease
 * claim summary", "Renew summary", "Queue summaries", "Forced release
 * summary", "Takeover summary", "Grant summary" and "Rejected and stale
 * events have no entry").
 *
 * The first block pins `describeEvent` alone on built events; the second
 * folds small boards with the store's own fold (grants derived with
 * `dueGrants`, exactly as catch-up writes them) and reads `feedEntries`,
 * so the actor of a grant entry and the absence of rejected events are
 * checked where the spec states them.
 */

import { describe, expect, it } from 'vitest';

import type { FoldInput } from '../../events/fold.js';
import { dueGrants } from '../../events/grants.js';
import { SYSTEM_ACTOR, isKnownEvent } from '../../events/schema.js';
import { describeEvent } from '../describe.js';
import { feedEntries, type FeedEntry } from '../feed.js';
import { E, T1, T2, T3, TASK, model } from './helpers.js';

const d = (input: FoldInput): string => describeEvent(input.event);

const S = 1000;
const M = 60 * S;
const H = 60 * M;
const DAY = 24 * H;

/** A lease reference naming a hash that no event has; describeEvent does not look it up. */
const REF = { holder: 'merger-1', expiresAt: 5_000_000, event: 'a'.repeat(64) };

describe('describeEvent: lease, queue and grant summaries (task 6.2)', () => {
  it.each<[string, FoldInput, string]>([
    ['scenario: a lease claim of 90s', E.leaseClaim(T1, 90 * S), 'claimed (lease 90s)'],
    [
      'a lease claim names the requested ttl, not the grace',
      E.leaseClaim(T1, 30 * M, { grace: 2 * M }),
      'claimed (lease 30m)',
    ],
    ['a lease claim of 10m', E.leaseClaim(T1, 10 * M), 'claimed (lease 10m)'],
    ['a lease claim of 2h', E.leaseClaim(T1, 2 * H), 'claimed (lease 2h)'],
    ['a lease claim of 7d', E.leaseClaim(T1, 7 * DAY), 'claimed (lease 7d)'],
    ['a lease claim of 1d', E.leaseClaim(T1, DAY), 'claimed (lease 1d)'],
    ['90 minutes stays in minutes', E.leaseClaim(T1, 90 * M), 'claimed (lease 90m)'],
    ['36 hours stays in hours', E.leaseClaim(T1, 36 * H), 'claimed (lease 36h)'],
    ['61 seconds stays in seconds', E.leaseClaim(T1, 61 * S), 'claimed (lease 61s)'],
    ['no unit divides 30500', E.leaseClaim(T1, 30_500), 'claimed (lease 30500ms)'],
    ['a claim with no lease', E.claim(T1, { actor: 'impl' }), 'claimed'],
    [
      'scenario: a takeover with its own lease',
      E.leaseClaim(T1, 10 * M, { actor: 'merger-2', supersedes: REF }),
      'took over from merger-1 (lease expired)',
    ],
    [
      'a takeover without a lease',
      E.takeoverNoLease(T1, REF, { actor: 'merger-2' }),
      'took over from merger-1 (lease expired)',
    ],
    ['scenario: a renew of 2h', E.renew(T1, 2 * H), 'renewed lease (2h)'],
    ['a renew of 90s', E.renew(T1, 90 * S), 'renewed lease (90s)'],
    ['a renew of 1d', E.renew(T1, DAY), 'renewed lease (1d)'],
    ['a renew of 45500ms', E.renew(T1, 45_500), 'renewed lease (45500ms)'],
    ['scenario: joining the queue', E.join(T1, 10 * M), 'joined the queue'],
    ['scenario: leaving the queue', E.leave(T1), 'left the queue'],
    [
      'scenario: a grant with a window of 120000',
      E.grant(T1, { to: 'merger-2', ttl: 10 * M, window: 120_000, after: { released: REF.event } }),
      'granted to merger-2 (accept within 2m)',
    ],
    [
      'a grant with a window of 90s, after a lapse',
      E.grant(T1, { to: 'merger-3', ttl: 10 * M, window: 90 * S, after: { lease: REF } }),
      'granted to merger-3 (accept within 90s)',
    ],
    [
      'a grant names its window, not its ttl',
      E.grant(T1, { to: 'merger-2', ttl: 2 * H, window: 10 * M, after: { released: REF.event } }),
      'granted to merger-2 (accept within 10m)',
    ],
    [
      'scenario: a forced release',
      E.forceRelease(T1, 'merger-1', 'stalled', { actor: 'orchestrator' }),
      'force-released from merger-1: stalled',
    ],
    [
      'a forced release with a longer reason',
      E.forceRelease(T1, 'merger-1', 'holder gone: process exited at 10:02', {
        actor: 'orchestrator',
      }),
      'force-released from merger-1: holder gone: process exited at 10:02',
    ],
  ])('summarises %s', (_name, input, expected) => {
    expect(d(input)).toBe(expected);
  });

  it('puts a forced release reason and every actor name on one line', () => {
    expect(d(E.forceRelease(T1, 'merger-1', 'line one\nline two\r\nthree\rfour'))).toBe(
      'force-released from merger-1: line one line two three four',
    );
    expect(d(E.forceRelease(T1, 'odd\nholder', 'gone'))).toBe(
      'force-released from odd holder: gone',
    );
    expect(d(E.leaseClaim(T1, 10 * M, { supersedes: { ...REF, holder: 'odd\r\nholder' } }))).toBe(
      'took over from odd holder (lease expired)',
    );
    expect(
      d(
        E.grant(T1, {
          to: 'odd\nwaiter',
          ttl: 10 * M,
          window: 2 * M,
          after: { released: REF.event },
        }),
      ),
    ).toBe('granted to odd waiter (accept within 2m)');
  });

  it('keeps text verbatim otherwise, markup included', () => {
    expect(d(E.forceRelease(T1, '<b>m</b>', '<script>x</script>'))).toBe(
      'force-released from <b>m</b>: <script>x</script>',
    );
  });

  it('no longer summarises any of the new kinds as the bare kind', () => {
    const inputs = [
      E.renew(T1, 2 * H),
      E.join(T1, 10 * M),
      E.leave(T1),
      E.grant(T1, { to: 'a', ttl: 10 * M, window: 2 * M, after: { released: REF.event } }),
      E.forceRelease(T1, 'a', 'b'),
    ];
    for (const input of inputs) {
      expect(d(input), input.event.kind).not.toBe(input.event.kind);
    }
  });
});

describe('feedEntries with leases, queues and grants (task 6.2)', () => {
  const summary = (entries: FeedEntry[], hash: string): FeedEntry | undefined =>
    entries.find((e) => e.hash === hash);

  /**
   * T1: merger-1 claims with a 10m lease and confirms it, merger-2 and
   * merger-3 join, merger-3 leaves, then the orchestrator force-releases
   * merger-1 with reason `stalled`, which makes a grant to merger-2 due
   * at the release wall + 1, with the default window of 2 minutes.
   */
  interface ForcedBoard {
    inputs: FoldInput[];
    grant: FoldInput;
    force: FoldInput;
  }

  function forcedBoard(): ForcedBoard {
    const create = E.create(T1, { title: 'Merge lock', adhoc: 'mutex' }, { wall: 2_000_000 });
    const claim = E.leaseClaim(T1, 10 * M, { actor: 'merger-1', wall: 2_000_010 });
    const renew = E.renew(T1, 10 * M, { actor: 'merger-1', wall: 2_000_020 });
    const join2 = E.join(T1, 10 * M, { actor: 'merger-2', wall: 2_000_030 });
    const join3 = E.join(T1, 10 * M, { actor: 'merger-3', wall: 2_000_031 });
    const leave3 = E.leave(T1, { actor: 'merger-3', wall: 2_000_032 });
    const force = E.forceRelease(T1, 'merger-1', 'stalled', {
      actor: 'orchestrator',
      wall: 2_000_040,
    });
    const base = [create, claim, renew, join2, join3, leave3, force];
    const grants = dueGrants(base, 2_000_100);
    expect(grants).toHaveLength(1);
    const [grant] = grants;
    if (grant === undefined) {
      throw new Error('no grant derived');
    }
    return { inputs: [...base, grant], grant, force };
  }

  it('scenario: forced release summary, by the actor that forced it', () => {
    const b = forcedBoard();
    const entry = summary(feedEntries(model(b.inputs)), b.force.hash);
    expect(entry).toMatchObject({
      kind: 'ticket.release.force',
      actor: 'orchestrator',
      ticket: T1,
      summary: 'force-released from merger-1: stalled',
    });
  });

  it('scenario: grant summary, written by agentboard', () => {
    const b = forcedBoard();
    expect(b.grant.event.actor).toBe(SYSTEM_ACTOR);
    const entry = summary(feedEntries(model(b.inputs)), b.grant.hash);
    expect(entry).toMatchObject({
      kind: 'ticket.grant',
      actor: 'agentboard',
      ticket: T1,
      summary: 'granted to merger-2 (accept within 2m)',
    });
  });

  it('summarises every applied lease and queue event of the board, newest first', () => {
    const b = forcedBoard();
    const entries = feedEntries(model(b.inputs));
    expect(entries.map((e) => [e.actor, e.summary])).toEqual([
      ['agentboard', 'granted to merger-2 (accept within 2m)'],
      ['orchestrator', 'force-released from merger-1: stalled'],
      ['merger-3', 'left the queue'],
      ['merger-3', 'joined the queue'],
      ['merger-2', 'joined the queue'],
      ['merger-1', 'renewed lease (10m)'],
      ['merger-1', 'claimed (lease 10m)'],
      ['orch', 'created Merge lock'],
    ]);
  });

  it('scenario: takeover summary, after the lease expired', () => {
    const create = E.create(T2, { title: 'Deploy lock', task: TASK }, { wall: 3_000_000 });
    const claim = E.leaseClaim(T2, 90 * S, { actor: 'merger-1', wall: 3_000_010 });
    // Unconfirmed: the lease expires at wall + min(90s, grace 2m) = wall + 90s.
    const expiresAt = 3_000_010 + 90 * S;
    const takeover = E.leaseClaim(T2, 10 * M, {
      actor: 'merger-2',
      wall: expiresAt + 60_000,
      supersedes: { holder: 'merger-1', expiresAt, event: claim.hash },
    });
    const m = model([create, claim, takeover]);
    expect(m.events.find((e) => e.hash === takeover.hash)?.outcome).toBe('applied');
    const entry = summary(feedEntries(m), takeover.hash);
    expect(entry).toMatchObject({
      kind: 'ticket.claim',
      actor: 'merger-2',
      summary: 'took over from merger-1 (lease expired)',
    });
    expect(summary(feedEntries(m), claim.hash)?.summary).toBe('claimed (lease 90s)');
  });

  it('scenario: a rejected renew, leave or claim and a stale grant have no feed entry', () => {
    const b = forcedBoard();
    // merger-3 never held T1: its renew is rejected not-assignee.
    const strayRenew = E.renew(T1, 10 * M, { actor: 'merger-3', wall: 2_000_035 });
    // merger-3 already left: a second leave is rejected invalid-queue.
    const strayLeave = E.leave(T1, { actor: 'merger-3', wall: 2_000_036 });
    // A grant that does not equal the derived one (another window) is stale.
    const g = b.grant.event;
    if (!isKnownEvent(g) || g.kind !== 'ticket.grant') {
      throw new Error('not a grant');
    }
    const forged = E.grant(T1, { ...g.body, window: 5 * M }, { wall: g.ts.wall });
    // T3 has no waiters at all: any grant on it is stale.
    const create3 = E.create(T3, { title: 'Idle lock', adhoc: 'mutex' }, { wall: 2_000_050 });
    const idle = E.grant(
      T3,
      { to: 'merger-9', ttl: 10 * M, window: 2 * M, after: { released: REF.event } },
      { wall: 2_000_060 },
    );
    // On T1, now held by merger-2 under its grant, a takeover naming a
    // lease that is not the current one is rejected already-assigned.
    const badTakeover = E.leaseClaim(T1, 10 * M, {
      actor: 'merger-8',
      wall: 2_000_070,
      supersedes: REF,
    });
    const m = model([...b.inputs, strayRenew, strayLeave, forged, create3, idle, badTakeover]);
    const outcome = (input: FoldInput): [string | undefined, string | null | undefined] => {
      const view = m.events.find((e) => e.hash === input.hash);
      return [view?.outcome, view?.reason];
    };
    expect(outcome(strayRenew)).toEqual(['rejected', 'not-assignee']);
    expect(outcome(strayLeave)).toEqual(['rejected', 'invalid-queue']);
    expect(outcome(forged)).toEqual(['rejected', 'stale-grant']);
    expect(outcome(idle)).toEqual(['rejected', 'stale-grant']);
    expect(outcome(badTakeover)).toEqual(['rejected', 'already-assigned']);
    // The real grant still applies.
    expect(outcome(b.grant)).toEqual(['applied', null]);
    const hashes = feedEntries(m).map((e) => e.hash);
    for (const rejected of [strayRenew, strayLeave, forged, idle, badTakeover]) {
      expect(hashes, rejected.event.kind).not.toContain(rejected.hash);
    }
    expect(hashes).toContain(b.grant.hash);
    expect(hashes).toContain(create3.hash);
  });
});
