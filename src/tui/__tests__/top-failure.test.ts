/**
 * board-tui "Terminal restoration" scenario "Failure restores first"
 * through the whole CLI path (`runCliAsync`, the `top` registry entry,
 * `topCommand`, `runTop`): the board feed is replaced with one whose first
 * tick after start-up fails with an integrity error, so the terminal must
 * be restored before the CLI prints the error and its hint, and the exit
 * code is 5.
 */

import { describe, expect, it, vi } from 'vitest';

import type { WatchBoardOptions } from '../../board/feed.js';
import { runCliAsync, type AsyncCliIo } from '../../cli/main.js';
import { cliEnv, project, run } from '../../cli/__tests__/cli-helpers.js';
import type { Board } from '../../store/board.js';
import { BoardError } from '../../store/errors.js';
import { FakeTerminal, expectRestoredOnce, until } from './screen.js';

const INTEGRITY = 'event file 00ff.json does not match its name';

vi.mock('../../board/feed.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../board/feed.js')>();
  return {
    ...actual,
    /** A feed whose first tick fails with an integrity error, 50 ms after it starts. */
    watchBoard: (board: Board, options: WatchBoardOptions): Promise<void> => {
      void board;
      return new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          const error = new BoardError(5, 'integrity', INTEGRITY);
          if (options.onProblem !== undefined) {
            options.onProblem(error);
          } else {
            reject(error);
          }
        }, 50);
        options.signal.addEventListener(
          'abort',
          () => {
            resolve();
          },
          { once: true },
        );
      });
    },
  };
});

function start(argv: readonly string[], cwd: string, term: FakeTerminal) {
  const journal: { stream: 'terminal' | 'stdout' | 'stderr'; text: string }[] = [];
  term.onWriteHook = (text) => journal.push({ stream: 'terminal', text });
  const io: AsyncCliIo = {
    argv,
    cwd,
    env: cliEnv({ TERM: 'xterm-256color', NO_COLOR: undefined }),
    stdout: (text) => journal.push({ stream: 'stdout', text }),
    stderr: (text) => journal.push({ stream: 'stderr', text }),
    stopSignal: () => new AbortController().signal,
    terminal: () => Promise.resolve(term),
  };
  return { journal, done: runCliAsync(io).then((code) => Number(code)) };
}

describe('scenario: Failure restores first', () => {
  it.each([[['top']], [['top', '--json']]])(
    '%j: restores the terminal, then prints the error and its hint, and exits 5',
    async (argv) => {
      const { root } = project();
      expect(run(['new', 'x', '--adhoc', 'test', '--as', 'orch'], root).code).toBe(0);
      const term = new FakeTerminal();
      const { journal, done } = start(argv, root, term);
      await until(() => term.raw, 5000, 'top to start');
      expect(await done).toBe(5);
      expectRestoredOnce(term);
      const leave = journal.findIndex(
        (e) => e.stream === 'terminal' && e.text.includes('\x1b[?1049l'),
      );
      const firstError = journal.findIndex((e) => e.stream !== 'terminal');
      expect(leave).toBeGreaterThanOrEqual(0);
      expect(firstError).toBeGreaterThan(leave);
      const stderr = journal
        .filter((e) => e.stream === 'stderr')
        .map((e) => e.text)
        .join('');
      expect(stderr).toContain(`agentboard: ${INTEGRITY}\n`);
      expect(stderr).toMatch(/^hint: .*'agentboard rebuild --check'/m);
      const stdout = journal
        .filter((e) => e.stream === 'stdout')
        .map((e) => e.text)
        .join('');
      if (argv.includes('--json')) {
        expect(JSON.parse(stdout)).toMatchObject({
          error: { exitCode: 5, reason: 'integrity', message: INTEGRITY },
        });
      } else {
        expect(stdout).toBe('');
      }
    },
  );
});
