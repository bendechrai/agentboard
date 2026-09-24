/**
 * `syncBoard` (board-concurrency: "Sync converges", scenarios "Divergent
 * clones converge" and "Sync with no remote"; board-cache: "Cache is not
 * synced"; design.md: "Git sync model"). Every remote is a temporary bare
 * repository on local disk.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Board } from '../../store/board.js';
import { catchUp, dumpCache } from '../../store/cache.js';
import { rebuild } from '../../store/rebuild.js';
import { P, T1, T2, T3, ev } from '../../store/__tests__/helpers.js';
import { initBoard } from '../init.js';
import { SYNC_IDENTITY, syncBoard, syncCommitMessage, type SyncResult } from '../sync.js';
import { listTickets } from '../tickets.js';
import {
  create,
  expectBoardError,
  git,
  gitRepo,
  makeBoardDir,
  openTracked,
  putEvent,
  tempDir,
} from './helpers.js';
import {
  bareRemote,
  cloneMachine,
  commitCount,
  initMachine,
  rebaseInProgress,
  revParse,
  syncEnv,
  treeEvents,
  treePaths,
  unmerged,
  type Env,
} from './sync-helpers.js';

const HEX40 = /^[0-9a-f]{40}$/;

/** Event file names (`<hash>.json`) currently in a board's events directory. */
function eventFiles(board: Board): string[] {
  return readdirSync(board.eventsDir)
    .filter((name) => /^[0-9a-f]{64}\.json$/.test(name))
    .sort();
}

/** Creates `n` tickets on `board` as `actor` and returns their event hashes. */
function addTickets(board: Board, n: number, actor: string): string[] {
  const hashes: string[] = [];
  for (let i = 0; i < n; i++) {
    const before = new Set(eventFiles(board));
    create(board, { title: `${actor} ticket ${String(i)}` }, actor);
    const added = eventFiles(board).filter((name) => !before.has(name));
    hashes.push(...added.map((name) => name.slice(0, -'.json'.length)));
  }
  return hashes.sort();
}

/** Machine A with a board pushed to a fresh bare remote, and machine B cloned from it. */
function twoMachines(env: Env): {
  remote: string;
  a: Board;
  b: Board;
  aDir: string;
  bDir: string;
} {
  const remote = bareRemote();
  const { dir: aDir } = initMachine(env, remote);
  const a = openTracked(aDir);
  syncBoard(a, { env });
  const { dir: bDir } = cloneMachine(remote);
  const b = openTracked(bDir);
  return { remote, a, b, aDir, bDir };
}

describe('syncCommitMessage', () => {
  it('counts event files with the right plural', () => {
    expect(syncCommitMessage(0)).toBe('agentboard sync: 0 event files');
    expect(syncCommitMessage(1)).toBe('agentboard sync: 1 event file');
    expect(syncCommitMessage(3)).toBe('agentboard sync: 3 event files');
  });
});

describe('sync with no remote', () => {
  it('scenario: commits local events, reports no remote configured, and succeeds', () => {
    const env = syncEnv();
    const { dir } = initMachine(env);
    const board = openTracked(dir);
    const hashes = addTickets(board, 2, 'orch');

    const result = syncBoard(board, { env });

    expect(result).toMatchObject({
      dir: board.dir,
      committedEvents: 2,
      remote: null,
      branch: 'main',
      pulled: false,
      pushed: false,
      upstreamSet: false,
      arrived: [],
      hostTracked: [],
      warnings: [],
    });
    expect(result.commit).toMatch(HEX40);
    expect(result.commit).toBe(revParse(dir));
    expect(result.message).toContain('no remote configured');
    expect(treePaths(dir)).toEqual(
      ['.gitignore', 'events/.gitkeep', ...hashes.map((h) => `events/${h}.json`)].sort(),
    );
    expect(commitCount(dir)).toBe(1);
  });

  it('commits as the fixed agentboard identity on a machine with no git identity', () => {
    const env = syncEnv();
    const { dir } = initMachine(env);
    const board = openTracked(dir);
    addTickets(board, 1, 'orch');

    syncBoard(board, { env });

    const log = git(dir, 'log', '-1', '--format=%an <%ae>|%cn <%ce>|%s').trim();
    const who = `${SYNC_IDENTITY.name} <${SYNC_IDENTITY.email}>`;
    expect(log).toBe(`${who}|${who}|${syncCommitMessage(1)}`);
  });

  it('makes no commit when nothing is new, and commits only what is new', () => {
    const env = syncEnv();
    const { dir } = initMachine(env);
    const board = openTracked(dir);
    addTickets(board, 1, 'orch');
    const first = syncBoard(board, { env });

    const again = syncBoard(board, { env });
    expect(again.commit).toBeNull();
    expect(again.committedEvents).toBe(0);
    expect(revParse(dir)).toBe(first.commit);
    expect(commitCount(dir)).toBe(1);

    addTickets(board, 3, 'orch');
    const third = syncBoard(board, { env });
    expect(third.committedEvents).toBe(3);
    expect(git(dir, 'log', '-1', '--format=%s').trim()).toBe(syncCommitMessage(3));
    expect(commitCount(dir)).toBe(2);
  });

  it('never stages the deletion of an event file', () => {
    const env = syncEnv();
    const { dir } = initMachine(env);
    const board = openTracked(dir);
    const [hash] = addTickets(board, 1, 'orch');
    syncBoard(board, { env });
    rmSync(join(board.eventsDir, `${String(hash)}.json`));

    const result = syncBoard(board, { env });

    expect(result.commit).toBeNull();
    expect(treeEvents(dir)).toEqual([`${String(hash)}.json`]);
  });

  it('syncs the board repository even when GIT_DIR points at the host repository', () => {
    const base = syncEnv();
    const host = gitRepo(join(tempDir(), 'host'));
    initBoard({ cwd: host, env: base });
    const dir = join(host, '.board');
    const board = openTracked(dir);
    addTickets(board, 1, 'orch');
    const hostHead = revParse(host);
    const env = { ...base, GIT_DIR: join(host, '.git'), GIT_WORK_TREE: host };

    const result = syncBoard(board, { env });

    expect(result.commit).toBe(revParse(dir));
    expect(treeEvents(dir)).toHaveLength(1);
    expect(revParse(host)).toBe(hostHead);
    expect(git(host, 'diff', '--cached', '--name-only')).toBe('');
  });
});

describe('sync with a remote', () => {
  it('pushes to an empty remote and sets the upstream on the first sync', () => {
    const env = syncEnv();
    const remote = bareRemote();
    const { dir } = initMachine(env, remote);
    const board = openTracked(dir);
    addTickets(board, 2, 'orch');

    const first = syncBoard(board, { env });

    expect(first).toMatchObject({
      remote: 'origin',
      branch: 'main',
      pushed: true,
      upstreamSet: true,
      committedEvents: 2,
      arrived: [],
    });
    expect(revParse(remote, 'main')).toBe(revParse(dir));
    expect(git(dir, 'rev-parse', '--abbrev-ref', '@{u}').trim()).toBe('origin/main');

    const second = syncBoard(board, { env });
    expect(second).toMatchObject({
      remote: 'origin',
      pulled: true,
      pushed: true,
      upstreamSet: false,
      commit: null,
      arrived: [],
    });
  });

  it('uses the only remote when it is not called origin', () => {
    const env = syncEnv();
    const remote = bareRemote();
    const { dir } = initMachine(env);
    git(dir, 'remote', 'add', 'hub', remote);
    const board = openTracked(dir);
    addTickets(board, 1, 'orch');

    const result = syncBoard(board, { env });

    expect(result).toMatchObject({ remote: 'hub', pushed: true, upstreamSet: true });
    expect(revParse(remote, 'main')).toBe(revParse(dir));
  });

  it('refuses to guess between several remotes when none is origin, after committing', () => {
    const env = syncEnv();
    const { dir } = initMachine(env);
    git(dir, 'remote', 'add', 'one', bareRemote());
    git(dir, 'remote', 'add', 'two', bareRemote());
    const board = openTracked(dir);
    addTickets(board, 1, 'orch');

    const err = expectBoardError(() => syncBoard(board, { env }), 1, 'ambiguous-remote');

    expect(err.message).toContain('one');
    expect(err.message).toContain('two');
    expect(commitCount(dir)).toBe(1);
  });

  it('exits 3 when the remote cannot be reached, keeping the local commit', () => {
    const env = syncEnv();
    const { dir } = initMachine(env, join(tempDir(), 'missing.git'));
    const board = openTracked(dir);
    addTickets(board, 1, 'orch');

    expectBoardError(() => syncBoard(board, { env }), 3, 'sync-failed');

    expect(commitCount(dir)).toBe(1);
    expect(treeEvents(dir)).toHaveLength(1);
  });

  it('refuses a detached HEAD with exit 3', () => {
    const env = syncEnv();
    const remote = bareRemote();
    const { dir } = initMachine(env, remote);
    const board = openTracked(dir);
    syncBoard(board, { env });
    git(dir, 'checkout', '-q', '--detach');

    expectBoardError(() => syncBoard(board, { env }), 3, 'detached-head');
  });
});

describe('scenario: divergent clones converge', () => {
  it('A adds three events, B adds two, both sync, A syncs again: same files, same caches', () => {
    const env = syncEnv();
    const { remote, a, b, aDir, bDir } = twoMachines(env);
    const fromA = addTickets(a, 3, 'alice');
    const fromB = addTickets(b, 2, 'bob');

    const syncA = syncBoard(a, { env });
    expect(syncA).toMatchObject({ committedEvents: 3, pushed: true, arrived: [] });

    const syncB = syncBoard(b, { env });
    expect(syncB).toMatchObject({ committedEvents: 2, pulled: true, pushed: true });
    expect(syncB.arrived).toEqual(fromA);

    const again = syncBoard(a, { env });
    expect(again).toMatchObject({ commit: null, pulled: true });
    expect(again.arrived).toEqual(fromB);

    const all = [...fromA, ...fromB].map((h) => `${h}.json`).sort();
    expect(eventFiles(a)).toEqual(all);
    expect(eventFiles(b)).toEqual(all);
    expect(treeEvents(aDir)).toEqual(all);
    expect(treeEvents(bDir)).toEqual(all);
    expect(treeEvents(remote, 'main')).toEqual(all);
    expect(revParse(aDir)).toBe(revParse(bDir));

    // The catch-up run by sync already folded the arrivals ...
    const liveA = dumpCache(a.db);
    expect(dumpCache(b.db)).toBe(liveA);
    // ... and a full rebuild on each clone gives the same bytes.
    rebuild(a);
    rebuild(b);
    expect(dumpCache(a.db)).toBe(liveA);
    expect(dumpCache(b.db)).toBe(liveA);
    expect(listTickets(a)).toHaveLength(5);
    expect(listTickets(b).map((t) => t.id)).toEqual(listTickets(a).map((t) => t.id));
  });

  it('folds an arrived event that sorts before the local last position (refold)', () => {
    const env = syncEnv();
    const { a, b } = twoMachines(env);
    // A's events are later than B's in fold order.
    putEvent(a.eventsDir, ev(P.create(T1, 'late on A'), 'alice', 5_000));
    putEvent(a.eventsDir, ev(P.comment(T1, 'after'), 'alice', 6_000));
    catchUp(a);
    const early = [
      putEvent(b.eventsDir, ev(P.create(T2, 'early on B'), 'bob', 1_000)),
      putEvent(b.eventsDir, ev(P.create(T3, 'also early'), 'bob', 2_000)),
    ].sort();
    syncBoard(a, { env });
    syncBoard(b, { env });

    const result = syncBoard(a, { env });

    expect(result.arrived).toEqual(early);
    expect(result.refolded).toBe(true);
    const live = dumpCache(a.db);
    rebuild(a);
    expect(dumpCache(a.db)).toBe(live);
    expect(
      listTickets(a)
        .map((t) => t.id)
        .sort(),
    ).toEqual([T1, T2, T3].sort());
  });

  it('makes the arrived events visible to list without any further step', () => {
    const env = syncEnv();
    const { a, b } = twoMachines(env);
    const tickets = [create(a, { title: 'one' }, 'alice'), create(a, { title: 'two' }, 'alice')];
    syncBoard(a, { env });

    const result = syncBoard(b, { env });

    expect(result.arrived).toHaveLength(2);
    expect(result.message).toContain('2');
    expect(
      listTickets(b)
        .map((t) => t.id)
        .sort(),
    ).toEqual(tickets.map((t) => t.id).sort());
  });
});

describe('conflicts needing a human', () => {
  function conflicted(env: Env): { a: Board; b: Board; aDir: string; bDir: string } {
    const machines = twoMachines(env);
    appendFileSync(join(machines.aDir, '.gitignore'), 'only-on-a\n');
    appendFileSync(join(machines.bDir, '.gitignore'), 'only-on-b\n');
    addTickets(machines.b, 1, 'bob');
    syncBoard(machines.a, { env });
    return machines;
  }

  it('stops with exit 3 naming the path, leaving the rebase for a human', () => {
    const env = syncEnv();
    const { b, bDir } = conflicted(env);

    const err = expectBoardError(() => syncBoard(b, { env }), 3, 'sync-conflict');

    expect(err.message).toContain('.gitignore');
    expect(err.message).toContain(bDir);
    expect(err.message).toContain('rebase');
    expect(unmerged(bDir)).toEqual(['.gitignore']);
    expect(rebaseInProgress(bDir)).toBe(true);
  });

  it('refuses to sync again while the conflict is unresolved', () => {
    const env = syncEnv();
    const { b, bDir } = conflicted(env);
    expectBoardError(() => syncBoard(b, { env }), 3, 'sync-conflict');
    addTickets(b, 1, 'bob');

    const err = expectBoardError(() => syncBoard(b, { env }), 3, 'sync-in-progress');

    expect(err.message).toContain(bDir);
    expect(unmerged(bDir)).toEqual(['.gitignore']);
    expect(rebaseInProgress(bDir)).toBe(true);
  });

  it('completes once the human resolves the conflict and continues the rebase', () => {
    const env = syncEnv();
    const { a, b, aDir, bDir } = conflicted(env);
    expectBoardError(() => syncBoard(b, { env }), 3, 'sync-conflict');
    writeFileSync(
      join(bDir, '.gitignore'),
      'cache.sqlite\ncache.sqlite-wal\ncache.sqlite-shm\nonly-on-a\nonly-on-b\n',
    );
    git(bDir, 'add', '.gitignore');
    git(bDir, '-c', 'core.editor=true', 'rebase', '--continue');

    const resolved = syncBoard(b, { env });
    expect(resolved.pushed).toBe(true);
    const back = syncBoard(a, { env });

    expect(back.arrived).toHaveLength(1);
    expect(treeEvents(aDir)).toEqual(treeEvents(bDir));
    expect(dumpCache(a.db)).toBe(dumpCache(b.db));
  });
});

describe('the cache is never committed (board-cache: "Cache is not synced")', () => {
  const CACHE = /(^|\/)cache\.sqlite(-wal|-shm)?$/;
  const TEMP = /(^|\/)\.tmp-/;

  function assertClean(paths: readonly string[]): void {
    expect(paths.filter((p) => CACHE.test(p))).toEqual([]);
    expect(paths.filter((p) => TEMP.test(p))).toEqual([]);
  }

  it('scenario: cache.sqlite and its WAL and SHM files stay out of the board repo and the remote', () => {
    const env = syncEnv();
    const remote = bareRemote();
    const { dir } = initMachine(env, remote);
    const board = openTracked(dir);
    addTickets(board, 2, 'orch');
    // The open connection in WAL mode keeps all three files on disk.
    for (const name of ['cache.sqlite', 'cache.sqlite-wal', 'cache.sqlite-shm']) {
      expect(existsSync(join(dir, name)), name).toBe(true);
    }
    writeFileSync(join(board.eventsDir, '.tmp-inflight'), 'partial');

    syncBoard(board, { env });
    addTickets(board, 1, 'orch');
    syncBoard(board, { env });

    assertClean(treePaths(dir));
    assertClean(treePaths(remote, 'main'));
    for (let i = 0; i < commitCount(dir); i++) {
      assertClean(treePaths(dir, `HEAD~${String(i)}`));
    }
    expect(treeEvents(remote, 'main')).toHaveLength(3);
  });

  it('keeps them out even when the board .gitignore no longer lists them', () => {
    const env = syncEnv();
    const remote = bareRemote();
    const { dir } = initMachine(env, remote);
    writeFileSync(join(dir, '.gitignore'), '');
    const board = openTracked(dir);
    addTickets(board, 1, 'orch');
    writeFileSync(join(board.eventsDir, '.tmp-inflight'), 'partial');

    syncBoard(board, { env });

    assertClean(treePaths(dir));
    assertClean(treePaths(remote, 'main'));
    expect(treeEvents(remote, 'main')).toHaveLength(1);
  });
});

describe('host repository tracking the board', () => {
  /** A host git repository that tracks `.board/notes.txt`, with a board initialized in it. */
  function trackedHost(env: Env): { host: string; board: Board } {
    const host = gitRepo(join(tempDir(), 'host'));
    mkdirSync(join(host, '.board'));
    writeFileSync(join(host, '.board', 'notes.txt'), 'tracked by mistake\n');
    git(host, 'add', '.board/notes.txt');
    git(host, 'commit', '-q', '-m', 'track board by mistake');
    initBoard({ cwd: host, env });
    return { host, board: openTracked(join(host, '.board')) };
  }

  it('warns, naming the tracked path, and still syncs', () => {
    const env = syncEnv();
    const { host, board } = trackedHost(env);
    addTickets(board, 1, 'orch');
    const hostHead = revParse(host);
    const hostStatus = git(host, 'status', '--porcelain');

    const result: SyncResult = syncBoard(board, { env });

    expect(result.hostTracked).toEqual(['.board/notes.txt']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/warning/i);
    expect(result.warnings[0]).toContain('.board/notes.txt');
    expect(result.warnings[0]).toContain('.gitignore');
    expect(result.commit).toMatch(HEX40);
    expect(treeEvents(board.dir)).toHaveLength(1);
    // The host repository is never modified.
    expect(revParse(host)).toBe(hostHead);
    expect(git(host, 'status', '--porcelain')).toBe(hostStatus);
  });

  it('warns when the host tracks the board directory as a gitlink', () => {
    const env = syncEnv();
    const host = gitRepo(join(tempDir(), 'host'));
    initBoard({ cwd: host, env });
    const board = openTracked(join(host, '.board'));
    syncBoard(board, { env });
    git(host, 'add', '-f', '.board');
    git(host, 'commit', '-q', '-m', 'embed board');

    const result = syncBoard(board, { env });

    expect(result.hostTracked).toEqual(['.board']);
    expect(result.warnings).toHaveLength(1);
  });

  it('does not warn when the host ignores the board', () => {
    const env = syncEnv();
    const host = gitRepo(join(tempDir(), 'host'));
    initBoard({ cwd: host, env });
    const board = openTracked(join(host, '.board'));
    addTickets(board, 1, 'orch');

    const result = syncBoard(board, { env });

    expect(result.hostTracked).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe('boards that are not their own repository', () => {
  it('refuses a board directory with no git repository', () => {
    const env = syncEnv();
    const board = openTracked(makeBoardDir(tempDir()));

    const err = expectBoardError(() => syncBoard(board, { env }), 2, 'board-not-a-repository');

    expect(err.message).toContain(board.dir);
    expect(existsSync(join(board.dir, '.git'))).toBe(false);
  });

  it('refuses a board that is only a directory of the host repository, touching nothing', () => {
    const env = syncEnv();
    const host = gitRepo(join(tempDir(), 'host'));
    const board = openTracked(makeBoardDir(host));
    create(board);
    const hostHead = revParse(host);

    expectBoardError(() => syncBoard(board, { env }), 2, 'board-not-a-repository');

    expect(revParse(host)).toBe(hostHead);
    expect(git(host, 'diff', '--cached', '--name-only')).toBe('');
    expect(existsSync(join(board.dir, '.git'))).toBe(false);
  });
});
