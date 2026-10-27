/**
 * Ten processes racing to take over a claimable lease (add-claim-leases
 * task 5.1; board-concurrency: "Expired-lease claim race has exactly one
 * winner", scenario "Ten concurrent takeovers").
 *
 * Each run seeds a fresh board as event files at walls from the real
 * clock: `holder` claims T1 with `--ttl 30m` and the default 2m grace and
 * never renews, and T1 has no waiters. The ten `claim T1 --ttl 30m` children
 * run with their clocks five minutes ahead (the lease is claimable from
 * the claim's wall plus 180000 ms), so every one of them may take over and
 * exactly one must. They are held by the harness's lock gate
 * (`startLockGated`) at the moment each asks for the cache's write lock,
 * and released together, so the race is at the lock itself and not only
 * at start-up (a start gate alone left children reaching the lock up to
 * hundreds of milliseconds apart). Every run asserts that it was a race:
 * at least two children asked for the lock before the first transaction
 * ended. With one shared cache a loser is refused inside the lock before
 * it writes, so each run writes exactly one claim file and the fold
 * rejects nothing; "any others written are rejected" is pinned by the
 * group 1 property test "one effective takeover per lease". The run is
 * repeated `RUNS` times, each ending with `rebuild --check` clean.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { P, ev, putEvent } from '../store/__tests__/helpers.js';
import {
  GRACE,
  RUNS,
  SCENARIO_TIMEOUT_MS,
  SKEW,
  T1,
  TTL,
  cliOk,
  errorOf,
  eventsOfKind,
  expectCheckClean,
  expectExclusionIn,
  show,
} from './harness/leases.js';
import { boardProject, oneDocument, startLockGated } from './harness/processes.js';

/** How far ahead the racing children run: well past the claimable time. */
const AHEAD = GRACE + SKEW + 120_000;

const ACTORS = Array.from({ length: 10 }, (_, n) => `agent-${String(n)}`);

describe('scenario: ten concurrent takeovers', () => {
  it(
    `exactly one takes over, nine exit 4 already-assigned naming it (${String(RUNS)} runs)`,
    { timeout: SCENARIO_TIMEOUT_MS },
    async () => {
      for (let run = 1; run <= RUNS; run += 1) {
        const label = `run ${String(run)}`;
        const { root, eventsDir } = boardProject();
        const base = Date.now() - 1000;
        putEvent(eventsDir, ev(P.create(T1, 'Merge lock'), 'orch', base - 1000));
        const claim = putEvent(
          eventsDir,
          ev(
            {
              kind: 'ticket.claim',
              ticket: T1,
              body: { lease: { ttl: TTL, grace: GRACE, expiresAt: base + GRACE } },
            },
            'holder',
            base,
          ),
        );
        // The cache exists before the race, so the race is the claims alone.
        await cliOk(['list'], root);

        const gated = await startLockGated(
          ACTORS.map((actor) => ({
            argv: ['claim', T1, '--ttl', '30m', '--as', actor, '--json'],
            clockOffsetMs: AHEAD,
          })),
          root,
        );
        expect(gated.readyAtLock, label).toBe(10);
        gated.open();
        const results = await Promise.all(gated.procs.map((p) => p.exited));
        // A race: more than one child asked for the lock before the first
        // transaction ended (each child's asked time is after the gate).
        const times = gated.times();
        const firstEnd = Math.min(...times.map((t) => t.ended ?? Infinity));
        expect(Number.isFinite(firstEnd), label).toBe(true);
        const contending = times.filter((t) => t.asked !== null && t.asked < firstEnd).length;
        expect(contending, `${label}: ${JSON.stringify(times)}`).toBeGreaterThanOrEqual(2);
        expect(
          results.map((r) => r.signal),
          label,
        ).toEqual(ACTORS.map(() => null));
        const won = results.flatMap((r, n) => (r.code === 0 ? [ACTORS[n] ?? ''] : []));
        expect(won, `${label}: ${results.map((r) => r.stdout).join('')}`).toHaveLength(1);
        const winner = won[0] ?? '';

        for (const [n, result] of results.entries()) {
          if (result.code === 0) {
            const doc = oneDocument(result) as {
              hash: string;
              ticket: { assignee: string; lease: { event: string; confirmed: boolean } };
            };
            expect(doc.ticket.assignee, label).toBe(winner);
            expect(doc.ticket.lease, label).toMatchObject({ event: doc.hash, confirmed: false });
            // The winning claim is a takeover naming the holder's grace lease.
            const written = JSON.parse(
              readFileSync(join(eventsDir, `${doc.hash}.json`), 'utf8'),
            ) as { kind: string; actor: string; body: { supersedes?: unknown } };
            expect(written, label).toMatchObject({
              kind: 'ticket.claim',
              actor: winner,
              body: { supersedes: { holder: 'holder', expiresAt: base + GRACE, event: claim } },
            });
            continue;
          }
          expect(result.code, `${label} ${ACTORS[n] ?? ''}: ${result.stderr}`).toBe(4);
          const error = errorOf(result);
          expect(error.reason, label).toBe('already-assigned');
          expect(error.message, label).toContain(`assigned to ${winner} `);
        }

        const ticket = await show(root, { offset: AHEAD });
        expect(ticket.assignee, label).toBe(winner);
        expect(ticket.assignee, label).not.toBe('holder');
        expect(ticket.queue, label).toEqual([]);

        // Exactly one takeover is effective, and the losers wrote nothing:
        // the holder's claim and the winner's are the only claim files.
        const walk = expectExclusionIn(eventsDir);
        expect(
          walk.takeovers.map((t) => t.actor),
          label,
        ).toEqual([winner]);
        expect(
          eventsOfKind(eventsDir, 'ticket.claim').map((c) => c.event.actor),
          label,
        ).toEqual(['holder', winner]);
        expect(walk.rejected, label).toEqual([]);
        expect(walk.state.tickets[T1]?.assignee, label).toBe(winner);
        await expectCheckClean(root, undefined, label);
      }
    },
  );
});
