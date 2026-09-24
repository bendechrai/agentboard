/**
 * Stand-ins for the GitHub CLI, so no test ever runs the real `gh`.
 *
 * - `fakeRunner`: an in-process `GhRunner` for library tests.
 * - `fakeGhOnPath`: a directory holding an executable `gh` shell script
 *   (built-ins only, so it needs nothing else on PATH) that logs its
 *   arguments and answers `gh pr view <pr> --json state` from a table. CLI
 *   tests put that directory first on the PATH of the environment they
 *   pass. `emptyPath` is a directory with no `gh` at all, for the
 *   gh-missing case; a PATH made of it alone can never reach a real `gh`.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { GhResult, GhRunner } from '../merged.js';
import { tempDir } from './helpers.js';

/** How the fake answers for one PR: a state (exit 0 with `{"state":...}`) or a full result. */
export type FakeAnswer = string | { code: number; stdout: string; stderr: string };

/** A `GhRunner` answering from `answers` keyed by the PR argument (`args[2]`), recording calls. */
export function fakeRunner(answers: Record<string, FakeAnswer>): {
  gh: GhRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const gh: GhRunner = (args) => {
    calls.push([...args]);
    const answer = answers[args[2] ?? ''];
    if (answer === undefined) {
      return { status: 'exited', code: 1, stdout: '', stderr: 'GraphQL: no such pull request\n' };
    }
    const result: GhResult =
      typeof answer === 'string'
        ? {
            status: 'exited',
            code: 0,
            stdout: `${JSON.stringify({ state: answer })}\n`,
            stderr: '',
          }
        : { status: 'exited', ...answer };
    return result;
  };
  return { gh, calls };
}

/** A `GhRunner` for a machine without `gh`, recording calls. */
export function missingRunner(): { gh: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    gh: (args) => {
      calls.push([...args]);
      return { status: 'missing' };
    },
    calls,
  };
}

function shellQuote(text: string): string {
  return `'${text.split("'").join("'\\''")}'`;
}

/**
 * A directory containing an executable fake `gh`. It appends `"$*"` to
 * `log` for every call, then for `pr view <pr> --json state` prints
 * `{"state":"<state>"}` and exits 0 when `<pr>` is in `states`; otherwise
 * prints an error to stderr and exits 1.
 */
export function fakeGhOnPath(states: Record<string, string>): { dir: string; log: string } {
  const dir = join(tempDir(), 'fake-bin');
  mkdirSync(dir);
  const log = join(dir, 'gh.log');
  const cases = Object.entries(states)
    .map(
      ([pr, state]) =>
        `  ${shellQuote(pr)}) printf '%s\\n' ${shellQuote(JSON.stringify({ state }))}; exit 0 ;;`,
    )
    .join('\n');
  const script = [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${shellQuote(log)}`,
    'if [ "$1" != pr ] || [ "$2" != view ] || [ "$4" != --json ] || [ "$5" != state ]; then',
    "  printf '%s\\n' 'fake gh: unexpected arguments' >&2; exit 2",
    'fi',
    'case "$3" in',
    cases,
    "  *) printf '%s\\n' 'GraphQL: Could not resolve to a PullRequest' >&2; exit 1 ;;",
    'esac',
    '',
  ].join('\n');
  const gh = join(dir, 'gh');
  writeFileSync(gh, script);
  chmodSync(gh, 0o755);
  return { dir, log };
}

/** The argument lines the fake `gh` logged, or [] when it never ran. */
export function ghCalls(log: string): string[] {
  return existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter((l) => l !== '')
    : [];
}

/** An empty directory, for a PATH on which no `gh` can be found. */
export function emptyPath(): string {
  const dir = join(tempDir(), 'empty-bin');
  mkdirSync(dir);
  return dir;
}
