/**
 * Joining and repairing a host-model board in process (add-board-sharing
 * tasks 2.2 and 2.3; board-cli "Initialising and joining a shared board";
 * add-board-sharing design.md decision 7): `init` joining the board from
 * the remote, creating a new one when the remote has none or cannot be
 * reached, re-creating a deleted board directory from the local ref,
 * repairing a moved host in place, rebuilding a stale copy in a fresh
 * clone while carrying every event file over (and skipping one whose
 * content does not match its name), and the plumbing API of
 * `src/board/host-init.ts`. Clone A's repository is proved unchanged after
 * every repair. Every remote is a bare repository on local disk; an SSH
 * shim proves when no network operation was attempted.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { spawnSync } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import { P, T1, ev, putEvent } from '../../store/__tests__/helpers.js';
import { gitRunner } from '../git.js';
import {
  AGENTBOARD_GIT_SUBDIR,
  EMPTY_BOARD_COMMIT_MESSAGE,
  INIT_LOCK_FILE,
  REPAIRING_WORKTREE,
  STALE_BOARD_PREFIX,
  STALE_LOCK_MS,
  WORKTREE_LOCK_REASON,
  addBoardWorktree,
  adoptRepairingWorktree,
  ensureBoardRef,
  removeLeftoverWorktree,
  repairBoardLink,
  staleBoardName,
  withInitLock,
  writeEmptyBoardCommit,
} from '../host-init.js';
import { initBoard } from '../init.js';
import { detectBoardModel } from '../model.js';
import { listTickets } from '../tickets.js';
import { git, openTracked, tempDir } from './helpers.js';
import {
  BOARD_REF,
  EMPTY_BOARD_COMMIT_ID,
  SSH_URL,
  cloneHost,
  commitHostEvent,
  emptyBoardCommit,
  hostBoard,
  hostRepo,
  pushBoardRef,
  real,
  refCommit,
  refs,
  rootCommit,
  snapshotDir,
  sshShim,
  withGitShimBefore,
  worktreeEntries,
  worktreeEntry,
  worktrees,
} from './sharing-helpers.js';
import { bareRemote, revParse, syncEnv, type Env } from './sync-helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const HEX40 = /^[0-9a-f]{40}$/;
const EVENT_FILE = /^[0-9a-f]{64}\.json$/;

/** Event file names (`<hash>.json`) in `<dir>/events`, sorted. */
function eventFiles(dir: string): string[] {
  return readdirSync(join(dir, 'events'))
    .filter((name) => EVENT_FILE.test(name))
    .sort();
}

/** The keys of `RepairOutcome`, sorted. */
const REPAIR_KEYS = ['copied', 'keptAt', 'method', 'skipped', 'source'];

/**
 * Clone A with a host-model board holding `committed` committed events
 * (one `ticket.create` and comments on it), its `main` and board ref
 * pushed to a bare `origin`. Returns A's root and board, the remote and
 * the committed event hashes.
 */
function publishedBoard(
  env: Env,
  committed = 1,
): { root: string; dir: string; remote: string; hashes: string[] } {
  const remote = bareRemote();
  const { root, dir } = hostBoard(env);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', 'origin', 'main');
  const hashes = [commitHostEvent(dir, ev(P.create(T1, 'Shared'), 'orch', 1000), env)];
  for (let i = 1; i < committed; i += 1) {
    hashes.push(commitHostEvent(dir, ev(P.comment(T1, `c${String(i)}`), 'orch', 1000 + i), env));
  }
  pushBoardRef(root);
  return { root, dir, remote, hashes };
}

/** The entries of `<root>/.git/agentboard/` (kept-aside boards, temporary worktrees), sorted. */
function keptEntries(root: string): string[] {
  const dir = join(root, '.git', AGENTBOARD_GIT_SUBDIR);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/** Asserts `<root>/.board` is a healthy, locked host-model board of `root` at its ref. */
function expectHealthy(root: string, env: Env): void {
  const dir = join(root, '.board');
  const info = detectBoardModel(dir, { env });
  expect(info.model).toBe('host');
  expect(info.gitDir).toBe(real(join(root, '.git')));
  expect(refCommit(root)).toMatch(HEX40);
  expect(revParse(dir)).toBe(refCommit(root));
  const entry = worktreeEntry(root, dir);
  expect(entry?.detached).toBe(true);
  expect(entry?.locked).toBe(WORKTREE_LOCK_REASON);
  expect(entry?.prunable).toBe(false);
}

describe('constants', () => {
  it('name the lock reason, the commit message and the repair paths as the spec does', () => {
    expect(WORKTREE_LOCK_REASON).toBe('agentboard board');
    expect(EMPTY_BOARD_COMMIT_MESSAGE).toBe('agentboard: empty board');
    expect(AGENTBOARD_GIT_SUBDIR).toBe('agentboard');
    expect(REPAIRING_WORKTREE).toBe('repairing');
    expect(STALE_BOARD_PREFIX).toBe('stale-board-');
  });
});

describe('staleBoardName', () => {
  it('is stale-board- followed by the UTC time as YYYYMMDDTHHMMSSZ', () => {
    expect(staleBoardName(new Date(Date.UTC(2026, 9, 12, 15, 30, 0)))).toBe(
      'stale-board-20261012T153000Z',
    );
    expect(staleBoardName(new Date(Date.UTC(2001, 0, 2, 3, 4, 5, 678)))).toBe(
      'stale-board-20010102T030405Z',
    );
    expect(staleBoardName(new Date(0))).toBe('stale-board-19700101T000000Z');
  });
});

describe('writeEmptyBoardCommit', () => {
  it('writes the deterministic commit into the object store and creates no ref', () => {
    const env = syncEnv();
    const root = hostRepo();
    const before = refs(root);

    const commit = writeEmptyBoardCommit(root, { env });

    expect(commit).toBe(EMPTY_BOARD_COMMIT_ID);
    expect(refs(root)).toBe(before);
    expect(git(root, 'cat-file', '-t', commit).trim()).toBe('commit');
    expect(git(root, 'log', '-1', '--format=%s%n%an <%ae> %at%n%cn <%ce> %ct', commit)).toBe(
      `${EMPTY_BOARD_COMMIT_MESSAGE}\nagentboard <agentboard@localhost> 0\nagentboard <agentboard@localhost> 0\n`,
    );
    // Again: the same objects, the same id.
    expect(writeEmptyBoardCommit(root, { env })).toBe(commit);
    expect(refs(root)).toBe(before);
  });
});

describe('ensureBoardRef', () => {
  it('creates the ref from a new empty board when there is no remote, and finds it next time', () => {
    const env = syncEnv();
    const root = hostRepo();

    const first = ensureBoardRef(root, null, { env });
    expect(first).toEqual({ commit: EMPTY_BOARD_COMMIT_ID, source: 'created', warnings: [] });
    expect(refCommit(root)).toBe(EMPTY_BOARD_COMMIT_ID);

    const again = ensureBoardRef(root, null, { env });
    expect(again).toEqual({ commit: EMPTY_BOARD_COMMIT_ID, source: 'local', warnings: [] });
    // Only the board ref under refs/agentboard/, no branch or tag.
    expect(git(root, 'for-each-ref', '--format=%(refname)', 'refs/agentboard/')).toBe(
      `${BOARD_REF}\n`,
    );
    expect(git(root, 'for-each-ref', '--format=%(refname)', 'refs/heads/')).toBe(
      'refs/heads/main\n',
    );
    expect(git(root, 'tag')).toBe('');
  });

  it('fetches the remote board into the local ref without tags or a remote-tracking ref', () => {
    const env = syncEnv();
    const a = publishedBoard(env, 2);
    git(a.root, 'tag', 'v1');
    git(a.root, 'push', '-q', 'origin', 'v1');
    const b = cloneHost(a.remote, 'b');
    git(b, 'tag', '-d', 'v1');

    const outcome = ensureBoardRef(b, 'origin', { env });

    expect(outcome).toEqual({ commit: refCommit(a.root), source: 'remote', warnings: [] });
    expect(refCommit(b)).toBe(refCommit(a.root));
    expect(git(b, 'tag')).toBe('');
    expect(git(b, 'for-each-ref', '--format=%(refname)', 'refs/remotes/')).not.toMatch(/agentboard/);
  });

  it('uses an existing local ref and never contacts the remote', () => {
    const env = syncEnv();
    const { root, dir } = hostBoard(env);
    const local = commitHostEvent(dir, ev(P.create(T1, 'Local'), 'orch', 1000), env);
    expect(local).toMatch(/^[0-9a-f]{64}$/);
    const ssh = sshShim();
    git(root, 'remote', 'add', 'origin', SSH_URL);

    const outcome = ensureBoardRef(root, 'origin', { env: { ...env, GIT_SSH_COMMAND: ssh.command } });

    expect(outcome).toEqual({ commit: revParse(dir), source: 'local', warnings: [] });
    expect(ssh.calls()).toEqual([]);
  });

  it('creates a new empty board with a warning when the remote cannot be reached', () => {
    const env = syncEnv();
    const root = hostRepo();
    git(root, 'remote', 'add', 'origin', join(tempDir(), 'missing.git'));

    const outcome = ensureBoardRef(root, 'origin', { env });

    expect(outcome.commit).toBe(EMPTY_BOARD_COMMIT_ID);
    expect(outcome.source).toBe('created');
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.warnings[0]).toContain('origin');
    expect(outcome.warnings[0]).toMatch(/agentboard sync/);
    expect(outcome.warnings[0]).toMatch(/^[\x20-\x7e]+$/);
  });

  it('creates a new empty board when the remote has no board, without pushing', () => {
    const env = syncEnv();
    const remote = bareRemote();
    const a = hostRepo();
    git(a, 'remote', 'add', 'origin', remote);
    git(a, 'push', '-q', 'origin', 'main');
    const b = cloneHost(remote, 'b');

    expect(ensureBoardRef(b, 'origin', { env })).toEqual({
      commit: EMPTY_BOARD_COMMIT_ID,
      source: 'created',
      warnings: [],
    });
    expect(git(remote, 'for-each-ref', 'refs/agentboard/')).toBe('');
  });
});

describe('addBoardWorktree', () => {
  it('adds a detached, locked worktree at the ref, and is idempotent', () => {
    const env = syncEnv();
    const root = hostRepo();
    const dir = join(root, '.board');
    ensureBoardRef(root, null, { env });

    addBoardWorktree(root, dir, { env });
    const after = worktrees(root);
    addBoardWorktree(root, dir, { env });

    expect(worktrees(root)).toBe(after);
    expect(existsSync(join(dir, 'events', '.gitkeep'))).toBe(true);
    expectHealthy(root, env);
  });

  it('re-adds a deleted but still registered worktree, locked or already pruned', () => {
    const env = syncEnv();
    for (const prune of [false, true]) {
      const { root, dir } = hostBoard(env);
      const hash = commitHostEvent(dir, ev(P.create(T1, 'Kept'), 'orch', 1000), env);
      rmSync(dir, { recursive: true });
      if (prune) {
        // A locked worktree is never pruned (scenario "Worktree cleanup
        // leaves the board alone"), so unlock it first to reach the pruned state.
        git(root, 'worktree', 'unlock', dir);
        git(root, 'worktree', 'prune');
        expect(worktreeEntry(root, dir)).toBeNull();
      } else {
        expect(worktreeEntry(root, dir)).not.toBeNull();
      }

      addBoardWorktree(root, dir, { env });

      expect(eventFiles(dir)).toEqual([`${hash}.json`]);
      expectHealthy(root, env);
    }
  });

  it('never forces a registered worktree at another path', () => {
    const env = syncEnv();
    const { root } = hostBoard(env);
    const elsewhere = join(tempDir(), 'elsewhere');
    git(root, 'worktree', 'add', '-q', '--detach', elsewhere, BOARD_REF);
    rmSync(elsewhere, { recursive: true });
    const other = join(root, 'other-board');

    addBoardWorktree(root, other, { env });

    // The missing worktree is still registered (not replaced), the new one was added normally.
    expect(worktreeEntry(root, elsewhere)).not.toBeNull();
    expect(worktreeEntry(root, other)?.locked).toBe(WORKTREE_LOCK_REASON);
  });
});

describe('scenario: init joins the board from the remote', () => {
  it("fetches A's ref, checks it out, folds the events and reports joined, origin and five events", () => {
    const env = syncEnv();
    const a = publishedBoard(env, 5);
    const b = cloneHost(a.remote, 'b');
    const bDir = join(b, '.board');

    const result = initBoard({ cwd: b, env });

    expect(result).toMatchObject({
      dir: bDir,
      created: true,
      model: 'host',
      joined: true,
      remote: 'origin',
      events: 5,
      hostGitignore: null,
      warnings: [],
      repair: null,
    });
    expect(result.message).toContain('5');
    expect(result.message).toContain('origin');
    expect(refCommit(b)).toBe(refCommit(a.root));
    expect(revParse(bDir)).toBe(refCommit(a.root));
    expect(eventFiles(bDir)).toEqual(a.hashes.map((h) => `${h}.json`).sort());
    expectHealthy(b, env);
    // list shows A's ticket without a sync: the cache was caught up by init.
    expect(existsSync(join(bDir, 'cache.sqlite'))).toBe(true);
    const tickets = listTickets(openTracked(bDir));
    expect(tickets.map((t) => t.id)).toEqual([T1]);
    expect(tickets[0]?.title).toBe('Shared');
    // Nothing was pushed, no branch or tag added anywhere.
    expect(git(a.remote, 'for-each-ref', '--format=%(refname)')).toBe(
      `${BOARD_REF}\nrefs/heads/main\n`,
    );
    expect(git(b, 'for-each-ref', '--format=%(refname)', 'refs/heads/')).toBe(
      'refs/heads/main\n',
    );
    expect(git(b, 'status', '--porcelain')).toBe('');
  });

  it('scenario: init where the remote has no board creates a new empty board and pushes nothing', () => {
    const env = syncEnv();
    const remote = bareRemote();
    const a = hostRepo();
    git(a, 'remote', 'add', 'origin', remote);
    git(a, 'push', '-q', 'origin', 'main');
    const b = cloneHost(remote, 'b');

    const result = initBoard({ cwd: b, env });

    expect(result).toMatchObject({
      created: true,
      model: 'host',
      joined: false,
      remote: 'origin',
      events: 0,
      warnings: [],
    });
    expect(refCommit(b)).toBe(EMPTY_BOARD_COMMIT_ID);
    expect(git(remote, 'for-each-ref', 'refs/agentboard/')).toBe('');
    expectHealthy(b, env);
  });

  it('scenario: init with an unreachable remote creates a new empty board and warns, naming origin', () => {
    const env = syncEnv();
    const root = hostRepo();
    git(root, 'remote', 'add', 'origin', join(tempDir(), 'gone.git'));

    const result = initBoard({ cwd: root, env });

    expect(result).toMatchObject({
      created: true,
      model: 'host',
      joined: false,
      remote: 'origin',
      events: 0,
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('origin');
    expect(result.warnings[0]).toMatch(/sync/);
    expect(refCommit(root)).toBe(EMPTY_BOARD_COMMIT_ID);
    expectHealthy(root, env);
  });

  it('scenario: init after the board directory was deleted re-creates it from the local ref', () => {
    const env = syncEnv();
    const { root, dir } = hostBoard(env);
    const hashes = [
      commitHostEvent(dir, ev(P.create(T1, 'One'), 'orch', 1000), env),
      commitHostEvent(dir, ev(P.comment(T1, 'two'), 'orch', 1001), env),
    ];
    const commit = refCommit(root);
    rmSync(dir, { recursive: true });
    // A remote with a different board must not be consulted: the local ref wins.
    const ssh = sshShim();
    git(root, 'remote', 'add', 'origin', SSH_URL);

    const result = initBoard({ cwd: root, env: { ...env, GIT_SSH_COMMAND: ssh.command } });

    expect(result).toMatchObject({
      dir,
      created: true,
      model: 'host',
      joined: false,
      remote: 'origin',
      events: 2,
      warnings: [],
      repair: null,
    });
    expect(ssh.calls()).toEqual([]);
    expect(result.message).toMatch(/restored/);
    expect(result.message).toMatch(/local/);
    expect(result.message).toContain('2 event files');
    expect(result.message).not.toMatch(/new empty board/);
    expect(refCommit(root)).toBe(commit);
    expect(eventFiles(dir)).toEqual(hashes.map((h) => `${h}.json`).sort());
    expectHealthy(root, env);
    expect(listTickets(openTracked(dir)).map((t) => t.id)).toEqual([T1]);
  });

  it('re-creates a deleted board directory that was pruned from the worktree list too', () => {
    const env = syncEnv();
    const { root, dir } = hostBoard(env);
    const hash = commitHostEvent(dir, ev(P.create(T1, 'One'), 'orch', 1000), env);
    rmSync(dir, { recursive: true });
    git(root, 'worktree', 'unlock', dir);
    git(root, 'worktree', 'prune');
    expect(worktreeEntry(root, dir)).toBeNull();

    const result = initBoard({ cwd: root, env });

    expect(result).toMatchObject({ created: true, model: 'host', joined: false, events: 1 });
    expect(result.message).toMatch(/restored/);
    expect(result.message).toContain('1 event file');
    expect(result.message).not.toMatch(/new empty board/);
    expect(eventFiles(dir)).toEqual([`${hash}.json`]);
    expectHealthy(root, env);
  });

  it('a new empty board is reported as such only when the ref was written fresh', () => {
    const env = syncEnv();
    const root = hostRepo();
    const result = initBoard({ cwd: root, env });
    expect(result.message).toMatch(/new empty board/);
    expect(result.message).not.toMatch(/restored/);
  });
});

describe('scenario: init repairs a moved host', () => {
  it('relinks .board in place with git worktree repair: nothing copied, nothing kept aside', () => {
    const env = syncEnv();
    const { root, dir } = hostBoard(env);
    const hash = commitHostEvent(dir, ev(P.create(T1, 'Moved'), 'orch', 1000), env);
    const commit = refCommit(root);
    const moved = join(tempDir(), 'moved-host');
    renameSync(root, moved);
    const movedDir = join(moved, '.board');
    expect(detectBoardModel(movedDir, { env }).model).toBe('broken-host-link');
    // Everything but .board/.git, which git worktree repair must rewrite to
    // name the moved host's administrative directory.
    const files = (): string[] => snapshotDir(movedDir).filter((line) => !line.startsWith('.git '));
    const filesBefore = files();
    expect(filesBefore.some((line) => line.startsWith('events/'))).toBe(true);

    const result = initBoard({ cwd: moved, env });

    expect(result).toMatchObject({
      dir: movedDir,
      created: false,
      model: 'host',
      joined: false,
      remote: null,
      events: 1,
      hostGitignore: null,
      warnings: [],
    });
    expect(result.repair).not.toBeNull();
    expect(Object.keys(result.repair ?? {}).sort()).toEqual(REPAIR_KEYS);
    expect(result.repair).toEqual({
      method: 'worktree-repair',
      copied: [],
      skipped: [],
      keptAt: null,
      source: null,
    });
    expect(result.message).toMatch(/repair/);
    expect(refCommit(moved)).toBe(commit);
    expect(eventFiles(movedDir)).toEqual([`${hash}.json`]);
    expect(files()).toEqual(filesBefore);
    expect(readFileSync(join(movedDir, '.git'), 'utf8')).toContain(join(moved, '.git'));
    expect(keptEntries(moved)).toEqual([]);
    expectHealthy(moved, env);
    // The board works from the moved host.
    expect(git(movedDir, 'status', '--porcelain')).toBe('');
    expect(listTickets(openTracked(movedDir)).map((t) => t.id)).toEqual([T1]);
  });
});

describe('scenario: init repairs a stale board copied into a fresh clone', () => {
  /**
   * Clone A with one committed event pushed to origin and one event file
   * never synced, its `.board` copied into a fresh clone C of the project.
   */
  function staleCopy(env: Env): {
    a: ReturnType<typeof publishedBoard>;
    unsynced: string;
    c: string;
    cDir: string;
  } {
    const a = publishedBoard(env, 1);
    const unsynced = putEvent(join(a.dir, 'events'), ev(P.comment(T1, 'unsynced'), 'orch', 2000));
    const c = cloneHost(a.remote, 'clone-c');
    const cDir = join(c, '.board');
    cpSync(a.dir, cDir, { recursive: true });
    expect(detectBoardModel(cDir, { env }).model).toBe('broken-host-link');
    return { a, unsynced, c, cDir };
  }

  /** What must not change in clone A: its refs, its worktree list and its board files. */
  function stateOfA(a: { root: string; dir: string }): unknown[] {
    return [refs(a.root), worktrees(a.root), snapshotDir(a.dir), git(a.root, 'status', '--porcelain')];
  }

  it('builds a fresh worktree at the board joined from origin, carries the unsynced file over and keeps the copy', () => {
    const env = syncEnv();
    const { a, unsynced, c, cDir } = staleCopy(env);
    const copied = snapshotDir(cDir);
    const aBefore = stateOfA(a);

    const result = initBoard({ cwd: c, env });

    expect(result).toMatchObject({
      dir: cDir,
      created: false,
      model: 'host',
      joined: true,
      remote: 'origin',
      events: 2,
      hostGitignore: null,
      warnings: [],
    });
    expect(result.repair).toMatchObject({
      method: 'fresh-worktree',
      copied: [`${unsynced}.json`],
      skipped: [],
      source: 'remote',
    });
    const keptAt = result.repair?.keptAt ?? '';
    expect(dirname(keptAt)).toBe(join(c, '.git', AGENTBOARD_GIT_SUBDIR));
    expect(basename(keptAt)).toMatch(/^stale-board-\d{8}T\d{6}Z/);
    expect(result.message).toContain(keptAt);
    expect(result.message).toMatch(/1 event file/);

    // C's board: a worktree of C at the joined ref, with both event files.
    expectHealthy(c, env);
    expect(refCommit(c)).toBe(refCommit(a.root));
    expect(eventFiles(cDir)).toEqual([`${a.hashes[0] ?? ''}.json`, `${unsynced}.json`].sort());
    // The carried-over file is uncommitted, for the next sync.
    expect(git(cDir, 'status', '--porcelain').trim()).toBe(`?? events/${unsynced}.json`);
    expect(listTickets(openTracked(cDir)).map((t) => t.id)).toEqual([T1]);
    // The copy is kept under C's git directory, byte for byte, and the host stays clean.
    expect(keptEntries(c)).toEqual([basename(keptAt)]);
    expect(existsSync(join(c, '.git', AGENTBOARD_GIT_SUBDIR, REPAIRING_WORKTREE))).toBe(false);
    expect(snapshotDir(keptAt)).toEqual(copied);
    expect(git(c, 'status', '--porcelain')).toBe('');
    expect(worktreeEntry(c, keptAt)).toBeNull();
    // Clone A is unchanged.
    expect(stateOfA(a)).toEqual(aBefore);
    expect(detectBoardModel(a.dir, { env }).model).toBe('host');
  });

  it('skips and reports an event file whose content does not match its name', () => {
    const env = syncEnv();
    const { unsynced, c, cDir } = staleCopy(env);
    const bogus = `${'0'.repeat(64)}.json`;
    writeFileSync(join(cDir, 'events', bogus), '{"v":1,"kind":"ticket.comment"}');
    const alsoBogus = 'not-an-event.json';
    writeFileSync(join(cDir, 'events', alsoBogus), '{}');

    const result = initBoard({ cwd: c, env });

    expect(result.repair).toMatchObject({
      method: 'fresh-worktree',
      copied: [`${unsynced}.json`],
      skipped: [alsoBogus, bogus].sort(),
    });
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.join('\n')).toContain(bogus);
    expect(result.warnings.join('\n')).toContain(alsoBogus);
    for (const warning of result.warnings) {
      expect(warning).toMatch(/^[\x20-\x7e]+$/);
      expect(warning).toMatch(/content|match|name/);
    }
    expect(existsSync(join(cDir, 'events', bogus))).toBe(false);
    expect(existsSync(join(cDir, 'events', alsoBogus))).toBe(false);
    expect(existsSync(join(result.repair?.keptAt ?? '', 'events', bogus))).toBe(true);
    expect(result.events).toBe(2);
    expectHealthy(c, env);
  });

  it('prefers a local ref over the remote when both exist, and is done in one run', () => {
    const env = syncEnv();
    const { a, unsynced, c, cDir } = staleCopy(env);
    // C already has the board under its local ref (fetched by hand); origin is then not consulted.
    git(c, 'fetch', '-q', 'origin', `${BOARD_REF}:${BOARD_REF}`);
    const local = refCommit(c);
    const ssh = sshShim();
    git(c, 'remote', 'set-url', 'origin', SSH_URL);

    const result = initBoard({ cwd: c, env: { ...env, GIT_SSH_COMMAND: ssh.command } });

    expect(result.repair).toMatchObject({ method: 'fresh-worktree', source: 'local' });
    expect(result.joined).toBe(false);
    expect(ssh.calls()).toEqual([]);
    expect(refCommit(c)).toBe(local);
    expect(eventFiles(cDir)).toEqual([`${a.hashes[0] ?? ''}.json`, `${unsynced}.json`].sort());
    expectHealthy(c, env);
  });

  it('builds the fresh worktree from a new empty board when neither the host nor its remote has one', () => {
    const env = syncEnv();
    const a = hostBoard(env);
    const h1 = commitHostEvent(a.dir, ev(P.create(T1, 'A'), 'orch', 1000), env);
    const h2 = putEvent(join(a.dir, 'events'), ev(P.comment(T1, 'b'), 'orch', 2000));
    const c = hostRepo(join(tempDir(), 'c'));
    cpSync(a.dir, join(c, '.board'), { recursive: true });

    const result = initBoard({ cwd: c, env });

    expect(result).toMatchObject({ model: 'host', joined: false, remote: null, events: 2 });
    expect(result.repair).toMatchObject({
      method: 'fresh-worktree',
      copied: [`${h1}.json`, `${h2}.json`].sort(),
      source: 'created',
    });
    expect(rootCommit(c)).toBe(EMPTY_BOARD_COMMIT_ID);
    expect(refCommit(c)).toBe(EMPTY_BOARD_COMMIT_ID);
    expect(eventFiles(join(c, '.board'))).toEqual([`${h1}.json`, `${h2}.json`].sort());
    expectHealthy(c, env);
  });

  it('rebuilds a .board that holds events but is not a repository, keeping the directory aside', () => {
    const env = syncEnv();
    const root = hostRepo();
    const dir = join(root, '.board');
    mkdirSync(join(dir, 'events'), { recursive: true });
    const hash = putEvent(join(dir, 'events'), ev(P.create(T1, 'Plain'), 'orch', 1000));
    writeFileSync(join(dir, 'notes.txt'), 'kept aside\n');
    expect(detectBoardModel(dir, { env }).model).toBe('not-a-repository');

    const result = initBoard({ cwd: root, env });

    expect(result).toMatchObject({ created: false, model: 'host', joined: false, events: 1 });
    expect(result.repair).toMatchObject({ method: 'fresh-worktree', copied: [`${hash}.json`] });
    expect(existsSync(join(result.repair?.keptAt ?? '', 'notes.txt'))).toBe(true);
    expect(existsSync(join(dir, 'notes.txt'))).toBe(false);
    expect(eventFiles(dir)).toEqual([`${hash}.json`]);
    expectHealthy(root, env);
  });

  it('a second init after a repair changes nothing', () => {
    const env = syncEnv();
    const { c, cDir } = staleCopy(env);
    initBoard({ cwd: c, env });
    const before = [refs(c), worktrees(c), snapshotDir(cDir), keptEntries(c)];

    const again = initBoard({ cwd: c, env });

    expect(again).toMatchObject({ created: false, model: 'host', repair: null, events: 2 });
    expect([refs(c), worktrees(c), snapshotDir(cDir), keptEntries(c)]).toEqual(before);
  });

  it('repairBoardLink with worktree repair keeps the lock, and locks an unlocked board', () => {
    const env = syncEnv();
    const { root, dir } = hostBoard(env);
    git(root, 'worktree', 'unlock', dir);
    const moved = join(tempDir(), 'moved');
    renameSync(root, moved);
    const movedDir = join(moved, '.board');

    const outcome = repairBoardLink(moved, movedDir, null, { env });

    expect(outcome).toEqual({
      method: 'worktree-repair',
      copied: [],
      skipped: [],
      keptAt: null,
      source: null,
    });
    expectHealthy(moved, env);
  });

  it('a second stale copy is kept aside under its own name beside the first', () => {
    const env = syncEnv();
    const first = staleCopy(env);
    initBoard({ cwd: first.c, env });
    const copyAgain = join(tempDir(), 'copy');
    cpSync(first.a.dir, copyAgain, { recursive: true });
    git(first.c, 'worktree', 'unlock', first.cDir);
    git(first.c, 'worktree', 'remove', '--force', first.cDir);
    cpSync(copyAgain, first.cDir, { recursive: true });

    initBoard({ cwd: first.c, env });

    const kept = keptEntries(first.c);
    expect(kept).toHaveLength(2);
    expect(new Set(kept).size).toBe(2);
    for (const name of kept) {
      expect(name.startsWith(STALE_BOARD_PREFIX)).toBe(true);
    }
    expectHealthy(first.c, env);
  });
});

describe('withInitLock', () => {
  const lockPath = (root: string): string =>
    join(root, '.git', AGENTBOARD_GIT_SUBDIR, INIT_LOCK_FILE);

  it('fresh: holds this pid while fn runs, runs it once, removes the lock, passes results and errors on', () => {
    const env = syncEnv();
    const root = hostRepo();
    let runs = 0;
    let seen = '';

    const out = withInitLock(
      root,
      () => {
        runs += 1;
        seen = readFileSync(lockPath(root), 'utf8').trim();
        return 42;
      },
      { env },
    );

    expect(out).toBe(42);
    expect(runs).toBe(1);
    expect(seen).toBe(String(process.pid));
    expect(existsSync(lockPath(root))).toBe(false);
    expect(() =>
      withInitLock(
        root,
        () => {
          throw new Error('boom');
        },
        { env },
      ),
    ).toThrow('boom');
    expect(existsSync(lockPath(root))).toBe(false);
  });

  it('held by a live process: waits until that process has exited', () => {
    const env = syncEnv();
    const root = hostRepo();
    mkdirSync(join(root, '.git', AGENTBOARD_GIT_SUBDIR), { recursive: true });
    // The holder must not be this process's child: withInitLock blocks the
    // event loop, so a child that exits would stay an unreaped zombie and
    // still look alive. A grandchild is reaped by init when it exits.
    const started = Date.now();
    const holder = spawnSync('sh', ['-c', 'sleep 2 >/dev/null 2>&1 </dev/null & echo $!'], {
      encoding: 'utf8',
    });
    const pid = Number(holder.stdout.trim());
    expect(pid).toBeGreaterThan(0);
    writeFileSync(lockPath(root), String(pid));
    let runs = 0;

    withInitLock(
      root,
      () => {
        runs += 1;
      },
      { env },
    );

    expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
    expect(runs).toBe(1);
    expect(existsSync(lockPath(root))).toBe(false);
  });

  it('held by a process that is gone: breaks the lock at once', () => {
    const env = syncEnv();
    const root = hostRepo();
    mkdirSync(join(root, '.git', AGENTBOARD_GIT_SUBDIR), { recursive: true });
    const gone = spawnSync('true');
    expect(gone.status).toBe(0);
    writeFileSync(lockPath(root), String(gone.pid));
    const started = Date.now();
    let runs = 0;

    withInitLock(
      root,
      () => {
        runs += 1;
      },
      { env },
    );

    expect(Date.now() - started).toBeLessThan(1000);
    expect(runs).toBe(1);
    expect(existsSync(lockPath(root))).toBe(false);
  });

  it('older than 60 s with a live holder: breaks the lock (the known limit)', () => {
    const env = syncEnv();
    const root = hostRepo();
    mkdirSync(join(root, '.git', AGENTBOARD_GIT_SUBDIR), { recursive: true });
    writeFileSync(lockPath(root), String(process.pid));
    const old = (Date.now() - STALE_LOCK_MS - 5_000) / 1000;
    utimesSync(lockPath(root), old, old);
    expect(STALE_LOCK_MS).toBe(60_000);
    const started = Date.now();
    let runs = 0;

    withInitLock(
      root,
      () => {
        runs += 1;
      },
      { env },
    );

    expect(Date.now() - started).toBeLessThan(1000);
    expect(runs).toBe(1);
    expect(existsSync(lockPath(root))).toBe(false);
  });
});

describe('the create-only update-ref race', () => {
  it('the loser uses the ref the winner wrote and reports source local', () => {
    const base = syncEnv();
    const root = hostRepo();
    const other = revParse(root);
    const env = withGitShimBefore(
      base,
      ['update-ref', BOARD_REF],
      `"$GIT" update-ref ${BOARD_REF} ${other}`,
    );

    const outcome = ensureBoardRef(root, null, { env });

    expect(outcome).toEqual({ commit: other, source: 'local', warnings: [] });
    expect(refCommit(root)).toBe(other);
    expect(git(root, 'for-each-ref', '--format=%(refname)', 'refs/agentboard/')).toBe(
      `${BOARD_REF}\n`,
    );
  });
});

describe('an interrupted repair', () => {
  /**
   * The state a repair leaves when killed between keeping the old
   * directory aside and `git worktree move`: `.board` missing, the
   * `repairing` worktree registered at the ref with one carried-over
   * (uncommitted) event file, and one kept `stale-board-*` directory.
   */
  function interruptedRepair(env: Env): {
    root: string;
    dir: string;
    repairing: string;
    kept: string;
    hash: string;
  } {
    const root = hostRepo();
    git(root, 'update-ref', BOARD_REF, emptyBoardCommit(root, env), '');
    const agentboardDir = join(root, '.git', AGENTBOARD_GIT_SUBDIR);
    mkdirSync(agentboardDir, { recursive: true });
    const repairing = join(agentboardDir, REPAIRING_WORKTREE);
    git(root, 'worktree', 'add', '-q', '--detach', repairing, BOARD_REF);
    const hash = putEvent(join(repairing, 'events'), ev(P.create(T1, 'Carried'), 'orch', 1000));
    const kept = join(agentboardDir, `${STALE_BOARD_PREFIX}20260101T000000Z`);
    mkdirSync(join(kept, 'events'), { recursive: true });
    writeFileSync(join(kept, '.git'), 'gitdir: /nowhere/.git/worktrees/-board\n');
    putEvent(join(kept, 'events'), ev(P.create(T1, 'Carried'), 'orch', 1000));
    return { root, dir: join(root, '.board'), repairing, kept, hash };
  }

  it('adoptRepairingWorktree moves the repairing worktree into place when .board is missing', () => {
    const env = syncEnv();
    const { root, dir, repairing, hash } = interruptedRepair(env);

    expect(adoptRepairingWorktree(root, dir, { env })).toBe(true);

    expect(existsSync(repairing)).toBe(false);
    expect(worktreeEntry(root, repairing)).toBeNull();
    expect(worktreeEntry(root, dir)).not.toBeNull();
    expect(eventFiles(dir)).toEqual([`${hash}.json`]);
    expect(revParse(dir)).toBe(refCommit(root));
    // Nothing left to adopt.
    expect(adoptRepairingWorktree(root, dir, { env })).toBe(false);
  });

  it('adoptRepairingWorktree changes nothing when .board exists or nothing is registered at repairing', () => {
    const env = syncEnv();
    const present = hostBoard(env);
    const agentboardDir = join(present.root, '.git', AGENTBOARD_GIT_SUBDIR);
    const repairing = join(agentboardDir, REPAIRING_WORKTREE);
    git(present.root, 'worktree', 'add', '-q', '--detach', repairing, BOARD_REF);
    const before = [worktrees(present.root), snapshotDir(present.dir)];
    expect(adoptRepairingWorktree(present.root, present.dir, { env })).toBe(false);
    expect([worktrees(present.root), snapshotDir(present.dir)]).toEqual(before);
    expect(existsSync(repairing)).toBe(true);

    const plain = hostRepo();
    const plainDir = join(plain, '.git', AGENTBOARD_GIT_SUBDIR, REPAIRING_WORKTREE);
    mkdirSync(plainDir, { recursive: true });
    writeFileSync(join(plainDir, 'stray.txt'), 'not a worktree\n');
    expect(adoptRepairingWorktree(plain, join(plain, '.board'), { env })).toBe(false);
    expect(existsSync(join(plain, '.board'))).toBe(false);
    expect(existsSync(join(plainDir, 'stray.txt'))).toBe(true);

    expect(adoptRepairingWorktree(hostRepo(), join(tempDir(), '.board'), { env })).toBe(false);
  });

  it('removeLeftoverWorktree unregisters and deletes a leftover, deletes a plain directory, ignores a missing path', () => {
    const env = syncEnv();
    const { root, repairing } = interruptedRepair(env);
    const runner = gitRunner(root, { env, disableHooks: true });
    git(root, 'worktree', 'lock', repairing);
    const refsBefore = refs(root);

    removeLeftoverWorktree(runner, repairing);

    expect(existsSync(repairing)).toBe(false);
    expect(worktreeEntry(root, repairing)).toBeNull();
    expect(worktreeEntries(root)).toHaveLength(1);
    expect(refs(root)).toBe(refsBefore);

    mkdirSync(repairing, { recursive: true });
    writeFileSync(join(repairing, 'stray.txt'), 'x\n');
    removeLeftoverWorktree(runner, repairing);
    expect(existsSync(repairing)).toBe(false);

    expect(() => {
      removeLeftoverWorktree(runner, repairing);
    }).not.toThrow();
    expect(worktreeEntries(root)).toHaveLength(1);
  });

  it('scenario: a re-run after an interrupted repair adopts the fresh worktree and reports the kept copy', () => {
    const env = syncEnv();
    const { root, dir, repairing, kept, hash } = interruptedRepair(env);

    const result = initBoard({ cwd: root, env });

    expect(result).toMatchObject({
      dir,
      created: false,
      model: 'host',
      joined: false,
      remote: null,
      events: 1,
      hostGitignore: null,
      warnings: [],
    });
    expect(result.repair).toEqual({
      method: 'fresh-worktree',
      copied: [],
      skipped: [],
      keptAt: kept,
      source: null,
    });
    expect(result.message).toContain(kept);
    expect(result.message).not.toMatch(/new empty board/);
    expectHealthy(root, env);
    expect(eventFiles(dir)).toEqual([`${hash}.json`]);
    expect(git(dir, 'status', '--porcelain').trim()).toBe(`?? events/${hash}.json`);
    expect(existsSync(repairing)).toBe(false);
    expect(worktreeEntry(root, repairing)).toBeNull();
    expect(keptEntries(root)).toEqual([basename(kept)]);
    expect(existsSync(join(kept, '.git'))).toBe(true);
    expect(listTickets(openTracked(dir)).map((t) => t.id)).toEqual([T1]);
  });

  it('a repairing worktree left by a repair interrupted earlier is removed and the repair starts again', () => {
    const env = syncEnv();
    const a = publishedBoard(env, 1);
    const c = cloneHost(a.remote, 'clone-c');
    const cDir = join(c, '.board');
    cpSync(a.dir, cDir, { recursive: true });
    // A leftover from an earlier attempt: registered, with the ref already fetched.
    git(c, 'fetch', '-q', 'origin', `${BOARD_REF}:${BOARD_REF}`);
    const repairing = join(c, '.git', AGENTBOARD_GIT_SUBDIR, REPAIRING_WORKTREE);
    git(c, 'worktree', 'add', '-q', '--detach', repairing, BOARD_REF);
    writeFileSync(join(repairing, 'events', 'stray.json'), '{}');

    const result = initBoard({ cwd: c, env });

    expect(result.repair).toMatchObject({ method: 'fresh-worktree', copied: [], skipped: [] });
    expectHealthy(c, env);
    expect(existsSync(join(cDir, 'events', 'stray.json'))).toBe(false);
    expect(eventFiles(cDir)).toEqual([`${a.hashes[0] ?? ''}.json`]);
    expect(worktreeEntry(c, repairing)).toBeNull();
    expect(worktreeEntries(c).map((entry) => basename(entry.path)).sort()).toEqual(['.board', 'clone-c']);
  });
});
