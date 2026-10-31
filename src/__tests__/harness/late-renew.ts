/**
 * The scenario "Renew synced late still wins" (add-claim-leases task 5.2;
 * board-concurrency: "Lease and queue folds converge across replicas with
 * skewed clocks"), shared by `lease-replicas-late-takeover.test.ts` and
 * `lease-replicas-late-grant.test.ts`, which run one variant each so
 * vitest runs them in parallel workers.
 *
 * Clones A and B of one standalone board share a bare remote. On B (the
 * real clock) `h` claims T1 with `--ttl 30m` and renews, so its lease
 * expires at real time E; in the grant variant `w` also joins, on A. Both
 * sync. Then, disconnected:
 *
 * - B renews again at real time E - 10 s (a child on a stopped clock
 *   reading E - 10000), before the expiry, and does not sync yet;
 * - A, whose machine is 45 s fast, acts at real time E + 20 s (a child on
 *   a stopped clock reading E + 65000, past E + 60000 on its own clock):
 *   in the takeover variant `a-agent` takes T1 over, in the grant variant
 *   A's `list` writes the lapse grant to `w`. A's own fold applies it.
 *
 * Then A syncs, B syncs and A syncs again. On both clones T1 is held by
 * `h` with the renewed lease, A's event is rejected (`already-assigned` or
 * `stale-grant`), both clones hold the same event files, the rebuilt
 * caches dump byte for byte alike and `rebuild --check` is clean.
 */

import { expect } from 'vitest';

import { canonicalDump } from './host-sync.js';
import {
  SKEW,
  T1,
  TTL,
  WINDOW,
  cliOk,
  eventsOfKind,
  expectCheckClean,
  expectExclusionIn,
  joinAndDie,
  show,
  syncOk,
  twoClones,
} from './leases.js';
import { oneDocument } from './processes.js';
import { eventNames } from '../../store/__tests__/helpers.js';

/** A's machine is this far ahead of B's. */
const A_FAST = 45_000;

/** One run of the scenario, for `variant`. */
export async function lateRenewRun(variant: 'takeover' | 'grant', label: string): Promise<void> {
  const clones = await twoClones();
  const { a, b, env } = clones;
  await cliOk(['claim', T1, '--ttl', '30m', '--as', 'h'], b.root, null, env);
  await cliOk(['renew', T1, '--as', 'h'], b.root, null, env);
  await syncOk(b.root, env);
  await syncOk(a.root, env);
  if (variant === 'grant') {
    await joinAndDie(a.root, 'w', { offset: A_FAST }, env);
    await syncOk(a.root, env);
    await syncOk(b.root, env);
  }
  const [renew] = eventsOfKind(b.eventsDir, 'ticket.renew');
  const expiresAt = (renew?.event.ts.wall ?? NaN) + TTL;
  const lapsed = { holder: 'h', expiresAt, event: renew?.hash ?? '' };

  // Disconnected. B renews 10 s before the expiry.
  const renewAt = expiresAt - 10_000;
  await cliOk(['renew', T1, '--as', 'h'], b.root, { at: renewAt }, env);
  const renewed = eventsOfKind(b.eventsDir, 'ticket.renew').find(
    (r) => r.event.ts.wall === renewAt,
  );
  expect(renewed, label).toBeDefined();

  // A acts 20 s after the expiry, on a clock 45 s fast.
  const actAt = expiresAt + 20_000 + A_FAST;
  let aEvent: string;
  let reason: string;
  if (variant === 'takeover') {
    const taken = await cliOk(
      ['claim', T1, '--ttl', '30m', '--as', 'a-agent', '--json'],
      a.root,
      { at: actAt },
      env,
    );
    aEvent = (oneDocument(taken) as { hash: string }).hash;
    const claim = eventsOfKind(a.eventsDir, 'ticket.claim').find((c) => c.hash === aEvent);
    expect(claim?.event.body.supersedes, label).toEqual(lapsed);
    expect((await show(a.root, { at: actAt }, env)).assignee, label).toBe('a-agent');
    reason = 'already-assigned';
  } else {
    const granted = await show(a.root, { at: actAt }, env);
    expect(granted.assignee, label).toBe('w');
    const grants = eventsOfKind(a.eventsDir, 'ticket.grant');
    expect(
      grants.map((g) => ({ wall: g.event.ts.wall, body: g.event.body })),
      label,
    ).toEqual([
      {
        wall: expiresAt + SKEW + 1,
        body: { to: 'w', ttl: TTL, window: WINDOW, after: { lease: lapsed } },
      },
    ]);
    aEvent = grants[0]?.hash ?? '';
    reason = 'stale-grant';
  }

  // B syncs only after A has written its event.
  await syncOk(a.root, env);
  await syncOk(b.root, env);
  await syncOk(a.root, env);

  expect(eventNames(a.eventsDir), label).toEqual(eventNames(b.eventsDir));
  expect(canonicalDump(a.dir), label).toBe(canonicalDump(b.dir));
  for (const clone of [a, b]) {
    const ticket = await show(clone.root, null, env);
    expect(ticket.assignee, label).toBe('h');
    expect(ticket.lease, label).toMatchObject({
      event: renewed?.hash,
      expiresAt: renewAt + TTL,
      confirmed: true,
    });
    expect(
      ticket.queue.map((q) => q.actor),
      label,
    ).toEqual(variant === 'grant' ? ['w'] : []);
    const walk = expectExclusionIn(clone.eventsDir);
    expect(walk.rejected, label).toEqual([
      { hash: aEvent, kind: `ticket.${variant === 'takeover' ? 'claim' : 'grant'}`, reason },
    ]);
    expect(walk.grants, label).toEqual([]);
    expect(walk.takeovers, label).toEqual([]);
    await expectCheckClean(clone.root, env, label);
  }
}
