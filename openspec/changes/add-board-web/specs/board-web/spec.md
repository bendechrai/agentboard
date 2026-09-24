# Spec Delta

## ADDED Requirements

### Requirement: Serve command
`agentboard serve [--port <n>] [--open]` SHALL start a local HTTP server
for the board found by the usual discovery rules and run until SIGINT or
SIGTERM, then close every connection and exit 0. Without `--port` the port
SHALL be chosen by the operating system (port 0); `--port` SHALL accept an
integer from 0 to 65535 and anything else SHALL exit 1 with reason
`usage`. When the port cannot be bound because it is in use, the command
SHALL exit 1 with reason `port-in-use` before serving anything. When no
board is found it SHALL exit 2 before listening. At start-up it SHALL print
on stdout the line `serving <board dir> read-only at <url>` where `<url>`
is `http://127.0.0.1:<port>/?token=<token>`, or, with `--json`, exactly one
line holding the JSON object `{"url", "port", "token", "writable"}` with
`writable` false, and nothing else on stdout afterwards. With `--open` it
SHALL also ask the system to open `<url>` in the default browser; failing
to do so SHALL be a warning on stderr, not an error. `serve` writes no
event, needs no actor, and SHALL accept and ignore `--as`.

#### Scenario: Start and stop
- **WHEN** `agentboard serve --port 0 --json` runs on a board and receives SIGINT after printing its start-up line
- **THEN** the line parses as JSON with a numeric `port`, a 43-character `token` and `writable` false, and the process exits 0

#### Scenario: Port in use
- **WHEN** `agentboard serve --port <p>` runs while another process listens on `127.0.0.1:<p>`
- **THEN** it exits 1 with reason `port-in-use` and a hint naming `--port`

#### Scenario: No board
- **WHEN** `agentboard serve` runs where discovery finds no board
- **THEN** it exits 2 naming the path it looked at, and no port is bound

### Requirement: Loopback only
The server SHALL listen on `127.0.0.1` only and SHALL NOT listen on any
other address.

#### Scenario: Bound address
- **WHEN** the server has started
- **THEN** its listening address is `127.0.0.1`

### Requirement: Access token
The server SHALL draw a new access token of 32 random bytes, encoded as
43 base64url characters, at every start, and SHALL require it on every
request, in one of these forms: the query parameter `token` on `GET /`
only, which SHALL be answered with `303 See Other` to `/` and a
`Set-Cookie` of the cookie below; the cookie `agentboard-<port>` with the
attributes `HttpOnly`, `SameSite=Strict` and `Path=/`; or the header
`Authorization: Bearer <token>`. Tokens SHALL be compared in constant
time. A request without a valid token SHALL be answered with status 401:
an `ErrorDocument` with reason `unauthorized` on API paths, a plain text
page telling the user to open the URL printed at start-up otherwise. The
token SHALL never be logged, written to a file, or included in any
response body.

#### Scenario: Entry URL sets the cookie
- **WHEN** a client requests `GET /?token=<token>` with the correct token
- **THEN** the response is 303 to `/` with a `Set-Cookie` for `agentboard-<port>` that is `HttpOnly` and `SameSite=Strict`

#### Scenario: Query token is not accepted on the API
- **WHEN** a client requests `GET /api/board?token=<token>` with no cookie and no Authorization header
- **THEN** the response is 401 with reason `unauthorized`

#### Scenario: Wrong token
- **WHEN** a client requests `GET /api/board` with `Authorization: Bearer` and a token of the right length that differs in one character
- **THEN** the response is 401

### Requirement: Host header check
Before checking the token, the server SHALL require the `Host` header to
be exactly `127.0.0.1:<port>` or `localhost:<port>`, and SHALL answer any
other value, or a missing header, with 403 and reason `forbidden-host`.

#### Scenario: DNS rebinding
- **WHEN** a request with a valid token cookie carries `Host: attacker.example:<port>`
- **THEN** the response is 403 with reason `forbidden-host` and no board data

### Requirement: No cross-origin access and security headers
No response SHALL carry an `Access-Control-Allow-Origin` or any other
`Access-Control-Allow-*` header. Every response SHALL carry
`Content-Security-Policy: default-src 'none'; script-src 'self';
style-src 'self'; connect-src 'self'; img-src 'self' data:;
base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and
`X-Frame-Options: DENY`, and every API and stream response SHALL carry
`Cache-Control: no-store`.

#### Scenario: Preflight is refused
- **WHEN** a client sends `OPTIONS /api/board` with an `Origin` of another site
- **THEN** the response is 405 and carries no `Access-Control-Allow-*` header

#### Scenario: Headers on every response
- **WHEN** the page, an asset, an API response, a stream and a 401 are each requested
- **THEN** every response carries the Content-Security-Policy, nosniff, no-referrer and frame headers above

### Requirement: Read-only server
The server SHALL answer only `GET`; any other method SHALL be answered
with 405, an `Allow: GET` header and reason `method-not-allowed`. Serving
SHALL write no event and no cursor; the only change it SHALL make to the
board is the catch-up any read command performs.

#### Scenario: POST is refused
- **WHEN** an authenticated client sends `POST /api/board`
- **THEN** the response is 405 with reason `method-not-allowed`, and no event file is created

### Requirement: Reads never block writers
Every API response SHALL be built from one read snapshot of the cache,
ended before the response is written to the network. The server SHALL
never hold a transaction across network IO or a timer. Stream data that a
client does not read SHALL be buffered for that client up to 4 MiB, after
which that client SHALL be disconnected.

#### Scenario: Slow client does not block writers
- **WHEN** a stream client stops reading and twenty processes each run `comment` on one ticket
- **THEN** all twenty commands exit 0 and `rebuild --check` reports no divergence

### Requirement: JSON API
The server SHALL answer these authenticated `GET` routes with JSON:
- `/api/session`: `{version, boardDir, writable, actor}` (`writable` false
  and `actor` null in this capability);
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

### Requirement: Live event stream
`GET /api/stream` SHALL answer with `text/event-stream` and deliver the
board feed: first a `retry: 2000` line, then each feed message as an SSE
event whose `event` field is its type (`append` or `resync`), whose `id`
is its position id and whose `data` is the message as JSON. The feed
SHALL start from the position id in the `Last-Event-ID` header, else from
the `since` query parameter, else from the start (an `append` of every
effective event). A comment line SHALL be sent every 15 seconds. A tick
failure other than `busy` SHALL be sent as a `problem` event whose data is
its `ErrorDocument`, and the stream SHALL continue. One feed SHALL serve
every stream of the server. At most 64 streams SHALL be open at once; a
further request SHALL be answered with 503 and reason `too-many-streams`.

#### Scenario: CLI write reaches the browser
- **WHEN** a client holds `/api/stream` open and another process runs `agentboard move T1 tests --as a`
- **THEN** within 3 seconds the client receives an `append` event containing that move and T1 in status `tests`

#### Scenario: Reconnect resumes
- **WHEN** a client reconnects with `Last-Event-ID` set to the last id it received, and one comment was written while it was disconnected
- **THEN** its first event is an `append` of exactly that comment

#### Scenario: Late arrival reaches the browser
- **WHEN** a client holds the stream open and an event file sorting before its head is copied into `events/`
- **THEN** the client receives a `resync` event listing that event as late

### Requirement: Board views
`GET /` SHALL serve a single-page app with four views, each computed by
the board view-model and updated from the stream without a page reload:
a live board (one column per status, cards as `boardColumns` defines them,
changed cards highlighted, filters by change and assignee, closed tickets
on request); an activity feed (entries as `feedEntries` defines them,
filterable by change, actor and kind, late arrivals marked); a ticket
detail (fields, checklist, links, disposition, the conversation as
`conversation` defines it with decisions and retractions highlighted, and
the ticket's events with their outcomes); and agent lanes (as `agentLanes`
defines them, with "last seen" as `relativeTime`, refreshed at least every
10 seconds). A resync SHALL reload the snapshot. The current view and its
filters SHALL be kept in the URL hash, so reloading the page restores them.

#### Scenario: Card moves live
- **WHEN** the board view is open and another process moves T1 from `todo` to `tests`
- **THEN** T1's card is shown in the `tests` column and marked changed, without a page reload

#### Scenario: Conversation highlights a decision
- **WHEN** the detail view of a ticket with a comment `DECISION: use sessions` is open
- **THEN** that message is shown highlighted as a decision

### Requirement: Self-contained front end
The page, script and stylesheet SHALL be built at package build time into
`dist/web/` and served from there; serving SHALL need no package beyond
the runtime dependencies of agentboard, and the page SHALL request nothing
from any origin other than the server. No built asset SHALL contain an
`http://` or `https://` URL referring to another host.

#### Scenario: No external requests
- **WHEN** the built assets in `dist/web/` are scanned
- **THEN** they contain no `http://` or `https://` URL naming a host

### Requirement: Board text is never markup
Every text taken from the board (titles, descriptions, labels, comments,
notes, actor names, paths) SHALL be rendered as text, never interpreted as
HTML.

#### Scenario: Title with markup
- **WHEN** a ticket's title is `<img src=x onerror=alert(1)>`
- **THEN** the board view shows that text literally and the document contains no `img` element for it
