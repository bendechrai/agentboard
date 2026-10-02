/**
 * The terminal driver and the loop of `agentboard top` (board-tui: "Top
 * command", "Interactive terminal required", "Live updates", "Frame
 * rendering", "Terminal restoration"; add-board-tui design.md: "Hand-rolled
 * ANSI rather than a library", "Non-TTY and terminal restoration").
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

import { loadSnapshot as defaultLoadSnapshot, type BoardSnapshot } from '../board/snapshot.js';
import type { Env } from '../board/text.js';
import { watchBoard, type WatchBoardOptions } from '../board/feed.js';
import type { TickerTimers, WatchDir } from '../board/ticker.js';
import type { ArgValues, RunContext, StreamIo } from '../cli/types.js';
import type { Board } from '../store/board.js';
import { BoardError } from '../store/errors.js';
import { applyFeedMessage } from '../view/apply.js';
import type { BoardModel, FeedMessage } from '../view/types.js';
import {
  renderFrame,
  type Color,
  type Frame,
  type Size,
  type Style,
  type StyleRun,
} from './frame.js';
import { decodeKeys, flushKeys, type Key } from './keys.js';
import { initialUi, reconcileUi, reduceKey, type UiState } from './state.js';

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
  /** Present on a socket or TTY stream; lets the process exit while the stream is open. */
  unref?(): unknown;
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
 *   remover removes that listener, calls `host.stdin.pause()` and, when
 *   it exists, `host.stdin.unref()`, so the process can exit once `top`
 *   has stopped, whatever stdin is connected to (a paused pipe alone
 *   keeps the process alive).
 * - `onEnd`: `host.stdin` `end`; `onResize`: `host.stdout` `resize`;
 *   `onExit`: `host.process` `exit`. Each remover removes exactly the
 *   listener it added.
 */
export function processTerminal(host: TerminalHost = realHost()): TerminalIo {
  const { stdin, stdout } = host;
  return {
    stdinIsTTY: stdin.isTTY === true,
    stdoutIsTTY: stdout.isTTY === true,
    write: (text) => {
      stdout.write(text);
    },
    size: () => {
      const { columns, rows } = stdout;
      return positiveInteger(columns) && positiveInteger(rows)
        ? { columns, rows }
        : { columns: DEFAULT_SIZE.columns, rows: DEFAULT_SIZE.rows };
    },
    setRawMode: (enabled) => {
      stdin.setRawMode?.(enabled);
    },
    onData: (listener) => {
      const handler = (chunk?: unknown): void => {
        const bytes = asBytes(chunk);
        if (bytes !== null) {
          listener(bytes);
        }
      };
      stdin.on('data', handler);
      return () => {
        stdin.off('data', handler);
        stdin.pause();
        stdin.unref?.();
      };
    },
    onEnd: (listener) => {
      const handler = (): void => {
        listener();
      };
      stdin.on('end', handler);
      return () => {
        stdin.off('end', handler);
      };
    },
    onResize: (listener) => {
      const handler = (): void => {
        listener();
      };
      stdout.on('resize', handler);
      return () => {
        stdout.off('resize', handler);
      };
    },
    onExit: (listener) => {
      const handler = (): void => {
        listener();
      };
      host.process.on('exit', handler);
      return () => {
        host.process.off('exit', handler);
      };
    },
  };
}

/** The size used when the output does not report one. */
const DEFAULT_SIZE: Readonly<Size> = { columns: 80, rows: 24 };

function positiveInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value > 0;
}

/** An input chunk as bytes: a string as its UTF-8 bytes; anything else is ignored. */
function asBytes(chunk: unknown): Uint8Array | null {
  if (chunk instanceof Uint8Array) {
    return chunk;
  }
  if (typeof chunk === 'string') {
    return new TextEncoder().encode(chunk);
  }
  return null;
}

/** The real process as a `TerminalHost`. */
function realHost(): TerminalHost {
  return { stdin: process.stdin, stdout: process.stdout, process };
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
  if (options.signal.aborted) {
    return Promise.resolve();
  }
  const load = options.loadSnapshot ?? defaultLoadSnapshot;
  let model: BoardModel;
  try {
    model = { ...load(options.board), late: [] };
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  return new Promise<void>((resolve, reject) => {
    new TopSession(options, model, load, resolve, reject).start();
  });
}

/** The escape sequence introducer (ESC `[`). */
const CSI = '\x1b[';
const ENTER_ALT = `${CSI}?1049h`;
const LEAVE_ALT = `${CSI}?1049l`;
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;
const RESET = `${CSI}0m`;

/** The SGR color parameters, in the order of `Color` (30 to 37). */
const COLOR_CODES: Readonly<Record<Color, number>> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
};

const DEFAULT_STYLE: Readonly<Style> = { bold: false, dim: false, inverse: false, color: null };

function sameStyle(a: Style, b: Style): boolean {
  return a.bold === b.bold && a.dim === b.dim && a.inverse === b.inverse && a.color === b.color;
}

function sameRuns(a: readonly StyleRun[], b: readonly StyleRun[]): boolean {
  return (
    a.length === b.length &&
    a.every((run, i) => {
      const other = b[i];
      return (
        other !== undefined &&
        run.start === other.start &&
        run.length === other.length &&
        sameStyle(run.style, other.style)
      );
    })
  );
}

/** The SGR sequence that sets exactly `style` (starting with a reset). */
function sgr(style: Style, color: boolean): string {
  const params = ['0'];
  if (style.bold) {
    params.push('1');
  }
  if (style.dim) {
    params.push('2');
  }
  if (style.inverse) {
    params.push('7');
  }
  if (color && style.color !== null) {
    params.push(String(COLOR_CODES[style.color]));
  }
  return `${CSI}${params.join(';')}m`;
}

/**
 * The output that draws row `index` of a frame in full: the cursor at its
 * first column, each segment of cells with its style, then a reset. The
 * first segment always sets its style, so nothing depends on the style
 * the terminal was left in.
 */
function rowOutput(index: number, line: string, runs: readonly StyleRun[], color: boolean): string {
  const segments: { text: string; style: Style }[] = [];
  let at = 0;
  for (const run of runs) {
    if (run.start > at) {
      segments.push({ text: line.slice(at, run.start), style: DEFAULT_STYLE });
    }
    segments.push({ text: line.slice(run.start, run.start + run.length), style: run.style });
    at = run.start + run.length;
  }
  if (at < line.length) {
    segments.push({ text: line.slice(at), style: DEFAULT_STYLE });
  }
  let out = `${CSI}${String(index + 1)};1H`;
  let current: string | null = null;
  for (const segment of segments) {
    const set = sgr(segment.style, color);
    if (set !== current) {
      out += set;
      current = set;
    }
    out += segment.text;
  }
  return `${out}${RESET}`;
}

/** One running board feed and its stopper. */
interface RunningFeed {
  readonly controller: AbortController;
  /** Settles once the feed has stopped; never rejects. */
  done: Promise<void>;
}

/** The state of one `runTop` call once its first snapshot is loaded. */
class TopSession {
  private ui: UiState;
  private readonly color: boolean;
  private readonly now: () => number;
  private readonly render: NonNullable<TopOptions['render']>;
  private readonly watch: NonNullable<TopOptions['watch']>;
  private readonly redrawMs: number;
  private readonly escapeMs: number;
  /** The frame drawn last (null: nothing drawn yet, or a full redraw is due). */
  private last: { frame: Frame; size: Size } | null = null;
  private pending: Uint8Array = new Uint8Array(0);
  private escapeTimer: ReturnType<typeof setTimeout> | null = null;
  private redrawTimer: ReturnType<typeof setInterval> | null = null;
  private readonly removers: (() => void)[] = [];
  private readonly feeds: RunningFeed[] = [];
  private feed: RunningFeed | null = null;
  private restored = false;
  private stopped = false;

  constructor(
    private readonly options: TopOptions,
    private model: BoardModel,
    private readonly load: (board: Board) => BoardSnapshot,
    private readonly resolve: () => void,
    private readonly reject: (error: unknown) => void,
  ) {
    const env = options.env.NO_COLOR;
    this.color = env === undefined || env === '';
    this.now = options.now ?? Date.now;
    this.render = options.render ?? renderFrame;
    this.watch = options.watch ?? watchBoard;
    this.redrawMs = options.redrawMs ?? REDRAW_MS;
    this.escapeMs = options.escapeMs ?? ESCAPE_FLUSH_MS;
    this.ui = reconcileUi(initialUi(options.boardDir ?? options.board.dir), model);
  }

  /** Steps 3 to 5 of `runTop`: every failure from here on restores first. */
  start(): void {
    const { terminal, signal } = this.options;
    // Registered before any terminal change, so an exiting process restores.
    this.removers.push(
      terminal.onExit(() => {
        this.stop(null);
      }),
    );
    this.guard(() => {
      terminal.write(`${ENTER_ALT}${HIDE_CURSOR}`);
      terminal.setRawMode(true);
      this.removers.push(
        terminal.onData((chunk) => {
          this.guard(() => {
            this.input(chunk);
          });
        }),
        terminal.onResize(() => {
          this.guard(() => {
            this.last = null;
            this.draw();
          });
        }),
        terminal.onEnd(() => {
          this.stop(null);
        }),
      );
      const onAbort = (): void => {
        this.stop(null);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.removers.push(() => {
        signal.removeEventListener('abort', onAbort);
      });
      this.redrawTimer = setInterval(() => {
        this.guard(() => {
          this.draw();
        });
      }, this.redrawMs);
      this.draw();
      this.startFeed();
    });
  }

  /** Runs `fn`; a failure restores the terminal and rejects with it. */
  private guard(fn: () => void): void {
    if (this.stopped) {
      return;
    }
    try {
      fn();
    } catch (error) {
      this.stop({ error });
    }
  }

  /** Starts a board feed from the model's position id. */
  private startFeed(): void {
    const controller = new AbortController();
    // Registered before the feed starts: its first tick runs synchronously.
    const feed: RunningFeed = { controller, done: Promise.resolve() };
    this.feed = feed;
    this.feeds.push(feed);
    const current = (): boolean => this.feed === feed;
    const watchOptions: WatchBoardOptions = {
      signal: controller.signal,
      since: this.model.id,
      onMessage: (message) => {
        if (current()) {
          this.guard(() => {
            this.message(message);
          });
        }
      },
      onWarning: () => {
        if (current()) {
          this.guard(() => {
            this.ui = { ...this.ui, notice: 'busy' };
            this.draw();
          });
        }
      },
      ...this.options.feed,
    };
    feed.done = this.watch(this.options.board, watchOptions).catch((error: unknown) => {
      // A failure of the feed running now stops top; a replaced feed's is moot.
      if (current()) {
        this.stop({ error });
      }
    });
  }

  /** One feed message: an append is applied, a resync reloads and restarts the feed. */
  private message(message: FeedMessage): void {
    if (this.ui.notice !== null) {
      this.ui = { ...this.ui, notice: null };
    }
    const applied = applyFeedMessage(this.model, message);
    if (!applied.reload) {
      this.model = applied.model;
      this.ui = reconcileUi(this.ui, this.model);
      this.draw();
      return;
    }
    this.model = { ...this.load(this.options.board), late: applied.late };
    this.ui = reconcileUi(this.ui, this.model);
    this.feed?.controller.abort();
    this.draw();
    this.startFeed();
  }

  /** One chunk of input. */
  private input(chunk: Uint8Array): void {
    if (this.escapeTimer !== null) {
      clearTimeout(this.escapeTimer);
      this.escapeTimer = null;
    }
    const decoded = decodeKeys(chunk, this.pending);
    this.pending = decoded.pending;
    if (!this.keys(decoded.keys)) {
      return;
    }
    if (this.pending.length > 0) {
      this.escapeTimer = setTimeout(() => {
        this.escapeTimer = null;
        this.guard(() => {
          const keys = flushKeys(this.pending);
          this.pending = new Uint8Array(0);
          this.keys(keys);
        });
      }, this.escapeMs);
    }
  }

  /** Applies `keys`, then draws once; false when top stopped (a quit key). */
  private keys(keys: readonly Key[]): boolean {
    for (const key of keys) {
      this.ui = reduceKey(this.ui, key, this.model, this.options.terminal.size());
      if (this.ui.quit) {
        this.stop(null);
        return false;
      }
    }
    this.draw();
    return true;
  }

  /** Draws the current frame: every row after a resize or at first, else the rows that changed. */
  private draw(): void {
    if (this.stopped) {
      return;
    }
    const size = this.options.terminal.size();
    const frame = this.render(this.model, this.ui, size, this.now());
    const last = this.last;
    const full =
      last === null || last.size.columns !== size.columns || last.size.rows !== size.rows;
    let out = '';
    for (const [index, line] of frame.lines.entries()) {
      const runs = frame.styles[index] ?? [];
      if (
        !full &&
        line === last.frame.lines[index] &&
        sameRuns(runs, last.frame.styles[index] ?? [])
      ) {
        continue;
      }
      out += rowOutput(index, line, runs, this.color);
    }
    this.last = { frame, size };
    if (out !== '') {
      this.options.terminal.write(out);
    }
  }

  /** Restores the terminal, once. Synchronous (it runs on the process exit). */
  private restore(): void {
    if (this.restored) {
      return;
    }
    this.restored = true;
    const { terminal } = this.options;
    try {
      terminal.setRawMode(false);
    } finally {
      terminal.write(`${RESET}${SHOW_CURSOR}${LEAVE_ALT}`);
    }
  }

  /**
   * Stops, once: restores the terminal, removes every listener, clears the
   * timers, stops every feed and, once they have stopped, resolves (or
   * rejects with `failure.error`).
   */
  private stop(failure: { error: unknown } | null): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    let outcome = failure;
    try {
      this.restore();
    } catch (error) {
      outcome ??= { error };
    }
    for (const remove of this.removers.splice(0)) {
      remove();
    }
    if (this.escapeTimer !== null) {
      clearTimeout(this.escapeTimer);
      this.escapeTimer = null;
    }
    if (this.redrawTimer !== null) {
      clearInterval(this.redrawTimer);
      this.redrawTimer = null;
    }
    this.feed = null;
    for (const feed of this.feeds) {
      feed.controller.abort();
    }
    // After a microtask, so a feed stopped during its own synchronous first
    // tick has its promise recorded.
    void Promise.resolve()
      .then(() => Promise.all(this.feeds.map((feed) => feed.done)))
      .then(() => {
        if (outcome === null) {
          this.resolve();
        } else {
          this.reject(outcome.error);
        }
      });
  }
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
  void values;
  const { terminal } = io;
  if (
    terminal === undefined ||
    !terminal.stdinIsTTY ||
    !terminal.stdoutIsTTY ||
    ctx.env.TERM === 'dumb'
  ) {
    return Promise.reject(
      new BoardError(
        1,
        'not-a-tty',
        'agentboard top needs an interactive terminal: standard input and output must be a terminal, and TERM must not be dumb',
      ),
    );
  }
  let board: Board;
  try {
    board = ctx.board();
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  return runTop({
    ...deps,
    board,
    terminal,
    signal: io.signal,
    env: ctx.env,
    boardDir: board.dir,
  });
}
