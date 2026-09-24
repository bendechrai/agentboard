/**
 * Fixtures for the sync tests: a git environment with no identity and a
 * fixed default branch, temporary bare remotes on local disk, boards that
 * are git repositories (machine A via `initBoard`, machine B via
 * `git clone`) and read-only git inspection. Every remote is a bare
 * repository in a temporary directory; nothing touches the network.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { initBoard } from '../init.js';
import { cleanEnv, git, tempDir } from './helpers.js';

export type Env = Record<string, string | undefined>;

/**
 * The environment sync runs with in these tests: `cleanEnv` plus a private
 * HOME and global git config holding only `init.defaultBranch=main`, no
 * system config and no identity variables, so a sync that relied on the
 * user's git identity would fail (or record the wrong author).
 */
export function syncEnv(extra: Env = {}): Env {
  const home = tempDir();
  const config = join(home, 'gitconfig');
  writeFileSync(config, '[init]\n\tdefaultBranch = main\n');
  return cleanEnv({
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: '1',
    EMAIL: undefined,
    GIT_AUTHOR_NAME: undefined,
    GIT_AUTHOR_EMAIL: undefined,
    GIT_COMMITTER_NAME: undefined,
    GIT_COMMITTER_EMAIL: undefined,
    AGENTBOARD_DIR: undefined,
    AGENTBOARD_ACTOR: undefined,
    ...extra,
  });
}

/** A fresh, empty bare repository on local disk whose HEAD is `main`. */
export function bareRemote(): string {
  const dir = join(tempDir(), 'remote.git');
  git(tempDir(), 'init', '-q', '--bare', '-b', 'main', dir);
  return dir;
}

/**
 * Machine A: a host directory (not a git repository) with a board created
 * by `initBoard`, on branch `main`, with `origin` pointing at `remote` when
 * given. Nothing is committed. Returns the host root and the board dir.
 */
export function initMachine(env: Env, remote?: string): { root: string; dir: string } {
  const root = tempDir();
  const { dir } = initBoard({ cwd: root, env });
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  if (remote !== undefined) {
    git(dir, 'remote', 'add', 'origin', remote);
  }
  return { root, dir };
}

/**
 * Machine B: a host directory whose `.board` is a `git clone` of `remote`
 * (which must already hold the board's first commit). Returns the host
 * root and the board dir.
 */
export function cloneMachine(remote: string): { root: string; dir: string } {
  const root = tempDir();
  const dir = join(root, '.board');
  git(root, 'clone', '-q', remote, dir);
  if (!existsSync(join(dir, 'events'))) {
    mkdirSync(join(dir, 'events'));
  }
  return { root, dir };
}

/** Lines of git's output, without empty ones. */
export function lines(text: string): string[] {
  return text.split('\n').filter((line) => line !== '');
}

/** Every path in the tree of `rev` (default HEAD) of the repository at `dir`. */
export function treePaths(dir: string, rev = 'HEAD'): string[] {
  return lines(git(dir, 'ls-tree', '-r', '--name-only', rev)).sort();
}

/** The event file names (`<hash>.json`) in the tree of `rev`. */
export function treeEvents(dir: string, rev = 'HEAD'): string[] {
  return treePaths(dir, rev)
    .filter((path) => /^events\/[0-9a-f]{64}\.json$/.test(path))
    .map((path) => path.slice('events/'.length));
}

/** `git rev-parse <rev>` in `dir`. */
export function revParse(dir: string, rev = 'HEAD'): string {
  return git(dir, 'rev-parse', rev).trim();
}

/** Number of commits reachable from HEAD, or 0 on an unborn branch. */
export function commitCount(dir: string): number {
  try {
    return Number(git(dir, 'rev-list', '--count', 'HEAD').trim());
  } catch {
    return 0;
  }
}

/** Paths git reports as unmerged in `dir`. */
export function unmerged(dir: string): string[] {
  return lines(git(dir, 'diff', '--name-only', '--diff-filter=U')).sort();
}

/** True when a rebase is stopped in the repository at `dir`. */
export function rebaseInProgress(dir: string): boolean {
  const gitDir = git(dir, 'rev-parse', '--absolute-git-dir').trim();
  return existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'));
}

/** Runs git with an explicit environment (no identity added). */
export function gitWith(dir: string, env: Env, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    env: { ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
