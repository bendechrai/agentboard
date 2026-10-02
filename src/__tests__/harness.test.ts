/**
 * The multi-process harness itself. It must run 20 CLI processes
 * at once, on macOS and Linux, well within the test timeout, and its
 * waiting and killing helpers must behave as documented.
 */

import { describe, expect, it } from 'vitest';

import {
  CHILD_TIMEOUT_MS,
  boardProject,
  cliEnv,
  oneDocument,
  runCliAsync,
  runTogether,
  startCli,
  waitForPause,
} from './harness/processes.js';

describe('the multi-process harness', () => {
  it('runs 20 CLI processes at once behind the start gate', { timeout: 30_000 }, async () => {
    const { root } = boardProject();
    // The cache exists before the race; racing first opens are a property
    // of the store, tested in concurrency.test.ts.
    expect((await runCliAsync(['list'], root)).code).toBe(0);
    const { results, readyAtGate, elapsedMs } = await runTogether(
      Array.from({ length: 20 }, () => ({ argv: ['list', '--json'] })),
      root,
    );
    // All 20 were alive and blocked at the gate at the same time.
    expect(readyAtGate).toBe(20);
    expect(results).toHaveLength(20);
    for (const result of results) {
      expect(result).toMatchObject({ code: 0, signal: null, stderr: '' });
      expect(oneDocument(result)).toEqual([]);
    }
    // Generous bound: the point is that 20 processes finish, not a benchmark.
    expect(elapsedMs).toBeLessThan(20_000);
  });

  it('keeps children bounded by a per-child timeout shorter than the test timeouts', () => {
    expect(CHILD_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  it('runs one invocation and captures stdout, stderr and the exit code', async () => {
    const { root } = boardProject();
    const ok = await runCliAsync(['version', '--json'], root);
    expect(ok.code).toBe(0);
    expect(oneDocument(ok)).toMatchObject({ version: expect.any(String) as unknown });
    const refused = await runCliAsync(['show', '01ARYZ6S41TSV4RRFFQ69G5FAV'], root);
    expect(refused.code).toBe(4);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toMatch(/^agentboard: /);
  });

  it('rejects a stderr wait when the child exits without a match', async () => {
    const { root } = boardProject();
    const proc = startCli({ argv: ['version'] }, root);
    await expect(proc.waitForStderr(/never printed/)).rejects.toThrow(/exited before/);
    expect((await proc.exited).code).toBe(0);
  });

  it(
    'waits for a pause line, then kills the paused child with SIGKILL',
    { timeout: 20_000 },
    async () => {
      const { root } = boardProject();
      const created = await runCliAsync(
        ['new', 'Paused', '--adhoc', 'harness', '--as', 'orch', '--json'],
        root,
      );
      expect(created.code).toBe(0);
      const { ticket } = oneDocument(created) as { ticket: { id: string } };
      const proc = startCli(
        {
          argv: ['comment', ticket.id, 'held', '--as', 'a'],
          env: cliEnv({ AGENTBOARD_TEST_PAUSE: 'after-rename' }),
        },
        root,
      );
      const path = await waitForPause(proc, 'after-rename');
      expect(path).toMatch(/[0-9a-f]{64}\.json$/);
      const result = await proc.kill();
      expect(result.signal).toBe('SIGKILL');
      expect(result.code).toBeNull();
    },
  );
});
