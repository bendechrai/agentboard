/**
 * The `serve` command in process, through `runCliAsync` with a stop signal
 * the test controls (board-web: "Serve command"; board-cli: "Command
 * surface" scenario "Serve has help", "Exit codes" scenario "Port in use
 * is a usage-class failure"; add-board-web task 3.1): the start-up line
 * and the `--json` line, `--port` validation, `port-in-use` with its hint,
 * no board, `--open` and its failure warning, and the system opener.
 * Write mode (board-web-actions: "Write mode is opt-in with an explicit
 * actor", "Close from the browser"; board-web: "Serve command" as modified
 * by add-board-web-actions; board-cli: "Actor is explicit" scenario "Serve
 * ignores the environment actor"; add-board-web-actions task 1.1): the
 * writable start-up line, AGENTBOARD_ACTOR ignored, an empty `--as`, the
 * tree root of decision paths, and the help of `--as`. The real SIGINT and SIGTERM are exercised on the built
 * CLI in src/__tests__/serve-processes.test.ts.
 */

import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LazyBoard, runCliAsync, runContext, type AsyncCliIo } from '../../cli/main.js';
import { parseArgs } from '../../cli/parse.js';
import { findCommand } from '../../cli/registry.js';
import type { StreamIo } from '../../cli/types.js';
import { run, cliEnv, type RunEnv } from '../../cli/__tests__/cli-helpers.js';
import { splitCommandLine } from '../../guidance/__tests__/command-line.js';
import { findBoard } from '../../store/locate.js';
import { gitRepo } from '../../store/__tests__/helpers.js';
import { ACTION_NAMES } from '../actions.js';
import { openInBrowser, serveCommand, type Spawner } from '../serve.js';
import { cliOk, eventFiles, newEvents, newTicket, post, showTicket } from './action-helpers.js';
import { freePort, occupiedPort, project, request, scratch, until } from './web-helpers.js';

/** A running in-process `agentboard <argv>`. */
interface Running {
  stdout(): string;
  stderr(): string;
  /** Aborts the stop signal (as SIGINT would). */
  stop(): void;
  /** The exit code, once the command has returned. */
  readonly done: Promise<number>;
}

function start(argv: readonly string[], cwd: string, env: RunEnv = cliEnv()): Running {
  let stdout = '';
  let stderr = '';
  const controller = new AbortController();
  const io: AsyncCliIo = {
    argv,
    cwd,
    // CI is always set here: these servers run the real opener by default,
    // and vitest's stdout may be a terminal, so without it a plain
    // `serve` would open a browser on the developer's machine
    // (add-serve-auto-open; the open decision is tested with injected seams
    // in serve-open.test.ts).
    env: { ...env, CI: '1' },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    stopSignal: () => controller.signal,
  };
  const done = runCliAsync(io).then((code) => Number(code));
  return {
    stdout: () => stdout,
    stderr: () => stderr,
    stop: () => {
      controller.abort();
    },
    done,
  };
}

/** Waits for the start-up line, then returns it without its newline. */
async function startupLine(running: Running): Promise<string> {
  await until(() => running.stdout().includes('\n'), 5000, 'the start-up line');
  return running.stdout().split('\n')[0] ?? '';
}

/** Does something listen on 127.0.0.1:`port`? */
async function portIsFree(port: number): Promise<boolean> {
  const probe = createServer();
  return new Promise((resolve) => {
    probe.once('error', () => {
      resolve(false);
    });
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => {
        resolve(true);
      });
    });
  });
}

describe('scenario: Start and stop (in process)', () => {
  it('prints one JSON line with url, port, token, writable false and actor null, serves, and exits 0 when stopped', async () => {
    const { root } = project();
    const running = start(['serve', '--port', '0', '--json'], root);
    const line = await startupLine(running);
    const doc = JSON.parse(line) as Record<string, unknown>;
    expect(Object.keys(doc)).toEqual(['url', 'port', 'token', 'writable', 'actor']);
    expect(doc.actor).toBeNull();
    expect(typeof doc.port).toBe('number');
    const port = doc.port as number;
    expect(port).toBeGreaterThan(0);
    expect(doc.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(doc.writable).toBe(false);
    expect(doc.url).toBe(`http://127.0.0.1:${String(port)}/#token=${String(doc.token)}`);
    // The page needs no token; the API needs the bearer header.
    const page = await request(port, '/');
    expect(page.status).toBe(200);
    expect(page.headers['set-cookie']).toBeUndefined();
    const session = await request(port, '/api/session', {
      headers: { Authorization: `Bearer ${String(doc.token)}` },
    });
    expect(session.status).toBe(200);
    running.stop();
    expect(await running.done).toBe(0);
    expect(running.stdout()).toBe(`${line}\n`);
    expect(running.stderr()).toBe('');
    expect(await portIsFree(port)).toBe(true);
  });

  it('prints serving <board dir> read-only at <url> without --json', async () => {
    const { root, boardDir } = project();
    const running = start(['serve'], root);
    const line = await startupLine(running);
    const match =
      /^serving (.+) read-only at (http:\/\/127\.0\.0\.1:(\d+)\/#token=([A-Za-z0-9_-]{43}))$/.exec(
        line,
      );
    expect(match, line).not.toBeNull();
    expect(match?.[1]).toBe(findBoard({ cwd: root, env: cliEnv() }).dir);
    expect(match?.[1]).toBe(boardDir);
    running.stop();
    expect(await running.done).toBe(0);
    expect(running.stdout()).toBe(`${line}\n`);
  });

  it('serves on the port given with --port', async () => {
    const { root } = project();
    const port = await freePort();
    const running = start(['serve', '--port', String(port), '--json'], root);
    const doc = JSON.parse(await startupLine(running)) as { port: number };
    expect(doc.port).toBe(port);
    running.stop();
    expect(await running.done).toBe(0);
  });

  it('needs no actor', async () => {
    const { root } = project();
    const running = start(['serve', '--json'], root, cliEnv({ AGENTBOARD_ACTOR: undefined }));
    const doc = JSON.parse(await startupLine(running)) as { writable: boolean; actor: unknown };
    expect(doc).toMatchObject({ writable: false, actor: null });
    running.stop();
    expect(await running.done).toBe(0);
  });

  it('refuses the synchronous runCli with streaming-command', () => {
    const { root } = project();
    const out = run(['serve', '--json'], root);
    expect(out.code).toBe(1);
    expect(JSON.parse(out.stdout)).toMatchObject({
      error: { exitCode: 1, reason: 'streaming-command' },
    });
  });
});

describe('--port validation', () => {
  it.each([['70000'], ['65536'], ['-1'], ['abc'], ['1.5']])(
    '--port %s exits 1 usage, even where there is no board',
    async (port) => {
      for (const cwd of [project().root, scratch()]) {
        const running = start(['serve', '--port', port, '--json'], cwd);
        expect(await running.done).toBe(1);
        expect(JSON.parse(running.stdout())).toMatchObject({
          error: { exitCode: 1, reason: 'usage' },
        });
      }
    },
  );
});

describe('scenario: Port in use', () => {
  it('exits 1 port-in-use with a hint naming --port, and prints nothing else', async () => {
    const { root } = project();
    const port = await occupiedPort();
    const running = start(['serve', '--port', String(port), '--json'], root);
    expect(await running.done).toBe(1);
    const doc = JSON.parse(running.stdout()) as {
      error: { exitCode: number; reason: string; hint: string };
    };
    expect(doc.error).toMatchObject({ exitCode: 1, reason: 'port-in-use' });
    expect(doc.error.hint).toContain('--port');
    expect(running.stdout().trim().split('\n')).toHaveLength(1);
    expect(running.stderr()).toMatch(/^hint: .*--port/m);
    // Without --json: the message and the hint on stderr, nothing on stdout.
    const text = start(['serve', '--port', String(port)], root);
    expect(await text.done).toBe(1);
    expect(text.stdout()).toBe('');
    expect(text.stderr()).toContain(String(port));
  });
});

describe('scenario: No board', () => {
  it('exits 2 naming the path it looked at, and binds no port', async () => {
    const cwd = scratch();
    const port = await freePort();
    const running = start(['serve', '--port', String(port), '--json'], cwd);
    expect(await running.done).toBe(2);
    const doc = JSON.parse(running.stdout()) as {
      error: { exitCode: number; reason: string; message: string };
    };
    expect(doc.error).toMatchObject({ exitCode: 2, reason: 'board-not-found' });
    expect(doc.error.message).toContain(cwd);
    expect(running.stdout().trim().split('\n')).toHaveLength(1);
    expect(await portIsFree(port)).toBe(true);
  });
});

/** Runs `serveCommand` directly with an injected opener. */
function direct(argv: readonly string[], cwd: string, open: (url: string) => Promise<void>) {
  const parsed = parseArgs(argv);
  const env = cliEnv();
  const lazy = new LazyBoard(
    () => findBoard({ cwd, env }).dir,
    () => undefined,
  );
  let stdout = '';
  let stderr = '';
  const controller = new AbortController();
  const io: StreamIo = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    json: parsed.json,
    signal: controller.signal,
  };
  const done = serveCommand(runContext(cwd, env, null, lazy), parsed.values, io, { open }).finally(
    () => {
      lazy.close();
    },
  );
  return { stdout: () => stdout, stderr: () => stderr, stop: () => controller.abort(), done };
}

describe('--open', () => {
  it('asks the system to open the start-up URL, token in the fragment, once', async () => {
    const { root } = project();
    const opened: string[] = [];
    const running = direct(['serve', '--open', '--json'], root, (url) => {
      opened.push(url);
      return Promise.resolve();
    });
    await until(() => running.stdout().includes('\n'), 5000, 'the start-up line');
    const doc = JSON.parse(running.stdout()) as { url: string };
    await until(() => opened.length === 1, 3000, 'the opener');
    expect(opened).toEqual([doc.url]);
    expect(doc.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]{43}$/);
    running.stop();
    await running.done;
    expect(running.stderr()).toBe('');
  });

  it('does not open anything without --open', async () => {
    const { root } = project();
    const opened: string[] = [];
    const running = direct(['serve', '--json'], root, (url) => {
      opened.push(url);
      return Promise.resolve();
    });
    await until(() => running.stdout().includes('\n'), 5000, 'the start-up line');
    await new Promise((resolve) => setTimeout(resolve, 100));
    running.stop();
    await running.done;
    expect(opened).toEqual([]);
  });

  it('warns on stderr when the browser cannot be opened, and keeps serving', async () => {
    const { root } = project();
    const running = direct(['serve', '--open', '--json'], root, () =>
      Promise.reject(new Error('no opener here')),
    );
    await until(() => running.stderr().includes('\n'), 5000, 'the warning');
    expect(running.stderr()).toBe('agentboard: could not open a browser: no opener here\n');
    const doc = JSON.parse(running.stdout()) as { port: number; token: string };
    expect(running.stderr()).not.toContain(doc.token);
    const session = await request(doc.port, '/api/session', {
      headers: { Authorization: `Bearer ${doc.token}` },
    });
    expect(session.status).toBe(200);
    running.stop();
    await running.done;
    expect(running.stdout().trim().split('\n')).toHaveLength(1);
  });

  it('masks the token when the opener echoes the URL in its error', async () => {
    const { root } = project();
    const running = direct(['serve', '--open', '--json'], root, (url) =>
      Promise.reject(new Error(`xdg-open ${url} failed; retried ${url}`)),
    );
    await until(() => running.stderr().includes('\n'), 5000, 'the warning');
    const doc = JSON.parse(running.stdout()) as { port: number; token: string };
    const masked = `http://127.0.0.1:${String(doc.port)}/#token=<token>`;
    expect(running.stderr()).toBe(
      `agentboard: could not open a browser: xdg-open ${masked} failed; retried ${masked}\n`,
    );
    expect(running.stderr()).not.toContain(doc.token);
    running.stop();
    await running.done;
  });
});

/** A fake spawner recording its calls; each child ends as `outcome` says. */
function fakeSpawn(outcome: { code?: number | null; signal?: string; error?: Error }): {
  spawn: Spawner;
  calls: [string, readonly string[]][];
} {
  const calls: [string, readonly string[]][] = [];
  const spawn: Spawner = (command, args) => {
    calls.push([command, args]);
    const child = new EventEmitter();
    setImmediate(() => {
      if (outcome.error !== undefined) {
        child.emit('error', outcome.error);
      } else {
        child.emit('exit', outcome.code ?? null, outcome.signal ?? null);
      }
    });
    return child;
  };
  return { spawn, calls };
}

describe('openInBrowser', () => {
  const URL = 'http://127.0.0.1:4477/#token=abc';

  it.each([
    ['darwin', 'open', [URL]],
    ['linux', 'xdg-open', [URL]],
    ['freebsd', 'xdg-open', [URL]],
    ['win32', 'cmd', ['/c', 'start', '""', URL]],
  ] as const)('on %s runs %s by name', async (platform, command, args) => {
    const fake = fakeSpawn({ code: 0 });
    await openInBrowser(URL, { platform, spawn: fake.spawn });
    expect(fake.calls).toEqual([[command, args]]);
  });

  it('rejects when the opener cannot be spawned, exits non-zero or is killed', async () => {
    await expect(
      openInBrowser(URL, {
        platform: 'linux',
        spawn: fakeSpawn({ error: new Error('spawn xdg-open ENOENT') }).spawn,
      }),
    ).rejects.toThrow('ENOENT');
    await expect(
      openInBrowser(URL, { platform: 'linux', spawn: fakeSpawn({ code: 3 }).spawn }),
    ).rejects.toThrow();
    await expect(
      openInBrowser(URL, {
        platform: 'linux',
        spawn: fakeSpawn({ code: null, signal: 'SIGTERM' }).spawn,
      }),
    ).rejects.toThrow();
  });
});

describe('scenario: Serve has help', () => {
  it('prints the synopsis with --port, --open, --no-open and --as, the exit codes and examples, with no board and no actor', () => {
    const out = run(['help', 'serve'], scratch(), cliEnv({ AGENTBOARD_ACTOR: undefined }));
    expect(out.code, out.stderr).toBe(0);
    // add-serve-auto-open task 1.1: --open and --no-open are one optional
    // exclusive group, rendered as the spec's `[--open | --no-open]`.
    expect(out.stdout).toMatch(
      /^Usage: agentboard serve \[--port <port>\] \[--open \| --no-open\] \[--as <actor>\] \[--json\]$/m,
    );
    expect(out.stdout).toMatch(/^ {2}--open {2,}boolean, optional {2,}\S/m);
    expect(out.stdout).toMatch(/^ {2}--no-open {2,}boolean, optional {2,}\S/m);
    expect(out.stdout).toMatch(/^At most one of: --open \| --no-open$/m);
    expect(out.stdout).toMatch(/^\s+1 usage\s/m);
    expect(out.stdout).toMatch(/^\s+1 port-in-use\s/m);
    expect(out.stdout).toMatch(/^\s+2 board-not-found\s/m);
    expect(out.stdout).toMatch(/^\s+0\s+Stopped by SIGINT or SIGTERM/m);
    const spec = findCommand('serve');
    expect(spec?.group).toBe('awareness');
    expect(spec?.writes).toBe(false);
    expect(spec?.tracksCursor ?? false).toBe(false);
    expect(spec?.stream).toBeDefined();
    expect(spec?.examples.length).toBeGreaterThan(0);
    for (const example of spec?.examples ?? []) {
      expect(out.stdout).toContain(example.command);
      const words = splitCommandLine(example.command);
      expect(parseArgs(words.slice(1)).command.name).toBe('serve');
    }
  });
});

// add-board-web-actions task 1.1: `serve --as <actor>` enables the write
// actions as that actor only; AGENTBOARD_ACTOR never does.

/** The start-up document of `serve --json`. */
interface StartupDoc {
  url: string;
  port: number;
  token: string;
  writable: boolean;
  actor: string | null;
}

describe('scenario: Writable start-up', () => {
  it('prints writable true and actor ben for serve --port 0 --json --as ben', async () => {
    const { root, boardDir } = project();
    const running = start(['serve', '--port', '0', '--json', '--as', 'ben'], root);
    const line = await startupLine(running);
    const doc = JSON.parse(line) as StartupDoc;
    expect(Object.keys(doc)).toEqual(['url', 'port', 'token', 'writable', 'actor']);
    expect(doc.writable).toBe(true);
    expect(doc.actor).toBe('ben');
    expect(doc.url).toBe(`http://127.0.0.1:${String(doc.port)}/#token=${doc.token}`);
    const session = await request(doc.port, '/api/session', {
      headers: { Authorization: `Bearer ${doc.token}` },
    });
    expect(JSON.parse(session.body)).toMatchObject({ boardDir, writable: true, actor: 'ben' });
    expect(session.headers['set-cookie']).toBeUndefined();
    running.stop();
    expect(await running.done).toBe(0);
    expect(running.stdout()).toBe(`${line}\n`);
    expect(running.stderr()).toBe('');
  });

  it('prints serving <board dir> as <actor> at <url> without --json', async () => {
    const { root, boardDir } = project();
    const running = start(['serve', '--as', 'ben'], root);
    const line = await startupLine(running);
    const match =
      /^serving (.+) as ben at (http:\/\/127\.0\.0\.1:(\d+)\/#token=([A-Za-z0-9_-]{43}))$/.exec(
        line,
      );
    expect(match, line).not.toBeNull();
    expect(match?.[1]).toBe(boardDir);
    running.stop();
    expect(await running.done).toBe(0);
    expect(running.stdout()).toBe(`${line}\n`);
  });

  it(
    'takes the actor from --as (or --as=<actor>), never from AGENTBOARD_ACTOR',
    { timeout: 20_000 },
    async () => {
      for (const flag of [['--as', 'ben'], ['--as=ben']]) {
        const { root, eventsDir } = project();
        const id = newTicket(root);
        const running = start(
          ['serve', '--json', ...flag],
          root,
          cliEnv({ AGENTBOARD_ACTOR: 'impl-1' }),
        );
        const doc = JSON.parse(await startupLine(running)) as StartupDoc;
        expect(doc).toMatchObject({ writable: true, actor: 'ben' });
        const before = eventFiles(eventsDir);
        const result = await post(doc, 'comment', { id, text: 'hello' });
        expect(result.status, result.body).toBe(200);
        expect(newEvents(eventsDir, before).map((e) => e.event.actor)).toEqual(['ben']);
        running.stop();
        expect(await running.done).toBe(0);
      }
    },
  );
});

describe('scenario: Environment actor does not enable writes', () => {
  it('says read-only on start-up with AGENTBOARD_ACTOR=impl-1 and no --as', async () => {
    const { root } = project();
    const running = start(['serve'], root, cliEnv({ AGENTBOARD_ACTOR: 'impl-1' }));
    const line = await startupLine(running);
    expect(line).toMatch(/^serving .+ read-only at http:\/\/127\.0\.0\.1:\d+\/#token=/);
    expect(line).not.toContain('impl-1');
    running.stop();
    expect(await running.done).toBe(0);
  });

  it(
    'reports writable false and actor null, and refuses every action with read-only',
    { timeout: 20_000 },
    async () => {
      const { root, eventsDir } = project();
      const id = newTicket(root);
      const running = start(['serve', '--json'], root, cliEnv({ AGENTBOARD_ACTOR: 'impl-1' }));
      const doc = JSON.parse(await startupLine(running)) as StartupDoc;
      expect(doc).toMatchObject({ writable: false, actor: null });
      const session = await request(doc.port, '/api/session', {
        headers: { Authorization: `Bearer ${doc.token}` },
      });
      expect(JSON.parse(session.body)).toMatchObject({ writable: false, actor: null });
      const before = eventFiles(eventsDir);
      for (const action of ACTION_NAMES) {
        const result = await post(doc, action, { id });
        expect(result.status, `${action}: ${result.body}`).toBe(405);
        expect(JSON.parse(result.body)).toMatchObject({
          error: { exitCode: 1, reason: 'read-only' },
        });
      }
      expect(eventFiles(eventsDir)).toEqual(before);
      running.stop();
      expect(await running.done).toBe(0);
    },
  );
});

/**
 * The exit code of `running` once it returns within `ms`; otherwise stops
 * it (as SIGINT would) and returns the string `still running`.
 */
async function exitWithin(running: Running, ms: number): Promise<number | string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      resolve('still running');
    }, ms);
  });
  const outcome = await Promise.race([running.done, late]);
  clearTimeout(timer);
  if (outcome === 'still running') {
    running.stop();
    await running.done;
  }
  return outcome;
}

describe('an empty --as', () => {
  it.each([[['--as', '']], [['--as=']]])(
    '%j exits 1 usage naming --as, before any board lookup or listening',
    { timeout: 20_000 },
    async (flag) => {
      for (const cwd of [project().root, scratch()]) {
        const port = await freePort();
        const running = start(['serve', '--port', String(port), '--json', ...flag], cwd);
        expect(await exitWithin(running, 3000)).toBe(1);
        const doc = JSON.parse(running.stdout()) as {
          error: { exitCode: number; reason: string; message: string };
        };
        expect(doc.error).toMatchObject({ exitCode: 1, reason: 'usage' });
        expect(doc.error.message).toContain('--as');
        expect(running.stdout().trim().split('\n')).toHaveLength(1);
        expect(await portIsFree(port)).toBe(true);
      }
    },
  );
});

describe('scenario: Decision path relative to the tree root (serve started in <root>/src)', () => {
  it(
    'records docs/adr/0006-web.md relative to the git working tree root',
    { timeout: 20_000 },
    async () => {
      const root = gitRepo(join(scratch(), 'repo'));
      mkdirSync(join(root, '.board', 'events'), { recursive: true });
      mkdirSync(join(root, 'docs', 'adr'), { recursive: true });
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'docs', 'adr', '0006-web.md'), '# ADR\n');
      const id = newTicket(root);
      for (const status of ['tests', 'implementing', 'review', 'merged']) {
        cliOk(root, ['move', id, status, '--as', 'orch']);
      }
      const running = start(['serve', '--json', '--as', 'ben'], join(root, 'src'));
      const doc = JSON.parse(await startupLine(running)) as StartupDoc;
      // link --decision resolves the same way (design.md: "Close paths
      // relative to the tree root").
      const linked = await post(doc, 'link', { id, decision: 'docs/adr/0006-web.md' });
      expect(linked.status, linked.body).toBe(200);
      expect(
        showTicket(root, id).links.map((link) => (link.type === 'decision' ? link.path : null)),
      ).toEqual(['docs/adr/0006-web.md']);
      const result = await post(doc, 'close', {
        id,
        'decision-recorded-in': 'docs/adr/0006-web.md',
      });
      expect(result.status, result.body).toBe(200);
      const ticket = showTicket(root, id);
      expect(ticket.closed).toBe(true);
      expect(ticket.disposition).toEqual({ decision: 'docs/adr/0006-web.md' });
      running.stop();
      expect(await running.done).toBe(0);
    },
  );

  it('resolves against the start directory itself outside git', { timeout: 20_000 }, async () => {
    const { root, boardDir } = project();
    mkdirSync(join(root, 'docs', 'adr'), { recursive: true });
    writeFileSync(join(root, 'docs', 'adr', '0006-web.md'), '# ADR\n');
    const src = join(root, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'note.md'), '# Note\n');
    const id = newTicket(root);
    cliOk(root, ['move', id, 'blocked', '--as', 'orch']);
    const running = start(
      ['serve', '--json', '--as', 'ben'],
      src,
      cliEnv({ AGENTBOARD_DIR: boardDir }),
    );
    const doc = JSON.parse(await startupLine(running)) as StartupDoc;
    const missing = await post(doc, 'close', {
      id,
      'decision-recorded-in': 'docs/adr/0006-web.md',
    });
    expect(missing.status, missing.body).toBe(400);
    expect(JSON.parse(missing.body)).toMatchObject({ error: { reason: 'decision-path-missing' } });
    const result = await post(doc, 'close', { id, 'decision-recorded-in': 'note.md' });
    expect(result.status, result.body).toBe(200);
    expect(showTicket(root, id).disposition).toEqual({ decision: 'note.md' });
    running.stop();
    expect(await running.done).toBe(0);
  });
});

describe('the help of serve (drift guard for --as)', () => {
  it('describes --as as the write actor, and no longer says it is ignored', () => {
    const out = run(['help', 'serve'], scratch(), cliEnv({ AGENTBOARD_ACTOR: undefined }));
    expect(out.code, out.stderr).toBe(0);
    const spec = findCommand('serve');
    expect(spec?.actorHelp).toBeDefined();
    expect(spec?.actorHelp).toMatch(/write/i);
    expect(spec?.actorHelp).toContain('AGENTBOARD_ACTOR');
    expect(out.stdout).toMatch(
      new RegExp(
        `^  --as <actor> {2,}string, optional {2,}${escapeRe(spec?.actorHelp ?? '')}$`,
        'm',
      ),
    );
    expect(out.stdout).not.toContain('Accepted and ignored by this command');
    expect(out.stdout).not.toContain('--as is ignored');
    expect(spec?.description).toContain('serving <board dir> as <actor> at <url>');
    expect(spec?.description).not.toMatch(/--as is ignored/);
    // Still needs no actor to run, and is still not a writing command of the registry.
    expect(spec?.writes).toBe(false);
    expect(spec?.tracksCursor ?? false).toBe(false);
    const usage = spec?.exitCodes.find((e) => e.code === 1 && e.reason === 'usage');
    expect(usage?.meaning).toContain('--as');
  });

  it('has an example with --as that parses to serve with that actor', () => {
    const spec = findCommand('serve');
    const withActor = (spec?.examples ?? []).filter((e) => / --as /.test(e.command));
    expect(withActor.length).toBeGreaterThan(0);
    for (const example of withActor) {
      const parsed = parseArgs(splitCommandLine(example.command).slice(1));
      expect(parsed.command.name).toBe('serve');
      expect(typeof parsed.values.as).toBe('string');
      expect(parsed.values.as).not.toBe('');
    }
  });
});

/** `text` with the regular expression metacharacters escaped. */
function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
