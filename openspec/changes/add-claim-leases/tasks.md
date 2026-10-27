# Tasks

Independent of `add-board-insights` and `add-board-web-actions`: this
change's MODIFIED text restates requirements those changes do not touch
(`board-cli` "Command surface", "MCP server" and "Claim, release and
handoff", `board-events` "Event kinds" and
"Fold semantics", `board-cache` "Cache schema", `board-view-model`
"Activity feed entries", `board-agent-guidance` "Agent guide",
`board-openspec-integration` "Import a change", `board-concurrency`
"Re-import is idempotent"); if either
is archived first and changes one of them, re-sync that MODIFIED text with
the main spec before archiving this change. `add-board-web-actions` builds
the web action bodies from the registry, so `claim` and `release` gain
their new optional arguments there without further work (`--timeout` is
CLI-only); lease and queue controls in the web app are out of scope.
`add-harness-integration` also modifies `board-cli` "Command surface" and
"MCP server" (`hook`, `--command`); whichever change is archived second
re-syncs both requirements with the main spec first, keeping the other
change's additions. `add-board-sharing` was archived on 2026-10-17, and
its archive folded `remote`, `init [--remote <url> | --into-host]` and the
`move`, `close` and `health` flags of `add-adhoc-ticket-lifecycle` into the
main "Command surface" and "MCP server"; this change's text of both
requirements is re-synced with that main text, keeping those additions and
adding its own, so its archive applies cleanly.
`add-adhoc-ticket-lifecycle` was archived on 2026-10-17 (ADR 0013,
`GUIDANCE_VERSION` 2). Its archive changed the main text of
`board-agent-guidance` "Agent guide", `board-cache` "Cache schema" and
"One command, one transaction", `board-events` "Event kinds" and "Fold
semantics", and `board-view-model` "Activity feed entries"; this change's
MODIFIED text of each was re-synced with that main text, keeping the ad
hoc text and scenarios (the unplanned disposition, the `unplanned` cache
column, the two-event transaction, `ticket.unplanned`, the
`needs-scope-disposition` and `already-linked` fold rules in place of the
removed task-link gate at `implementing`, and the `recorded as unplanned`
summary) and adding its own. "Command surface" and "MCP server" already
carried the lifecycle's flags and needed no change. Both changes set the
guide limit to 180 lines, so the mutex recipe fits within it beside the
ad hoc text. This change's guidance group sets `GUIDANCE_VERSION` to 3
and its ADR is 0014.

Every group is delivered by a test author, an implementer and a reviewer
in turn (see CONTRIBUTING.md), on one branch per group named
`<area>/<group-slug>` and cut from `origin/staging`; the test author's
first commit defines the group's exported API as stubs. Verification for
every task includes `make check` and `make check-floor` passing with
coverage at or above 90 percent. Groups 1 to 5 are concurrency-critical:
the orchestrator runs a second reviewer on the strongest model. Groups run
in order, except that group 6 may run in parallel with groups 4 and 5.
Group 8 (re-import reconciliation) is independent of groups 1 to 7 and
may run at any time; if it lands first, group 1 re-syncs the
`board-events` "Event kinds" text it shares.
Tests that depend on time use an injected clock in-process and the
harness preload's clock offset for child processes, never a production
environment variable.

## 1. Lease, queue and grant fold (`events/claim-leases`)

- [x] 1.1 Extend `src/events/schema.ts`: the `lease` (`ttl`, `grace`, `expiresAt`) and `supersedes` fields of `ticket.claim`, the kinds `ticket.renew`, `ticket.release.force`, `ticket.queue.join`, `ticket.queue.leave` and `ticket.grant`, the range and `expiresAt` rules, the reserved actor `agentboard`, and the constants (`LEASE_SKEW_MS`, ttl, grace and window bounds and defaults). Verify: schema tests for every well-formed and malformed body named in board-events "Event kinds" and "Reserved system actor", including extra fields in nested objects, a `supersedes.event` that is not 64 lowercase hex characters, a grant with both or neither of `after.released` and `after.lease`, and a golden test that a plain claim's canonical bytes are unchanged from a fixture written before this change
- [x] 1.2 Implement the lease rules in `src/events/fold.ts` (grace lease, confirmation by renew, takeover with `supersedes` and the tolerance, lease cleared by release, forced release, hand-off and assign, forced release with `holder-changed`) and the settings `lease.grace` and `queue.window`. Verify: table tests for every scenario of "Claim leases", "Forced release", "Board lease settings" and the modified "Fold semantics"; a test that the fold reads no clock (an injected `Date.now` that throws, or the layering test)
- [x] 1.3 Implement the queue and grants: join and leave with `invalid-queue`, `queued` refusals, the pure `dueGrant` (slot time, head waiter, window at position, `after`) used by the fold to accept or reject `stale-grant`, and grant application. Verify: table tests for every scenario of "Waiting queue" and "Grants"; property tests (fast-check) generating random joins, leaves, renews, releases, forced releases and takeovers with random walls and actors, materialising every due grant at random clock points, and asserting over sampled permutations: byte-identical folded state, grants in join order among remaining waiters, reservation passing on non-acceptance at exactly window plus tolerance, grace expiry without renew at exactly grace plus tolerance, no position with two assignees, and no applied takeover or lapse grant with a wall below the named lease's `expiresAt + LEASE_SKEW_MS`
- [x] 1.4 Add the lease, availability and `waiters` state to `src/store/cache.ts`, bump `CACHE_SCHEMA_VERSION`, and include it in `rebuild` and `rebuild --check`. Verify: the "Lease survives a rebuild", "Queue survives a rebuild" and "Old cache is rebuilt" scenarios, `rebuild` twice byte-identical, and `rebuild --check` detecting a hand-edited `lease_expires_at` and a reordered `waiters` row

## 2. Grant materialisation in catch-up (`store/grant-catchup`)

- [x] 2.1 Make catch-up write every due grant (slot time at or before the local clock, not yet present) with the bytes `dueGrant` derives, fold it as a late event (refolding later events, moving inbox cursors back as board-concurrency requires), and let read-only commands take the write lock only when something is due; `rebuild` and `rebuild --check` never write grants. Verify: the two "Due grants are written during catch-up" scenarios; a chain of three lapsed grants written by one command in order; two processes materialising the same grant concurrently leaving one file; a read-only command with nothing due taking no write lock (an injected lock probe); the inbox of the grantee returning the grant exactly once; and the crash test killing a command after a grant file is renamed but before commit, with the next command recovering it; the `grant_watermark` row (the next missing grant's slot, absent when none, rebuild twice byte-identical including it and equal to incremental catch-up, lowered by a late release so the next command writes that grant), a warm catch-up before the watermark opening no event file (the read probe in process, the read log in a child), and a version 2 cache rebuilt; the scenario "Refused command keeps its catch-up"

## 3. Lease, queue and forced-release commands (`board/lease-commands`)

- [x] 3.1 Implement ttl, timeout and setting parsers, `claimTicket` with `ttl` and `wait` (timestamp before validation; takeover only when the fold rule and the local clock allow it; join when the ticket is held), `renewTicket` (default ttl from the lease), `unqueueTicket`, `releaseTicket` with `force` and `reason`, `config set` and `config get`, the reserved actor refusal, and the registry entries and flags (`--timeout` CLI-only). Verify: tests for every scenario of the modified "Claim, release and handoff", "Leases on the command line", "Forced release on the command line" and "Board settings command", with an injected clock; parsers accepting `30s`, `7d`, `10m` and refusing `29s`, `8d`, `0m`, `10min`, `m`, `-1m`; the help drift guard and the "Claim has help for leases and waiting" and "Renew, unqueue and config have help" scenarios of the modified "Command surface"; validation failures creating no event or temporary file
- [x] 3.2 Render leases and queues: `show` (lease line with grace or confirmed, queue with join times, pending or applied grant, takeover with both walls, forced release with actor, holder and reason), the `list` assignee token, `--json` `lease` and `queue`, inbox `affects`, `to` for grants, `note` for forced release, and the `GRANTED: ` and `LOST: ` prefixes; add the hints of "Lease and queue hints". Verify: golden CLI outputs (human and `--json`) for `show`, `list` and `inbox` on a fixture board at a fixed clock with tickets that are free, in grace, confirmed, expired, claimable, queued with three waiters, granted and pending acceptance, taken over and force-released; the inbox and hint scenarios; the hint completeness test; the provisional `queued` hint (`show <id>` since group 1) replaced by the `--wait` form and pinned by a test; and the `invalid-queue` and `stale-grant` hints checked against `show` now rendering the queue and lease
- [x] 3.3 MCP: `board_renew`, `board_unqueue`, `board_claim` `ttl` and `wait` (non-blocking), `board_release` `force` and `reason`, no `timeout` and no `config` tool. Verify: the three "Lease and queue tools over MCP" scenarios and the modified "MCP server" scenarios "Tools are listed from the registry", "Excluded config tool" and "CLI-only flag is refused over MCP"; golden MCP outputs (text content, structured content and tool errors with `exitCode`, `reason` and `hint`) for a leased claim, a renew, a queued claim (`{queued, position, holder, ticket}`), a refused takeover, a grant seen through `board_inbox` and a forced release; each event written through MCP byte-identical in body to the CLI's for the same arguments and actor on a copy of the board

## 4. Waiting in the foreground (`board/claim-wait`)

- [ ] 4.1 Implement `claim --wait --timeout` on the watch machinery: join, print the position, wake on events and at the next due grant time, write due grants, exit 0 on a grant to the actor (naming `renew` and the acceptance deadline), leave and exit 4 `wait-timeout` on timeout, leave on SIGINT and SIGTERM, claim instead when the join is rejected because the ticket became free. Verify: in-process tests with a fake clock and fake watch source for each "Waiting on the command line" scenario, including a wake at a due grant time with no new event, a timeout exactly at the boundary, and no busy loop (the number of catch-ups bounded by events plus due times); child-process tests for "Waiter is granted on release" within 3 seconds, SIGINT leaving the queue, and SIGKILL leaving the waiter queued

## 5. Concurrency, crash and replica tests (`board/lease-concurrency`)

- [ ] 5.1 Child-process tests on one board: ten concurrent takeovers of a claimable lease; ten concurrent `claim --wait` processes against a releasing holder granted exactly once each in join order; a waiter killed with SIGKILL whose grant passes on; a holder killed while holding a confirmed lease and recovered by takeover; a holder killed after its claim file is renamed but before commit. Verify: the scenarios of "Expired-lease claim race has exactly one winner", "Queue grants are fair and single" and "Crashed holder recovery through lease expiry", each repeated at least 20 times in the test without a flake, and `rebuild --check` clean after each
- [ ] 5.2 Replica tests with two clones and a bare remote, each clone's children running with its own clock offset (A 45 s and 59 s fast, B exact). Verify: the three scenarios of "Lease and queue folds converge across replicas with skewed clocks", with canonical dumps compared byte for byte after both clones sync, identical grants written on both clones merging as one file, no fold position with two assignees, and the late-renew case rejecting A's grant or takeover on both clones

## 6. Guidance and feed summaries (`guidance/mutex-recipe`)

- [x] 6.1 Add the `Mutex tickets` section to `help agents`, the worker lines to the test-author, implementer and reviewer checklists and the queue-runner lines to the orchestrator checklist, the short recipe to the installed `claude` and `agents-md` text, and the worker rule to the MCP instructions summary; set `GUIDANCE_VERSION` to 3. Verify: `src/guidance/__tests__/mutex-guide.test.ts` (37 tests: every `agentboard ` line of the section parses with `--as`, the pinned phrases, one mutex step per role checklist, the summary rule in at most two sentences) and `mutex-installed.test.ts` (10: `## Mutex tickets` in SKILL.md, `Mutex tickets:` in the AGENTS.md block, `agents install` writes v3, a v2 install is `stale`); `guide.test.ts` keeps every role output at most 180 lines (orchestrator is exactly 180) and ASCII, `guide-mcp.test.ts` the instructions at most 2000 characters with the worker rule and `agentboard://guide` equal to `help agents`; `install.test.ts` pins the ad hoc rule from version 2 on (09777d1, after the STOP ruling); the repo's own SKILL.md and openspec/config.yaml reinstalled at v3 (`agents check`: current)
- [x] 6.2 Extend `describeEvent` with the lease, queue and grant summaries and the ttl formatting rule. Verify: `src/view/__tests__/describe-leases.test.ts` (30 tests) pins each new summary, including `claimed (lease 90s)`, `renewed lease (2h)`, `joined the queue`, the "Forced release summary", "Takeover summary" and "Grant summary" scenarios, the ttl rule down to `30500ms`, and a rejected or stale event producing no feed entry; `formatDuration` lives in the browser-safe `src/view/time.ts` and `src/board/leases.ts` re-exports it (`src/board/__tests__/leases.test.ts` still green)

## 7. Documentation (`docs/claim-leases`)

- [ ] 7.1 Document leases, renew, the queue, `--wait`, grants, forced release and `config` in README.md (command reference; the mutex ticket recipe with a merge-lock example for CLI workers and for an orchestrator running the queue over MCP; grace and liveness; clock skew and multi-machine limits; the upgrade requirement for boards shared between machines), record the decisions in ADR 0014 (grace leases and liveness instead of a declared intent flag; takeover and grants decided from event timestamps with a fixed 60 second tolerance; derived, backdated grant events with the reserved actor; forced release as a distinct kind without an allowlist), run `agentboard agents install` in this repository to move its own guidance to version 3, and update STATUS.md. Verify: `make ascii`, `make validate-specs`, `agentboard agents check` reporting every target current, and running the README recipe on a temporary board (claim with `--ttl`, let the grace lapse, wait with `--wait --timeout` in a second terminal and see the grant, renew, force-release another ticket and read the previous holder's inbox)

## 8. Re-import reconciliation (`openspec/reconcile-import`)

- [x] 8.1 Add `ticket.reconcile` to `src/events/schema.ts` and its fold rule (index validation, title, updated, removed flag keeping indices, appended lines; ticks on removed lines rejected `checklist-index`), the per-line `removed` flag in the cache checklist JSON with a cache schema version bump (shared with group 1 if both land together), and the `describeEvent` summary. Verify: table tests for the three "Reconcile events" scenarios and the summary; a property test that folding a random ticket history followed by random reconciles and ticks is independent of read order and never changes the meaning of an existing index
- [x] 8.2 Implement pairing by identity in `src/board/import.ts`: title and line normalisation, the three passes with the 0.5 threshold and 0.2 margin, `reconcile-ambiguous` writing nothing, `ticket.renumber` and `ticket.supersede` (schema, fold with `stale-import`, `superseded` marker in `list` and `show`, `describeEvent` summaries), renumbers in ascending old-number order, new tickets for unpaired groups, closed tickets paired but never reconciled, and the pairing in `--dry-run`. Verify: tests for every scenario of "Pair tickets to groups by identity", "Renumber and supersede events" and the modified "Import a change"; a fixture reproducing the vaultfold insertion (groups 5 to 7 becoming 6 to 8); and the property test "Property: group edits never move work" (fast-check, tracking true group identity through random insertions, deletions, reorderings, renames and partial rewordings, with claims, comments and ticks attached), which must also show that a second re-import writes nothing
- [x] 8.3 Implement the reconcile diff for paired tickets in `src/board/import.ts` (match by task number then by text without the number, done-state rules, order preserved with additions appended, one event per ticket, none when unchanged), the guard (`reconcile-blocked` per ticket, exit 4 after all groups, `--force` with `forced` and `affects`), `--dry-run` (human and `--json`), the `reconcile-blocked` hint, and the `dry-run` and `force` arguments of `board_import_change`. Verify: tests for every scenario of "Reconcile on re-import", the modified "Import a change" and "Re-import is idempotent" (including two concurrent child-process imports of a revised change), a fixture reproducing the vaultfold case (a regrouped and reworded tasks file) whose reconciled tickets match the new groups exactly, dry-run output goldens, and no event file created by `--dry-run`
- [x] 8.4 Make removed checklist lines inactive on every surface (card progress in `src/view/columns.ts`, `top` in `src/tui/frame.ts`, the web ticket detail and checklist control, `show`), map the `checklist tick` reminder through active lines only, refuse stale writes inside an import as `stale-import` so the catch-up is committed, and carry the import result in the `--json` error document and the MCP error of `reconcile-blocked` and `reconcile-ambiguous`. Verify: tests for every scenario of board-cli "Removed checklist lines are inactive" and "Re-import markers in list and show", board-view-model "Checklist progress counts active lines", board-web "Removed lines in the ticket detail", board-web-actions "No checklist control for a removed line", and the board-openspec-integration scenarios "Renumbered done line is not blocked", "Refusal carries the result" and "Concurrent import leaves nothing stale"; deterministic tests of each stale skip (renumber, supersede, create, reconcile) killing the skip-removal mutants; the pairing and guard boundary tests
