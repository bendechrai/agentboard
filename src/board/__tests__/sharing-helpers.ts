/**
 * Fixtures for the board sharing tests (add-board-sharing): a host-model
 * board built with git plumbing only (`init` of group 2 is not used, so
 * these tests do not depend on it), events committed into it, standalone
 * boards whose `.git` is a file (a separate git directory; a submodule of
 * the host), a `git` shim
 * on the PATH that reports another version and delegates to the real git,
 * a `GIT_SSH_COMMAND` shim that records every call git makes to it, and
 * read-only snapshots of refs, worktrees and directories to prove that a
 * command changed nothing. Every repository is on local disk; nothing
 * touches the network.
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';

import { sha256Hex } from '../../events/canonical.js';
import { putEvent } from '../../store/__tests__/helpers.js';
import { BOARD_GITIGNORE_LINES, initBoard } from '../init.js';
import { git, gitRepo, makeBoardDir, tempDir } from './helpers.js';
import { gitWith, syncEnv, type Env } from './sync-helpers.js';

/** The ref that holds a host-model board's history. */
export const BOARD_REF = 'refs/agentboard/board';

/** The fixed identity and time of the deterministic empty-board commit. */
const EMPTY_COMMIT_ENV: Env = {
  GIT_AUTHOR_NAME: 'agentboard',
  GIT_AUTHOR_EMAIL: 'agentboard@localhost',
  GIT_COMMITTER_NAME: 'agentboard',
  GIT_COMMITTER_EMAIL: 'agentboard@localhost',
  GIT_AUTHOR_DATE: '@0 +0000',
  GIT_COMMITTER_DATE: '@0 +0000',
};

/**
 * A host repository at `<temp>/host` (one commit on `main`) whose committed
 * `.gitignore` lists `.board/`, so a board worktree never dirties it.
 */
export function hostRepo(root = join(tempDir(), 'host')): string {
  gitRepo(root);
  writeFileSync(join(root, '.gitignore'), '.board/\n');
  git(root, 'add', '.gitignore');
  git(root, 'commit', '-q', '-m', 'ignore the board');
  return root;
}

/**
 * The deterministic empty-board commit (board-events "Board ref in the
 * host repository") written into the repository at `repo` with plumbing
 * only: blobs for `.gitignore` (`BOARD_GITIGNORE_LINES`) and
 * `events/.gitkeep`, two `mktree`s and one `commit-tree` as
 * `agentboard <agentboard@localhost>` at time 0 with the message
 * `agentboard: empty board`. Returns the commit id.
 */
export function emptyBoardCommit(repo: string, env: Env = syncEnv()): string {
  const run = (...args: string[]): string =>
    gitWith(repo, { ...env, ...EMPTY_COMMIT_ENV }, ...args).trim();
  const ignore = BOARD_GITIGNORE_LINES.map((line) => `${line}\n`).join('');
  const ignoreBlob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: repo,
    env: { ...env },
    input: ignore,
    encoding: 'utf8',
  }).trim();
  const keepBlob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: repo,
    env: { ...env },
    input: '',
    encoding: 'utf8',
  }).trim();
  const eventsTree = execFileSync('git', ['mktree'], {
    cwd: repo,
    env: { ...env },
    input: `100644 blob ${keepBlob}\t.gitkeep\n`,
    encoding: 'utf8',
  }).trim();
  const rootTree = execFileSync('git', ['mktree'], {
    cwd: repo,
    env: { ...env },
    input: `100644 blob ${ignoreBlob}\t.gitignore\n040000 tree ${eventsTree}\tevents\n`,
    encoding: 'utf8',
  }).trim();
  return run('commit-tree', rootTree, '-m', 'agentboard: empty board');
}

/**
 * A host-model board (add-board-sharing design.md, decisions 1 and 2) at
 * `<root>/.board`, built with plumbing: the empty-board commit under
 * `refs/agentboard/board`, a linked worktree on a detached HEAD at that
 * ref, locked with the reason `agentboard board`. `root` defaults to a
 * fresh `hostRepo()`. Returns the host root, the board directory and the
 * commit of the ref.
 */
export function hostBoard(
  env: Env = syncEnv(),
  root: string = hostRepo(),
): { root: string; dir: string; commit: string } {
  const commit = emptyBoardCommit(root, env);
  git(root, 'update-ref', BOARD_REF, commit, '');
  const dir = join(root, '.board');
  git(root, 'worktree', 'add', '-q', '--detach', dir, BOARD_REF);
  git(root, 'worktree', 'lock', '--reason', 'agentboard board', dir);
  return { root, dir, commit };
}

/**
 * A standalone board whose `.git` is a file (board-events "Board model
 * detection": standalone whether `.git` is a directory or a file): the
 * working tree at `<root>/.board`, made with
 * `git init --separate-git-dir <temp>/board-git`, holding `.gitignore` and
 * `events/.gitkeep` as `init` writes them, nothing committed, on the unborn
 * branch `main`. `root` may be a git repository. Returns the board
 * directory and the separate git directory the `.git` file names.
 */
export function separateGitDirBoard(root = tempDir()): { dir: string; gitDir: string } {
  const dir = makeBoardDir(root);
  const gitDir = join(tempDir(), 'board-git');
  git(root, 'init', '-q', '--separate-git-dir', gitDir, dir);
  writeFileSync(join(dir, '.gitignore'), BOARD_GITIGNORE_LINES.map((line) => `${line}\n`).join(''));
  writeFileSync(join(dir, 'events', '.gitkeep'), '');
  return { dir, gitDir };
}

/**
 * A submodule-style board: a standalone board repository (one commit with
 * `.gitignore` and `events/.gitkeep`) added to a fresh `hostRepo()` as the
 * submodule `.board` with `git submodule add --force`, so `.board/.git` is
 * a file naming `<host>/.git/modules/.board`, the host's index holds
 * `.board` as a gitlink and `.gitmodules`, and the board's `origin` is the
 * source repository with `main` tracking it. Returns the host root, the
 * board directory, the git directory the `.git` file names and the source
 * repository.
 */
export function submoduleBoard(env: Env = syncEnv()): {
  host: string;
  dir: string;
  gitDir: string;
  source: string;
} {
  const source = initBoard({ cwd: tempDir(), env }).dir;
  git(source, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(source, 'add', '-A');
  git(source, 'commit', '-q', '-m', 'board');
  const host = hostRepo();
  git(host, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--force', '-q', source, '.board');
  return {
    host,
    dir: join(host, '.board'),
    gitDir: join(host, '.git', 'modules', '.board'),
    source,
  };
}

/**
 * Writes `event` as an event file of the host-model board at `dir`,
 * commits it there (fixed identity, hooks skipped) and moves
 * `refs/agentboard/board` to the new HEAD, as a completed `sync` leaves
 * them. Returns the event hash.
 */
export function commitHostEvent(dir: string, event: unknown, env: Env = syncEnv()): string {
  const hash = putEvent(join(dir, 'events'), event);
  const run = (...args: string[]): string =>
    gitWith(dir, { ...env, ...EMPTY_COMMIT_ENV }, ...args).trim();
  run('add', '--', 'events');
  run('commit', '-q', '--no-verify', '-m', 'agentboard sync: 1 event file');
  run('update-ref', BOARD_REF, run('rev-parse', 'HEAD'));
  return hash;
}

/** The absolute path of the real `git` on the current PATH. */
export function realGit(): string {
  return execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
}

/**
 * A directory holding a `git` shim that answers `git --version` with
 * `git version <version>` and delegates every other invocation to the real
 * git (tasks.md: tests that simulate an older git use a shim on PATH).
 * Prepend it to `PATH`.
 */
export function gitShim(version: string): string {
  const dir = join(tempDir(), 'shim-bin');
  mkdirSync(dir);
  const script = join(dir, 'git');
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then',
      `  echo "git version ${version}"`,
      '  exit 0',
      'fi',
      `exec '${realGit()}' "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(script, 0o755);
  return dir;
}

/** `env` with `gitShim(version)` first on its PATH. */
export function withGitShim(env: Env, version: string): Env {
  return { ...env, PATH: `${gitShim(version)}:${env.PATH ?? process.env.PATH ?? ''}` };
}

/**
 * A `GIT_SSH_COMMAND` shim that appends one line with its arguments to
 * `log` on every call and exits 255 without connecting anywhere. A remote
 * whose URL is `ssh://` (or `host:path`) makes git run it for any network
 * operation, so an empty (or missing) log proves that no such operation
 * was attempted.
 */
export function sshShim(): { command: string; log: string; calls: () => string[] } {
  const dir = tempDir();
  const log = join(dir, 'ssh-calls.log');
  const script = join(dir, 'ssh-shim');
  writeFileSync(script, ['#!/bin/sh', `echo "$@" >> '${log}'`, 'exit 255', ''].join('\n'));
  chmodSync(script, 0o755);
  return {
    command: script,
    log,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []),
  };
}

/** An SSH URL that resolves to nothing; with `sshShim`, git never gets past the shim. */
export const SSH_URL = 'git@example.invalid:me/project.git';

/** Every ref of the repository at `repo` with its target, as one text. */
export function refs(repo: string): string {
  return git(repo, 'for-each-ref', '--format=%(refname) %(objectname)');
}

/** `git worktree list --porcelain` of the repository at `repo`. */
export function worktrees(repo: string): string {
  return git(repo, 'worktree', 'list', '--porcelain');
}

/**
 * Every file under `dir` (recursively, symlinks followed, the SQLite cache
 * and its companions left out because opening a board creates them) as
 * `<relative path> <sha256>` lines, sorted.
 */
export function snapshotDir(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      if (name.startsWith('cache.sqlite')) {
        continue;
      }
      const path = join(current, name);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else {
        out.push(`${relative(dir, path)} ${sha256Hex(readFileSync(path))}`);
      }
    }
  };
  walk(dir);
  return out.sort();
}

/** `realpathSync(path)`. */
export function real(path: string): string {
  return realpathSync(path);
}
