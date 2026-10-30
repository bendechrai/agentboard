/**
 * Review round 1 of no-echo-refusals group 2 (reviewer-ne2-2; orchestrator
 * DECISION on ticket 01M5YAB4PJQSSMGDM2XZAQA5FZ; board-cli "Git lines
 * quoted from remote commands"), through the built CLI, plain and
 * `--json`, on every path that quotes git talking to a remote:
 *
 * 1. A URL holding a non-ASCII character or a backslash is sanitised
 *    before the line is escaped for output (`asciiText`), so a token in
 *    its path never shows, escaped or not: standalone and host-model
 *    `sync`, `init --remote`, the host-model `init` join warning,
 *    `init --into-host`, and the `remote:` lines of a refused host push.
 * 2. A remote named by URL (`branch.<b>.remote`, `agentboard.remote`) is
 *    sanitised in the whole `sync-failed` message, not only in git's line.
 * 3. Proxy credentials (`http.proxy`, `remote.<name>.proxy`, and the
 *    `http_proxy`, `HTTPS_PROXY`, `all_proxy`, `ALL_PROXY` environment
 *    variables) never show, including a user name with `%20`, `%2F` or
 *    `%27`, which git 2.32 prints decoded.
 *
 * Only 127.0.0.1 is contacted: closed ports, a 401 server and a 407 proxy.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
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
  startAuthServer,
  startProxyServer,
  type AuthServer,
} from '../../board/__tests__/no-echo-remote-helpers.js';
import { hostBoard, hostRepo, standaloneBoard } from '../../board/__tests__/sharing-helpers.js';
import { bareRemote, type Env } from '../../board/__tests__/sync-helpers.js';
import { oneJson, spawnCli, type Run } from './cli-helpers.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/** URLs with a token in the path and a character `asciiText` escapes, on a closed port. */
const ESCAPED_URLS: readonly (readonly [string, string])[] = [
  ['a non-ASCII character', `http://127.0.0.1:${CLOSED_PORT}/${GH_TOKEN}/caf\u00e9.git`],
  ['a backslash', `http://127.0.0.1:${CLOSED_PORT}/${GH_TOKEN}/a\\b.git`],
];

/** A fresh, empty project directory that is not a git repository. */
function plainProject(): string {
  const root = join(tempDir(), 'proj');
  mkdirSync(root);
  return root;
}

/** Both outputs of a run, for the leak check. */
function all(out: Run): string {
  return out.stdout + out.stderr;
}

/** The message of a failed run: the `--json` error message, or the first stderr line without `agentboard: `. */
function messageOf(out: Run, json: boolean): string {
  if (json) {
    return (oneJson(out) as { error: { message: string } }).error.message;
  }
  return (out.stderr.split('\n')[0] ?? '').replace(/^agentboard: /, '');
}

/** The reason of a failed `--json` run. */
function reasonOf(out: Run): string | null {
  return (oneJson(out) as { error: { reason: string | null } }).error.reason;
}

/** A standalone board at `<temp>/proj/.board` on `main` with one unsynced event and `origin` at `url`. */
function standaloneWithOrigin(url: string): { root: string; dir: string } {
  const root = join(tempDir(), 'proj');
  const dir = standaloneBoard(root);
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(dir, 'remote', 'add', 'origin', url);
  writeEvents(dir, 1);
  return { root, dir };
}

/**
 * Runs `argv` in a fresh fixture from `setup`, once plain and once with
 * `--json` (each on its own fixture, as some paths change the board), and
 * calls `check` with each run; asserts no fixture leaks in either.
 */
function bothWays(
  setup: () => { cwd: string; env: Env },
  argv: readonly string[],
  check: (out: Run, json: boolean) => void,
): void {
  for (const json of [false, true]) {
    const { cwd, env } = setup();
    const out = spawnCli([...argv, ...(json ? ['--json'] : [])], cwd, env);
    expectNoLeak(all(out));
    check(out, json);
  }
}

/** A sync-failed run quoting `<url>`. */
function expectSyncFailedWithUrl(out: Run, json: boolean): void {
  expect(out.code, out.stderr).toBe(3);
  if (json) {
    expect(reasonOf(out)).toBe('sync-failed');
  }
  expect(messageOf(out, json)).toMatch(/ failed: fatal: unable to access '<url>\/': /);
}

describe('1. a URL with a character asciiText escapes is still sanitised', () => {
  it.each(ESCAPED_URLS)('standalone sync, origin with %s', (_, url) => {
    bothWays(
      () => ({ cwd: standaloneWithOrigin(url).root, env: localEnv() }),
      ['sync'],
      expectSyncFailedWithUrl,
    );
  });

  it.each(ESCAPED_URLS)('host-model sync, host origin with %s', (_, url) => {
    bothWays(
      () => {
        const env = localEnv();
        const { root, dir } = hostBoard(env);
        git(root, 'remote', 'add', 'origin', url);
        writeEvents(dir, 1);
        return { cwd: root, env };
      },
      ['sync'],
      expectSyncFailedWithUrl,
    );
  });

  it.each(ESCAPED_URLS)('init --remote given a URL with %s', (_, url) => {
    bothWays(
      () => ({ cwd: plainProject(), env: localEnv() }),
      ['init', '--remote', url],
      (out, json) => {
        expect(out.code, out.stderr).toBe(3);
        expect(messageOf(out, json)).toMatch(
          /^the repository given with --remote cannot be read \(fatal: unable to access '<url>\/': /,
        );
      },
    );
  });

  it.each(ESCAPED_URLS)('init --remote on a board without a remote: the sync it runs, URL with %s', (_, url) => {
    bothWays(
      () => {
        const root = join(tempDir(), 'proj');
        const dir = standaloneBoard(root);
        git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
        writeEvents(dir, 1);
        return { cwd: root, env: localEnv() };
      },
      ['init', '--remote', url],
      expectSyncFailedWithUrl,
    );
  });

  it.each(ESCAPED_URLS)('the host-model init join warning, host origin with %s', (_, url) => {
    bothWays(
      () => {
        const root = hostRepo();
        git(root, 'remote', 'add', 'origin', url);
        return { cwd: root, env: localEnv() };
      },
      ['init'],
      (out) => {
        expect(out.code, out.stderr).toBe(0);
        expect(all(out)).toContain("the remote origin could not be reached (fatal: unable to access '<url>/': ");
      },
    );
  });

  it.each(ESCAPED_URLS)('init --into-host, host origin with %s', (_, url) => {
    bothWays(
      () => {
        const env = localEnv();
        const { root } = standaloneProject(env, 2);
        git(root, 'remote', 'set-url', 'origin', url);
        return { cwd: root, env };
      },
      ['init', '--into-host'],
      (out) => {
        expect(all(out)).toContain("'<url>/'");
      },
    );
  });

  it.each(ESCAPED_URLS)(
    'a refused host push whose remote: line quotes another remote URL with %s',
    (_, url) => {
      bothWays(
        () => {
          const env = localEnv();
          const { root, dir } = hostBoard(env);
          const remote = bareRemote();
          writeFileSync(
            join(remote, 'hooks', 'pre-receive'),
            `#!/bin/sh\nprintf '%s\\n' 'refused, try ${url}' >&2\nexit 1\n`,
            { mode: 0o755 },
          );
          git(root, 'remote', 'add', 'origin', remote);
          git(root, 'remote', 'add', 'mirror', url);
          writeEvents(dir, 1);
          return { cwd: root, env };
        },
        ['sync'],
        (out, json) => {
          expect(out.code, out.stderr).toBe(3);
          expect(messageOf(out, json)).toContain('refused, try <url>');
        },
      );
    },
  );
});

describe('2. a remote named by URL is sanitised in the whole sync-failed message', () => {
  let server: AuthServer;
  beforeAll(async () => {
    server = await startAuthServer();
  });
  afterAll(() => {
    server.stop();
  });

  /** The sync-failed message for a remote named by URL: `<step> <url> failed: <line>`. */
  const NAMED_BY_URL = /^(reaching|pulling from|pushing to|fetching \S+ from) <url> failed: /;

  it.each([
    ['user:pass@ on a closed port', () => `http://agent:${URL_TOKEN}@127.0.0.1:${CLOSED_PORT}/x.git`],
    ['a token in the path, 401', () => `http://127.0.0.1:${server.port}/me/${GH_TOKEN}.git`],
    ['a token as the user name, 401', () => `http://${GH_TOKEN}@127.0.0.1:${server.port}/me/x.git`],
  ])('branch.main.remote set to a URL with %s (standalone)', (_, urlFor) => {
    bothWays(
      () => {
        const root = join(tempDir(), 'proj');
        const dir = standaloneBoard(root);
        git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
        git(dir, 'config', 'branch.main.remote', urlFor());
        git(dir, 'config', 'branch.main.merge', 'refs/heads/main');
        writeEvents(dir, 1);
        return { cwd: root, env: localEnv() };
      },
      ['sync'],
      (out, json) => {
        expect(out.code, out.stderr).toBe(3);
        expect(messageOf(out, json)).toMatch(NAMED_BY_URL);
      },
    );
  });

  it('agentboard.remote set to a URL with credentials (standalone)', () => {
    bothWays(
      () => {
        const root = join(tempDir(), 'proj');
        const dir = standaloneBoard(root);
        git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
        git(dir, 'config', 'agentboard.remote', `http://agent:${URL_TOKEN}@127.0.0.1:${CLOSED_PORT}/x.git`);
        writeEvents(dir, 1);
        return { cwd: root, env: localEnv() };
      },
      ['sync'],
      (out, json) => {
        expect(out.code, out.stderr).toBe(3);
        expect(messageOf(out, json)).toMatch(NAMED_BY_URL);
      },
    );
  });

  it('agentboard.remote set to a URL with a token in the path (host model)', () => {
    bothWays(
      () => {
        const env = localEnv();
        const { root, dir } = hostBoard(env);
        git(root, 'config', 'agentboard.remote', `http://127.0.0.1:${server.port}/me/${GH_TOKEN}.git`);
        writeEvents(dir, 1);
        return { cwd: root, env };
      },
      ['sync'],
      (out, json) => {
        expect(out.code, out.stderr).toBe(3);
        expect(messageOf(out, json)).toMatch(NAMED_BY_URL);
      },
    );
  });
});

describe('3. proxy credentials never show (git 2.32 prints a proxy user name decoded)', () => {
  let proxy: AuthServer;
  beforeAll(async () => {
    proxy = await startProxyServer();
  });
  afterAll(() => {
    proxy.stop();
  });

  const ENCODINGS = ['%20', '%2F', '%27'] as const;

  /** git's line asking for the proxy password, the proxy sanitised. */
  const proxyQuoted = (): RegExp =>
    new RegExp(
      `could not read Password for '(<url>|http://<redacted>@127\\.0\\.0\\.1:${String(proxy.port)})': terminal prompts disabled`,
    );

  /** A proxy URL whose user name is the token, an encoded character and `x`. */
  const proxyUrl = (encoded: string): string => `http://${GH_TOKEN}${encoded}x@127.0.0.1:${proxy.port}`;

  /** The environment of a proxy test: no proxy bypass, plus `extra`. */
  const proxyEnv = (extra: Env = {}): Env => localEnv({ no_proxy: undefined, NO_PROXY: undefined, ...extra });

  /** A refused sync whose message names the proxy only as `<redacted>` (or `<url>`). */
  const expectProxyRefusal = (out: Run, json: boolean): void => {
    expect(out.code, out.stderr).toBe(3);
    if (json) {
      expect(reasonOf(out)).toBe('sync-failed');
    }
    // git reached the proxy and quotes it: whole as <url> (the form
    // configured), or with its user name redacted (git 2.32 decodes it).
    expect(messageOf(out, json)).toMatch(proxyQuoted());
  };

  const SOURCES: readonly (readonly [string, string, (url: string) => Env, (dir: string, url: string) => void])[] = [
    ['http_proxy', 'http', (url) => proxyEnv({ http_proxy: url }), () => undefined],
    ['HTTPS_PROXY', 'https', (url) => proxyEnv({ HTTPS_PROXY: url }), () => undefined],
    ['all_proxy', 'http', (url) => proxyEnv({ all_proxy: url }), () => undefined],
    ['ALL_PROXY', 'http', (url) => proxyEnv({ ALL_PROXY: url }), () => undefined],
    ['http.proxy', 'http', () => proxyEnv(), (dir, url) => git(dir, 'config', 'http.proxy', url)],
    ['remote.origin.proxy', 'http', () => proxyEnv(), (dir, url) => git(dir, 'config', 'remote.origin.proxy', url)],
  ];

  for (const [source, scheme, envFor, configure] of SOURCES) {
    it.each(ENCODINGS)(`${source}, a user name with %s (standalone sync)`, (encoded) => {
      bothWays(
        () => {
          const url = proxyUrl(encoded);
          const { root, dir } = standaloneWithOrigin(`${scheme}://127.0.0.1:${CLOSED_PORT}/x.git`);
          configure(dir, url);
          return { cwd: root, env: envFor(url) };
        },
        ['sync'],
        expectProxyRefusal,
      );
    });
  }

  it.each(ENCODINGS)('http_proxy with %s, the host-model sync', (encoded) => {
    bothWays(
      () => {
        const env = proxyEnv({ http_proxy: proxyUrl(encoded) });
        const { root, dir } = hostBoard(env);
        git(root, 'remote', 'add', 'origin', `http://127.0.0.1:${CLOSED_PORT}/x.git`);
        writeEvents(dir, 1);
        return { cwd: root, env };
      },
      ['sync'],
      expectProxyRefusal,
    );
  });

  it.each(ENCODINGS)('http_proxy with %s, init --remote', (encoded) => {
    bothWays(
      () => ({
        cwd: plainProject(),
        env: proxyEnv({ http_proxy: proxyUrl(encoded) }),
      }),
      ['init', '--remote', `http://127.0.0.1:${CLOSED_PORT}/x.git`],
      (out, json) => {
        expect(out.code, out.stderr).toBe(3);
        expect(messageOf(out, json)).toMatch(proxyQuoted());
      },
    );
  });
});
