/**
 * A scripted fake terminal for the prompt tests (add-harness-integration
 * task 5.1): it plays the user, answering each question when the command
 * starts listening for it, and records what was written and whether
 * standard input was ever listened to.
 */

import type { PromptTerminal } from '../prompt.js';

/**
 * One scripted answer: the chunks delivered, in order, once the command
 * listens for it (`onData`), then, when `end` is true, the end of the
 * input. `hang` delivers nothing until `ScriptedTerminal.finish` is
 * called.
 */
export type Scripted =
  { readonly chunks: readonly (string | Uint8Array)[]; readonly end?: boolean } | 'hang';

/** A line typed and ended with Enter. */
export function typed(text: string): Scripted {
  return { chunks: [`${text}\n`] };
}

/** The end of the input (Ctrl-D on an empty line) with nothing typed. */
export const EOF: Scripted = { chunks: [], end: true };

/** Text without a line end, then the end of the input. */
export function partialThenEof(text: string): Scripted {
  return { chunks: [text], end: true };
}

export class ScriptedTerminal implements PromptTerminal {
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  /** Everything written to stdout, by the terminal and by the command's stdout, in order. */
  readonly log: string[];
  /** Number of `onData` calls (each is one question being listened for). */
  dataListens = 0;
  /** Number of `onEnd` calls. */
  endListens = 0;
  /** `onData` and `onEnd` listeners currently registered. */
  active = 0;
  /** Texts passed to `write`, in order. */
  readonly writes: string[] = [];
  private readonly script: Scripted[];
  private dataListeners = new Set<(chunk: Uint8Array) => void>();
  private endListeners = new Set<() => void>();
  private hanging = false;

  constructor(
    script: readonly Scripted[],
    options: { stdin?: boolean; stdout?: boolean; log?: string[] } = {},
  ) {
    this.script = [...script];
    this.stdinIsTTY = options.stdin ?? true;
    this.stdoutIsTTY = options.stdout ?? true;
    this.log = options.log ?? [];
  }

  /** True when the command ever listened to standard input. */
  get read(): boolean {
    return this.dataListens > 0 || this.endListens > 0;
  }

  /** Scripted answers not yet used. */
  get remaining(): number {
    return this.script.length;
  }

  /** True while a `hang` answer is waiting for `finish`. */
  get waiting(): boolean {
    return this.hanging;
  }

  write(text: string): void {
    this.writes.push(text);
    this.log.push(text);
  }

  onData(listener: (chunk: Uint8Array) => void): () => void {
    this.dataListens += 1;
    this.active += 1;
    this.dataListeners.add(listener);
    const next = this.script.shift();
    if (next === 'hang') {
      this.hanging = true;
    } else if (next !== undefined) {
      void this.deliver(next);
    }
    let removed = false;
    return () => {
      if (!removed) {
        removed = true;
        this.active -= 1;
        this.dataListeners.delete(listener);
      }
    };
  }

  onEnd(listener: () => void): () => void {
    this.endListens += 1;
    this.active += 1;
    this.endListeners.add(listener);
    let removed = false;
    return () => {
      if (!removed) {
        removed = true;
        this.active -= 1;
        this.endListeners.delete(listener);
      }
    };
  }

  /** Answers a `hang` question with `answer`. */
  finish(answer: Scripted = EOF): void {
    this.hanging = false;
    if (answer !== 'hang') {
      void this.deliver(answer);
    }
  }

  private async deliver(answer: Exclude<Scripted, 'hang'>): Promise<void> {
    for (const chunk of answer.chunks) {
      await tick();
      const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
      for (const listener of [...this.dataListeners]) {
        listener(bytes);
      }
    }
    if (answer.end === true) {
      await tick();
      for (const listener of [...this.endListeners]) {
        listener();
      }
    }
  }
}

/** One turn of the event loop. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Waits until `condition` holds, failing after `ms`. */
export async function until(condition: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
