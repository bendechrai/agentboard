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
On a re-import, existing tickets SHALL be paired to the current groups by
identity (see "Pair tickets to groups by identity"), never by group number
alone; a paired ticket SHALL be renumbered when its group's number
changed and reconciled with the group's current lines (see "Reconcile on
re-import"); a group with no paired ticket SHALL get a new ticket; and a
ticket with no paired group SHALL be marked superseded by a
`ticket.supersede` event rather than rewritten.

#### Scenario: Import creates one ticket per group
- **WHEN** a tasks file has nine numbered groups and `import-change` runs
- **THEN** nine tickets exist with matching titles, task references, checklists and labels

#### Scenario: Fully ticked group imports as merged
- **WHEN** a group's tasks are all ticked in tasks.md
- **THEN** its ticket is created in status `merged`

#### Scenario: Removed group is superseded, not rewritten
- **WHEN** group 4 is deleted from tasks.md and `import-change` runs again
- **THEN** the group 4 ticket gets a `ticket.supersede` event, keeps its title, checklist, comments and assignee, and no other ticket is rewritten with its content

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

### Requirement: Reconcile on re-import
For each existing ticket paired to a group, `import-change` SHALL
compute the difference between the ticket's active checklist and the
group's current task lines, and SHALL write at most one
`ticket.reconcile` event per ticket, and none when nothing differs, such
that afterwards the title equals the current group heading and the active
checklist holds exactly the current task lines. Lines SHALL be matched in
two passes: first by task number (the leading `<n>.<m>` of the line), then,
for lines still unmatched, by text with the task number removed, compared
exactly (case-sensitive); when several lines on either side share a number
or a text, the k-th ticket line in index order SHALL match the k-th task
line in file order. A matched line whose text is unchanged SHALL keep the
ticket's done flag; a matched line whose text differs only in its task
number SHALL be written in `updated` with the new text and the ticket's
done flag; any other matched line whose text changed SHALL be written in
`updated` with the new text and the done flag of its tasks-file checkbox;
an unmatched ticket line SHALL be written in `removed`; an unmatched task
line SHALL be written in `added` with the done flag of its checkbox, in
tasks-file order. Active lines SHALL keep their existing order and added
lines SHALL be appended, so that checklist indices never change meaning.
The event SHALL record the tasks file and the SHA-256 of its bytes in
`source`, as `<root-relative path>@sha256:<64 lowercase hex>`.
The hash is taken from a second read of the file after it is parsed, so a
file edited between the two reads is recorded with the newer hash; the
next import reconciles against the file as it then is.

An import SHALL write its events in this order: the renumbers, by
ascending old number; then, for each group in tasks-file order, the new
ticket's events or the paired ticket's reconcile; then the supersedes, by
ascending item. Each event SHALL be written in its own command
transaction that re-checks it against the caught-up state, so that a
concurrent import of the same change makes it write nothing stale: a
renumber whose ticket's item no longer equals `from`, a supersede of a
ticket already superseded, a reconcile whose recomputed difference is
empty, and the creation of a group's ticket that another import has
created (a ticket of the change, not superseded, with the group's number
and normalised title) SHALL be skipped as a refusal with reason
`stale-import` inside that transaction, so its catch-up is committed, and
SHALL not be reported as written.

A reconcile SHALL be blocked for a ticket when it would remove a line
that is done on the ticket or change its text other than in its task
number, or when it would remove any line or change its text other than in
its task number while the ticket is assigned and in `tests`,
`implementing` or `review`. A line whose text changes only in its task
number SHALL never block. A blocked ticket SHALL get no event; the other
tickets SHALL still be reconciled; the output SHALL list each blocked
ticket with the lines concerned; and the command SHALL exit 4 with reason
`reconcile-blocked` after processing every group. `--force` SHALL
reconcile blocked tickets too, with `forced` true in the event (and
`forced` false for a ticket the guard did not block), and the inbox entry of a forced reconcile SHALL carry the assignee, when there is
one, in `affects`. Changing the title and appending lines SHALL never be
blocked. `import-change --dry-run` SHALL compute and print the same
per-ticket differences (title, updated, removed, added, blocked) as human
text or, with `--json`, as one document, and SHALL write nothing and exit 0,
also when the pairing is ambiguous or a reconcile would be blocked. On a
`reconcile-blocked` or `reconcile-ambiguous` refusal, the `--json` error
document and the MCP tool error SHALL carry the import's result as
`result` (the same document a successful import prints: every ticket with
its action, events written, differences and blocked lines, and the
ambiguous candidates), so a caller need not run `--dry-run` again.
The `reconcile-blocked` and `reconcile-ambiguous` hints SHALL name
`import-change <name> --dry-run`, the first also `--force`, and the
`stale-import` reason SHALL hint `import-change <name> --dry-run`. The MCP tool `board_import_change` SHALL gain optional
`dry-run` and `force` arguments from the registry.

#### Scenario: Revised tasks file reconciles
- **WHEN** a ticket was imported with lines `1.1 Add A`, `1.2 Add B` and `1.3 Add C` (`1.1` done), and tasks.md now titles the group differently and has `1.1 Add A`, `1.2 Add B with retries` and `1.4 Add D`
- **THEN** one `ticket.reconcile` is written with the new title, `1.2` in `updated`, `1.3` in `removed` and `1.4 Add D` in `added`, and `1.1` stays done

#### Scenario: Renumbered line matches by text
- **WHEN** a ticket line `2.3 Write the ADR` becomes `2.2 Write the ADR` in tasks.md and no other line is numbered `2.2`
- **THEN** it matches by text, keeps its done flag, and is written in `updated` with the new number

#### Scenario: Unchanged tasks file writes nothing
- **WHEN** `import-change` runs twice with an unchanged tasks file
- **THEN** the second run writes no event

#### Scenario: Removing a ticked line is blocked
- **WHEN** a revision deletes a line that is done on the ticket and `import-change` runs without `--force`
- **THEN** no event is written for that ticket, other tickets are reconciled, the output names the line, and the command exits 4 with reason `reconcile-blocked`

#### Scenario: In-progress ticket is not rewritten under its holder
- **WHEN** `impl` holds a ticket in `implementing` and a revision rewords one of its lines
- **THEN** that ticket is blocked as above, and `import-change --force` then writes the reconcile with `forced` true and `impl` in the inbox entry's `affects`

#### Scenario: Title and additions are never blocked
- **WHEN** `impl` holds a ticket in `implementing` and a revision only renames the group and appends a line
- **THEN** the reconcile is written without `--force`

#### Scenario: Dry run
- **WHEN** `import-change add-x --dry-run --json` runs on a revised tasks file
- **THEN** stdout is one JSON document listing each ticket's title change, updated, removed, added and blocked lines, and no event file is created

#### Scenario: Renumbered done line is not blocked
- **WHEN** `impl` holds a ticket in `implementing` whose done line `5.1 Add A` becomes `6.1 Add A` because a group was inserted before it
- **THEN** the reconcile is written without `--force`, with `6.1 Add A` in `updated` still done

#### Scenario: Refusal carries the result
- **WHEN** `import-change add-x --json` exits 4 with reason `reconcile-blocked`
- **THEN** the error document has `result` listing the blocked ticket with its lines and the other tickets with the events written for them

#### Scenario: Concurrent import leaves nothing stale
- **WHEN** another import of the same revision writes its events after this import has paired the tickets and before it writes
- **THEN** this import writes no event, reports no event written, and commits the catch-up of the other import's events

### Requirement: Pair tickets to groups by identity
Before writing anything, `import-change` SHALL pair the change's existing
tickets that are not superseded with the current task groups. Titles
SHALL be normalised (lowercase, leading group number removed, runs of
non-alphanumeric characters collapsed to one space, trimmed), and a task
line SHALL be normalised the same way after removing its checkbox and
leading task number; a ticket's lines are its active checklist lines.
Scores SHALL be the Jaccard similarity of the two normalised line sets
(0 when both are empty), compared exactly as fractions.
Pairing SHALL proceed in three passes, each over the tickets and groups
still unpaired:
1. by title: a ticket and a group whose normalised titles are equal, when
   that title is unique among the unpaired tickets and among the unpaired
   groups;
2. by content: a ticket and a group whose Jaccard similarity of
   normalised line sets is at least 0.5, when each is the other's best
   match and every other candidate of either scores at least 0.2 lower;
3. by number: a ticket and the group with its item number, when neither
   has any other unpaired candidate scoring 0.2 or more.
When a best match in pass 2 scores at least 0.5 but the 0.2 margin is not
met, or two groups or two tickets remain tied for one partner, the
pairing SHALL be ambiguous: the command SHALL write no event at all, print
the dry-run report with the ambiguous candidates and their scores, and
exit 4 with reason `reconcile-ambiguous`. A paired ticket whose item
differs from its group's number SHALL get a `ticket.renumber` from the old
number to the new one before any reconcile. Renumbers SHALL be written in
ascending order of the old number; because the fold does not require task
items to be unique, a swap needs no temporary number.
`--dry-run` SHALL report the pairing (pass used and score), renumbers,
new tickets and superseded tickets as well as the line differences.
Closed tickets SHALL take part in pairing, and SHALL receive renumbers
and supersedes but no reconcile (a closed ticket whose lines differ is
reported, not rewritten).

#### Scenario: Inserted group moves nothing
- **WHEN** tickets exist for groups 1 to 7, `impl` holds the group 5 ticket with comments and ticks, and tasks.md inserts a new group 5 so old groups 5, 6 and 7 become 6, 7 and 8
- **THEN** the old group 5, 6 and 7 tickets are renumbered to 6, 7 and 8 with their claims, comments and ticks unchanged, one new ticket is created for the new group 5, and no line of any ticket is removed or reworded: when the moved groups keep their task line numbers no checklist is rewritten, and when their lines are renumbered (`5.1` becoming `6.1`) each moved ticket gets one reconcile that only changes those numbers, keeping every done flag, without `--force` even for the held ticket

#### Scenario: Reordered groups
- **WHEN** groups 2 and 3 swap places in tasks.md with their titles and lines unchanged
- **THEN** the two tickets are paired by title and renumbered 2 to 3 and 3 to 2, and nothing else is written

#### Scenario: Renamed group keeps its ticket
- **WHEN** group 4 is renamed but keeps four of its five task lines unchanged
- **THEN** the group 4 ticket is paired by content, reconciled with the new title and lines, and keeps its assignee and comments

#### Scenario: Ambiguous pairing refuses
- **WHEN** a group is split into two new groups that each share half of the old ticket's lines
- **THEN** the command writes no event, prints the candidates with their scores, and exits 4 with reason `reconcile-ambiguous`

#### Scenario: Number fallback only when unambiguous
- **WHEN** group 3 is renamed and every line reworded, and no other unpaired group or ticket scores 0.2 or more against either
- **THEN** the group 3 ticket is paired by number and reconciled

#### Scenario: Removed group
- **WHEN** a group is deleted and the later groups move up by one
- **THEN** the later tickets are renumbered, the deleted group's ticket is superseded, and no ticket takes over its content
