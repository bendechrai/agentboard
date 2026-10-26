/**
 * `renew` racing `release --force` across processes (add-claim-leases
 * review round 2 ruling; board-cli: "Leases on the command line",
 * "Forced release on the command line"): the forced release always
 * applies, and when the holder's renew is folded after it, the holder
 * learns it lost the lock through exit 4 `not-assignee`, never a usage
 * error.
 *
 * Each round writes a fresh board as event files at walls taken from the
 * real clock: T1 is created, then `holder` claims it with a 30m ttl and
 * the default 2m grace, so the lease is live but unconfirmed and T1 has no
 * waiters. No renew is written in advance: the racing `renew` is the
 * holder's first. Every child runs on the real clock.
 *
 * Which of the two wins is up to the scheduler, so the rounds run until at
 * least one renew has lost (at least `ROUNDS`, at most `MAX_ROUNDS`; the
 * reviewers measured a loss in about a third of rounds), and the test
 * fails if none did, so it cannot pass without exercising the losing
 * path. After every round no event file is rejected by an independent
 * fold: the losing renew is refused before it writes.
 */

import { describe, expect, it } from 'vitest';

import { P, ev, foldDir, putEvent } from '../store/__tests__/helpers.js';
import {
  boardProject,
  oneDocument,
  runCliAsync,
  runTogether,
  type ProcessResult,
} from './harness/processes.js';

const T1 = '01ARYZ6S41TSV4RRFFQ69G5FAV';
const ROUNDS = 10;
const MAX_ROUNDS = 40;

/** The `--json` error reason of a failed child, or null. */
function reason(result: ProcessResult): string | null {
  const doc = oneDocument(result) as { error?: { reason?: string } };
  return doc.error?.reason ?? null;
}

describe('renew racing release --force', () => {
  it(
    'the forced release always applies and a renew that loses exits 4 not-assignee',
    { timeout: 480_000 },
    async () => {
      const outcomes: Record<string, number> = {};
      let losses = 0;
      let rounds = 0;
      while (rounds < MAX_ROUNDS && (rounds < ROUNDS || losses === 0)) {
        rounds += 1;
        const { root, eventsDir } = boardProject();
        const base = Date.now();
        putEvent(eventsDir, ev(P.create(T1, 'Merge lock'), 'orch', base - 2000));
        putEvent(
          eventsDir,
          ev(
            {
              kind: 'ticket.claim',
              ticket: T1,
              body: { lease: { ttl: 1_800_000, grace: 120_000, expiresAt: base - 1000 + 120_000 } },
            },
            'holder',
            base - 1000,
          ),
        );
        const built = await runCliAsync(['list'], root);
        expect(built.code, built.stderr).toBe(0);
        const { results } = await runTogether(
          [
            { argv: ['renew', T1, '--as', 'holder', '--json'] },
            {
              argv: ['release', T1, '--force', '--reason', 'holder gone', '--as', 'orch', '--json'],
            },
          ],
          root,
        );
        const [renew, force] = results;
        expect(force?.code, force?.stdout).toBe(0);
        expect(renew).toBeDefined();
        if (renew !== undefined && renew.code !== 0) {
          losses += 1;
          expect({ code: renew.code, reason: reason(renew) }, renew.stdout).toEqual({
            code: 4,
            reason: 'not-assignee',
          });
        }
        const key = String(renew?.code);
        outcomes[key] = (outcomes[key] ?? 0) + 1;
        const shown = await runCliAsync(['show', T1, '--json'], root);
        expect(
          (oneDocument(shown) as { ticket: { assignee: unknown } }).ticket.assignee,
        ).toBeNull();
        expect(foldDir(eventsDir).rejected, `round ${String(rounds)}`).toEqual([]);
      }
      expect(Object.values(outcomes).reduce((a, b) => a + b, 0)).toBe(rounds);
      expect(losses, JSON.stringify(outcomes)).toBeGreaterThan(0);
    },
  );
});
