/**
 * Review round 3 of no-echo-refusals group 2 (reviewer-ne2-2 S1 at
 * b2da7cc, widened by the orchestrator to the class; design.md "Review
 * round 3" lists the search and every site): wherever agentboard shows a
 * configured or chosen remote name outside a git argument, a remote
 * named by URL (`agentboard.remote` or `branch.<b>.remote` set to a URL
 * with credentials) is shown without its user information, in the text
 * and in the `--json` fields. Sites tested here, each through the built
 * CLI, plain and `--json`:
 *
 * - `init` on an existing board, standalone and host (`remote: <name>`, `remote`);
 * - `init` creating a host-model board (`sync publishes it to <name>`) and
 *   joining one (`joined N events from <name>`);
 * - `init` repairing a host-model board joined from its remote (`joined from <name>`);
 * - `init --into-host` on a board already in the host (`remote: <name>`);
 * - `init --remote` with `agentboard.remote` naming no remote (the
 *   `remote-mismatch` variant naming that remote);
 * - the `sync-conflict` refusals of a standalone pull, of a host-model
 *   rebase and of the rebase `init --into-host` runs (`pulling from
 *   <name>`, `rebasing onto what <name> holds`).
 *
 * Every URL is on a closed port of 127.0.0.1; where git must reach it, it
 * is rewritten to a local bare repository.
 */

import { cpSync, writeFileSync } from 'node:fs';
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
  withKillingGitShim,
} from '../../board/__tests__/sharing-helpers.js';
import { bareRemote, type Env } from '../../board/__tests__/sync-helpers.js';
import { MIGRATING_REF } from '../../board/into-host.js';
import { BOARD_REF } from '../../board/model.js';
import { oneJson, spawnCli, type Run } from './cli-helpers.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/** A remote named by a URL with a credential, and the form agentboard shows. */
const NAMED = {
  url: `http://agent:${URL_TOKEN}@127.0.0.1:${CLOSED_PORT}/r.git`,
  shown: `http://127.0.0.1:${CLOSED_PORT}/r.git`,
};

/** How a board names its remote by URL. */
type Naming = 'agentboard.remote' | 'branch.main.remote';
const NAMINGS: readonly Naming[] = ['agentboard.remote', 'branch.main.remote'];

/** Sets `naming` to `NAMED.url` in the repository at `repo`. */
function nameByUrl(repo: string, naming: Naming): void {
  git(repo, 'config', naming, NAMED.url);
  if (naming === 'branch.main.remote') {
    git(repo, 'config', 'branch.main.merge', 'refs/heads/main');
  }
}

/** Both outputs of a run. */
function all(out: Run): string {
  return out.stdout + out.stderr;
}

/**
 * Runs `argv` in a fresh fixture from `setup`, plain and `--json`; no
 * fixture leaks; the run exits `code`; `check` sees the text (stdout and
 * stderr) and, for `--json`, the parsed document.
 */
function bothWays(
  setup: () => { cwd: string; env: Env },
  argv: readonly string[],
  code: number,
  check: (text: string, doc: Record<string, unknown> | null) => void,
): void {
  for (const json of [false, true]) {
    const { cwd, env } = setup();
    const out = spawnCli([...argv, ...(json ? ['--json'] : [])], cwd, env);
    expectNoLeak(all(out));
    expect(out.code, out.stderr).toBe(code);
    check(all(out), json ? (oneJson(out) as Record<string, unknown>) : null);
  }
}

/** A bare repository holding an empty board at `refs/agentboard/board`. */
function bareWithBoardRef(): string {
  const bare = bareRemote();
  git(bare, 'update-ref', BOARD_REF, emptyBoardCommit(bare));
  return bare;
}

describe('init on an existing board shows a remote named by URL without credentials', () => {
  it.each(NAMINGS)('standalone board, %s: remote: <url> and the --json remote', (naming) => {
    bothWays(
      () => {
        const root = join(tempDir(), 'proj');
        const dir = standaloneBoard(root);
        git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
        nameByUrl(dir, naming);
        return { cwd: root, env: localEnv() };
      },
      ['init'],
      0,
      (text, doc) => {
        expect(text).toContain(`remote: ${NAMED.shown}); nothing changed`);
        if (doc !== null) {
          expect(doc.remote).toBe(NAMED.shown);
        }
      },
    );
  });

  it('host-model board, agentboard.remote in the host', () => {
    bothWays(
      () => {
        const env = localEnv();
        const { root } = hostBoard(env);
        nameByUrl(root, 'agentboard.remote');
        return { cwd: root, env };
      },
      ['init'],
      0,
      (text, doc) => {
        expect(text).toContain(`remote: ${NAMED.shown})`);
        if (doc !== null) {
          expect(doc.remote).toBe(NAMED.shown);
        }
      },
    );
  });
});

describe('init creating or joining a host-model board names the remote without credentials', () => {
  it('a new board: agentboard sync publishes it to <url> (the remote unreachable)', () => {
    bothWays(
      () => {
        const root = hostRepo();
        nameByUrl(root, 'agentboard.remote');
        return { cwd: root, env: localEnv() };
      },
      ['init'],
      0,
      (text, doc) => {
        expect(text).toContain(`agentboard sync publishes it to ${NAMED.shown}, `);
        if (doc !== null) {
          expect(doc.remote).toBe(NAMED.shown);
        }
      },
    );
  });

  it('joining the board the remote holds: joined 0 events from <url>', () => {
    bothWays(
      () => {
        const env = localEnv();
        rewriteToLocal(env, NAMED.url, bareWithBoardRef());
        const root = hostRepo();
        nameByUrl(root, 'agentboard.remote');
        return { cwd: root, env };
      },
      ['init'],
      0,
      (text, doc) => {
        expect(text).toContain(`from ${NAMED.shown}`);
        if (doc !== null) {
          expect(doc).toMatchObject({ joined: true, remote: NAMED.shown });
        }
      },
    );
  });

  it('repairing a board copied into a fresh host: joined from <url>', () => {
    bothWays(
      () => {
        const env = localEnv();
        const bare = bareWithBoardRef();
        rewriteToLocal(env, NAMED.url, bare);
        const { dir } = hostBoard(env);
        const root = hostRepo();
        cpSync(dir, join(root, '.board'), { recursive: true });
        nameByUrl(root, 'agentboard.remote');
        return { cwd: root, env };
      },
      ['init'],
      0,
      (text, doc) => {
        expect(text).toContain(`joined from ${NAMED.shown}`);
        if (doc !== null) {
          expect(doc.remote).toBe(NAMED.shown);
        }
      },
    );
  });
});

describe('init --into-host on a board already in the host', () => {
  it('remote: <url> and the --json remote', () => {
    bothWays(
      () => {
        const env = localEnv();
        const { root } = hostBoard(env);
        nameByUrl(root, 'agentboard.remote');
        return { cwd: root, env };
      },
      ['init', '--into-host'],
      0,
      (text, doc) => {
        expect(text).toContain(`remote: ${NAMED.shown})`);
        if (doc !== null) {
          expect(doc.remote).toBe(NAMED.shown);
        }
      },
    );
  });
});

describe('init --remote when agentboard.remote is a URL with credentials', () => {
  it('the remote-mismatch variant names that remote without its credentials', () => {
    bothWays(
      () => {
        const root = join(tempDir(), 'proj');
        const dir = standaloneBoard(root);
        nameByUrl(dir, 'agentboard.remote');
        return { cwd: root, env: localEnv() };
      },
      ['init', '--remote', 'https://other.example/y.git'],
      1,
      (text) => {
        expect(text).toContain(`the remote ${NAMED.shown} (git config agentboard.remote)`);
        expect(text).toContain(`remote add ${NAMED.shown} <url>`);
      },
    );
  });
});

describe('sync-conflict refusals name a remote named by URL without credentials', () => {
  it('a standalone pull that stops on a conflict: pulling from <url> stopped on a conflict', () => {
    bothWays(
      () => {
        const env = localEnv();
        const bare = bareRemote();
        rewriteToLocal(env, NAMED.url, bare);
        const root = join(tempDir(), 'proj');
        const dir = standaloneBoard(root);
        git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
        writeEvents(dir, 1);
        git(dir, 'add', '-A');
        git(dir, 'commit', '-q', '-m', 'base');
        git(dir, 'push', '-q', bare, 'main');
        // The remote and the board change the same line of .gitignore.
        const other = join(tempDir(), 'other');
        git(tempDir(), 'clone', '-q', bare, other);
        writeFileSync(join(other, '.gitignore'), 'theirs\n');
        git(other, 'commit', '-q', '-am', 'theirs');
        git(other, 'push', '-q', 'origin', 'main');
        writeFileSync(join(dir, '.gitignore'), 'ours\n');
        git(dir, 'commit', '-q', '-am', 'ours');
        nameByUrl(dir, 'branch.main.remote');
        return { cwd: root, env };
      },
      ['sync'],
      3,
      (text) => {
        expect(text).toContain(`pulling from ${NAMED.shown} stopped on a conflict`);
      },
    );
  });

  it('a host-model rebase onto what the remote holds that stops on a conflict', () => {
    bothWays(
      () => {
        const env = localEnv();
        const bare = bareRemote();
        rewriteToLocal(env, NAMED.url, bare);
        const { root, dir } = hostBoard(env);
        // The remote's board ref changes .gitignore one way, the local one another.
        const other = join(tempDir(), 'other');
        git(tempDir(), 'clone', '-q', '--no-checkout', root, other);
        git(other, 'fetch', '-q', 'origin', `${BOARD_REF}:${BOARD_REF}`);
        git(other, 'checkout', '-q', '--detach', BOARD_REF);
        writeFileSync(join(other, '.gitignore'), 'theirs\n');
        git(other, 'commit', '-q', '-am', 'theirs');
        git(other, 'push', '-q', bare, `HEAD:${BOARD_REF}`);
        writeFileSync(join(dir, '.gitignore'), 'ours\n');
        git(dir, 'commit', '-q', '-am', 'ours');
        git(root, 'update-ref', BOARD_REF, git(dir, 'rev-parse', 'HEAD').trim());
        nameByUrl(root, 'agentboard.remote');
        return { cwd: root, env };
      },
      ['sync'],
      3,
      (text) => {
        expect(text).toContain(`rebasing onto what ${NAMED.shown} holds stopped on a conflict`);
      },
    );
  });

  it('init --into-host rebasing onto what the host remote holds, stopping on a conflict', () => {
    bothWays(
      () => {
        const env = localEnv();
        const { root } = standaloneProject(env, 1);
        // The host remote holds a board whose .gitignore differs from the standalone board's.
        const hostBare = bareRemote();
        const holder = hostRepo(join(tempDir(), 'holder'));
        const { dir: holderBoard } = hostBoard(env, holder);
        writeFileSync(join(holderBoard, '.gitignore'), 'theirs\n');
        git(holderBoard, 'commit', '-q', '-am', 'theirs');
        git(holderBoard, 'push', '-q', hostBare, `HEAD:${BOARD_REF}`);
        rewriteToLocal(env, NAMED.url, hostBare);
        nameByUrl(root, 'agentboard.remote');
        return { cwd: root, env };
      },
      ['init', '--into-host'],
      3,
      (text) => {
        expect(text).toContain(`what ${NAMED.shown} holds`);
      },
    );
  });
});

describe('round 4: init --into-host moved and resumed results name a host remote named by URL without credentials', () => {
  /** A project with a synced standalone board whose host remote is named by URL (`agentboard.remote`), rewritten to the host bare repository. */
  function project(): { root: string; env: Env } {
    const env = localEnv();
    const { root, remote } = standaloneProject(env, 2);
    rewriteToLocal(env, NAMED.url, remote);
    nameByUrl(root, 'agentboard.remote');
    return { root, env };
  }

  it('moved: the --json remote', () => {
    const { root, env } = project();
    const out = spawnCli(['init', '--into-host', '--json'], root, env);
    expectNoLeak(all(out));
    expect(out.code, out.stderr).toBe(0);
    expect(oneJson(out)).toMatchObject({ action: 'moved', remote: NAMED.shown });
  });

  it('resumed after a kill past the worktree move: the --json remote', () => {
    const { root, env } = project();
    const killed = spawnCli(
      ['init', '--into-host'],
      root,
      withKillingGitShim(env, ['update-ref', '-d', MIGRATING_REF], 'after'),
    );
    expectNoLeak(all(killed));
    expect(killed.code).not.toBe(0);
    const out = spawnCli(['init', '--into-host', '--json'], root, env);
    expectNoLeak(all(out));
    expect(out.code, out.stderr).toBe(0);
    expect(oneJson(out)).toMatchObject({ action: 'resumed', remote: NAMED.shown });
  });
});

describe('round 4: the init --remote mismatch names the setting that chose the remote', () => {
  it.each(NAMINGS)('%s set to a URL with credentials', (naming) => {
    bothWays(
      () => {
        const root = join(tempDir(), 'proj');
        const dir = standaloneBoard(root);
        git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
        nameByUrl(dir, naming);
        return { cwd: root, env: localEnv() };
      },
      ['init', '--remote', 'https://other.example/y.git'],
      1,
      (text) => {
        expect(text).toContain(
          `is configured to sync with the remote ${NAMED.shown} (git config ${naming}), which the ` +
            'board repository does not have, so the URL given was not added; unset it with git -C ',
        );
        expect(text).toContain(`config --unset ${naming}, or add that remote with git -C `);
      },
    );
  });
});
