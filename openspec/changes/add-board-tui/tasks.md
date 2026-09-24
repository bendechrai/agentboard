# Tasks

Depends on `add-board-web` groups 1 and 2 (the view-model and the board
feed) and on its snapshot loader (group 3); it does not need the web
client. Archive after `add-board-web` and `add-board-insights`; the
`board-cli` delta text includes both (if this change is archived before
`add-board-insights`, drop `health` and `board_health` from that text
first). Every group is delivered by a test author, an implementer and a
reviewer in turn (see CONTRIBUTING.md), on one branch per group named
`<area>/<group-slug>` and cut from `origin/staging`; the test author's
first commit defines the group's exported API as stubs. Verification for
every task includes `make check` and `make check-floor` passing with
coverage at or above 90 percent.

## 1. Frames, keys and UI state (`tui/frame`)

- [ ] 1.1 Implement `src/tui/keys.ts` (decoding raw input bytes into printable keys, Enter, Escape, Backspace, Tab, Ctrl-C, arrows, Page Up and Page Down, ignoring unknown sequences) and `src/tui/state.ts` (UI state and a pure `reduceKey`). Verify: table tests for every key's byte forms (including CSI and SS3 arrows and a sequence split across two reads), and for each "Keys" scenario, including selection clamping when a column empties
- [ ] 1.2 Implement `src/tui/frame.ts` (`renderFrame` for the board, feed, lanes and detail views, the header and key lines, the 140-column feed pane, the too-small screen, `~` truncation, and the style map). Verify: plain-text golden files for each view at 80x24 and 140x40, the too-small screen and a detail with a decision, a retracted decision and a retraction; the property test of "Frame dimensions"; and a reviewer recomputing one golden frame with a throwaway script

## 2. The `top` command (`tui/top-command`)

- [ ] 2.1 Implement `src/tui/terminal.ts`: the driver over a `TerminalIo` (alternate screen, hidden cursor, raw mode, changed-line writes with only the permitted sequences, `NO_COLOR`), one idempotent restore registered before any mode change, and the loop (snapshot load, `watchBoard` from its id, `applyFeedMessage`, reload on resync, redraw on model change, key, resize and every 10 seconds, `busy` shown on the last line). Verify: fake-terminal tests with a test-only interpreter of the permitted sequences, for quit by `q` and Ctrl-C, abort by signal, restoration exactly once on every exit path including an injected integrity failure (exit 5, restored before the error is printed), the too-small resize scenario, the no-color scenario, and a comment written by a child process on a real temporary board appearing within 3 seconds
- [ ] 2.2 Add the `top` registry entry (streaming, group `awareness`, description, examples, exit codes), the optional terminal handle on `StreamIo` supplied by `src/cli.ts` for `top` only, the `not-a-tty` check before opening the board, `top` in `EXCLUDED_COMMANDS`, and the `not-a-tty` hint. Verify: the built CLI spawned with pipes exits 1 with `not-a-tty` for `top` and `top --json` (JSON error document on stdout), the help drift guard, the hint completeness test, the MCP excluded-tool scenario, and the existing `watch` and `serve` tests unchanged

## 3. Documentation (`docs/tui`)

- [ ] 3.1 Document `top` in README.md (views, keys, non-TTY behavior, `NO_COLOR`, `reset` if a terminal is left in a bad state), write ADR 0008 (terminal UI without a library: pure frames, restricted ANSI output, fake-terminal tests), and update docs/STATUS.md. Verify: `make ascii`, `make validate-specs`, and running `agentboard top` on a temporary board in at least two terminal emulators while another shell writes events
