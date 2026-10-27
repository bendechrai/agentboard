/**
 * Multi-process test harness for the concurrency and crash properties: the
 * tests spawn the built CLI.
 *
 * Build: the harness runs the built CLI (`dist/cli.js`, `BUILT_CLI`) and
 * never builds it itself. `make check` (and `npm run check`) run the build
 * before the tests, and `make check-in-docker` / `make check-floor` run
 * `make check`, so the tests always see a fresh build there. When running
 * vitest directly, run `npm run build` first; a missing build fails the
 * test with that instruction (`requireBuiltCli`). The harness does not build
 * once per test file from vitest: that would race when vitest runs files in
 * parallel and would double the build time of `make check`.
 *
 * Processes: every child is `node [nodeArgs] dist/cli.js <argv>` spawned
 * asynchronously with piped stdout and stderr, so many can run at once
 * (`startCli`). A child still alive when the test file ends is killed with
 * SIGKILL, and every child is killed after `CHILD_TIMEOUT_MS` so a hung
 * process fails the test instead of hanging the run.
 *
 * Start gate: `runTogether` makes N processes start their command within a
 * millisecond or two of each other. Each child preloads a small module
 * (`node --import <gate>`, written to a temporary directory at run time)
 * that marks itself ready and blocks until a `go` file appears; once all N
 * are ready the harness creates `go`. So every process is already started,
 * past Node's own start-up, when the race begins, and the spread is the
 * gate's 1 ms polling, on macOS and Linux alike. Before marking itself
 * ready the gate module also imports the built CLI's code chunks (listed
 * in `AGENTBOARD_HARNESS_PRELOAD`, with process warnings muted while they
 * load), so module loading happens before the gate and not inside the
 * race.
 *
 * Crash injection: a child run with `AGENTBOARD_TEST_PAUSE` set prints
 * `agentboard: paused at <point> <path>` to stderr and blocks
 * (`src/store/transaction.ts`); `waitForPause` waits for that line and
 * returns the path, and `CliProcess.kill` sends SIGKILL and waits for the
 * exit.
 *
 * Clock offset: a child started with `Invocation.clockOffsetMs` preloads a
 * small module (`node --import <clock>`, written to a temporary directory
 * at run time) that replaces `Date.now` with the real clock plus the
 * offset read from `AGENTBOARD_HARNESS_CLOCK_OFFSET_MS`, before the CLI
 * loads. The CLI reads its clock only through `Date.now`, so the child
 * behaves exactly as on a machine whose clock is that far ahead (or behind,
 * for a negative offset). The variable is read by the preload module only,
 * never by agentboard itself. `Invocation.clockFixedMs` uses the same
 * preload to stop the child's clock instead: `Date.now` always returns that
 * value (from `AGENTBOARD_HARNESS_CLOCK_FIXED_MS`), so a test can place a
 * single-shot command exactly at a boundary such as a grant's slot time
 * minus one millisecond, however long the child takes to start. A stopped
 * clock never advances, so it is only for commands that do not wait on
 * the clock (not `claim --wait` or `watch`).
 *
 * Read log: a child started with `Invocation.readLog` (a file path)
 * preloads a module that wraps `fs.readFileSync` and `fs.openSync` (and
 * calls `syncBuiltinESMExports`, so the CLI's named imports of `node:fs`
 * see the wrappers) and, when the child exits, writes to that file one line
 * per call that opened an event file (`events/<64 hex>.json`), in call
 * order. Listing the events directory is not logged. `readLogLines` reads
 * the file back. Like the clock offset, the variable is read by the
 * preload only.
 *
 * Temporary directories made here (`boardProject`, the gate) are removed
 * after the test file (afterAll), not after each test, so one scenario can
 * be set up in `beforeAll` and asserted by several tests.
 */

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll } from 'vitest';

import { BUILT_CLI, cliEnv, type RunEnv } from '../../cli/__tests__/cli-helpers.js';

export { BUILT_CLI, cliEnv, type RunEnv };

/** Every child is killed with SIGKILL after this long, unless `Invocation.timeoutMs` says otherwise. */
export const CHILD_TIMEOUT_MS = 30_000;

/** How a child ended, with everything it printed. */
export interface ProcessResult {
  /** Exit code, or null when killed by a signal. */
  code: number | null;
  /** The signal that killed it (`SIGKILL`), or null when it exited. */
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** One CLI invocation. */
export interface Invocation {
  /** Arguments after `dist/cli.js`. */
  argv: readonly string[];
  /** Environment; defaults to `cliEnv()` (no actor, no board override). */
  env?: RunEnv;
  /**
   * Milliseconds added to the child's clock (`Date.now`) by the clock
   * preload; omitted, the child runs on the real clock with no preload.
   */
  clockOffsetMs?: number;
  /**
   * The value the child's `Date.now` always returns, through the clock
   * preload (see the module comment); not together with `clockOffsetMs`.
   */
  clockFixedMs?: number;
  /** Milliseconds after which the child is killed with SIGKILL; defaults to `CHILD_TIMEOUT_MS`. */
  timeoutMs?: number;
  /**
   * Path of a file the read-log preload writes when the child exits: one
   * line per event file the child opened (see the module comment).
   */
  readLog?: string;
}

/** A running child. */
export interface CliProcess {
  readonly pid: number;
  /** Resolves when the child has exited and its output is complete. */
  readonly exited: Promise<ProcessResult>;
  /** stdout so far. */
  stdout(): string;
  /** stderr so far. */
  stderr(): string;
  /**
   * Resolves with the first match of `pattern` against stderr (as printed
   * so far and as it arrives). Rejects if the child exits without a match
   * or `timeoutMs` passes; the rejection message includes stderr.
   */
  waitForStderr(pattern: RegExp, timeoutMs?: number): Promise<RegExpExecArray>;
  /** Sends SIGKILL (if still running) and resolves with the result. */
  kill(): Promise<ProcessResult>;
}

const dirs: string[] = [];
const live = new Set<CliProcess>();

afterAll(async () => {
  await Promise.all([...live].map((proc) => proc.kill()));
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/** A fresh temporary directory (realpath), removed after the test file. */
export function scratchDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agentboard-proc-')));
  dirs.push(dir);
  return dir;
}

/**
 * A temporary project (not a git repository) with an empty board at
 * `<root>/.board`, removed after the test file.
 */
export function boardProject(): { root: string; boardDir: string; eventsDir: string } {
  const root = scratchDir();
  const boardDir = join(root, '.board');
  const eventsDir = join(boardDir, 'events');
  mkdirSync(eventsDir, { recursive: true });
  return { root, boardDir, eventsDir };
}

/** Throws with a clear instruction when `dist/cli.js` is missing; returns its path. */
export function requireBuiltCli(): string {
  if (!existsSync(BUILT_CLI)) {
    throw new Error(`${BUILT_CLI} is missing; run npm run build (make check does) first`);
  }
  return BUILT_CLI;
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

/**
 * Spawns `node [nodeArgs] dist/cli.js <argv>` in `cwd`. The child is
 * tracked, killed after `CHILD_TIMEOUT_MS`, and killed at the end of the
 * test file if still running.
 */
export function startCli(
  invocation: Invocation,
  cwd: string,
  nodeArgs: readonly string[] = [],
): CliProcess {
  const cli = requireBuiltCli();
  const offset = invocation.clockOffsetMs;
  const fixed = invocation.clockFixedMs;
  if (offset !== undefined && fixed !== undefined) {
    throw new Error('an invocation takes clockOffsetMs or clockFixedMs, not both');
  }
  const clockArgs =
    offset === undefined && fixed === undefined
      ? []
      : ['--import', pathToFileURL(clockPath()).href];
  const env = definedEnv(invocation.env ?? cliEnv());
  if (offset !== undefined) {
    env[CLOCK_OFFSET_ENV] = String(offset);
  }
  if (fixed !== undefined) {
    env[CLOCK_FIXED_ENV] = String(fixed);
  }
  const { readLog } = invocation;
  const readArgs =
    readLog === undefined ? [] : ['--import', pathToFileURL(readLogModulePath()).href];
  if (readLog !== undefined) {
    env[READ_LOG_ENV] = readLog;
  }
  const preloads = [...clockArgs, ...readArgs, ...nodeArgs];
  const child = spawn(process.execPath, [...preloads, cli, ...invocation.argv], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  const listeners = new Set<() => void>();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    out += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    err += chunk;
    for (const listener of listeners) {
      listener();
    }
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), invocation.timeoutMs ?? CHILD_TIMEOUT_MS);
  let done = false;
  const exited = new Promise<ProcessResult>((resolve, reject) => {
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    // `close` fires after the exit and after stdio has been fully read.
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      done = true;
      live.delete(proc);
      for (const listener of listeners) {
        listener();
      }
      resolve({ code, signal, stdout: out, stderr: err });
    });
  });
  const proc: CliProcess = {
    pid: child.pid ?? -1,
    exited,
    stdout: () => out,
    stderr: () => err,
    waitForStderr(pattern, timeoutMs = 15_000) {
      return new Promise<RegExpExecArray>((resolve, reject) => {
        const check = (): boolean => {
          const match = new RegExp(pattern.source, pattern.flags.replace('g', '')).exec(err);
          if (match !== null) {
            finish();
            resolve(match);
            return true;
          }
          if (done) {
            finish();
            reject(new Error(`process exited before stderr matched ${String(pattern)}: ${err}`));
            return true;
          }
          return false;
        };
        const deadline = setTimeout(() => {
          finish();
          reject(new Error(`timed out waiting for stderr to match ${String(pattern)}: ${err}`));
        }, timeoutMs);
        const finish = (): void => {
          clearTimeout(deadline);
          listeners.delete(listener);
        };
        const listener = (): void => {
          check();
        };
        listeners.add(listener);
        check();
      });
    },
    kill() {
      if (!done) {
        child.kill('SIGKILL');
      }
      return exited;
    },
  };
  live.add(proc);
  return proc;
}

/** Runs one invocation to completion. */
export function runCliAsync(
  argv: readonly string[],
  cwd: string,
  env?: RunEnv,
): Promise<ProcessResult> {
  return startCli(env === undefined ? { argv } : { argv, env }, cwd).exited;
}

/** Environment variable holding the clock offset of a child, read by the clock preload. */
export const CLOCK_OFFSET_ENV = 'AGENTBOARD_HARNESS_CLOCK_OFFSET_MS';

/** Environment variable holding the stopped clock of a child, read by the clock preload. */
export const CLOCK_FIXED_ENV = 'AGENTBOARD_HARNESS_CLOCK_FIXED_MS';

const CLOCK_MODULE = `const offset = Number(process.env.${CLOCK_OFFSET_ENV} ?? '0');
const fixed = process.env.${CLOCK_FIXED_ENV};
if (fixed !== undefined && fixed !== '') {
  const at = Number(fixed);
  Date.now = () => at;
} else if (Number.isFinite(offset) && offset !== 0) {
  const real = Date.now.bind(Date);
  Date.now = () => real() + offset;
}
`;

let clockModule: string | null = null;

/** Path of the clock preload module, written once per test file. */
function clockPath(): string {
  if (clockModule === null) {
    clockModule = join(scratchDir(), 'clock.mjs');
    writeFileSync(clockModule, CLOCK_MODULE);
  }
  return clockModule;
}

/** Environment variable naming the read log of a child, read by the read-log preload. */
export const READ_LOG_ENV = 'AGENTBOARD_HARNESS_READ_LOG';

const READ_LOG_MODULE = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const log = process.env.${READ_LOG_ENV};
if (log) {
  const pattern = /[\\/]events[\\/][0-9a-f]{64}\\.json$/;
  const opened = [];
  const note = (path) => {
    const text = typeof path === 'string' ? path : path instanceof URL ? path.pathname : '';
    if (pattern.test(text)) {
      opened.push(text);
    }
  };
  const { readFileSync, openSync, writeFileSync } = fs;
  fs.readFileSync = function (path, ...rest) {
    note(path);
    return readFileSync.call(this, path, ...rest);
  };
  fs.openSync = function (path, ...rest) {
    note(path);
    return openSync.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
  process.on('exit', () => {
    writeFileSync(log, opened.map((path) => path + '\\n').join(''));
  });
}
`;

let readLogModule: string | null = null;

/** Path of the read-log preload module, written once per test file. */
function readLogModulePath(): string {
  if (readLogModule === null) {
    readLogModule = join(scratchDir(), 'read-log.mjs');
    writeFileSync(readLogModule, READ_LOG_MODULE);
  }
  return readLogModule;
}

/**
 * The event files a child started with `readLog: path` opened, one per
 * call, in call order. Throws when the child wrote no log (it was killed).
 */
export function readLogLines(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '');
}

/** Environment variable naming the gate directory of a gated child. */
export const GATE_ENV = 'AGENTBOARD_HARNESS_GATE';

/** Environment variable listing, newline-separated, the module URLs a gated child preloads. */
export const PRELOAD_ENV = 'AGENTBOARD_HARNESS_PRELOAD';

const GATE_MODULE = `import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const dir = process.env.${GATE_ENV};
if (dir) {
  // Load the CLI's code chunks before the gate (with process warnings
  // muted while they load, so the node:sqlite warning is not printed), so
  // that after the gate only the command itself runs.
  const saved = process.listeners('warning');
  process.removeAllListeners('warning');
  for (const url of (process.env.${PRELOAD_ENV} ?? '').split('\\n')) {
    if (url !== '') {
      await import(url);
    }
  }
  await new Promise((resolve) => setImmediate(resolve));
  for (const listener of saved) {
    process.on('warning', listener);
  }
  writeFileSync(join(dir, 'ready-' + String(process.pid)), '');
  const go = join(dir, 'go');
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(go)) {
    Atomics.wait(cell, 0, 0, 1);
  }
}
`;

/**
 * URLs of the built CLI's code chunks: every `.js` file in `dist` other
 * than the `cli.js` entry (which runs the command when imported) and the
 * separate `index.js` library bundle. Importing a chunk only defines
 * functions. When the build has no chunks the gate still works, with the
 * module loading after the gate widening the start spread.
 */
function cliChunks(): string[] {
  const dist = dirname(requireBuiltCli());
  return readdirSync(dist)
    .filter((name) => name.endsWith('.js') && name !== 'cli.js' && name !== 'index.js')
    .sort()
    .map((name) => pathToFileURL(join(dist, name)).href);
}

let gateModule: string | null = null;

/** Path of the gate preload module, written once per test file. */
function gatePath(): string {
  if (gateModule === null) {
    gateModule = join(scratchDir(), 'gate.mjs');
    writeFileSync(gateModule, GATE_MODULE);
  }
  return gateModule;
}

/** Result of `runTogether`. */
export interface TogetherResult {
  /** One result per invocation, in the order given. */
  results: ProcessResult[];
  /** Milliseconds from opening the gate to the last exit. */
  elapsedMs: number;
  /** Number of children that were blocked at the gate when it opened. */
  readyAtGate: number;
}

/** Children blocked at one start gate (`startGated`). */
export interface Gated {
  /** One child per invocation, in the order given. */
  procs: CliProcess[];
  /** Number of children blocked at the gate (all of them). */
  readyAtGate: number;
  /** Opens the gate, so every child runs its command now; returns `Date.now()`. */
  open(): number;
}

/**
 * Starts every invocation in `cwd` behind one start gate and resolves once
 * all of them are blocked at it (so all are running at once and past
 * module loading), without opening it. Rejects, killing them, if they are
 * not all ready within `readyTimeoutMs`. Lets a test start something else
 * (an MCP call) at the moment the gate opens.
 */
export async function startGated(
  invocations: readonly Invocation[],
  cwd: string,
  readyTimeoutMs = 20_000,
): Promise<Gated> {
  const gateDir = scratchDir();
  const nodeArgs = ['--import', pathToFileURL(gatePath()).href];
  const preload = cliChunks().join('\n');
  const procs = invocations.map((inv) =>
    startCli(
      {
        argv: inv.argv,
        env: { ...(inv.env ?? cliEnv()), [GATE_ENV]: gateDir, [PRELOAD_ENV]: preload },
        ...(inv.clockOffsetMs === undefined ? {} : { clockOffsetMs: inv.clockOffsetMs }),
        ...(inv.clockFixedMs === undefined ? {} : { clockFixedMs: inv.clockFixedMs }),
        ...(inv.timeoutMs === undefined ? {} : { timeoutMs: inv.timeoutMs }),
        ...(inv.readLog === undefined ? {} : { readLog: inv.readLog }),
      },
      cwd,
      nodeArgs,
    ),
  );
  const readyCount = (): number =>
    readdirSync(gateDir).filter((name) => name.startsWith('ready-')).length;
  const deadline = Date.now() + readyTimeoutMs;
  while (readyCount() < procs.length) {
    if (Date.now() > deadline) {
      await Promise.all(procs.map((p) => p.kill()));
      throw new Error(`only ${String(readyCount())} of ${String(procs.length)} reached the gate`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return {
    procs,
    readyAtGate: readyCount(),
    open: () => {
      const opened = Date.now();
      writeFileSync(join(gateDir, 'go'), '');
      return opened;
    },
  };
}

/**
 * Starts every invocation in `cwd` behind one start gate, waits until all
 * of them are blocked at the gate (so all are running at once), opens it,
 * and resolves when all have exited. Rejects if they are not all ready
 * within `readyTimeoutMs`.
 */
export async function runTogether(
  invocations: readonly Invocation[],
  cwd: string,
  readyTimeoutMs = 20_000,
): Promise<TogetherResult> {
  const gated = await startGated(invocations, cwd, readyTimeoutMs);
  const opened = gated.open();
  const results = await Promise.all(gated.procs.map((p) => p.exited));
  return { results, elapsedMs: Date.now() - opened, readyAtGate: gated.readyAtGate };
}

/** The `AGENTBOARD_TEST_PAUSE` points (see `src/store/transaction.ts`). */
export type PausePoint = 'after-temp-write' | 'after-rename';

/**
 * Waits until `proc` prints `agentboard: paused at <point> <path>` and
 * returns `<path>` (the temporary file for `after-temp-write`, the final
 * hash-named file for `after-rename`).
 */
export async function waitForPause(proc: CliProcess, point: PausePoint): Promise<string> {
  const match = await proc.waitForStderr(new RegExp(`^agentboard: paused at ${point} (.+)$`, 'm'));
  return match[1] ?? '';
}

/**
 * Parses stdout as exactly one JSON document followed by one newline.
 * Throws otherwise.
 */
export function oneDocument(result: ProcessResult): unknown {
  const { stdout } = result;
  if (!stdout.endsWith('\n') || stdout.slice(0, -1).includes('\n')) {
    throw new Error(`stdout is not one JSON line: ${JSON.stringify(stdout)}`);
  }
  return JSON.parse(stdout) as unknown;
}
