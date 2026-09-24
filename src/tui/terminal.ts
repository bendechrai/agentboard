/**
 * The terminal driver and the loop of `agentboard top` (board-tui: "Top
 * command", "Interactive terminal required", "Live updates", "Frame
 * rendering", "Terminal restoration"; design.md: "Hand-rolled ANSI rather
 * than a library", "Non-TTY and terminal restoration"; add-board-tui task
 * 2.1).
 *
 * This is the only module of `src/tui/` that performs IO: `keys.ts`,
 * `state.ts` and `frame.ts` are pure (the layering test enforces it), and
 * this module turns their data into terminal output. Everything it does to
 * the terminal goes through a `TerminalIo`, so the tests drive it with a
 * fake terminal; `processTerminal` adapts the real process to it.
 *
 * Output protocol. Everything the driver writes with `TerminalIo.write` is
 * printable ASCII (0x20 to 0x7E) and these escape sequences only (ESC is
 * the byte 0x1B):
 * - `ESC[?1049h` and `ESC[?1049l`: enter and leave the alternate screen;
 * - `ESC[?25l` and `ESC[?25h`: hide and show the cursor;
 * - `ESC[<row>;<col>H`: cursor position, 1-based decimal row and column;
 * - `ESC[<params>m`: SGR, where `<params>` is one or more parameters
 *   separated by `;`, each one of `0` (reset), `1` (bold), `2` (dim), `7`
 *   (inverse) and `30` to `37` (the eight standard foreground colors, in
 *   the order of `Color` in `frame.ts`).
 * No other control byte is ever written (no carriage return, line feed,
 * bell, erase or scroll sequence). Text is written only while the
 * alternate screen is active and never past the last column of a row.
 *
 * Drawing. The driver keeps the frame it drew last. To draw, it renders
 * the current frame (`renderFrame(model, ui, size, now())`) and writes
 * each row whose text or style runs differ from the last drawn frame's
 * row, and every row when nothing was drawn yet or the size changed since
 * the last draw. A row is written in full: the cursor position of its
 * first column, then its cells from left to right, with SGR sequences
 * such that every cell is written with exactly its style from the frame's
 * style map (`Frame.styles`; a cell in no run has the default style),
 * then `ESC[0m`. So an interpreter of the sequences above that starts
 * with the default style reconstructs the frame exactly, cell by cell and
 * style by style. A draw in which no row differs writes nothing at all.
 * With a non-empty `NO_COLOR` in the environment, colors are dropped from
 * every style (SGR 30 to 37 are never written); bold, dim and inverse
 * remain, so the selection still shows.
 */

import type { Env } from '../board/text.js';
import type { ArgValues, RunContext, StreamIo } from '../cli/types.js';
import type { BoardSnapshot } from '../board/snapshot.js';
import type { WatchBoardOptions } from '../board/feed.js';
import type { TickerTimers, WatchDir } from '../board/ticker.js';
import type { Board } from '../store/board.js';
import type { Frame, Size } from './frame.js';
import type { UiState } from './state.js';
import type { BoardModel } from '../view/types.js';

/**
 * Everything `top` needs from its terminal. `processTerminal` builds one
 * over the real process; tests pass a fake.
 */
export interface TerminalIo {
  /** Whether standard input is a TTY. */
  readonly stdinIsTTY: boolean;
  /** Whether standard output is a TTY. */
  readonly stdoutIsTTY: boolean;
  /** Writes raw output (text and escape sequences) to the terminal. */
  write(text: string): void;
  /** The current size in character cells. */
  size(): Size;
  /** Turns raw mode on (true) or off (false). */
  setRawMode(enabled: boolean): void;
  /**
   * Calls `listener` with each chunk of input bytes as it arrives. Returns
   * a function that removes the listener (and, for the real process,
   * stops reading, so the process can exit).
   */
  onData(listener: (chunk: Uint8Array) => void): () => void;
  /** Calls `listener` when the input ends (end of file). Returns the remover. */
  onEnd(listener: () => void): () => void;
  /** Calls `listener` after each change of the terminal size. Returns the remover. */
  onResize(listener: () => void): () => void;
  /**
   * Calls `listener` synchronously when the process is about to exit for
   * any reason, an uncaught exception included (the real process: its
   * `exit` event). The listener must do synchronous work only. Returns the
   * remover.
   */
  onExit(listener: () => void): () => void;
}

/** Periodic redraw interval, so relative times stay current: 10 seconds. */
export const REDRAW_MS = 10_000;

/**
 * How long input bytes that start an escape sequence are kept pending
 * before `flushKeys` decides them (a lone Escape key press): 50 ms.
 */
export const ESCAPE_FLUSH_MS = 50;

/** The input side of the process that `processTerminal` uses (`process.stdin`). */
export interface HostInput {
  readonly isTTY?: boolean;
  /** Present on a TTY. */
  setRawMode?(mode: boolean): unknown;
  on(event: 'data' | 'end', listener: (chunk?: unknown) => void): unknown;
  off(event: 'data' | 'end', listener: (chunk?: unknown) => void): unknown;
  pause(): unknown;
}

/** The output side of the process that `processTerminal` uses (`process.stdout`). */
export interface HostOutput {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
  write(text: string): unknown;
  on(event: 'resize', listener: () => void): unknown;
  off(event: 'resize', listener: () => void): unknown;
}

/** The process itself, for its `exit` event (`process`). */
export interface HostProcess {
  on(event: 'exit', listener: () => void): unknown;
  off(event: 'exit', listener: () => void): unknown;
}

/** What `processTerminal` adapts; defaults to the real process. */
export interface TerminalHost {
  readonly stdin: HostInput;
  readonly stdout: HostOutput;
  readonly process: HostProcess;
}

/**
 * The `TerminalIo` of a process (`src/cli.ts` passes none, so the real
 * `process.stdin`, `process.stdout` and `process`). Creating it has no
 * effect on the host: nothing is read, written or listened to until a
 * method is called.
 * - `stdinIsTTY` and `stdoutIsTTY`: `host.stdin.isTTY === true` and
 *   `host.stdout.isTTY === true`, read when the terminal is created.
 * - `write(text)`: `host.stdout.write(text)`.
 * - `size()`: `host.stdout.columns` and `rows` when both are positive
 *   integers, otherwise 80 by 24.
 * - `setRawMode(on)`: `host.stdin.setRawMode(on)` when it exists, else
 *   nothing.
 * - `onData(listener)`: listens to `host.stdin` `data`, passing each
 *   chunk as a `Uint8Array` (a string chunk as its UTF-8 bytes); the
 *   remover removes that listener and calls `host.stdin.pause()`.
 * - `onEnd`: `host.stdin` `end`; `onResize`: `host.stdout` `resize`;
 *   `onExit`: `host.process` `exit`. Each remover removes exactly the
 *   listener it added.
 */
export function processTerminal(host?: TerminalHost): TerminalIo {
  void host;
  throw new Error('processTerminal: not implemented');
}

/** Options of `runTop`. */
export interface TopOptions {
  /** The open board; `runTop` does not close it. */
  readonly board: Board;
  readonly terminal: TerminalIo;
  /** Aborted to stop `top` (SIGINT or SIGTERM for the CLI). */
  readonly signal: AbortSignal;
  /** The environment; only `NO_COLOR` is read. */
  readonly env: Env;
  /** The board directory shown on the header line; defaults to `board.dir`. */
  readonly boardDir?: string;
  /** The clock (milliseconds since the Unix epoch); defaults to `Date.now`. */
  readonly now?: () => number;
  /** The periodic redraw interval; defaults to `REDRAW_MS`. */
  readonly redrawMs?: number;
  /** The pending escape delay; defaults to `ESCAPE_FLUSH_MS`. */
  readonly escapeMs?: number;
  /** Loads a snapshot; defaults to `loadSnapshot` (`src/board/snapshot.ts`). */
  readonly loadSnapshot?: (board: Board) => BoardSnapshot;
  /** Runs the board feed; defaults to `watchBoard` (`src/board/feed.ts`). */
  readonly watch?: (board: Board, options: WatchBoardOptions) => Promise<void>;
  /** Renders a frame; defaults to `renderFrame` (`src/tui/frame.ts`). Tests inject failures. */
  readonly render?: (model: BoardModel, ui: UiState, size: Size, now: number) => Frame;
  /** Passed to the feed (tests). */
  readonly feed?: {
    readonly pollMs?: number;
    readonly fsWatch?: boolean;
    readonly timers?: TickerTimers;
    readonly watchDir?: WatchDir;
  };
}

/**
 * Runs the `top` loop on `options.terminal` until the user quits, the
 * signal aborts or the input ends (then resolves), or something fails
 * (then rejects with that error). In order:
 *
 * 1. When `signal` is already aborted, resolves at once without loading
 *    anything or touching the terminal.
 * 2. Loads the first snapshot (`loadSnapshot(board)`); the model is the
 *    snapshot with an empty `late` list. The terminal is not touched
 *    before this succeeds, so a failing load rejects with nothing written
 *    and raw mode never turned on.
 * 3. Registers the restore function with `terminal.onExit`, before any
 *    terminal change. Restore is idempotent: its first call turns raw mode
 *    off (`setRawMode(false)`) and writes `ESC[0m`, `ESC[?25h` (show the
 *    cursor) and `ESC[?1049l` (leave the alternate screen); every later
 *    call does nothing. It runs exactly once on every exit path: `q`,
 *    Ctrl-C, the signal, the end of input, a feed failure, a failing
 *    reload or render, and the process exiting (`onExit`, for an uncaught
 *    exception).
 * 4. Writes `ESC[?1049h` and `ESC[?25l`, turns raw mode on, listens to
 *    input, resizes and the end of input, and draws the first frame (every
 *    row). The UI state starts as `reconcileUi(initialUi(boardDir),
 *    model)`.
 * 5. Starts the feed: `watch(board, { signal, since: <the model's id>,
 *    onMessage, onWarning, ...options.feed })`, with a signal of its own
 *    that `runTop` aborts when it stops.
 *
 * Then, until it stops:
 * - Input: each chunk is decoded with `decodeKeys(chunk, pending)`; each
 *   key is applied with `reduceKey(ui, key, model, terminal.size())`, and
 *   when `ui.quit` becomes true `top` stops (keys after it are ignored);
 *   then one draw. When bytes stay pending, and no further chunk arrives
 *   within `escapeMs`, `flushKeys(pending)` is applied the same way (a lone
 *   Escape closes the detail) and the pending bytes are dropped.
 * - An `append` message: `applyFeedMessage`, then `reconcileUi` with the
 *   new model, then a draw.
 * - A `resync` message: the snapshot is reloaded (`loadSnapshot(board)`)
 *   and becomes the model with `late` the resync's late hashes (the
 *   `late` of `applyFeedMessage`); the running feed is stopped and a new
 *   one started with `since` the reloaded snapshot's id (so no event is
 *   ever applied twice); then `reconcileUi` and a draw.
 * - A busy warning (`onWarning`): `ui.notice` becomes `busy` (shown at
 *   the start of the key line) and a draw; the notice is cleared (null)
 *   when the feed next delivers a message.
 * - A resize: a draw at the new size (every row).
 * - Every `redrawMs`: a draw (relative times move on; nothing is written
 *   when no row changed).
 * - Any other failure of the feed (the promise of `watch` rejecting, or
 *   its `onProblem` being called when `runTop` passes one), of a reload,
 *   or of a render: restore, stop, and reject with that error, so the CLI
 *   prints it (and its hint) only after the terminal is restored, and
 *   exits with its exit code.
 *
 * Stopping: the restore runs (once), every listener added to the terminal
 * is removed, the timers are cleared and the feed is stopped and awaited;
 * nothing is written after the restore. Writes no event and no cursor.
 * Does not close the board.
 */
export function runTop(options: TopOptions): Promise<void> {
  void options;
  return Promise.reject(new Error('runTop: not implemented'));
}

/** Test seams of `topCommand`: everything of `TopOptions` it does not supply itself. */
export type TopDeps = Omit<TopOptions, 'board' | 'terminal' | 'signal' | 'env' | 'boardDir'>;

/**
 * Runs `agentboard top`, the `stream` of the `top` registry entry:
 * 1. Requires `io.terminal` to be present with `stdinIsTTY` and
 *    `stdoutIsTTY` true, and `ctx.env.TERM` not to be `dumb` (an unset
 *    `TERM` is fine); otherwise throws `BoardError(1, 'not-a-tty')` with a
 *    message saying that top needs an interactive terminal, before
 *    anything else: no board lookup, no write to the terminal or to
 *    `io.stdout`.
 * 2. `ctx.board()`: discovery and open with catch-up; no board is
 *    `BoardError(2, 'board-not-found')`, thrown before any terminal
 *    change.
 * 3. `runTop({ ...deps, board, terminal: io.terminal, signal: io.signal,
 *    env: ctx.env, boardDir: board.dir })`.
 * `--json` changes nothing on the screen (a failure is then reported by
 * the CLI as the usual JSON error document); `--as` is accepted and
 * ignored. Nothing is ever written to `io.stdout`.
 */
export function topCommand(
  ctx: RunContext,
  values: ArgValues,
  io: StreamIo,
  deps: TopDeps = {},
): Promise<void> {
  void ctx;
  void values;
  void io;
  void deps;
  return Promise.reject(new Error('topCommand: not implemented'));
}
