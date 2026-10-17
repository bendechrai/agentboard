## MODIFIED Requirements

### Requirement: Event kinds
The following kinds SHALL be defined with these bodies:
`ticket.create` (title, optional description, optional labels array, optional
`task` reference, optional `adhoc` reason string, optional checklist array
of strings; `task` and `adhoc` SHALL NOT both be present);
`ticket.comment` (text);
`ticket.move` (to: status);
`ticket.assign` (to: actor);
`ticket.claim` (no body fields; the event's actor claims the ticket);
`ticket.release` (no body fields);
`ticket.handoff` (to: actor, status, note);
`ticket.link` (exactly one of: `task` reference, pr URL or number, decision path);
`ticket.unplanned` (reason: non-empty string; records that the ticket's
scope was never planned, see "Unplanned disposition");
`ticket.close` (either `decision` path string or `noDecision` true);
`ticket.checklist` (index: integer, done: boolean);
`ticket.checklist.add` (items: non-empty array of objects with `text`, a
non-empty string, and `done`, a boolean; the fold appends them in order);
`board.meta` (key, value; board-level settings such as the default column
set). Bodies with extra fields SHALL be malformed.

#### Scenario: Handoff carries three effects
- **WHEN** a `ticket.handoff` event with to, status and note is folded
- **THEN** the ticket's assignee, status and comment list all reflect it, and no separate assign, move or comment event exists for it

#### Scenario: Checklist tick out of range
- **WHEN** a `ticket.checklist` event names an index beyond the ticket's checklist length
- **THEN** the event is reported as rejected with reason `checklist-index` and the ticket is unchanged

#### Scenario: Unplanned body is checked
- **WHEN** a `ticket.unplanned` event has an empty `reason`, or a body with a field other than `reason`
- **THEN** the event is reported as malformed naming the field and is not folded

### Requirement: Fold semantics
Folding SHALL produce, per ticket: id, title, description, status, assignee,
labels, task reference or ad hoc reason, unplanned disposition (reason,
actor and timestamp, or none), checklist with done flags, ordered comments (each
with actor, timestamp and text), links, closed flag with its decision record
path or explicit no-decision marker, `version` (the count of folded events
that changed the ticket), and `updated_at` (the timestamp of the last such
event). A `ticket.create` SHALL be the first event for its id; any other event
for an unknown ticket id SHALL be reported as rejected with reason
`unknown-ticket` and held aside. A second `ticket.create` for an existing id
SHALL be rejected with reason `duplicate-create`. A `ticket.move` to a status
not permitted by the state machine (see board-cli) SHALL be rejected with
reason `invalid-transition`; a `ticket.claim` on an assigned ticket SHALL be
rejected with reason `already-assigned`; a `ticket.release` by an actor other
than the assignee SHALL be rejected with reason `not-assignee`; a
`ticket.move` or `ticket.handoff` that would take a ticket with neither a
task reference nor an unplanned disposition into `merged` SHALL be rejected
with reason `needs-scope-disposition` (see board-openspec-integration); a
`ticket.unplanned` on a ticket that has a task reference SHALL be rejected
with reason `already-linked`. No rule SHALL depend on a task reference for
a move into `implementing` or any status other than `merged`. Rejected
events SHALL be listed in the fold report with hash, kind, ticket and reason
and SHALL never be deleted.

Where the requirements above leave a case open, the fold SHALL behave as
follows. A `ticket.close` on a ticket not in `merged` or `blocked`, or on an
already closed ticket, SHALL be rejected with reason `invalid-transition`.
The fold SHALL NOT apply the scope disposition rule to `ticket.close`; that
is the CLI's `close` check, like the decision-comment rule.
Events after a close SHALL fold by their own rules (a comment on a closed
ticket is accepted; a move out of `merged` is still rejected). A task link
SHALL replace the ticket's task reference and clear its ad hoc reason and
its unplanned disposition; pr
and decision links SHALL be appended in fold order. `version` SHALL count
every applied event of a defined kind, including one that leaves the state
unchanged, such as ticking an already ticked checklist line. `board.meta`
events SHALL be stored in the board state's meta map and SHALL NOT change
the six statuses or the state machine. A ticket SHALL always be created in
`todo`; an import that needs another status writes the permitted moves.

#### Scenario: Close from implementing is refused
- **WHEN** a `ticket.close` is folded for a ticket in `implementing`
- **THEN** it is rejected with reason `invalid-transition`

#### Scenario: Concurrent claims fold to one winner
- **WHEN** two `ticket.claim` events for the same unassigned ticket exist with different timestamps
- **THEN** the earlier one in fold order assigns the ticket and the later one is reported as rejected with reason `already-assigned`

#### Scenario: Comment on unknown ticket is held
- **WHEN** a `ticket.comment` names a ticket id with no `ticket.create` in the log
- **THEN** the fold report lists it as rejected with reason `unknown-ticket` and no ticket is created

#### Scenario: Version counts effective events
- **WHEN** a ticket has one create, two comments and one rejected move
- **THEN** its version is 3 and its updated_at equals the timestamp of the second comment

#### Scenario: Ad hoc ticket enters implementing
- **WHEN** a `ticket.move` to `implementing` is folded for an ad hoc ticket in `tests` with no task reference
- **THEN** it is applied and the ticket is in `implementing`

#### Scenario: Undisposed ticket cannot enter merged
- **WHEN** a `ticket.move` to `merged`, or a `ticket.handoff` with status `merged`, is folded for an ad hoc ticket in `review` with no task reference and no unplanned disposition
- **THEN** it is rejected with reason `needs-scope-disposition` and the ticket stays in `review`

#### Scenario: Close of an undisposed ticket still folds
- **WHEN** a log written before this change holds an ad hoc ticket moved to `blocked` and then closed with `noDecision`, with no task link and no `ticket.unplanned`
- **THEN** the close is applied and the ticket is closed, exactly as before this change

## ADDED Requirements

### Requirement: Unplanned disposition
A `ticket.unplanned` event SHALL record that the ticket's scope was never
planned. When applied it SHALL set the ticket's unplanned disposition to
its `reason`, actor and `ts`, replacing any earlier one, and SHALL leave
the ad hoc reason, status, assignee and closed flag unchanged. It SHALL be
applied in any status, open or closed, unless the ticket has a task
reference (`already-linked`). An applied task link SHALL clear it.

#### Scenario: Unplanned then merged
- **WHEN** an ad hoc ticket in `review` has an applied `ticket.unplanned` with reason `hotfix` followed by a `ticket.move` to `merged`
- **THEN** both are applied, the ticket is in `merged` with the unplanned disposition `hotfix`, its ad hoc reason is unchanged, and its version went up by 2

#### Scenario: Unplanned on a linked ticket
- **WHEN** a `ticket.unplanned` is folded for a ticket whose task reference is `openspec:add-login#2`
- **THEN** it is rejected with reason `already-linked` and the ticket is unchanged

#### Scenario: Later task link clears the disposition
- **WHEN** a ticket merged with an unplanned disposition later receives an applied `ticket.link` with a task reference
- **THEN** the ticket has that task reference, no ad hoc reason and no unplanned disposition

#### Scenario: Disposition without its move
- **WHEN** the log holds an applied `ticket.unplanned` for a ticket in `review` and no later event for it (the writing command died before its move)
- **THEN** the ticket is in `review` with the unplanned disposition, and a later `ticket.move` to `merged` without another disposition is applied

#### Scenario: Older version keeps the event
- **WHEN** a version without `ticket.unplanned` folds a log containing one
- **THEN** it reports the event as an unknown kind, preserves it, and folds every other event of the ticket by its own rules
