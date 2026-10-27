/**
 * The scenario "Renew synced late still wins" of board-concurrency "Lease
 * and queue folds converge across replicas with skewed clocks"
 * (add-claim-leases task 5.2), grant variant: A writes the lapse grant
 * past the old lease's lapse on a clock 45 s fast while B's renew, written
 * before the expiry, has not been synced. The scenario and its
 * assertions are in `harness/late-renew.ts`; it is repeated `RUNS` times.
 */

import { describe, it } from 'vitest';

import { lateRenewRun } from './harness/late-renew.js';
import { RUNS, SCENARIO_TIMEOUT_MS } from './harness/leases.js';

describe('scenario: renew synced late still wins', () => {
  it(
    `A's grant is rejected stale-grant on both replicas (${String(RUNS)} runs)`,
    { timeout: SCENARIO_TIMEOUT_MS },
    async () => {
      for (let run = 1; run <= RUNS; run += 1) {
        await lateRenewRun('grant', `run ${String(run)}`);
      }
    },
  );
});
