import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BoardError } from '../errors.js';
import { BOARD_DIR_ENV, BOARD_DIR_NAME, boardExists, findBoard, locateBoard } from '../locate.js';
import { cleanEnv, git, gitRepo, makeBoardDir, tempDir } from './helpers.js';

/** realpath of a path that exists, for comparing across /var -> /private/var. */
const real = (p: string): string => realpathSync(p);

function expectNotFound(fn: () => unknown): BoardError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BoardError);
    const err = error as BoardError;
    expect(err.exitCode).toBe(2);
    expect(err.reason).toBe('board-not-found');
    return err;
  }
  throw new Error('expected a BoardError');
}

describe('constants', () => {
  it('names the board directory and the override variable', () => {
    expect(BOARD_DIR_NAME).toBe('.board');
    expect(BOARD_DIR_ENV).toBe('AGENTBOARD_DIR');
  });
});

describe('locateBoard', () => {
  it('uses AGENTBOARD_DIR when set, even inside a different git repository', () => {
    const root = tempDir();
    const board = makeBoardDir(root, 'elsewhere-board');
    const repo = gitRepo(join(root, 'repo'));
    makeBoardDir(repo);
    const loc = locateBoard({ cwd: repo, env: cleanEnv({ AGENTBOARD_DIR: board }) });
    expect(loc.source).toBe('env');
    expect(loc.dir).toBe(board);
  });

  it('resolves a relative AGENTBOARD_DIR against cwd', () => {
    const root = tempDir();
    const loc = locateBoard({ cwd: root, env: cleanEnv({ AGENTBOARD_DIR: 'sub/../b' }) });
    expect(loc).toEqual({ dir: join(root, 'b'), source: 'env' });
  });

  it('uses AGENTBOARD_DIR even when it does not exist', () => {
    const root = tempDir();
    const missing = join(root, 'nope');
    expect(locateBoard({ cwd: root, env: cleanEnv({ AGENTBOARD_DIR: missing }) })).toEqual({
      dir: missing,
      source: 'env',
    });
  });

  it('ignores an empty AGENTBOARD_DIR', () => {
    const root = tempDir();
    const loc = locateBoard({ cwd: root, env: cleanEnv({ AGENTBOARD_DIR: '' }) });
    expect(loc.source).toBe('cwd');
  });

  it('finds <repo>/.board at the root of a git repository', () => {
    const repo = gitRepo(join(tempDir(), 'repo'));
    const board = makeBoardDir(repo);
    const loc = locateBoard({ cwd: repo, env: cleanEnv() });
    expect(loc.source).toBe('git');
    expect(real(loc.dir)).toBe(real(board));
  });

  it('finds the repository board from a nested subdirectory', () => {
    const repo = gitRepo(join(tempDir(), 'repo'));
    const board = makeBoardDir(repo);
    const nested = join(repo, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    const loc = locateBoard({ cwd: nested, env: cleanEnv() });
    expect(loc.source).toBe('git');
    expect(real(loc.dir)).toBe(real(board));
  });

  it('resolves to the repository board path even before the board exists', () => {
    const repo = gitRepo(join(tempDir(), 'repo'));
    const loc = locateBoard({ cwd: repo, env: cleanEnv() });
    expect(loc.source).toBe('git');
    expect(basename(loc.dir)).toBe('.board');
    expect(real(join(loc.dir, '..'))).toBe(real(repo));
  });

  it("finds the main checkout's board from a linked worktree", () => {
    const root = tempDir();
    const repo = gitRepo(join(root, 'main'));
    const board = makeBoardDir(repo);
    const worktree = join(root, 'linked');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', worktree);
    const fromWorktree = locateBoard({ cwd: worktree, env: cleanEnv() });
    expect(fromWorktree.source).toBe('git');
    expect(real(fromWorktree.dir)).toBe(real(board));
    const sub = join(worktree, 'deep');
    mkdirSync(sub);
    expect(real(locateBoard({ cwd: sub, env: cleanEnv() }).dir)).toBe(real(board));
  });

  it('does not pick up a .board inside the linked worktree itself', () => {
    const root = tempDir();
    const repo = gitRepo(join(root, 'main'));
    const board = makeBoardDir(repo);
    const worktree = join(root, 'linked');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', worktree);
    makeBoardDir(worktree);
    expect(real(locateBoard({ cwd: worktree, env: cleanEnv() }).dir)).toBe(real(board));
  });

  it('falls back to ./.board outside any git repository', () => {
    const dir = join(tempDir(), 'plain');
    mkdirSync(dir);
    expect(locateBoard({ cwd: dir, env: cleanEnv() })).toEqual({
      dir: join(dir, '.board'),
      source: 'cwd',
    });
  });

  it('falls back to ./.board when git is not on the PATH', () => {
    const repo = gitRepo(join(tempDir(), 'repo'));
    const loc = locateBoard({ cwd: repo, env: cleanEnv({ PATH: join(repo, 'no-bin') }) });
    expect(loc).toEqual({ dir: join(repo, '.board'), source: 'cwd' });
  });

  it('passes env to git (GIT_DIR in env is honoured)', () => {
    const root = tempDir();
    const repo = gitRepo(join(root, 'repo'));
    const other = join(root, 'other');
    mkdirSync(other);
    const loc = locateBoard({ cwd: other, env: cleanEnv({ GIT_DIR: join(repo, '.git') }) });
    expect(loc.source).toBe('git');
    expect(real(join(loc.dir, '..'))).toBe(real(repo));
  });
});

describe('boardExists', () => {
  it('is true for a directory with an events subdirectory', () => {
    expect(boardExists(makeBoardDir(tempDir()))).toBe(true);
  });

  it('is false for a missing path, a plain file, or a directory without events', () => {
    const root = tempDir();
    expect(boardExists(join(root, 'missing'))).toBe(false);
    const file = join(root, 'file');
    writeFileSync(file, 'x');
    expect(boardExists(file)).toBe(false);
    const empty = join(root, 'empty');
    mkdirSync(empty);
    expect(boardExists(empty)).toBe(false);
    const eventsFile = join(root, 'eventsfile');
    mkdirSync(eventsFile);
    writeFileSync(join(eventsFile, 'events'), 'x');
    expect(boardExists(eventsFile)).toBe(false);
  });
});

describe('findBoard', () => {
  it('returns the location when a board exists there', () => {
    const repo = gitRepo(join(tempDir(), 'repo'));
    const board = makeBoardDir(repo);
    const loc = findBoard({ cwd: repo, env: cleanEnv() });
    expect(loc.source).toBe('git');
    expect(real(loc.dir)).toBe(real(board));
  });

  it('exits 2 naming ./.board outside a git repository with no board', () => {
    const dir = join(tempDir(), 'plain');
    mkdirSync(dir);
    const err = expectNotFound(() => findBoard({ cwd: dir, env: cleanEnv() }));
    expect(err.message).toContain('./.board');
    expect(err.message).toContain(join(dir, '.board'));
  });

  it('exits 2 naming <repo>/.board inside a git repository with no board', () => {
    const repo = gitRepo(join(tempDir(), 'repo'));
    const expected = locateBoard({ cwd: repo, env: cleanEnv() }).dir;
    const err = expectNotFound(() => findBoard({ cwd: repo, env: cleanEnv() }));
    expect(err.message).toContain(expected);
  });

  it('exits 2 naming AGENTBOARD_DIR when it holds no board', () => {
    const root = tempDir();
    const missing = join(root, 'nope');
    const err = expectNotFound(() =>
      findBoard({ cwd: root, env: cleanEnv({ AGENTBOARD_DIR: missing }) }),
    );
    expect(err.message).toContain(missing);
  });

  it('does not fall through to another rule when the resolved path has no board', () => {
    const root = tempDir();
    makeBoardDir(root);
    // cwd has a ./.board, but AGENTBOARD_DIR wins and names a path with none.
    expectNotFound(() =>
      findBoard({ cwd: root, env: cleanEnv({ AGENTBOARD_DIR: join(root, 'x') }) }),
    );
  });
});
