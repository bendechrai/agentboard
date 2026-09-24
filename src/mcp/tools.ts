/**
 * MCP tool definitions generated from the command registry (board-cli: "MCP
 * server"; design.md: "Library first, CLI second", "MCP server"). Nothing
 * about a tool is written by hand: its name, description and input schema
 * are computed from the `CommandSpec`, and its arguments are validated by
 * the same rules as the CLI parser (`parseArgs`), so the CLI and the MCP
 * surface cannot drift.
 *
 * Decisions of task group 9 recorded here:
 * - Exclusive flag groups (`ExclusiveGroup`) are NOT expressed as `oneOf`,
 *   `anyOf` or `allOf`: several MCP clients and model APIs refuse top-level
 *   combinators in a tool input schema. They are stated in the tool
 *   description (see `toolDescription`) and enforced at call time by
 *   `toolArguments`, with the CLI's own reasons and messages.
 * - Every tool has an optional `as` property, as every CLI command accepts
 *   `--as`; it is never in `required`, because the server falls back to its
 *   own `AGENTBOARD_ACTOR`.
 * - `--json` is implied and is not a property.
 *
 * Tool order is registry order, so `tools/list` is stable.
 */

import { parseArgs } from '../cli/parse.js';
import { ACTOR_FLAG, COMMANDS } from '../cli/registry.js';
import { asciiText } from '../cli/render.js';
import type { ArgSpec, ArgValues, CommandSpec } from '../cli/types.js';
import { BoardError } from '../store/errors.js';

/** Prefix of every tool name. */
export const TOOL_PREFIX = 'board_';

/**
 * The commands that are not exposed as tools (board-cli: "MCP server"):
 * setup, streaming or maintenance commands run by a human or an
 * orchestrator in a shell, `help` (tools/list already describes every
 * tool; board-agent-guidance ruling 0412c1c), and `agents install` and
 * `agents check`, which write or read host project files in the caller's
 * working tree (board-agent-guidance: "Help is not an MCP tool").
 */
export const EXCLUDED_COMMANDS: readonly string[] = [
  'init',
  'watch',
  'rebuild',
  'sync',
  'mcp',
  'version',
  'help',
  'agents install',
  'agents check',
];

/** JSON Schema of one tool input property. */
export interface ToolProperty {
  /**
   * `string`, `integer` or `boolean` from `ArgSpec.type`; `array` for a
   * repeatable flag.
   */
  readonly type: 'string' | 'integer' | 'boolean' | 'array';
  /** Only for `array`: the items are strings. */
  readonly items?: { readonly type: 'string' };
  /** The `ArgSpec.summary`. */
  readonly description: string;
}

/** JSON Schema of a tool's input, as published in `tools/list`. */
export interface ToolInputSchema {
  readonly type: 'object';
  /**
   * One property per positional (in order), then per flag of the command
   * (in order), then `as` (with `ACTOR_FLAG.summary` as description). Keys
   * are the kebab-case `ArgSpec.name`s (`decision-recorded-in`,
   * `allow-secret-like`). No `json` property.
   */
  readonly properties: Readonly<Record<string, ToolProperty>>;
  /**
   * The names of the required positionals (in order) followed by the
   * required flags (in order), exactly the arguments `parseArgs` refuses to
   * run without. Members of an exclusive group are never listed (a group
   * is not a single required property); `as` is never listed. Always
   * present, possibly empty.
   */
  readonly required: readonly string[];
  /** Always false: an unknown property is a usage error. */
  readonly additionalProperties: false;
}

/** One MCP tool. */
export interface ToolDefinition {
  /** `toolName(command.name)`. */
  readonly name: string;
  /** `toolDescription(command)`. */
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
  /**
   * MCP tool annotations. `readOnlyHint` is true exactly for a command that
   * neither writes an event nor tracks a per-actor cursor (so `board_show`
   * and `board_list` are read-only, and `board_inbox`, which advances a
   * cursor, is not).
   */
  readonly annotations: { readonly readOnlyHint: boolean };
  /** The registry entry the tool runs. */
  readonly command: CommandSpec;
}

/**
 * The tool name of a command: `board_` followed by the command name with
 * every space and hyphen replaced by an underscore (`claim` is
 * `board_claim`, `checklist tick` is `board_checklist_tick`,
 * `import-change` is `board_import_change`). Pure.
 */
export function toolName(commandName: string): string {
  return `${TOOL_PREFIX}${commandName.replace(/[ -]/g, '_')}`;
}

/**
 * The description of a command's tool: `command.summary`, then, for each
 * exclusive group in order, one sentence, each preceded by `. ` (a period
 * and a space):
 * - a required group: `Give exactly one of: <alternatives>.`
 * - an optional group: `Give at most one of: <alternatives>.`
 * where `<alternatives>` lists each alternative's property names joined
 * with ` with `, alternatives joined with ` | `. For example `new` is
 * `Create a ticket. Give exactly one of: task | change with group | adhoc.`
 * and `claim` is just `Assign an unassigned ticket to yourself`. Plain
 * ASCII. Pure.
 */
export function toolDescription(command: CommandSpec): string {
  const sentences = command.exclusive.map(
    (group) =>
      `Give ${group.required ? 'exactly' : 'at most'} one of: ${group.alternatives
        .map((alt) => alt.join(' with '))
        .join(' | ')}.`,
  );
  return [command.summary, ...sentences].join('. ');
}

/** The input schema of a command's tool (see `ToolInputSchema`). Pure. */
export function toolInputSchema(command: CommandSpec): ToolInputSchema {
  const properties: Record<string, ToolProperty> = {};
  const args = [...command.positionals, ...command.flags];
  for (const arg of args) {
    properties[arg.name] = toolProperty(arg);
  }
  properties[ACTOR_FLAG.name] = toolProperty(ACTOR_FLAG);
  const grouped = new Set(command.exclusive.flatMap((group) => group.alternatives.flat()));
  return {
    type: 'object',
    properties,
    required: args.filter((arg) => arg.required && !grouped.has(arg.name)).map((arg) => arg.name),
    additionalProperties: false,
  };
}

/** The JSON Schema property of one argument. */
function toolProperty(arg: ArgSpec): ToolProperty {
  return arg.repeatable
    ? { type: 'array', items: { type: 'string' }, description: arg.summary }
    : { type: arg.type, description: arg.summary };
}

/** The tool of one command (whether or not it is excluded). Pure. */
export function toolDefinition(command: CommandSpec): ToolDefinition {
  return {
    name: toolName(command.name),
    description: toolDescription(command),
    inputSchema: toolInputSchema(command),
    annotations: { readOnlyHint: !command.writes && command.tracksCursor !== true },
    command,
  };
}

/**
 * The tools of `commands` (default `COMMANDS`): one per command whose name
 * is not in `EXCLUDED_COMMANDS`, in registry order. Pure.
 */
export function toolDefinitions(commands: readonly CommandSpec[] = COMMANDS): ToolDefinition[] {
  return commands.filter((c) => !EXCLUDED_COMMANDS.includes(c.name)).map(toolDefinition);
}

/** The tool named exactly `name` among `toolDefinitions(commands)`, or undefined. */
export function findTool(
  name: string,
  commands: readonly CommandSpec[] = COMMANDS,
): ToolDefinition | undefined {
  return toolDefinitions(commands).find((tool) => tool.name === name);
}

/**
 * Validates the `arguments` of a `tools/call` for `command` and returns
 * the same `ArgValues` that `parseArgs` returns for the equivalent command
 * line, so `command.run` sees identical input from both surfaces.
 *
 * `args` undefined or null is `{}`. Otherwise it must be a plain JSON
 * object; each key must be one of the schema's properties (a positional, a
 * flag, or `as`), and its value must match the property type:
 * - `string`: a JSON string, taken verbatim (a value starting with `-` or
 *   `--` is still a value, never a flag);
 * - `integer`: a JSON number that is a safe integer (a numeric string is
 *   refused);
 * - `boolean`: `true` sets the flag; `false` is the same as absent;
 * - `array` (repeatable): an array of strings, kept in order; an empty
 *   array is the same as absent.
 * Then exactly the checks of `parseArgs` apply, with its reasons and
 * messages: a missing required positional or flag, and each exclusive
 * group (a missing required group throws the group's own reason and
 * message, for example `needs-task-or-adhoc` with `TASK_RULE` for `new`
 * and `no-disposition` with `CLOSE_RULE` for `close`; two alternatives, or
 * an alternative given only partly, are `usage`). One way to guarantee
 * this is to build the equivalent argv (flags as `--name value`, then
 * `--`, then the positionals) and call `parseArgs`.
 *
 * `as`, when given as a non-empty string, is in the result as `as` (as
 * `parseArgs` puts `--as` there); actor resolution is not done here.
 *
 * @throws BoardError exit 1: reason `usage` naming the property for a
 *   non-object `args`, an unknown property (including `json`), a value of
 *   the wrong type, or a missing required argument; or the reason of a
 *   missing required exclusive group.
 */
export function toolArguments(command: CommandSpec, args: unknown): ArgValues {
  const given = argumentObject(args);
  const specs = new Map<string, ArgSpec>();
  for (const arg of [...command.positionals, ...command.flags, ACTOR_FLAG]) {
    specs.set(arg.name, arg);
  }
  const values = new Map<string, string | number | true | readonly string[]>();
  for (const [key, value] of Object.entries(given)) {
    const spec = specs.get(key);
    if (spec === undefined) {
      throw usage(`unknown argument ${asciiText(key)} for ${toolName(command.name)}`);
    }
    const checked = argumentValue(spec, value);
    if (checked !== null) {
      values.set(key, checked);
    }
  }
  const empty = values.get(ACTOR_FLAG.name);
  if (empty === '') {
    values.delete(ACTOR_FLAG.name);
  }

  const argv: string[] = [...command.name.split(' ')];
  for (const spec of [...command.flags, ACTOR_FLAG]) {
    const value = values.get(spec.name);
    if (value === undefined) {
      continue;
    }
    if (value === true) {
      argv.push(`--${spec.name}`);
    } else if (Array.isArray(value)) {
      for (const item of value as readonly string[]) {
        argv.push(`--${spec.name}`, item);
      }
    } else {
      argv.push(`--${spec.name}`, String(value));
    }
  }
  // Positionals are positional: one that is absent ends the list, and
  // (as on a command line) no later one can be given without it.
  argv.push('--');
  const present = command.positionals.filter((spec) => values.has(spec.name));
  command.positionals.forEach((spec, index) => {
    const value = values.get(spec.name);
    if (value !== undefined) {
      argv.push(String(value));
    } else if (spec.required || present.some((p) => command.positionals.indexOf(p) > index)) {
      throw usage(`${command.name} needs the argument <${spec.name}>`);
    }
  });
  return parseArgs(argv, [command]).values;
}

/** `args` as a plain object (`{}` for undefined or null), else a usage error. */
function argumentObject(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) {
    return {};
  }
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw usage('tool arguments must be a JSON object');
  }
  const proto: unknown = Object.getPrototypeOf(args);
  if (proto !== Object.prototype && proto !== null) {
    throw usage('tool arguments must be a JSON object');
  }
  return args as Record<string, unknown>;
}

/**
 * One argument checked against its spec: the value to pass on, or null
 * when it is the same as absent (`false`, an empty array).
 */
function argumentValue(
  spec: ArgSpec,
  value: unknown,
): string | number | true | readonly string[] | null {
  const name = spec.name;
  if (spec.repeatable) {
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
      throw usage(`${name} must be an array of strings`);
    }
    return value.length === 0 ? null : (value as string[]);
  }
  switch (spec.type) {
    case 'string':
      if (typeof value !== 'string') {
        throw usage(`${name} must be a string`);
      }
      return value;
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw usage(`${name} must be an integer`);
      }
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw usage(`${name} must be a boolean`);
      }
      return value ? true : null;
  }
}

function usage(message: string): BoardError {
  return new BoardError(1, 'usage', message);
}
