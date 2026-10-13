/**
 * Shared fixtures of the host-model sync process tests (add-board-sharing
 * task 3.2; `host-sync-writers.test.ts`, `host-sync-crash.test.ts` and
 * `host-sync-clones.test.ts`): two clones of a host repository sharing a
 * published board through a bare `origin`, the exact command lines of
 * `syncHostBoard` that the shims on the PATH match, `sync` and
 * `rebuild --check` through the built CLI, canonical dumps, and the
 * assertion that the board ref is one value everywhere. The scenarios are
 * split over three files so vitest runs them in parallel workers: each
 * one repeats its scenario `RUNS` times.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect } from 'vitest';

import { git } from '../../board/__tests__/helpers.js';
import {
  BOARD_REF,
  hostBoard,
  joinHostBoard,
  refCommit,
} from '../../board/__tests__/sharing-helpers.js';
import { bareRemote, revParse, treeEvents, type Env } from '../../board/__tests__/sync-helpers.js';
import { oneJson, spawnCli, type Run } from '../../cli/__tests__/cli-helpers.js';
import { openBoard } from '../../store/board.js';
import { dumpCache } from '../../store/cache.js';
import { rebuild } from '../../store/rebuild.js';
import { P, T1, ev, putEvent } from '../../store/__tests__/helpers.js';

/** How often each scenario is repeated (tasks.md 3.2: at least 20 times without a flake). */
export const RUNS = 20;

/** Generous: each scenario spawns hundreds of processes over its runs. */
export const SCENARIO_TIMEOUT_MS = 420_000;

export const TASK = ['--task', 'openspec:add-board-sharing#3'];
export const EVENT_FILE = /^[0-9a-f]{64}\.json$/;

/** The exact command lines of the host-model sync (`syncHostBoard`), as a shim on the PATH sees them. */
export const COMMANDS = {
  updateRef: ['update-ref', BOARD_REF],
  rebaseLocal: ['rebase', '--no-verify', BOARD_REF],
  rebaseFetched: ['rebase', '--no-verify', 'FETCH_HEAD'],
  push: ['push', '--porcelain', '--no-verify', 'origin', `HEAD:${BOARD_REF}`],
} as const;

/** Event file names in `<dir>/events`, sorted. */
export function eventFiles(dir: string): string[] {
  return readdirSync(join(dir, 'events'))
    .filter((name) => EVENT_FILE.test(name))
    .sort();
}

/** The event file names in the tree of `refs/agentboard/board` of `repo`, sorted. */
export function refEvents(repo: string): string[] {
  return treeEvents(repo, BOARD_REF).sort();
}

/** `sync --json` in `cwd` through the built CLI (synchronously). */
export function sync(cwd: string, env: Env): Run {
  return spawnCli(['sync', '--json'], cwd, env);
}

/** `sync --json` in `cwd`, which must succeed; returns its document. */
export function syncOk(cwd: string, env: Env): Record<string, unknown> {
  const out = sync(cwd, env);
  expect(out.code, out.stderr).toBe(0);
  return oneJson(out) as Record<string, unknown>;
}

/** `rebuild --check --json` in `cwd` reports no divergence. */
export function expectCheckClean(cwd: string, env: Env): void {
  const out = spawnCli(['rebuild', '--check', '--json'], cwd, env);
  expect(out.code, out.stderr).toBe(0);
  expect(oneJson(out)).toMatchObject({ ok: true, differences: [] });
}

/** The canonical dump of a full rebuild of the board at `dir`. */
export function canonicalDump(dir: string): string {
  const board = openBoard(dir);
  try {
    rebuild(board);
    return dumpCache(board.db);
  } finally {
    board.db.close();
  }
}

/** Asserts the ref is one value everywhere: both clones, both worktree HEADs, and origin. */
export function expectOneRefValue(
  aRoot: string,
  bRoot: string,
  remote: string,
  label: string,
): string {
  const value = refCommit(aRoot);
  expect(value, label).toMatch(/^[0-9a-f]{40}$/);
  expect(refCommit(bRoot), label).toBe(value);
  expect(git(remote, 'rev-parse', BOARD_REF).trim(), label).toBe(value);
  expect(revParse(join(aRoot, '.board')), label).toBe(value);
  expect(revParse(join(bRoot, '.board')), label).toBe(value);
  return String(value);
}

/**
 * Clones A and B sharing a published host-model board through a bare
 * `origin`, with one ticket (`T1`) created in A and synced, so comments on
 * it are valid events. Returns both roots, both board directories and the
 * remote. Red until host-model sync exists: the first sync is one.
 */
export function twoClones(env: Env): {
  remote: string;
  aRoot: string;
  bRoot: string;
  aDir: string;
  bDir: string;
} {
  const remote = bareRemote();
  const { root: aRoot, dir: aDir } = hostBoard(env);
  git(aRoot, 'remote', 'add', 'origin', remote);
  git(aRoot, 'push', '-q', 'origin', 'main');
  putEvent(join(aDir, 'events'), ev(P.create(T1, 'Shared'), 'orch', 1_000));
  syncOk(aRoot, env);
  const { root: bRoot, dir: bDir } = joinHostBoard(remote, 'b');
  syncOk(bRoot, env);
  return { remote, aRoot, bRoot, aDir, bDir };
}

/** A comment on `T1` as an event file in `<dir>/events`, distinct per `actor` and `n`. */
export function addComment(dir: string, actor: string, n: number): string {
  return putEvent(
    join(dir, 'events'),
    ev(P.comment(T1, `${actor} ${String(n)}`), actor, 10_000 + n),
  );
}

/** A `spawnCli` run that was killed by the shim: no exit code 0, and nothing on stdout. */
export function expectKilled(out: Run): void {
  expect(out.code).not.toBe(0);
  expect(out.stdout).toBe('');
}

/** A `file://` URL for `path`, so `git clone --depth` and `--filter` are honoured (git ignores both for a plain local path). */
export function fileUrl(path: string): string {
  return pathToFileURL(path).href;
}

/** `init --json` in `cwd` joins the published board. */
export function initJoins(cwd: string, env: Env, label: string): void {
  const out = spawnCli(['init', '--json'], cwd, env);
  expect(out.code, `${label}: ${out.stderr}`).toBe(0);
  expect(oneJson(out), label).toMatchObject({ model: 'host', joined: true, remote: 'origin' });
}
