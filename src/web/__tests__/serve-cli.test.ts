/**
 * The `serve` command in process, through `runCliAsync` with a stop signal
 * the test controls (board-web: "Serve command"; board-cli: "Command
 * surface" scenario "Serve has help", "Exit codes" scenario "Port in use
 * is a usage-class failure"; add-board-web task 3.1): the start-up line
 * and the `--json` line, `--port` validation, `port-in-use` with its hint,
 * no board, `--as` ignored, `--open` and its failure warning, and the
 * system opener. The real SIGINT and SIGTERM are exercised on the built
 * CLI in src/__tests__/serve-processes.test.ts.
 */

import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';

import { describe, expect, it } from 'vitest';

import { LazyBoard, runCliAsync, runContext, type AsyncCliIo } from '../../cli/main.js';
import { parseArgs } from '../../cli/parse.js';
import { findCommand } from '../../cli/registry.js';
import type { StreamIo } from '../../cli/types.js';
import { run, cliEnv, type RunEnv } from '../../cli/__tests__/cli-helpers.js';
import { splitCommandLine } from '../../guidance/__tests__/command-line.js';
import { findBoard } from '../../store/locate.js';
import { openInBrowser, serveCommand, type Spawner } from '../serve.js';
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
    env,
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
  it('prints one JSON line with url, port, token and writable false, serves, and exits 0 when stopped', async () => {
    const { root } = project();
    const running = start(['serve', '--port', '0', '--json'], root);
    const line = await startupLine(running);
    const doc = JSON.parse(line) as Record<string, unknown>;
    expect(Object.keys(doc)).toEqual(['url', 'port', 'token', 'writable']);
    expect(typeof doc.port).toBe('number');
    const port = doc.port as number;
    expect(port).toBeGreaterThan(0);
    expect(doc.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(doc.writable).toBe(false);
    expect(doc.url).toBe(`http://127.0.0.1:${String(port)}/?token=${String(doc.token)}`);
    const entry = await request(port, `/?token=${String(doc.token)}`);
    expect(entry.status).toBe(303);
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
      /^serving (.+) read-only at (http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]{43}))$/.exec(
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

  it('accepts and ignores --as, and needs no actor', async () => {
    const { root } = project();
    for (const argv of [
      ['serve', '--json', '--as', 'someone'],
      ['serve', '--json'],
    ]) {
      const running = start(argv, root, cliEnv({ AGENTBOARD_ACTOR: undefined }));
      const doc = JSON.parse(await startupLine(running)) as { writable: boolean };
      expect(doc.writable).toBe(false);
      running.stop();
      expect(await running.done).toBe(0);
    }
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
  it('asks the system to open the entry URL once', async () => {
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
  const URL = 'http://127.0.0.1:4477/?token=abc';

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
  it('prints the synopsis with --port and --open, the exit codes and examples, with no board and no actor', () => {
    const out = run(['help', 'serve'], scratch(), cliEnv({ AGENTBOARD_ACTOR: undefined }));
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).toMatch(/^Usage: agentboard serve \[--port <port>\] \[--open\]/m);
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
