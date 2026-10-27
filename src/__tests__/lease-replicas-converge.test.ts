/**
 * Two replicas with skewed clocks converge on leases, the queue and grants
 * (add-claim-leases task 5.2; board-concurrency: "Lease and queue folds
 * converge across replicas with skewed clocks", scenario "Skewed replicas
 * converge").
 *
 * Clones A and B of one standalone board share a bare remote. Every
 * command of a clone is a child of the built CLI on that clone's clock:
 * B's is the real clock plus the simulated time elapsed in the scenario,
 * A's the same plus 45 seconds (A's machine is 45 s fast). Simulated time
 * is moved forward through the harness's clock offset, never waited for.
 *
 * Connected (elapsed 0): `h` claims T1 with `--ttl 30m` on B and never
 * renews; `w` joins on A. Both sync.
 *
 * Disconnected (elapsed 200 s, past the lapse of `h`'s grace lease at its
 * claim's wall plus 180000): B's `list` writes the grant to `w`; `w` renews
 * and releases, `x` claims the free ticket and `y` joins, all on B. A's
 * `list` writes the same grant; `z` joins and leaves, and `v` joins, all
 * on A. Then A syncs, B syncs and A syncs again.
 *
 * Both clones then hold the same event files, the grant written on both is
 * one file, the rebuilt caches dump byte for byte alike, `rebuild --check`
 * is clean on both, nothing is rejected, and an independent walk of the
 * fold finds one holder at every position. Repeated `RUNS` times.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { canonicalDump } from './harness/host-sync.js';
import {
  GRACE,
  RUNS,
  SCENARIO_TIMEOUT_MS,
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
  type Clock,
} from './harness/leases.js';
import { eventNames } from '../store/__tests__/helpers.js';

/** A's machine is this far ahead of B's. */
const A_FAST = 45_000;
/** Simulated time of the disconnected phase, past the lapse of `h`'s grace lease. */
const LATER = 200_000;

const onA = (elapsed: number): Clock => ({ offset: elapsed + A_FAST });
const onB = (elapsed: number): Clock => (elapsed === 0 ? null : { offset: elapsed });

describe('scenario: skewed replicas converge', () => {
  it(
    `both clones fold to identical state with one file per grant (${String(RUNS)} runs)`,
    { timeout: SCENARIO_TIMEOUT_MS },
    async () => {
      for (let run = 1; run <= RUNS; run += 1) {
        const label = `run ${String(run)}`;
        const { a, b, env } = await twoClones();

        // Connected: h claims on B, w joins on A.
        await cliOk(['claim', T1, '--ttl', '30m', '--as', 'h'], b.root, onB(0), env);
        await syncOk(b.root, env, onB(0));
        await syncOk(a.root, env, onA(0));
        await joinAndDie(a.root, 'w', onA(0), env);
        await syncOk(a.root, env, onA(0));
        await syncOk(b.root, env, onB(0));
        const [claim] = eventsOfKind(b.eventsDir, 'ticket.claim');
        const claimWall = claim?.event.ts.wall ?? NaN;
        const slot = claimWall + GRACE + SKEW + 1;

        // Disconnected, on B.
        const bAfterGrant = await show(b.root, onB(LATER), env);
        expect(bAfterGrant.assignee, label).toBe('w');
        const bGrants = eventsOfKind(b.eventsDir, 'ticket.grant');
        expect(
          bGrants.map((g) => ({ wall: g.event.ts.wall, body: g.event.body })),
          label,
        ).toEqual([
          {
            wall: slot,
            body: {
              to: 'w',
              ttl: TTL,
              window: WINDOW,
              after: {
                lease: { holder: 'h', expiresAt: claimWall + GRACE, event: claim?.hash },
              },
            },
          },
        ]);
        await cliOk(['renew', T1, '--as', 'w'], b.root, onB(LATER), env);
        await cliOk(['release', T1, '--as', 'w'], b.root, onB(LATER), env);
        await cliOk(['claim', T1, '--ttl', '30m', '--as', 'x'], b.root, onB(LATER), env);
        await joinAndDie(b.root, 'y', onB(LATER), env);

        // Disconnected, on A: the same grant, then a join and leave and a join.
        const aAfterGrant = await show(a.root, onA(LATER), env);
        expect(aAfterGrant.assignee, label).toBe('w');
        const aGrants = eventsOfKind(a.eventsDir, 'ticket.grant');
        expect(
          aGrants.map((g) => g.hash),
          label,
        ).toEqual(bGrants.map((g) => g.hash));
        const grantFile = `${bGrants[0]?.hash ?? ''}.json`;
        expect(readFileSync(join(a.eventsDir, grantFile)), label).toEqual(
          readFileSync(join(b.eventsDir, grantFile)),
        );
        await joinAndDie(a.root, 'z', onA(LATER), env);
        await cliOk(['unqueue', T1, '--as', 'z'], a.root, onA(LATER), env);
        await joinAndDie(a.root, 'v', onA(LATER), env);
        expect(
          (await show(a.root, onA(LATER), env)).queue.map((q) => q.actor),
          label,
        ).toEqual(['v']);

        // Reconnect: A, B, then A again.
        await syncOk(a.root, env, onA(LATER));
        await syncOk(b.root, env, onB(LATER));
        await syncOk(a.root, env, onA(LATER));

        expect(eventNames(a.eventsDir), label).toEqual(eventNames(b.eventsDir));
        expect(eventsOfKind(a.eventsDir, 'ticket.grant'), label).toHaveLength(1);
        expect(canonicalDump(a.dir), label).toBe(canonicalDump(b.dir));
        for (const [clone, clock] of [
          [a, onA(LATER)],
          [b, onB(LATER)],
        ] as const) {
          const ticket = await show(clone.root, clock, env);
          expect(ticket.assignee, label).toBe('x');
          expect(
            ticket.queue.map((q) => q.actor),
            label,
          ).toEqual(['y', 'v']);
          const walk = expectExclusionIn(clone.eventsDir);
          expect(
            walk.grants.map((g) => g.to),
            label,
          ).toEqual(['w']);
          expect(walk.rejected, label).toEqual([]);
          await expectCheckClean(clone.root, env, label);
        }
      }
    },
  );
});
