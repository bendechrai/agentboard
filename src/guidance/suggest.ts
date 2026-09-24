/**
 * "Did you mean" suggestions for unknown commands and flags
 * (board-agent-guidance: "Unknown command suggestions"). Pure; used by the
 * parser (`parseArgs`) and by `help <topic>`.
 */

import { asciiText } from '../board/text.js';
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
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      current.push(Math.min(substitution, deletion, insertion));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
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
  const first = argv[0];
  if (first === undefined) {
    return [];
  }
  const candidates: { name: string; distance: number }[] = [];
  for (const command of commands) {
    const words = command.name.split(' ');
    const distance = editDistance(command.name, argv.slice(0, words.length).join(' '));
    const byFirstWord =
      words.length > 1 && editDistance(words[0] ?? '', first) <= MAX_SUGGESTION_DISTANCE;
    if (distance <= MAX_SUGGESTION_DISTANCE || byFirstWord) {
      candidates.push({ name: command.name, distance });
    }
  }
  return closest(candidates);
}

/**
 * The flags to suggest for the unknown flag `name` (without its leading
 * dashes, e.g. `not` for `--not`) among `flags`, as `--<name>` strings:
 * the flags whose name is within `MAX_SUGGESTION_DISTANCE` of `name`,
 * ordered by distance, then by their order in `flags`, at most
 * `MAX_SUGGESTIONS`. Pure.
 */
export function suggestFlags(name: string, flags: readonly ArgSpec[]): string[] {
  const candidates = flags
    .map((flag) => ({ name: `--${flag.name}`, distance: editDistance(flag.name, name) }))
    .filter((candidate) => candidate.distance <= MAX_SUGGESTION_DISTANCE);
  return closest(candidates);
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
  const [first = '', second] = argv;
  const multiWord = commands.some((command) => {
    const words = command.name.split(' ');
    return words.length > 1 && words[0] === first;
  });
  return asciiText(multiWord && second !== undefined ? `${first} ${second}` : first);
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
  const token = unknownCommandToken(argv, commands);
  return `unknown command ${token}; ${didYouMean(suggestCommands(argv, commands))}run 'agentboard help' to list the commands`;
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
  const suggestions = didYouMean(suggestFlags(name, flags));
  return `unknown flag --${asciiText(name)} for ${command.name}; ${suggestions}run 'agentboard help ${command.name}' to list its flags`;
}

/**
 * The names of `candidates` ordered by distance, then by their given order
 * (the sort is stable), at most `MAX_SUGGESTIONS`.
 */
function closest(candidates: readonly { name: string; distance: number }[]): string[] {
  return [...candidates]
    .sort((a, b) => a.distance - b.distance)
    .slice(0, MAX_SUGGESTIONS)
    .map((candidate) => candidate.name);
}

/** `did you mean <list>? ` for suggestions, or the empty string for none. */
function didYouMean(suggestions: readonly string[]): string {
  if (suggestions.length === 0) {
    return '';
  }
  const last = suggestions.at(-1) ?? '';
  const list =
    suggestions.length === 1 ? last : `${suggestions.slice(0, -1).join(', ')} or ${last}`;
  return `did you mean ${list}? `;
}
