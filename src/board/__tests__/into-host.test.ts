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

import fs, {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { canonicalDump, expectCheckClean } from '../../__tests__/harness/host-sync.js';
import { canonicalEncode, sha256Hex } from '../../events/canonical.js';
import { openBoard } from '../../store/board.js';
import { P, T1, T2, T3, ev, putEvent } from '../../store/__tests__/helpers.js';
import { AGENTBOARD_GIT_SUBDIR, BOARD_GITIGNORE_LINES, WORKTREE_LOCK_REASON } from '../host-init.js';
import { initBoard } from '../init.js';
import {
  MIGRATING_DIR,
  MIGRATING_REF,
  MoveSyncFailure,
  STANDALONE_KEPT_PREFIX,
  adoptMigratingWorktree,
  carryOverEventFiles,
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
  lockFile,
  migratingEntries,
  project,
  refEvents,
  standaloneInHostWithoutIgnore,
  standaloneProject,
  syncStandalone,
  syncedStandalone,
  untouched,
  withShellGitShim,
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
import { bareRemote, rebaseInProgress, revParse, syncEnv, unmerged, type Env } from './sync-helpers.js';

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

describe('carryOverEventFiles (step 5 and the rename window, ruling A)', () => {
  /** A valid event file: its canonical bytes under their hash. */
  function validEvent(text: string): { name: string; bytes: Buffer } {
    const bytes = Buffer.from(canonicalEncode(ev(P.comment(T1, text), 'w', 30_000)));
    return { name: `${sha256Hex(bytes)}.json`, bytes };
  }
  function dirWith(files: Record<string, Buffer | string>): string {
    const dir = join(tempDir(), 'events');
    mkdirSync(dir);
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
    return dir;
  }

  it('copies the missing files whose content hashes to their name, leaves present ones, reports nothing else', () => {
    const a = validEvent('a');
    const b = validEvent('b');
    const from = dirWith({ [a.name]: a.bytes, [b.name]: b.bytes, '.gitkeep': '', '.tmp-x': 'x' });
    const to = dirWith({ [a.name]: a.bytes });
    mkdirSync(join(from, 'sub'));

    expect(carryOverEventFiles(from, to)).toEqual({ copied: [b.name], mismatched: [] });

    expect(readFileSync(join(to, b.name))).toEqual(b.bytes);
    expect(readFileSync(join(to, a.name))).toEqual(a.bytes);
    expect(existsSync(join(to, '.tmp-x'))).toBe(false);
    expect(carryOverEventFiles(from, to)).toEqual({ copied: [], mismatched: [] });
  });

  it('never copies a file whose content does not hash to its name, never overwrites a differing copy, and reports both', () => {
    const a = validEvent('a');
    const bad = `${'f'.repeat(64)}.json`;
    const from = dirWith({ [a.name]: a.bytes, [bad]: '{"not":"hashed"}' });
    const to = dirWith({ [a.name]: 'other bytes' });

    expect(carryOverEventFiles(from, to)).toEqual({ copied: [], mismatched: [a.name, bad].sort() });

    expect(existsSync(join(to, bad))).toBe(false);
    expect(readFileSync(join(to, a.name), 'utf8')).toBe('other bytes');
    expect(carryOverEventFiles(join(tempDir(), 'nowhere'), to)).toEqual({ copied: [], mismatched: [] });
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

  it('in a linked worktree of a bare repository: exit 1 no-host-repository, the board beside the bare repository untouched', () => {
    const env = syncEnv();
    const parent = tempDir();
    const source = gitRepo(join(tempDir(), 'source'));
    const bare = join(parent, 'b.git');
    git(parent, 'clone', '-q', '--bare', source, bare);
    const linked = join(parent, 'bw');
    git(bare, 'worktree', 'add', '-q', linked, 'main');
    // Discovery puts the board beside the bare repository.
    const { dir } = syncedStandalone(parent, env, 1);
    const board = snapshotDir(dir);
    const before = [git(bare, 'for-each-ref'), git(bare, 'worktree', 'list', '--porcelain')];

    const err = expectBoardError(() => move(linked, env), 1, 'no-host-repository');

    expect(err.message).toMatch(/git repository/);
    expect(snapshotDir(dir)).toEqual(board);
    expect([git(bare, 'for-each-ref'), git(bare, 'worktree', 'list', '--porcelain')]).toEqual(before);
    expect(existsSync(join(bare, AGENTBOARD_GIT_SUBDIR))).toBe(false);
  });

  it('inside a submodule: exit 1 no-host-repository, nothing written in the superproject', () => {
    const env = syncEnv();
    const lib = gitRepo(join(tempDir(), 'lib'));
    const superproject = bareHost('super');
    git(superproject, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'lib');
    git(superproject, 'commit', '-q', '-m', 'add lib');
    const inside = join(superproject, 'lib');
    const modules = join(superproject, '.git', 'modules');
    // Discovery puts the board beside the submodule's git directory.
    const { dir } = syncedStandalone(modules, env, 1);
    const board = snapshotDir(dir);
    const state = (): unknown[] => [
      git(superproject, 'for-each-ref'),
      git(superproject, 'worktree', 'list', '--porcelain'),
      git(superproject, 'status', '--porcelain'),
      git(inside, 'for-each-ref'),
      git(inside, 'worktree', 'list', '--porcelain'),
    ];
    const before = state();

    const err = expectBoardError(() => move(inside, env), 1, 'no-host-repository');

    expect(err.message).toMatch(/git repository/);
    expect(snapshotDir(dir)).toEqual(board);
    expect(state()).toEqual(before);
    expect(existsSync(join(superproject, '.git', AGENTBOARD_GIT_SUBDIR))).toBe(false);
    expect(existsSync(join(modules, 'lib', AGENTBOARD_GIT_SUBDIR))).toBe(false);
  });

  it('no board: exit 2 board-not-found naming the directory, nothing written', () => {
    const env = syncEnv();
    const root = gitRepo(join(tempDir(), 'proj'));
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

  /**
   * Clone A published a host-model board whose `.gitignore` gained `foo`
   * and one event; clone B has a standalone board with one event whose
   * committed `.gitignore` gained `bar` instead. B's move stops on
   * `.gitignore`.
   */
  function conflictingClones(env: Env): {
    remote: string;
    boardRemote: string;
    bRoot: string;
    bDir: string;
    fromA: string;
    fromB: string[];
    before: ReturnType<typeof untouched>;
  } {
    const { root: aRoot, remote } = project('a');
    const a = hostBoard(env, aRoot);
    const fromA = commitHostEvent(a.dir, ev(P.create(T2, 'From A'), 'a', 2000), env);
    commitIgnoreLine(a.dir, 'foo');
    git(a.dir, 'update-ref', BOARD_REF, 'HEAD');
    pushBoardRef(a.root);
    const bRoot = cloneProject(remote, 'b');
    const bDir = standaloneBoard(bRoot);
    git(bDir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    const boardRemote = bareRemote();
    git(bDir, 'remote', 'add', 'origin', boardRemote);
    const fromB = writeEvents(bDir, 1);
    syncStandalone(bDir, env);
    commitIgnoreLine(bDir, 'bar');
    syncStandalone(bDir, env);
    return { remote, boardRemote, bRoot, bDir, fromA, fromB, before: untouched(bRoot, bDir) };
  }

  /** Resolves every stop of the rebase in `temporary` by keeping both lines, until it is finished. */
  function resolveIgnoreConflicts(temporary: string): string {
    const resolved = [...BOARD_GITIGNORE_LINES, 'foo', 'bar'].map((line) => `${line}\n`).join('');
    for (let step = 0; rebaseInProgress(temporary); step += 1) {
      expect(step).toBeLessThan(5);
      writeFileSync(join(temporary, '.gitignore'), resolved);
      git(temporary, 'add', '--', '.gitignore');
      try {
        git(temporary, '-c', 'core.editor=true', 'rebase', '--continue');
      } catch {
        // The next commit conflicts too; the loop resolves it.
      }
    }
    return resolved;
  }

  /** The registered worktrees of `root` under `agentboard/migrating/`. */
  function registeredMigrating(root: string): string[] {
    return worktrees(root)
      .split('\n')
      .filter((line) => line.startsWith('worktree ') && line.includes(`/${MIGRATING_DIR}/`))
      .map((line) => line.slice('worktree '.length));
  }

  it('scenario: Migration stopped on a conflict: exit 3 sync-conflict naming the temporary worktree and the human steps, the old .board untouched, nothing removed', () => {
    const env = syncEnv();
    const { bRoot, bDir, before } = conflictingClones(env);

    const err = expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');

    expect(err.message).toContain('.gitignore');
    expect(err.message).toContain(join(agentboardDir(bRoot), MIGRATING_DIR));
    expect(err.message).toContain('git rebase --continue');
    expect(err.message).toContain('agentboard init --into-host');
    expect(snapshotDir(bDir)).toEqual(before.board);
    expect(detectBoardModel(bDir, { env }).model).toBe('standalone');
    expect(refCommit(bRoot)).toBeNull();
    expect(refCommit(bRoot, MIGRATING_REF)).not.toBeNull();
    expect(keptRepositories(bRoot)).toEqual([]);
    const [temporary] = registeredMigrating(bRoot);
    expect(registeredMigrating(bRoot)).toHaveLength(1);
    expect(err.message).toContain(String(temporary));
    expect(rebaseInProgress(String(temporary))).toBe(true);
    expect(unmerged(String(temporary))).toEqual(['.gitignore']);
  });

  it('a re-run while the temporary worktree is still rebasing exits 3 sync-in-progress naming its path with the same steps, and removes nothing', () => {
    const env = syncEnv();
    const { bRoot, bDir, before } = conflictingClones(env);
    expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');
    const [temporary] = registeredMigrating(bRoot);
    const temporaryFiles = snapshotDir(String(temporary));
    const migratingRef = refCommit(bRoot, MIGRATING_REF);

    const again = expectBoardError(() => move(bRoot, env), 3, 'sync-in-progress');

    expect(again.message).toContain(String(temporary));
    expect(again.message).toContain('git rebase --continue');
    expect(again.message).toContain('agentboard init --into-host');
    expect(snapshotDir(bDir)).toEqual(before.board);
    expect(detectBoardModel(bDir, { env }).model).toBe('standalone');
    expect(refCommit(bRoot)).toBeNull();
    expect(refCommit(bRoot, MIGRATING_REF)).toBe(migratingRef);
    expect(registeredMigrating(bRoot)).toEqual([temporary]);
    expect(snapshotDir(String(temporary))).toEqual(temporaryFiles);
    expect(rebaseInProgress(String(temporary))).toBe(true);
    expect(migratingEntries(bRoot)).toHaveLength(1);
    expect(keptRepositories(bRoot)).toEqual([]);
  });

  it('scenario: Migration completes after the conflict is resolved: the re-run adopts the finished worktree and ends with every event', () => {
    const env = syncEnv();
    const { bRoot, bDir, fromA, fromB } = conflictingClones(env);
    const tip = revParse(bDir);
    const files = eventFiles(bDir);
    expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');
    const [temporary] = registeredMigrating(bRoot);
    // The human keeps both lines and continues until the rebase is finished;
    // both of B's commits stop on .gitignore, so the continue that applies
    // the first exits non-zero on the second, and the loop resolves again.
    const resolved = resolveIgnoreConflicts(String(temporary));
    expect(revParse(String(temporary))).not.toBe(refCommit(bRoot, MIGRATING_REF));

    const result = move(bRoot, env);

    expect(result).toMatchObject({ action: 'moved', model: 'host', joined: true, events: 2 });
    expectMoved(bRoot, env);
    expect(eventFiles(bDir)).toEqual([`${fromA}.json`, ...fromB.map((h) => `${h}.json`)].sort());
    expect(refEvents(bRoot)).toEqual(eventFiles(bDir));
    expect(readFileSync(join(bDir, '.gitignore'), 'utf8')).toBe(resolved);
    expect(existsSync(String(temporary))).toBe(false);
    expectKept(String(result.keptAt), tip, files);
    expectCheckClean(bRoot, env);
  });

  it('scenario: the conflict resolved while a third clone pushed to the old remote: the re-run adopts, integrates the new event and keeps the resolution (ruling A)', () => {
    const env = syncEnv();
    const { remote, boardRemote, bRoot, bDir, fromA, fromB } = conflictingClones(env);
    const tip = revParse(bDir);
    const files = eventFiles(bDir);
    expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');
    const [temporary] = registeredMigrating(bRoot);
    const resolved = resolveIgnoreConflicts(String(temporary));
    const resolvedHead = revParse(String(temporary));
    // Meanwhile a third clone, which has not moved, syncs an event to the old board remote.
    const c = cloneWithStandalone(remote, boardRemote, 'c');
    const [fromC] = writeEvents(c.dir, 1, 'c', 500);
    syncStandalone(c.dir, env);
    // And this clone's own standalone sync pulls it in.
    syncStandalone(bDir, env);
    expect(eventFiles(bDir)).toContain(`${String(fromC)}.json`);

    const result = move(bRoot, env);

    expect(result).toMatchObject({ action: 'moved', model: 'host', joined: true, events: 3 });
    expectMoved(bRoot, env);
    const all = [`${fromA}.json`, ...fromB.map((h) => `${h}.json`), `${String(fromC)}.json`].sort();
    expect(eventFiles(bDir)).toEqual(all);
    expect(refEvents(bRoot)).toEqual(all);
    expect(refEvents(remote)).toEqual(all);
    // The human's resolution is what the result descends from, not a replay of it.
    expect(isAncestor(bRoot, resolvedHead, BOARD_REF)).toBe(true);
    expect(readFileSync(join(bDir, '.gitignore'), 'utf8')).toBe(resolved);
    expect(existsSync(String(temporary))).toBe(false);
    // The kept repository is the standalone board as it was when the move ran: tip and its events.
    const [kept] = keptRepositories(bRoot);
    expect(revParse(String(kept))).not.toBe(tip);
    expect(eventFiles(String(kept))).toEqual([...files, `${String(fromC)}.json`].sort());
    expectCheckClean(bRoot, env);
  });

  it('an unreachable host remote: the move completes, exits 3 sync-failed carrying the kept path and the old remote, and the next sync publishes (ruling C)', () => {
    const env = syncEnv();
    const { root, remote, dir, boardRemote, tip } = standaloneProject(env, 2);
    const files = eventFiles(dir);
    git(root, 'remote', 'set-url', 'origin', join(tempDir(), 'gone.git'));

    const err = expectBoardError(() => move(root, env), 3, 'sync-failed');

    expect(err.message).toContain('origin');
    expect(err).toBeInstanceOf(MoveSyncFailure);
    const failure = err as MoveSyncFailure;
    const [kept] = keptRepositories(root);
    expect(failure.keptAt).toBe(kept);
    expect(failure.oldRemoteUrl).toBe(boardRemote);
    expect(err.message).toContain(String(kept));
    expect(err.message).toContain(boardRemote);
    expect(err.message).toContain(dir);
    expect(err.message).toMatch(/retire/);
    expectMoved(root, env);
    expect(isAncestor(root, tip, BOARD_REF)).toBe(true);
    expect(eventFiles(dir)).toEqual(files);

    git(root, 'remote', 'set-url', 'origin', remote);
    // The re-run resumes (the move's sync had not completed) and publishes.
    const resumed = move(root, env);
    expect(resumed).toMatchObject({ action: 'resumed', keptAt: kept, oldRemoteUrl: boardRemote });
    expect(resumed.sync).toMatchObject({ model: 'host', pushed: true });
    expect(git(remote, 'rev-parse', BOARD_REF).trim()).toBe(refCommit(root));
    expect(move(root, env).action).toBe('unchanged');
    expectMoved(root, env);
    expect(eventFiles(dir)).toEqual(files);
    expect(isAncestor(root, tip, BOARD_REF)).toBe(true);
    expectCheckClean(root, env);
  });
});

describe('step 5 and the rename window: events written during the move are carried over (ruling A)', () => {
  /** A valid event file written into `<dir>/events` by a shim at the moment `trigger` runs. */
  function eventWriter(dir: string, text: string): { name: string; bytes: Buffer; command: string } {
    const bytes = Buffer.from(canonicalEncode(ev(P.comment(T1, text), 'writer', 40_000)));
    const name = `${sha256Hex(bytes)}.json`;
    const source = join(tempDir(), name);
    writeFileSync(source, bytes);
    return { name, bytes, command: `cp '${source}' '${join(dir, 'events', name)}'` };
  }

  it('an event written into the old .board after the checks is carried over, committed by the sync and published', () => {
    const env = syncEnv();
    const { root, remote, dir, tip } = standaloneProject(env, 2);
    const files = eventFiles(dir);
    const late = eventWriter(dir, 'after the checks');
    // Lands after the compare-and-swap, before the carry-over of step 5.
    const writing = withGitShimBefore(env, ['update-ref', '-d', MIGRATING_REF], late.command);

    const result = move(root, writing);

    expect(result).toMatchObject({ action: 'moved', events: 3 });
    expectMoved(root, env);
    const all = [...files, late.name].sort();
    expect(eventFiles(dir)).toEqual(all);
    expect(refEvents(root)).toEqual(all);
    expect(refEvents(remote)).toEqual(all);
    expect(readFileSync(join(dir, 'events', late.name))).toEqual(late.bytes);
    expectKept(String(result.keptAt), tip, all);
    expectCheckClean(root, env);
  });

  it('a file whose content does not match its name: exit 5 integrity naming it, nothing moved, the temporary kept; a clean re-run moves', () => {
    const env = syncEnv();
    const { root, dir, tip } = standaloneProject(env, 2);
    const files = eventFiles(dir);
    const bad = `${'e'.repeat(64)}.json`;
    const corrupting = withGitShimBefore(
      env,
      ['update-ref', '-d', MIGRATING_REF],
      `echo '{"not":"hashed"}' > '${join(dir, 'events', bad)}'`,
    );

    const err = expectBoardError(() => move(root, corrupting), 5, 'integrity');

    expect(err.message).toContain(bad);
    expect(detectBoardModel(dir, { env }).model).toBe('standalone');
    expect(eventFiles(dir)).toEqual([...files, bad].sort());
    expect(keptRepositories(root)).toEqual([]);
    expect(migratingEntries(root)).toHaveLength(1);
    expect(worktrees(root)).toContain(`/${MIGRATING_DIR}/`);

    rmSync(join(dir, 'events', bad));
    const result = move(root, env);
    expect(result.action).toBe('moved');
    expectMoved(root, env);
    expect(eventFiles(dir)).toEqual(files);
    expectKept(String(result.keptAt), tip, files);
    expectCheckClean(root, env);
  });

  it('scenario: Event written during the move is carried over: one landing between the carry-over and the rename ends in the new worktree and the ref', () => {
    const env = syncEnv();
    const { root, remote, dir, tip } = standaloneProject(env, 2);
    const files = eventFiles(dir);
    const bytes = Buffer.from(canonicalEncode(ev(P.comment(T1, 'in the rename window'), 'writer', 41_000)));
    const name = `${sha256Hex(bytes)}.json`;
    // The rename of .board is the first thing that happens after the carry-over of step 5:
    // a writer lands an event just before it.
    const realRename = fs.renameSync;
    let landed = 0;
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike): void => {
      if (String(from) === dir && landed === 0) {
        landed += 1;
        writeFileSync(join(dir, 'events', name), bytes);
      }
      realRename(from, to);
    }) as typeof fs.renameSync;
    syncBuiltinESMExports();
    let result: IntoHostResult;
    try {
      result = move(root, env);
    } finally {
      fs.renameSync = realRename;
      syncBuiltinESMExports();
    }

    expect(landed).toBe(1);
    expect(result).toMatchObject({ action: 'moved', events: 3 });
    expectMoved(root, env);
    const all = [...files, name].sort();
    expect(eventFiles(dir)).toEqual(all);
    expect(refEvents(root)).toEqual(all);
    expect(refEvents(remote)).toEqual(all);
    expectKept(String(result.keptAt), tip, all);
    expectCheckClean(root, env);
  });
});

describe('refusals of steps 3 to 6 (ruling B, D and F)', () => {
  /** A host holding a local refs/agentboard/board with one event, from another repository. */
  function hostWithLocalRef(root: string, env: Env): { commit: string; hash: string; other: ReturnType<typeof hostBoard> } {
    const other = hostBoard(env);
    const hash = commitHostEvent(other.dir, ev(P.create(T2, 'From the host ref'), 'x', 2000), env);
    git(root, 'fetch', '-q', other.root, `${BOARD_REF}:${BOARD_REF}`);
    return { commit: String(refCommit(root)), hash, other };
  }

  it('the compare-and-swap lost in step 4: exit 3 sync-failed, .board and the host .gitignore untouched, the temporary kept; the re-run adopts it with the new events (one run)', () => {
    const env = syncEnv();
    const boardRemote = bareRemote();
    const { root, dir, tip } = standaloneInHostWithoutIgnore(env, 2, boardRemote);
    const files = eventFiles(dir);
    const other = hostBoard(env);
    const fromOther = commitHostEvent(other.dir, ev(P.create(T2, 'From the host ref'), 'x', 2000), env);
    git(root, 'fetch', '-q', other.root, `${BOARD_REF}:refs/test/other`);
    const otherCommit = git(root, 'rev-parse', 'refs/test/other').trim();
    const before = untouched(root, dir);
    // A hand fetch creates the ref between the read of its (empty) old value and the swap.
    const racing = withGitShimBefore(
      env,
      ['update-ref', BOARD_REF],
      `"$GIT" -C '${root}' update-ref ${BOARD_REF} ${otherCommit}`,
    );

    const err = expectBoardError(() => move(root, racing), 3, 'sync-failed');

    expect(err.message).toContain(BOARD_REF);
    expect(err.message).toContain('agentboard init --into-host');
    expect(snapshotDir(dir)).toEqual(before.board);
    expect(detectBoardModel(dir, { env }).model).toBe('standalone');
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
    expect(refCommit(root)).toBe(otherCommit);
    expect(keptRepositories(root)).toEqual([]);
    expect(migratingEntries(root)).toHaveLength(1);
    expect(worktrees(root)).toContain(`/${MIGRATING_DIR}/`);

    // One more standalone event, synced to the old remote, then the re-run.
    const [late] = writeEvents(dir, 1, 'late', 700);
    syncStandalone(dir, env);
    const newTip = revParse(dir);
    const result = move(root, env);
    expect(result).toMatchObject({ action: 'moved', joined: false, events: 4 });
    expectMoved(root, env);
    const all = [...files, `${fromOther}.json`, `${String(late)}.json`].sort();
    expect(eventFiles(dir)).toEqual(all);
    expect(refEvents(root)).toEqual(all);
    expect(isAncestor(root, otherCommit, BOARD_REF)).toBe(true);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('.board/\n');
    expect(result.hostGitignore).toBe(join(root, '.gitignore'));
    expectKept(String(result.keptAt), newTip, [...files, `${String(late)}.json`]);
    expect(tip).not.toBe(newTip);
    expectCheckClean(root, env);
  });

  it('the old value of the compare-and-swap is read before the rebases: a ref moved during the rebase loses the swap', () => {
    const env = syncEnv();
    const { root, dir } = standaloneProject(env, 2);
    const { commit: c1, other } = hostWithLocalRef(root, env);
    commitHostEvent(other.dir, ev(P.comment(T2, 'second'), 'x', 2100), env);
    git(root, 'fetch', '-q', other.root, `${BOARD_REF}:refs/test/c2`);
    const c2 = git(root, 'rev-parse', 'refs/test/c2').trim();
    const before = untouched(root, dir);
    // The ref moves from c1 to c2 while the rebase onto it runs.
    const racing = withGitShimBefore(
      env,
      ['rebase', '--no-verify', BOARD_REF],
      `"$GIT" -C '${root}' update-ref ${BOARD_REF} ${c2} ${c1}`,
    );

    expectBoardError(() => move(root, racing), 3, 'sync-failed');

    expect(refCommit(root)).toBe(c2);
    expect(snapshotDir(dir)).toEqual(before.board);
    expect(keptRepositories(root)).toEqual([]);

    const result = move(root, env);
    expect(result.action).toBe('moved');
    expectMoved(root, env);
    expect(isAncestor(root, c2, BOARD_REF)).toBe(true);
    expect(eventFiles(dir)).toHaveLength(4);
    expectCheckClean(root, env);
  });

  it('a rebase that fails without a conflict: exit 3 sync-failed quoting git, .board untouched, the temporary removed; the re-run moves', () => {
    const env = syncEnv();
    const { root, dir, tip } = standaloneProject(env, 2);
    const files = eventFiles(dir);
    const { commit, hash } = hostWithLocalRef(root, env);
    const before = untouched(root, dir);
    // An untracked file in the temporary worktree that the rebase would overwrite.
    const blocking = withGitShimBefore(
      env,
      ['rebase', '--no-verify', BOARD_REF],
      `for d in '${join(agentboardDir(root), MIGRATING_DIR)}'/*/events; do echo other > "$d/${hash}.json"; done`,
    );

    const err = expectBoardError(() => move(root, blocking), 3, 'sync-failed');

    expect(err.message).toMatch(/untracked|overwritten/);
    expect(snapshotDir(dir)).toEqual(before.board);
    expect(detectBoardModel(dir, { env }).model).toBe('standalone');
    expect(refCommit(root)).toBe(commit);
    expect(refCommit(root, MIGRATING_REF)).toBeNull();
    expect(migratingEntries(root)).toEqual([]);
    expect(worktrees(root)).not.toContain(`/${MIGRATING_DIR}/`);
    expect(keptRepositories(root)).toEqual([]);

    const result = move(root, env);
    expect(result.action).toBe('moved');
    expectMoved(root, env);
    expect(eventFiles(dir)).toEqual([...files, `${hash}.json`].sort());
    expectKept(String(result.keptAt), tip, files);
    expectCheckClean(root, env);
  });

  it('a fetch of the host remote ref that fails after ls-remote listed it: exit 3 sync-failed naming the remote, .board untouched, the temporary removed; the re-run joins', () => {
    const env = syncEnv();
    const { root: aRoot, remote } = project('a');
    const a = hostBoard(env, aRoot);
    const fromA = commitHostEvent(a.dir, ev(P.create(T2, 'From A'), 'a', 2000), env);
    pushBoardRef(a.root);
    const bRoot = cloneProject(remote, 'b');
    const { dir, tip } = syncedStandalone(bRoot, env, 2);
    const files = eventFiles(dir);
    const before = untouched(bRoot, dir);
    const away = `${remote}.away`;
    const breaking = withGitShimBefore(
      env,
      ['fetch', '--no-tags', 'origin', BOARD_REF],
      `mv '${remote}' '${away}'`,
    );

    const err = expectBoardError(() => move(bRoot, breaking), 3, 'sync-failed');

    expect(err.message).toContain('origin');
    expect(err.message).toContain(BOARD_REF);
    expect(snapshotDir(dir)).toEqual(before.board);
    expect(detectBoardModel(dir, { env }).model).toBe('standalone');
    expect(refCommit(bRoot)).toBeNull();
    expect(migratingEntries(bRoot)).toEqual([]);
    expect(keptRepositories(bRoot)).toEqual([]);

    fs.renameSync(away, remote);
    const result = move(bRoot, env);
    expect(result).toMatchObject({ action: 'moved', joined: true });
    expectMoved(bRoot, env);
    expect(eventFiles(dir)).toEqual([...files, `${fromA}.json`].sort());
    expectKept(String(result.keptAt), tip, files);
    expectCheckClean(bRoot, env);
  });

  it('.board replaced by another repository before the rename: exit 3 sync-failed, nothing kept aside, the replacement untouched (ruling B)', () => {
    const env = syncEnv();
    const { root, dir, tip } = standaloneProject(env, 2);
    const aside = `${dir}-aside`;
    // Between the compare-and-swap and the rename, .board becomes a clone of itself: another git directory.
    const swapping = withGitShimBefore(
      env,
      ['update-ref', '-d', MIGRATING_REF],
      `mv '${dir}' '${aside}' && "$GIT" clone -q '${aside}' '${dir}'`,
    );

    const err = expectBoardError(() => move(root, swapping), 3, 'sync-failed');

    expect(err.message).toContain(dir);
    expect(err.message).toContain('agentboard init --into-host');
    expect(keptRepositories(root)).toEqual([]);
    expect(detectBoardModel(dir, { env }).model).toBe('standalone');
    expect(revParse(dir)).toBe(tip);
    expect(git(dir, 'remote', 'get-url', 'origin').trim()).toBe(aside);
    expect(worktreeEntry(root, dir)).toBeNull();
    expect(migratingEntries(root)).toHaveLength(1);
  });

  it('the init lock mtime is refreshed before each network step, so a stalled move is not stale at 60 s (ruling B)', () => {
    const env = syncEnv();
    const { root } = standaloneProject(env, 1);
    const lock = lockFile(root);
    const log = join(tempDir(), 'lock-times');
    mkdirSync(log);
    const stalling = withShellGitShim(
      env,
      [
        'case " $* " in',
        `  *":${MIGRATING_REF}"*) date -r '${lock}' +%s > '${log}/start'; sleep 2 ;;`,
        `  *" ls-remote "*) [ -e '${log}/net' ] || date -r '${lock}' +%s > '${log}/net' ;;`,
        `  *" worktree move "*) sleep 2 ;;`,
        `  *" push --porcelain "*) date -r '${lock}' +%s > '${log}/push' ;;`,
        'esac',
      ].join('\n'),
    );

    expect(move(root, stalling).action).toBe('moved');

    const at = (name: string): number => Number(readFileSync(join(log, name), 'utf8').trim());
    expect(at('net') - at('start')).toBeGreaterThanOrEqual(2);
    expect(at('push') - at('start')).toBeGreaterThanOrEqual(4);
    expect(existsSync(lock)).toBe(false);
  });

  it('the final push losing the create race on the remote (reference already exists) is retried once and succeeds', () => {
    const env = syncEnv();
    const { root, remote, dir } = standaloneProject(env, 2);
    const files = eventFiles(dir);
    // The remote's update hook creates the ref with the pushed commit before
    // receive-pack's own update, once: the push sees the ref it was told
    // did not exist, exactly as a push received at the same time leaves it.
    const hooks = join(remote, 'hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(
      join(hooks, 'update'),
      [
        '#!/bin/sh',
        `if [ "$1" = ${BOARD_REF} ] && [ ! -e "$GIT_DIR/hooked" ]; then`,
        '  : > "$GIT_DIR/hooked"',
        '  git update-ref "$1" "$3"',
        'fi',
        'exit 0',
        '',
      ].join('\n'),
    );
    chmodSync(join(hooks, 'update'), 0o755);
    const log = join(tempDir(), 'pushes.log');
    const recording = withShellGitShim(
      env,
      [
        'case " $* " in',
        '  *" push --porcelain "*)',
        `    out=$(mktemp); err=$(mktemp); "$GIT" "$@" > "$out" 2> "$err"; status=$?`,
        `    { echo "== push"; cat "$out"; cat "$err"; } >> '${log}'`,
        '    cat "$out"; cat "$err" >&2; exit $status ;;',
        'esac',
      ].join('\n'),
    );

    const result = move(root, recording);

    expect(result).toMatchObject({ action: 'moved' });
    expect(result.sync).toMatchObject({ pushed: true });
    const pushes = readFileSync(log, 'utf8').split('== push').filter((p) => p.trim() !== '');
    expect(pushes).toHaveLength(2);
    expect(pushes[0]).toMatch(/\[remote rejected\]|\[rejected\]/);
    expect(pushes[0]).toMatch(/reference already exists|failed to (update|lock)|cannot lock ref|incorrect old value/);
    expect(git(remote, 'rev-parse', BOARD_REF).trim()).toBe(refCommit(root));
    expect(refEvents(remote)).toEqual(files);
    expectMoved(root, env);
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
    const rebasing = temporary(root, DEAD_PID + 1, commit);
    mkdirSync(join(git(rebasing, 'rev-parse', '--absolute-git-dir').trim(), 'rebase-merge'));

    const found = findMigratingWorktrees(root, { env });

    expect(found.map((w) => w.path)).toEqual([plain, dead, alive, junk, rebasing].sort());
    expect(found.find((w) => w.path === dead)).toEqual({
      path: dead,
      pid: DEAD_PID,
      alive: false,
      registered: true,
      head: commit,
      rebasing: false,
    });
    expect(found.find((w) => w.path === rebasing)).toMatchObject({
      pid: DEAD_PID + 1,
      alive: false,
      registered: true,
      rebasing: true,
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
      rebasing: false,
    });
    expect(found.find((w) => w.path === junk)).toMatchObject({
      pid: null,
      alive: false,
      registered: false,
      head: null,
      rebasing: false,
    });
    expect(findMigratingWorktrees(bareHost('empty'), { env })).toEqual([]);
  });

  it('removeDeadMigratingWorktrees removes only dead-pid leftovers with nothing in them, keeps a live, a rebasing and a rebased one, and reports what it removed', () => {
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
    const rebasing = temporary(root, DEAD_PID + 1, commit);
    mkdirSync(join(git(rebasing, 'rev-parse', '--absolute-git-dir').trim(), 'rebase-merge'));
    const rebased = temporary(root, DEAD_PID + 2, commit);
    writeFileSync(join(rebased, 'events', 'x'), '');
    git(rebased, 'add', '-A');
    git(rebased, 'commit', '-q', '--no-verify', '-m', 'a finished rebase');

    const removed = removeDeadMigratingWorktrees(root, { env });

    expect(removed).toEqual([plain, dead, junk].sort());
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(plain)).toBe(false);
    expect(existsSync(junk)).toBe(false);
    expect(existsSync(alive)).toBe(true);
    expect(existsSync(rebasing)).toBe(true);
    expect(existsSync(rebased)).toBe(true);
    expect(worktreeEntry(root, dead)).toBeNull();
    expect(worktreeEntry(root, alive)).not.toBeNull();
    expect(worktreeEntry(root, rebasing)).not.toBeNull();
    expect(worktreeEntry(root, rebased)).not.toBeNull();
    // Moves still in flight, stopped or finished keep the temporary ref.
    expect(refCommit(root, MIGRATING_REF)).toBe(commit);
    expect(refCommit(root)).toBe(commit);

    for (const path of [alive, rebasing, rebased]) {
      git(root, 'worktree', 'remove', '--force', '--force', path);
      rmSync(path, { recursive: true, force: true });
    }
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

    const stopped = hostWithRefOnly(env);
    const stoppedTemp = temporary(stopped.root, DEAD_PID, stopped.commit);
    mkdirSync(join(git(stoppedTemp, 'rev-parse', '--absolute-git-dir').trim(), 'rebase-merge'));
    expect(adoptMigratingWorktree(stopped.root, stopped.dir, { env })).toBe(false);
    expect(existsSync(stopped.dir)).toBe(false);
    expect(existsSync(stoppedTemp)).toBe(true);
  });

  it('a leftover temporary worktree of a dead move beside a standalone .board is removed and the move starts again, naming it', () => {
    const env = syncEnv();
    const { root, dir, tip } = standaloneProject(env, 2);
    const files = eventFiles(dir);
    git(root, 'update-ref', MIGRATING_REF, 'HEAD');
    const leftover = temporary(root, DEAD_PID, MIGRATING_REF);

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

describe('resuming after the worktree is in place, and cleaning dead temporaries (ruling E)', () => {
  it('a move killed between the worktree move and the end of its sync is resumed with the sync, carrying over what the kept repository gained', () => {
    const env = syncEnv();
    const { root, remote, dir, boardRemote } = standaloneProject(env, 2);
    const first = move(root, env);
    expect(first.action).toBe('moved');
    const kept = String(first.keptAt);
    // The state a kill after the worktree move leaves: the lock not yet set,
    // the migrating marker still there, nothing published, and an event
    // that landed in the old directory in the rename window.
    git(root, 'worktree', 'unlock', dir);
    mkdirSync(join(agentboardDir(root), MIGRATING_DIR), { recursive: true });
    git(remote, 'update-ref', '-d', BOARD_REF);
    const [late] = writeEvents(kept, 1, 'late', 800);
    const files = [...eventFiles(dir), `${String(late)}.json`].sort();

    const result = move(root, env);

    expect(result).toMatchObject({ action: 'resumed', keptAt: kept, oldRemoteUrl: boardRemote, events: 3 });
    expect(result.sync).toMatchObject({ model: 'host', pushed: true });
    expect(result.message).toContain(kept);
    expectMoved(root, env);
    expect(eventFiles(dir)).toEqual(files);
    expect(refEvents(root)).toEqual(files);
    expect(git(remote, 'rev-parse', BOARD_REF).trim()).toBe(refCommit(root));
    expect(existsSync(join(agentboardDir(root), MIGRATING_DIR))).toBe(false);
    expect(move(root, env).action).toBe('unchanged');
    expectCheckClean(root, env);
  });

  it('plain init on a host-model board removes dead temporaries without rebase state, keeps a stopped one, and touches nothing else', () => {
    const env = syncEnv();
    const { root, dir, commit } = hostBoard(env);
    const hash = commitHostEvent(dir, ev(P.create(T3, 'Kept'), 'orch', 1000), env);
    const base = join(agentboardDir(root), MIGRATING_DIR);
    mkdirSync(base, { recursive: true });
    const dead = join(base, String(DEAD_PID));
    git(root, 'worktree', 'add', '-q', '--detach', dead, BOARD_REF);
    const stopped = join(base, String(DEAD_PID + 1));
    git(root, 'worktree', 'add', '-q', '--detach', stopped, commit);
    mkdirSync(join(git(stopped, 'rev-parse', '--absolute-git-dir').trim(), 'rebase-merge'));
    const plain = join(base, '123');
    mkdirSync(plain);
    const before = [refCommit(root), snapshotDir(dir), worktreeEntry(root, dir)];

    const result = initBoard({ cwd: root, env });

    expect(result).toMatchObject({ created: false, model: 'host', repair: null });
    expect(result.message).toContain(dead);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(plain)).toBe(false);
    expect(worktreeEntry(root, dead)).toBeNull();
    expect(existsSync(stopped)).toBe(true);
    expect(worktreeEntry(root, stopped)).not.toBeNull();
    expect([refCommit(root), snapshotDir(dir), worktreeEntry(root, dir)]).toEqual(before);
    expect(eventFiles(dir)).toEqual([`${hash}.json`]);

    // init --into-host on the same board does the same, and the empty directory goes once the last one is gone.
    git(root, 'worktree', 'remove', '--force', '--force', stopped);
    rmSync(stopped, { recursive: true, force: true });
    const again = move(root, env);
    expect(again.action).toBe('unchanged');
    expect(existsSync(base)).toBe(false);
    expect(eventFiles(dir)).toEqual([`${hash}.json`]);
  });

  it('a temporary named by the running process own pid counts as dead for the move (ruling G)', () => {
    const env = syncEnv();
    const { root, dir, tip } = standaloneProject(env, 2);
    const files = eventFiles(dir);
    git(root, 'update-ref', MIGRATING_REF, 'HEAD');
    const own = join(agentboardDir(root), MIGRATING_DIR, String(process.pid));
    mkdirSync(join(agentboardDir(root), MIGRATING_DIR), { recursive: true });
    git(root, 'worktree', 'add', '-q', '--detach', own, MIGRATING_REF);
    const stamp = new Date(Date.now() - 120_000);
    utimesSync(own, stamp, stamp);

    const result = move(root, env);

    expect(result.action).toBe('moved');
    expect(result.message).toContain(own);
    expectMoved(root, env);
    expect(eventFiles(dir)).toEqual(files);
    expectKept(String(result.keptAt), tip, files);
  });
});
