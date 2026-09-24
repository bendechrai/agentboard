/**
 * "Did you mean" suggestions for unknown commands and flags
 * (board-agent-guidance: "Unknown command suggestions"). Pure; used by the
 * parser (`parseArgs`) and by `help <topic>`.
 */

import type { ArgSpec, CommandSpec } from '../cli/types.js';

/** At most this many suggestions are offered. */
export const MAX_SUGGESTIONS = 3;

/** A candidate is suggested only within this edit distance. */
export const MAX_SUGGESTION_DISTANCE = 2;

/**
 * The Levenshtein distance between `a` and `b`: the least number of
 * single-character insertions, deletions and substitutions turning one into
 * the other, counted in UTF-16 code units. A transposition counts 2.
 * Symmetric; 0 exactly when the strings are equal. Pure.
 */
export function editDistance(a: string, b: string): number {
  void a;
  void b;
  throw new Error('not implemented');
}

/**
 * The commands to suggest for `argv` (the arguments after the program name)
 * when no command matches it, as full command names.
 *
 * For a command of k words, its full distance is the edit distance between
 * its name and the first k arguments joined by single spaces (fewer when
 * `argv` is shorter). It is a candidate when either
 * - its full distance is at most `MAX_SUGGESTION_DISTANCE`; or
 * - it has two or more words and the edit distance between its first word
 *   and the first argument is at most `MAX_SUGGESTION_DISTANCE` (so
 *   `checklist` alone, `checklist tik` or `checklst` suggest both
 *   `checklist tick` and `checklist untick`).
 * Candidates are ordered by full distance, then by their order in
 * `commands`, and at most `MAX_SUGGESTIONS` are returned. An empty `argv`
 * returns []. Pure.
 */
export function suggestCommands(
  argv: readonly string[],
  commands: readonly CommandSpec[],
): string[] {
  void argv;
  void commands;
  throw new Error('not implemented');
}

/**
 * The flags to suggest for the unknown flag `name` (without its leading
 * dashes, e.g. `not` for `--not`) among `flags`, as `--<name>` strings:
 * the flags whose name is within `MAX_SUGGESTION_DISTANCE` of `name`,
 * ordered by distance, then by their order in `flags`, at most
 * `MAX_SUGGESTIONS`. Pure.
 */
export function suggestFlags(name: string, flags: readonly ArgSpec[]): string[] {
  void name;
  void flags;
  throw new Error('not implemented');
}

/**
 * The unknown command named in an error for `argv`: the first argument, or,
 * when the first argument is the first word of a command of several words
 * and a second argument exists, the first two arguments joined by a space
 * (`checklist tik`). Passed through `asciiText`. Pure.
 */
export function unknownCommandToken(
  argv: readonly string[],
  commands: readonly CommandSpec[],
): string {
  void argv;
  void commands;
  throw new Error('not implemented');
}

/**
 * The message of the exit 1 `usage` error for an unknown command (argv
 * non-empty, matching no command), exactly:
 * - with suggestions:
 *   `unknown command <token>; did you mean <list>? run 'agentboard help' to list the commands`
 * - without:
 *   `unknown command <token>; run 'agentboard help' to list the commands`
 * where `<token>` is `unknownCommandToken(argv, commands)` and `<list>` is
 * `suggestCommands(argv, commands)` written `a`, `a or b`, or `a, b or c`.
 * Pure.
 */
export function unknownCommandMessage(
  argv: readonly string[],
  commands: readonly CommandSpec[],
): string {
  void argv;
  void commands;
  throw new Error('not implemented');
}

/**
 * The message of the exit 1 `usage` error for an unknown flag `--<name>`
 * given to `command`, where `flags` are the flags it accepts (its own and
 * the global ones), exactly:
 * - with suggestions:
 *   `unknown flag --<name> for <command>; did you mean <list>? run 'agentboard help <command>' to list its flags`
 * - without:
 *   `unknown flag --<name> for <command>; run 'agentboard help <command>' to list its flags`
 * where `<name>` is passed through `asciiText`, `<command>` is the command
 * name and `<list>` is `suggestFlags(name, flags)` written as in
 * `unknownCommandMessage`. Pure.
 */
export function unknownFlagMessage(
  name: string,
  command: CommandSpec,
  flags: readonly ArgSpec[],
): string {
  void name;
  void command;
  void flags;
  throw new Error('not implemented');
}
