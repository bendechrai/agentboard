/**
 * The questions `init` and `agents install` ask on an interactive terminal
 * (board-cli "Init offers to install agent guidance"; board-agent-guidance
 * "Installing guidance into a host project", the bare-project prompt;
 * add-harness-integration design.md decision 8 and "Rulings from task
 * group 5 (test author)").
 *
 * A question is asked only when standard input and standard output are
 * both terminals and `--json` is not given; anything else keeps the
 * non-interactive behaviour, and then standard input is never read. The
 * terminal is used in its normal (cooked)
 * mode: raw mode is never turned on, so the terminal's own line editing,
 * Ctrl-C (SIGINT, with Node's default behaviour: the process ends by the
 * signal before anything is installed) and Ctrl-D (end of input) work as
 * in any shell prompt. The CLI never writes any part of an answer it
 * read; what the terminal itself echoes while the user types is the
 * user's own input, not output of the CLI.
 */

/**
 * The terminal a question is asked on: `processPromptTerminal()` for the
 * executable, a fake in tests. A subset of `TerminalIo`
 * (`src/tui/terminal.ts`), so the two stay interchangeable.
 */
export interface PromptTerminal {
  /** Whether standard input is a TTY, read when the terminal was created. */
  readonly stdinIsTTY: boolean;
  /** Whether standard output is a TTY, read when the terminal was created. */
  readonly stdoutIsTTY: boolean;
  /** Writes text to standard output (the question and what precedes it). */
  write(text: string): void;
  /**
   * Calls `listener` with each chunk of input bytes as it arrives; the
   * first call starts reading standard input. Returns a function that
   * removes the listener and stops reading (so the process can exit).
   */
  onData(listener: (chunk: Uint8Array) => void): () => void;
  /** Calls `listener` when the input ends (end of file). Returns the remover. */
  onEnd(listener: () => void): () => void;
}

/** The input side of the process that `processPromptTerminal` uses (`process.stdin`). */
export interface PromptHostInput {
  readonly isTTY?: boolean;
  on(event: 'data' | 'end', listener: (chunk?: unknown) => void): unknown;
  off(event: 'data' | 'end', listener: (chunk?: unknown) => void): unknown;
  pause(): unknown;
  /** Present on a socket or TTY stream; lets the process exit while the stream is open. */
  unref?(): unknown;
}

/** The output side of the process that `processPromptTerminal` uses (`process.stdout`). */
export interface PromptHostOutput {
  readonly isTTY?: boolean;
  write(text: string): unknown;
}

/** What `processPromptTerminal` adapts; defaults to the real process. */
export interface PromptHost {
  /**
   * Returns the input stream. Called at most once, by the first `onData`
   * or `onEnd`; for the real process it is `() => process.stdin`, so a
   * command that asks nothing never creates the stdin stream.
   */
  stdin(): PromptHostInput;
  /**
   * Whether standard input is a TTY, known without reading it (for the
   * real process `tty.isatty(0)`).
   */
  readonly stdinIsTTY: boolean;
  readonly stdout: PromptHostOutput;
}

/**
 * The `PromptTerminal` of a process (`src/cli.ts` passes none, so the real
 * one: `process.stdout`, `tty.isatty(0)` and `process.stdin` created only
 * when first listened to). Creating it reads nothing and listens to
 * nothing.
 * - `stdinIsTTY`: `host.stdinIsTTY`; `stdoutIsTTY`: `host.stdout.isTTY ===
 *   true`; both read once, when the terminal is created.
 * - `write(text)`: `host.stdout.write(text)`.
 * - `onData(listener)`: listens to `host.stdin()` `data`, passing each
 *   chunk as a `Uint8Array` (a string chunk as its UTF-8 bytes); the
 *   remover removes exactly that listener, calls `pause()` and, when it
 *   exists, `unref()`.
 * - `onEnd(listener)`: `host.stdin()` `end`; the remover removes exactly
 *   that listener.
 * Raw mode is never touched.
 */
export function processPromptTerminal(host?: PromptHost): PromptTerminal {
  void host;
  throw new Error('not implemented: processPromptTerminal (task 5.2)');
}

/**
 * The most bytes of one answer: 4096, the line length of a Linux terminal
 * in canonical mode. More bytes without a line end make the answer
 * `too-long`, and reading stops there, so input of any length is never
 * buffered beyond this.
 */
export const PROMPT_LINE_LIMIT = 4096;

/**
 * One answer read by `askLine`:
 * - `line`: a line ended by `\n`; `text` is the line without the `\n` and
 *   without one `\r` directly before it (any other `\r` stays), decoded as
 *   UTF-8 (a character split across chunks is decoded whole; invalid bytes
 *   become U+FFFD). Exactly `PROMPT_LINE_LIMIT` bytes before the `\n` is
 *   still a line.
 * - `end`: the input ended before a line end. Any partial text typed
 *   before the end is dropped, never used as an answer.
 * - `too-long`: more than `PROMPT_LINE_LIMIT` bytes arrived without a line
 *   end; resolved as soon as the limit is passed, without waiting for the
 *   rest of the line or the end of the input.
 */
export type PromptAnswer =
  | { readonly kind: 'line'; readonly text: string }
  | { readonly kind: 'end' }
  | { readonly kind: 'too-long' };

/**
 * Asks one question: writes `question` with `terminal.write` (once, before
 * listening), then listens with `terminal.onData` and `terminal.onEnd`
 * (each once) until the first of: a line end (`line`), the end of the
 * input (`end`), or more than `PROMPT_LINE_LIMIT` bytes (`too-long`); then
 * removes both listeners and resolves. Bytes after the first line end,
 * in the same chunk or later, are dropped: input typed ahead is never the
 * answer to a later question. Writes nothing else, and never any part of
 * the answer. Never rejects for anything the input contains.
 */
export function askLine(terminal: PromptTerminal, question: string): Promise<PromptAnswer> {
  void terminal;
  void question;
  return Promise.reject(new Error('not implemented: askLine (task 5.2)'));
}

/**
 * The question `init` asks (board-cli "Init offers to install agent
 * guidance"), written as is, with no line end, after the board message.
 */
export const INIT_QUESTION = 'Install agent guidance now? [Y/n] ';

/**
 * The meaning of an answer to `INIT_QUESTION`: `yes` for `y`, `yes` or
 * the empty answer (Enter), `no` for `n` or `no`, in any case, after
 * removing spaces and tabs around the answer; null for anything else
 * (which `init` refuses without repeating it). Pure.
 */
export function parseYesNo(answer: string): 'yes' | 'no' | null {
  void answer;
  throw new Error('not implemented: parseYesNo (task 5.2)');
}
