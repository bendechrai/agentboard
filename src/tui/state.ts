/**
 * The UI state of `agentboard top` and its pure reducers (board-tui:
 * "Keys", "Views"; add-board-tui task 1.1).
 *
 * Pure and browser-safe like the view-model: no IO, no clock, no
 * randomness, and no `node:` import, directly or transitively (the layering
 * test enforces this). Neither function modifies its arguments.
 *
 * Selections are indexes into the lists the frame shows, computed with the
 * board view-model exactly as `renderFrame` computes them:
 * - board: `boardColumns(model.tickets, now, { includeClosed:
 *   ui.showClosed })` (the time passed does not change which cards a
 *   column holds or their order, so the reducers pass 0);
 * - feed: `feedEntries(model)` (no filter);
 * - lanes: `agentLanes(model, now)` (again, any `now` gives the same order).
 */

import type { Key } from './keys.js';
import type { Size } from './frame.js';
import type { BoardModel } from '../view/types.js';

/** The three views selected with `1`, `2` and `3`. */
export type ViewName = 'board' | 'feed' | 'lanes';

/** The views in key order (`1`, `2`, `3`), which is also the Tab cycle order. */
export const VIEWS: readonly ViewName[] = ['board', 'feed', 'lanes'];

/** The open ticket detail. */
export interface DetailState {
  /** The full id of the ticket shown. */
  ticket: string;
  /**
   * Index of the first detail line shown (see `detailLines` in
   * `frame.ts`); 0 is the top.
   */
  scroll: number;
}

/** Everything `renderFrame` needs besides the model, the size and `now`. */
export interface UiState {
  /** The board directory shown on the header line, as given (the frame escapes it). */
  boardDir: string;
  /** The current view. */
  view: ViewName;
  /**
   * The board selection: the column index (0 to 5, in `BOARD_COLUMNS`
   * order) and the card index within that column (0 when the column is
   * empty, in which case no card is selected).
   */
  board: { column: number; row: number };
  /** The selected feed entry index (0 when the feed is empty). */
  feed: number;
  /** The selected lane index (0 when there is no lane). */
  lanes: number;
  /** The ticket detail shown over the current view, or null when closed. */
  detail: DetailState | null;
  /** Whether the board shows closed tickets (toggled with `c`). */
  showClosed: boolean;
  /** Whether the key help overlay is shown (toggled with `?`). */
  help: boolean;
  /**
   * A short status shown at the start of the key line (the driver sets
   * `busy` while the board is busy), or null.
   */
  notice: string | null;
  /** Set by `q` and Ctrl-C; the driver stops when it is true. */
  quit: boolean;
}

/**
 * The state `top` starts in: `boardDir` as given, the board view, every
 * selection at 0 (`board` at column 0, row 0), no detail, closed tickets
 * hidden, no help, no notice, `quit` false.
 */
export function initialUi(boardDir: string): UiState {
  throw new Error(`not implemented: initialUi(${boardDir})`);
}

/**
 * The state after key `key`, given the current `model` and terminal
 * `size`. Returns `ui` itself (the same object) when the key is ignored;
 * otherwise a new state. Let H be `max(1, size.rows - 2)` (the body
 * height of a frame). Rules, the first that applies wins:
 *
 * 1. `q` or `ctrl-c`: `quit` true (in every mode, help and detail too).
 * 2. While `help` is true: `?` or `escape` sets `help` false; every other
 *    key is ignored.
 * 3. `?`: `help` true.
 * 4. `c`: `showClosed` toggled, then the board selection clamped as in
 *    `reconcileUi` (in every view, also with a detail open, which stays
 *    open).
 * 5. `1`, `2`, `3`: `view` set to `board`, `feed` or `lanes` and the
 *    detail closed; `tab`: `view` set to the next view in `VIEWS` order
 *    (after `lanes` comes `board`) and the detail closed. Selections are
 *    kept per view. Ignored when it would change nothing (the view is
 *    already current and no detail is open).
 * 6. While a detail is open: `escape` and `backspace` close it (the
 *    selection of the view under it is unchanged); `up` and `k` decrease
 *    `scroll` by 1, `down` and `j` increase it by 1, `pageup` decreases it
 *    by H and `pagedown` increases it by H, each clamped to 0 to
 *    `max(0, detailLines(model, ticket, size.columns).length - H)`. Every
 *    other key is ignored.
 * 7. Board view: `left` and `h` move to the previous column (not before
 *    0), `right` and `l` to the next (not past 5), and the row is then
 *    clamped to the new column's last card index (0 when it is empty);
 *    `up` and `k` decrease the row by 1 and `down` and `j` increase it by
 *    1, clamped to 0 to the column's last card index; `enter` opens the
 *    detail (`scroll` 0) of the selected card, and is ignored when the
 *    column is empty. Every other key is ignored.
 * 8. Feed view: `up`/`k` and `down`/`j` move the selection by 1, `pageup`
 *    and `pagedown` by H, clamped to 0 to the last entry index (0 when the
 *    feed is empty); `enter` opens the detail of the selected entry's
 *    ticket, ignored when the feed is empty, the entry has no ticket
 *    (`board.meta`) or its ticket is not in `model.tickets`. Every other
 *    key is ignored.
 * 9. Lanes view: `up`/`k` and `down`/`j` move the selection by 1, clamped
 *    to 0 to the last lane index (0 when there is none); `enter` opens the
 *    detail of the selected lane's first held ticket (`tickets[0]`),
 *    ignored when the lane holds none or there is no lane. Every other key
 *    is ignored.
 *
 * Moving the selection is always one step at a time: a key that would
 * move past a bound leaves the selection at that bound.
 */
export function reduceKey(ui: UiState, key: Key, model: BoardModel, size: Size): UiState {
  throw new Error(
    `not implemented: reduceKey(${ui.view}, ${key.name}, ${String(model.events.length)}, ${String(size.columns)})`,
  );
}

/**
 * The state after the model changed (an append, a reload or a `c`
 * toggle): the board row clamped to 0 to the last card index of the
 * selected column (0 when that column is empty), the feed selection
 * clamped to the last entry index and the lane selection to the last lane
 * index (each 0 when the list is empty), and the detail closed when its
 * ticket is not in `model.tickets` (otherwise kept, `scroll` unchanged;
 * the frame clamps what it shows). The column index, the view and every
 * other field are unchanged. Returns `ui` itself (the same object) when
 * nothing changes.
 */
export function reconcileUi(ui: UiState, model: BoardModel): UiState {
  throw new Error(`not implemented: reconcileUi(${ui.view}, ${String(model.events.length)})`);
}
