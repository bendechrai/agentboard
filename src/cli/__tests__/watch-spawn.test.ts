/**
 * `agentboard watch` as a real child process of the built CLI
 * (`dist/cli.js`, built before the tests by `make check`): an event written
 * by another process appears on the watcher's stdout within 3 seconds, the
 * watcher never advances the cursor, and SIGTERM or SIGINT stop it with
 * exit code 0.
 */

import { spawn, type ChildProcess } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import type { InboxEntry, InboxResult } from '../../board/inbox.js';
import { BUILT_CLI, cliEnv, oneJson, project, spawnCli, written } from './cli-helpers.js';

const TASK3 = ['--task', 'openspec:add-board-core#3'];

/** A running watcher: its collected stdout and stderr, and its exit. */
interface Watcher {
  child: ChildProcess;
  out(): string;
  err(): string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
});

function startWatch(root: string, argv: readonly string[]): Watcher {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(cliEnv())) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  const child = spawn(process.execPath, [BUILT_CLI, 'watch', ...argv], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    out += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    err += chunk;
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });
  return { child, out: () => out, err: () => err, exit };
}

/** The complete NDJSON lines printed so far, parsed. */
function entries(w: Watcher): InboxEntry[] {
  return w
    .out()
    .split('\n')
    .slice(0, -1)
    .map((line) => JSON.parse(line) as InboxEntry);
}

async function until(check: () => boolean, ms: number, what: string, w: Watcher): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${String(ms)} ms waiting for ${what}; stdout ${JSON.stringify(w.out())}, stderr ${JSON.stringify(w.err())}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A project with one ticket; returns its id. */
function withTicket(): { root: string; id: string } {
  const { root } = project();
  const id = written(spawnCli(['new', 'T', ...TASK3, '--as', 'orch', '--json'], root)).id;
  return { root, id };
}

describe('agentboard watch (child process)', () => {
  it(
    'prints an event written by another process within 3 seconds, without advancing the cursor, and exits 0 on SIGTERM',
    { timeout: 30_000 },
    async () => {
      const { root, id } = withTicket();
      const w = startWatch(root, ['--as', 'orch', '--json']);
      // The pending create is printed first: the watcher is running.
      await until(() => entries(w).length === 1, 15_000, 'the pending create', w);
      expect(entries(w)[0]).toMatchObject({ kind: 'ticket.create', ticket: id });

      const comment = spawnCli(['comment', id, 'from elsewhere', '--as', 'impl', '--json'], root);
      expect(comment.code, comment.stderr).toBe(0);
      const hash = written(comment).hash;
      const writtenAt = Date.now();
      await until(() => entries(w).some((e) => e.hash === hash), 3000, 'the comment', w);
      expect(Date.now() - writtenAt).toBeLessThanOrEqual(3000);
      expect(entries(w)[1]).toMatchObject({
        kind: 'ticket.comment',
        ticket: id,
        from: 'impl',
        note: 'from elsewhere',
      });

      w.child.kill('SIGTERM');
      expect(await w.exit).toEqual({ code: 0, signal: null });
      expect(w.err()).toBe('');
      // Each line printed was one complete JSON document.
      expect(entries(w)).toHaveLength(2);

      // Watch never acknowledged anything: inbox still returns both events.
      const inbox = oneJson(spawnCli(['inbox', '--as', 'orch', '--json'], root)) as InboxResult;
      expect(inbox.entries.map((e) => e.hash)).toEqual(entries(w).map((e) => e.hash));
    },
  );

  it('exits 0 on SIGINT', { timeout: 30_000 }, async () => {
    const { root } = withTicket();
    const w = startWatch(root, ['--as', 'orch']);
    await until(() => w.out().includes('ticket.create'), 15_000, 'the pending create', w);
    w.child.kill('SIGINT');
    expect(await w.exit).toEqual({ code: 0, signal: null });
    expect(w.out().split('\n')).toHaveLength(2);
  });

  it('exits 1 without an actor, before watching', { timeout: 30_000 }, async () => {
    const { root } = project();
    const w = startWatch(root, []);
    expect(await w.exit).toEqual({ code: 1, signal: null });
    expect(w.err()).toContain('AGENTBOARD_ACTOR');
  });
});
