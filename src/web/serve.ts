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

import { spawn } from 'node:child_process';

import type { ArgValues, RunContext, StreamIo } from '../cli/types.js';
import { BoardError } from '../store/errors.js';
import { actionRoot } from './actions.js';
import { startServer, type ServerOptions } from './server.js';

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
export function openInBrowser(url: string, options: OpenOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  const spawner: Spawner =
    options.spawn ?? ((command, args) => spawn(command, args, { stdio: 'ignore' }));
  const [command, args]: [string, readonly string[]] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  return new Promise<void>((resolve, reject) => {
    try {
      const child = spawner(command, args);
      child.once('error', (error: Error) => {
        reject(error);
      });
      child.once('exit', (code: number | null, signal: string | null) => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              code === null
                ? `${command} was stopped by ${String(signal)}`
                : `${command} exited with code ${String(code)}`,
            ),
          );
        }
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** Test seams of `serveCommand`. */
export interface ServeDeps {
  /** Opens the URL for `--open`; defaults to `openInBrowser`. */
  readonly open?: (url: string) => Promise<void>;
  /** Passed to `startServer` beneath the port (tests); `stderr` defaults to `io.stderr`. */
  readonly server?: Omit<ServerOptions, 'port'>;
}

/**
 * Runs `agentboard serve [--port <n>] [--open] [--as <actor>]`, the
 * `stream` of the `serve` registry entry:
 * 1. `--port`, when given, must be an integer from 0 to 65535, else
 *    `BoardError(1, 'usage')` naming the range; `--as`, when given
 *    (`values.as`), must be a non-empty string, else `BoardError(1,
 *    'usage')` naming `--as`. Both are checked before any board lookup, so
 *    they exit 1 even where there is no board.
 * 2. `ctx.board()`: discovery and open with catch-up; no board is
 *    `BoardError(2, 'board-not-found')` from discovery, before anything
 *    listens.
 * 3. `startServer(board, { ...deps.server, port, stderr, actor, root, env
 *    })` with the port (default 0), `io.stderr` as `stderr`, `actor` the
 *    `--as` value or null (never `ctx.actor` and never `AGENTBOARD_ACTOR`
 *    from `ctx.env`: the environment never enables writes), `root`
 *    `actionRoot(ctx.cwd, ctx.env)` (`src/web/actions.ts`) and `env`
 *    `ctx.env`; a port in use rejects with `BoardError(1, 'port-in-use')`.
 * 4. Prints exactly one line on stdout: without `--json`, `serving <board
 *    dir> read-only at <url>`, or with `--as <actor>` `serving <board dir>
 *    as <actor> at <url>` (`<board dir>` is `board.dir`, `<url>` the
 *    server's start-up URL `http://127.0.0.1:<port>/#token=<token>`, the
 *    token in the fragment); with `--json`, `JSON.stringify({ url, port,
 *    token, writable, actor })` with the keys in that order, `writable`
 *    true and `actor` the actor with `--as`, else false and null. Nothing
 *    else is ever written to stdout.
 * 5. With `--open`: `open(url)` (default `openInBrowser`) with that same
 *    fragment URL; when it rejects, `io.stderr` receives `agentboard:
 *    could not open a browser: <message>` and a newline, where every
 *    occurrence of the token in the error's message is replaced by the
 *    literal `<token>` (an opener that echoes the URL leaves
 *    `http://127.0.0.1:<port>/#token=<token>` with the placeholder), and
 *    serving carries on. The token is never written to stderr.
 * 6. Waits until `io.signal` aborts (at once when it already has), then
 *    `close()`s the server and resolves (the CLI then closes the board and
 *    exits 0).
 * `serve` needs no actor (the registry entry does not write and tracks no
 * cursor, so `ctx.actor` is null); without `--as` it writes no event, and
 * with it only the events of accepted write actions. Writes no cursor.
 */
export async function serveCommand(
  ctx: RunContext,
  values: ArgValues,
  io: StreamIo,
  deps: ServeDeps = {},
): Promise<void> {
  const given = values.port;
  let port = 0;
  if (given !== undefined) {
    if (typeof given !== 'number' || !Number.isInteger(given) || given < 0 || given > 65535) {
      throw new BoardError(1, 'usage', '--port must be an integer from 0 to 65535');
    }
    port = given;
  }
  // Only an explicit --as enables writes: never ctx.actor, never AGENTBOARD_ACTOR.
  const as = values.as;
  if (as !== undefined && (typeof as !== 'string' || as === '')) {
    throw new BoardError(1, 'usage', '--as must name an actor; leave --as out to serve read-only');
  }
  const actor = as ?? null;
  const board = ctx.board();
  const stderr = (text: string): void => {
    io.stderr?.(text);
  };
  const server = await startServer(board, {
    stderr,
    ...deps.server,
    port,
    actor,
    root: actionRoot(ctx.cwd, ctx.env),
    env: ctx.env,
  });
  try {
    io.stdout(
      io.json
        ? `${JSON.stringify({ url: server.url, port: server.port, token: server.token, writable: actor !== null, actor })}\n`
        : `serving ${board.dir} ${actor === null ? 'read-only' : `as ${actor}`} at ${server.url}\n`,
    );
    if (values.open === true) {
      const open = deps.open ?? ((url: string) => openInBrowser(url));
      open(server.url).catch((error: unknown) => {
        // The URL (and so the token) is never written to stderr, whatever the opener says.
        const message = (error instanceof Error ? error.message : String(error))
          .split(server.token)
          .join('<token>');
        stderr(`agentboard: could not open a browser: ${message}\n`);
      });
    }
    await new Promise<void>((resolve) => {
      if (io.signal.aborted) {
        resolve();
        return;
      }
      io.signal.addEventListener(
        'abort',
        () => {
          resolve();
        },
        { once: true },
      );
    });
  } finally {
    await server.close();
  }
}
