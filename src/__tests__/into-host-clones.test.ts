/**
 * Several clones moving a shared standalone board into the host
 * repository one after the other (add-board-sharing task 5.2;
 * board-concurrency "Second clone migrates after the first"): real CLI
 * processes on clones of one project with a bare `origin`, each sharing a
 * standalone board through a bare board remote, repeated `RUNS` times on
 * fresh repositories and checked with `rebuild --check` afterwards. Clone
 * A moves and syncs, B syncs two new events to the old remote and then
 * moves, and C, which has not moved, is still reported as `standalone` by
 * `remote` and still syncs with the old remote. The two clones moving at
 * the same time are in `into-host-race.test.ts`.
 */

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { git } from '../board/__tests__/helpers.js';
import {
  cloneWithStandalone,
  eventFiles,
  expectMoved,
  refEvents,
  standaloneProject,
  writeEvents,
} from '../board/__tests__/into-host-helpers.js';
import { BOARD_REF, refCommit } from '../board/__tests__/sharing-helpers.js';
import { syncEnv, type Env } from '../board/__tests__/sync-helpers.js';
import { oneJson, spawnCli } from '../cli/__tests__/cli-helpers.js';
import { P, T1, ev, putEvent } from '../store/__tests__/helpers.js';
import {
  RUNS,
  SCENARIO_TIMEOUT_MS,
  canonicalDump,
  expectCheckClean,
  expectOneRefValue,
  syncOk,
} from './harness/host-sync.js';

/** `init --into-host --json` in `cwd`, which must exit 0; returns its document. */
function intoHostOk(cwd: string, env: Env, label: string): Record<string, unknown> {
  const out = spawnCli(['init', '--into-host', '--json'], cwd, env);
  expect(out.code, `${label}: ${out.stderr}`).toBe(0);
  return oneJson(out) as Record<string, unknown>;
}

describe('scenario: Second clone migrates after the first, with a third clone that has not moved', () => {
  it(
    `B's ref holds A's history and B's new commits, every event is in both after each syncs, and C is still standalone (${String(RUNS)} runs)`,
    { timeout: SCENARIO_TIMEOUT_MS },
    () => {
      const env = syncEnv();
      for (let run = 1; run <= RUNS; run += 1) {
        const label = `run ${String(run)}`;
        const a = standaloneProject(env, 3, `a-${String(run)}`);
        const b = cloneWithStandalone(a.remote, a.boardRemote, `b-${String(run)}`);
        const c = cloneWithStandalone(a.remote, a.boardRemote, `c-${String(run)}`);
        const original = eventFiles(a.dir);

        // A moves (the move syncs), then adds an event in the host model and syncs.
        expect(intoHostOk(a.root, env, label)).toMatchObject({ action: 'moved', joined: false });
        const fromA = putEvent(
          join(a.dir, 'events'),
          ev(P.comment(T1, `a after ${String(run)}`), 'a', 20_000 + run),
        );
        expect(syncOk(a.root, env), label).toMatchObject({ model: 'host', pushed: true });
        const aRef = String(refCommit(a.root));

        // B syncs two new events to the old standalone remote, then moves.
        const fromB = writeEvents(b.dir, 2, 'b', 100 + run * 10);
        expect(syncOk(b.root, env), label).toMatchObject({ model: 'standalone', pushed: true });
        const bDoc = intoHostOk(b.root, env, label);
        expect(bDoc, label).toMatchObject({ action: 'moved', joined: true, remote: 'origin' });
        expect(git(b.root, 'merge-base', '--is-ancestor', aRef, BOARD_REF), label).toBe('');
        for (const hash of fromB) {
          expect(refEvents(b.root), label).toContain(`${hash}.json`);
        }
        expect(eventFiles(b.dir), label).toContain(`${fromA}.json`);
        expectMoved(b.root, env, 1, label);

        // Converge: A, B, A again.
        syncOk(a.root, env);
        syncOk(b.root, env);
        syncOk(a.root, env);
        expectOneRefValue(a.root, b.root, a.remote, label);
        const files = [...original, `${fromA}.json`, ...fromB.map((h) => `${h}.json`)].sort();
        expect(eventFiles(a.dir), label).toEqual(files);
        expect(eventFiles(b.dir), label).toEqual(files);
        expect(refEvents(a.remote), label).toEqual(files);
        expect(canonicalDump(a.dir), label).toBe(canonicalDump(b.dir));
        expectCheckClean(a.root, env);
        expectCheckClean(b.root, env);
        expect(git(a.root, 'status', '--porcelain'), label).toBe('');
        expect(git(b.root, 'status', '--porcelain'), label).toBe('');

        // C has not moved: remote reports standalone, and it still syncs with the old remote.
        const report = spawnCli(['remote', '--json'], c.root, env);
        expect(report.code, `${label}: ${report.stderr}`).toBe(0);
        expect(oneJson(report), label).toMatchObject({
          model: 'standalone',
          branch: 'main',
          ref: null,
          remote: { name: 'origin', url: a.boardRemote },
          problems: [],
        });
        expect(refCommit(c.root), label).toBeNull();
        const cSync = syncOk(c.root, env);
        expect(cSync, label).toMatchObject({ model: 'standalone', pulled: true });
        expect(cSync.arrived, label).toEqual([...fromB].sort());
        expect(eventFiles(c.dir), label).toEqual([...original, ...fromB.map((h) => `${h}.json`)].sort());
        expectCheckClean(c.root, env);
      }
    },
  );
});
