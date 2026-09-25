# Tasks

Independent of `add-board-insights` and `add-board-web-actions`: this
change's MODIFIED text restates requirements those changes do not touch
(`board-cli` "Claim, release and handoff", `board-events` "Event kinds" and
"Fold semantics", `board-cache` "Cache schema", `board-view-model`
"Activity feed entries", `board-agent-guidance` "Agent guide"); if either
is archived first and changes one of them, re-sync that MODIFIED text with
the main spec before archiving this change. `add-board-web-actions` builds
the web action bodies with `toolArguments` from the registry, so
`claim` and `release` gain their new optional arguments there without
further work; lease controls in the web app are out of scope.

Every group is delivered by a test author, an implementer and a reviewer
in turn (see CONTRIBUTING.md), on one branch per group named
`<area>/<group-slug>` and cut from `origin/staging`; the test author's
first commit defines the group's exported API as stubs. Verification for
every task includes `make check` and `make check-floor` passing with
coverage at or above 90 percent. Groups 1 to 3 are concurrency-critical:
the orchestrator runs a second reviewer on the strongest model. Groups run
in order; group 4 may run in parallel with group 3.

## 1. Lease events and fold (`events/claim-leases`)

- [ ] 1.1 Extend `src/events/schema.ts`: the optional `lease` and `supersedes` fields of `ticket.claim`, the kinds `ticket.renew` and `ticket.release.force`, the ttl range and `expiresAt = ts.wall + ttl` rules (malformed otherwise, naming the field), and the constants `LEASE_SKEW_MS`, `TTL_MIN_MS` and `TTL_MAX_MS`. Verify: schema tests for every well-formed and malformed body named in board-events "Event kinds", including extra fields in `lease` and `supersedes`, a `supersedes.event` that is not 64 lowercase hex characters, and a golden test that a plain claim's canonical bytes are unchanged from a fixture written before this change
- [ ] 1.2 Implement the lease rules in `src/events/fold.ts`: the ticket's `lease`, renew by the assignee only, takeover acceptance (holder, lease event and expiry match, `ts.wall >= expiresAt + LEASE_SKEW_MS`), `supersedes` ignored on an unassigned ticket, lease cleared by release, forced release, hand-off and assign, and forced release with `holder-changed`; the fold must not read the clock. Verify: table tests for every scenario of "Claim leases", "Forced release" and the modified "Fold semantics"; a test that the fold module imports no clock (the layering test or an injected `Date.now` that throws); a property test (fast-check) generating a lease and random sets of takeover, renew, release, hand-off and forced release events with random walls and actors, asserting that every sampled permutation folds to byte-identical canonical state, that at most one takeover per lease generation is applied, and that no applied takeover has a wall below `expiresAt + LEASE_SKEW_MS` of the lease it names
- [ ] 1.3 Add the lease columns to `src/store/cache.ts`, bump `CACHE_SCHEMA_VERSION`, and apply and dump the lease in the cache fold and `rebuild --check`. Verify: the "Lease survives a rebuild" and "Old cache is rebuilt" scenarios, `rebuild` twice byte-identical with lease events present, and `rebuild --check` detecting a hand-edited `lease_expires_at`

## 2. Lease and forced-release commands (`board/lease-commands`)

- [ ] 2.1 Implement `parseTtl`, `claimTicket` with `ttl` (timestamp built before validation inside the transaction; takeover written with `supersedes` only when the fold rule and the local clock both allow it), `renewTicket`, and `releaseTicket` with `force` and `reason` (usage rules, secret patterns on the reason, `holder` from the current assignee), plus the `renew` registry entry and the `--ttl`, `--force` and `--reason` flags with descriptions, examples and exit codes. Verify: tests for every scenario of the modified "Claim, release and handoff" and of "Leases on the command line" and "Forced release on the command line", with an injected clock; `parseTtl` accepting `30s`, `99999s`, `7d` and refusing `29s`, `8d`, `0m`, `10min`, `m`, `-1m`; the help drift guard; and a validation-failure test proving no event file or temporary file is created
- [ ] 2.2 Render leases: `show` (lease line, takeover with both walls, forced release with actor, holder and reason), `list` assignee token (`+<remaining>`, `!expired`, `!claimable`), `--json` `lease` with `state` and `claimableAt`, and inbox `affects`, `note` for forced release and the `LOST: ` prefix; add hints for `holder-changed`, the lease form of `already-assigned` and `not-assignee` from `renew`. Verify: golden CLI outputs (human and `--json`) for `show`, `list` and `inbox` on a fixture board with a live, an expired, a claimable, a taken-over and a force-released ticket at a fixed injected clock; the "Previous holder is told" and "Hint for a live lease" scenarios; the hint completeness test
- [ ] 2.3 MCP: `board_renew`, `board_claim` `ttl`, `board_release` `force` and `reason`, all from the registry. Verify: the two "Lease tools over MCP" scenarios; golden MCP outputs (text content, structured content and tool errors with `exitCode`, `reason` and `hint`) for a leased claim, a renew, a refused takeover, a successful takeover and a forced release; and a test that each event written through MCP is byte-identical in body to the one the CLI writes for the same arguments and actor on a copy of the board

## 3. Lease concurrency, crash and replica tests (`board/lease-concurrency`)

- [ ] 3.1 Add a clock offset to the child-process test harness (through the existing harness preload, never through a production environment variable) and the child-process tests: ten concurrent takeovers of a claimable lease (exactly one winner, nine `already-assigned` naming it, `rebuild --check` clean), ten concurrent renews and forced releases mixed with takeovers (one consistent outcome, no lost event), a holder killed with SIGKILL while holding a leased claim and recovered by takeover, and a holder killed after its claim file is renamed but before commit. Verify: the scenarios of "Expired-lease claim race has exactly one winner" and "Crashed holder recovery through lease expiry", each run repeated at least 20 times in the test without a flake
- [ ] 3.2 Replica tests with two clones and a bare remote, each clone's children running with its own clock offset (A 45 s and 59 s fast, B exact). Verify: the three scenarios of "Lease folds converge across replicas with skewed clocks", with canonical dumps compared byte for byte after both clones sync, and the late-renew case asserting that the takeover is rejected on both clones and that A's next `inbox` carries the renew

## 4. Guidance and feed summaries (`guidance/mutex-recipe`)

- [ ] 4.1 Add the `Using a ticket as a mutex` section to `help agents`, the forced-release line to the orchestrator checklist, and the short recipe to the installed `claude` and `agents-md` text; set `GUIDANCE_VERSION` to 2. Verify: the guide tests (every `agentboard ` line parses, at most 170 lines with each role checklist, ASCII), the three "Ticket-as-mutex recipe" scenarios, the modified "Agent guide" scenarios, and the MCP `agentboard://guide` resource still equal to `help agents`
- [ ] 4.2 Extend `describeEvent` with the lease summaries and the ttl formatting rule. Verify: tests for each new summary, including `claimed (lease 90s)`, `renewed lease (2h)`, the "Forced release summary" and "Takeover summary" scenarios, and a rejected takeover producing no feed entry

## 5. Documentation (`docs/claim-leases`)

- [ ] 5.1 Document leases, renew and forced release in README.md (command reference, the mutex recipe with a merge-lock example, clock skew and multi-machine limits, the upgrade requirement for boards shared between machines), record the decisions in a new ADR (lease on the claim event, takeover decided from event timestamps with a fixed 60 second skew tolerance, forced release as a distinct kind without an allowlist), run `agentboard agents install` in this repository to move its own guidance to version 2, and update docs/STATUS.md. Verify: `make ascii`, `make validate-specs`, `agentboard agents check` reporting every target current, and running the README recipe on a temporary board (claim with a 30s ttl, kill the holder, take over after the claimable time, force-release another ticket and read the previous holder's inbox)
