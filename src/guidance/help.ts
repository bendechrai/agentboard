/**
 * Help rendered from the command registry (board-agent-guidance: "Generated
 * help"; add-agent-guidance design.md: "Help is rendered from the
 * registry"). No command has hand-written help: everything below is built
 * from `CommandSpec` fields, so a flag cannot be added without appearing in
 * help.
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
import { asciiText } from '../board/text.js';
import { COMMAND_GROUPS } from '../cli/types.js';
import { BoardError } from '../store/errors.js';
import { agentsHelpOutput } from './guide.js';
import { unknownCommandMessage } from './suggest.js';

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
  /** `command.actorHelp`, or null when absent. */
  readonly actorHelp: string | null;
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
 * 4. `--as <actor>` when the command writes or tracks a cursor; otherwise
 *    `[--as <actor>]` when the command has `actorHelp` (`serve`, where
 *    `--as` enables the write actions, and `mcp`: board-cli "Command
 *    surface" scenario "Serve has help"); nothing on every other command;
 * 5. `[--json]`.
 * Pure.
 */
export function synopsis(command: CommandSpec): string {
  const parts = ['agentboard', command.name];
  for (const arg of command.positionals) {
    parts.push(arg.required ? `<${arg.name}>` : `[<${arg.name}>]`);
  }
  const grouped = new Set(command.exclusive.flatMap((group) => group.alternatives.flat()));
  for (const flag of command.flags) {
    if (grouped.has(flag.name)) {
      continue;
    }
    const text = flagForm(flag);
    parts.push(`${flag.required ? text : `[${text}]`}${flag.repeatable ? '...' : ''}`);
  }
  for (const group of command.exclusive) {
    const alternatives = group.alternatives
      .map((alternative) => alternative.map((name) => flagForm(flagNamed(command, name))).join(' '))
      .join(' | ');
    parts.push(group.required ? `(${alternatives})` : `[${alternatives}]`);
  }
  if (needsActor(command)) {
    parts.push('--as <actor>');
  } else if (command.actorHelp !== undefined) {
    parts.push('[--as <actor>]');
  }
  parts.push('[--json]');
  return parts.join(' ');
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
 * that writes or tracks a cursor; for any other it reads `string, optional`
 * with the summary `command.actorHelp` when present (`serve`: the actor of
 * the web app's write actions; `mcp`: the server's default actor for tool
 * calls), else `Accepted and ignored by this command`.
 *
 * Every line has no trailing spaces; the text ends with one newline. Pure.
 */
export function renderCommandHelp(source: HelpSource, command: CommandSpec): string {
  const actor = needsActor(command);
  const sections: string[][] = [
    [`Usage: ${synopsis(command)}`],
    [command.summary],
    wrap(command.description, WRAP_COLUMNS),
  ];
  if (command.positionals.length > 0) {
    sections.push([
      'Arguments:',
      ...argumentLines(
        command.positionals.map((arg) => [`<${arg.name}>`, typeText(arg), arg.summary]),
      ),
    ]);
  }
  if (command.flags.length > 0) {
    sections.push([
      'Flags:',
      ...argumentLines(command.flags.map((flag) => [flagForm(flag), typeText(flag), flag.summary])),
      ...command.exclusive.map(
        (group) =>
          `${group.required ? 'Exactly one of: ' : 'At most one of: '}${group.alternatives
            .map((alternative) => alternative.map((name) => `--${name}`).join(' with '))
            .join(' | ')}`,
      ),
    ]);
  }
  sections.push([
    'Global flags:',
    ...argumentLines(
      source.globalFlags.map((flag) => {
        if (flag.name !== ACTOR) {
          return [flagForm(flag), typeText(flag), flag.summary];
        }
        return actor
          ? [
              ACTOR_FORM,
              `${typeText({ ...flag, required: true })} (or set AGENTBOARD_ACTOR)`,
              flag.summary,
            ]
          : [
              ACTOR_FORM,
              typeText({ ...flag, required: false }),
              command.actorHelp ?? 'Accepted and ignored by this command',
            ];
      }),
    ),
  ]);
  sections.push([
    'Exit codes:',
    ...columns(
      command.exitCodes.map((exit) => [
        exit.reason === undefined ? String(exit.code) : `${String(exit.code)} ${exit.reason}`,
        exit.meaning,
      ]),
    ),
  ]);
  sections.push([
    'Examples:',
    ...command.examples.flatMap((example) => [`  ${example.command}`, `    ${example.summary}`]),
  ]);
  return `${sections.map((lines) => lines.map((line) => line.trimEnd()).join('\n')).join('\n\n')}\n`;
}

/** The `--json` document of one command's help (see `CommandHelpDocument`). Pure. */
export function commandHelpDocument(source: HelpSource, command: CommandSpec): CommandHelpDocument {
  return {
    name: command.name,
    group: command.group,
    summary: command.summary,
    description: command.description,
    synopsis: synopsis(command),
    positionals: command.positionals,
    flags: command.flags,
    globalFlags: source.globalFlags,
    exclusive: command.exclusive,
    writes: command.writes,
    tracksCursor: command.tracksCursor === true,
    needsActor: needsActor(command),
    actorHelp: command.actorHelp ?? null,
    operation: command.operation,
    examples: command.examples,
    exitCodes: command.exitCodes,
  };
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
  const width = Math.max(0, ...source.commands.map((command) => command.name.length)) + 2;
  const lines = [
    `agentboard ${source.version}: a local, offline ticket board for coding agents working on one project`,
    '',
    'Usage: agentboard <command> [arguments] [--as <actor>] [--json]',
    '',
  ];
  for (const group of COMMAND_GROUPS) {
    const commands = source.commands.filter((command) => command.group === group);
    if (commands.length === 0) {
      continue;
    }
    lines.push(`${GROUP_TITLES[group]}:`);
    for (const command of commands) {
      lines.push(`  ${command.name.padEnd(width)}${command.summary}`.trimEnd());
    }
    lines.push('');
  }
  lines.push(
    "Run 'agentboard help <command>' or 'agentboard <command> --help' for its arguments, exit codes and examples.",
    AGENTS_LINE,
  );
  return `${lines.join('\n')}\n`;
}

/**
 * The `--json` document of the overview: `commandHelpDocument` of every
 * command, in registry order. Pure.
 */
export function overviewDocument(source: HelpSource): CommandHelpDocument[] {
  return source.commands.map((command) => commandHelpDocument(source, command));
}

/**
 * The output of the `help` command for the topic words `topic` (its
 * positionals, absent ones left out):
 * - `[]`: the overview (`json`: `overviewDocument`, `text`:
 *   `renderOverview`).
 * - words that, joined by single spaces, are exactly a command name
 *   (`['claim']`, `['checklist', 'tick']`): that command's help (`json`:
 *   `commandHelpDocument`, `text`: `renderCommandHelp`).
 * - two words whose first alone is a command name (`['claim', 'extra']`):
 *   throws `BoardError(1, 'usage')` with exactly
 *   `<command> has no help subtopic <word>; run 'agentboard help <command>'`
 *   (`<word>` passed through `asciiText`).
 * - anything else: throws `BoardError(1, 'usage',
 *   unknownCommandMessage(topic, source.commands))`, so `help clam`
 *   suggests `claim` and points to `agentboard help`.
 *
 * - exactly `['agents']`: the agent guide,
 *   `agentsHelpOutput(source.version, role)` from `src/guidance/guide.ts`,
 *   which also handles an unknown role. This is checked before any
 *   command lookup, so it holds even when the registry has commands whose
 *   first word is `agents` (`agents install` and `agents check`):
 *   `help agents` is always the
 *   guide, while `help agents install` is that command's help like any
 *   other two-word command. No command may be named `agents` alone.
 *
 * `role` is the `--role` value of the `help` command. Given with any topic
 * other than exactly `['agents']` (including no topic), it throws
 * `BoardError(1, 'usage')` saying that `--role` applies only to
 * `agentboard help agents`, before anything else is checked.
 *
 * Pure; needs no board and no actor.
 */
export function helpOutput(
  source: HelpSource,
  topic: readonly string[],
  role?: string,
): CommandOutput {
  if (topic.length === 1 && topic[0] === AGENTS_TOPIC) {
    return agentsHelpOutput(source.version, role);
  }
  if (role !== undefined) {
    throw new BoardError(
      1,
      'usage',
      `--role applies only to 'agentboard ${HELP_AGENTS}'; run 'agentboard ${HELP_AGENTS} --role <role>'`,
    );
  }
  if (topic.length === 0) {
    return { json: overviewDocument(source), text: renderOverview(source) };
  }
  const name = topic.join(' ');
  const command = source.commands.find((candidate) => candidate.name === name);
  const [first = '', word = ''] = topic;
  if (
    command === undefined &&
    topic.length === 2 &&
    source.commands.some((candidate) => candidate.name === first)
  ) {
    throw new BoardError(
      1,
      'usage',
      `${first} has no help subtopic ${asciiText(word)}; run 'agentboard help ${first}'`,
    );
  }
  if (command === undefined) {
    throw new BoardError(1, 'usage', unknownCommandMessage(topic, source.commands));
  }
  return { json: commandHelpDocument(source, command), text: renderCommandHelp(source, command) };
}

/** The help topic of the agent guide: `agentboard help agents`. */
export const AGENTS_TOPIC = 'agents';

/** The command line words of the agent guide. */
const HELP_AGENTS = `help ${AGENTS_TOPIC}`;

/** The column at which command help wraps the description. */
const WRAP_COLUMNS = 78;

/** The name of the global actor flag, and its form in help. */
const ACTOR = 'as';
const ACTOR_FORM = '--as <actor>';

/** True when `command` requires an actor (`--as` or `AGENTBOARD_ACTOR`). */
function needsActor(command: CommandSpec): boolean {
  return command.writes || command.tracksCursor === true;
}

/** `--name` for a boolean flag, `--as <actor>`, else `--name <name>`. */
function flagForm(flag: ArgSpec): string {
  if (flag.type === 'boolean') {
    return `--${flag.name}`;
  }
  return flag.name === ACTOR ? ACTOR_FORM : `--${flag.name} <${flag.name}>`;
}

/**
 * The flag of `command` named `name`; a name an exclusive group lists but
 * the command does not declare is shown as a boolean flag.
 */
function flagNamed(command: CommandSpec, name: string): ArgSpec {
  return (
    command.flags.find((flag) => flag.name === name) ?? {
      name,
      type: 'boolean',
      required: false,
      repeatable: false,
      summary: '',
    }
  );
}

/** `<type>, required` or `<type>, optional`, plus `, repeatable`. */
function typeText(arg: ArgSpec): string {
  return `${arg.type}, ${arg.required ? 'required' : 'optional'}${arg.repeatable ? ', repeatable' : ''}`;
}

/** Argument lines: form, type and summary, in aligned columns. */
function argumentLines(rows: readonly (readonly [string, string, string])[]): string[] {
  const formWidth = Math.max(...rows.map(([form]) => form.length)) + 2;
  return columns(rows.map(([form, type, summary]) => [form.padEnd(formWidth) + type, summary]));
}

/** Two-column lines, indented by two spaces, the second column aligned. */
function columns(rows: readonly (readonly [string, string])[]): string[] {
  const width = Math.max(...rows.map(([head]) => head.length)) + 2;
  return rows.map(([head, text]) => `  ${head.padEnd(width)}${text}`.trimEnd());
}

/** `text` split at single spaces into lines of at most `limit` columns (a longer word stands alone). */
function wrap(text: string, limit: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line === '') {
      line = word;
    } else if (line.length + 1 + word.length <= limit) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  lines.push(line);
  return lines;
}
