/**
 * The prompt helpers of `src/cli/prompt.ts` (add-harness-integration task
 * 5.1; design.md decision 8 and "Rulings from task group 5 (test
 * author)"): `askLine` over a scripted terminal (line ends, the end of
 * the input mid-line, the 4096-byte limit, chunking, typed-ahead input,
 * listener removal), `parseYesNo`, and `processPromptTerminal` over a fake
 * host (nothing read or listened to until asked, raw mode never touched).
 */

import { describe, expect, it } from 'vitest';

import {
  INIT_QUESTION,
  PROMPT_LINE_LIMIT,
  askLine,
  parseYesNo,
  processPromptTerminal,
  type PromptHost,
  type PromptHostInput,
} from '../prompt.js';
import { GITHUB_TOKEN } from '../../__tests__/harness/secret-fixtures.js';
import { EOF, ScriptedTerminal, partialThenEof, typed, until } from './prompt-helpers.js';

/** U+00E9, built so the source stays ASCII. */
const E_ACUTE = String.fromCharCode(0xe9);

describe('askLine', () => {
  it('writes the question once, before listening, and resolves the typed line', async () => {
    const term = new ScriptedTerminal([typed('1,3')]);
    const answer = await askLine(term, 'Which? ');
    expect(answer).toEqual({ kind: 'line', text: '1,3' });
    expect(term.writes).toEqual(['Which? ']);
    expect(term.dataListens).toBe(1);
  });

  it('removes its listeners once answered, so the process can exit', async () => {
    for (const script of [typed('y'), EOF, { chunks: ['x'.repeat(PROMPT_LINE_LIMIT + 1)] }]) {
      const term = new ScriptedTerminal([script]);
      await askLine(term, 'Q? ');
      expect(term.active).toBe(0);
    }
  });

  it('resolves an empty line (Enter) as an empty answer', async () => {
    expect(await askLine(new ScriptedTerminal([typed('')]), 'Q? ')).toEqual({
      kind: 'line',
      text: '',
    });
  });

  it('drops one carriage return before the line feed, and keeps any other', async () => {
    expect(await askLine(new ScriptedTerminal([{ chunks: ['y\r\n'] }]), 'Q? ')).toEqual({
      kind: 'line',
      text: 'y',
    });
    expect(await askLine(new ScriptedTerminal([{ chunks: ['a\rb\r\r\n'] }]), 'Q? ')).toEqual({
      kind: 'line',
      text: 'a\rb\r',
    });
  });

  it('assembles a line from several chunks', async () => {
    const term = new ScriptedTerminal([{ chunks: ['1', ',', ' 3', '\n'] }]);
    expect(await askLine(term, 'Q? ')).toEqual({ kind: 'line', text: '1, 3' });
  });

  it('decodes a character split across chunks whole', async () => {
    const bytes = new TextEncoder().encode(`caf${E_ACUTE}`);
    const term = new ScriptedTerminal([
      { chunks: [bytes.subarray(0, 4), bytes.subarray(4), '\n'] },
    ]);
    expect(await askLine(term, 'Q? ')).toEqual({ kind: 'line', text: `caf${E_ACUTE}` });
  });

  it('uses only the first line: input typed ahead is dropped', async () => {
    const term = new ScriptedTerminal([{ chunks: ['n\ny\n1,3\n'] }]);
    expect(await askLine(term, 'Q? ')).toEqual({ kind: 'line', text: 'n' });
  });

  it('resolves end when the input ends before a line end, dropping partial text', async () => {
    expect(await askLine(new ScriptedTerminal([EOF]), 'Q? ')).toEqual({ kind: 'end' });
    expect(await askLine(new ScriptedTerminal([partialThenEof('y')]), 'Q? ')).toEqual({
      kind: 'end',
    });
  });

  it('accepts a line of exactly the limit', async () => {
    const text = 'a'.repeat(PROMPT_LINE_LIMIT);
    expect(await askLine(new ScriptedTerminal([typed(text)]), 'Q? ')).toEqual({
      kind: 'line',
      text,
    });
  });

  it('resolves too-long once the limit is passed, without waiting for a line end or the end', async () => {
    expect(PROMPT_LINE_LIMIT).toBe(4096);
    // Never ended and never terminated: only the limit can resolve it.
    const term = new ScriptedTerminal([{ chunks: ['b'.repeat(1000), 'b'.repeat(3097)] }]);
    expect(await askLine(term, 'Q? ')).toEqual({ kind: 'too-long' });
    expect(term.active).toBe(0);
  });

  it('counts the limit in bytes, not characters', async () => {
    // 2049 two-byte characters are 4098 bytes.
    const term = new ScriptedTerminal([{ chunks: [E_ACUTE.repeat(2049)] }]);
    expect(await askLine(term, 'Q? ')).toEqual({ kind: 'too-long' });
  });

  it('handles a 1 MB line in many chunks without buffering it', async () => {
    const chunk = 'z'.repeat(65_536);
    const term = new ScriptedTerminal([{ chunks: Array.from({ length: 16 }, () => chunk) }]);
    expect(await askLine(term, 'Q? ')).toEqual({ kind: 'too-long' });
  });

  it('never writes any part of the answer', async () => {
    const secret = GITHUB_TOKEN;
    for (const script of [
      typed(secret),
      partialThenEof(secret),
      { chunks: [secret.repeat(200)] },
    ]) {
      const term = new ScriptedTerminal([script]);
      await askLine(term, 'Q? ');
      expect(term.writes.join('')).toBe('Q? ');
    }
  });

  it('does not resolve while waiting for the answer', async () => {
    const term = new ScriptedTerminal(['hang']);
    let settled = false;
    const pending = askLine(term, 'Q? ').then((answer) => {
      settled = true;
      return answer;
    });
    await until(() => term.dataListens === 1, 2000, 'the listener');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    term.finish(typed('n'));
    expect(await pending).toEqual({ kind: 'line', text: 'n' });
  });
});

describe('parseYesNo', () => {
  it.each(['y', 'Y', 'yes', 'YES', 'Yes', 'yEs', '', ' ', '\t', ' y ', '\tyes\t'])(
    '%j is yes',
    (answer) => {
      expect(parseYesNo(answer)).toBe('yes');
    },
  );

  it.each(['n', 'N', 'no', 'NO', 'No', ' n', 'no\t'])('%j is no', (answer) => {
    expect(parseYesNo(answer)).toBe('no');
  });

  it.each([
    'ye',
    'yess',
    'nope',
    'y n',
    'y,',
    '1',
    'ok',
    'true',
    '\u0003',
    '\u001b[A',
    'y\r',
    String.fromCharCode(0xfd),
    GITHUB_TOKEN,
  ])('%j is neither', (answer) => {
    expect(parseYesNo(answer)).toBeNull();
  });
});

describe('INIT_QUESTION', () => {
  it('is the question of the spec, with no line end', () => {
    expect(INIT_QUESTION).toBe('Install agent guidance now? [Y/n] ');
  });
});

/** A fake process for `processPromptTerminal`, recording every call. */
function fakeHost(options: { stdinTTY?: boolean; stdoutTTY?: boolean; unref?: boolean } = {}): {
  host: PromptHost;
  calls: string[];
  written: string[];
  emit(event: 'data' | 'end', chunk?: unknown): void;
  listeners(event: 'data' | 'end'): number;
} {
  const calls: string[] = [];
  const written: string[] = [];
  const handlers = {
    data: new Set<(chunk?: unknown) => void>(),
    end: new Set<(chunk?: unknown) => void>(),
  };
  const input: PromptHostInput = {
    isTTY: options.stdinTTY ?? true,
    on: (event, listener) => {
      calls.push(`on ${event}`);
      handlers[event].add(listener);
    },
    off: (event, listener) => {
      calls.push(`off ${event}`);
      handlers[event].delete(listener);
    },
    pause: () => {
      calls.push('pause');
    },
    ...(options.unref === false
      ? {}
      : {
          unref: () => {
            calls.push('unref');
          },
        }),
  };
  // setRawMode is present to catch any use of it.
  Object.assign(input, {
    setRawMode: () => {
      calls.push('setRawMode');
    },
  });
  const host: PromptHost = {
    stdin: () => {
      calls.push('stdin');
      return input;
    },
    stdinIsTTY: options.stdinTTY ?? true,
    stdout: {
      isTTY: options.stdoutTTY ?? true,
      write: (text) => {
        written.push(text);
      },
    },
  };
  return {
    host,
    calls,
    written,
    emit: (event, chunk) => {
      for (const listener of [...handlers[event]]) {
        listener(chunk);
      }
    },
    listeners: (event) => handlers[event].size,
  };
}

describe('processPromptTerminal', () => {
  it('reads the TTY flags at creation and touches nothing else', () => {
    for (const [stdinTTY, stdoutTTY] of [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ] as const) {
      const fake = fakeHost({ stdinTTY, stdoutTTY });
      const term = processPromptTerminal(fake.host);
      expect(term.stdinIsTTY).toBe(stdinTTY);
      expect(term.stdoutIsTTY).toBe(stdoutTTY);
      expect(fake.calls).toEqual([]);
    }
  });

  it('writes to stdout', () => {
    const fake = fakeHost();
    processPromptTerminal(fake.host).write('Q? ');
    expect(fake.written).toEqual(['Q? ']);
    expect(fake.calls).toEqual([]);
  });

  it('passes data as bytes, and its remover stops reading', () => {
    const fake = fakeHost();
    const term = processPromptTerminal(fake.host);
    const got: Uint8Array[] = [];
    const remove = term.onData((chunk) => got.push(chunk));
    expect(fake.listeners('data')).toBe(1);
    fake.emit('data', new Uint8Array([0x79, 0x0a]));
    fake.emit('data', 'n\n');
    expect(got.map((b) => Buffer.from(b).toString('utf8'))).toEqual(['y\n', 'n\n']);
    remove();
    expect(fake.listeners('data')).toBe(0);
    expect(fake.calls).toContain('pause');
    expect(fake.calls).toContain('unref');
    expect(fake.calls).not.toContain('setRawMode');
  });

  it('works on a stream without unref', () => {
    const fake = fakeHost({ unref: false });
    const remove = processPromptTerminal(fake.host).onData(() => undefined);
    remove();
    expect(fake.calls).toContain('pause');
  });

  it('reports the end of the input and removes exactly its listener', () => {
    const fake = fakeHost();
    const term = processPromptTerminal(fake.host);
    let ended = 0;
    const remove = term.onEnd(() => {
      ended += 1;
    });
    fake.emit('end');
    expect(ended).toBe(1);
    remove();
    expect(fake.listeners('end')).toBe(0);
    fake.emit('end');
    expect(ended).toBe(1);
  });

  it('creates the stdin stream at most once', () => {
    const fake = fakeHost();
    const term = processPromptTerminal(fake.host);
    term.onData(() => undefined)();
    term.onEnd(() => undefined)();
    term.onData(() => undefined)();
    expect(fake.calls.filter((call) => call === 'stdin')).toHaveLength(1);
  });

  it('answers askLine end to end over the fake host', async () => {
    const fake = fakeHost();
    const term = processPromptTerminal(fake.host);
    const pending = askLine(term, INIT_QUESTION);
    await until(() => fake.listeners('data') === 1, 2000, 'the data listener');
    fake.emit('data', Buffer.from('yes\n'));
    expect(await pending).toEqual({ kind: 'line', text: 'yes' });
    expect(fake.written).toEqual([INIT_QUESTION]);
    expect(fake.listeners('data')).toBe(0);
    expect(fake.listeners('end')).toBe(0);
    expect(fake.calls).not.toContain('setRawMode');
  });
});
