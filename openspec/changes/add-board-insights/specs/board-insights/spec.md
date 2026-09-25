# Spec Delta

## ADDED Requirements

### Requirement: Health report
`healthReport` SHALL be a pure view-model function (see board-view-model)
of the board's tickets and events, `now`, the thresholds `staleAfter`
(default 2 hours) and `blockedAfter` (default 24 hours), and, when
supplied by a server, the observed late arrivals and the last cache check.
Every age SHALL be `now` minus an event wall, and 0 when that is negative.
The report SHALL contain:
- `staleClaims`: every open ticket not in `merged` with an assignee whose
  idle time is at least `staleAfter`, where idle time is measured from the
  later of the assignee's own latest applied event on the ticket and the
  applied `ticket.claim`, `ticket.handoff` or `ticket.assign` that made
  them the assignee;
- `stuckBlocked`: every open ticket in `blocked` whose applied event into
  `blocked` (a `ticket.move` to `blocked`, or a `ticket.handoff` with status
  `blocked` from a ticket not already in `blocked`; a hand-off within
  `blocked` reassigns it without restarting the clock) is at least
  `blockedAfter` old, with the status it was
  blocked from and its latest comment;
- `unpromotedDecisions`: every open ticket with at least one comment in
  `openDecisions` and no `decision` link, with those comments;
- `closeMerged`: the open tickets in `merged`, split into `ready` (at
  least one `pr` link, and no open decision or a `decision` link),
  `heldByDecision` (at least one `pr` link, open decisions and no
  `decision` link) and `missingPr` (no `pr` link);
- `late`: the server's observed late arrivals, or null when not supplied;
- `check`: the last cache check result, or null when not supplied.

#### Scenario: Idle holder is stale
- **WHEN** `impl-1` claimed T1 at wall 0, `reviewer` commented on T1 at wall 7000000, `staleAfter` is 2 hours and `now` is 7300000
- **THEN** T1 is in `staleClaims` with an idle time of 7300000 milliseconds

#### Scenario: Active holder is not stale
- **WHEN** `impl-1` claimed T1 at wall 0 and commented on it at wall 7000000, and `now` is 7300000
- **THEN** T1 is not in `staleClaims`

#### Scenario: Blocked for a day
- **WHEN** T1 was moved from `implementing` to `blocked` 25 hours before `now` with the default thresholds
- **THEN** T1 is in `stuckBlocked` with `implementing` as the status it was blocked from

#### Scenario: Decision without a decision link
- **WHEN** open ticket T1 has the comment `DECISION: use sessions` and no `decision` link
- **THEN** T1 is in `unpromotedDecisions` with that comment, and after `link T1 --decision docs/adr/0009.md` it is not

#### Scenario: close-merged candidates
- **WHEN** three open tickets are in `merged`: A with a `pr` link, B with a `pr` link and an open `DECISION:` comment, C with no `pr` link
- **THEN** A is in `ready`, B in `heldByDecision` and C in `missingPr`

### Requirement: Durations
Thresholds SHALL be written as `<n>m`, `<n>h` or `<n>d`, where `<n>` is a
positive decimal integer of at most 5 digits (minutes, hours, days). Any
other text SHALL be refused with exit 1 and reason `usage` on the CLI, and
SHALL be shown as invalid, without changing the report, in the web panel.

#### Scenario: Malformed duration
- **WHEN** `agentboard health --stale-after 2hours` runs
- **THEN** it exits 1 with reason `usage` naming the accepted forms

### Requirement: Health command
`agentboard health [--stale-after <duration>] [--blocked-after <duration>]
[--check]` SHALL print the health report of the board, with `late` null,
and with `check` null unless `--check` is given, in which case it SHALL
run the same comparison as `rebuild --check` and include its result
(whether the cache matches and the number of differing rows). It SHALL
read ticket state from the cache and event bodies from the event files of
applied events, reading each file at most once, within one read snapshot
(the cache does not record which ticket an event belongs to, so the files
of closed tickets cannot be skipped without reading them), SHALL
write nothing, SHALL need no actor, and SHALL exit 0 whatever the report
contains. Human output SHALL list each section with its count and one
line per ticket in the `list` format followed by the finding; `--json`
SHALL print the report as one JSON document.

#### Scenario: JSON report
- **WHEN** `agentboard health --json` runs on a board with one stale claim
- **THEN** stdout is one JSON document whose `staleClaims` has one entry, `late` is null, `check` is null, and the exit code is 0

#### Scenario: Check included on request
- **WHEN** `agentboard health --check --json` runs on a board whose cache matches the event log
- **THEN** the document's `check` reports a match with 0 differing rows

#### Scenario: Health over MCP
- **WHEN** an MCP client calls `board_health` with `{"stale-after": "30m"}`
- **THEN** the result is the same document `agentboard health --stale-after 30m --json` prints

### Requirement: Health in the web app
The web app SHALL offer a health view computed with `healthReport` in the
browser, re-evaluated on every model change and at least every 10
seconds, with inputs for both thresholds. The server SHALL answer
`GET /api/health` with `{late, check}`, where `late` lists, newest first,
at most the last 100 events its feed reported as late or removed in a
resync since the server started, each with its hash, kind, ticket, whether
it was late or removed, and the time the server observed it, and `check`
is the last cache check result or null. `GET /api/health/check` SHALL run
the cache comparison of `rebuild --check` and return its result, running
at most one comparison at a time and returning a result less than 30
seconds old without running again. The cache comparison SHALL never run
except on such a request. The view SHALL state that whether a pull request
is merged is known only to `close-merged`.

#### Scenario: Late arrival shown in health
- **WHEN** the server is running and an event file sorting before its head is copied into `events/`
- **THEN** `/api/health` lists that event as late with the time it was observed

#### Scenario: Check is single-flight and cached
- **WHEN** two requests for `/api/health/check` arrive together and a third arrives 10 seconds later
- **THEN** the comparison runs once and all three responses carry the same result

### Requirement: Replay
`replayState(events, index)` SHALL return the board state obtained by
folding, with the store's `fold`, the first `index + 1` well-formed events
in fold order, and SHALL equal `fold` of exactly those events however the
position was reached (directly, or stepping from any other position). At
the last index it SHALL equal the current board state. The web app SHALL
offer a replay view over a copy of the event list taken when the view
opens: a slider over positions, step back and forward, play and pause at
1, 4 or 16 events per second, the event at the current position described
with `describeEvent`, the board columns of the replayed state, and a
return to the live view. The view SHALL state that replay follows the
log's fold order, so late arrivals appear at their fold position.

#### Scenario: Replay reaches the present
- **WHEN** `replayState` is called with the index of the last event
- **THEN** its tickets deep-equal the current board state

#### Scenario: A rejected claim replays as rejected
- **WHEN** replay is stepped past the second of two claims on one ticket
- **THEN** the replayed ticket is still held by the first claimant

#### Scenario: Seeking is path independent
- **WHEN** position 700 is reached once directly and once by stepping back from position 900
- **THEN** the two replayed states are deep-equal

### Requirement: Hand-off graph
`handoffGraph(events, filter)` SHALL return, for the applied
`ticket.handoff` events matching the filter (change as
`<source>:<ref>`, and a minimum wall `since`), one directed edge per
(event actor, `body.to`) pair with its count and latest hand-off, and one
node per actor on any edge with its sent and received counts; a hand-off
to oneself SHALL be a self-loop edge. No other kind SHALL count. The web
app SHALL draw the graph with actors on a circle in name order, directed
edges labelled with their counts, and SHALL animate an edge for 3 seconds
when a hand-off on it arrives from the stream.

#### Scenario: Counts per pair
- **WHEN** `test-1` handed off to `impl-1` twice and `impl-1` to `reviewer-1` once
- **THEN** the graph has the edge `test-1` to `impl-1` with count 2 and the edge `impl-1` to `reviewer-1` with count 1, and `impl-1` has sent 1 and received 2

#### Scenario: Claims are not hand-offs
- **WHEN** `impl-2` claims a ticket released by `impl-1`
- **THEN** the graph has no edge between `impl-1` and `impl-2`

#### Scenario: Filter by change
- **WHEN** the graph is filtered to `openspec:add-login`
- **THEN** only hand-offs on tickets whose task reference is `openspec:add-login#<item>` are counted
