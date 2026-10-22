/**
 * Host-model sync under concurrency (add-board-sharing task 3.2;
 * board-concurrency "Sync converges"; design.md decision 4): real CLI
 * processes on two clones of a host repository and a bare `origin`, each
 * scenario repeated `RUNS` times and checked with `rebuild --check`
 * afterwards. Ten writers per clone add events while each clone syncs,
 * all started together through the start gate of the harness, ending with
 * identical canonical dumps and one ref value everywhere; and a sync races
 * a hand-run `git fetch origin +refs/agentboard/board:refs/agentboard/board`
 * run just before its compare-and-swap (a `git` shim on the PATH runs it),
 * which fails once and is repeated. The crash and clone scenarios are in
 * `host-sync-crash.test.ts` and `host-sync-clones.test.ts`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { git, tempDir } from '../board/__tests__/helpers.js';
import {
  BOARD_REF,
  commitHostEvent,
  pushBoardRef,
  refCommit,
  withGitShimBefore,
  withRecordingGitShim,
} from '../board/__tests__/sharing-helpers.js';
import { revParse, syncEnv } from '../board/__tests__/sync-helpers.js';
import { P, T1, ev } from '../store/__tests__/helpers.js';
import {
  COMMANDS,
  RUNS,
  SCENARIO_TIMEOUT_MS,
  TASK,
  addComment,
  canonicalDump,
  eventFiles,
  expectCheckClean,
  expectOneRefValue,
  refEvents,
  syncOk,
  twoClones,
} from './harness/host-sync.js';
import { oneDocument, runCliAsync, startGated, type ProcessResult } from './harness/processes.js';

describe('two clones, ten writers each, syncing concurrently', () => {
  it(
    `ends every run with identical canonical dumps and one ref value everywhere (${String(RUNS)} runs)`,
    { timeout: SCENARIO_TIMEOUT_MS },
    async () => {
      const env = syncEnv();
      const { remote, aRoot, bRoot, aDir, bDir } = twoClones(env);
      // The two racing syncs run through a recording shim, so the rounds
      // can be shown to have raced: a rejected push is retried, so more
      // pushes than syncs means at least one retry happened.
      const { env: racingEnv, calls } = withRecordingGitShim(env);
      for (let run = 1; run <= RUNS; run += 1) {
        const label = `run ${String(run)}`;
        const writers = (side: string) =>
          Array.from({ length: 10 }, (_, n) => ({
            argv: [
              'new',
              `${side} ${String(run)} ${String(n)}`,
              ...TASK,
              '--as',
              `${side}-${String(n)}`,
              '--json',
            ],
            env,
          }));
        const gatedA = await startGated(
          [...writers('a'), { argv: ['sync', '--json'], env: racingEnv }],
          aRoot,
        );
        const gatedB = await startGated(
          [...writers('b'), { argv: ['sync', '--json'], env: racingEnv }],
          bRoot,
        );
        gatedA.open();
        gatedB.open();
        const results: ProcessResult[] = await Promise.all(
          [...gatedA.procs, ...gatedB.procs].map((proc) => proc.exited),
        );

        for (const [index, result] of results.entries()) {
          expect(result.signal, `${label} process ${String(index)}`).toBeNull();
          expect(result.code, `${label} process ${String(index)}: ${result.stderr}`).toBe(0);
          expect(result.stderr, `${label} process ${String(index)}`).toBe('');
          expect(oneDocument(result)).not.toHaveProperty('error');
        }
        // The two syncs raced on origin; one of them may have retried once.
        // Converge: A, B, A again.
        syncOk(aRoot, env);
        syncOk(bRoot, env);
        syncOk(aRoot, env);

        expectOneRefValue(aRoot, bRoot, remote, label);
        const files = eventFiles(aDir);
        expect(files, label).toHaveLength(1 + 20 * run);
        expect(eventFiles(bDir), label).toEqual(files);
        expect(refEvents(aRoot), label).toEqual(files);
        expect(refEvents(remote), label).toEqual(files);
        expect(git(aRoot, 'status', '--porcelain'), label).toBe('');
        expect(git(bRoot, 'status', '--porcelain'), label).toBe('');
        expectCheckClean(aRoot, env);
        expectCheckClean(bRoot, env);
        expect(canonicalDump(bDir), label).toBe(canonicalDump(aDir));
      }
      const listed = await runCliAsync(['list', '--json'], bRoot, env);
      expect(listed.code, listed.stderr).toBe(0);
      expect(oneDocument(listed)).toHaveLength(1 + 20 * RUNS);
      // The racing syncs pushed more often than they ran: at least one
      // round had its push rejected and retried (the reviewers measured
      // 15 to 19 of 20 rounds), and no push was ever forced.
      const pushes = calls().filter((line) => / push --porcelain /.test(line));
      expect(pushes.length).toBeGreaterThan(2 * RUNS);
      expect(pushes.every((line) => !/--force|--mirror| -f /.test(line))).toBe(true);
    },
  );
});

describe('a sync racing a hand-run fetch into the ref (the compare-and-swap path)', () => {
  it(
    `the first update-ref fails, the step is repeated, nothing is lost (${String(RUNS)} runs)`,
    { timeout: SCENARIO_TIMEOUT_MS },
    () => {
      const env = syncEnv();
      const { remote, aRoot, bRoot, aDir, bDir } = twoClones(env);
      for (let run = 1; run <= RUNS; run += 1) {
        const label = `run ${String(run)}`;
        const fromB = commitHostEvent(
          bDir,
          ev(P.comment(T1, `b ${String(run)}`), 'bob', 20_000 + run),
          env,
        );
        pushBoardRef(bRoot);
        const bTip = String(refCommit(bRoot));
        const beforeSync = String(refCommit(aRoot));
        const fromA = addComment(aDir, 'alice', run);
        // Just before A's first compare-and-swap, a human fetches origin's
        // ref over A's; every update-ref command line is logged, so the
        // three-argument form and the repeated step are both pinned.
        const log = join(tempDir(), `cas-${String(run)}.log`);
        const racing = withGitShimBefore(
          env,
          COMMANDS.updateRef,
          `echo "$*" >> '${log}'; if [ ! -e '${log}.fired' ]; then : > '${log}.fired'; ` +
            `"$GIT" -C '${aRoot}' fetch -q --no-tags origin +${BOARD_REF}:${BOARD_REF}; fi`,
          3,
        );

        const doc = syncOk(aRoot, racing);

        const swaps = readFileSync(log, 'utf8').split('\n').filter(Boolean);
        expect(swaps, label).toHaveLength(2);
        expect(swaps[0], label).toMatch(
          new RegExp(` update-ref ${BOARD_REF} [0-9a-f]{40} ${beforeSync}$`),
        );
        expect(swaps[1], label).toMatch(
          new RegExp(` update-ref ${BOARD_REF} [0-9a-f]{40} ${bTip}$`),
        );
        expect(doc, label).toMatchObject({ committedEvents: 1, pushed: true, model: 'host' });
        expect(doc.arrived, label).toEqual([fromB]);
        expect(refCommit(aRoot), label).toBe(revParse(aDir));
        expect(doc.refCommit, label).toBe(refCommit(aRoot));
        expect(git(remote, 'rev-parse', BOARD_REF).trim(), label).toBe(refCommit(aRoot));
        expect(refEvents(remote), label).toContain(`${fromA}.json`);
        expect(refEvents(remote), label).toContain(`${fromB}.json`);
        expect(git(aRoot, 'status', '--porcelain'), label).toBe('');

        syncOk(bRoot, env);
        expectOneRefValue(aRoot, bRoot, remote, label);
        expect(eventFiles(bDir), label).toEqual(eventFiles(aDir));
        expectCheckClean(aRoot, env);
        expectCheckClean(bRoot, env);
      }
    },
  );
});
