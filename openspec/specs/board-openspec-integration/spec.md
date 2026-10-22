# board-openspec-integration Specification

## Purpose
Defines how tickets relate to planning artifacts, OpenSpec changes and tasks
in particular, so that the board coordinates work without becoming a second
source of truth for scope or completion.

## Requirements

### Requirement: Task sources are adapters
The board core SHALL depend on a planning tool only through a source
adapter keyed by the task reference's `source`. An adapter SHALL provide:
locating its root in the host project, listing the importable units for a
`ref`, and mapping an `item` to its tasks file path and line for reminders.
agentboard SHALL ship the `openspec` adapter only. Tickets whose source has
no adapter in the running version SHALL still be created, shown, listed,
moved and closed normally. Only `import-change` requires an adapter, and it
SHALL exit 1 naming the unsupported source; `checklist tick` on such a
ticket SHALL succeed and state that no tasks-file reminder is available
for that source.

#### Scenario: Ticket from a source with no adapter
- **WHEN** a ticket is created with `--task speckit:001-photo-albums#phase-2` on a version with only the `openspec` adapter
- **THEN** it is created, listed and movable, and `checklist tick` on it succeeds and states that no tasks-file reminder is available for source `speckit`

### Requirement: Completion truth stays in tasks
The board SHALL never mark a task as complete. `tasks.md` checkboxes remain
the record of what was built; the board records who holds the work and its
state in flight. `checklist tick` on a ticket SHALL update only the ticket's
own checklist and SHALL print a reminder that the task line in `tasks.md`
must be ticked in the implementing PR.

#### Scenario: Tick reminds about tasks.md
- **WHEN** `agentboard checklist tick T1 2 --as impl` runs
- **THEN** the ticket's third checklist line is marked done and the output includes the path of the corresponding tasks file and line

### Requirement: Import a change
`import-change <name>` SHALL read `openspec/changes/<name>/tasks.md` from the
host project (locating the OpenSpec root the same way the board is located),
create one ticket per top-level numbered task group titled with the group
heading, with the task reference `openspec:<name>#<n>`, the group's task
lines as the ticket checklist (done state copied from the checkbox), labels
`change:<name>` and `group:<n>`, and status `todo`. Groups whose tasks are all ticked SHALL be imported as `merged`.

#### Scenario: Import creates one ticket per group
- **WHEN** a tasks file has nine numbered groups and `import-change` runs
- **THEN** nine tickets exist with matching titles, task references, checklists and labels

#### Scenario: Fully ticked group imports as merged
- **WHEN** a group's tasks are all ticked in tasks.md
- **THEN** its ticket is created in status `merged`

### Requirement: Close merged
`close-merged` SHALL, for every ticket in status `merged` that has a `pr`
link, query the PR's merge state (using `gh` when available) and close the
ticket with `--no-decision` when the PR is merged and the ticket has no
`decision` link, or with the decision path when it has one. Tickets whose PR
is not merged SHALL be left untouched and listed. `close-merged` SHALL never
give a scope disposition: a ticket in `merged` that has neither a task
reference nor an unplanned disposition (only possible for an event written
outside agentboard) SHALL be left open and listed with the reason
`needs-scope-disposition`, and the other tickets SHALL still be processed.

#### Scenario: Merged PR closes its ticket
- **WHEN** ticket T1 is `merged` with a `pr` link whose PR is merged and no decision link
- **THEN** T1 is closed with the no-decision disposition and listed in the command's output

#### Scenario: Unplanned merged ticket closes normally
- **WHEN** ad hoc ticket T2 was moved to `merged` with `--unplanned "hotfix"`, has a `pr` link whose PR is merged, and `close-merged` runs
- **THEN** T2 is closed with the no-decision disposition and its unplanned disposition is unchanged

### Requirement: Decisions are promoted, not buried
A ticket whose comments contain a decision marker (a comment beginning with
`DECISION:`) SHALL NOT be closable with `--no-decision`; `close` SHALL exit 1
and list the decision comments until a `--decision-recorded-in` path is
supplied or the decision comment is retracted with a later `RETRACTED:`
comment by the same actor.

#### Scenario: Decision comment blocks no-decision close
- **WHEN** T1 has a comment "DECISION: use RFC 6979 for P-256" and `close T1 --no-decision` runs
- **THEN** the command exits 1 quoting that comment and the rule

### Requirement: Orchestrator inbox protocol
The recommended orchestrator loop SHALL be documented and supported by the
CLI: before dispatching any agent, run `inbox --as orchestrator` and act on
every returned event; after dispatching, the dispatched agent SHALL `claim`
its ticket; on completion the agent SHALL `handoff` to the next role or
`move` to `blocked` with a comment; the orchestrator SHALL never rely on its
own memory of ticket state in place of `show` or `inbox`.

#### Scenario: Inbox shows a handoff
- **WHEN** an implementer runs `handoff T1 --to reviewer --status review --note "done"` and the orchestrator then runs `inbox --as orchestrator`
- **THEN** the inbox lists the handoff with ticket, from, to, status and note, and a second inbox call returns nothing new

### Requirement: Tickets reference tasks or are ad hoc
Every ticket SHALL carry a task reference (see board-events) identifying the
unit of planned work it delivers, or be explicitly created with `--adhoc`
and a reason. An ad hoc ticket SHALL move through every status, be blocked,
handed off, claimed and released exactly like a ticket with a task
reference. Scope SHALL NOT enter the board silently: an ad hoc ticket SHALL
enter `merged` or be closed only with a scope disposition (see "Scope
disposition at merge and close").

#### Scenario: Ticket without a task is refused
- **WHEN** `agentboard new "Fix thing"` runs without `--task`, without `--change` and `--group`, and without `--adhoc`
- **THEN** the command exits 1 and explains that tickets must reference a task or be marked ad hoc with a reason

#### Scenario: Ad hoc ticket moves through the work statuses
- **WHEN** an ad hoc ticket with no task link is moved from `todo` to `tests`, then to `implementing`, then to `review`
- **THEN** each move exits 0, the ticket is in `review`, it still has its ad hoc reason and no task reference, and no move was refused

#### Scenario: Ad hoc ticket is blocked and handed off
- **WHEN** an ad hoc ticket in `implementing` held by `impl-1` is moved to `blocked`, moved back, and handed off to `reviewer` with `--status review`
- **THEN** every command exits 0 and the ticket is in `review`, assigned to `reviewer`

#### Scenario: Existing ad hoc ticket gains the ability to move
- **WHEN** a board written by an earlier release has an ad hoc ticket in `todo` and the current CLI runs `move <id> tests` and then `move <id> implementing`
- **THEN** both moves exit 0 and no other ticket of the board changes state

### Requirement: Ad hoc markers in list
`list` SHALL show an ad hoc ticket with an `[adhoc]` marker while it has no
scope disposition, and with an `[unplanned]` marker in its place once an
unplanned disposition is recorded. A ticket linked to a task SHALL show
neither marker.

#### Scenario: List markers
- **WHEN** a board has an ad hoc ticket A with no disposition, an ad hoc ticket B merged with `--unplanned "hotfix"` and a ticket C created ad hoc and later linked with `link C --task openspec:x#1`
- **THEN** `list --closed` shows A with `[adhoc]`, B with `[unplanned]` and not `[adhoc]`, and C with neither marker

### Requirement: Scope disposition at merge and close
A ticket SHALL have a scope disposition when it has a task reference or an
unplanned disposition (see board-events). Moving or handing off a ticket
into `merged`, or closing it, without one, and without the command giving
one (see board-cli, "Scope disposition on the command line"), SHALL be
refused with exit 4 and reason `needs-scope-disposition`. A ticket linked
with `link` at any earlier time SHALL need nothing more.

#### Scenario: Merge without a disposition is refused
- **WHEN** ad hoc ticket T1 with no task link is in `review` and `agentboard move T1 merged --as orch` runs
- **THEN** the command exits 4 with reason `needs-scope-disposition`, stderr has a `hint: ` line naming both `--task` and `--unplanned`, no event file is created, and T1 is still in `review`

#### Scenario: Ticket linked earlier needs no disposition
- **WHEN** ad hoc ticket T1 was linked with `link T1 --task openspec:add-login#2` while in `implementing`, and `move T1 merged --as orch` runs from `review`
- **THEN** the move exits 0 and T1 is in `merged` with the task reference `openspec:add-login#2`

#### Scenario: Planned ticket is unaffected
- **WHEN** a ticket created with `--change add-login --group 2` is moved from `review` to `merged` and closed with `--no-decision`, with no disposition flag
- **THEN** both commands exit 0

#### Scenario: Linked tickets on an older board are unaffected
- **WHEN** a board written by an earlier release has tickets that were linked and are in `implementing`, `review` and `merged`
- **THEN** with the current CLI, every ticket folds to the same state as before, and moving them on and closing them needs no disposition flag

#### Scenario: Mutex ticket never needs a disposition
- **WHEN** a standing ad hoc ticket is used as a mutex (claimed and released many times, never moved to `merged` and never closed)
- **THEN** no command on it is refused with `needs-scope-disposition`, and it appears in no `unplannedScope` finding of `health`
