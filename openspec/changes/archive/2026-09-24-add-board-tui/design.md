# Design

## Context

`add-board-web` provides the board feed (`watchBoard`: append and resync
messages over the `watch` tick machinery), the snapshot loader the server
uses for `/api/board` and `/api/events`, and the pure view-model
(`boardColumns`, `feedEntries`, `describeEvent`, `conversation`,
`agentLanes`, `relativeTime`, `applyFeedMessage`). Streaming commands
already exist (`watch`, `serve`): `runCliAsync` hands them a `StreamIo`
with a stop signal. This change adds a terminal client.

## Goals / Non-Goals

**Goals:**
- A live, whole-board terminal view with the same content as the web app's
  board, feed, lanes and detail views.
- No new dependency; testable without a real terminal.
- The terminal is always restored, whatever ends the program.

**Non-Goals:**
- Writing from the TUI, insights in the TUI, mouse, Unicode art.

## Decisions

### The command is `top`
`agentboard top` names what it is for, a live read-only monitor of the
board in the spirit of `top(1)`, rather than the technology (`tui`). It
sits in the help group `awareness` beside `inbox`, `watch` and `serve`.
It writes nothing and needs no actor (`--as` is accepted and ignored),
and has no flags of its own beyond the global ones; filters are keys.

Alternatives considered: `tui` (describes the implementation, and reads
oddly in `agentboard help`); `board` (ambiguous next to the board
directory); `watch --all` (overloads a command whose contract is a line
stream for one actor).

### Hand-rolled ANSI rather than a library
The UI is a grid of fixed panes redrawn from state; it needs cursor
addressing, an alternate screen, a handful of attributes (bold, dim,
inverse, 8 foreground colors) and key decoding. That is a small, well
known subset of ANSI and needs no layout engine.

- A frame is produced by `renderFrame(model, ui, size, now)`: a pure
  function returning exactly `rows` lines, each exactly `columns`
  characters of printable ASCII, plus a style map (runs of attributes per
  line). Board text passes through `asciiText`, so width is one column
  per character and no East Asian width or combining character logic is
  needed.
- The terminal driver enters the alternate screen, hides the cursor and
  enables raw mode; after each change it writes only the lines that
  differ from the previous frame, each as cursor position, the styled
  text and a reset. It emits only `ESC[?1049h`, `ESC[?1049l`, `ESC[?25l`,
  `ESC[?25h`, `ESC[<row>;<col>H`, `ESC[0m` and SGR 1, 2, 7 and 30 to 37.
  With `NO_COLOR` set to a non-empty value it emits no color (bold, dim
  and inverse remain, for the selection).
- Keys are decoded from raw input bytes: printable characters, Enter,
  Escape, Backspace, Tab, Ctrl-C, the four arrows, Page Up and Page Down
  (their common CSI forms). Unknown sequences are ignored.

Alternatives considered:
- ink: React for the terminal. It brings React, a reconciler and the yoga
  layout engine (WebAssembly) as runtime dependencies of the CLI package,
  for a fixed-pane layout; its test renderer is its own. The shared
  view-model is not React, so the web's Preact components could not be
  reused anyway.
- blessed or neo-blessed: large, unmaintained or sporadically maintained,
  and carries terminfo parsing we do not need.
- A curses binding: a native dependency, which the package has avoided so
  far (`node:sqlite` is built in).

### Structure
- `src/tui/state.ts`: the UI state (current view, selection per view,
  detail open or closed and its scroll offset, whether closed tickets are
  shown, help overlay) and a pure `reduceKey(ui, key, model)`.
- `src/tui/frame.ts`: `renderFrame`, and the layout of each view.
- `src/tui/keys.ts`: the byte-to-key decoder.
- `src/tui/terminal.ts`: the driver over a `TerminalIo` (write, size,
  resize events, input data, raw mode) and the `top` loop: load the model
  with the snapshot loader, start `watchBoard` from its position id, apply
  appends with `applyFeedMessage`, reload on resync, redraw on every model
  change, key, resize and every 10 seconds (relative times).

### Layout
Top line: `agentboard top`, the board directory, the ticket count per
status, and the time since the last event. Bottom line: the keys of the
current view. Between them, the current view:

- Board: six columns (`todo`, `tests`, `implementing`, `review`,
  `blocked`, `merged`) of equal width, each headed by its status and
  count, cards as two lines (title, then assignee, each truncated with `~`;
  at 80 columns a column is 12 cells wide, too narrow for the short id),
  the selected card inverse, cards that changed in the last 5 seconds
  bold. At 140 columns or more, the activity feed is shown in a 40-column
  pane to the right.
- Feed: one line per entry, newest first: relative time, actor, ticket
  short id and `describeEvent` summary; late arrivals marked `late`.
- Lanes: one block per actor: name, "last seen", held tickets.
- Detail (over the current view): ticket fields, checklist, links, then
  the conversation, messages as `<actor>: <text>` wrapped to width,
  decisions marked `[DECISION]`, retracted ones `[DECISION, retracted]`,
  retractions `[RETRACTED]`, system lines indented.

The minimum size is 60 columns by 15 rows; below it the whole screen shows
`terminal too small: need 60x15, have <c>x<r>` and the program keeps
running until the terminal grows or the user quits.

### Keys
`1` board, `2` feed, `3` lanes, and Tab cycles through them; arrows or
`h`, `j`, `k`, `l` move the selection (left and right between columns on
the board, up and down within a column, the feed or the lanes); Enter
opens the
detail of the selected ticket (the entry's ticket in the feed, the first
held ticket or the selected one in lanes); Escape or Backspace closes it;
Page Up and Page Down scroll the detail or the feed; `c` toggles closed
tickets; `?` toggles the key help; `q` or Ctrl-C quits. In raw mode Ctrl-C
arrives as a byte, not as SIGINT, so it is handled as a key; SIGINT and
SIGTERM from elsewhere also stop the program.

### Non-TTY and terminal restoration
`top` requires stdin and stdout to be TTYs and `TERM` not to be `dumb`;
otherwise it exits 1 with reason `not-a-tty` before opening the board,
with the hint to use `agentboard list` for a snapshot or
`agentboard watch --as <actor>` for a line stream. The driver restores the
terminal (raw mode off, cursor shown, alternate screen left) on quit, on
SIGINT and SIGTERM, when a tick fails with an error other than `busy`
(the error is then printed after restoring, and the exit code is the
error's), and on an uncaught exception, through one idempotent restore
function registered before the alternate screen is entered.

### Testing strategy
- Frames: `renderFrame` snapshot tests of the plain text, in golden files
  under `src/tui/__tests__/`, for each view at 80x24 and 140x40, the too
  small screen, a detail with a decision and a retraction, and titles
  needing truncation; a property test that every frame has exactly `rows`
  lines of exactly `columns` printable ASCII characters for random models
  and sizes from 60x15 to 200x60.
- Keys and state: table tests of the decoder and `reduceKey`.
- Driver: a fake `TerminalIo` capturing writes, interpreted by a small test
  helper that understands only the sequences listed above (so the
  restricted output set is itself tested), driving keys and resizes, and
  checking restoration on quit, on abort and on an injected failure.
- Live updates: the driver on a real temporary board with the fake
  terminal, a comment written by a child process appearing within 3
  seconds.
- Non-TTY: the built CLI spawned with pipes (not a TTY) exits 1 with
  `not-a-tty`. A pseudo-terminal library (node-pty) was rejected: it is a
  native dependency, and the fake terminal covers the driver.

## Risks / Trade-offs

- [Terminal differences] -> the output subset is supported by every
  terminal emulator in common use (xterm, iTerm2, Terminal.app, GNOME,
  Windows Terminal, tmux, screen); unknown input sequences are ignored.
- [A crash leaving the terminal in raw mode] -> restoration is registered
  before any mode change and runs on every exit path; the README says
  `reset` recovers a terminal in the worst case.
- [Large boards] -> a frame renders only visible rows; the feed entries
  are computed once per model change, not per frame.
- [ASCII-only text loses non-ASCII titles] -> consistent with every human
  output of the CLI (board-cli "Output conventions"); the web app shows
  them in full.
