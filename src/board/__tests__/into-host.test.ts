/**
 * `init --into-host` in process (add-board-sharing task 5.1; board-cli
 * "Moving a standalone board into the host repository"; board-concurrency
 * "Moving a board into the host repository loses no event"; design.md
 * decision 9): the constants and the kept name, byte-for-byte event
 * verification, every refusal of step 1 leaving the host and the board
 * untouched, the move itself (the history kept, the events identical, the
 * canonical dump byte-identical, the old repository kept, the ref
 * published), the re-run, integrating a local and a remote board ref, the
 * conflict and the step 5 integrity refusal, and the temporary worktree
 * helpers (pid-named, only dead-pid leftovers removed). The CLI document,
 * the hints, the kill points and the multi-clone runs are in
 * `src/cli/__tests__/into-host-cli.test.ts`, `src/__tests__/into-host-clones.test.ts`
 * and `src/__tests__/into-host-race.test.ts`.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { canonicalDump, expectCheckClean } from '../../__tests__/harness/host-sync.js';
import { openBoard } from '../../store/board.js';
import { P, T1, T2, ev, putEvent } from '../../store/__tests__/helpers.js';
import { AGENTBOARD_GIT_SUBDIR, WORKTREE_LOCK_REASON } from '../host-init.js';
import {
  MIGRATING_DIR,
  MIGRATING_REF,
  STANDALONE_KEPT_PREFIX,
  adoptMigratingWorktree,
  findMigratingWorktrees,
  migratingWorktreePath,
  moveBoardIntoHost,
  removeDeadMigratingWorktrees,
  standaloneKeptName,
  verifyEventFiles,
  type IntoHostResult,
} from '../into-host.js';
import { detectBoardModel } from '../model.js';
import { syncBoard } from '../sync.js';
import { expectBoardError, git, gitRepo, tempDir } from './helpers.js';
import {
  agentboardDir,
  bareHost,
  cloneProject,
  cloneWithStandalone,
  commitIgnoreLine,
  eventFiles,
  expectKept,
  expectMoved,
  expectUntouched,
  keptRepositories,
  migratingEntries,
  project,
  refEvents,
  standaloneProject,
  syncStandalone,
  syncedStandalone,
  untouched,
  writeEvents,
} from './into-host-helpers.js';
import {
  BOARD_REF,
  commitHostEvent,
  hostBoard,
  pushBoardRef,
  refCommit,
  snapshotDir,
  standaloneBoard,
  withGitShim,
  withGitShimBefore,
  worktreeEntry,
  worktrees,
} from './sharing-helpers.js';
import { bareRemote, revParse, syncEnv, type Env } from './sync-helpers.js';

// Every test runs git many times; keep well clear of the 5 s default.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

/** A pid no process has: above every platform's pid range, so `kill(pid, 0)` fails with ESRCH. */
const DEAD_PID = 4_194_305;

/** `moveBoardIntoHost` in `cwd`. */
function move(cwd: string, env: Env): IntoHostResult {
  return moveBoardIntoHost({ cwd, env });
}

/** The host-model `sync` on the board at `dir`, in process. */
function syncHost(dir: string, env: Env): void {
  const board = openBoard(dir);
  try {
    expect(syncBoard(board, { env }).model).toBe('host');
  } finally {
    board.close();
  }
}

/** Whether `ancestor` is an ancestor of (or equal to) `descendant` in `repo`. */
function isAncestor(repo: string, ancestor: string, descendant: string): boolean {
  try {
    git(repo, 'merge-base', '--is-ancestor', ancestor, descendant);
    return true;
  } catch {
    return false;
  }
}

describe('constants and names', () => {
  it('name the temporary ref, the temporary directory and the kept prefix as the design does', () => {
    expect(MIGRATING_REF).toBe('refs/agentboard/migrating');
    expect(MIGRATING_DIR).toBe('migrating');
    expect(STANDALONE_KEPT_PREFIX).toBe('standalone-');
  });

  it('standaloneKeptName is standalone- followed by the UTC time as YYYYMMDDTHHMMSSZ', () => {
    expect(standaloneKeptName(new Date(Date.UTC(2026, 9, 13, 15, 30, 0)))).toBe(
      'standalone-20261013T153000Z',
    );
    expect(standaloneKeptName(new Date(Date.UTC(2027, 0, 1, 0, 0, 9)))).toBe(
      'standalone-20270101T000009Z',
    );
    expect(standaloneKeptName(new Date(0))).toMatch(/^standalone-[0-9]{8}T[0-9]{6}Z$/);
  });

  it('migratingWorktreePath is <git common dir>/agentboard/migrating/<pid>, from the host or a linked worktree, creating nothing', () => {
    const root = gitRepo(join(tempDir(), 'proj'));
    const linked = join(tempDir(), 'linked');
    git(root, 'worktree', 'add', '-q', '--detach', linked, 'HEAD');

    expect(migratingWorktreePath(root, 4242)).toBe(
      join(root, '.git', AGENTBOARD_GIT_SUBDIR, MIGRATING_DIR, '4242'),
    );
    expect(migratingWorktreePath(root)).toBe(
      join(root, '.git', AGENTBOARD_GIT_SUBDIR, MIGRATING_DIR, String(process.pid)),
    );
    expect(migratingWorktreePath(linked, 7)).toBe(
      join(root, '.git', AGENTBOARD_GIT_SUBDIR, MIGRATING_DIR, '7'),
    );
    expect(existsSync(join(root, '.git', AGENTBOARD_GIT_SUBDIR))).toBe(false);
  });
});

describe('verifyEventFiles', () => {
  function events(names: Record<string, string>): string {
    const dir = join(tempDir(), 'events');
    mkdirSync(dir);
    for (const [name, content] of Object.entries(names)) {
      writeFileSync(join(dir, name), content);
    }
    return dir;
  }
  const A = `${'a'.repeat(64)}.json`;
  const B = `${'b'.repeat(64)}.json`;
  const C = `${'c'.repeat(64)}.json`;

  it('reports nothing when every event of from is in to with identical bytes', () => {
    const from = events({ [A]: '{"a":1}', [B]: '{"b":2}' });
    const to = events({ [A]: '{"a":1}', [B]: '{"b":2}', [C]: '{"c":3}' });
    expect(verifyEventFiles(from, to)).toEqual({ missing: [], different: [] });
  });

  it('reports the missing and the differing files, ascending', () => {
    const from = events({ [C]: 'x', [A]: '{"a":1}', [B]: '{"b":2}' });
    const to = events({ [A]: '{"a":1}', [B]: '{"b":2} ' });
    expect(verifyEventFiles(from, to)).toEqual({ missing: [C], different: [B] });
  });

  it('compares bytes, not text: a one-byte difference counts', () => {
    const from = events({ [A]: 'abc' });
    const to = join(tempDir(), 'to');
    mkdirSync(to);
    writeFileSync(join(to, A), Buffer.from([0x61, 0x62, 0xff]));
    expect(verifyEventFiles(from, to)).toEqual({ missing: [], different: [A] });
  });

  it('ignores dot-named entries, temporaries, non-event names and subdirectories, and a missing from', () => {
    const from = events({ [A]: '1', '.gitkeep': '', '.tmp-123': 'x', 'notes.txt': 'n' });
    mkdirSync(join(from, 'sub'));
    writeFileSync(join(from, 'sub', B), '2');
    const to = events({ [A]: '1' });
    expect(verifyEventFiles(from, to)).toEqual({ missing: [], different: [] });
    expect(verifyEventFiles(join(tempDir(), 'nowhere'), to)).toEqual({ missing: [], different: [] });
  });
});

describe('step 1 refusals change nothing', () => {
  it('git-too-old: exit 1 with 2.32 in the message, on a standalone board, a host-model board and outside a git repository', () => {
    const env = syncEnv();
    const old = withGitShim(env, '2.31.8');
    const { root, dir } = standaloneProject(env);
    const before = untouched(root, dir);

    const err = expectBoardError(() => move(root, old), 1, 'git-too-old');

    expect(err.message).toContain('2.32');
    expect(err.message).toContain('2.31.8');
    expectUntouched(root, dir, before);
    expect(detectBoardModel(dir, { env }).model).toBe('standalone');

    const host = hostBoard(env);
    const hostBefore = untouched(host.root, host.dir);
    expectBoardError(() => move(host.root, old), 1, 'git-too-old');
    expectUntouched(host.root, host.dir, hostBefore);

    const plain = tempDir();
    standaloneBoard(plain);
    expectBoardError(() => move(plain, old), 1, 'git-too-old');
  });

  it('git 2.32.0 exactly meets the floor', () => {
    const env = syncEnv();
    const { root, dir } = standaloneProject(env);
    const result = move(root, withGitShim(env, '2.32.0'));
    expect(result).toMatchObject({ action: 'moved', model: 'host' });
    expectMoved(root, env);
    expect(eventFiles(dir)).toHaveLength(3);
  });

  it('scenario: Move outside a git repository exits 1 no-host-repository and changes nothing', () => {
    const env = syncEnv();
    const root = tempDir();
    const dir = standaloneBoard(root);
    git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    writeEvents(dir, 2);
    syncStandalone(dir, env);
    const board = snapshotDir(dir);

    const err = expectBoardError(() => move(root, env), 1, 'no-host-repository');

    expect(err.message).toMatch(/git repository/);
    expect(snapshotDir(dir)).toEqual(board);
    expect(detectBoardModel(dir, { env }).model).toBe('standalone');
    expect(git(dir, 'for-each-ref', '--format=%(refname)', 'refs/agentboard/')).toBe('');
  });

  it('with AGENTBOARD_DIR set inside a git host: exit 1 no-host-repository naming the variable, nothing changes', () => {
    const env = syncEnv();
    const { root, dir } = standaloneProject(env);
    const before = untouched(root, dir);

    const err = expectBoardError(
      () => move(root, { ...env, AGENTBOARD_DIR: dir }),
      1,
      'no-host-repository',
    );

    expect(err.message).toContain('AGENTBOARD_DIR');
    expectUntouched(root, dir, before);
  });

  it('in a host whose git directory is not in its working tree (separate git dir): exit 1 no-host-repository', () => {
    const env = syncEnv();
    const base = tempDir();
    const work = join(base, 'work');
    const gitDir = join(base, 'work-git');
    git(base, 'init', '-q', '--separate-git-dir', gitDir, work);
    writeFileSync(join(work, 'README'), 'x\n');
    git(work, 'add', 'README');
    git(work, 'commit', '-q', '-m', 'one');
    // Discovery puts .board beside the git directory, outside the working tree.
    const dir = standaloneBoard(base);
    git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    writeEvents(dir, 1);
    syncStandalone(dir, env);
    const board = snapshotDir(dir);

    const err = expectBoardError(() => move(work, env), 1, 'no-host-repository');

    expect(err.message).toMatch(/git repository/);
    expect(snapshotDir(dir)).toEqual(board);
    expect(git(work, 'for-each-ref', '--format=%(refname)', 'refs/agentboard/')).toBe('');
  });

  it('no board: exit 2 board-not-found naming the directory, nothing written', () => {
    const env = syncEnv();
    const root = bareHost();
    const before = untouched(root, join(root, '.board'));

    const err = expectBoardError(() => move(root, env), 2, 'board-not-found');

    expect(err.message).toContain(join(root, '.board'));
    expectUntouched(root, join(root, '.board'), before);
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
  });

  it('a rebase in progress in the standalone board: exit 3 sync-in-progress', () => {
    const env = syncEnv();
    const { root, dir } = standaloneProject(env);
    mkdirSync(join(dir, '.git', 'rebase-merge'));
    const before = untouched(root, dir);

    const err = expectBoardError(() => move(root, env), 3, 'sync-in-progress');

    expect(err.message).toContain(dir);
    expectUntouched(root, dir, before);
  });

  it('a detached HEAD in the standalone board: exit 3 detached-head', () => {
    const env = syncEnv();
    const { root, dir } = standaloneProject(env);
    git(dir, 'checkout', '-q', '--detach');
    const before = untouched(root, dir);

    expectBoardError(() => move(root, env), 3, 'detached-head');

    expectUntouched(root, dir, before);
  });

  it('a standalone board with no commit yet: exit 4 unsynced saying to run agentboard sync first', () => {
    const env = syncEnv();
    const root = bareHost();
    const dir = standaloneBoard(root);
    git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    const before = untouched(root, dir);

    const err = expectBoardError(() => move(root, env), 4, 'unsynced');

    expect(err.message).toContain('agentboard sync');
    expectUntouched(root, dir, before);
  });

  it('a committed event file missing from events/: exit 5 integrity naming it', () => {
    const env = syncEnv();
    const { root, dir } = standaloneProject(env, 2);
    const [gone] = eventFiles(dir);
    rmSync(join(dir, 'events', String(gone)));
    const before = untouched(root, dir);

    const err = expectBoardError(() => move(root, env), 5, 'integrity');

    expect(err.message).toContain(String(gone));
    expectUntouched(root, dir, before);
  });

  it('a committed event file modified in place: exit 5 integrity naming it, nothing moved (DECISION: not unsynced)', () => {
    const env = syncEnv();
    const { root, dir } = standaloneProject(env, 2);
    const [changed] = eventFiles(dir);
    const path = join(dir, 'events', String(changed));
    writeFileSync(path, `${readFileSync(path, 'utf8')} `);
    const before = untouched(root, dir);

    const err = expectBoardError(() => move(root, env), 5, 'integrity');

    expect(err.message).toContain(String(changed));
    expectUntouched(root, dir, before);
  });

  it('scenario: Migration refused with uncommitted events (untracked): exit 4 unsynced naming the count and agentboard sync', () => {
    const env = syncEnv();
    const { root, dir } = standaloneProject(env, 3);
    writeEvents(dir, 2, 'late', 100);
    const before = untouched(root, dir);

    const err = expectBoardError(() => move(root, env), 4, 'unsynced');

    expect(err.message).toContain('2 event files');
    expect(err.message).toContain('agentboard sync');
    expectUntouched(root, dir, before);
    expect(existsSync(agentboardDir(root))).toBe(false);
    expect(detectBoardModel(dir, { env }).model).toBe('standalone');
  });

  it('a staged but uncommitted event file is unsynced too (1 event file)', () => {
    const env = syncEnv();
    const { root, dir } = standaloneProject(env, 1);
    const [hash] = writeEvents(dir, 1, 'late', 100);
    git(dir, 'add', '--', `events/${String(hash)}.json`);
    const before = untouched(root, dir);

    const err = expectBoardError(() => move(root, env), 4, 'unsynced');

    expect(err.message).toContain('1 event file');
    expect(err.message).not.toContain('1 event files');
    expectUntouched(root, dir, before);
  });

  it('a temporary file under events/ does not count as unsynced', () => {
    const env = syncEnv();
    const { root, dir } = standaloneProject(env, 1);
    writeFileSync(join(dir, 'events', '.tmp-abc'), 'partial');

    const result = move(root, env);

    expect(result.action).toBe('moved');
    expectMoved(root, env);
  });

  it('scenario: Migration refused with unpushed commits: exit 4 unsynced, nothing changes', () => {
    const env = syncEnv();
    const { root, dir } = standaloneProject(env, 2);
    writeEvents(dir, 1, 'late', 100);
    git(dir, 'add', '--', 'events');
    git(dir, 'commit', '-q', '--no-verify', '-m', 'local only');
    const before = untouched(root, dir);

    const err = expectBoardError(() => move(root, env), 4, 'unsynced');

    expect(err.message).toContain('agentboard sync');
    expectUntouched(root, dir, before);
  });

  it('the standalone remote cannot be reached: exit 3 sync-failed naming it, nothing changes', () => {
    const env = syncEnv();
    const { root, dir } = standaloneProject(env, 2);
    git(dir, 'remote', 'set-url', 'origin', join(tempDir(), 'gone.git'));
    const before = untouched(root, dir);

    const err = expectBoardError(() => move(root, env), 3, 'sync-failed');

    expect(err.message).toContain('origin');
    expectUntouched(root, dir, before);
  });

  it('the standalone board has several remotes and none chosen: exit 1 ambiguous-remote naming them', () => {
    const env = syncEnv();
    const { root, dir } = standaloneProject(env, 2);
    git(dir, 'remote', 'rename', 'origin', 'fork');
    git(dir, 'config', '--unset', 'branch.main.remote');
    git(dir, 'config', '--unset', 'branch.main.merge');
    git(dir, 'remote', 'add', 'upstream', bareRemote());
    const before = untouched(root, dir);

    const err = expectBoardError(() => move(root, env), 1, 'ambiguous-remote');

    expect(err.message).toContain('fork');
    expect(err.message).toContain('upstream');
    expect(err.message).toContain('agentboard init');
    expectUntouched(root, dir, before);
  });

  it('the host has several remotes and none chosen: exit 1 ambiguous-remote before anything is written', () => {
    const env = syncEnv();
    const root = bareHost();
    const { dir } = syncedStandalone(root, env, 2);
    git(root, 'remote', 'add', 'fork', bareRemote());
    git(root, 'remote', 'add', 'upstream', bareRemote());
    const before = untouched(root, dir);

    const err = expectBoardError(() => move(root, env), 1, 'ambiguous-remote');

    expect(err.message).toContain('git config agentboard.remote');
    expectUntouched(root, dir, before);
    expect(detectBoardModel(dir, { env }).model).toBe('standalone');
  });
});

describe('scenario: Migration success', () => {
  it('moves a fully synced board of 40 events: history kept, events identical, dump byte-identical, old repository kept, ref published', () => {
    const env = syncEnv();
    const { root, remote, dir, boardRemote, tip } = standaloneProject(env, 40);
    const files = eventFiles(dir);
    expect(files).toHaveLength(40);
    const oldCommits = git(dir, 'rev-list', 'main').trim().split('\n');
    const dumpBefore = canonicalDump(dir);
    const hostRefsBefore = git(root, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/remotes', 'refs/tags');

    const result = move(root, env);

    expect(result).toMatchObject({
      dir,
      action: 'moved',
      created: false,
      model: 'host',
      joined: false,
      remote: 'origin',
      events: 40,
      hostGitignore: null,
      repair: null,
      oldRemoteUrl: boardRemote,
    });
    expect(result.keptAt).not.toBeNull();
    expect(result.keptAt).toContain(join(agentboardDir(root), STANDALONE_KEPT_PREFIX));
    expect(basename(String(result.keptAt))).toMatch(/^standalone-[0-9]{8}T[0-9]{6}Z$/);
    expect(result.sync).toMatchObject({ model: 'host', remote: 'origin', pushed: true });
    expect(result.warnings).toEqual([]);
    for (const text of [dir, BOARD_REF, String(result.keptAt), boardRemote, 'agentboard init --into-host']) {
      expect(result.message).toContain(text);
    }
    expect(result.message).toMatch(/retire/);
    expectMoved(root, env);
    // Every commit of the old branch is in the new history, and the tip is reachable.
    expect(isAncestor(root, tip, BOARD_REF)).toBe(true);
    for (const commit of oldCommits) {
      expect(isAncestor(root, commit, BOARD_REF), commit).toBe(true);
    }
    expect(eventFiles(dir)).toEqual(files);
    expect(refEvents(root)).toEqual(files);
    expect(canonicalDump(dir)).toBe(dumpBefore);
    expectKept(String(result.keptAt), tip, files);
    expect(git(remote, 'rev-parse', BOARD_REF).trim()).toBe(refCommit(root));
    expect(refEvents(remote)).toEqual(files);
    // The host's branches, remote-tracking refs and tags are untouched; the kept repository is inside .git.
    expect(git(root, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/remotes', 'refs/tags')).toBe(hostRefsBefore);
    expect(git(root, 'ls-files', '--', '.git')).toBe('');
    expectCheckClean(root, env);
  });

  it('scenario: Migration re-run exits 0 saying the board is already in the host repository, and nothing changes', () => {
    const env = syncEnv();
    const { root, remote, dir } = standaloneProject(env, 2);
    const first = move(root, env);
    expect(first.action).toBe('moved');
    const before = untouched(root, dir);
    const kept = keptRepositories(root);
    const published = git(remote, 'rev-parse', BOARD_REF).trim();

    const again = move(root, env);

    expect(again).toMatchObject({
      action: 'unchanged',
      created: false,
      model: 'host',
      keptAt: null,
      oldRemoteUrl: null,
      sync: null,
      repair: null,
      events: 2,
    });
    expect(again.message).toMatch(/already/);
    expect(again.message).toMatch(/host repository/);
    expect(untouched(root, dir)).toEqual(before);
    expect(keptRepositories(root)).toEqual(kept);
    expect(git(remote, 'rev-parse', BOARD_REF).trim()).toBe(published);
    expectMoved(root, env);
  });

  it('a board without a remote moves too: oldRemoteUrl null, the sync reports no remote, the ref is created', () => {
    const env = syncEnv();
    const root = bareHost();
    const { dir, tip } = syncedStandalone(root, env, 3);
    const files = eventFiles(dir);

    const result = move(root, env);

    expect(result).toMatchObject({ action: 'moved', remote: null, oldRemoteUrl: null, events: 3 });
    expect(result.sync).toMatchObject({ model: 'host', remote: null, pushed: false });
    expect(result.message).toMatch(/no remote/);
    expectMoved(root, env);
    expect(isAncestor(root, tip, BOARD_REF)).toBe(true);
    expect(eventFiles(dir)).toEqual(files);
    expectKept(String(result.keptAt), tip, files);
    expectCheckClean(root, env);
  });

  it('adds the .board/ entry to a host .gitignore that lacks it, and names the file', () => {
    const env = syncEnv();
    const root = bareHost();
    const { dir } = syncedStandalone(root, env, 1);
    rmSync(join(root, '.gitignore'));

    const result = move(root, env);

    expect(result.action).toBe('moved');
    expect(result.hostGitignore).toBe(join(root, '.gitignore'));
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('.board/\n');
    expect(detectBoardModel(dir, { env }).model).toBe('host');
  });

  it('a second move kept in the same second gets its own kept name (numeric suffix)', () => {
    const env = syncEnv();
    const root = bareHost();
    syncedStandalone(root, env, 1);
    const taken = join(agentboardDir(root), standaloneKeptName(new Date()));
    mkdirSync(taken, { recursive: true });
    writeFileSync(join(taken, 'marker'), 'x');

    const result = move(root, env);

    expect(result.action).toBe('moved');
    expect(result.keptAt).not.toBe(taken);
    expect(String(result.keptAt)).toMatch(/^.*standalone-[0-9]{8}T[0-9]{6}Z(-[0-9]+)?$/);
    expect(readFileSync(join(taken, 'marker'), 'utf8')).toBe('x');
    expect(keptRepositories(root)).toHaveLength(2);
  });

  it('the old repository keeps its cache file and is never modified; the new board gets a fresh cache', () => {
    const env = syncEnv();
    const { root, dir, tip } = standaloneProject(env, 2);
    openBoard(dir).close();
    expect(existsSync(join(dir, 'cache.sqlite'))).toBe(true);
    const files = eventFiles(dir);

    const result = move(root, env);

    const kept = String(result.keptAt);
    expect(existsSync(join(kept, 'cache.sqlite'))).toBe(true);
    expectKept(kept, tip, files);
    expect(git(kept, 'status', '--porcelain', '--', 'events', '.gitignore')).toBe('');
    expect(existsSync(join(dir, 'cache.sqlite'))).toBe(true);
    expectCheckClean(root, env);
  });
});

describe('integrating board refs that already exist', () => {
  it('a local refs/agentboard/board in the host (fetched by hand) is integrated: the result holds both histories, joined false', () => {
    const env = syncEnv();
    const root = bareHost();
    const { dir, tip } = syncedStandalone(root, env, 3);
    const other = hostBoard(env);
    const fromOther = commitHostEvent(other.dir, ev(P.create(T2, 'From the host ref'), 'x', 2000), env);
    git(root, 'fetch', '-q', other.root, `${BOARD_REF}:${BOARD_REF}`);
    const local = String(refCommit(root));
    const files = eventFiles(dir);

    const result = move(root, env);

    expect(result).toMatchObject({ action: 'moved', joined: false, events: 4 });
    expectMoved(root, env);
    expect(isAncestor(root, local, BOARD_REF)).toBe(true);
    expect(isAncestor(root, tip, BOARD_REF)).toBe(false);
    expect(eventFiles(dir)).toEqual([...files, `${fromOther}.json`].sort());
    expect(refEvents(root)).toEqual(eventFiles(dir));
    expectCheckClean(root, env);
  });

  it("scenario: Second clone migrates after the first (one run): B's ref holds A's history and B's new commits, both converge", () => {
    const env = syncEnv();
    const a = standaloneProject(env, 3);
    const b = cloneWithStandalone(a.remote, a.boardRemote, 'b');
    expect(move(a.root, env).action).toBe('moved');
    // A goes on in the host model; B goes on with the old remote.
    const fromA = putEvent(join(a.dir, 'events'), ev(P.comment(T1, 'a after'), 'a', 20_001));
    syncHost(a.dir, env);
    const aRef = String(refCommit(a.root));
    const original = eventFiles(b.dir);
    const fromB = writeEvents(b.dir, 2, 'b', 200);
    syncStandalone(b.dir, env);
    const bTip = revParse(b.dir);

    const result = move(b.root, env);

    expect(result).toMatchObject({ action: 'moved', joined: true, remote: 'origin' });
    expectMoved(b.root, env);
    expect(isAncestor(b.root, aRef, BOARD_REF)).toBe(true);
    for (const hash of fromB) {
      expect(refEvents(b.root)).toContain(`${hash}.json`);
    }
    expect(eventFiles(b.dir)).toContain(`${fromA}.json`);
    expectKept(String(result.keptAt), bTip, [...original, ...fromB.map((h) => `${h}.json`)]);

    syncHost(a.dir, env);
    expect(eventFiles(a.dir)).toEqual(eventFiles(b.dir));
    expect(eventFiles(a.dir)).toHaveLength(6);
    expect(refCommit(a.root)).toBe(refCommit(b.root));
    expect(canonicalDump(a.dir)).toBe(canonicalDump(b.dir));
    expectCheckClean(a.root, env);
    expectCheckClean(b.root, env);
  });

  it('a conflict while integrating the host remote ref: exit 3 sync-conflict naming the temporary worktree, the old .board untouched, a re-run refuses again', () => {
    const env = syncEnv();
    const { root: aRoot, remote } = project('a');
    const a = hostBoard(env, aRoot);
    commitIgnoreLine(a.dir, 'foo');
    git(a.dir, 'update-ref', BOARD_REF, 'HEAD');
    pushBoardRef(a.root);
    const bRoot = cloneProject(remote, 'b');
    const bDir = standaloneBoard(bRoot);
    git(bDir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    writeEvents(bDir, 1);
    syncStandalone(bDir, env);
    commitIgnoreLine(bDir, 'bar');
    const before = untouched(bRoot, bDir);

    const err = expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');

    expect(err.message).toContain('.gitignore');
    expect(err.message).toContain(join(agentboardDir(bRoot), MIGRATING_DIR));
    expect(err.message).toContain('rebase --continue');
    expect(snapshotDir(bDir)).toEqual(before.board);
    expect(detectBoardModel(bDir, { env }).model).toBe('standalone');
    expect(refCommit(bRoot)).toBeNull();
    expect(keptRepositories(bRoot)).toEqual([]);
    const registered = worktrees(bRoot)
      .split('\n')
      .filter((line) => line.startsWith('worktree ') && line.includes(`/${MIGRATING_DIR}/`));
    expect(registered).toHaveLength(1);

    const again = expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');
    expect(again.message).toContain('.gitignore');
    expect(snapshotDir(bDir)).toEqual(before.board);
    expect(refCommit(bRoot)).toBeNull();
    expect(
      worktrees(bRoot)
        .split('\n')
        .filter((line) => line.startsWith('worktree ') && line.includes(`/${MIGRATING_DIR}/`)),
    ).toHaveLength(1);
    expect(migratingEntries(bRoot)).toHaveLength(1);
  });

  it('an unreachable host remote: the move completes, exits 3 sync-failed from the sync, and the next sync publishes', () => {
    const env = syncEnv();
    const { root, remote, dir, tip } = standaloneProject(env, 2);
    const files = eventFiles(dir);
    git(root, 'remote', 'set-url', 'origin', join(tempDir(), 'gone.git'));

    const err = expectBoardError(() => move(root, env), 3, 'sync-failed');

    expect(err.message).toContain('origin');
    expectMoved(root, env);
    expect(isAncestor(root, tip, BOARD_REF)).toBe(true);
    expect(eventFiles(dir)).toEqual(files);

    git(root, 'remote', 'set-url', 'origin', remote);
    syncHost(dir, env);
    expect(git(remote, 'rev-parse', BOARD_REF).trim()).toBe(refCommit(root));
    expect(move(root, env).action).toBe('unchanged');
    expectCheckClean(root, env);
  });
});

describe('step 5: byte-for-byte verification', () => {
  it('a temporary worktree whose event file differs from the old board: exit 5 integrity, nothing moved, the temporary ref and worktree removed, a clean re-run succeeds', () => {
    const env = syncEnv();
    const root = bareHost();
    const { dir, tip } = syncedStandalone(root, env, 2);
    const files = eventFiles(dir);
    const [victim] = files;
    // Right after the temporary worktree is checked out, one of its event
    // files is overwritten, as a bug in steps 2 to 4 would.
    const corrupting = withGitShimBefore(
      env,
      ['worktree', 'add', '--detach'],
      `"$GIT" "$@"; for f in '${join(agentboardDir(root), MIGRATING_DIR)}'/*/events/${String(victim)}; do echo corrupt > "$f"; done; exit 0`,
    );
    const before = untouched(root, dir);

    const err = expectBoardError(() => move(root, corrupting), 5, 'integrity');

    expect(err.message).toContain(String(victim));
    expect(snapshotDir(dir)).toEqual(before.board);
    expect(detectBoardModel(dir, { env }).model).toBe('standalone');
    expect(keptRepositories(root)).toEqual([]);
    expect(refCommit(root, MIGRATING_REF)).toBeNull();
    expect(migratingEntries(root)).toEqual([]);
    expect(worktrees(root)).not.toContain(`/${MIGRATING_DIR}/`);

    const result = move(root, env);
    expect(result.action).toBe('moved');
    expectMoved(root, env);
    expect(eventFiles(dir)).toEqual(files);
    expectKept(String(result.keptAt), tip, files);
    expectCheckClean(root, env);
  });
});

describe('the temporary worktree helpers', () => {
  /** A host with `refs/agentboard/board` at the empty board and its `.board` worktree removed, so a temporary worktree can be adopted. */
  function hostWithRefOnly(env: Env): { root: string; dir: string; commit: string } {
    const { root, dir, commit } = hostBoard(env);
    git(root, 'worktree', 'unlock', dir);
    git(root, 'worktree', 'remove', '--force', dir);
    expect(existsSync(dir)).toBe(false);
    return { root, dir, commit };
  }

  /** A registered temporary worktree at `migrating/<pid>` on `rev`. */
  function temporary(root: string, pid: number, rev: string): string {
    const path = join(agentboardDir(root), MIGRATING_DIR, String(pid));
    mkdirSync(join(agentboardDir(root), MIGRATING_DIR), { recursive: true });
    git(root, 'worktree', 'add', '-q', '--detach', path, rev);
    return path;
  }

  it('findMigratingWorktrees lists every entry with its pid, liveness, registration and HEAD', () => {
    const env = syncEnv();
    const { root, commit } = hostWithRefOnly(env);
    const dead = temporary(root, DEAD_PID, commit);
    const alive = temporary(root, process.pid, commit);
    const plain = join(agentboardDir(root), MIGRATING_DIR, '123');
    mkdirSync(plain);
    const junk = join(agentboardDir(root), MIGRATING_DIR, 'junk');
    mkdirSync(junk);

    const found = findMigratingWorktrees(root, { env });

    expect(found.map((w) => w.path)).toEqual([plain, dead, alive, junk].sort());
    expect(found.find((w) => w.path === dead)).toEqual({
      path: dead,
      pid: DEAD_PID,
      alive: false,
      registered: true,
      head: commit,
    });
    expect(found.find((w) => w.path === alive)).toMatchObject({
      pid: process.pid,
      alive: true,
      registered: true,
      head: commit,
    });
    expect(found.find((w) => w.path === plain)).toMatchObject({
      pid: 123,
      alive: false,
      registered: false,
      head: null,
    });
    expect(found.find((w) => w.path === junk)).toMatchObject({
      pid: null,
      alive: false,
      registered: false,
      head: null,
    });
    expect(findMigratingWorktrees(bareHost('empty'), { env })).toEqual([]);
  });

  it('removeDeadMigratingWorktrees removes only dead-pid leftovers (registered or plain), keeps a live one, and reports what it removed', () => {
    const env = syncEnv();
    const { root, commit } = hostWithRefOnly(env);
    git(root, 'update-ref', MIGRATING_REF, commit);
    const dead = temporary(root, DEAD_PID, commit);
    const alive = temporary(root, process.pid, commit);
    const plain = join(agentboardDir(root), MIGRATING_DIR, '123');
    mkdirSync(plain);
    const junk = join(agentboardDir(root), MIGRATING_DIR, 'junk');
    mkdirSync(junk);
    writeFileSync(join(junk, 'note'), 'x');

    const removed = removeDeadMigratingWorktrees(root, { env });

    expect(removed).toEqual([plain, dead, junk].sort());
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(plain)).toBe(false);
    expect(existsSync(junk)).toBe(false);
    expect(existsSync(alive)).toBe(true);
    expect(worktreeEntry(root, dead)).toBeNull();
    expect(worktreeEntry(root, alive)).not.toBeNull();
    // A live move still needs the temporary ref.
    expect(refCommit(root, MIGRATING_REF)).toBe(commit);
    expect(refCommit(root)).toBe(commit);

    git(root, 'worktree', 'remove', '--force', alive);
    rmSync(alive, { recursive: true, force: true });
    expect(removeDeadMigratingWorktrees(root, { env })).toEqual([]);
    expect(refCommit(root, MIGRATING_REF)).toBeNull();
    expect(refCommit(root)).toBe(commit);
    expect(removeDeadMigratingWorktrees(bareHost('empty'), { env })).toEqual([]);
  });

  it('adoptMigratingWorktree moves a dead-pid temporary worktree at the ref into place and locks it', () => {
    const env = syncEnv();
    const { root, dir, commit } = hostWithRefOnly(env);
    const temp = temporary(root, DEAD_PID, commit);

    expect(adoptMigratingWorktree(root, dir, { env })).toBe(true);

    expect(existsSync(temp)).toBe(false);
    expect(worktreeEntry(root, temp)).toBeNull();
    expect(worktreeEntry(root, dir)?.locked).toBe(WORKTREE_LOCK_REASON);
    expect(revParse(dir)).toBe(commit);
    expect(detectBoardModel(dir, { env }).model).toBe('host');
    expect(adoptMigratingWorktree(root, dir, { env })).toBe(false);
  });

  it('adoptMigratingWorktree changes nothing when .board exists, when the HEAD differs from the ref, or when the pid is alive', () => {
    const env = syncEnv();
    const present = hostBoard(env);
    const presentTemp = temporary(present.root, DEAD_PID, present.commit);
    expect(adoptMigratingWorktree(present.root, present.dir, { env })).toBe(false);
    expect(existsSync(presentTemp)).toBe(true);

    const behind = hostWithRefOnly(env);
    const other = temporary(behind.root, DEAD_PID, behind.commit);
    writeFileSync(join(other, 'events', 'x'), '');
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '--no-verify', '-m', 'ahead of the ref');
    expect(adoptMigratingWorktree(behind.root, behind.dir, { env })).toBe(false);
    expect(existsSync(behind.dir)).toBe(false);
    expect(existsSync(other)).toBe(true);

    const live = hostWithRefOnly(env);
    const liveTemp = temporary(live.root, process.pid, live.commit);
    expect(adoptMigratingWorktree(live.root, live.dir, { env })).toBe(false);
    expect(existsSync(live.dir)).toBe(false);
    expect(existsSync(liveTemp)).toBe(true);
  });

  it('a leftover temporary worktree of a dead move beside a standalone .board is removed and the move starts again, naming it', () => {
    const env = syncEnv();
    const { root, dir, tip } = standaloneProject(env, 2);
    const files = eventFiles(dir);
    const leftover = temporary(root, DEAD_PID, 'HEAD');
    git(root, 'update-ref', MIGRATING_REF, 'HEAD');

    const result = move(root, env);

    expect(result.action).toBe('moved');
    expect(result.message).toContain(leftover);
    expectMoved(root, env);
    expect(eventFiles(dir)).toEqual(files);
    expectKept(String(result.keptAt), tip, files);
  });

  it('a stale .board copied into a fresh clone is repaired as init repairs it (action repaired)', () => {
    const env = syncEnv();
    const { root: aRoot, remote } = project('a');
    const a = hostBoard(env, aRoot);
    const hash = commitHostEvent(a.dir, ev(P.create(T1, 'From A'), 'orch', 1000), env);
    pushBoardRef(a.root);
    const cRoot = cloneProject(remote, 'c');
    const cDir = join(cRoot, '.board');
    cpSync(a.dir, cDir, { recursive: true });
    expect(detectBoardModel(cDir, { env }).model).toBe('broken-host-link');

    const result = move(cRoot, env);

    expect(result).toMatchObject({
      action: 'repaired',
      model: 'host',
      created: false,
      joined: true,
      keptAt: null,
      oldRemoteUrl: null,
      sync: null,
    });
    expect(result.repair).toMatchObject({ method: 'fresh-worktree', source: 'remote' });
    expect(detectBoardModel(cDir, { env }).model).toBe('host');
    expect(eventFiles(cDir)).toEqual([`${hash}.json`]);
    expect(keptRepositories(cRoot)).toEqual([]);
  });

  it('an unlocked host-model worktree is locked again and reported unchanged', () => {
    const env = syncEnv();
    const { root, dir } = hostBoard(env);
    git(root, 'worktree', 'unlock', dir);

    const result = move(root, env);

    expect(result.action).toBe('unchanged');
    expect(result.message).toMatch(/lock/);
    expect(worktreeEntry(root, dir)?.locked).toBe(WORKTREE_LOCK_REASON);
  });
});
