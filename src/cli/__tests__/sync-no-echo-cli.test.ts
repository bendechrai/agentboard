/**
 * Git lines quoted from remote commands repeat no configured credential,
 * through the built CLI (`dist/cli.js`; no-echo-refusals group 2,
 * orchestrator DECISION on ticket 01M5YAB4PJQSSMGDM2XZAQA5FZ; board-cli
 * "Git lines quoted from remote commands"): `sync` of a standalone and of
 * a host-model board, the `sync` that `init --remote` runs after
 * attaching a remote, the host-model `init` join and `init --into-host`,
 * each with a remote whose configured URL holds a token (as the user name,
 * as `user:pass@`, in the path, in a `pushurl`), against a closed port on
 * 127.0.0.1, an HTTP server on 127.0.0.1 that answers 401, and an ssh shim
 * that prints a line quoting the URL. Plain and `--json`: the reason and
 * exit code as today, the git line sanitised (`<url>`, `<redacted>`), and
 * no fixture anywhere in stdout or stderr. `sync`, `remote` and `init`
 * are not MCP tools (checked here), and no web action runs git against a
 * remote, so the CLI is the only surface.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { expectNoLeak } from '../../__tests__/harness/secret-fixtures.js';
import { git, tempDir } from '../../board/__tests__/helpers.js';
import { standaloneProject, writeEvents } from '../../board/__tests__/into-host-helpers.js';
import {
  CLOSED_PORT,
  GH_TOKEN,
  URL_TOKEN,
  expectOneTokenUserPrompt,
  localEnv,
  printingSshShim,
  startAuthServer,
  tokenUserPromptPattern,
  type AuthServer,
  withoutTiming,
} from '../../board/__tests__/no-echo-remote-helpers.js';
import { hostBoard, hostRepo, standaloneBoard } from '../../board/__tests__/sharing-helpers.js';
import { bareRemote, type Env } from '../../board/__tests__/sync-helpers.js';
import { EXCLUDED_COMMANDS } from '../../mcp/tools.js';
import { oneJson, spawnCli, type Run } from './cli-helpers.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/** The `--json` error document of a failed run. */
function errorOf(out: Run): { exitCode: number; reason: string | null; message: string; hint: string | null } {
  return (
    oneJson(out) as {
      error: { exitCode: number; reason: string | null; message: string; hint: string | null };
    }
  ).error;
}

/**
 * Runs `argv` plain and with `--json` in `cwd`; both exit `code` with
 * `reason`, the plain stderr's first line is `agentboard: <message>` with
 * the message the `--json` document carries, the message matches
 * `message`, and no fixture leaks anywhere. Returns the message.
 */
function expectSanitisedRefusal(
  argv: readonly string[],
  cwd: string,
  env: Env,
  code: number,
  reason: string,
  message: RegExp,
): string {
  const plain = spawnCli(argv, cwd, env);
  expectNoLeak(plain.stdout + plain.stderr);
  expect(plain.code, plain.stderr).toBe(code);
  const json = spawnCli([...argv, '--json'], cwd, env);
  expectNoLeak(json.stdout + json.stderr);
  expect(json.code, json.stderr).toBe(code);
  const doc = errorOf(json);
  expect(doc.reason).toBe(reason);
  expect(doc.exitCode).toBe(code);
  expect(doc.message).toMatch(message);
  // Two git runs: curl's elapsed time (`after N ms`) may differ between them.
  expect(withoutTiming(plain.stderr.split('\n')[0] ?? '')).toBe(
    withoutTiming(`agentboard: ${doc.message}`),
  );
  return doc.message;
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

/** The sync-failed message shape: `<step> origin failed: <line>`, where the step contacts the remote. */
const SYNC_FAILED = /^(reaching|pulling from|pushing to|fetching \S+ from) origin failed: /;

/** The same, on stderr (`agentboard: ` first) or in the `--json` message. */
const SYNC_FAILED_ANY = /^(agentboard: )?(reaching|pulling from|pushing to|fetching \S+ from) origin failed: /;

describe('no MCP tool runs git against a remote', () => {
  it('sync, remote and init are excluded from the MCP tools', () => {
    for (const name of ['sync', 'remote', 'init']) {
      expect(EXCLUDED_COMMANDS).toContain(name);
    }
  });
});

describe('scenario: Sync with a token in the configured remote URL (standalone board)', () => {
  let server: AuthServer;
  beforeAll(async () => {
    server = await startAuthServer();
  });
  afterAll(() => {
    server.stop();
  });

  it('a token as the user name, 401: could not read Password quoted with <redacted>, or could not read Username without it', () => {
    const url = `http://${GH_TOKEN}@127.0.0.1:${server.port}/me/x.git`;
    const { root } = standaloneWithOrigin(url);
    const message = expectSanitisedRefusal(['sync'], root, localEnv(), 3, 'sync-failed', SYNC_FAILED);
    expect(message).toMatch(new RegExp(`failed: ${tokenUserPromptPattern(server.port)}$`));
  });

  it('user:pass@ with a token in the path, 401: Authentication failed quoted with <url>', () => {
    const url = `http://agent:${URL_TOKEN}@127.0.0.1:${server.port}/me/${GH_TOKEN}.git`;
    const { root } = standaloneWithOrigin(url);
    const message = expectSanitisedRefusal(['sync'], root, localEnv(), 3, 'sync-failed', SYNC_FAILED);
    expect(message).toMatch(/failed: fatal: Authentication failed for '<url>\/'$/);
  });

  it('user:pass@ with a token in the path, closed port: unable to access quoted with <url>', () => {
    const url = `https://agent:${URL_TOKEN}@127.0.0.1:${CLOSED_PORT}/me/${GH_TOKEN}.git`;
    const { root } = standaloneWithOrigin(url);
    const message = expectSanitisedRefusal(['sync'], root, localEnv(), 3, 'sync-failed', SYNC_FAILED);
    expect(message).toMatch(/failed: fatal: unable to access '<url>\/': /);
  });

  it('a token as the user name, closed port', () => {
    const url = `https://${GH_TOKEN}@127.0.0.1:${CLOSED_PORT}/me/x.git`;
    const { root } = standaloneWithOrigin(url);
    expectSanitisedRefusal(['sync'], root, localEnv(), 3, 'sync-failed', SYNC_FAILED);
  });

  it('a git line quoting the configured ssh URL with its credentials', () => {
    const url = `ssh://agent:${URL_TOKEN}@127.0.0.1:${CLOSED_PORT}/x.git`;
    const shim = printingSshShim(`fatal: cannot reach ${url} (agent:${URL_TOKEN}@127.0.0.1)`);
    const { root } = standaloneWithOrigin(url);
    const message = expectSanitisedRefusal(
      ['sync'],
      root,
      localEnv({ GIT_SSH_COMMAND: shim }),
      3,
      'sync-failed',
      SYNC_FAILED,
    );
    expect(message).toMatch(/failed: fatal: cannot reach <url> \(<redacted>@127\.0\.0\.1\)$/);
  });

  it('a token in a pushurl while the fetch URL is a local bare repository', () => {
    const remote = bareRemote();
    const { root, dir } = standaloneWithOrigin(remote);
    git(dir, 'config', 'remote.origin.pushurl', `http://${GH_TOKEN}@127.0.0.1:${server.port}/x.git`);
    const message = expectSanitisedRefusal(['sync'], root, localEnv(), 3, 'sync-failed', SYNC_FAILED);
    expect(message).toMatch(new RegExp(`^pushing to origin failed: ${tokenUserPromptPattern(server.port)}$`));
  });

  it('a token in the URL a url.<base>.insteadOf rewrite produces', () => {
    const { root, dir } = standaloneWithOrigin('https://host.example/x.git');
    git(
      dir,
      'config',
      `url.http://agent:${URL_TOKEN}@127.0.0.1:${server.port}/${GH_TOKEN}/.insteadOf`,
      'https://host.example/',
    );
    const message = expectSanitisedRefusal(['sync'], root, localEnv(), 3, 'sync-failed', SYNC_FAILED);
    expect(message).toMatch(/failed: fatal: Authentication failed for '<url>\/'$/);
  });
});

describe('scenario: Sync with a token in the host remote URL (host-model board)', () => {
  let server: AuthServer;
  beforeAll(async () => {
    server = await startAuthServer();
  });
  afterAll(() => {
    server.stop();
  });

  it.each([
    ['a token as the user name', (port: number) => `http://${GH_TOKEN}@127.0.0.1:${port}/me/x.git`],
    ['user:pass@ and a token in the path', (port: number) => `http://agent:${URL_TOKEN}@127.0.0.1:${port}/me/${GH_TOKEN}.git`],
  ])('%s, 401', (_, urlFor) => {
    const env = localEnv();
    const { root, dir } = hostBoard(env);
    git(root, 'remote', 'add', 'origin', urlFor(server.port));
    writeEvents(dir, 1);
    expectSanitisedRefusal(['sync'], root, env, 3, 'sync-failed', SYNC_FAILED);
  });
});

describe('scenario: The sync init --remote runs after attaching a remote', () => {
  let server: AuthServer;
  beforeAll(async () => {
    server = await startAuthServer();
  });
  afterAll(() => {
    server.stop();
  });

  it.each([false, true])(
    'a token as the user name of the URL given, 401 (--json %s): sync-failed quoting <redacted>, the remote kept',
    (json) => {
      const root = join(tempDir(), 'proj');
      const dir = standaloneBoard(root);
      git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
      writeEvents(dir, 1);
      const url = `http://${GH_TOKEN}@127.0.0.1:${server.port}/me/x.git`;
      const out = spawnCli(['init', '--remote', url, ...(json ? ['--json'] : [])], root, localEnv());
      expectNoLeak(out.stdout + out.stderr);
      expect(out.code, out.stderr).toBe(3);
      const message = json ? errorOf(out).message : (out.stderr.split('\n')[0] ?? '');
      expect(message).toMatch(SYNC_FAILED_ANY);
      expectOneTokenUserPrompt(message, server.port);
      expect(json ? errorOf(out).reason : 'sync-failed').toBe('sync-failed');
      // The remote stays (board-cli: a failing sync keeps the remote it set).
      expect(git(dir, 'remote')).toBe('origin\n');
    },
  );
});

describe('the host-model init join and init --into-host quote the host remote sanitised', () => {
  let server: AuthServer;
  beforeAll(async () => {
    server = await startAuthServer();
  });
  afterAll(() => {
    server.stop();
  });

  it('init in a host whose origin answers 401 for a token user: the warning quotes <redacted>, or no user', () => {
    const root = hostRepo();
    git(root, 'remote', 'add', 'origin', `http://${GH_TOKEN}@127.0.0.1:${server.port}/me/x.git`);
    const plain = spawnCli(['init'], root, localEnv());
    expectNoLeak(plain.stdout + plain.stderr);
    expect(plain.code, plain.stderr).toBe(0);
    expect(plain.stdout + plain.stderr).toMatch(
      new RegExp(`the remote origin could not be reached \\(${tokenUserPromptPattern(server.port)}\\)`),
    );
    expectOneTokenUserPrompt(plain.stdout + plain.stderr, server.port);
  });

  it('init with a host origin of user:pass@ and a token in the path, 401: no leak, <url> quoted', () => {
    const root = hostRepo();
    git(root, 'remote', 'add', 'origin', `http://agent:${URL_TOKEN}@127.0.0.1:${server.port}/${GH_TOKEN}.git`);
    const json = spawnCli(['init', '--json'], root, localEnv());
    expectNoLeak(json.stdout + json.stderr);
    expect(json.code, json.stderr).toBe(0);
    expect(json.stdout).toContain("Authentication failed for '<url>/'");
  });

  it('init --into-host with a host origin whose URL holds a token: nothing leaks, plain or --json', () => {
    const env = localEnv();
    const { root } = standaloneProject(env, 2);
    git(root, 'remote', 'set-url', 'origin', `http://${GH_TOKEN}@127.0.0.1:${server.port}/me/x.git`);
    const plain = spawnCli(['init', '--into-host'], root, env);
    expectNoLeak(plain.stdout + plain.stderr);
    expectOneTokenUserPrompt(plain.stdout + plain.stderr, server.port);
    const json = spawnCli(['init', '--into-host', '--json'], root, env);
    expectNoLeak(json.stdout + json.stderr);
  });

  it('a host remote that refuses with remote: lines quoting a URL with credentials: the remote lines are sanitised too', () => {
    const env = localEnv();
    const { root, dir } = hostBoard(env);
    const remote = bareRemote();
    const hook = join(remote, 'hooks', 'pre-receive');
    writeFileSync(
      hook,
      `#!/bin/sh\necho "refused for http://agent:${URL_TOKEN}@127.0.0.1:1/x.git" >&2\nexit 1\n`,
      { mode: 0o755 },
    );
    git(root, 'remote', 'add', 'origin', remote);
    writeEvents(dir, 1);
    const message = expectSanitisedRefusal(['sync'], root, env, 3, 'sync-failed', /failed: /);
    expect(message).toContain('refused for http://<redacted>@127.0.0.1:1/x.git');
  });
});
