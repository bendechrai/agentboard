/**
 * The CLI driver: parse, resolve the actor, run, render, map exit codes
 * (board-cli: "Output conventions", "Exit codes", "Actor is explicit").
 * `src/cli.ts` calls `runCli` with the real process; tests call it in
 * process with captured streams.
 */

import { openBoard, type Board } from '../store/board.js';
import { BoardError, type ExitCode } from '../store/errors.js';
import { findBoard } from '../store/locate.js';
import { parseArgs, resolveActor, type ParsedCommand } from './parse.js';
import type { BoardOpenOptions, Env, RunContext } from './types.js';

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

/** The `--json` document printed on stdout when a command fails. */
export interface ErrorDocument {
  error: {
    exitCode: Exclude<ExitCode, 0>;
    /** The `BoardError` reason, or null. */
    reason: string | null;
    message: string;
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
 * `BoardError` reason (null for other errors) and the error message. Pure.
 */
export function errorDocument(error: unknown): ErrorDocument {
  return {
    error: {
      exitCode: exitCodeFor(error),
      reason: error instanceof BoardError ? error.reason : null,
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

/**
 * Runs one CLI invocation and returns its exit code.
 *
 * 1. `parseArgs(io.argv)`.
 * 2. For a writing command, `resolveActor(values.as, io.env)`.
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
 *    `agentboard: <message>` and a newline; with `--json` (detected
 *    anywhere in `io.argv`, even when parsing failed), stdout also receives
 *    `JSON.stringify(errorDocument(error))` and a newline. Returns
 *    `exitCodeFor(error)`.
 *
 * Steps 1 and 2 happen before any board lookup, so a usage error or a
 * missing actor exits 1 even where there is no board. Diagnostics never go
 * to stdout, and stdout carries at most one JSON document.
 */
export function runCli(io: CliIo): ExitCode {
  let parsed: ParsedCommand | null = null;
  let board: Board | null = null;
  try {
    parsed = parseArgs(io.argv);
    const { command, values } = parsed;
    const given = values.as;
    const actor = command.writes
      ? resolveActor(typeof given === 'string' ? given : undefined, io.env)
      : null;
    const ctx: RunContext = {
      cwd: io.cwd,
      env: io.env,
      actor,
      boardDir(): string {
        return findBoard({ cwd: io.cwd, env: io.env }).dir;
      },
      board(options?: BoardOpenOptions): Board {
        if (board === null) {
          board = openBoard(findBoard({ cwd: io.cwd, env: io.env }).dir, {
            catchUp: options?.catchUp !== false,
          });
          for (const path of board.opened?.reaped ?? []) {
            io.stderr(`agentboard: removed stale temporary file ${path}\n`);
          }
          for (const file of board.opened?.corrupt ?? []) {
            io.stderr(`agentboard: ${file.message}\n`);
          }
        }
        return board;
      },
    };
    const output = command.run(ctx, values);
    for (const line of output.warnings ?? []) {
      io.stderr(`agentboard: ${line}\n`);
    }
    io.stdout(parsed.json ? `${JSON.stringify(output.json)}\n` : output.text);
    return output.exitCode ?? 0;
  } catch (error) {
    const doc = errorDocument(error);
    io.stderr(`agentboard: ${doc.error.message}\n`);
    if (parsed?.json ?? io.argv.includes('--json')) {
      io.stdout(`${JSON.stringify(doc)}\n`);
    }
    return doc.error.exitCode;
  } finally {
    // `board` is assigned inside the closure above.
    (board as Board | null)?.close();
  }
}
