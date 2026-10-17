## MODIFIED Requirements

### Requirement: Secret-like text is refused
Comments, hand-off notes and unplanned reasons posted through the server
SHALL be checked
against the same secret patterns as the CLI and refused with 400, reason
`secret-like` and the pattern name, never echoing the text. The server
SHALL offer no override; a false positive is written with the CLI and
`--allow-secret-like`.

#### Scenario: PEM header from the browser
- **WHEN** the page posts a comment containing `-----BEGIN PRIVATE KEY-----`
- **THEN** the response is 400 with reason `secret-like` naming `pem-private-key`, the text is not in the response, and no event is written

#### Scenario: Secret-like unplanned reason from the browser
- **WHEN** the page posts `{"id": "<T1>", "status": "merged", "unplanned": "-----BEGIN PRIVATE KEY-----"}` to `/api/actions/move`
- **THEN** the response is 400 with reason `secret-like` naming `pem-private-key`, and no event is written

### Requirement: Action controls in the web app
When `/api/session` reports `writable`, the ticket detail SHALL offer
controls for every action: a comment box, a move control listing the
targets the state machine permits from the current status (and leaving
`blocked` to its remembered status), claim and release buttons, a
hand-off form (recipient, status, note), a checkbox per checklist line, a
link form (task reference, pull request, or decision path) and a close
form with exactly one disposition. For a ticket with neither a task
reference nor an unplanned disposition, choosing `merged` in the move
control and the close form SHALL also ask for exactly one scope
disposition, a task reference or an unplanned reason, sent as the `task`
or `unplanned` property. The page SHALL show the actor it acts
as. A refusal SHALL be shown beside the control with its message and
hint, and the entered text SHALL be kept. The result of a successful
action SHALL be shown without waiting for the stream. A read-only server's
page SHALL show no action control.

#### Scenario: Refusal shown with its hint
- **WHEN** the user submits `--no-decision` in the close form of a ticket with an open decision
- **THEN** the form shows the `unpromoted-decision` message and hint, and the form keeps its values

#### Scenario: Read-only page
- **WHEN** the page is served without `--as`
- **THEN** the ticket detail shows no comment box, button or form that writes

#### Scenario: Merge an ad hoc ticket from the browser
- **WHEN** the server runs with `--as ben`, the user chooses `merged` for an undisposed ad hoc ticket in `review`, enters the unplanned reason `hotfix` and submits
- **THEN** the page posts `{"id": "<T1>", "status": "merged", "unplanned": "hotfix"}` to `/api/actions/move`, the response is 200, and `agentboard show T1` has the line `unplanned: hotfix (by ben)`

#### Scenario: Missing disposition from the browser
- **WHEN** a client posts `{"id": "<T1>", "status": "merged"}` to `/api/actions/move` for an undisposed ad hoc ticket in `review`
- **THEN** the response is 409 with reason `needs-scope-disposition` and a hint for the server's actor, and no event is written
