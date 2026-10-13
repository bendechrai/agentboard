/**
 * Host-model sync killed at each crash point (add-board-sharing task 3.2;
 * board-events "Board ref in the host repository"; design.md decision 4):
 * a `git` shim on the PATH kills the CLI process after the commit, after
 * the rebase onto the local ref, after the rebase onto `FETCH_HEAD` (each
 * before its `update-ref`) and after the push (before the catch-up); the
 * next `sync` recovers with no commit lost, `RUNS` times each, with
 * `rebuild --check` clean afterwards. The command lines matched are the
 * ones `syncHostBoard` documents. The concurrency and clone scenarios are
 * in `host-sync-writers.test.ts` and `host-sync-clones.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { git } from '../board/__tests__/helpers.js';
import {
  BOARD_REF,
  commitHostEvent,
  pushBoardRef,
  refCommit,
  withKillingGitShim,
} from '../board/__tests__/sharing-helpers.js';
import { revParse, syncEnv } from '../board/__tests__/sync-helpers.js';
import { oneJson, spawnCli } from '../cli/__tests__/cli-helpers.js';
import { P, T1, ev } from '../store/__tests__/helpers.js';
import {
  COMMANDS,
  RUNS,
  SCENARIO_TIMEOUT_MS,
  addComment,
  eventFiles,
  expectCheckClean,
  expectKilled,
  expectOneRefValue,
  refEvents,
  sync,
  syncOk,
  twoClones,
} from './harness/host-sync.js';

describe('a sync killed before an update-ref is recovered by the next sync', () => {
  it(
    `killed after the commit, before the first update-ref (${String(RUNS)} runs)`,
    { timeout: SCENARIO_TIMEOUT_MS },
    () => {
      const env = syncEnv();
      const { remote, aRoot, bRoot, aDir } = twoClones(env);
      for (let run = 1; run <= RUNS; run += 1) {
        const label = `run ${String(run)}`;
        const before = refCommit(aRoot);
        const hash = addComment(aDir, 'alice', run);

        expectKilled(sync(aRoot, withKillingGitShim(env, COMMANDS.updateRef, 'before')));

        // The commit exists on HEAD; the ref did not move; nothing reached origin.
        expect(git(aDir, 'log', '-1', '--format=%s').trim(), label).toBe(
          'agentboard sync: 1 event file',
        );
        expect(refCommit(aRoot), label).toBe(before);
        expect(git(remote, 'rev-parse', BOARD_REF).trim(), label).toBe(before);

        const doc = syncOk(aRoot, env);
        expect(doc, label).toMatchObject({ commit: null, committedEvents: 0, pushed: true });
        expect(refCommit(aRoot), label).toBe(revParse(aDir));
        expect(git(remote, 'rev-parse', BOARD_REF).trim(), label).toBe(refCommit(aRoot));
        expect(refEvents(remote), label).toContain(`${hash}.json`);
        expectCheckClean(aRoot, env);
      }
      syncOk(bRoot, env);
      expectOneRefValue(aRoot, bRoot, remote, 'end');
      expectCheckClean(bRoot, env);
    },
  );

  it(
    `killed after the rebase onto FETCH_HEAD, before its update-ref (${String(RUNS)} runs)`,
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
        const onOrigin = git(remote, 'rev-parse', BOARD_REF).trim();
        const fromA = addComment(aDir, 'alice', run);

        expectKilled(sync(aRoot, withKillingGitShim(env, COMMANDS.rebaseFetched, 'after')));

        // HEAD was rebased onto what origin holds; the ref still holds A's own commit; origin did not move.
        expect(git(aDir, 'merge-base', '--is-ancestor', onOrigin, 'HEAD'), label).toBe('');
        expect(refCommit(aRoot), label).not.toBe(revParse(aDir));
        expect(git(remote, 'rev-parse', BOARD_REF).trim(), label).toBe(onOrigin);
        expect(eventFiles(aDir), label).toContain(`${fromB}.json`);

        const doc = syncOk(aRoot, env);
        expect(doc, label).toMatchObject({ pushed: true });
        expect(refCommit(aRoot), label).toBe(revParse(aDir));
        expect(git(remote, 'rev-parse', BOARD_REF).trim(), label).toBe(refCommit(aRoot));
        expect(refEvents(remote), label).toContain(`${fromA}.json`);
        expect(refEvents(remote), label).toContain(`${fromB}.json`);
        expect(refEvents(aRoot), label).toEqual(eventFiles(aDir));
        expectCheckClean(aRoot, env);

        syncOk(bRoot, env);
        expectOneRefValue(aRoot, bRoot, remote, label);
        expect(eventFiles(bDir), label).toEqual(eventFiles(aDir));
        expectCheckClean(bRoot, env);
      }
    },
  );

  it(
    `killed after the rebase onto a hand-fetched local ref, before its update-ref (${String(RUNS)} runs)`,
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
        git(aRoot, 'fetch', '-q', '--no-tags', 'origin', `+${BOARD_REF}:${BOARD_REF}`);
        const fetched = refCommit(aRoot);
        const fromA = addComment(aDir, 'alice', run);

        expectKilled(sync(aRoot, withKillingGitShim(env, COMMANDS.rebaseLocal, 'after')));

        // HEAD was rebased onto the ref, which was not moved to it.
        expect(refCommit(aRoot), label).toBe(fetched);
        expect(git(aDir, 'merge-base', '--is-ancestor', String(fetched), 'HEAD'), label).toBe('');
        expect(revParse(aDir), label).not.toBe(fetched);

        const doc = syncOk(aRoot, env);
        expect(doc, label).toMatchObject({ pushed: true });
        expect(refCommit(aRoot), label).toBe(revParse(aDir));
        expect(git(remote, 'rev-parse', BOARD_REF).trim(), label).toBe(refCommit(aRoot));
        expect(refEvents(remote), label).toContain(`${fromA}.json`);
        expect(refEvents(remote), label).toContain(`${fromB}.json`);
        expectCheckClean(aRoot, env);

        syncOk(bRoot, env);
        expectOneRefValue(aRoot, bRoot, remote, label);
        expectCheckClean(bRoot, env);
      }
    },
  );

  it(
    `killed after the push, before the catch-up (${String(RUNS)} runs)`,
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
        const fromA = addComment(aDir, 'alice', run);

        expectKilled(sync(aRoot, withKillingGitShim(env, COMMANDS.push, 'after')));

        // Everything but the catch-up happened: ref, HEAD and origin agree and hold both events.
        expect(refCommit(aRoot), label).toBe(revParse(aDir));
        expect(git(remote, 'rev-parse', BOARD_REF).trim(), label).toBe(refCommit(aRoot));
        expect(refEvents(remote), label).toContain(`${fromA}.json`);
        expect(refEvents(remote), label).toContain(`${fromB}.json`);

        const doc = syncOk(aRoot, env);
        expect(doc, label).toMatchObject({
          commit: null,
          committedEvents: 0,
          pulled: true,
          pushed: true,
        });
        expect(doc.arrived, label).toEqual([]);
        expect(refCommit(aRoot), label).toBe(revParse(aDir));
        expectCheckClean(aRoot, env);
        // The catch-up of the recovering sync folded B's comment.
        const shown = spawnCli(['show', T1, '--json'], aRoot, env);
        expect(shown.code, shown.stderr).toBe(0);
        const { ticket } = oneJson(shown) as { ticket: { comments: { text: string }[] } };
        expect(
          ticket.comments.map((c) => c.text),
          label,
        ).toContain(`b ${String(run)}`);

        syncOk(bRoot, env);
        expectOneRefValue(aRoot, bRoot, remote, label);
        expectCheckClean(bRoot, env);
      }
    },
  );
});
