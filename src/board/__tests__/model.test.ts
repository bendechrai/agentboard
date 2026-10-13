/**
 * Board model detection (add-board-sharing task 1.2; board-events "Board
 * model detection"): one test per model, including a temporary directory
 * behind a symlink and the two broken-link cases (the `.git` file's target
 * is missing; a worktree of another repository), and `sync` on a broken
 * link: exit 2 `board-link-broken`, changing nothing (scenario "Stale board
 * copied into a fresh clone"), while `list` still works (scenario "Board
 * commands work on a broken link").
 */

import { cpSync, existsSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { run } from '../../cli/__tests__/cli-helpers.js';
import { P, T1, T3, ev, putEvent } from '../../store/__tests__/helpers.js';
import { initBoard } from '../init.js';
import { BOARD_REF, BOARD_REF_NAMESPACE, MODEL_TEXT, detectBoardModel } from '../model.js';
import { syncBoard } from '../sync.js';
import {
  cleanEnv,
  expectBoardError,
  git,
  gitRepo,
  makeBoardDir,
  openTracked,
  tempDir,
} from './helpers.js';
import {
  commitHostEvent,
  hostBoard,
  hostRepo,
  real,
  refs,
  snapshotDir,
  worktrees,
} from './sharing-helpers.js';
import { bareRemote, syncEnv } from './sync-helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe('the board ref', () => {
  it('is refs/agentboard/board in the reserved namespace', () => {
    expect(BOARD_REF).toBe('refs/agentboard/board');
    expect(BOARD_REF_NAMESPACE).toBe('refs/agentboard/');
    expect(BOARD_REF.startsWith(BOARD_REF_NAMESPACE)).toBe(true);
    expect(MODEL_TEXT).toEqual({
      host: 'host',
      standalone: 'standalone',
      'broken-host-link': 'broken host link',
      'not-a-repository': 'not a repository',
    });
  });
});

/** A standalone board (its own repository, as `init` makes one today) at `<root>/.board`; `root` may be a git repository. */
function standalone(root = tempDir()): string {
  return initBoard({ cwd: root, env: syncEnv() }).dir;
}

describe('detectBoardModel', () => {
  it('host: a linked worktree whose common directory is the parent repository', () => {
    const env = syncEnv();
    const { root, dir } = hostBoard(env);
    const info = detectBoardModel(dir, { env });
    expect(info).toEqual({
      dir,
      model: 'host',
      gitDir: real(join(root, '.git')),
      detail: null,
    });
  });

  it('host: the same through a symlink to the host directory', () => {
    const env = syncEnv();
    const { root } = hostBoard(env);
    const link = join(tempDir(), 'link-to-host');
    symlinkSync(root, link);
    const viaLink = join(link, '.board');
    const info = detectBoardModel(viaLink, { env });
    expect(info.model).toBe('host');
    expect(info.gitDir).toBe(real(join(root, '.git')));
    expect(info.dir).toBe(viaLink);
  });

  it('host: a temporary directory behind a symlink (the parent is reached through a link)', () => {
    const env = syncEnv();
    const parent = tempDir();
    const link = join(tempDir(), 'tmp-link');
    symlinkSync(parent, link);
    const { dir } = hostBoard(env, hostRepo(join(link, 'host')));
    expect(dir.startsWith(link)).toBe(true);
    const info = detectBoardModel(dir, { env });
    expect(info.model).toBe('host');
    expect(info.gitDir).toBe(real(join(parent, 'host', '.git')));
    expect(detectBoardModel(join(parent, 'host', '.board'), { env }).model).toBe('host');
  });

  it('standalone: a repository of its own, outside and inside a git host', () => {
    const env = syncEnv();
    const plain = standalone();
    expect(detectBoardModel(plain, { env })).toEqual({
      dir: plain,
      model: 'standalone',
      gitDir: real(join(plain, '.git')),
      detail: null,
    });
    const inHost = standalone(gitRepo(join(tempDir(), 'host')));
    expect(detectBoardModel(inHost, { env }).model).toBe('standalone');
    expect(detectBoardModel(inHost, { env }).gitDir).toBe(real(join(inHost, '.git')));
  });

  it('standalone: through a symlink to the board directory', () => {
    const env = syncEnv();
    const dir = standalone();
    const link = join(tempDir(), 'board-link');
    symlinkSync(dir, link);
    const info = detectBoardModel(link, { env });
    expect(info.model).toBe('standalone');
    expect(info.gitDir).toBe(real(join(dir, '.git')));
  });

  it('broken host link: the .git file names a missing directory (the host was moved)', () => {
    const env = syncEnv();
    const { root } = hostBoard(env);
    const moved = join(tempDir(), 'moved-host');
    renameSync(root, moved);
    const dir = join(moved, '.board');
    const info = detectBoardModel(dir, { env });
    expect(info.model).toBe('broken-host-link');
    expect(info.gitDir).toBeNull();
    expect(info.detail).toMatch(/^[\x20-\x7e]+$/);
    expect(info.detail).toMatch(/missing|not found|does not exist/i);
  });

  it('broken host link: a worktree of another repository (a stale copy in a fresh clone)', () => {
    const env = syncEnv();
    const a = hostBoard(env);
    const c = hostRepo(join(tempDir(), 'clone-c'));
    cpSync(a.dir, join(c, '.board'), { recursive: true });
    const info = detectBoardModel(join(c, '.board'), { env });
    expect(info.model).toBe('broken-host-link');
    expect(info.gitDir).toBeNull();
    expect(info.detail).toMatch(/^[\x20-\x7e]+$/);
    expect(info.detail).toMatch(/other|another|different/i);
    // Clone A is still healthy.
    expect(detectBoardModel(a.dir, { env }).model).toBe('host');
  });

  it('broken host link: a copied worktree whose parent is not a repository at all', () => {
    const env = syncEnv();
    const a = hostBoard(env);
    const parent = tempDir();
    cpSync(a.dir, join(parent, '.board'), { recursive: true });
    expect(detectBoardModel(join(parent, '.board'), { env }).model).toBe('broken-host-link');
  });

  it('not a repository: a plain directory with events', () => {
    const env = syncEnv();
    const dir = makeBoardDir(tempDir());
    expect(detectBoardModel(dir, { env })).toEqual({
      dir,
      model: 'not-a-repository',
      gitDir: null,
      detail: null,
    });
  });

  it('not a repository: a plain subdirectory of the host repository', () => {
    const env = syncEnv();
    const host = gitRepo(join(tempDir(), 'host'));
    const dir = makeBoardDir(host);
    expect(detectBoardModel(dir, { env }).model).toBe('not-a-repository');
    expect(detectBoardModel(dir, { env }).gitDir).toBeNull();
  });

  it('not a repository: a directory that does not exist', () => {
    const env = syncEnv();
    const dir = join(tempDir(), 'nowhere', '.board');
    expect(detectBoardModel(dir, { env }).model).toBe('not-a-repository');
  });

  it('not a repository when git cannot be run', () => {
    const { dir } = hostBoard(syncEnv());
    const info = detectBoardModel(dir, { env: cleanEnv({ PATH: '' }) });
    expect(info.model).toBe('not-a-repository');
    expect(info.gitDir).toBeNull();
  });

  it('ignores GIT_DIR and the other repository variables of the environment', () => {
    const env = syncEnv();
    const other = gitRepo(join(tempDir(), 'other'));
    const { root, dir } = hostBoard(env);
    const info = detectBoardModel(dir, {
      env: { ...env, GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other },
    });
    expect(info.model).toBe('host');
    expect(info.gitDir).toBe(real(join(root, '.git')));
  });

  it('changes nothing in the host, the board or a broken copy', () => {
    const env = syncEnv();
    const a = hostBoard(env);
    const c = hostRepo(join(tempDir(), 'clone-c'));
    cpSync(a.dir, join(c, '.board'), { recursive: true });
    const before = [refs(a.root), worktrees(a.root), snapshotDir(a.dir), refs(c), snapshotDir(c)];
    detectBoardModel(a.dir, { env });
    detectBoardModel(join(c, '.board'), { env });
    expect([refs(a.root), worktrees(a.root), snapshotDir(a.dir), refs(c), snapshotDir(c)]).toEqual(
      before,
    );
  });
});

describe('sync on a broken host link', () => {
  /**
   * Clone A with a host-model board holding one committed event, pushed
   * to a bare remote (the project branch only: a plain clone never carries
   * the board), and a fresh clone C of the project into which A's `.board`
   * was copied.
   */
  function staleCopy(): { aRoot: string; aDir: string; cRoot: string; cDir: string } {
    const env = syncEnv();
    const remote = bareRemote();
    const a = hostBoard(env);
    git(a.root, 'remote', 'add', 'origin', remote);
    git(a.root, 'push', '-q', 'origin', 'main');
    commitHostEvent(a.dir, ev(P.create(T1, 'Stale'), 'orch', 1000), env);
    const cRoot = join(tempDir(), 'clone-c');
    git(tempDir(), 'clone', '-q', remote, cRoot);
    expect(git(cRoot, 'for-each-ref', 'refs/agentboard/')).toBe('');
    const cDir = join(cRoot, '.board');
    cpSync(a.dir, cDir, { recursive: true });
    return { aRoot: a.root, aDir: a.dir, cRoot, cDir };
  }

  it('scenario: stale board copied into a fresh clone exits 2 board-link-broken and changes nothing', () => {
    const env = syncEnv();
    const { aRoot, aDir, cRoot, cDir } = staleCopy();
    const snapshot = (): unknown[] => [
      refs(aRoot),
      worktrees(aRoot),
      snapshotDir(aDir),
      refs(cRoot),
      worktrees(cRoot),
      snapshotDir(cDir),
    ];
    const before = snapshot();
    const board = openTracked(cDir);

    const err = expectBoardError(() => syncBoard(board, { env }), 2, 'board-link-broken');

    expect(err.message).toContain(cDir);
    expect(err.message).toContain('agentboard init');
    expect(err.message).toMatch(/^[\x20-\x7e]+$/);
    expect(snapshot()).toEqual(before);
    expect(git(cRoot, 'for-each-ref', 'refs/agentboard/')).toBe('');
    expect(git(cRoot, 'status', '--porcelain')).toBe('');
  });

  it('a moved host exits 2 board-link-broken, naming the directory and agentboard init', () => {
    const env = syncEnv();
    const { root } = hostBoard(env);
    commitHostEvent(join(root, '.board'), ev(P.create(T1, 'Moved'), 'orch', 1000), env);
    const moved = join(tempDir(), 'moved-host');
    renameSync(root, moved);
    const dir = join(moved, '.board');
    const before = snapshotDir(dir);
    const board = openTracked(dir);

    const err = expectBoardError(() => syncBoard(board, { env }), 2, 'board-link-broken');

    expect(err.message).toContain(dir);
    expect(err.message).toContain('agentboard init');
    expect(snapshotDir(dir)).toEqual(before);
  });

  it('scenario: board commands work on a broken link (list shows the tickets, exit 0)', () => {
    const { cRoot, cDir } = staleCopy();
    const env = syncEnv();
    // One more event written straight into the copied board, never committed.
    putEvent(join(cDir, 'events'), ev(P.create(T3, 'Local'), 'orch', 2000));

    const out = run(['list', '--json'], cRoot, env);

    expect(out.code, out.stderr).toBe(0);
    const titles = (JSON.parse(out.stdout) as { title: string }[]).map((t) => t.title).sort();
    expect(titles).toEqual(['Local', 'Stale']);
  });

  it('the standalone refusals are unchanged: a plain directory is board-not-a-repository', () => {
    const env = syncEnv();
    const board = openTracked(makeBoardDir(tempDir()));
    expectBoardError(() => syncBoard(board, { env }), 2, 'board-not-a-repository');
    expect(existsSync(join(board.dir, '.git'))).toBe(false);
  });

  it('a .git file is never created by a refused sync', () => {
    const env = syncEnv();
    const host = gitRepo(join(tempDir(), 'host'));
    const board = openTracked(makeBoardDir(host));
    writeFileSync(join(host, 'README'), 'host\n');
    expectBoardError(() => syncBoard(board, { env }), 2, 'board-not-a-repository');
    expect(existsSync(join(board.dir, '.git'))).toBe(false);
    expect(git(host, 'status', '--porcelain')).toContain('README');
  });
});
