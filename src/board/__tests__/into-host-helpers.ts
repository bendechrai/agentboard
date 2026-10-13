/**
 * Fixtures for the `init --into-host` tests (add-board-sharing group 5):
 * a project (a git host with a bare `origin`), a standalone board inside
 * it that is fully synced with its own bare board remote (built with
 * plumbing, `putEvent` and the standalone `syncBoard`, never with
 * `init --into-host`), a second clone of the project whose `.board` is a
 * clone of that board remote, read-only snapshots proving a refusal
 * changed nothing, and the assertions a completed move must satisfy (a
 * locked host-model worktree at `refs/agentboard/board`, one kept
 * repository, no temporary ref or worktree). Every repository is on local
 * disk; nothing touches the network.
 */

import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect } from 'vitest';

import { openBoard } from '../../store/board.js';
import { P, T1, ev, putEvent } from '../../store/__tests__/helpers.js';
import { AGENTBOARD_GIT_SUBDIR } from '../host-init.js';
import { MIGRATING_DIR, MIGRATING_REF, STANDALONE_KEPT_PREFIX } from '../into-host.js';
import { detectBoardModel } from '../model.js';
import { syncBoard } from '../sync.js';
import { git, gitRepo, tempDir } from './helpers.js';
import {
  BOARD_REF,
  cloneHost,
  hostRepo,
  refCommit,
  refs,
  snapshotDir,
  standaloneBoard,
  worktreeEntry,
  worktrees,
} from './sharing-helpers.js';
import { bareRemote, revParse, treeEvents, type Env } from './sync-helpers.js';

/** The event file name pattern. */
export const EVENT_FILE = /^[0-9a-f]{64}\.json$/;

/** Event file names in `<dir>/events`, sorted. */
export function eventFiles(dir: string): string[] {
  return readdirSync(join(dir, 'events'))
    .filter((name) => EVENT_FILE.test(name))
    .sort();
}

/** The event file names in the tree of `ref` of `repo`, sorted. */
export function refEvents(repo: string, ref: string = BOARD_REF): string[] {
  return treeEvents(repo, ref).sort();
}

/**
 * A project: a git host at `<temp>/<name>` (one commit on `main`, whose
 * committed `.gitignore` lists `.board/`) that has pushed `main` to a
 * fresh bare `origin`. Returns the host root and the bare remote.
 */
export function project(name = 'a'): { root: string; remote: string } {
  const remote = bareRemote();
  const root = hostRepo(join(tempDir(), name));
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', 'origin', 'main');
  return { root, remote };
}

/** A clone of the project at `remote`, at `<temp>/<name>`, tracking `origin/main`. */
export function cloneProject(remote: string, name: string): string {
  return cloneHost(remote, name);
}

/**
 * Writes `n` events into `<dir>/events`: the ticket `T1` (when `from` is
 * 0) and comments on it, distinct per `actor` and index; returns the
 * hashes. `from` offsets the comment numbers so two boards never write
 * the same comment.
 */
export function writeEvents(dir: string, n: number, actor = 'orch', from = 0): string[] {
  const hashes: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const k = from + i;
    const event =
      k === 0
        ? ev(P.create(T1, 'Shared ticket'), actor, 1_000)
        : ev(P.comment(T1, `${actor} comment ${String(k)}`), actor, 10_000 + k);
    hashes.push(putEvent(join(dir, 'events'), event));
  }
  return hashes;
}

/** The standalone `sync` on the board at `dir`, in process; the board is closed afterwards. */
export function syncStandalone(dir: string, env: Env): void {
  const board = openBoard(dir);
  try {
    const result = syncBoard(board, { env });
    expect(result.model).toBe('standalone');
  } finally {
    board.close();
  }
}

/**
 * A standalone board at `<root>/.board` (built without `init`, on the
 * branch `main`) holding `events` event files committed with the
 * standalone `sync`. With `remote` (a bare repository), `origin` is set to
 * it first, so the sync pushes and the board is fully synced; without one
 * the sync only commits. `actor` writes the events (two boards built with
 * different actors share no event file). Returns the board directory and
 * the tip of `main`.
 */
export function syncedStandalone(
  root: string,
  env: Env,
  events: number,
  remote?: string,
  actor = 'orch',
): { dir: string; tip: string } {
  const dir = standaloneBoard(root);
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  if (remote !== undefined) {
    git(dir, 'remote', 'add', 'origin', remote);
  }
  writeEvents(dir, events, actor);
  syncStandalone(dir, env);
  return { dir, tip: revParse(dir) };
}

/**
 * The common fixture: a project with a bare `origin`, a standalone board
 * in it with `events` committed events, fully synced with its own bare
 * board remote. Returns the host root, its `origin`, the board directory,
 * the board remote and the tip of the board's `main`.
 */
export function standaloneProject(
  env: Env,
  events = 3,
  name = 'a',
): { root: string; remote: string; dir: string; boardRemote: string; tip: string } {
  const { root, remote } = project(name);
  const boardRemote = bareRemote();
  const { dir, tip } = syncedStandalone(root, env, events, boardRemote);
  return { root, remote, dir, boardRemote, tip };
}

/**
 * A second clone of the project at `remote`, at `<temp>/<name>`, whose
 * `.board` is a `git clone` of `boardRemote` (the standalone board shared
 * through it, on `main` tracking `origin/main`). Returns the clone's root
 * and board directory.
 */
export function cloneWithStandalone(
  remote: string,
  boardRemote: string,
  name: string,
): { root: string; dir: string } {
  const root = cloneProject(remote, name);
  const dir = join(root, '.board');
  git(root, 'clone', '-q', boardRemote, dir);
  return { root, dir };
}

/** `<root>/.git/agentboard`, where the move keeps its temporary and kept directories. */
export function agentboardDir(root: string): string {
  return join(root, '.git', AGENTBOARD_GIT_SUBDIR);
}

/** The kept repositories (`standalone-*`) under `<root>/.git/agentboard`, by name. */
export function keptRepositories(root: string): string[] {
  const dir = agentboardDir(root);
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.startsWith(STANDALONE_KEPT_PREFIX))
        .sort()
        .map((name) => join(dir, name))
    : [];
}

/** The entries of `<root>/.git/agentboard/migrating`, by name; empty when the directory is missing. */
export function migratingEntries(root: string): string[] {
  const dir = join(agentboardDir(root), MIGRATING_DIR);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/** What a refusal must leave as it was: the board directory, the host's refs and worktrees, and whether `<git common dir>/agentboard` exists. */
export interface Untouched {
  readonly board: string[];
  readonly refs: string;
  readonly worktrees: string;
  readonly agentboardDir: boolean;
  readonly status: string;
}

/** A snapshot of `Untouched` for the host `root` and board `dir`. */
export function untouched(root: string, dir: string): Untouched {
  return {
    board: existsSync(dir) ? snapshotDir(dir) : [],
    refs: refs(root),
    worktrees: worktrees(root),
    agentboardDir: existsSync(agentboardDir(root)),
    status: git(root, 'status', '--porcelain'),
  };
}

/** Asserts the state of `root` and `dir` equals `before`, and that no ref under `refs/agentboard/` exists unless it did. */
export function expectUntouched(root: string, dir: string, before: Untouched, label = ''): void {
  expect(untouched(root, dir), label).toEqual(before);
  if (!before.refs.includes('refs/agentboard/')) {
    expect(git(root, 'for-each-ref', '--format=%(refname)', 'refs/agentboard/'), label).toBe('');
  }
}

/**
 * Asserts `<root>/.board` is a complete host-model board after a move:
 * model `host`, one registered worktree at `.board`, locked with the
 * reason `agentboard board` on a detached HEAD equal to
 * `refs/agentboard/board`, exactly `kept` kept repositories, no
 * `refs/agentboard/migrating`, nothing under `agentboard/migrating`, no
 * worktree registered there, and the host's working tree clean.
 */
export function expectMoved(root: string, env: Env, kept = 1, label = ''): void {
  const dir = join(root, '.board');
  expect(detectBoardModel(dir, { env }).model, label).toBe('host');
  const entry = worktreeEntry(root, dir);
  expect(entry?.locked, label).toBe('agentboard board');
  expect(entry?.detached, label).toBe(true);
  expect(refCommit(root), label).toMatch(/^[0-9a-f]{40}$/);
  expect(revParse(dir), label).toBe(refCommit(root));
  expect(git(root, 'for-each-ref', '--format=%(refname)', 'refs/agentboard/'), label).toBe(
    `${BOARD_REF}\n`,
  );
  expect(refCommit(root, MIGRATING_REF), label).toBeNull();
  expect(keptRepositories(root), label).toHaveLength(kept);
  expect(migratingEntries(root), label).toEqual([]);
  const paths = worktrees(root)
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
  expect(paths.filter((path) => path.includes(`/${MIGRATING_DIR}/`)), label).toEqual([]);
  expect(paths.filter((path) => path.endsWith('/.board')), label).toHaveLength(1);
  expect(git(root, 'status', '--porcelain'), label).toBe('');
}

/** Asserts the kept repository at `kept` is the old standalone board, untouched: a repository of its own at `tip` holding `files`. */
export function expectKept(kept: string, tip: string, files: readonly string[], label = ''): void {
  expect(existsSync(join(kept, '.git')), label).toBe(true);
  expect(revParse(kept), label).toBe(tip);
  expect(git(kept, 'symbolic-ref', '--short', 'HEAD').trim(), label).toBe('main');
  expect(eventFiles(kept), label).toEqual([...files].sort());
}

/** A fresh host that is a git repository without any `.gitignore`, at `<temp>/<name>`. */
export function bareHost(name = 'proj'): string {
  return gitRepo(join(tempDir(), name));
}

/** Appends `line` to `<dir>/.gitignore` and commits it in the repository at `dir` (a standalone board or a host worktree). */
export function commitIgnoreLine(dir: string, line: string): string {
  writeFileSync(join(dir, '.gitignore'), `${line}\n`, { flag: 'a' });
  git(dir, 'add', '--', '.gitignore');
  git(dir, 'commit', '-q', '--no-verify', '-m', `ignore ${line}`);
  return revParse(dir);
}
