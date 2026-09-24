# Tasks

Depends on `add-board-web` (all groups): the view-model layer, the board
feed, the server and the client. The `board-cli` delta text is the
current main spec (with `add-board-web` archived) plus `health`; if
`add-board-tui` is archived first, re-sync that MODIFIED text with the
main spec (keeping `top`) before archiving this change. Every group
is delivered by a test author, an implementer and a reviewer in turn (see
CONTRIBUTING.md), on one branch per group named `<area>/<group-slug>` and
cut from `origin/staging`; the test author's first commit defines the
group's exported API as stubs. Verification for every task includes
`make check` and `make check-floor` passing with coverage at or above 90
percent.

## 1. Insight view-model (`view/insights`)

- [x] 1.1 Implement `src/view/health.ts`: `DEFAULT_THRESHOLDS`, `parseDuration` and `healthReport` with every check as board-insights defines it. Verify: table tests for every "Health report" scenario, the idle rule (a reviewer's comment does not reset the holder's idle time; the event that made them assignee does), a handoff with status `blocked` counting as the entry into `blocked`, closed tickets excluded from every section, negative ages clamped to 0, and `parseDuration` accepting `1m`, `99999d` and refusing `0h`, `100000m`, `2hours`, `h`, `-1h`
- [x] 1.2 Implement `src/view/replay.ts` (`replayState` with checkpoints every 500 events) and `src/view/graph.ts` (`handoffGraph` with change and `since` filters). Verify: tests for every "Replay" and "Hand-off graph" scenario, a property test over random event sequences that `replayState` at every index equals `fold` of the prefix and is the same reached directly or by stepping from a random position, and the layering test covering both modules

## 2. The `health` command (`board/health-command`)

- [x] 2.1 Implement `boardHealth` in `src/board/health.ts` (ticket state from the cache, event bodies from the applied events' files, each read once, one read snapshot, `--check` through `checkCache`) and the `health` registry entry (group `awareness`, flags, description, examples, exit codes, human rendering). Verify: tests for the three "Health command" scenarios, a malformed duration (exit 1 `usage` with its hint), an injected reader proving that each applied event file is read at most once, inside the read snapshot, and that no rejected, unknown-kind or malformed event file is read, a `--check` mismatch still exiting 0 with nothing on stderr, the help drift guard, and the MCP tool list including `board_health` with its three optional properties
- [x] 2.2 Add `agentboard health` to the orchestrator checklist of the agent guide (before archiving a change, and when choosing what to dispatch). Verify: the guide tests (every `agentboard ` line parses, at most 150 lines, ASCII) pass with the new line

## 3. Insight views (`web/insights`)

- [ ] 3.1 Add `GET /api/health` (observed late and removed events, at most 100, newest first, with observation times) and `GET /api/health/check` (single-flight, results reused for 30 seconds). Verify: server tests for the "Late arrival shown in health" and "Check is single-flight and cached" scenarios with an injected clock, a check never running without a request, and both routes refusing requests without the token or with a foreign Host
- [ ] 3.2 Implement the health view (sections from `healthReport`, threshold inputs with invalid values flagged, the check button, the close-merged note). Verify: component tests for each section rendering, threshold changes re-evaluating the report, an invalid duration leaving the report unchanged, and the check result shown after the button is pressed
- [ ] 3.3 Implement the replay view (frozen event list, slider, step, play and pause at 1, 4 and 16 events per second, current event description, replayed columns, back to live) and the hand-off graph view (SVG circle layout, counted edges, change and time filters, 3 second animation of an edge on a live hand-off). Verify: component tests with fake timers for play and pause, stepping across a rejected claim, back to live, events arriving during replay not changing the frozen list, the graph's nodes and edge labels for the "Counts per pair" scenario, and the animation class present for 3 seconds after a hand-off arrives

## 4. Documentation (`docs/insights`)

- [ ] 4.1 Document the health checks with their definitions and default thresholds, the `health` command and `board_health`, replay and the hand-off graph in README.md, and update docs/STATUS.md. Verify: `make ascii`, `make validate-specs`, and running `agentboard health` and `agentboard health --check --json` on a temporary board with a stale claim, a blocked ticket and a merged ticket without a PR link
