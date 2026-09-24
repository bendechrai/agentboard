# Design

## Context

The store already gives everything a live view needs: the event log is the
source of truth (ADR 0001), the cache is caught up by any reader without
taking the write lock when there is nothing to fold (ADR 0002), `folded`
records every well-formed event's position and outcome, and `watch`
(ADR 0003) streams one actor's pending inbox entries with `fs.watch`, a
2 second polling fallback and a change marker (`PRAGMA data_version` plus
`total_changes()`) that makes an idle tick read nothing. This change turns
that machinery into a board-wide feed, serves it to a browser, and adds a
pure view-model layer that the terminal UI (`add-board-tui`) and the
insights (`add-board-insights`) reuse. `add-board-web-actions` later adds
writes; nothing here writes an event.

Four changes share one data layer, in this order:

1. `add-board-web` (this change): `board-feed`, `board-view-model`,
   `board-web`.
2. `add-board-insights`: health, replay and the hand-off graph, as more
   view-model functions and web views, plus `agentboard health`.
3. `add-board-tui`: `agentboard top`, a terminal client of the same feed
   and view-model.
4. `add-board-web-actions`: write actions from the browser under
   `serve --as <actor>`.

## Goals / Non-Goals

**Goals:**
- A human sees the whole board change live, including events that arrive
  late through `sync`, without any command loop.
- No guarantee of the board weakens: readers never block writers, every
  write is still one transaction (this change writes nothing), the event
  schema is unchanged and no event kind is added.
- The server is safe to run on a developer machine with a browser open to
  arbitrary web sites.
- One tested definition of every piece of view data, used by the web and
  the terminal UI.
- `npm link` and the package work with no extra install step and no
  network access at run time.

**Non-Goals:**
- Writes (change 4), insights (change 2), the terminal UI (change 3).
- Remote access, TLS, accounts, multi-user sessions.
- Boards far beyond the tested scale (see Risks).

## Decisions

### The server is `node:http`, with a small router of our own
The API is a handful of fixed `GET` routes plus static files and one
stream. `node:http` covers it with no dependency, and keeping request
handling in our own code keeps the security checks (host, token, method,
headers) in one audited function that runs before any route.

Alternatives considered: Express, Fastify or Hono. Each adds a runtime
dependency and middleware ordering to reason about, for a server with no
routing needs they would meet better than a switch on the path.

### Loopback only, OS-assigned port by default
The server binds `127.0.0.1` and nothing else. `--port <n>` (0 to 65535)
chooses the port; without it the port is 0, so the operating system picks
a free one, and the URL printed at start-up is the only way in anyway
(the token changes every run, so a stable port would not give a stable
URL). A port already in use exits 1 with reason `port-in-use`.

Alternatives considered: a fixed default port (for example 4477). It is
easier to remember but fails when two boards are served at once, and a
bookmark would still fail on the token. Binding `::1` as well was
rejected: one address keeps the Host check and the printed URL simple;
browsers reach `127.0.0.1` directly.

### An access token on every API request, sent only as a bearer header
At start-up the server draws 32 random bytes and encodes them base64url
(43 characters). It prints `http://127.0.0.1:<port>/#token=<token>`. The
token travels in the URL fragment, which a browser never sends to a
server, never puts in a `Referer`, and which the page removes from the
address bar at once.

- The page and its static assets (`GET /`, `/app.js`, `/app.css` and the
  other flat files of `dist/web/`) are served without a token. They are
  the same bytes for every board and contain no board data, so there is
  nothing to protect in them; the Host check, the method check and the
  security headers still apply.
- Every `/api/*` request, `/api/stream` included, requires
  `Authorization: Bearer <token>`. This is the only accepted form: a
  `token` query parameter and every cookie are ignored, and the server
  sets no cookie.
- The client reads `#token=<token>` from `location.hash`, stores it in
  `sessionStorage` under `agentboard-token` (a token in the fragment
  replaces a stored one), calls `history.replaceState` to drop the
  fragment, and sends the header on every `fetch`, the stream included
  (see the stream section). A reload of the tab keeps working from
  `sessionStorage`. A tab with no token, or whose token gets a 401 (for
  example after the server was restarted with a new token), discards the
  stored token and shows a message telling the user to open the URL
  printed by `agentboard serve`; it does not retry.

`sessionStorage` is isolated by origin, which includes the port, so a page
served by another process on `127.0.0.1` cannot read it; only script of
this origin can, and the Content-Security-Policy admits only this server's
own script, which never renders board text as markup.

Comparison is constant time (`crypto.timingSafeEqual` over equal-length
buffers). The token is never logged, written to disk, set in a cookie or
returned by any response. `Referrer-Policy: no-referrer` is kept as well.

Why a token at all when the server is on loopback: any web page the user
has open can make requests to `127.0.0.1`, and any local user or process
can connect to it. The token is what the attacker does not have.

Why no cookie (this replaces the earlier design, which set an `HttpOnly`,
`SameSite=Strict` cookie `agentboard-<port>` from a `/?token=` entry URL
answered with a 303): browsers do not isolate cookies by port (RFC 6265
section 8.5), and SameSite treats every port of `127.0.0.1` as the same
site. The cookie holding the token was therefore sent to every server
listening on `127.0.0.1`, whatever its port, including another OS user's
process, as soon as any page led the browser there (a plain navigation
followed by a same-origin `fetch` on that server was enough, as the
security review reproduced in Chromium). It also leaked into the logs and
request dumps of every other local development server, could be
overwritten or shadowed by another port (cookie tossing, a denial of
service), and the `/?token=` entry URL stayed in browser history as a
redirect source. A header the page sets itself goes only where the page
sends it.

Alternatives considered: no token, relying on the Host check (rejected:
any local process can connect with a correct Host header); the per-port
cookie (rejected, above); the token in a query parameter on every request
(rejected: it lands in history, logs and `Referer`); the fragment
exchanged by script for a cookie (the cookie problem again); HTTP basic
auth (rejected: browsers cache and prompt for it, and send it to the
whole host); requiring the token for the static page too (it would need
the query or a cookie again to load the page, for no protected data).

### Host header check and no cross-origin access
Before the token is looked at, the request must carry exactly one `Host`
header, and its value must be exactly `127.0.0.1:<port>` or
`localhost:<port>`; anything else, a missing header or a repeated one
(Node keeps only the first in `req.headers.host`, so the check uses
`req.headersDistinct.host`), is `403` with reason `forbidden-host`. This defeats DNS rebinding, where an attacker's
domain is re-pointed at `127.0.0.1` so the browser treats the local server
as same-origin with the attacker's page (the Host header then names the
attacker's domain).

No response ever carries an `Access-Control-Allow-*` header, and
`OPTIONS` is refused like every other method that is not `GET`, so no
preflight ever succeeds. Every response carries:

- `Content-Security-Policy: default-src 'none'; script-src 'self';
  style-src 'self'; connect-src 'self'; img-src 'self' data:;
  base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `X-Frame-Options: DENY`
- `Cache-Control: no-store` on API and stream responses.

Order of checks for every request: Host, then (on `/api/*` only) token,
then method, then route. A request that fails a check gets an
`ErrorDocument` (the same `{error: {exitCode, reason, message, hint}}` the
CLI prints with `--json`) for API paths and a short plain text page
otherwise.

Static files are named flat (no separator, no percent sign, no leading
dot), opened once with `O_NONBLOCK` and `O_NOFOLLOW`, and served only when
`fstat` of the open descriptor says it is a regular file, so a FIFO or
device placed in `dist/web/` cannot block the event loop and nothing can
be swapped between the check and the read.

### Server-Sent Events for the live stream, read with `fetch`
The browser needs one-way, ordered, resumable delivery. SSE gives exactly
that over plain HTTP, with an id per event, a `retry` hint and resume by
`Last-Event-ID`. `EventSource` cannot set request headers, and the token
travels only in the `Authorization` header, so the client reads the
stream with `fetch` and a small SSE parser (lines, `event`, `id`, `data`,
`retry` and comments; a few dozen lines, unit tested). When the stream
ends or fails it reconnects after the `retry` interval with the last id
it received in a `Last-Event-ID` header, and a 401 stops it and shows the
no-token message. The server side is plain SSE and unchanged by the
choice of client.

Alternatives considered: `EventSource` (cannot send the header, so it
would need a cookie or a query token, both rejected above); WebSocket
(bidirectional, which nothing here needs; needs an upgrade handler and
its own framing, or a dependency, and the browser API cannot set an
`Authorization` header either); long polling (reinvents the reconnection
and ordering SSE provides).

### The board feed: append or resync
`watch` follows one actor's cursor; the web needs every effective event.
The feed (`board-feed`) keeps, instead of watch's examined set, the set of
effective events it has delivered and its head (the greatest delivered
event in fold order). On a tick whose change marker moved, it lists the
effective events and compares:

- newly effective events that all sort after the head, and no delivered
  event that stopped being effective: an **append**, carrying the new
  events in fold order and the current state of every ticket they name;
- anything else: a **resync**, listing the late events (newly effective
  behind the head) and the removed ones (no longer effective).

An event can stop being effective: two clones each fold a local claim of
one ticket, and after `sync` the earlier claim wins and the other is
refolded as `already-assigned`. `watch` never needs to report that,
because an inbox is a stream of events, not a picture of state; a board
view does. A resync tells the consumer to reload its snapshot (board state
and events) rather than patching the model: late arrivals are rare, a
reload is one request, and patching would mean refolding in the client
anyway.

Alternatives considered: sending the whole board state on every change
(simple, but it re-sends every ticket for each comment and loses the event
granularity the feed and activity view need); client-side refolding on
late events (correct, but every consumer would have to do it, including
the terminal UI).

### Position ids and resume with a set digest
Each feed message has an id `<head>.<digest>`: `<head>` is the head's
64-character hash (or `none` on an empty board) and `<digest>` is the
64-character hex XOR of the SHA-256 values (32 bytes each) of every
effective event at or before the head. XOR over a set is order
independent and updated in constant time per added or removed event.

On reconnect the browser sends the last id as `Last-Event-ID`; the first
connection passes the id from its snapshot as `?since=<id>`. The server
recomputes the digest of the effective events at or before that head. If
the head is a recorded event and the digests match, the set of effective
events up to the head is the one the client has, and the server sends
only the events after the head (one append). Otherwise, including an
unparsable id, it sends a resync. So a late arrival or a refold during a
disconnect is never missed, and the common reconnect costs no reload.

Alternatives considered: the head hash alone (misses a late arrival behind
the head during a disconnect); a count of effective events up to the head
(an added late event and a removed claim cancel out, and that is exactly
the claim-race case); always resync on reconnect (correct but reloads
everything after every network blip or laptop sleep).

### One ticker for `watch` and the feed
The tick loop of `watch` (initial tick, `fs.watch` with a 25 ms settle,
polling every 2 seconds, no overlapping ticks, `busy` failures reported as
warnings, cleanup on abort) moves into a shared ticker in
`src/board/ticker.ts`. `watchInbox` and the feed are two examiners run by
it. `watch`'s behavior and its tests are unchanged; that is the check that
the refactor is safe.

### Event files are cached by hash
The feed and the API read event files to show event bodies. A file's name
is the hash of its content and files are never modified (board-events), so
the server keeps a process-wide map from hash to parsed event and never
reads a file twice. Only files that `folded` records as well-formed are
read.

### One feed per server, fanned out to every client
The server runs one feed and forwards each message to every open stream.
A new or resuming stream computes its first message in the same
synchronous turn in which it subscribes, so no message can fall between
the two.

The joiner's position id is compared with the board, not with what the
shared feed has delivered. `/api/board` runs its own catch-up, so the id
of a fresh snapshot can be ahead of the feed for up to one tick (25 ms
after an `fs.watch` notification, up to 2 seconds on the polling
fallback). Resuming against the feed's delivered set in that window gave
the joiner a spurious `resync` with the feed's older id, and then, when
the feed ticked, an `append` of an event the snapshot already held, which
`applyFeedMessage` would add twice (found by the security review: 13 of
25 page loads during a burst of agent writes). So a join first brings the
feed up to date in the same turn: one catch-up and examination, exactly
as a tick, delivering any resulting message to the streams already open,
and only then computes the joiner's first message from the new state.
Examination is synchronous, so it cannot interleave with a ticker tick,
and the ticker's next tick then finds nothing new. A stream started with
the id of any snapshot taken before it therefore gets an append of exactly
the events after that id, or nothing. At most 64 streams are open at once; the 65th gets `503` with
reason `too-many-streams`. A stream sends `retry: 2000` first and a
comment line every 15 seconds, so dead connections are noticed and
proxies do not time out.

### Reads never block writers
Every API response is built inside one deferred read transaction
(`inSnapshot`), which is committed before the response is written to the
socket; no transaction is ever held across network IO or a timer. Catch-up
before a read takes the write lock only when there is something to fold or
reap, exactly as for any read command. A slow or stalled client therefore
holds no lock and no snapshot. Stream writes that the socket cannot take
immediately are buffered per client up to 4 MiB; a client over that limit
is disconnected (it reconnects and resumes).

### A tick failure does not stop the server
`watch` stops on a non-busy error. The server instead reports the error on
stderr once per distinct message, sends it to every stream as a `problem`
message (an `ErrorDocument`), and keeps ticking; requests that fail answer
with the error document and status 500. A long-running viewer should
survive, for example, a corrupt file that a human is about to restore.

### The view-model is pure and browser-safe
`src/view/` holds pure functions from inputs (tickets, events with their
outcomes, `now`, filters) to plain view data: columns and cards, feed
entries and their summaries, the conversation of a ticket, agent lanes,
relative times, and the reducer that applies feed messages to a client
model. They read no clock (`now` is a parameter), do no IO and import no
`node:` module, directly or transitively; a layering test enforces this.
The web client and the terminal UI import them; so do the insights.

Two small refactors make the pure layer bundleable: `src/events/ulid.ts`
switches from `node:crypto`'s `getRandomValues` to the global Web Crypto
one (present in Node 22 and every browser; same bytes contract), and
`openDecisions` with the `DECISION:` and `RETRACTED:` prefixes moves from
`src/board/actions.ts` (which imports `node:fs`) to
`src/events/decisions.ts`, re-exported from `actions.ts` so the library
API is unchanged. The close rule and the views then share one definition
of an open decision.

### Front end: Preact, compiled by the existing esbuild toolchain
The client is written in TypeScript with JSX for Preact and bundled by a
third tsup entry (esbuild, `platform: 'browser'`, everything inlined,
minified) into `dist/web/app.js`, with `dist/web/index.html` and
`dist/web/app.css` copied beside it. The server serves them from the
directory next to its own module. Preact is a devDependency: it is inlined
into the bundle at build time, so nothing is installed or fetched at run
time and the package's runtime dependencies do not change. The client has
its own `tsconfig.json` (DOM library, `jsxImportSource: preact`), checked
by `npm run typecheck`. Views are selected by the URL hash (`#/board`,
`#/feed`, `#/ticket/<id>`, `#/lanes`); there is no router library and no
CSS framework (one hand-written stylesheet with light and dark schemes).
Text is only ever rendered as text; `dangerouslySetInnerHTML` is not used
anywhere, which a test checks.

Alternatives considered:
- No framework (DOM calls and template strings): smallest bundle, but live
  updates of four views with filters, scroll position and, in change 4,
  forms mean writing a small diffing layer ourselves, and component tests
  would test that layer rather than the views.
- React: the same model as Preact at about ten times the bundle size.
- Lit or Svelte or Solid: Lit has thinner testing tools for this use;
  Svelte and Solid need compiler plugins in the build, where Preact's JSX
  is handled by esbuild with no plugin.
- Preact with `htm` tagged templates instead of JSX: avoids a JSX build
  step we already have, and loses type checking of the markup.

### Client model
On load the client takes the token from the fragment or `sessionStorage`
(see the access token section), fetches `/api/session`, `/api/board` and
every page of `/api/events` with the bearer header, builds its model with
the view-model, and opens `/api/stream?since=<id>` with `fetch`. Appends go through the view-model reducer; a
resync (or a `problem` followed by recovery) reloads the snapshot. A
10 second timer re-renders relative times. Filters live in the URL hash
query, so a filtered view can be reloaded.

### Testing strategy
- View-model: unit tests in the Node environment, table-driven, plus a
  property that applying an append to a model equals building the model
  from a snapshot taken after the same events.
- Feed: tests against temporary boards, with events written by other
  processes and late events copied in (the fixtures `watch` already uses),
  including the claim race refolded after a late earlier claim.
- Server and API: vitest tests that start the server on port 0 in process
  and use `fetch` or raw sockets: every security check (one Host header,
  the bearer token as the only form, query tokens and cookies ignored, no
  `Set-Cookie`, the page and assets without a token, method, headers, no
  CORS headers), every route, and the stream (append within 3 seconds of
  a CLI write in a child process, resync on a late file, resume by
  `Last-Event-ID`, and a join from a fresh snapshot with the feed's timers
  faked so it has not ticked).
- Components: `@testing-library/preact` in a `happy-dom` environment
  selected per file (`// @vitest-environment happy-dom`), with stubbed
  `fetch` (streamed responses for the stream); the token hand-over from
  the fragment to `sessionStorage` and the no-token message are tested
  there too.
- Smoke: using the built package (`dist/cli.js`, as the concurrency tests
  already do), start `serve --port 0 --json`, load the served HTML and
  bundle in a `happy-dom` window at the start-up URL (token in the
  fragment) whose `fetch` reaches the live server, and check that a ticket created by the CLI appears on the
  board within 3 seconds. A browser-driving tool such as Playwright was
  rejected for `make check`: it downloads browsers and does not run in the
  pinned Docker toolchain without extra setup.

### Registry, help and MCP
`serve` is a streaming command in the registry (group `awareness`, like
`watch`), with description, examples and exit codes checked by the help
drift guard. It writes no event and tracks no cursor, so it needs no
actor; `--as` is accepted and ignored in this change (change 4 gives it a
meaning). `--json` prints one JSON line at start-up,
`{"url", "port", "token", "writable": false}`, and nothing else on stdout.
`serve` is added to the MCP excluded commands, with `watch`. New reasons
get hints like every other reason; HTTP errors use the CLI hint surface.

## Interfaces (sketch)

Names are indicative; the test author's stubs are authoritative.

- `src/board/ticker.ts`: `runTicker(board, { signal, pollMs, fsWatch,
  examine, onWarning })`.
- `src/board/feed.ts`: `watchBoard(board, { signal, since?, onMessage,
  onWarning, onProblem })`; `FeedMessage` is
  `{ type: 'append', id, events: EventView[], tickets: Ticket[], meta? }` or
  `{ type: 'resync', id, late: EventView[], removed: string[] }`;
  `positionId(head, digest)`, `parsePositionId(text)`,
  `effectiveDigest(hashes)`.
- `src/board/snapshot.ts`: `loadSnapshot(board)` returning the tickets,
  meta, every well-formed event as an `EventView` in fold order and the
  position id, from one read snapshot (event bodies through the hash
  cache); used by `/api/board`, `/api/events` and, in `add-board-tui`, by
  `top`.
- `src/view/`: `EventView` `{ hash, kind, ticket, actor, ts, outcome:
  'applied' | 'rejected' | 'unknown', reason, event }`; `BoardModel`
  `{ tickets, events, head, id }`; `boardColumns`, `feedEntries`,
  `describeEvent`, `conversation`, `agentLanes`, `relativeTime`,
  `applyFeedMessage`.
- `src/web/server.ts`: `startServer(board, { port, host: '127.0.0.1',
  token, assetsDir, now })` returning `{ url, port, close() }`;
  `src/web/security.ts` with the per-request checks as pure functions of
  the request line and headers.

## Risks / Trade-offs

- [Large boards] -> the client loads every event at start-up. Target:
  20,000 events load and render in under 2 seconds on a laptop; the events
  API pages at 1,000 per request (at most 5,000). Beyond that, paging the
  feed view is a later change.
- [The server's event cache grows with the log] -> one parsed event per
  well-formed file, the same order of size as the log itself; acceptable
  for the target scale and freed on exit.
- [A tab left open for days] -> the feed's delivered set grows by one hash
  per effective event, like `watch`'s examined set (ADR 0003).
- [A local user who can read the terminal or the process list sees the
  token] -> out of scope, stated in the README: the token protects against
  web pages and other users' processes, not against your own account.
  `--open` passes the URL to the system opener, which is visible in the
  process list for the moment it runs.
- [The start-up URL is in browser history] -> the page drops the fragment
  with `history.replaceState`, but a browser may still record the URL it
  first loaded, fragment included, in its history database. That is
  readable only by the user's own account, and the token changes every
  run.
- [A new tab has no token] -> `sessionStorage` is per tab: a reload keeps
  the token, a tab opened by hand does not and shows the message pointing
  to the start-up URL. Accepted as the price of keeping the token out of
  cookies.
- [The token is readable by script of the origin] -> it lives in
  `sessionStorage`, not in an `HttpOnly` cookie, so an XSS in the page
  could read it. The CSP admits only the server's own script, and board
  text is never rendered as markup (board-web), so there is no injection
  point; an injection would have the page's full access either way.
- [A large-board join held in memory] -> a join's first `append` is
  written in full even when it is larger than the 4 MiB per-client
  buffer, so up to 64 authenticated clients that never read can hold about
  64 times the board size in memory until they are disconnected or close.
  Acceptable: only token holders can open streams.
- [Wall clocks differ between machines] -> "last seen" and relative times
  use event walls; a wall in the future shows as "just now", never as a
  negative age.
- [A synchronous write transaction by another command stalls a request]
  -> only when that request's catch-up has something to fold, and bounded
  by the busy timeout, exactly as for any CLI read.
