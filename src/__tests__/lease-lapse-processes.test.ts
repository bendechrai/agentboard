/**
 * Grants passing on at their lapse, across processes (add-claim-leases
 * task 5.1; board-concurrency: "Queue grants are fair and single",
 * scenarios "Reservation passes on non-acceptance" and "Grace expiry
 * without renew"). Each scenario is repeated `RUNS` times on a fresh
 * board, each run ending with `rebuild --check` clean and an independent
 * walk of the fold (`expectExclusion`) finding at most one holder at every
 * position.
 *
 * - Reservation passes on non-acceptance: the board is seeded as event
 *   files (three joins and a release); the grant to `a` is written by a
 *   `show` on the real clock, and the hand-on to `b` by `show`s on stopped
 *   clocks one millisecond before and exactly at its slot time.
 * - Grace expiry without renew: a child claims T1 with `--ttl 30m`, `b`
 *   joins through the library, and `show`s on stopped clocks check that the
 *   grant is due at exactly the claim's wall plus 180001 and not before.
 */

import { describe, expect, it } from 'vitest';

import { claimTicket } from '../board/actions.js';
import { openBoard } from '../store/board.js';
import { P, ev, putEvent } from '../store/__tests__/helpers.js';
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
  show,
} from './harness/leases.js';
import { boardProject } from './harness/processes.js';

/** A fresh board with T1 created a second ago; the cache is built. */
async function freshBoard(): Promise<{ root: string; boardDir: string; eventsDir: string }> {
  const project = boardProject();
  putEvent(project.eventsDir, ev(P.create(T1, 'Merge lock'), 'orch', Date.now() - 1000));
  await cliOk(['list'], project.root);
  return project;
}

describe('scenario: reservation passes on non-acceptance', () => {
  it(
    `a's grant lapses at its window plus the tolerance and passes to b (${String(RUNS)} runs)`,
    { timeout: SCENARIO_TIMEOUT_MS },
    async () => {
      for (let run = 1; run <= RUNS; run += 1) {
        const label = `run ${String(run)}`;
        const { root, eventsDir } = boardProject();
        const base = Date.now() - 5000;
        putEvent(eventsDir, ev(P.create(T1, 'Merge lock'), 'orch', base));
        putEvent(eventsDir, ev(P.claim(T1), 'holder', base + 1));
        for (const [n, actor] of ['a', 'b', 'c'].entries()) {
          putEvent(
            eventsDir,
            ev({ kind: 'ticket.queue.join', ticket: T1, body: { ttl: TTL } }, actor, base + 2 + n),
          );
        }
        const release = putEvent(
          eventsDir,
          ev({ kind: 'ticket.release', ticket: T1, body: {} }, 'holder', base + 10),
        );

        // The first command writes the grant to a, at the release wall plus one.
        const toA = await show(root);
        expect(toA.assignee, label).toBe('a');
        expect(
          toA.queue.map((w) => w.actor),
          label,
        ).toEqual(['b', 'c']);
        const [first] = eventsOfKind(eventsDir, 'ticket.grant');
        expect(first?.event.ts.wall, label).toBe(base + 11);
        expect(first?.event.body, label).toEqual({
          to: 'a',
          ttl: TTL,
          window: WINDOW,
          after: { released: release },
        });
        const slot = base + 11 + WINDOW + SKEW + 1;

        // a never renews: one millisecond before the slot the reservation is still a's...
        const before = await show(root, { at: slot - 1 });
        expect(before.assignee, label).toBe('a');
        expect(eventsOfKind(eventsDir, 'ticket.grant'), label).toHaveLength(1);
        // ...and at the slot it passes to b, and a is no longer queued.
        const passed = await show(root, { at: slot });
        expect(passed.assignee, label).toBe('b');
        expect(
          passed.queue.map((w) => w.actor),
          label,
        ).toEqual(['c']);
        const grants = eventsOfKind(eventsDir, 'ticket.grant');
        expect(grants, label).toHaveLength(2);
        expect(grants[1]?.event.ts.wall, label).toBe(slot);
        expect(grants[1]?.event.body, label).toEqual({
          to: 'b',
          ttl: TTL,
          window: WINDOW,
          after: { lease: { holder: 'a', expiresAt: base + 11 + WINDOW, event: first?.hash } },
        });

        const walk = expectExclusionIn(eventsDir);
        expect(
          walk.grants.map((g) => g.to),
          label,
        ).toEqual(['a', 'b']);
        expect(walk.rejected, label).toEqual([]);
        await expectCheckClean(root, undefined, label);
      }
    },
  );
});

describe('scenario: grace expiry without renew', () => {
  it(
    `the grant to b is due at the claim's wall plus 180001 and not before (${String(RUNS)} runs)`,
    { timeout: SCENARIO_TIMEOUT_MS },
    async () => {
      for (let run = 1; run <= RUNS; run += 1) {
        const label = `run ${String(run)}`;
        const { root, boardDir, eventsDir } = await freshBoard();
        await cliOk(['claim', T1, '--ttl', '30m', '--as', 'holder'], root);
        const board = openBoard(boardDir);
        try {
          expect(claimTicket(board, 'b', { id: T1, ttl: TTL, wait: true }), label).toMatchObject({
            queued: true,
            position: 1,
            holder: 'holder',
          });
        } finally {
          board.close();
        }
        const [claim] = eventsOfKind(eventsDir, 'ticket.claim');
        const wall = claim?.event.ts.wall ?? NaN;
        expect(claim?.event.body, label).toEqual({
          lease: { ttl: TTL, grace: GRACE, expiresAt: wall + GRACE },
        });
        const slot = wall + GRACE + SKEW + 1;
        const [join] = eventsOfKind(eventsDir, 'ticket.queue.join');
        expect(join?.event.ts.wall, label).toBeLessThan(slot);

        const before = await show(root, { at: slot - 1 });
        expect(before.assignee, label).toBe('holder');
        expect(eventsOfKind(eventsDir, 'ticket.grant'), label).toEqual([]);

        const due = await show(root, { at: slot });
        expect(due.assignee, label).toBe('b');
        expect(due.queue, label).toEqual([]);
        const grants = eventsOfKind(eventsDir, 'ticket.grant');
        expect(
          grants.map((g) => ({ wall: g.event.ts.wall, body: g.event.body })),
          label,
        ).toEqual([
          {
            wall: slot,
            body: {
              to: 'b',
              ttl: TTL,
              window: WINDOW,
              after: { lease: { holder: 'holder', expiresAt: wall + GRACE, event: claim?.hash } },
            },
          },
        ]);
        const walk = expectExclusionIn(eventsDir);
        expect(walk.rejected, label).toEqual([]);
        await expectCheckClean(root, undefined, label);
      }
    },
  );
});
