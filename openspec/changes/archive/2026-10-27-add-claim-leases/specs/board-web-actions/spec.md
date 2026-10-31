## ADDED Requirements

### Requirement: No checklist control for a removed line
The checklist control SHALL offer a checkbox only for the ticket's active
lines; a line a reconcile marked removed SHALL be shown marked as removed
with no checkbox, so the page never sends a `checklist-tick` or
`checklist-untick` the fold would reject.

#### Scenario: No checkbox for a removed line
- **WHEN** the ticket detail of a ticket with lines `1.1 A`, `1.2 B` (removed) and `1.3 C` is open on a writable server
- **THEN** it shows checkboxes with indices 0 and 2 only, and `1.2 B` marked as removed
