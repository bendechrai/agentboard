## MODIFIED Requirements

### Requirement: Board columns and cards
`boardColumns` SHALL return one column per status in the order `todo`,
`tests`, `implementing`, `review`, `blocked`, `merged`, each holding the
cards of the tickets in that status, most recently updated first (by
`updatedAt` in fold order). Closed tickets SHALL be excluded unless the
`includeClosed` filter is set. A card SHALL carry the ticket id and its
first 10 characters, title, assignee or none, task reference in text form
or the ad hoc marker, whether it has an unplanned disposition and its
reason, labels, checklist progress as done and total counts,
the status it was blocked from when blocked, whether it is closed, the
count of open `DECISION:` comments (as `openDecisions` defines them), and
whether it changed within the last 5 seconds before `now`. Filters by task
reference (`<source>:<ref>`, or `<source>:<ref>#<item>`) and by assignee
SHALL be combined with AND.

#### Scenario: Blocked card remembers its origin
- **WHEN** a ticket in `implementing` is moved to `blocked`
- **THEN** its card is in the `blocked` column and carries `implementing` as the status it was blocked from

#### Scenario: Closed tickets are hidden by default
- **WHEN** a board has one open and one closed ticket in `merged`
- **THEN** the `merged` column holds only the open ticket's card, and both when `includeClosed` is set

#### Scenario: Unplanned card
- **WHEN** an ad hoc ticket is moved to `merged` with the unplanned reason `hotfix`
- **THEN** its card in the `merged` column has the ad hoc marker, is marked unplanned with the reason `hotfix`, and has no task reference

### Requirement: Activity feed entries
`feedEntries` SHALL return one entry per applied event, newest first
(reverse fold order), each with the event hash, kind, actor, timestamp,
ticket id and title (null for `board.meta`), the change (task reference
`<source>:<ref>` of the ticket, when it has one), and a one-line summary
produced by `describeEvent`: `created <title>`, `commented: <text>`,
`moved to <status>`, `claimed`, `released`, `assigned to <actor>`,
`handed off to <actor> (<status>): <note>`, `linked <task|pr|decision>
<value>`, `recorded as unplanned: <reason>`, `closed (decision <path>)` or `closed (no decision)`,
`checked <n>` or `unchecked <n>` (1-based line number), `added <k>
checklist line(s)`, and `set <key>` for `board.meta`. Filters by change,
by actor and by a set of kinds SHALL be combined with AND. An entry SHALL
be marked `late` when the consumer's model recorded it as a late arrival.

#### Scenario: Filter by actor and kind
- **WHEN** the feed is filtered to actor `impl-1` and kind `ticket.handoff`
- **THEN** only hand-offs written by `impl-1` are returned, newest first

#### Scenario: Hand-off summary
- **WHEN** `impl` hands T1 off to `reviewer` with status `review` and note `green`
- **THEN** its entry's summary is `handed off to reviewer (review): green`

#### Scenario: Unplanned summary
- **WHEN** `orch` runs `move T1 merged --unplanned "hotfix"`
- **THEN** the feed has, newest first, `moved to merged` and then `recorded as unplanned: hotfix`, both by `orch`
