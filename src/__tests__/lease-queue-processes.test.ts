/**
 * Fair, single grants across processes (add-claim-leases task 5.1;
 * board-concurrency: "Queue grants are fair and single", scenario
 * "Concurrent joins and releases"), repeated `RUNS` times on a fresh
 * board, each run ending with `rebuild --check` clean and an independent
 * walk of the fold (`expectExclusion`) finding at most one holder at every
 * position.
 *
 * Ten `claim T1 --ttl 30m --wait --timeout 5m` children start together
 * behind the start gate against a holder; once every one has printed its
 * queued line the holder releases (a child), and each granted waiter
 * renews and releases (children) in turn. Grants are observed through the
 * waiters' own exits: exactly one exits at a time, in the fold order of
 * the join events, all on the real clock. The lapse scenarios of the same
 * requirement are in `lease-lapse-processes.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { P, ev, putEvent } from '../store/__tests__/helpers.js';
import {
  RUNS,
  SCENARIO_TIMEOUT_MS,
  T1,
  cliOk,
  eventsOfKind,
  expectCheckClean,
  expectExclusionIn,
  queuedLine,
  show,
} from './harness/leases.js';
import {
  boardProject,
  startGated,
  type CliProcess,
  type ProcessResult,
} from './harness/processes.js';

/** A fresh board with T1 created a second ago; the cache is built. */
async function freshBoard(): Promise<{ root: string; eventsDir: string }> {
  const project = boardProject();
  putEvent(project.eventsDir, ev(P.create(T1, 'Merge lock'), 'orch', Date.now() - 1000));
  await cliOk(['list'], project.root);
  return project;
}

const WAITERS = Array.from({ length: 10 }, (_, n) => `waiter-${String(n)}`);

describe('scenario: concurrent joins and releases', () => {
  it(
    `every waiter is granted exactly once, in the fold order of its join (${String(RUNS)} runs)`,
    { timeout: SCENARIO_TIMEOUT_MS },
    async () => {
      for (let run = 1; run <= RUNS; run += 1) {
        const label = `run ${String(run)}`;
        const { root, eventsDir } = await freshBoard();
        await cliOk(['claim', T1, '--ttl', '30m', '--as', 'holder', '--json'], root);

        const gated = await startGated(
          WAITERS.map((actor) => ({
            argv: ['claim', T1, '--ttl', '30m', '--wait', '--timeout', '5m', '--as', actor],
            // Ten waiters granted one after another on a loaded host: well
            // past the harness's default 30 s, well inside --timeout 5m.
            timeoutMs: 240_000,
          })),
          root,
        );
        gated.open();
        await Promise.all(gated.procs.map((proc) => queuedLine(proc)));
        const running = new Map<CliProcess, string>(
          gated.procs.map((proc, n) => [proc, WAITERS[n] ?? '']),
        );
        const exitedSoFar = new Set<CliProcess>();
        for (const proc of gated.procs) {
          void proc.exited.then(() => exitedSoFar.add(proc));
        }

        // The queue is the joins in fold order, and that is the order of the grants.
        const joinOrder = eventsOfKind(eventsDir, 'ticket.queue.join').map((j) => j.event.actor);
        expect([...joinOrder].sort(), label).toEqual([...WAITERS].sort());
        const queued = await show(root);
        expect(
          queued.queue.map((w) => w.actor),
          label,
        ).toEqual(joinOrder);
        expect(queued.assignee, label).toBe('holder');

        await cliOk(['release', T1, '--as', 'holder'], root);
        const granted: string[] = [];
        for (let turn = 0; turn < WAITERS.length; turn += 1) {
          const [proc, result] = await Promise.race(
            [...running.keys()].map((p) =>
              p.exited.then((r): [CliProcess, ProcessResult] => [p, r]),
            ),
          );
          const actor = running.get(proc) ?? '';
          running.delete(proc);
          granted.push(actor);
          expect(result.code, `${label} ${actor}: ${result.stdout} ${result.stderr}`).toBe(0);
          expect(result.stdout, label).toContain(`agentboard renew ${T1} --as ${actor}`);
          const ticket = await show(root);
          expect(ticket.assignee, label).toBe(actor);
          expect(ticket.lease, label).toMatchObject({ confirmed: false });
          expect(
            ticket.queue.map((w) => w.actor),
            label,
          ).toEqual(joinOrder.slice(turn + 1));
          await cliOk(['renew', T1, '--as', actor], root);
          // Nobody else is granted while the grantee holds the ticket.
          expect(
            [...running.keys()].filter((p) => exitedSoFar.has(p)),
            label,
          ).toEqual([]);
          await cliOk(['release', T1, '--as', actor], root);
        }
        expect(granted, label).toEqual(joinOrder);

        // One applied grant per waiter, in join order, and nothing rejected.
        const walk = expectExclusionIn(eventsDir);
        expect(
          walk.grants.map((g) => g.to),
          label,
        ).toEqual(joinOrder);
        expect(walk.rejected, label).toEqual([]);
        expect(eventsOfKind(eventsDir, 'ticket.grant'), label).toHaveLength(WAITERS.length);
        const end = await show(root);
        expect(end.assignee, label).toBeNull();
        expect(end.queue, label).toEqual([]);
        await expectCheckClean(root, undefined, label);
      }
    },
  );
});
