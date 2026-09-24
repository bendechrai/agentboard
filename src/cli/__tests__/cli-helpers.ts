/**
 * Helpers for the CLI tests: an in-process runner over `runCli` and a
 * spawner for the built CLI (`dist/cli.js`), both returning exit code,
 * stdout and stderr separately.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanEnv, makeBoardDir, tempDir } from '../../board/__tests__/helpers.js';
import { runCli } from '../main.js';

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunEnv = Record<string, string | undefined>;

/** The environment for CLI runs: clean git, no board override, no actor. */
export function cliEnv(extra: RunEnv = {}): RunEnv {
  return cleanEnv({ AGENTBOARD_ACTOR: undefined, AGENTBOARD_DIR: undefined, ...extra });
}

/** Runs the CLI in process. */
export function run(argv: readonly string[], cwd: string, env: RunEnv = cliEnv()): Run {
  let stdout = '';
  let stderr = '';
  const code = runCli({
    argv,
    cwd,
    env,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

/** Absolute path of the built CLI. */
export const BUILT_CLI = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'dist',
  'cli.js',
);

/** Runs the built CLI as a child process (`node dist/cli.js`). */
export function spawnCli(argv: readonly string[], cwd: string, env: RunEnv = cliEnv()): Run {
  if (!existsSync(BUILT_CLI)) {
    throw new Error(`${BUILT_CLI} is missing; run npm run build first`);
  }
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      childEnv[key] = value;
    }
  }
  const result = spawnSync(process.execPath, [BUILT_CLI, ...argv], {
    cwd,
    env: childEnv,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** A temporary project (not a git repository) with an empty board at `./.board`. */
export function project(): { root: string; boardDir: string } {
  const root = tempDir();
  return { root, boardDir: makeBoardDir(root) };
}

/**
 * Parses stdout as exactly one JSON document: the whole of stdout is one
 * `JSON.stringify` output followed by a single newline.
 */
export function oneJson(out: Run): unknown {
  if (!out.stdout.endsWith('\n') || out.stdout.slice(0, -1).includes('\n')) {
    throw new Error(`stdout is not one JSON line: ${JSON.stringify(out.stdout)}`);
  }
  return JSON.parse(out.stdout) as unknown;
}

/** The `hash` and ticket `id` of a writing command's `--json` output. */
export function written(out: Run): { hash: string | null; id: string } {
  const doc = oneJson(out) as { hash: string | null; ticket: { id: string } };
  return { hash: doc.hash, id: doc.ticket.id };
}
