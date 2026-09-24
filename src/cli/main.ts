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
import type { Env, RunContext } from './types.js';

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
 * 2. For a writing command or one that tracks a cursor
 *    (`CommandSpec.tracksCursor`), `resolveActor(values.as, io.env)`.
 * 3. `command.run(ctx, values)` with a context whose `board()` finds and
 *    opens the board lazily (`findBoard` with `io.cwd` and `io.env`, then
 *    `openBoard`); the board is closed before returning. After opening, one
 *    stderr line `agentboard: removed stale temporary file <path>` is
 *    printed for each reaped temporary file and `agentboard: <message>` for
 *    each corrupt event file in the open report.
 * 4. Success: with `--json`, stdout receives `JSON.stringify(output.json)`
 *    and a newline, and nothing else; without it, `output.text`. Exit 0.
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
      board(): Board {
        if (board === null) {
          board = openBoard(findBoard({ cwd: io.cwd, env: io.env }).dir);
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
    io.stdout(parsed.json ? `${JSON.stringify(output.json)}\n` : output.text);
    return 0;
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

/**
 * `runCli` for the executable (`src/cli.ts`): identical to `runCli`, with
 * the same output and exit codes, for every command without `stream`.
 *
 * For a streaming command (`watch`): steps 1 and 2 of `runCli` (parse,
 * resolve the actor; failures exit 1 before any board lookup), then
 * `io.stopSignal()`, then `command.stream(ctx, values, { stdout:
 * io.stdout, json, signal })` with the same lazily opened board as `runCli`
 * (stale temporary and corrupt file diagnostics on stderr likewise). When
 * the stream resolves (the signal aborted), the board is closed and the
 * result is 0: SIGINT and SIGTERM are the normal way to stop `watch`. When
 * it rejects (or opening the board fails), stderr receives `agentboard:
 * <message>` and, with `--json`, stdout receives the `errorDocument` as one
 * more line after any lines already streamed; the result is
 * `exitCodeFor(error)`.
 *
 * Output of `watch`: one line per entry, `renderInboxLine(entry)` without
 * `--json`, and with `--json` `JSON.stringify(entry)` of the `InboxEntry`
 * (newline-delimited JSON, one document per line). This is the single
 * exception to "exactly one JSON document on stdout": a stream has no end
 * at which to print one.
 */
export function runCliAsync(io: AsyncCliIo): Promise<ExitCode> {
  void io;
  return Promise.reject(new Error('not implemented'));
}
