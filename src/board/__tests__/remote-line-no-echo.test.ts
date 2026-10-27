/**
 * `configuredRemoteUrls` and `sanitizeRemoteLine` (`src/board/git.ts`;
 * no-echo-refusals group 2, orchestrator DECISION on ticket
 * 01M5YAB4PJQSSMGDM2XZAQA5FZ; board-cli "Git lines quoted from remote
 * commands"): the URLs a git line from a remote command is sanitised
 * against, and the sanitising itself on the lines git 2.32 and 2.53 print.
 * The commands that quote such lines (`sync`, `init`, `init --remote`,
 * `init --into-host`) are run through the built CLI in
 * `src/cli/__tests__/sync-no-echo-cli.test.ts`.
 */

import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { expectNoLeak } from '../../__tests__/harness/secret-fixtures.js';
import { configuredRemoteUrls, sanitizeRemoteLine } from '../git.js';
import { sanitizeGitLine } from '../init-remote.js';
import { git, gitRepo, tempDir } from './helpers.js';
import { GH_TOKEN, URL_TOKEN, localEnv } from './no-echo-remote-helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe('configuredRemoteUrls', () => {
  it('a repository without remotes, and a directory that is no repository, give []', () => {
    const env = localEnv();
    expect(configuredRemoteUrls(gitRepo(join(tempDir(), 'r')), env)).toEqual([]);
    expect(configuredRemoteUrls(tempDir(), env)).toEqual([]);
  });

  it('every url and pushurl of every remote, raw and as rewritten by insteadOf and pushInsteadOf, deduplicated, longest first', () => {
    const env = localEnv();
    const repo = gitRepo(join(tempDir(), 'r'));
    git(repo, 'remote', 'add', 'origin', 'https://host.example/a.git');
    git(repo, 'config', '--add', 'remote.origin.url', 'https://second.example/a.git');
    git(repo, 'config', 'remote.origin.pushurl', `https://${GH_TOKEN}@push.example/a.git`);
    git(repo, 'remote', 'add', 'fork', 'gh:me/a.git');
    git(repo, 'config', `url.https://agent:${URL_TOKEN}@github.example/.insteadOf`, 'gh:');
    git(repo, 'config', `url.ssh://pusher@github.example/.pushInsteadOf`, 'gh:');

    const urls = configuredRemoteUrls(repo, env);

    expect([...urls].sort()).toEqual(
      [
        'https://host.example/a.git',
        'https://second.example/a.git',
        `https://${GH_TOKEN}@push.example/a.git`,
        'gh:me/a.git',
        `https://agent:${URL_TOKEN}@github.example/me/a.git`,
        'ssh://pusher@github.example/me/a.git',
      ].sort(),
    );
    expect(urls.map((u) => u.length)).toEqual([...urls.map((u) => u.length)].sort((a, b) => b - a));
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('contacts no remote: a remote on a closed port answers at once', () => {
    const env = localEnv();
    const repo = gitRepo(join(tempDir(), 'r'));
    git(repo, 'remote', 'add', 'origin', 'https://127.0.0.1:1/x.git');
    expect(configuredRemoteUrls(repo, env)).toEqual(['https://127.0.0.1:1/x.git']);
  });
});

describe('sanitizeRemoteLine', () => {
  const tokenUser = `http://${GH_TOKEN}@127.0.0.1:4242/me/x.git`;
  const userPass = `http://agent:${URL_TOKEN}@127.0.0.1:4242/me/${GH_TOKEN}.git`;

  it('a token as the user name of a configured URL (could not read Password)', () => {
    expect(
      sanitizeRemoteLine(
        `fatal: could not read Password for 'http://${GH_TOKEN}@127.0.0.1:4242': terminal prompts disabled`,
        [tokenUser],
      ),
    ).toBe(
      `fatal: could not read Password for 'http://<redacted>@127.0.0.1:4242': terminal prompts disabled`,
    );
  });

  it('user:pass@ with a token in the path: the stripped form git prints becomes <url>', () => {
    expect(
      sanitizeRemoteLine(
        `fatal: Authentication failed for 'http://127.0.0.1:4242/me/${GH_TOKEN}.git/'`,
        [tokenUser, userPass],
      ),
    ).toBe(`fatal: Authentication failed for '<url>/'`);
  });

  it('the userinfo of a configured URL is redacted without a scheme (ssh echo)', () => {
    expect(
      sanitizeRemoteLine(`agent:${URL_TOKEN}@127.0.0.1 refused`, [
        `ssh://agent:${URL_TOKEN}@127.0.0.1:1/x.git`,
      ]),
    ).toBe('<redacted>@127.0.0.1 refused');
  });

  it('with no URLs, only the generic <scheme>://<userinfo>@ redaction applies', () => {
    expect(sanitizeRemoteLine(`remote: refused for http://agent:${URL_TOKEN}@h/x.git`, [])).toBe(
      'remote: refused for http://<redacted>@h/x.git',
    );
    expect(sanitizeRemoteLine('fatal: Could not read from remote repository.', [])).toBe(
      'fatal: Could not read from remote repository.',
    );
  });

  it('agrees with sanitizeGitLine for a value given and the URL git was given', () => {
    const lines = [
      `fatal: '/tmp/p/${GH_TOKEN}' does not appear to be a git repository`,
      `fatal: unable to access 'http://127.0.0.1:4242/me/${GH_TOKEN}.git/': boom`,
      `fatal: could not read Password for 'http://${GH_TOKEN}@127.0.0.1:4242': x`,
    ];
    for (const line of lines) {
      expect(sanitizeRemoteLine(line, [GH_TOKEN, `/tmp/p/${GH_TOKEN}`])).toBe(
        sanitizeGitLine(line, GH_TOKEN, `/tmp/p/${GH_TOKEN}`),
      );
      expect(sanitizeRemoteLine(line, [userPass])).toBe(sanitizeGitLine(line, userPass));
      expect(sanitizeRemoteLine(line, [tokenUser])).toBe(sanitizeGitLine(line, tokenUser));
    }
  });

  it('lets no fixture through for any line shape git prints for a configured URL', () => {
    for (const url of [tokenUser, userPass]) {
      const stripped = url.replace(/\/\/[^/]*@/, '//');
      for (const line of [
        `fatal: unable to access '${url}/': x`,
        `fatal: unable to access '${stripped}/': x`,
        `fatal: Authentication failed for '${stripped}/'`,
        `fatal: could not read Password for '${url.replace(/(:\d+)\/.*$/, '$1')}': terminal prompts disabled`,
      ]) {
        expectNoLeak(sanitizeRemoteLine(line, [url]));
      }
    }
  });
});
