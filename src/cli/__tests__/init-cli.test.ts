/**
 * `agentboard init` through the built CLI (`dist/cli.js`; add-board-sharing
 * tasks 2.1 and 2.2; board-cli "Initialising and joining a shared board"):
 * the `--json` document and its fields, warnings on stderr, the
 * `ambiguous-remote` refusal, two `init` processes racing on one host
 * (one ref, one worktree), and an `init` killed after the host
 * `.gitignore` entry, after the ref is created and after the worktree is
 * added but before it is locked, each completed by running `init` again.
 * The crash points are reached with a `git` shim on the PATH that kills
 * the CLI process at the matching git command.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { git, gitRepo, tempDir } from '../../board/__tests__/helpers.js';
import {
  BOARD_REF,
  EMPTY_BOARD_COMMIT_ID,
  cloneHost,
  commitHostEvent,
  hostBoard,
  hostRepo,
  pushBoardRef,
  refCommit,
  worktreeEntries,
  worktreeEntry,
  withGitShimBefore,
  withKillingGitShim,
} from '../../board/__tests__/sharing-helpers.js';
import { bareRemote, syncEnv, type Env } from '../../board/__tests__/sync-helpers.js';
import { P, T1, ev } from '../../store/__tests__/helpers.js';
import { INIT_SUGGESTION } from '../../guidance/install.js';
import { BUILT_CLI, oneJson, spawnCli, type Run } from './cli-helpers.js';

// Every test spawns the CLI and git several times; keep well clear of the 5 s default.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const RESULT_KEYS = [
  'created',
  'dir',
  'events',
  'hostGitignore',
  'joined',
  'message',
  'model',
  'remote',
  'repair',
  'warnings',
];

/** `init` in `cwd` through the built CLI. */
function init(cwd: string, env: Env, json = true): Run {
  return spawnCli(json ? ['init', '--json'] : ['init'], cwd, env);
}

/** Lines of the host `.gitignore` that ignore the board. */
function boardLines(root: string): string[] {
  return readFileSync(join(root, '.gitignore'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() === '.board/');
}

/** Asserts `<root>/.board` is a complete host-model board: ref, one locked worktree, events. */
function expectComplete(root: string): void {
  const dir = join(root, '.board');
  expect(refCommit(root)).toMatch(/^[0-9a-f]{40}$/);
  const entries = worktreeEntries(root).filter((entry) => entry.path.endsWith('.board'));
  expect(entries).toHaveLength(1);
  expect(entries[0]?.locked).toBe('agentboard board');
  expect(entries[0]?.detached).toBe(true);
  expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(refCommit(root));
  expect(existsSync(join(dir, 'events', '.gitkeep'))).toBe(true);
  expect(git(root, 'for-each-ref', '--format=%(refname)', 'refs/agentboard/')).toBe(
    `${BOARD_REF}\n`,
  );
}

/** Runs `init --json` in `cwd` as a child process and resolves with its result. */
function initAsync(cwd: string, env: Env): Promise<Run> {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      childEnv[key] = value;
    }
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUILT_CLI, 'init', '--json'], {
      cwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

describe('agentboard init (built CLI)', () => {
  it('prints one JSON document with the sharing fields for a new host-model board', () => {
    const env = syncEnv();
    const root = gitRepo(join(tempDir(), 'proj'));

    const out = init(root, env);

    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr).toBe('');
    const doc = oneJson(out) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(RESULT_KEYS);
    expect(doc).toMatchObject({
      dir: join(root, '.board'),
      created: true,
      model: 'host',
      joined: false,
      remote: null,
      events: 0,
      hostGitignore: join(root, '.gitignore'),
      warnings: [],
      repair: null,
    });
    expect(typeof doc.message).toBe('string');
    expectComplete(root);
  });

  it('prints the message and the agents suggestion as text, naming the model', () => {
    const env = syncEnv();
    const root = gitRepo(join(tempDir(), 'proj'));
    const out = init(root, env, false);
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).toContain(join(root, '.board'));
    expect(out.stdout).toMatch(/host/);
    expect(out.stdout.endsWith(`\n${INIT_SUGGESTION}\n`)).toBe(true);
    expect(out.stderr).toBe('');
  });

  it('prints each warning on stderr as agentboard: <line>, also with --json', () => {
    const env = syncEnv();
    const root = hostRepo();
    git(root, 'remote', 'add', 'origin', join(tempDir(), 'gone.git'));

    const out = init(root, env);

    expect(out.code, out.stderr).toBe(0);
    const doc = oneJson(out) as { warnings: string[]; remote: string | null; joined: boolean };
    expect(doc.warnings).toHaveLength(1);
    expect(doc).toMatchObject({ remote: 'origin', joined: false });
    expect(out.stderr).toBe(`agentboard: ${doc.warnings[0] ?? ''}\n`);
    expect(out.stderr).toContain('origin');

    const text = init(hostRepo(join(tempDir(), 'other')), env, false);
    expect(text.stderr).toBe('');
  });

  it('exits 1 ambiguous-remote with a hint and creates nothing', () => {
    const env = syncEnv();
    const root = gitRepo(join(tempDir(), 'proj'));
    git(root, 'remote', 'add', 'fork', bareRemote());
    git(root, 'remote', 'add', 'upstream', bareRemote());

    const out = init(root, env, false);

    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toMatch(/^agentboard: .*fork.*upstream.*\nhint: \S/);
    expect(out.stderr).toContain('git config agentboard.remote');
    expect(existsSync(join(root, '.board'))).toBe(false);
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
    expect(refCommit(root)).toBeNull();

    const json = init(root, env);
    expect(json.code).toBe(1);
    expect(oneJson(json)).toMatchObject({ error: { exitCode: 1, reason: 'ambiguous-remote' } });
  });

  it('joins from a second clone and reports the event count', () => {
    const env = syncEnv();
    const remote = bareRemote();
    // Clone A's board, published as a completed sync leaves it (host-model sync is group 3).
    const a = hostBoard(env);
    git(a.root, 'remote', 'add', 'origin', remote);
    git(a.root, 'push', '-q', 'origin', 'main');
    commitHostEvent(a.dir, ev(P.create(T1, 'From A'), 'orch', 1000), env);
    pushBoardRef(a.root);
    const b = cloneHost(remote, 'b');

    const out = init(b, env);

    expect(out.code, out.stderr).toBe(0);
    expect(oneJson(out)).toMatchObject({
      joined: true,
      remote: 'origin',
      events: 1,
      model: 'host',
    });
    expectComplete(b);
    expect(refCommit(b)).toBe(refCommit(a.root));
    const list = spawnCli(['list', '--json'], b, env);
    expect(list.code, list.stderr).toBe(0);
    expect((oneJson(list) as { title: string }[]).map((t) => t.title)).toEqual(['From A']);
  });
});

describe('two init processes racing on one host', () => {
  // A missing lock lets both `git worktree add` succeed only now and then
  // (about one run in twenty when measured), so the race is repeated.
  const RUNS = 20;

  it(`leaves one ref and one locked worktree, and both processes exit 0 (${String(RUNS)} runs)`, async () => {
    const env = syncEnv();
    for (let run = 1; run <= RUNS; run += 1) {
      const root = hostRepo(join(tempDir(), `host-${String(run)}`));

      const [first, second] = await Promise.all([initAsync(root, env), initAsync(root, env)]);

      const label = `run ${String(run)}: ${first.stderr}${second.stderr}`;
      expect(first.code, label).toBe(0);
      expect(second.code, label).toBe(0);
      expect(oneJson(first)).toMatchObject({ model: 'host' });
      expect(oneJson(second)).toMatchObject({ model: 'host' });
      expect(refCommit(root), label).toBe(EMPTY_BOARD_COMMIT_ID);
      expectComplete(root);
      expect(git(root, 'status', '--porcelain'), label).toBe('');
      expect(readdirSync(join(root, '.board', 'events')), label).toEqual(['.gitkeep']);
      // Both inits see the same ref; one of them created it. Neither says
      // it restored a board from an older ref: the board is new (the
      // group 2 review nit on the race loser's wording).
      const docs = [oneJson(first), oneJson(second)] as { created: boolean; message: string }[];
      expect(
        docs.some((doc) => doc.created),
        label,
      ).toBe(true);
      for (const doc of docs) {
        expect(doc.message, label).not.toMatch(/restored it from the local/);
        expect(doc.message, label).not.toContain('0 event files');
      }
      expect(existsSync(join(root, '.git', 'agentboard', 'init.lock')), label).toBe(false);
    }
  });
});

describe('a second init while the first is inside worktree add', () => {
  it('waits on the init lock, then reports the existing board: one ref, one worktree, no repair', async () => {
    const env = syncEnv();
    const root = hostRepo();
    const dir = join(root, '.board');
    // The first init is held inside its `git worktree add`: the shim makes
    // the (empty) directory git is about to fill and sleeps before running
    // the real command, which is what a second init sees mid-add.
    const paused = withGitShimBefore(env, ['worktree', 'add'], `mkdir -p '${dir}'; sleep 4`);

    const first = initAsync(root, paused);
    const deadline = Date.now() + 10_000;
    while (!existsSync(dir) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, 'events'))).toBe(false);
    const second = initAsync(root, env);
    const [one, two] = await Promise.all([first, second]);

    expect(one.code, one.stderr).toBe(0);
    expect(two.code, two.stderr).toBe(0);
    expect(oneJson(one)).toMatchObject({ created: true, model: 'host', repair: null });
    const doc = oneJson(two) as { created: boolean; repair: unknown; message: string };
    expect(doc).toMatchObject({ created: false, model: 'host', repair: null });
    expect(doc.message).toContain('already exists');
    expect(doc.message).not.toContain('repair');
    expect(refCommit(root)).toBe(EMPTY_BOARD_COMMIT_ID);
    expectComplete(root);
    expect(git(root, 'status', '--porcelain')).toBe('');
    const kept = join(root, '.git', 'agentboard');
    expect(existsSync(kept) ? readdirSync(kept) : []).toEqual([]);
    expect(worktreeEntries(root).filter((entry) => entry.path.includes('agentboard'))).toEqual([]);
  });
});

describe('an interrupted init is completed by running init again', () => {
  /** A host with `.board/` not yet in its `.gitignore`, so the entry is the first thing init writes. */
  function bareHost(): string {
    return gitRepo(join(tempDir(), 'proj'));
  }

  it('killed after the host .gitignore entry (before the ref is created)', () => {
    const env = syncEnv();
    const root = bareHost();
    const killing = withKillingGitShim(env, ['update-ref', BOARD_REF], 'before');

    const crashed = init(root, killing);

    expect(crashed.code).not.toBe(0);
    expect(boardLines(root)).toEqual(['.board/']);
    expect(refCommit(root)).toBeNull();
    expect(existsSync(join(root, '.board', 'events'))).toBe(false);

    const again = init(root, env);
    expect(again.code, again.stderr).toBe(0);
    expect(oneJson(again)).toMatchObject({ created: true, model: 'host', joined: false });
    expect(boardLines(root)).toEqual(['.board/']);
    expectComplete(root);
  });

  it('killed after the ref is created (before the worktree is added)', () => {
    const env = syncEnv();
    const root = bareHost();
    const killing = withKillingGitShim(env, ['update-ref', BOARD_REF], 'after');

    const crashed = init(root, killing);

    expect(crashed.code).not.toBe(0);
    expect(refCommit(root)).toBe(EMPTY_BOARD_COMMIT_ID);
    expect(worktreeEntry(root, join(root, '.board'))).toBeNull();
    expect(existsSync(join(root, '.board', 'events'))).toBe(false);

    const again = init(root, env);
    expect(again.code, again.stderr).toBe(0);
    expect(oneJson(again)).toMatchObject({ created: true, model: 'host', joined: false });
    expect(refCommit(root)).toBe(EMPTY_BOARD_COMMIT_ID);
    expect(boardLines(root)).toEqual(['.board/']);
    expectComplete(root);
  });

  it('killed after the worktree is added but before it is locked', () => {
    const env = syncEnv();
    const root = bareHost();
    const killing = withKillingGitShim(env, ['worktree', 'add'], 'after');

    const crashed = init(root, killing);

    expect(crashed.code).not.toBe(0);
    const dir = join(root, '.board');
    expect(existsSync(join(dir, 'events', '.gitkeep'))).toBe(true);
    expect(worktreeEntry(root, dir)?.locked).toBeNull();

    const again = init(root, env);
    expect(again.code, again.stderr).toBe(0);
    expect(oneJson(again)).toMatchObject({ model: 'host' });
    expect(boardLines(root)).toEqual(['.board/']);
    expectComplete(root);
  });
});
