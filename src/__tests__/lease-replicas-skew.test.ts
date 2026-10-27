/**
 * A fast clock inside the tolerance cannot steal a live lease from another
 * replica (add-claim-leases task 5.2; board-concurrency: "Lease and queue
 * folds converge across replicas with skewed clocks", scenario "Fast clock
 * inside tolerance cannot steal a live lease", and the rule that within
 * one machine a takeover is accepted at and only at walls from
 * `expiresAt + 60000` on).
 *
 * Clones A and B of one standalone board share a bare remote. On B (the
 * real clock) `h` claims T1 with `--ttl 30m` and renews, so its lease
 * expires at real time E; both clones sync. A's machine is 59 seconds fast,
 * and its takeover attempt is made at real time E minus 1 second: the
 * child runs on a stopped clock reading E + 58000 (`clockFixedMs`), so the
 * boundary does not depend on how long the child takes to start.
 *
 * - The command refuses with `already-assigned` and writes nothing.
 * - A takeover event crafted with that wall, naming `h`'s lease, is put in
 *   A's events directory and synced: both replicas reject it
 *   `already-assigned`, `h` keeps T1, and the rebuilt caches are identical.
 * - Within A, a takeover at E + 59999 is refused and one at exactly
 *   E + 60000 is accepted with that wall; after both sync, both replicas
 *   fold it identically.
 *
 * Repeated `RUNS` times, `rebuild --check` clean on both clones after each.
 */

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
  cli,
  cliOk,
  errorOf,
  eventsOfKind,
  expectCheckClean,
  expectExclusionIn,
  show,
  syncOk,
  twoClones,
  type Clones,
} from './harness/leases.js';
import { oneDocument } from './harness/processes.js';
import { ev, eventNames, putEvent } from '../store/__tests__/helpers.js';

/** A's machine is this far ahead of B's. */
const A_FAST = 59_000;

/** Both clones agree byte for byte and fold `T1` to `assignee`. */
async function expectConverged(
  clones: Clones,
  assignee: string,
  rejected: { hash: string; kind: string; reason: string }[],
  label: string,
): Promise<void> {
  const { a, b, env } = clones;
  expect(eventNames(a.eventsDir), label).toEqual(eventNames(b.eventsDir));
  expect(canonicalDump(a.dir), label).toBe(canonicalDump(b.dir));
  for (const clone of [a, b]) {
    expect((await show(clone.root, null, env)).assignee, label).toBe(assignee);
    expect(expectExclusionIn(clone.eventsDir).rejected, label).toEqual(rejected);
    await expectCheckClean(clone.root, env, label);
  }
}

describe('scenario: fast clock inside tolerance cannot steal a live lease', () => {
  it(
    `A, 59 s fast, cannot take over at real E - 1 s; within A the boundary is exact (${String(RUNS)} runs)`,
    { timeout: SCENARIO_TIMEOUT_MS },
    async () => {
      for (let run = 1; run <= RUNS; run += 1) {
        const label = `run ${String(run)}`;
        const clones = await twoClones();
        const { a, b, env } = clones;
        await cliOk(['claim', T1, '--ttl', '30m', '--as', 'h'], b.root, null, env);
        await cliOk(['renew', T1, '--as', 'h'], b.root, null, env);
        await syncOk(b.root, env);
        await syncOk(a.root, env);
        const [renew] = eventsOfKind(a.eventsDir, 'ticket.renew');
        const expiresAt = (renew?.event.ts.wall ?? NaN) + TTL;
        expect((await show(a.root, null, env)).lease, label).toMatchObject({
          event: renew?.hash,
          expiresAt,
          confirmed: true,
        });
        const supersedes = { holder: 'h', expiresAt, event: renew?.hash ?? '' };

        // Real time E - 1 s on a clock 59 s fast.
        const stealAt = expiresAt - 1000 + A_FAST;
        const before = eventNames(a.eventsDir);
        const refused = await cli(
          ['claim', T1, '--ttl', '30m', '--as', 'thief', '--json'],
          a.root,
          { at: stealAt },
          env,
        );
        expect(refused.code, `${label}: ${refused.stdout} ${refused.stderr}`).toBe(4);
        expect(errorOf(refused).reason, label).toBe('already-assigned');
        expect(errorOf(refused).message, label).toContain('assigned to h ');
        expect(eventNames(a.eventsDir), label).toEqual(before);

        // The same takeover written by hand with that wall is rejected on both replicas.
        const crafted = putEvent(
          a.eventsDir,
          ev(
            {
              kind: 'ticket.claim',
              ticket: T1,
              body: {
                lease: { ttl: TTL, grace: GRACE, expiresAt: stealAt + GRACE },
                supersedes,
              },
            },
            'thief',
            stealAt,
          ),
        );
        await syncOk(a.root, env);
        await syncOk(b.root, env);
        await syncOk(a.root, env);
        const rejected = [{ hash: crafted, kind: 'ticket.claim', reason: 'already-assigned' }];
        await expectConverged(clones, 'h', rejected, `${label} crafted`);

        // Within one machine the rule is exact: refused one millisecond
        // before expiresAt + 60000, accepted at it, with that wall.
        const early = await cli(
          ['claim', T1, '--ttl', '30m', '--as', 'thief', '--json'],
          a.root,
          { at: expiresAt + SKEW - 1 },
          env,
        );
        expect(early.code, `${label}: ${early.stdout} ${early.stderr}`).toBe(4);
        expect(errorOf(early).reason, label).toBe('already-assigned');
        const taken = await cliOk(
          ['claim', T1, '--ttl', '30m', '--as', 'thief', '--json'],
          a.root,
          { at: expiresAt + SKEW },
          env,
        );
        const hash = (oneDocument(taken) as { hash: string }).hash;
        const takeover = eventsOfKind(a.eventsDir, 'ticket.claim').find((c) => c.hash === hash);
        expect(takeover?.event.ts, label).toEqual({
          wall: expiresAt + SKEW,
          counter: 0,
          actor: 'thief',
        });
        expect(takeover?.event.body.supersedes, label).toEqual(supersedes);
        await syncOk(a.root, env);
        await syncOk(b.root, env);
        await syncOk(a.root, env);
        await expectConverged(clones, 'thief', rejected, `${label} takeover`);
        expect(
          expectExclusionIn(join(b.dir, 'events')).takeovers.map((t) => t.hash),
          label,
        ).toEqual([hash]);
      }
    },
  );
});
