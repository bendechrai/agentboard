/**
 * `initBoardWithRemote` in process (add-board-sharing task 4.1; board-cli
 * "Board in a separate repository"; design.md decision 8): local path
 * detection and resolution, every scenario of the requirement (an empty
 * remote, a missing local path created as a bare repository, a remote
 * that holds a board, a non-local URL that cannot be read, an existing
 * standalone board without a remote, a host-model board, the remote that
 * matches or mismatches), a not-a-board remote leaving nothing behind, a
 * failing `sync` propagating its exit code with the remote kept, the
 * standalone board it creates inside a git host, and `remote` reporting
 * it afterwards. The built CLI (`--json`, the flag exclusivity, help, the
 * two-clone walkthrough) is in `src/cli/__tests__/init-remote-cli.test.ts`.
 * Every remote is a bare repository on local disk, or an SSH URL behind a
 * shim that connects nowhere; nothing touches the network.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { P, T1, T2, T3, ev } from '../../store/__tests__/helpers.js';
import { BOARD_GITIGNORE_LINES } from '../init.js';
import {
  initBoardWithRemote,
  isLocalUrl,
  localPath,
  originUrl,
  type InitRemoteResult,
} from '../init-remote.js';
import { detectBoardModel } from '../model.js';
import { remoteReport } from '../remote.js';
import { syncBoard } from '../sync.js';
import { listTickets } from '../tickets.js';
import { expectBoardError, git, gitRepo, openTracked, putEvent, tempDir } from './helpers.js';
import {
  SSH_URL,
  hostBoard,
  hostRepo,
  installHook,
  refs,
  snapshotDir,
  sshShim,
  standaloneBoard,
  withGitShim,
  withRecordingGitShim,
  worktreeEntries,
  worktrees,
} from './sharing-helpers.js';
import {
  bareRemote,
  commitCount,
  initMachine,
  revParse,
  syncEnv,
  treeEvents,
  treePaths,
  type Env,
} from './sync-helpers.js';

// Every test spawns several git processes; keep well clear of the 5 s default under load.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const HEX40 = /^[0-9a-f]{40}$/;

/** The keys of every `InitRemoteResult`, sorted: the `init --remote --json` document. */
const RESULT_KEYS = [
  'action',
  'created',
  'dir',
  'events',
  'hostGitignore',
  'joined',
  'message',
  'model',
  'remote',
  'remoteUrl',
  'repair',
  'sync',
  'warnings',
];

/** A complete `ticket.create` event for `ticket`. */
function createEvent(ticket: string, title: string): unknown {
  return ev(P.create(ticket, title), 'orch', 1_700_000_000_000);
}

/** A fresh project directory that is not a git repository, holding nothing. */
function plainProject(): string {
  const root = join(tempDir(), 'proj');
  mkdirSync(root);
  return root;
}

/** The fetch URL of `origin` of the repository at `dir`. */
function originOf(dir: string): string {
  return git(dir, 'remote', 'get-url', 'origin').trim();
}

/** The branches of the bare repository at `remote` (`refs/heads/*`), sorted. */
function branchesOf(remote: string): string[] {
  return git(remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/')
    .split('\n')
    .filter((line) => line !== '')
    .sort();
}

/**
 * A standalone board with `titles.length` events pushed to a fresh bare
 * remote (as a first clone leaves it); returns the remote and the board.
 */
function publishedBoard(env: Env, titles: readonly string[]): { remote: string; dir: string } {
  const remote = bareRemote();
  const { dir } = initMachine(env, remote);
  const ids = [T1, T2, T3];
  titles.forEach((title, i) => {
    putEvent(join(dir, 'events'), createEvent(ids[i] ?? T1, title));
  });
  const result = syncBoard(openTracked(dir), { env });
  expect(result.pushed).toBe(true);
  return { remote, dir };
}

/** Asserts the invariants of the standalone board `initBoardWithRemote` leaves at `dir`. */
function expectStandaloneBoard(dir: string, url: string, env: Env): void {
  expect(detectBoardModel(dir, { env }).model).toBe('standalone');
  expect(existsSync(join(dir, '.git'))).toBe(true);
  expect(existsSync(join(dir, 'events'))).toBe(true);
  expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe(
    BOARD_GITIGNORE_LINES.map((line) => `${line}\n`).join(''),
  );
  expect(originOf(dir)).toBe(url);
  expect(git(dir, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('main');
}

describe('isLocalUrl: git treats a URL as a path when it starts with file:// or has no colon before its first slash', () => {
  it.each([
    ['/abs/x.git', true],
    ['./x.git', true],
    ['../x.git', true],
    ['x.git', true],
    ['boards/x.git', true],
    ['dir/host:x.git', true],
    ['file:///x.git', true],
    ['file:///abs/path/x.git', true],
    ['file://localhost/abs/x.git', true],
    ['file://host/abs/x.git', true],
    ['host:x.git', false],
    ['git@host:x.git', false],
    ['git@github.com:me/board.git', false],
    ['ssh://host/x.git', false],
    ['ssh://git@host:22/x.git', false],
    ['https://host/x.git', false],
    ['git://host/x.git', false],
  ])('%s is local: %s', (url, local) => {
    expect(isLocalUrl(url)).toBe(local);
  });
});

describe('localPath and originUrl', () => {
  it.each([
    ['/abs/x.git', '/a/b', '/abs/x.git'],
    ['./x.git', '/a/b', '/a/b/x.git'],
    ['../x.git', '/a/b', '/a/x.git'],
    ['x.git', '/a/b', '/a/b/x.git'],
    ['../../boards/x.git', '/a/b/c', '/a/boards/x.git'],
    ['file:///abs/x.git', '/a/b', '/abs/x.git'],
    ['file://localhost/abs/x.git', '/a/b', '/abs/x.git'],
  ])('localPath(%s, %s) is %s', (url, base, path) => {
    expect(localPath(url, base)).toBe(path);
  });

  it.each([
    'host:x.git',
    'git@host:x.git',
    'ssh://host/x.git',
    'https://host/x.git',
    // A file:// URL with a host other than localhost names no path on this machine.
    'file://host/abs/x.git',
    'file://example.invalid/x.git',
  ])(
    'localPath(%s) is null',
    (url) => {
      expect(localPath(url, '/a/b')).toBeNull();
    },
  );

  it('originUrl stores a local path as an absolute path, a file:// URL and any other URL as given', () => {
    expect(originUrl('../boards/x.git', '/a/b')).toBe('/a/boards/x.git');
    expect(originUrl('./x.git', '/a/b')).toBe('/a/b/x.git');
    expect(originUrl('/abs/x.git', '/a/b')).toBe('/abs/x.git');
    expect(originUrl('file:///abs/x.git', '/a/b')).toBe('file:///abs/x.git');
    expect(originUrl('file://localhost/abs/x.git', '/a/b')).toBe('file://localhost/abs/x.git');
    expect(originUrl('git@host:x.git', '/a/b')).toBe('git@host:x.git');
    expect(originUrl('https://host/x.git', '/a/b')).toBe('https://host/x.git');
  });
});

describe('scenario: Init with an empty remote', () => {
  it('creates a standalone board with origin set, and the remote gets a branch holding .gitignore and events/.gitkeep', () => {
    const env = syncEnv();
    const root = plainProject();
    const remote = bareRemote();
    const dir = join(root, '.board');

    const result: InitRemoteResult = initBoardWithRemote(remote, { cwd: root, env });

    expect(Object.keys(result).sort()).toEqual(RESULT_KEYS);
    expect(result).toMatchObject({
      dir,
      action: 'created',
      created: true,
      model: 'standalone',
      joined: false,
      remote: 'origin',
      remoteUrl: remote,
      events: 0,
      hostGitignore: null,
      warnings: [],
      repair: null,
    });
    expect(result.sync).not.toBeNull();
    expect(result.sync).toMatchObject({
      model: 'standalone',
      remote: 'origin',
      branch: 'main',
      pushed: true,
      upstreamSet: true,
    });
    expect(result.message).toContain(dir);
    expect(result.message).toContain(remote);
    expect(result.message).toMatch(/standalone/);
    expectStandaloneBoard(dir, remote, env);
    expect(branchesOf(remote)).toEqual(['main']);
    expect(treePaths(remote, 'main')).toEqual(['.gitignore', 'events/.gitkeep']);
    expect(revParse(dir)).toBe(revParse(remote, 'main'));
    expect(git(dir, 'config', '--get', 'branch.main.remote').trim()).toBe('origin');
    expect(readdirSync(join(dir, 'events'))).toEqual(['.gitkeep']);
    // Nothing but the board was created beside it.
    expect(readdirSync(root)).toEqual(['.board']);
  });

  it('a later sync on that board is an ordinary standalone sync', () => {
    const env = syncEnv();
    const root = plainProject();
    const remote = bareRemote();
    initBoardWithRemote(remote, { cwd: root, env });
    putEvent(join(root, '.board', 'events'), createEvent(T1, 'later'));

    const result = syncBoard(openTracked(join(root, '.board')), { env });

    expect(result).toMatchObject({ model: 'standalone', committedEvents: 1, pushed: true });
    expect(treeEvents(remote, 'main')).toHaveLength(1);
  });
});

describe('scenario: Init with a local path that does not exist', () => {
  it('creates ../boards/project.git as a bare repository, pushes the board to it and stores the absolute path', () => {
    const env = syncEnv();
    const root = plainProject();
    const bare = resolve(root, '../boards/project.git');
    expect(existsSync(bare)).toBe(false);

    const result = initBoardWithRemote('../boards/project.git', { cwd: root, env });

    expect(result).toMatchObject({ action: 'created', remote: 'origin', remoteUrl: bare });
    expect(git(bare, 'rev-parse', '--is-bare-repository').trim()).toBe('true');
    expect(branchesOf(bare)).toEqual(['main']);
    expect(treePaths(bare, 'main')).toEqual(['.gitignore', 'events/.gitkeep']);
    expectStandaloneBoard(join(root, '.board'), bare, env);
  });

  it('resolves ./boards/x.git against the current directory outside a git repository', () => {
    const env = syncEnv();
    const root = plainProject();

    const result = initBoardWithRemote('./boards/x.git', { cwd: root, env });

    expect(result.remoteUrl).toBe(join(root, 'boards', 'x.git'));
    expect(originOf(join(root, '.board'))).toBe(join(root, 'boards', 'x.git'));
    expect(git(join(root, 'boards', 'x.git'), 'rev-parse', '--is-bare-repository').trim()).toBe(
      'true',
    );
  });

  it('resolves a relative path against the host top level, not the linked worktree the command runs in', () => {
    const env = syncEnv();
    const tmp = tempDir();
    const host = gitRepo(join(tmp, 'proj'));
    const linked = join(tmp, 'wt', 'feature');
    mkdirSync(join(tmp, 'wt'));
    git(host, 'worktree', 'add', '-q', '-b', 'feature', linked);

    const result = initBoardWithRemote('../boards/x.git', { cwd: linked, env });

    const bare = join(tmp, 'boards', 'x.git');
    expect(result.dir).toBe(join(host, '.board'));
    expect(result.remoteUrl).toBe(bare);
    expect(existsSync(bare)).toBe(true);
    expect(existsSync(join(tmp, 'wt', 'boards'))).toBe(false);
    expect(originOf(join(host, '.board'))).toBe(bare);
    // The standalone sync from the linked worktree reaches the same remote.
    putEvent(join(host, '.board', 'events'), createEvent(T1, 'from the worktree'));
    const sync = syncBoard(openTracked(join(host, '.board')), { env });
    expect(sync.pushed).toBe(true);
    expect(treeEvents(bare, 'main')).toHaveLength(1);
  });

  it('a missing file:// URL is created as a bare repository and stored as the URL given', () => {
    const env = syncEnv();
    const root = plainProject();
    const path = join(tempDir(), 'boards', 'x.git');
    const url = `file://${path}`;

    const result = initBoardWithRemote(url, { cwd: root, env });

    expect(result).toMatchObject({ action: 'created', remoteUrl: url });
    expect(git(path, 'rev-parse', '--is-bare-repository').trim()).toBe('true');
    expect(originOf(join(root, '.board'))).toBe(url);
    expect(branchesOf(path)).toEqual(['main']);
  });
});

describe('scenario: Init with a remote that has a board', () => {
  it('clones the board into .board, and its events are present and folded before any sync', () => {
    const env = syncEnv();
    const { remote } = publishedBoard(env, ['one', 'two', 'three']);
    const root = plainProject();
    const dir = join(root, '.board');

    const result = initBoardWithRemote(remote, { cwd: root, env });

    expect(Object.keys(result).sort()).toEqual(RESULT_KEYS);
    expect(result).toMatchObject({
      dir,
      action: 'cloned',
      created: true,
      model: 'standalone',
      joined: true,
      remote: 'origin',
      remoteUrl: remote,
      events: 3,
      hostGitignore: null,
      warnings: [],
      repair: null,
      sync: null,
    });
    expect(result.message).toContain(remote);
    expect(result.message).toMatch(/cloned/);
    expect(result.message).toMatch(/\b3\b/);
    expectStandaloneBoard(dir, remote, env);
    expect(revParse(dir)).toBe(revParse(remote, 'main'));
    expect(readdirSync(join(dir, 'events')).filter((n) => n.endsWith('.json'))).toHaveLength(3);
    // Nothing was pushed or committed by init: the clone is at the remote's tip.
    expect(commitCount(dir)).toBe(Number(git(remote, 'rev-list', '--count', 'main').trim()));
    // The events are already folded: list shows the tickets with no sync.
    const titles = listTickets(openTracked(dir))
      .map((t) => t.title)
      .sort();
    expect(titles).toEqual(['one', 'three', 'two']);
    // No temporary directory was left beside the board.
    expect(readdirSync(root)).toEqual(['.board']);
  });

  it('sync exits 0 on the cloned board', () => {
    const env = syncEnv();
    const { remote } = publishedBoard(env, ['one', 'two', 'three']);
    const root = plainProject();
    initBoardWithRemote(remote, { cwd: root, env });

    const result = syncBoard(openTracked(join(root, '.board')), { env });

    expect(result).toMatchObject({
      model: 'standalone',
      remote: 'origin',
      branch: 'main',
      commit: null,
      pulled: true,
      pushed: true,
      arrived: [],
    });
  });

  it('decision: when the remote HEAD names no branch of the clone and the remote has one branch, that branch is checked out', () => {
    const env = syncEnv();
    // A bare repository whose HEAD is main that only ever received master.
    const remote = bareRemote();
    const source = standaloneBoard(join(tempDir(), 'source'));
    git(source, 'symbolic-ref', 'HEAD', 'refs/heads/master');
    git(source, 'remote', 'add', 'origin', remote);
    putEvent(join(source, 'events'), createEvent(T1, 'on master'));
    expect(syncBoard(openTracked(source), { env }).pushed).toBe(true);
    expect(branchesOf(remote)).toEqual(['master']);
    expect(git(remote, 'symbolic-ref', 'HEAD').trim()).toBe('refs/heads/main');
    const root = plainProject();

    const result = initBoardWithRemote(remote, { cwd: root, env });

    const dir = join(root, '.board');
    expect(result).toMatchObject({ action: 'cloned', events: 1 });
    expect(git(dir, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('master');
    expect(revParse(dir)).toBe(revParse(remote, 'master'));
    expect(listTickets(openTracked(dir)).map((t) => t.title)).toEqual(['on master']);
    expect(syncBoard(openTracked(dir), { env })).toMatchObject({ branch: 'master', pushed: true });
  });
});

describe('a remote that holds a branch without events/ is not a board', () => {
  /** A bare remote whose main holds a README and nothing else. */
  function notABoardRemote(): string {
    const remote = bareRemote();
    const scratch = gitRepo(join(tempDir(), 'scratch'));
    writeFileSync(join(scratch, 'README.md'), 'not a board\n');
    git(scratch, 'add', 'README.md');
    git(scratch, 'commit', '-q', '-m', 'readme');
    git(scratch, 'push', '-q', remote, 'HEAD:refs/heads/main');
    return remote;
  }

  it('exits 1 not-a-board naming the URL and leaves no .board, no temporary directory and no host .gitignore entry', () => {
    const env = syncEnv();
    const remote = notABoardRemote();
    const root = gitRepo(join(tempDir(), 'proj'));
    const before = readdirSync(root).sort();

    const err = expectBoardError(
      () => initBoardWithRemote(remote, { cwd: root, env }),
      1,
      'not-a-board',
    );

    expect(err.message).toContain(remote);
    expect(err.message).toMatch(/events/);
    expect(existsSync(join(root, '.board'))).toBe(false);
    expect(readdirSync(root).sort()).toEqual(before);
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
    expect(git(root, 'status', '--porcelain')).toBe('');
    // The remote was not changed either.
    expect(branchesOf(remote)).toEqual(['main']);
  });
});

describe('scenario: Init with a non-local URL that does not exist', () => {
  it('exits 3 remote-unreachable telling the user to create the repository and check access, and creates nothing', () => {
    const shim = sshShim();
    const env = syncEnv({ GIT_SSH_COMMAND: shim.command });
    const url = SSH_URL.replace('project', 'missing');
    const root = gitRepo(join(tempDir(), 'proj'));

    const err = expectBoardError(
      () => initBoardWithRemote(url, { cwd: root, env }),
      3,
      'remote-unreachable',
    );

    expect(err.message).toContain(url);
    expect(err.message).toMatch(/create/);
    expect(err.message).toMatch(/access/);
    // The remote was asked (ls-remote through the shim), and it is the
    // only thing that happened.
    expect(shim.calls().length).toBeGreaterThan(0);
    expect(existsSync(join(root, '.board'))).toBe(false);
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
    expect(readdirSync(root).sort()).toEqual(['.git']);
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(git(root, 'for-each-ref', '--format=%(refname)', 'refs/agentboard/')).toBe('');
  });

  it('a local path that exists but is not a repository is unreachable too, quoting git', () => {
    const env = syncEnv();
    const notRepo = join(tempDir(), 'plain');
    mkdirSync(notRepo);
    const root = plainProject();

    const err = expectBoardError(
      () => initBoardWithRemote(notRepo, { cwd: root, env }),
      3,
      'remote-unreachable',
    );

    expect(err.message).toContain(notRepo);
    expect(err.message).toMatch(/fatal: /);
    expect(existsSync(join(root, '.board'))).toBe(false);
    expect(readdirSync(root)).toEqual([]);
    // The directory was not turned into a repository.
    expect(readdirSync(notRepo)).toEqual([]);
  });
});

describe('scenario: Init with a remote on an existing board without one', () => {
  it('sets origin, commits and pushes the unsynced events, and exits 0', () => {
    const env = syncEnv();
    const root = plainProject();
    const dir = standaloneBoard(root);
    putEvent(join(dir, 'events'), createEvent(T1, 'one'));
    putEvent(join(dir, 'events'), createEvent(T2, 'two'));
    const remote = bareRemote();

    const result = initBoardWithRemote(remote, { cwd: root, env });

    expect(Object.keys(result).sort()).toEqual(RESULT_KEYS);
    expect(result).toMatchObject({
      dir,
      action: 'attached',
      created: false,
      model: 'standalone',
      joined: false,
      remote: 'origin',
      remoteUrl: remote,
      events: 2,
      hostGitignore: null,
      repair: null,
    });
    expect(result.sync).toMatchObject({
      committedEvents: 2,
      remote: 'origin',
      pushed: true,
      upstreamSet: true,
    });
    expect(result.message).toContain(remote);
    expect(result.message).toMatch(/origin/);
    expect(originOf(dir)).toBe(remote);
    expect(treeEvents(dir)).toHaveLength(2);
    expect(treeEvents(remote, 'main')).toHaveLength(2);
    expect(revParse(dir)).toBe(revParse(remote, 'main'));
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('a relative local path on an existing board is resolved and stored absolute', () => {
    const env = syncEnv();
    const root = plainProject();
    const dir = standaloneBoard(root);
    // The remote is reached through a relative path from the project directory.
    const boards = join(root, 'boards');
    mkdirSync(boards);
    git(boards, 'init', '-q', '--bare', '-b', 'main', 'x.git');

    const result = initBoardWithRemote('./boards/x.git', { cwd: root, env });

    expect(result).toMatchObject({ action: 'attached', remoteUrl: join(boards, 'x.git') });
    expect(originOf(dir)).toBe(join(boards, 'x.git'));
  });

  it('attaching to a remote that already holds another clone\'s board merges both sets of events', () => {
    const env = syncEnv();
    const { remote } = publishedBoard(env, ['from A']);
    const root = plainProject();
    const dir = standaloneBoard(root);
    putEvent(join(dir, 'events'), createEvent(T2, 'from B'));

    const result = initBoardWithRemote(remote, { cwd: root, env });

    expect(result).toMatchObject({ action: 'attached', events: 2 });
    expect(result.sync).toMatchObject({ committedEvents: 1, pulled: true, pushed: true });
    expect(result.sync?.arrived).toHaveLength(1);
    expect(treeEvents(dir)).toHaveLength(2);
    expect(treeEvents(remote, 'main')).toHaveLength(2);
    expect(
      listTickets(openTracked(dir))
        .map((t) => t.title)
        .sort(),
    ).toEqual(['from A', 'from B']);
  });
});

describe('an existing standalone board that already has a remote', () => {
  it('with the same URL (given as a relative path again) changes nothing and runs no sync, exit 0', () => {
    const env = syncEnv();
    const root = plainProject();
    const first = initBoardWithRemote('../boards/x.git', { cwd: root, env });
    const dir = join(root, '.board');
    putEvent(join(dir, 'events'), createEvent(T1, 'not yet synced'));
    const bare = first.remoteUrl;
    const remoteTip = revParse(bare, 'main');
    const before = snapshotDir(dir);

    const again = initBoardWithRemote('../boards/x.git', { cwd: root, env });

    expect(again).toMatchObject({
      dir,
      action: 'unchanged',
      created: false,
      model: 'standalone',
      joined: false,
      remote: 'origin',
      remoteUrl: bare,
      events: 1,
      hostGitignore: null,
      sync: null,
      repair: null,
      warnings: [],
    });
    expect(again.message).toMatch(/nothing changed/);
    expect(snapshotDir(dir)).toEqual(before);
    // No sync ran: the event is still uncommitted and the remote did not move.
    expect(git(dir, 'status', '--porcelain')).toMatch(/^\?\? events\//m);
    expect(revParse(bare, 'main')).toBe(remoteTip);
  });

  it('with another URL exits 1 remote-mismatch naming both URLs and remote set-url, changing nothing', () => {
    const env = syncEnv();
    const root = plainProject();
    const dir = standaloneBoard(root);
    const existing = bareRemote();
    git(dir, 'remote', 'add', 'origin', existing);
    const other = bareRemote();
    const before = snapshotDir(dir);

    const err = expectBoardError(
      () => initBoardWithRemote(other, { cwd: root, env }),
      1,
      'remote-mismatch',
    );

    expect(err.message).toContain(existing);
    expect(err.message).toContain(other);
    expect(err.message).toContain('remote set-url');
    expect(originOf(dir)).toBe(existing);
    expect(snapshotDir(dir)).toEqual(before);
    expect(branchesOf(existing)).toEqual([]);
    expect(branchesOf(other)).toEqual([]);
  });
});

describe('scenario: Init with a remote on a host-model board', () => {
  it('exits 1 board-in-host and nothing changes, not the host refs, the worktrees, the board or the remote', () => {
    const env = syncEnv();
    const { root, dir } = hostBoard(env);
    const remote = bareRemote();
    const before = {
      refs: refs(root),
      worktrees: worktrees(root),
      board: snapshotDir(dir),
      status: git(root, 'status', '--porcelain'),
    };

    const err = expectBoardError(
      () => initBoardWithRemote(remote, { cwd: root, env }),
      1,
      'board-in-host',
    );

    expect(err.message).toContain(dir);
    expect(err.message).toContain('refs/agentboard/board');
    expect({
      refs: refs(root),
      worktrees: worktrees(root),
      board: snapshotDir(dir),
      status: git(root, 'status', '--porcelain'),
    }).toEqual(before);
    expect(branchesOf(remote)).toEqual([]);
    expect(git(dir, 'remote')).toBe('');
  });
});

describe('a failing sync propagates its exit code and reason, keeping the board and the remote', () => {
  it('a new board whose first push the remote refuses: exit 3 sync-failed, origin set, the commit kept', () => {
    const env = syncEnv();
    const remote = bareRemote();
    const marker = installHook(remote, 'pre-receive');
    const root = plainProject();
    const dir = join(root, '.board');

    const err = expectBoardError(
      () => initBoardWithRemote(remote, { cwd: root, env }),
      3,
      'sync-failed',
    );

    expect(existsSync(marker)).toBe(true);
    expect(err.message).toMatch(/push/);
    expectStandaloneBoard(dir, remote, env);
    expect(commitCount(dir)).toBe(1);
    expect(treePaths(dir)).toEqual(['.gitignore', 'events/.gitkeep']);
    expect(branchesOf(remote)).toEqual([]);
    // The next sync, once the remote accepts pushes, completes.
    writeFileSync(join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 0\n');
    expect(syncBoard(openTracked(dir), { env })).toMatchObject({ pushed: true });
    expect(branchesOf(remote)).toEqual(['main']);
  });

  it('an existing board whose events the remote refuses: exit 3 sync-failed, events committed, origin kept', () => {
    const env = syncEnv();
    const remote = bareRemote();
    installHook(remote, 'pre-receive');
    const root = plainProject();
    const dir = standaloneBoard(root);
    putEvent(join(dir, 'events'), createEvent(T1, 'one'));

    expectBoardError(() => initBoardWithRemote(remote, { cwd: root, env }), 3, 'sync-failed');

    expect(originOf(dir)).toBe(remote);
    expect(treeEvents(dir)).toHaveLength(1);
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect(branchesOf(remote)).toEqual([]);
  });
});

describe('init --remote inside a git host', () => {
  it('creates a standalone board (never the host model), writes the host .gitignore entry and leaves the host refs untouched', () => {
    const env = syncEnv();
    const root = gitRepo(join(tempDir(), 'proj'));
    const remote = bareRemote();
    const head = revParse(root);
    const refsBefore = refs(root);

    const result = initBoardWithRemote(remote, { cwd: root, env });

    const dir = join(root, '.board');
    expect(result).toMatchObject({
      dir,
      action: 'created',
      model: 'standalone',
      hostGitignore: join(root, '.gitignore'),
      warnings: [],
    });
    expectStandaloneBoard(dir, remote, env);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('.board/\n');
    expect(refs(root)).toBe(refsBefore);
    expect(git(root, 'for-each-ref', '--format=%(refname)', 'refs/agentboard/')).toBe('');
    expect(worktreeEntries(root)).toHaveLength(1);
    expect(revParse(root)).toBe(head);
    expect(git(root, 'status', '--porcelain')).toBe('?? .gitignore\n');
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('writes nothing to a host whose .gitignore already ignores the board: git status stays clean', () => {
    const env = syncEnv();
    const root = hostRepo();
    const remote = bareRemote();

    const result = initBoardWithRemote(remote, { cwd: root, env });

    expect(result.hostGitignore).toBeNull();
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(detectBoardModel(join(root, '.board'), { env }).model).toBe('standalone');
  });

  it('cloning a board into a git host writes the host .gitignore entry too, and still never pushes', () => {
    const env = syncEnv();
    const { remote } = publishedBoard(env, ['one']);
    const root = gitRepo(join(tempDir(), 'proj'));
    const tip = revParse(remote, 'main');

    const result = initBoardWithRemote(remote, { cwd: root, env });

    expect(result).toMatchObject({ action: 'cloned', hostGitignore: join(root, '.gitignore') });
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('.board/\n');
    expect(revParse(remote, 'main')).toBe(tip);
    expect(git(root, 'for-each-ref', '--format=%(refname)', 'refs/agentboard/')).toBe('');
  });

  it('never contacts the host repository remote: an SSH origin on the host records no call', () => {
    const shim = sshShim();
    const env = syncEnv({ GIT_SSH_COMMAND: shim.command });
    const root = hostRepo();
    git(root, 'remote', 'add', 'origin', SSH_URL);
    const remote = bareRemote();

    const result = initBoardWithRemote(remote, { cwd: root, env });

    expect(result).toMatchObject({ action: 'created', remote: 'origin', remoteUrl: remote });
    expect(shim.calls()).toEqual([]);
    expect(originOf(join(root, '.board'))).toBe(remote);
  });

  it('with a git older than 2.32 the result is the same standalone board, with no warning', () => {
    const env = withGitShim(syncEnv(), '2.31.8');
    const root = hostRepo();
    const remote = bareRemote();

    const result = initBoardWithRemote(remote, { cwd: root, env });

    expect(result).toMatchObject({ action: 'created', model: 'standalone', warnings: [] });
    expect(result.message).not.toContain('2.32');
    expectStandaloneBoard(join(root, '.board'), remote, env);
  });
});

describe('agentboard remote afterwards', () => {
  it('reports the standalone model, the branch and origin at the stored URL for a created board', () => {
    const env = syncEnv();
    const root = plainProject();
    const result = initBoardWithRemote('../boards/x.git', { cwd: root, env });

    const report = remoteReport(join(root, '.board'), { env });

    expect(report).toMatchObject({
      model: 'standalone',
      ref: null,
      refCommit: null,
      branch: 'main',
      remote: { name: 'origin', url: result.remoteUrl },
      remotes: [{ name: 'origin', url: result.remoteUrl }],
      problems: [],
    });
    expect(report.head).toMatch(HEX40);
    expect(result.remoteUrl).toBe(resolve(root, '../boards/x.git'));
  });

  it('reports the same for a cloned board', () => {
    const env = syncEnv();
    const { remote } = publishedBoard(env, ['one']);
    const root = plainProject();
    initBoardWithRemote(remote, { cwd: root, env });

    const report = remoteReport(join(root, '.board'), { env });

    expect(report).toMatchObject({
      model: 'standalone',
      branch: 'main',
      remote: { name: 'origin', url: remote },
      problems: [],
    });
  });
});

describe('refusals before anything is read', () => {
  it.each(['', '   '])('an empty --remote value (%j) is a usage error that creates nothing', (url) => {
    const env = syncEnv();
    const root = plainProject();

    expectBoardError(() => initBoardWithRemote(url, { cwd: root, env }), 1, 'usage');

    expect(readdirSync(root)).toEqual([]);
  });

  it('git missing is exit 1 git-missing as for init, creating nothing', () => {
    const env = syncEnv({ PATH: tempDir() });
    const root = plainProject();

    expectBoardError(
      () => initBoardWithRemote(join(tempDir(), 'x.git'), { cwd: root, env }),
      1,
      'git-missing',
    );

    expect(readdirSync(root)).toEqual([]);
  });
});

// The group 4 review round 1 (ticket 01M4SN8WNB94RP984DERZBRSBG, orchestrator
// ruling): the URL is validated before any git command runs, an existing
// non-board `.board` is refused before any write, the decisions are in the
// delta, and the clone failure paths are typed refusals.

/** The git command lines a recording shim saw that carry `word` as an argument. */
function callsWith(calls: readonly string[], word: string): string[] {
  return calls.filter((line) => line.split(' ').includes(word));
}

describe('scenario: Remote URL that is an option (review R1)', () => {
  it.each(['--upload-pack=touch PWNED;:x', '-x', '--', '-'])(
    'refuses %j as usage before any git command sees it, contacting nothing and creating nothing',
    (url) => {
      const shim = sshShim();
      const recording = withRecordingGitShim(syncEnv({ GIT_SSH_COMMAND: shim.command }));
      const env = recording.env;
      const root = hostRepo();
      git(root, 'remote', 'add', 'origin', SSH_URL);
      const before = { entries: readdirSync(root).sort(), refs: refs(root) };

      const err = expectBoardError(() => initBoardWithRemote(url, { cwd: root, env }), 1, 'usage');

      expect(err.message).toContain('--remote');
      expect(err.message).toContain(url);
      // No git command received the value, so no command could run it or
      // reach the host's origin; the shims prove both. (A one or two
      // character value is matched as a whole word: `-` is in every `-c`.)
      const carries = (line: string): boolean =>
        url.length > 2 ? line.includes(url) : line.split(' ').includes(url);
      for (const line of recording.calls()) {
        expect(carries(line), line).toBe(false);
      }
      expect(callsWith(recording.calls(), 'ls-remote')).toEqual([]);
      expect(callsWith(recording.calls(), 'clone')).toEqual([]);
      expect(shim.calls()).toEqual([]);
      expect(existsSync(join(root, 'PWNED'))).toBe(false);
      expect(existsSync(join(root, '.board'))).toBe(false);
      expect({ entries: readdirSync(root).sort(), refs: refs(root) }).toEqual(before);
      expect(git(root, 'status', '--porcelain')).toBe('');
    },
  );

  it('passes the URL after -- to ls-remote and to clone', () => {
    const base = syncEnv();
    const { remote } = publishedBoard(base, ['one']);
    const recording = withRecordingGitShim(base);
    const root = plainProject();

    const result = initBoardWithRemote(remote, { cwd: root, env: recording.env });

    expect(result.action).toBe('cloned');
    const lsRemote = callsWith(recording.calls(), 'ls-remote');
    expect(lsRemote).toHaveLength(1);
    expect(lsRemote[0]).toMatch(new RegExp(`ls-remote( \\S+)* -- ${remote}`));
    const clone = callsWith(recording.calls(), 'clone');
    expect(clone).toHaveLength(1);
    expect(clone[0]).toMatch(new RegExp(`clone( \\S+)* -- ${remote} `));
  });

  it('passes the URL after -- to ls-remote on the empty-remote path too', () => {
    const recording = withRecordingGitShim(syncEnv());
    const root = plainProject();
    const remote = bareRemote();

    const result = initBoardWithRemote(remote, { cwd: root, env: recording.env });

    expect(result.action).toBe('created');
    const lsRemote = callsWith(recording.calls(), 'ls-remote');
    expect(lsRemote.length).toBeGreaterThan(0);
    expect(lsRemote[0]).toMatch(new RegExp(`ls-remote( \\S+)* -- ${remote}`));
  });
});

describe('scenario: Existing directory that is not a board (review R2)', () => {
  /** `<root>/.board` as a directory holding only `notes.txt`; returns the file's bytes. */
  function userDirectory(root: string): Buffer {
    const dir = join(root, '.board');
    mkdirSync(dir);
    writeFileSync(join(dir, 'notes.txt'), 'my notes, not a board\n');
    return readFileSync(join(dir, 'notes.txt'));
  }

  it('a directory with a user file and a remote that holds a board: exit 2 before any write, the file survives', () => {
    const env = syncEnv();
    const { remote } = publishedBoard(env, ['one']);
    const root = gitRepo(join(tempDir(), 'proj'));
    const notes = userDirectory(root);
    const dir = join(root, '.board');
    const entries = readdirSync(root).sort();

    const err = expectBoardError(
      () => initBoardWithRemote(remote, { cwd: root, env }),
      2,
      'board-not-a-repository',
    );

    expect(err.message).toContain(dir);
    expect(err.message).toMatch(/move/);
    expect(readdirSync(dir)).toEqual(['notes.txt']);
    expect(readFileSync(join(dir, 'notes.txt')).equals(notes)).toBe(true);
    expect(readdirSync(root).sort()).toEqual(entries);
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
    // The fixture's own notes.txt is untracked; nothing else, so no
    // .gitignore entry was written (it would show as ?? .gitignore).
    expect(git(root, 'status', '--porcelain')).toBe('?? .board/\n');
  });

  it('a directory with a user file and a missing local path: exit 2, the bare repository is not created', () => {
    const env = syncEnv();
    const root = gitRepo(join(tempDir(), 'proj'));
    const notes = userDirectory(root);
    const dir = join(root, '.board');
    const bare = resolve(root, '../boards/project.git');

    expectBoardError(
      () => initBoardWithRemote('../boards/project.git', { cwd: root, env }),
      2,
      'board-not-a-repository',
    );

    expect(existsSync(bare)).toBe(false);
    expect(existsSync(resolve(root, '../boards'))).toBe(false);
    expect(readdirSync(dir)).toEqual(['notes.txt']);
    expect(readFileSync(join(dir, 'notes.txt')).equals(notes)).toBe(true);
    expect(existsSync(join(dir, '.git'))).toBe(false);
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
  });

  it('a directory with a user file and an empty remote: exit 2, the directory is not turned into a repository', () => {
    const env = syncEnv();
    const root = plainProject();
    const notes = userDirectory(root);
    const dir = join(root, '.board');
    const remote = bareRemote();

    expectBoardError(
      () => initBoardWithRemote(remote, { cwd: root, env }),
      2,
      'board-not-a-repository',
    );

    expect(readdirSync(dir)).toEqual(['notes.txt']);
    expect(readFileSync(join(dir, 'notes.txt')).equals(notes)).toBe(true);
    expect(branchesOf(remote)).toEqual([]);
  });

  it('a regular file named .board: exit 2, the file survives byte for byte', () => {
    const env = syncEnv();
    const { remote } = publishedBoard(env, ['one']);
    const root = plainProject();
    writeFileSync(join(root, '.board'), 'a file, not a directory\n');
    const bytes = readFileSync(join(root, '.board'));

    const err = expectBoardError(
      () => initBoardWithRemote(remote, { cwd: root, env }),
      2,
      'board-not-a-repository',
    );

    expect(err.message).toContain(join(root, '.board'));
    expect(lstatSync(join(root, '.board')).isFile()).toBe(true);
    expect(readFileSync(join(root, '.board')).equals(bytes)).toBe(true);
    expect(readdirSync(root)).toEqual(['.board']);
  });

  it('a dangling symbolic link named .board: exit 2, the link survives and its target stays absent', () => {
    const env = syncEnv();
    const root = plainProject();
    const remote = bareRemote();
    const target = join(tempDir(), 'gone');
    symlinkSync(target, join(root, '.board'));

    expectBoardError(
      () => initBoardWithRemote(remote, { cwd: root, env }),
      2,
      'board-not-a-repository',
    );

    expect(lstatSync(join(root, '.board')).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(root)).toEqual(['.board']);
    expect(branchesOf(remote)).toEqual([]);
  });

  it('an empty directory counts as absent: a board is cloned into it', () => {
    const env = syncEnv();
    const { remote } = publishedBoard(env, ['one']);
    const root = plainProject();
    mkdirSync(join(root, '.board'));

    const result = initBoardWithRemote(remote, { cwd: root, env });

    expect(result).toMatchObject({ action: 'cloned', events: 1 });
    expectStandaloneBoard(join(root, '.board'), remote, env);
    expect(readdirSync(root)).toEqual(['.board']);
  });

  it('an empty directory counts as absent: a new board is created in it for an empty remote', () => {
    const env = syncEnv();
    const root = plainProject();
    const remote = bareRemote();
    mkdirSync(join(root, '.board'));

    const result = initBoardWithRemote(remote, { cwd: root, env });

    expect(result).toMatchObject({ action: 'created' });
    expectStandaloneBoard(join(root, '.board'), remote, env);
    expect(branchesOf(remote)).toEqual(['main']);
  });
});

describe('scenario: Init with a remote on a board with several remotes (review R3)', () => {
  it('exits 1 ambiguous-remote naming fork, upstream and agentboard init, and changes nothing', () => {
    const env = syncEnv();
    const root = plainProject();
    const dir = standaloneBoard(root);
    const fork = bareRemote();
    const upstream = bareRemote();
    git(dir, 'remote', 'add', 'fork', fork);
    git(dir, 'remote', 'add', 'upstream', upstream);
    putEvent(join(dir, 'events'), createEvent(T1, 'not yet synced'));
    const other = bareRemote();
    const before = snapshotDir(dir);

    const err = expectBoardError(
      () => initBoardWithRemote(other, { cwd: root, env }),
      1,
      'ambiguous-remote',
    );

    expect(err.message).toContain('fork');
    expect(err.message).toContain('upstream');
    expect(err.message).toContain('agentboard init');
    expect(err.message).toContain('git config agentboard.remote <name>');
    expect(snapshotDir(dir)).toEqual(before);
    expect(git(dir, 'remote').trim().split('\n').sort()).toEqual(['fork', 'upstream']);
    expect(git(dir, 'status', '--porcelain')).toMatch(/^\?\? events\//m);
    for (const remote of [fork, upstream, other]) {
      expect(branchesOf(remote)).toEqual([]);
    }
  });
});

describe('file:// URLs with a host part (review S1)', () => {
  it('file://localhost/<path> names that path: a missing one is created as a bare repository, stored as given', () => {
    const env = syncEnv();
    const root = plainProject();
    const path = join(tempDir(), 'boards', 'x.git');
    const url = `file://localhost${path}`;

    const result = initBoardWithRemote(url, { cwd: root, env });

    expect(result).toMatchObject({ action: 'created', remoteUrl: url });
    expect(git(path, 'rev-parse', '--is-bare-repository').trim()).toBe('true');
    expect(originOf(join(root, '.board'))).toBe(url);
    expect(existsSync(join(root, 'localhost'))).toBe(false);
  });

  it.each(['file://host/x.git', 'file://example.invalid/boards/x.git'])(
    '%s is refused as usage and nothing is created',
    (url) => {
      const env = syncEnv();
      const root = plainProject();

      const err = expectBoardError(() => initBoardWithRemote(url, { cwd: root, env }), 1, 'usage');

      expect(err.message).toContain(url);
      expect(readdirSync(root)).toEqual([]);
    },
  );
});

describe('a matching URL rewritten by insteadOf (review S2)', () => {
  it('is unchanged, not remote-mismatch, and runs no sync', () => {
    const env = syncEnv();
    const root = plainProject();
    const dir = standaloneBoard(root);
    const bare = bareRemote();
    git(dir, 'remote', 'add', 'origin', 'https://host/d.git');
    git(dir, 'config', `url.${bare}/.insteadOf`, 'https://host/');
    expect(git(dir, 'remote', 'get-url', 'origin').trim()).toBe(`${bare}/d.git`);
    putEvent(join(dir, 'events'), createEvent(T1, 'not yet synced'));
    const before = snapshotDir(dir);

    const result = initBoardWithRemote('https://host/d.git', { cwd: root, env });

    expect(result).toMatchObject({
      action: 'unchanged',
      remote: 'origin',
      remoteUrl: 'https://host/d.git',
      sync: null,
    });
    expect(snapshotDir(dir)).toEqual(before);
    expect(git(dir, 'status', '--porcelain')).toMatch(/^\?\? events\//m);
    expect(git(dir, 'config', '--get', 'remote.origin.url').trim()).toBe('https://host/d.git');
  });
});

describe('clone failures after ls-remote succeeded (review S3)', () => {
  /**
   * A bare copy of the board at `source` (loose objects, so one can be
   * deleted) at `<temp>/corrupt.git`, with HEAD at `head`; returns its path.
   */
  function bareCopy(source: string, head: string): string {
    const bare = join(tempDir(), 'corrupt.git');
    git(tempDir(), 'clone', '-q', '--bare', '--no-hardlinks', source, bare);
    git(bare, 'symbolic-ref', 'HEAD', head);
    return bare;
  }

  /** Deletes the loose object `id` from the bare repository at `bare`. */
  function deleteObject(bare: string, id: string): void {
    const path = join(bare, 'objects', id.slice(0, 2), id.slice(2));
    expect(existsSync(path), path).toBe(true);
    rmSync(path);
  }

  /** A standalone board with one committed event on `main`. */
  function committedBoard(): string {
    const dir = standaloneBoard(join(tempDir(), 'source'));
    putEvent(join(dir, 'events'), createEvent(T1, 'one'));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'agentboard sync: 1 event file');
    return dir;
  }

  it('a file:// remote whose tip commit object is missing: ls-remote succeeds, the clone fails, exit 3 remote-unreachable, nothing left', () => {
    const env = syncEnv();
    const source = committedBoard();
    const bare = bareCopy(source, 'refs/heads/main');
    deleteObject(bare, revParse(bare, 'main'));
    const url = `file://${bare}`;
    expect(git(tempDir(), 'ls-remote', '--', url)).toContain('refs/heads/main');
    const root = gitRepo(join(tempDir(), 'proj'));

    const err = expectBoardError(
      () => initBoardWithRemote(url, { cwd: root, env }),
      3,
      'remote-unreachable',
    );

    expect(err.message).toContain(url);
    expect(err.message).toMatch(/fatal: |error: /);
    expect(existsSync(join(root, '.board'))).toBe(false);
    expect(readdirSync(root).sort()).toEqual(['.git']);
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
  });

  it('a remote whose HEAD names a missing branch and whose only branch cannot be checked out: exit 1 not-a-board, nothing left', () => {
    const env = syncEnv();
    const source = committedBoard();
    const bare = bareCopy(source, 'refs/heads/main');
    git(bare, 'branch', '-m', 'main', 'master');
    git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    deleteObject(bare, git(bare, 'rev-parse', 'master^{tree}').trim());
    const root = gitRepo(join(tempDir(), 'proj'));

    const err = expectBoardError(
      () => initBoardWithRemote(bare, { cwd: root, env }),
      1,
      'not-a-board',
    );

    expect(err.message).toContain(bare);
    expect(err.message).toMatch(/master/);
    expect(existsSync(join(root, '.board'))).toBe(false);
    expect(readdirSync(root).sort()).toEqual(['.git']);
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
  });
});

describe('review nits', () => {
  it('N1: agentboard.remote naming a remote the board does not have is a mismatch that names agentboard.remote, not remote set-url', () => {
    const env = syncEnv();
    const root = plainProject();
    const dir = standaloneBoard(root);
    git(dir, 'config', 'agentboard.remote', 'nosuch');
    const remote = bareRemote();
    const before = snapshotDir(dir);

    const err = expectBoardError(
      () => initBoardWithRemote(remote, { cwd: root, env }),
      1,
      'remote-mismatch',
    );

    expect(err.message).toContain('nosuch');
    expect(err.message).toContain('agentboard.remote');
    expect(err.message).not.toContain('remote set-url');
    expect(snapshotDir(dir)).toEqual(before);
    expect(git(dir, 'remote')).toBe('');
    expect(branchesOf(remote)).toEqual([]);
  });

  it('N3: a leftover .board-clone-* from an interrupted run is removed by the next init --remote, which names it (clone path)', () => {
    const env = syncEnv();
    const { remote } = publishedBoard(env, ['one']);
    const root = plainProject();
    const leftover = join(root, '.board-clone-abc123');
    mkdirSync(leftover);
    writeFileSync(join(leftover, 'half.txt'), 'half a clone\n');

    const result = initBoardWithRemote(remote, { cwd: root, env });

    expect(result.action).toBe('cloned');
    expect(result.message).toContain('.board-clone-abc123');
    expect(existsSync(leftover)).toBe(false);
    expect(readdirSync(root)).toEqual(['.board']);
    expectStandaloneBoard(join(root, '.board'), remote, env);
  });

  it('N3: the same on the empty-remote path', () => {
    const env = syncEnv();
    const root = plainProject();
    const remote = bareRemote();
    const leftover = join(root, '.board-clone-xyz789');
    mkdirSync(leftover);
    writeFileSync(join(leftover, 'half.txt'), 'half a clone\n');

    const result = initBoardWithRemote(remote, { cwd: root, env });

    expect(result.action).toBe('created');
    expect(result.message).toContain('.board-clone-xyz789');
    expect(existsSync(leftover)).toBe(false);
    expect(readdirSync(root)).toEqual(['.board']);
  });
});
