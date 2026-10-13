/**
 * `initBoard` in process (add-board-sharing tasks 2.1 and 2.2; board-events
 * "Board directory per project" and "Board ref in the host repository";
 * board-cli "Initialising and joining a shared board"): which model `init`
 * creates where, the host-model board it creates (ref, worktree, lock,
 * host `.gitignore`), the deterministic empty-board commit checked against
 * a plumbing-only shell script, the standalone fallbacks, idempotence on
 * both models, the `ambiguous-remote` refusal before anything is written,
 * and the `InitResult` fields. Joining and repair are in
 * `host-init.test.ts`; the built CLI (`--json`, warnings, crashes, races)
 * in `src/cli/__tests__/init-cli.test.ts`.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { findBoard } from '../../store/locate.js';
import { BOARD_GITIGNORE_LINES, HOST_GITIGNORE_ENTRY, initBoard, type InitResult } from '../init.js';
import { detectBoardModel } from '../model.js';
import { cleanEnv, expectBoardError, git, gitRepo, tempDir } from './helpers.js';
import {
  BOARD_REF,
  EMPTY_BOARD_COMMIT_ID,
  EMPTY_BOARD_SCRIPT,
  commitHostEvent,
  hostBoard,
  hostRepo,
  refCommit,
  refs,
  rootCommit,
  snapshotDir,
  standaloneBoard,
  withGitShim,
  worktreeEntries,
  worktreeEntry,
  worktrees,
} from './sharing-helpers.js';
import { bareRemote, syncEnv } from './sync-helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const HEX40 = /^[0-9a-f]{40}$/;

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

/** True when the repository or worktree at `dir` has a detached HEAD. */
function detached(dir: string): boolean {
  try {
    git(dir, 'symbolic-ref', '--quiet', 'HEAD');
    return false;
  } catch {
    return true;
  }
}

/** The keys of every `InitResult`, sorted: the `init --json` document. */
const RESULT_KEYS = [
  'created',
  'dir',
  'events',
  'hostGitignore',
  'joined',
  'message',
  'model',
  'remote',
  'repair',
  'warnings',
];

/** Asserts the invariants of a healthy host-model board at `<root>/.board`. */
function expectHostBoard(root: string, env = syncEnv()): void {
  const dir = join(root, '.board');
  const commit = refCommit(root);
  expect(commit).toMatch(HEX40);
  expect(detectBoardModel(dir, { env }).model).toBe('host');
  expect(detached(dir)).toBe(true);
  expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(commit);
  const entry = worktreeEntry(root, dir);
  expect(entry).not.toBeNull();
  expect(entry?.detached).toBe(true);
  expect(entry?.locked).toBe('agentboard board');
  expect(statSync(join(dir, 'events')).isDirectory()).toBe(true);
  expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe(
    BOARD_GITIGNORE_LINES.map((line) => `${line}\n`).join(''),
  );
  // No branch or tag for the board, and nothing else under refs/agentboard/.
  const names = refs(root)
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.split(' ')[0] ?? '');
  expect(names.filter((name) => name.startsWith('refs/agentboard/'))).toEqual([BOARD_REF]);
  expect(names.some((name) => /board/.test(name) && !name.startsWith('refs/agentboard/'))).toBe(
    false,
  );
}

describe('scenario: init creates the board (git host, git 2.32 or later, no remote)', () => {
  it('creates refs/agentboard/board and .board as a locked, detached worktree at it', () => {
    const env = syncEnv();
    const root = gitRepo(join(tempDir(), 'proj'));
    const dir = join(root, '.board');

    const result: InitResult = initBoard({ cwd: root, env });

    expect(Object.keys(result).sort()).toEqual(RESULT_KEYS);
    expect(result).toEqual({
      dir,
      created: true,
      model: 'host',
      joined: false,
      remote: null,
      events: 0,
      hostGitignore: join(root, '.gitignore'),
      warnings: [],
      repair: null,
      message: result.message,
    });
    expect(result.message).toContain(dir);
    expect(result.message).toMatch(/host/);
    expect(result.message).toMatch(/sync/);
    expect(result.message).toMatch(/remote/);
    expectHostBoard(root, env);
    expect(refCommit(root)).toBe(EMPTY_BOARD_COMMIT_ID);
    // events/ holds only the empty .gitkeep.
    expect(readdirSync(join(dir, 'events'))).toEqual(['.gitkeep']);
    expect(readFileSync(join(dir, 'events', '.gitkeep'), 'utf8')).toBe('');
    // The cache and its companions are ignored in the worktree, event files are not.
    for (const name of ['cache.sqlite', 'cache.sqlite-wal', 'cache.sqlite-shm']) {
      expect(ignored(dir, name), name).toBe(true);
    }
    expect(ignored(dir, 'events/abc.json')).toBe(false);
    // .board/ in the host .gitignore.
    expect(HOST_GITIGNORE_ENTRY).toBe('.board/');
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('.board/\n');
    expect(ignored(root, '.board/events/x.json')).toBe(true);
    // The worktree's git directory is under the host's, named by git.
    expect(readFileSync(join(dir, '.git'), 'utf8')).toMatch(/^gitdir: /);
  });

  it('leaves the host clean: git status --porcelain is empty when .board/ is already ignored', () => {
    const env = syncEnv();
    const root = hostRepo();
    const head = git(root, 'rev-parse', 'HEAD').trim();
    const branch = git(root, 'symbolic-ref', '--short', 'HEAD').trim();

    initBoard({ cwd: root, env });

    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(git(root, 'symbolic-ref', '--short', 'HEAD').trim()).toBe(branch);
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(root, 'tag')).toBe('');
    expect(git(root, 'branch', '--format=%(refname:short)').trim()).toBe(branch);
  });

  it('writes the same root commit as a plumbing-only shell script, and the pinned id', () => {
    const env = syncEnv();
    const root = gitRepo(join(tempDir(), 'proj'));
    initBoard({ cwd: root, env });

    const scratch = gitRepo(join(tempDir(), 'scratch'));
    const script = join(tempDir(), 'empty-board.sh');
    writeFileSync(script, EMPTY_BOARD_SCRIPT);
    const computed = execFileSync('sh', [script], {
      cwd: scratch,
      env: { ...env },
      encoding: 'utf8',
    }).trim();

    expect(computed).toMatch(HEX40);
    expect(rootCommit(root)).toBe(computed);
    expect(refCommit(root)).toBe(computed);
    expect(computed).toBe(EMPTY_BOARD_COMMIT_ID);
    // The commit is what the spec says, field by field.
    const raw = git(root, 'cat-file', '-p', BOARD_REF);
    expect(raw).toContain('author agentboard <agentboard@localhost> 0 +0000\n');
    expect(raw).toContain('committer agentboard <agentboard@localhost> 0 +0000\n');
    expect(raw).not.toContain('parent ');
    expect(raw.endsWith('\n\nagentboard: empty board\n')).toBe(true);
    expect(git(root, 'ls-tree', '-r', '--name-only', BOARD_REF).trim().split('\n').sort()).toEqual(
      ['.gitignore', 'events/.gitkeep'],
    );
  });

  it('scenario: independent empty boards share their root', () => {
    const env = syncEnv();
    const remote = bareRemote();
    const a = hostRepo(join(tempDir(), 'a'));
    git(a, 'remote', 'add', 'origin', remote);
    git(a, 'push', '-q', 'origin', 'main');
    const b = join(tempDir(), 'b');
    git(tempDir(), 'clone', '-q', remote, b);

    const first = initBoard({ cwd: a, env });
    const second = initBoard({ cwd: b, env });

    expect(first).toMatchObject({ model: 'host', joined: false, remote: 'origin' });
    expect(second).toMatchObject({ model: 'host', joined: false, remote: 'origin' });
    expect(rootCommit(a)).toBe(rootCommit(b));
    expect(refCommit(a)).toBe(refCommit(b));
    // Neither init pushed the board.
    expect(git(remote, 'for-each-ref', 'refs/agentboard/')).toBe('');
  });

  it('scenario: worktree cleanup leaves the board alone (prune, then remove without --force)', () => {
    const env = syncEnv();
    const root = gitRepo(join(tempDir(), 'proj'));
    initBoard({ cwd: root, env });
    const dir = join(root, '.board');

    git(root, 'worktree', 'prune');
    let refused: unknown = null;
    try {
      git(root, 'worktree', 'remove', dir);
    } catch (error) {
      refused = error;
    }

    expect(refused).not.toBeNull();
    expect(String((refused as { stderr?: string }).stderr ?? '')).toMatch(/lock/i);
    expect(existsSync(join(dir, 'events', '.gitkeep'))).toBe(true);
    expect(worktreeEntry(root, dir)?.locked).toBe('agentboard board');
    expectHostBoard(root, env);
  });

  it('git 2.32.0 exactly is enough for the host model', () => {
    const env = withGitShim(syncEnv(), '2.32.0');
    const root = gitRepo(join(tempDir(), 'proj'));
    const result = initBoard({ cwd: root, env });
    expect(result.model).toBe('host');
    expect(result.warnings).toEqual([]);
    expectHostBoard(root, syncEnv());
  });

  it('checks out every event file when the host uses sparse checkout', () => {
    const env = syncEnv();
    const { root, dir } = hostBoard(env);
    const hash = commitHostEvent(dir, { v: 1, kind: 'noise', body: {} }, env);
    // Keep the ref, drop the worktree, make the host sparse.
    git(root, 'worktree', 'unlock', dir);
    git(root, 'worktree', 'remove', '--force', dir);
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.txt'), 'a\n');
    git(root, 'add', 'src');
    git(root, 'commit', '-q', '-m', 'src');
    git(root, 'sparse-checkout', 'set', '--cone', 'src');

    const result = initBoard({ cwd: root, env });

    expect(result).toMatchObject({ model: 'host', created: true, events: 1 });
    expect(existsSync(join(dir, 'events', `${hash}.json`))).toBe(true);
    expect(existsSync(join(dir, '.gitignore'))).toBe(true);
    let sparse: string;
    try {
      sparse = git(dir, 'config', '--get', 'core.sparseCheckout').trim();
    } catch {
      sparse = 'unset';
    }
    expect(sparse).not.toBe('true');
  });
});

describe('where the host-model board goes', () => {
  it("from a linked worktree, creates the main checkout's board and chooses the remote by the main branch", () => {
    const env = syncEnv();
    const parent = tempDir();
    const main = hostRepo(join(parent, 'main'));
    const fork = bareRemote();
    const upstream = bareRemote();
    git(main, 'remote', 'add', 'fork', fork);
    git(main, 'remote', 'add', 'upstream', upstream);
    git(main, 'config', 'branch.main.remote', 'upstream');
    git(main, 'config', 'branch.main.merge', 'refs/heads/main');
    const linked = join(parent, 'linked');
    git(main, 'worktree', 'add', '-q', '-b', 'feature', linked);

    const result = initBoard({ cwd: linked, env });

    expect(result.dir).toBe(join(main, '.board'));
    expect(result).toMatchObject({ model: 'host', remote: 'upstream', joined: false });
    expect(existsSync(join(linked, '.board'))).toBe(false);
    expect(readFileSync(join(main, '.gitignore'), 'utf8')).toBe('.board/\n');
    expectHostBoard(main, env);
  });

  it('from a subdirectory of the repository, creates the board at the root', () => {
    const env = syncEnv();
    const root = gitRepo(join(tempDir(), 'proj'));
    const sub = join(root, 'src', 'deep');
    mkdirSync(sub, { recursive: true });
    expect(initBoard({ cwd: sub, env }).dir).toBe(join(root, '.board'));
    expect(existsSync(join(sub, '.board'))).toBe(false);
    expectHostBoard(root, env);
  });

  it('is found by discovery afterwards, from the host and from inside the worktree', () => {
    const env = syncEnv();
    const root = gitRepo(join(tempDir(), 'proj'));
    initBoard({ cwd: root, env });
    expect(findBoard({ cwd: root, env }).dir).toBe(join(root, '.board'));
    expect(findBoard({ cwd: join(root, '.board'), env }).dir).toBe(join(root, '.board'));
    expect(findBoard({ cwd: join(root, '.board', 'events'), env }).dir).toBe(join(root, '.board'));
  });
});

describe('host .gitignore', () => {
  it('appends to an existing host .gitignore, keeping its content byte for byte', () => {
    const env = syncEnv();
    const root = gitRepo(join(tempDir(), 'proj'));
    writeFileSync(join(root, '.gitignore'), 'node_modules\ndist');
    const result = initBoard({ cwd: root, env });
    expect(result.hostGitignore).toBe(join(root, '.gitignore'));
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('node_modules\ndist\n.board/\n');
  });

  it.each(['.board/', '.board', '/.board/', '/.board', '  .board/  '])(
    'leaves a host .gitignore that already lists %j untouched',
    (line) => {
      const env = syncEnv();
      const root = gitRepo(join(tempDir(), 'proj'));
      const content = `node_modules\n${line}\n`;
      writeFileSync(join(root, '.gitignore'), content);
      const result = initBoard({ cwd: root, env });
      expect(result.created).toBe(true);
      expect(result.hostGitignore).toBeNull();
      expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(content);
    },
  );
});

describe('standalone fallbacks', () => {
  it('scenario: init outside a git repository makes a repository of its own and writes no host .gitignore', () => {
    const env = syncEnv();
    const parent = tempDir();
    const result = initBoard({ cwd: parent, env });
    const dir = join(parent, '.board');

    expect(Object.keys(result).sort()).toEqual(RESULT_KEYS);
    expect(result).toMatchObject({
      dir,
      created: true,
      model: 'standalone',
      joined: false,
      remote: null,
      events: 0,
      hostGitignore: null,
      warnings: [],
      repair: null,
    });
    expect(result.message).toContain(dir);
    expect(git(dir, 'rev-parse', '--git-dir').trim()).toBe('.git');
    expect(detectBoardModel(dir, { env }).model).toBe('standalone');
    expect(readdirSync(join(dir, 'events'))).toEqual(['.gitkeep']);
    expect(readFileSync(join(dir, 'events', '.gitkeep'), 'utf8')).toBe('');
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe(
      BOARD_GITIGNORE_LINES.map((line) => `${line}\n`).join(''),
    );
    // No commit is made.
    expect(refCommit(dir, 'HEAD')).toBeNull();
    // No host .gitignore outside a git repository.
    expect(existsSync(join(parent, '.gitignore'))).toBe(false);
  });

  it('scenario: init with an old git (2.31) makes a standalone board, ignores it in the host and says why', () => {
    const env = withGitShim(syncEnv(), '2.31.8');
    const root = gitRepo(join(tempDir(), 'proj'));
    const dir = join(root, '.board');

    const result = initBoard({ cwd: root, env });

    expect(result).toMatchObject({
      dir,
      created: true,
      model: 'standalone',
      joined: false,
      remote: null,
      events: 0,
      hostGitignore: join(root, '.gitignore'),
      repair: null,
    });
    expect(result.message).toContain('git 2.32 or later');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('2.31.8');
    expect(result.warnings[0]).toContain('git 2.32 or later');
    expect(result.warnings[0]).toMatch(/^[\x20-\x7e]+$/);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('.board/\n');
    // As outside a git repository: its own repository, nothing committed.
    expect(git(dir, 'rev-parse', '--git-dir').trim()).toBe('.git');
    expect(detectBoardModel(dir, { env: syncEnv() }).model).toBe('standalone');
    expect(refCommit(dir, 'HEAD')).toBeNull();
    expect(readdirSync(join(dir, 'events'))).toEqual(['.gitkeep']);
    // Nothing of the host model was made.
    expect(refCommit(root)).toBeNull();
    expect(worktreeEntry(root, dir)).toBeNull();
  });

  it('with AGENTBOARD_DIR inside a git repository, creates a standalone board there and touches no host .gitignore', () => {
    const parent = tempDir();
    const root = gitRepo(join(parent, 'proj'));
    const target = join(parent, 'shared-board');
    const result = initBoard({ cwd: root, env: syncEnv({ AGENTBOARD_DIR: target }) });
    expect(result).toMatchObject({
      dir: target,
      created: true,
      model: 'standalone',
      hostGitignore: null,
      remote: null,
    });
    expect(readdirSync(join(target, 'events'))).toEqual(['.gitkeep']);
    expect(existsSync(join(target, '.git'))).toBe(true);
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
    expect(existsSync(join(parent, '.gitignore'))).toBe(false);
    expect(refCommit(root)).toBeNull();
  });

  it('outside git, completes an existing .board directory that is not a board, keeping its files', () => {
    const env = syncEnv();
    const parent = tempDir();
    const dir = join(parent, '.board');
    mkdirSync(dir);
    writeFileSync(join(dir, 'notes.txt'), 'keep me');
    writeFileSync(join(dir, '.gitignore'), 'custom\n');
    const result = initBoard({ cwd: parent, env });
    expect(result).toMatchObject({ created: true, model: 'standalone' });
    expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('keep me');
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('custom\n');
    expect(readdirSync(join(dir, 'events'))).toEqual(['.gitkeep']);
    expect(existsSync(join(dir, '.git'))).toBe(true);
  });
});

describe('scenario: init is idempotent', () => {
  it('on a host-model board: nothing created or modified, exit 0, the model, history and remote named', () => {
    const env = syncEnv();
    const { root, dir } = hostBoard(env);
    const remote = bareRemote();
    git(root, 'remote', 'add', 'origin', remote);
    const hash = commitHostEvent(dir, { v: 1, kind: 'noise', body: {} }, env);
    writeFileSync(join(root, '.gitignore'), 'other\n');
    const state = (): unknown[] => [
      refs(root),
      worktrees(root),
      snapshotDir(dir),
      git(root, 'status', '--porcelain'),
      git(root, 'rev-parse', 'HEAD'),
      git(dir, 'rev-parse', 'HEAD'),
    ];
    const before = state();

    const again = initBoard({ cwd: root, env });

    expect(Object.keys(again).sort()).toEqual(RESULT_KEYS);
    expect(again).toMatchObject({
      dir,
      created: false,
      model: 'host',
      joined: false,
      remote: 'origin',
      events: 1,
      hostGitignore: null,
      warnings: [],
      repair: null,
    });
    expect(again.message).toMatch(/already exists/);
    expect(again.message).toContain(dir);
    expect(again.message).toMatch(/\bhost\b/);
    expect(again.message).toContain(BOARD_REF);
    expect(again.message).toContain('origin');
    expect(again.message).not.toContain('--into-host');
    expect(again.message).not.toMatch(/restor/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(state()).toEqual(before);
    // The host .gitignore is not touched when the board exists.
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('other\n');
    expect(existsSync(join(dir, 'cache.sqlite'))).toBe(false);
  });

  it('on a standalone board inside a git host with git 2.32 or later: names standalone and suggests --into-host', () => {
    const env = syncEnv();
    const root = gitRepo(join(tempDir(), 'proj'));
    const dir = standaloneBoard(root);
    const before = [snapshot(root), refs(root)];

    const again = initBoard({ cwd: root, env });

    expect(again).toMatchObject({
      dir,
      created: false,
      model: 'standalone',
      joined: false,
      remote: null,
      events: 0,
      hostGitignore: null,
      repair: null,
    });
    expect(again.message).toMatch(/already exists/);
    expect(again.message).toMatch(/\bstandalone\b/);
    expect(again.message).toContain('agentboard init --into-host');
    expect([snapshot(root), refs(root)]).toEqual(before);
    expect(refCommit(root)).toBeNull();
  });

  it('on a standalone board inside a git host with an old git: no --into-host suggestion', () => {
    const env = withGitShim(syncEnv(), '2.31.8');
    const root = gitRepo(join(tempDir(), 'proj'));
    standaloneBoard(root);
    const again = initBoard({ cwd: root, env });
    expect(again).toMatchObject({ created: false, model: 'standalone' });
    expect(again.message).not.toContain('--into-host');
  });

  it('on a standalone board outside git: names standalone, its branch and remote, no --into-host suggestion', () => {
    const env = syncEnv();
    const parent = tempDir();
    const dir = standaloneBoard(parent);
    git(dir, 'remote', 'add', 'origin', bareRemote());
    const before = snapshot(parent);

    const again = initBoard({ cwd: parent, env });

    expect(again).toMatchObject({
      dir,
      created: false,
      model: 'standalone',
      remote: 'origin',
      hostGitignore: null,
    });
    expect(again.message).toMatch(/already exists/);
    expect(again.message).toMatch(/\bstandalone\b/);
    expect(again.message).toMatch(/\bmain\b/);
    expect(again.message).toContain('origin');
    expect(again.message).not.toContain('--into-host');
    expect(snapshot(parent)).toEqual(before);
  });

  it('on a host-model board whose worktree is not locked: restores the lock and says so', () => {
    const env = syncEnv();
    const { root, dir } = hostBoard(env);
    git(root, 'worktree', 'unlock', dir);
    const before = [refs(root), snapshotDir(dir), git(root, 'status', '--porcelain')];

    const again = initBoard({ cwd: root, env });

    expect(again).toMatchObject({ dir, created: false, model: 'host', repair: null, events: 0 });
    expect(again.message).toMatch(/already exists/);
    expect(again.message).toMatch(/lock/);
    expect(again.message).toMatch(/restor/);
    expect(worktreeEntry(root, dir)?.locked).toBe('agentboard board');
    expect([refs(root), snapshotDir(dir), git(root, 'status', '--porcelain')]).toEqual(before);
  });

  it('on a host-model board without a remote says there is none', () => {
    const env = syncEnv();
    const { root } = hostBoard(env);
    const again = initBoard({ cwd: root, env });
    expect(again).toMatchObject({ created: false, model: 'host', remote: null });
    expect(again.message).toMatch(/no remote/);
  });
});

describe('scenario: init with several remotes and no choice', () => {
  it('exits 1 ambiguous-remote and creates nothing, not even the host .gitignore entry', () => {
    const env = syncEnv();
    const root = gitRepo(join(tempDir(), 'proj'));
    git(root, 'remote', 'add', 'fork', bareRemote());
    git(root, 'remote', 'add', 'upstream', bareRemote());
    const before = [snapshot(root), refs(root), worktrees(root)];

    const err = expectBoardError(() => initBoard({ cwd: root, env }), 1, 'ambiguous-remote');

    expect(err.message).toContain('fork');
    expect(err.message).toContain('upstream');
    expect(err.message).toContain('git config agentboard.remote <name>');
    expect(err.message).toContain('agentboard init');
    expect(err.message).not.toContain('agentboard sync');
    expect(existsSync(join(root, '.board'))).toBe(false);
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
    expect(refCommit(root)).toBeNull();
    expect([snapshot(root), refs(root), worktrees(root)]).toEqual(before);
  });

  it('agentboard.remote resolves the choice', () => {
    const env = syncEnv();
    const root = gitRepo(join(tempDir(), 'proj'));
    git(root, 'remote', 'add', 'fork', bareRemote());
    git(root, 'remote', 'add', 'upstream', bareRemote());
    git(root, 'config', 'agentboard.remote', 'fork');
    const result = initBoard({ cwd: root, env });
    expect(result).toMatchObject({ model: 'host', remote: 'fork', joined: false });
    expectHostBoard(root, env);
  });

  it('a standalone fallback (old git) in a host with several remotes is not refused', () => {
    const env = withGitShim(syncEnv(), '2.31.8');
    const root = gitRepo(join(tempDir(), 'proj'));
    git(root, 'remote', 'add', 'fork', bareRemote());
    git(root, 'remote', 'add', 'upstream', bareRemote());
    const result = initBoard({ cwd: root, env });
    expect(result).toMatchObject({ model: 'standalone', created: true, remote: null });
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

  it('in a git host, exits 1 naming git and writes no .gitignore entry', () => {
    const root = gitRepo(join(tempDir(), 'proj'));
    rmSync(join(root, '.gitignore'), { force: true });
    expectBoardError(() => initBoard({ cwd: root, env: cleanEnv({ PATH: '' }) }), 1, 'git-missing');
    expect(existsSync(join(root, '.board'))).toBe(false);
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
  });
});

describe('scenario: init in a host whose git directory is not in its working tree', () => {
  /**
   * Asserts the standalone fallback: a repository of its own at `dir`
   * (nothing committed), no host `.gitignore` (the parent of `dir` is not
   * a working tree), the reason in `warnings` and `message` naming the git
   * directory `gitDir`, and no host-model trace (no ref under
   * `refs/agentboard/`, no worktree for `.board`) in the repository at
   * `repo`.
   */
  function expectFallback(result: InitResult, dir: string, gitDir: string, repo: string): void {
    expect(result).toMatchObject({
      dir,
      created: true,
      model: 'standalone',
      joined: false,
      remote: null,
      events: 0,
      hostGitignore: null,
      repair: null,
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/working tree/);
    expect(result.warnings[0]).toMatch(/standalone/);
    expect(result.warnings[0]).toContain(gitDir);
    expect(result.warnings[0]).toMatch(/^[\x20-\x7e]+$/);
    expect(result.message).toMatch(/standalone/);
    expect(result.message).toMatch(/working tree/);
    expect(git(dir, 'rev-parse', '--git-dir').trim()).toBe('.git');
    expect(detectBoardModel(dir, { env: syncEnv() }).model).toBe('standalone');
    expect(refCommit(dir, 'HEAD')).toBeNull();
    expect(readdirSync(join(dir, 'events'))).toEqual(['.gitkeep']);
    expect(existsSync(join(dirname(dir), '.gitignore'))).toBe(false);
    expect(git(repo, 'for-each-ref', 'refs/agentboard/')).toBe('');
    expect(worktreeEntries(repo).some((entry) => entry.path.endsWith('.board'))).toBe(false);
  }

  it('a linked worktree of a bare repository: a standalone board beside the bare repository, nothing else', () => {
    const env = syncEnv();
    const parent = tempDir();
    const source = gitRepo(join(tempDir(), 'source'));
    const bare = join(parent, 'b.git');
    git(parent, 'clone', '-q', '--bare', source, bare);
    const linked = join(parent, 'bw');
    git(bare, 'worktree', 'add', '-q', linked, 'main');
    const status = git(linked, 'status', '--porcelain');

    const result = initBoard({ cwd: linked, env });

    expectFallback(result, join(parent, '.board'), bare, bare);
    expect(git(linked, 'status', '--porcelain')).toBe(status);
    expect(existsSync(join(linked, '.gitignore'))).toBe(false);
    expect(worktreeEntries(bare).map((entry) => entry.path)).toEqual([bare, linked]);
  });

  it('a repository made with --separate-git-dir: a standalone board, nothing in the git directory', () => {
    const env = syncEnv();
    const parent = tempDir();
    const gitDir = join(parent, 'gd');
    const tree = join(parent, 'wt');
    mkdirSync(tree);
    git(parent, 'init', '-q', '--separate-git-dir', gitDir, tree);
    git(tree, 'commit', '-q', '--allow-empty', '-m', 'init');
    const status = git(tree, 'status', '--porcelain');

    const result = initBoard({ cwd: tree, env });

    expectFallback(result, join(parent, '.board'), gitDir, tree);
    expect(git(tree, 'status', '--porcelain')).toBe(status);
    expect(existsSync(join(tree, '.gitignore'))).toBe(false);
  });

  it('inside a submodule: a standalone board, nothing written in the superproject', () => {
    const env = syncEnv();
    const lib = gitRepo(join(tempDir(), 'lib'));
    const superproject = hostRepo();
    git(superproject, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'lib');
    git(superproject, 'commit', '-q', '-m', 'add lib');
    const inside = join(superproject, 'lib');
    const modules = join(superproject, '.git', 'modules');
    const state = (): unknown[] => [
      refs(superproject),
      worktrees(superproject),
      git(superproject, 'status', '--porcelain'),
      refs(inside),
      worktrees(inside),
      readFileSync(join(superproject, '.gitignore'), 'utf8'),
    ];
    const before = state();

    const result = initBoard({ cwd: inside, env });

    expectFallback(result, join(modules, '.board'), join(modules, 'lib'), superproject);
    expect(git(inside, 'for-each-ref', 'refs/agentboard/')).toBe('');
    expect(existsSync(join(modules, '.gitignore'))).toBe(false);
    expect(existsSync(join(inside, '.gitignore'))).toBe(false);
    expect(state()).toEqual(before);
  });

  it('the host model is taken when the host .git is in its working tree, through a symlinked path too', () => {
    const env = syncEnv();
    const root = gitRepo(join(tempDir(), 'proj'));
    const link = join(tempDir(), 'via-link');
    symlinkSync(root, link);
    const result = initBoard({ cwd: link, env });
    expect(result.model).toBe('host');
    expect(result.warnings).toEqual([]);
    expectHostBoard(root, env);
  });
});
