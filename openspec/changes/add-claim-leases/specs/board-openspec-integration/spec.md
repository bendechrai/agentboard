## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: Reconcile on re-import
For each existing ticket paired to a group, `import-change` SHALL
compute the difference between the ticket's active checklist and the
group's current task lines, and SHALL write at most one
`ticket.reconcile` event per ticket, and none when nothing differs, such
that afterwards the title equals the current group heading and the active
checklist holds exactly the current task lines. Lines SHALL be matched in
two passes: first by task number (the leading `<n>.<m>` of the line), then,
for lines still unmatched, by text with the task number removed. A matched
line whose text is unchanged SHALL keep the ticket's done flag; a matched
line whose text changed SHALL be written in `updated` with the new text and
the done flag of its tasks-file checkbox; an unmatched ticket line SHALL be
written in `removed`; an unmatched task line SHALL be written in `added`
with the done flag of its checkbox, in tasks-file order. Active lines SHALL
keep their existing order and added lines SHALL be appended, so that
checklist indices never change meaning. The event SHALL record the tasks
file path and the SHA-256 of its bytes in `source`.

A reconcile SHALL be blocked for a ticket when it would remove or change
the text of a line that is done on the ticket, or when it would remove or
change the text of any line while the ticket is assigned and in `tests`,
`implementing` or `review`. A blocked ticket SHALL get no event; the other
tickets SHALL still be reconciled; the output SHALL list each blocked
ticket with the lines concerned; and the command SHALL exit 4 with reason
`reconcile-blocked` after processing every group. `--force` SHALL
reconcile blocked tickets too, with `forced` true in the event, and the
inbox entry of a forced reconcile SHALL carry the assignee, when there is
one, in `affects`. Changing the title and appending lines SHALL never be
blocked. `import-change --dry-run` SHALL compute and print the same
per-ticket differences (title, updated, removed, added, blocked) as human
text or, with `--json`, as one document, and SHALL write nothing and exit 0.
The `reconcile-blocked` and `reconcile-ambiguous` hints SHALL name
`import-change <name> --dry-run`, the first also `--force`, and the
`stale-import` reason SHALL hint `import-change <name> --dry-run`. The MCP tool `board_import_change` SHALL gain optional
`dry_run` and `force` arguments from the registry.

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

### Requirement: Pair tickets to groups by identity
Before writing anything, `import-change` SHALL pair the change's existing
tickets that are not superseded with the current task groups. Titles
SHALL be normalised (lowercase, leading group number removed, runs of
non-alphanumeric characters collapsed to one space, trimmed), and a task
line SHALL be normalised the same way after removing its checkbox and
leading task number; a ticket's lines are its active checklist lines.
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
- **THEN** the old group 5, 6 and 7 tickets are renumbered to 6, 7 and 8 with their claims, comments and ticks unchanged, one new ticket is created for the new group 5, and no ticket's checklist is rewritten

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
