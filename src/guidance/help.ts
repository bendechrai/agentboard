/**
 * Help rendered from the command registry (board-agent-guidance: "Generated
 * help"; design.md: "Help is rendered from the registry"). No command has
 * hand-written help: everything below is built from `CommandSpec` fields,
 * so a flag cannot be added without appearing in help.
 *
 * This module imports no runtime value from `src/cli/registry.ts` (the
 * registry's `help` command calls it), so every function takes the
 * registry as a `HelpSource`.
 *
 * All output is plain ASCII (arguments, summaries and examples in the
 * registry are ASCII by contract) and ends with a newline.
 */

import type {
  ArgSpec,
  CommandExample,
  CommandGroup,
  CommandOutput,
  CommandSpec,
  ExclusiveGroup,
  ExitCodeSpec,
} from '../cli/types.js';

/** The last line of the overview, exactly. */
export const AGENTS_LINE = "Agents: run 'agentboard help agents' before first use.";

/** The overview heading of each group (without the trailing colon). */
export const GROUP_TITLES: Readonly<Record<CommandGroup, string>> = {
  lifecycle: 'Ticket lifecycle',
  awareness: 'Change awareness',
  planning: 'Planning integration',
  maintenance: 'Maintenance',
  setup: 'Setup',
};

/** What help is rendered from: the registry, its global flags and the version. */
export interface HelpSource {
  /** The commands in registry order (normally `COMMANDS`). */
  readonly commands: readonly CommandSpec[];
  /** The flags every command accepts (normally `GLOBAL_FLAGS`: `--json`, `--as`). */
  readonly globalFlags: readonly ArgSpec[];
  /** The running version (normally `VERSION`). */
  readonly version: string;
}

/**
 * The `--json` form of one command's help: the registry entry's data
 * fields (everything but `run` and `stream`), plus the rendered `synopsis`,
 * the global flags and whether the command needs an actor. Every field is
 * always present; `tracksCursor` is normalized to a boolean.
 */
export interface CommandHelpDocument {
  readonly name: string;
  readonly group: CommandGroup;
  readonly summary: string;
  readonly description: string;
  /** `synopsis(command)`, without the `Usage: ` prefix. */
  readonly synopsis: string;
  readonly positionals: readonly ArgSpec[];
  /** The command's own flags, as in the registry (global flags excluded). */
  readonly flags: readonly ArgSpec[];
  /** `HelpSource.globalFlags`, as given. */
  readonly globalFlags: readonly ArgSpec[];
  readonly exclusive: readonly ExclusiveGroup[];
  readonly writes: boolean;
  readonly tracksCursor: boolean;
  /** `writes || tracksCursor`: `--as` or `AGENTBOARD_ACTOR` is required. */
  readonly needsActor: boolean;
  readonly operation: string | null;
  readonly examples: readonly CommandExample[];
  readonly exitCodes: readonly ExitCodeSpec[];
}

/**
 * The synopsis of `command`, for example
 * `agentboard handoff <id> --to <to> --status <status> --note <note> [--allow-secret-like] --as <actor> [--json]`.
 *
 * `agentboard <name>`, then, separated by single spaces:
 * 1. each positional: `<name>` when required, `[<name>]` when optional;
 * 2. each own flag not in an exclusive group, in registry order: a
 *    boolean flag is `--name`, any other `--name <name>`; wrapped in
 *    `[...]` when optional, and followed by `...` when repeatable (e.g.
 *    `[--label <label>]...`);
 * 3. each exclusive group: its alternatives, each written as its flags in
 *    the form above joined by spaces, joined by ` | `, in `(...)` when the
 *    group is required and `[...]` when it is not (e.g.
 *    `(--task <task> | --change <change> --group <group> | --adhoc <adhoc>)`);
 * 4. `--as <actor>` when the command writes or tracks a cursor;
 * 5. `[--json]`.
 * Pure.
 */
export function synopsis(command: CommandSpec): string {
  void command;
  throw new Error('not implemented');
}

/**
 * The help of one command, as printed by `agentboard help <command>` and
 * `agentboard <command> --help`. Lines, in order (sections separated by one
 * empty line; a section with nothing in it is left out entirely):
 *
 * 1. `Usage: ` + `synopsis(command)`.
 * 2. The `summary`.
 * 3. The `description`, word-wrapped at 78 columns.
 * 4. `Arguments:` then one line per positional (left out when none).
 * 5. `Flags:` then one line per own flag (left out when none), followed
 *    by one line per exclusive group: `Exactly one of: ` (required group)
 *    or `At most one of: ` (optional group) and its alternatives, each
 *    alternative's flags as `--a with --b`, joined by ` | ` (e.g.
 *    `Exactly one of: --task | --change with --group | --adhoc`).
 * 6. `Global flags:` then one line per global flag.
 * 7. `Exit codes:` then one line per `exitCodes` entry, in order:
 *    `  <code> <reason>  <meaning>`, or `  <code>  <meaning>` without a
 *    reason (padding after the code and reason may be wider, to align the
 *    meanings).
 * 8. `Examples:` then, per example, `  <command>` and, on the next line,
 *    `    <summary>`.
 *
 * An argument line is two spaces, the argument's form, at least two
 * spaces, `<type>, required` or `<type>, optional` (plus `, repeatable`
 * for a repeatable flag), at least two spaces, and its summary. The form is
 * `<name>` for a positional, `--name` for a boolean flag and
 * `--name <name>` for any other flag, except `--as <actor>`. The `--as`
 * line reads `string, required (or set AGENTBOARD_ACTOR)` for a command
 * that writes or tracks a cursor, and `string, optional` with the summary
 * `Accepted and ignored by this command` for any other.
 *
 * Every line has no trailing spaces; the text ends with one newline. Pure.
 */
export function renderCommandHelp(source: HelpSource, command: CommandSpec): string {
  void source;
  void command;
  throw new Error('not implemented');
}

/** The `--json` document of one command's help (see `CommandHelpDocument`). Pure. */
export function commandHelpDocument(source: HelpSource, command: CommandSpec): CommandHelpDocument {
  void source;
  void command;
  throw new Error('not implemented');
}

/**
 * The top-level overview, printed by `agentboard`, `agentboard help`,
 * `agentboard --help` and `agentboard -h`. Lines, in order:
 *
 * 1. `agentboard <version>: a local, offline ticket board for coding agents working on one project`
 * 2. empty
 * 3. `Usage: agentboard <command> [arguments] [--as <actor>] [--json]`
 * 4. empty
 * 5. For each group of `COMMAND_GROUPS` that has at least one command, in
 *    that order: `<GROUP_TITLES[group]>:`, then one line per command of the
 *    group in registry order, `  <name>` padded with spaces to a common
 *    column (at least two spaces after the longest name) followed by its
 *    summary; then an empty line.
 * 6. `Run 'agentboard help <command>' or 'agentboard <command> --help' for its arguments, exit codes and examples.`
 * 7. `AGENTS_LINE`, the last line.
 *
 * Every line has no trailing spaces; the text ends with one newline. Pure.
 */
export function renderOverview(source: HelpSource): string {
  void source;
  throw new Error('not implemented');
}

/**
 * The `--json` document of the overview: `commandHelpDocument` of every
 * command, in registry order. Pure.
 */
export function overviewDocument(source: HelpSource): CommandHelpDocument[] {
  void source;
  throw new Error('not implemented');
}

/**
 * The output of the `help` command for the topic words `topic` (its
 * positionals, absent ones left out):
 * - `[]`: the overview (`json`: `overviewDocument`, `text`:
 *   `renderOverview`).
 * - words that, joined by single spaces, are exactly a command name
 *   (`['claim']`, `['checklist', 'tick']`): that command's help (`json`:
 *   `commandHelpDocument`, `text`: `renderCommandHelp`).
 * - anything else: throws `BoardError(1, 'usage',
 *   unknownCommandMessage(topic, source.commands))`, so `help clam`
 *   suggests `claim` and points to `agentboard help`.
 *
 * Topics that are not commands (`help agents`) are reserved for the agent
 * guide (task group 2 of add-agent-guidance). Pure; needs no board and no
 * actor.
 */
export function helpOutput(source: HelpSource, topic: readonly string[]): CommandOutput {
  void source;
  void topic;
  throw new Error('not implemented');
}
