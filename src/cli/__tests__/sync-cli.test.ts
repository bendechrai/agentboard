/**
 * `agentboard sync` through the built CLI (`dist/cli.js`): exit codes,
 * stdout and stderr, `--json`, the host tracking warning on stderr and
 * arrived events being visible to `list`. Every remote is a temporary bare
 * repository on local disk.
 */

import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { git, gitRepo, tempDir } from '../../board/__tests__/helpers.js';
import {
  bareRemote,
  cloneMachine,
  initMachine,
  rebaseInProgress,
  revParse,
  syncEnv,
  treeEvents,
  unmerged,
} from '../../board/__tests__/sync-helpers.js';
import { oneJson, spawnCli, written, type Run } from './cli-helpers.js';

const TASK3 = ['--task', 'openspec:add-board-core#3'];

/** `sync` in `cwd` through the built CLI, no actor given. */
function sync(cwd: string, env: Record<string, string | undefined>, json = false): Run {
  return spawnCli(json ? ['sync', '--json'] : ['sync'], cwd, env);
}

/** Creates a ticket through the built CLI and returns its id. */
function newTicket(cwd: string, env: Record<string, string | undefined>, title: string): string {
  const out = spawnCli(['new', title, ...TASK3, '--as', 'orch', '--json'], cwd, env);
  expect(out.code, out.stderr).toBe(0);
  return written(out).id;
}

describe('agentboard sync (built CLI)', () => {
  it('scenario: with no remote it commits, says no remote is configured and exits 0', () => {
    const env = syncEnv();
    const { root, dir } = initMachine(env);
    newTicket(root, env, 'one');

    const out = sync(root, env);

    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr).toBe('');
    expect(out.stdout).toContain('no remote configured');
    expect(out.stdout.endsWith('\n')).toBe(true);
    expect(treeEvents(dir)).toHaveLength(1);
  });

  it('prints one JSON document with --json and needs no actor', () => {
    const env = syncEnv();
    const { root, dir } = initMachine(env);
    newTicket(root, env, 'one');

    const out = sync(root, env, true);

    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr).toBe('');
    const doc = oneJson(out) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(
      [
        'arrived',
        'branch',
        'commit',
        'committedEvents',
        'dir',
        'hostTracked',
        'message',
        'pulled',
        'pushed',
        'refolded',
        'remote',
        'upstreamSet',
        'warnings',
      ].sort(),
    );
    expect(doc).toMatchObject({
      commit: revParse(dir),
      committedEvents: 1,
      remote: null,
      pulled: false,
      pushed: false,
      arrived: [],
      warnings: [],
    });
  });

  it('scenario: exits 5 naming a deleted committed event file, staging nothing', () => {
    const env = syncEnv();
    const { root, dir } = initMachine(env);
    newTicket(root, env, 'one');
    expect(sync(root, env).code).toBe(0);
    const [name] = treeEvents(dir);
    rmSync(join(dir, 'events', String(name)));
    const head = revParse(dir);

    const out = sync(root, env);
    expect(out.code).toBe(5);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain(`events/${String(name)}`);

    const json = sync(root, env, true);
    expect(json.code).toBe(5);
    expect(oneJson(json)).toMatchObject({ error: { exitCode: 5, reason: 'integrity' } });
    expect(revParse(dir)).toBe(head);
    expect(git(dir, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('exits 2 where there is no board', () => {
    const out = sync(tempDir(), syncEnv());
    expect(out.code).toBe(2);
    expect(out.stdout).toBe('');
  });

  it('reports arrived events, which list then shows', () => {
    const env = syncEnv();
    const remote = bareRemote();
    const a = initMachine(env, remote);
    expect(sync(a.root, env).code).toBe(0);
    const b = cloneMachine(remote);
    const ids = [newTicket(a.root, env, 'first'), newTicket(a.root, env, 'second')];
    expect(sync(a.root, env).code).toBe(0);

    const out = sync(b.root, env, true);

    expect(out.code, out.stderr).toBe(0);
    const doc = oneJson(out) as { arrived: string[]; pulled: boolean };
    expect(doc.pulled).toBe(true);
    expect(doc.arrived).toHaveLength(2);
    const listed = oneJson(spawnCli(['list', '--json'], b.root, env)) as { id: string }[];
    expect(listed.map((t) => t.id).sort()).toEqual(ids.sort());
  });

  it('exits 3 on a conflict that needs a human, naming the path, and again until resolved', () => {
    const env = syncEnv();
    const remote = bareRemote();
    const a = initMachine(env, remote);
    expect(sync(a.root, env).code).toBe(0);
    const b = cloneMachine(remote);
    appendFileSync(join(a.dir, '.gitignore'), 'only-on-a\n');
    appendFileSync(join(b.dir, '.gitignore'), 'only-on-b\n');
    newTicket(b.root, env, 'from b');
    expect(sync(a.root, env).code).toBe(0);

    const out = sync(b.root, env);
    expect(out.code).toBe(3);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('.gitignore');
    expect(unmerged(b.dir)).toEqual(['.gitignore']);
    expect(rebaseInProgress(b.dir)).toBe(true);

    const json = sync(b.root, env, true);
    expect(json.code).toBe(3);
    expect(oneJson(json)).toMatchObject({ error: { exitCode: 3, reason: 'sync-in-progress' } });
    expect(rebaseInProgress(b.dir)).toBe(true);
  });

  it('gives the conflict as a --json error document', () => {
    const env = syncEnv();
    const remote = bareRemote();
    const a = initMachine(env, remote);
    expect(sync(a.root, env).code).toBe(0);
    const b = cloneMachine(remote);
    appendFileSync(join(a.dir, '.gitignore'), 'only-on-a\n');
    appendFileSync(join(b.dir, '.gitignore'), 'only-on-b\n');
    expect(sync(a.root, env).code).toBe(0);

    const out = sync(b.root, env, true);

    expect(out.code).toBe(3);
    const doc = oneJson(out) as { error: { exitCode: number; reason: string; message: string } };
    expect(doc.error).toMatchObject({ exitCode: 3, reason: 'sync-conflict' });
    expect(doc.error.message).toContain('.gitignore');
  });

  it('warns on stderr when the host repository tracks a path under .board, and exits 0', () => {
    const env = syncEnv();
    const host = gitRepo(join(tempDir(), 'host'));
    mkdirSync(join(host, '.board'));
    writeFileSync(join(host, '.board', 'notes.txt'), 'tracked by mistake\n');
    git(host, 'add', '.board/notes.txt');
    git(host, 'commit', '-q', '-m', 'track board by mistake');
    expect(spawnCli(['init'], host, env).code).toBe(0);
    newTicket(host, env, 'one');

    const out = sync(host, env);

    expect(out.code, out.stderr).toBe(0);
    const warning = out.stderr.split('\n').find((line) => /warning/i.test(line));
    expect(warning).toBeDefined();
    expect(warning).toMatch(/^agentboard: /);
    expect(warning).toContain('.board/notes.txt');
    expect(out.stdout).not.toMatch(/warning/i);

    const json = sync(host, env, true);
    expect(json.code).toBe(0);
    expect(json.stderr).toContain('.board/notes.txt');
    expect(oneJson(json)).toMatchObject({ hostTracked: ['.board/notes.txt'] });
  });
});
