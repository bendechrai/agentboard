## MODIFIED Requirements

### Requirement: Health report
`healthReport` SHALL be a pure view-model function (see board-view-model)
of the board's tickets and events, `now`, the thresholds `staleAfter`
(default 2 hours), `blockedAfter` (default 24 hours) and `unplannedWithin`
(default 7 days), and, when
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
- `unplannedScope`: `total`, the number of tickets, open or closed, that
  are unplanned scope (see "Unplanned scope in the health report"), and
  `tickets`, those whose disposition event is less than `unplannedWithin`
  old, most recent first;
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

### Requirement: Health command
`agentboard health [--stale-after <duration>] [--blocked-after <duration>]
[--unplanned-within <duration>] [--check]` SHALL print the health report of
the board, with `late` null,
and with `check` null unless `--check` is given, in which case it SHALL
run the same comparison as `rebuild --check` and include its result
(whether the cache matches and the number of differing rows). It SHALL
read ticket state from the cache and event bodies from the event files of
applied events, reading each file at most once, within one read snapshot
(the cache does not record which ticket an event belongs to, so the files
of closed tickets cannot be skipped without reading them), SHALL
write nothing, SHALL need no actor, and SHALL exit 0 whatever the report
contains. Human output SHALL list each section with its count and one
line per ticket in the `list` format followed by the finding; the
unplanned scope section SHALL be headed with the count within the window
and the total, and each line SHALL end with the outcome, the age and the
reason; `--json` SHALL print the report as one JSON document.

#### Scenario: JSON report
- **WHEN** `agentboard health --json` runs on a board with one stale claim
- **THEN** stdout is one JSON document whose `staleClaims` has one entry, `late` is null, `check` is null, and the exit code is 0

#### Scenario: Check included on request
- **WHEN** `agentboard health --check --json` runs on a board whose cache matches the event log
- **THEN** the document's `check` reports a match with 0 differing rows

#### Scenario: Health over MCP
- **WHEN** an MCP client calls `board_health` with `{"stale-after": "30m"}`
- **THEN** the result is the same document `agentboard health --stale-after 30m --json` prints

#### Scenario: Unplanned merges in text output
- **WHEN** ad hoc ticket T1 was moved to `merged` with `--unplanned "production hotfix"` 2 hours before `now`, and `agentboard health` runs with the default thresholds
- **THEN** the output has the line `unplanned scope: 1 in the last 7d (1 in all)` followed by T1's `list` line ending `merged 2h ago, unplanned: production hotfix`, and the exit code is 0

#### Scenario: Unplanned scope over MCP and JSON
- **WHEN** an MCP client calls `board_health` with `{"unplanned-within": "30d"}` on the same board
- **THEN** the result equals what `agentboard health --unplanned-within 30d --json` prints, its `thresholds.unplannedWithin` is 2592000000, and `unplannedScope.tickets` has one entry for T1 with `reason` `production hotfix` and `outcome` `merged`

### Requirement: Health in the web app
The web app SHALL offer a health view computed with `healthReport` in the
browser, re-evaluated on every model change and at least every 10
seconds, with inputs for all three thresholds and an unplanned scope
section styled as information, not as a warning. The server SHALL answer
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

#### Scenario: Unplanned scope in the Health view
- **WHEN** the Health view is open and an ad hoc ticket is merged with `--unplanned "hotfix"` from the CLI
- **THEN** within 10 seconds the view's unplanned scope section lists the ticket with the reason `hotfix`, and changing the window input to `1m` after a minute removes it from the list while the total stays 1

## ADDED Requirements

### Requirement: Unplanned scope in the health report
A ticket SHALL be unplanned scope when it has an unplanned disposition and
is in `merged` or closed, or when it is closed with an ad hoc reason, no
task reference and no unplanned disposition (closed before this rule). Each
entry SHALL carry the ticket's card, `adhoc` (the ad hoc reason), `reason` (the
unplanned reason, null in the second case), `outcome` (`merged` if it reached
`merged`, else `closed`), the event it was measured from and the age.

#### Scenario: Window and total
- **WHEN** three tickets were merged with `--unplanned`, 1 day, 6 days and 10 days before `now`, with the default thresholds
- **THEN** `unplannedScope.total` is 3 and `unplannedScope.tickets` lists the 1 day and 6 day tickets, most recent first

#### Scenario: Closed tickets are included
- **WHEN** an ad hoc ticket was closed from `blocked` with `--unplanned "abandoned"` an hour before `now`
- **THEN** it is in `unplannedScope.tickets` with `outcome` `closed` and `reason` `abandoned`, although closed tickets appear in no other section

#### Scenario: Ticket closed before this change
- **WHEN** an older board has an ad hoc ticket closed from `blocked` with no task link and no `ticket.unplanned`
- **THEN** it counts in `unplannedScope.total` with `reason` null, measured from its `ticket.close`, and no command or the report fails because of it

#### Scenario: Linked and in-flight tickets are not unplanned scope
- **WHEN** one ad hoc ticket is in `review` with no disposition and another was merged with `--task openspec:add-login#2`
- **THEN** neither is counted in `unplannedScope`

#### Scenario: Information, not a failure
- **WHEN** the report has unplanned scope and no other finding
- **THEN** `health` exits 0, and the web Health view shows the section without the warning styling used for stale claims and stuck tickets
