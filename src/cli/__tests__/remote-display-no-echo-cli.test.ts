/**
 * Review round 2 of no-echo-refusals group 2 (reviewer-ne2-2 R1 to R5 and
 * reviewer-ne2-1 N03, N34 at 63cfb1b; orchestrator DECISIONs on ticket
 * 01M5YAB4PJQSSMGDM2XZAQA5FZ; board-cli "Remote URLs are shown without
 * credentials" and "Git lines quoted from remote commands"), through the
 * built CLI, plain and `--json`:
 *
 * - R1: a remote named by URL (`agentboard.remote`, `branch.<b>.remote`)
 *   is shown without its user information on success: `sync`'s pulled
 *   and pushed lines and its `--json` `remote`, standalone and host model,
 *   and `agentboard remote`'s `remote:` and `problem:` lines and `--json`
 *   `remote.name`.
 * - R2: a proxy URL with two raw `@` (git 2.53 splits it at the first).
 * - R3: a proxy user name with a raw `#` or `?` (curl on git 2.32 takes
 *   the text before it for the proxy host and prints it). The user name
 *   holds a label longer than 63 characters, which the resolver refuses
 *   before sending any query, so no DNS lookup leaves the machine.
 * - R5: a remote named by a relative path (a guard).
 * - N03: the host-model push that loses the race for the board ref on its
 *   last retry quotes git sanitised.
 * - N34: the old remote URL `init --into-host` reports when it resumes a
 *   move is the configured URL without its user information.
 *
 * Only 127.0.0.1 is contacted.
 */

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { expectNoLeak } from '../../__tests__/harness/secret-fixtures.js';
import { git, tempDir } from '../../board/__tests__/helpers.js';
import { standaloneProject, writeEvents } from '../../board/__tests__/into-host-helpers.js';
import {
  CLOSED_PORT,
  GH_TOKEN,
  URL_TOKEN,
  localEnv,
  rewriteToLocal,
  startProxyServer,
  type AuthServer,
} from '../../board/__tests__/no-echo-remote-helpers.js';
import {
  emptyBoardCommit,
  hostBoard,
  realGit,
  standaloneBoard,
  withKillingGitShim,
} from '../../board/__tests__/sharing-helpers.js';
import { bareRemote, type Env } from '../../board/__tests__/sync-helpers.js';
import { MIGRATING_REF } from '../../board/into-host.js';
import { BOARD_REF } from '../../board/model.js';
import { oneJson, spawnCli, type Run } from './cli-helpers.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/** A remote named by a URL with a credential, and the form agentboard shows it in. */
const NAMED = {
  url: `http://agent:${URL_TOKEN}@127.0.0.1:${CLOSED_PORT}/r.git`,
  shown: `http://127.0.0.1:${CLOSED_PORT}/r.git`,
};

/** Both outputs of a run. */
function all(out: Run): string {
  return out.stdout + out.stderr;
}

/** A successful run with no fixture anywhere. */
function ok(out: Run): Run {
  expectNoLeak(all(out));
  expect(out.code, out.stderr).toBe(0);
  return out;
}

/** The message of a failed run: the `--json` error message, or the first stderr line without `agentboard: `. */
function messageOf(out: Run, json: boolean): string {
  if (json) {
    return (oneJson(out) as { error: { message: string } }).error.message;
  }
  return (out.stderr.split('\n')[0] ?? '').replace(/^agentboard: /, '');
}

/** How a standalone board names its remote by URL. */
type Naming = 'agentboard.remote' | 'branch.main.remote';

/** A standalone board at `<temp>/proj/.board` on `main` with one event, its remote named by `NAMED.url` through `naming`, rewritten to a bare repository. */
function standaloneNamedByUrl(naming: Naming): { root: string; env: Env } {
  const env = localEnv();
  rewriteToLocal(env, NAMED.url, bareRemote());
  const root = join(tempDir(), 'proj');
  const dir = standaloneBoard(root);
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(dir, 'config', naming, NAMED.url);
  if (naming === 'branch.main.remote') {
    git(dir, 'config', 'branch.main.merge', 'refs/heads/main');
  }
  writeEvents(dir, 1);
  return { root, env };
}

describe('R1: a remote named by URL is shown without its user information on success', () => {
  it.each(['agentboard.remote', 'branch.main.remote'] as const)('standalone sync, %s', (naming) => {
    for (const json of [false, true]) {
      const { root, env } = standaloneNamedByUrl(naming);
      const out = ok(spawnCli(['sync', ...(json ? ['--json'] : [])], root, env));
      if (json) {
        const doc = oneJson(out) as { remote: string; message: string };
        expect(doc.remote).toBe(NAMED.shown);
        expect(doc.message).toContain(`pushed main to ${NAMED.shown}`);
      } else {
        expect(out.stdout).toContain(`pushed main to ${NAMED.shown}`);
      }
    }
  });

  it('host-model sync, agentboard.remote', () => {
    for (const json of [false, true]) {
      const env = localEnv();
      const bare = bareRemote();
      rewriteToLocal(env, NAMED.url, bare);
      const { root, dir } = hostBoard(env);
      git(root, 'config', 'agentboard.remote', NAMED.url);
      writeEvents(dir, 1);
      const out = ok(spawnCli(['sync', ...(json ? ['--json'] : [])], root, env));
      if (json) {
        expect((oneJson(out) as { remote: string }).remote).toBe(NAMED.shown);
      }
      expect(all(out)).toContain(NAMED.shown);
    }
  });

  it.each(['agentboard.remote', 'branch.main.remote'] as const)(
    'agentboard remote, %s: the remote: and problem: lines and --json remote.name',
    (naming) => {
      const { root, env } = standaloneNamedByUrl(naming);
      const text = ok(spawnCli(['remote'], root, env));
      expect(text.stdout).toContain(`remote: ${NAMED.shown} (chosen by `);
      const json = ok(spawnCli(['remote', '--json'], root, env));
      const doc = oneJson(json) as { remote: { name: string } | null };
      expect(doc.remote?.name).toBe(NAMED.shown);
    },
  );

  it('agentboard remote names an unreachable remote named by URL without its credential (problem: line)', () => {
    const root = join(tempDir(), 'proj');
    const dir = standaloneBoard(root);
    git(dir, 'config', 'agentboard.remote', NAMED.url);
    const env = localEnv();
    const text = ok(spawnCli(['remote'], root, env));
    expect(text.stdout).toContain(NAMED.shown);
    ok(spawnCli(['remote', '--json'], root, env));
  });
});

describe('R2 and R3: proxy user information that git and curl split differently', () => {
  let proxy: AuthServer;
  beforeAll(async () => {
    proxy = await startProxyServer();
  });
  afterAll(() => {
    proxy.stop();
  });

  /** A standalone board with one event and `origin` on a closed port. */
  function board(): string {
    const root = join(tempDir(), 'proj');
    const dir = standaloneBoard(root);
    git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    git(dir, 'remote', 'add', 'origin', `http://127.0.0.1:${CLOSED_PORT}/x.git`);
    writeEvents(dir, 1);
    return root;
  }

  /** The environment of a proxy test: no proxy bypass, and `http_proxy`. */
  const proxyEnv = (value: string): Env =>
    localEnv({ no_proxy: undefined, NO_PROXY: undefined, http_proxy: value });

  it('R2: http_proxy with two raw @ (http://a@<token>%40x@proxy), 407', () => {
    for (const json of [false, true]) {
      const value = `http://a@${GH_TOKEN}%40x@127.0.0.1:${proxy.port}`;
      const out = spawnCli(['sync', ...(json ? ['--json'] : [])], board(), proxyEnv(value));
      expectNoLeak(all(out));
      expect(out.code, out.stderr).toBe(3);
      expect(messageOf(out, json)).toMatch(/^reaching origin failed: fatal: /);
    }
  });

  it.each(['#', '?'])('R3: http_proxy whose user name holds a raw %s, the proxy unreachable', (mark) => {
    for (const json of [false, true]) {
      // A label of more than 63 characters: the resolver refuses it locally.
      const value = `http://${GH_TOKEN}${'x'.repeat(30)}${mark}x@127.0.0.1:${CLOSED_PORT}`;
      const out = spawnCli(['sync', ...(json ? ['--json'] : [])], board(), proxyEnv(value));
      expectNoLeak(all(out));
      expect(out.code, out.stderr).toBe(3);
      expect(messageOf(out, json)).toMatch(/^reaching origin failed: fatal: /);
    }
  });
});

describe('R5: a remote named by a relative path (guard)', () => {
  it('branch.main.remote set to ../<token>/repo.git: reaching <url> failed, git quoted with <url>', () => {
    for (const json of [false, true]) {
      const root = join(tempDir(), 'proj');
      const dir = standaloneBoard(root);
      git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
      git(dir, 'config', 'branch.main.remote', `../${GH_TOKEN}/repo.git`);
      git(dir, 'config', 'branch.main.merge', 'refs/heads/main');
      writeEvents(dir, 1);
      const out = spawnCli(['sync', ...(json ? ['--json'] : [])], root, localEnv());
      expectNoLeak(all(out));
      expect(out.code, out.stderr).toBe(3);
      expect(messageOf(out, json)).toMatch(/^(reaching|pulling from) <url> failed: /);
    }
  });
});

describe('N03: the host-model push that loses the race on its last retry', () => {
  /**
   * `env` with a `git` shim that, before every `push`, moves
   * `refs/agentboard/board` in `bare` to a new commit (so every push is
   * rejected as stale), prints `line` on stderr, then runs the real push
   * and exits with its status.
   */
  function racingPushEnv(env: Env, bare: string, line: string): Env {
    const dir = join(tempDir(), 'racing-git-bin');
    mkdirSync(dir);
    const real = realGit();
    const q = (text: string): string => `'${text.replace(/'/g, "'\\''")}'`;
    writeFileSync(
      join(dir, 'git'),
      [
        '#!/bin/sh',
        `found=0; for a in "$@"; do [ "$a" = push ] && found=1; done`,
        `[ "$found" = 1 ] || exec ${q(real)} "$@"`,
        `old=$(${q(real)} --git-dir=${q(bare)} rev-parse ${BOARD_REF})`,
        `tree=$(${q(real)} --git-dir=${q(bare)} rev-parse "$old^{tree}")`,
        `new=$(${q(real)} --git-dir=${q(bare)} commit-tree "$tree" -p "$old" -m race)`,
        `${q(real)} --git-dir=${q(bare)} update-ref ${BOARD_REF} "$new" "$old"`,
        `printf '%s\\n' ${q(line)} >&2`,
        `${q(real)} "$@"`,
        'exit $?',
        '',
      ].join('\n'),
    );
    chmodSync(join(dir, 'git'), 0o755);
    return { ...env, PATH: `${dir}:${env.PATH ?? process.env.PATH ?? ''}` };
  }

  it('sync-failed quoting the sanitised line, the credential nowhere', () => {
    const url = `http://agent:${URL_TOKEN}@127.0.0.1:${CLOSED_PORT}/${GH_TOKEN}.git`;
    for (const json of [false, true]) {
      const env = localEnv();
      const bare = bareRemote();
      git(bare, 'update-ref', BOARD_REF, emptyBoardCommit(bare));
      rewriteToLocal(env, url, bare);
      const { root, dir } = hostBoard(env);
      git(root, 'remote', 'add', 'origin', url);
      writeEvents(dir, 1);
      const out = spawnCli(
        ['sync', ...(json ? ['--json'] : [])],
        root,
        racingPushEnv(env, bare, `error: failed to push some refs to '${url}'`),
      );
      expectNoLeak(all(out));
      expect(out.code, out.stderr).toBe(3);
      expect(messageOf(out, json)).toBe(
        `pushing ${BOARD_REF} to origin failed: error: failed to push some refs to '<url>'`,
      );
    }
  });
});

describe('N34: init --into-host reports the old remote URL without its user information', () => {
  /** A project whose standalone board's `origin` is a credentialed URL rewritten to its bare remote. */
  function credentialedProject(env: Env): { root: string; shown: string } {
    const url = `http://agent:${URL_TOKEN}@127.0.0.1:${CLOSED_PORT}/board.git`;
    const { root, dir, boardRemote } = standaloneProject(env, 2);
    git(dir, 'remote', 'set-url', 'origin', url);
    rewriteToLocal(env, url, boardRemote);
    return { root, shown: `http://127.0.0.1:${CLOSED_PORT}/board.git` };
  }

  it('moved: oldRemoteUrl and the kept line', () => {
    const env = localEnv();
    const { root, shown } = credentialedProject(env);
    const out = ok(spawnCli(['init', '--into-host', '--json'], root, env));
    const doc = oneJson(out) as { action: string; oldRemoteUrl: string | null; message: string };
    expect(doc.action).toBe('moved');
    expect(doc.oldRemoteUrl).toBe(shown);
    expect(doc.message).toContain(`its remote was ${shown}`);
  });

  it('resumed after a kill past the worktree move: oldRemoteUrl read from the kept repository', () => {
    for (const json of [false, true]) {
      const env = localEnv();
      const { root, shown } = credentialedProject(env);
      const killed = spawnCli(
        ['init', '--into-host'],
        root,
        withKillingGitShim(env, ['update-ref', '-d', MIGRATING_REF], 'after'),
      );
      expectNoLeak(all(killed));
      expect(killed.code).not.toBe(0);
      const out = ok(spawnCli(['init', '--into-host', ...(json ? ['--json'] : [])], root, env));
      if (json) {
        const doc = oneJson(out) as { action: string; oldRemoteUrl: string | null };
        expect(doc).toMatchObject({ action: 'resumed', oldRemoteUrl: shown });
      } else {
        expect(out.stdout).toContain(`its remote was ${shown}`);
      }
    }
  });
});
