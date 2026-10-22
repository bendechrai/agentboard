/**
 * `agentboard init --remote <url>` through the built CLI (`dist/cli.js`;
 * add-board-sharing tasks 4.1 and 4.2; board-cli "Board in a separate
 * repository"): the `--json` document and its fields, the text output, no
 * actor needed, the flag exclusivity with `--into-host` (scenario "Remote
 * flags are exclusive"), the refusals with their hints on stderr and in
 * the `--json` error document, `help init`, the two-clone walkthrough with
 * a local bare path that the README describes, `remote` afterwards, and
 * the README text of task 4.2 (the walkthrough on two clones is run here;
 * reading the README for accuracy is a manual check). Every remote is a
 * bare repository on local disk, or an SSH URL behind a shim that connects
 * nowhere.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { git, gitRepo, tempDir } from '../../board/__tests__/helpers.js';
import { SSH_URL, hostBoard, refs, sshShim, worktrees } from '../../board/__tests__/sharing-helpers.js';
import { bareRemote, revParse, syncEnv, type Env } from '../../board/__tests__/sync-helpers.js';
import { splitCommandLine } from '../../guidance/__tests__/command-line.js';
import { renderHint } from '../../guidance/hints.js';
import { INIT_SUGGESTION } from '../../guidance/install.js';
import { parseArgs } from '../parse.js';
import { findCommand } from '../registry.js';
import { oneJson, spawnCli, written, type Run } from './cli-helpers.js';

// Every test spawns the CLI and git several times; keep well clear of the 5 s default.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const README = join(HERE, '..', '..', '..', 'README.md');

const TASK3 = ['--task', 'openspec:add-board-core#3'];

/** The keys of the `init --remote --json` document, sorted. */
const RESULT_KEYS = [
  'action',
  'created',
  'dir',
  'events',
  'hostGitignore',
  'joined',
  'message',
  'model',
  'remote',
  'remoteUrl',
  'repair',
  'sync',
  'warnings',
];

/** `init --remote <url>` in `cwd` through the built CLI, no actor given. */
function initRemote(cwd: string, env: Env, url: string, json = true): Run {
  return spawnCli(['init', '--remote', url, ...(json ? ['--json'] : [])], cwd, env);
}

/** Creates a ticket through the built CLI and returns its id. */
function newTicket(cwd: string, env: Env, title: string): string {
  const out = spawnCli(['new', title, ...TASK3, '--as', 'orch', '--json'], cwd, env);
  expect(out.code, out.stderr).toBe(0);
  return written(out).id;
}

/** The hint line of a failed run's stderr (`hint: <hint>`, the last line). */
function hintOf(out: Run): string {
  expect(out.code).not.toBe(0);
  expect(out.stderr).toMatch(/^agentboard: \S/);
  const lines = out.stderr.trimEnd().split('\n');
  const last = lines.at(-1) ?? '';
  expect(last).toMatch(/^hint: \S/);
  return last.slice('hint: '.length);
}

/** The `--json` error document of a failed run. */
function errorOf(out: Run): {
  exitCode: number;
  reason: string | null;
  message: string;
  hint: string | null;
} {
  return (
    oneJson(out) as {
      error: { exitCode: number; reason: string | null; message: string; hint: string | null };
    }
  ).error;
}

/** A fresh project directory (a git repository with one commit) at `<temp>/<name>`. */
function project(name = 'proj'): string {
  return gitRepo(join(tempDir(), name));
}

describe('agentboard init --remote (built CLI)', () => {
  it('prints one JSON document with the init keys plus action, remoteUrl and sync, and needs no actor', () => {
    const env = syncEnv();
    const root = project();
    const remote = bareRemote();

    const out = initRemote(root, env, remote);

    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr).toBe('');
    const doc = oneJson(out) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(RESULT_KEYS);
    expect(doc).toMatchObject({
      dir: join(root, '.board'),
      action: 'created',
      created: true,
      model: 'standalone',
      joined: false,
      remote: 'origin',
      remoteUrl: remote,
      events: 0,
      hostGitignore: join(root, '.gitignore'),
      warnings: [],
      repair: null,
    });
    expect(doc.sync).toMatchObject({ model: 'standalone', remote: 'origin', pushed: true });
    expect(typeof doc.message).toBe('string');
    expect(git(join(root, '.board'), 'remote', 'get-url', 'origin').trim()).toBe(remote);
  });

  it('prints the message and the agents suggestion as text', () => {
    const env = syncEnv();
    const root = project();
    const remote = bareRemote();

    const out = initRemote(root, env, remote, false);

    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr).toBe('');
    expect(out.stdout).toContain(join(root, '.board'));
    expect(out.stdout).toContain(remote);
    expect(out.stdout).toMatch(/standalone/);
    expect(out.stdout.endsWith(`\n${INIT_SUGGESTION}\n`)).toBe(true);
  });

  it('prints the sync warnings on stderr as agentboard: <line> when the host tracks the board', () => {
    const env = syncEnv();
    const root = project();
    const remote = bareRemote();
    // The host tracks a file under .board, committed and then removed from
    // the working tree, so the board directory does not exist yet.
    mkdirSync(join(root, '.board'));
    writeFileSync(join(root, '.board', 'tracked.txt'), 'tracked\n');
    git(root, 'add', '.board/tracked.txt');
    git(root, 'commit', '-q', '-m', 'track a board path');
    rmSync(join(root, '.board'), { recursive: true });

    const out = initRemote(root, env, remote);

    expect(out.code, out.stderr).toBe(0);
    const doc = oneJson(out) as { warnings: string[] };
    expect(doc.warnings).toHaveLength(1);
    expect(doc.warnings[0]).toMatch(/warning/);
    expect(out.stderr).toBe(`agentboard: ${doc.warnings[0] ?? ''}\n`);
  });
});

describe('scenario: Remote flags are exclusive', () => {
  it('init --remote <url> --into-host exits 1 usage naming --into-host, and nothing changes', () => {
    const env = syncEnv();
    const root = project();
    const url = resolve(root, '../boards/project.git');
    const before = { entries: readdirSync(root).sort(), refs: refs(root) };

    const out = spawnCli(['init', '--remote', url, '--into-host'], root, env);

    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('--into-host');
    const json = spawnCli(['init', '--remote', url, '--into-host', '--json'], root, env);
    expect(json.code).toBe(1);
    expect(errorOf(json)).toMatchObject({ exitCode: 1, reason: 'usage' });
    // Nothing was created: no board, no bare repository at the URL, no host .gitignore entry.
    expect(existsSync(join(root, '.board'))).toBe(false);
    expect(existsSync(url)).toBe(false);
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
    expect({ entries: readdirSync(root).sort(), refs: refs(root) }).toEqual(before);
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  it('--remote without a value is a usage error', () => {
    const env = syncEnv();
    const root = project();

    const out = spawnCli(['init', '--remote'], root, env);

    expect(out.code).toBe(1);
    expect(out.stderr).toContain('--remote');
    expect(existsSync(join(root, '.board'))).toBe(false);
  });
});

describe('refusals through the CLI carry a hint', () => {
  it('remote-unreachable: exit 3, the message on stderr, a hint, and the --json error document', () => {
    const shim = sshShim();
    const env = syncEnv({ GIT_SSH_COMMAND: shim.command });
    const url = SSH_URL.replace('project', 'missing');
    const root = project();

    const out = initRemote(root, env, url, false);

    expect(out.code).toBe(3);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain(url);
    expect(out.stderr).toMatch(/create/);
    const hint = hintOf(out);
    expect(hint).toBe(renderHint('remote-unreachable', { surface: 'cli', command: 'init' }));
    const json = initRemote(root, env, url);
    expect(json.code).toBe(3);
    expect(errorOf(json)).toMatchObject({ exitCode: 3, reason: 'remote-unreachable', hint });
    expect(existsSync(join(root, '.board'))).toBe(false);
  });

  it('board-in-host: exit 1 with a hint naming agentboard remote, nothing changed', () => {
    const env = syncEnv();
    const { root, dir } = hostBoard(env);
    const remote = bareRemote();
    const before = { refs: refs(root), worktrees: worktrees(root), head: revParse(dir) };

    const out = initRemote(root, env, remote, false);

    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    expect(hintOf(out)).toContain("'agentboard remote'");
    expect(errorOf(initRemote(root, env, remote))).toMatchObject({
      exitCode: 1,
      reason: 'board-in-host',
    });
    expect({ refs: refs(root), worktrees: worktrees(root), head: revParse(dir) }).toEqual(before);
  });

  it('remote-mismatch: exit 1 with a hint naming remote set-url', () => {
    const env = syncEnv();
    const root = project();
    const first = bareRemote();
    expect(initRemote(root, env, first).code).toBe(0);
    const other = bareRemote();

    const out = initRemote(root, env, other, false);

    expect(out.code).toBe(1);
    expect(out.stderr).toContain(first);
    expect(out.stderr).toContain(other);
    expect(hintOf(out)).toContain('remote set-url');
    expect(errorOf(initRemote(root, env, other))).toMatchObject({
      exitCode: 1,
      reason: 'remote-mismatch',
    });
    expect(git(join(root, '.board'), 'remote', 'get-url', 'origin').trim()).toBe(first);
  });
});

describe('scenario: Init with a remote that has a board, through two clones with a local bare path', () => {
  it('clone A creates the bare repository and pushes; clone B clones it and lists the ticket before any sync', () => {
    const env = syncEnv();
    const tmp = tempDir();
    const a = gitRepo(join(tmp, 'a'));
    const b = gitRepo(join(tmp, 'b'));
    const bare = join(tmp, 'boards', 'project.git');

    // Clone A: the README's first command, with a path that does not exist yet.
    const initA = initRemote(a, env, '../boards/project.git');
    expect(initA.code, initA.stderr).toBe(0);
    expect(oneJson(initA)).toMatchObject({ action: 'created', remoteUrl: bare });
    expect(git(bare, 'rev-parse', '--is-bare-repository').trim()).toBe('true');
    const id = newTicket(a, env, 'From A');
    const syncA = spawnCli(['sync', '--json'], a, env);
    expect(syncA.code, syncA.stderr).toBe(0);
    expect(oneJson(syncA)).toMatchObject({ model: 'standalone', remote: 'origin', pushed: true });

    // Clone B: the same command, now against a repository that holds a board.
    const initB = initRemote(b, env, '../boards/project.git');
    expect(initB.code, initB.stderr).toBe(0);
    expect(oneJson(initB)).toMatchObject({
      action: 'cloned',
      joined: true,
      remote: 'origin',
      remoteUrl: bare,
      events: 1,
      model: 'standalone',
      sync: null,
    });
    const list = spawnCli(['list', '--json'], b, env);
    expect(list.code, list.stderr).toBe(0);
    expect((oneJson(list) as { id: string; title: string }[]).map((t) => [t.id, t.title])).toEqual([
      [id, 'From A'],
    ]);
    const syncB = spawnCli(['sync', '--json'], b, env);
    expect(syncB.code, syncB.stderr).toBe(0);
    expect(oneJson(syncB)).toMatchObject({ pulled: true, pushed: true, arrived: [] });

    // Both boards are at the remote's tip, and the host repositories are untouched.
    expect(revParse(join(a, '.board'))).toBe(revParse(bare, 'main'));
    expect(revParse(join(b, '.board'))).toBe(revParse(bare, 'main'));
    for (const root of [a, b]) {
      expect(git(root, 'for-each-ref', '--format=%(refname)', 'refs/agentboard/')).toBe('');
      expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('.board/\n');
    }
  });

  it('remote in each clone reports the standalone model and origin at the absolute path', () => {
    const env = syncEnv();
    const tmp = tempDir();
    const a = gitRepo(join(tmp, 'a'));
    const bare = join(tmp, 'boards', 'project.git');
    expect(initRemote(a, env, '../boards/project.git').code).toBe(0);

    const out = spawnCli(['remote', '--json'], a, env);

    expect(out.code, out.stderr).toBe(0);
    expect(oneJson(out)).toMatchObject({
      model: 'standalone',
      branch: 'main',
      remote: { name: 'origin', url: bare },
      remotes: [{ name: 'origin', url: bare }],
      problems: [],
    });
    const text = spawnCli(['remote'], a, env);
    expect(text.stdout).toContain('model: standalone');
    expect(text.stdout).toContain(bare);
  });

  it('running init --remote again in a clone changes nothing and exits 0', () => {
    const env = syncEnv();
    const tmp = tempDir();
    const a = gitRepo(join(tmp, 'a'));
    expect(initRemote(a, env, '../boards/project.git').code).toBe(0);

    const again = initRemote(a, env, '../boards/project.git');

    expect(again.code, again.stderr).toBe(0);
    expect(oneJson(again)).toMatchObject({ action: 'unchanged', created: false, sync: null });
  });
});

describe('help init documents --remote (task 4.1; the --into-host half is group 5)', () => {
  it('prints --remote in the synopsis, the new exit codes, and examples with --remote that parse', () => {
    const out = spawnCli(['help', 'init'], tempDir(), syncEnv());

    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).toMatch(/^Usage: agentboard init .*--remote <[a-z]+>/m);
    for (const [code, reason] of [
      [3, 'remote-unreachable'],
      [1, 'not-a-board'],
      [1, 'remote-mismatch'],
      [1, 'board-in-host'],
      [3, 'sync-failed'],
    ] as const) {
      expect(out.stdout, reason).toMatch(new RegExp(`^\\s+${String(code)} ${reason}\\s`, 'm'));
    }
    const spec = findCommand('init');
    const withRemote = spec?.examples.filter((e) => e.command.includes('--remote')) ?? [];
    expect(withRemote.length).toBeGreaterThan(0);
    for (const example of withRemote) {
      expect(out.stdout).toContain(example.command);
      const parsed = parseArgs(splitCommandLine(example.command).slice(1));
      expect(parsed.command.name).toBe('init');
      expect(typeof parsed.values.remote).toBe('string');
    }
  });

  it('help init --json carries the new reasons in its exit codes', () => {
    const out = spawnCli(['help', 'init', '--json'], tempDir(), syncEnv());
    expect(out.code, out.stderr).toBe(0);
    const doc = oneJson(out) as { exitCodes: { code: number; reason?: string }[] };
    for (const [code, reason] of [
      [3, 'remote-unreachable'],
      [1, 'not-a-board'],
      [1, 'remote-mismatch'],
      [1, 'board-in-host'],
    ] as const) {
      expect(doc.exitCodes).toContainEqual(expect.objectContaining({ code, reason }));
    }
  });
});

describe('the README documents the board in a separate repository (task 4.2)', () => {
  it('names the command, when to choose it, that existing standalone boards are unchanged, and the hosts that refuse custom refs', () => {
    const readme = readFileSync(README, 'utf8');
    const start = readme.indexOf('## Sync between machines');
    expect(start).toBeGreaterThan(0);
    const rest = readme.slice(start + '## Sync between machines'.length);
    const section = rest.slice(0, rest.search(/\n## /));
    for (const text of [
      'agentboard init --remote',
      'bare',
      'public',
      'custom refs',
      'standalone',
      'unchanged',
    ]) {
      expect(section, text).toContain(text);
    }
    expect([...readme].every((ch) => ch.charCodeAt(0) < 128)).toBe(true);
  });
});

describe('scenario: Remote URL that is an option, through the built CLI (review R1)', () => {
  it('exits 1 usage, runs nothing and creates nothing', () => {
    const shim = sshShim();
    const env = syncEnv({ GIT_SSH_COMMAND: shim.command });
    const root = project();
    git(root, 'remote', 'add', 'origin', SSH_URL);
    const url = '--upload-pack=touch PWNED;:x';

    const out = spawnCli(['init', '--remote', url], root, env);

    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('--remote');
    expect(errorOf(spawnCli(['init', '--remote', url, '--json'], root, env))).toMatchObject({
      exitCode: 1,
      reason: 'usage',
    });
    expect(shim.calls()).toEqual([]);
    expect(existsSync(join(root, 'PWNED'))).toBe(false);
    expect(existsSync(join(root, '.board'))).toBe(false);
    expect(git(root, 'status', '--porcelain')).toBe('');
  });
});
