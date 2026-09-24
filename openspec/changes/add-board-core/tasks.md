# Tasks

Every group is delivered by a test author, an implementer and a reviewer in
turn (see CONTRIBUTING.md). Verification for every task includes `make check`
passing with vitest coverage at or above 90 percent for the package.
One branch per group, named `<area>/<group-slug>` and cut from
`origin/staging`; the test author's first commit defines the group's
exported API as stubs; a group is done when its tasks are ticked, the
branch is reviewed and merged, and its decisions are in a spec delta or ADR.

## 1. Events, canonical JSON and fold (pure, no IO)

- [x] 1.1 Implement `src/events/canonical.ts` (sorted-key canonical JSON encode, decode with strict rejection of floats and duplicate keys) and verify with tests that two objects with different key insertion order produce identical bytes and that a float is rejected
- [x] 1.2 Implement `src/events/ulid.ts` (encode, monotonic generator, parse and validate) and verify with tests against two published ULID example values and a 10,000-iteration monotonicity check
- [x] 1.3 Implement `src/events/schema.ts` (event envelope and kind bodies as TypeScript types, the source-neutral task reference with its `<source>:<ref>#<item>` text form, plus a validator returning malformed reasons) and verify with table tests for every kind, one malformed case per required field, extra-field rejection, task and adhoc both present, a task reference from a source other than openspec, and a malformed source
- [x] 1.4 Implement `src/events/hlc.ts` (hybrid timestamp next-value and compare) and verify with tests for the clock-moved-backwards case and total-order property over random inputs
- [x] 1.5 Implement `src/events/fold.ts` (deterministic ordering by (wall, counter, actor, hash); fold to ticket state; rejection reasons unknown-ticket, duplicate-create, invalid-transition, already-assigned, not-assignee, checklist-index, needs-task-link; unknown kinds preserved in the report) and verify with tests for every rejection reason, the blocked-remembers-origin rule, handoff's three effects, version and updated_at counting, and a property test that folding the same event set in shuffled orders yields identical canonical state

## 2. Store: discovery, atomic writes, cache, rebuild

- [x] 2.1 Implement `src/store/locate.ts` (AGENTBOARD_DIR, then git common dir parent, then ./.board) and verify with tests using temporary git repositories including a linked worktree and a non-git directory
- [x] 2.2 Implement `src/store/eventfile.ts` (atomic temp-write, fsync, rename to SHA-256 name; dedupe; listing that ignores `.tmp-` names; corrupt-name detection on read; stale temp reaping) and verify with tests for dedupe, corrupt detection and temp reaping
- [x] 2.3 Implement `src/store/cache.ts` (open with WAL, busy_timeout 5000, foreign keys; schema from board-cache; catch-up fold of unrecorded files; apply-event to rows; canonical dump for comparison) and verify with tests that a deleted cache is rebuilt transparently and that the canonical dump of two rebuilds is identical
- [x] 2.4 Implement `src/store/transaction.ts` (the single BEGIN IMMEDIATE command transaction: catch-up, validate, build event, write file, apply rows, record folded, commit) and verify with tests that a validation failure writes no file and changes no rows
- [x] 2.5 Implement `rebuild` and `rebuild --check` and verify with tests that a hand-edited cache is detected and left unchanged by `--check`

## 3. CLI core commands

- [x] 3.1 Implement the command registry (`src/cli/registry.ts`: every command's arguments, flags, summary and writing flag, defined once) and the argument parser driven by it, actor resolution (`--as` or AGENTBOARD_ACTOR), `--json` plumbing, exit code mapping and `version`, and verify with tests that a missing actor exits 1 and that every command's `--json` stdout parses as one document
- [x] 3.2 Implement `init`, `new`, `show` (including `--raw`) and `list` with filters and prefix id resolution, and verify with tests for idempotent init, host gitignore update, ambiguous-prefix refusal, closed-ticket exclusion, each filter, `--task` parsing and malformed-reference refusal, and `--change --group` producing the same task reference as `--task openspec:<name>#<n>`
- [x] 3.3 Implement `claim`, `release`, `move`, `comment`, `handoff`, `link`, `checklist tick/untick` and verify with tests for every state machine transition (allowed and refused), claim on assigned, release by non-assignee, handoff atomicity and the tasks.md reminder on tick
- [x] 3.4 Implement `close` with the decision disposition rule, the missing-path check and the DECISION: comment guard, and verify with tests for each refusal and for a successful close from merged and from blocked
- [x] 3.5 Implement secret-pattern refusal for `new`, `comment` and `handoff` and verify with tests for each pattern name and the `--allow-secret-like` bypass, asserting the matched text is never echoed
- [x] 3.6 Implement the `mcp` placeholder that exits 1 with the not-implemented message and verify with a test

## 4. Concurrency and crash properties

- [x] 4.1 Add a test harness that builds the CLI once and spawns it as child processes against a temporary board, and verify it can run 20 processes concurrently on macOS and Linux within the vitest timeout
- [x] 4.2 Ten concurrent `claim` processes on one ticket: verify exactly one exits 0, nine exit 4 naming the winner, `show` reports one assignee, and `rebuild --check` reports no divergence
- [x] 4.3 Twenty concurrent `comment` processes: verify all twenty comments are present in deterministic order and `rebuild --check` reports no divergence
- [x] 4.4 Crash injection: with an environment variable that makes the CLI pause after rename and after temp-write, kill the child with SIGKILL at each point and verify the next command recovers (event folded in the first case; temp reaped and ticket unchanged in the second)
- [x] 4.5 Busy-timeout behaviour: verify two writers within the same millisecond both succeed and neither reports a locked database

## 5. Inbox and watch

- [x] 5.1 Implement cursors (position plus bounded seen set) and `inbox` with `--since` and `--peek` and verify with tests that a late-arriving event with an earlier timestamp is delivered, that peek does not advance, and that a second call returns nothing new
- [x] 5.2 Implement `watch` with `fs.watch` plus a 2 second polling fallback and verify with a test that an event written by another process appears on the watcher's stdout within 3 seconds and that watch does not advance the cursor

## 6. Sync

- [x] 6.1 Implement `sync` (add, commit if needed, pull --rebase, push; no-remote path; exit 3 on any conflict or other problem that needs a human; warning if the host repo tracks `.board`) and verify with tests using two clones of a bare temporary remote that divergent add-only events converge to identical rebuilt caches
- [x] 6.2 Verify with a test that `cache.sqlite` and its WAL and SHM files are never committed by `sync`

## 7. OpenSpec integration

- [x] 7.1 Implement `import-change <name>` (locate the OpenSpec root, parse numbered groups and checkbox lines, one ticket per group with labels and checklist, fully ticked groups as merged) and verify with tests against a fixture tasks file and an idempotency test that a second import writes no events
- [x] 7.2 Implement the tickets-reference-tasks rule (`--task`, `--change/--group` or `--adhoc <reason>`; ad hoc tickets cannot enter `implementing` without a task link) and the source adapter interface with the `openspec` adapter, and verify with tests for both refusals, a ticket from a source with no adapter being fully usable, and `import-change` naming the unsupported source
- [x] 7.3 Implement `close-merged` (gh-backed PR merge state, closes with the right disposition, lists unmerged) and verify with tests that stub the gh invocation for merged, unmerged and gh-missing cases

## 8. Documentation and consumer setup

- [ ] 8.1 Write README.md usage covering init, the orchestrator inbox protocol, the role columns, the decision-promotion rule, import-change, sync between machines, and what the board is not (a secret store), and verify with `make ascii` and by following the README on a fresh temporary project end to end
- [ ] 8.2 Add docs/adr/0002-one-transaction-per-command.md and docs/adr/0003-cursors-as-position-plus-seen-set.md recording the design decisions above, and verify the ADR index lists them
- [ ] 8.3 Add a "Using agentboard in a project" section to CONTRIBUTING.md (gitignore entry, `make hooks` unaffected, `agentboard init`, `import-change` on every new OpenSpec change) and verify with `make check`

## 9. MCP server

- [ ] 9.1 Add the official MCP TypeScript SDK with `npm install`, and implement tool definitions generated from the command registry (names, input schemas, exclusions) and verify with a test that the listed tools are exactly the set in the board-cli spec and that each schema's required fields match the registry
- [ ] 9.2 Implement `agentboard mcp` over stdio (board discovery at start-up, actor from `as` or `AGENTBOARD_ACTOR`, success as structured JSON, failures as tool errors with exitCode, reason and message) replacing the 3.6 placeholder, and verify with tests that spawn the server as a child process and round-trip `new`, `claim`, `handoff` and `show`, that an `already-assigned` claim returns the mapped tool error and writes no event, and that start-up with no board exits 2
- [ ] 9.3 Verify with a test that a claim race between one MCP client and one CLI process on the same ticket has exactly one winner and `rebuild --check` reports no divergence
