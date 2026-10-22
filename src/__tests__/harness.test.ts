/**
 * The multi-process harness itself. It must run 20 CLI processes
 * at once, on macOS and Linux, well within the test timeout, and its
 * waiting and killing helpers must behave as documented.
 */

import { readdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CHILD_TIMEOUT_MS,
  boardProject,
  cliEnv,
  oneDocument,
  readLogLines,
  runCliAsync,
  runTogether,
  scratchDir,
  startCli,
  waitForPause,
  type ProcessResult,
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

  it('runs a child with its clock offset by the clock preload, gated or not', async () => {
    const { root } = boardProject();
    const offset = 3_600_000;
    const wallOf = (result: ProcessResult | undefined): number => {
      if (result === undefined) {
        throw new Error('no result');
      }
      return (oneDocument(result) as { ticket: { createdAt: { wall: number } } }).ticket.createdAt
        .wall;
    };
    const before = Date.now();
    const direct = await startCli(
      {
        argv: ['new', 'Ahead', '--adhoc', 'clock', '--as', 'orch', '--json'],
        clockOffsetMs: offset,
      },
      root,
    ).exited;
    expect(direct.code, direct.stderr).toBe(0);
    expect(wallOf(direct)).toBeGreaterThanOrEqual(before + offset);
    expect(wallOf(direct)).toBeLessThanOrEqual(Date.now() + offset);
    const behind = await startCli(
      {
        argv: ['new', 'Behind', '--adhoc', 'clock', '--as', 'orch', '--json'],
        clockOffsetMs: -offset,
      },
      root,
    ).exited;
    expect(behind.code, behind.stderr).toBe(0);
    // The hybrid clock never goes backwards on one board.
    expect(wallOf(behind)).toBeGreaterThanOrEqual(wallOf(direct));
    const gated = await runTogether(
      [
        {
          argv: ['new', 'Gated', '--adhoc', 'clock', '--as', 'orch', '--json'],
          clockOffsetMs: 2 * offset,
        },
      ],
      root,
    );
    const [result] = gated.results;
    expect(result?.code, result?.stderr).toBe(0);
    expect(wallOf(result)).toBeGreaterThanOrEqual(before + 2 * offset);
  }, 30_000);

  it('logs the event files a child opens through the read-log preload', async () => {
    const { root, eventsDir } = boardProject();
    const created = await runCliAsync(
      ['new', 'Logged', '--adhoc', 'reads', '--as', 'orch', '--json'],
      root,
    );
    expect(created.code, created.stderr).toBe(0);
    rmSync(join(eventsDir, '..', 'cache.sqlite'));
    const log = join(scratchDir(), 'reads.log');
    const cold = await startCli({ argv: ['list'], readLog: log }, root).exited;
    expect(cold.code, cold.stderr).toBe(0);
    // A cold cache is rebuilt from the one event file, so it was opened.
    const [name] = readdirSync(eventsDir).filter((n) => n.endsWith('.json'));
    expect(readLogLines(log).map((line) => basename(line))).toContain(name);
    const quiet = join(scratchDir(), 'quiet.log');
    expect((await startCli({ argv: ['version'], readLog: quiet }, root).exited).code).toBe(0);
    expect(readLogLines(quiet)).toEqual([]);
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
