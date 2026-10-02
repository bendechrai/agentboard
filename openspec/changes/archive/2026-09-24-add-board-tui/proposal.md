# Proposal

## Why

Many of the people supervising coding agents live in a terminal, often
over SSH on the machine where the agents run, where opening a browser on
`127.0.0.1` is awkward. `watch` streams one actor's inbox as lines; there
is no terminal view of the whole board, the activity across all agents,
or a ticket's conversation. `add-board-web` built a board-wide feed and a
pure view-model precisely so a second client costs little.

## What Changes

- `agentboard top`: a full-screen, read-only terminal UI with four views
  (the board as status columns, the live activity feed, agent lanes, and a
  ticket detail pane with the conversation), keyboard navigation, and live
  updates from the same board feed `serve` uses, including resyncs after
  late `sync` arrivals.
- Built on the shared view-model (`board-view-model`): columns, feed
  entries, conversation and lanes are the same functions the web app
  uses; this change adds only terminal layout and input handling.
- Hand-rolled ANSI output (alternate screen, cursor addressing, a few SGR
  attributes), no terminal UI library. Every frame is a pure function of
  the model, the UI state, the terminal size and `now`, so it is tested
  with plain-text snapshots and a fake terminal.
- Outside an interactive terminal `top` exits 1 with reason `not-a-tty`
  and points to `list` and `watch`.

## Capabilities

### New Capabilities
- `board-tui`: the `top` command, its views, keys, rendering rules,
  terminal handling and non-TTY behavior.

### Modified Capabilities
- `board-cli`: "Command surface" gains `top`; "MCP server" excludes it;
  "Exit codes" names `not-a-tty`. The text is the main spec as archived
  from `add-board-web`, plus `top`; it does not assume
  `add-board-insights`.

## Non-Goals

- Write actions from the terminal UI: agents and humans already have the
  CLI in the same terminal.
- Health, replay and the hand-off graph in the terminal (they remain web
  views; `agentboard health` covers health in a terminal).
- Mouse support, themes, Unicode box drawing: output is plain ASCII like
  every other human output of the CLI.
- Windows console support beyond what Node's TTY layer gives for ANSI.

## Impact

- New source: `src/tui/` (frame renderer, UI state reducer, key decoder,
  terminal driver) and a `top` registry entry.
- `StreamIo` gains an optional terminal handle (input stream, size,
  resize notifications, raw mode), supplied by `src/cli.ts` for `top`
  only; `watch` and `serve` are unaffected.
- No new dependency, runtime or development.
- New reason with a hint: `not-a-tty`.
- README section; ADR 0008 (terminal UI without a library).
