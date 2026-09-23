# Spec Delta

## Purpose

Defines how tickets relate to OpenSpec changes and tasks so that the board
coordinates work without becoming a second source of truth for scope or
completion.

## ADDED Requirements

### Requirement: Tickets reference tasks
Every ticket SHALL carry a `change` name and a `group` number identifying a
task group in that change's `tasks.md`, or be explicitly created with
`--adhoc` and a reason. `list` SHALL show ad hoc tickets with an `adhoc`
marker. Scope SHALL NOT be introduced through the board: an ad hoc ticket
whose work turns into product behavior SHALL be linked to a change before it
can move past `tests`.

#### Scenario: Ticket without change is refused
- **WHEN** `agentboard new "Fix thing"` runs without `--change` and `--group` and without `--adhoc`
- **THEN** the command exits 1 and explains that tickets must reference a task group or be marked ad hoc with a reason

#### Scenario: Ad hoc ticket cannot reach implementing
- **WHEN** an ad hoc ticket with no change link is moved to `implementing`
- **THEN** the command exits 4 with reason `needs-change-link`

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
heading, with the group's task lines as the ticket checklist (done state
copied from the checkbox), labels `change:<name>` and `group:<n>`, and status
`todo`. Groups whose tasks are all ticked SHALL be imported as `merged`.

#### Scenario: Import creates one ticket per group
- **WHEN** a tasks file has nine numbered groups and `import-change` runs
- **THEN** nine tickets exist with matching titles, checklists and labels

#### Scenario: Fully ticked group imports as merged
- **WHEN** a group's tasks are all ticked in tasks.md
- **THEN** its ticket is created in status `merged`

### Requirement: Close merged
`close-merged` SHALL, for every ticket in status `merged` that has a `pr`
link, query the PR's merge state (using `gh` when available) and close the
ticket with `--no-decision` when the PR is merged and the ticket has no
`decision` link, or with the decision path when it has one. Tickets whose PR
is not merged SHALL be left untouched and listed.

#### Scenario: Merged PR closes its ticket
- **WHEN** ticket T1 is `merged` with a `pr` link whose PR is merged and no decision link
- **THEN** T1 is closed with the no-decision disposition and listed in the command's output

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
