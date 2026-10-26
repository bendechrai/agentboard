/**
 * `renew` racing `release --force` across processes (add-claim-leases
 * review round 2 ruling; board-cli: "Leases on the command line",
 * "Forced release on the command line"): the forced release always
 * applies, and when the holder's renew is folded after it, the holder
 * learns it lost the lock through exit 4 `not-assignee`, never a usage
 * error.
 *
 * The board is written as event files at walls taken from the real clock
 * (`holder` claims T1 with a 30m lease, renewed, so it is live and has no
 * waiters); every child runs on the real clock.
 */

import { describe, expect, it } from 'vitest';

import { P, ev, putEvent } from '../store/__tests__/helpers.js';
import {
  boardProject,
  oneDocument,
  runCliAsync,
  runTogether,
  type ProcessResult,
} from './harness/processes.js';

const T1 = '01ARYZ6S41TSV4RRFFQ69G5FAV';
const ROUNDS = 10;

/** The `--json` error reason of a failed child, or null. */
function reason(result: ProcessResult): string | null {
  const doc = oneDocument(result) as { error?: { reason?: string } };
  return doc.error?.reason ?? null;
}

describe('renew racing release --force', () => {
  it(
    'the forced release always applies and a renew that loses exits 4 not-assignee',
    { timeout: 120_000 },
    async () => {
      const outcomes: Record<string, number> = {};
      for (let round = 0; round < ROUNDS; round += 1) {
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
      }
      expect(Object.values(outcomes).reduce((a, b) => a + b, 0)).toBe(ROUNDS);
    },
  );
});
