/**
 * The `serve` command (board-web: "Serve command"; board-cli: "Command
 * surface", "Exit codes"; add-board-web task 3.1): starts the server
 * (`startServer`, `src/web/server.ts`) for the board found by discovery,
 * prints the start-up line, optionally opens a browser, and runs until
 * the stop signal (SIGINT or SIGTERM from `src/cli.ts`).
 *
 * The registry entry (`src/cli/registry.ts`) calls `serveCommand` through
 * a dynamic import, so no other command loads `node:http`.
 */

import type { ArgValues, RunContext, StreamIo } from '../cli/types.js';
import type { ServerOptions } from './server.js';

/** Starts a child process; the subset of `node:child_process` `spawn` that `openInBrowser` uses. */
export type Spawner = (
  command: string,
  args: readonly string[],
) => {
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
};

/** Options of `openInBrowser` (tests). */
export interface OpenOptions {
  /** Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /**
   * Defaults to `node:child_process` `spawn` with `stdio: 'ignore'` (the
   * opener's output never reaches the server's stdout or stderr).
   */
  readonly spawn?: Spawner;
}

/**
 * Asks the system to open `url` in the default browser: spawns, by name
 * (looked up on `PATH`, never an absolute path), `open <url>` on `darwin`,
 * `cmd /c start "" <url>` (arguments `/c`, `start`, `""`, url) on `win32`,
 * and `xdg-open <url>` on every other platform. Resolves when the opener
 * exits with code 0; rejects with an `Error` when it cannot be spawned
 * (`error`, for example ENOENT) or exits otherwise (a non-zero code or a
 * signal).
 */
export function openInBrowser(url: string, options?: OpenOptions): Promise<void> {
  void url;
  void options;
  throw new Error('not implemented');
}

/** Test seams of `serveCommand`. */
export interface ServeDeps {
  /** Opens the URL for `--open`; defaults to `openInBrowser`. */
  readonly open?: (url: string) => Promise<void>;
  /** Passed to `startServer` beneath the port (tests); `stderr` defaults to `io.stderr`. */
  readonly server?: Omit<ServerOptions, 'port'>;
}

/**
 * Runs `agentboard serve [--port <n>] [--open]`, the `stream` of the
 * `serve` registry entry:
 * 1. `--port`, when given, must be an integer from 0 to 65535, else
 *    `BoardError(1, 'usage')` naming the range; this is checked before
 *    any board lookup, so it exits 1 even where there is no board.
 * 2. `ctx.board()`: discovery and open with catch-up; no board is
 *    `BoardError(2, 'board-not-found')` from discovery, before anything
 *    listens.
 * 3. `startServer(board, { ...deps.server, port, stderr })` with the port
 *    (default 0) and `io.stderr` as `stderr`; a port in use rejects with
 *    `BoardError(1, 'port-in-use')`.
 * 4. Prints exactly one line on stdout: without `--json`, `serving <board
 *    dir> read-only at <url>` (`<board dir>` is `board.dir`, `<url>` the
 *    server's entry URL); with `--json`, `JSON.stringify({ url, port,
 *    token, writable: false })` with the keys in that order. Nothing else
 *    is ever written to stdout.
 * 5. With `--open`: `open(url)` (default `openInBrowser`); when it
 *    rejects, `io.stderr` receives `agentboard: could not open a browser:
 *    <message>` and a newline and serving carries on. The URL is never
 *    written to stderr.
 * 6. Waits until `io.signal` aborts (at once when it already has), then
 *    `close()`s the server and resolves (the CLI then closes the board and
 *    exits 0).
 * `--as` is accepted and ignored (serve writes nothing and tracks no
 * cursor, so it needs no actor). Writes no event and no cursor.
 */
export function serveCommand(
  ctx: RunContext,
  values: ArgValues,
  io: StreamIo,
  deps?: ServeDeps,
): Promise<void> {
  void ctx;
  void values;
  void io;
  void deps;
  throw new Error('not implemented');
}
