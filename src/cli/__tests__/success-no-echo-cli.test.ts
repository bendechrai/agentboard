/**
 * Remote URLs are shown without credentials (no-echo-refusals group 2,
 * review round 1 addendum, reversing design.md's exclusion of success
 * output; board-cli "Remote URLs are shown without credentials"), through
 * the built CLI: the success messages and the `--json` `remoteUrl` of
 * `init --remote` (created, cloned, attached, unchanged), `agentboard
 * remote` (text and `--json`, standalone and host model), `sync`, the
 * host-model `init` join and `init --into-host` show a configured or
 * given URL with its user information removed (`withoutUserinfo`), never
 * the credential; so does the `remote-mismatch` refusal for the URL the
 * board is configured with. git keeps the URL as configured. Each URL is
 * on a closed port of 127.0.0.1 and rewritten to a local bare repository.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { expectNoLeak } from '../../__tests__/harness/secret-fixtures.js';
import { git, tempDir } from '../../board/__tests__/helpers.js';
import { standaloneProject, writeEvents } from '../../board/__tests__/into-host-helpers.js';
import {
  CLOSED_PORT,
  URL_TOKEN,
  localEnv,
  rewriteToLocal,
} from '../../board/__tests__/no-echo-remote-helpers.js';
import {
  emptyBoardCommit,
  hostBoard,
  hostRepo,
  standaloneBoard,
} from '../../board/__tests__/sharing-helpers.js';
import { bareRemote, type Env } from '../../board/__tests__/sync-helpers.js';
import { BOARD_REF } from '../../board/model.js';
import { oneJson, spawnCli, type Run } from './cli-helpers.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/** A URL with a credential and nothing secret in its path, and the form agentboard shows. */
function urls(name = 'x'): { url: string; shown: string } {
  return {
    url: `http://agent:${URL_TOKEN}@127.0.0.1:${CLOSED_PORT}/${name}.git`,
    shown: `http://127.0.0.1:${CLOSED_PORT}/${name}.git`,
  };
}

/** A fresh, empty project directory. */
function plainProject(): string {
  const root = join(tempDir(), 'proj');
  mkdirSync(root);
  return root;
}

/** A successful run: exit 0, no fixture anywhere. */
function ok(out: Run): Run {
  expectNoLeak(out.stdout + out.stderr);
  expect(out.code, out.stderr).toBe(0);
  return out;
}

/** A bare repository holding a standalone board with one committed event on `main`. */
function boardBare(): string {
  const source = standaloneBoard(join(tempDir(), 'source'));
  git(source, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  writeEvents(source, 1);
  git(source, 'add', '-A');
  git(source, 'commit', '-q', '-m', 'one');
  const bare = join(tempDir(), 'board.git');
  git(tempDir(), 'clone', '-q', '--bare', source, bare);
  return bare;
}

/** `init --remote <url>` plain and `--json` in fresh fixtures from `setup`; the URL shown is `shown`. */
function expectInitRemote(setup: (env: Env) => string, url: string, shown: string, action: string): void {
  for (const json of [false, true]) {
    const env = localEnv();
    const cwd = setup(env);
    const out = ok(spawnCli(['init', '--remote', url, ...(json ? ['--json'] : [])], cwd, env));
    if (json) {
      const doc = oneJson(out) as { action: string; remoteUrl: string; message: string };
      expect(doc.action).toBe(action);
      expect(doc.remoteUrl).toBe(shown);
      expect(doc.message).toContain(shown);
    } else {
      expect(out.stdout).toContain(shown);
    }
  }
}

describe('init --remote shows the URL without its credentials', () => {
  it('created (an empty remote)', () => {
    const { url, shown } = urls();
    expectInitRemote(
      (env) => {
        rewriteToLocal(env, url, bareRemote());
        return plainProject();
      },
      url,
      shown,
      'created',
    );
  });

  it('cloned (a remote that holds a board)', () => {
    const { url, shown } = urls();
    expectInitRemote(
      (env) => {
        rewriteToLocal(env, url, boardBare());
        return plainProject();
      },
      url,
      shown,
      'cloned',
    );
  });

  it('attached (a board without a remote)', () => {
    const { url, shown } = urls();
    expectInitRemote(
      (env) => {
        rewriteToLocal(env, url, bareRemote());
        const root = join(tempDir(), 'proj');
        const dir = standaloneBoard(root);
        git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
        writeEvents(dir, 1);
        return root;
      },
      url,
      shown,
      'attached',
    );
  });

  it('unchanged (the board already has that remote)', () => {
    const { url, shown } = urls();
    expectInitRemote(
      (env) => {
        rewriteToLocal(env, url, bareRemote());
        const root = join(tempDir(), 'proj');
        const dir = standaloneBoard(root);
        git(dir, 'remote', 'add', 'origin', url);
        return root;
      },
      url,
      shown,
      'unchanged',
    );
  });

  it('decision: remote-mismatch names the configured URL without its credentials', () => {
    const { url, shown } = urls('configured');
    for (const json of [false, true]) {
      const root = join(tempDir(), 'proj');
      const dir = standaloneBoard(root);
      git(dir, 'remote', 'add', 'origin', url);
      const out = spawnCli(
        ['init', '--remote', 'https://other.example/y.git', ...(json ? ['--json'] : [])],
        root,
        localEnv(),
      );
      expectNoLeak(out.stdout + out.stderr);
      expect(out.code).toBe(1);
      expect(out.stdout + out.stderr).toContain(`already has the remote origin at ${shown}, not the URL given`);
    }
  });
});

describe('agentboard remote shows URLs without credentials', () => {
  it('standalone board: the chosen remote line and the remotes list, text and --json', () => {
    const { url, shown } = urls();
    const other = urls('second');
    const env = localEnv();
    const root = join(tempDir(), 'proj');
    const dir = standaloneBoard(root);
    git(dir, 'remote', 'add', 'origin', url);
    git(dir, 'remote', 'add', 'second', other.url);

    const text = ok(spawnCli(['remote'], root, env));
    expect(text.stdout).toContain(`remote: origin ${shown} (chosen by `);
    expect(text.stdout).toContain(`  origin  ${shown}`);
    expect(text.stdout).toContain(`  second  ${other.shown}`);

    const json = ok(spawnCli(['remote', '--json'], root, env));
    expect(json.stdout).toContain(JSON.stringify(shown));
    expect(json.stdout).toContain(JSON.stringify(other.shown));
    // git keeps the URL as configured.
    expect(git(dir, 'config', '--get', 'remote.origin.url').trim()).toBe(url);
  });

  it('host-model board', () => {
    const { url, shown } = urls();
    const env = localEnv();
    const { root } = hostBoard(env);
    git(root, 'remote', 'add', 'origin', url);
    expect(ok(spawnCli(['remote'], root, env)).stdout).toContain(`remote: origin ${shown} (chosen by `);
    expect(ok(spawnCli(['remote', '--json'], root, env)).stdout).toContain(JSON.stringify(shown));
  });
});

describe('sync, the host-model init join and init --into-host succeed without showing credentials', () => {
  it('standalone sync to a credentialed origin', () => {
    const { url } = urls();
    for (const json of [false, true]) {
      const env = localEnv();
      rewriteToLocal(env, url, bareRemote());
      const root = join(tempDir(), 'proj');
      const dir = standaloneBoard(root);
      git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
      git(dir, 'remote', 'add', 'origin', url);
      writeEvents(dir, 1);
      ok(spawnCli(['sync', ...(json ? ['--json'] : [])], root, env));
    }
  });

  it('host-model sync and the init join of a host whose origin holds a board', () => {
    const { url } = urls();
    for (const json of [false, true]) {
      const env = localEnv();
      const bare = bareRemote();
      git(bare, 'update-ref', BOARD_REF, emptyBoardCommit(bare));
      rewriteToLocal(env, url, bare);
      const root = hostRepo();
      git(root, 'remote', 'add', 'origin', url);
      ok(spawnCli(['init', ...(json ? ['--json'] : [])], root, env));
      ok(spawnCli(['sync', ...(json ? ['--json'] : [])], root, env));
    }
  });

  it('init --into-host with credentialed board and host remotes', () => {
    for (const json of [false, true]) {
      const env = localEnv();
      const board = urls('board');
      const host = urls('host');
      const { root, dir, remote, boardRemote } = standaloneProject(env, 2);
      git(dir, 'remote', 'set-url', 'origin', board.url);
      rewriteToLocal(env, board.url, boardRemote);
      git(root, 'remote', 'set-url', 'origin', host.url);
      rewriteToLocal(env, host.url, remote);
      ok(spawnCli(['init', '--into-host', ...(json ? ['--json'] : [])], root, env));
    }
  });
});
