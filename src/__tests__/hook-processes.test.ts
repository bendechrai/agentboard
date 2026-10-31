/**
 * `agentboard hook` through the built CLI (add-harness-integration task
 * 1.1; board-harness-hooks "Hook command and protocol", "Hook actor
 * resolution"; board-cli "Exit codes", "Command surface"; design.md
 * decision 3): the executable routes `hook` to the hook runner, reads the
 * payload from stdin, keeps to the 2 second budget, fails open and writes
 * nothing.
 *
 * Determinism. The locked cache is held by a child process that takes an
 * exclusive SQLite lock (`locking_mode = EXCLUSIVE`, which blocks even WAL
 * readers) and says `locked` on stdout; the hook is started only after
 * that line, and the lock is held until the test kills the holder, far
 * longer than any bound asserted. So the lock is in place for the whole
 * run, and the only timing assumption is the spec's own: a run answers
 * within 3 seconds (the 2 second budget plus process start-up). A hook
 * that waited on the lock would wait for the cache's 5 second busy
 * timeout or for the holder, and fail the bound by a wide margin.
 * Likewise stdin left open is never closed by the test.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { canonicalHash } from '../events/canonical.js';
import type { TicketGrantEvent } from '../events/schema.js';
import { ev, eventNames, P, putEvent, T1, T2 } from '../store/__tests__/helpers.js';
import { cacheHashes } from '../store/__tests__/v020-cache.js';
import { TOKEN_FIXTURES, expectNoLeak } from './harness/secret-fixtures.js';
import { fixtureProject } from './harness/upgrade.js';
import {
  boardProject,
  cliEnv,
  oneDocument,
  requireBuiltCli,
  runCliAsync,
  scratchDir,
  startCli,
  type RunEnv,
} from './harness/processes.js';

/** Every test spawns several CLI processes; a loaded machine needs time. */
const SLOW = { timeout: 120_000 };

/** The spec's bound on a hook run (board-harness-hooks "Time budget"). */
const BOUND_MS = 3000;

/** A finished hook process. */
interface HookRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Milliseconds from spawn to exit. */
  ms: number;
}

const children = new Set<ChildProcess>();

afterAll(() => {
  for (const child of children) {
    child.kill('SIGKILL');
  }
});

/**
 * Runs `node dist/cli.js hook <argv>` in `cwd`. `stdin` is written and
 * closed; null leaves stdin open (never closed by the test). The child is
 * killed after 20 seconds.
 */
function runHook(
  argv: readonly string[],
  cwd: string,
  stdin: string | null,
  env: RunEnv = cliEnv(),
): Promise<HookRun> {
  const cli = requireBuiltCli();
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      childEnv[key] = value;
    }
  }
  const started = performance.now();
  const child = spawn(process.execPath, [cli, 'hook', ...argv], {
    cwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
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
  child.stdin.on('error', () => undefined);
  if (stdin !== null) {
    child.stdin.end(stdin);
  }
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      child.stdin.destroy();
      resolve({ code, signal, stdout, stderr, ms: performance.now() - started });
    });
  });
}

/**
 * A child holding an exclusive lock on the SQLite file at `path` until it
 * is killed; resolves once the lock is held.
 */
async function lockCache(path: string): Promise<ChildProcess> {
  const script = [
    "const { DatabaseSync } = require('node:sqlite');",
    'const db = new DatabaseSync(process.argv[1]);',
    "db.exec('PRAGMA locking_mode = EXCLUSIVE');",
    "db.exec('BEGIN EXCLUSIVE');",
    "db.prepare('SELECT count(*) FROM sqlite_master').get();",
    "process.stdout.write('locked\\n');",
    'setInterval(() => undefined, 60000);',
  ].join('\n');
  const child = spawn(process.execPath, ['--no-warnings', '-e', script, path], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let out = '';
  let err = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    err += chunk;
  });
  await new Promise<void>((resolve, reject) => {
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
async function unlock(child: ChildProcess): Promise<void> {
  const closed = new Promise<void>((resolve) => child.on('close', () => resolve()));
  child.kill('SIGKILL');
  await closed;
  children.delete(child);
}

/** A Claude Code PreToolUse payload writing `file` from `cwd`. */
function editPayload(cwd: string, file: string): string {
  return JSON.stringify({
    session_id: 'hook-processes',
    cwd,
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: file, content: 'x' },
  });
}

/** A Claude Code Stop payload. */
function stopPayload(cwd: string): string {
  return JSON.stringify({
    session_id: 'hook-processes',
    cwd,
    hook_event_name: 'Stop',
    stop_hook_active: false,
  });
}

/** Asserts exit 0, nothing on stdout and at most one line on stderr. */
function expectFailOpen(out: HookRun): void {
  expect(out.signal).toBeNull();
  expect(out.code, out.stderr).toBe(0);
  expect(out.stdout).toBe('');
  expect(out.stderr === '' || /^[^\n]*\n$/.test(out.stderr), out.stderr).toBe(true);
}

/** Every file under `dir` (recursively) with its bytes, as `path -> base64`. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (sub: string): void => {
    for (const name of readdirSync(join(dir, sub)).sort()) {
      const rel = sub === '' ? name : `${sub}/${name}`;
      if (statSync(join(dir, rel)).isDirectory()) {
        walk(rel);
      } else {
        out[rel] = readFileSync(join(dir, rel)).toString('base64');
      }
    }
  };
  walk('');
  return out;
}

/** A project whose board has T1 created by orch and claimed by `holder`, cache built. */
async function claimedProject(holder = 'impl'): Promise<{ root: string; boardDir: string }> {
  const { root, boardDir, eventsDir } = boardProject();
  const now = Date.now();
  putEvent(eventsDir, ev(P.create(T1, 'Held work'), 'orch', now - 60_000));
  putEvent(eventsDir, ev(P.claim(T1), holder, now - 50_000));
  const listed = await runCliAsync(['list', '--json'], root, cliEnv());
  expect(listed.code, listed.stderr).toBe(0);
  return { root, boardDir };
}

describe('the executable routes hook to the hook runner', SLOW, () => {
  it('scenario: no board: pre-tool-use --strict exits 0 and prints nothing to stdout', async () => {
    const dir = scratchDir();
    for (const env of [cliEnv(), cliEnv({ AGENTBOARD_ACTOR: 'impl' })]) {
      const out = await runHook(
        ['pre-tool-use', '--strict'],
        dir,
        editPayload(dir, join(dir, 'a.ts')),
        env,
      );
      expectFailOpen(out);
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it('board-cli scenario: hook never reports a board error: stop with no board exits 0, not 2', async () => {
    const dir = scratchDir();
    for (const argv of [['stop'], ['stop', '--strict'], ['session-start'], ['pre-tool-use']]) {
      const out = await runHook([...argv, '--as', 'impl'], dir, stopPayload(dir));
      expectFailOpen(out);
    }
  });

  it('scenario: garbage payload: stop with stdin "not json" exits 0', async () => {
    const { root } = await claimedProject();
    for (const env of [cliEnv(), cliEnv({ AGENTBOARD_ACTOR: 'impl' })]) {
      const out = await runHook(['stop'], root, 'not json', env);
      expect(out.code, out.stderr).toBe(0);
      expect(out.stderr === '' || /^[^\n]*\n$/.test(out.stderr)).toBe(true);
    }
  });

  it('scenario: unknown event is not repeated, with and without --json', async () => {
    const { root } = await claimedProject();
    for (const f of TOKEN_FIXTURES) {
      for (const argv of [[f.value], [f.value, '--json']]) {
        const out = await runHook(
          argv,
          root,
          stopPayload(root),
          cliEnv({ AGENTBOARD_ACTOR: 'impl' }),
        );
        expect(out.code, f.name).toBe(0);
        expect(out.stdout, f.name).toBe('');
        expect(out.stderr).toMatch(/^[^\n]*\n$/);
        for (const event of ['session-start', 'stop', 'pre-tool-use']) {
          expect(out.stderr).toContain(event);
        }
        expectNoLeak(`hook ${f.name}`, [out.stdout, out.stderr]);
      }
    }
  });

  it('an argument error never exits 1, the usual usage code', async () => {
    const dir = scratchDir();
    for (const argv of [[], ['stop', '--frobnicate'], ['stop', 'extra'], ['stop', '--as']]) {
      const out = await runHook(argv, dir, '{}');
      expect(out.code, argv.join(' ')).toBe(0);
      expect(out.stdout).toBe('');
    }
  });

  it('agentboard hook --help prints the help of hook like any command', async () => {
    const dir = scratchDir();
    const out = await runCliAsync(['hook', '--help'], dir, cliEnv());
    expect(out.code, out.stderr).toBe(0);
    for (const word of ['session-start', 'stop', 'pre-tool-use', '--strict']) {
      expect(out.stdout).toContain(word);
    }
  });

  it('scenario: hook has help: help hook with no board and no actor', async () => {
    const dir = scratchDir();
    const out = await runCliAsync(['help', 'hook'], dir, cliEnv());
    expect(out.code, out.stderr).toBe(0);
    for (const word of ['session-start', 'stop', 'pre-tool-use', '--strict', 'agentboard hook']) {
      expect(out.stdout).toContain(word);
    }
    expect(out.stdout).not.toContain('Accepted and ignored');
    expect(out.stdout).toMatch(/^ +0 /m);
    expect(out.stdout).toMatch(/^ +2 /m);
  });
});

describe('scenario: time budget', SLOW, () => {
  it('with the cache locked longer than 2 seconds, pre-tool-use --strict exits 0 within 3 seconds', async () => {
    const { root, boardDir } = await claimedProject('someone-else');
    const holder = await lockCache(join(boardDir, 'cache.sqlite'));
    try {
      // impl holds nothing, so a hook that got past the lock would deny
      // this edit in strict mode.
      const out = await runHook(
        ['pre-tool-use', '--strict', '--as', 'impl'],
        root,
        editPayload(root, join(root, 'src', 'a.ts')),
      );
      expectFailOpen(out);
      expect(out.ms).toBeLessThan(BOUND_MS);
      for (const argv of [
        ['stop', '--strict', '--as', 'someone-else'],
        ['session-start', '--as', 'impl'],
      ]) {
        const other = await runHook(argv, root, stopPayload(root));
        expect(other.code, argv.join(' ')).toBe(0);
        expect(other.ms, argv.join(' ')).toBeLessThan(BOUND_MS);
      }
    } finally {
      await unlock(holder);
    }
  });

  it('the in-process view gives up at its deadline on a locked cache', async () => {
    const { root, boardDir } = await claimedProject();
    const holder = await lockCache(join(boardDir, 'cache.sqlite'));
    try {
      const { readHookView } = await import('../board/hook.js');
      const started = performance.now();
      const view = readHookView({
        cwd: root,
        env: cliEnv(),
        deadline: Date.now() + 200,
      });
      expect(view).toBeNull();
      expect(performance.now() - started).toBeLessThan(BOUND_MS - 1000);
    } finally {
      await unlock(holder);
    }
  });

  it('stdin that never ends does not hold the hook past the bound', async () => {
    const { root } = await claimedProject();
    for (const argv of [
      ['pre-tool-use', '--strict', '--as', 'impl'],
      ['stop', '--as', 'nobody'],
    ]) {
      const out = await runHook(argv, root, null);
      expect(out.code, argv.join(' ')).toBe(0);
      expect(out.ms).toBeLessThan(BOUND_MS);
    }
  });
});

describe('scenario: escape hatch', SLOW, () => {
  it('AGENTBOARD_HOOKS=off: stop --strict with a claimed, un-handed-off ticket exits 0 and prints nothing', async () => {
    const { root } = await claimedProject();
    const out = await runHook(
      ['stop', '--strict', '--as', 'impl'],
      root,
      stopPayload(root),
      cliEnv({ AGENTBOARD_HOOKS: 'off' }),
    );
    expect(out).toMatchObject({ code: 0, stdout: '', stderr: '' });
  });

  it('exits at once: without reading stdin, which stays open, and without touching a locked cache', async () => {
    const { root, boardDir } = await claimedProject();
    const holder = await lockCache(join(boardDir, 'cache.sqlite'));
    try {
      for (const argv of [
        ['stop', '--strict', '--as', 'impl'],
        ['pre-tool-use', '--strict'],
        ['session-start'],
      ]) {
        const out = await runHook(argv, root, null, cliEnv({ AGENTBOARD_HOOKS: 'off' }));
        expect(out).toMatchObject({ code: 0, stdout: '', stderr: '' });
        // Well under the 2 second budget a stdin read or the lock would use.
        expect(out.ms, argv.join(' ')).toBeLessThan(2000);
      }
    } finally {
      await unlock(holder);
    }
  });
});

describe('scenario: cache of another schema version', SLOW, () => {
  it('pre-tool-use --strict exits 0 without blocking, and the cache file is byte-identical afterwards', async () => {
    const { root, boardDir, cache } = fixtureProject('plain');
    const before = cacheHashes(cache);
    const files = tree(boardDir);
    const out = await runHook(
      ['pre-tool-use', '--strict', '--as', 'nobody'],
      root,
      editPayload(root, join(root, 'src', 'a.ts')),
    );
    expectFailOpen(out);
    expect(cacheHashes(cache)).toEqual(before);
    expect(tree(boardDir)).toEqual(files);
  });

  it('a missing cache is not created', async () => {
    const { root, boardDir, eventsDir } = boardProject();
    putEvent(eventsDir, ev(P.create(T1), 'orch', Date.now() - 1000));
    for (const argv of [
      ['pre-tool-use', '--strict', '--as', 'nobody'],
      ['session-start', '--as', 'nobody'],
    ]) {
      expectFailOpen(await runHook(argv, root, editPayload(root, join(root, 'a.ts'))));
    }
    expect(existsSync(join(boardDir, 'cache.sqlite'))).toBe(false);
    expect(readdirSync(boardDir)).toEqual(['events']);
  });
});

describe('scenario: read-only', SLOW, () => {
  it('pre-tool-use and stop leave event files, cache and cursors byte-identical, with a grant due and not written', async () => {
    // merger-1 claimed T1, merger-2 joined, merger-1 released 30 seconds
    // ago, so the grant to merger-2 is due; impl claimed T2. The cache is
    // built by rebuild, which never writes a grant, and the actors' cursors
    // are stored by inbox calls on a clock stopped at the release.
    const { root, boardDir, eventsDir } = boardProject();
    const now = Date.now();
    const at = (ago: number): number => now - ago;
    putEvent(eventsDir, ev(P.create(T1, 'Merge lock'), 'orch', at(90_000)));
    putEvent(eventsDir, ev(P.create(T2, 'Work'), 'orch', at(90_000), 1));
    putEvent(eventsDir, ev(P.claim(T1), 'merger-1', at(80_000)));
    putEvent(
      eventsDir,
      ev({ kind: 'ticket.queue.join', ticket: T1, body: { ttl: 600_000 } }, 'merger-2', at(70_000)),
    );
    putEvent(eventsDir, ev(P.claim(T2), 'impl', at(60_000)));
    const released = at(30_000);
    const release = putEvent(
      eventsDir,
      ev({ kind: 'ticket.release', ticket: T1, body: {} }, 'merger-1', released),
    );
    const grant: TicketGrantEvent = {
      v: 1,
      kind: 'ticket.grant',
      ticket: T1,
      actor: 'agentboard',
      ts: { wall: released + 1, counter: 0, actor: 'agentboard' },
      body: { to: 'merger-2', ttl: 600_000, window: 120_000, after: { released: release } },
    };
    const grantFile = `${canonicalHash(grant)}.json`;
    expect((await runCliAsync(['rebuild'], root, cliEnv())).code).toBe(0);
    for (const actor of ['merger-2', 'impl']) {
      const inbox = await startCli(
        { argv: ['inbox', '--as', actor, '--json'], env: cliEnv(), clockFixedMs: released },
        root,
      ).exited;
      expect(inbox.code, inbox.stderr).toBe(0);
    }
    expect(eventNames(eventsDir)).not.toContain(grantFile);
    const files = tree(boardDir);
    const hashes = cacheHashes(join(boardDir, 'cache.sqlite'));

    for (const actor of ['merger-2', 'merger-1', 'impl']) {
      for (const argv of [
        ['pre-tool-use'],
        ['pre-tool-use', '--strict'],
        ['stop'],
        ['stop', '--strict'],
      ]) {
        const payload =
          argv[0] === 'stop' ? stopPayload(root) : editPayload(root, join(root, 'src', 'a.ts'));
        const out = await runHook([...argv, '--as', actor], root, payload);
        expect([0, 2], `${argv.join(' ')} ${actor}: ${out.stderr}`).toContain(out.code);
      }
    }

    expect(tree(boardDir)).toEqual(files);
    expect(cacheHashes(join(boardDir, 'cache.sqlite'))).toEqual(hashes);
    expect(eventNames(eventsDir)).not.toContain(grantFile);

    // The grant was due all along: the next inbox writes it and returns it.
    const inbox = await runCliAsync(['inbox', '--as', 'merger-2', '--json'], root, cliEnv());
    expect(inbox.code, inbox.stderr).toBe(0);
    expect(eventNames(eventsDir)).toContain(grantFile);
    const doc = oneDocument(inbox) as { entries: { hash: string }[] };
    expect(doc.entries.map((e) => `${e.hash}.json`)).toContain(grantFile);
  });
});
