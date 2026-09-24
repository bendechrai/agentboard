/**
 * The UI state of `agentboard top` and its pure reducers (board-tui:
 * "Keys", "Views"; add-board-tui task 1.1).
 *
 * Pure and browser-safe like the view-model: no IO, no clock, no
 * randomness, and no `node:` import, directly or transitively (the layering
 * test enforces this). Neither function modifies its arguments.
 *
 * The lists the selections refer to are computed with the board
 * view-model exactly as `renderFrame` computes them:
 * - board: `boardColumns(model.tickets, now, { includeClosed:
 *   ui.showClosed })` (the time passed does not change which cards a
 *   column holds or their order, so the reducers pass 0);
 * - feed: `feedEntries(model)` (no filter);
 * - lanes: `agentLanes(model, now)` (again, any `now` gives the same order).
 *
 * Selections follow what is selected, not its position. Each selection
 * holds an index (what `renderFrame` highlights) and the identity of the
 * item at that index: the ticket id of the selected card, the hash of the
 * selected feed entry, the actor of the selected lane (null when the list
 * is empty). Invariant, after `initialUi` followed by `reconcileUi` and
 * after every `reduceKey` or `reconcileUi` on the current model: the
 * identity is the one of the item at the index, or null exactly when the
 * list (for the board, the selected column) is empty. When the model
 * changes, `reconcileUi` moves each index to wherever its identity now is,
 * and clamps only when that item is gone or no longer listed.
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

/** The board selection. */
export interface BoardSelection {
  /** The column index, 0 to 5, in `BOARD_COLUMNS` order. */
  column: number;
  /** The card index within that column (0 when the column is empty). */
  row: number;
  /** The id of the card at `row` in `column`, or null when the column is empty. */
  ticket: string | null;
}

/** The feed selection. */
export interface FeedSelection {
  /** The entry index (0 when the feed is empty). */
  index: number;
  /** The hash of the entry at `index`, or null when the feed is empty. */
  hash: string | null;
}

/** The lanes selection. */
export interface LaneSelection {
  /** The lane index (0 when there is no lane). */
  index: number;
  /** The actor of the lane at `index`, or null when there is no lane. */
  actor: string | null;
}

/** Everything `renderFrame` needs besides the model, the size and `now`. */
export interface UiState {
  /** The board directory shown on the header line, as given (the frame escapes it). */
  boardDir: string;
  /** The current view. */
  view: ViewName;
  /** The board selection (no card is selected when the column is empty). */
  board: BoardSelection;
  /** The feed selection. */
  feed: FeedSelection;
  /** The lanes selection. */
  lanes: LaneSelection;
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
 * selection at index 0 with a null identity (`board` is `{ column: 0, row:
 * 0, ticket: null }`, `feed` `{ index: 0, hash: null }`, `lanes` `{ index:
 * 0, actor: null }`), no detail, closed tickets hidden, no help, no
 * notice, `quit` false. The driver passes it through `reconcileUi` with
 * the first model, which fills in the identities.
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
 * 4. `c`: `showClosed` toggled, then the result passed through
 *    `reconcileUi` (so the selected card stays selected when it is still
 *    listed); in every view, also with a detail open, which stays open.
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
 *    column is empty. After a move, `ticket` is the id of the card at the
 *    new column and row (null when that column is empty). Every other key
 *    is ignored.
 * 8. Feed view: `up`/`k` and `down`/`j` move the selection by 1, `pageup`
 *    and `pagedown` by H, clamped to 0 to the last entry index (0 when the
 *    feed is empty), `hash` following the new index; `enter` opens the detail of the selected entry's
 *    ticket, ignored when the feed is empty, the entry has no ticket
 *    (`board.meta`) or its ticket is not in `model.tickets`. Every other
 *    key is ignored.
 * 9. Lanes view: `up`/`k` and `down`/`j` move the selection by 1, clamped
 *    to 0 to the last lane index (0 when there is none), `actor` following
 *    the new index; `enter` opens the
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
 * toggle), with every selection following its identity:
 * - board: when `board.ticket` is not null and that ticket is a card of
 *   one of the columns (closed tickets count only while `showClosed`),
 *   `column` and `row` become its column and index there, `ticket`
 *   unchanged. Otherwise (null, gone from the model, or no longer listed,
 *   for example closed while closed tickets are hidden) `column` is kept,
 *   `row` is clamped to 0 to that column's last card index (0 when it is
 *   empty) and `ticket` becomes the id of the card there, or null.
 * - feed: when `feed.hash` is the hash of an entry, `index` becomes that
 *   entry's index. Otherwise `index` is clamped to 0 to the last entry
 *   index and `hash` becomes that entry's hash, or null when the feed is
 *   empty.
 * - lanes: the same with `lanes.actor` and the lanes.
 * - detail: closed when its ticket is not in `model.tickets`; otherwise
 *   kept with `scroll` unchanged (the frame clamps what it shows).
 * The view and every other field are unchanged. Returns `ui` itself (the
 * same object) when nothing changes.
 */
export function reconcileUi(ui: UiState, model: BoardModel): UiState {
  throw new Error(`not implemented: reconcileUi(${ui.view}, ${String(model.events.length)})`);
}
