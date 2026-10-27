/**
 * Helpers for the no-echo tests of the CLI (no-echo-refusals group 1;
 * board-cli "Refusals never repeat the refused input"): run one refused
 * command line plain and with `--json`, in process or as a child of the
 * built CLI, and check the whole refusal (exit code, reason, exact
 * message and hint, the stderr lines, the `--json` document) and that no
 * fixture leaked into stdout or stderr.
 */

import { readdirSync } from 'node:fs';

import { expect } from 'vitest';

import { expectNoLeak, type SecretFixture } from '../../__tests__/harness/secret-fixtures.js';
import { cliEnv, oneJson, run, spawnCli, type Run, type RunEnv } from './cli-helpers.js';

/** What a refusal must be on every channel. */
export interface ExpectedRefusal {
  readonly exitCode: number;
  readonly reason: string;
  /** The exact message. */
  readonly message: string;
  /** The exact hint (unchanged by no-echo-refusals unless an id is in it). */
  readonly hint: string | null;
}

/** How the CLI is run. */
export type Runner = 'in-process' | 'child';

/** Runs `argv` with `runner`. */
export function runWith(runner: Runner, argv: readonly string[], cwd: string, env: RunEnv): Run {
  return runner === 'in-process' ? run(argv, cwd, env) : spawnCli(argv, cwd, env);
}

/** The stderr of a refusal: the message line, then the hint line when there is one. */
export function refusalStderr(expected: ExpectedRefusal): string {
  return `agentboard: ${expected.message}\n${expected.hint === null ? '' : `hint: ${expected.hint}\n`}`;
}

/**
 * Runs `argv` plain and with `--json` appended, with `runner`, and checks
 * both against `expected`: plain prints nothing on stdout and exactly
 * `refusalStderr(expected)` on stderr; `--json` prints the same stderr and
 * exactly one `{error: {exitCode, reason, message, hint}}` document on
 * stdout. Then checks that no fixture of `fixtures` appears anywhere in
 * either run's stdout or stderr.
 */
export function expectCliRefusal(
  argv: readonly string[],
  cwd: string,
  expected: ExpectedRefusal,
  fixtures: readonly SecretFixture[],
  options: { runner?: Runner; env?: RunEnv } = {},
): void {
  const runner = options.runner ?? 'in-process';
  const env = options.env ?? cliEnv();
  const what = `${runner} ${argv.length} arguments`;
  const plain = runWith(runner, argv, cwd, env);
  const json = runWith(runner, [...argv, '--json'], cwd, env);
  expectNoLeak(`${what} (plain)`, [plain.stdout, plain.stderr], fixtures);
  expectNoLeak(`${what} (--json)`, [json.stdout, json.stderr], fixtures);
  expect(plain.code, plain.stderr).toBe(expected.exitCode);
  expect(plain.stdout).toBe('');
  expect(plain.stderr).toBe(refusalStderr(expected));
  expect(json.code, json.stderr).toBe(expected.exitCode);
  expect(json.stderr).toBe(refusalStderr(expected));
  expect(oneJson(json)).toEqual({
    error: {
      exitCode: expected.exitCode,
      reason: expected.reason,
      message: expected.message,
      hint: expected.hint,
    },
  });
}

/** The event file names in `eventsDir` (temporaries and `.gitkeep` excluded), sorted. */
export function eventNames(eventsDir: string): string[] {
  return readdirSync(eventsDir)
    .filter((name) => !name.startsWith('.'))
    .sort();
}
