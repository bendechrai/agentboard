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
import { configuredRemoteUrls, sanitizeRemoteLine, withoutUserinfo } from '../git.js';
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

describe('configuredRemoteUrls: remotes named by URL and proxies (review round 1)', () => {
  it('every branch.<b>.remote and agentboard.remote value that names no configured remote and holds : or /, as given', () => {
    const env = localEnv();
    const repo = gitRepo(join(tempDir(), 'r'));
    git(repo, 'remote', 'add', 'origin', 'https://host.example/a.git');
    git(repo, 'config', 'branch.main.remote', `http://agent:${URL_TOKEN}@127.0.0.1:1/x.git`);
    git(repo, 'config', 'branch.main.merge', 'refs/heads/main');
    git(repo, 'config', 'branch.dev.remote', 'origin');
    // A bare word naming no remote is kept out (board-cli "Configured
    // remote that does not exist" names it).
    git(repo, 'config', 'branch.old.remote', 'nope');
    git(repo, 'config', 'agentboard.remote', `https://127.0.0.1:1/${GH_TOKEN}.git`);

    expect([...configuredRemoteUrls(repo, env)].sort()).toEqual(
      [
        'https://host.example/a.git',
        `http://agent:${URL_TOKEN}@127.0.0.1:1/x.git`,
        `https://127.0.0.1:1/${GH_TOKEN}.git`,
      ].sort(),
    );
  });

  it('the proxies git uses: http.proxy, http.<url>.proxy, https.proxy and remote.<name>.proxy from the configuration', () => {
    const env = localEnv();
    const repo = gitRepo(join(tempDir(), 'r'));
    git(repo, 'remote', 'add', 'origin', 'http://127.0.0.1:1/x.git');
    git(repo, 'config', 'http.proxy', `http://${GH_TOKEN}%20a@127.0.0.1:3128`);
    git(repo, 'config', 'http.http://127.0.0.1:1/.proxy', `http://${GH_TOKEN}%2Fb@127.0.0.1:3129`);
    git(repo, 'config', 'https.proxy', `http://${GH_TOKEN}%27c@127.0.0.1:3130`);
    git(repo, 'config', 'remote.origin.proxy', `http://agent:${URL_TOKEN}@127.0.0.1:3131`);

    const urls = configuredRemoteUrls(repo, env);

    for (const proxy of [
      `http://${GH_TOKEN}%20a@127.0.0.1:3128`,
      `http://${GH_TOKEN}%2Fb@127.0.0.1:3129`,
      `http://${GH_TOKEN}%27c@127.0.0.1:3130`,
      `http://agent:${URL_TOKEN}@127.0.0.1:3131`,
    ]) {
      expect(urls).toContain(proxy);
    }
  });

  it.each(['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'])(
    'the proxy of the environment given, %s; a value without a scheme also as http://<value>',
    (name) => {
      const repo = gitRepo(join(tempDir(), 'r'));
      const withScheme = configuredRemoteUrls(
        repo,
        localEnv({ [name]: `http://${GH_TOKEN}%20x@127.0.0.1:3128` }),
      );
      expect(withScheme).toEqual([`http://${GH_TOKEN}%20x@127.0.0.1:3128`]);
      const bare = configuredRemoteUrls(repo, localEnv({ [name]: `agent:${URL_TOKEN}@127.0.0.1:3128` }));
      expect([...bare].sort()).toEqual(
        [`agent:${URL_TOKEN}@127.0.0.1:3128`, `http://agent:${URL_TOKEN}@127.0.0.1:3128`].sort(),
      );
    },
  );

  it('a proxy user name git 2.32 prints decoded (%20, %2F, %27) is redacted once the proxy is in the list', () => {
    for (const [encoded, decoded] of [
      ['%20', ' '],
      ['%2F', '/'],
      ['%27', "'"],
    ] as const) {
      const proxy = `http://${GH_TOKEN}${encoded}x@127.0.0.1:3128`;
      const line = `fatal: could not read Password for 'http://${GH_TOKEN}${decoded}x@127.0.0.1:3128': terminal prompts disabled`;
      const out = sanitizeRemoteLine(line, [proxy]);
      expectNoLeak(out);
      expect(out).toBe(
        "fatal: could not read Password for 'http://<redacted>@127.0.0.1:3128': terminal prompts disabled",
      );
    }
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

describe('withoutUserinfo: the form a remote URL is shown in (review round 1 addendum)', () => {
  it.each([
    [`https://agent:${URL_TOKEN}@host.example/x.git`, 'https://host.example/x.git'],
    [`http://${GH_TOKEN}@127.0.0.1:4242/me/x.git`, 'http://127.0.0.1:4242/me/x.git'],
    [`HTTPS://a:p@${URL_TOKEN}@host.example/x.git`, 'HTTPS://host.example/x.git'],
    [`ssh://agent:${URL_TOKEN}@[::1]:22/x.git`, 'ssh://[::1]:22/x.git'],
    ['https://host.example/path@v2/x.git', 'https://host.example/path@v2/x.git'],
    ['https://host.example/x.git', 'https://host.example/x.git'],
    ['git@host.example:me/x.git', 'git@host.example:me/x.git'],
    ['/srv/boards/x.git', '/srv/boards/x.git'],
    ['', ''],
  ])('%s -> %s', (url, shown) => {
    expect(withoutUserinfo(url)).toBe(shown);
  });
});

describe('proxy user information git and curl split differently (review round 2: R2, R3)', () => {
  it('R2: a proxy with two raw @ is split at the first, as git 2.53 prints it re-encoded', () => {
    const proxy = `http://a@${GH_TOKEN}%40x@127.0.0.1:3128`;
    // git 2.53 percent-encodes what it takes for the host, `_` included.
    const host = `${GH_TOKEN.replace('_', '%5F')}%2540x%40127.0.0.1:3128`;
    const line = `fatal: could not read Password for 'http://a@${host}': terminal prompts disabled`;
    const out = sanitizeRemoteLine(line, [proxy]);
    expectNoLeak(out);
    expect(out).toMatch(/^fatal: could not read Password for '.*': terminal prompts disabled$/);
  });

  it.each(['#', '?'])(
    'R3: a proxy user name with a raw %s, which curl on git 2.32 takes for the proxy host',
    (mark) => {
      const user = `${GH_TOKEN}${'x'.repeat(30)}`;
      const proxy = `http://${user}${mark}x@127.0.0.1:1`;
      const line = `fatal: unable to access 'http://127.0.0.1:1/x.git/': Could not resolve proxy: ${user}`;
      const out = sanitizeRemoteLine(line, [proxy]);
      expectNoLeak(out);
      expect(out.startsWith("fatal: unable to access 'http://127.0.0.1:1/x.git/': Could not resolve proxy: ")).toBe(true);
    },
  );

  it('R3 on git 2.53: the whole invalid proxy URL is quoted, and replaced', () => {
    const user = `${GH_TOKEN}${'x'.repeat(30)}`;
    const proxy = `http://${user}#x@127.0.0.1:1`;
    expect(
      sanitizeRemoteLine(`fatal: Invalid proxy URL '${proxy}': only SOCKS proxies support paths`, [proxy]),
    ).toBe("fatal: Invalid proxy URL '<url>': only SOCKS proxies support paths");
  });
});
