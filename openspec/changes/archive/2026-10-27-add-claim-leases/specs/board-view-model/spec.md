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
<value>`, `recorded as unplanned: <reason>`, `closed (decision <path>)` or `closed (no decision)`,
`checked <n>` or `unchecked <n>` (1-based line number), `added <k>
checklist line(s)`, `reconciled with tasks (<u> updated, <r> removed, <a>
added[, renamed][, forced])`, `renumbered from group <n> to <m>`,
`superseded: <reason>`, and `set <key>` for `board.meta`. A ttl or window
in a summary SHALL be written in the largest unit of `d`, `h`, `m` and `s`
that divides it exactly (`90s`, `10m`, `2h`, `7d`), or in milliseconds
(`30500ms`) when none does. A claim carrying `supersedes` SHALL be
summarised as the takeover, naming `supersedes.holder`, whether or not it
carries a lease; a claim with a lease and no `supersedes` as `claimed
(lease <ttl>)` with the lease's requested `ttl` (not its grace); a renew
with its own `ttl`; and a grant with its `to` and `window`. Reasons and
actor names are put on one line like every other text. Filters by change,
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

#### Scenario: Lease claim summary
- **WHEN** `merger-1` claims T1 with a ttl of 90000 (its grace is 120000)
- **THEN** its entry's summary is `claimed (lease 90s)`, and a claim with no lease is still `claimed`

#### Scenario: Renew summary
- **WHEN** the holder of T1 renews with a ttl of 7200000
- **THEN** its entry's summary is `renewed lease (2h)`

#### Scenario: Queue summaries
- **WHEN** `merger-2` joins the queue of T1 and later leaves it
- **THEN** the entries' summaries are `joined the queue` and `left the queue`

#### Scenario: Rejected and stale events have no entry
- **WHEN** a renew by an actor that does not hold T1 is rejected `not-assignee`, and a grant that does not equal the derived one is rejected `stale-grant`
- **THEN** neither has a feed entry

#### Scenario: Forced release summary
- **WHEN** `orchestrator` force-releases T1 from `merger-1` with reason `stalled`
- **THEN** its entry's summary is `force-released from merger-1: stalled`

#### Scenario: Takeover summary
- **WHEN** `merger-2` takes T1 over from `merger-1` after its lease expired
- **THEN** its entry's summary is `took over from merger-1 (lease expired)`

#### Scenario: Grant summary
- **WHEN** T1 is granted to `merger-2` with a window of 120000
- **THEN** its entry's actor is `agentboard` and its summary is `granted to merger-2 (accept within 2m)`

## ADDED Requirements

### Requirement: Checklist progress counts active lines
A card's checklist progress SHALL count only the ticket's active lines:
a line a reconcile marked removed is in neither the done nor the total
count.

#### Scenario: Removed lines are not counted
- **WHEN** a ticket has lines `1.1 A` (done), `1.2 B` (removed, done) and `1.3 C`
- **THEN** its card's checklist progress is 1 done of 2
