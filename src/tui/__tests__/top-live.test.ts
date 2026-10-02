/**
 * The `top` driver on a real temporary board with the real snapshot loader
 * and board feed, on a fake terminal (board-tui: "Live updates" scenarios
 * "Comment from another process" and "Late arrival", "Top command": no
 * event and no cursor written). The writer is the built CLI in a child
 * process (run `npm run build` first when running vitest directly).
 *
 * Expected screens are `renderFrame` of a snapshot the test loads itself
 * over a second connection to the same board, with the UI state the test
 * computes with the pure UI functions (`state.ts` and `applyFeedMessage`).
 */

import { readdirSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { loadSnapshot } from '../../board/snapshot.js';
import { openBoard, type Board } from '../../store/board.js';
import { P, ev, putEvent, T1 } from '../../store/__tests__/helpers.js';
import type { BoardModel } from '../../view/types.js';
import { boardProject, oneDocument, runCliAsync } from '../../__tests__/harness/processes.js';
import { renderFrame, type Size } from '../frame.js';
import type { Key } from '../keys.js';
import { initialUi, reconcileUi, reduceKey, type UiState } from '../state.js';
import { runTop } from '../terminal.js';
import { FakeTerminal, expectScreen, screenShows, until } from './screen.js';

const SIZE: Size = { columns: 100, rows: 30 };
const TASK = ['--task', 'openspec:add-board-tui#2'];
const FEED: Key = { name: 'char', char: '2' };

const boards: Board[] = [];
afterEach(() => {
  for (const board of boards.splice(0)) {
    board.close();
  }
});

function open(dir: string): Board {
  const board = openBoard(dir);
  boards.push(board);
  return board;
}

/** The model a fresh snapshot of `dir` gives, loaded over its own connection. */
function modelOf(dir: string, late: string[] = []): BoardModel {
  const board = open(dir);
  return { ...loadSnapshot(board), late };
}

function cursorRows(board: Board): unknown {
  return {
    cursors: board.db.prepare('SELECT * FROM cursors').all(),
    seen: board.db.prepare('SELECT * FROM cursor_seen').all(),
  };
}

interface Session {
  term: FakeTerminal;
  controller: AbortController;
  done: Promise<void>;
  board: Board;
}

function startTop(boardDir: string, now: number): Session {
  const board = open(boardDir);
  const term = new FakeTerminal(SIZE);
  const controller = new AbortController();
  const done = runTop({
    board,
    terminal: term,
    signal: controller.signal,
    env: {},
    boardDir,
    now: () => now,
  });
  return { term, controller, done, board };
}

describe('live updates on a real board', () => {
  it(
    'scenario: Comment from another process: shown in the feed view within 3 seconds, with no key press',
    { timeout: 30_000 },
    async () => {
      const { root, boardDir, eventsDir } = boardProject();
      const created = await runCliAsync(
        ['new', 'Watched live', ...TASK, '--as', 'orch', '--json'],
        root,
      );
      expect(created.code, created.stderr).toBe(0);
      const id = (oneDocument(created) as { ticket: { id: string } }).ticket.id;
      const now = Date.now() + 60_000;
      const m0 = modelOf(boardDir);
      const session = startTop(boardDir, now);
      const { term } = session;
      await until(
        () => term.raw && term.screen.screenText().includes('Watched live'),
        5000,
        'the board',
      );
      term.type('2');
      const ui0: UiState = reduceKey(reconcileUi(initialUi(boardDir), m0), FEED, m0, SIZE);
      await until(
        () => screenShows(term.screen, renderFrame(m0, ui0, SIZE, now)),
        2000,
        'the feed view',
      );
      const filesBefore = readdirSync(eventsDir).length;
      const cursorsBefore = cursorRows(session.board);

      const comment = await runCliAsync(
        ['comment', id, '--as', 'impl', '--', 'hello from another process'],
        root,
      );
      expect(comment.code, comment.stderr).toBe(0);
      const written = Date.now();
      await until(
        () => term.screen.screenText().includes('commented: hello from another process'),
        3000,
        'the comment on the screen',
      );
      expect(Date.now() - written).toBeLessThan(3000);
      const m1 = modelOf(boardDir);
      expectScreen(term.screen, renderFrame(m1, reconcileUi(ui0, m1), SIZE, now));

      term.type('q');
      await session.done;
      // top wrote no event and no cursor: only the comment's file is new.
      expect(readdirSync(eventsDir).length).toBe(filesBefore + 1);
      expect(cursorRows(session.board)).toEqual(cursorsBefore);
      expect(cursorsBefore).toEqual({ cursors: [], seen: [] });
    },
  );

  it(
    'scenario: Late arrival: reloads, marks the event late, and applies later events once',
    { timeout: 30_000 },
    async () => {
      const { boardDir, eventsDir } = boardProject();
      putEvent(eventsDir, ev(P.create(T1, 'Late target'), 'orch', 1000));
      putEvent(eventsDir, ev(P.comment(T1, 'at 2000'), 'impl', 2000));
      const now = 1_700_000_000_000;
      const m0 = modelOf(boardDir);
      const session = startTop(boardDir, now);
      const { term } = session;
      await until(() => term.raw, 5000, 'top to start');
      term.type('2');
      const ui0: UiState = reduceKey(reconcileUi(initialUi(boardDir), m0), FEED, m0, SIZE);
      await until(
        () => screenShows(term.screen, renderFrame(m0, ui0, SIZE, now)),
        2000,
        'the feed view',
      );

      // Copied into events/ as sync would: behind the head.
      const late = putEvent(eventsDir, ev(P.comment(T1, 'at 1500'), 'remote', 1500));
      await until(
        () => term.screen.lines().some((line) => line.includes(' late remote ')),
        5000,
        'the late event marked late',
      );
      const m1 = modelOf(boardDir, [late]);
      const ui1 = reconcileUi(ui0, m1);
      expectScreen(term.screen, renderFrame(m1, ui1, SIZE, now));

      // A later event is an append after the reload, shown exactly once.
      putEvent(eventsDir, ev(P.comment(T1, 'at 3000'), 'impl', 3000));
      await until(
        () => term.screen.screenText().includes('commented: at 3000'),
        5000,
        'the next event',
      );
      const m2 = modelOf(boardDir, [late]);
      expectScreen(term.screen, renderFrame(m2, reconcileUi(ui1, m2), SIZE, now));
      expect(
        term.screen.lines().filter((line) => line.includes('commented: at 3000')),
      ).toHaveLength(1);

      session.controller.abort();
      await session.done;
      expect(term.restored).toBe(true);
    },
  );
});
