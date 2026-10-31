/**
 * Helpers for the actor check tests of the CLI (actor-secret-check group
 * 1): run a command line whose actor is refused, plain and with `--json`,
 * in process or against the built CLI, and check the whole refusal: exit
 * 1, reason `invalid-actor`, the exact message, a hint that writes
 * `<actor>` and names how to pass an actor, the same hint in the `--json`
 * document, nothing on stdout but that document, and no refused name in
 * any output.
 */

import { readdirSync } from 'node:fs';

import { expect } from 'vitest';

import { expectNoLeak, type SecretFixture } from '../../__tests__/harness/secret-fixtures.js';
import { cliEnv, oneJson, type Run, type RunEnv } from './cli-helpers.js';
import { runWith, type Runner } from './no-echo-helpers.js';

/** What the hint of an `invalid-actor` refusal on the CLI must name. */
export type HintKind = 'actor' | 'to';

/**
 * Checks the hint of a CLI `invalid-actor` refusal (board-agent-guidance
 * "Guide states the actor form"): one line, the placeholder `<actor>`, the
 * word `form`; for a refused actor (`--as` or `AGENTBOARD_ACTOR`) it names
 * `--as <actor>` and `AGENTBOARD_ACTOR`; for a refused `--to` it names
 * `--to <actor>`. It never names `agentboard mcp` (a CLI caller can set
 * the variable).
 */
export function expectCliActorHint(hint: string | null, kind: HintKind): void {
  expect(hint).not.toBeNull();
  const text = hint ?? '';
  expect(text).not.toContain('\n');
  expect(text).toContain('<actor>');
  expect(text).toContain('form');
  if (kind === 'actor') {
    expect(text).toContain('--as <actor>');
    expect(text).toContain('AGENTBOARD_ACTOR');
  } else {
    expect(text).toContain('--to <actor>');
  }
  expect(text).not.toContain('agentboard mcp');
}

/** The hint line of a refusal's stderr (`agentboard: <message>\nhint: <hint>\n`). */
function hintOf(stderr: string, message: string): string {
  const prefix = `agentboard: ${message}\nhint: `;
  expect(stderr.startsWith(prefix), stderr).toBe(true);
  expect(stderr.endsWith('\n')).toBe(true);
  const hint = stderr.slice(prefix.length, -1);
  expect(hint).not.toContain('\n');
  return hint;
}

/**
 * Runs `argv` plain and with `--json` appended and checks the
 * `invalid-actor` refusal on both (see the module comment). Returns the
 * plain run.
 */
export function expectActorRefusal(
  argv: readonly string[],
  cwd: string,
  message: string,
  fixtures: readonly SecretFixture[],
  options: { runner?: Runner; env?: RunEnv; hint?: HintKind } = {},
): Run {
  const runner = options.runner ?? 'in-process';
  const env = options.env ?? cliEnv();
  const what = `${runner} ${argv[0] ?? ''}`;
  const plain = runWith(runner, argv, cwd, env);
  const json = runWith(runner, [...argv, '--json'], cwd, env);
  expectNoLeak(`${what} (plain)`, [plain.stdout, plain.stderr], fixtures);
  expectNoLeak(`${what} (--json)`, [json.stdout, json.stderr], fixtures);
  expect(plain.code, plain.stderr).toBe(1);
  expect(plain.stdout).toBe('');
  const hint = hintOf(plain.stderr, message);
  expectCliActorHint(hint, options.hint ?? 'actor');
  expect(json.code, json.stderr).toBe(1);
  expect(json.stderr).toBe(plain.stderr);
  expect(oneJson(json)).toEqual({
    error: { exitCode: 1, reason: 'invalid-actor', message, hint },
  });
  return plain;
}

/** Every entry of `dir`, recursively, as relative paths (dot files and temporaries included), sorted. */
export function tree(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`;
    out.push(path);
    if (entry.isDirectory()) {
      out.push(...tree(`${dir}/${entry.name}`, `${path}/`));
    }
  }
  return out.sort();
}
