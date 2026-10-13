/**
 * Remote choice for both models (add-board-sharing task 1.3;
 * board-concurrency "Sync converges", the remote rules): table tests of
 * every rule and combination (`agentboard.remote`, the upstream of the
 * branch, an upstream remote of `.` ignored, `origin`, the only remote,
 * ambiguous), the host model consulting the main worktree's branch, the
 * `ambiguous-remote` refusal naming `git config agentboard.remote <name>`,
 * `sync` on a standalone board obeying the configured remote ("Configured
 * remote wins"), and the `remote` report and its text rendering in
 * process. Every remote is a bare repository on local disk.
 */

import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { BoardError } from '../../store/errors.js';
import { detectBoardModel } from '../model.js';
import {
  REMOTE_CONFIG_KEY,
  RULE_TEXT,
  ambiguousRemoteError,
  boardRemote,
  chooseRemote,
  remoteReport,
  renderRemote,
  type RemoteChoice,
  type RemoteReport,
} from '../remote.js';
import { syncBoard } from '../sync.js';
import {
  cleanEnv,
  create,
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
  separateGitDirBoard,
  withGitShim,
} from './sharing-helpers.js';
import { bareRemote, commitCount, initMachine, revParse, syncEnv } from './sync-helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const HEX40 = /^[0-9a-f]{40}$/;

/** Adds a bare remote named `name` to the repository at `dir`; returns its path. */
function addRemote(dir: string, name: string): string {
  const remote = bareRemote();
  git(dir, 'remote', 'add', name, remote);
  return remote;
}

/** Makes `branch` of `dir` track `<remote>/<branch>` without contacting it. */
function track(dir: string, remote: string, branch = 'main'): void {
  git(dir, 'config', `branch.${branch}.remote`, remote);
  git(dir, 'config', `branch.${branch}.merge`, `refs/heads/${branch}`);
}

/** The remotes of `dir` as `{ name, url }`, by name. */
function remotesOf(dir: string): { name: string; url: string }[] {
  return git(dir, 'remote')
    .split('\n')
    .filter((n) => n !== '')
    .sort()
    .map((name) => ({ name, url: git(dir, 'remote', 'get-url', name).trim() }));
}

describe('REMOTE_CONFIG_KEY and RULE_TEXT', () => {
  it('name the configuration key and the rules as the spec does', () => {
    expect(REMOTE_CONFIG_KEY).toBe('agentboard.remote');
    expect(RULE_TEXT).toEqual({
      'agentboard.remote': 'agentboard.remote',
      upstream: 'upstream',
      origin: 'origin',
      only: 'only remote',
    });
  });
});

describe('chooseRemote: each rule and combination of board-concurrency "Sync converges"', () => {
  interface Case {
    readonly label: string;
    /** Sets the repository up; returns the names of the remotes it added. */
    readonly setup: (dir: string) => void;
    readonly branch: string | null;
    readonly chosen: { name: string; rule: string; url: 'set' | null } | null;
    readonly ambiguous: boolean;
    readonly configured: string | null;
  }

  const cases: readonly Case[] = [
    {
      label: 'no remote: nothing chosen, not ambiguous',
      setup: () => undefined,
      branch: 'main',
      chosen: null,
      ambiguous: false,
      configured: null,
    },
    {
      label: 'origin alone is chosen by the origin rule',
      setup: (dir) => {
        addRemote(dir, 'origin');
      },
      branch: 'main',
      chosen: { name: 'origin', rule: 'origin', url: 'set' },
      ambiguous: false,
      configured: null,
    },
    {
      label: 'the only remote is chosen when it is not called origin',
      setup: (dir) => {
        addRemote(dir, 'hub');
      },
      branch: 'main',
      chosen: { name: 'hub', rule: 'only', url: 'set' },
      ambiguous: false,
      configured: null,
    },
    {
      label: 'origin beats another remote when nothing tracks',
      setup: (dir) => {
        addRemote(dir, 'hub');
        addRemote(dir, 'origin');
      },
      branch: 'main',
      chosen: { name: 'origin', rule: 'origin', url: 'set' },
      ambiguous: false,
      configured: null,
    },
    {
      label: 'fork and upstream, no origin, no tracking: ambiguous',
      setup: (dir) => {
        addRemote(dir, 'fork');
        addRemote(dir, 'upstream');
      },
      branch: 'main',
      chosen: null,
      ambiguous: true,
      configured: null,
    },
    {
      label: 'the upstream of the branch wins over the only-remote and origin rules',
      setup: (dir) => {
        addRemote(dir, 'fork');
        addRemote(dir, 'upstream');
        track(dir, 'upstream');
      },
      branch: 'main',
      chosen: { name: 'upstream', rule: 'upstream', url: 'set' },
      ambiguous: false,
      configured: null,
    },
    {
      label: 'the upstream of the branch wins over origin',
      setup: (dir) => {
        addRemote(dir, 'origin');
        addRemote(dir, 'fork');
        track(dir, 'fork');
      },
      branch: 'main',
      chosen: { name: 'fork', rule: 'upstream', url: 'set' },
      ambiguous: false,
      configured: null,
    },
    {
      label: 'the upstream of another branch does not count',
      setup: (dir) => {
        addRemote(dir, 'fork');
        addRemote(dir, 'upstream');
        track(dir, 'fork', 'feature');
      },
      branch: 'main',
      chosen: null,
      ambiguous: true,
      configured: null,
    },
    {
      label: 'branch.<b>.remote without branch.<b>.merge is not an upstream',
      setup: (dir) => {
        addRemote(dir, 'fork');
        addRemote(dir, 'upstream');
        git(dir, 'config', 'branch.main.remote', 'fork');
      },
      branch: 'main',
      chosen: null,
      ambiguous: true,
      configured: null,
    },
    {
      label: 'an upstream remote of . is ignored: origin is chosen',
      setup: (dir) => {
        addRemote(dir, 'origin');
        git(dir, 'branch', '-q', 'base');
        track(dir, '.');
        git(dir, 'config', 'branch.main.merge', 'refs/heads/base');
      },
      branch: 'main',
      chosen: { name: 'origin', rule: 'origin', url: 'set' },
      ambiguous: false,
      configured: null,
    },
    {
      label: 'an upstream remote of . is ignored: the only remote is chosen',
      setup: (dir) => {
        addRemote(dir, 'hub');
        git(dir, 'branch', '-q', 'base');
        track(dir, '.');
        git(dir, 'config', 'branch.main.merge', 'refs/heads/base');
      },
      branch: 'main',
      chosen: { name: 'hub', rule: 'only', url: 'set' },
      ambiguous: false,
      configured: null,
    },
    {
      label: 'an upstream remote of . is ignored: fork and upstream stay ambiguous',
      setup: (dir) => {
        addRemote(dir, 'fork');
        addRemote(dir, 'upstream');
        git(dir, 'branch', '-q', 'base');
        track(dir, '.');
        git(dir, 'config', 'branch.main.merge', 'refs/heads/base');
      },
      branch: 'main',
      chosen: null,
      ambiguous: true,
      configured: null,
    },
    {
      label: 'agentboard.remote wins over the upstream of the branch (Configured remote wins)',
      setup: (dir) => {
        addRemote(dir, 'fork');
        addRemote(dir, 'upstream');
        track(dir, 'upstream');
        git(dir, 'config', 'agentboard.remote', 'fork');
      },
      branch: 'main',
      chosen: { name: 'fork', rule: 'agentboard.remote', url: 'set' },
      ambiguous: false,
      configured: 'fork',
    },
    {
      label: 'agentboard.remote wins over origin',
      setup: (dir) => {
        addRemote(dir, 'origin');
        addRemote(dir, 'fork');
        git(dir, 'config', 'agentboard.remote', 'fork');
      },
      branch: 'main',
      chosen: { name: 'fork', rule: 'agentboard.remote', url: 'set' },
      ambiguous: false,
      configured: 'fork',
    },
    {
      label: 'agentboard.remote resolves an otherwise ambiguous choice',
      setup: (dir) => {
        addRemote(dir, 'fork');
        addRemote(dir, 'upstream');
        git(dir, 'config', 'agentboard.remote', 'upstream');
      },
      branch: 'main',
      chosen: { name: 'upstream', rule: 'agentboard.remote', url: 'set' },
      ambiguous: false,
      configured: 'upstream',
    },
    {
      label: 'agentboard.remote naming a remote that does not exist is chosen with no URL',
      setup: (dir) => {
        addRemote(dir, 'origin');
        git(dir, 'config', 'agentboard.remote', 'nope');
      },
      branch: 'main',
      chosen: { name: 'nope', rule: 'agentboard.remote', url: null },
      ambiguous: false,
      configured: 'nope',
    },
    {
      label: 'a detached HEAD (no branch) falls through to origin',
      setup: (dir) => {
        addRemote(dir, 'origin');
        addRemote(dir, 'fork');
        track(dir, 'fork');
      },
      branch: null,
      chosen: { name: 'origin', rule: 'origin', url: 'set' },
      ambiguous: false,
      configured: null,
    },
    {
      label: 'a detached HEAD with fork and upstream is ambiguous',
      setup: (dir) => {
        addRemote(dir, 'fork');
        addRemote(dir, 'upstream');
        track(dir, 'upstream');
      },
      branch: null,
      chosen: null,
      ambiguous: true,
      configured: null,
    },
    {
      label: 'three remotes with none chosen are ambiguous',
      setup: (dir) => {
        addRemote(dir, 'a');
        addRemote(dir, 'b');
        addRemote(dir, 'c');
      },
      branch: 'main',
      chosen: null,
      ambiguous: true,
      configured: null,
    },
  ];

  it.each(cases.map((c) => [c.label, c] as const))('%s', (_label, c) => {
    const env = syncEnv();
    const dir = gitRepo(join(tempDir(), 'repo'));
    c.setup(dir);
    const remotes = remotesOf(dir);

    const choice = chooseRemote(dir, c.branch, { env });

    expect(choice.remotes).toEqual(remotes);
    expect(choice.ambiguous).toBe(c.ambiguous);
    expect(choice.branch).toBe(c.branch);
    expect(choice.configured).toBe(c.configured);
    if (c.chosen === null) {
      expect(choice.chosen).toBeNull();
    } else {
      const url =
        c.chosen.url === null ? null : remotes.find((r) => r.name === c.chosen?.name)?.url;
      expect(choice.chosen).toEqual({ name: c.chosen.name, rule: c.chosen.rule, url });
      if (url !== null) {
        expect(url).toMatch(/remote\.git$/);
      }
    }
  });

  it('never contacts a remote (an unreachable URL changes nothing)', () => {
    const env = syncEnv();
    const dir = gitRepo(join(tempDir(), 'repo'));
    git(dir, 'remote', 'add', 'origin', join(tempDir(), 'missing.git'));
    const choice = chooseRemote(dir, 'main', { env });
    expect(choice.chosen).toEqual({
      name: 'origin',
      rule: 'origin',
      url: git(dir, 'remote', 'get-url', 'origin').trim(),
    });
  });
});

describe('boardRemote: the branch the model prescribes', () => {
  it('standalone: the board repository and its current branch', () => {
    const env = syncEnv();
    const remote = bareRemote();
    const { dir } = initMachine(env, remote);
    git(dir, 'remote', 'add', 'fork', bareRemote());
    track(dir, 'fork');
    const info = detectBoardModel(dir, { env });

    const choice = boardRemote(info, { env });

    expect(choice.branch).toBe('main');
    expect(choice.chosen).toMatchObject({ name: 'fork', rule: 'upstream' });
    expect(choice.remotes.map((r) => r.name)).toEqual(['fork', 'origin']);
  });

  it('standalone: a detached HEAD has no branch', () => {
    const env = syncEnv();
    const { dir } = initMachine(env, bareRemote());
    const board = openTracked(dir);
    create(board);
    syncBoard(board, { env });
    git(dir, 'checkout', '-q', '--detach');
    const choice = boardRemote(detectBoardModel(dir, { env }), { env });
    expect(choice.branch).toBeNull();
    expect(choice.chosen).toMatchObject({ name: 'origin', rule: 'origin' });
  });

  it("host: the host's main worktree branch decides, not the linked worktree's", () => {
    const env = syncEnv();
    const { root, dir } = hostBoard(env);
    addRemote(root, 'fork');
    addRemote(root, 'upstream');
    track(root, 'upstream');
    // A linked worktree on a branch that tracks fork; agents often run there.
    const linked = join(tempDir(), 'feature');
    git(root, 'worktree', 'add', '-q', '-b', 'feature', linked);
    track(root, 'fork', 'feature');
    const info = detectBoardModel(dir, { env });

    const choice = boardRemote(info, { env });

    expect(choice.branch).toBe('main');
    expect(choice.chosen).toMatchObject({ name: 'upstream', rule: 'upstream' });
    expect(choice.remotes.map((r) => r.name)).toEqual(['fork', 'upstream']);
  });

  it("host: the board worktree's own detached HEAD is not the branch", () => {
    const env = syncEnv();
    const { root, dir } = hostBoard(env);
    addRemote(root, 'fork');
    addRemote(root, 'upstream');
    track(root, 'upstream');
    const choice = boardRemote(detectBoardModel(dir, { env }), { env });
    expect(choice.chosen).toMatchObject({ name: 'upstream', rule: 'upstream' });
  });

  it('host: a detached main worktree has no branch, so fork and upstream are ambiguous', () => {
    const env = syncEnv();
    const { root, dir } = hostBoard(env);
    addRemote(root, 'fork');
    addRemote(root, 'upstream');
    track(root, 'upstream');
    git(root, 'checkout', '-q', '--detach');
    const choice = boardRemote(detectBoardModel(dir, { env }), { env });
    expect(choice.branch).toBeNull();
    expect(choice.chosen).toBeNull();
    expect(choice.ambiguous).toBe(true);
  });

  it('host: agentboard.remote of the host repository wins', () => {
    const env = syncEnv();
    const { root, dir } = hostBoard(env);
    addRemote(root, 'fork');
    addRemote(root, 'upstream');
    track(root, 'upstream');
    git(root, 'config', 'agentboard.remote', 'fork');
    const choice = boardRemote(detectBoardModel(dir, { env }), { env });
    expect(choice.chosen).toMatchObject({ name: 'fork', rule: 'agentboard.remote' });
    expect(choice.configured).toBe('fork');
  });

  it('a broken host link and a non-repository have nothing to choose from', () => {
    const env = syncEnv();
    const a = hostBoard(env);
    addRemote(a.root, 'origin');
    const c = hostRepo(join(tempDir(), 'clone-c'));
    cpSync(a.dir, join(c, '.board'), { recursive: true });
    const empty: RemoteChoice = {
      chosen: null,
      remotes: [],
      ambiguous: false,
      branch: null,
      configured: null,
    };
    expect(boardRemote(detectBoardModel(join(c, '.board'), { env }), { env })).toEqual(empty);
    expect(boardRemote(detectBoardModel(makeBoardDir(tempDir()), { env }), { env })).toEqual(empty);
  });
});

describe('ambiguousRemoteError', () => {
  it('is exit 1 ambiguous-remote naming the remotes and git config agentboard.remote <name>', () => {
    const choice: RemoteChoice = {
      chosen: null,
      remotes: [
        { name: 'fork', url: 'git@example.invalid:me/fork.git' },
        { name: 'upstream', url: 'git@example.invalid:them/project.git' },
      ],
      ambiguous: true,
      branch: 'main',
      configured: null,
    };
    const err = ambiguousRemoteError(choice);
    expect(err).toBeInstanceOf(BoardError);
    const boardError = err as BoardError;
    expect(boardError.exitCode).toBe(1);
    expect(boardError.reason).toBe('ambiguous-remote');
    expect(boardError.message).toContain('fork');
    expect(boardError.message).toContain('upstream');
    expect(boardError.message).toContain('git config agentboard.remote <name>');
    expect(boardError.message).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe('sync on a standalone board obeys the remote rules', () => {
  it('scenario: Configured remote wins (agentboard.remote fork while main tracks upstream/main)', () => {
    const env = syncEnv();
    const { dir } = initMachine(env);
    const fork = addRemote(dir, 'fork');
    const upstream = addRemote(dir, 'upstream');
    track(dir, 'upstream');
    git(dir, 'config', 'agentboard.remote', 'fork');
    const board = openTracked(dir);
    create(board);

    const result = syncBoard(board, { env });

    expect(result.remote).toBe('fork');
    expect(result.pushed).toBe(true);
    expect(revParse(fork, 'main')).toBe(revParse(dir));
    expect(git(upstream, 'for-each-ref')).toBe('');
    // The override never rewrites the user's upstream: no push -u, and the
    // branch still tracks upstream/main (design.md decision 5).
    expect(result.upstreamSet).toBe(false);
    expect(result.message).not.toContain('set it as the upstream');
    expect(git(dir, 'config', '--get', 'branch.main.remote').trim()).toBe('upstream');
    expect(git(dir, 'config', '--get', 'branch.main.merge').trim()).toBe('refs/heads/main');
  });

  it('an upstream remote of . is ignored and origin is used', () => {
    const env = syncEnv();
    const { dir } = initMachine(env);
    const origin = addRemote(dir, 'origin');
    const board = openTracked(dir);
    create(board);
    syncBoard(board, { env });
    git(dir, 'branch', '-q', 'base');
    track(dir, '.');
    git(dir, 'config', 'branch.main.merge', 'refs/heads/base');
    create(board);

    const result = syncBoard(board, { env });

    expect(result.remote).toBe('origin');
    expect(result.pushed).toBe(true);
    expect(revParse(origin, 'main')).toBe(revParse(dir));
  });

  it('ambiguous-remote names both remotes and git config agentboard.remote, after committing', () => {
    const env = syncEnv();
    const { dir } = initMachine(env);
    addRemote(dir, 'fork');
    addRemote(dir, 'upstream');
    const board = openTracked(dir);
    create(board);

    const err = expectBoardError(() => syncBoard(board, { env }), 1, 'ambiguous-remote');

    expect(err.message).toContain('fork');
    expect(err.message).toContain('upstream');
    expect(err.message).toContain('git config agentboard.remote <name>');
    expect(commitCount(dir)).toBe(1);
  });

  it('agentboard.remote naming a remote that does not exist fails to reach it (exit 3) after committing', () => {
    const env = syncEnv();
    const { dir } = initMachine(env, bareRemote());
    git(dir, 'config', 'agentboard.remote', 'nope');
    const board = openTracked(dir);
    create(board);

    const err = expectBoardError(() => syncBoard(board, { env }), 3, 'sync-failed');

    expect(err.message).toContain('nope');
    expect(commitCount(dir)).toBe(1);
  });
});

describe('remoteReport', () => {
  const KEYS = [
    'branch',
    'dir',
    'gitDir',
    'head',
    'model',
    'problems',
    'ref',
    'refCommit',
    'remote',
    'remotes',
  ];

  it('host model: the ref with its commit, the host git directory and the upstream remote', () => {
    const env = syncEnv();
    const { root, dir, commit } = hostBoard(env);
    const origin = addRemote(root, 'origin');
    track(root, 'origin');
    const hash = commitHostEvent(dir, { v: 1, kind: 'noise', body: {} }, env);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const head = revParse(dir);
    expect(head).not.toBe(commit);

    const report = remoteReport(dir, { env });

    expect(Object.keys(report).sort()).toEqual(KEYS);
    expect(report).toEqual({
      dir,
      model: 'host',
      gitDir: real(join(root, '.git')),
      ref: 'refs/agentboard/board',
      refCommit: head,
      branch: null,
      head,
      remote: { name: 'origin', url: origin, rule: 'upstream' },
      remotes: [{ name: 'origin', url: origin }],
      problems: [],
    });
    expect(report.head).toMatch(HEX40);
  });

  it('host model: a ref that has gone has a null refCommit and the HEAD still reported', () => {
    const env = syncEnv();
    const { root, dir, commit } = hostBoard(env);
    git(root, 'update-ref', '-d', 'refs/agentboard/board');
    const report = remoteReport(dir, { env });
    expect(report.model).toBe('host');
    expect(report.refCommit).toBeNull();
    expect(report.head).toBe(commit);
  });

  it('standalone with no remote: the branch, no remote, no remotes, no problem', () => {
    const env = syncEnv();
    const { dir } = initMachine(env);
    const report = remoteReport(dir, { env });
    expect(Object.keys(report).sort()).toEqual(KEYS);
    expect(report).toEqual({
      dir,
      model: 'standalone',
      gitDir: real(join(dir, '.git')),
      ref: null,
      refCommit: null,
      branch: 'main',
      head: null,
      remote: null,
      remotes: [],
      problems: [],
    });
  });

  it('standalone with commits and a remote: the head and the chosen remote', () => {
    const env = syncEnv();
    const remote = bareRemote();
    const { dir } = initMachine(env, remote);
    const board = openTracked(dir);
    create(board);
    syncBoard(board, { env });
    const report = remoteReport(dir, { env });
    expect(report.head).toBe(revParse(dir));
    expect(report.branch).toBe('main');
    expect(report.remote).toEqual({ name: 'origin', url: remote, rule: 'upstream' });
    expect(report.problems).toEqual([]);
  });

  it('standalone with a separate git directory: model standalone, the git directory the .git file names', () => {
    const env = syncEnv();
    const remote = bareRemote();
    const { dir, gitDir } = separateGitDirBoard();
    git(dir, 'remote', 'add', 'origin', remote);

    const report = remoteReport(dir, { env });

    expect(Object.keys(report).sort()).toEqual(KEYS);
    expect(report).toEqual({
      dir,
      model: 'standalone',
      gitDir: real(gitDir),
      ref: null,
      refCommit: null,
      branch: 'main',
      head: null,
      remote: { name: 'origin', url: remote, rule: 'origin' },
      remotes: [{ name: 'origin', url: remote }],
      problems: [],
    });
    expect(renderRemote(report)).toContain('model: standalone\n');
  });

  it('broken host link: a problem naming agentboard init, nothing else known', () => {
    const env = syncEnv();
    const a = hostBoard(env);
    const c = hostRepo(join(tempDir(), 'clone-c'));
    const dir = join(c, '.board');
    cpSync(a.dir, dir, { recursive: true });
    const report = remoteReport(dir, { env });
    expect(report).toMatchObject({
      dir,
      model: 'broken-host-link',
      gitDir: null,
      ref: null,
      refCommit: null,
      branch: null,
      head: null,
      remote: null,
      remotes: [],
    });
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain('agentboard init');
  });

  it('not a repository: a problem naming agentboard init', () => {
    const env = syncEnv();
    const dir = makeBoardDir(tempDir());
    const report = remoteReport(dir, { env });
    expect(report.model).toBe('not-a-repository');
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain('agentboard init');
  });

  it('an ambiguous choice is a problem naming the remotes and git config agentboard.remote', () => {
    const env = syncEnv();
    const { root, dir } = hostBoard(env);
    addRemote(root, 'fork');
    addRemote(root, 'upstream');
    const report = remoteReport(dir, { env });
    expect(report.remote).toBeNull();
    expect(report.remotes.map((r) => r.name)).toEqual(['fork', 'upstream']);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain('fork');
    expect(report.problems[0]).toContain('upstream');
    expect(report.problems[0]).toContain('git config agentboard.remote <name>');
  });

  it('agentboard.remote naming a missing remote is reported with the names that exist', () => {
    const env = syncEnv();
    const { dir } = initMachine(env, bareRemote());
    git(dir, 'config', 'agentboard.remote', 'nope');
    const report = remoteReport(dir, { env });
    expect(report.remote).toEqual({ name: 'nope', url: null, rule: 'agentboard.remote' });
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain('nope');
    expect(report.problems[0]).toContain('origin');
  });

  it('a host-model board on a git older than 2.32 is a problem; a standalone board is not', () => {
    const env = withGitShim(syncEnv(), '2.31.8');
    const host = hostBoard(env);
    addRemote(host.root, 'origin');
    const hostReport = remoteReport(host.dir, { env });
    expect(hostReport.model).toBe('host');
    expect(hostReport.problems).toHaveLength(1);
    expect(hostReport.problems[0]).toContain('2.31.8');
    expect(hostReport.problems[0]).toContain('2.32');

    const { dir } = initMachine(env);
    expect(remoteReport(dir, { env }).problems).toEqual([]);

    const fine = withGitShim(syncEnv(), '2.32.0');
    expect(remoteReport(host.dir, { env: fine }).problems).toEqual([]);
  });

  it('git not runnable: every git-derived field empty and a problem naming git, without throwing', () => {
    const { dir } = hostBoard(syncEnv());
    const report = remoteReport(dir, { env: cleanEnv({ PATH: '' }) });
    expect(report).toMatchObject({
      dir,
      model: 'not-a-repository',
      gitDir: null,
      ref: null,
      refCommit: null,
      branch: null,
      head: null,
      remote: null,
      remotes: [],
    });
    expect(report.problems.some((p) => /\bgit\b/.test(p))).toBe(true);
  });

  it('never opens the board: no cache file is created and git state is unchanged', () => {
    const env = syncEnv();
    const { root, dir } = hostBoard(env);
    addRemote(root, 'origin');
    const before = [git(root, 'for-each-ref'), git(root, 'worktree', 'list', '--porcelain')];
    remoteReport(dir, { env });
    expect(existsSync(join(dir, 'cache.sqlite'))).toBe(false);
    expect([git(root, 'for-each-ref'), git(root, 'worktree', 'list', '--porcelain')]).toEqual(
      before,
    );
  });

  it('every problem is one plain ASCII line', () => {
    const env = syncEnv();
    const { root, dir } = hostBoard(env);
    addRemote(root, 'fork');
    addRemote(root, 'upstream');
    for (const problem of remoteReport(dir, { env }).problems) {
      expect(problem).toMatch(/^[\x20-\x7e]+$/);
      expect(problem).toBe(problem.trim());
    }
  });
});

describe('renderRemote', () => {
  const COMMIT = 'a'.repeat(40);
  const base: RemoteReport = {
    dir: '/p/.board',
    model: 'host',
    gitDir: '/p/.git',
    ref: 'refs/agentboard/board',
    refCommit: COMMIT,
    branch: null,
    head: COMMIT,
    remote: { name: 'origin', url: 'git@example.invalid:me/p.git', rule: 'upstream' },
    remotes: [
      { name: 'origin', url: 'git@example.invalid:me/p.git' },
      { name: 'fork', url: 'git@example.invalid:me/fork.git' },
    ],
    problems: [],
  };

  function lines(report: RemoteReport): string[] {
    const text = renderRemote(report);
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toMatch(/^[\x20-\x7e\n]+$/);
    return text.slice(0, -1).split('\n');
  }

  it('host model: the board, the model, the ref with its commit, the remote with its rule, every remote', () => {
    const out = lines(base);
    expect(out[0]).toBe('board: /p/.board');
    expect(out[1]).toBe('model: host');
    expect(out[2]).toBe(`history: refs/agentboard/board at ${COMMIT} in /p/.git`);
    expect(out[3]).toBe('remote: origin git@example.invalid:me/p.git (chosen by upstream)');
    expect(out[4]).toBe('remotes:');
    expect(out.slice(5, 7).map((l) => l.trim().split(/\s+/))).toEqual([
      ['origin', 'git@example.invalid:me/p.git'],
      ['fork', 'git@example.invalid:me/fork.git'],
    ]);
    expect(out).toHaveLength(7);
  });

  it('host model with the ref missing', () => {
    const out = lines({ ...base, refCommit: null });
    expect(out[2]).toBe('history: refs/agentboard/board missing in /p/.git');
  });

  it('standalone model: the branch and the head, no remote, no remotes', () => {
    const out = lines({
      ...base,
      model: 'standalone',
      gitDir: '/p/.board/.git',
      ref: null,
      refCommit: null,
      branch: 'main',
      remote: null,
      remotes: [],
    });
    expect(out[1]).toBe('model: standalone');
    expect(out[2]).toBe(`history: branch main at ${COMMIT} in /p/.board/.git`);
    expect(out[3]).toBe('remote: none configured');
    expect(out[4]).toBe('remotes: none');
    expect(out).toHaveLength(5);
  });

  it('standalone model with no commit yet and a detached HEAD', () => {
    const unborn = lines({
      ...base,
      model: 'standalone',
      ref: null,
      refCommit: null,
      branch: 'main',
      head: null,
    });
    expect(unborn[2]).toBe('history: branch main (no commits yet) in /p/.git');
    const detached = lines({
      ...base,
      model: 'standalone',
      ref: null,
      refCommit: null,
      branch: null,
    });
    expect(detached[2]).toBe(`history: detached HEAD at ${COMMIT} in /p/.git`);
  });

  it('the rule texts: agentboard.remote, origin and only remote', () => {
    const rule = (r: 'agentboard.remote' | 'origin' | 'only'): string =>
      String(lines({ ...base, remote: { name: 'fork', url: 'u', rule: r } })[3]);
    expect(rule('agentboard.remote')).toBe('remote: fork u (chosen by agentboard.remote)');
    expect(rule('origin')).toBe('remote: fork u (chosen by origin)');
    expect(rule('only')).toBe('remote: fork u (chosen by only remote)');
  });

  it('a configured remote that does not exist', () => {
    const out = lines({ ...base, remote: { name: 'nope', url: null, rule: 'agentboard.remote' } });
    expect(out[3]).toBe('remote: nope (chosen by agentboard.remote; no such remote)');
  });

  it('an ambiguous choice names the remotes and how to set agentboard.remote', () => {
    const out = lines({ ...base, remote: null });
    expect(out[3]).toBe(
      'remote: ambiguous (origin, fork); set one with git config agentboard.remote <name>',
    );
  });

  it('a broken host link and its problem', () => {
    const out = lines({
      ...base,
      model: 'broken-host-link',
      gitDir: null,
      ref: null,
      refCommit: null,
      head: null,
      remote: null,
      remotes: [],
      problems: ['the .git file names a missing directory; run agentboard init to repair it'],
    });
    expect(out[1]).toBe('model: broken host link');
    expect(out[2]).toBe(
      'problem: the .git file names a missing directory; run agentboard init to repair it',
    );
    expect(out).toHaveLength(3);
  });

  it('not a repository', () => {
    const out = lines({
      ...base,
      model: 'not-a-repository',
      gitDir: null,
      ref: null,
      refCommit: null,
      head: null,
      remote: null,
      remotes: [],
      problems: ['p1', 'p2'],
    });
    expect(out[1]).toBe('model: not a repository');
    expect(out.slice(2)).toEqual(['problem: p1', 'problem: p2']);
    expect(out).toHaveLength(4);
  });

  it('keeps the output plain ASCII whatever the URLs hold', () => {
    const out = renderRemote({
      ...base,
      remotes: [
        {
          name: 'origin',
          url: `ssh://caf${String.fromCodePoint(0xe9)}.example/${String.fromCodePoint(0x2014)}`,
        },
      ],
    });
    expect(out).toMatch(/^[\x20-\x7e\n]+$/);
  });
});
