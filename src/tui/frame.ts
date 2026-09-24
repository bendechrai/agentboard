/**
 * Frames of `agentboard top` (board-tui: "Views", "Frame rendering";
 * add-board-tui task 1.2).
 *
 * A frame is a pure function of the model, the UI state, the terminal size
 * and `now` (milliseconds since the Unix epoch): no clock, no IO, no
 * randomness, and no `node:` import, directly or transitively (the layering
 * test enforces this). Equal inputs give deep-equal frames, and no input is
 * modified. A frame is plain text (exactly `size.rows` lines of exactly
 * `size.columns` printable ASCII characters, 0x20 to 0x7E) plus a style
 * map; styles are data, never escape codes (the terminal driver of group 2
 * turns them into SGR sequences).
 *
 * Definitions used below:
 * - `fitText(text, width)` (exported): text made single-width ASCII and
 *   cut or padded to exactly `width` characters.
 * - C is `size.columns`, R is `size.rows`, and H is `R - 2`, the body
 *   height (the lines between the header line and the key line).
 * - The columns are `boardColumns(model.tickets, now, { includeClosed:
 *   ui.showClosed })`; the feed entries are `feedEntries(model)`; the
 *   lanes are `agentLanes(model, now)`.
 * - Selections are read by index only (`ui.board.column` and `row`,
 *   `ui.feed.index`, `ui.lanes.index`); their identity fields are not
 *   read here (`reconcileUi` keeps the indexes where the identities are).
 * - "Styled X over [a, b)" means the cells from column a (inclusive) to b
 *   (exclusive) of that line get attribute or color X, in addition to any
 *   other style those cells get.
 */

import type { BoardModel } from '../view/types.js';
import type { FeedEntry } from '../view/feed.js';
import type { UiState } from './state.js';

/** A terminal size in character cells. Both are non-negative integers. */
export interface Size {
  columns: number;
  rows: number;
}

/** The eight standard foreground colors (SGR 30 to 37, in that order). */
export type Color = 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white';

/** The style of one cell. The default style is all false with no color. */
export interface Style {
  bold: boolean;
  dim: boolean;
  inverse: boolean;
  /** The foreground color, or null for the terminal's default. */
  color: Color | null;
}

/** A run of cells of one line that share a non-default style. */
export interface StyleRun {
  /** Index of the first cell (0-based column). */
  start: number;
  /** Number of cells, at least 1. */
  length: number;
  style: Style;
}

/** One rendered frame. */
export interface Frame {
  /** Exactly `size.rows` lines, each exactly `size.columns` characters from 0x20 to 0x7E. */
  lines: string[];
  /**
   * One list per line (so exactly as many as `lines`): the runs of cells
   * whose style is not the default, sorted by `start`, not overlapping,
   * each inside its line, and maximal (two adjacent runs never have equal
   * styles). A cell in no run has the default style. So the map is
   * canonical: equal per-cell styles give deep-equal runs.
   */
  styles: StyleRun[][];
}

/** The minimum usable size: 60 columns by 15 rows. */
export const MIN_COLUMNS = 60;
export const MIN_ROWS = 15;

/** From this many columns the board view shows the activity feed pane. */
export const FEED_PANE_MIN_COLUMNS = 140;

/** Width of the activity feed pane, its `|` separator included. */
export const FEED_PANE_WIDTH = 40;

/**
 * The key line text by mode. The mode is `help` while the help overlay is
 * shown, otherwise `detail` while a detail is open, otherwise the view.
 */
export const KEY_LINES: Readonly<Record<'board' | 'feed' | 'lanes' | 'detail' | 'help', string>> = {
  board: '[1 board] 2 feed 3 lanes  tab  hjkl move  enter open  c closed  ? help  q quit',
  feed: '1 board [2 feed] 3 lanes  tab  jk move  pgup/pgdn  enter open  ? help  q quit',
  lanes: '1 board 2 feed [3 lanes]  tab  jk move  enter open  ? help  q quit',
  detail: 'esc close  jk scroll  pgup/pgdn  1/2/3 view  ? help  q quit',
  help: '? close help  q quit',
};

/** The body lines of the help overlay, from the first body line down. */
export const HELP_LINES: readonly string[] = [
  'keys',
  '  1 2 3        board, feed, lanes',
  '  tab          next view',
  '  arrows hjkl  move the selection',
  '  enter        open the selected ticket',
  '  esc bksp     close the ticket',
  '  pgup pgdn    page the ticket or the feed',
  '  c            show or hide closed tickets',
  '  ?            show or hide this help',
  '  q ctrl-c     quit',
];

/**
 * `text` passed through `asciiText` (from `src/board/text.ts`: every
 * character outside printable ASCII, and the backslash, escaped), then, if
 * longer than `width`, cut to its first `width - 1` characters followed by
 * `~`, otherwise padded with spaces to `width`. Always exactly `width`
 * characters (`width` 0 gives the empty string). Every piece of text in a
 * frame goes through this (or, in the detail, through the same
 * `asciiText` and then wrapping) exactly once, so escaping never doubles.
 */
export function fitText(text: string, width: number): string {
  throw new Error(`not implemented: fitText(${text}, ${String(width)})`);
}

/**
 * The one-line form of a feed entry used by the feed view and the feed
 * pane, before `fitText`:
 * `<time> <late><actor> <ticket> <summary>`, where `<time>` is
 * `relativeTime(now - entry.ts.wall)` padded with spaces to 8 characters,
 * `<late>` is `late ` (with its space) for a late entry and empty
 * otherwise, `<ticket>` is the first `SHORT_ID_LENGTH` (10) characters of
 * `entry.ticket`, or `-` when it is null, and `<summary>` is
 * `entry.summary`. For example `5m ago   impl 01ARYZ6S41 claimed`.
 */
export function feedLine(entry: FeedEntry, now: number): string {
  throw new Error(`not implemented: feedLine(${entry.hash}, ${String(now)})`);
}

/**
 * The lines of the detail of ticket `ticketId` at width `columns`, before
 * scrolling. The logical lines below are each passed through `asciiText`
 * and then cut into consecutive pieces of `columns` characters (the last
 * piece may be shorter; an empty logical line gives one empty line), so
 * nothing is truncated. Lines are not padded. When `ticketId` is not in
 * `model.tickets` the only logical line is `ticket <id> not found`.
 * Otherwise, with `t` the ticket:
 *
 * 1. `ticket <t.id>`
 * 2. `title: <t.title>`
 * 3. `status: <t.status>`, or `status: blocked (from <t.blockedFrom>)`
 *    when `t.blockedFrom` is not null
 * 4. `assignee: <t.assignee>`, or `assignee: -` when null
 * 5. `task: <formatTaskRef(t.task)>`; when `t.task` is null, `task:
 *    adhoc: <t.adhoc>` when `t.adhoc` is not null, else `task: -`
 * 6. `labels: <labels joined with ", ">`, or `labels: -` when none
 * 7. `description: <t.description>`, or `description: -` when null
 * 8. `checklist: -` when the checklist is empty; otherwise
 *    `checklist: <done>/<total>` followed by one line per item in order,
 *    `  [x] <text>` when done and `  [ ] <text>` when not
 * 9. `links: -` when `t.links` is empty; otherwise `links:` followed by one
 *    line per link in order, `  pr <pr>` or `  decision <path>`
 * 10. `disposition: open` while open; `disposition: closed, decision
 *    <path>` or `disposition: closed, no decision` once closed
 * 11. an empty line
 * 12. `conversation:`
 * 13. one line per message of `conversation(model, t.id)`, in order:
 *    - comment: `<marker><actor>: <text>`
 *    - hand-off: `<marker><actor> -> <to> (<status>): <text>`
 *    - system: `  <actor> <text>` (indented by two spaces)
 *    where `<marker>` is `[DECISION, retracted] ` when `retracted`, else
 *    `[DECISION] ` when `decision`, else `[RETRACTED] ` when `retraction`,
 *    else empty.
 */
export function detailLines(model: BoardModel, ticketId: string, columns: number): string[] {
  throw new Error(
    `not implemented: detailLines(${String(model.events.length)}, ${ticketId}, ${String(columns)})`,
  );
}

/**
 * Renders one frame (see the module comment for C, R, H and the lists).
 *
 * Too small: when C is below `MIN_COLUMNS` or R below `MIN_ROWS`, line 0
 * is `fitText('terminal too small: need 60x15, have <C>x<R>', C)`, every
 * other line is C spaces, and no cell is styled (R 0 gives no line).
 *
 * Otherwise line 0 is the header, lines 1 to R - 2 the body (H lines) and
 * line R - 1 the key line.
 *
 * Header: `fitText` to C of `agentboard top  <counts>  <last>  <dir>`,
 * where `<counts>` is `<status>:<number of cards>` for each of the six
 * columns in order, joined by one space (so it follows `c`), `<last>` is
 * `last event <relativeTime(now - wall)>` for the wall of the last event
 * of `model.events` whose outcome is `applied`, or `no events` when there
 * is none, and `<dir>` is `ui.boardDir`. Styled bold over [0, C).
 *
 * Key line: `fitText` to C of `KEY_LINES[mode]`, or of `<notice>  <keys>`
 * when `ui.notice` is not null. Styled dim over [0, C), except that the
 * first `min(N, C)` cells, N being the length of `fitText`'s escaping of
 * the notice (its `asciiText`), are styled bold and yellow instead of dim.
 *
 * Body, by mode (help first, then detail, then the view):
 *
 * Help: body line i is `fitText(HELP_LINES[i] ?? '', C)`. No style.
 *
 * Detail: with L = `detailLines(model, ui.detail.ticket, C)` and
 * top = `min(ui.detail.scroll, max(0, L.length - H))`, body line i is
 * L[top + i] padded with spaces to C (C spaces past the end). Styles: the
 * line from logical line 1 (`ticket <id>`) bold over [0, C); every line
 * of a system message dim over [0, C); on the first line of a message
 * with a marker, the marker without its trailing space (`[DECISION]`,
 * `[DECISION, retracted]` or `[RETRACTED]`, from column 0) bold green,
 * dim, or bold red respectively.
 *
 * Board view: W is C - `FEED_PANE_WIDTH` when C is at least
 * `FEED_PANE_MIN_COLUMNS`, otherwise C. Column width w is
 * `floor((W - 5) / 6)`; column k (0 to 5) occupies cells
 * [k * (w + 1), k * (w + 1) + w) and a `|` follows each of the first
 * five columns (at k * (w + 1) + w) on every body line; cells from
 * 6 * w + 5 to W - 1 are spaces.
 * - Body line 0 holds the headings. With `s` the status and ` <n>` the
 *   suffix (a space and the card count), a heading is `s + suffix`
 *   padded to w when it fits; otherwise `fitText(s, w - suffix.length) +
 *   suffix` when w is longer than the suffix (the count always shows),
 *   else `fitText(s + suffix, w)`. Each heading cell styled bold.
 * - Body lines 1 to H - 1 hold the cards. A card takes two lines: its
 *   first line is `fitText(card.title, w)` and its second
 *   `fitText(card.assignee ?? '-', w)` (the short id is not shown on
 *   cards; the detail shows the full id). So P = `floor((H - 1) / 2)`
 *   cards fit per column, card j shown on body lines 1 + 2j and 2 + 2j
 *   (when H - 1 is odd, the last body line holds no card). Column k shows
 *   its cards from index top_k, where top_k is `max(0, ui.board.row - P +
 *   1)` for the selected column (`ui.board.column`) and 0 for the others;
 *   w spaces past the last card. Over both lines of its cell, the
 *   selected card (column `ui.board.column`, index `ui.board.row`) is
 *   styled inverse, a card whose `changed` is true bold, and a closed card
 *   dim.
 * - When C is at least `FEED_PANE_MIN_COLUMNS`, cell W of every body line
 *   is `|`, and the 39 cells after it hold the feed pane: body line 0 is
 *   `fitText('activity', 39)` with `activity` styled bold, and body line
 *   j (1 to H - 1) is `fitText(feedLine(entries[j - 1], now), 39)`, or
 *   39 spaces past the last entry.
 *
 * Feed view: with top = `max(0, ui.feed.index - H + 1)`, body line i is
 * `fitText(feedLine(entries[top + i], now), C)`, or C spaces past the last
 * entry. The selected entry (index `ui.feed.index`) is styled inverse over
 * [0, C), and the `late` marker of a late entry (cells [9, 13)) yellow.
 * With no entry, body line 0 is `fitText('no events', C)`.
 *
 * Lanes view: the lanes give a list of lines: for each lane in order its
 * header `<actor>  last seen <time>` (`<time>` is
 * `relativeTime(lastSeenMs)`, or `never` when `lastSeenMs` is null), then
 * one line per held card, `  <shortId> <status padded with spaces to 12>
 * <title>`, or `  (no tickets)` when it holds none, and then one empty
 * line unless it is the last lane. With s and e the indexes of the
 * selected lane's (`ui.lanes.index`) header and of its last line, top is 0 when
 * e is below H and s otherwise; body line i is `fitText(list[top + i] ??
 * '', C)`. Every lane header line is styled bold over [0, C), the selected
 * one also inverse. With no lane, body line 0 is `fitText('no agents',
 * C)`.
 */
export function renderFrame(model: BoardModel, ui: UiState, size: Size, now: number): Frame {
  throw new Error(
    `not implemented: renderFrame(${String(model.events.length)}, ${ui.view}, ${String(size.columns)}x${String(size.rows)}, ${String(now)})`,
  );
}
