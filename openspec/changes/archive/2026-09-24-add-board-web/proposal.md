# Proposal

## Why

The board is only visible through one-shot commands (`list`, `show`,
`inbox`) and the per-actor `watch` stream. A human supervising several
agents has no way to see the whole board move: which tickets are in which
column right now, what each agent last did and when, and what was said in
each hand-off, without running commands in a loop. The event log already
holds all of this; what is missing is a live, whole-board view that stays
local and offline like the rest of agentboard.

## What Changes

- `agentboard serve [--port <n>] [--open]`: a read-only local web app,
  served by `node:http` (no web framework), bound to `127.0.0.1` only,
  protected by a random access token printed at start-up (handed to the
  page in the URL fragment and sent only as an `Authorization: Bearer`
  header, never in a cookie), a `Host` header check against DNS rebinding
  and no cross-origin access.
- A board-wide change feed (new capability `board-feed`): the catch-up,
  `fs.watch` and polling machinery of `watch`, generalized to every
  effective event of the board instead of one actor's cursor, reporting
  each change either as an append (new events after everything seen) or as
  a resync (an event arrived late by `sync`, or stopped being effective),
  with a position id that lets a client resume after a disconnect. `watch`
  moves onto the same ticker with no change in behavior.
- A read-only JSON API (session, board snapshot, ticket detail with its
  ordered events, events after a position, actors) and a Server-Sent
  Events stream carrying the feed to the browser, resumable with
  `Last-Event-ID`.
- Views: a live board (one column per status; cards move as tickets
  change), an activity feed filterable by change, actor and kind, a ticket
  detail with a conversation view (comments and hand-offs as a chat
  between actors, `DECISION:` and `RETRACTED:` highlighted), and agent
  lanes (per actor: tickets held, last event, and a derived "last seen";
  no presence events).
- A shared, pure view-model layer (new capability `board-view-model`,
  `src/view/`): functions from board state and events to view data, used
  by the web app now and by the terminal UI (`add-board-tui`) later, unit
  tested without a DOM.
- The front end is written with Preact and compiled into `dist/web/` at
  build time, so `npm link` and the published package need nothing extra
  and make no network request at run time.

## Capabilities

### New Capabilities
- `board-feed`: the board-wide change feed (append and resync, position
  ids and resume), shared by `serve` and, later, `top`.
- `board-view-model`: pure view data for the board, the activity feed, the
  conversation and agent lanes.
- `board-web`: the `serve` command, its security model, the JSON API, the
  event stream and the views.

### Modified Capabilities
- `board-cli`: "Command surface" gains `serve`; "MCP server" excludes
  `serve` from the tools, like `watch`; "Exit codes" names a server that
  cannot listen as exit 1.

## Non-Goals

- Writing from the browser. That is `add-board-web-actions`, which builds
  on this change; here every request that is not `GET` is refused.
- Health checks, replay and the hand-off graph (`add-board-insights`).
- Serving beyond the local machine: no binding to other interfaces, no
  TLS, no accounts. The token defends the local server against other web
  pages and other local users, not against someone who can read your
  terminal.
- Presence: "last seen" is derived from the last event an actor wrote. No
  heartbeat or presence event is added; no event kind or schema change is
  made by this change.

## Impact

- New source: `src/board/feed.ts` (and a shared ticker used by
  `src/board/watch.ts`), `src/view/` (pure, browser-safe), `src/web/`
  (server, API, stream) and `src/web/client/` (Preact front end, its own
  `tsconfig.json` with the DOM library).
- Small refactors with no behavior change: `src/events/ulid.ts` uses the
  global Web Crypto `getRandomValues` instead of `node:crypto`, so the pure
  fold can be bundled for the browser; `openDecisions` and the
  `DECISION:`/`RETRACTED:` prefixes move to a pure module under
  `src/events/` and stay re-exported from `src/board/actions.ts`.
- Build: a third tsup entry bundles the client for the browser into
  `dist/web/`; `npm run typecheck` also checks the client project.
- New devDependencies only, installed with `npm install --save-dev`:
  `preact` (bundled into `dist/web` at build time, so not a runtime
  dependency), `@testing-library/preact` and `happy-dom` (component and
  smoke tests). No runtime dependency is added.
- New reasons with hints: `port-in-use`, and the HTTP error reasons
  `unauthorized`, `forbidden-host`, `not-found`, `method-not-allowed` and
  `too-many-streams`.
- README section and ADRs 0006 (local web server security model) and 0007
  (board feed and shared view-model).
