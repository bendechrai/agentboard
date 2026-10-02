# 8. Terminal UI without a library

Date: 2026-09-24

## Status

Accepted

## Context

`agentboard top` (OpenSpec change `add-board-tui`) is a full-screen,
read-only terminal view of the board: status columns, the activity feed,
agent lanes and a ticket's conversation, updated live. It needs cursor
addressing, an alternate screen, a handful of text attributes, raw key
input and a redraw whenever the model, a key or the terminal size
changes. The content is already computed by the pure view-model of ADR
0007 (`boardColumns`, `feedEntries`, `conversation`, `agentLanes`,
`applyFeedMessage`), so the terminal client only adds layout and input
handling.

Three things constrain the choice. The CLI package has no native
dependency (`node:sqlite` is built in) and few runtime ones. A terminal
program that crashes in raw mode on the alternate screen leaves the user
with a terminal that does not echo, which is worse than the program not
existing. And the project's rule is that behavior is tested, including
coverage at or above 90 percent, which a program drawing to a real
terminal makes hard.

## Decision

**No terminal UI library.** `src/tui/` is hand-rolled over Node's TTY
layer, in four modules, three of them pure:

- `keys.ts` decodes raw input bytes into keys: printable characters,
  Enter, Escape, Backspace, Tab, Ctrl-C, the arrows (CSI and SS3 forms),
  Page Up and Page Down, including a sequence split across two reads.
  Unknown sequences are ignored. A lone Escape is decided after 50 ms
  without further input.
- `state.ts` holds the UI state (view, a selection per view, the open
  detail and its scroll, closed tickets shown, help, a notice, quit) and
  the pure reducers `reduceKey` and `reconcileUi`. Selections carry the
  identity of what they select, so a card that moves stays selected.
- `frame.ts` has `renderFrame(model, ui, size, now)`: a pure function
  returning exactly `rows` lines of exactly `columns` printable ASCII
  characters plus a style map (runs of bold, dim, inverse and one of the
  eight standard colors). Styles are data, not escape codes. Board text
  goes through the CLI's `asciiText`, so every character is one column
  wide and no East Asian width or combining-character logic is needed;
  text that does not fit ends in `~`. Below 60x15 the frame is a single
  `terminal too small` line.
- `terminal.ts` is the only module that does IO, and only through a
  `TerminalIo` interface (write, size, resize, input, end of input, raw
  mode, process exit) that `processTerminal` adapts to the real process.

**A restricted set of ANSI sequences.** The driver writes printable ASCII
and nothing but `ESC[?1049h` and `ESC[?1049l` (enter and leave the
alternate screen), `ESC[?25l` and `ESC[?25h` (hide and show the cursor),
`ESC[<row>;<col>H` (cursor position) and SGR with the parameters 0, 1, 2,
7 and 30 to 37. No carriage return, line feed, erase, scroll or bell is
ever written, every row is placed by an explicit cursor position, and no
text is written past the last column of a row, so nothing depends on a
terminal's line discipline, wrapping or scrolling behavior. With a non-empty
`NO_COLOR` no color parameter is written; bold, dim and inverse remain,
so the selection still shows.

**Changed-line writes.** The driver keeps the last frame it drew. A draw
renders the current frame and writes only the rows whose text or style
runs differ, each in full: cursor position, the cells with their styles,
then `ESC[0m`. A resize, or the first draw, writes every row. A draw
where nothing changed writes nothing, so the 10-second redraw that keeps
relative times current costs nothing on a quiet board, and an ignored key
writes no byte.

**One idempotent restore on every exit path.** The first snapshot is
loaded before the terminal is touched, so a missing or unreadable board
fails with the terminal unchanged. Then, before any mode change, one
restore function is registered on process exit; its first call turns raw
mode off and writes `ESC[0m`, `ESC[?25h` and `ESC[?1049l`, and every later
call does nothing. It runs on `q`, on Ctrl-C (a byte in raw mode, so
handled as a key), on SIGINT and SIGTERM, at the end of input, on a feed,
reload or render failure, and on an uncaught exception. On a failure the
error is rethrown only after the restore, so the CLI prints it and its
hint on a normal screen and exits with the error's code. A `busy` feed
tick is not a failure: it is shown at the start of the key line.

**Not a TTY is refused early.** `top` requires stdin and stdout to be
TTYs and `TERM` not to be `dumb`, and otherwise exits 1 with reason
`not-a-tty` (and a hint naming `list` and `watch`) before it looks for
the board or writes anything to stdout. The terminal handle is an
optional field of `StreamIo` that `src/cli.ts` supplies for `top` only, so
`watch`, `serve` and the MCP server are unaffected; `top` is excluded
from the MCP tools.

**Fake-terminal and fake-TTY tests.** Frames are tested as plain-text
golden files (each view at 80x24 and 140x40, the too-small screen, a
detail with decisions, retracted decisions and retractions) and with a
property test of the frame dimensions for random boards and sizes. Keys
and state are table tests. The driver runs against a fake `TerminalIo`
whose writes are replayed by a test-only interpreter that understands
only the permitted sequences, so an unexpected escape sequence fails the
test and the reconstructed screen is compared cell by cell and style by
style. Those tests cover quit by `q` and Ctrl-C, abort by signal,
restoration exactly once on every exit path including an injected
integrity failure (exit 5, restored before the error is printed), resize
to too small, `NO_COLOR`, and a comment written by a child process on a
real temporary board appearing within 3 seconds. `processTerminal` is
tested against a fake host (fake stdin and stdout with `isTTY`, sizes and
events), and the built CLI is spawned with pipes to check `not-a-tty`.

## Rationale

The layout is a grid of fixed panes redrawn from state, which needs no
layout engine, no component tree and no terminfo. Keeping the frame a
pure function of its inputs means the whole visible behavior is tested as
text, at any size, without a terminal, and the reviewer can recompute a
golden frame with a throwaway script. Restricting output to a short,
documented list of sequences, all supported by every terminal emulator
and multiplexer in common use (xterm, iTerm2, Terminal.app, GNOME
Terminal, Windows Terminal, tmux, screen), removes most terminal
differences by construction, and makes the list itself testable through
the interpreter. Writing only changed rows keeps output small over SSH.
One restore function that is idempotent and registered first is simpler
to reason about than restoring in each handler, and running it exactly
once is an assertion the tests can make.

## Consequences

- No new runtime or development dependency; the package stays free of
  native modules.
- Every piece of terminal behavior agentboard needs is its own code to
  maintain: key decoding, the layout of each view and the driver. Adding
  mouse support, Unicode box drawing or wide-character text would mean
  extending them (and the permitted-sequence list and its interpreter)
  rather than turning on a library feature.
- Non-ASCII board text is shown escaped, as in every human output of the
  CLI; the web app of `serve` shows it in full.
- The frame is fully redrawn on resize and partly on every change; there
  is no scroll-region optimization, which the board's size does not need.
- Real terminal emulators are not exercised by the automated tests; the
  restricted sequence list is what makes that acceptable. If a terminal
  is ever left in a bad state, the README tells the user to run `reset`.

## Alternatives considered

**ink** (React for the terminal). It would bring React, a reconciler and
the yoga layout engine (WebAssembly) into the CLI's runtime dependencies
for a fixed-pane layout, and comes with its own test renderer instead of
plain-text frames. The shared view-model is plain functions rather than
React, and the web client's Preact components could not be reused in ink
anyway, so it would add a second component model without saving any
code.

**blessed or neo-blessed.** Large, unmaintained or sporadically
maintained, and built around terminfo parsing and widgets that `top` does
not need.

**A curses binding.** A native dependency, which the package has avoided
so far.

**A pseudo-terminal library for tests (node-pty).** Also a native
dependency; the fake `TerminalIo` with the sequence interpreter tests the
driver, and the fake host tests the adapter to the real process.
