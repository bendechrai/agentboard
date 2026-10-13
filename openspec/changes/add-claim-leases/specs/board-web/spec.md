## ADDED Requirements

### Requirement: Removed lines in the ticket detail
The ticket detail SHALL show a checklist line that a reconcile marked
removed only as removed (marked, and distinguishable from an open or a
done line), and the board view's card progress SHALL not count it.

#### Scenario: Removed line shown as removed
- **WHEN** the detail view of a ticket with a removed line `1.2 B` is open on a read-only server
- **THEN** `1.2 B` is shown marked as removed, and the other lines as before
