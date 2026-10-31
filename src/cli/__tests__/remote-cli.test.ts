/**
 * `agentboard remote` (add-board-sharing task 1.4; board-cli "Showing how a
 * board is shared", "Remote has help", "MCP server"): the three scenarios
 * through the built CLI in text and JSON, the proof that `remote` contacts
 * no remote (the host's `origin` is an SSH URL whose `GIT_SSH_COMMAND`
 * records every call, and none is recorded), the registry entry and its
 * help, `remote` excluded from the MCP tools, the `mcp` description and the
 * guide naming it, and the README documenting it.
 */

import { cpSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { git, gitRepo, makeBoardDir, tempDir } from '../../board/__tests__/helpers.js';
import {
  SSH_URL,
  commitHostEvent,
  hostBoard,
  hostRepo,
  real,
  snapshotDir,
  sshShim,
} from '../../board/__tests__/sharing-helpers.js';
import {
  gitWith,
  initMachine,
  revParse,
  syncEnv,
  type Env,
} from '../../board/__tests__/sync-helpers.js';
import { renderGuide } from '../../guidance/guide.js';
import { splitCommandLine } from '../../guidance/__tests__/command-line.js';
import { EXCLUDED_COMMANDS, findTool, toolDefinitions } from '../../mcp/tools.js';
import { P, T1, ev } from '../../store/__tests__/helpers.js';
import { VERSION } from '../../version.js';
import { parseArgs } from '../parse.js';
import { COMMANDS, findCommand } from '../registry.js';
import { cliEnv, oneJson, run, spawnCli, type Run } from './cli-helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const README = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'README.md');

const HEX40 = /^[0-9a-f]{40}$/;

/** `remote` in `cwd` through the built CLI, no actor given. */
function remote(cwd: string, env: Env, json = false): Run {
  return spawnCli(json ? ['remote', '--json'] : ['remote'], cwd, env);
}

/**
 * The JSON keys of the `remote --json` document (board-cli: at least dir,
 * model, gitDir, ref, branch, head, remote, remotes and problems).
 */
const KEYS = [
  'branch',
  'dir',
  'gitDir',
  'head',
  'model',
  'problems',
  'ref',
  'refCommit',
  'remote',
  'remotes',
];

describe('scenario: Remote on a host-model board', () => {
  /** A host-model board whose main checkout tracks origin/main at an SSH URL behind the shim. */
  function hostTrackingOrigin(): {
    env: Env;
    root: string;
    dir: string;
    commit: string;
    shim: ReturnType<typeof sshShim>;
  } {
    const shim = sshShim();
    const env = syncEnv({ GIT_SSH_COMMAND: shim.command });
    const { root, dir } = hostBoard(env);
    git(root, 'remote', 'add', 'origin', SSH_URL);
    git(root, 'config', 'branch.main.remote', 'origin');
    git(root, 'config', 'branch.main.merge', 'refs/heads/main');
    const commit = revParse(dir);
    return { env, root, dir, commit, shim };
  }

  it('prints the model host, the ref with its commit and origin chosen as the upstream, exit 0', () => {
    const { env, root, dir, commit } = hostTrackingOrigin();

    const out = remote(root, env);

    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr).toBe('');
    expect(out.stdout.endsWith('\n')).toBe(true);
    expect(out.stdout).toMatch(/^model: host$/m);
    expect(out.stdout).toContain('refs/agentboard/board');
    expect(out.stdout).toContain(commit);
    expect(out.stdout).toContain(dir);
    expect(out.stdout).toContain(SSH_URL);
    expect(out.stdout).toMatch(/^remote: origin .*upstream/m);
    expect(out.stdout).toMatch(/^[\x20-\x7e\n]+$/);
  });

  it('does not contact origin: the SSH shim records no call', () => {
    const { env, root, shim } = hostTrackingOrigin();

    expect(remote(root, env).code).toBe(0);
    expect(remote(root, env, true).code).toBe(0);

    expect(shim.calls()).toEqual([]);
    // The shim does see a network operation: the control proves the proof.
    expect(() => gitWith(root, env, 'ls-remote', 'origin')).toThrow();
    expect(shim.calls().length).toBeGreaterThan(0);
  });

  it('as JSON: one object with the spec keys, the ref, its commit, the remote and its rule', () => {
    const { env, root, dir, commit } = hostTrackingOrigin();

    const out = remote(root, env, true);

    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr).toBe('');
    const doc = oneJson(out) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(KEYS);
    expect(doc).toEqual({
      dir,
      model: 'host',
      gitDir: real(join(root, '.git')),
      ref: 'refs/agentboard/board',
      refCommit: commit,
      branch: null,
      head: commit,
      remote: { name: 'origin', url: SSH_URL, rule: 'upstream' },
      remotes: [{ name: 'origin', url: SSH_URL }],
      problems: [],
    });
    expect(commit).toMatch(HEX40);
  });

  it('from a linked worktree of the host, still reports the main checkout upstream', () => {
    const { env, root } = hostTrackingOrigin();
    git(root, 'remote', 'add', 'fork', SSH_URL.replace('project', 'fork'));
    const linked = join(tempDir(), 'feature');
    git(root, 'worktree', 'add', '-q', '-b', 'feature', linked);
    git(root, 'config', 'branch.feature.remote', 'fork');
    git(root, 'config', 'branch.feature.merge', 'refs/heads/feature');

    const out = remote(linked, env, true);

    expect(out.code, out.stderr).toBe(0);
    expect(oneJson(out)).toMatchObject({
      dir: join(root, '.board'),
      remote: { name: 'origin', rule: 'upstream' },
    });
  });

  it('changes nothing: no cache file, the host refs and worktrees and the board files as before', () => {
    const { env, root, dir } = hostTrackingOrigin();
    commitHostEvent(dir, ev(P.create(T1, 'One'), 'orch', 1000), env);
    const before = [
      git(root, 'for-each-ref'),
      git(root, 'worktree', 'list', '--porcelain'),
      snapshotDir(dir),
      git(root, 'status', '--porcelain'),
    ];

    expect(remote(root, env).code).toBe(0);
    expect(remote(root, env, true).code).toBe(0);

    expect(existsSync(join(dir, 'cache.sqlite'))).toBe(false);
    expect([
      git(root, 'for-each-ref'),
      git(root, 'worktree', 'list', '--porcelain'),
      snapshotDir(dir),
      git(root, 'status', '--porcelain'),
    ]).toEqual(before);
  });
});

describe('scenario: Remote on a standalone board without a remote', () => {
  it('--json prints one object with model standalone, the branch, remote null and remotes empty', () => {
    const env = syncEnv();
    const { root, dir } = initMachine(env);

    const out = remote(root, env, true);

    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr).toBe('');
    const doc = oneJson(out) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(KEYS);
    expect(doc).toEqual({
      dir,
      model: 'standalone',
      gitDir: real(join(dir, '.git')),
      ref: null,
      refCommit: null,
      branch: 'main',
      head: null,
      remote: null,
      remotes: [],
      problems: [],
    });
  });

  it('as text says standalone, the branch and that no remote is configured', () => {
    const env = syncEnv();
    const { root } = initMachine(env);
    const out = remote(root, env);
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).toMatch(/^model: standalone$/m);
    expect(out.stdout).toMatch(/branch main/);
    expect(out.stdout).toMatch(/^remote: none configured$/m);
  });
});

describe('scenario: Remote on a broken link', () => {
  function staleCopy(): { env: Env; cRoot: string; cDir: string } {
    const env = syncEnv();
    const a = hostBoard(env);
    const cRoot = hostRepo(join(tempDir(), 'clone-c'));
    const cDir = join(cRoot, '.board');
    cpSync(a.dir, cDir, { recursive: true });
    return { env, cRoot, cDir };
  }

  it('reports the model broken host link, names agentboard init as the repair, and exits 0', () => {
    const { env, cRoot, cDir } = staleCopy();
    const before = snapshotDir(cDir);

    const out = remote(cRoot, env);

    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr).toBe('');
    expect(out.stdout).toMatch(/^model: broken host link$/m);
    expect(out.stdout).toContain('agentboard init');
    expect(snapshotDir(cDir)).toEqual(before);
    expect(git(cRoot, 'for-each-ref', 'refs/agentboard/')).toBe('');
  });

  it('as JSON: model broken-host-link, nothing known, one problem naming agentboard init', () => {
    const { env, cRoot, cDir } = staleCopy();
    const out = remote(cRoot, env, true);
    expect(out.code, out.stderr).toBe(0);
    const doc = oneJson(out) as { model: string; dir: string; problems: string[]; remote: unknown };
    expect(doc.model).toBe('broken-host-link');
    expect(doc.dir).toBe(cDir);
    expect(doc.remote).toBeNull();
    expect(doc.problems.some((p) => p.includes('agentboard init'))).toBe(true);
  });
});

describe('remote on the other states a board can be in', () => {
  it('exits 2 board-not-found where there is no board, with nothing on stdout', () => {
    const out = remote(tempDir(), syncEnv());
    expect(out.code).toBe(2);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('agentboard: ');
    const json = remote(tempDir(), syncEnv(), true);
    expect(json.code).toBe(2);
    expect(oneJson(json)).toMatchObject({ error: { exitCode: 2, reason: 'board-not-found' } });
  });

  it('a board that is not a repository exits 0 reporting the model and a problem', () => {
    const env = syncEnv();
    const root = gitRepo(join(tempDir(), 'host'));
    makeBoardDir(root);

    const out = remote(root, env, true);

    expect(out.code, out.stderr).toBe(0);
    expect(oneJson(out)).toMatchObject({ model: 'not-a-repository', remote: null, remotes: [] });
    expect(remote(root, env).stdout).toMatch(/^model: not a repository$/m);
  });

  it('an ambiguous remote exits 0 and says how to set agentboard.remote', () => {
    const env = syncEnv();
    const { root } = hostBoard(env);
    git(root, 'remote', 'add', 'fork', SSH_URL.replace('project', 'fork'));
    git(root, 'remote', 'add', 'upstream', SSH_URL);

    const out = remote(root, env);

    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).toContain('fork');
    expect(out.stdout).toContain('upstream');
    expect(out.stdout).toContain('git config agentboard.remote <name>');
    const doc = oneJson(remote(root, env, true)) as {
      remote: unknown;
      remotes: { name: string }[];
    };
    expect(doc.remote).toBeNull();
    expect(doc.remotes.map((r) => r.name)).toEqual(['fork', 'upstream']);
  });

  it('needs no actor and ignores --as', () => {
    const env = syncEnv({ AGENTBOARD_ACTOR: undefined });
    const { root } = initMachine(env);
    expect(remote(root, env).code).toBe(0);
    expect(spawnCli(['remote', '--as', 'someone', '--json'], root, env).stdout).toBe(
      remote(root, env, true).stdout,
    );
  });

  it('refuses an extra argument as usage, exit 1', () => {
    const env = syncEnv();
    const { root } = initMachine(env);
    const out = spawnCli(['remote', 'origin'], root, env);
    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
  });
});

describe('scenario: Remote has help', () => {
  it('prints the synopsis, says it never contacts the network, lists exit code 2 and an example that parses to remote', () => {
    const out = run(['help', 'remote'], tempDir(), cliEnv({ AGENTBOARD_ACTOR: undefined }));
    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr).toBe('');
    expect(out.stdout).toMatch(/^Usage: agentboard remote \[--json\]$/m);
    expect(out.stdout).toMatch(/never contacts the network/);
    expect(out.stdout).toMatch(/^\s+2 board-not-found\s/m);
    const spec = findCommand('remote');
    expect(spec?.examples.length).toBeGreaterThan(0);
    for (const example of spec?.examples ?? []) {
      expect(out.stdout).toContain(example.command);
      expect(parseArgs(splitCommandLine(example.command).slice(1)).command.name).toBe('remote');
    }
  });

  it('is the same through remote --help, with no board', () => {
    const dir = tempDir();
    expect(run(['remote', '--help'], dir).stdout).toBe(run(['help', 'remote'], dir).stdout);
    expect(run(['remote', '--help'], dir).code).toBe(0);
  });
});

describe('the remote registry entry', () => {
  it('is a setup command with no actor, no flags of its own and the remoteReport operation', () => {
    const spec = findCommand('remote');
    expect(spec).toBeDefined();
    expect(spec).toMatchObject({
      name: 'remote',
      group: 'setup',
      writes: false,
      operation: 'remoteReport',
      positionals: [],
      flags: [],
      exclusive: [],
    });
    expect(spec?.tracksCursor ?? false).toBe(false);
    expect(spec?.stream).toBeUndefined();
    expect(spec?.exitCodes.map((e) => [e.code, e.reason ?? null])).toEqual([
      [0, null],
      [1, 'usage'],
      [1, 'invalid-actor'],
      [2, 'board-not-found'],
    ]);
  });

  it('comes right after sync in the registry (board-cli "Command surface" order)', () => {
    const names = COMMANDS.map((c) => c.name);
    expect(names.indexOf('remote')).toBe(names.indexOf('sync') + 1);
  });

  it('sync lists exit 2 board-link-broken (board-events "Board model detection")', () => {
    expect(findCommand('sync')?.exitCodes).toContainEqual(
      expect.objectContaining({ code: 2, reason: 'board-link-broken' }),
    );
  });
});

describe('scenario: Excluded remote tool', () => {
  it('remote is in EXCLUDED_COMMANDS and has no tool', () => {
    expect(EXCLUDED_COMMANDS).toContain('remote');
    expect(findTool('board_remote')).toBeUndefined();
    expect(toolDefinitions().map((t) => t.name)).not.toContain('board_remote');
  });

  it('the mcp description names every excluded command, remote included', () => {
    const description = findCommand('mcp')?.description ?? '';
    for (const name of EXCLUDED_COMMANDS) {
      const word = name.split(' ')[0] ?? name;
      expect(description, name).toMatch(new RegExp(`\\b${word}\\b`));
    }
    expect(description).toMatch(/\bremote\b/);
  });

  it('the agent guide names remote among the commands that are not tools', () => {
    const guide = renderGuide(VERSION);
    const section = guide.slice(guide.indexOf('\nUsing the MCP tools\n'));
    const body = section.slice(0, section.indexOf('\nExit codes and hints\n'));
    expect(body).toMatch(/\bremote\b/);
    for (const name of EXCLUDED_COMMANDS) {
      expect(body, name).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });
});

describe('README documents remote', () => {
  const readme = readFileSync(README, 'utf8');

  it('in the MCP server section, among the commands that are not exposed', () => {
    const start = readme.indexOf('\n## MCP server\n');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = readme.indexOf('\n## ', start + 1);
    const section = readme.slice(start, end < 0 ? undefined : end);
    expect(section).toMatch(/`remote`/);
  });

  it('in the command reference, with the command line agentboard remote', () => {
    expect(readme).toMatch(/^agentboard remote$/m);
    expect(readme).toMatch(/never contacts the network/);
  });
});
