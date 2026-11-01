/**
 * The CLI driver: parse, resolve the actor, run, render, map exit codes
 * (board-cli: "Output conventions", "Exit codes", "Actor is explicit").
 * `src/cli.ts` calls `runCli` with the real process; tests call it in
 * process with captured streams.
 */

import { ImportRefusedError, type ImportResult } from '../board/import.js';
import { MoveSyncFailure } from '../board/into-host.js';
import { openBoard, type Board } from '../store/board.js';
import { BoardError, type ExitCode } from '../store/errors.js';
import type { WriteHooks } from '../store/eventfile.js';
import { pauseHooks } from '../store/transaction.js';
import { findBoard } from '../store/locate.js';
import { closeDecisionOf, hintFor, type HintContext } from '../guidance/hints.js';
import {
  ACTOR_ENV,
  parseArgs,
  checkActorName,
  refuseReservedActor,
  resolveActor,
  type ActorSource,
  type ParsedCommand,
} from './parse.js';
import { COMMANDS, findCommand } from './registry.js';
import type { TerminalIo } from '../tui/terminal.js';
import type { PromptTerminal } from './prompt.js';
import type { BoardOpenOptions, CommandSpec, Env, RunContext } from './types.js';

/** The process surroundings `runCli` uses; nothing else is read or written. */
export interface CliIo {
  /** Arguments after the program name. */
  argv: readonly string[];
  cwd: string;
  env: Env;
  /** Receives stdout text (possibly several calls). */
  stdout(text: string): void;
  /** Receives stderr text (possibly several calls). */
  stderr(text: string): void;
}

/** `CliIo` for `runCliAsync`, which can also run streaming commands. */
export interface AsyncCliIo extends CliIo {
  /**
   * Called once, only when a streaming command is about to start
   * streaming (after parsing, actor resolution and nothing else), and
   * returns the signal that stops it. `src/cli.ts` installs its SIGINT and
   * SIGTERM handlers here, so every other command keeps Node's default
   * signal behaviour.
   */
  stopSignal(): AbortSignal;
  /**
   * Returns the interactive terminal (`processTerminal()` for
   * `src/cli.ts`). Called at most once, only for a command whose spec has
   * `terminal` true (`top`), after parsing and before `stopSignal`; its
   * result is passed as `StreamIo.terminal`. When absent, such a command
   * gets no terminal (and `top` refuses with `not-a-tty`). Never called
   * for any other command, so `watch`, `serve` and the rest never touch
   * the terminal.
   */
  terminal?(): Promise<TerminalIo>;
  /**
   * Returns the terminal a question is asked on (`processPromptTerminal()`
   * for `src/cli.ts`, whose creation reads nothing). Called at most once,
   * only for a command with `CommandSpec.prompting` (`init`, `agents
   * install`), after parsing and the actor checks, and then that command
   * runs through `prompting` with it. When absent, such a command runs
   * through `run`, exactly as in `runCli`, and asks nothing.
   */
  promptTerminal?(): PromptTerminal;
}

/**
 * The `--json` document printed on stdout when a command fails, and (as
 * `error`) the structured content of a failed MCP tool call.
 *
 * The CLI's `--json` error document carries the `hint` too, so an agent
 * reading JSON gets the same advice as one reading stderr, and the MCP error content stays exactly
 * `errorDocument(...).error`.
 */
export interface ErrorDocument {
  error: {
    exitCode: Exclude<ExitCode, 0>;
    /** The `BoardError` reason, or null. */
    reason: string | null;
    message: string;
    /**
     * `hintFor(error, context)` (board-agent-guidance: "Error hints"): one
     * ASCII line naming what to run next, or null when the error has no
     * reason (an unexpected failure). Always present.
     */
    hint: string | null;
    /**
     * Present only for the `import-change` refusals `reconcile-blocked` and
     * `reconcile-ambiguous` (an `ImportRefusedError`): the import's result,
     * what was written for a blocked import and the dry run with the
     * candidates for an ambiguous one. Absent for every other error.
     */
    result?: ImportResult;
    /**
     * The kept old repository of a completed `init --into-host` whose
     * final `sync` failed (`MoveSyncFailure` in `src/board/into-host.ts`),
     * and the old remote's URL; present exactly when the error is one.
     */
    keptAt?: string | null;
    oldRemoteUrl?: string | null;
  };
}

/**
 * The exit code for a thrown value: a `BoardError`'s `exitCode`; any other
 * error (an unexpected IO or SQLite failure) is 5. Pure.
 */
export function exitCodeFor(error: unknown): Exclude<ExitCode, 0> {
  return error instanceof BoardError ? error.exitCode : 5;
}

/**
 * The `ErrorDocument` for a thrown value: `exitCodeFor(error)`, the
 * `BoardError` reason (null for other errors), the error message and
 * `hintFor(error, context)`. `context` defaults to
 * `{ surface: 'cli', command: null }` (placeholders for the id and actor).
 * A `MoveSyncFailure` adds its `keptAt` and `oldRemoteUrl`, and an
 * `ImportRefusedError` its `result`. Pure.
 */
export function errorDocument(error: unknown, context?: HintContext): ErrorDocument {
  const base: ErrorDocument['error'] = {
    exitCode: exitCodeFor(error),
    reason: error instanceof BoardError ? error.reason : null,
    message: error instanceof Error ? error.message : String(error),
    hint: hintFor(error, context ?? { surface: 'cli', command: null }),
  };
  return {
    error:
      error instanceof MoveSyncFailure
        ? { ...base, keptAt: error.keptAt, oldRemoteUrl: error.oldRemoteUrl }
        : error instanceof ImportRefusedError
          ? { ...base, result: error.result }
          : base,
  };
}

/**
 * Runs one CLI invocation and returns its exit code.
 *
 * 1. `parseArgs(io.argv)`.
 * 2. `refuseReservedActor(values.as)` and `checkActorName(values.as,
 *    '--as')` (when given and non-empty) for every command, then, for a
 *    writing command or one that tracks a cursor
 *    (`CommandSpec.tracksCursor`), `resolveActor(values.as, io.env)`,
 *    `refuseReservedActor` of the result and, when it came from
 *    `AGENTBOARD_ACTOR`, `checkActorName(actor, 'AGENTBOARD_ACTOR')` (all
 *    in `commandActor`; board-cli "Actor names are checked").
 * 3. `command.run(ctx, values)` with a context whose `board()` finds and
 *    opens the board lazily (`findBoard` with `io.cwd` and `io.env`, then
 *    `openBoard`, passing `catchUp: false` when the first call asks for
 *    it) and whose `boardDir()` runs discovery only; the board is closed
 *    before returning. After opening, one
 *    stderr line `agentboard: removed stale temporary file <path>` is
 *    printed for each reaped temporary file and `agentboard: <message>` for
 *    each corrupt event file in the open report.
 * 4. Success (`run` returned): stderr first receives `agentboard: <line>`
 *    and a newline for each of `output.warnings`; then, with `--json`,
 *    stdout receives `JSON.stringify(output.json)` and a newline, and
 *    nothing else; without it, `output.text`. Returns `output.exitCode`
 *    when present (1 for a divergent `rebuild --check`), otherwise 0.
 * 5. Failure (anything thrown in steps 1 to 3): stderr receives
 *    `agentboard: <message>` and a newline, then, when the error has a
 *    hint, `hint: <hint>` and a newline (board-agent-guidance: "Error
 *    hints"); with `--json` (detected anywhere in `io.argv`, even when
 *    parsing failed), stdout also receives
 *    `JSON.stringify(errorDocument(error, context))` and a newline, whose
 *    `hint` is the same text. Returns `exitCodeFor(error)`.
 *
 *    The hint context: surface `cli`; `command` the parsed command's name,
 *    or, when parsing failed, the name of the registry command the leading
 *    arguments select (the longest match, as `parseArgs` selects it), else
 *    null; `id` the parsed `id` value when there is one (undefined when
 *    parsing failed); `actor` the parsed `--as` when non-empty (when
 *    parsing failed: the `as` of the relaxed re-parse, `parsedActor`),
 *    else `AGENTBOARD_ACTOR` from `io.env` when non-empty and the command
 *    uses the variable as its actor (`usesActorEnv`; a command that
 *    ignores it never repeats it), else undefined, and in every case
 *    only when that name passes the actor check (`checkActorName`), else
 *    undefined, so the hint writes `<actor>` for a refused or unchecked
 *    name (actor-secret-check design.md "No echo of an unchecked
 *    actor"). So `close <id> --as orch`
 *    without a disposition hints commands with `--as orch`, and the same
 *    with a token in place of `orch` hints `--as <actor>`. The same
 *    applies to a failing streaming command in `runCliAsync`.
 *
 * Steps 1 and 2 happen before any board lookup, so a usage error or a
 * missing actor exits 1 even where there is no board. Diagnostics never go
 * to stdout, and stdout carries at most one JSON document.
 */
export function runCli(io: CliIo): ExitCode {
  let parsed: ParsedCommand | null = null;
  const opened = cliBoard(io);
  try {
    parsed = parseArgs(io.argv);
    const { command, values } = parsed;
    const output = command.run(context(io, parsed, opened), values);
    for (const line of output.warnings ?? []) {
      io.stderr(`agentboard: ${line}\n`);
    }
    io.stdout(parsed.json ? `${JSON.stringify(output.json)}\n` : output.text);
    return output.exitCode ?? 0;
  } catch (error) {
    return fail(io, parsed, error);
  } finally {
    opened.close();
  }
}

/**
 * Opens a board directory on first use and prints the open diagnostics
 * (shared by `runCli` and the MCP server's tool calls).
 */
export class LazyBoard {
  private board: Board | null = null;
  private readonly locate: () => string;
  private readonly stderr: (text: string) => void;
  private readonly hooks: WriteHooks;

  /**
   * @param locate returns the board directory (discovery for the CLI, the
   *   directory fixed at start-up for the MCP server); called by `dir` and
   *   on first open.
   * @param stderr receives the reaped and corrupt file diagnostics.
   * @param hooks write hooks for the grants the opening catch-up writes
   *   (the CLI passes `pauseHooks` of its environment); none by default.
   */
  constructor(locate: () => string, stderr: (text: string) => void, hooks: WriteHooks = {}) {
    this.locate = locate;
    this.stderr = stderr;
    this.hooks = hooks;
  }

  /** The board directory, without opening anything. */
  dir(): string {
    return this.locate();
  }

  /** `options` apply to the first call only (see `RunContext.board`). */
  get(options?: BoardOpenOptions): Board {
    if (this.board === null) {
      this.board = openBoard(this.dir(), {
        catchUp: options?.catchUp !== false,
        prepare: options?.prepare !== false,
        hooks: this.hooks,
      });
      for (const path of this.board.opened?.reaped ?? []) {
        this.stderr(`agentboard: removed stale temporary file ${path}\n`);
      }
      for (const file of this.board.opened?.corrupt ?? []) {
        this.stderr(`agentboard: ${file.message}\n`);
      }
    }
    return this.board;
  }

  /** Closes the board if it was opened. */
  close(): void {
    this.board?.close();
  }
}

/**
 * The CLI's `LazyBoard`: discovery with `io.cwd` and `io.env`, and the
 * crash-injection hooks of `io.env` (`AGENTBOARD_TEST_PAUSE`) for a grant
 * written when the board is opened.
 */
function cliBoard(io: CliIo): LazyBoard {
  return new LazyBoard(
    () => findBoard({ cwd: io.cwd, env: io.env }).dir,
    (text) => {
      io.stderr(text);
    },
    pauseHooks(io.env),
  );
}

/**
 * The actor of `command`: `resolveActor(given, env)` for a writing or
 * cursor-tracking command, null for any other (shared with the MCP server).
 * Before the board is opened, in this order (board-cli "Actor names are
 * checked"; actor-secret-check design.md "Where the check runs"):
 *
 * 1. The reserved actor is refused as `given` (every command, so `show
 *    --as agentboard` exits 1, reason `usage`).
 * 2. A non-empty `given` is checked with `checkActorName(given,
 *    givenSource)` on every command, reads included, so `show T1 --as
 *    <token>` exits 1 with reason `invalid-actor`. `givenSource` is
 *    `--as` (the CLI, the default) or `the argument as` (an MCP tool
 *    call). An empty `given` is not a given name and is not checked.
 * 3. For a command that needs no actor, null: `AGENTBOARD_ACTOR` is
 *    neither read nor checked.
 * 4. Else the actor is resolved, the reserved actor refused as the
 *    resolved actor (so `AGENTBOARD_ACTOR=agentboard` is refused) and,
 *    when the actor came from the environment, checked with source
 *    `AGENTBOARD_ACTOR`. A name already checked as `given` is not checked
 *    again (the check is pure, so it would pass anyway).
 *
 * @throws BoardError exit 1: reason `missing-actor` from `resolveActor`,
 *   reason `usage` from `refuseReservedActor`, or reason `invalid-actor`
 *   from `checkActorName`.
 */
export function commandActor(
  command: CommandSpec,
  given: string | undefined,
  env: Env,
  givenSource: Extract<ActorSource, '--as' | 'the argument as'> = '--as',
): string | null {
  refuseReservedActor(given);
  if (given !== undefined && given !== '') {
    checkActorName(given, givenSource);
  }
  if (!usesActorEnv(command)) {
    return null;
  }
  const actor = resolveActor(given, env);
  refuseReservedActor(actor);
  if (actor !== given) {
    checkActorName(actor, ACTOR_ENV);
  }
  return actor;
}

/**
 * True when `command` uses `AGENTBOARD_ACTOR` as its actor when `--as` is
 * not given: it writes or tracks a per-actor cursor (`commandActor`
 * resolves an actor for exactly these). Pure.
 */
export function usesActorEnv(command: CommandSpec): boolean {
  return command.writes || command.tracksCursor === true;
}

/**
 * `actor` when it passes the actor check (`checkActorName`), else
 * undefined, for a hint context: a hint names an actor only when the name
 * has passed (board-cli "Actor names are checked"). The source is
 * immaterial, nothing is thrown. Pure.
 */
export function checkedActor(actor: string | undefined): string | undefined {
  if (actor === undefined) {
    return undefined;
  }
  try {
    checkActorName(actor, '--as');
    return actor;
  } catch {
    return undefined;
  }
}

/**
 * The `RunContext` of one command run on `opened` (shared with the MCP
 * server and the web app's actions); `surface` is `RunContext.surface`,
 * `cli` by default.
 */
export function runContext(
  cwd: string,
  env: Env,
  actor: string | null,
  opened: LazyBoard,
  surface: RunContext['surface'] = 'cli',
): RunContext {
  return {
    cwd,
    env,
    actor,
    surface,
    boardDir: () => opened.dir(),
    board: (options?: BoardOpenOptions) => opened.get(options),
  };
}

/** Resolves the actor (writing and cursor-tracking commands) and builds the context. */
function context(io: CliIo, parsed: ParsedCommand, opened: LazyBoard): RunContext {
  const given = parsed.values.as;
  const actor = commandActor(parsed.command, typeof given === 'string' ? given : undefined, io.env);
  return runContext(io.cwd, io.env, actor, opened);
}

/** Step 5 of `runCli`: reports `error` and returns its exit code. */
function fail(io: CliIo, parsed: ParsedCommand | null, error: unknown): Exclude<ExitCode, 0> {
  const doc = errorDocument(error, cliHintContext(io, parsed));
  io.stderr(`agentboard: ${doc.error.message}\n`);
  if (doc.error.hint !== null) {
    io.stderr(`hint: ${doc.error.hint}\n`);
  }
  if (parsed?.json ?? io.argv.includes('--json')) {
    io.stdout(`${JSON.stringify(doc)}\n`);
  }
  return doc.error.exitCode;
}

/** A non-empty string, else undefined. */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The hint context of a failed CLI run (step 5 of `runCli`): its actor is
 * the `--as` or, for a command that uses the variable as its actor
 * (`usesActorEnv`), the `AGENTBOARD_ACTOR` the run would have used, only
 * when that name passes the actor check (`checkedActor`). A command that
 * ignores the variable never repeats it, whatever its value.
 */
function cliHintContext(io: CliIo, parsed: ParsedCommand | null): HintContext {
  const fromEnv = nonEmpty(io.env[ACTOR_ENV]);
  if (parsed !== null) {
    const id = nonEmpty(parsed.values.id);
    const actor = checkedActor(
      nonEmpty(parsed.values.as) ?? (usesActorEnv(parsed.command) ? fromEnv : undefined),
    );
    const closeDecision =
      parsed.command.name === 'close' ? closeDecisionOf(parsed.values) : undefined;
    const force = parsed.command.name === 'release' && parsed.values.force === true;
    return {
      surface: 'cli',
      command: parsed.command.name,
      ...(id === undefined ? {} : { id }),
      ...(actor === undefined ? {} : { actor }),
      ...(closeDecision === undefined ? {} : { closeDecision }),
      ...(force ? { force } : {}),
    };
  }
  const command = leadingCommand(io.argv);
  const spec = command === null ? undefined : findCommand(command);
  const actor = checkedActor(
    parsedActor(io.argv, command) ??
      (spec !== undefined && usesActorEnv(spec) ? fromEnv : undefined),
  );
  return {
    surface: 'cli',
    command,
    ...(actor === undefined ? {} : { actor }),
  };
}

/**
 * The registry command the leading arguments select (the longest name
 * whose words equal them, as `parseArgs` selects it), or null.
 */
function leadingCommand(argv: readonly string[]): string | null {
  let best: string | null = null;
  for (const command of COMMANDS) {
    const words = command.name.split(' ');
    if (
      words.every((word, i) => argv[i] === word) &&
      (best === null || words.length > best.split(' ').length)
    ) {
      best = command.name;
    }
  }
  return best;
}

/**
 * The `--as` value of arguments that failed to parse for `command`: the
 * arguments are parsed again against the command with its exclusive
 * groups and its required arguments relaxed, and the actor is the `as`
 * value that parse yields; undefined when the arguments do not parse even
 * then (an unknown flag, a flag given twice, a bad integer), when `command`
 * is null, or when no `--as` was parsed. The raw arguments are never
 * scanned for `--as`, so a flag that took `--as` as its value (`close
 * --unplanned --as <text>`) names no actor and the following text, which
 * the parser read as the `<id>`, is not repeated as one (board-cli
 * "Refusals never repeat the refused input", review round 1 F1).
 */
function parsedActor(argv: readonly string[], command: string | null): string | undefined {
  const spec = command === null ? undefined : findCommand(command);
  if (spec === undefined) {
    return undefined;
  }
  const relaxed: CommandSpec = {
    ...spec,
    positionals: spec.positionals.map((p) => ({ ...p, required: false })),
    flags: spec.flags.map((f) => ({ ...f, required: false })),
    exclusive: [],
  };
  try {
    return nonEmpty(parseArgs(argv, [relaxed]).values.as);
  } catch {
    return undefined;
  }
}

/**
 * `runCli` for the executable (`src/cli.ts`): identical to `runCli`, with
 * the same output and exit codes, for every command without `stream`.
 *
 * A command streams when it has `stream` and either has no `streams`
 * predicate or `streams(values)` is true for the parsed values (`claim`
 * streams only with `--wait`); a command that does not stream is run
 * exactly as `runCli` runs it, without asking for a stop signal.
 *
 * For a streaming command (`watch`, `serve`, `top`, `claim --wait`):
 * steps 1 and 2 of
 * `runCli` (parse, resolve the actor; failures exit 1 before any board
 * lookup), then, for a command whose spec has `terminal` true (`top`)
 * only, `terminal = await io.terminal?.()`, then `io.stopSignal()`, then
 * `command.stream(ctx, values, { stdout: io.stdout, stderr: io.stderr,
 * json, signal, terminal })` (`terminal` present only when obtained) with
 * the same lazily opened board as `runCli`
 * (stale temporary and corrupt file diagnostics on stderr likewise). When
 * the stream resolves (the signal aborted), the board is closed and the
 * result is 0: SIGINT and SIGTERM are the normal way to stop `watch`. When
 * it rejects (or opening the board fails), stderr receives `agentboard:
 * <message>` and, with `--json`, stdout receives the `errorDocument` as one
 * more line after any lines already streamed; the result is
 * `exitCodeFor(error)`.
 *
 * Output of `watch`: one line per entry, `renderInboxLine(entry, actor)` without
 * `--json`, and with `--json` `JSON.stringify(entry)` of the `InboxEntry`
 * (newline-delimited JSON, one document per line). This is the single
 * exception to "exactly one JSON document on stdout": a stream has no end
 * at which to print one.
 */
export async function runCliAsync(io: AsyncCliIo): Promise<ExitCode> {
  let parsed: ParsedCommand;
  try {
    parsed = parseArgs(io.argv);
  } catch {
    // runCli reports the usage error, exactly as for a non-streaming command.
    return runCli(io);
  }
  const { command, values } = parsed;
  if (command.stream === undefined || command.streams?.(values) === false) {
    return runCli(io);
  }
  const opened = cliBoard(io);
  try {
    const ctx = context(io, parsed, opened);
    const terminal = command.terminal === true ? await io.terminal?.() : undefined;
    const signal = io.stopSignal();
    await command.stream(ctx, values, {
      stdout: io.stdout,
      stderr: io.stderr,
      json: parsed.json,
      signal,
      ...(terminal === undefined ? {} : { terminal }),
    });
    return 0;
  } catch (error) {
    return fail(io, parsed, error);
  } finally {
    opened.close();
  }
}
