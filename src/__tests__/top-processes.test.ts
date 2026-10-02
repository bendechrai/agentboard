/**
 * `agentboard top` as the built CLI in a child process (board-tui:
 * "Interactive terminal required" scenario "Piped output", "Top command"
 * scenario "JSON error document when piped", "Terminal restoration",
 * "Live updates", "Frame rendering" scenario "No color"; board-cli: "Exit
 * codes" scenario "Top without a terminal"). Run `npm run build` first
 * when running vitest directly.
 *
 * No pseudo-terminal is used (add-board-tui design.md: no node-pty). Without
 * a terminal the child must refuse with `not-a-tty` and write no escape
 * sequence. To reach the terminal path of `src/cli.ts` anyway, some tests
 * preload a small module (`node --import`) that makes the child's piped
 * stdin and stdout look like a TTY: `isTTY` true, `setRawMode` (which
 * reports each call on stderr as `fake-tty: raw on|off`), `columns` and
 * `rows` (80 by 24), and on SIGUSR2 a resize to 50 by 10 with a `resize`
 * event. Its stdout is then read back through the test-only interpreter
 * of the permitted escape sequences.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { ScreenInterpreter, expectRestoredOnce, FakeTerminal, until } from '../tui/__tests__/screen.js';
import {
  CHILD_TIMEOUT_MS,
  boardProject,
  cliEnv,
  oneDocument,
  requireBuiltCli,
  runCliAsync,
  scratchDir,
  type RunEnv,
} from './harness/processes.js';

const ESC = '\x1b';
const TASK = ['--task', 'openspec:add-board-tui#2'];

const PRELOAD = `
const state = { columns: 80, rows: 24 };
Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
process.stdin.setRawMode = (mode) => {
  process.stderr.write('fake-tty: raw ' + (mode ? 'on' : 'off') + '\\n');
  return process.stdin;
};
Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
Object.defineProperty(process.stdout, 'columns', { get: () => state.columns, configurable: true });
Object.defineProperty(process.stdout, 'rows', { get: () => state.rows, configurable: true });
process.on('SIGUSR2', () => {
  state.columns = 50;
  state.rows = 10;
  process.stdout.emit('resize');
});
`;

let preloadPath: string | null = null;

/** The fake TTY module, written once per test file. */
function preload(): string {
  if (preloadPath === null) {
    preloadPath = join(scratchDir(), 'fake-tty.mjs');
    writeFileSync(preloadPath, PRELOAD);
  }
  return preloadPath;
}

function definedEnv(env: RunEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/** A terminal-capable environment: TERM set, NO_COLOR unset, no actor. */
function ttyEnv(extra: RunEnv = {}): RunEnv {
  return cliEnv({ TERM: 'xterm-256color', NO_COLOR: undefined, ...extra });
}

interface TopChild {
  readonly child: ChildProcessWithoutNullStreams;
  stdout(): string;
  stderr(): string;
  /** stderr without the fake TTY's own lines. */
  cliStderr(): string;
  /** The raw mode calls the fake TTY reported, in order. */
  rawCalls(): string[];
  /** stdout read back through the interpreter (80 by 24). */
  screen(): ScreenInterpreter;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const children = new Set<ChildProcessWithoutNullStreams>();
afterAll(() => {
  for (const child of children) {
    child.kill('SIGKILL');
  }
});

/** Spawns `node --import <fake tty> dist/cli.js <argv>` with piped stdio. */
function spawnTop(argv: readonly string[], cwd: string, env: RunEnv = ttyEnv()): TopChild {
  const cli = requireBuiltCli();
  const child = spawn(
    process.execPath,
    ['--import', pathToFileURL(preload()).href, cli, ...argv],
    { cwd, env: definedEnv(env), stdio: ['pipe', 'pipe', 'pipe'] },
  );
  children.add(child);
  let out = '';
  let err = '';
  child.stdout.setEncoding('latin1');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    out += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    err += chunk;
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        children.delete(child);
        resolve({ code, signal });
      });
    },
  );
  return {
    child,
    stdout: () => out,
    stderr: () => err,
    cliStderr: () =>
      err
        .split('\n')
        .filter((line) => !line.startsWith('fake-tty: '))
        .join('\n'),
    rawCalls: () =>
      err
        .split('\n')
        .filter((line) => line.startsWith('fake-tty: raw '))
        .map((line) => line.slice('fake-tty: raw '.length)),
    screen: () => {
      const screen = new ScreenInterpreter({ columns: 80, rows: 24 });
      screen.feed(out);
      return screen;
    },
    exited,
  };
}

/** A board with one ticket titled `title`; returns the project root and the ticket id. */
async function boardWithTicket(title: string): Promise<{ root: string; id: string }> {
  const { root } = boardProject();
  const out = await runCliAsync(['new', title, ...TASK, '--as', 'orch', '--json'], root);
  expect(out.code, out.stderr).toBe(0);
  return { root, id: (oneDocument(out) as { ticket: { id: string } }).ticket.id };
}

/** Waits until the child's screen shows `text`. */
async function showing(top: TopChild, text: string, ms = 10_000): Promise<void> {
  await until(
    () => top.screen().screenText().includes(text),
    ms,
    `"${text}" on the screen (stderr: ${top.stderr()})`,
  );
}

/**
 * Asserts the child's whole output restored the terminal exactly once:
 * the interpreter sees one enter and one leave of the alternate screen, no
 * protocol error and nothing drawn after the restore; the fake TTY saw raw
 * mode on then off.
 */
function expectChildRestored(top: TopChild): void {
  const term = new FakeTerminal();
  term.setRawMode(true);
  term.write(top.stdout());
  term.setRawMode(false);
  expectRestoredOnce(term);
  expect(top.rawCalls()).toEqual(['on', 'off']);
}

// ---------------------------------------------------------------------------

describe('scenario: Piped output (no terminal)', () => {
  it('top | cat exits 1 with the hint on stderr, nothing on stdout and no escape sequence', async () => {
    const { root } = await boardWithTicket('Piped');
    for (const cwd of [root, scratchDir()]) {
      const cli = requireBuiltCli();
      const out = spawnSync(process.execPath, [cli, 'top'], {
        cwd,
        env: definedEnv(ttyEnv()),
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(out.status, out.stderr).toBe(1);
      expect(out.stdout).toBe('');
      expect(out.stderr).toMatch(/^agentboard: .*terminal/m);
      const hint = /^hint: (.*)$/m.exec(out.stderr)?.[1] ?? '';
      expect(hint).toContain("'agentboard list'");
      expect(hint).toContain("'agentboard watch --as <actor>'");
      expect(out.stderr).not.toContain(ESC);
    }
  });

  it('scenario: JSON error document when piped: top --json | cat', () => {
    const cli = requireBuiltCli();
    const out = spawnSync(process.execPath, [cli, 'top', '--json'], {
      cwd: scratchDir(),
      env: definedEnv(ttyEnv()),
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(out.status, out.stderr).toBe(1);
    expect(out.stdout.endsWith('\n')).toBe(true);
    expect(out.stdout.slice(0, -1)).not.toContain('\n');
    const doc = JSON.parse(out.stdout) as {
      error: { exitCode: number; reason: string; hint: string };
    };
    expect(doc.error).toMatchObject({ exitCode: 1, reason: 'not-a-tty' });
    expect(doc.error.hint).toContain("'agentboard list'");
    expect(doc.error.hint).toContain("'agentboard watch --as <actor>'");
    expect(out.stdout + out.stderr).not.toContain(ESC);
  });

  it('scenario: Top without a terminal: stdout redirected to a file', async () => {
    const { root } = await boardWithTicket('Redirected');
    const file = join(scratchDir(), 'out.txt');
    const fd = openSync(file, 'w');
    try {
      const out = spawnSync(process.execPath, [requireBuiltCli(), 'top'], {
        cwd: root,
        env: definedEnv(ttyEnv()),
        stdio: ['pipe', fd, 'pipe'],
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(out.status).toBe(1);
      expect(out.stderr).toMatch(/^hint: /m);
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(file, 'utf8')).toBe('');
  });

  it('TERM=dumb is not an interactive terminal, even on a TTY', async () => {
    const { root } = await boardWithTicket('Dumb');
    const top = spawnTop(['top', '--json'], root, ttyEnv({ TERM: 'dumb' }));
    const { code } = await top.exited;
    expect(code).toBe(1);
    expect(JSON.parse(top.stdout())).toMatchObject({
      error: { exitCode: 1, reason: 'not-a-tty' },
    });
    expect(top.stdout()).not.toContain(ESC);
    expect(top.rawCalls()).toEqual([]);
  });
});

describe('the terminal path of the executable (fake TTY)', () => {
  it(
    'scenario: Quit restores the terminal: q exits 0 with the terminal restored once',
    { timeout: 30_000 },
    async () => {
      const { root } = await boardWithTicket('Quit me');
      const top = spawnTop(['top'], root);
      await showing(top, 'Quit me');
      expect(top.screen().screenText()).toContain('agentboard top');
      top.child.stdin.write('q');
      const { code } = await top.exited;
      expect(code, top.stderr()).toBe(0);
      expectChildRestored(top);
      expect(top.cliStderr()).toBe('');
    },
  );

  it.each([['SIGTERM' as const], ['SIGINT' as const]])(
    'stops on %s, exits 0 and restores the terminal once',
    { timeout: 30_000 },
    async (signal) => {
      const { root } = await boardWithTicket('Signalled');
      const top = spawnTop(['top'], root);
      await showing(top, 'Signalled');
      top.child.kill(signal);
      const { code } = await top.exited;
      expect(code, top.stderr()).toBe(0);
      expectChildRestored(top);
      expect(top.cliStderr()).toBe('');
    },
  );

  it('stops at the end of input, exits 0 and restores the terminal once', { timeout: 30_000 }, async () => {
    const { root } = await boardWithTicket('Ended');
    const top = spawnTop(['top'], root);
    await showing(top, 'Ended');
    top.child.stdin.end();
    const { code } = await top.exited;
    expect(code, top.stderr()).toBe(0);
    expectChildRestored(top);
  });

  it(
    'scenario: Comment from another process appears within 3 seconds',
    { timeout: 30_000 },
    async () => {
      const { root, id } = await boardWithTicket('Commented');
      const top = spawnTop(['top'], root);
      await showing(top, 'Commented');
      top.child.stdin.write('2');
      await showing(top, 'created');
      const out = await runCliAsync(['comment', id, '--as', 'impl', '--', 'seen live'], root);
      expect(out.code, out.stderr).toBe(0);
      const written = Date.now();
      await showing(top, 'commented: seen live', 3000);
      expect(Date.now() - written).toBeLessThan(3000);
      top.child.stdin.write('q');
      expect((await top.exited).code).toBe(0);
      expectChildRestored(top);
    },
  );

  it(
    'scenario: Too small: a resize to 50x10 shows the message and keeps running',
    { timeout: 30_000 },
    async () => {
      const { root } = await boardWithTicket('Resized');
      const top = spawnTop(['top'], root);
      await showing(top, 'Resized');
      const before = top.stdout().length;
      top.child.kill('SIGUSR2');
      await until(
        () =>
          top.stdout().slice(before).includes('terminal too small: need 60x15, have 50x10'),
        10_000,
        'the too-small screen',
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(top.child.exitCode).toBeNull();
      top.child.stdin.write('q');
      expect((await top.exited).code).toBe(0);
      expect(top.rawCalls()).toEqual(['on', 'off']);
    },
  );

  it.each([
    ['NO_COLOR=1', { NO_COLOR: '1' }, false],
    ['NO_COLOR unset', {}, true],
  ])(
    'scenario: No color: %s (a detail with a decision)',
    { timeout: 30_000 },
    async (_, extra, colored) => {
      const { root, id } = await boardWithTicket('Decided');
      const comment = await runCliAsync(
        ['comment', id, '--as', 'impl', '--', 'DECISION: keep the colors'],
        root,
      );
      expect(comment.code, comment.stderr).toBe(0);
      const top = spawnTop(['top'], root, ttyEnv(extra));
      await showing(top, 'Decided');
      top.child.stdin.write('\r');
      await showing(top, '[DECISION]');
      top.child.stdin.write('q');
      expect((await top.exited).code).toBe(0);
      const screen = top.screen();
      expect(screen.errors).toEqual([]);
      expect(screen.usedColor).toBe(colored);
      expect(screen.tokens.some((t) => t.kind === 'sgr' && t.params.includes(1))).toBe(true);
    },
  );
});
