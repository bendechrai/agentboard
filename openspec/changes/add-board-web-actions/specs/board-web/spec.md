# Spec Delta

## MODIFIED Requirements

### Requirement: Serve command
`agentboard serve [--port <n>] [--open] [--as <actor>]` SHALL start a local HTTP server
for the board found by the usual discovery rules and run until SIGINT or
SIGTERM, then close every connection and exit 0. Without `--port` the port
SHALL be chosen by the operating system (port 0); `--port` SHALL accept an
integer from 0 to 65535 and anything else SHALL exit 1 with reason
`usage`. When the port cannot be bound because it is in use, the command
SHALL exit 1 with reason `port-in-use` before serving anything. When no
board is found it SHALL exit 2 before listening. At start-up it SHALL print
on stdout the line `serving <board dir> read-only at <url>`, or, when
started with `--as <actor>`, `serving <board dir> as <actor> at <url>`,
where `<url>` is `http://127.0.0.1:<port>/#token=<token>`; with `--json`
it SHALL instead print exactly one line holding the JSON object
`{"url", "port", "token", "writable", "actor"}`, with `writable` true and
`actor` the actor exactly when `--as` was given (else false and null), and
nothing else on stdout afterwards. With `--open` it
SHALL also ask the system to open `<url>` in the default browser; failing
to do so SHALL be a warning on stderr, not an error. `serve` needs no
actor. Without `--as` it writes no event; with a non-empty `--as` it
accepts write actions as that actor (see board-web-actions), and an empty
`--as` value SHALL exit 1 with reason `usage`. `AGENTBOARD_ACTOR` SHALL be
ignored by `serve`.

#### Scenario: Start and stop
- **WHEN** `agentboard serve --port 0 --json` runs on a board and receives SIGINT after printing its start-up line
- **THEN** the line parses as JSON with a numeric `port`, a 43-character `token` and `writable` false, and the process exits 0

#### Scenario: Port in use
- **WHEN** `agentboard serve --port <p>` runs while another process listens on `127.0.0.1:<p>`
- **THEN** it exits 1 with reason `port-in-use` and a hint naming `--port`

#### Scenario: No board
- **WHEN** `agentboard serve` runs where discovery finds no board
- **THEN** it exits 2 naming the path it looked at, and no port is bound

#### Scenario: Writable start-up
- **WHEN** `agentboard serve --port 0 --json --as ben` starts
- **THEN** its start-up line has `writable` true and `actor` `ben`

### Requirement: Read-only server
The server SHALL answer only `GET`, except `POST` to
`/api/actions/<action>` (see board-web-actions); any other method or
path and method pair SHALL be answered with 405, an `Allow` header naming
the permitted methods, and reason `method-not-allowed`. A server started
without `--as` SHALL answer `POST /api/actions/<action>` with 405 and
reason `read-only`. Serving SHALL write no cursor, and SHALL write no
event other than those of accepted write actions; apart from them the only
change it SHALL make to the board is the catch-up any read command
performs.

#### Scenario: POST is refused
- **WHEN** an authenticated client sends `POST /api/board`
- **THEN** the response is 405 with reason `method-not-allowed`, and no event file is created

#### Scenario: Read-only server refuses actions
- **WHEN** a server started without `--as` receives an authenticated same-origin `POST /api/actions/comment`
- **THEN** the response is 405 with reason `read-only` and a hint naming `agentboard serve --as <actor>`, and no event is written

### Requirement: JSON API
The server SHALL answer these authenticated `GET` routes with JSON:
- `/api/session`: `{version, boardDir, writable, actor}`: `writable` true
  and `actor` the `--as` actor when started with `--as`, else false and
  null;
- `/api/board`: `{tickets, meta, id}`: every ticket, open and closed, the
  board meta, and the feed position id of the same snapshot;
- `/api/tickets/<id>`: `{ticket, events}` for a full id or unique prefix
  of at least 6 characters, where `events` lists every well-formed event
  of the ticket in fold order with its outcome and rejection reason;
  refusals as `show` refuses (400 for exit 1 reasons, 404 for
  `unknown-ticket`);
- `/api/events?after=<hash>&limit=<n>`: `{events, next}`: the well-formed
  events (applied, rejected and unknown kinds) that sort after `after` (or
  from the start without it), in fold order, at most `limit` (default
  1000, at most 5000), each as `{hash, kind, ticket, actor, ts, outcome,
  reason, event}`, and `next` the hash to pass as `after` for the next
  page, or null; an `after` that is not a recorded event SHALL be 400
  with reason `unknown-cursor`, and a bad `limit` 400 with reason `usage`;
- `/api/actors`: the agent lanes of the board at the request time.
Any other path under `/api/` SHALL be 404 with reason `not-found`. Every
error SHALL be an `ErrorDocument` whose `hint` is the CLI hint of its
reason.

#### Scenario: Ticket detail includes a rejected claim
- **WHEN** two claims of T1 were written and the second was rejected as `already-assigned`, and a client requests `/api/tickets/<prefix of T1>`
- **THEN** `events` lists both claims in fold order, the second with outcome `rejected` and reason `already-assigned`

#### Scenario: Paging events
- **WHEN** a board has 2500 well-formed events and a client pages `/api/events` with the default limit
- **THEN** it receives 1000, 1000 and 500 events in fold order, and `next` is null on the last page

