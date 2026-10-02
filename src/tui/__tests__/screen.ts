/**
 * Test-only terminal for the `top` driver tests (add-board-tui design.md:
 * "Testing strategy"): an interpreter that understands exactly
 * the escape sequences the driver may emit and reconstructs the screen
 * from them, and a fake `TerminalIo` built on it.
 *
 * The interpreter is written from the output protocol in
 * `src/tui/terminal.ts` and board-tui "Frame rendering", not from the
 * driver: anything outside the permitted set is recorded as a protocol
 * error (and otherwise ignored), so the restricted output set is itself
 * under test. Permitted: `ESC[?1049h`, `ESC[?1049l`, `ESC[?25l`,
 * `ESC[?25h`, `ESC[<row>;<col>H` (1-based, inside the screen), and SGR
 * `ESC[<p>(;<p>)*m` with each `<p>` one of 0, 1, 2, 7 and 30 to 37; text
 * is printable ASCII only, written only on the alternate screen and never
 * past the last column. Cells that were never written since the alternate
 * screen was entered or the terminal was resized are unknown (shown as
 * `\0`), so a comparison with a frame fails unless every cell was drawn.
 */

import { expect } from 'vitest';

import type { Color, Frame, Size, Style } from '../frame.js';
import type { TerminalIo } from '../terminal.js';

export const ESC = '\x1b';

/** The colors in SGR order (30 to 37). */
const COLORS: readonly Color[] = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
];

const DEFAULT_STYLE: Style = { bold: false, dim: false, inverse: false, color: null };

/** One screen cell: its character (null when unknown) and style. */
export interface Cell {
  char: string | null;
  style: Style;
}

/** One interpreted token, in output order. */
export type Token =
  | { kind: 'enter-alt' }
  | { kind: 'leave-alt' }
  | { kind: 'hide-cursor' }
  | { kind: 'show-cursor' }
  | { kind: 'move'; row: number; col: number }
  | { kind: 'sgr'; params: number[] }
  | { kind: 'text'; row: number; text: string };

/** Reconstructs the screen from the permitted escape sequences. */
export class ScreenInterpreter {
  columns: number;
  rows: number;
  cells: Cell[][] = [];
  /** Whether the alternate screen is active. */
  alt = false;
  /** Whether the cursor is visible (it is at the start). */
  cursorVisible = true;
  /** The current SGR state. */
  style: Style = { ...DEFAULT_STYLE };
  /** Cursor, 0-based. */
  row = 0;
  col = 0;
  /** Every token so far. */
  readonly tokens: Token[] = [];
  /** Everything outside the protocol, as messages. */
  readonly errors: string[] = [];
  /** Rows (0-based) that received text since the last `mark()`. */
  rowsWritten = new Set<number>();
  /** Bytes fed since the last `mark()`. */
  bytesSinceMark = 0;
  private pending = '';

  constructor(size: Size) {
    this.columns = size.columns;
    this.rows = size.rows;
    this.clear();
  }

  /** Every cell unknown. */
  private clear(): void {
    this.cells = Array.from({ length: this.rows }, () =>
      Array.from({ length: this.columns }, () => ({ char: null, style: { ...DEFAULT_STYLE } })),
    );
  }

  /** The terminal changed size: the whole screen becomes unknown. */
  resize(size: Size): void {
    this.columns = size.columns;
    this.rows = size.rows;
    this.row = Math.min(this.row, Math.max(0, this.rows - 1));
    this.col = 0;
    this.clear();
  }

  /** Starts a new observation window for `rowsWritten` and `bytesSinceMark`. */
  mark(): void {
    this.rowsWritten = new Set();
    this.bytesSinceMark = 0;
  }

  /** An escape sequence split across writes is still pending. */
  get incomplete(): boolean {
    return this.pending.length > 0;
  }

  feed(text: string): void {
    this.bytesSinceMark += text.length;
    const input = this.pending + text;
    this.pending = '';
    let i = 0;
    let run = '';
    const flushRun = (): void => {
      if (run.length > 0) {
        this.text(run);
        run = '';
      }
    };
    while (i < input.length) {
      const ch = input[i] ?? '';
      const code = ch.charCodeAt(0);
      if (ch !== ESC) {
        if (code >= 0x20 && code <= 0x7e) {
          run += ch;
        } else {
          flushRun();
          this.errors.push(`forbidden byte 0x${code.toString(16)}`);
        }
        i += 1;
        continue;
      }
      flushRun();
      // ESC must be followed by `[`, parameter bytes and one final byte.
      if (i + 1 >= input.length) {
        this.pending = input.slice(i);
        return;
      }
      if (input[i + 1] !== '[') {
        this.errors.push(`escape not followed by [: ${JSON.stringify(input.slice(i, i + 4))}`);
        i += 1;
        continue;
      }
      let j = i + 2;
      while (j < input.length) {
        const c = input.charCodeAt(j);
        if (c >= 0x40 && c <= 0x7e) {
          break;
        }
        j += 1;
      }
      if (j >= input.length) {
        this.pending = input.slice(i);
        return;
      }
      this.sequence(input.slice(i + 2, j), input[j] ?? '');
      i = j + 1;
    }
    flushRun();
  }

  private sequence(body: string, final: string): void {
    const whole = `ESC[${body}${final}`;
    if (final === 'h' || final === 'l') {
      if (body === '?1049') {
        if (final === 'h') {
          this.alt = true;
          this.clear();
          this.tokens.push({ kind: 'enter-alt' });
        } else {
          this.alt = false;
          this.tokens.push({ kind: 'leave-alt' });
        }
        return;
      }
      if (body === '?25') {
        this.cursorVisible = final === 'h';
        this.tokens.push({ kind: final === 'h' ? 'show-cursor' : 'hide-cursor' });
        return;
      }
    }
    if (final === 'H') {
      const match = /^([1-9][0-9]*);([1-9][0-9]*)$/.exec(body);
      if (match !== null) {
        const row = Number(match[1]);
        const col = Number(match[2]);
        if (row > this.rows || col > this.columns) {
          this.errors.push(`cursor outside the screen: ${whole}`);
          return;
        }
        this.row = row - 1;
        this.col = col - 1;
        this.tokens.push({ kind: 'move', row, col });
        return;
      }
    }
    if (final === 'm' && /^(0|1|2|7|3[0-7])(;(0|1|2|7|3[0-7]))*$/.test(body)) {
      const params = body.split(';').map(Number);
      for (const p of params) {
        if (p === 0) {
          this.style = { ...DEFAULT_STYLE };
        } else if (p === 1) {
          this.style = { ...this.style, bold: true };
        } else if (p === 2) {
          this.style = { ...this.style, dim: true };
        } else if (p === 7) {
          this.style = { ...this.style, inverse: true };
        } else {
          this.style = { ...this.style, color: COLORS[p - 30] ?? null };
        }
      }
      this.tokens.push({ kind: 'sgr', params });
      return;
    }
    this.errors.push(`sequence not permitted: ${whole}`);
  }

  private text(run: string): void {
    if (!this.alt) {
      this.errors.push(`text outside the alternate screen: ${JSON.stringify(run)}`);
      return;
    }
    const line = this.cells[this.row];
    for (const ch of run) {
      if (line === undefined || this.col >= this.columns) {
        this.errors.push(`text past the last column of row ${String(this.row + 1)}`);
        return;
      }
      line[this.col] = { char: ch, style: { ...this.style } };
      this.col += 1;
    }
    this.rowsWritten.add(this.row);
    this.tokens.push({ kind: 'text', row: this.row, text: run });
  }

  /** The screen text, one string per row; an unknown cell is `\0`. */
  lines(): string[] {
    return this.cells.map((line) => line.map((cell) => cell.char ?? '\0').join(''));
  }

  /** The whole screen text joined with newlines. */
  screenText(): string {
    return this.lines().join('\n');
  }

  /** The number of tokens of `kind`. */
  count(kind: Token['kind']): number {
    return this.tokens.filter((t) => t.kind === kind).length;
  }

  /** Whether any SGR parameter from 30 to 37 was written. */
  get usedColor(): boolean {
    return this.tokens.some((t) => t.kind === 'sgr' && t.params.some((p) => p >= 30 && p <= 37));
  }
}

/** A compact, comparable description of a style (`-` for the default). */
export function styleName(style: Style): string {
  const parts: string[] = [];
  if (style.bold) {
    parts.push('bold');
  }
  if (style.dim) {
    parts.push('dim');
  }
  if (style.inverse) {
    parts.push('inverse');
  }
  if (style.color !== null) {
    parts.push(style.color);
  }
  return parts.length === 0 ? '-' : parts.join('+');
}

/** Per line, the runs of equal styles as `<start>:<style>`. */
function runsOf(styles: readonly (readonly Style[])[]): string[] {
  return styles.map((line) => {
    const out: string[] = [];
    let previous = '';
    line.forEach((style, x) => {
      const name = styleName(style);
      if (name !== previous) {
        out.push(`${String(x)}:${name}`);
        previous = name;
      }
    });
    return out.join(' ');
  });
}

/** The per-cell styles of `frame`, colors dropped when `color` is false. */
export function frameCellStyles(frame: Frame, columns: number, color = true): Style[][] {
  return frame.lines.map((_, y) => {
    const cells: Style[] = Array.from({ length: columns }, () => ({ ...DEFAULT_STYLE }));
    for (const run of frame.styles[y] ?? []) {
      for (let x = run.start; x < run.start + run.length; x += 1) {
        cells[x] = { ...run.style, color: color ? run.style.color : null };
      }
    }
    return cells;
  });
}

/**
 * Asserts that the screen shows exactly `frame`: every cell known, the
 * same text and the same style (colors dropped when `color` is false), and
 * no protocol error so far.
 */
export function expectScreen(screen: ScreenInterpreter, frame: Frame, color = true): void {
  expect(screen.errors).toEqual([]);
  expect(screen.lines()).toEqual(frame.lines);
  const columns = frame.lines[0]?.length ?? 0;
  expect(runsOf(screen.cells.map((line) => line.map((cell) => cell.style)))).toEqual(
    runsOf(frameCellStyles(frame, columns, color)),
  );
}

/** Whether the screen shows exactly `frame` (text and styles), without failing. */
export function screenShows(screen: ScreenInterpreter, frame: Frame, color = true): boolean {
  const columns = frame.lines[0]?.length ?? 0;
  return (
    JSON.stringify(screen.lines()) === JSON.stringify(frame.lines) &&
    JSON.stringify(runsOf(screen.cells.map((line) => line.map((cell) => cell.style)))) ===
      JSON.stringify(runsOf(frameCellStyles(frame, columns, color)))
  );
}

/** The rows (0-based) whose text or styles differ between two frames of one size. */
export function changedRows(a: Frame, b: Frame): number[] {
  const out: number[] = [];
  const columns = a.lines[0]?.length ?? 0;
  const sa = runsOf(frameCellStyles(a, columns));
  const sb = runsOf(frameCellStyles(b, columns));
  a.lines.forEach((line, y) => {
    if (line !== b.lines[y] || sa[y] !== sb[y]) {
      out.push(y);
    }
  });
  return out;
}

/** One entry of the fake terminal's journal, in call order. */
export type JournalEntry =
  | { kind: 'write'; text: string }
  | { kind: 'raw'; on: boolean }
  | { kind: 'listen'; what: 'data' | 'end' | 'resize' | 'exit' }
  | { kind: 'unlisten'; what: 'data' | 'end' | 'resize' | 'exit' };

type Listener<T> = (value: T) => void;

/** A `TerminalIo` over a `ScreenInterpreter`, driven by the test. */
export class FakeTerminal implements TerminalIo {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  readonly screen: ScreenInterpreter;
  /** Every call, in order. */
  readonly journal: JournalEntry[] = [];
  /** Called with each written text (to interleave with other outputs). */
  onWriteHook: ((text: string) => void) | null = null;
  /** Whether raw mode is on. */
  raw = false;
  /**
   * The number of `onExit` listeners registered at the first terminal
   * change (the first write or raw mode call); null before any change.
   */
  exitListenersAtFirstChange: number | null = null;
  private current: Size;
  private readonly data = new Set<{ fn: Listener<Uint8Array> }>();
  private readonly ends = new Set<{ fn: () => void }>();
  private readonly resizes = new Set<{ fn: () => void }>();
  private readonly exits = new Set<{ fn: () => void }>();

  constructor(size: Size = { columns: 80, rows: 24 }, tty = { stdin: true, stdout: true }) {
    this.current = { ...size };
    this.screen = new ScreenInterpreter(size);
    this.stdinIsTTY = tty.stdin;
    this.stdoutIsTTY = tty.stdout;
  }

  private change(): void {
    this.exitListenersAtFirstChange ??= this.exits.size;
  }

  write(text: string): void {
    this.change();
    this.journal.push({ kind: 'write', text });
    this.screen.feed(text);
    this.onWriteHook?.(text);
  }

  size(): Size {
    return { ...this.current };
  }

  setRawMode(enabled: boolean): void {
    this.change();
    this.raw = enabled;
    this.journal.push({ kind: 'raw', on: enabled });
  }

  /** Adds a listener (each call is its own registration) and returns its remover. */
  private listen<T>(
    set: Set<{ fn: T }>,
    what: 'data' | 'end' | 'resize' | 'exit',
    fn: T,
  ): () => void {
    const entry = { fn };
    set.add(entry);
    this.journal.push({ kind: 'listen', what });
    return () => {
      if (set.delete(entry)) {
        this.journal.push({ kind: 'unlisten', what });
      }
    };
  }

  onData(listener: (chunk: Uint8Array) => void): () => void {
    return this.listen(this.data, 'data', listener);
  }

  onEnd(listener: () => void): () => void {
    return this.listen(this.ends, 'end', listener);
  }

  onResize(listener: () => void): () => void {
    return this.listen(this.resizes, 'resize', listener);
  }

  onExit(listener: () => void): () => void {
    return this.listen(this.exits, 'exit', listener);
  }

  /** Types input: a string is sent as its bytes (Latin-1, one byte per character). */
  type(input: string | Uint8Array): void {
    const bytes =
      typeof input === 'string' ? Uint8Array.from(input, (c) => c.charCodeAt(0)) : input;
    for (const entry of [...this.data]) {
      entry.fn(bytes);
    }
  }

  /** Resizes the terminal: the screen content becomes unknown, then listeners are told. */
  resize(size: Size): void {
    this.current = { ...size };
    this.screen.resize(size);
    for (const entry of [...this.resizes]) {
      entry.fn();
    }
  }

  /** Ends the input. */
  end(): void {
    for (const entry of [...this.ends]) {
      entry.fn();
    }
  }

  /** The process is exiting (an uncaught exception, for example). */
  exit(): void {
    for (const entry of [...this.exits]) {
      entry.fn();
    }
  }

  /** How many listeners of every kind are registered. */
  get listeners(): number {
    return this.data.size + this.ends.size + this.resizes.size + this.exits.size;
  }

  /** The raw mode calls, in order. */
  get rawCalls(): boolean[] {
    return this.journal.flatMap((e) => (e.kind === 'raw' ? [e.on] : []));
  }

  /** Everything written, concatenated. */
  get output(): string {
    return this.journal.map((e) => (e.kind === 'write' ? e.text : '')).join('');
  }

  /** Whether the terminal is back to normal: main screen, cursor shown, raw mode off. */
  get restored(): boolean {
    return !this.screen.alt && this.screen.cursorVisible && !this.raw;
  }
}

/**
 * Asserts the terminal was restored exactly once and nothing was written
 * after the restore: raw mode turned on once and off once (off last), the
 * alternate screen entered and left once, the cursor hidden and shown
 * once, the last screen token the leaving of the alternate screen or the
 * cursor or attribute reset of the restore, no listener left, no protocol
 * error.
 */
export function expectRestoredOnce(term: FakeTerminal): void {
  const { screen } = term;
  expect(screen.errors).toEqual([]);
  expect(screen.incomplete).toBe(false);
  expect(term.rawCalls).toEqual([true, false]);
  expect(screen.count('enter-alt')).toBe(1);
  expect(screen.count('leave-alt')).toBe(1);
  expect(screen.count('hide-cursor')).toBe(1);
  expect(screen.count('show-cursor')).toBe(1);
  expect(term.restored).toBe(true);
  const leave = screen.tokens.findIndex((t) => t.kind === 'leave-alt');
  const after = screen.tokens.slice(leave + 1);
  expect(after.every((t) => t.kind === 'show-cursor' || t.kind === 'sgr')).toBe(true);
  // No text or cursor movement after the first restore token.
  const firstRestore = screen.tokens.findIndex(
    (t) => t.kind === 'show-cursor' || t.kind === 'leave-alt',
  );
  expect(
    screen.tokens.slice(firstRestore).filter((t) => t.kind === 'text' || t.kind === 'move'),
  ).toEqual([]);
  expect(term.listeners).toBe(0);
}

/** Waits until `check()` holds, polling every 5 ms, failing after `ms`. */
export async function until(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${String(ms)} ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Waits `ms` milliseconds. */
export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
