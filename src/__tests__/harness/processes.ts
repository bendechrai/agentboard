/**
 * Multi-process test harness for the concurrency and crash properties
 * (task group 4; design.md: "Tests ... spawn the built CLI for the
 * concurrency and crash properties").
 *
 * Build: the harness runs the built CLI (`dist/cli.js`, `BUILT_CLI`) and
 * never builds it itself. `make check` (and `npm run check`) run the build
 * before the tests, and `make check-in-docker` / `make check-floor` run
 * `make check`, so the tests always see a fresh build there. When running
 * vitest directly, run `npm run build` first; a missing build fails the
 * test with that instruction (`requireBuiltCli`). Building once per test
 * file from vitest was rejected: it would race when vitest runs files in
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
 * Temporary directories made here (`boardProject`, the gate) are removed
 * after the test file (afterAll), not after each test, so one scenario can
 * be set up in `beforeAll` and asserted by several tests.
 */

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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

/** Every child is killed with SIGKILL after this long. */
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
  const child = spawn(process.execPath, [...nodeArgs, cli, ...invocation.argv], {
    cwd,
    env: definedEnv(invocation.env ?? cliEnv()),
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
  const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS);
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
