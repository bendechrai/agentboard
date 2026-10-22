/**
 * Host-model sync from unusual clones and under routine git maintenance
 * (add-board-sharing task 3.2; design.md decision 4 and its risks): a
 * shallow clone and a partial clone of the host join the board with
 * `init` and sync; `git fetch --prune` and `git remote prune` leave the
 * ref alone; `git push --mirror` from a stale clone rewinds the remote
 * ref and the other clone's next sync restores its events. Each scenario
 * runs `RUNS` times with `rebuild --check` clean afterwards. Clones made
 * with `--depth` and `--filter` use a `file://` URL, because git ignores
 * both for a plain local path. The concurrency and crash scenarios are in
 * `host-sync-writers.test.ts` and `host-sync-crash.test.ts`.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { git, tempDir } from '../board/__tests__/helpers.js';
import { BOARD_REF, refCommit } from '../board/__tests__/sharing-helpers.js';
import { revParse, syncEnv } from '../board/__tests__/sync-helpers.js';
import { spawnCli } from '../cli/__tests__/cli-helpers.js';
import {
  RUNS,
  SCENARIO_TIMEOUT_MS,
  TASK,
  addComment,
  eventFiles,
  expectCheckClean,
  expectOneRefValue,
  fileUrl,
  initJoins,
  refEvents,
  syncOk,
  twoClones,
} from './harness/host-sync.js';

describe('shallow and partial clones of the host join the board and sync', () => {
  it(
    `a shallow clone (--depth 1) joins, adds an event and syncs (${String(RUNS)} runs)`,
    { timeout: SCENARIO_TIMEOUT_MS },
    () => {
      const env = syncEnv();
      const { remote, aRoot, aDir } = twoClones(env);
      for (let run = 1; run <= RUNS; run += 1) {
        const label = `run ${String(run)}`;
        const root = join(tempDir(), `shallow-${String(run)}`);
        git(tempDir(), 'clone', '-q', '--depth', '1', fileUrl(remote), root);
        expect(existsSync(join(root, '.git', 'shallow')), label).toBe(true);

        initJoins(root, env, label);

        // The board ref arrived with its whole history; the host branch stays shallow.
        expect(git(root, 'rev-list', '--count', BOARD_REF).trim(), label).toBe(
          git(aRoot, 'rev-list', '--count', BOARD_REF).trim(),
        );
        expect(git(root, 'rev-list', '--count', 'HEAD').trim(), label).toBe('1');
        const added = spawnCli(
          ['new', `shallow ${String(run)}`, ...TASK, '--as', 'shallow', '--json'],
          root,
          env,
        );
        expect(added.code, added.stderr).toBe(0);
        const doc = syncOk(root, env);
        expect(doc, label).toMatchObject({ committedEvents: 1, pushed: true, model: 'host' });
        expect(refCommit(root), label).toBe(git(remote, 'rev-parse', BOARD_REF).trim());
        expectCheckClean(root, env);

        const back = syncOk(aRoot, env);
        expect(back.arrived, label).toHaveLength(1);
        expect(eventFiles(aDir), label).toEqual(eventFiles(join(root, '.board')));
        expectCheckClean(aRoot, env);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it(
    `a partial clone (--filter=blob:none) joins, reads every event, adds one and syncs (${String(RUNS)} runs)`,
    { timeout: SCENARIO_TIMEOUT_MS },
    () => {
      const env = syncEnv();
      const { remote, aRoot, aDir } = twoClones(env);
      git(remote, 'config', 'uploadpack.allowFilter', 'true');
      for (let run = 1; run <= RUNS; run += 1) {
        const label = `run ${String(run)}`;
        const root = join(tempDir(), `partial-${String(run)}`);
        git(tempDir(), 'clone', '-q', '--filter=blob:none', fileUrl(remote), root);
        expect(git(root, 'config', '--get', 'remote.origin.promisor').trim(), label).toBe('true');

        initJoins(root, env, label);

        // Every event blob was fetched on checkout and reads back byte for byte.
        const dir = join(root, '.board');
        expect(eventFiles(dir), label).toEqual(eventFiles(aDir));
        for (const name of eventFiles(dir)) {
          expect(readFileSync(join(dir, 'events', name)), `${label} ${name}`).toEqual(
            readFileSync(join(aDir, 'events', name)),
          );
        }
        const added = spawnCli(
          ['new', `partial ${String(run)}`, ...TASK, '--as', 'partial', '--json'],
          root,
          env,
        );
        expect(added.code, added.stderr).toBe(0);
        const doc = syncOk(root, env);
        expect(doc, label).toMatchObject({ committedEvents: 1, pushed: true, model: 'host' });
        expect(refCommit(root), label).toBe(git(remote, 'rev-parse', BOARD_REF).trim());
        expectCheckClean(root, env);

        const back = syncOk(aRoot, env);
        expect(back.arrived, label).toHaveLength(1);
        expectCheckClean(aRoot, env);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe('routine git maintenance leaves the board alone', () => {
  it(
    `git fetch --prune and git remote prune leave refs/agentboard/board (${String(RUNS)} runs)`,
    { timeout: SCENARIO_TIMEOUT_MS },
    () => {
      const env = syncEnv();
      const { remote, aRoot, bRoot, bDir } = twoClones(env);
      git(bRoot, 'config', 'fetch.prune', 'true');
      for (let run = 1; run <= RUNS; run += 1) {
        const label = `run ${String(run)}`;
        addComment(bDir, 'bob', run);
        syncOk(bRoot, env);
        const value = refCommit(bRoot);

        git(bRoot, 'fetch', '-q', '--prune', 'origin');
        git(bRoot, 'remote', 'prune', 'origin');
        git(bRoot, 'fetch', '-q', 'origin');

        expect(refCommit(bRoot), label).toBe(value);
        expect(revParse(bDir), label).toBe(value);
        expect(git(bRoot, 'for-each-ref', '--format=%(refname)', 'refs/agentboard/'), label).toBe(
          `${BOARD_REF}\n`,
        );
        expect(
          git(bRoot, 'for-each-ref', '--format=%(refname)', 'refs/remotes/')
            .split('\n')
            .filter(Boolean),
          label,
        ).toEqual(['refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
        const doc = syncOk(bRoot, env);
        expect(doc, label).toMatchObject({ commit: null, pushed: true, refCommit: value });
        expectCheckClean(bRoot, env);
      }
      syncOk(aRoot, env);
      expectOneRefValue(aRoot, bRoot, remote, 'end');
      expectCheckClean(aRoot, env);
    },
  );

  it(
    `git push --mirror from a stale clone rewinds origin; the other clone's next sync restores its events (${String(RUNS)} runs)`,
    { timeout: SCENARIO_TIMEOUT_MS },
    () => {
      const env = syncEnv();
      const { remote, aRoot, bRoot, aDir, bDir } = twoClones(env);
      for (let run = 1; run <= RUNS; run += 1) {
        const label = `run ${String(run)}`;
        const fromB = addComment(bDir, 'bob', run);
        syncOk(bRoot, env);
        const bValue = refCommit(bRoot);
        const stale = refCommit(aRoot);
        expect(stale, label).not.toBe(bValue);

        git(aRoot, 'push', '-q', '--mirror', 'origin');

        expect(git(remote, 'rev-parse', BOARD_REF).trim(), label).toBe(stale);
        expect(refEvents(remote), label).not.toContain(`${fromB}.json`);

        const restored = syncOk(bRoot, env);
        expect(restored, label).toMatchObject({ commit: null, pushed: true, refCommit: bValue });
        expect(git(remote, 'rev-parse', BOARD_REF).trim(), label).toBe(bValue);
        expect(refEvents(remote), label).toContain(`${fromB}.json`);
        expect(revParse(bDir), label).toBe(bValue);

        const caught = syncOk(aRoot, env);
        expect(caught.arrived, label).toEqual([fromB]);
        expectOneRefValue(aRoot, bRoot, remote, label);
        expect(eventFiles(aDir), label).toEqual(eventFiles(bDir));
        expectCheckClean(aRoot, env);
        expectCheckClean(bRoot, env);
      }
    },
  );
});
