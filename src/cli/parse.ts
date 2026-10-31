/**
 * The argument parser driven by the command registry, actor resolution and
 * the actor check (board-cli: "Command surface", "Actor is explicit",
 * "Actor names are checked").
 */

import { choicesMessage } from '../board/text.js';
import { SYSTEM_ACTOR } from '../events/schema.js';
import { BoardError } from '../store/errors.js';
import { positionalForm } from '../guidance/help.js';
import { unknownCommandMessage, unknownFlagMessage } from '../guidance/suggest.js';
import { COMMANDS, GLOBAL_FLAGS, JSON_FLAG } from './registry.js';
import type { ArgSpec, ArgValue, ArgValues, CommandSpec, Env } from './types.js';

export { choicesMessage };

/** The environment variable naming the actor when `--as` is not given. */
export const ACTOR_ENV = 'AGENTBOARD_ACTOR';

/** The command that help requests become. */
const HELP_COMMAND = 'help';

/** The arguments that request help (`--help`, `-h`). */
const HELP_FLAGS: ReadonlySet<string> = new Set(['--help', '-h']);

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
 * - Help requests (board-agent-guidance: "Generated help") are parsed as
 *   the `help` command, before anything below and without validating any
 *   other argument, so they never need an actor or a board:
 *   - an empty `argv`, or a first argument `--help` or `-h`, is `help`
 *     with the remaining arguments (`agentboard -h claim` is
 *     `help claim`);
 *   - a command (matched as below) followed anywhere before a lone `--` by
 *     `--help` or `-h` is `help <command words>`, with `json` true when
 *     `--json` is also among those arguments; every other argument is
 *     ignored (`claim 01J9K3 --bogus --help` is `help claim`), and after a
 *     lone `--` both are ordinary positionals. `help --help` is
 *     `help help`.
 *   An unknown command followed by `--help` is still an unknown command.
 *   Only when `commands` has a `help` command: the MCP server validates a
 *   tool call with `parseArgs(argv, [command])`, so there a string value
 *   such as `-h` stays a value.
 * - The command is the longest command name whose words equal the leading
 *   arguments (`checklist tick 01ABCD 2` is `checklist tick`). No match is
 *   `BoardError(1, 'usage')` with `unknownCommandMessage(argv, commands)`
 *   (it suggests up to three commands within edit distance 2 and points to
 *   `agentboard help`, without repeating the token).
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
 * - Unknown flag: usage error with `unknownFlagMessage(name, position,
 *   command, [...command.flags, ...GLOBAL_FLAGS])`, where `position` is the
 *   flag's 1-based position in `argv` (the command words count): it names
 *   that position, suggests up to three of the command's flags within edit
 *   distance 2 and points to `agentboard help <command>`, and repeats
 *   neither the flag's name nor an inline `=value`.
 * - A non-repeatable flag given twice, or a missing required positional or
 *   flag: usage error naming the argument from the registry.
 * - More positionals than the command declares: usage error with
 *   `unexpectedArgumentMessage(command, n)`, where `n` is the 1-based
 *   position in `argv` of the first extra positional (the command words,
 *   flags, flag values and a lone `--` count). The extra argument is never
 *   repeated.
 * - `integer` values must match `^-?[0-9]+$` and be safe integers; the
 *   value is the number. Anything else is a usage error, exactly
 *   `--<name> must be an integer` for a flag and `<name> must be an
 *   integer` for a positional (`index must be an integer`), never
 *   repeating the value. Repeatable flags produce string arrays.
 * - A positional with `choices` (`config set <key>`) must be one of them;
 *   any other value is a usage error listing every choice, exactly
 *   `choicesMessage(command.name, '<' + name + '>', choices)`, which never
 *   repeats the value (a token pasted there must not land in a terminal
 *   or a log).
 * - A CLI-only flag (`ArgSpec.cliOnly`) is parsed like any other flag.
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
  const helpCommand = commands.find((c) => c.name === HELP_COMMAND);
  const [first] = argv;
  if (helpCommand !== undefined && (first === undefined || HELP_FLAGS.has(first))) {
    return parseArgs([HELP_COMMAND, ...argv.slice(1)], commands);
  }
  const command = selectCommand(argv, commands);
  const words = command.name.split(' ');
  const rest = argv.slice(words.length);
  if (helpCommand !== undefined) {
    const end = rest.indexOf('--');
    const options = end < 0 ? rest : rest.slice(0, end);
    if (options.some((arg) => HELP_FLAGS.has(arg))) {
      const [topic, subtopic] = words;
      return {
        command: helpCommand,
        values: { topic, ...(subtopic === undefined ? {} : { subtopic }) },
        json: options.includes(`--${JSON_FLAG.name}`),
      };
    }
  }
  const flags = new Map<string, ArgSpec>();
  for (const spec of [...command.flags, ...GLOBAL_FLAGS]) {
    flags.set(spec.name, spec);
  }
  const values: Record<string, ArgValue> = {};
  const positionals: string[] = [];
  // The 1-based position in argv of each positional, for the refusal of an
  // extra one (the command words come first, so index i of rest is at
  // words.length + i + 1).
  const positions: number[] = [];
  let json = false;
  let jsonSeen = false;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] ?? '';
    if (arg === '--') {
      for (let k = i + 1; k < rest.length; k += 1) {
        positionals.push(rest[k] ?? '');
        positions.push(words.length + k + 1);
      }
      break;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      positions.push(words.length + i + 1);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    const inline = eq < 0 ? undefined : arg.slice(eq + 1);
    const spec = flags.get(name);
    if (spec === undefined) {
      throw usage(
        unknownFlagMessage(name, words.length + i + 1, command, [
          ...command.flags,
          ...GLOBAL_FLAGS,
        ]),
      );
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
    const position = positions[command.positionals.length] ?? positions.length;
    throw usage(unexpectedArgumentMessage(command, position));
  }
  command.positionals.forEach((spec, index) => {
    const raw = positionals[index];
    if (raw === undefined) {
      if (spec.required) {
        throw usage(`${command.name} needs the argument <${spec.name}>`);
      }
      return;
    }
    if (spec.choices !== undefined && !spec.choices.includes(raw)) {
      throw usage(choicesMessage(command.name, `<${spec.name}>`, spec.choices));
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

/**
 * The message of the refusal of an extra positional of `command` at the
 * 1-based `position` among the arguments after the program name, exactly
 * `unexpected argument at position <position> for <command>; it takes
 * <positionals>, and text with spaces must be quoted`, where
 * `<positionals>` is the positional part of `synopsis(command)`
 * (`src/guidance/help.ts`): each positional `<name>` when required,
 * `[<name>]` when optional, with its choices joined by `|` in place of its
 * name when it has choices, separated by single spaces (`<id> <text>` for
 * `comment`, `<id> [<status>]` for `move`, `<lease.grace|queue.window>
 * <value>` for `config set`). For a command with no positionals it is
 * exactly `unexpected argument at position <position> for <command>; it
 * takes no positional arguments`. Built only from the registry and the
 * position, so it never repeats the argument. Pure.
 */
export function unexpectedArgumentMessage(command: CommandSpec, position: number): string {
  const head = `unexpected argument at position ${String(position)} for ${command.name}; it takes`;
  if (command.positionals.length === 0) {
    return `${head} no positional arguments`;
  }
  const forms = command.positionals.map((arg) => {
    const form = positionalForm(arg);
    return arg.required ? form : `[${form}]`;
  });
  return `${head} ${forms.join(' ')}, and text with spaces must be quoted`;
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
    throw usage(
      argv.length === 0
        ? "no command given; run 'agentboard help' to list the commands"
        : unknownCommandMessage(argv, commands),
    );
  }
  return best;
}

/**
 * A decimal integer argument, or a usage error naming the argument (`name`
 * is `--<flag>` or the positional's name) and not the value.
 */
function parseInteger(name: string, raw: string): number {
  const value = Number(raw);
  if (!/^-?[0-9]+$/.test(raw) || !Number.isSafeInteger(value)) {
    throw usage(`${name} must be an integer`);
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

/**
 * Refuses the reserved system actor (board-cli: "Claim, release and
 * handoff"; board-events: "Reserved system actor"): when `actor` is
 * exactly `SYSTEM_ACTOR` (`agentboard`), throws `BoardError(1, 'usage')`
 * whose message says that `agentboard` is reserved for the grants the
 * board writes itself and names `--as <actor>`; for any other value,
 * undefined included, does nothing.
 *
 * `runCli` calls it, before the board is opened, with the parsed `--as` of
 * every command (so `show T1 --as agentboard` exits 1 too) and with the
 * actor `resolveActor` resolves for a command that needs one (so
 * `AGENTBOARD_ACTOR=agentboard` is refused there); the MCP server calls it
 * with the call's `as`, and with the resolved actor of a tool that needs
 * one. Nothing is written. Pure.
 */
export function refuseReservedActor(actor: string | undefined): void {
  if (actor === SYSTEM_ACTOR) {
    throw new BoardError(
      1,
      'usage',
      `the actor ${SYSTEM_ACTOR} is reserved for the grants the board writes itself; pass your own name with --as <actor>`,
    );
  }
}

/**
 * Where an actor name came from, as an `invalid-actor` refusal names it
 * (board-cli "Actor names are checked"; actor-secret-check design.md
 * "Messages"): `--as`, `AGENTBOARD_ACTOR` or `--to` on the CLI;
 * `the argument as`, `AGENTBOARD_ACTOR` or `the argument to` over MCP (and
 * on the web, whose body properties are the MCP argument names).
 */
export type ActorSource =
  | '--as'
  | 'AGENTBOARD_ACTOR'
  | '--to'
  | 'the argument as'
  | 'the argument to';

/**
 * The actor check (board-cli "Actor names are checked"; actor-secret-check
 * design.md "The actor check"): returns normally when `name` passes, and
 * throws otherwise. Pure; reads nothing and writes nothing.
 *
 * `name` passes when both hold, tested in this order:
 * 1. it matches none of the secret patterns (`secretPatternsIn(name)`,
 *    `src/board/secrets.ts`, is empty);
 * 2. it has the actor form `^[A-Za-z0-9][A-Za-z0-9._@-]{0,31}$`: 1 to 32
 *    characters, each an ASCII letter, digit, `.`, `_`, `-` or `@`, the
 *    first a letter or digit. The test is on ASCII only, with no Unicode
 *    case folding or normalisation (a long s, a Kelvin sign or a
 *    fullwidth letter fails), and the whole string must match (a trailing
 *    newline fails). The empty string fails.
 *
 * On failure throws `BoardError(1, 'invalid-actor', message)`:
 * - when (1) fails, exactly `refused: the actor name given with <source>
 *   matches the secret pattern(s) <names>; an actor name is recorded on
 *   every event and shared with the board, so choose another name
 *   (--allow-secret-like does not apply to actor names)`, where `<names>`
 *   is the matching pattern names in `SECRET_PATTERN_NAMES` order joined
 *   with `, ` (as `refuseSecretLike` writes them), so a name that also
 *   fails the form gets this message;
 * - when only (2) fails, exactly `refused: the actor name given with
 *   <source> is not of the actor form: 1 to 32 ASCII letters, digits,
 *   dots, underscores, hyphens or @ signs, the first a letter or digit,
 *   such as impl-1`.
 * `<source>` is `source`. The message contains no part of `name`: it
 * interpolates only `source` and the pattern names (the no-echo source
 * scan allows exactly the values `source` and `names` in this function).
 *
 * There is no override: `--allow-secret-like` does not apply to actor
 * names. The reserved actor `agentboard` passes (it is refused separately
 * by `refuseReservedActor`, reason `usage`).
 *
 * Callers (actor-secret-check design.md "Where the check runs"), all
 * before the board is opened: `commandActor` (`src/cli/main.ts`, shared
 * by the CLI and the MCP server) with a given non-empty `--as` (source
 * `--as`) or call `as` (source `the argument as`) on every command, after
 * `refuseReservedActor`, and with the resolved actor of a command that
 * needs one when it came from `AGENTBOARD_ACTOR` (source
 * `AGENTBOARD_ACTOR`); the conversion of the `handoff` arguments with the
 * new assignee (source `--to`, or `the argument to` over MCP and the
 * web). An empty `--as`, `as` or `AGENTBOARD_ACTOR` is not a given name
 * (as for `resolveActor`) and is never checked.
 */
export function checkActorName(name: string, source: ActorSource): void {
  void name;
  void source;
  throw new Error('not implemented: checkActorName (actor-secret-check task 1.1)');
}
