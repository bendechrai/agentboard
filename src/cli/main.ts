/**
 * The CLI driver: parse, resolve the actor, run, render, map exit codes
 * (board-cli: "Output conventions", "Exit codes", "Actor is explicit").
 * `src/cli.ts` calls `runCli` with the real process; tests call it in
 * process with captured streams.
 */

import type { ExitCode } from '../store/errors.js';
import { notImplemented } from '../board/stub.js';
import type { Env } from './types.js';

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
  throw notImplemented(error);
}

/**
 * The `ErrorDocument` for a thrown value: `exitCodeFor(error)`, the
 * `BoardError` reason (null for other errors) and the error message. Pure.
 */
export function errorDocument(error: unknown): ErrorDocument {
  throw notImplemented(error);
}

/**
 * Runs one CLI invocation and returns its exit code.
 *
 * 1. `parseArgs(io.argv)`.
 * 2. For a writing command, `resolveActor(values.as, io.env)`.
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
  throw notImplemented(io);
}
