import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { treePath } from '../paths.js';
import { cleanEnv, expectBoardError, gitRepo, tempDir } from './helpers.js';

describe('treePath inside a git repository', () => {
  function repo(): string {
    const root = gitRepo(join(tempDir(), 'proj'));
    mkdirSync(join(root, 'src', 'deep'), { recursive: true });
    return root;
  }

  it('records a path relative to the repository root, from any subdirectory', () => {
    const root = repo();
    const env = cleanEnv();
    expect(treePath('docs/adr/1.md', { cwd: root, env })).toEqual({
      absolute: join(root, 'docs', 'adr', '1.md'),
      recorded: 'docs/adr/1.md',
    });
    expect(treePath('../../docs/adr/1.md', { cwd: join(root, 'src', 'deep'), env }).recorded).toBe(
      'docs/adr/1.md',
    );
    expect(treePath('./x/../y.md', { cwd: join(root, 'src'), env }).recorded).toBe('src/y.md');
  });

  it('records an absolute path inside the tree relative to the root', () => {
    const root = repo();
    expect(
      treePath(join(root, 'docs', 'adr', '1.md'), { cwd: join(root, 'src'), env: cleanEnv() })
        .recorded,
    ).toBe('docs/adr/1.md');
  });

  it('does not check that the path exists', () => {
    const root = repo();
    expect(treePath('nope/missing.md', { cwd: root, env: cleanEnv() }).recorded).toBe(
      'nope/missing.md',
    );
  });

  it.each(['../outside.md', '/etc/hosts', '.', '..'])(
    'refuses %j as outside the working tree',
    (text) => {
      const root = repo();
      const err = expectBoardError(
        () => treePath(text, { cwd: root, env: cleanEnv() }),
        1,
        'path-outside-tree',
      );
      expect(err.message).toContain(text);
    },
  );

  it('refuses a path that climbs out from a subdirectory', () => {
    const root = repo();
    expectBoardError(
      () => treePath('../../../x.md', { cwd: join(root, 'src', 'deep'), env: cleanEnv() }),
      1,
      'path-outside-tree',
    );
  });

  it('resolves symbolic links in cwd before comparing with the root', () => {
    const root = repo();
    const link = join(tempDir(), 'link');
    symlinkSync(root, link);
    expect(treePath('docs/1.md', { cwd: join(link, 'src'), env: cleanEnv() }).recorded).toBe(
      'src/docs/1.md',
    );
  });

  it('refuses an empty path with exit 1 usage', () => {
    expectBoardError(() => treePath('', { cwd: repo(), env: cleanEnv() }), 1, 'usage');
  });
});

describe('treePath outside git', () => {
  it('uses cwd as the root', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'docs'));
    const env = cleanEnv();
    expect(treePath('adr/1.md', { cwd: join(dir, 'docs'), env }).recorded).toBe('adr/1.md');
    expectBoardError(
      () => treePath('../other.md', { cwd: join(dir, 'docs'), env }),
      1,
      'path-outside-tree',
    );
  });

  it('uses cwd as the root when git is not on the PATH', () => {
    const root = gitRepo(join(tempDir(), 'proj'));
    mkdirSync(join(root, 'src'));
    const env = cleanEnv({ PATH: '' });
    expect(treePath('a.md', { cwd: join(root, 'src'), env }).recorded).toBe('a.md');
    expectBoardError(
      () => treePath('../a.md', { cwd: join(root, 'src'), env }),
      1,
      'path-outside-tree',
    );
  });
});

describe('treePath resolves symbolic links in the target', () => {
  function repoAndOutside(): { root: string; outside: string } {
    const root = gitRepo(join(tempDir(), 'proj'));
    const outside = tempDir();
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(outside, 'secret-plan.md'), '# outside\n');
    return { root, outside };
  }

  it('refuses a symlink inside the tree that points outside it', () => {
    const { root, outside } = repoAndOutside();
    symlinkSync(outside, join(root, 'docs', 'escape'));
    symlinkSync(join(outside, 'secret-plan.md'), join(root, 'docs', 'file-link.md'));
    for (const text of ['docs/escape/secret-plan.md', 'docs/file-link.md']) {
      expectBoardError(
        () => treePath(text, { cwd: root, env: cleanEnv() }),
        1,
        'path-outside-tree',
      );
    }
  });

  it('refuses a missing target whose nearest existing ancestor is outside the tree', () => {
    const { root, outside } = repoAndOutside();
    symlinkSync(outside, join(root, 'docs', 'escape'));
    expectBoardError(
      () => treePath('docs/escape/new/0100.md', { cwd: root, env: cleanEnv() }),
      1,
      'path-outside-tree',
    );
  });

  it('records the real in-tree location of a path through an in-tree symlink', () => {
    const { root } = repoAndOutside();
    mkdirSync(join(root, 'docs', 'adr'));
    writeFileSync(join(root, 'docs', 'adr', '1.md'), '# x\n');
    symlinkSync(join(root, 'docs', 'adr'), join(root, 'decisions'));
    expect(treePath('decisions/1.md', { cwd: root, env: cleanEnv() })).toEqual({
      absolute: join(root, 'docs', 'adr', '1.md'),
      recorded: 'docs/adr/1.md',
    });
    expect(treePath('decisions/new/2.md', { cwd: root, env: cleanEnv() }).recorded).toBe(
      'docs/adr/new/2.md',
    );
  });
});
