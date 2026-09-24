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

import { asciiText } from '../board/text.js';
import type { Ticket } from '../events/fold.js';
import { formatTaskRef } from '../events/schema.js';
import { SHORT_ID_LENGTH, boardColumns, type Card, type Column } from '../view/columns.js';
import { conversation, type ConversationMessage } from '../view/conversation.js';
import { feedEntries, type FeedEntry } from '../view/feed.js';
import { agentLanes } from '../view/lanes.js';
import { relativeTime } from '../view/time.js';
import type { BoardModel } from '../view/types.js';
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
  if (width <= 0) {
    return '';
  }
  const ascii = asciiText(text);
  return ascii.length > width ? `${ascii.slice(0, width - 1)}~` : ascii.padEnd(width);
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
  const time = relativeTime(now - entry.ts.wall).padEnd(8);
  const late = entry.late ? 'late ' : '';
  const ticket = entry.ticket === null ? '-' : entry.ticket.slice(0, SHORT_ID_LENGTH);
  return `${time} ${late}${entry.actor} ${ticket} ${entry.summary}`;
}

/** The ticket `id` of the model, or undefined (own keys only). */
function findTicket(model: Pick<BoardModel, 'tickets'>, id: string): Ticket | undefined {
  return Object.hasOwn(model.tickets, id) ? model.tickets[id] : undefined;
}

/** How a detail line is styled. */
type DetailKind = 'ticket' | 'system' | 'plain';

/** The markers of decision messages, with their trailing space. */
type Marker = '[DECISION, retracted] ' | '[DECISION] ' | '[RETRACTED] ' | '';

/** One logical detail line, before escaping and wrapping. */
interface LogicalLine {
  text: string;
  kind: DetailKind;
  marker: Marker;
}

/** One detail line after wrapping, with what styles it. */
interface DetailLine {
  text: string;
  kind: DetailKind;
  /** The marker of the message, on the first line of that message only. */
  marker: Marker;
}

const plain = (text: string): LogicalLine => ({ text, kind: 'plain', marker: '' });

function markerOf(message: ConversationMessage): Marker {
  if (message.type === 'system') {
    return '';
  }
  if (message.retracted) {
    return '[DECISION, retracted] ';
  }
  if (message.decision) {
    return '[DECISION] ';
  }
  return message.retraction ? '[RETRACTED] ' : '';
}

function messageLine(message: ConversationMessage): LogicalLine {
  const marker = markerOf(message);
  switch (message.type) {
    case 'comment':
      return { text: `${marker}${message.actor}: ${message.text}`, kind: 'plain', marker };
    case 'handoff':
      return {
        text: `${marker}${message.actor} -> ${message.to} (${message.status}): ${message.text}`,
        kind: 'plain',
        marker,
      };
    case 'system':
      return { text: `  ${message.actor} ${message.text}`, kind: 'system', marker };
  }
}

function ticketLines(model: BoardModel, t: Ticket): LogicalLine[] {
  const lines: LogicalLine[] = [
    { text: `ticket ${t.id}`, kind: 'ticket', marker: '' },
    plain(`title: ${t.title}`),
    plain(
      t.blockedFrom === null
        ? `status: ${t.status}`
        : `status: ${t.status} (from ${t.blockedFrom})`,
    ),
    plain(`assignee: ${t.assignee ?? '-'}`),
  ];
  if (t.task !== null) {
    lines.push(plain(`task: ${formatTaskRef(t.task)}`));
  } else {
    lines.push(plain(t.adhoc === null ? 'task: -' : `task: adhoc: ${t.adhoc}`));
  }
  lines.push(plain(t.labels.length === 0 ? 'labels: -' : `labels: ${t.labels.join(', ')}`));
  lines.push(plain(`description: ${t.description ?? '-'}`));
  if (t.checklist.length === 0) {
    lines.push(plain('checklist: -'));
  } else {
    const done = t.checklist.filter((item) => item.done).length;
    lines.push(plain(`checklist: ${String(done)}/${String(t.checklist.length)}`));
    for (const item of t.checklist) {
      lines.push(plain(`  [${item.done ? 'x' : ' '}] ${item.text}`));
    }
  }
  if (t.links.length === 0) {
    lines.push(plain('links: -'));
  } else {
    lines.push(plain('links:'));
    for (const link of t.links) {
      lines.push(plain(link.type === 'pr' ? `  pr ${String(link.pr)}` : `  decision ${link.path}`));
    }
  }
  if (!t.closed) {
    lines.push(plain('disposition: open'));
  } else if (t.disposition !== null && 'decision' in t.disposition) {
    lines.push(plain(`disposition: closed, decision ${t.disposition.decision}`));
  } else {
    lines.push(plain('disposition: closed, no decision'));
  }
  lines.push(plain(''), plain('conversation:'));
  for (const message of conversation(model, t.id)) {
    lines.push(messageLine(message));
  }
  return lines;
}

/** The detail lines with their styling data (see `detailLines`). */
function detailRows(model: BoardModel, ticketId: string, columns: number): DetailLine[] {
  const width = Math.max(1, columns);
  const ticket = findTicket(model, ticketId);
  const logical =
    ticket === undefined ? [plain(`ticket ${ticketId} not found`)] : ticketLines(model, ticket);
  const out: DetailLine[] = [];
  for (const line of logical) {
    const text = asciiText(line.text);
    let start = 0;
    do {
      out.push({
        text: text.slice(start, start + width),
        kind: line.kind,
        marker: start === 0 ? line.marker : '',
      });
      start += width;
    } while (start < text.length);
  }
  return out;
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
  return detailRows(model, ticketId, columns).map((line) => line.text);
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
  const { columns: c, rows: r } = size;
  const canvas = new Canvas(c, r);
  if (c < MIN_COLUMNS || r < MIN_ROWS) {
    canvas.text(
      0,
      0,
      fitText(
        `terminal too small: need ${String(MIN_COLUMNS)}x${String(MIN_ROWS)}, have ${String(c)}x${String(r)}`,
        c,
      ),
    );
    return canvas.frame();
  }
  const columns = boardColumns(model.tickets, now, { includeClosed: ui.showClosed });
  drawHeader(canvas, model, ui, columns, now);
  drawKeyLine(canvas, ui);
  const body: Body = { canvas, top: 1, height: r - 2 };
  if (ui.help) {
    HELP_LINES.forEach((line, i) => {
      if (i < body.height) {
        canvas.text(body.top + i, 0, fitText(line, c));
      }
    });
  } else if (ui.detail !== null) {
    drawDetail(body, model, ui.detail.ticket, ui.detail.scroll);
  } else if (ui.view === 'board') {
    drawBoard(body, model, ui, columns, now);
  } else if (ui.view === 'feed') {
    drawFeed(body, model, ui.feed.index, now);
  } else {
    drawLanes(body, model, ui.lanes.index, now);
  }
  return canvas.frame();
}

/** Style bits of a cell: bold, dim, inverse, then the color index (1 to 8) shifted by 3. */
const BOLD = 1;
const DIM = 2;
const INVERSE = 4;
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

/** A style as a cell code: the attribute bits and, from bit 3, the color index plus 1. */
function code(attributes: number, color: Color | null = null): number {
  return attributes | ((color === null ? 0 : COLORS.indexOf(color) + 1) << 3);
}

function styleOf(cell: number): Style {
  const color = COLORS[(cell >> 3) - 1];
  return {
    bold: (cell & BOLD) !== 0,
    dim: (cell & DIM) !== 0,
    inverse: (cell & INVERSE) !== 0,
    color: color ?? null,
  };
}

/** A frame being drawn: lines of spaces and a style code per cell. */
class Canvas {
  private readonly lines: string[][];
  private readonly cells: number[][];

  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {
    this.lines = Array.from({ length: rows }, () => Array.from({ length: columns }, () => ' '));
    this.cells = Array.from({ length: rows }, () => Array.from({ length: columns }, () => 0));
  }

  /** Writes `text` (already fitted, printable ASCII) on line `y` from column `x`, clipped. */
  text(y: number, x: number, text: string): void {
    const line = this.lines[y];
    if (line === undefined) {
      return;
    }
    for (let i = 0; i < text.length && x + i < this.columns; i += 1) {
      line[x + i] = text[i] ?? ' ';
    }
  }

  /** Adds style `cell` (attributes ORed, a color replacing) to cells [a, b) of line `y`, clipped. */
  style(y: number, a: number, b: number, cell: number): void {
    const line = this.cells[y];
    if (line === undefined) {
      return;
    }
    const end = Math.min(b, this.columns);
    for (let x = Math.max(0, a); x < end; x += 1) {
      const current = line[x] ?? 0;
      const color = cell >> 3 === 0 ? current & ~7 : cell & ~7;
      line[x] = (current & 7) | (cell & 7) | color;
    }
  }

  frame(): Frame {
    return {
      lines: this.lines.map((line) => line.join('')),
      styles: this.cells.map((line) => {
        const runs: StyleRun[] = [];
        let x = 0;
        while (x < line.length) {
          const cell = line[x] ?? 0;
          let end = x + 1;
          while (end < line.length && line[end] === cell) {
            end += 1;
          }
          if (cell !== 0) {
            runs.push({ start: x, length: end - x, style: styleOf(cell) });
          }
          x = end;
        }
        return runs;
      }),
    };
  }
}

/** The body area of a frame: `height` lines from frame line `top`. */
interface Body {
  canvas: Canvas;
  top: number;
  height: number;
}

function drawHeader(
  canvas: Canvas,
  model: BoardModel,
  ui: UiState,
  columns: readonly Column[],
  now: number,
): void {
  const counts = columns.map((col) => `${col.status}:${String(col.cards.length)}`).join(' ');
  let since = 'no events';
  for (let i = model.events.length - 1; i >= 0; i -= 1) {
    const view = model.events[i];
    if (view?.outcome === 'applied') {
      since = `last event ${relativeTime(now - view.ts.wall)}`;
      break;
    }
  }
  canvas.text(0, 0, fitText(`agentboard top  ${counts}  ${since}  ${ui.boardDir}`, canvas.columns));
  canvas.style(0, 0, canvas.columns, code(BOLD));
}

function drawKeyLine(canvas: Canvas, ui: UiState): void {
  const mode = ui.help ? 'help' : ui.detail !== null ? 'detail' : ui.view;
  const keys = KEY_LINES[mode];
  const line = ui.notice === null ? keys : `${ui.notice}  ${keys}`;
  const row = canvas.rows - 1;
  canvas.text(row, 0, fitText(line, canvas.columns));
  const notice = ui.notice === null ? 0 : Math.min(asciiText(ui.notice).length, canvas.columns);
  canvas.style(row, 0, notice, code(BOLD, 'yellow'));
  canvas.style(row, notice, canvas.columns, code(DIM));
}

function drawDetail(body: Body, model: BoardModel, ticketId: string, scroll: number): void {
  const { canvas } = body;
  const lines = detailRows(model, ticketId, canvas.columns);
  const top = Math.min(scroll, Math.max(0, lines.length - body.height));
  for (let i = 0; i < body.height; i += 1) {
    const line = lines[top + i];
    if (line === undefined) {
      break;
    }
    const y = body.top + i;
    canvas.text(y, 0, line.text);
    if (line.kind === 'ticket') {
      canvas.style(y, 0, canvas.columns, code(BOLD));
    } else if (line.kind === 'system') {
      canvas.style(y, 0, canvas.columns, code(DIM));
    }
    canvas.style(y, 0, line.marker.trimEnd().length, MARKER_STYLES[line.marker]);
  }
}

/** The style of each decision marker. */
const MARKER_STYLES: Readonly<Record<Marker, number>> = {
  '': 0,
  '[DECISION] ': code(BOLD, 'green'),
  '[DECISION, retracted] ': code(DIM),
  '[RETRACTED] ': code(BOLD, 'red'),
};

/** A board column heading of width `w` (the count always shows when it can). */
function heading(column: Column, w: number): string {
  const suffix = ` ${String(column.cards.length)}`;
  const full = `${column.status}${suffix}`;
  if (full.length <= w) {
    return full.padEnd(w);
  }
  return w > suffix.length ? fitText(column.status, w - suffix.length) + suffix : fitText(full, w);
}

function drawBoard(
  body: Body,
  model: BoardModel,
  ui: UiState,
  columns: readonly Column[],
  now: number,
): void {
  const { canvas } = body;
  const pane = canvas.columns >= FEED_PANE_MIN_COLUMNS;
  const width = pane ? canvas.columns - FEED_PANE_WIDTH : canvas.columns;
  const w = Math.floor((width - 5) / 6);
  const perColumn = Math.floor((body.height - 1) / 2);
  columns.forEach((column, k) => {
    const x = k * (w + 1);
    canvas.text(body.top, x, heading(column, w));
    canvas.style(body.top, x, x + w, code(BOLD));
    if (k < 5) {
      for (let i = 0; i < body.height; i += 1) {
        canvas.text(body.top + i, x + w, '|');
      }
    }
    const selected = k === ui.board.column;
    const first = selected ? Math.max(0, ui.board.row - perColumn + 1) : 0;
    for (let j = 0; j < perColumn; j += 1) {
      const card = column.cards[first + j];
      if (card === undefined) {
        break;
      }
      const y = body.top + 1 + 2 * j;
      canvas.text(y, x, fitText(card.title, w));
      canvas.text(y + 1, x, fitText(card.assignee ?? '-', w));
      const attributes = cardAttributes(card, selected && first + j === ui.board.row);
      if (attributes !== 0) {
        canvas.style(y, x, x + w, attributes);
        canvas.style(y + 1, x, x + w, attributes);
      }
    }
  });
  if (pane) {
    const paneWidth = FEED_PANE_WIDTH - 1;
    const entries = feedEntries(model);
    for (let i = 0; i < body.height; i += 1) {
      canvas.text(body.top + i, width, '|');
    }
    canvas.text(body.top, width + 1, fitText('activity', paneWidth));
    canvas.style(body.top, width + 1, width + 1 + 'activity'.length, code(BOLD));
    for (let j = 1; j < body.height; j += 1) {
      const entry = entries[j - 1];
      if (entry === undefined) {
        break;
      }
      canvas.text(body.top + j, width + 1, fitText(feedLine(entry, now), paneWidth));
    }
  }
}

function cardAttributes(card: Card, selected: boolean): number {
  return (selected ? INVERSE : 0) | (card.changed ? BOLD : 0) | (card.closed ? DIM : 0);
}

/** Cells of the `late` marker in a feed line (after the 8-character time and a space). */
const LATE_START = 9;
const LATE_END = 13;

function drawFeed(body: Body, model: BoardModel, index: number, now: number): void {
  const { canvas } = body;
  const entries = feedEntries(model);
  if (entries.length === 0) {
    canvas.text(body.top, 0, fitText('no events', canvas.columns));
    return;
  }
  const top = Math.max(0, index - body.height + 1);
  for (let i = 0; i < body.height; i += 1) {
    const entry = entries[top + i];
    if (entry === undefined) {
      break;
    }
    const y = body.top + i;
    canvas.text(y, 0, fitText(feedLine(entry, now), canvas.columns));
    if (top + i === index) {
      canvas.style(y, 0, canvas.columns, code(INVERSE));
    }
    if (entry.late) {
      canvas.style(y, LATE_START, LATE_END, code(0, 'yellow'));
    }
  }
}

/** One line of the lanes view. */
interface LaneLine {
  text: string;
  /** The lane index when this is a lane header, else null. */
  header: number | null;
}

function drawLanes(body: Body, model: BoardModel, index: number, now: number): void {
  const { canvas } = body;
  const lanes = agentLanes(model, now);
  if (lanes.length === 0) {
    canvas.text(body.top, 0, fitText('no agents', canvas.columns));
    return;
  }
  const list: LaneLine[] = [];
  let start = 0;
  let end = 0;
  lanes.forEach((lane, k) => {
    if (k === index) {
      start = list.length;
    }
    const seen = lane.lastSeenMs === null ? 'never' : relativeTime(lane.lastSeenMs);
    list.push({ text: `${lane.actor}  last seen ${seen}`, header: k });
    if (lane.tickets.length === 0) {
      list.push({ text: '  (no tickets)', header: null });
    }
    for (const card of lane.tickets) {
      list.push({
        text: `  ${card.shortId} ${card.status.padEnd(12)} ${card.title}`,
        header: null,
      });
    }
    if (k === index) {
      end = list.length - 1;
    }
    if (k < lanes.length - 1) {
      list.push({ text: '', header: null });
    }
  });
  const top = end < body.height ? 0 : start;
  for (let i = 0; i < body.height; i += 1) {
    const line = list[top + i];
    if (line === undefined) {
      break;
    }
    const y = body.top + i;
    canvas.text(y, 0, fitText(line.text, canvas.columns));
    if (line.header !== null) {
      canvas.style(y, 0, canvas.columns, code(line.header === index ? BOLD | INVERSE : BOLD));
    }
  }
}
