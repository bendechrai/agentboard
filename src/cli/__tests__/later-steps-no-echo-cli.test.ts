/**
 * Every later git step that talks to a remote quotes git sanitised
 * (no-echo-refusals group 2, review round 1 addendum: reviewer-ne2-1
 * finding 1 and 3; board-cli "Git lines quoted from remote commands"),
 * through the built CLI, plain and `--json`. The remote's configured (or
 * given) URL holds a credential and a token (`credentialedUrl`), git uses
 * a local bare repository for it (`rewriteToLocal`), so `ls-remote`
 * succeeds; a `git` shim then fails exactly one later step with a line
 * quoting that URL (`withFailingGit`). Steps: the standalone `sync` pull
 * and push, the host-model `sync` fetch of the board ref and a push that
 * fails without a rejection, the two fetches of `init --into-host`, the
 * `clone` and the checkout of `init --remote`, and the fetch of the
 * host-model `init` join after a successful `ls-remote`. Each step whose
 * quote dropped the sanitiser fails here. Nothing leaves 127.0.0.1.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { expectNoLeak } from '../../__tests__/harness/secret-fixtures.js';
import { git, tempDir } from '../../board/__tests__/helpers.js';
import { standaloneProject, writeEvents } from '../../board/__tests__/into-host-helpers.js';
import {
  credentialedUrl,
  localEnv,
  rewriteToLocal,
  withFailingGit,
} from '../../board/__tests__/no-echo-remote-helpers.js';
import {
  emptyBoardCommit,
  hostBoard,
  hostRepo,
  standaloneBoard,
} from '../../board/__tests__/sharing-helpers.js';
import { bareRemote, revParse, type Env } from '../../board/__tests__/sync-helpers.js';
import { BOARD_REF } from '../../board/model.js';
import { oneJson, spawnCli, type Run } from './cli-helpers.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/** The line every failing step prints: git's form, quoting the credentialed URL whole. */
function failure(url: string): string {
  return `fatal: unable to access '${url}/': shim refused`;
}

/** What that line becomes once sanitised. */
const SANITISED = "fatal: unable to access '<url>/': shim refused";

/** The message of a failed run: the `--json` error message, or the first stderr line without `agentboard: `. */
function messageOf(out: Run, json: boolean): string {
  if (json) {
    return (oneJson(out) as { error: { message: string } }).error.message;
  }
  return (out.stderr.split('\n')[0] ?? '').replace(/^agentboard: /, '');
}

/**
 * Runs `argv` in a fresh fixture from `setup`, plain and with `--json`;
 * each run exits `code`, its message is exactly `message(json)`, and no
 * fixture leaks.
 */
function expectStep(
  setup: () => { cwd: string; env: Env },
  argv: readonly string[],
  code: number,
  message: string,
): void {
  for (const json of [false, true]) {
    const { cwd, env } = setup();
    const out = spawnCli([...argv, ...(json ? ['--json'] : [])], cwd, env);
    expectNoLeak(out.stdout + out.stderr);
    expect(out.code, out.stderr).toBe(code);
    expect(messageOf(out, json)).toBe(message);
  }
}

/**
 * A standalone board at `<temp>/proj/.board` synced once to a bare
 * remote (so `main` tracks `origin/main`), whose `origin` is then set to
 * `url`, rewritten to that bare remote; one more event is left unsynced.
 */
function syncedStandaloneAt(url: string): { root: string; env: Env } {
  const env = localEnv();
  const bare = bareRemote();
  const root = join(tempDir(), 'proj');
  const dir = standaloneBoard(root);
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(dir, 'remote', 'add', 'origin', bare);
  writeEvents(dir, 1);
  const first = spawnCli(['sync'], root, env);
  expect(first.code, first.stderr).toBe(0);
  git(dir, 'remote', 'set-url', 'origin', url);
  rewriteToLocal(env, url, bare);
  writeEvents(dir, 1, 'orch', 1);
  return { root, env };
}

/** A bare repository holding an empty board at `refs/agentboard/board`. */
function bareWithBoardRef(): string {
  const bare = bareRemote();
  git(bare, 'update-ref', BOARD_REF, emptyBoardCommit(bare));
  return bare;
}

describe('standalone sync: pull and push', () => {
  it('pull fails after ls-remote: pulling from origin, git quoted sanitised', () => {
    const url = credentialedUrl();
    expectStep(
      () => {
        const { root, env } = syncedStandaloneAt(url);
        return { cwd: root, env: withFailingGit(env, ['pull'], failure(url)) };
      },
      ['sync'],
      3,
      `pulling from origin failed: ${SANITISED}`,
    );
  });

  it('push fails without a rejection: pushing to origin, git quoted sanitised', () => {
    const url = credentialedUrl();
    expectStep(
      () => {
        const { root, env } = syncedStandaloneAt(url);
        return { cwd: root, env: withFailingGit(env, ['push'], failure(url)) };
      },
      ['sync'],
      3,
      `pushing to origin failed: ${SANITISED}`,
    );
  });
});

describe('host-model sync: the board ref fetch and a push failure', () => {
  /** A host-model board whose `origin` is `url`, rewritten to `bare`, with one unsynced event. */
  function hostAt(url: string, bare: string): { cwd: string; env: Env } {
    const env = localEnv();
    const { root, dir } = hostBoard(env);
    git(root, 'remote', 'add', 'origin', url);
    rewriteToLocal(env, url, bare);
    writeEvents(dir, 1);
    return { cwd: root, env };
  }

  it('the fetch of refs/agentboard/board fails after ls-remote listed it', () => {
    const url = credentialedUrl();
    expectStep(
      () => {
        const { cwd, env } = hostAt(url, bareWithBoardRef());
        return { cwd, env: withFailingGit(env, ['fetch', BOARD_REF], failure(url)) };
      },
      ['sync'],
      3,
      `fetching ${BOARD_REF} from origin failed: ${SANITISED}`,
    );
  });

  it('the push fails without a rejection', () => {
    const url = credentialedUrl();
    expectStep(
      () => {
        const { cwd, env } = hostAt(url, bareRemote());
        return { cwd, env: withFailingGit(env, ['push'], failure(url)) };
      },
      ['sync'],
      3,
      `pushing ${BOARD_REF} to origin failed: ${SANITISED}`,
    );
  });
});

describe('init --into-host: the fetch from the board remote and the fetch of the host board ref', () => {
  /**
   * A project with a synced standalone board: the board's `origin` is
   * `boardUrl` and the host's `origin` is `hostUrl`, each rewritten to its
   * bare repository; the host's holds a board ref when `hostHasBoard`.
   */
  function project(boardUrl: string, hostUrl: string, hostHasBoard: boolean): { cwd: string; env: Env } {
    const env = localEnv();
    const { root, dir, boardRemote } = standaloneProject(env, 2);
    git(dir, 'remote', 'set-url', 'origin', boardUrl);
    rewriteToLocal(env, boardUrl, boardRemote);
    const hostBare = hostHasBoard ? bareWithBoardRef() : bareRemote();
    git(root, 'remote', 'set-url', 'origin', hostUrl);
    rewriteToLocal(env, hostUrl, hostBare);
    return { cwd: root, env };
  }

  it("the fetch of the board's branch from the board remote", () => {
    const boardUrl = credentialedUrl('board');
    const hostUrl = credentialedUrl('host');
    expectStep(
      () => {
        const { cwd, env } = project(boardUrl, hostUrl, false);
        return {
          cwd,
          env: withFailingGit(env, ['fetch', '+refs/heads/main:refs/remotes/origin/main'], failure(boardUrl)),
        };
      },
      ['init', '--into-host'],
      3,
      `fetching main from origin failed: ${SANITISED}`,
    );
  });

  it('the fetch of refs/agentboard/board from the host remote after ls-remote listed it', () => {
    const boardUrl = credentialedUrl('board');
    const hostUrl = credentialedUrl('host');
    expectStep(
      () => {
        const { cwd, env } = project(boardUrl, hostUrl, true);
        return { cwd, env: withFailingGit(env, ['fetch', BOARD_REF], failure(hostUrl)) };
      },
      ['init', '--into-host'],
      3,
      `fetching ${BOARD_REF} from origin failed: ${SANITISED}`,
    );
  });
});

describe('init --remote: the clone and the checkout after ls-remote', () => {
  /** A bare repository holding a standalone board with one committed event on `branch`, HEAD at `head`. */
  function boardBare(branch: string, head: string): string {
    const source = standaloneBoard(join(tempDir(), 'source'));
    git(source, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`);
    writeEvents(source, 1);
    git(source, 'add', '-A');
    git(source, 'commit', '-q', '-m', 'one');
    const bare = join(tempDir(), 'board.git');
    git(tempDir(), 'clone', '-q', '--bare', source, bare);
    git(bare, 'symbolic-ref', 'HEAD', `refs/heads/${head}`);
    expect(revParse(bare, branch)).toMatch(/^[0-9a-f]{40}$/);
    return bare;
  }

  /** A fresh, empty project directory. */
  function plainProject(): string {
    const root = join(tempDir(), 'proj');
    mkdirSync(root);
    return root;
  }

  it('the clone fails: could not be cloned, git quoted sanitised', () => {
    const url = credentialedUrl();
    expectStep(
      () => {
        const env = localEnv();
        rewriteToLocal(env, url, boardBare('main', 'main'));
        return { cwd: plainProject(), env: withFailingGit(env, ['clone'], failure(url)) };
      },
      ['init', '--remote', url],
      3,
      `the repository given with --remote could not be cloned (${SANITISED}); create an empty ` +
        'repository there (for example on your git host) and check your access to it, then run ' +
        'agentboard init --remote again',
    );
  });

  it('the checkout of the only branch fails: cannot be checked out, git quoted sanitised', () => {
    const url = credentialedUrl();
    expectStep(
      () => {
        const env = localEnv();
        rewriteToLocal(env, url, boardBare('master', 'main'));
        return { cwd: plainProject(), env: withFailingGit(env, ['checkout', '--track'], failure(url)) };
      },
      ['init', '--remote', url],
      1,
      `the repository given with --remote holds no board: its branch master cannot be checked out ` +
        `(${SANITISED}); --remote needs an empty repository, or one that holds a board`,
    );
  });
});

describe('the host-model init join: the fetch after a successful ls-remote', () => {
  it('decision: a sync-failed refusal quoting git sanitised, never a raw error carrying the URL', () => {
    const url = credentialedUrl();
    expectStep(
      () => {
        const env = localEnv();
        const root = hostRepo();
        git(root, 'remote', 'add', 'origin', url);
        rewriteToLocal(env, url, bareWithBoardRef());
        return { cwd: root, env: withFailingGit(env, ['fetch', `${BOARD_REF}:${BOARD_REF}`], failure(url)) };
      },
      ['init'],
      3,
      `fetching ${BOARD_REF} from origin failed: ${SANITISED}`,
    );
  });
});
