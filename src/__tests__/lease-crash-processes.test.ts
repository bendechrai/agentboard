/**
 * Crashed holders and waiters recovered through lease expiry
 * (add-claim-leases task 5.1; board-concurrency: "Crashed holder recovery
 * through lease expiry", scenarios "Holder killed while holding the
 * lock", "Waiter killed while waiting" and "Holder killed after the claim
 * file is renamed"). Each scenario is repeated `RUNS` times on a fresh
 * board, each run ending with `rebuild --check` clean and an independent
 * walk of the fold (`expectExclusion`) finding at most one holder at every
 * position. Nobody impersonates the dead process: recovery is a takeover
 * or a grant by another actor.
 *
 * Processes die by SIGKILL. A holder is killed inside its renew (or its
 * claim) after the event file is renamed into place and before the cache
 * transaction commits (`AGENTBOARD_TEST_PAUSE=after-rename`), the latest a
 * process can die while its event still counts; a waiter is killed while
 * blocked in `claim --wait`. Lapses are reached by children whose clocks
 * run ahead (`clockOffsetMs`), with margins of 30 s or more past each
 * boundary, and the one probe between the expiry and the claimable time
 * runs on a stopped clock (`clockFixedMs`) 30 s from each.
 */

import { existsSync } from 'node:fs';
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
  WINDOW,
  cli,
  cliOk,
  errorOf,
  eventsOfKind,
  expectCheckClean,
  expectExclusionIn,
  queuedLine,
  show,
} from './harness/leases.js';
import { boardProject, cliEnv, oneDocument, startCli, waitForPause } from './harness/processes.js';

/** A fresh board with T1 created a second ago; the cache is built. */
async function freshBoard(): Promise<{ root: string; eventsDir: string }> {
  const project = boardProject();
  putEvent(project.eventsDir, ev(P.create(T1, 'Merge lock'), 'orch', Date.now() - 1000));
  await cliOk(['list'], project.root);
  return project;
}

/**
 * Runs `argv` paused after its event file's rename, kills it with SIGKILL
 * there, and returns the hash of the file it left.
 */
async function killAfterRename(root: string, eventsDir: string, argv: string[]): Promise<string> {
  const proc = startCli({ argv, env: cliEnv({ AGENTBOARD_TEST_PAUSE: 'after-rename' }) }, root);
  const path = await waitForPause(proc, 'after-rename');
  const killed = await proc.kill();
  expect(killed.signal).toBe('SIGKILL');
  expect(killed.stdout).toBe('');
  const match = /([0-9a-f]{64})\.json$/.exec(path);
  expect(path).toBe(join(eventsDir, `${match?.[1] ?? ''}.json`));
  expect(existsSync(path)).toBe(true);
  return match?.[1] ?? '';
}

/** The takeover claim `hash` in `eventsDir` names exactly `supersedes`. */
function expectTakeover(
  eventsDir: string,
  hash: string,
  actor: string,
  supersedes: { holder: string; expiresAt: number; event: string },
): void {
  const claim = eventsOfKind(eventsDir, 'ticket.claim').find((c) => c.hash === hash);
  expect(claim?.event.actor).toBe(actor);
  expect(claim?.event.body.supersedes).toEqual(supersedes);
}

describe('scenario: holder killed while holding the lock', () => {
  it(
    `a takeover is refused before the claimable time and succeeds after it (${String(RUNS)} runs)`,
    { timeout: SCENARIO_TIMEOUT_MS },
    async () => {
      for (let run = 1; run <= RUNS; run += 1) {
        const label = `run ${String(run)}`;
        const { root, eventsDir } = await freshBoard();
        await cliOk(['claim', T1, '--ttl', '30m', '--as', 'holder'], root);
        // The holder confirms its lease and dies in the same command.
        const renew = await killAfterRename(root, eventsDir, ['renew', T1, '--as', 'holder']);
        const held = await show(root);
        expect(held.assignee, label).toBe('holder');
        expect(held.lease, label).toMatchObject({ event: renew, confirmed: true, ttl: TTL });
        const expiresAt = held.lease?.expiresAt ?? NaN;
        const [renewEvent] = eventsOfKind(eventsDir, 'ticket.renew');
        expect(expiresAt, label).toBe((renewEvent?.event.ts.wall ?? NaN) + TTL);

        // Past the expiry but 30 s short of the claimable time: refused,
        // naming the dead holder. A stopped clock, so the margin on either
        // side is 30 s however long the run takes in real time.
        const early = await cli(['claim', T1, '--ttl', '30m', '--as', 'rescuer', '--json'], root, {
          at: expiresAt + SKEW / 2,
        });
        expect(early.code, `${label}: ${early.stdout} ${early.stderr}`).toBe(4);
        expect(errorOf(early).reason, label).toBe('already-assigned');
        expect(errorOf(early).message, label).toContain('assigned to holder ');
        expect(eventsOfKind(eventsDir, 'ticket.claim'), label).toHaveLength(1);

        // Past the claimable time: a takeover naming the renewed lease.
        const late = await cliOk(['claim', T1, '--ttl', '30m', '--as', 'rescuer', '--json'], root, {
          offset: TTL + SKEW + 60_000,
        });
        const doc = oneDocument(late) as { hash: string; ticket: { assignee: string } };
        expect(doc.ticket.assignee, label).toBe('rescuer');
        expectTakeover(eventsDir, doc.hash, 'rescuer', {
          holder: 'holder',
          expiresAt,
          event: renew,
        });

        const walk = expectExclusionIn(eventsDir);
        expect(
          walk.takeovers.map((t) => t.actor),
          label,
        ).toEqual(['rescuer']);
        expect(walk.rejected, label).toEqual([]);
        await expectCheckClean(root, undefined, label);
      }
    },
  );
});

describe('scenario: waiter killed while waiting', () => {
  it(
    `the dead waiter's grant lapses after its window and passes to the next waiter (${String(RUNS)} runs)`,
    { timeout: SCENARIO_TIMEOUT_MS },
    async () => {
      for (let run = 1; run <= RUNS; run += 1) {
        const label = `run ${String(run)}`;
        const { root, eventsDir } = await freshBoard();
        await cliOk(['claim', T1, '--ttl', '30m', '--as', 'holder'], root);
        const wait = (actor: string): string[] => [
          'claim',
          T1,
          '--ttl',
          '30m',
          '--wait',
          '--timeout',
          '10m',
          '--as',
          actor,
        ];
        const dead = startCli({ argv: wait('waiter-1') }, root);
        await queuedLine(dead);
        const killed = await dead.kill();
        expect(killed.signal, label).toBe('SIGKILL');
        const next = startCli({ argv: wait('waiter-2'), timeoutMs: 120_000 }, root);
        await queuedLine(next);
        expect(
          (await show(root)).queue.map((w) => w.actor),
          label,
        ).toEqual(['waiter-1', 'waiter-2']);

        await cliOk(['release', T1, '--as', 'holder'], root);
        // The grant goes to the dead waiter first (written by whichever
        // command catches up first: the live waiter or this show).
        const toDead = await show(root);
        expect(toDead.assignee, label).toBe('waiter-1');
        expect(
          toDead.queue.map((w) => w.actor),
          label,
        ).toEqual(['waiter-2']);
        const [first] = eventsOfKind(eventsDir, 'ticket.grant');
        expect(first?.event.body.to, label).toBe('waiter-1');
        expect(next.stdout(), label).not.toContain('agentboard renew');

        // Nobody renews it; past its window plus the tolerance it passes on,
        // and the live waiter, woken by the new grant file, exits granted.
        const passed = await show(root, { offset: WINDOW + SKEW + 30_000 });
        expect(passed.assignee, label).toBe('waiter-2');
        expect(passed.queue, label).toEqual([]);
        const result = await next.exited;
        expect(result.code, `${label}: ${result.stdout} ${result.stderr}`).toBe(0);
        expect(result.stdout, label).toContain(`agentboard renew ${T1} --as waiter-2`);
        const grants = eventsOfKind(eventsDir, 'ticket.grant');
        expect(
          grants.map((g) => g.event.body.to),
          label,
        ).toEqual(['waiter-1', 'waiter-2']);
        const firstWall = first?.event.ts.wall ?? NaN;
        expect(grants[1]?.event.ts.wall, label).toBe(firstWall + WINDOW + SKEW + 1);
        expect(grants[1]?.event.body.after, label).toEqual({
          lease: { holder: 'waiter-1', expiresAt: firstWall + WINDOW, event: first?.hash },
        });

        const walk = expectExclusionIn(eventsDir);
        expect(
          walk.grants.map((g) => g.to),
          label,
        ).toEqual(['waiter-1', 'waiter-2']);
        expect(walk.rejected, label).toEqual([]);
        await expectCheckClean(root, undefined, label);
      }
    },
  );
});

describe('scenario: holder killed after the claim file is renamed', () => {
  it(
    `the next command folds the claim with its grace lease; a takeover after the claimable time succeeds (${String(RUNS)} runs)`,
    { timeout: SCENARIO_TIMEOUT_MS },
    async () => {
      for (let run = 1; run <= RUNS; run += 1) {
        const label = `run ${String(run)}`;
        const { root, eventsDir } = await freshBoard();
        const claim = await killAfterRename(root, eventsDir, [
          'claim',
          T1,
          '--ttl',
          '30m',
          '--as',
          'holder',
        ]);
        const [written] = eventsOfKind(eventsDir, 'ticket.claim');
        const wall = written?.event.ts.wall ?? NaN;
        expect(written?.hash, label).toBe(claim);

        const folded = await show(root);
        expect(folded.assignee, label).toBe('holder');
        expect(folded.lease, label).toMatchObject({
          ttl: TTL,
          expiresAt: wall + GRACE,
          event: claim,
          confirmed: false,
        });
        await expectCheckClean(root, undefined, label);

        const taken = await cliOk(
          ['claim', T1, '--ttl', '30m', '--as', 'rescuer', '--json'],
          root,
          { offset: GRACE + SKEW + 60_000 },
        );
        const doc = oneDocument(taken) as { hash: string; ticket: { assignee: string } };
        expect(doc.ticket.assignee, label).toBe('rescuer');
        expectTakeover(eventsDir, doc.hash, 'rescuer', {
          holder: 'holder',
          expiresAt: wall + GRACE,
          event: claim,
        });

        const walk = expectExclusionIn(eventsDir);
        expect(
          walk.takeovers.map((t) => t.actor),
          label,
        ).toEqual(['rescuer']);
        expect(walk.rejected, label).toEqual([]);
        await expectCheckClean(root, undefined, label);
      }
    },
  );
});
