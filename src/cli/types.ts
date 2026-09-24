/**
 * Types of the command registry (design.md: "Library first, CLI second").
 * The registry describes every command once; the CLI parser, the `mcp`
 * tool definitions (task group 9) and generated help (add-agent-guidance)
 * all read it, so a flag added to one surface is added to all of them.
 */

import type { Board } from '../store/board.js';
import type { ExitCode } from '../store/errors.js';

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
   *
   * `options` apply to the first call only (later calls return the handle
   * already opened, whatever they pass). With `catchUp: false` the board is
   * opened with `openBoard(dir, { catchUp: false })`: no event file is
   * folded and no temporary file is reaped, so the live cache is exactly as
   * the previous command left it (`rebuild --check` needs this). The open
   * report is then null, so nothing is printed about reaped or corrupt
   * files. `rebuild` and `rebuild --check` open this way (board-cache:
   * they SHALL NOT catch up before they run). Omitted, or `catchUp: true`,
   * is the default open with catch-up.
   */
  board(options?: BoardOpenOptions): Board;
  /**
   * The absolute board directory found by discovery (`findBoard` with `cwd`
   * and `env`), without opening the board or touching the cache, so a
   * command can inspect the directory first (`rebuild --check` checks
   * whether the cache file exists without creating it). Throws
   * `BoardError(2, 'board-not-found')` when there is no board.
   */
  boardDir(): string;
}

/** Options of `RunContext.board`. */
export interface BoardOpenOptions {
  /** False to open without catch-up (see `RunContext.board`). Default true. */
  readonly catchUp?: boolean;
  /**
   * Passed to `openBoard` as `prepare` (default true): false opens the
   * cache for inspection only, never creating, migrating or writing it,
   * and implies no catch-up (see `OpenBoardOptions.prepare`). Applies to
   * the first call only, like `catchUp`.
   */
  readonly prepare?: boolean;
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
  /**
   * The exit code of a command that ran to completion but whose result is a
   * failure the caller must see, while still printing its full output (the
   * `json` document or `text`) on stdout. Only `rebuild --check` uses it,
   * with 1 when the cache diverges from a fresh rebuild (board-cache:
   * "Rebuild"). Absent means 0. Refusals are still thrown as `BoardError`,
   * never reported here.
   */
  readonly exitCode?: 1;
  /**
   * Diagnostics for stderr, one ASCII line each without a trailing newline;
   * `runCli` prints each as `agentboard: <line>` plus a newline, before the
   * stdout output, in `--json` mode too. Absent or empty prints nothing.
   */
  readonly warnings?: readonly string[];
}

/** What a streaming command (`CommandSpec.stream`) writes to and stops on. */
export interface StreamIo {
  /** Receives stdout text; each call is one or more whole lines. */
  stdout(text: string): void;
  /** True when `--json` was given. */
  readonly json: boolean;
  /**
   * Receives stderr text (whole lines), for warnings while streaming such as
   * a `watch` tick that found the cache busy. `runCliAsync` always provides
   * it, as `io.stderr` of its `CliIo`; optional only so that other callers
   * of `stream` may omit it (warnings are then dropped).
   */
  stderr?(text: string): void;
  /** Aborted when the stream must stop (SIGINT or SIGTERM for the CLI). */
  readonly signal: AbortSignal;
}

/**
 * The overview section a command is listed under (board-agent-guidance:
 * "Generated help"), in overview order:
 * - `lifecycle`: "Ticket lifecycle" (creating, finding and moving tickets);
 * - `awareness`: "Change awareness" (`inbox`, `watch`);
 * - `planning`: "Planning integration" (`import-change`, `close-merged`);
 * - `maintenance`: "Maintenance" (`rebuild`, `sync`);
 * - `setup`: "Setup" (`init`, `mcp`, `version`, `help`).
 */
export type CommandGroup = 'lifecycle' | 'awareness' | 'planning' | 'maintenance' | 'setup';

/** Every `CommandGroup`, in overview order. */
export const COMMAND_GROUPS: readonly CommandGroup[] = [
  'lifecycle',
  'awareness',
  'planning',
  'maintenance',
  'setup',
];

/**
 * One example of a command, shown in its help (board-agent-guidance:
 * "Generated help").
 */
export interface CommandExample {
  /**
   * A complete command line starting with `agentboard ` followed by the
   * command's words, in plain ASCII, whose arguments are separated by
   * single spaces and may be quoted with `"` or `'` (no escapes inside
   * quotes). Split into words it SHALL parse with `parseArgs` to this very
   * command (the drift guard in `src/guidance/__tests__/help.test.ts`), so
   * renaming a flag breaks the build until the example is fixed. Placeholder
   * ids are plausible ULID prefixes such as `01J9K3`.
   */
  readonly command: string;
  /** One ASCII sentence saying what the example does. */
  readonly summary: string;
}

/**
 * One exit code a command can produce, shown in its help.
 *
 * A command lists every code it can produce, in ascending `code` order,
 * starting with `0` (success). Several entries may share a code when they
 * differ by `reason`; an entry without `reason` covers every failure of
 * that code the command can produce (typically 5, integrity or a cache
 * still busy). `reason`, when present, is exactly the `BoardError` reason
 * token the CLI reports in its `--json` error document, so an agent can
 * match on it.
 */
export interface ExitCodeSpec {
  readonly code: ExitCode;
  /** The `BoardError` reason; absent for 0 and for a class-wide entry. */
  readonly reason?: string;
  /** What the code means for this command; one ASCII line. */
  readonly meaning: string;
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
  /**
   * A longer ASCII description for the command's help: one or more
   * sentences on one logical paragraph (no newlines), saying what the
   * command does, what it requires (a board, an actor) and anything an
   * agent must know before running it. Help wraps it for display.
   */
  readonly description: string;
  /** The overview section the command is listed under. */
  readonly group: CommandGroup;
  /** At least one example; every one parses to this command. */
  readonly examples: readonly CommandExample[];
  /** Every exit code the command can produce (see `ExitCodeSpec`). */
  readonly exitCodes: readonly ExitCodeSpec[];
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
   * Name of the library function (exported from `src/index.ts`) the command
   * calls, e.g. `claimTicket`; null for `version`, `mcp` and `help`, which
   * call none. Normally in `src/board/`; `rebuild` names the store's `rebuild`
   * (its `--check` form calls the store's `checkCache`).
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
