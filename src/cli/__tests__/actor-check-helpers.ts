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
import { COMMANDS } from '../registry.js';
import type { CommandSpec } from '../types.js';
import { runWith, type Runner } from './no-echo-helpers.js';

/** What the hint of an `invalid-actor` refusal on the CLI must name. */
export type HintKind = 'actor' | 'to';

/**
 * The registry command the leading words of `argv` select (the longest
 * match), or undefined.
 */
export function leadingSpec(argv: readonly string[]): CommandSpec | undefined {
  let best: CommandSpec | undefined;
  for (const command of COMMANDS) {
    const words = command.name.split(' ');
    if (
      words.every((word, i) => argv[i] === word) &&
      (best === undefined || words.length > best.name.split(' ').length)
    ) {
      best = command;
    }
  }
  return best;
}

/** Whether `command` uses `AGENTBOARD_ACTOR` as its actor (it writes or tracks a cursor). */
export function usesActorEnv(command: CommandSpec): boolean {
  return command.writes || command.tracksCursor === true;
}

/**
 * Checks the hint of a CLI `invalid-actor` refusal (board-agent-guidance
 * "Guide states the actor form"; review round 1 F5): one line, the
 * placeholder `<actor>`, the word `form`; for a refused actor (`--as` or
 * `AGENTBOARD_ACTOR`) it names `--as <actor>`; for a refused `--to` it
 * names `--to <actor>`. It never names `agentboard mcp` (a CLI caller can
 * set the variable). When `command` (the registry command that failed) is
 * given: the hint says `set AGENTBOARD_ACTOR` exactly when the command
 * uses the variable as its actor, and otherwise does not name the variable
 * at all; for `handoff` it names both names unambiguously, the actor
 * first and then `, and the new assignee with --to <actor>`.
 */
export function expectCliActorHint(
  hint: string | null,
  kind: HintKind,
  command?: CommandSpec,
): void {
  expect(hint).not.toBeNull();
  const text = hint ?? '';
  expect(text).not.toContain('\n');
  expect(text).toContain('<actor>');
  expect(text).toContain('form');
  if (kind === 'actor') {
    expect(text).toContain('--as <actor>');
  } else {
    expect(text).toContain('--to <actor>');
  }
  expect(text).not.toContain('agentboard mcp');
  if (command !== undefined) {
    if (usesActorEnv(command)) {
      expect(text, command.name).toContain('set AGENTBOARD_ACTOR');
    } else {
      expect(text, command.name).not.toContain('AGENTBOARD_ACTOR');
    }
    if (command.name === 'handoff') {
      expect(text).toContain('--as <actor>');
      expect(text).toContain(', and the new assignee with --to <actor>');
      expect(text).not.toContain('AGENTBOARD_ACTOR and the new assignee');
    }
  }
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
  expectCliActorHint(hint, options.hint ?? 'actor', leadingSpec(argv));
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
