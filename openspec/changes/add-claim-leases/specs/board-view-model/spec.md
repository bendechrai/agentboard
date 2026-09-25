## MODIFIED Requirements

### Requirement: Activity feed entries
`feedEntries` SHALL return one entry per applied event, newest first
(reverse fold order), each with the event hash, kind, actor, timestamp,
ticket id and title (null for `board.meta`), the change (task reference
`<source>:<ref>` of the ticket, when it has one), and a one-line summary
produced by `describeEvent`: `created <title>`, `commented: <text>`,
`moved to <status>`, `claimed`, `claimed (lease <ttl>)`, `took over
from <holder> (lease expired)`, `renewed lease (<ttl>)`, `joined the
queue`, `left the queue`, `granted to <actor> (accept within <window>)`,
`released`,
`force-released from <holder>: <reason>`, `assigned to <actor>`,
`handed off to <actor> (<status>): <note>`, `linked <task|pr|decision>
<value>`, `closed (decision <path>)` or `closed (no decision)`,
`checked <n>` or `unchecked <n>` (1-based line number), `added <k>
checklist line(s)`, `reconciled with tasks (<u> updated, <r> removed, <a>
added[, renamed][, forced])`, `renumbered from group <n> to <m>`,
`superseded: <reason>`, and `set <key>` for `board.meta`. A ttl in a summary
SHALL be written in the largest unit that divides it exactly (`90s`,
`10m`, `2h`). Filters by change,
by actor and by a set of kinds SHALL be combined with AND. An entry SHALL
be marked `late` when the consumer's model recorded it as a late arrival.

#### Scenario: Filter by actor and kind
- **WHEN** the feed is filtered to actor `impl-1` and kind `ticket.handoff`
- **THEN** only hand-offs written by `impl-1` are returned, newest first

#### Scenario: Hand-off summary
- **WHEN** `impl` hands T1 off to `reviewer` with status `review` and note `green`
- **THEN** its entry's summary is `handed off to reviewer (review): green`

#### Scenario: Forced release summary
- **WHEN** `orchestrator` force-releases T1 from `merger-1` with reason `stalled`
- **THEN** its entry's summary is `force-released from merger-1: stalled`

#### Scenario: Takeover summary
- **WHEN** `merger-2` takes T1 over from `merger-1` after its lease expired
- **THEN** its entry's summary is `took over from merger-1 (lease expired)`

#### Scenario: Grant summary
- **WHEN** T1 is granted to `merger-2` with a window of 120000
- **THEN** its entry's actor is `agentboard` and its summary is `granted to merger-2 (accept within 2m)`
