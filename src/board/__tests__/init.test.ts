import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { findBoard } from '../../store/locate.js';
import { BOARD_GITIGNORE_LINES, HOST_GITIGNORE_ENTRY, initBoard } from '../init.js';
import { cleanEnv, expectBoardError, git, gitRepo, tempDir } from './helpers.js';

/** Every file under `dir` (recursively) with its content and mtime, for "nothing changed" checks. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) {
        out[`${relative(dir, path)}/`] = String(statSync(path).mtimeMs);
        walk(path);
      } else {
        out[relative(dir, path)] =
          `${readFileSync(path, 'base64')}@${String(statSync(path).mtimeMs)}`;
      }
    }
  };
  walk(dir);
  return out;
}

/** True when git in `repo` ignores `path` (relative to `repo`). */
function ignored(repo: string, path: string): boolean {
  try {
    git(repo, 'check-ignore', '-q', path);
    return true;
  } catch {
    return false;
  }
}

describe('initBoard at the root of a git repository', () => {
  it('creates .board as a git repository with events/.gitkeep and a cache .gitignore', () => {
    const repo = gitRepo(join(tempDir(), 'proj'));
    const result = initBoard({ cwd: repo, env: cleanEnv() });
    const dir = join(repo, '.board');
    expect(result.dir).toBe(dir);
    expect(result.created).toBe(true);
    expect(result.message).toContain(dir);

    // A git repository of its own.
    expect(git(dir, 'rev-parse', '--git-dir').trim()).toBe('.git');
    // events/ contains only an empty .gitkeep.
    expect(readdirSync(join(dir, 'events'))).toEqual(['.gitkeep']);
    expect(readFileSync(join(dir, 'events', '.gitkeep'), 'utf8')).toBe('');
    // The cache and its WAL and SHM files are ignored by the board repository.
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe(
      BOARD_GITIGNORE_LINES.map((line) => `${line}\n`).join(''),
    );
    for (const name of ['cache.sqlite', 'cache.sqlite-wal', 'cache.sqlite-shm']) {
      expect(ignored(dir, name), name).toBe(true);
    }
    expect(ignored(dir, 'events/abc.json')).toBe(false);
  });

  it('adds .board/ to the host .gitignore, creating it when absent', () => {
    const repo = gitRepo(join(tempDir(), 'proj'));
    const result = initBoard({ cwd: repo, env: cleanEnv() });
    expect(HOST_GITIGNORE_ENTRY).toBe('.board/');
    expect(result.hostGitignore).toBe(join(repo, '.gitignore'));
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('.board/\n');
    expect(ignored(repo, '.board/events/x.json')).toBe(true);
  });

  it('appends to an existing host .gitignore, keeping its content byte for byte', () => {
    const repo = gitRepo(join(tempDir(), 'proj'));
    writeFileSync(join(repo, '.gitignore'), 'node_modules\ndist');
    initBoard({ cwd: repo, env: cleanEnv() });
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('node_modules\ndist\n.board/\n');
  });

  it.each(['.board/', '.board', '/.board/', '/.board', '  .board/  '])(
    'leaves a host .gitignore that already lists %j untouched',
    (line) => {
      const repo = gitRepo(join(tempDir(), 'proj'));
      const content = `node_modules\n${line}\n`;
      writeFileSync(join(repo, '.gitignore'), content);
      const result = initBoard({ cwd: repo, env: cleanEnv() });
      expect(result.created).toBe(true);
      expect(result.hostGitignore).toBeNull();
      expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe(content);
    },
  );

  it('is found by discovery afterwards', () => {
    const repo = gitRepo(join(tempDir(), 'proj'));
    initBoard({ cwd: repo, env: cleanEnv() });
    expect(findBoard({ cwd: repo, env: cleanEnv() }).dir).toBe(join(repo, '.board'));
  });
});

describe('initBoard is idempotent', () => {
  it('creates and modifies nothing when the board exists, and says so', () => {
    const repo = gitRepo(join(tempDir(), 'proj'));
    initBoard({ cwd: repo, env: cleanEnv() });
    const before = snapshot(repo);
    const again = initBoard({ cwd: repo, env: cleanEnv() });
    expect(again).toMatchObject({ dir: join(repo, '.board'), created: false, hostGitignore: null });
    expect(again.message).toMatch(/already exists/);
    expect(snapshot(repo)).toEqual(before);
  });

  it('does not add the host entry when the board already exists', () => {
    const repo = gitRepo(join(tempDir(), 'proj'));
    initBoard({ cwd: repo, env: cleanEnv() });
    writeFileSync(join(repo, '.gitignore'), 'other\n');
    initBoard({ cwd: repo, env: cleanEnv() });
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('other\n');
  });
});

describe('initBoard: where the board goes', () => {
  it("from a linked worktree, creates the main checkout's board", () => {
    const root = tempDir();
    const main = gitRepo(join(root, 'main'));
    const linked = join(root, 'linked');
    git(main, 'worktree', 'add', '-q', linked);
    const result = initBoard({ cwd: linked, env: cleanEnv() });
    expect(result.dir).toBe(join(main, '.board'));
    expect(existsSync(join(main, '.board', 'events', '.gitkeep'))).toBe(true);
    expect(existsSync(join(linked, '.board'))).toBe(false);
    expect(readFileSync(join(main, '.gitignore'), 'utf8')).toBe('.board/\n');
  });

  it('from a subdirectory of the repository, creates the board at the root', () => {
    const repo = gitRepo(join(tempDir(), 'proj'));
    const sub = join(repo, 'src', 'deep');
    mkdirSync(sub, { recursive: true });
    expect(initBoard({ cwd: sub, env: cleanEnv() }).dir).toBe(join(repo, '.board'));
    expect(existsSync(join(sub, '.board'))).toBe(false);
  });

  it('outside git, creates ./.board and a .gitignore beside it', () => {
    const dir = tempDir();
    const result = initBoard({ cwd: dir, env: cleanEnv() });
    expect(result.dir).toBe(join(dir, '.board'));
    expect(existsSync(join(dir, '.board', '.git'))).toBe(true);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('.board/\n');
  });

  it('with AGENTBOARD_DIR, creates the board there and touches no host .gitignore', () => {
    const root = tempDir();
    const repo = gitRepo(join(root, 'proj'));
    const target = join(root, 'shared-board');
    const result = initBoard({ cwd: repo, env: cleanEnv({ AGENTBOARD_DIR: target }) });
    expect(result).toMatchObject({ dir: target, created: true, hostGitignore: null });
    expect(readdirSync(join(target, 'events'))).toEqual(['.gitkeep']);
    expect(existsSync(join(repo, '.gitignore'))).toBe(false);
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
  });

  it('completes an existing .board directory that is not a board, keeping its files', () => {
    const repo = gitRepo(join(tempDir(), 'proj'));
    const dir = join(repo, '.board');
    mkdirSync(dir);
    writeFileSync(join(dir, 'notes.txt'), 'keep me');
    writeFileSync(join(dir, '.gitignore'), 'custom\n');
    const result = initBoard({ cwd: repo, env: cleanEnv() });
    expect(result.created).toBe(true);
    expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('keep me');
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('custom\n');
    expect(readdirSync(join(dir, 'events'))).toEqual(['.gitkeep']);
    expect(existsSync(join(dir, '.git'))).toBe(true);
  });
});

describe('initBoard without git', () => {
  it('exits 1 naming git and creates nothing', () => {
    const dir = tempDir();
    const err = expectBoardError(
      () => initBoard({ cwd: dir, env: cleanEnv({ PATH: '' }) }),
      1,
      'git-missing',
    );
    expect(err.message).toContain('git');
    expect(readdirSync(dir)).toEqual([]);
  });
});
