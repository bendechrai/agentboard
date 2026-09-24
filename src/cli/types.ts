/**
 * Types of the command registry (design.md: "Library first, CLI second").
 * The registry describes every command once; the CLI parser, the `mcp`
 * tool definitions (task group 9) and generated help (add-agent-guidance)
 * all read it, so a flag added to one surface is added to all of them.
 */

import type { Board } from '../store/board.js';

/** The environment a command runs with; defined in `src/board/text.ts` (layering). */
import type { Env } from '../board/text.js';

export type { Env };

/**
 * Type of an argument value.
 * - `string`: taken verbatim.
 * - `integer`: a decimal integer (`^-?[0-9]+$`, safe integer); parsed to a
 *   number.
 * - `boolean`: a flag without a value (`--closed`); never a positional.
 */
export type ValueType = 'string' | 'integer' | 'boolean';

/** One positional argument or flag of a command. */
export interface ArgSpec {
  /**
   * Kebab-case name, unique among a command's positionals and flags. For a
   * flag it is the long option without dashes (`decision-recorded-in` is
   * `--decision-recorded-in`); it is also the key in `ArgValues` and, in
   * task group 9, the MCP input property name.
   */
  readonly name: string;
  readonly type: ValueType;
  /** True when the command cannot run without it. */
  readonly required: boolean;
  /**
   * Flags only: may be given several times; the value is then an array of
   * strings in the given order. Always false for positionals.
   */
  readonly repeatable: boolean;
  /** One-line ASCII description. */
  readonly summary: string;
}

/**
 * Mutually exclusive flag alternatives, such as `--task` | `--change`
 * with `--group` | `--adhoc`. Each alternative is a set of flag names that
 * are given together.
 *
 * Parsing rules: flags from two or more alternatives is `BoardError(1,
 * 'usage')`; an alternative given only partly (`--change` without
 * `--group`) is `BoardError(1, 'usage')` naming the missing flag; when
 * `required` and no alternative is given, `BoardError(1, reason,
 * message)` with this group's `reason` and `message`.
 */
export interface ExclusiveGroup {
  readonly alternatives: readonly (readonly string[])[];
  readonly required: boolean;
  /** Reason token when a required group is missing (e.g. `no-disposition`). */
  readonly reason: string;
  /** Message when a required group is missing; plain ASCII. */
  readonly message: string;
}

/** Parsed values keyed by `ArgSpec.name`; absent arguments are absent keys. */
export type ArgValue = string | number | boolean | readonly string[];
export type ArgValues = Readonly<Partial<Record<string, ArgValue>>>;

/** What a command needs from its surroundings. */
export interface RunContext {
  /** Directory the command runs in; discovery and relative paths use it. */
  readonly cwd: string;
  readonly env: Env;
  /**
   * The resolved actor (`resolveActor`) for a writing command or a command
   * that tracks a per-actor cursor (`CommandSpec.tracksCursor`); null for
   * any other command.
   */
  readonly actor: string | null;
  /**
   * The board, found by discovery (`findBoard` with `cwd` and `env`) and
   * opened (`openBoard`) on first call; later calls return the same handle.
   * The caller of `run` closes it. Throws `BoardError(2,
   * 'board-not-found')` when there is no board.
   */
  board(): Board;
}

/** What a command produced. */
export interface CommandOutput {
  /**
   * The `--json` document: exactly what is printed with `JSON.stringify` on
   * stdout. For writing commands an object with `hash` and `ticket`; for
   * `list` an array; for `show` a `ShowResult`.
   */
  readonly json: unknown;
  /**
   * The human output: plain ASCII (see `asciiText`), either empty or ending
   * with a newline.
   */
  readonly text: string;
}

/** What a streaming command (`CommandSpec.stream`) writes to and stops on. */
export interface StreamIo {
  /** Receives stdout text; each call is one or more whole lines. */
  stdout(text: string): void;
  /** True when `--json` was given. */
  readonly json: boolean;
  /** Aborted when the stream must stop (SIGINT or SIGTERM for the CLI). */
  readonly signal: AbortSignal;
}

/** One command of the registry. */
export interface CommandSpec {
  /**
   * The command words separated by single spaces, e.g. `claim` or
   * `checklist tick`. The MCP tool name (task group 9) is derived from it.
   */
  readonly name: string;
  /** One-line ASCII summary. */
  readonly summary: string;
  /** Positional arguments in order. */
  readonly positionals: readonly ArgSpec[];
  /**
   * The command's own flags. The global flags `--json` and `--as`
   * (`GLOBAL_FLAGS`) are accepted by every command and not repeated here.
   */
  readonly flags: readonly ArgSpec[];
  /** Mutually exclusive flag sets; empty when none. */
  readonly exclusive: readonly ExclusiveGroup[];
  /**
   * True when the command writes an event, so it requires an actor
   * (`--as` or `AGENTBOARD_ACTOR`). Every command accepts `--as`.
   */
  readonly writes: boolean;
  /**
   * True for the commands that track a per-actor cursor (`inbox`,
   * `watch`): they write no event but require an actor exactly as a
   * writing command does (`--as` or `AGENTBOARD_ACTOR`, else exit 1
   * `missing-actor` before any board lookup), and receive it as
   * `RunContext.actor`. Absent (false) for every other command.
   */
  readonly tracksCursor?: boolean;
  /**
   * Name of the library function in `src/board/` (exported from
   * `src/index.ts`) the command calls, e.g. `claimTicket`; null for
   * `version` and `mcp`, which call none.
   */
  readonly operation: string | null;
  /**
   * Runs the command with validated values (after `parseArgs`). Throws
   * `BoardError` on failure.
   */
  run(ctx: RunContext, values: ArgValues): CommandOutput;
  /**
   * Present only for a streaming command (`watch`), which cannot answer
   * with one `CommandOutput`: runs until `io.signal` aborts, writing lines
   * to `io.stdout` as they come, and resolves when it has stopped; rejects
   * with a `BoardError` on failure. `runCliAsync` calls it instead of
   * `run`; the `run` of a streaming command, reachable only through the
   * synchronous `runCli`, throws `BoardError(1, 'streaming-command')`.
   */
  stream?(ctx: RunContext, values: ArgValues, io: StreamIo): Promise<void>;
}
