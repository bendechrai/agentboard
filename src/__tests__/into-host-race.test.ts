/**
 * Two clones moving different standalone boards into the host repository
 * at the same time (add-board-sharing task 5.2; board-concurrency "Moving
 * a board into the host repository loses no event"): real CLI processes
 * on two clones of one project with a bare `origin`, each with a
 * standalone board of its own history (its own bare board remote, its own
 * events), started together through the start gate of the harness,
 * repeated `RUNS` times on fresh repositories. Both exit 0 (the loser of
 * the push race retries once), and after each syncs the one ref holds
 * every event of both histories, with identical canonical dumps and
 * `rebuild --check` clean. The sequential scenarios are in
 * `into-host-clones.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { git } from '../board/__tests__/helpers.js';
import {
  cloneProject,
  eventFiles,
  expectMoved,
  project,
  refEvents,
  syncedStandalone,
} from '../board/__tests__/into-host-helpers.js';
import { BOARD_REF, refCommit } from '../board/__tests__/sharing-helpers.js';
import { bareRemote, syncEnv } from '../board/__tests__/sync-helpers.js';
import {
  RUNS,
  SCENARIO_TIMEOUT_MS,
  canonicalDump,
  expectCheckClean,
  expectOneRefValue,
  syncOk,
} from './harness/host-sync.js';
import { oneDocument, startGated, type ProcessResult } from './harness/processes.js';

/** Whether `ancestor` is an ancestor of (or equal to) `descendant` in `repo`. */
function isAncestor(repo: string, ancestor: string, descendant: string): boolean {
  try {
    git(repo, 'merge-base', '--is-ancestor', ancestor, descendant);
    return true;
  } catch {
    return false;
  }
}

describe('two clones running init --into-host at the same time against the same host remote', () => {
  it(
    `both exit 0 and, after each syncs, one ref holds both histories with identical dumps (${String(RUNS)} runs)`,
    { timeout: SCENARIO_TIMEOUT_MS },
    async () => {
      const env = syncEnv();
      for (let run = 1; run <= RUNS; run += 1) {
        const label = `run ${String(run)}`;
        const { root: aRoot, remote } = project(`a-${String(run)}`);
        const a = syncedStandalone(aRoot, env, 3, bareRemote(), 'alice');
        const bRoot = cloneProject(remote, `b-${String(run)}`);
        const b = syncedStandalone(bRoot, env, 2, bareRemote(), 'bob');
        const files = [...eventFiles(a.dir), ...eventFiles(b.dir)].sort();
        expect(new Set(files).size, label).toBe(files.length);

        const gatedA = await startGated([{ argv: ['init', '--into-host', '--json'], env }], aRoot);
        const gatedB = await startGated([{ argv: ['init', '--into-host', '--json'], env }], bRoot);
        gatedA.open();
        gatedB.open();
        const results: ProcessResult[] = await Promise.all(
          [...gatedA.procs, ...gatedB.procs].map((proc) => proc.exited),
        );

        for (const [index, result] of results.entries()) {
          const who = `${label} clone ${index === 0 ? 'A' : 'B'}: ${result.stderr}`;
          expect(result.signal, who).toBeNull();
          expect(result.code, who).toBe(0);
          expect(oneDocument(result), who).toMatchObject({ action: 'moved', model: 'host' });
        }
        expectMoved(aRoot, env, 1, label);
        expectMoved(bRoot, env, 1, label);

        // Converge: A, B, A again.
        syncOk(aRoot, env);
        syncOk(bRoot, env);
        syncOk(aRoot, env);
        const value = expectOneRefValue(aRoot, bRoot, remote, label);
        expect(eventFiles(a.dir), label).toEqual(files);
        expect(eventFiles(b.dir), label).toEqual(files);
        expect(refEvents(aRoot), label).toEqual(files);
        expect(refEvents(remote), label).toEqual(files);
        // The history pushed first is an ancestor of the result; the other was rebased onto it.
        expect(isAncestor(aRoot, a.tip, value) || isAncestor(aRoot, b.tip, value), label).toBe(
          true,
        );
        expect(git(aRoot, 'for-each-ref', '--format=%(refname)', 'refs/agentboard/'), label).toBe(
          `${BOARD_REF}\n`,
        );
        expect(refCommit(aRoot), label).toBe(value);
        expect(canonicalDump(a.dir), label).toBe(canonicalDump(b.dir));
        expectCheckClean(aRoot, env);
        expectCheckClean(bRoot, env);
      }
    },
  );
});
