/**
 * The hook events through the built CLI (add-harness-integration task
 * 2.1; board-harness-hooks "Session start hook", "Stop hook",
 * "Pre-tool-use claim check"): the answers reach the harness as the
 * protocol wants them (one JSON document on stdout, or exit 2 with the
 * reason on stderr), the inbox cursor advances across processes, and the
 * pre-tool-use rate limit is kept across processes in the OS temporary
 * directory (`TMPDIR`, a scratch directory here, never the real one).
 * The detail of each answer is pinned in process by
 * src/board/__tests__/hook-events.test.ts.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { HOOK_BUDGET_MS, HOOK_STDIN_LIMIT, STOP_TEXT_LIMIT } from '../board/hook.js';
import { ev, P, putEvent, T1 } from '../store/__tests__/helpers.js';
import {
  boardProject,
  cliEnv,
  oneDocument,
  requireBuiltCli,
  runCliAsync,
  scratchDir,
  type RunEnv,
} from './harness/processes.js';

/** Every test spawns several CLI processes; a loaded machine needs time. */
const SLOW = { timeout: 120_000 };

/** A finished hook process. */
interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** The spec's bound on a hook run (board-harness-hooks "Time budget"). */
const BOUND_MS = 3000;

/** A finished hook process, with the milliseconds from spawn to exit. */
interface TimedHookRun extends HookRun {
  ms: number;
}

/**
 * Runs `node dist/cli.js hook <argv>` in `cwd` with `stdin` as its
 * payload; the child is killed after `timeoutMs` (20 seconds by default).
 */
function hookProcess(
  argv: readonly string[],
  cwd: string,
  stdin: string,
  env: RunEnv,
  timeoutMs = 20_000,
): TimedHookRun {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      childEnv[key] = value;
    }
  }
  const started = performance.now();
  const result = spawnSync(process.execPath, [requireBuiltCli(), 'hook', ...argv], {
    cwd,
    env: childEnv,
    input: stdin,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    ms: performance.now() - started,
  };
}

const holders = new Set<ChildProcess>();

afterAll(() => {
  for (const child of holders) {
    child.kill('SIGKILL');
  }
});

/**
 * A child holding the write lock of the SQLite file at `path` (an open
 * `BEGIN IMMEDIATE`, so readers still read) until it is killed; resolves
 * once the lock is held.
 */
async function holdWriteLock(path: string): Promise<ChildProcess> {
  const script = [
    "const { DatabaseSync } = require('node:sqlite');",
    'const db = new DatabaseSync(process.argv[1]);',
    "db.exec('BEGIN IMMEDIATE');",
    "process.stdout.write('locked\\n');",
    'setInterval(() => undefined, 60000);',
  ].join('\n');
  const child = spawn(process.execPath, ['--no-warnings', '-e', script, path], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  holders.add(child);
  let err = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    err += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
      if (out.includes('locked\n')) {
        resolve();
      }
    });
    child.on('close', () => {
      reject(new Error(`lock holder exited before locking: ${err}`));
    });
  });
  return child;
}

/** Kills a lock holder and waits for it to exit. */
async function release(child: ChildProcess): Promise<void> {
  const closed = new Promise<void>((resolve) => child.on('close', () => resolve()));
  child.kill('SIGKILL');
  await closed;
  holders.delete(child);
}

/** The pending `inbox --peek` lines of `actor`, without acknowledging them. */
async function peek(root: string, actor: string): Promise<string[]> {
  const out = await runCliAsync(['inbox', '--as', actor, '--peek'], root, cliEnv());
  expect(out.code, out.stderr).toBe(0);
  return out.stdout.split('\n').filter((l) => l !== '');
}

/** A project whose board has T1 created by orch and claimed by impl, cache built. */
async function claimedProject(): Promise<{ root: string; boardDir: string }> {
  const { root, boardDir, eventsDir } = boardProject();
  const now = Date.now();
  putEvent(eventsDir, ev(P.create(T1, 'Held work'), 'orch', now - 60_000));
  putEvent(eventsDir, ev(P.claim(T1), 'impl', now - 50_000));
  const listed = await runCliAsync(['list', '--json'], root, cliEnv());
  expect(listed.code, listed.stderr).toBe(0);
  return { root, boardDir };
}

/** The environment of a hook process: no actor, its temporary directory `tmp`. */
function env(tmp: string): RunEnv {
  return cliEnv({ AGENTBOARD_HOOKS: undefined, TMPDIR: tmp });
}

describe('session-start through the built CLI', SLOW, () => {
  it('prints the SessionStart context with the held ticket and the inbox, and advances the cursor', async () => {
    const { root } = await claimedProject();
    const tmp = scratchDir();
    const payload = JSON.stringify({
      session_id: 'p-1',
      cwd: root,
      hook_event_name: 'SessionStart',
    });
    const first = hookProcess(['session-start', '--as', 'impl'], root, payload, env(tmp));
    expect(first.code, first.stderr).toBe(0);
    expect(first.stderr).toBe('');
    const doc = oneDocument({ ...first, signal: null }) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(doc.hookSpecificOutput.hookEventName).toBe('SessionStart');
    const lines = doc.hookSpecificOutput.additionalContext.replace(/\n$/, '').split('\n');
    expect(lines[0]).toContain(`${T1} impl`);
    expect(lines.slice(1).some((l) => l.includes('ticket.claim'))).toBe(true);

    const second = hookProcess(['session-start', '--as', 'impl'], root, payload, env(tmp));
    const again = oneDocument({ ...second, signal: null }) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(again.hookSpecificOutput.additionalContext.replace(/\n$/, '').split('\n')).toEqual([
      lines[0],
    ]);
    expect(readdirSync(tmp)).toEqual([]);
  });
});

describe('stop through the built CLI', SLOW, () => {
  it('strict blocks once with the reason on stderr; with stop_hook_active it continues with a systemMessage', async () => {
    const { root } = await claimedProject();
    const tmp = scratchDir();
    const stop = (active: boolean): string =>
      JSON.stringify({
        session_id: 'p-1',
        cwd: root,
        hook_event_name: 'Stop',
        stop_hook_active: active,
      });
    const blocked = hookProcess(['stop', '--strict', '--as', 'impl'], root, stop(false), env(tmp));
    expect(blocked.code).toBe(2);
    expect(blocked.stdout).toBe('');
    expect(blocked.stderr).toContain(T1);
    expect(blocked.stderr).toContain('agentboard handoff');

    const again = hookProcess(['stop', '--strict', '--as', 'impl'], root, stop(true), env(tmp));
    expect(again.code).toBe(0);
    expect(again.stderr).toBe('');
    const doc = oneDocument({ ...again, signal: null }) as Record<string, unknown>;
    expect(Object.keys(doc)).toEqual(['systemMessage']);
    expect(`${String(doc.systemMessage)}\n`).toBe(blocked.stderr);
  });
});

describe('pre-tool-use through the built CLI', SLOW, () => {
  it('warns once per session across processes, with the state in TMPDIR; strict blocks every time', async () => {
    const { root } = await claimedProject();
    const tmp = scratchDir();
    const edit = (session: string): string =>
      JSON.stringify({
        session_id: session,
        cwd: root,
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: join(root, 'src', 'a.ts'), old_string: 'a', new_string: 'b' },
      });

    const first = hookProcess(['pre-tool-use', '--as', 'nobody'], root, edit('p-1'), env(tmp));
    expect(first.code, first.stderr).toBe(0);
    const doc = oneDocument({ ...first, signal: null }) as {
      hookSpecificOutput: Record<string, unknown>;
    };
    expect(doc.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(doc.hookSpecificOutput).not.toHaveProperty('permissionDecision');
    expect(String(doc.hookSpecificOutput.additionalContext)).toContain('agentboard claim');

    const name = `agentboard-hook-${createHash('sha256').update('p-1').digest('hex')}`;
    expect(readdirSync(tmp)).toEqual([name]);
    expect(readFileSync(join(tmp, name), 'utf8').trim()).toMatch(/^\d+$/);

    const second = hookProcess(['pre-tool-use', '--as', 'nobody'], root, edit('p-1'), env(tmp));
    expect(second).toMatchObject({ code: 0, stdout: '', stderr: '' });

    for (let i = 0; i < 2; i += 1) {
      const strict = hookProcess(
        ['pre-tool-use', '--strict', '--as', 'nobody'],
        root,
        edit('p-1'),
        env(tmp),
      );
      expect(strict.code).toBe(2);
      expect(strict.stdout).toBe('');
      expect(strict.stderr).toContain('agentboard claim');
    }

    const held = hookProcess(
      ['pre-tool-use', '--strict', '--as', 'impl'],
      root,
      edit('p-2'),
      env(tmp),
    );
    expect(held).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(readdirSync(tmp)).toEqual([name]);
  });
});

describe('review round 1 through the built CLI', SLOW, () => {
  it('R1 scenario: write lock held by another process: session-start with a pending entry exits 0 within the bound, delivering and writing nothing', async () => {
    const { root, boardDir } = await claimedProject();
    const before = await peek(root, 'impl');
    expect(before.length).toBeGreaterThan(0);
    const holder = await holdWriteLock(join(boardDir, 'cache.sqlite'));
    let out: TimedHookRun;
    try {
      out = hookProcess(
        ['session-start', '--as', 'impl'],
        root,
        JSON.stringify({ session_id: 'p-1', cwd: root, hook_event_name: 'SessionStart' }),
        env(scratchDir()),
      );
    } finally {
      await release(holder);
    }
    expect(out.code, out.stderr).toBe(0);
    expect(out.ms).toBeLessThan(BOUND_MS);
    expect(out.stdout).toBe('');
    expect(out.stderr).not.toContain('internal error');
    expect(out.stderr === '' || /^agentboard hook: [^\n]*\n$/.test(out.stderr), out.stderr).toBe(
      true,
    );
    expect(await peek(root, 'impl')).toEqual(before);
  });

  it.each([
    ['empty stdin', ''],
    ['garbage', 'not json'],
    ['no stop_hook_active', '{"hook_event_name":"Stop"}'],
  ])('R2: stop --strict with %s does not block: exit 0 with a systemMessage', async (_l, stdin) => {
    const { root } = await claimedProject();
    const out = hookProcess(['stop', '--strict', '--as', 'impl'], root, stdin, env(scratchDir()));
    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr).toBe('');
    const doc = oneDocument({ ...out, signal: null }) as Record<string, unknown>;
    expect(Object.keys(doc)).toEqual(['systemMessage']);
    expect(String(doc.systemMessage)).toContain(T1);
  });

  it('R8 scenario: oversized payload: over 1 MiB is an unreadable payload; exactly 1 MiB is read', async () => {
    const { root } = await claimedProject();
    const stop = (bytes: number): string => {
      const head = JSON.stringify({
        session_id: 'p-1',
        hook_event_name: 'Stop',
        stop_hook_active: false,
      });
      return head + ' '.repeat(bytes - head.length);
    };
    const exact = hookProcess(
      ['stop', '--strict', '--as', 'impl'],
      root,
      stop(HOOK_STDIN_LIMIT),
      env(scratchDir()),
    );
    expect(exact.code, exact.stderr).toBe(2);
    expect(exact.stderr).toContain(T1);
    const over = hookProcess(
      ['stop', '--strict', '--as', 'impl'],
      root,
      stop(HOOK_STDIN_LIMIT + 1),
      env(scratchDir()),
    );
    expect(over.code, over.stderr).toBe(0);
    const doc = oneDocument({ ...over, signal: null }) as Record<string, unknown>;
    expect(Object.keys(doc)).toEqual(['systemMessage']);
    const edit = JSON.stringify({
      session_id: 'p-1',
      cwd: root,
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: join(root, 'src', 'a.ts'), content: 'x'.repeat(HOOK_STDIN_LIMIT) },
    });
    const big = hookProcess(
      ['pre-tool-use', '--strict', '--as', 'nobody'],
      root,
      edit,
      env(scratchDir()),
    );
    expect(big).toMatchObject({ code: 0, stdout: '', stderr: '' });
  });

  it.skipIf(process.platform === 'win32')(
    'R7 scenario: a FIFO, or a symbolic link to one, at the rate-limit name never blocks the hook: it warns',
    async () => {
      const { root } = await claimedProject();
      for (const viaLink of [false, true]) {
        const tmp = scratchDir();
        const name = join(
          tmp,
          `agentboard-hook-${createHash('sha256').update('p-fifo').digest('hex')}`,
        );
        const fifo = viaLink ? join(scratchDir(), 'fifo') : name;
        const made = spawnSync('mkfifo', [fifo]);
        expect(made.status, String(made.stderr)).toBe(0);
        if (viaLink) {
          symlinkSync(fifo, name);
        }
        const out = hookProcess(
          ['pre-tool-use', '--as', 'nobody'],
          root,
          JSON.stringify({
            session_id: 'p-fifo',
            cwd: root,
            hook_event_name: 'PreToolUse',
            tool_name: 'Write',
            tool_input: { file_path: join(root, 'a.ts'), content: 'x' },
          }),
          env(tmp),
          6000,
        );
        const label = viaLink ? 'symbolic link to a FIFO' : 'FIFO';
        expect(out.code, `${label}: ${out.stderr}`).toBe(0);
        expect(out.ms, label).toBeLessThan(BOUND_MS);
        const doc = oneDocument({ ...out, signal: null }) as {
          hookSpecificOutput: Record<string, unknown>;
        };
        expect(String(doc.hookSpecificOutput.additionalContext), label).toContain(
          'agentboard claim',
        );
      }
    },
  );
});

/**
 * A large board, timed through the built CLI; run locally with
 * AGENTBOARD_HOOK_TIMING=1 (not in CI, like the 500 ticket timing of task
 * 2.2): 24 000 events, impl holding 2000 tickets with no comment of its
 * own, 20 000 comments by orch.
 */
describe.runIf(process.env.AGENTBOARD_HOOK_TIMING === '1')(
  'R1 timing on a 24 000-event board (local only)',
  { timeout: 900_000 },
  () => {
    it('stop, session-start for a fresh actor and pre-tool-use answer within the bound; strict never blocks past the budget', async () => {
      const { root, eventsDir } = boardProject();
      const now = Date.now() - 3_600_000;
      const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
      const ids: string[] = [];
      for (let i = 0; i < 2000; i += 1) {
        const id = `01ARYZ6S41TSV4RRF${alphabet[Math.floor(i / 1024) % 32] ?? '0'}${alphabet[Math.floor(i / 32) % 32] ?? '0'}${alphabet[i % 32] ?? '0'}Q69GAV`;
        ids.push(id);
        putEvent(eventsDir, ev(P.create(id, `Ticket ${String(i)}`), 'orch', now, i));
        putEvent(eventsDir, ev(P.claim(id), 'impl', now + 1000, i));
      }
      for (let i = 0; i < 20_000; i += 1) {
        putEvent(
          eventsDir,
          ev(P.comment(ids[i % ids.length] ?? '', `orch note ${String(i)}`), 'orch', now + 2000, i),
        );
      }
      const listed = await runCliAsync(['list', '--json'], root, cliEnv());
      expect(listed.code, listed.stderr).toBe(0);
      const stop = JSON.stringify({
        session_id: 't',
        cwd: root,
        hook_event_name: 'Stop',
        stop_hook_active: false,
      });
      for (const argv of [
        ['stop', '--strict', '--as', 'impl'],
        ['stop', '--as', 'impl'],
        ['session-start', '--as', 'fresh'],
        ['pre-tool-use', '--strict', '--as', 'nobody'],
      ]) {
        const out = hookProcess(argv, root, stop, env(scratchDir()));
        const label = argv.join(' ');
        expect(out.ms, label).toBeLessThan(BOUND_MS);
        if (out.code === 2) {
          expect(out.ms, `${label}: blocked after the budget`).toBeLessThan(HOOK_BUDGET_MS + 500);
          expect(out.stderr.length).toBeLessThanOrEqual(STOP_TEXT_LIMIT + 1);
        } else {
          expect(out.code, label).toBe(0);
        }
      }
    });
  },
);
