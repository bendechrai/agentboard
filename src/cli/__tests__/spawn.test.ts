/**
 * The built CLI (`dist/cli.js`) as a child process: exit codes, the
 * separation of stdout and stderr, and `--json`, for a representative
 * subset of commands. Breadth is covered in process by main.test.ts.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SAMPLES } from '../../board/__tests__/helpers.js';
import { gitRepo, tempDir } from '../../store/__tests__/helpers.js';
import { cliEnv, oneJson, project, spawnCli, written } from './cli-helpers.js';

const TASK3 = ['--task', 'openspec:add-board-core#3'];

describe('the built CLI', () => {
  it('prints version', () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', '..', '..', 'package.json'), 'utf8'),
    ) as {
      version: string;
    };
    const out = spawnCli(['version'], tempDir());
    expect(out).toEqual({ code: 0, stdout: `${pkg.version}\n`, stderr: '' });
    expect(oneJson(spawnCli(['version', '--json'], tempDir()))).toEqual({ version: pkg.version });
  });

  it('runs a ticket through new, claim, a refused claim and show', () => {
    const { root } = project();
    const created = spawnCli(['new', 'Build it', ...TASK3, '--as', 'orch', '--json'], root);
    expect(created.code).toBe(0);
    expect(created.stderr).toBe('');
    const { id, hash } = written(created);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    expect(spawnCli(['claim', id.slice(0, 8), '--as', 'impl'], root).code).toBe(0);

    const refused = spawnCli(['claim', id, '--as', 'reviewer'], root);
    expect(refused.code).toBe(4);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toContain('impl');

    const json = spawnCli(['claim', id, '--as', 'reviewer', '--json'], root);
    expect(json.code).toBe(4);
    expect(oneJson(json)).toMatchObject({ error: { exitCode: 4, reason: 'already-assigned' } });

    const shown = spawnCli(['show', id, '--json'], root);
    expect(shown.code).toBe(0);
    expect(oneJson(shown)).toMatchObject({ ticket: { id, assignee: 'impl' }, events: 2 });
  });

  it('scenario: list --json prints one array and nothing else', () => {
    const { root } = project();
    spawnCli(['new', 'a', ...TASK3, '--as', 'orch'], root);
    const out = spawnCli(['list', '--json'], root);
    expect(out.code).toBe(0);
    expect(out.stderr).toBe('');
    const doc = oneJson(out);
    expect(Array.isArray(doc)).toBe(true);
    expect(doc).toHaveLength(1);
  });

  it('exits 1 for a missing actor, naming both ways to give one', () => {
    const { root } = project();
    const out = spawnCli(['comment', '01ARYZ6S41', 'hi'], root, cliEnv({ USER: 'someone' }));
    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('--as');
    expect(out.stderr).toContain('AGENTBOARD_ACTOR');
  });

  it('exits 2 when there is no board', () => {
    const dir = tempDir();
    const out = spawnCli(['list'], dir);
    expect(out.code).toBe(2);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('./.board');
  });

  it('refuses a secret without echoing it', () => {
    const { root } = project();
    const id = written(spawnCli(['new', 'a', ...TASK3, '--as', 'orch', '--json'], root)).id;
    const secret = SAMPLES['pem-private-key'];
    const out = spawnCli(['comment', id, `key: ${secret}`, '--as', 'orch', '--json'], root);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('pem-private-key');
    expect(out.stdout + out.stderr).not.toContain(secret);
    expect(oneJson(out)).toMatchObject({ error: { exitCode: 1, reason: 'secret-like' } });
  });

  it('mcp exits 1 with the not-implemented message', () => {
    const out = spawnCli(['mcp'], tempDir());
    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toMatch(/mcp.*not implemented/);
  });

  it('init makes a board that is found from inside .board itself', () => {
    const repo = gitRepo(join(tempDir(), 'proj'));
    expect(spawnCli(['init'], repo).code).toBe(0);
    const id = written(spawnCli(['new', 'a', ...TASK3, '--as', 'orch', '--json'], repo)).id;
    const out = spawnCli(['list', '--json'], join(repo, '.board'));
    expect(out.code).toBe(0);
    expect(oneJson(out)).toMatchObject([{ id }]);
  });
});
