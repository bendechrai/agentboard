# board-tui Specification

## Purpose
`agentboard top`: a read-only, full-screen terminal view of the board,
the activity feed and agent lanes, drawn with plain ANSI output from the
shared board view-model and updated live from the board feed.

## Requirements

### Requirement: Top command
`agentboard top` SHALL run a full-screen, read-only terminal UI for the
board found by the usual discovery rules until the user quits or the
process receives SIGINT or SIGTERM, then restore the terminal and exit 0.
It SHALL write no event and no cursor, SHALL need no actor, and SHALL
accept and ignore `--as`. `--json` SHALL be accepted like on every
command; it changes nothing on the screen, and a failure is then reported
as the usual JSON error document. When no board is found it SHALL
exit 2 before changing any terminal mode.

#### Scenario: Quit restores the terminal
- **WHEN** `top` runs on a fake terminal and receives the key `q`
- **THEN** the terminal has left the alternate screen, shows the cursor, is out of raw mode, and the command resolves with exit code 0

#### Scenario: JSON error document when piped
- **WHEN** `agentboard top --json | cat` runs
- **THEN** it exits 1 and stdout is one JSON error document with reason `not-a-tty` and its hint

### Requirement: Interactive terminal required
`top` SHALL require stdin and stdout to be TTYs and the `TERM` environment
variable not to be `dumb`; otherwise it SHALL exit 1 with reason
`not-a-tty` before opening the board or writing anything to stdout, with
a hint naming `agentboard list` and `agentboard watch --as <actor>`.

#### Scenario: Piped output
- **WHEN** `agentboard top | cat` runs without `--json`
- **THEN** it exits 1 with reason `not-a-tty`, stdout is empty, and stderr has the hint

### Requirement: Views
`top` SHALL offer these views, computed with the board view-model:
- board: one column per status in the order of `boardColumns`, each headed
  by its status and card count, two lines per card, the title and then
  the assignee or `-` (the short id is left to the detail, as columns are
  narrow); closed tickets only when toggled on; at
  140 columns or more, the activity feed in a 40-column pane to the right;
- feed: one line per `feedEntries` entry, newest first, with
  `relativeTime`, actor, short ticket id and summary, late arrivals
  marked `late`;
- lanes: per `agentLanes` lane, the actor, "last seen" as `relativeTime`,
  and the held tickets;
- detail, over the current view: the selected ticket's fields, checklist,
  links and disposition, then its `conversation`, with decisions marked
  `[DECISION]`, retracted decisions `[DECISION, retracted]` and
  retractions `[RETRACTED]`.
The first line SHALL show the board directory and the ticket count per
status, and the last line the keys of the current view.

#### Scenario: Board at 80 columns
- **WHEN** a board with tickets in `todo`, `implementing` and `review` is rendered at 80x24
- **THEN** the frame shows six column headings with counts and each ticket's card in its status column

#### Scenario: Decision in the detail
- **WHEN** the detail of a ticket with a retracted `DECISION:` comment is open
- **THEN** that message is marked `[DECISION, retracted]`

### Requirement: Keys
`top` SHALL handle these keys: `1`, `2` and `3` select the board, feed
and lanes views, and Tab cycles through them; the arrow keys and `h`,
`j`, `k`, `l` move the selection; Enter opens the detail of the selected
ticket; Escape and Backspace close it; Page Up and Page Down scroll the
detail or the feed; `c` toggles closed tickets; `?` toggles a key help
overlay; `q` and Ctrl-C quit. Any other key SHALL be ignored.

#### Scenario: Open and close a detail
- **WHEN** on the board view the user presses `l` twice, `j` once and Enter, then Escape
- **THEN** the detail of the second card of the third column is shown and then closed, leaving that card selected

#### Scenario: Unknown key
- **WHEN** the user presses `z`
- **THEN** the frame is unchanged

### Requirement: Live updates
`top` SHALL follow the board with the board feed from the position id of
the snapshot it loaded, apply appends with `applyFeedMessage`, reload its
snapshot on a resync, and redraw on every model change, key press and
terminal resize, and at least every 10 seconds. A feed tick failing with
reason `busy` SHALL be shown on the last line until the next successful
tick; any other failure SHALL restore the terminal, print the error and
its hint on stderr, and exit with the error's exit code.

#### Scenario: Comment from another process
- **WHEN** `top` is running and another process comments on a ticket
- **THEN** within 3 seconds the feed view shows the comment without any key press

#### Scenario: Late arrival
- **WHEN** `top` is running and an event file sorting before its head is copied into `events/`
- **THEN** the snapshot is reloaded and the feed marks that event `late`

### Requirement: Frame rendering
Every frame SHALL be exactly as many lines as the terminal has rows, each
of exactly as many printable ASCII characters as it has columns, with
board text passed through the CLI's ASCII rendering and truncated with
`~` where it does not fit. Below 60 columns or 15 rows the frame SHALL
show only `terminal too small: need 60x15, have <c>x<r>`, and the program
SHALL keep running. The driver SHALL write only the lines that changed
since the previous frame, and SHALL emit no escape sequence other than
entering and leaving the alternate screen, hiding and showing the cursor,
cursor positioning, attribute reset, and SGR bold, dim, inverse and the
eight standard foreground colors; with a non-empty `NO_COLOR` it SHALL
emit no color.

#### Scenario: Frame dimensions
- **WHEN** random boards are rendered at random sizes from 60x15 to 200x60
- **THEN** every frame has exactly the terminal's rows, each line of exactly its columns, all printable ASCII

#### Scenario: Too small
- **WHEN** the terminal is resized to 50x10
- **THEN** the frame shows `terminal too small: need 60x15, have 50x10` and the program keeps running

#### Scenario: No color
- **WHEN** `NO_COLOR=1` is set
- **THEN** no SGR sequence from 30 to 37 is written

### Requirement: Terminal restoration
`top` SHALL restore the terminal (raw mode off, cursor shown, alternate
screen left) exactly once on every exit path: quit keys, SIGINT, SIGTERM,
a failed feed tick and an uncaught exception.

#### Scenario: Failure restores first
- **WHEN** a feed tick throws an integrity error while `top` runs on a fake terminal
- **THEN** the terminal is restored before the error is printed, and the exit code is 5
