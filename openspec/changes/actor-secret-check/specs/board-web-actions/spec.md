## ADDED Requirements

### Requirement: Actor names from the server and the browser are checked
The actor given as `agentboard serve --as <actor>` SHALL pass the actor
check of board-cli "Actor names are checked" at start-up; a name that
fails SHALL make `serve` exit 1 with reason `invalid-actor` before it
listens, printing no URL and no token. The `to` of a
`POST /api/actions/handoff` body SHALL pass the same check; a name that
fails SHALL be answered with 400, reason `invalid-actor` and the message
naming `the argument to`, and SHALL write nothing. Neither response nor
the server's output SHALL contain the refused name, and the hint SHALL
write `<actor>` in its place. The browser SHALL have no override.

#### Scenario: Serve started with a token
- **WHEN** `agentboard serve --as <token>` runs with a GitHub-style token, with and without `--json`
- **THEN** it exits 1 with reason `invalid-actor`, does not listen, and the token appears nowhere in stdout or stderr

#### Scenario: Hand-off to a token from the browser
- **WHEN** a writable `agentboard serve --as ben` receives `POST /api/actions/handoff` with `{"id": "<T1>", "to": "<token>", "status": "review", "note": "n"}` from its own page
- **THEN** the response is 400 with reason `invalid-actor`, no event is written, and the token appears nowhere in the response body or the server's output

#### Scenario: Hand-off to an existing actor style from the browser
- **WHEN** a writable `agentboard serve --as ben` receives a hand-off of T1 to `reviewer-3-2`
- **THEN** the response is 200 and T1 is assigned to `reviewer-3-2`
