## MODIFIED Requirements

### Requirement: Import a change
`import-change <name>` SHALL read `openspec/changes/<name>/tasks.md` from the
host project (locating the OpenSpec root the same way the board is located),
create one ticket per top-level numbered task group titled with the group
heading, with the task reference `openspec:<name>#<n>`, the group's task
lines as the ticket checklist (done state copied from the checkbox), labels
`change:<name>` and `group:<n>`, and status `todo`. Groups whose tasks are all ticked SHALL be imported as `merged`.
For a group whose ticket already exists, `import-change` SHALL reconcile
the ticket with the current tasks file (see "Reconcile on re-import").
Tickets whose group no longer exists in the tasks file SHALL be left
unchanged and listed in the output as `orphaned`.

#### Scenario: Import creates one ticket per group
- **WHEN** a tasks file has nine numbered groups and `import-change` runs
- **THEN** nine tickets exist with matching titles, task references, checklists and labels

#### Scenario: Fully ticked group imports as merged
- **WHEN** a group's tasks are all ticked in tasks.md
- **THEN** its ticket is created in status `merged`

#### Scenario: Removed group is reported, not closed
- **WHEN** group 4 is deleted from tasks.md and `import-change` runs again
- **THEN** the group 4 ticket is unchanged and listed as `orphaned`

## ADDED Requirements

### Requirement: Reconcile on re-import
For each existing ticket of an imported group, `import-change` SHALL
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
The `reconcile-blocked` hint SHALL name `import-change <name> --dry-run`
and `--force`. The MCP tool `board_import_change` SHALL gain optional
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
