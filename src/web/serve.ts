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

import type { ArgValues, Env, RunContext, StreamIo } from '../cli/types.js';
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

/**
 * Whether `serve` opens the start-up URL in a browser (add-serve-auto-open
 * design.md: "Deciding whether to open"):
 * - `always`: `--open`; an attempt is made whatever the environment;
 * - `never`: `--no-open`; no attempt is ever made;
 * - `auto`: neither flag; an attempt is made only when `shouldAutoOpen`
 *   holds.
 */
export type OpenMode = 'always' | 'never' | 'auto';

/**
 * The open mode of the parsed `serve` values: `always` when `values.open`
 * is `true`, `never` when `values['no-open']` is `true`, `auto` when
 * neither is. Both `true` throws `BoardError(1, 'usage')` with a message
 * naming `--open` and `--no-open` (the registry's exclusive group already
 * refuses both when parsing; this guards callers of `serveCommand` that
 * pass values directly). Any other value of either key (absent, `false`)
 * counts as not given. Pure.
 */
export function openMode(values: ArgValues): OpenMode {
  const open = values.open === true;
  const noOpen = values['no-open'] === true;
  if (open && noOpen) {
    throw new BoardError(1, 'usage', 'give only one of --open, --no-open');
  }
  return open ? 'always' : noOpen ? 'never' : 'auto';
}

/** The inputs of `shouldAutoOpen`. */
export interface AutoOpenInput {
  /** The platform (`process.platform` in production). */
  readonly platform: NodeJS.Platform;
  /** The environment variables (`RunContext.env` in production). */
  readonly env: Env;
  /** Whether stdout is a terminal (`process.stdout.isTTY === true` in production). */
  readonly stdoutIsTTY: boolean;
  /** Whether `--json` was given. */
  readonly json: boolean;
}

/**
 * Whether `serve` in `auto` mode opens the browser (board-web: "Serve
 * command", as modified by add-serve-auto-open). True exactly when every
 * one of these holds, where a variable "is set" when its value is defined
 * and not the empty string (an undefined value or an absent key is unset):
 * 1. `stdoutIsTTY` is true;
 * 2. `json` is false;
 * 3. `CI` is not set (any non-empty value, `0` and `false` included,
 *    counts as set);
 * 4. none of `SSH_CONNECTION`, `SSH_CLIENT` and `SSH_TTY` is set;
 * 5. when `platform` is neither `darwin` nor `win32`, `DISPLAY` or
 *    `WAYLAND_DISPLAY` is set. On `darwin` and `win32` neither variable
 *    is consulted.
 * Nothing checks whether an opener binary exists. Pure: reads nothing but
 * its input.
 */
export function shouldAutoOpen(input: AutoOpenInput): boolean {
  const isSet = (name: string): boolean => {
    const value = input.env[name];
    return value !== undefined && value !== '';
  };
  if (!input.stdoutIsTTY || input.json || isSet('CI')) {
    return false;
  }
  if (isSet('SSH_CONNECTION') || isSet('SSH_CLIENT') || isSet('SSH_TTY')) {
    return false;
  }
  if (input.platform === 'darwin' || input.platform === 'win32') {
    return true;
  }
  return isSet('DISPLAY') || isSet('WAYLAND_DISPLAY');
}

/** Test seams of `serveCommand`. */
export interface ServeDeps {
  /**
   * Opens the URL (in `always` mode, and in `auto` mode when
   * `shouldAutoOpen` holds); defaults to `openInBrowser(url, { platform })`
   * with the resolved `platform` below.
   */
  readonly open?: (url: string) => Promise<void>;
  /** Passed to `startServer` beneath the port (tests); `stderr` defaults to `io.stderr`. */
  readonly server?: Omit<ServerOptions, 'port'>;
  /**
   * Whether stdout is a terminal, for `shouldAutoOpen`; defaults to
   * `process.stdout.isTTY === true`, read when `serveCommand` runs.
   */
  readonly stdoutIsTTY?: boolean;
  /**
   * The platform, for `shouldAutoOpen` and the default `open`; defaults to
   * `process.platform`.
   */
  readonly platform?: NodeJS.Platform;
}

/**
 * Runs `agentboard serve [--port <n>] [--open | --no-open] [--as <actor>]`,
 * the `stream` of the `serve` registry entry:
 * 1. `--port`, when given, must be an integer from 0 to 65535, else
 *    `BoardError(1, 'usage')` naming the range; `--as`, when given
 *    (`values.as`), must be a non-empty string, else `BoardError(1,
 *    'usage')` naming `--as`; `openMode(values)` resolves the open mode
 *    (`--open` with `--no-open` is `BoardError(1, 'usage')`). All are
 *    checked before any board lookup, so they exit 1 even where there is
 *    no board, and nothing listens.
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
 * 5. Opens the browser when the mode is `always`, or `auto` and
 *    `shouldAutoOpen({ platform, env: ctx.env, stdoutIsTTY, json: io.json
 *    })` holds (`platform` and `stdoutIsTTY` from `deps`, else their
 *    process defaults); in `never` mode, or `auto` when it does not hold,
 *    `open` is never called. Opening is `open(url)` called exactly once,
 *    after the start-up line is written and before waiting for the stop
 *    signal, with that same fragment URL; when it rejects, `io.stderr` receives `agentboard:
 *    could not open a browser: <message>` and a newline, where every
 *    occurrence of the token in the error's message is replaced by the
 *    literal `<token>` (an opener that echoes the URL leaves
 *    `http://127.0.0.1:<port>/#token=<token>` with the placeholder), and
 *    serving carries on (one warning line, in any mode). Nothing is written
 *    when it resolves. The token is never written to stderr.
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
  const mode = openMode(values);
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
    const platform = deps.platform ?? process.platform;
    const stdoutIsTTY = deps.stdoutIsTTY ?? process.stdout.isTTY === true;
    if (
      mode === 'always' ||
      (mode === 'auto' && shouldAutoOpen({ platform, env: ctx.env, stdoutIsTTY, json: io.json }))
    ) {
      const open = deps.open ?? ((url: string) => openInBrowser(url, { platform }));
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
