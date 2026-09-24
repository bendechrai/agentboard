# Spec Delta

## ADDED Requirements

### Requirement: Write mode is opt-in with an explicit actor
The server SHALL accept write actions only when started as
`agentboard serve --as <actor>` with a non-empty actor given on the
command line; `AGENTBOARD_ACTOR` SHALL never enable write actions or name
their actor. Every event written through the server SHALL carry that
actor, and no request SHALL be able to choose or change it.

#### Scenario: Environment actor does not enable writes
- **WHEN** `agentboard serve` runs with `AGENTBOARD_ACTOR=impl-1` and no `--as`
- **THEN** its start-up output says read-only, `/api/session` reports `writable` false and `actor` null, and every action request is refused with reason `read-only`

#### Scenario: Actor cannot be chosen by the browser
- **WHEN** the server runs with `--as ben` and an action request body contains `"as": "impl-1"`
- **THEN** the response is 400 with reason `usage` and no event is written

### Requirement: Action endpoints
A writable server SHALL answer `POST /api/actions/<action>` for the
actions `comment`, `move`, `claim`, `release`, `handoff`,
`checklist-tick`, `checklist-untick`, `link` and `close`, each mapping to
the registry command of the same name (with `-` for the space in
`checklist tick` and `checklist untick`). The body SHALL be a JSON object
whose properties are the command's arguments named as in its MCP tool
input schema, and SHALL be converted and validated by the same code as an
MCP tool call, then run by the command's own operation in its single
`BEGIN IMMEDIATE` transaction, so validation, refusals and the resulting
event are identical to the CLI's. The properties `as`, `json` and
`allow-secret-like` SHALL be refused with 400 and reason `usage`. A
success SHALL be answered with 200 and the document the CLI prints with
`--json`. A refusal SHALL be answered with an `ErrorDocument` whose hint
is the CLI hint for the server's actor, with status 400 for exit 1, 409
for exit 4, 503 for reason `busy` and 500 otherwise, and SHALL write
nothing. Any other action name SHALL be 404 with reason `not-found`.

#### Scenario: Claim from the browser
- **WHEN** the server runs with `--as ben` and the page posts `{"id": "<prefix of T1>"}` to `/api/actions/claim` for an unassigned T1
- **THEN** the response is 200 with the event hash and T1 assigned to `ben`, and `agentboard show T1` agrees

#### Scenario: Refusal with its hint
- **WHEN** the page posts a claim for a ticket held by `impl-1`
- **THEN** the response is 409 with reason `already-assigned`, a message naming `impl-1`, a hint naming `agentboard inbox --as ben`, and no event is written

#### Scenario: Invalid transition
- **WHEN** the page posts `{"id": "<T1>", "status": "merged"}` to `/api/actions/move` while T1 is in `todo`
- **THEN** the response is 409 with reason `invalid-transition` and no event file is created

### Requirement: Close from the browser
`close` SHALL require exactly one of `decision-recorded-in` and
`no-decision`, as on the CLI. A relative `decision-recorded-in` path SHALL
be resolved against the root of the working tree that contains the
directory `serve` was started in (`git rev-parse --show-toplevel`, or that
directory outside git), SHALL lie inside it, SHALL exist, and SHALL be
recorded relative to that root. `no-decision` SHALL be refused while the
ticket has an open `DECISION:` comment, with reason `unpromoted-decision`
and the decision comments quoted, exactly as on the CLI.

#### Scenario: Decision path relative to the tree root
- **WHEN** the server was started in `<root>/src` and the page closes a merged ticket with `decision-recorded-in` `docs/adr/0006-web.md`, which exists under `<root>`
- **THEN** the ticket is closed with the decision path `docs/adr/0006-web.md`

#### Scenario: Unpromoted decision
- **WHEN** the page closes a merged ticket that has an open `DECISION:` comment with `no-decision`
- **THEN** the response is 400 with reason `unpromoted-decision` quoting the comment, and the ticket stays open

### Requirement: Secret-like text is refused
Comments and hand-off notes posted through the server SHALL be checked
against the same secret patterns as the CLI and refused with 400, reason
`secret-like` and the pattern name, never echoing the text. The server
SHALL offer no override; a false positive is written with the CLI and
`--allow-secret-like`.

#### Scenario: PEM header from the browser
- **WHEN** the page posts a comment containing `-----BEGIN PRIVATE KEY-----`
- **THEN** the response is 400 with reason `secret-like` naming `pem-private-key`, the text is not in the response, and no event is written

### Requirement: Cross-site request forgery protection
Every `POST` SHALL pass, in addition to the Host and token checks of every
request, all of: a `Content-Type` of `application/json`; a body of at most
64 KiB (otherwise 413 with reason `body-too-large`); an `Origin` header
equal to `http://127.0.0.1:<port>` or `http://localhost:<port>` matching
the `Host` header, or, only when the token was given as
`Authorization: Bearer`, no `Origin` header; and an `X-Agentboard-CSRF`
header equal to the server's CSRF token, 32 random bytes encoded as 43
base64url characters, drawn at start-up, distinct from the access token,
and returned only by `/api/session` of a writable server. Tokens SHALL be
compared in constant time. A request failing any of these SHALL be
answered with 403 and reason `csrf-failed` and SHALL write nothing.

#### Scenario: Cross-site form post
- **WHEN** a request with the valid token cookie posts to `/api/actions/comment` with `Origin: https://attacker.example`
- **THEN** the response is 403 with reason `csrf-failed` and no event is written

#### Scenario: Missing CSRF header
- **WHEN** a same-origin request with the valid cookie and `Content-Type: application/json` posts without `X-Agentboard-CSRF`
- **THEN** the response is 403 with reason `csrf-failed`

#### Scenario: Form encoding refused
- **WHEN** an otherwise valid action is posted with `Content-Type: application/x-www-form-urlencoded`
- **THEN** the response is 403 with reason `csrf-failed`

### Requirement: Action controls in the web app
When `/api/session` reports `writable`, the ticket detail SHALL offer
controls for every action: a comment box, a move control listing the
targets the state machine permits from the current status (and leaving
`blocked` to its remembered status), claim and release buttons, a
hand-off form (recipient, status, note), a checkbox per checklist line, a
link form (task reference, pull request, or decision path) and a close
form with exactly one disposition. The page SHALL show the actor it acts
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
