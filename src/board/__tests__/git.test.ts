/**
 * The shared git layer (add-board-sharing task 1.1; design.md decisions 3
 * and 4): `git --version` parsing and the 2.32 floor of the host model, the
 * version of the real git and of a shim on the PATH, and the runner: the
 * fixed identity, the sanitised environment, `commit.gpgsign=false`,
 * `attempt` returning failures, and hooks of the target repository not
 * running when they are disabled. Every repository is temporary and on
 * local disk.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  GIT_IDENTITY,
  GIT_REPOSITORY_VARIABLES,
  HOST_MODEL_GIT_FLOOR,
  firstErrorLine,
  gitRunner,
  gitVersion,
  isGitFailure,
  meetsGitFloor,
  parseGitVersion,
  type GitFailure,
  type GitVersion,
} from '../git.js';
import { SYNC_IDENTITY } from '../sync.js';
import { cleanEnv, git, gitRepo, tempDir } from './helpers.js';
import { hostBoard, withGitShim } from './sharing-helpers.js';
import { bareRemote, syncEnv, type Env } from './sync-helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const V = (major: number, minor: number, patch: number): GitVersion => ({ major, minor, patch });

describe('parseGitVersion', () => {
  it.each([
    ['git version 2.52.0', V(2, 52, 0)],
    ['git version 2.39.5 (Apple Git-154)', V(2, 39, 5)],
    ['git version 2.32.0.windows.1', V(2, 32, 0)],
    ['git version 2.31.8', V(2, 31, 8)],
    ['git version 2.52.0\n', V(2, 52, 0)],
    ['  git version 2.34.1  \n', V(2, 34, 1)],
    ['git version 2.40', V(2, 40, 0)],
    ['git version 10.0.1', V(10, 0, 1)],
  ])('parses %j', (text, expected) => {
    expect(parseGitVersion(text)).toEqual(expected);
  });

  it.each([
    [''],
    ['\n'],
    ['git: command not found'],
    ['2.52.0'],
    ['version 2.52.0'],
    ['git version x.y.z'],
    ['git version 2'],
    ['git version'],
    ['gitversion 2.52.0'],
  ])('is null for %j', (text) => {
    expect(parseGitVersion(text)).toBeNull();
  });
});

describe('the host model git floor', () => {
  it('is 2.32 (design.md decision 3)', () => {
    expect(HOST_MODEL_GIT_FLOOR).toEqual({ major: 2, minor: 32 });
  });

  it.each([
    [V(2, 32, 0), true],
    [V(2, 32, 7), true],
    [V(2, 34, 1), true],
    [V(2, 52, 0), true],
    [V(3, 0, 0), true],
    [V(2, 31, 8), false],
    [V(2, 31, 99), false],
    [V(2, 30, 6), false],
    [V(1, 99, 99), false],
    [V(2, 0, 0), false],
  ])('meetsGitFloor(%j) is %s', (version, expected) => {
    expect(meetsGitFloor(version)).toBe(expected);
  });

  it('agrees with the parsed versions tasks.md names', () => {
    const parsed = (text: string): GitVersion => {
      const v = parseGitVersion(text);
      if (v === null) {
        throw new Error(`did not parse: ${text}`);
      }
      return v;
    };
    expect(meetsGitFloor(parsed('git version 2.52.0'))).toBe(true);
    expect(meetsGitFloor(parsed('git version 2.39.5 (Apple Git-154)'))).toBe(true);
    expect(meetsGitFloor(parsed('git version 2.32.0.windows.1'))).toBe(true);
    expect(meetsGitFloor(parsed('git version 2.31.8'))).toBe(false);
  });
});

describe('gitVersion', () => {
  it('reports the version of the git on the PATH', () => {
    const real = execFileSync('git', ['--version'], { encoding: 'utf8' });
    const version = gitVersion(syncEnv());
    expect(version).not.toBeNull();
    expect(version).toEqual(parseGitVersion(real));
    expect(version?.major).toBeGreaterThanOrEqual(2);
  });

  it('believes a git shim on the PATH that reports 2.31.8', () => {
    expect(gitVersion(withGitShim(syncEnv(), '2.31.8'))).toEqual(V(2, 31, 8));
    expect(gitVersion(withGitShim(syncEnv(), '2.32.0.windows.1'))).toEqual(V(2, 32, 0));
  });

  it('is null when git cannot be run, without throwing', () => {
    expect(gitVersion(cleanEnv({ PATH: '' }))).toBeNull();
    expect(gitVersion(cleanEnv({ PATH: tempDir() }))).toBeNull();
  });

  it('is null when git prints something that is not a version', () => {
    const dir = join(tempDir(), 'odd-bin');
    mkdirSync(dir);
    writeFileSync(join(dir, 'git'), '#!/bin/sh\necho "not git at all"\n');
    chmodSync(join(dir, 'git'), 0o755);
    expect(gitVersion(cleanEnv({ PATH: dir }))).toBeNull();
  });
});

describe('GIT_IDENTITY', () => {
  it('is the fixed agentboard identity of ADR 0005, shared with sync', () => {
    expect(GIT_IDENTITY).toEqual({ name: 'agentboard', email: 'agentboard@localhost' });
    expect(SYNC_IDENTITY).toEqual(GIT_IDENTITY);
  });

  it('lists the variables that point git elsewhere', () => {
    expect([...GIT_REPOSITORY_VARIABLES].sort()).toEqual(
      [
        'GIT_DIR',
        'GIT_WORK_TREE',
        'GIT_INDEX_FILE',
        'GIT_COMMON_DIR',
        'GIT_OBJECT_DIRECTORY',
        'GIT_ALTERNATE_OBJECT_DIRECTORIES',
        'GIT_NAMESPACE',
        'GIT_PREFIX',
      ].sort(),
    );
  });
});

/** A repository with one commit on `main` and a file ready to be committed. */
function repoWithChange(): string {
  const dir = gitRepo(join(tempDir(), 'repo'));
  writeFileSync(join(dir, 'note.txt'), 'hello\n');
  return dir;
}

/** `git log -1 --format=<format>` of `dir`. */
function log(dir: string, format: string): string {
  return git(dir, 'log', '-1', `--format=${format}`).trim();
}

describe('gitRunner', () => {
  it('runs in its directory and returns stdout', () => {
    const dir = gitRepo(join(tempDir(), 'repo'));
    const runner = gitRunner(dir, { env: syncEnv() });
    expect(runner.dir).toBe(dir);
    expect(runner.run('rev-parse', '--show-toplevel').trim()).toBe(dir);
    expect(runner.run('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
  });

  it('runIn and attemptIn run in another directory', () => {
    const a = gitRepo(join(tempDir(), 'a'));
    const b = gitRepo(join(tempDir(), 'b'));
    const runner = gitRunner(a, { env: syncEnv() });
    expect(runner.runIn(b, 'rev-parse', '--show-toplevel').trim()).toBe(b);
    expect(runner.attemptIn(b, 'rev-parse', '--show-toplevel')).toBe(`${b}\n`);
  });

  it('commits as the fixed identity on a machine with no identity, even when the environment names another', () => {
    const dir = repoWithChange();
    const env: Env = syncEnv({
      GIT_AUTHOR_NAME: 'Someone Else',
      GIT_AUTHOR_EMAIL: 'else@example.invalid',
      GIT_COMMITTER_NAME: 'Someone Else',
      GIT_COMMITTER_EMAIL: 'else@example.invalid',
      EMAIL: 'env@example.invalid',
    });
    const runner = gitRunner(dir, { env });
    runner.run('add', 'note.txt');
    runner.run('commit', '-q', '-m', 'note');
    expect(log(dir, '%an <%ae>|%cn <%ce>')).toBe(
      `${GIT_IDENTITY.name} <${GIT_IDENTITY.email}>|${GIT_IDENTITY.name} <${GIT_IDENTITY.email}>`,
    );
  });

  it('commits as the fixed identity even when the repository configures another', () => {
    const dir = repoWithChange();
    git(dir, 'config', 'user.name', 'Repo User');
    git(dir, 'config', 'user.email', 'repo@example.invalid');
    const runner = gitRunner(dir, { env: syncEnv() });
    runner.run('add', 'note.txt');
    runner.run('commit', '-q', '-m', 'note');
    expect(log(dir, '%an <%ae>')).toBe(`${GIT_IDENTITY.name} <${GIT_IDENTITY.email}>`);
  });

  it('removes the variables that would point git at another repository', () => {
    const dir = gitRepo(join(tempDir(), 'repo'));
    const other = gitRepo(join(tempDir(), 'other'));
    const env: Env = syncEnv({
      GIT_DIR: join(other, '.git'),
      GIT_WORK_TREE: other,
      GIT_INDEX_FILE: join(other, '.git', 'index'),
      GIT_COMMON_DIR: join(other, '.git'),
      GIT_OBJECT_DIRECTORY: join(other, '.git', 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(other, '.git', 'objects'),
      GIT_NAMESPACE: 'ns',
      GIT_PREFIX: 'sub/',
    });
    const runner = gitRunner(dir, { env });
    expect(runner.run('rev-parse', '--show-toplevel').trim()).toBe(dir);
    expect(runner.run('rev-parse', '--absolute-git-dir').trim()).toBe(join(dir, '.git'));
    // Without the runner, the same environment points git at the other repository.
    const raw = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      env: { ...env },
      encoding: 'utf8',
    }).trim();
    expect(raw).toBe(other);
  });

  it('never waits for a credential prompt (GIT_TERMINAL_PROMPT is 0)', () => {
    const dir = gitRepo(join(tempDir(), 'repo'));
    const runner = gitRunner(dir, { env: syncEnv({ GIT_TERMINAL_PROMPT: '1' }) });
    // `git var` does not expose GIT_TERMINAL_PROMPT; a hook that prints it does.
    writeFileSync(join(dir, 'show-env.sh'), '#!/bin/sh\nprintf "%s" "$GIT_TERMINAL_PROMPT"\n');
    chmodSync(join(dir, 'show-env.sh'), 0o755);
    const out = runner.run('-c', `alias.show-env=!${join(dir, 'show-env.sh')}`, 'show-env');
    expect(out).toBe('0');
  });

  it('commits with commit.gpgsign=false even when the repository turns signing on', () => {
    const dir = repoWithChange();
    git(dir, 'config', 'commit.gpgsign', 'true');
    git(dir, 'config', 'gpg.program', join(tempDir(), 'no-such-gpg'));
    const runner = gitRunner(dir, { env: syncEnv() });
    runner.run('add', 'note.txt');
    expect(() => runner.run('commit', '-q', '-m', 'note')).not.toThrow();
    expect(log(dir, '%s')).toBe('note');
    expect(log(dir, '%G?')).toBe('N');
  });

  it('attempt returns the failure instead of throwing; run throws', () => {
    const dir = gitRepo(join(tempDir(), 'repo'));
    const runner = gitRunner(dir, { env: syncEnv() });
    const result = runner.attempt('rev-parse', '--verify', '--quiet', 'refs/heads/nope');
    expect(isGitFailure(result)).toBe(true);
    const failure = result as GitFailure;
    expect(failure.status).toBe(1);
    expect(typeof failure.stdout).toBe('string');
    expect(typeof failure.stderr).toBe('string');
    expect(() => runner.run('rev-parse', '--verify', '--quiet', 'refs/heads/nope')).toThrow();

    const fatal = runner.attempt('cat-file', '-t', 'no-such-object');
    expect(isGitFailure(fatal)).toBe(true);
    expect((fatal as GitFailure).status).toBe(128);
    expect((fatal as GitFailure).stderr).toMatch(/^fatal:/m);
  });

  it('attempt returns stdout as a string on success', () => {
    const dir = gitRepo(join(tempDir(), 'repo'));
    const runner = gitRunner(dir, { env: syncEnv() });
    const result = runner.attempt('rev-parse', '--abbrev-ref', 'HEAD');
    expect(isGitFailure(result)).toBe(false);
    expect(result).toBe('main\n');
  });

  it('attempt reports git not being runnable as a failure with a null status', () => {
    const dir = gitRepo(join(tempDir(), 'repo'));
    const runner = gitRunner(dir, { env: cleanEnv({ PATH: '' }) });
    const result = runner.attempt('--version');
    expect(isGitFailure(result)).toBe(true);
    expect((result as GitFailure).status).toBeNull();
  });
});

describe('isGitFailure and firstErrorLine', () => {
  const failure = (stdout: string, stderr: string, status: number | null = 1): GitFailure => ({
    status,
    stdout,
    stderr,
  });

  it('tells a failure from output', () => {
    expect(isGitFailure('any output')).toBe(false);
    expect(isGitFailure('')).toBe(false);
    expect(isGitFailure(failure('', ''))).toBe(true);
  });

  it('prefers the first fatal: or error: line of stderr', () => {
    expect(
      firstErrorLine(
        failure('ignored\n', 'warning: something\nfatal: could not read from remote\nhint: x\n'),
      ),
    ).toBe('fatal: could not read from remote');
    expect(firstErrorLine(failure('', 'error: failed to push some refs\n'))).toBe(
      'error: failed to push some refs',
    );
  });

  it('falls back to the first non-empty line, then to stdout, then to a fixed text', () => {
    expect(firstErrorLine(failure('', '\n  Permission denied (publickey).  \n'))).toBe(
      'Permission denied (publickey).',
    );
    expect(firstErrorLine(failure('rejected\n', ''))).toBe('rejected');
    expect(firstErrorLine(failure('', '', null))).toBe('git failed');
  });

  it('keeps the line plain ASCII', () => {
    const accented = `caf${String.fromCodePoint(0xe9)} ${String.fromCodePoint(0x2014)} broken`;
    const line = firstErrorLine(failure('', `fatal: ${accented}\n`));
    expect(line).toMatch(/^[\x20-\x7e]+$/);
    expect(line.startsWith('fatal: caf')).toBe(true);
  });
});

/**
 * Installs a hook named `name` in the repository whose git directory is
 * `gitDir` that writes `marker` and exits `status`. Returns the marker path.
 */
function installHook(gitDir: string, name: string, status = 0): string {
  const marker = join(tempDir(), `${name}-ran`);
  const hooks = join(gitDir, 'hooks');
  mkdirSync(hooks, { recursive: true });
  const hook = join(hooks, name);
  writeFileSync(
    hook,
    [
      '#!/bin/sh',
      'cat >/dev/null 2>&1',
      `echo ran > '${marker}'`,
      `exit ${String(status)}`,
      '',
    ].join('\n'),
  );
  chmodSync(hook, 0o755);
  return marker;
}

describe('gitRunner with hooks disabled', () => {
  it('a pre-commit hook of the target repository does not run (and runs by default)', () => {
    const dir = repoWithChange();
    const gitDir = git(dir, 'rev-parse', '--absolute-git-dir').trim();
    const marker = installHook(gitDir, 'pre-commit');

    const disabled = gitRunner(dir, { env: syncEnv(), disableHooks: true });
    disabled.run('add', 'note.txt');
    disabled.run('commit', '-q', '-m', 'without hooks');
    expect(existsSync(marker)).toBe(false);
    expect(log(dir, '%s')).toBe('without hooks');

    writeFileSync(join(dir, 'note.txt'), 'again\n');
    const normal = gitRunner(dir, { env: syncEnv() });
    normal.run('add', 'note.txt');
    normal.run('commit', '-q', '-m', 'with hooks');
    expect(existsSync(marker)).toBe(true);
  });

  it('a failing pre-commit hook cannot stop a commit made with hooks disabled', () => {
    const dir = repoWithChange();
    const gitDir = git(dir, 'rev-parse', '--absolute-git-dir').trim();
    const marker = installHook(gitDir, 'pre-commit', 1);
    const disabled = gitRunner(dir, { env: syncEnv(), disableHooks: true });
    disabled.run('add', 'note.txt');
    expect(() => disabled.run('commit', '-q', '-m', 'note')).not.toThrow();
    expect(existsSync(marker)).toBe(false);
  });

  it("a failing pre-push hook of the host does not run for a push from the board worktree (board-events: 'Host hooks do not run for the board')", () => {
    const env = syncEnv();
    const { root, dir, commit } = hostBoard(env);
    const remote = bareRemote();
    git(root, 'remote', 'add', 'origin', remote);
    const marker = installHook(join(root, '.git'), 'pre-push', 1);

    // By default the host's hook runs for the worktree and rejects the push.
    const normal = gitRunner(dir, { env });
    const refused = normal.attempt('push', '--porcelain', 'origin', 'HEAD:refs/agentboard/board');
    expect(isGitFailure(refused)).toBe(true);
    expect(existsSync(marker)).toBe(true);
    expect(git(remote, 'for-each-ref', 'refs/agentboard/')).toBe('');

    const disabled = gitRunner(dir, { env, disableHooks: true });
    const pushed = disabled.attempt('push', '--porcelain', 'origin', 'HEAD:refs/agentboard/board');
    expect(isGitFailure(pushed)).toBe(false);
    expect(git(remote, 'rev-parse', 'refs/agentboard/board').trim()).toBe(commit);
  });

  it('never writes core.hooksPath into the repository configuration', () => {
    const dir = repoWithChange();
    const runner = gitRunner(dir, { env: syncEnv(), disableHooks: true });
    runner.run('add', 'note.txt');
    runner.run('commit', '-q', '-m', 'note');
    expect(() => git(dir, 'config', '--local', '--get', 'core.hooksPath')).toThrow();
    // And the hooks directory git is pointed at while running is empty.
    const path = runner.run('config', '--get', 'core.hooksPath').trim();
    expect(path).not.toBe('');
    expect(existsSync(path)).toBe(true);
    expect(readdirSync(path)).toEqual([]);
  });
});
