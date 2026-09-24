/**
 * The argument parser driven by the command registry, and actor resolution
 * (board-cli: "Command surface", "Actor is explicit").
 */

import { BoardError } from '../store/errors.js';
import { COMMANDS, GLOBAL_FLAGS } from './registry.js';
import { asciiText } from './render.js';
import type { ArgSpec, ArgValue, ArgValues, CommandSpec, Env } from './types.js';

/** The environment variable naming the actor when `--as` is not given. */
export const ACTOR_ENV = 'AGENTBOARD_ACTOR';

/** Result of `parseArgs`. */
export interface ParsedCommand {
  command: CommandSpec;
  /** Values keyed by `ArgSpec.name`; `json` and absent arguments are not included. */
  values: ArgValues;
  /** True when `--json` was given. */
  json: boolean;
}

/**
 * Parses `argv` (the arguments after the program name) against `commands`
 * (default `COMMANDS`). Pure; never touches the board or the environment.
 *
 * Rules:
 * - The command is the longest command name whose words equal the leading
 *   arguments (`checklist tick 01ABCD 2` is `checklist tick`). No match,
 *   including an empty `argv`, is `BoardError(1, 'usage')` whose message
 *   lists every command name.
 * - After the command words, an argument starting with `--` is a flag,
 *   written `--name value` or `--name=value`; a boolean flag takes no value
 *   (`--name=value` on it is a usage error). The value of a string or
 *   integer flag is the next argument taken verbatim, even when it starts
 *   with `-`; a missing value is a usage error. A lone `--` ends flags:
 *   every later argument is positional. Every other argument (including
 *   `-` and `-1`) is positional. Flags may appear before, between or after
 *   positionals.
 * - `--json` and `--as` (`GLOBAL_FLAGS`) are accepted by every command.
 *   `--json` sets `json` and is not in `values`; `--as` is in `values` as
 *   `as` when given, for every command (only writing commands use it).
 * - Unknown flag, a non-repeatable flag given twice, more positionals than
 *   the command declares, or a missing required positional or flag: usage
 *   error naming the argument.
 * - `integer` values must match `^-?[0-9]+$` and be safe integers; the
 *   value is the number. Repeatable flags produce string arrays.
 * - Then each of the command's exclusive groups is checked as documented
 *   on `ExclusiveGroup` (a missing required group throws with the group's
 *   own reason and message, for example `needs-task-or-adhoc` for `new`
 *   and `no-disposition` for `close`).
 *
 * Every error is a `BoardError` with exit code 1 and reason `usage`, except
 * the exclusive-group reasons above.
 */
export function parseArgs(
  argv: readonly string[],
  commands: readonly CommandSpec[] = COMMANDS,
): ParsedCommand {
  const command = selectCommand(argv, commands);
  const rest = argv.slice(command.name.split(' ').length);
  const flags = new Map<string, ArgSpec>();
  for (const spec of [...command.flags, ...GLOBAL_FLAGS]) {
    flags.set(spec.name, spec);
  }
  const values: Record<string, ArgValue> = {};
  const positionals: string[] = [];
  let json = false;
  let jsonSeen = false;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] ?? '';
    if (arg === '--') {
      positionals.push(...rest.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    const inline = eq < 0 ? undefined : arg.slice(eq + 1);
    const spec = flags.get(name);
    if (spec === undefined) {
      throw usage(`unknown flag --${asciiText(name)} for ${command.name}`);
    }
    if (spec.type === 'boolean') {
      if (inline !== undefined) {
        throw usage(`--${name} takes no value`);
      }
      if (name === 'json' ? jsonSeen : Object.hasOwn(values, name)) {
        throw usage(`--${name} given more than once`);
      }
      if (name === 'json') {
        json = true;
        jsonSeen = true;
      } else {
        values[name] = true;
      }
      continue;
    }
    let raw = inline;
    if (raw === undefined) {
      raw = rest[i + 1];
      if (raw === undefined) {
        throw usage(`--${name} needs a value`);
      }
      i += 1;
    }
    const value = spec.type === 'integer' ? parseInteger(`--${name}`, raw) : raw;
    if (spec.repeatable) {
      const list = values[name];
      values[name] = [...(Array.isArray(list) ? (list as string[]) : []), String(value)];
    } else if (Object.hasOwn(values, name)) {
      throw usage(`--${name} given more than once`);
    } else {
      values[name] = value;
    }
  }

  if (positionals.length > command.positionals.length) {
    const extra = positionals[command.positionals.length] ?? '';
    throw usage(`unexpected argument ${asciiText(extra)} for ${command.name}`);
  }
  command.positionals.forEach((spec, index) => {
    const raw = positionals[index];
    if (raw === undefined) {
      if (spec.required) {
        throw usage(`${command.name} needs the argument <${spec.name}>`);
      }
      return;
    }
    values[spec.name] = spec.type === 'integer' ? parseInteger(spec.name, raw) : raw;
  });
  for (const spec of command.flags) {
    if (spec.required && !Object.hasOwn(values, spec.name)) {
      throw usage(`${command.name} needs the flag --${spec.name}`);
    }
  }
  for (const group of command.exclusive) {
    const given = group.alternatives.filter((alt) =>
      alt.some((name) => Object.hasOwn(values, name)),
    );
    const [chosen, ...others] = given;
    if (others.length > 0) {
      throw usage(
        `give only one of ${group.alternatives.map((alt) => alt.map((n) => `--${n}`).join(' with ')).join(', ')}`,
      );
    }
    if (chosen === undefined) {
      if (group.required) {
        throw new BoardError(1, group.reason, group.message);
      }
      continue;
    }
    const missing = chosen.filter((name) => !Object.hasOwn(values, name));
    if (missing.length > 0) {
      throw usage(
        `${chosen.map((n) => `--${n}`).join(' and ')} must be given together; missing ${missing.map((n) => `--${n}`).join(', ')}`,
      );
    }
  }
  return { command, values, json };
}

/** The command whose words are the longest match for the leading arguments. */
function selectCommand(argv: readonly string[], commands: readonly CommandSpec[]): CommandSpec {
  let best: CommandSpec | undefined;
  let bestLength = 0;
  for (const command of commands) {
    const words = command.name.split(' ');
    if (words.length > bestLength && words.every((word, i) => argv[i] === word)) {
      best = command;
      bestLength = words.length;
    }
  }
  if (best === undefined) {
    const given =
      argv.length === 0 ? 'no command given' : `unknown command ${asciiText(argv[0] ?? '')}`;
    throw usage(
      `${given}; usage: agentboard <command> [arguments]; commands: ${commands.map((c) => c.name).join(', ')}`,
    );
  }
  return best;
}

/** A decimal integer argument, or a usage error naming it. */
function parseInteger(name: string, raw: string): number {
  const value = Number(raw);
  if (!/^-?[0-9]+$/.test(raw) || !Number.isSafeInteger(value)) {
    throw usage(`${name} must be an integer, not ${asciiText(raw)}`);
  }
  return value;
}

function usage(message: string): BoardError {
  return new BoardError(1, 'usage', message);
}

/**
 * The actor of a writing command: `given` (the `--as` value) when it is a
 * non-empty string, else `env.AGENTBOARD_ACTOR` when non-empty. Never the
 * OS user (`USER`, `LOGNAME`, `os.userInfo()` are never read).
 *
 * @throws BoardError exit 1, reason `missing-actor`, whose message names
 *   both ways to supply an actor: `--as <actor>` and `AGENTBOARD_ACTOR`.
 */
export function resolveActor(given: string | undefined, env: Env): string {
  if (given !== undefined && given !== '') {
    return given;
  }
  const fromEnv = env[ACTOR_ENV];
  if (fromEnv !== undefined && fromEnv !== '') {
    return fromEnv;
  }
  throw new BoardError(
    1,
    'missing-actor',
    `this command needs an actor: pass --as <actor> or set ${ACTOR_ENV}`,
  );
}
