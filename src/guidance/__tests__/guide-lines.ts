/**
 * Test helpers shared by the guide drift guards (guide.test.ts,
 * summary.test.ts and the MCP guide tests): find the command lines of a
 * guidance text and parse them with the real parser, and name the MCP
 * tools it mentions.
 */

import { parseArgs } from '../../cli/parse.js';
import { COMMANDS } from '../../cli/registry.js';
import { toolDefinitions } from '../../mcp/tools.js';
import { splitCommandLine } from './command-line.js';

/** Printable ASCII only (no tabs), no trailing space. */
export const ASCII_LINE = /^(?:[\x20-\x7e]*[\x21-\x7e])?$/;

/** A command line of a guidance text, parsed. */
export interface Parsed {
  line: string;
  command: string;
  values: Record<string, unknown>;
}

/** Every line whose text, ignoring leading spaces, begins with `agentboard `. */
export function commandLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trimStart())
    .filter((line) => line.startsWith('agentboard '));
}

/** A command line parsed with the real parser; throws the parser's error. */
export function parseLine(line: string): Parsed {
  const words = splitCommandLine(line);
  const parsed = parseArgs(words.slice(1));
  return { line, command: parsed.command.name, values: { ...parsed.values } };
}

/** Every command line of `text`, parsed; throws on the first that does not parse. */
export function parsedLines(text: string): Parsed[] {
  return commandLines(text).map(parseLine);
}

/**
 * The parsed command lines of `text` whose command writes or tracks a
 * per-actor cursor but that do not pass `--as` (the actor rule, taught by
 * example): empty when every such line passes it.
 */
export function linesMissingActor(text: string): string[] {
  return parsedLines(text)
    .filter((p) => {
      const command = COMMANDS.find((c) => c.name === p.command);
      return (
        command !== undefined &&
        (command.writes || command.tracksCursor === true) &&
        typeof p.values.as !== 'string'
      );
    })
    .map((p) => p.line);
}

/** Every `board_...` name in `text`, in order of appearance, with repeats. */
export function toolNames(text: string): string[] {
  return [...text.matchAll(/\bboard_[a-z_]+/g)].map((m) => m[0]);
}

/** The `board_...` names in `text` that the MCP server does not serve. */
export function unservedTools(text: string): string[] {
  const served = new Set(toolDefinitions().map((t) => t.name));
  return toolNames(text).filter((name) => !served.has(name));
}
