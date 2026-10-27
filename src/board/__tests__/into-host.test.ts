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
  MIGRATING_FETCH_REF,
  MIGRATING_REF,
  MoveSyncFailure,
  STANDALONE_KEPT_PREFIX,
  adoptMigratingWorktree,
  carryOverEventFiles,
  cleanDeadMigratingWorktrees,
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
  cherryPickInProgress,
  cloneProject,
  cloneWithStandalone,
  conflictingClones,
  eventFiles,
  expectKept,
  expectMoved,
  expectUntouched,
  keptRepositories,
  lateEventFile,
  lockFile,
  migratingEntries,
  project,
  refEvents,
  registeredMigrating,
  resolveCherryPickConflicts,
  resolveIgnoreConflicts,
  sequencerInProgress,
  standaloneInHostWithoutIgnore,
  standaloneProject,
  syncStandalone,
  syncedStandalone,
  thirdCloneRewritesIgnore,
  thirdCloneRewritesIgnoreOnly,
  thirdCloneRewritesIgnoreThenEvent,
  untouched,
  withShellGitShim,
  writeEvents,
  type ConflictingClones,
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
  withRecordingGitShim,
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
    expect(MIGRATING_FETCH_REF).toBe('refs/agentboard/migrating-fetch');
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

  // The conflict fixture (`conflictingClones` in into-host-helpers.ts) gives
  // A and B a shared history, as two clones of one board have: the merge
  // base of B's temporary worktree and B's source tip is the first sync
  // commit, so a replay based on it would apply B's conflicting commit a
  // second time (reviewer-5 round 2). The two completion tests below pin
  // that the re-run after the human's resolution never does.
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

  it('scenario: Migration completes after the conflict is resolved (shared history): one re-run, exit 0, every event, the resolution kept, no replay and no second conflict', () => {
    const env = syncEnv();
    const { aRoot, bRoot, bDir, shared, fromA, fromB } = conflictingClones(env);
    const tip = revParse(bDir);
    const files = eventFiles(bDir);
    expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');
    const [temporary] = registeredMigrating(bRoot);
    // The human keeps both lines and continues until the rebase is finished.
    const resolved = resolveIgnoreConflicts(String(temporary));
    const resolvedHead = revParse(String(temporary));
    expect(resolvedHead).not.toBe(refCommit(bRoot, MIGRATING_REF));
    // Nothing reached the standalone board since: the source tip the re-run
    // fetches equals the value the temporary was made from.
    const sourceBefore = refCommit(bRoot, MIGRATING_REF);
    const { env: recording, calls } = withRecordingGitShim(env);

    const result = move(bRoot, recording);

    expect(result).toMatchObject({ action: 'moved', model: 'host', joined: true, events: 3 });
    expect(refCommit(bRoot)).not.toBeNull();
    expectMoved(bRoot, env);
    const all = [...shared, `${fromA}.json`, ...fromB.map((h) => `${h}.json`)].sort();
    expect(eventFiles(bDir)).toEqual(all);
    expect(refEvents(bRoot)).toEqual(all);
    expect(readFileSync(join(bDir, '.gitignore'), 'utf8')).toBe(resolved);
    // The human's resolution is what the result descends from; with the tip
    // unchanged the re-run replayed nothing onto it (no cherry-pick, no
    // --onto rebase, never a --root one), and B's conflicting commit appears once.
    expect(isAncestor(bRoot, resolvedHead, BOARD_REF)).toBe(true);
    expect(refCommit(bRoot)).toBe(resolvedHead);
    expect(
      calls().filter((c) => c.includes('cherry-pick') || c.includes('--onto') || c.includes('--root')),
    ).toEqual([]);
    expect(git(bRoot, 'log', '--format=%s', BOARD_REF).split('\n').filter((s) => s === 'ignore bar')).toHaveLength(1);
    expect(isAncestor(bRoot, String(sourceBefore), BOARD_REF)).toBe(false);
    expect(isAncestor(bRoot, String(refCommit(aRoot)), BOARD_REF)).toBe(true);
    expect(existsSync(String(temporary))).toBe(false);
    expectKept(String(result.keptAt), tip, files);
    expectCheckClean(bRoot, env);
  });

  it('scenario: the conflict resolved while a third clone pushed to the old remote (shared history): one re-run replays only the new commit, based on the old temporary ref value, and keeps the resolution (ruling A)', () => {
    const env = syncEnv();
    const { remote, boardRemote, bRoot, bDir, shared, fromA, fromB } = conflictingClones(env);
    const tip = revParse(bDir);
    const files = eventFiles(bDir);
    expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');
    const [temporary] = registeredMigrating(bRoot);
    const resolved = resolveIgnoreConflicts(String(temporary));
    const resolvedHead = revParse(String(temporary));
    const sourceBefore = String(refCommit(bRoot, MIGRATING_REF));
    // Meanwhile a third clone, which has not moved, syncs an event to the old board remote.
    const c = cloneWithStandalone(remote, boardRemote, 'c');
    const [fromC] = writeEvents(c.dir, 1, 'c', 500);
    syncStandalone(c.dir, env);
    // And this clone's own standalone sync pulls it in: the new tip descends from the old one.
    syncStandalone(bDir, env);
    expect(eventFiles(bDir)).toContain(`${String(fromC)}.json`);
    expect(isAncestor(bDir, sourceBefore, 'HEAD')).toBe(true);
    expect(revParse(bDir)).not.toBe(sourceBefore);
    const { env: recording, calls } = withRecordingGitShim(env);

    const result = move(bRoot, recording);

    expect(result).toMatchObject({ action: 'moved', model: 'host', joined: true, events: 4 });
    expectMoved(bRoot, env);
    const all = [...shared, `${fromA}.json`, ...fromB.map((h) => `${h}.json`), `${String(fromC)}.json`].sort();
    expect(eventFiles(bDir)).toEqual(all);
    expect(refEvents(bRoot)).toEqual(all);
    expect(refEvents(remote)).toEqual(all);
    // The human's resolution is what the result descends from, not a replay
    // of it: the replay was a cherry-pick of the commits between the tip the
    // worktree integrated (refs/agentboard/migrating, an ancestor of the
    // fresh tip) and the fresh tip in refs/agentboard/migrating-fetch, never
    // a rebase --onto, never from the merge base or --root, so only C's
    // commit was applied on top and B's conflicting commit appears once.
    expect(isAncestor(bRoot, resolvedHead, BOARD_REF)).toBe(true);
    const replays = calls().filter((c) => c.includes('cherry-pick') && !c.includes('--skip'));
    expect(replays).toHaveLength(1);
    expect(replays[0]).toContain(`${sourceBefore}..${MIGRATING_FETCH_REF}`);
    expect(calls().filter((c) => c.includes('--onto') || c.includes('--root'))).toEqual([]);
    expect(calls().filter((c) => c.includes(`:${MIGRATING_REF} `) || c.endsWith(`:${MIGRATING_REF}`))).toEqual([]);
    expect(git(bRoot, 'log', '--format=%s', BOARD_REF).split('\n').filter((s) => s === 'ignore bar')).toHaveLength(1);
    expect(readFileSync(join(bDir, '.gitignore'), 'utf8')).toBe(resolved);
    expect(existsSync(String(temporary))).toBe(false);
    // The kept repository is the standalone board as it was when the move ran: tip and its events.
    const [kept] = keptRepositories(bRoot);
    expect(revParse(String(kept))).not.toBe(tip);
    expect(eventFiles(String(kept))).toEqual([...files, `${String(fromC)}.json`].sort());
    expectCheckClean(bRoot, env);
  });

  it('a replay that conflicts (a third clone rewrote the resolved .gitignore line): exit 3 sync-conflict naming git cherry-pick --continue; a re-run is sync-in-progress; git cherry-pick --abort returns to the resolved HEAD and the next re-run keeps it (round 4 ruling 2)', () => {
    const env = syncEnv();
    const fx = conflictingClones(env);
    const { bRoot, bDir } = fx;
    expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');
    const [temporary] = registeredMigrating(bRoot);
    resolveIgnoreConflicts(String(temporary));
    const resolvedHead = revParse(String(temporary));
    const integrated = String(refCommit(bRoot, MIGRATING_REF));
    const { fromD } = thirdCloneRewritesIgnore(fx, env);
    // Step 1 of the move fetches the old remote's branch into the board's
    // remote-tracking ref (D's push); the snapshot is taken after that same
    // fetch, so it pins that the working tree, HEAD and the board's own refs
    // are untouched by the refusal.
    git(bDir, 'fetch', '--no-tags', '--no-write-fetch-head', 'origin', '+refs/heads/main:refs/remotes/origin/main');
    const before = untouched(bRoot, bDir);

    const err = expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');

    expect(err.message).toContain('.gitignore');
    expect(err.message).toContain(String(temporary));
    expect(err.message).toContain('git cherry-pick --continue');
    expect(err.message).toContain('agentboard init --into-host');
    expect(err.message).not.toContain('git rebase --continue');
    expect(cherryPickInProgress(String(temporary))).toBe(true);
    expect(unmerged(String(temporary))).toEqual(['.gitignore']);
    // The resolution is still the ancestor of the worktree's HEAD (D's event
    // commit landed on it; its .gitignore commit is the one stopped on), and
    // refs/agentboard/migrating still records the tip the worktree integrated.
    expect(isAncestor(String(temporary), resolvedHead, 'HEAD')).toBe(true);
    expect(refCommit(bRoot, MIGRATING_REF)).toBe(integrated);
    expect(refCommit(bRoot, MIGRATING_FETCH_REF)).not.toBe(integrated);
    expect(snapshotDir(bDir)).toEqual(before.board);
    expect(refCommit(bRoot)).toBeNull();
    expect(keptRepositories(bRoot)).toEqual([]);

    const again = expectBoardError(() => move(bRoot, env), 3, 'sync-in-progress');
    expect(again.message).toContain(String(temporary));
    expect(again.message).toContain('git cherry-pick --continue');
    // The steps for a pick git reports as empty are named too: --skip drops
    // it, git commit --allow-empty keeps it (round 5 ruling 2, round 6 ruling 1).
    expect(again.message).toContain('git cherry-pick --skip');
    expect(again.message).toContain('git cherry-pick --abort');
    expect(again.message).toContain('git commit --allow-empty');
    expect(again.message).toContain('agentboard init --into-host');
    expect(again.message).not.toContain('git rebase --continue');
    expect(registeredMigrating(bRoot)).toEqual([temporary]);
    expect(cherryPickInProgress(String(temporary))).toBe(true);
    expect(refCommit(bRoot, MIGRATING_REF)).toBe(integrated);

    // A resolution staged but not continued is a human's work in progress
    // (nothing unmerged, the index differs from HEAD): still the refusal,
    // never quit or replayed over (round 5 ruling 2).
    const halfway = revParse(String(temporary));
    writeFileSync(join(String(temporary), '.gitignore'), [...BOARD_GITIGNORE_LINES, 'foo', 'baz', 'bar'].map((l) => `${l}\n`).join(''));
    git(String(temporary), 'add', '--', '.gitignore');
    expect(unmerged(String(temporary))).toEqual([]);
    const staged = expectBoardError(() => move(bRoot, env), 3, 'sync-in-progress');
    expect(staged.message).toContain('git cherry-pick --continue');
    expect(staged.message).toContain('git cherry-pick --skip');
    expect(staged.message).toContain('git commit --allow-empty');
    expect(cherryPickInProgress(String(temporary))).toBe(true);
    expect(revParse(String(temporary))).toBe(halfway);
    expect(git(String(temporary), 'diff', '--cached', '--name-only')).toContain('.gitignore');
    expect(refCommit(bRoot, MIGRATING_REF)).toBe(integrated);

    // The human gives up on this replay: the worktree is back at the resolution,
    // and the next run adopts it again (the resolution never discarded) and
    // stops on the same conflict, D's event still waiting in the fresh tip.
    git(String(temporary), 'cherry-pick', '--abort');
    git(String(temporary), 'checkout', '--', '.gitignore');
    expect(git(String(temporary), 'status', '--porcelain')).toBe('');
    expect(revParse(String(temporary))).toBe(resolvedHead);
    const third = expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');
    expect(third.message).toContain('git cherry-pick --continue');
    expect(registeredMigrating(bRoot)).toEqual([temporary]);
    expect(isAncestor(String(temporary), resolvedHead, 'HEAD')).toBe(true);
    expect(cherryPickInProgress(String(temporary))).toBe(true);
    expect(refCommit(bRoot)).toBeNull();
    expect(detectBoardModel(bDir, { env }).model).toBe('standalone');
    expect(eventFiles(bDir)).not.toContain(`${fromD}.json`);
    expect(keptRepositories(bRoot)).toEqual([]);
  });

  it('a replay conflict resolved by keeping our side (an empty pick, skipped): the re-run counts the tip as integrated and completes with every event, the resolution kept (round 6 ruling 1)', () => {
    const env = syncEnv();
    const fx = conflictingClones(env);
    const { remote, bRoot, bDir, shared, fromA, fromB } = fx;
    expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');
    const [temporary] = registeredMigrating(bRoot);
    const resolved = resolveIgnoreConflicts(String(temporary));
    const resolvedHead = revParse(String(temporary));
    // D's only commit rewrites the resolved line and adds no event.
    thirdCloneRewritesIgnoreOnly(fx, env);
    const freshTip = revParse(bDir, 'refs/remotes/origin/main');
    expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');
    expect(cherryPickInProgress(String(temporary))).toBe(true);
    // The human keeps B's side: git reports the pick empty on --continue
    // and the human skips it, as the message says; HEAD is the resolution.
    git(String(temporary), 'checkout', '--ours', '--', '.gitignore');
    git(String(temporary), 'add', '--', '.gitignore');
    try {
      git(String(temporary), '-c', 'core.editor=true', 'cherry-pick', '--continue');
    } catch {
      // The pick is empty: git refuses to continue and names --skip.
    }
    git(String(temporary), 'cherry-pick', '--skip');
    expect(cherryPickInProgress(String(temporary))).toBe(false);
    expect(sequencerInProgress(String(temporary))).toBe(false);
    expect(revParse(String(temporary))).toBe(resolvedHead);
    expect(git(String(temporary), 'status', '--porcelain')).toBe('');
    const { env: recording, calls } = withRecordingGitShim(env);

    const result = move(bRoot, recording);

    expect(result).toMatchObject({ action: 'moved', model: 'host', joined: true, events: 3 });
    expectMoved(bRoot, env);
    const all = [...shared, `${fromA}.json`, ...fromB.map((h) => `${h}.json`)].sort();
    expect(eventFiles(bDir)).toEqual(all);
    expect(refEvents(bRoot)).toEqual(all);
    expect(refEvents(remote)).toEqual(all);
    expect(readFileSync(join(bDir, '.gitignore'), 'utf8')).toBe(resolved);
    expect(isAncestor(bRoot, resolvedHead, BOARD_REF)).toBe(true);
    // D's rewrite was dropped by the human, once: no second replay of it.
    expect(calls().filter((c) => c.includes('cherry-pick'))).toEqual([]);
    expect(isAncestor(bRoot, freshTip, BOARD_REF)).toBe(false);
    expect(git(bRoot, 'log', '--format=%s', BOARD_REF).split('\n').filter((s) => s === 'ignore baz')).toEqual([]);
    expect(existsSync(String(temporary))).toBe(false);
    expectCheckClean(bRoot, env);
  });

  /**
   * The assertions a dirty adopted worktree's refusal must satisfy (round
   * 6 ruling 2 and the orchestrator's ruling on the sequencer case): with
   * git's sequencer still present it is a human's conflict in progress,
   * exit 3 sync-in-progress naming the worktree and the cherry-pick steps;
   * with no cherry-pick state left it is exit 3 sync-failed naming the
   * worktree, the file and the checkout step. Either way nothing is quit,
   * replayed, dropped or published, and the next run refuses the same way.
   */
  function expectDirtyWorktreeRefused(
    fx: ConflictingClones,
    temporary: string,
    state: { halfway: string; resolvedHead: string; integrated: string; published: string; fromD?: string },
    sequencerStays: boolean,
  ): void {
    const { remote, bRoot, bDir } = fx;
    const env = syncEnv();
    const before = untouched(bRoot, bDir);
    const reason = sequencerStays ? 'sync-in-progress' : 'sync-failed';

    const err = expectBoardError(() => move(bRoot, env), 3, reason);

    expect(err.message).toContain(temporary);
    expect(err.message).toContain('agentboard init --into-host');
    if (sequencerStays) {
      expect(err.message).toContain('git cherry-pick --continue');
      expect(err.message).toContain('git cherry-pick --skip');
      expect(err.message).toContain('git cherry-pick --abort');
      expect(err.message).not.toContain('git rebase --continue');
    } else {
      expect(err.message).toContain('.gitignore');
      expect(err.message).toContain('checkout -- ');
    }
    expect(registeredMigrating(bRoot)).toEqual([temporary]);
    expect(sequencerInProgress(temporary)).toBe(sequencerStays);
    expect(revParse(temporary)).toBe(state.halfway);
    expect(isAncestor(temporary, state.resolvedHead, 'HEAD')).toBe(true);
    expect(readFileSync(join(temporary, '.gitignore'), 'utf8')).toContain('<<<<<<<');
    expect(refCommit(bRoot, MIGRATING_REF)).toBe(state.integrated);
    expect(refCommit(bRoot)).toBeNull();
    expect(git(remote, 'rev-parse', BOARD_REF).trim()).toBe(state.published);
    expect(untouched(bRoot, bDir)).toEqual(before);
    expect(keptRepositories(bRoot)).toEqual([]);
    if (state.fromD !== undefined) {
      expect(eventFiles(bDir)).not.toContain(`${state.fromD}.json`);
    }
    // The re-run refuses the same way until the human acts.
    expectBoardError(() => move(bRoot, env), 3, reason);
    expect(revParse(temporary)).toBe(state.halfway);
    expect(sequencerInProgress(temporary)).toBe(sequencerStays);
    expect(readFileSync(join(temporary, '.gitignore'), 'utf8')).toContain('<<<<<<<');
    expect(git(remote, 'rev-parse', BOARD_REF).trim()).toBe(state.published);
  }

  it('git reset after a conflict on the last pick (git drops its cherry-pick state, the markers stay in .gitignore): the re-run refuses the dirty worktree as sync-failed before any replay, quits nothing, loses nothing and publishes nothing (round 6 ruling 2)', () => {
    const env = syncEnv();
    const fx = conflictingClones(env);
    const { remote, bRoot } = fx;
    expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');
    const [temporary] = registeredMigrating(bRoot);
    resolveIgnoreConflicts(String(temporary));
    const resolvedHead = revParse(String(temporary));
    const integrated = String(refCommit(bRoot, MIGRATING_REF));
    // D's event commit is picked, D's .gitignore rewrite (the last pick) conflicts.
    const { fromD } = thirdCloneRewritesIgnore(fx, env);
    const published = git(remote, 'rev-parse', BOARD_REF).trim();
    expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');
    const halfway = revParse(String(temporary));
    expect(halfway).not.toBe(resolvedHead);
    // The human clears the index without resolving: the conflict markers
    // stay in the working tree, nothing is unmerged, and git 2.52's reset
    // on the last pick of a sequence drops CHERRY_PICK_HEAD and the
    // sequencer with it, so nothing is in progress any more.
    git(String(temporary), 'reset', '-q');
    expect(unmerged(String(temporary))).toEqual([]);
    expect(git(String(temporary), 'diff', '--cached', '--name-only')).toBe('');
    expect(git(String(temporary), 'diff', '--name-only')).toBe('.gitignore\n');
    expect(readFileSync(join(String(temporary), '.gitignore'), 'utf8')).toContain('<<<<<<<');
    expect(cherryPickInProgress(String(temporary))).toBe(false);
    expect(sequencerInProgress(String(temporary))).toBe(false);

    expectDirtyWorktreeRefused(fx, String(temporary), { halfway, resolvedHead, integrated, published, fromD }, false);
  });

  it('git reset after a conflict on a non-last pick (the sequencer stays, the markers stay in .gitignore): a human conflict in progress, refused as sync-in-progress naming the cherry-pick steps, nothing quit, lost or published (round 6 ruling 2)', () => {
    const env = syncEnv();
    const fx = conflictingClones(env);
    const { remote, bRoot } = fx;
    expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');
    const [temporary] = registeredMigrating(bRoot);
    resolveIgnoreConflicts(String(temporary));
    const resolvedHead = revParse(String(temporary));
    const integrated = String(refCommit(bRoot, MIGRATING_REF));
    // D's .gitignore rewrite is the first of two picks and conflicts; D's
    // event commit is still to do.
    const { fromD } = thirdCloneRewritesIgnoreThenEvent(fx, env);
    const published = git(remote, 'rev-parse', BOARD_REF).trim();
    expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');
    const halfway = revParse(String(temporary));
    expect(halfway).toBe(resolvedHead);
    expect(sequencerInProgress(String(temporary))).toBe(true);
    git(String(temporary), 'reset', '-q');
    expect(unmerged(String(temporary))).toEqual([]);
    expect(git(String(temporary), 'diff', '--cached', '--name-only')).toBe('');
    expect(git(String(temporary), 'diff', '--name-only')).toBe('.gitignore\n');
    expect(readFileSync(join(String(temporary), '.gitignore'), 'utf8')).toContain('<<<<<<<');
    // The reset on a non-last pick leaves the sequence in progress.
    expect(sequencerInProgress(String(temporary))).toBe(true);

    expectDirtyWorktreeRefused(fx, String(temporary), { halfway, resolvedHead, integrated, published, fromD }, true);
  });

  it('a dirty tracked file in an adopted temporary makes the replay stop for another reason: exit 3 sync-failed, the sequencer quit, the temporary kept and no pick dropped; cleaned up, the re-run conflicts as normal (round 6 ruling 2)', () => {
    const env = syncEnv();
    const fx = conflictingClones(env);
    const { remote, bRoot, bDir, shared, fromA, fromB } = fx;
    expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');
    const [temporary] = registeredMigrating(bRoot);
    const resolved = resolveIgnoreConflicts(String(temporary));
    const resolvedHead = revParse(String(temporary));
    const integrated = String(refCommit(bRoot, MIGRATING_REF));
    const { fromD, ignore } = thirdCloneRewritesIgnore(fx, env);
    const published = git(remote, 'rev-parse', BOARD_REF).trim();
    // An unstaged edit of a tracked file in the adopted worktree: D's
    // .gitignore commit cannot be applied over it.
    writeFileSync(join(String(temporary), '.gitignore'), `${resolved}local\n`);
    expect(cherryPickInProgress(String(temporary))).toBe(false);

    const err = expectBoardError(() => move(bRoot, env), 3, 'sync-failed');

    expect(err.message).toContain('.gitignore');
    // Not a conflict, not an empty pick: the sequence is quit, nothing is
    // skipped, the worktree stays adoptable with its edit untouched.
    expect(cherryPickInProgress(String(temporary))).toBe(false);
    expect(sequencerInProgress(String(temporary))).toBe(false);
    expect(registeredMigrating(bRoot)).toEqual([temporary]);
    expect(isAncestor(String(temporary), resolvedHead, 'HEAD')).toBe(true);
    expect(readFileSync(join(String(temporary), '.gitignore'), 'utf8')).toBe(`${resolved}local\n`);
    expect(refCommit(bRoot, MIGRATING_REF)).toBe(integrated);
    expect(refCommit(bRoot)).toBeNull();
    expect(git(remote, 'rev-parse', BOARD_REF).trim()).toBe(published);
    expect(detectBoardModel(bDir, { env }).model).toBe('standalone');
    expect(keptRepositories(bRoot)).toEqual([]);

    // Cleaned up, the re-run replays D's commits again: the event once, the
    // .gitignore rewrite conflicting as it normally does (never dropped).
    git(String(temporary), 'checkout', '--', '.gitignore');
    const conflict = expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');
    expect(conflict.message).toContain('.gitignore');
    expect(conflict.message).toContain('git cherry-pick --continue');
    expect(unmerged(String(temporary))).toEqual(['.gitignore']);
    expect(git(String(temporary), 'log', '--format=%H', '--diff-filter=A', '--', `events/${fromD}.json`).trim().split('\n')).toHaveLength(1);
    const both = [...BOARD_GITIGNORE_LINES, 'foo', 'baz', 'bar'].map((line) => `${line}\n`).join('');
    resolveCherryPickConflicts(String(temporary), both);
    const result = move(bRoot, env);
    expect(result).toMatchObject({ action: 'moved', events: 4 });
    expectMoved(bRoot, env);
    const all = [...shared, `${fromA}.json`, ...fromB.map((h) => `${h}.json`), `${fromD}.json`].sort();
    expect(eventFiles(bDir)).toEqual(all);
    expect(refEvents(remote)).toEqual(all);
    expect(readFileSync(join(bDir, '.gitignore'), 'utf8')).toBe(both);
    expect(ignore).not.toBe(both);
    expect(git(bRoot, 'log', '--format=%s', BOARD_REF).split('\n').filter((s) => s === 'ignore baz')).toHaveLength(1);
    expectCheckClean(bRoot, env);
  });

  it('a replay that conflicts, resolved with git cherry-pick --continue: the re-run adopts the worktree and completes with every event, both resolutions kept, nothing applied twice (round 4 ruling 2)', () => {
    const env = syncEnv();
    const fx = conflictingClones(env);
    const { remote, bRoot, bDir, shared, fromA, fromB } = fx;
    expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');
    const [temporary] = registeredMigrating(bRoot);
    resolveIgnoreConflicts(String(temporary));
    const resolvedHead = revParse(String(temporary));
    const { fromD } = thirdCloneRewritesIgnore(fx, env);
    const freshTip = revParse(bDir, `refs/remotes/origin/main`);
    expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');
    const both = [...BOARD_GITIGNORE_LINES, 'foo', 'baz', 'bar'].map((line) => `${line}\n`).join('');
    resolveCherryPickConflicts(String(temporary), both);
    const continuedHead = revParse(String(temporary));
    expect(isAncestor(String(temporary), resolvedHead, continuedHead)).toBe(true);
    const { env: recording, calls } = withRecordingGitShim(env);

    const result = move(bRoot, recording);

    expect(result).toMatchObject({ action: 'moved', model: 'host', joined: true, events: 4 });
    expectMoved(bRoot, env);
    const all = [...shared, `${fromA}.json`, ...fromB.map((h) => `${h}.json`), `${fromD}.json`].sort();
    expect(eventFiles(bDir)).toEqual(all);
    expect(refEvents(bRoot)).toEqual(all);
    expect(refEvents(remote)).toEqual(all);
    expect(readFileSync(join(bDir, '.gitignore'), 'utf8')).toBe(both);
    // What the human finished is the ancestor of the result; D's commits,
    // already applied by hand, were not applied a second time.
    expect(isAncestor(bRoot, continuedHead, BOARD_REF)).toBe(true);
    const subjects = git(bRoot, 'log', '--format=%s', BOARD_REF).split('\n');
    expect(subjects.filter((s) => s === 'ignore bar')).toHaveLength(1);
    expect(subjects.filter((s) => s === 'ignore baz')).toHaveLength(1);
    expect(git(bRoot, 'log', '--format=%s', '--diff-filter=A', '--', `events/${fromD}.json`).trim().split('\n')).toHaveLength(1);
    expect(calls().filter((c) => c.includes('--onto') || c.includes('--root'))).toEqual([]);
    expect(isAncestor(bRoot, git(bRoot, 'rev-parse', `${freshTip}^{commit}`).trim(), BOARD_REF)).toBe(false);
    expect(existsSync(String(temporary))).toBe(false);
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
    // Lands after the checks and the rebases, just before the compare-and-swap
    // of step 4: before the carry-over of step 5.
    const writing = withGitShimBefore(env, ['update-ref', BOARD_REF], late.command);

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
      ['update-ref', BOARD_REF],
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
  function hostWithLocalRef(root: string, env: Env): { commit: string; hash: string; other: ReturnType<typeof hostBoard> & { hash: string } } {
    const other = hostBoard(env);
    const hash = commitHostEvent(other.dir, ev(P.create(T2, 'From the host ref'), 'x', 2000), env);
    git(root, 'fetch', '-q', other.root, `${BOARD_REF}:${BOARD_REF}`);
    return { commit: String(refCommit(root)), hash, other: { ...other, hash } };
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
    // The move wrote the host .gitignore entry (untracked, as init leaves
    // it); committing it here lets expectMoved check that the move wrote
    // nothing else into the host's working tree.
    expect(result.hostGitignore).toBe(join(root, '.gitignore'));
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('.board/\n');
    expect(git(root, 'status', '--porcelain')).toBe('?? .gitignore\n');
    git(root, 'add', '.gitignore');
    git(root, 'commit', '-q', '-m', 'ignore the board');
    expectMoved(root, env);
    const all = [...files, `${fromOther}.json`, `${String(late)}.json`].sort();
    expect(eventFiles(dir)).toEqual(all);
    expect(refEvents(root)).toEqual(all);
    expect(isAncestor(root, otherCommit, BOARD_REF)).toBe(true);
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
    // Between the rebases and the rename (just before the compare-and-swap),
    // .board becomes a clone of itself: another git directory.
    const swapping = withGitShimBefore(
      env,
      ['update-ref', BOARD_REF],
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

  it('a worktree add that fails after git registered the worktree: exit 3 sync-failed, no registration, directory or ref left, .board untouched; the re-run moves (round 4 ruling 5)', () => {
    const env = syncEnv();
    const { root, dir, tip } = standaloneProject(env, 2);
    const files = eventFiles(dir);
    const before = untouched(root, dir);
    const once = join(tempDir(), 'failed-once');
    // git registers and checks out the worktree, then the command fails (a
    // hook, a full disk, a signal): the move must not trust the exit code
    // to mean nothing was written.
    const failing = withShellGitShim(
      env,
      [
        'case " $* " in',
        `  *" worktree add --detach "*) if [ ! -e '${once}' ]; then : > '${once}'; "$GIT" "$@"; echo 'fatal: simulated failure after the worktree was registered' >&2; exit 128; fi ;;`,
        'esac',
      ].join('\n'),
    );

    const err = expectBoardError(() => move(root, failing), 3, 'sync-failed');

    expect(existsSync(once)).toBe(true);
    expect(err.message).toContain('agentboard init --into-host');
    expect(snapshotDir(dir)).toEqual(before.board);
    expect(detectBoardModel(dir, { env }).model).toBe('standalone');
    expect(revParse(dir)).toBe(tip);
    expect(keptRepositories(root)).toEqual([]);
    expect(migratingEntries(root)).toEqual([]);
    expect(worktrees(root)).not.toContain(`/${MIGRATING_DIR}/`);
    expect(git(root, 'for-each-ref', '--format=%(refname)', 'refs/agentboard/')).toBe('');
    expect(git(root, 'status', '--porcelain')).toBe(before.status);

    const result = move(root, env);
    expect(result.action).toBe('moved');
    expectMoved(root, env);
    expect(eventFiles(dir)).toEqual(files);
    expectKept(String(result.keptAt), tip, files);
    expectCheckClean(root, env);
  });

  it('a temporary without an agentboard-source record (older code) whose integrated tip is in the board history is adopted, the resolution kept (round 5 ruling 5)', () => {
    const env = syncEnv();
    const fx = conflictingClones(env);
    const { remote, bRoot, bDir, shared, fromA, fromB } = fx;
    expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');
    const [temporary] = registeredMigrating(bRoot);
    const resolved = resolveIgnoreConflicts(String(temporary));
    const resolvedHead = revParse(String(temporary));
    const record = join(git(String(temporary), 'rev-parse', '--absolute-git-dir').trim(), 'agentboard-source');
    expect(existsSync(record)).toBe(true);
    rmSync(record);
    expect(isAncestor(bRoot, String(refCommit(bRoot, MIGRATING_REF)), revParse(bDir))).toBe(true);

    const result = move(bRoot, env);

    expect(result).toMatchObject({ action: 'moved', joined: true, events: 3 });
    expect(result.message).not.toContain(String(temporary));
    expectMoved(bRoot, env);
    const all = [...shared, `${fromA}.json`, ...fromB.map((h) => `${h}.json`)].sort();
    expect(eventFiles(bDir)).toEqual(all);
    expect(refEvents(bRoot)).toEqual(all);
    expect(refEvents(remote)).toEqual(all);
    expect(isAncestor(bRoot, resolvedHead, BOARD_REF)).toBe(true);
    expect(readFileSync(join(bDir, '.gitignore'), 'utf8')).toBe(resolved);
    expectCheckClean(bRoot, env);
  });

  it('a temporary without an agentboard-source record whose integrated tip is not in the board history (.board replaced) is removed and named (round 5 ruling 5)', () => {
    const env = syncEnv();
    const { root, dir } = standaloneProject(env, 3);
    const oldFiles = eventFiles(dir);
    const { commit: c1, other } = hostWithLocalRef(root, env);
    const fromOther2 = commitHostEvent(other.dir, ev(P.comment(T2, 'second'), 'x', 2100), env);
    git(root, 'fetch', '-q', other.root, `${BOARD_REF}:refs/test/c2`);
    const c2 = git(root, 'rev-parse', 'refs/test/c2').trim();
    const racing = withGitShimBefore(
      env,
      ['update-ref', BOARD_REF],
      `"$GIT" -C '${root}' update-ref ${BOARD_REF} ${c2} ${c1}`,
    );
    expectBoardError(() => move(root, racing), 3, 'sync-failed');
    const [temporary] = registeredMigrating(root);
    rmSync(join(git(String(temporary), 'rev-parse', '--absolute-git-dir').trim(), 'agentboard-source'));
    rmSync(dir, { recursive: true, force: true });
    const replacement = syncedStandalone(root, env, 2, bareRemote(), 'other');
    const newFiles = eventFiles(dir);

    const result = move(root, env);

    expect(result).toMatchObject({ action: 'moved', events: 4 });
    expect(result.message).toContain(String(temporary));
    expectMoved(root, env);
    const all = [...newFiles, `${other.hash}.json`, `${fromOther2}.json`].sort();
    expect(eventFiles(dir)).toEqual(all);
    for (const old of oldFiles) {
      expect(eventFiles(dir)).not.toContain(old);
    }
    expectKept(String(result.keptAt), replacement.tip, newFiles);
  });

  it('a temporary left by a move of a different .board (replaced since) is not adopted: removed and named, the new board moved on its own (round 4 ruling 3)', () => {
    const env = syncEnv();
    const { root, dir } = standaloneProject(env, 3);
    const oldFiles = eventFiles(dir);
    const { commit: c1, other } = hostWithLocalRef(root, env);
    const fromOther2 = commitHostEvent(other.dir, ev(P.comment(T2, 'second'), 'x', 2100), env);
    git(root, 'fetch', '-q', other.root, `${BOARD_REF}:refs/test/c2`);
    const c2 = git(root, 'rev-parse', 'refs/test/c2').trim();
    // The first move integrates c1 (its worktree HEAD leaves the temporary
    // ref) and loses the compare-and-swap: an adoptable temporary of this board.
    const racing = withGitShimBefore(
      env,
      ['update-ref', BOARD_REF],
      `"$GIT" -C '${root}' update-ref ${BOARD_REF} ${c2} ${c1}`,
    );
    expectBoardError(() => move(root, racing), 3, 'sync-failed');
    const [temporary] = registeredMigrating(root);
    expect(registeredMigrating(root)).toHaveLength(1);
    expect(revParse(String(temporary))).not.toBe(refCommit(root, MIGRATING_REF));
    // The user replaces the board with another standalone board (its own
    // repository, its own history and events) before running the move again.
    // The old board is moved aside and removed only once the replacement
    // exists: the identity the temporary records is the git directory's
    // realpath, device and inode, and a file system that reuses inode
    // numbers (ext4 does) could otherwise give the new `.board/.git` the
    // inode of the old one, which the recorded identity cannot tell apart.
    const oldGitDir = fs.statSync(join(dir, '.git'));
    const aside = join(tempDir(), 'replaced-board');
    fs.renameSync(dir, aside);
    const replacement = syncedStandalone(root, env, 2, bareRemote(), 'other');
    rmSync(aside, { recursive: true, force: true });
    const newGitDir = fs.statSync(join(dir, '.git'));
    expect([newGitDir.dev, newGitDir.ino]).not.toEqual([oldGitDir.dev, oldGitDir.ino]);
    const newFiles = eventFiles(dir);
    expect(newFiles.some((f) => oldFiles.includes(f))).toBe(false);

    const result = move(root, env);

    expect(result).toMatchObject({ action: 'moved', events: 4 });
    expect(result.message).toContain(String(temporary));
    expectMoved(root, env);
    const all = [...newFiles, `${other.hash}.json`, `${fromOther2}.json`].sort();
    expect(eventFiles(dir)).toEqual(all);
    expect(refEvents(root)).toEqual(all);
    for (const old of oldFiles) {
      expect(eventFiles(dir)).not.toContain(old);
    }
    expect(isAncestor(root, c2, BOARD_REF)).toBe(true);
    expect(isAncestor(root, replacement.tip, BOARD_REF)).toBe(false);
    expectKept(String(result.keptAt), replacement.tip, newFiles);
    expectCheckClean(root, env);
  });

  it('.board re-created at the same path with a different history before the rename: refused by the step 1 HEAD of the identity re-check, nothing renamed (round 3 ruling 6)', () => {
    const env = syncEnv();
    const { root, dir, tip } = standaloneProject(env, 2);
    const files = eventFiles(dir);
    // The same git directory (same realpath, device and inode: a file
    // system that reuses inode numbers cannot tell it apart) now holds a
    // history that does not descend from the HEAD step 1 saw: the branch is
    // rebuilt from an orphan root commit holding the same files.
    const rebuilding = withGitShimBefore(
      env,
      ['update-ref', BOARD_REF],
      [
        `"$GIT" -C '${dir}' checkout -q --orphan rebuilt`,
        `"$GIT" -C '${dir}' -c user.name=rebuilder -c user.email=rebuilder@localhost commit -q --no-verify -m rebuilt`,
        `"$GIT" -C '${dir}' branch -q -M main`,
      ].join(' && '),
    );
    const gitDirBefore = git(dir, 'rev-parse', '--absolute-git-dir').trim();

    const err = expectBoardError(() => move(root, rebuilding), 3, 'sync-failed');

    expect(err.message).toContain(dir);
    expect(err.message).toContain('agentboard init --into-host');
    expect(keptRepositories(root)).toEqual([]);
    expect(detectBoardModel(dir, { env }).model).toBe('standalone');
    expect(git(dir, 'rev-parse', '--absolute-git-dir').trim()).toBe(gitDirBefore);
    expect(revParse(dir)).not.toBe(tip);
    expect(isAncestor(dir, tip, 'HEAD')).toBe(false);
    expect(eventFiles(dir)).toEqual(files);
    expect(worktreeEntry(root, dir)).toBeNull();
    expect(migratingEntries(root)).toHaveLength(1);
  });

  it('a standalone sync landing in the rename window (HEAD moved on, descending from the step 1 HEAD) is not a replacement: the move completes and carries the event over (round 3 ruling 6)', () => {
    const env = syncEnv();
    const { root, remote, dir, tip } = standaloneProject(env, 2);
    const files = eventFiles(dir);
    const late = lateEventFile('synced in the rename window');
    const realRename = fs.renameSync;
    let landed = 0;
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike): void => {
      if (String(from) === dir && landed === 0) {
        landed += 1;
        writeFileSync(join(dir, 'events', late.name), late.bytes);
        syncStandalone(dir, env);
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
    const all = [...files, late.name].sort();
    expect(eventFiles(dir)).toEqual(all);
    expect(refEvents(root)).toEqual(all);
    expect(refEvents(remote)).toEqual(all);
    // The kept repository holds the sync's commit on top of the tip step 1 saw.
    const kept = String(result.keptAt);
    expect(isAncestor(kept, tip, 'HEAD')).toBe(true);
    expect(revParse(kept)).not.toBe(tip);
    expect(eventFiles(kept)).toEqual(all);
    expectCheckClean(root, env);
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
    const plain = join(agentboardDir(root), MIGRATING_DIR, String(DEAD_PID + 2));
    mkdirSync(plain);
    const junk = join(agentboardDir(root), MIGRATING_DIR, 'junk');
    mkdirSync(junk);
    const rebasing = temporary(root, DEAD_PID + 1, commit);
    mkdirSync(join(git(rebasing, 'rev-parse', '--absolute-git-dir').trim(), 'rebase-merge'));
    const picking = temporary(root, DEAD_PID + 3, commit);
    writeFileSync(join(git(picking, 'rev-parse', '--absolute-git-dir').trim(), 'CHERRY_PICK_HEAD'), `${commit}\n`);
    // A multi-commit cherry-pick killed between two picks leaves only git's
    // sequencer directory behind (round 5 ruling 1).
    const sequencing = temporary(root, DEAD_PID + 4, commit);
    mkdirSync(join(git(sequencing, 'rev-parse', '--absolute-git-dir').trim(), 'sequencer'));

    const found = findMigratingWorktrees(root, { env });

    expect(found.map((w) => w.path)).toEqual([plain, dead, alive, junk, rebasing, picking, sequencing].sort());
    // A stopped cherry-pick (the replay of an adopted worktree) counts as rebasing.
    expect(found.find((w) => w.path === picking)).toMatchObject({
      pid: DEAD_PID + 3,
      alive: false,
      registered: true,
      rebasing: true,
    });
    expect(found.find((w) => w.path === sequencing)).toMatchObject({
      pid: DEAD_PID + 4,
      alive: false,
      registered: true,
      rebasing: true,
    });
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
      pid: DEAD_PID + 2,
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
    git(root, 'update-ref', MIGRATING_FETCH_REF, commit);
    const dead = temporary(root, DEAD_PID, commit);
    const alive = temporary(root, process.pid, commit);
    const plain = join(agentboardDir(root), MIGRATING_DIR, String(DEAD_PID + 3));
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
    // Moves still in flight, stopped or finished keep the temporary refs.
    expect(refCommit(root, MIGRATING_REF)).toBe(commit);
    expect(refCommit(root, MIGRATING_FETCH_REF)).toBe(commit);
    expect(refCommit(root)).toBe(commit);

    for (const path of [alive, rebasing, rebased]) {
      git(root, 'worktree', 'remove', '--force', '--force', path);
      rmSync(path, { recursive: true, force: true });
    }
    expect(removeDeadMigratingWorktrees(root, { env })).toEqual([]);
    expect(refCommit(root, MIGRATING_REF)).toBeNull();
    expect(refCommit(root, MIGRATING_FETCH_REF)).toBeNull();
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
    const plain = join(base, String(DEAD_PID + 2));
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

    // Without a kept repository the directory, still holding the stopped
    // one, is not a pending move: plain init does not say so (the removal
    // line names the command that left the temporaries, not a sync to finish).
    expect(result.message).not.toMatch(/sync/);
    expect(existsSync(base)).toBe(true);

    // init --into-host on the same board does the same, and the empty
    // directory goes in that run once the last one is gone (round 4 ruling
    // 4), so plain init afterwards reports no phantom pending move.
    git(root, 'worktree', 'remove', '--force', '--force', stopped);
    rmSync(stopped, { recursive: true, force: true });
    const again = move(root, env);
    expect(again).toMatchObject({ action: 'unchanged', sync: null });
    expect(existsSync(base)).toBe(false);
    expect(eventFiles(dir)).toEqual([`${hash}.json`]);
    const plainAgain = initBoard({ cwd: root, env });
    expect(plainAgain.message).not.toContain('agentboard init --into-host');
    expect(plainAgain.message).not.toMatch(/interrupted/);
    expect(existsSync(base)).toBe(false);

    // And plain init itself removes the directory it empties when no kept repository exists.
    mkdirSync(join(base, String(DEAD_PID + 4)), { recursive: true });
    const cleaned = initBoard({ cwd: root, env });
    expect(cleaned.message).toContain(join(base, String(DEAD_PID + 4)));
    expect(cleaned.message).not.toMatch(/sync/);
    expect(existsSync(base)).toBe(false);
  });

  it('resuming with two kept repositories carries over from the newest and leaves the older one alone (round 4 ruling 3)', () => {
    const env = syncEnv();
    const { root, remote, dir, boardRemote } = standaloneProject(env, 2);
    const first = move(root, env);
    expect(first.action).toBe('moved');
    const kept = String(first.keptAt);
    // An older kept repository from an earlier move (rolled back since), holding an event of its own.
    const older = join(agentboardDir(root), `${STANDALONE_KEPT_PREFIX}20200101T000000Z`);
    cpSync(kept, older, { recursive: true });
    const [stale] = writeEvents(older, 1, 'stale', 900);
    expect(older < kept).toBe(true);
    git(root, 'worktree', 'unlock', dir);
    mkdirSync(join(agentboardDir(root), MIGRATING_DIR), { recursive: true });
    git(remote, 'update-ref', '-d', BOARD_REF);
    const [late] = writeEvents(kept, 1, 'late', 800);
    const files = [...eventFiles(dir), `${String(late)}.json`].sort();

    const result = move(root, env);

    expect(result).toMatchObject({ action: 'resumed', keptAt: kept, oldRemoteUrl: boardRemote, events: 3 });
    expect(result.message).toContain(kept);
    expect(result.message).not.toContain(older);
    expectMoved(root, env, 2);
    expect(eventFiles(dir)).toEqual(files);
    expect(refEvents(root)).toEqual(files);
    expect(eventFiles(dir)).not.toContain(`${String(stale)}.json`);
    expect(eventFiles(older)).toContain(`${String(stale)}.json`);
    expect(git(remote, 'rev-parse', BOARD_REF).trim()).toBe(refCommit(root));
    expect(move(root, env).action).toBe('unchanged');
    expectCheckClean(root, env);
  });

  it('plain init on a moved board whose sync did not complete leaves the migrating marker, restores the lock, names the pending move and runs no sync; init --into-host then resumes it with the kept repository event (round 3 ruling 3)', () => {
    const env = syncEnv();
    const { root, remote, dir, boardRemote } = standaloneProject(env, 2);
    const first = move(root, env);
    expect(first.action).toBe('moved');
    const kept = String(first.keptAt);
    const marker = join(agentboardDir(root), MIGRATING_DIR);
    // The state a kill after the worktree move leaves (as the test above),
    // with an event that landed in the old directory in the rename window.
    git(root, 'worktree', 'unlock', dir);
    mkdirSync(marker, { recursive: true });
    git(remote, 'update-ref', '-d', BOARD_REF);
    const [late] = writeEvents(kept, 1, 'late', 800);
    const files = [...eventFiles(dir), `${String(late)}.json`].sort();
    const published = refCommit(root);

    const plain = initBoard({ cwd: root, env });

    expect(plain).toMatchObject({ created: false, model: 'host', repair: null, hostGitignore: null, events: 2 });
    expect(plain.message).toContain('agentboard init --into-host');
    expect(plain.message).toMatch(/sync/);
    expect(existsSync(marker)).toBe(true);
    expect(migratingEntries(root)).toEqual([]);
    expect(worktreeEntry(root, dir)?.locked).toBe(WORKTREE_LOCK_REASON);
    // Plain init reports; it neither carries over nor publishes.
    expect(refCommit(root)).toBe(published);
    expect(git(remote, 'for-each-ref', '--format=%(refname)', 'refs/agentboard/')).toBe('');
    expect(eventFiles(kept)).toEqual(files);

    const resumed = move(root, env);

    expect(resumed).toMatchObject({ action: 'resumed', keptAt: kept, oldRemoteUrl: boardRemote, events: 3 });
    expect(resumed.sync).toMatchObject({ model: 'host', pushed: true });
    expectMoved(root, env);
    expect(eventFiles(dir)).toEqual(files);
    expect(refEvents(root)).toEqual(files);
    expect(git(remote, 'rev-parse', BOARD_REF).trim()).toBe(refCommit(root));
    expect(existsSync(marker)).toBe(false);
    expect(move(root, env).action).toBe('unchanged');
    expect(initBoard({ cwd: root, env }).message).not.toContain('agentboard init --into-host');
    expectCheckClean(root, env);
  });

  it('init --into-host on a moved board removes dead temporaries without rebase state as plain init does, names them and keeps a stopped one; once the marker is empty beside the kept repository it is resumed (round 3 ruling 4)', () => {
    const env = syncEnv();
    const { root, remote, dir } = standaloneProject(env, 2);
    const first = move(root, env);
    expect(first.action).toBe('moved');
    const files = eventFiles(dir);
    const published = refCommit(root);
    const base = join(agentboardDir(root), MIGRATING_DIR);
    mkdirSync(base, { recursive: true });
    const dead = join(base, String(DEAD_PID));
    git(root, 'worktree', 'add', '-q', '--detach', dead, BOARD_REF);
    const stopped = join(base, String(DEAD_PID + 1));
    git(root, 'worktree', 'add', '-q', '--detach', stopped, BOARD_REF);
    mkdirSync(join(git(stopped, 'rev-parse', '--absolute-git-dir').trim(), 'rebase-merge'));
    const plain = join(base, String(DEAD_PID + 2));
    mkdirSync(plain);

    const result = move(root, env);

    expect(result).toMatchObject({ action: 'unchanged', keptAt: null, sync: null, events: 2 });
    expect(result.message).toContain(dead);
    expect(result.message).toContain(plain);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(plain)).toBe(false);
    expect(worktreeEntry(root, dead)).toBeNull();
    expect(existsSync(stopped)).toBe(true);
    expect(worktreeEntry(root, stopped)).not.toBeNull();
    expect(refCommit(root)).toBe(published);
    expect(eventFiles(dir)).toEqual(files);
    expect(keptRepositories(root)).toEqual([first.keptAt]);
    expect(detectBoardModel(dir, { env }).model).toBe('host');

    // The stopped one removed by hand leaves the marker empty beside the
    // kept repository: a move whose sync may not have completed, resumed
    // with an idempotent sync; then the marker goes and the board is unchanged.
    git(root, 'worktree', 'remove', '--force', '--force', stopped);
    rmSync(stopped, { recursive: true, force: true });
    const again = move(root, env);
    expect(again).toMatchObject({ action: 'resumed', keptAt: first.keptAt });
    expect(again.sync).toMatchObject({ model: 'host' });
    expect(existsSync(base)).toBe(false);
    expect(refCommit(root)).toBe(published);
    expect(git(remote, 'rev-parse', BOARD_REF).trim()).toBe(published);
    expect(eventFiles(dir)).toEqual(files);
    expect(move(root, env).action).toBe('unchanged');
    expectMoved(root, env);
    expectCheckClean(root, env);
  });

  it('cleanDeadMigratingWorktrees removes the empty migrating directory only when no kept repository exists (the marker of an unsynced move stays)', () => {
    const env = syncEnv();
    const { root, dir } = standaloneProject(env, 1);
    expect(move(root, env).action).toBe('moved');
    const base = join(agentboardDir(root), MIGRATING_DIR);
    mkdirSync(base, { recursive: true });
    const dead = join(base, String(DEAD_PID));
    git(root, 'worktree', 'add', '-q', '--detach', dead, BOARD_REF);

    expect(cleanDeadMigratingWorktrees(root, { env })).toEqual([dead]);

    expect(existsSync(dead)).toBe(false);
    expect(worktreeEntry(root, dead)).toBeNull();
    expect(existsSync(base)).toBe(true);
    expect(detectBoardModel(dir, { env }).model).toBe('host');

    // Without a kept repository the empty directory marks nothing and goes.
    const fresh = hostBoard(env);
    const freshBase = join(agentboardDir(fresh.root), MIGRATING_DIR);
    mkdirSync(join(freshBase, String(DEAD_PID)), { recursive: true });
    expect(cleanDeadMigratingWorktrees(fresh.root, { env })).toEqual([join(freshBase, String(DEAD_PID))]);
    expect(existsSync(freshBase)).toBe(false);
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

/**
 * guard-stale-temporary group 1 (board-concurrency "Moving a board into
 * the host repository loses no event", the leftover rule; design.md of
 * that change): every temporary records the HEAD of the standalone board
 * at step 1 in `agentboard-source-head` beside the git directory identity
 * in `agentboard-source`, and a dead temporary that integrated something
 * is adopted only when the identity is the board's and that HEAD is an
 * ancestor of, or equal to, the board's HEAD now. Inode reuse is never
 * left to the file system: a test rewrites the temporary's
 * `agentboard-source` to the replacement's identity (tasks.md, preamble),
 * so the tests fail the same way on tmpfs, ext4 and every CI runner. A
 * temporary of 0.2.0 is one without `agentboard-source-head`, one of older
 * code has neither record.
 */
describe('guard-stale-temporary: adoption guarded by the HEAD the move began from', () => {
  const SOURCE_RECORD = 'agentboard-source';
  const HEAD_RECORD = 'agentboard-source-head';

  /** The path of the record `name` in the git directory of the temporary worktree at `temporary`. */
  function recordPath(temporary: string, name: string): string {
    return join(git(temporary, 'rev-parse', '--absolute-git-dir').trim(), name);
  }

  /** The content of the record `name` of `temporary`, or null when it has none. */
  function readRecordFile(temporary: string, name: string): string | null {
    const path = recordPath(temporary, name);
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  }

  /** The git directory identity of the repository at `repo` as the move computes it: `<realpath>:<dev>:<ino>`. */
  function gitDirIdentity(repo: string): string {
    const path = fs.realpathSync(git(repo, 'rev-parse', '--absolute-git-dir').trim());
    const stats = fs.statSync(path);
    return `${path}:${String(stats.dev)}:${String(stats.ino)}`;
  }

  /**
   * Makes the temporary at `temporary` record the identity of the board at
   * `dir` now, as a file system that gave the replacement's git directory
   * the freed inode of the old one would (the PR #99 reproduction).
   */
  function simulateInodeReuse(temporary: string, dir: string): void {
    writeFileSync(recordPath(temporary, SOURCE_RECORD), gitDirIdentity(dir));
  }

  /** design.md "Reporting": the line naming a removed temporary of another board. */
  function removedAsAnotherBoard(temporary: string, dir: string): string {
    return (
      `removed ${temporary}, left by a move of another board (not the one at ${dir}, or one ` +
      'whose history no longer holds where that move began), so nothing of it was adopted'
    );
  }

  /** design.md "Reporting": the parenthesis of the `sync-in-progress` refusal for a temporary of another board. */
  function anotherBoardParenthesis(dir: string): string {
    return (
      ` (that worktree was left by a move of another board, not the one at ${dir} now or one ` +
      'whose history no longer holds where that move began, so finishing it moves nothing of this board)'
    );
  }

  /**
   * A move of the standalone board in `root` that integrated a local
   * `refs/agentboard/board` (c1, one event of another host board) and lost
   * the compare-and-swap to c2 (c1 plus a second event): exit 3
   * `sync-failed`, the temporary kept with its HEAD off
   * `refs/agentboard/migrating`, so a re-run on the same board adopts it.
   */
  function interruptedMove(root: string, env: Env): { temporary: string; c2: string; fromHost: string[] } {
    const other = hostBoard(env);
    const h1 = commitHostEvent(other.dir, ev(P.create(T2, 'From the host ref'), 'x', 2000), env);
    git(root, 'fetch', '-q', other.root, `${BOARD_REF}:${BOARD_REF}`);
    const c1 = String(refCommit(root));
    const h2 = commitHostEvent(other.dir, ev(P.comment(T2, 'second'), 'x', 2100), env);
    git(root, 'fetch', '-q', other.root, `${BOARD_REF}:refs/test/c2`);
    const c2 = git(root, 'rev-parse', 'refs/test/c2').trim();
    const racing = withGitShimBefore(
      env,
      ['update-ref', BOARD_REF],
      `"$GIT" -C '${root}' update-ref ${BOARD_REF} ${c2} ${c1}`,
    );
    expectBoardError(() => move(root, racing), 3, 'sync-failed');
    const [temporary] = registeredMigrating(root);
    expect(registeredMigrating(root)).toHaveLength(1);
    expect(revParse(String(temporary))).not.toBe(refCommit(root, MIGRATING_REF));
    return { temporary: String(temporary), c2, fromHost: [`${h1}.json`, `${h2}.json`] };
  }

  /** Replaces the board at `<root>/.board` by an unrelated standalone board with two events of its own and its own remote. */
  function replaceBoard(root: string, dir: string, env: Env): { tip: string; files: string[] } {
    rmSync(dir, { recursive: true, force: true });
    const { tip } = syncedStandalone(root, env, 2, bareRemote(), 'other');
    return { tip, files: eventFiles(dir) };
  }

  /** Asserts no commit of `ref` in `repo` ever added any of `files` (`<hash>.json`) under `events/`. */
  function expectNeverIn(repo: string, files: readonly string[], ref: string = BOARD_REF): void {
    for (const file of files) {
      expect(git(repo, 'log', '--format=%H', ref, '--', `events/${file}`).trim(), file).toBe('');
    }
  }

  describe('1.1 the records', () => {
    it('a move stopped on a conflict leaves a temporary whose agentboard-source-head is the board HEAD at the start of that move (a full object name and a newline) and whose agentboard-source is the identity as before (no newline)', () => {
      const env = syncEnv();
      const { bRoot, bDir } = conflictingClones(env);
      const head = revParse(bDir);
      const identity = gitDirIdentity(bDir);

      expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');

      const [temporary] = registeredMigrating(bRoot);
      expect(readRecordFile(String(temporary), HEAD_RECORD)).toBe(`${head}\n`);
      expect(head).toMatch(/^[0-9a-f]{40}$/);
      expect(readRecordFile(String(temporary), SOURCE_RECORD)).toBe(identity);
      expect(identity).toMatch(/^\/.+:\d+:\d+$/);
    });

    it('a move that lost the compare-and-swap leaves both records too, the HEAD record naming the board HEAD step 1 saw', () => {
      const env = syncEnv();
      const { root, dir, tip } = standaloneProject(env, 3);
      const identity = gitDirIdentity(dir);

      const { temporary } = interruptedMove(root, env);

      expect(readRecordFile(temporary, HEAD_RECORD)).toBe(`${tip}\n`);
      expect(readRecordFile(temporary, SOURCE_RECORD)).toBe(identity);
    });

    it.each([
      ['made by 0.2.0 (agentboard-source only)', [HEAD_RECORD]],
      ['made by older code (no record)', [SOURCE_RECORD, HEAD_RECORD]],
    ])(
      'a temporary %s adopted by a run that a replay conflict interrupts carries both records with the adopting run identity and HEAD, and the next run judges it by the full test',
      (_label, removedRecords) => {
        const env = syncEnv();
        const fx = conflictingClones(env);
        const { bRoot, bDir } = fx;
        expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');
        const temporary = String(registeredMigrating(bRoot)[0]);
        resolveIgnoreConflicts(temporary);
        const resolvedHead = revParse(temporary);
        for (const name of removedRecords) {
          rmSync(recordPath(temporary, name), { force: true });
        }
        expect(readRecordFile(temporary, HEAD_RECORD)).toBeNull();
        thirdCloneRewritesIgnore(fx, env);
        const adoptingHead = revParse(bDir);

        // The adoption: the temporary is this board's (its integrated tip
        // is in the board's history), so the replay of the third clone's
        // commits runs in it and stops on .gitignore.
        const adopting = expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');

        expect(adopting.message).toContain('git cherry-pick --continue');
        expect(cherryPickInProgress(temporary)).toBe(true);
        expect(String(readRecordFile(temporary, SOURCE_RECORD)).replace(/\n$/, '')).toBe(gitDirIdentity(bDir));
        expect(readRecordFile(temporary, HEAD_RECORD)).toBe(`${adoptingHead}\n`);

        // The human abandons the replay (back at the resolution), and the
        // board's branch is reset behind the HEAD the adoption recorded
        // while its remote still has it: the identity matches and the
        // integrated tip is still in the source tip, so only the recorded
        // HEAD tells that the board's history no longer holds where the
        // adoption began. Judged by the full test, the temporary is
        // another board's: removed, and a fresh temporary stops on the
        // rebase of step 3 (judged as 0.2.0 it would be adopted again and
        // stop on the replay's cherry-pick).
        git(temporary, 'cherry-pick', '--abort');
        git(temporary, 'checkout', '--', '.gitignore');
        expect(revParse(temporary)).toBe(resolvedHead);
        git(bDir, 'reset', '-q', '--hard', 'HEAD~1');
        expect(isAncestor(bDir, adoptingHead, 'HEAD')).toBe(false);
        expect(isAncestor(bDir, adoptingHead, 'refs/remotes/origin/main')).toBe(true);

        const next = expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');

        expect(next.message).toContain('git rebase --continue');
        expect(next.message).not.toContain('cherry-pick');
        const [fresh] = registeredMigrating(bRoot);
        expect(registeredMigrating(bRoot)).toHaveLength(1);
        expect(rebaseInProgress(String(fresh))).toBe(true);
        expect(cherryPickInProgress(String(fresh))).toBe(false);
        expect(refCommit(bRoot)).toBeNull();
      },
    );

    it.each([
      ['no record (killed right after worktree add)', 'none'],
      ['agentboard-source only (killed between the two writes)', 'source'],
      ['agentboard-source and a torn agentboard-source-head (killed during the second write)', 'torn'],
      ['agentboard-source and an unreadable agentboard-source-head', 'unreadable'],
      ['both records (killed right after the second write)', 'both'],
    ])(
      'a dead temporary whose HEAD is still at refs/agentboard/migrating with %s is removed as a plain leftover, its records never judged, and the move starts again',
      (_label, records) => {
        const env = syncEnv();
        const { root, dir, tip } = standaloneProject(env, 2);
        const files = eventFiles(dir);
        git(root, 'fetch', '-q', dir, `+refs/heads/main:${MIGRATING_REF}`);
        mkdirSync(join(agentboardDir(root), MIGRATING_DIR), { recursive: true });
        const leftover = join(agentboardDir(root), MIGRATING_DIR, String(DEAD_PID));
        git(root, 'worktree', 'add', '-q', '--detach', leftover, MIGRATING_REF);
        if (records !== 'none') {
          writeFileSync(recordPath(leftover, SOURCE_RECORD), gitDirIdentity(dir));
        }
        if (records === 'torn') {
          writeFileSync(recordPath(leftover, HEAD_RECORD), tip.slice(0, 7));
        } else if (records === 'unreadable') {
          mkdirSync(recordPath(leftover, HEAD_RECORD));
        } else if (records === 'both') {
          writeFileSync(recordPath(leftover, HEAD_RECORD), `${tip}\n`);
        }

        const result = move(root, env);

        expect(result.action).toBe('moved');
        expect(result.message).toContain(`removed ${leftover}, left by an interrupted move`);
        expect(result.message).not.toContain('another board');
        expectMoved(root, env);
        expect(eventFiles(dir)).toEqual(files);
        expectKept(String(result.keptAt), tip, files);
      },
    );
  });

  describe('1.2 belonging: the same git directory and the same history', () => {
    it('scenario: Temporary of a replaced board whose git directory reuses the inode: the replacement is moved with exit 0, the temporary removed and named, nothing of the old board in .board/events or refs/agentboard/board', () => {
      const env = syncEnv();
      const { root, dir } = standaloneProject(env, 3);
      const oldFiles = eventFiles(dir);
      const { temporary, c2, fromHost } = interruptedMove(root, env);
      const replacement = replaceBoard(root, dir, env);
      expect(replacement.files.some((f) => oldFiles.includes(f))).toBe(false);
      simulateInodeReuse(temporary, dir);

      const result = move(root, env);

      expect(result).toMatchObject({ action: 'moved', events: 4 });
      expect(result.message).toContain(removedAsAnotherBoard(temporary, dir));
      expectMoved(root, env);
      const all = [...replacement.files, ...fromHost].sort();
      expect(eventFiles(dir)).toEqual(all);
      expect(refEvents(root)).toEqual(all);
      expectNeverIn(root, oldFiles);
      expect(isAncestor(root, c2, BOARD_REF)).toBe(true);
      expect(git(root, 'for-each-ref', '--format=%(refname)', 'refs/agentboard/')).toBe(`${BOARD_REF}\n`);
      expect(migratingEntries(root)).toEqual([]);
      expectKept(String(result.keptAt), replacement.tip, replacement.files);
      expectCheckClean(root, env);
    });

    it('scenario: Stopped temporary of a replaced board whose git directory reuses the inode: exit 3 sync-in-progress naming the temporary as left by a move of another board; the temporary, .board and the host refs unchanged, nothing removed', () => {
      const env = syncEnv();
      const { bRoot, bDir } = conflictingClones(env);
      expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');
      const temporary = String(registeredMigrating(bRoot)[0]);
      replaceBoard(bRoot, bDir, env);
      simulateInodeReuse(temporary, bDir);
      const before = untouched(bRoot, bDir);
      const temporaryFiles = snapshotDir(temporary);

      const err = expectBoardError(() => move(bRoot, env), 3, 'sync-in-progress');

      expect(err.message).toContain(`temporary worktree at ${temporary}${anotherBoardParenthesis(bDir)}; resolve`);
      expect(err.message).toContain('git rebase --continue');
      expectUntouched(bRoot, bDir, before);
      expect(snapshotDir(temporary)).toEqual(temporaryFiles);
      expect(rebaseInProgress(temporary)).toBe(true);
      expect(registeredMigrating(bRoot)).toEqual([temporary]);
      expect(migratingEntries(bRoot)).toHaveLength(1);
      expect(refCommit(bRoot)).toBeNull();
      expect(keptRepositories(bRoot)).toEqual([]);
    });

    it('a stopped temporary of this board whose history was rewritten since (the same git directory, its branch reset behind the recorded HEAD): sync-in-progress saying another board, nothing removed', () => {
      const env = syncEnv();
      const { bRoot, bDir } = conflictingClones(env);
      const head = revParse(bDir);
      expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');
      const temporary = String(registeredMigrating(bRoot)[0]);
      git(bDir, 'reset', '-q', '--hard', 'HEAD~1');
      expect(isAncestor(bDir, head, 'HEAD')).toBe(false);
      const before = untouched(bRoot, bDir);
      const temporaryFiles = snapshotDir(temporary);

      const err = expectBoardError(() => move(bRoot, env), 3, 'sync-in-progress');

      expect(err.message).toContain(`temporary worktree at ${temporary}${anotherBoardParenthesis(bDir)}; resolve`);
      expectUntouched(bRoot, bDir, before);
      expect(snapshotDir(temporary)).toEqual(temporaryFiles);
      expect(rebaseInProgress(temporary)).toBe(true);
      expect(registeredMigrating(bRoot)).toEqual([temporary]);
    });

    it('a stopped temporary of 0.2.0 on this board: sync-in-progress without another board in its text', () => {
      const env = syncEnv();
      const { bRoot, bDir } = conflictingClones(env);
      expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');
      const temporary = String(registeredMigrating(bRoot)[0]);
      rmSync(recordPath(temporary, HEAD_RECORD), { force: true });

      const err = expectBoardError(() => move(bRoot, env), 3, 'sync-in-progress');

      expect(err.message).toContain(`temporary worktree at ${temporary}; resolve`);
      expect(err.message).not.toContain('another board');
      expect(rebaseInProgress(temporary)).toBe(true);
      expect(detectBoardModel(bDir, { env }).model).toBe('standalone');
    });

    it('a stopped temporary of 0.2.0 on a replaced board whose git directory reuses the inode: sync-in-progress saying another board, nothing removed', () => {
      const env = syncEnv();
      const { bRoot, bDir } = conflictingClones(env);
      expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');
      const temporary = String(registeredMigrating(bRoot)[0]);
      rmSync(recordPath(temporary, HEAD_RECORD), { force: true });
      replaceBoard(bRoot, bDir, env);
      simulateInodeReuse(temporary, bDir);
      const before = untouched(bRoot, bDir);

      const err = expectBoardError(() => move(bRoot, env), 3, 'sync-in-progress');

      expect(err.message).toContain(`temporary worktree at ${temporary}${anotherBoardParenthesis(bDir)}; resolve`);
      expectUntouched(bRoot, bDir, before);
      expect(rebaseInProgress(temporary)).toBe(true);
      expect(registeredMigrating(bRoot)).toEqual([temporary]);
    });

    it('scenario: Board history rewritten since the interrupted move (no remote): the temporary is removed and named, the move completes from the board as it is now, no event added only by the removed commits anywhere', () => {
      const env = syncEnv();
      const { root } = project();
      const { dir } = syncedStandalone(root, env, 2);
      const [dropped] = writeEvents(dir, 1, 'orch', 50);
      syncStandalone(dir, env);
      const head = revParse(dir);
      const { temporary, fromHost } = interruptedMove(root, env);
      expect(readRecordFile(temporary, HEAD_RECORD)).toBe(`${head}\n`);
      git(dir, 'reset', '-q', '--hard', 'HEAD~1');
      const resetTip = revParse(dir);
      const files = eventFiles(dir);
      expect(files).not.toContain(`${String(dropped)}.json`);

      const result = move(root, env);

      expect(result).toMatchObject({ action: 'moved', events: 4 });
      expect(result.message).toContain(removedAsAnotherBoard(temporary, dir));
      expectMoved(root, env);
      const all = [...files, ...fromHost].sort();
      expect(eventFiles(dir)).toEqual(all);
      expect(refEvents(root)).toEqual(all);
      expectNeverIn(root, [`${String(dropped)}.json`]);
      expect(isAncestor(root, head, BOARD_REF)).toBe(false);
      expectKept(String(result.keptAt), resetTip, files);
      expectCheckClean(root, env);
    });

    it('a board with a remote whose branch was reset behind the recorded HEAD (its remote still has it) is another board too: the comparison is with the board HEAD, not its source tip (design.md, Alternatives)', () => {
      const env = syncEnv();
      const { root, dir } = standaloneProject(env, 2);
      writeEvents(dir, 1, 'orch', 50);
      syncStandalone(dir, env);
      const head = revParse(dir);
      const { temporary } = interruptedMove(root, env);
      git(dir, 'reset', '-q', '--hard', 'HEAD~1');
      expect(isAncestor(dir, head, 'HEAD')).toBe(false);
      expect(isAncestor(dir, head, 'refs/remotes/origin/main')).toBe(true);

      const result = move(root, env);

      expect(result.action).toBe('moved');
      expect(result.message).toContain(removedAsAnotherBoard(temporary, dir));
      expectMoved(root, env);
    });

    it('scenario: Board that only grew since the interrupted move is adopted: the resolution is an ancestor of refs/agentboard/board, both new events are in it, and the temporary is not named as removed', () => {
      const env = syncEnv();
      const { bRoot, bDir, remote } = conflictingClones(env);
      const head = revParse(bDir);
      expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');
      const temporary = String(registeredMigrating(bRoot)[0]);
      expect(readRecordFile(temporary, HEAD_RECORD)).toBe(`${head}\n`);
      resolveIgnoreConflicts(temporary);
      const resolvedHead = revParse(temporary);
      const grown = writeEvents(bDir, 2, 'b', 300);
      syncStandalone(bDir, env);
      expect(isAncestor(bDir, head, 'HEAD')).toBe(true);
      expect(revParse(bDir)).not.toBe(head);

      const result = move(bRoot, env);

      expect(result).toMatchObject({ action: 'moved', joined: true });
      expect(result.message).not.toContain(temporary);
      expect(result.message).not.toContain('another board');
      expectMoved(bRoot, env);
      expect(isAncestor(bRoot, resolvedHead, BOARD_REF)).toBe(true);
      for (const hash of grown) {
        expect(refEvents(bRoot)).toContain(`${hash}.json`);
        expect(refEvents(remote)).toContain(`${hash}.json`);
      }
      expectCheckClean(bRoot, env);
    });

    it('a replacement that is a clone of the same board at a reused inode holds the recorded HEAD and is adopted (design.md, "A rewritten history is another board")', () => {
      const env = syncEnv();
      const { bRoot, bDir, boardRemote } = conflictingClones(env);
      expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');
      const temporary = String(registeredMigrating(bRoot)[0]);
      resolveIgnoreConflicts(temporary);
      const resolvedHead = revParse(temporary);
      rmSync(bDir, { recursive: true, force: true });
      git(bRoot, 'clone', '-q', boardRemote, bDir);
      simulateInodeReuse(temporary, bDir);

      const result = move(bRoot, env);

      expect(result.action).toBe('moved');
      expect(result.message).not.toContain(temporary);
      expectMoved(bRoot, env);
      expect(isAncestor(bRoot, resolvedHead, BOARD_REF)).toBe(true);
      expectCheckClean(bRoot, env);
    });

    it('scenario: Temporary of an earlier version on this board is adopted: a 0.2.0 temporary holding a finished resolution completes the move with exit 0, the resolution kept, every event in the ref', () => {
      const env = syncEnv();
      const { bRoot, bDir, remote, shared, fromA, fromB } = conflictingClones(env);
      expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');
      const temporary = String(registeredMigrating(bRoot)[0]);
      const resolved = resolveIgnoreConflicts(temporary);
      const resolvedHead = revParse(temporary);
      rmSync(recordPath(temporary, HEAD_RECORD), { force: true });
      expect(readRecordFile(temporary, SOURCE_RECORD)).toBe(gitDirIdentity(bDir));

      const result = move(bRoot, env);

      expect(result).toMatchObject({ action: 'moved', joined: true, events: 3 });
      expect(result.message).not.toContain(temporary);
      expectMoved(bRoot, env);
      const all = [...shared, `${fromA}.json`, ...fromB.map((h) => `${h}.json`)].sort();
      expect(eventFiles(bDir)).toEqual(all);
      expect(refEvents(bRoot)).toEqual(all);
      expect(refEvents(remote)).toEqual(all);
      expect(isAncestor(bRoot, resolvedHead, BOARD_REF)).toBe(true);
      expect(readFileSync(join(bDir, '.gitignore'), 'utf8')).toBe(resolved);
      expectCheckClean(bRoot, env);
    });

    it('scenario: Temporary of an earlier version on a replaced board whose git directory reuses the inode: removed and named, the new board moved with exit 0, nothing of the old board in refs/agentboard/board', () => {
      const env = syncEnv();
      const { root, dir } = standaloneProject(env, 3);
      const oldFiles = eventFiles(dir);
      const { temporary, fromHost } = interruptedMove(root, env);
      rmSync(recordPath(temporary, HEAD_RECORD), { force: true });
      const replacement = replaceBoard(root, dir, env);
      simulateInodeReuse(temporary, dir);
      expect(isAncestor(dir, String(refCommit(root, MIGRATING_REF)), 'HEAD')).toBe(false);

      const result = move(root, env);

      expect(result).toMatchObject({ action: 'moved', events: 4 });
      expect(result.message).toContain(removedAsAnotherBoard(temporary, dir));
      expectMoved(root, env);
      const all = [...replacement.files, ...fromHost].sort();
      expect(eventFiles(dir)).toEqual(all);
      expect(refEvents(root)).toEqual(all);
      expectNeverIn(root, oldFiles);
      expectKept(String(result.keptAt), replacement.tip, replacement.files);
      expectCheckClean(root, env);
    });

    it('a temporary without agentboard-source is judged by the round 5 ruling 5 check whatever its agentboard-source-head says (design.md table, last row): adopted when its integrated tip is in the board history', () => {
      const env = syncEnv();
      const { root, dir, tip } = standaloneProject(env, 3);
      const { temporary } = interruptedMove(root, env);
      rmSync(recordPath(temporary, SOURCE_RECORD));
      writeFileSync(recordPath(temporary, HEAD_RECORD), `${'f'.repeat(40)}\n`);
      expect(isAncestor(dir, String(refCommit(root, MIGRATING_REF)), tip)).toBe(true);

      const result = move(root, env);

      expect(result.action).toBe('moved');
      expect(result.message).not.toContain(temporary);
      expectMoved(root, env);
    });

    // Each row rewrites the HEAD record of an otherwise adoptable temporary
    // of this board (identity equal, integrated tip in its history). Only a
    // full object name of the board's hash algorithm, with at most one
    // trailing newline, is read as a recorded HEAD; anything else, and a
    // name the board's repository does not have as a commit, is not an
    // ancestor, so the temporary is removed and named (design.md, "When in
    // doubt the move does not adopt").
    it.each<[string, boolean, (tip: string, dir: string) => string | null]>([
      ['the full HEAD the move began from (control)', true, (tip) => `${tip}\n`],
      ['empty', false, () => ''],
      ['a newline only', false, () => '\n'],
      ['not hexadecimal', false, () => 'not-a-commit\n'],
      ['a ref name (HEAD)', false, () => 'HEAD\n'],
      ['a branch name (main)', false, () => 'main\n'],
      ['an abbreviated object name of that HEAD', false, (tip) => `${tip.slice(0, 12)}\n`],
      ['a revision expression on that HEAD', false, (tip) => `${tip}^0\n`],
      ['that HEAD followed by a second line', false, (tip) => `${tip}\n${tip}\n`],
      ['64 hexadecimal digits in a SHA-1 repository', false, (tip) => `${tip}${'0'.repeat(24)}\n`],
      ['a full name the board repository does not have', false, () => `${'f'.repeat(40)}\n`],
      ['the full name of a tree, not a commit', false, (tip, dir) => `${git(dir, 'rev-parse', `${tip}^{tree}`).trim()}\n`],
      ['unreadable (a directory)', false, () => null],
      ['that HEAD in upper-case hexadecimal', false, (tip) => `${tip.toUpperCase()}\n`],
      ['that HEAD with a leading space', false, (tip) => ` ${tip}\n`],
      ['that HEAD with a trailing space', false, (tip) => `${tip} \n`],
      ['that HEAD after a leading newline', false, (tip) => `\n${tip}\n`],
      ['that HEAD with two trailing newlines', false, (tip) => `${tip}\n\n`],
      ['that HEAD with a carriage return before the newline', false, (tip) => `${tip}\r\n`],
      ['that HEAD without a trailing newline', true, (tip) => tip],
    ])('a temporary of this board whose agentboard-source-head is %s: adopted %s', (_label, adopted, content) => {
      const env = syncEnv();
      const { root, dir, tip } = standaloneProject(env, 3);
      const { temporary } = interruptedMove(root, env);
      const path = recordPath(temporary, HEAD_RECORD);
      rmSync(path, { recursive: true, force: true });
      const text = content(tip, dir);
      if (text === null) {
        mkdirSync(path);
      } else {
        writeFileSync(path, text);
      }

      const result = move(root, env);

      expect(result.action).toBe('moved');
      expectMoved(root, env);
      if (adopted) {
        expect(result.message).not.toContain(temporary);
      } else {
        expect(result.message).toContain(removedAsAnotherBoard(temporary, dir));
      }
    });

    it('the identity is checked first: with an agentboard-source naming another git directory, no git command is given the recorded HEAD', () => {
      const env = syncEnv();
      const { root, dir } = standaloneProject(env, 3);
      const { temporary } = interruptedMove(root, env);
      const sentinel = 'e'.repeat(40);
      writeFileSync(recordPath(temporary, HEAD_RECORD), `${sentinel}\n`);
      // A real replacement at another inode (the old board is moved aside
      // and removed only once the replacement exists, as in the round 4
      // ruling 3 test), so the identity differs.
      const oldGitDir = fs.statSync(join(dir, '.git'));
      const aside = join(tempDir(), 'replaced-board');
      fs.renameSync(dir, aside);
      syncedStandalone(root, env, 2, bareRemote(), 'other');
      rmSync(aside, { recursive: true, force: true });
      const newGitDir = fs.statSync(join(dir, '.git'));
      expect([newGitDir.dev, newGitDir.ino]).not.toEqual([oldGitDir.dev, oldGitDir.ino]);
      const { env: recording, calls } = withRecordingGitShim(env);

      const result = move(root, recording);

      expect(result.action).toBe('moved');
      expect(result.message).toContain(removedAsAnotherBoard(temporary, dir));
      expect(calls().length).toBeGreaterThan(0);
      expect(calls().filter((c) => c.includes(sentinel))).toEqual([]);
    });
  });

  /**
   * Review round 1 (orchestrator ruling on reviewer-gst-2; design.md
   * "Adopt only on the same git directory and the same history", test 3,
   * and "Record the step-1 HEAD beside the identity", atomic writes).
   */
  describe('1.4 review round 1: the integrated tip, atomic records, unreadable identity', () => {
    /**
     * A move of the board in a fresh project whose source tip (its
     * remote-tracking `origin/main`) is ahead of its HEAD: another clone
     * synced two events X to the board's remote that this clone never
     * pulled. The move integrates X and loses the compare-and-swap, so a
     * temporary that integrated X stays, recording the clone's HEAD.
     */
    function interruptedMoveWithRemoteAhead(env: Env): {
      root: string;
      dir: string;
      boardRemote: string;
      head: string;
      xFiles: string[];
      temporary: string;
    } {
      const { root, remote, dir, boardRemote, tip } = standaloneProject(env, 3);
      const other = cloneWithStandalone(remote, boardRemote, 'other');
      const x = writeEvents(other.dir, 2, 'xavier', 50);
      syncStandalone(other.dir, env);
      expect(revParse(dir)).toBe(tip);
      const { temporary } = interruptedMove(root, env);
      const xFiles = x.map((h) => `${h}.json`);
      for (const file of xFiles) {
        expect(existsSync(join(temporary, 'events', file))).toBe(true);
      }
      return { root, dir, boardRemote, head: tip, xFiles, temporary };
    }

    it('scenario: Board remote rewritten since the interrupted move: the temporary that integrated the dropped events is removed and named, and neither dropped event reaches refs/agentboard/board', () => {
      const env = syncEnv();
      const fx = interruptedMoveWithRemoteAhead(env);
      // The remote is force-reset to the HEAD the move began from, dropping
      // X on purpose; the board then syncs a new event (HEAD only grows).
      git(fx.boardRemote, 'update-ref', 'refs/heads/main', fx.head);
      writeEvents(fx.dir, 1, 'yolanda', 70);
      syncStandalone(fx.dir, env);
      expect(isAncestor(fx.dir, fx.head, 'HEAD')).toBe(true);
      expect(eventFiles(fx.dir).some((f) => fx.xFiles.includes(f))).toBe(false);
      const files = eventFiles(fx.dir);

      const result = move(fx.root, env);

      expect(result.action).toBe('moved');
      expect(result.message).toContain(removedAsAnotherBoard(fx.temporary, fx.dir));
      expectMoved(fx.root, env);
      expectNeverIn(fx.root, fx.xFiles);
      for (const file of files) {
        expect(refEvents(fx.root)).toContain(file);
      }
      expect(eventFiles(fx.dir).some((f) => fx.xFiles.includes(f))).toBe(false);
      expectCheckClean(fx.root, env);
    });

    it('scenario: Temporary of a replaced board forked at or after the HEAD the move began from: the fork is moved with exit 0, the temporary removed and named, nothing it alone held in refs/agentboard/board', () => {
      const env = syncEnv();
      const fx = interruptedMoveWithRemoteAhead(env);
      // .board becomes B: a fork of A at the recorded HEAD, with a remote of
      // its own and an event of its own, at a reused inode (simulated).
      rmSync(fx.dir, { recursive: true, force: true });
      git(fx.root, 'clone', '-q', fx.boardRemote, fx.dir);
      git(fx.dir, 'reset', '-q', '--hard', fx.head);
      git(fx.dir, 'remote', 'set-url', 'origin', bareRemote());
      git(fx.dir, 'push', '-q', 'origin', 'main');
      git(fx.dir, 'fetch', '-q', 'origin');
      git(fx.dir, 'branch', '-q', '-u', 'origin/main');
      const [own] = writeEvents(fx.dir, 1, 'zed', 90);
      syncStandalone(fx.dir, env);
      simulateInodeReuse(fx.temporary, fx.dir);
      expect(isAncestor(fx.dir, fx.head, 'HEAD')).toBe(true);

      const result = move(fx.root, env);

      expect(result.action).toBe('moved');
      expect(result.message).toContain(removedAsAnotherBoard(fx.temporary, fx.dir));
      expectMoved(fx.root, env);
      expectNeverIn(fx.root, fx.xFiles);
      expect(refEvents(fx.root)).toContain(`${String(own)}.json`);
      expectCheckClean(fx.root, env);
    });

    /**
     * Runs `run` with every write that targets a record file by its own
     * name (`writeFileSync`, `appendFileSync`, or `openSync` for writing)
     * simulated as torn by a kill: the file is left empty, as a truncating
     * write leaves it, and the call throws. An atomic write (a temporary
     * file in the same directory renamed onto the record) never triggers
     * it. Returns the record paths written in place and what `run` threw.
     */
    function withTornRecordWrites<T>(run: () => T): { inPlace: string[]; thrown: unknown; value: T | undefined } {
      const names = new Set([SOURCE_RECORD, HEAD_RECORD]);
      const inPlace: string[] = [];
      const real = {
        writeFileSync: fs.writeFileSync,
        appendFileSync: fs.appendFileSync,
        openSync: fs.openSync,
      };
      const target = (file: unknown): string | null =>
        (typeof file === 'string' || file instanceof URL || Buffer.isBuffer(file)) &&
        names.has(basename(file instanceof URL ? file.pathname : String(file)))
          ? String(file)
          : null;
      const tear = (path: string): never => {
        inPlace.push(path);
        real.writeFileSync(path, '');
        throw new Error(`simulated kill during the in-place write of ${path}`);
      };
      fs.writeFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]): void => {
        const path = target(file);
        if (path !== null) {
          tear(path);
        }
        (real.writeFileSync as (...a: unknown[]) => void)(file, ...rest);
      }) as typeof fs.writeFileSync;
      fs.appendFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]): void => {
        const path = target(file);
        if (path !== null) {
          tear(path);
        }
        (real.appendFileSync as (...a: unknown[]) => void)(file, ...rest);
      }) as typeof fs.appendFileSync;
      fs.openSync = ((file: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode | null): number => {
        const path = target(file);
        const writing =
          typeof flags === 'string'
            ? /[wa+]/.test(flags)
            : typeof flags === 'number' && (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0;
        if (path !== null && writing) {
          tear(path);
        }
        return real.openSync(file, flags ?? 'r', mode);
      }) as typeof fs.openSync;
      syncBuiltinESMExports();
      try {
        return { inPlace, thrown: undefined, value: run() };
      } catch (error) {
        return { inPlace, thrown: error, value: undefined };
      } finally {
        fs.writeFileSync = real.writeFileSync;
        fs.appendFileSync = real.appendFileSync;
        fs.openSync = real.openSync;
        syncBuiltinESMExports();
      }
    }

    it('the records an adopted 0.2.0 or record-less temporary gains are written atomically: no write of a record in place, so a kill there cannot leave an empty record that loses the resolution', () => {
      const env = syncEnv();
      for (const removedRecords of [[HEAD_RECORD], [SOURCE_RECORD, HEAD_RECORD]]) {
        const label = removedRecords.join('+');
        const { bRoot, bDir } = conflictingClones(env);
        expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');
        const temporary = String(registeredMigrating(bRoot)[0]);
        resolveIgnoreConflicts(temporary);
        const resolvedHead = revParse(temporary);
        for (const name of removedRecords) {
          rmSync(recordPath(temporary, name), { force: true });
        }
        const head = revParse(bDir);
        const identity = gitDirIdentity(bDir);

        const run = withTornRecordWrites(() => move(bRoot, env));

        expect(run.inPlace, label).toEqual([]);
        expect(run.thrown, label).toBeUndefined();
        expect(run.value?.action, label).toBe('moved');
        expect(run.value?.message, label).not.toContain(temporary);
        expectMoved(bRoot, env, 1, label);
        expect(isAncestor(bRoot, resolvedHead, BOARD_REF), label).toBe(true);
        // The adopted temporary is .board now; its git directory holds the records.
        expect(readRecordFile(bDir, HEAD_RECORD), label).toBe(`${head}\n`);
        expect(String(readRecordFile(bDir, SOURCE_RECORD)).replace(/\n$/, ''), label).toBe(identity);
      }
    });

    it('the records of a fresh temporary are written atomically too (step 3): no write of a record in place', () => {
      const env = syncEnv();
      const { bRoot } = conflictingClones(env);

      const run = withTornRecordWrites(() => move(bRoot, env));

      expect(run.inPlace).toEqual([]);
      expect(run.thrown).toBeInstanceOf(Error);
      expect((run.thrown as { reason?: unknown }).reason).toBe('sync-conflict');
      const temporary = String(registeredMigrating(bRoot)[0]);
      expect(readRecordFile(temporary, HEAD_RECORD)).toMatch(/^[0-9a-f]{40}\n$/);
      expect(readRecordFile(temporary, SOURCE_RECORD)).toMatch(/^\/.+:\d+:\d+$/);
    });

    it('an unreadable agentboard-source (a directory) names another board: the temporary is removed and named and the move completes, no raw file error', () => {
      const env = syncEnv();
      const { root, dir } = standaloneProject(env, 3);
      const { temporary } = interruptedMove(root, env);
      rmSync(recordPath(temporary, SOURCE_RECORD), { force: true });
      mkdirSync(recordPath(temporary, SOURCE_RECORD));

      const result = move(root, env);

      expect(result.action).toBe('moved');
      expect(result.message).toContain(removedAsAnotherBoard(temporary, dir));
      expectMoved(root, env);
    });

    it('an unreadable agentboard-source of a stopped temporary: the sync-in-progress refusal saying another board, nothing removed, no raw file error', () => {
      const env = syncEnv();
      const { bRoot, bDir } = conflictingClones(env);
      expectBoardError(() => move(bRoot, env), 3, 'sync-conflict');
      const temporary = String(registeredMigrating(bRoot)[0]);
      rmSync(recordPath(temporary, SOURCE_RECORD), { force: true });
      mkdirSync(recordPath(temporary, SOURCE_RECORD));

      const err = expectBoardError(() => move(bRoot, env), 3, 'sync-in-progress');

      expect(err.message).toContain(`temporary worktree at ${temporary}${anotherBoardParenthesis(bDir)}; resolve`);
      expect(rebaseInProgress(temporary)).toBe(true);
      expect(registeredMigrating(bRoot)).toEqual([temporary]);
    });

    it('the identity check applies to a 0.2.0 temporary (mutant M8): one recording another git directory is removed and named although the tip it integrated is in the board history', () => {
      const env = syncEnv();
      const { root, dir } = standaloneProject(env, 3);
      const { temporary } = interruptedMove(root, env);
      rmSync(recordPath(temporary, HEAD_RECORD), { force: true });
      const [path, dev, ino] = gitDirIdentity(dir).split(/:(?=\d+:\d+$)|:(?=\d+$)/);
      writeFileSync(recordPath(temporary, SOURCE_RECORD), `${String(path)}:${String(dev)}:${String(Number(ino) + 1)}`);
      expect(isAncestor(dir, String(refCommit(root, MIGRATING_REF)), 'refs/remotes/origin/main')).toBe(true);

      const result = move(root, env);

      expect(result.action).toBe('moved');
      expect(result.message).toContain(removedAsAnotherBoard(temporary, dir));
      expectMoved(root, env);
    });
  });
});
