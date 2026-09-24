# Proposal

## Why

`add-board-web` shows what the board looks like now. The questions a
supervising human (or an orchestrator) actually asks are about what is
going wrong and how it got here: which claims have gone quiet, which
tickets have sat in `blocked` for a day, which `DECISION:` comments still
need promoting before anything can close, which merged tickets
`close-merged` will pick up, whether a `sync` just delivered events out of
order, and whether the cache still matches the log. Answering these today
means reading `list`, `show` and `inbox` output by hand. The event log
also holds the full history of the board and every hand-off between
agents, but nothing lets a human replay it or see the flow of work
between agents.

## What Changes

- A health panel in the web app, with thresholds the viewer can adjust:
  stale claims (assigned, open, the assignee idle beyond a threshold,
  default 2 hours), tickets stuck in `blocked` (default 24 hours),
  unpromoted `DECISION:` comments, candidates for `close-merged` (and
  merged tickets it can never close), late sync arrivals observed by the
  server, and the result of `rebuild --check` run on request.
- `agentboard health [--stale-after <duration>] [--blocked-after
  <duration>] [--check]`: the same report from the CLI, with `--json`,
  and therefore also the MCP tool `board_health`, so an orchestrator can
  run it before archiving a change.
- Replay: a time slider that rebuilds the board at any past position of
  the event log, in the browser, with the same pure fold the store uses;
  step, play and pause.
- A hand-off graph: actors as nodes, hand-offs as directed edges with
  counts, filterable by change and time, with an edge animated when a new
  hand-off arrives live.
- All of it is computed by new pure view-model functions (`healthReport`,
  `replayState`, `handoffGraph`), shared by the CLI and the web.

## Capabilities

### New Capabilities
- `board-insights`: the health report and its checks and thresholds, the
  `health` command, replay, the hand-off graph, and their web views and
  API routes.

### Modified Capabilities
- `board-cli`: "Command surface" gains `health`; "MCP server" lists
  `board_health`. The text of both assumes `add-board-web` is archived
  first.

## Non-Goals

- Asking GitHub from the UI. Whether a pull request is merged is known
  only to `close-merged` (through `gh`); the health report says which
  tickets `close-merged` would consider and why, not whether it will close
  them now.
- Persisting observations. Late arrivals are what the running server saw
  since it started; nothing is written to the board or the cache.
- Notifications or alerts outside the page.
- Any new event kind or schema change.

## Impact

- New source: `src/view/health.ts`, `src/view/replay.ts`,
  `src/view/graph.ts`, `src/board/health.ts` (the CLI operation), client
  views under `src/web/client/`, and two server routes.
- No new dependency; replay bundles the existing pure fold into the
  client (made possible by `add-board-web` group 1).
- New reason with a hint: none beyond `usage` (a malformed duration is a
  usage error).
- README section; the orchestrator checklist in the agent guide gains
  `agentboard health` before archiving.
