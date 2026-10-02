/**
 * The `top` command in process, through `runCliAsync` with a fake terminal
 * and a stop signal the test controls (board-tui: "Top command",
 * "Interactive terminal required"; board-cli: "Command surface" scenario
 * "Top has help", "Exit codes" scenario "Top without a terminal"), and
 * `processTerminal` over a fake process. The built CLI is exercised in
 * `src/__tests__/top-processes.test.ts`.
 */

import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCliAsync, type AsyncCliIo } from '../../cli/main.js';
import { parseArgs } from '../../cli/parse.js';
import { findCommand } from '../../cli/registry.js';
import { cliEnv, oneJson, project, run, type RunEnv } from '../../cli/__tests__/cli-helpers.js';
import { splitCommandLine } from '../../guidance/__tests__/command-line.js';
import { tempDir } from '../../store/__tests__/helpers.js';
import { processTerminal, type TerminalHost } from '../terminal.js';
import { ESC, FakeTerminal, expectRestoredOnce, pause, until } from './screen.js';

const TASK = ['--task', 'openspec:add-board-tui#2'];

/** A terminal-capable environment: TERM set, NO_COLOR unset, no actor. */
function ttyEnv(extra: RunEnv = {}): RunEnv {
  return cliEnv({ TERM: 'xterm-256color', NO_COLOR: undefined, ...extra });
}

interface Running {
  stdout(): string;
  stderr(): string;
  /** Terminal writes, stdout and stderr, interleaved in call order. */
  readonly journal: { stream: 'terminal' | 'stdout' | 'stderr'; text: string }[];
  /** How many times the terminal factory was called. */
  factoryCalls(): number;
  stop(): void;
  readonly done: Promise<number>;
}

/**
 * Runs `agentboard <argv>` in process. `terminal` is what `io.terminal`
 * returns; null leaves `io.terminal` out (no terminal available).
 */
function start(
  argv: readonly string[],
  cwd: string,
  env: RunEnv,
  terminal: FakeTerminal | null,
): Running {
  let stdout = '';
  let stderr = '';
  let calls = 0;
  const journal: Running['journal'] = [];
  const controller = new AbortController();
  if (terminal !== null) {
    terminal.onWriteHook = (text) => journal.push({ stream: 'terminal', text });
  }
  const io: AsyncCliIo = {
    argv,
    cwd,
    env,
    stdout: (text) => {
      stdout += text;
      journal.push({ stream: 'stdout', text });
    },
    stderr: (text) => {
      stderr += text;
      journal.push({ stream: 'stderr', text });
    },
    stopSignal: () => controller.signal,
    ...(terminal === null
      ? {}
      : {
          terminal: () => {
            calls += 1;
            return Promise.resolve(terminal);
          },
        }),
  };
  const done = runCliAsync(io).then((code) => Number(code));
  return {
    stdout: () => stdout,
    stderr: () => stderr,
    journal,
    factoryCalls: () => calls,
    stop: () => {
      controller.abort();
    },
    done,
  };
}

/** A project with a board holding one ticket titled `title`. */
function boardWithTicket(title = 'Shown in top'): { root: string; boardDir: string } {
  const p = project();
  const out = run(['new', title, ...TASK, '--as', 'orch', '--json'], p.root);
  expect(out.code, out.stderr).toBe(0);
  return p;
}

describe('scenario: Piped output (no interactive terminal)', () => {
  const cases: [string, () => FakeTerminal | null, RunEnv][] = [
    ['no terminal at all', () => null, ttyEnv()],
    [
      'stdin not a TTY',
      () => new FakeTerminal(undefined, { stdin: false, stdout: true }),
      ttyEnv(),
    ],
    [
      'stdout not a TTY',
      () => new FakeTerminal(undefined, { stdin: true, stdout: false }),
      ttyEnv(),
    ],
    ['TERM=dumb', () => new FakeTerminal(), ttyEnv({ TERM: 'dumb' })],
  ];

  it.each(cases)(
    '%s: exits 1 not-a-tty with the hint, nothing on stdout, before opening the board',
    async (_, terminal, env) => {
      const { root, boardDir } = project();
      const nowhere = tempDir();
      for (const cwd of [root, nowhere]) {
        const term = terminal();
        const running = start(['top'], cwd, env, term);
        expect(await running.done).toBe(1);
        expect(running.stdout()).toBe('');
        expect(running.stderr()).toMatch(/^agentboard: .*terminal.*\n/);
        const hint = /^hint: (.*)$/m.exec(running.stderr())?.[1] ?? '';
        expect(hint).toContain("'agentboard list'");
        expect(hint).toContain("'agentboard watch --as <actor>'");
        expect(running.stderr()).not.toContain(ESC);
        expect(term?.journal ?? []).toEqual([]);
      }
      // The board was never opened: no cache file was created.
      expect(existsSync(join(boardDir, 'cache.sqlite'))).toBe(false);
    },
  );

  it.each(cases)(
    '%s with --json: one JSON error document with reason not-a-tty and its hint',
    async (_, terminal, env) => {
      const { root } = project();
      const term = terminal();
      const running = start(['top', '--json'], root, env, term);
      expect(await running.done).toBe(1);
      const doc = oneJson({ code: 1, stdout: running.stdout(), stderr: running.stderr() }) as {
        error: { exitCode: number; reason: string; hint: string | null };
      };
      expect(doc.error).toMatchObject({ exitCode: 1, reason: 'not-a-tty' });
      expect(doc.error.hint).toContain("'agentboard list'");
      expect(doc.error.hint).toContain("'agentboard watch --as <actor>'");
      expect(running.stdout()).not.toContain(ESC);
      expect(term?.journal ?? []).toEqual([]);
    },
  );

  it('names the actor in the watch hint when one is known', async () => {
    const { root } = project();
    const running = start(['top'], root, ttyEnv({ AGENTBOARD_ACTOR: 'impl' }), null);
    expect(await running.done).toBe(1);
    expect(running.stderr()).toContain("'agentboard watch --as impl'");
  });
});

describe('top on a fake terminal', () => {
  it('scenario: Quit restores the terminal: q exits 0 with nothing on stdout or stderr', async () => {
    const { root } = boardWithTicket();
    const term = new FakeTerminal();
    const running = start(['top'], root, ttyEnv(), term);
    await until(() => term.screen.screenText().includes('Shown in top'), 5000, 'the board');
    expect(term.screen.lines()[0]).toMatch(/^agentboard top /);
    expect(running.factoryCalls()).toBe(1);
    term.type('q');
    expect(await running.done).toBe(0);
    expectRestoredOnce(term);
    expect(running.stdout()).toBe('');
    expect(running.stderr()).toBe('');
  });

  it('stops on the signal (SIGINT or SIGTERM) and exits 0 restored', async () => {
    const { root } = boardWithTicket();
    const term = new FakeTerminal();
    const running = start(['top'], root, ttyEnv(), term);
    await until(() => term.screen.screenText().includes('Shown in top'), 5000, 'the board');
    running.stop();
    expect(await running.done).toBe(0);
    expectRestoredOnce(term);
  });

  it('runs with TERM unset', async () => {
    const { root } = boardWithTicket();
    const term = new FakeTerminal();
    const running = start(['top'], root, ttyEnv({ TERM: undefined }), term);
    await until(() => term.raw, 5000, 'raw mode');
    term.type('\x03');
    expect(await running.done).toBe(0);
    expectRestoredOnce(term);
  });

  it('accepts --json, which changes nothing on the screen', async () => {
    const { root } = boardWithTicket();
    const screens: string[][] = [];
    for (const argv of [['top'], ['top', '--json']]) {
      const term = new FakeTerminal();
      const running = start(argv, root, ttyEnv(), term);
      await until(() => term.screen.screenText().includes('Shown in top'), 5000, 'the board');
      // The header's "last event" time may move on between the two runs.
      screens.push(term.screen.lines().slice(1));
      term.type('q');
      expect(await running.done).toBe(0);
      expect(running.stdout()).toBe('');
      expectRestoredOnce(term);
    }
    expect(screens[1]).toEqual(screens[0]);
  });

  it('accepts and ignores --as, and needs no actor', async () => {
    const { root } = boardWithTicket();
    for (const argv of [['top', '--as', 'someone'], ['top']]) {
      const term = new FakeTerminal();
      const running = start(argv, root, ttyEnv({ AGENTBOARD_ACTOR: undefined }), term);
      await until(() => term.raw, 5000, 'raw mode');
      term.type('q');
      expect(await running.done).toBe(0);
    }
  });

  it('exits 2 when no board is found, before any terminal change', async () => {
    for (const json of [false, true]) {
      const term = new FakeTerminal();
      const running = start(json ? ['top', '--json'] : ['top'], tempDir(), ttyEnv(), term);
      expect(await running.done).toBe(2);
      expect(term.journal.filter((e) => e.kind === 'write' || e.kind === 'raw')).toEqual([]);
      expect(term.listeners).toBe(0);
      if (json) {
        expect(JSON.parse(running.stdout())).toMatchObject({
          error: { exitCode: 2, reason: 'board-not-found' },
        });
      } else {
        expect(running.stdout()).toBe('');
      }
    }
  });

  it('asks for a terminal for top only: never for watch or serve', async () => {
    const { root } = boardWithTicket();
    const watch = start(['watch', '--as', 'someone'], root, ttyEnv(), new FakeTerminal());
    await pause(200);
    watch.stop();
    expect(await watch.done).toBe(0);
    expect(watch.factoryCalls()).toBe(0);
    const serve = start(['serve', '--json'], root, ttyEnv(), new FakeTerminal());
    await until(() => serve.stdout().includes('\n'), 5000, 'the serve start-up line');
    serve.stop();
    expect(await serve.done).toBe(0);
    expect(serve.factoryCalls()).toBe(0);
  });

  it('refuses the synchronous runCli with streaming-command', () => {
    const { root } = project();
    const out = run(['top', '--json'], root);
    expect(out.code).toBe(1);
    const doc = oneJson(out) as { error: { reason: string; hint: string } };
    expect(doc.error.reason).toBe('streaming-command');
    expect(doc.error.hint).toContain("'agentboard top'");
  });
});

describe('scenario: Top has help', () => {
  it('prints the synopsis, the exit codes including 1 not-a-tty and 2, and examples, with no board and no actor', () => {
    const out = run(['help', 'top'], tempDir(), cliEnv({ AGENTBOARD_ACTOR: undefined }));
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).toMatch(/^Usage: agentboard top( \[--json\])?\s*$/m);
    expect(out.stdout).toMatch(/^\s+1 not-a-tty\s/m);
    expect(out.stdout).toMatch(/^\s+2 board-not-found\s/m);
    expect(out.stdout).toMatch(/^\s+0\s+Quit/m);
    const spec = findCommand('top');
    expect(spec?.group).toBe('awareness');
    expect(spec?.writes).toBe(false);
    expect(spec?.tracksCursor ?? false).toBe(false);
    expect(spec?.terminal).toBe(true);
    expect(spec?.stream).toBeDefined();
    expect(spec?.flags).toEqual([]);
    expect(spec?.examples.length).toBeGreaterThan(0);
    for (const example of spec?.examples ?? []) {
      expect(out.stdout).toContain(example.command);
      const words = splitCommandLine(example.command);
      expect(parseArgs(words.slice(1)).command.name).toBe('top');
    }
  });
});

// ---------------------------------------------------------------------------
// processTerminal

interface FakeHost extends TerminalHost {
  readonly stdin: EventEmitter & {
    isTTY?: boolean;
    setRawMode?(mode: boolean): unknown;
    pause(): unknown;
    unref(): unknown;
  };
  readonly stdout: EventEmitter & {
    isTTY?: boolean;
    columns?: number;
    rows?: number;
    write(text: string): unknown;
  };
  readonly process: EventEmitter;
  readonly calls: string[];
}

function fakeHost(
  options: {
    stdinTTY?: boolean;
    stdoutTTY?: boolean;
    columns?: number;
    rows?: number;
    raw?: boolean;
  } = {},
): FakeHost {
  const calls: string[] = [];
  const stdin = Object.assign(new EventEmitter(), {
    ...(options.stdinTTY === undefined ? {} : { isTTY: options.stdinTTY }),
    ...(options.raw === false
      ? {}
      : {
          setRawMode: (mode: boolean) => {
            calls.push(`raw ${String(mode)}`);
          },
        }),
    pause: () => {
      calls.push('pause');
    },
    unref: () => {
      calls.push('unref');
    },
  });
  const stdout = Object.assign(new EventEmitter(), {
    ...(options.stdoutTTY === undefined ? {} : { isTTY: options.stdoutTTY }),
    ...(options.columns === undefined ? {} : { columns: options.columns }),
    ...(options.rows === undefined ? {} : { rows: options.rows }),
    write: (text: string) => {
      calls.push(`write ${text}`);
      return true;
    },
  });
  return { stdin, stdout, process: new EventEmitter(), calls };
}

function listenerTotal(host: FakeHost): number {
  return (
    host.stdin.listenerCount('data') +
    host.stdin.listenerCount('end') +
    host.stdout.listenerCount('resize') +
    host.process.listenerCount('exit')
  );
}

describe('processTerminal', () => {
  it('has no effect when created, and reads isTTY', () => {
    const host = fakeHost({ stdinTTY: true, stdoutTTY: false });
    const term = processTerminal(host);
    expect(host.calls).toEqual([]);
    expect(listenerTotal(host)).toBe(0);
    expect(term.stdinIsTTY).toBe(true);
    expect(term.stdoutIsTTY).toBe(false);
    const unset = processTerminal(fakeHost());
    expect(unset.stdinIsTTY).toBe(false);
    expect(unset.stdoutIsTTY).toBe(false);
  });

  it('writes to stdout and sets raw mode on stdin (when it can)', () => {
    const host = fakeHost({ stdinTTY: true, stdoutTTY: true });
    const term = processTerminal(host);
    term.write(`${ESC}[?25l`);
    term.setRawMode(true);
    term.setRawMode(false);
    expect(host.calls).toEqual([`write ${ESC}[?25l`, 'raw true', 'raw false']);
    const noRaw = processTerminal(fakeHost({ raw: false }));
    expect(() => {
      noRaw.setRawMode(true);
    }).not.toThrow();
  });

  it('reads the size from stdout, 80x24 when it is not known', () => {
    expect(processTerminal(fakeHost({ columns: 120, rows: 40 })).size()).toEqual({
      columns: 120,
      rows: 40,
    });
    expect(processTerminal(fakeHost()).size()).toEqual({ columns: 80, rows: 24 });
    expect(processTerminal(fakeHost({ columns: 0, rows: 0 })).size()).toEqual({
      columns: 80,
      rows: 24,
    });
    const host = fakeHost({ columns: 100, rows: 30 });
    const term = processTerminal(host);
    host.stdout.columns = 90;
    expect(term.size()).toEqual({ columns: 90, rows: 30 });
  });

  it('passes input chunks as bytes, and removing the listener pauses and unrefs stdin', () => {
    const host = fakeHost();
    const term = processTerminal(host);
    const chunks: number[][] = [];
    const remove = term.onData((chunk) => chunks.push(Array.from(chunk)));
    host.stdin.emit('data', Buffer.from([0x1b, 0x5b, 0x41]));
    host.stdin.emit('data', 'q');
    expect(chunks).toEqual([[0x1b, 0x5b, 0x41], [0x71]]);
    expect(host.stdin.listenerCount('data')).toBe(1);
    remove();
    expect(host.stdin.listenerCount('data')).toBe(0);
    // So the process can exit once top has stopped, however stdin is connected.
    expect(host.calls).toContain('pause');
    expect(host.calls).toContain('unref');
  });

  it('listens to the end of input, resizes and the process exit, and removes exactly its own listener', () => {
    const host = fakeHost();
    const term = processTerminal(host);
    const seen: string[] = [];
    const others = (): void => undefined;
    host.stdin.on('end', others);
    host.stdout.on('resize', others);
    host.process.on('exit', others);
    const removers = [
      term.onEnd(() => seen.push('end')),
      term.onResize(() => seen.push('resize')),
      term.onExit(() => seen.push('exit')),
    ];
    host.stdin.emit('end');
    host.stdout.emit('resize');
    host.process.emit('exit');
    expect(seen).toEqual(['end', 'resize', 'exit']);
    for (const remove of removers) {
      remove();
    }
    expect(host.stdin.listenerCount('end')).toBe(1);
    expect(host.stdout.listenerCount('resize')).toBe(1);
    expect(host.process.listenerCount('exit')).toBe(1);
  });
});
