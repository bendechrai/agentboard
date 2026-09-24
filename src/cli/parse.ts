/**
 * The argument parser driven by the command registry, and actor resolution
 * (board-cli: "Command surface", "Actor is explicit").
 */

import { notImplemented } from '../board/stub.js';
import { COMMANDS } from './registry.js';
import type { ArgValues, CommandSpec, Env } from './types.js';

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
  throw notImplemented(argv, commands);
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
  throw notImplemented(given, env);
}
