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

import { COMMANDS } from '../cli/registry.js';
import type { ArgValues, CommandSpec } from '../cli/types.js';

/** Prefix of every tool name. */
export const TOOL_PREFIX = 'board_';

/**
 * The commands that are not exposed as tools (board-cli: "MCP server"):
 * setup, streaming or maintenance commands run by a human or an
 * orchestrator in a shell.
 */
export const EXCLUDED_COMMANDS: readonly string[] = [
  'init',
  'watch',
  'rebuild',
  'sync',
  'mcp',
  'version',
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
  void commandName;
  throw new Error('not implemented');
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
  void command;
  throw new Error('not implemented');
}

/** The input schema of a command's tool (see `ToolInputSchema`). Pure. */
export function toolInputSchema(command: CommandSpec): ToolInputSchema {
  void command;
  throw new Error('not implemented');
}

/** The tool of one command (whether or not it is excluded). Pure. */
export function toolDefinition(command: CommandSpec): ToolDefinition {
  void command;
  throw new Error('not implemented');
}

/**
 * The tools of `commands` (default `COMMANDS`): one per command whose name
 * is not in `EXCLUDED_COMMANDS`, in registry order. Pure.
 */
export function toolDefinitions(commands: readonly CommandSpec[] = COMMANDS): ToolDefinition[] {
  void commands;
  throw new Error('not implemented');
}

/** The tool named exactly `name` among `toolDefinitions(commands)`, or undefined. */
export function findTool(
  name: string,
  commands: readonly CommandSpec[] = COMMANDS,
): ToolDefinition | undefined {
  void name;
  void commands;
  throw new Error('not implemented');
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
  void command;
  void args;
  throw new Error('not implemented');
}
