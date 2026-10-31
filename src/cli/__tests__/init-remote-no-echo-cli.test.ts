/**
 * `init --remote` repeats no value given, through the built CLI
 * (`dist/cli.js`; no-echo-refusals task 2.1; board-cli "Board in a
 * separate repository", scenarios "Credentials in an unreachable URL",
 * "Remote URL that is an option" and "Remote mismatch does not repeat the
 * URL given"; "Refusals never repeat the refused input"): each refusal
 * plain (the `agentboard: <message>` line and the hint on stderr, nothing
 * on stdout) and with `--json` (the error document on stdout), with the
 * exact message, the reason, exit code and hint unchanged, and no
 * credential or token-shaped text anywhere in stdout or stderr. `init` is
 * not an MCP tool and not a web action, so the CLI is its only surface.
 * Remotes are local bare repositories, a closed port and an HTTP server on
 * 127.0.0.1, and ssh shims that connect nowhere.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { expectNoLeak } from '../../__tests__/harness/secret-fixtures.js';
import { git, tempDir } from '../../board/__tests__/helpers.js';
import {
  BARE_TOKENS,
  CLOSED_PORT,
  GH_TOKEN,
  URL_TOKEN,
  credentialUrls,
  localEnv,
  printingSshShim,
  startAuthServer,
  type AuthServer,
  withoutTiming,
} from '../../board/__tests__/no-echo-remote-helpers.js';
import { sshShim, standaloneBoard } from '../../board/__tests__/sharing-helpers.js';
import { type Env } from '../../board/__tests__/sync-helpers.js';
import { renderHint } from '../../guidance/hints.js';
import { EXCLUDED_COMMANDS, toolDefinitions } from '../../mcp/tools.js';
import { oneJson, spawnCli } from './cli-helpers.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const USAGE =
  'agentboard init --remote needs the URL or local path of the repository that holds the board (--remote <url>): ';
const UNREACHABLE_TAIL =
  '); create an empty repository there (for example on your git host) and check your access to it, then run agentboard init --remote again';

/** A fresh directory that is not a git repository. */
function plainProject(): string {
  const root = join(tempDir(), 'proj');
  mkdirSync(root);
  return root;
}

/**
 * Runs `init --remote <url>` plain and with `--json` in `cwd` and checks
 * both: exit `code`, `reason`, the message (exactly `message`, or matching
 * it when it is a RegExp) on stderr as `agentboard: <message>` and in the
 * error document, the hint the registry gives for the reason, nothing
 * leaked. Returns the message.
 */
function expectRefusal(
  cwd: string,
  env: Env,
  url: string,
  code: number,
  reason: string,
  message: string | RegExp,
): string {
  const hint = renderHint(reason, { surface: 'cli', command: 'init' });
  const plain = spawnCli(['init', '--remote', url], cwd, env);
  expect(plain.code, plain.stderr).toBe(code);
  expect(plain.stdout).toBe('');
  const lines = plain.stderr.trimEnd().split('\n');
  expect(lines).toHaveLength(2);
  const shown = (lines[0] ?? '').replace(/^agentboard: /, '');
  expect(lines[0]).toBe(`agentboard: ${shown}`);
  expect(lines[1]).toBe(`hint: ${hint ?? ''}`);
  if (typeof message === 'string') {
    expect(shown).toBe(message);
  } else {
    expect(shown).toMatch(message);
  }
  expect(plain.stdout + plain.stderr).not.toContain(url);
  expectNoLeak(plain.stdout + plain.stderr);

  const json = spawnCli(['init', '--remote', url, '--json'], cwd, env);
  expect(json.code, json.stderr).toBe(code);
  // Two git runs: curl's elapsed time (`after N ms`) may differ between them.
  const doc = oneJson(json) as { error: { message: string } };
  expect({ ...doc, error: { ...doc.error, message: withoutTiming(doc.error.message) } }).toEqual({
    error: { exitCode: code, reason, message: withoutTiming(shown), hint },
  });
  expect(json.stdout + json.stderr).not.toContain(url);
  expectNoLeak(json.stdout + json.stderr);
  return shown;
}

describe('init is reachable only through the CLI', () => {
  it('init is not an MCP tool (so no MCP surface carries these refusals)', () => {
    expect(EXCLUDED_COMMANDS).toContain('init');
    expect(toolDefinitions().map((tool) => tool.name)).not.toContain('board_init');
  });
});

describe('scenario: Credentials in an unreachable URL (built CLI, plain and --json)', () => {
  it.each(Object.entries(credentialUrls()))('%s against a closed port', (_, url) => {
    const root = plainProject();
    expectRefusal(
      root,
      localEnv(),
      url,
      3,
      'remote-unreachable',
      /^the repository given with --remote cannot be read \(fatal: unable to access '<url>\/': .*\); create an empty repository there \(for example on your git host\) and check your access to it, then run agentboard init --remote again$/,
    );
  });

  it('the URL fixture itself (an unresolvable host is never looked up: a closed port stands in for it)', () => {
    const url = `https://agent:${URL_TOKEN}@127.0.0.1:${CLOSED_PORT}/x.git`;
    expectRefusal(
      plainProject(),
      localEnv(),
      url,
      3,
      'remote-unreachable',
      /^the repository given with --remote cannot be read \(fatal: unable to access '<url>\/': /,
    );
  });

  it('an invalid URL (port out of range)', () => {
    const url = `https://agent:${URL_TOKEN}@127.0.0.1:99999/x.git`;
    expectRefusal(
      plainProject(),
      localEnv(),
      url,
      3,
      'remote-unreachable',
      /^the repository given with --remote cannot be read \(fatal: unable to access '<url>\/': URL /,
    );
  });

  it('ssh://user:password@ through an ssh shim', () => {
    const shim = sshShim();
    const url = `ssh://agent:${URL_TOKEN}@127.0.0.1:${CLOSED_PORT}/x.git`;
    expectRefusal(
      plainProject(),
      localEnv({ GIT_SSH_COMMAND: shim.command }),
      url,
      3,
      'remote-unreachable',
      `the repository given with --remote cannot be read (fatal: Could not read from remote repository.${UNREACHABLE_TAIL}`,
    );
  });

  it('scp-like user@host:path through an ssh shim', () => {
    const shim = sshShim();
    const url = `agent@127.0.0.1:me/${GH_TOKEN}.git`;
    expectRefusal(
      plainProject(),
      localEnv({ GIT_SSH_COMMAND: shim.command }),
      url,
      3,
      'remote-unreachable',
      `the repository given with --remote cannot be read (fatal: Could not read from remote repository.${UNREACHABLE_TAIL}`,
    );
  });

  it('a git error line quoting the URL with credentials and a second URL with its own', () => {
    const url = `ssh://agent:${URL_TOKEN}@127.0.0.1:${CLOSED_PORT}/x.git`;
    const shim = printingSshShim(
      `fatal: cannot reach ${url}; tried https://mirror:${GH_TOKEN}@mirror.example/x.git too`,
    );
    expectRefusal(
      plainProject(),
      localEnv({ GIT_SSH_COMMAND: shim }),
      url,
      3,
      'remote-unreachable',
      `the repository given with --remote cannot be read (fatal: cannot reach <url>; tried https://<redacted>@mirror.example/x.git too${UNREACHABLE_TAIL}`,
    );
  });

  it.each(BARE_TOKENS.map((f) => [f.name, f.value]))(
    'a %s as the whole value, naming a directory that is no repository',
    (_, token) => {
      const root = plainProject();
      mkdirSync(join(root, token));
      const message = expectRefusal(
        root,
        localEnv(),
        token,
        3,
        'remote-unreachable',
        `the repository given with --remote cannot be read (fatal: '<url>' does not appear to be a git repository${UNREACHABLE_TAIL}`,
      );
      expect(message).not.toContain(root);
    },
  );
});

describe('an auth failure through the built CLI (HTTP 401 on 127.0.0.1)', () => {
  let server: AuthServer;
  beforeAll(async () => {
    server = await startAuthServer();
  });
  afterAll(() => {
    server.stop();
  });

  it('user:password', () => {
    expectRefusal(
      plainProject(),
      localEnv(),
      `http://agent:${URL_TOKEN}@127.0.0.1:${server.port}/me/x.git`,
      3,
      'remote-unreachable',
      `the repository given with --remote cannot be read (fatal: Authentication failed for '<url>/'${UNREACHABLE_TAIL}`,
    );
  });

  it('a token as the user name', () => {
    expectRefusal(
      plainProject(),
      localEnv(),
      `http://${GH_TOKEN}@127.0.0.1:${server.port}/me/x.git`,
      3,
      'remote-unreachable',
      `the repository given with --remote cannot be read (fatal: could not read Password for 'http://<redacted>@127.0.0.1:${server.port}': terminal prompts disabled${UNREACHABLE_TAIL}`,
    );
  });
});

describe('scenario: Remote URL that is an option, and a file:// URL naming a host (built CLI)', () => {
  it.each([`-${GH_TOKEN}`, `--upload-pack=${URL_TOKEN}`])('%s', (url) => {
    expectRefusal(
      plainProject(),
      localEnv(),
      url,
      1,
      'usage',
      `${USAGE}the value starts with -, which git would read as an option`,
    );
  });

  it.each([`file://${GH_TOKEN}/x.git`, `file://agent:${URL_TOKEN}@example.invalid/x.git`])(
    '%s',
    (url) => {
      expectRefusal(
        plainProject(),
        localEnv(),
        url,
        1,
        'usage',
        `${USAGE}the value is a file:// URL naming a host other than localhost, so it is no path on this machine`,
      );
    },
  );
});

describe('scenario: Remote mismatch does not repeat the URL given (built CLI)', () => {
  it.each([
    ['a token in the path', `https://host/${GH_TOKEN}.git`],
    ['credentials', `https://agent:${URL_TOKEN}@host/d2.git`],
  ])('%s', (_, url) => {
    const root = plainProject();
    const dir = standaloneBoard(root);
    git(dir, 'remote', 'add', 'origin', 'https://host/d.git');
    expectRefusal(
      root,
      localEnv(),
      url,
      1,
      'remote-mismatch',
      `the board at ${dir} already has the remote origin at https://host/d.git, not the URL given; ` +
        `keep it, or change it with git -C ${dir} remote set-url origin <url>; nothing changed`,
    );
    expect(git(dir, 'remote', 'get-url', 'origin').trim()).toBe('https://host/d.git');
  });
});
