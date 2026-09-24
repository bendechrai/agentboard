/**
 * The UI state reducers (board-tui: "Keys"; add-board-tui task 1.1): table
 * tests of `reduceKey` for every key in every mode, the "Keys" scenarios,
 * and `reconcileUi`, including selection clamping when a column empties.
 */

import { describe, expect, it } from 'vitest';

import type { FoldInput } from '../../events/fold.js';
import { E, OTHER, TASK, model } from '../../view/__tests__/helpers.js';
import type { BoardModel } from '../../view/types.js';
import { renderFrame, type Size } from '../frame.js';
import type { Key } from '../keys.js';
import {
  VIEWS,
  initialUi,
  reconcileUi,
  reduceKey,
  type BoardSelection,
  type FeedSelection,
  type LaneSelection,
  type UiState,
} from '../state.js';
import { feedEntries } from '../../view/feed.js';
import { BOARD_DIR, NOW, T1, T2, T3, T4, T5, T6, T7, fixtureModel, START_UI } from './fixtures.js';

const char = (c: string): Key => ({ name: 'char', char: c });
const named = (name: Exclude<Key['name'], 'char'>): Key => ({ name });

/** Parses a key script: single characters, or `<name>` for a named key. */
function keys(script: string): Key[] {
  const out: Key[] = [];
  const pattern = /<([a-z-]+)>|([\s\S])/g;
  for (const match of script.matchAll(pattern)) {
    const name = match[1];
    out.push(name === undefined ? char(match[2] ?? '') : ({ name } as Key));
  }
  return out;
}

const SIZE: Size = { columns: 80, rows: 24 };
/** Body height at SIZE. */
const H = SIZE.rows - 2;

function press(ui: UiState, script: string, m: BoardModel, size: Size = SIZE): UiState {
  return keys(script).reduce((state, key) => reduceKey(state, key, m, size), ui);
}

const M = fixtureModel();

/** Fixture columns (closed hidden): todo [T4, T3], tests [T2], implementing [T1], review [T5], blocked [T6], merged []. */
const FIXTURE_COLUMNS: readonly (readonly string[])[] = [[T4, T3], [T2], [T1], [T5], [T6], []];
/** The board selection of fixture card (column, row), with its ticket id. */
const at = (column: number, row: number): BoardSelection => ({
  column,
  row,
  ticket: FIXTURE_COLUMNS[column]?.[row] ?? null,
});
/** Fixture feed entries, newest first (computed with the view-model, not the code under test). */
const ENTRIES = feedEntries(M);
const feedSel = (index: number): FeedSelection => ({ index, hash: ENTRIES[index]?.hash ?? null });
/** Fixture lanes in order. */
const LANES = ['impl', 'orch', 'test-author', 'rev'];
const laneSel = (index: number): LaneSelection => ({ index, actor: LANES[index] ?? null });

/** `initialUi(BOARD_DIR)` after `reconcileUi` with the fixture model. */
const START: UiState = { ...START_UI, board: at(0, 0), feed: feedSel(0), lanes: laneSel(0) };

/**
 * A board for the "Open and close a detail" scenario: two cards in todo,
 * none in tests, three in implementing (T3 most recently updated, then
 * T2, then T1).
 */
function scenarioModel(): BoardModel {
  const inputs: FoldInput[] = [
    E.create(T4, { title: 'four', task: TASK }, { wall: 100 }),
    E.create(T5, { title: 'five', task: TASK }, { wall: 110 }),
    E.create(T1, { title: 'one', task: TASK }, { wall: 200 }),
    E.create(T2, { title: 'two', task: TASK }, { wall: 210 }),
    E.create(T3, { title: 'three', task: TASK }, { wall: 220 }),
  ];
  for (const [ticket, wall] of [
    [T1, 300],
    [T2, 310],
    [T3, 320],
  ] as const) {
    inputs.push(
      E.move(ticket, 'tests', { wall }),
      E.move(ticket, 'implementing', { wall: wall + 1 }),
    );
  }
  return model(inputs);
}

describe('initialUi', () => {
  it('starts on the board with everything at rest', () => {
    expect(initialUi('/some/dir')).toEqual({
      boardDir: '/some/dir',
      view: 'board',
      board: { column: 0, row: 0, ticket: null },
      feed: { index: 0, hash: null },
      lanes: { index: 0, actor: null },
      detail: null,
      showClosed: false,
      help: false,
      notice: null,
      quit: false,
    });
    expect(initialUi(BOARD_DIR)).toEqual(START_UI);
    expect([...VIEWS]).toEqual(['board', 'feed', 'lanes']);
  });
});

describe('reduceKey: scenario "Open and close a detail"', () => {
  it('l, l, j, Enter opens the second card of the third column; Escape closes it and keeps it selected', () => {
    const m = scenarioModel();
    const opened = press(START, 'llj<enter>', m);
    expect(opened.board).toEqual({ column: 2, row: 1, ticket: T2 });
    expect(opened.detail).toEqual({ ticket: T2, scroll: 0 });
    const closed = press(opened, '<escape>', m);
    expect(closed.detail).toBeNull();
    expect(closed.board).toEqual({ column: 2, row: 1, ticket: T2 });
    expect(closed.view).toBe('board');
  });

  it('the same with the arrow keys, and Backspace closing', () => {
    const m = scenarioModel();
    const opened = press(START, '<right><right><down><enter>', m);
    expect(opened.detail).toEqual({ ticket: T2, scroll: 0 });
    expect(press(opened, '<backspace>', m)).toEqual({ ...opened, detail: null });
  });
});

describe('reduceKey: scenario "Unknown key"', () => {
  const states: [string, UiState][] = [
    ['board', START],
    ['feed', { ...START, view: 'feed', feed: feedSel(3) }],
    ['lanes', { ...START, view: 'lanes', lanes: laneSel(1) }],
    ['detail', { ...START, detail: { ticket: T1, scroll: 1 } }],
    ['help', { ...START, help: true }],
  ];
  it.each(states)('z is ignored in %s: the same state object and the same frame', (_label, ui) => {
    const next = reduceKey(ui, char('z'), M, SIZE);
    expect(next).toBe(ui);
    expect(renderFrame(M, next, SIZE, NOW)).toEqual(renderFrame(M, ui, SIZE, NOW));
  });

  it.each([
    ['x', char('x')],
    ['Q (upper case)', char('Q')],
    ['C (upper case)', char('C')],
    ['4', char('4')],
    ['space', char(' ')],
    ['page up on the board', named('pageup')],
    ['page down on the board', named('pagedown')],
    ['escape with nothing open', named('escape')],
    ['backspace with nothing open', named('backspace')],
  ])('%s is ignored on the board', (_label, key) => {
    expect(reduceKey(START, key, M, SIZE)).toBe(START);
  });
});

describe('reduceKey: quit', () => {
  it.each([
    ['board', START],
    ['detail', { ...START, detail: { ticket: T1, scroll: 0 } }],
    ['help', { ...START, help: true }],
    ['feed', { ...START, view: 'feed' as const }],
  ])('q and Ctrl-C set quit in %s and change nothing else', (_label, ui) => {
    expect(reduceKey(ui, char('q'), M, SIZE)).toEqual({ ...ui, quit: true });
    expect(reduceKey(ui, named('ctrl-c'), M, SIZE)).toEqual({ ...ui, quit: true });
  });
});

describe('reduceKey: help', () => {
  it('? opens the help and ? or Escape closes it', () => {
    const open = reduceKey(START, char('?'), M, SIZE);
    expect(open).toEqual({ ...START, help: true });
    expect(reduceKey(open, char('?'), M, SIZE)).toEqual(START);
    expect(reduceKey(open, named('escape'), M, SIZE)).toEqual(START);
  });

  it('ignores every other key while the help is shown', () => {
    const open = { ...START, help: true };
    for (const key of keys('jkhl123c<tab><enter><backspace><pagedown><down>')) {
      expect(reduceKey(open, key, M, SIZE)).toBe(open);
    }
  });

  it('opens over a detail and closing it leaves the detail open', () => {
    const detail = { ...START, detail: { ticket: T1, scroll: 1 } };
    const help = reduceKey(detail, char('?'), M, SIZE);
    expect(help).toEqual({ ...detail, help: true });
    expect(reduceKey(help, named('escape'), M, SIZE)).toEqual(detail);
  });
});

describe('reduceKey: views', () => {
  it('1, 2 and 3 select the board, feed and lanes views', () => {
    expect(press(START, '2', M).view).toBe('feed');
    expect(press(START, '3', M).view).toBe('lanes');
    expect(press(START, '31', M).view).toBe('board');
  });

  it('Tab cycles board, feed, lanes, board', () => {
    expect(press(START, '<tab>', M).view).toBe('feed');
    expect(press(START, '<tab><tab>', M).view).toBe('lanes');
    expect(press(START, '<tab><tab><tab>', M).view).toBe('board');
  });

  it('selecting the current view with no detail open is ignored', () => {
    expect(reduceKey(START, char('1'), M, SIZE)).toBe(START);
    const feed = { ...START, view: 'feed' as const };
    expect(reduceKey(feed, char('2'), M, SIZE)).toBe(feed);
  });

  it('a view key closes an open detail, also for the current view', () => {
    const detail = { ...START, detail: { ticket: T1, scroll: 2 } };
    expect(reduceKey(detail, char('1'), M, SIZE)).toEqual({ ...START });
    expect(reduceKey(detail, char('2'), M, SIZE)).toEqual({ ...START, view: 'feed' });
    expect(reduceKey(detail, named('tab'), M, SIZE)).toEqual({ ...START, view: 'feed' });
  });

  it('keeps each view selection across view switches', () => {
    const ui = press(START, 'lj2jjj3j1', M);
    expect(ui.view).toBe('board');
    expect(ui.board).toEqual(at(1, 0));
    expect(ui.feed).toEqual(feedSel(3));
    expect(ui.lanes).toEqual(laneSel(1));
  });
});

describe('reduceKey: board view', () => {
  // Fixture columns (closed hidden): todo [T4, T3], tests [T2],
  // implementing [T1], review [T5], blocked [T6], merged [].

  it('h and left stop at the first column', () => {
    expect(press(START, 'h', M).board).toEqual(at(0, 0));
    expect(press(START, '<left>', M).board).toEqual(at(0, 0));
    expect(press(START, 'llh', M).board).toEqual(at(1, 0));
  });

  it('l and right stop at the last column', () => {
    expect(press(START, 'lllllll', M).board).toEqual(at(5, 0));
    expect(press(START, '<right><right><right><right><right><right>', M).board).toEqual(at(5, 0));
  });

  it('j and k move within the column and stop at its ends', () => {
    expect(press(START, 'j', M).board).toEqual(at(0, 1));
    expect(press(START, '<down><down><down>', M).board).toEqual(at(0, 1));
    expect(press(START, 'jk', M).board).toEqual(at(0, 0));
    expect(press(START, '<up>', M).board).toEqual(at(0, 0));
  });

  it('clamps the row to the new column when moving sideways', () => {
    expect(press(START, 'jl', M).board).toEqual(at(1, 0));
    expect(press(START, 'jlllll', M).board).toEqual(at(5, 0));
  });

  it('Enter opens the selected card', () => {
    expect(press(START, '<enter>', M).detail).toEqual({ ticket: T4, scroll: 0 });
    expect(press(START, 'j<enter>', M).detail).toEqual({ ticket: T3, scroll: 0 });
    expect(press(START, 'lll<enter>', M).detail).toEqual({ ticket: T5, scroll: 0 });
  });

  it('Enter on an empty column is ignored', () => {
    const merged = press(START, 'lllll', M);
    expect(reduceKey(merged, named('enter'), M, SIZE)).toBe(merged);
  });

  it('c toggles closed tickets, so the merged column gains its closed card', () => {
    const shown = press(START, 'lllllc', M);
    expect(shown.showClosed).toBe(true);
    expect(press(shown, '<enter>', M).detail).toEqual({ ticket: T7, scroll: 0 });
    expect(press(shown, 'c', M).showClosed).toBe(false);
  });

  it('c keeps the selected card selected when it stays listed, and clamps when it is hidden', () => {
    // blocked holds T6 (open) and T7 (closed, more recently updated).
    const m = model([
      E.create(T6, { title: 'open blocked', task: TASK }, { wall: 100 }),
      E.create(T7, { title: 'closed blocked', task: OTHER }, { wall: 110 }),
      E.move(T6, 'blocked', { wall: 200 }),
      E.move(T7, 'blocked', { wall: 210 }),
      E.close(T7, { noDecision: true }, { wall: 220 }),
    ]);
    // T6 selected at row 1 with closed shown: hiding T7 moves T6 to row 0.
    const onOpen = { ...START, showClosed: true, board: { column: 4, row: 1, ticket: T6 } };
    const hiddenOpen = reduceKey(onOpen, char('c'), m, SIZE);
    expect(hiddenOpen.showClosed).toBe(false);
    expect(hiddenOpen.board).toEqual({ column: 4, row: 0, ticket: T6 });
    // T7 selected: hidden, so the row clamps and T6 becomes the selection.
    const onClosed = { ...START, showClosed: true, board: { column: 4, row: 0, ticket: T7 } };
    const hiddenClosed = reduceKey(onClosed, char('c'), m, SIZE);
    expect(hiddenClosed.showClosed).toBe(false);
    expect(hiddenClosed.board).toEqual({ column: 4, row: 0, ticket: T6 });
    // Showing closed again: T6 is followed to row 1.
    const hidden = { ...START, board: { column: 4, row: 0, ticket: T6 } };
    expect(reduceKey(hidden, char('c'), m, SIZE).board).toEqual({ column: 4, row: 1, ticket: T6 });
  });

  it('c works with a detail open and keeps it open', () => {
    const detail = { ...START, detail: { ticket: T1, scroll: 1 } };
    expect(reduceKey(detail, char('c'), M, SIZE)).toEqual({ ...detail, showClosed: true });
  });
});

describe('reduceKey: detail', () => {
  // The detail of T1 has 24 lines at 80 columns (see frame.test.ts), so at
  // 80x24 (H = 22) the greatest scroll is 2; at 140x40 everything fits.
  const open = { ...START, detail: { ticket: T1, scroll: 0 } };

  it('j and down scroll by one line, k and up back, clamped to the content', () => {
    expect(press(open, 'j', M).detail).toEqual({ ticket: T1, scroll: 1 });
    expect(press(open, '<down><down>', M).detail).toEqual({ ticket: T1, scroll: 2 });
    expect(press(open, 'jjjjj', M).detail).toEqual({ ticket: T1, scroll: 2 });
    expect(press(open, 'jjk', M).detail).toEqual({ ticket: T1, scroll: 1 });
    expect(press(open, 'k<up>', M).detail).toEqual({ ticket: T1, scroll: 0 });
  });

  it('page down and page up move by the body height, clamped', () => {
    expect(press(open, '<pagedown>', M).detail).toEqual({ ticket: T1, scroll: 2 });
    expect(press(open, '<pagedown><pageup>', M).detail).toEqual({ ticket: T1, scroll: 0 });
  });

  it('pages by exactly the body height in a long detail', () => {
    const inputs: FoldInput[] = [E.create(T1, { title: 'long', task: TASK }, { wall: 100 })];
    for (let i = 0; i < 60; i += 1) {
      inputs.push(E.comment(T1, `note ${String(i)}`, { actor: 'impl', wall: 200 + i }));
    }
    // 12 field and heading lines + 61 messages = 73 lines; at 80x24 the
    // greatest scroll is 73 - 22 = 51.
    const m = model(inputs);
    const long = { ...START, detail: { ticket: T1, scroll: 0 } };
    expect(press(long, '<pagedown>', m).detail).toEqual({ ticket: T1, scroll: H });
    expect(press(long, '<pagedown><pagedown>', m).detail).toEqual({ ticket: T1, scroll: 2 * H });
    expect(press(long, '<pagedown><pagedown><pagedown>', m).detail).toEqual({
      ticket: T1,
      scroll: 51,
    });
    expect(press(long, '<pagedown><pagedown><pageup>', m).detail).toEqual({
      ticket: T1,
      scroll: H,
    });
    expect(press(long, '<pagedown>j', m).detail).toEqual({ ticket: T1, scroll: H + 1 });
  });

  it('clamps with the detail lines of the current width', () => {
    expect(press(open, 'j<pagedown>', M, { columns: 140, rows: 40 }).detail).toEqual({
      ticket: T1,
      scroll: 0,
    });
    // At 60x15 (H = 13) the page is 13 lines; T1 has 25 lines at 60 columns (its
    // open decision wraps), so the greatest scroll is 12.
    expect(press(open, '<pagedown>', M, { columns: 60, rows: 15 }).detail).toEqual({
      ticket: T1,
      scroll: 12,
    });
    expect(press(open, 'j<pagedown>', M, { columns: 60, rows: 15 }).detail).toEqual({
      ticket: T1,
      scroll: 12,
    });
  });

  it('ignores the selection keys of the view under it', () => {
    for (const key of keys('hl<left><right><enter>xz')) {
      expect(reduceKey(open, key, M, SIZE)).toBe(open);
    }
  });

  it('the view selection is unchanged by scrolling', () => {
    const ui = { ...START, board: at(0, 1), detail: { ticket: T3, scroll: 0 } };
    expect(press(ui, 'jj<escape>', M).board).toEqual(at(0, 1));
  });
});

describe('reduceKey: feed view', () => {
  // The fixture feed has 31 entries (every applied event), newest first:
  // entry 0 is T5's hand-off, entry 30 the board.meta.
  const feed = { ...START, view: 'feed' as const };

  it('j, k and the arrows move by one, clamped', () => {
    expect(press(feed, 'jjj', M).feed).toEqual(feedSel(3));
    expect(press(feed, 'jjk', M).feed).toEqual(feedSel(1));
    expect(press(feed, '<down><up><up>', M).feed).toEqual(feedSel(0));
    expect(press({ ...feed, feed: feedSel(30) }, 'j', M).feed).toEqual(feedSel(30));
  });

  it('page down and page up move by the body height, clamped', () => {
    expect(press(feed, '<pagedown>', M).feed).toEqual(feedSel(H));
    expect(press(feed, '<pagedown><pagedown>', M).feed).toEqual(feedSel(30));
    expect(press(feed, '<pagedown><pagedown><pageup>', M).feed).toEqual(feedSel(30 - H));
    expect(press(feed, '<pageup>', M).feed).toEqual(feedSel(0));
  });

  it('Enter opens the ticket of the selected entry', () => {
    expect(press(feed, '<enter>', M).detail).toEqual({ ticket: T5, scroll: 0 });
    expect(press(feed, 'jjjjj<enter>', M).detail).toEqual({ ticket: T7, scroll: 0 });
  });

  it('Enter on a board.meta entry is ignored', () => {
    const last = { ...feed, feed: feedSel(30) };
    expect(reduceKey(last, named('enter'), M, SIZE)).toBe(last);
  });

  it('Enter on an empty feed is ignored, and moving stays at 0', () => {
    const empty = model([]);
    expect(reduceKey(feed, named('enter'), empty, SIZE)).toBe(feed);
    expect(press(feed, 'jj<pagedown>', empty).feed).toEqual({ index: 0, hash: null });
  });

  it('h and l are ignored', () => {
    expect(reduceKey(feed, char('h'), M, SIZE)).toBe(feed);
    expect(reduceKey(feed, named('right'), M, SIZE)).toBe(feed);
  });
});

describe('reduceKey: lanes view', () => {
  // Fixture lanes: impl (T1), orch (T4), test-author (T2), rev (T5).
  const lanes = { ...START, view: 'lanes' as const };

  it('j, k and the arrows move by one, clamped', () => {
    expect(press(lanes, 'j', M).lanes).toEqual(laneSel(1));
    expect(press(lanes, 'jjjjjj', M).lanes).toEqual(laneSel(3));
    expect(press(lanes, '<down>k<up>', M).lanes).toEqual(laneSel(0));
  });

  it('Enter opens the first held ticket of the selected lane', () => {
    expect(press(lanes, '<enter>', M).detail).toEqual({ ticket: T1, scroll: 0 });
    expect(press(lanes, 'jjj<enter>', M).detail).toEqual({ ticket: T5, scroll: 0 });
  });

  it('Enter on a lane holding no ticket, or with no lane, is ignored', () => {
    const m = model([
      E.create(T1, { title: 'one', task: TASK }, { actor: 'orch', wall: 100 }),
      E.comment(T1, 'hello', { actor: 'idle', wall: 200 }),
    ]);
    expect(reduceKey(lanes, named('enter'), m, SIZE)).toBe(lanes);
    expect(reduceKey(lanes, named('enter'), model([]), SIZE)).toBe(lanes);
  });

  it('page keys, h and l are ignored', () => {
    for (const key of keys('hl<pagedown><pageup>')) {
      expect(reduceKey(lanes, key, M, SIZE)).toBe(lanes);
    }
  });
});

describe('reconcileUi: model changes', () => {
  it('returns the same object when every selection is where its identity is', () => {
    const ui = { ...START, board: at(0, 1), feed: feedSel(30), lanes: laneSel(3) };
    expect(reconcileUi(ui, M)).toBe(ui);
    expect(reconcileUi(START, M)).toBe(START);
  });

  it('fills in the identities of the initial state', () => {
    expect(reconcileUi(START_UI, M)).toEqual(START);
    const empty = model([]);
    expect(reconcileUi(START_UI, empty)).toBe(START_UI);
  });

  it('keeps the selected ticket selected when a live append reorders its column', () => {
    // todo holds T2 (newest), then T1; T1 is selected at row 1.
    const before: FoldInput[] = [
      E.create(T1, { title: 'one', task: TASK }, { wall: 100 }),
      E.create(T2, { title: 'two', task: TASK }, { wall: 110 }),
    ];
    const ui = { ...START_UI, board: { column: 0, row: 1, ticket: T1 } };
    expect(reconcileUi(ui, model(before)).board).toEqual(ui.board);
    // A comment on T1 makes it the most recently updated: it moves to row 0.
    const after = model([...before, E.comment(T1, 'bump', { wall: 200 })]);
    expect(reconcileUi(ui, after).board).toEqual({ column: 0, row: 0, ticket: T1 });
  });

  it('follows the selected ticket to another column', () => {
    const before: FoldInput[] = [
      E.create(T1, { title: 'one', task: TASK }, { wall: 100 }),
      E.create(T2, { title: 'two', task: TASK }, { wall: 110 }),
      E.create(T3, { title: 'three', task: TASK }, { wall: 120 }),
      E.move(T3, 'tests', { wall: 130 }),
    ];
    const ui = { ...START_UI, board: { column: 0, row: 1, ticket: T1 } };
    const moved = model([...before, E.move(T1, 'tests', { wall: 200 })]);
    // tests now holds T1 (newest) then T3.
    expect(reconcileUi(ui, moved).board).toEqual({ column: 1, row: 0, ticket: T1 });
  });

  it('clamps when the selected ticket leaves the listed cards, and when a column empties', () => {
    // T2 is merged; T1 (selected, in merged at row 1 before) follows.
    const before: FoldInput[] = [
      E.create(T1, { title: 'one', task: TASK }, { wall: 100 }),
      E.create(T2, { title: 'two', task: TASK }, { wall: 110 }),
      E.move(T1, 'tests', { wall: 200 }),
      E.move(T2, 'tests', { wall: 210 }),
      E.move(T2, 'implementing', { wall: 220 }),
      E.move(T2, 'review', { wall: 230 }),
      E.move(T2, 'merged', { wall: 240 }),
    ];
    const ui = { ...START_UI, board: { column: 5, row: 1, ticket: T1 } };
    const withT1Merged = [
      ...before,
      E.move(T1, 'implementing', { wall: 300 }),
      E.move(T1, 'review', { wall: 310 }),
      E.move(T1, 'merged', { wall: 320 }),
    ];
    // merged: T1 (newest) then T2; T1 is followed to row 0.
    expect(reconcileUi(ui, model(withT1Merged)).board).toEqual({ column: 5, row: 0, ticket: T1 });
    // T1 closed and closed hidden: not listed, so the row clamps to T2.
    const closed = model([...withT1Merged, E.close(T1, { noDecision: true }, { wall: 400 })]);
    expect(reconcileUi({ ...ui, board: { column: 5, row: 0, ticket: T1 } }, closed).board).toEqual({
      column: 5,
      row: 0,
      ticket: T2,
    });
    // Both closed: the column is empty.
    const none = model([
      ...withT1Merged,
      E.close(T1, { noDecision: true }, { wall: 400 }),
      E.close(T2, { noDecision: true }, { wall: 410 }),
    ]);
    expect(reconcileUi(ui, none).board).toEqual({ column: 5, row: 0, ticket: null });
  });

  it('clamps when the selected ticket disappears from the model (a reload after a resync)', () => {
    // T3 was selected at row 2 of todo; the reloaded model has no T3.
    const ui = { ...START_UI, board: { column: 0, row: 2, ticket: T3 } };
    const without = model([
      E.create(T1, { title: 'one', task: TASK }, { wall: 100 }),
      E.create(T2, { title: 'two', task: TASK }, { wall: 110 }),
    ]);
    // Row 2 clamps to 1, the last card (T1).
    expect(reconcileUi(ui, without).board).toEqual({ column: 0, row: 1, ticket: T1 });
  });

  it('keeps the selected feed entry selected when newer entries arrive', () => {
    const base: FoldInput[] = [
      E.create(T1, { title: 'one', task: TASK }, { actor: 'orch', wall: 100 }),
      E.comment(T1, 'first', { actor: 'impl', wall: 200 }),
    ];
    const m1 = model(base);
    const entries1 = feedEntries(m1);
    // Select the create (index 1).
    const ui = {
      ...START_UI,
      view: 'feed' as const,
      feed: { index: 1, hash: entries1[1]?.hash ?? null },
    };
    expect(reconcileUi(ui, m1).feed).toEqual(ui.feed);
    // The same events plus a newer comment (as an append would give).
    const m2 = model([...base, E.comment(T1, 'later', { actor: 'rev', wall: 300 })]);
    expect(reconcileUi(ui, m2).feed).toEqual({ index: 2, hash: entries1[1]?.hash ?? null });
  });

  it('clamps the feed selection when its entry is gone', () => {
    const small = model([E.create(T1, { title: 'one', task: TASK }, { actor: 'orch', wall: 100 })]);
    const ui = { ...START, feed: feedSel(12) };
    const only = feedEntries(small)[0]?.hash ?? null;
    expect(reconcileUi(ui, small).feed).toEqual({ index: 0, hash: only });
    expect(reconcileUi(ui, model([])).feed).toEqual({ index: 0, hash: null });
  });

  it('keeps the selected lane selected when lanes reorder, and clamps when it is gone', () => {
    const base: FoldInput[] = [
      E.create(T1, { title: 'one', task: TASK }, { actor: 'a', wall: 100 }),
      E.comment(T1, 'hi', { actor: 'b', wall: 200 }),
    ];
    // Lanes: b (most recent), a.
    const ui = { ...START_UI, view: 'lanes' as const, lanes: { index: 1, actor: 'a' } };
    expect(reconcileUi(ui, model(base)).lanes).toEqual(ui.lanes);
    // a writes again and becomes the first lane.
    const reordered = model([...base, E.comment(T1, 'again', { actor: 'a', wall: 300 })]);
    expect(reconcileUi(ui, reordered).lanes).toEqual({ index: 0, actor: 'a' });
    // Only b remains (a reload without a's events): clamp to b.
    const gone = model([E.create(T1, { title: 'one', task: TASK }, { actor: 'b', wall: 100 })]);
    expect(reconcileUi(ui, gone).lanes).toEqual({ index: 0, actor: 'b' });
    expect(reconcileUi(ui, model([])).lanes).toEqual({ index: 0, actor: null });
  });

  it('closes the detail when its ticket is gone, and keeps it (scroll too) otherwise', () => {
    const ui = { ...START, detail: { ticket: T1, scroll: 7 } };
    expect(reconcileUi(ui, M)).toBe(ui);
    const without = model([E.create(T2, { title: 'two', task: TASK }, { wall: 100 })]);
    expect(reconcileUi(ui, without).detail).toBeNull();
  });

  it('keeps the view, the flags and the notice', () => {
    const ui: UiState = {
      ...START,
      view: 'lanes',
      board: { column: 5, row: 4, ticket: 'GONE' },
      showClosed: true,
      help: true,
      notice: 'busy',
    };
    expect(reconcileUi(ui, model([]))).toEqual({
      ...ui,
      board: { column: 5, row: 0, ticket: null },
      feed: { index: 0, hash: null },
      lanes: { index: 0, actor: null },
    });
  });
});

describe('reducers are pure', () => {
  it('reduceKey and reconcileUi do not modify their arguments and are deterministic', () => {
    const m = fixtureModel();
    const mCopy = structuredClone(m);
    const ui = { ...START, board: at(0, 1), detail: { ticket: T1, scroll: 1 } };
    const uiCopy = structuredClone(ui);
    for (const key of keys('jkhl123c?<tab><enter><escape><pagedown><pageup>q')) {
      expect(reduceKey(ui, key, m, SIZE)).toEqual(reduceKey(uiCopy, key, mCopy, SIZE));
    }
    expect(reconcileUi(ui, m)).toEqual(reconcileUi(uiCopy, mCopy));
    expect(m).toEqual(mCopy);
    expect(ui).toEqual(uiCopy);
  });
});
