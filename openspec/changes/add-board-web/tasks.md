# Tasks

Depends on nothing beyond the archived changes. First of four changes
(`add-board-web`, `add-board-insights`, `add-board-tui`,
`add-board-web-actions`); the later ones build on the feed and view-model
defined here. Every group is delivered by a test author, an implementer
and a reviewer in turn (see CONTRIBUTING.md), on one branch per group
named `<area>/<group-slug>` and cut from `origin/staging`; the test
author's first commit defines the group's exported API as stubs.
Verification for every task includes `make check` and `make check-floor`
passing with coverage at or above 90 percent. Groups 3 and 5 are
security-critical: the orchestrator runs a second reviewer on the
strongest model.

## 1. Browser-safe events and the view-model (`view/view-model`)

- [x] 1.1 Switch `src/events/ulid.ts` to the global Web Crypto `getRandomValues`, and move `openDecisions`, `DECISION_PREFIX` and `RETRACTED_PREFIX` to `src/events/decisions.ts`, re-exported unchanged from `src/board/actions.ts` and `src/index.ts`. Verify: every existing test passes unmodified, and a new layering test fails if any module reachable from `src/events/fold.ts` or `src/events/decisions.ts` imports a `node:` specifier
- [x] 1.2 Implement `src/view/` types (`EventView`, `BoardModel`) and `boardColumns`, `feedEntries`, `describeEvent`, `conversation`, `agentLanes` and `relativeTime`. Verify: table tests for every scenario of board-view-model (column order, closed filter, blocked origin, card fields, AND filters, every `describeEvent` summary kind, decision and retraction flags, hand-off messages, lanes for assignees without events, negative ages, every `relativeTime` boundary), a determinism test calling each function twice on deep-equal inputs, and the layering test extended to every module under `src/view/`

## 2. Board feed (`board/board-feed`)

- [ ] 2.1 Extract the tick loop of `watchInbox` into `src/board/ticker.ts` (initial tick, `fs.watch` with the 25 ms settle, 2 second polling, no overlap, `busy` warnings, cleanup on abort) and run `watchInbox` on it. Verify: the existing `watch` tests pass without modification, plus ticker tests for the no-overlap rule and cleanup on abort with an injected clock
- [ ] 2.2 Implement `watchBoard` in `src/board/feed.ts` with append and resync messages, position ids and the digest, and an event cache keyed by hash. Verify: tests for an append after a CLI write in a child process within 3 seconds, a late file copied into `events/` giving a resync with it as late, the cross-machine claim race giving a resync with one late and one removed claim, idle ticks reading no event file (counted through an injected reader), the empty-board id, a digest equal across two read orders, no cursor row changed, and twenty concurrent `comment` processes succeeding while the consumer callback blocks
- [ ] 2.3 Implement resume from a position id and `applyFeedMessage` in `src/view/`. Verify: tests for resume after missed appends (exactly the missed events), a late arrival while disconnected (resync), an unparsable id (resync), and a property test that a model built from a snapshot and given an append deep-equals a model built from a later snapshot

## 3. Server, API and stream (`web/server`)

- [ ] 3.1 Implement `src/web/security.ts` (Host check, token forms, constant-time compare, cookie flow, method check, security headers) and `src/web/server.ts` on `node:http` bound to `127.0.0.1`, serving `dist/web/` assets; add the `serve` registry entry (streaming, group `awareness`, `--port`, `--open`, description, examples, exit codes), its start-up line and `--json` line, `--open` with a warning on failure, `port-in-use`, SIGINT and SIGTERM shutdown, `serve` in `EXCLUDED_COMMANDS`, and hints for `port-in-use`, `unauthorized`, `forbidden-host`, `not-found`, `method-not-allowed` and `too-many-streams`. Verify: tests for every board-web scenario of "Serve command", "Loopback only", "Access token", "Host header check", "No cross-origin access and security headers" and "Read-only server", the help drift guard, the hint completeness test, and the MCP tool list scenarios
- [ ] 3.2 Implement the snapshot loader (`src/board/snapshot.ts`: tickets, meta, every well-formed event with its outcome in fold order, and the position id, from one read snapshot) and the JSON API routes (`/api/session`, `/api/board`, `/api/tickets/<id>`, `/api/events`, `/api/actors`) on it, with `ErrorDocument` errors, each built in one read snapshot. Verify: a test that the loader's position id equals the id of a feed started on the same board; tests for every route and error, including the rejected-claim detail, paging 2500 events, `unknown-cursor`, a bad `limit`, and a check that no transaction is open on the server connection when a response body is written
- [ ] 3.3 Implement `/api/stream` over one shared feed: `retry`, typed events with ids, `Last-Event-ID` and `since`, keepalive comments, `problem` events, the 64-stream cap and the 4 MiB per-client buffer. Verify: tests for the three stream scenarios, the cap (503 `too-many-streams`), a client disconnected past the buffer limit, a `problem` event on an injected tick failure with the stream continuing, and twenty concurrent CLI comments succeeding while a stream client does not read

## 4. Front end (`web/client`)

- [ ] 4.1 Install `preact`, `@testing-library/preact` and `happy-dom` with `npm install --save-dev`; add `src/web/client/` with its own `tsconfig.json` (DOM library, `jsxImportSource: preact`), a tsup browser entry bundling it with everything inlined into `dist/web/app.js`, `index.html` and `app.css` copied to `dist/web/`, and `npm run typecheck` checking both projects. Verify: `make build` produces the three files, a test scans `dist/web/` for `http://` and `https://` URLs naming a host and finds none, `make lint` and `make typecheck` cover the client, and `npm pack --dry-run` lists `dist/web/` with no new runtime dependency in `package.json`
- [ ] 4.2 Implement the client model: load `/api/session`, `/api/board` and every page of `/api/events`, open `/api/stream?since=<id>`, apply appends with `applyFeedMessage`, reload on resync, show `problem` events, re-render relative times every 10 seconds, and keep the view and filters in the URL hash. Verify: component tests in `happy-dom` with a fake `EventSource` and stubbed `fetch` for the initial load, an append, a resync reload with late entries marked, a problem banner, and restoring a view and filters from the hash
- [ ] 4.3 Implement the live board and activity feed views from `boardColumns` and `feedEntries`. Verify: component tests for the card-moves-live scenario, the changed highlight, the change and assignee filters, the closed toggle, and the feed filters by change, actor and kind
- [ ] 4.4 Implement the ticket detail (fields, checklist, links, disposition, conversation, events with outcomes) and agent lanes views. Verify: component tests for the decision highlight, retracted and retraction flags, hand-off messages, a rejected event shown with its reason, lanes with "last seen", the title-with-markup scenario, and a source test that fails if `dangerouslySetInnerHTML` appears under `src/web/client/`

## 5. Smoke test and documentation (`web/smoke-docs`)

- [ ] 5.1 Add an end-to-end smoke test on the built package: start `node dist/cli.js serve --port 0 --json` on a temporary board, follow the token URL with a cookie jar, load the served HTML and bundle in a `happy-dom` window whose `fetch` and `EventSource` reach the live server, create a ticket with the CLI and see its card within 3 seconds, then stop the server with SIGINT. Verify: the test passes in `make check`, `make check-in-docker` and `make check-floor`
- [ ] 5.2 Document `serve` in README.md (what it shows, the security model and its limits, `--port`, `--open`, `--json`, the API routes for scripts), write ADR 0006 (local web server security model: loopback, token, Host check, no CORS) and ADR 0007 (board feed with append, resync and digest resume; the shared view-model), and update docs/STATUS.md. Verify: `make ascii`, `make validate-specs`, and running the documented commands on a fresh temporary project with a linked build, opening the URL in a browser
