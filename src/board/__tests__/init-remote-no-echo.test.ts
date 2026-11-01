/**
 * `init --remote` repeats no value given (no-echo-refusals task 2.1;
 * board-cli "Board in a separate repository" and "Refusals never repeat
 * the refused input"; design.md "Audit" rows 40 to 45 and the sanitizer
 * below the table), in process: `sanitizeGitLine` on recorded git lines
 * (the value verbatim, the value without its credentials, a second URL
 * with credentials, neither, and the lines git 2.32 and 2.53 print for
 * each URL form), and every refusal of `initBoardWithRemote` with its
 * exact message, against local bare repositories, a closed port and an
 * HTTP server on 127.0.0.1 that answers 401, and an ssh shim that
 * connects nowhere. The built CLI, plain and `--json`, is in
 * `src/cli/__tests__/init-remote-no-echo-cli.test.ts`.
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { expectNoLeak } from '../../__tests__/harness/secret-fixtures.js';
import { initBoardWithRemote, sanitizeGitLine } from '../init-remote.js';
import { expectBoardError, git, gitRepo, putEvent, tempDir } from './helpers.js';
import {
  BARE_TOKENS,
  CLOSED_PORT,
  GH_TOKEN,
  URL_TOKEN,
  credentialUrls,
  localEnv,
  printingSshShim,
  startAuthServer,
  tokenUserPromptLines,
  type AuthServer,
} from './no-echo-remote-helpers.js';
import { sshShim, standaloneBoard } from './sharing-helpers.js';
import { bareRemote, revParse } from './sync-helpers.js';
import { P, T1, ev } from '../../store/__tests__/helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** The prefix every `usage` refusal of `--remote` shares. */
const USAGE =
  'agentboard init --remote needs the URL or local path of the repository that holds the board (--remote <url>): ';

/** The text after the quoted git line of both `remote-unreachable` refusals. */
const UNREACHABLE_TAIL =
  '); create an empty repository there (for example on your git host) and check your access to it, then run agentboard init --remote again';

/** The text after the branch of both `not-a-board` refusals. */
const NOT_A_BOARD_TAIL = '; --remote needs an empty repository, or one that holds a board';

/** The quoted git line of a `remote-unreachable` message (`cannot be read (<line>); ...`). */
function quotedLine(message: string, verb: 'cannot be read' | 'could not be cloned'): string {
  const head = `the repository given with --remote ${verb} (`;
  expect(message.startsWith(head), message).toBe(true);
  expect(message.endsWith(UNREACHABLE_TAIL), message).toBe(true);
  return message.slice(head.length, message.length - UNREACHABLE_TAIL.length);
}

/** A fresh directory that is not a git repository. */
function plainProject(): string {
  const root = join(tempDir(), 'proj');
  mkdirSync(root);
  return root;
}

describe('sanitizeGitLine: the value given becomes <url>, credentials become <redacted>', () => {
  it('replaces the value given verbatim, every occurrence', () => {
    const given = `https://host.example/${GH_TOKEN}.git`;
    expect(
      sanitizeGitLine(`fatal: unable to access '${given}/': could not reach ${given}`, given),
    ).toBe(`fatal: unable to access '<url>/': could not reach <url>`);
  });

  it('replaces a token given as the whole value', () => {
    for (const fixture of BARE_TOKENS) {
      expect(
        sanitizeGitLine(
          `fatal: '${fixture.value}' does not appear to be a git repository`,
          fixture.value,
        ),
      ).toBe(`fatal: '<url>' does not appear to be a git repository`);
    }
  });

  it('replaces the form git was given (an absolute path for a relative one) before the value itself', () => {
    const given = GH_TOKEN;
    const passed = `/tmp/proj/${GH_TOKEN}`;
    expect(
      sanitizeGitLine(`fatal: '${passed}' does not appear to be a git repository`, given, passed),
    ).toBe(`fatal: '<url>' does not appear to be a git repository`);
  });

  it('replaces the value without its credentials, the form git prints in unable to access and Authentication failed', () => {
    const given = `https://agent:${URL_TOKEN}@git.example.com/me/${GH_TOKEN}.git`;
    expect(
      sanitizeGitLine(
        `fatal: unable to access 'https://git.example.com/me/${GH_TOKEN}.git/': Could not resolve host: git.example.com`,
        given,
      ),
    ).toBe(`fatal: unable to access '<url>/': Could not resolve host: git.example.com`);
    const http = `http://agent:${URL_TOKEN}@127.0.0.1:4242/x.git`;
    expect(
      sanitizeGitLine(`fatal: Authentication failed for 'http://127.0.0.1:4242/x.git/'`, http),
    ).toBe(`fatal: Authentication failed for '<url>/'`);
  });

  it('redacts a token given as the user name, which git prints with the scheme and host (could not read Password)', () => {
    const given = `http://${GH_TOKEN}@127.0.0.1:4242/x.git`;
    expect(
      sanitizeGitLine(
        `fatal: could not read Password for 'http://${GH_TOKEN}@127.0.0.1:4242': terminal prompts disabled`,
        given,
      ),
    ).toBe(
      `fatal: could not read Password for 'http://<redacted>@127.0.0.1:4242': terminal prompts disabled`,
    );
  });

  it('leaves the could not read Username line unchanged: git quotes no user information in it', () => {
    const given = `http://${GH_TOKEN}@127.0.0.1:4242/x.git`;
    const line = `fatal: could not read Username for 'http://127.0.0.1:4242': terminal prompts disabled`;
    expect(sanitizeGitLine(line, given)).toBe(line);
  });

  it('redacts the percent-decoded user information git prints for an encoded one', () => {
    expect(
      sanitizeGitLine(
        `fatal: could not read Password for 'http://token@127.0.0.1:4242': terminal prompts disabled`,
        'http://to%6Ben@127.0.0.1:4242/x.git',
      ),
    ).toBe(
      `fatal: could not read Password for 'http://<redacted>@127.0.0.1:4242': terminal prompts disabled`,
    );
    expect(
      sanitizeGitLine(
        `fatal: unable to look up agent:${URL_TOKEN}!@127.0.0.1:1 (port 9418)`,
        `git://agent:${URL_TOKEN}%21@127.0.0.1:1/x.git`,
      ),
    ).toBe('fatal: unable to look up <redacted>@127.0.0.1:1 (port 9418)');
  });

  it('redacts the user information of the value given where git prints it without a scheme (git:// lookup, ssh)', () => {
    expect(
      sanitizeGitLine(
        `fatal: unable to look up agent:${URL_TOKEN}@127.0.0.1:1 (port 9418) (Name or service not known)`,
        `git://agent:${URL_TOKEN}@127.0.0.1:1/x.git`,
      ),
    ).toBe(
      'fatal: unable to look up <redacted>@127.0.0.1:1 (port 9418) (Name or service not known)',
    );
    expect(
      sanitizeGitLine(
        `agent:${URL_TOKEN}@127.0.0.1:1 git-upload-pack '/x.git'`,
        `ssh://agent:${URL_TOKEN}@127.0.0.1:1/x.git`,
      ),
    ).toBe(`<redacted>@127.0.0.1:1 git-upload-pack '/x.git'`);
  });

  it('redacts the user information of a second URL in the line, whatever its scheme case or quotes', () => {
    const given = 'https://host.example/me/x.git';
    expect(
      sanitizeGitLine(
        `fatal: redirect from ${given} to 'https://mirror:${GH_TOKEN}@mirror.example/x.git/' refused`,
        given,
      ),
    ).toBe(`fatal: redirect from <url> to 'https://<redacted>@mirror.example/x.git/' refused`);
    expect(
      sanitizeGitLine(`error: HTTPS://u:${URL_TOKEN}@other.example/x and ssh://me@h/x`, given),
    ).toBe('error: HTTPS://<redacted>@other.example/x and ssh://<redacted>@h/x');
  });

  it('takes the user information up to the last @ before the path, so a password holding @ is redacted whole', () => {
    const given = `https://agent:p@${URL_TOKEN}@host.example/x.git`;
    expect(sanitizeGitLine(`fatal: unable to access 'https://host.example/x.git/': boom`, given)).toBe(
      `fatal: unable to access '<url>/': boom`,
    );
    expect(
      sanitizeGitLine(`error: see https://a:p@${URL_TOKEN}@other.example/y`, 'https://elsewhere/'),
    ).toBe(
      'error: see https://<redacted>@other.example/y',
    );
  });

  it('handles an IPv6 host', () => {
    const given = `https://agent:${URL_TOKEN}@[::1]:1/x.git`;
    expect(
      sanitizeGitLine(
        `fatal: unable to access 'https://[::1]:1/x.git/': Failed to connect to ::1 port 1 after 0 ms: Could not connect to server`,
        given,
      ),
    ).toBe(
      `fatal: unable to access '<url>/': Failed to connect to ::1 port 1 after 0 ms: Could not connect to server`,
    );
  });

  it('leaves a line holding neither the value nor a credential unchanged', () => {
    for (const line of [
      'fatal: Could not read from remote repository.',
      'error: RPC failed; HTTP 500 curl 22 The requested URL returned error: 500',
      'see https://host.example/path@v2 for details',
      'ssh: connect to host 127.0.0.1 port 1: Connection refused',
    ]) {
      expect(sanitizeGitLine(line, 'https://agent:pw@git.example.com/x.git')).toBe(line);
    }
  });

  it('decision: the user of an scp-like value is an ssh login name, kept where it appears apart from the whole value', () => {
    const given = 'agent@127.0.0.1:me/x.git';
    expect(sanitizeGitLine(`agent@127.0.0.1 git-upload-pack 'me/x.git'`, given)).toBe(
      `agent@127.0.0.1 git-upload-pack 'me/x.git'`,
    );
    expect(sanitizeGitLine(`fatal: ${given} not found`, given)).toBe('fatal: <url> not found');
  });

  it('passed defaults to the value given', () => {
    expect(sanitizeGitLine('fatal: x.git', 'x.git')).toBe('fatal: <url>');
  });

  it('never lets a fixture through, for each recorded line shape', () => {
    for (const [name, url] of Object.entries(credentialUrls(4242))) {
      const stripped = url.replace(/\/\/[^/]*@/, '//');
      const lines = [
        `fatal: unable to access '${url}/': Failed to connect`,
        `fatal: unable to access '${stripped}/': Failed to connect`,
        `fatal: Authentication failed for '${stripped}/'`,
        `fatal: could not read Password for '${url.replace(/(:\d+)\/.*$/, '$1')}': terminal prompts disabled`,
      ];
      for (const line of lines) {
        const out = sanitizeGitLine(line, url);
        expectNoLeak(out);
        expect(out, `${name}: ${line}`).not.toContain(url);
      }
    }
  });
});

describe('scenario: Remote URL that is an option, and a file:// URL with a host: usage refusals name no value', () => {
  it.each([
    ['-', `-${GH_TOKEN}`],
    ['--upload-pack=', `--upload-pack=${URL_TOKEN}`],
  ])('a value starting with %s', (_, url) => {
    const root = plainProject();
    const err = expectBoardError(
      () => initBoardWithRemote(url, { cwd: root, env: localEnv() }),
      1,
      'usage',
    );
    expect(err.message).toBe(`${USAGE}the value starts with -, which git would read as an option`);
    expectNoLeak(err.message);
    expect(readdirSync(root)).toEqual([]);
  });

  it.each([`file://${GH_TOKEN}/x.git`, `file://agent:${URL_TOKEN}@example.invalid/x.git`])(
    'a file:// URL naming another host: %s',
    (url) => {
      const root = plainProject();
      const err = expectBoardError(
        () => initBoardWithRemote(url, { cwd: root, env: localEnv() }),
        1,
        'usage',
      );
      expect(err.message).toBe(
        `${USAGE}the value is a file:// URL naming a host other than localhost, so it is no path on this machine`,
      );
      expectNoLeak(err.message);
      expect(readdirSync(root)).toEqual([]);
    },
  );

  it('an empty value keeps its message', () => {
    const root = plainProject();
    const err = expectBoardError(
      () => initBoardWithRemote(' ', { cwd: root, env: localEnv() }),
      1,
      'usage',
    );
    expect(err.message).toBe(`${USAGE}the value is empty`);
  });
});

describe('scenario: Credentials in an unreachable URL (in process)', () => {
  it.each(Object.entries(credentialUrls()))(
    '%s against a closed port: exit 3 remote-unreachable quoting git with <url>, no credential',
    (_, url) => {
      const root = gitRepo(join(tempDir(), 'proj'));
      const err = expectBoardError(
        () => initBoardWithRemote(url, { cwd: root, env: localEnv() }),
        3,
        'remote-unreachable',
      );
      const line = quotedLine(err.message, 'cannot be read');
      expect(line).toMatch(/^fatal: unable to access '<url>\/': /);
      expect(err.message).not.toContain(url);
      expect(err.message).not.toContain('127.0.0.1:1/');
      expectNoLeak(err.message);
      expect(readdirSync(root)).toEqual(['.git']);
    },
  );

  it('an invalid URL (port out of range) is refused the same way, quoting git with <url>', () => {
    const url = `https://agent:${URL_TOKEN}@127.0.0.1:99999/me/x.git`;
    const root = plainProject();
    const err = expectBoardError(
      () => initBoardWithRemote(url, { cwd: root, env: localEnv() }),
      3,
      'remote-unreachable',
    );
    expect(quotedLine(err.message, 'cannot be read')).toMatch(
      /^fatal: unable to access '<url>\/': URL /,
    );
    expectNoLeak(err.message);
    expect(readdirSync(root)).toEqual([]);
  });

  it('an invalid URL (unterminated IPv6 host) quotes no credential', () => {
    const url = `https://agent:${URL_TOKEN}@[::1/x.git`;
    const root = plainProject();
    const err = expectBoardError(
      () => initBoardWithRemote(url, { cwd: root, env: localEnv() }),
      3,
      'remote-unreachable',
    );
    quotedLine(err.message, 'cannot be read');
    expect(err.message).not.toContain(url);
    expectNoLeak(err.message);
  });

  it('ssh://user:password@ through an ssh shim: the fatal line, and the credential nowhere', () => {
    const shim = sshShim();
    const url = `ssh://agent:${URL_TOKEN}@127.0.0.1:${CLOSED_PORT}/x.git`;
    const root = plainProject();
    const err = expectBoardError(
      () => initBoardWithRemote(url, { cwd: root, env: localEnv({ GIT_SSH_COMMAND: shim.command }) }),
      3,
      'remote-unreachable',
    );
    expect(err.message).toBe(
      `the repository given with --remote cannot be read (fatal: Could not read from remote repository.${UNREACHABLE_TAIL}`,
    );
    expect(shim.calls().length).toBeGreaterThan(0);
  });

  it('scp-like user@host:path through an ssh shim: the value is not repeated', () => {
    const shim = sshShim();
    const url = `agent@127.0.0.1:me/${GH_TOKEN}.git`;
    const root = plainProject();
    const err = expectBoardError(
      () => initBoardWithRemote(url, { cwd: root, env: localEnv({ GIT_SSH_COMMAND: shim.command }) }),
      3,
      'remote-unreachable',
    );
    expect(err.message).toBe(
      `the repository given with --remote cannot be read (fatal: Could not read from remote repository.${UNREACHABLE_TAIL}`,
    );
    expectNoLeak(err.message);
  });

  it('a git error line that quotes the URL with credentials, and a second URL with its own, is quoted sanitised', () => {
    const url = `ssh://agent:${URL_TOKEN}@127.0.0.1:${CLOSED_PORT}/x.git`;
    const mirror = `https://mirror:${GH_TOKEN}@mirror.example/x.git`;
    const shim = printingSshShim(`fatal: cannot reach ${url}; tried ${mirror} too`);
    const root = plainProject();
    const err = expectBoardError(
      () => initBoardWithRemote(url, { cwd: root, env: localEnv({ GIT_SSH_COMMAND: shim }) }),
      3,
      'remote-unreachable',
    );
    expect(err.message).toBe(
      `the repository given with --remote cannot be read (fatal: cannot reach <url>; tried https://<redacted>@mirror.example/x.git too${UNREACHABLE_TAIL}`,
    );
    expectNoLeak(err.message);
  });

  it.each(BARE_TOKENS.map((f) => [f.name, f.value]))(
    'a %s given as the whole value, naming a directory that is no repository: git quoted with <url>',
    (_, token) => {
      const root = plainProject();
      mkdirSync(join(root, token));
      const err = expectBoardError(
        () => initBoardWithRemote(token, { cwd: root, env: localEnv() }),
        3,
        'remote-unreachable',
      );
      expect(err.message).toBe(
        `the repository given with --remote cannot be read (fatal: '<url>' does not appear to be a git repository${UNREACHABLE_TAIL}`,
      );
      expect(err.message).not.toContain(root);
      expectNoLeak(err.message);
      expect(readdirSync(join(root, token))).toEqual([]);
    },
  );
});

describe('an auth failure (HTTP 401 from a server on 127.0.0.1)', () => {
  let server: AuthServer;
  beforeAll(async () => {
    server = await startAuthServer();
  });
  afterAll(() => {
    server.stop();
  });

  it('user:password: Authentication failed quoted with <url>', () => {
    const url = `http://agent:${URL_TOKEN}@127.0.0.1:${server.port}/me/x.git`;
    const root = plainProject();
    const err = expectBoardError(
      () => initBoardWithRemote(url, { cwd: root, env: localEnv() }),
      3,
      'remote-unreachable',
    );
    expect(err.message).toBe(
      `the repository given with --remote cannot be read (fatal: Authentication failed for '<url>/'${UNREACHABLE_TAIL}`,
    );
    expectNoLeak(err.message);
  });

  it('a token as the user name: could not read Password quoted with <redacted>, or could not read Username without it', () => {
    const url = `http://${GH_TOKEN}@127.0.0.1:${server.port}/me/x.git`;
    const root = plainProject();
    const err = expectBoardError(
      () => initBoardWithRemote(url, { cwd: root, env: localEnv() }),
      3,
      'remote-unreachable',
    );
    expect(
      tokenUserPromptLines(server.port).map(
        (line) => `the repository given with --remote cannot be read (${line}${UNREACHABLE_TAIL}`,
      ),
    ).toContain(err.message);
    expectNoLeak(err.message);
  });
});

describe('scenario: Clone fails after ls-remote (no value repeated)', () => {
  it('a file:// remote under a token-named directory whose tip commit is missing: exit 3, could not be cloned, no path', () => {
    const env = localEnv();
    const source = standaloneBoard(join(tempDir(), 'source'));
    putEvent(join(source, 'events'), ev(P.create(T1, 'one'), 'orch', 1_700_000_000_000));
    git(source, 'add', '-A');
    git(source, 'commit', '-q', '-m', 'one');
    const parent = join(tempDir(), BARE_TOKENS[0]?.value ?? 'x');
    mkdirSync(parent);
    const bare = join(parent, 'corrupt.git');
    git(tempDir(), 'clone', '-q', '--bare', '--no-hardlinks', source, bare);
    git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    const tip = revParse(bare, 'main');
    rmSync(join(bare, 'objects', tip.slice(0, 2), tip.slice(2)));
    const url = `file://${bare}`;
    const root = gitRepo(join(tempDir(), 'proj'));

    const err = expectBoardError(
      () => initBoardWithRemote(url, { cwd: root, env }),
      3,
      'remote-unreachable',
    );

    expect(quotedLine(err.message, 'could not be cloned')).toMatch(/^(fatal|error): /);
    expect(err.message).not.toContain(bare);
    expectNoLeak(err.message);
    expect(existsSync(join(root, '.board'))).toBe(false);
    expect(readdirSync(root).sort()).toEqual(['.git']);
  });
});

describe('not-a-board refusals name the repository given, not its URL', () => {
  /** A bare remote under a token-named directory whose main holds only a README. */
  function readmeRemote(): string {
    const parent = join(tempDir(), BARE_TOKENS[1]?.value ?? 'y');
    mkdirSync(parent);
    const remote = join(parent, 'remote.git');
    git(tempDir(), 'init', '-q', '--bare', '-b', 'main', remote);
    const scratch = gitRepo(join(tempDir(), 'scratch'));
    writeFileSync(join(scratch, 'README.md'), 'not a board\n');
    git(scratch, 'add', 'README.md');
    git(scratch, 'commit', '-q', '-m', 'readme');
    git(scratch, 'push', '-q', remote, 'HEAD:refs/heads/main');
    return remote;
  }

  it('a branch without events/: the exact message, naming the branch', () => {
    const remote = readmeRemote();
    const root = plainProject();
    const err = expectBoardError(
      () => initBoardWithRemote(remote, { cwd: root, env: localEnv() }),
      1,
      'not-a-board',
    );
    expect(err.message).toBe(
      `the repository given with --remote holds no board: its branch main has no events/ directory${NOT_A_BOARD_TAIL}`,
    );
    expect(readdirSync(root)).toEqual([]);
  });

  it('an only branch that cannot be checked out: the branch named, git quoted without the path', () => {
    const source = standaloneBoard(join(tempDir(), 'source'));
    putEvent(join(source, 'events'), ev(P.create(T1, 'one'), 'orch', 1_700_000_000_000));
    git(source, 'add', '-A');
    git(source, 'commit', '-q', '-m', 'one');
    const parent = join(tempDir(), BARE_TOKENS[2]?.value ?? 'z');
    mkdirSync(parent);
    const bare = join(parent, 'corrupt.git');
    git(tempDir(), 'clone', '-q', '--bare', '--no-hardlinks', source, bare);
    git(bare, 'branch', '-m', 'main', 'master');
    git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    const tree = git(bare, 'rev-parse', 'master^{tree}').trim();
    rmSync(join(bare, 'objects', tree.slice(0, 2), tree.slice(2)));
    const root = plainProject();

    const err = expectBoardError(
      () => initBoardWithRemote(bare, { cwd: root, env: localEnv() }),
      1,
      'not-a-board',
    );

    // git 2.53 fails the checkout (the message quotes git); git 2.32 checks
    // out an empty tree, so the branch has no events/ directory.
    const head = 'the repository given with --remote holds no board: its branch master ';
    expect(err.message.startsWith(head), err.message).toBe(true);
    expect(err.message.slice(head.length)).toMatch(
      /^(cannot be checked out \((fatal|error): .*\)|has no events\/ directory); --remote needs an empty repository, or one that holds a board$/,
    );
    expect(err.message).not.toContain(bare);
    expectNoLeak(err.message);
    expect(readdirSync(root)).toEqual([]);
  });
});

describe('scenario: Remote mismatch does not repeat the URL given', () => {
  it.each([
    ['a token in the path', `https://host/${GH_TOKEN}.git`],
    ['credentials', `https://agent:${URL_TOKEN}@host/d2.git`],
  ])('%s: names origin, its URL and remote set-url origin <url>', (_, url) => {
    const root = plainProject();
    const dir = standaloneBoard(root);
    git(dir, 'remote', 'add', 'origin', 'https://host/d.git');

    const err = expectBoardError(
      () => initBoardWithRemote(url, { cwd: root, env: localEnv() }),
      1,
      'remote-mismatch',
    );

    expect(err.message).toBe(
      `the board at ${dir} already has the remote origin at https://host/d.git, not the URL given; ` +
        `keep it, or change it with git -C ${dir} remote set-url origin <url>; nothing changed`,
    );
    expectNoLeak(err.message);
    expect(git(dir, 'remote', 'get-url', 'origin').trim()).toBe('https://host/d.git');
  });

  it('a relative local path is not repeated in its absolute form either', () => {
    const root = plainProject();
    const dir = standaloneBoard(root);
    const existing = bareRemote();
    git(dir, 'remote', 'add', 'origin', existing);
    const relative = `../${GH_TOKEN}.git`;

    const err = expectBoardError(
      () => initBoardWithRemote(relative, { cwd: root, env: localEnv() }),
      1,
      'remote-mismatch',
    );

    expect(err.message).toBe(
      `the board at ${dir} already has the remote origin at ${existing}, not the URL given; ` +
        `keep it, or change it with git -C ${dir} remote set-url origin <url>; nothing changed`,
    );
    expectNoLeak(err.message);
  });

  it('agentboard.remote naming a remote the board does not have: names it and writes <url> in the remote add step', () => {
    const root = plainProject();
    const dir = standaloneBoard(root);
    git(dir, 'config', 'agentboard.remote', 'nosuch');
    const url = `https://agent:${URL_TOKEN}@host/d.git`;

    const err = expectBoardError(
      () => initBoardWithRemote(url, { cwd: root, env: localEnv() }),
      1,
      'remote-mismatch',
    );

    expect(err.message).toBe(
      `the board at ${dir} is configured to sync with the remote nosuch (git config agentboard.remote), ` +
        `which the board repository does not have, so the URL given was not added; unset it with ` +
        `git -C ${dir} config --unset agentboard.remote, or add that remote with ` +
        `git -C ${dir} remote add nosuch <url>; nothing changed`,
    );
    expectNoLeak(err.message);
    expect(git(dir, 'remote')).toBe('');
  });
});
