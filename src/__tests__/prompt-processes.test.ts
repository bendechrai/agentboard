/**
 * The init and bare-project prompts through the built CLI in a child
 * process, with real standard input (board-cli "Init offers to install
 * agent guidance" scenarios "Scripts get no prompt" and "Install failure
 * keeps the board"; board-agent-guidance scenario "Bare project without a
 * terminal"; add-harness-integration task 5.1, design.md decision 8 and
 * "Rulings from task group 5 (test author)"). Run `npm run build` first
 * when running vitest directly.
 *
 * "Nothing is read" is proved, not inferred from the output: standard
 * input is a regular file opened by the test and shared with the child,
 * so any read by the child moves the shared file offset, and after the
 * child exits the test reads the whole file back from that offset. A pipe
 * that stays open proves the child never waits for input; /dev/null is
 * the plain script case.
 *
 * No pseudo-terminal is used (add-board-tui design.md: no node-pty). As
 * in top-processes.test.ts, a small preloaded module (`node --import`)
 * makes the child's stdin, stdout or both look like a terminal
 * (`isTTY` true and `tty.isatty` true for that descriptor), so the
 * terminal path of `src/cli.ts` runs over real pipes and files; it
 * reports any `setRawMode` call on stderr as `fake-tty: raw on|off`. Ctrl-C
 * is a SIGINT sent to the child, as the terminal would send it.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { TOKEN_FIXTURES, expectNoLeak } from './harness/secret-fixtures.js';
import { CHILD_TIMEOUT_MS, requireBuiltCli, scratchDir, type RunEnv } from './harness/processes.js';
import { syncEnv } from '../board/__tests__/sync-helpers.js';
import { fileList, plainProject, repo } from '../guidance/__tests__/guidance-helpers.js';
import { INIT_SUGGESTION, PROMPT_TARGETS } from '../guidance/install.js';
import { INIT_QUESTION } from '../cli/prompt.js';

vi.setConfig({ testTimeout: 90_000 });

const SKILL = '.claude/skills/agentboard/SKILL.md';
const AGENTS = 'AGENTS.md';
const FAKE_TTY_ENV = 'AGENTBOARD_TEST_FAKE_TTY';

const PRELOAD = `
import tty from 'node:tty';
import { syncBuiltinESMExports } from 'node:module';
const which = (process.env.${FAKE_TTY_ENV} ?? '').split(',');
const fds = [];
if (which.includes('stdin')) {
  fds.push(0);
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  process.stdin.setRawMode = (mode) => {
    process.stderr.write('fake-tty: raw ' + (mode ? 'on' : 'off') + '\\n');
    return process.stdin;
  };
}
if (which.includes('stdout')) {
  fds.push(1);
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
}
const isatty = tty.isatty;
tty.isatty = (fd) => fds.includes(fd) || isatty(fd);
syncBuiltinESMExports();
`;

let preloadPath: string | null = null;

/** The fake TTY module, written once per test file. */
function preload(): string {
  if (preloadPath === null) {
    preloadPath = join(scratchDir(), 'fake-tty-prompt.mjs');
    writeFileSync(preloadPath, PRELOAD);
  }
  return preloadPath;
}

type Tty = 'stdin' | 'stdout';

interface Child {
  readonly child: ChildProcess;
  stdout(): string;
  /** stderr without the fake TTY's own lines. */
  stderr(): string;
  /** The raw mode calls the fake TTY reported. */
  rawCalls(): string[];
  write(text: string): void;
  end(): void;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const children = new Set<ChildProcess>();
afterAll(() => {
  for (const child of children) {
    child.kill('SIGKILL');
  }
});

function definedEnv(env: RunEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Starts `node [--import fake-tty] dist/cli.js <argv>`. `stdin` is `pipe`
 * (the test writes and ends it) or an open file descriptor shared with
 * the child.
 */
function startCli(
  argv: readonly string[],
  cwd: string,
  options: { tty?: readonly Tty[]; stdin?: 'pipe' | number } = {},
): Child {
  const cli = requireBuiltCli();
  const tty = options.tty ?? [];
  const nodeArgs = tty.length > 0 ? ['--import', pathToFileURL(preload()).href] : [];
  const env = definedEnv(syncEnv({ [FAKE_TTY_ENV]: tty.join(','), TERM: 'xterm-256color' }));
  const stdin = options.stdin ?? 'pipe';
  const child = spawn(process.execPath, [...nodeArgs, cli, ...argv], {
    cwd,
    env,
    stdio: [stdin, 'pipe', 'pipe'],
  });
  children.add(child);
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
  child.stdin?.on('error', () => undefined);
  const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      resolve({ code, signal });
    });
  });
  return {
    child,
    stdout: () => out,
    stderr: () =>
      err
        .split('\n')
        .filter((line) => !line.startsWith('fake-tty: '))
        .join('\n'),
    rawCalls: () =>
      err
        .split('\n')
        .filter((line) => line.startsWith('fake-tty: raw '))
        .map((line) => line.slice('fake-tty: raw '.length)),
    write: (text) => {
      child.stdin?.write(text);
    },
    end: () => {
      child.stdin?.end();
    },
    exited,
  };
}

/** Waits until `condition` holds, failing after `ms` with `what`. */
async function until(condition: () => boolean, ms: number, what: () => string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Waits until the child's stdout contains `text`. */
function showing(child: Child, text: string): Promise<void> {
  return until(
    () => child.stdout().includes(text),
    30_000,
    () => `${JSON.stringify(text)} (stdout: ${child.stdout()}; stderr: ${child.stderr()})`,
  );
}

const STDIN_TEXT = 'y\n1,3\nyes\n';

/**
 * Runs the CLI with stdin a regular file holding `STDIN_TEXT`, then
 * returns the result and what of the file was left unread at the shared
 * offset (all of it when the child read nothing).
 */
async function withFileStdin(
  argv: readonly string[],
  cwd: string,
  tty: readonly Tty[] = [],
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  unread: string;
}> {
  const path = join(scratchDir(), 'stdin.txt');
  writeFileSync(path, STDIN_TEXT);
  const fd = openSync(path, 'r');
  try {
    const child = startCli(argv, cwd, { tty, stdin: fd });
    const result = await child.exited;
    const buffer = Buffer.alloc(STDIN_TEXT.length + 16);
    const n = readSync(fd, buffer, 0, buffer.length, null);
    return {
      ...result,
      stdout: child.stdout(),
      stderr: child.stderr(),
      unread: buffer.subarray(0, n).toString('utf8'),
    };
  } finally {
    closeSync(fd);
  }
}

function claudeProject(): string {
  const root = repo();
  mkdirSync(join(root, '.claude'));
  return root;
}

function projectFiles(root: string): string[] {
  return fileList(root).filter((p) => !p.startsWith('.board/') && p !== '.gitignore');
}

function expectBoard(root: string): void {
  expect(existsSync(join(root, '.board', 'events'))).toBe(true);
}

// ---------------------------------------------------------------------------

describe('scenario: Scripts get no prompt (stdin a file, stdout a pipe)', () => {
  it('init reads nothing, creates the board and ends with the hint line', async () => {
    const root = claudeProject();
    const out = await withFileStdin(['init'], root);
    expect(out.code, out.stderr).toBe(0);
    expect(out.unread).toBe(STDIN_TEXT);
    expectBoard(root);
    expect(projectFiles(root)).toEqual([]);
    expect(out.stdout.endsWith(`\n${INIT_SUGGESTION}\n`), out.stdout).toBe(true);
    expect(out.stdout).not.toContain(INIT_QUESTION.trim());
  });

  it('scenario: Bare project without a terminal: agents install reads nothing, exits 1 listing the targets', async () => {
    const root = plainProject();
    const out = await withFileStdin(['agents', 'install'], root);
    expect(out.code).toBe(1);
    expect(out.unread).toBe(STDIN_TEXT);
    expect(projectFiles(root)).toEqual([]);
    expect(out.stdout).toBe('');
    for (const target of PROMPT_TARGETS) {
      expect(out.stderr).toContain(target);
    }
  });

  it('scenario: Install failure keeps the board: init --agents in a bare project exits 1, board kept', async () => {
    const root = repo();
    const out = await withFileStdin(['init', '--agents'], root);
    expect(out.code).toBe(1);
    expect(out.unread).toBe(STDIN_TEXT);
    expectBoard(root);
    expect(out.stdout).toContain(join(root, '.board'));
    expect(out.stderr).toMatch(/nothing to install/);
    expect(projectFiles(root)).toEqual([]);
  });

  it('init --agents with a detected target installs it and reads nothing', async () => {
    const root = claudeProject();
    const out = await withFileStdin(['init', '--agents'], root);
    expect(out.code, out.stderr).toBe(0);
    expect(out.unread).toBe(STDIN_TEXT);
    expect(projectFiles(root)).toEqual([SKILL]);
    expect(out.stdout).not.toContain(INIT_SUGGESTION);
  });

  it('init --no-agents reads nothing and ends with the hint line', async () => {
    const root = claudeProject();
    const out = await withFileStdin(['init', '--no-agents'], root);
    expect(out.code, out.stderr).toBe(0);
    expect(out.unread).toBe(STDIN_TEXT);
    expect(projectFiles(root)).toEqual([]);
    expect(out.stdout.endsWith(`\n${INIT_SUGGESTION}\n`)).toBe(true);
  });

  it('init --agents --no-agents exits 1 before creating anything, reading nothing', async () => {
    const root = claudeProject();
    const out = await withFileStdin(['init', '--agents', '--no-agents'], root);
    expect(out.code).toBe(1);
    expect(out.unread).toBe(STDIN_TEXT);
    expect(existsSync(join(root, '.board'))).toBe(false);
  });
});

describe('stdin /dev/null or a pipe nobody writes to', () => {
  it('init and agents install with stdin from /dev/null', async () => {
    const fd = openSync('/dev/null', 'r');
    try {
      const root = claudeProject();
      const init = startCli(['init'], root, { stdin: fd });
      expect((await init.exited).code, init.stderr()).toBe(0);
      expect(init.stdout().endsWith(`\n${INIT_SUGGESTION}\n`)).toBe(true);
      expect(projectFiles(root)).toEqual([]);
      const bare = plainProject();
      const install = startCli(['agents', 'install'], bare, { stdin: fd });
      expect((await install.exited).code).toBe(1);
      expect(projectFiles(bare)).toEqual([]);
    } finally {
      closeSync(fd);
    }
  });

  it('never waits on an open pipe: init and agents install exit with the pipe still open', async () => {
    const root = claudeProject();
    const init = startCli(['init'], root);
    const initDone = await init.exited;
    expect(initDone.signal).toBeNull();
    expect(initDone.code, init.stderr()).toBe(0);
    expect(projectFiles(root)).toEqual([]);
    const bare = plainProject();
    const install = startCli(['agents', 'install'], bare);
    const installDone = await install.exited;
    expect(installDone.signal).toBeNull();
    expect(installDone.code).toBe(1);
  });
});

describe('CI-like sessions: only one of stdin and stdout is a terminal', () => {
  it.each<[string, Tty[]]>([
    ['stdout a terminal, stdin a file', ['stdout']],
    ['stdin a terminal, stdout a pipe', ['stdin']],
  ])('%s: init reads nothing and does not ask', async (_name, tty) => {
    const root = claudeProject();
    const out = await withFileStdin(['init'], root, tty);
    expect(out.code, out.stderr).toBe(0);
    expect(out.unread).toBe(STDIN_TEXT);
    expect(projectFiles(root)).toEqual([]);
    expect(out.stdout).not.toContain(INIT_QUESTION.trim());
    expect(out.stdout.endsWith(`\n${INIT_SUGGESTION}\n`)).toBe(true);
  });

  it.each<[string, Tty[]]>([
    ['stdout a terminal, stdin a file', ['stdout']],
    ['stdin a terminal, stdout a pipe', ['stdin']],
  ])('%s: agents install reads nothing and exits 1', async (_name, tty) => {
    const root = plainProject();
    const out = await withFileStdin(['agents', 'install'], root, tty);
    expect(out.code).toBe(1);
    expect(out.unread).toBe(STDIN_TEXT);
    expect(projectFiles(root)).toEqual([]);
  });
});

describe('--json on a terminal never asks', () => {
  it('init --json reads nothing and prints one document', async () => {
    const root = claudeProject();
    const out = await withFileStdin(['init', '--json'], root, ['stdin', 'stdout']);
    expect(out.code, out.stderr).toBe(0);
    expect(out.unread).toBe(STDIN_TEXT);
    expect(out.stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(out.stdout)).toMatchObject({ created: true });
    expect(projectFiles(root)).toEqual([]);
  });

  it('agents install --json reads nothing and exits 1 no-targets', async () => {
    const root = plainProject();
    const out = await withFileStdin(['agents', 'install', '--json'], root, ['stdin', 'stdout']);
    expect(out.code).toBe(1);
    expect(out.unread).toBe(STDIN_TEXT);
    expect(JSON.parse(out.stdout)).toMatchObject({ error: { reason: 'no-targets' } });
  });
});

describe('on a terminal, answers come from real standard input', () => {
  it('init: y, then 1,3 at the bare-project prompt, installs the first and third targets', async () => {
    const root = repo();
    const child = startCli(['init'], root, { tty: ['stdin', 'stdout'] });
    await showing(child, INIT_QUESTION);
    expectBoard(root);
    child.write('y\n');
    await showing(child, '  3. ');
    child.write('1,3\n');
    const done = await child.exited;
    expect(done.code, child.stderr()).toBe(0);
    expect(projectFiles(root)).toEqual([SKILL, AGENTS]);
    expect(child.rawCalls()).toEqual([]);
  });

  it('init: n exits 0 with the hint last, although stdin stays open', async () => {
    const root = claudeProject();
    const child = startCli(['init'], root, { tty: ['stdin', 'stdout'] });
    await showing(child, INIT_QUESTION);
    child.write('n\n');
    const done = await child.exited;
    expect(done.signal).toBeNull();
    expect(done.code, child.stderr()).toBe(0);
    expect(child.stdout().endsWith(`${INIT_SUGGESTION}\n`)).toBe(true);
    expect(projectFiles(root)).toEqual([]);
  });

  it('init: Enter installs the detected target, and the process exits with stdin open', async () => {
    const root = claudeProject();
    const child = startCli(['init'], root, { tty: ['stdin', 'stdout'] });
    await showing(child, INIT_QUESTION);
    child.write('\n');
    const done = await child.exited;
    expect(done.code, child.stderr()).toBe(0);
    expect(projectFiles(root)).toEqual([SKILL]);
  });

  it('agents install: 1,3 at the bare-project prompt', async () => {
    const root = plainProject();
    const child = startCli(['agents', 'install'], root, { tty: ['stdin', 'stdout'] });
    await showing(child, '  6. ');
    child.write('1,3\n');
    const done = await child.exited;
    expect(done.code, child.stderr()).toBe(0);
    expect(projectFiles(root)).toEqual([SKILL, AGENTS]);
    expect(child.rawCalls()).toEqual([]);
  });

  it('an unknown token-shaped answer is never written back', async () => {
    const f = TOKEN_FIXTURES[0];
    if (f === undefined) {
      throw new Error('no token fixture');
    }
    const root = plainProject();
    const install = startCli(['agents', 'install'], root, { tty: ['stdin', 'stdout'] });
    await showing(install, '  1. ');
    install.write(`${f.value}\n`);
    expect((await install.exited).code).toBe(1);
    expectNoLeak(`${install.stdout()}\n${install.stderr()}`, [f]);
    expect(projectFiles(root)).toEqual([]);
    const initRoot = claudeProject();
    const init = startCli(['init'], initRoot, { tty: ['stdin', 'stdout'] });
    await showing(init, INIT_QUESTION);
    init.write(`${f.value}\n`);
    expect((await init.exited).code).toBe(1);
    expectNoLeak(`${init.stdout()}\n${init.stderr()}`, [f]);
    expect(projectFiles(initRoot)).toEqual([]);
  });
});

describe('Ctrl-C and Ctrl-D at a prompt leave nothing half-installed', () => {
  it('SIGINT at the init question: ends by the signal, board kept, no guidance', async () => {
    const root = claudeProject();
    const child = startCli(['init'], root, { tty: ['stdin', 'stdout'] });
    await showing(child, INIT_QUESTION);
    child.child.kill('SIGINT');
    const done = await child.exited;
    expect(done.signal).toBe('SIGINT');
    expectBoard(root);
    expect(projectFiles(root)).toEqual([]);
  });

  it('SIGINT at the bare-project prompt after init y: board kept, no guidance', async () => {
    const root = repo();
    const child = startCli(['init'], root, { tty: ['stdin', 'stdout'] });
    await showing(child, INIT_QUESTION);
    child.write('y\n');
    await showing(child, '  1. ');
    child.child.kill('SIGINT');
    const done = await child.exited;
    expect(done.signal).toBe('SIGINT');
    expectBoard(root);
    expect(projectFiles(root)).toEqual([]);
  });

  it('SIGINT at the agents install prompt, with part of an answer typed: nothing written', async () => {
    const root = plainProject();
    const child = startCli(['agents', 'install'], root, { tty: ['stdin', 'stdout'] });
    await showing(child, '  1. ');
    child.write('1,');
    child.child.kill('SIGINT');
    const done = await child.exited;
    expect(done.signal).toBe('SIGINT');
    expect(projectFiles(root)).toEqual([]);
  });

  it('end of input mid-answer at the init question: exit 1, board kept, no guidance, hint last', async () => {
    const root = claudeProject();
    const child = startCli(['init'], root, { tty: ['stdin', 'stdout'] });
    await showing(child, INIT_QUESTION);
    child.write('y');
    child.end();
    const done = await child.exited;
    expect(done.code).toBe(1);
    expectBoard(root);
    expect(projectFiles(root)).toEqual([]);
    expect(child.stdout().endsWith(`${INIT_SUGGESTION}\n`)).toBe(true);
  });

  it('end of input mid-answer at the bare-project prompt: exit 1, nothing written', async () => {
    const root = plainProject();
    const child = startCli(['agents', 'install'], root, { tty: ['stdin', 'stdout'] });
    await showing(child, '  1. ');
    child.write('1,3');
    child.end();
    const done = await child.exited;
    expect(done.code).toBe(1);
    expect(projectFiles(root)).toEqual([]);
  });

  it('a 1 MB line at the bare-project prompt: exit 1 without waiting for its end, not repeated', async () => {
    const root = plainProject();
    const child = startCli(['agents', 'install'], root, { tty: ['stdin', 'stdout'] });
    await showing(child, '  1. ');
    const word = 'Wm4Jx8Pq';
    child.write(word.repeat(131_072));
    const done = await child.exited;
    expect(done.code).toBe(1);
    expect(child.stdout() + child.stderr()).not.toContain(word);
    expect(projectFiles(root)).toEqual([]);
  });
});
