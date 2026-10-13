/**
 * `syncBoard` on a host-model board (add-board-sharing task 3.1;
 * board-concurrency "Sync converges" for the host model; board-events
 * "Board ref in the host repository"; add-board-sharing design.md decision
 * 4): the preconditions `git-too-old`, `board-on-branch`, `integrity` and
 * `sync-in-progress`, the commit per ADR 0005, the local ref made equal
 * to HEAD with a compare-and-swap, the fetch into the worktree's own
 * `FETCH_HEAD` with `--no-tags`, the rebase, the push of
 * `HEAD:refs/agentboard/board` without force and its one retry, the
 * conflict left for a human, the remote rules on a host, hooks of the host
 * never running, `git gc` and a plain clone leaving the board alone, and
 * an offline-created board meeting a board with another root. Every
 * remote is a bare repository on local disk.
 */

import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { openBoard, type Board } from '../../store/board.js';
import { dumpCache } from '../../store/cache.js';
import { checkCache, rebuild } from '../../store/rebuild.js';
import { P, T1, T2, ev, putEvent } from '../../store/__tests__/helpers.js';
import { HOST_MODEL_GIT_FLOOR, gitVersion } from '../git.js';
import { BOARD_REF } from '../model.js';
import { syncBoard, syncCommitMessage, type SyncResult } from '../sync.js';
import { listTickets } from '../tickets.js';
import { BUILT_CLI } from '../../cli/__tests__/cli-helpers.js';
import { create, expectBoardError, git, openTracked, tempDir } from './helpers.js';
import {
  EMPTY_BOARD_COMMIT_ID,
  commitHostEvent,
  hostBoard,
  installHook,
  joinHostBoard,
  pushBoardRef,
  refCommit,
  refs,
  standaloneBoard,
  withGitShim,
  withGitShimBefore,
  withRecordingGitShim,
  worktreeEntry,
} from './sharing-helpers.js';
import {
  bareRemote,
  rebaseInProgress,
  revParse,
  syncEnv,
  treeEvents,
  unmerged,
  type Env,
} from './sync-helpers.js';

// Every test spawns many git processes; keep well clear of the 5 s default under load.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const HEX40 = /^[0-9a-f]{40}$/;
const EVENT_FILE = /^[0-9a-f]{64}\.json$/;

/** Event file names (`<hash>.json`) in a board's events directory, sorted. */
function eventFiles(dir: string): string[] {
  return readdirSync(join(dir, 'events'))
    .filter((name) => EVENT_FILE.test(name))
    .sort();
}

/** Creates `n` tickets on `board` as `actor` through the store and returns their event hashes, sorted. */
function addTickets(board: Board, n: number, actor: string): string[] {
  const hashes: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const before = new Set(eventFiles(board.dir));
    create(board, { title: `${actor} ticket ${String(i)}` }, actor);
    hashes.push(
      ...eventFiles(board.dir)
        .filter((name) => !before.has(name))
        .map((name) => name.slice(0, -'.json'.length)),
    );
  }
  return hashes.sort();
}

/** The event file names in the tree of `ref` of the repository at `repo`, sorted. */
function refEvents(repo: string, ref = BOARD_REF): string[] {
  return treeEvents(repo, ref).sort();
}

/**
 * Clone A: a host repository with a bare `origin` holding its `main`, and
 * a host-model board at the empty-board commit (not yet pushed).
 */
function hostWithOrigin(env: Env): { root: string; dir: string; remote: string } {
  const remote = bareRemote();
  const { root, dir } = hostBoard(env);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', 'origin', 'main');
  return { root, dir, remote };
}

/** Clones A and B sharing an (empty) published board through `origin`, both opened. */
function twoClones(env: Env): {
  remote: string;
  aRoot: string;
  bRoot: string;
  a: Board;
  b: Board;
} {
  const { root: aRoot, dir: aDir, remote } = hostWithOrigin(env);
  pushBoardRef(aRoot);
  const { root: bRoot, dir: bDir } = joinHostBoard(remote, 'b');
  return { remote, aRoot, bRoot, a: openTracked(aDir), b: openTracked(bDir) };
}

/** Branches and tags of the repository at `repo` with their targets (never the board ref). */
function branchesAndTags(repo: string): string {
  return git(repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags');
}

/** Remote-tracking refs of the repository at `repo`. */
function remoteRefs(repo: string): string[] {
  return git(repo, 'for-each-ref', '--format=%(refname)', 'refs/remotes')
    .split('\n')
    .filter(Boolean)
    .sort();
}

/** Asserts the invariant of a completed host-model sync: the ref equals the worktree's HEAD, and the result says so. */
function expectRefAtHead(root: string, dir: string, result?: SyncResult): void {
  const head = revParse(dir);
  expect(refCommit(root)).toBe(head);
  if (result !== undefined) {
    expect(result).toMatchObject({
      model: 'host',
      ref: BOARD_REF,
      refCommit: head,
      branch: null,
      upstreamSet: false,
      dir,
    });
  }
}

/** The git directory of the board worktree at `dir`, as git names it. */
function worktreeGitDir(dir: string): string {
  return git(dir, 'rev-parse', '--absolute-git-dir').trim();
}

describe('scenario: Two clones of a host repository converge through the board ref', () => {
  it('A adds three, B adds two, both sync, A syncs again: all five everywhere, one ref value, no branch moved', () => {
    const env = syncEnv();
    const { remote, aRoot, bRoot, a, b } = twoClones(env);
    const branchesBefore = [
      branchesAndTags(aRoot),
      branchesAndTags(bRoot),
      branchesAndTags(remote),
    ];
    const remotesBefore = [remoteRefs(aRoot), remoteRefs(bRoot)];
    const fromA = addTickets(a, 3, 'alice');
    const fromB = addTickets(b, 2, 'bob');

    const syncA = syncBoard(a, { env });
    expect(syncA).toMatchObject({
      committedEvents: 3,
      remote: 'origin',
      pulled: true,
      pushed: true,
      arrived: [],
    });
    expect(syncA.commit).toMatch(HEX40);
    expectRefAtHead(aRoot, a.dir, syncA);
    expect(git(remote, 'rev-parse', BOARD_REF).trim()).toBe(syncA.refCommit);

    const syncB = syncBoard(b, { env });
    expect(syncB).toMatchObject({ committedEvents: 2, pulled: true, pushed: true });
    expect(syncB.arrived).toEqual(fromA);
    // B's commit was replayed onto A's by the rebase: commit names the replayed one.
    expect(syncB.commit).toMatch(HEX40);
    expect(syncB.commit).toBe(revParse(b.dir));
    expectRefAtHead(bRoot, b.dir, syncB);
    expect(git(remote, 'rev-parse', BOARD_REF).trim()).toBe(syncB.refCommit);

    const again = syncBoard(a, { env });
    expect(again).toMatchObject({ commit: null, committedEvents: 0, pulled: true, pushed: true });
    expect(again.arrived).toEqual(fromB);
    expectRefAtHead(aRoot, a.dir, again);

    const all = [...fromA, ...fromB].map((h) => `${h}.json`).sort();
    expect(eventFiles(a.dir)).toEqual(all);
    expect(eventFiles(b.dir)).toEqual(all);
    expect(refEvents(aRoot)).toEqual(all);
    expect(refEvents(bRoot)).toEqual(all);
    expect(refEvents(remote)).toEqual(all);
    const value = refCommit(aRoot);
    expect(value).toMatch(HEX40);
    expect(refCommit(bRoot)).toBe(value);
    expect(git(remote, 'rev-parse', BOARD_REF).trim()).toBe(value);
    expect(revParse(a.dir)).toBe(value);
    expect(revParse(b.dir)).toBe(value);

    // No branch or tag was created or moved anywhere, and no remote-tracking ref appeared.
    expect([branchesAndTags(aRoot), branchesAndTags(bRoot), branchesAndTags(remote)]).toEqual(
      branchesBefore,
    );
    expect([remoteRefs(aRoot), remoteRefs(bRoot)]).toEqual(remotesBefore);
    expect(git(aRoot, 'for-each-ref', '--format=%(refname)', 'refs/agentboard/')).toBe(
      `${BOARD_REF}\n`,
    );

    // The catch-up run by sync already folded the arrivals, and a full
    // rebuild on each clone gives the same bytes.
    const live = dumpCache(a.db);
    expect(dumpCache(b.db)).toBe(live);
    rebuild(a);
    rebuild(b);
    expect(dumpCache(a.db)).toBe(live);
    expect(dumpCache(b.db)).toBe(live);
    expect(listTickets(a)).toHaveLength(5);
    expect(listTickets(b).map((t) => t.id)).toEqual(listTickets(a).map((t) => t.id));
    expect(checkCache(a).ok).toBe(true);
    expect(checkCache(b).ok).toBe(true);
  });

  it('the host repositories are untouched: main, the index and the working tree of the main checkout', () => {
    const env = syncEnv();
    const { aRoot, a } = twoClones(env);
    const head = revParse(aRoot);
    const index = git(aRoot, 'ls-files', '-s');
    addTickets(a, 1, 'alice');

    syncBoard(a, { env });

    expect(revParse(aRoot)).toBe(head);
    expect(git(aRoot, 'ls-files', '-s')).toBe(index);
    expect(git(aRoot, 'status', '--porcelain')).toBe('');
    expect(git(aRoot, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('main');
    expect(() => git(aRoot, 'config', '--local', '--get', 'core.hooksPath')).toThrow();
  });
});

describe('scenario: First sync publishes the board', () => {
  it('a board created with no board on origin is pushed as refs/agentboard/board by its first sync', () => {
    const env = syncEnv();
    const { root, dir, remote } = hostWithOrigin(env);
    expect(git(remote, 'for-each-ref', 'refs/agentboard/')).toBe('');
    const board = openTracked(dir);
    const [hash] = addTickets(board, 1, 'orch');

    const result = syncBoard(board, { env });

    expect(result).toMatchObject({
      committedEvents: 1,
      remote: 'origin',
      pulled: false,
      pushed: true,
      arrived: [],
      refolded: false,
      hostTracked: [],
      warnings: [],
    });
    expectRefAtHead(root, dir, result);
    const listed = git(root, 'ls-remote', 'origin', BOARD_REF).trim();
    expect(listed).toBe(`${String(refCommit(root))}\t${BOARD_REF}`);
    expect(refEvents(remote)).toEqual([`${String(hash)}.json`]);
    expect(result.message).toBe(
      [
        `committed 1 event file (${String(result.commit).slice(0, 12)})`,
        `origin has no ${BOARD_REF} yet; nothing to fetch`,
        `pushed ${BOARD_REF} to origin`,
      ].join('\n'),
    );
    // The board's history starts at the deterministic empty-board commit.
    expect(git(root, 'rev-list', '--max-parents=0', BOARD_REF).trim()).toBe(EMPTY_BOARD_COMMIT_ID);
    expect(git(remote, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe(
      'refs/heads/main\n',
    );
  });

  it('commits as the fixed identity with the ADR 0005 message and only its own paths', () => {
    const env = syncEnv();
    const { root, dir } = hostWithOrigin(env);
    const board = openTracked(dir);
    writeFileSync(join(dir, 'stray.txt'), 'not for sync\n');
    writeFileSync(join(dir, 'events', '.tmp-inflight'), 'partial');
    const [hash] = addTickets(board, 1, 'orch');

    const result = syncBoard(board, { env });

    const who = 'agentboard <agentboard@localhost>';
    expect(git(dir, 'log', '-1', '--format=%an <%ae>|%cn <%ce>|%s').trim()).toBe(
      `${who}|${who}|${syncCommitMessage(1)}`,
    );
    expect(git(dir, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe(
      `events/${String(hash)}.json`,
    );
    expect(git(dir, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('stray.txt');
    expect(git(dir, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('.tmp-');
    expect(git(dir, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('cache.sqlite');
    expectRefAtHead(root, dir, result);
  });
});

describe('scenario: Sync with no remote (host model)', () => {
  it('commits local events, moves the ref to HEAD, reports no remote configured and succeeds', () => {
    const env = syncEnv();
    const { root, dir } = hostBoard(env);
    const board = openTracked(dir);
    const hashes = addTickets(board, 2, 'orch');

    const result = syncBoard(board, { env });

    expect(result).toMatchObject({
      dir,
      model: 'host',
      ref: BOARD_REF,
      committedEvents: 2,
      remote: null,
      branch: null,
      pulled: false,
      pushed: false,
      upstreamSet: false,
      arrived: [],
      refolded: false,
      hostTracked: [],
      warnings: [],
    });
    expect(result.commit).toMatch(HEX40);
    expect(result.commit).toBe(revParse(dir));
    expectRefAtHead(root, dir, result);
    expect(result.message).toBe(
      [
        `committed 2 event files (${String(result.commit).slice(0, 12)})`,
        `no remote configured; the board at ${dir} was not fetched or pushed`,
      ].join('\n'),
    );
    expect(refEvents(root)).toEqual(hashes.map((h) => `${h}.json`));
    expect(worktreeEntry(root, dir)?.detached).toBe(true);
    expect(branchesAndTags(root).split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('makes no commit when nothing is new, and the ref still equals HEAD', () => {
    const env = syncEnv();
    const { root, dir } = hostBoard(env);
    const board = openTracked(dir);
    addTickets(board, 1, 'orch');
    const first = syncBoard(board, { env });

    const again = syncBoard(board, { env });

    expect(again).toMatchObject({ commit: null, committedEvents: 0, remote: null });
    expect(again.refCommit).toBe(first.commit);
    expect(again.message.split('\n')[0]).toBe('nothing new to commit');
    expectRefAtHead(root, dir, again);
    expect(git(root, 'rev-list', '--count', BOARD_REF).trim()).toBe('2');
  });

  it('creates the ref again from HEAD when a human deleted it', () => {
    const env = syncEnv();
    const { root, dir } = hostBoard(env);
    const board = openTracked(dir);
    addTickets(board, 1, 'orch');
    syncBoard(board, { env });
    git(root, 'update-ref', '-d', BOARD_REF);
    expect(refCommit(root)).toBeNull();

    const result = syncBoard(board, { env });

    expect(result.commit).toBeNull();
    expectRefAtHead(root, dir, result);
    expect(refEvents(root)).toHaveLength(1);
  });

  it('rebases HEAD onto the ref first when someone fetched into it by hand', () => {
    const env = syncEnv();
    const { remote, aRoot, bRoot, a, b } = twoClones(env);
    const fromA = addTickets(a, 1, 'alice');
    syncBoard(a, { env });
    const [fromB] = addTickets(b, 1, 'bob');
    git(bRoot, 'fetch', '-q', 'origin', `+${BOARD_REF}:${BOARD_REF}`);
    expect(refCommit(bRoot)).toBe(refCommit(aRoot));

    const result = syncBoard(b, { env });

    expect(result.arrived).toEqual(fromA);
    expect(result.committedEvents).toBe(1);
    expectRefAtHead(bRoot, b.dir, result);
    expect(git(remote, 'rev-parse', BOARD_REF).trim()).toBe(refCommit(bRoot));
    expect(refEvents(remote)).toEqual([...fromA, String(fromB)].map((h) => `${h}.json`).sort());
    expect(git(b.dir, 'log', '--format=%s', 'HEAD').trim().split('\n')).toEqual([
      syncCommitMessage(1),
      syncCommitMessage(1),
      'agentboard: empty board',
    ]);
    expect(listTickets(b)).toHaveLength(2);
  });
});

describe('scenario: Rejected push is retried', () => {
  /** The exact push command line of the host-model sync, as the design gives it. */
  const PUSH = ['push', '--porcelain', '--no-verify', 'origin', `HEAD:${BOARD_REF}`];

  it('B pushes between A fetch and push: A fetches again, rebases, pushes, reports B events and exits 0', () => {
    const base = syncEnv();
    const { remote, aRoot, bRoot, a, b } = twoClones(base);
    const fromA = addTickets(a, 1, 'alice');
    const fromB = commitHostEvent(b.dir, ev(P.create(T2, 'From B'), 'bob', 2_000), base);
    // Just before A's first push, B's board ref reaches origin.
    const env = withGitShimBefore(
      base,
      PUSH,
      `"$GIT" -C '${bRoot}' push -q origin ${BOARD_REF}:${BOARD_REF}`,
    );

    const result = syncBoard(a, { env });

    expect(result).toMatchObject({ committedEvents: 1, pulled: true, pushed: true });
    expect(result.arrived).toEqual([fromB]);
    expect(result.commit).toBe(revParse(a.dir));
    expectRefAtHead(aRoot, a.dir, result);
    expect(git(remote, 'rev-parse', BOARD_REF).trim()).toBe(refCommit(aRoot));
    expect(refEvents(remote)).toEqual([...fromA, fromB].map((h) => `${h}.json`).sort());
    expect(listTickets(a)).toHaveLength(2);
    expect(result.message).not.toMatch(/retr/i);

    const back = syncBoard(b, { env: base });
    expect(back.arrived).toEqual(fromA);
    expect(eventFiles(b.dir)).toEqual(eventFiles(a.dir));
    expect(dumpCache(b.db)).toBe(dumpCache(a.db));
  });

  it('exits 3 sync-failed when the push is rejected a second time, keeping the local commit and the ref at HEAD', () => {
    const base = syncEnv();
    const { remote, aRoot, bRoot, a, b } = twoClones(base);
    addTickets(a, 1, 'alice');
    // Before each of A's two pushes, B's ref moves and reaches origin.
    const env = withGitShimBefore(
      base,
      PUSH,
      `"$GIT" -C '${b.dir}' commit -q --allow-empty --no-verify -m competing && ` +
        `"$GIT" -C '${bRoot}' update-ref ${BOARD_REF} "$("$GIT" -C '${b.dir}' rev-parse HEAD)" && ` +
        `"$GIT" -C '${bRoot}' push -q origin ${BOARD_REF}:${BOARD_REF}`,
      2,
    );

    const err = expectBoardError(() => syncBoard(a, { env }), 3, 'sync-failed');

    expect(err.message).toContain('origin');
    expect(git(remote, 'rev-parse', BOARD_REF).trim()).toBe(refCommit(bRoot));
    expect(refEvents(remote)).toEqual([]);
    expect(refEvents(aRoot)).toHaveLength(1);
    expectRefAtHead(aRoot, a.dir);
    expect(rebaseInProgress(a.dir)).toBe(false);
  });
});

describe('the remote of a host-model board', () => {
  /** A host whose remotes are `fork` and `upstream` (both bare, both holding `main`), no `origin`. */
  function forkWorkflow(env: Env): {
    root: string;
    dir: string;
    fork: string;
    upstream: string;
    board: Board;
  } {
    const { root, dir } = hostBoard(env);
    const fork = bareRemote();
    const upstream = bareRemote();
    git(root, 'remote', 'add', 'fork', fork);
    git(root, 'remote', 'add', 'upstream', upstream);
    git(root, 'push', '-q', 'fork', 'main');
    git(root, 'push', '-q', 'upstream', 'main');
    return { root, dir, fork, upstream, board: openTracked(dir) };
  }

  it('scenario: Host with several remotes (main tracks upstream/main): fetches from and pushes to upstream', () => {
    const env = syncEnv();
    const { root, dir, fork, upstream, board } = forkWorkflow(env);
    git(root, 'branch', '--set-upstream-to=upstream/main', 'main');
    addTickets(board, 1, 'orch');

    const result = syncBoard(board, { env });

    expect(result.remote).toBe('upstream');
    expect(result.pushed).toBe(true);
    expectRefAtHead(root, dir, result);
    expect(git(upstream, 'rev-parse', BOARD_REF).trim()).toBe(refCommit(root));
    expect(git(fork, 'for-each-ref', 'refs/agentboard/')).toBe('');
    expect(result.message).toContain(`pushed ${BOARD_REF} to upstream`);
  });

  it('scenario: Host with several remotes and no way to choose: commits, exits 1 ambiguous-remote, pushes nothing', () => {
    const env = syncEnv();
    const { root, dir, fork, upstream, board } = forkWorkflow(env);
    addTickets(board, 1, 'orch');

    const err = expectBoardError(() => syncBoard(board, { env }), 1, 'ambiguous-remote');

    expect(err.message).toContain('fork');
    expect(err.message).toContain('upstream');
    expect(err.message).toContain('git config agentboard.remote <name>');
    expect(refEvents(root)).toHaveLength(1);
    expectRefAtHead(root, dir);
    expect(git(fork, 'for-each-ref', 'refs/agentboard/')).toBe('');
    expect(git(upstream, 'for-each-ref', 'refs/agentboard/')).toBe('');
  });

  it('scenario: Configured remote wins: agentboard.remote fork while main tracks upstream/main', () => {
    const env = syncEnv();
    const { root, dir, fork, upstream, board } = forkWorkflow(env);
    git(root, 'branch', '--set-upstream-to=upstream/main', 'main');
    git(root, 'config', 'agentboard.remote', 'fork');
    addTickets(board, 1, 'orch');

    const result = syncBoard(board, { env });

    expect(result.remote).toBe('fork');
    expectRefAtHead(root, dir, result);
    expect(git(fork, 'rev-parse', BOARD_REF).trim()).toBe(refCommit(root));
    expect(git(upstream, 'for-each-ref', 'refs/agentboard/')).toBe('');
    expect(git(root, 'config', '--get', 'branch.main.remote').trim()).toBe('upstream');
  });

  it('scenario: Configured remote that does not exist: commits, exits 3 sync-failed naming it, pushes nothing', () => {
    const env = syncEnv();
    const { root, dir, remote } = hostWithOrigin(env);
    git(root, 'config', 'agentboard.remote', 'nope');
    const board = openTracked(dir);
    addTickets(board, 1, 'orch');

    const err = expectBoardError(() => syncBoard(board, { env }), 3, 'sync-failed');

    expect(err.message).toContain('nope');
    expect(refEvents(root)).toHaveLength(1);
    expectRefAtHead(root, dir);
    expect(git(remote, 'for-each-ref', 'refs/agentboard/')).toBe('');
  });

  it('scenario: Configured remote does not change the upstream (standalone board)', () => {
    const env = syncEnv();
    const dir = standaloneBoard(tempDir());
    git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    const upstream = bareRemote();
    git(dir, 'remote', 'add', 'upstream', upstream);
    const board = openTracked(dir);
    addTickets(board, 1, 'orch');
    expect(syncBoard(board, { env })).toMatchObject({ remote: 'upstream', upstreamSet: true });
    expect(git(dir, 'config', '--get', 'branch.main.remote').trim()).toBe('upstream');
    const fork = bareRemote();
    git(dir, 'remote', 'add', 'fork', fork);
    git(dir, 'config', 'agentboard.remote', 'fork');
    const upstreamTip = revParse(upstream, 'main');
    addTickets(board, 1, 'orch');

    const result = syncBoard(board, { env });

    expect(result).toMatchObject({
      model: 'standalone',
      remote: 'fork',
      upstreamSet: false,
      ref: null,
    });
    expect(git(dir, 'config', '--get', 'branch.main.remote').trim()).toBe('upstream');
    expect(git(dir, 'config', '--get', 'branch.main.merge').trim()).toBe('refs/heads/main');
    expect(revParse(fork, 'main')).toBe(revParse(dir));
    expect(revParse(upstream, 'main')).toBe(upstreamTip);
    expect(treeEvents(upstream, 'main')).toHaveLength(1);
  });

  it('reaches the remote with the host URL and stores no second URL', () => {
    const env = syncEnv();
    const { root, dir } = hostWithOrigin(env);
    const config = readFileSync(join(root, '.git', 'config'), 'utf8');
    const board = openTracked(dir);
    addTickets(board, 1, 'orch');

    syncBoard(board, { env });

    expect(readFileSync(join(root, '.git', 'config'), 'utf8')).toBe(config);
    expect(() => git(dir, 'config', '--local', '--get', 'core.hooksPath')).toThrow();
  });
});

describe('scenario: Conflict on a host-model board', () => {
  /** A and B with different `.gitignore` changes; A synced; B has an event too. */
  function conflicted(env: Env): ReturnType<typeof twoClones> {
    const clones = twoClones(env);
    appendFileSync(join(clones.a.dir, '.gitignore'), 'only-on-a\n');
    appendFileSync(join(clones.b.dir, '.gitignore'), 'only-on-b\n');
    addTickets(clones.b, 1, 'bob');
    syncBoard(clones.a, { env });
    return clones;
  }

  it('B exits 3 sync-conflict naming .gitignore, the rebase is left in B worktree, B ref and host unchanged', () => {
    const env = syncEnv();
    const { bRoot, b } = conflicted(env);
    const hostHead = revParse(bRoot);
    const hostIndex = git(bRoot, 'ls-files', '-s');
    const hostBranches = branchesAndTags(bRoot);
    const hostStatus = git(bRoot, 'status', '--porcelain');

    const err = expectBoardError(() => syncBoard(b, { env }), 3, 'sync-conflict');

    expect(err.message).toContain('.gitignore');
    expect(err.message).toContain(b.dir);
    expect(err.message).toContain('rebase');
    expect(unmerged(b.dir)).toEqual(['.gitignore']);
    expect(rebaseInProgress(b.dir)).toBe(true);
    // B's own commit was made and its ref moved to it before the fetch; the failed rebase moved nothing.
    expect(refEvents(bRoot)).toHaveLength(1);
    expect(git(b.dir, 'log', '-1', '--format=%s', BOARD_REF).trim()).toBe(syncCommitMessage(1));
    expect(revParse(bRoot)).toBe(hostHead);
    expect(git(bRoot, 'ls-files', '-s')).toBe(hostIndex);
    expect(branchesAndTags(bRoot)).toBe(hostBranches);
    expect(git(bRoot, 'status', '--porcelain')).toBe(hostStatus);

    const again = expectBoardError(() => syncBoard(b, { env }), 3, 'sync-in-progress');
    expect(again.message).toContain(b.dir);
    expect(rebaseInProgress(b.dir)).toBe(true);
  });

  it('completes once the human resolves the conflict and continues the rebase', () => {
    const env = syncEnv();
    const { remote, aRoot, bRoot, a, b } = conflicted(env);
    expectBoardError(() => syncBoard(b, { env }), 3, 'sync-conflict');
    writeFileSync(
      join(b.dir, '.gitignore'),
      'cache.sqlite\ncache.sqlite-wal\ncache.sqlite-shm\nonly-on-a\nonly-on-b\n',
    );
    git(b.dir, 'add', '.gitignore');
    git(b.dir, '-c', 'core.editor=true', 'rebase', '--continue');

    const resolved = syncBoard(b, { env });
    expect(resolved.pushed).toBe(true);
    expectRefAtHead(bRoot, b.dir, resolved);
    const back = syncBoard(a, { env });

    expect(back.arrived).toHaveLength(1);
    expectRefAtHead(aRoot, a.dir, back);
    expect(refEvents(aRoot)).toEqual(refEvents(bRoot));
    expect(git(remote, 'rev-parse', BOARD_REF).trim()).toBe(refCommit(aRoot));
    expect(dumpCache(a.db)).toBe(dumpCache(b.db));
  });
});

describe('preconditions of the host-model sync', () => {
  it('scenario: Board worktree on a branch: exit 3 board-on-branch, nothing staged, the fix named', () => {
    const env = syncEnv();
    const { root, dir, remote } = hostWithOrigin(env);
    git(dir, 'switch', '-q', '-c', 'scratch');
    const board = openTracked(dir);
    const [hash] = addTickets(board, 1, 'orch');
    const head = revParse(dir);

    const err = expectBoardError(() => syncBoard(board, { env }), 3, 'board-on-branch');

    expect(err.message).toContain('scratch');
    expect(err.message).toContain(`switch --detach ${BOARD_REF}`);
    expect(git(dir, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(dir, 'status', '--porcelain')).toContain(`?? events/${String(hash)}.json`);
    expect(revParse(dir)).toBe(head);
    expect(refCommit(root)).toBe(EMPTY_BOARD_COMMIT_ID);
    expect(git(remote, 'for-each-ref', 'refs/agentboard/')).toBe('');

    git(dir, 'switch', '-q', '--detach', BOARD_REF);
    git(dir, 'branch', '-q', '-D', 'scratch');
    const result = syncBoard(board, { env });
    expect(result.committedEvents).toBe(1);
    expectRefAtHead(root, dir, result);
  });

  it('exits 1 git-too-old on a git older than 2.32, staging nothing', () => {
    const base = syncEnv();
    const { root, dir, remote } = hostWithOrigin(base);
    const board = openTracked(dir);
    addTickets(board, 1, 'orch');
    const env = withGitShim(base, '2.31.8');
    expect(gitVersion(env)).toEqual({ major: 2, minor: 31, patch: 8 });

    const err = expectBoardError(() => syncBoard(board, { env }), 1, 'git-too-old');

    expect(err.message).toContain('2.31.8');
    expect(err.message).toContain(
      `${String(HOST_MODEL_GIT_FLOOR.major)}.${String(HOST_MODEL_GIT_FLOOR.minor)}`,
    );
    expect(git(dir, 'diff', '--cached', '--name-only')).toBe('');
    expect(revParse(dir)).toBe(EMPTY_BOARD_COMMIT_ID);
    expect(refCommit(root)).toBe(EMPTY_BOARD_COMMIT_ID);
    expect(git(remote, 'for-each-ref', 'refs/agentboard/')).toBe('');

    // Exactly the floor is enough.
    const atFloor = syncBoard(board, { env: withGitShim(base, '2.32.0') });
    expect(atFloor.committedEvents).toBe(1);
    expectRefAtHead(root, dir, atFloor);
  });

  it('scenario: Deleted event file is not synced (host model): exit 5 naming it, nothing staged or pushed', () => {
    const env = syncEnv();
    const { root, dir, remote } = hostWithOrigin(env);
    const board = openTracked(dir);
    const [hash] = addTickets(board, 1, 'orch');
    syncBoard(board, { env });
    const pushed = git(remote, 'rev-parse', BOARD_REF).trim();
    rmSync(join(dir, 'events', `${String(hash)}.json`));
    addTickets(board, 1, 'orch');

    const err = expectBoardError(() => syncBoard(board, { env }), 5, 'integrity');

    expect(err.message).toContain(`events/${String(hash)}.json`);
    expect(err.message).toContain('checkout');
    expect(git(dir, 'diff', '--cached', '--name-only')).toBe('');
    expect(revParse(dir)).toBe(pushed);
    expect(refCommit(root)).toBe(pushed);
    expect(git(remote, 'rev-parse', BOARD_REF).trim()).toBe(pushed);
  });

  it('warns when the host repository tracks the board directory as a gitlink, and still syncs', () => {
    const env = syncEnv();
    const { root, dir } = hostWithOrigin(env);
    // `.board/` is ignored by the host, so it is tracked only by force: as a gitlink.
    git(root, 'add', '-f', '.board');
    git(root, 'commit', '-q', '-m', 'track the board by mistake');
    const board = openTracked(dir);
    addTickets(board, 1, 'orch');

    const result = syncBoard(board, { env });

    expect(result.hostTracked).toEqual(['.board']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/warning/i);
    expectRefAtHead(root, dir, result);
  });
});

describe('the git commands of a host-model sync', () => {
  it('fetches into the worktree FETCH_HEAD with --no-tags, swaps the ref against its old value, pushes without force', () => {
    const base = syncEnv();
    const { remote, aRoot, bRoot, a, b } = twoClones(base);
    git(aRoot, 'tag', 'v1');
    git(aRoot, 'push', '-q', 'origin', 'v1');
    addTickets(a, 1, 'alice');
    syncBoard(a, { env: base });
    addTickets(b, 1, 'bob');
    const mainFetchHead = join(bRoot, '.git', 'FETCH_HEAD');
    const mainFetchHeadBefore = existsSync(mainFetchHead)
      ? readFileSync(mainFetchHead, 'utf8')
      : null;
    const { env, calls } = withRecordingGitShim(base);

    const result = syncBoard(b, { env });

    expect(result.pulled).toBe(true);
    expectRefAtHead(bRoot, b.dir, result);
    const lines = calls();
    expect(lines.length).toBeGreaterThan(0);
    const fetches = lines.filter((line) => / fetch /.test(line));
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toMatch(new RegExp(` fetch --no-tags origin ${BOARD_REF}$`));
    const pushes = lines.filter((line) => / push /.test(line));
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatch(
      new RegExp(` push --porcelain --no-verify origin HEAD:${BOARD_REF}$`),
    );
    expect(pushes[0]).not.toMatch(/--force|--mirror|--all| -f /);
    const swaps = lines.filter((line) => / update-ref /.test(line));
    expect(swaps.length).toBeGreaterThanOrEqual(1);
    for (const swap of swaps) {
      expect(swap).toMatch(new RegExp(` update-ref ${BOARD_REF} [0-9a-f]{40} [0-9a-f]{40}$`));
    }
    const rebases = lines.filter((line) => / rebase /.test(line));
    expect(rebases).toEqual([expect.stringMatching(/ rebase --no-verify FETCH_HEAD$/)]);
    // Every command that could run a hook of the host is given the empty hooks path.
    const hookable = lines.filter((l) => / (add|commit|rebase|fetch|push|update-ref) /.test(l));
    expect(hookable.length).toBeGreaterThanOrEqual(5);
    for (const line of hookable) {
      expect(line, line).toMatch(/(^| )-c core\.hooksPath=\S+ /);
    }
    expect(lines.some((line) => /(^| )(pull|checkout|switch|branch) /.test(line))).toBe(false);

    // The fetch landed in the worktree's own FETCH_HEAD and wrote no remote-tracking ref or tag.
    const worktreeFetchHead = join(worktreeGitDir(b.dir), 'FETCH_HEAD');
    expect(existsSync(worktreeFetchHead)).toBe(true);
    expect(readFileSync(worktreeFetchHead, 'utf8')).toContain(BOARD_REF);
    expect(existsSync(mainFetchHead) ? readFileSync(mainFetchHead, 'utf8') : null).toBe(
      mainFetchHeadBefore,
    );
    expect(remoteRefs(bRoot)).toEqual(['refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    expect(git(bRoot, 'tag', '--list')).toBe('');
    expect(git(remote, 'rev-parse', BOARD_REF).trim()).toBe(refCommit(bRoot));
  });

  it('the host hooks never run, and no hooks path is written to the host configuration', () => {
    const env = syncEnv();
    const { root, dir, remote } = hostWithOrigin(env);
    const gitDir = join(root, '.git');
    const preCommit = installHook(gitDir, 'pre-commit');
    const prePush = installHook(gitDir, 'pre-push');
    const preRebase = installHook(gitDir, 'pre-rebase');
    const postCheckout = installHook(gitDir, 'post-checkout');
    const board = openTracked(dir);
    addTickets(board, 1, 'orch');

    const result = syncBoard(board, { env });

    expect(result.pushed).toBe(true);
    expectRefAtHead(root, dir, result);
    expect(git(remote, 'rev-parse', BOARD_REF).trim()).toBe(refCommit(root));
    for (const marker of [preCommit, prePush, preRebase, postCheckout]) {
      expect(existsSync(marker), marker).toBe(false);
    }
    expect(() => git(root, 'config', '--local', '--get', 'core.hooksPath')).toThrow();
    const noHooks = join(worktreeGitDir(dir), 'agentboard-no-hooks');
    expect(existsSync(noHooks)).toBe(true);
    expect(readdirSync(noHooks)).toEqual([]);

    // The hooks are intact for the host itself: a normal commit there still runs pre-commit.
    writeFileSync(join(root, 'notes.txt'), 'host work\n');
    git(root, 'add', 'notes.txt');
    expect(() => git(root, 'commit', '-q', '-m', 'host commit')).toThrow();
    expect(existsSync(preCommit)).toBe(true);
  });
});

describe('scenario: Host hooks do not run for the board', () => {
  it('a failing pre-push hook of the host does not run when sync pushes', () => {
    const env = syncEnv();
    const { root, dir, remote } = hostWithOrigin(env);
    const marker = installHook(join(root, '.git'), 'pre-push');
    const board = openTracked(dir);
    const [hash] = addTickets(board, 1, 'orch');

    const result = syncBoard(board, { env });

    expect(result.pushed).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(refEvents(remote)).toEqual([`${String(hash)}.json`]);

    // The same hook refuses a plain push of the host's branch.
    writeFileSync(join(root, 'notes.txt'), 'host work\n');
    git(root, 'add', 'notes.txt');
    git(root, 'commit', '-q', '-m', 'host commit');
    expect(() => git(root, 'push', '-q', 'origin', 'main')).toThrow();
    expect(existsSync(marker)).toBe(true);
  });
});

describe('scenario: Plain clone does not fetch the board', () => {
  it('git clone and git fetch origin transfer no ref under refs/agentboard/, while ls-remote still lists it', () => {
    const env = syncEnv();
    const { dir, remote } = hostWithOrigin(env);
    const board = openTracked(dir);
    addTickets(board, 2, 'orch');
    const result = syncBoard(board, { env });
    const cloned = join(tempDir(), 'plain');
    git(tempDir(), 'clone', '-q', remote, cloned);
    git(cloned, 'fetch', '-q', 'origin');

    expect(git(cloned, 'for-each-ref', 'refs/agentboard/')).toBe('');
    expect(branchesAndTags(cloned)).toBe(`refs/heads/main ${revParse(cloned, 'main')}\n`);
    expect(remoteRefs(cloned)).toEqual(['refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    expect(existsSync(join(cloned, '.board'))).toBe(false);
    expect(git(cloned, 'ls-remote', 'origin', BOARD_REF).trim()).toBe(
      `${String(result.refCommit)}\t${BOARD_REF}`,
    );
    // Fetched explicitly, the ref arrives with its whole history.
    git(cloned, 'fetch', '-q', '--no-tags', 'origin', `${BOARD_REF}:${BOARD_REF}`);
    expect(refEvents(cloned)).toHaveLength(2);
  });
});

describe('scenario: Garbage collection keeps the board', () => {
  it('after git gc --prune=now every event file is still readable from refs/agentboard/board', () => {
    const env = syncEnv();
    const { root, dir, remote } = hostWithOrigin(env);
    const board = openTracked(dir);
    const hashes = addTickets(board, 3, 'orch');
    syncBoard(board, { env });
    const value = refCommit(root);

    git(root, 'gc', '--prune=now', '--quiet');

    expect(refCommit(root)).toBe(value);
    expect(refEvents(root)).toEqual(hashes.map((h) => `${h}.json`));
    for (const hash of hashes) {
      expect(git(root, 'cat-file', '-p', `${BOARD_REF}:events/${hash}.json`)).toBe(
        readFileSync(join(dir, 'events', `${hash}.json`), 'utf8'),
      );
    }
    expect(() => git(root, 'fsck', '--no-progress', '--connectivity-only')).not.toThrow();
    expect(git(remote, 'rev-parse', BOARD_REF).trim()).toBe(value);
  });

  it('the ref alone keeps the commits reachable: with .board deleted and pruned, gc loses nothing', () => {
    const env = syncEnv();
    const { root, dir } = hostBoard(env);
    const board = openBoard(dir);
    const hashes = addTickets(board, 2, 'orch');
    syncBoard(board, { env });
    const value = refCommit(root);
    board.db.close();
    rmSync(dir, { recursive: true, force: true });
    git(root, 'worktree', 'prune');

    git(root, 'gc', '--prune=now', '--quiet');

    expect(refCommit(root)).toBe(value);
    expect(refEvents(root)).toEqual(hashes.map((h) => `${h}.json`));
    expect(() => git(root, 'fsck', '--no-progress', '--connectivity-only')).not.toThrow();
  });
});

describe('scenario: Init with an unreachable remote, second half: a board created offline meets another root', () => {
  /**
   * A board history that began as a standalone board (a root commit holding
   * `.gitignore`, `events/.gitkeep` and one event, as `sync` makes it on a
   * standalone board), published on the bare `remote` as
   * `refs/agentboard/board`. Returns the root commit and the event hash.
   */
  function migratedBoardOn(
    remote: string,
    env: Env,
    ignoreLine?: string,
  ): { root: string; hash: string } {
    const dir = standaloneBoard(tempDir());
    git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    if (ignoreLine !== undefined) {
      appendFileSync(join(dir, '.gitignore'), `${ignoreLine}\n`);
    }
    const hash = putEvent(join(dir, 'events'), ev(P.create(T1, 'Began standalone'), 'orch', 1_000));
    const result = syncBoard(openTracked(dir), { env });
    expect(result.model).toBe('standalone');
    git(dir, 'push', '-q', remote, `main:${BOARD_REF}`);
    return { root: revParse(dir), hash };
  }

  it('the empty-board root rebases cleanly onto the remote history and both event sets are kept', () => {
    const env = syncEnv();
    const { root, dir, remote } = hostWithOrigin(env);
    const other = migratedBoardOn(remote, env);
    expect(git(root, 'rev-list', '--max-parents=0', BOARD_REF).trim()).toBe(EMPTY_BOARD_COMMIT_ID);
    expect(other.root).not.toBe(EMPTY_BOARD_COMMIT_ID);
    const board = openTracked(dir);
    const [mine] = addTickets(board, 1, 'orch');

    const result = syncBoard(board, { env });

    expect(result).toMatchObject({ committedEvents: 1, pulled: true, pushed: true });
    expect(result.arrived).toEqual([other.hash]);
    expectRefAtHead(root, dir, result);
    expect(rebaseInProgress(dir)).toBe(false);
    expect(git(root, 'rev-list', '--max-parents=0', BOARD_REF).trim()).toBe(other.root);
    expect(git(root, 'rev-list', '--count', BOARD_REF).trim()).toBe('2');
    expect(refEvents(root)).toEqual([other.hash, String(mine)].map((h) => `${h}.json`).sort());
    expect(git(remote, 'rev-parse', BOARD_REF).trim()).toBe(refCommit(root));
    expect(eventFiles(dir)).toEqual(refEvents(root));
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe(
      'cache.sqlite\ncache.sqlite-wal\ncache.sqlite-shm\n',
    );
    expect(listTickets(board)).toHaveLength(2);
    expect(checkCache(board).ok).toBe(true);
  });

  it('a .gitignore changed differently on both sides is an ordinary conflict', () => {
    const env = syncEnv();
    const { root, dir, remote } = hostWithOrigin(env);
    migratedBoardOn(remote, env, 'remote-only');
    appendFileSync(join(dir, '.gitignore'), 'offline-only\n');
    const board = openTracked(dir);
    addTickets(board, 1, 'orch');

    const err = expectBoardError(() => syncBoard(board, { env }), 3, 'sync-conflict');

    expect(err.message).toContain('.gitignore');
    expect(rebaseInProgress(dir)).toBe(true);
    expect(refs(root)).toContain(BOARD_REF);
  });
});

describe('a second sync during the rebase of a first', () => {
  it('exits 3 sync-in-progress while the first holds the worktree in its rebase, and the first completes', () => {
    const base = syncEnv();
    const { remote, aRoot, bRoot, a, b } = twoClones(base);
    addTickets(b, 1, 'bob');
    syncBoard(b, { env: base });
    const [fromA] = addTickets(a, 1, 'alice');
    const outcome = join(tempDir(), 'second-sync');
    // The shim replaces the first sync's rebase onto FETCH_HEAD by the same
    // rebase with an exec step after each replayed commit, which runs a
    // second sync through the built CLI while git's rebase is still in
    // progress (its state directory exists), and records how it ended; the
    // shim exits with the rebase's status instead of running the command
    // a second time.
    const second =
      `'${process.execPath}' '${BUILT_CLI}' sync --json > '${outcome}.out' 2> '${outcome}.err'; ` +
      `echo $? > '${outcome}.code'`;
    const env = withGitShimBefore(
      base,
      ['rebase', '--no-verify', 'FETCH_HEAD'],
      `"$GIT" "$@" -x "${second.replace(/["$]/g, '\\$&')}"; exit $?`,
    );

    const first = syncBoard(a, { env });

    expect(readFileSync(`${outcome}.code`, 'utf8').trim()).toBe('3');
    const document = JSON.parse(readFileSync(`${outcome}.out`, 'utf8')) as {
      error: { exitCode: number; reason: string; message: string };
    };
    expect(document.error).toMatchObject({ exitCode: 3, reason: 'sync-in-progress' });
    expect(document.error.message).toContain(a.dir);
    expect(readFileSync(`${outcome}.err`, 'utf8')).toMatch(/^agentboard: .*rebase/m);
    expect(first).toMatchObject({ committedEvents: 1, pulled: true, pushed: true });
    expect(first.arrived).toHaveLength(1);
    expectRefAtHead(aRoot, a.dir, first);
    expect(rebaseInProgress(a.dir)).toBe(false);
    expect(git(remote, 'rev-parse', BOARD_REF).trim()).toBe(refCommit(aRoot));
    expect(refEvents(remote)).toContain(`${String(fromA)}.json`);
    expect(refEvents(remote)).toHaveLength(2);
    expect(git(a.dir, 'status', '--porcelain')).toBe('');
    syncBoard(b, { env: base });
    expect(refCommit(bRoot)).toBe(refCommit(aRoot));
  });
});

describe('the standalone path is unchanged', () => {
  it('reports model standalone with no ref, and a detached standalone board is still refused', () => {
    const env = syncEnv();
    const dir = standaloneBoard(tempDir());
    git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    const board = openTracked(dir);
    addTickets(board, 1, 'orch');

    const result = syncBoard(board, { env });

    expect(result).toMatchObject({
      model: 'standalone',
      ref: null,
      refCommit: null,
      branch: 'main',
    });
    git(dir, 'checkout', '-q', '--detach');
    expectBoardError(() => syncBoard(board, { env }), 3, 'detached-head');
  });
});
