# Design

## Context

`add-board-web` provides the board feed, the pure view-model layer under
`src/view/`, the read-only server and the Preact client, and makes the
fold bundleable for the browser. This change adds three insights on top,
as view-model functions plus views, and one CLI command. Nothing here
writes an event, and the only store call beyond ordinary reads is the
existing `checkCache` (`rebuild --check`), run on request.

## Goals / Non-Goals

**Goals:**
- Each health check has one definition, used by the web panel, the CLI
  and the MCP tool, with thresholds stated and adjustable.
- Replay shows exactly what the fold computes, not a second
  implementation of the state machine.
- No guarantee weakens: nothing blocks writers except the explicit,
  user-requested cache check, which behaves exactly as `rebuild --check`.

**Non-Goals:**
- Calling `gh` from the server or the page.
- Storing observations, alerts, notifications.

## Decisions

### Health checks and their definitions
`healthReport(input)` is pure. Its input is the board model (tickets and
events with outcomes), `now`, the thresholds, and optionally what only a
running server knows (observed late arrivals and the last cache check).
Times are event walls; a negative age counts as 0.

- **Stale claim**: an open ticket, not in `merged`, with an assignee,
  whose assignee has been idle for at least `staleAfter` (default 2
  hours). Idle is measured from the later of: the assignee's own latest
  applied event on that ticket, and the applied event that made them the
  assignee (`ticket.claim`, `ticket.handoff` or `ticket.assign`). A
  reviewer commenting on the ticket does not make the implementer look
  busy.
- **Stuck in blocked**: an open ticket in `blocked` whose applied event
  into `blocked` (a `ticket.move` to `blocked`, or a `ticket.handoff`
  with status `blocked`) is at least `blockedAfter` old (default 24
  hours). The report names the status it was blocked from and the latest
  comment, which by convention says why.
- **Unpromoted decision**: an open ticket with at least one open
  `DECISION:` comment (`openDecisions`, the same function `close` uses)
  and no `decision` link. Closed tickets are excluded: closing already
  required a disposition.
- **close-merged candidates**, split three ways, all open tickets in
  `merged`:
  - `ready`: at least one `pr` link, and no open decision or a `decision`
    link. `close-merged` will close it once `gh` reports the PR merged.
  - `heldByDecision`: at least one `pr` link, open decisions and no
    `decision` link. `close-merged` would skip it with the decision rule.
  - `missingPr`: no `pr` link. `close-merged` never considers it; it needs
    `link --pr` or a manual `close`.
  The report never claims a PR is merged; the page says so beside the
  list.
- **Late arrivals** (server only): the events the server's feed reported
  as late or removed in a resync since it started, newest first, at most
  the last 100, each with the time the server observed it. The CLI report
  has `late: null`, because a one-shot command cannot observe arrival
  order.
- **Cache check** (on request only): the result of `checkCache`, with the
  time it ran and the number of differing rows. It takes the write lock
  for the length of a full refold into memory, exactly like
  `rebuild --check`, so it never runs automatically: the page runs it when
  the user presses a button, and the CLI with `--check`.

Alternatives considered for idleness: the ticket's `updatedAt` (any
actor's event resets it, hiding an absent assignee); a presence heartbeat
(needs a new event kind, which this work must not add).

Default thresholds (2 hours, 24 hours) are constants in
`src/view/health.ts`. Agents work in bursts of minutes, so two hours of
silence from a holder is worth a look; `blocked` waits on humans, so a
day. Both are adjustable per request.

### Durations
`--stale-after` and `--blocked-after` take `<n>m`, `<n>h` or `<n>d`, with
`<n>` a positive decimal integer of at most 5 digits. Anything else is
exit 1 with reason `usage`. The same parser validates the page's
threshold inputs.

### The `health` command
`agentboard health [--stale-after <d>] [--blocked-after <d>] [--check]
[--json]` reads the cache for ticket state and the event files of the
applied events of open tickets (the checks need the time of specific
events, which the cache does not keep), in one read snapshot, and prints
the report. It writes nothing and needs no actor. It exits 0 whatever it
finds: findings are data, and a failing exit would make the command
unusable as an MCP tool call whose result an agent reads. Group
`awareness`. Because it is an ordinary command, it becomes the MCP tool
`board_health` with no extra work.

Alternatives considered: exit 1 when anything is found (useful for
scripts, but conflates "the check ran" with "the board is unhealthy";
`jq` on `--json` output covers scripts); no CLI counterpart (the checks
are cheap to expose once they are pure functions, and an orchestrator is
the natural consumer).

### Replay in the browser with the store's own fold
The client already holds every well-formed event with its outcome. Replay
freezes that list when opened, and `replayState(events, index)` folds the
first `index + 1` events in fold order with the pure `fold` from
`src/events/fold.ts`, bundled into the client. Outcomes are recomputed by
the fold, so an event that was rejected at the time shows as rejected in
replay. To keep scrubbing fast the client keeps a checkpoint of the folded
state every 500 events and folds forward from the nearest one; replay of a
position is independent of the path taken to reach it.

Replay shows the history as the log now orders it: an event synced late
appears at its fold position, not when it arrived. This is the only
history the log can reproduce and is stated on the page.

Controls: a slider over positions, step back and forward, play and pause
at 1, 4 or 16 events per second, the event at the current position
described with `describeEvent`, the board rendered with the same column
component as the live board, and a button back to live. New events that
arrive while replaying extend the live model, not the frozen list.

Alternatives considered: server-side replay (`GET /api/replay?at=<hash>`):
each scrub step becomes a request that refolds on the server, which is
slower to scrub and duplicates what the client can do with the events it
already holds; replaying by wall time instead of fold position: several
events share a wall across machines, and the fold order is what defines
state.

### Hand-off graph
`handoffGraph(events, filter)` counts applied `ticket.handoff` events as
directed edges from the event's actor to `body.to`, with the count and
the latest hand-off per edge. Nodes are the actors on any edge, with sent
and received totals. A self hand-off (same actor, for example a status
change with a note) is a self-loop. Filters: change (task reference
`<source>:<ref>`) and `since` (a wall time). `ticket.assign` and claims are
not hand-offs and are not counted.

The page draws it as SVG with no graph library: nodes on a circle in
actor name order (stable when an actor is added: positions are
recomputed but the order is deterministic), edges as arrows whose width
grows with the logarithm of the count, labelled with the count. An edge
whose latest hand-off arrived within the last 3 seconds is animated.

Alternatives considered: a force-directed layout (needs a library such as
d3-force or a hand-rolled simulation, and moves nodes on every update,
which fights the animation); a Sankey of statuses (answers a different
question, flow between statuses rather than between agents).

### Server additions
- `GET /api/health`: `{late, check}`: the observed late arrivals and the
  last check result (or null).
- `GET /api/health/check`: runs `checkCache` and returns its summary. One
  run at a time; a request while one runs waits for it; a result younger
  than 30 seconds is returned without running again. It is a `GET`
  because it changes nothing (the check always rolls back), and it is
  behind the same token and Host checks as every route.

The health panel computes the rest in the browser with `healthReport`,
re-evaluated on every model change and every 10 seconds.

## Interfaces (sketch)

- `src/view/health.ts`: `HealthThresholds`, `DEFAULT_THRESHOLDS`,
  `parseDuration(text)`, `healthReport({ model, now, thresholds, late?,
  check? })` returning `HealthReport` `{ now, thresholds, staleClaims,
  stuckBlocked, unpromotedDecisions, closeMerged: { ready, heldByDecision,
  missingPr }, late, check }`.
- `src/view/replay.ts`: `replayState(events, index, checkpoints?)`.
- `src/view/graph.ts`: `handoffGraph(events, { change?, since? })`
  returning `{ nodes, edges }`.
- `src/board/health.ts`: `boardHealth(board, { thresholds, check, now })`.

## Risks / Trade-offs

- [The cache check blocks writers while it runs] -> only on explicit
  request, single-flight, and cached for 30 seconds; the button says it
  briefly pauses writers.
- [Wall clock skew makes ages wrong] -> ages clamp at 0; the report shows
  the event walls it used so a human can judge.
- [Replay of a large board in the browser] -> checkpoints every 500 events
  bound a seek to at most 500 fold steps; memory is one state per
  checkpoint, acceptable at the target scale of 20,000 events.
- [`health` reads event files] -> only those of open tickets, and the
  content-addressed files are never re-read within a process.
