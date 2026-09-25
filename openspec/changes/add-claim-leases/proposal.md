# Proposal

## Why

A downstream project (vaultfold) uses a standing agentboard ticket as a
mutex to serialise merges into its integration branch: an agent claims the
ticket before merging and releases it afterwards. This works because
`claim` is atomic (exactly one racer wins, see board-concurrency), but
nothing ever expires. A holder that crashes, is killed or simply forgets
stalls every lane waiting on the lock, and only the holder can release, so
recovery today means another actor impersonating the holder with
`--as <holder>` and running `release`. That leaves no record of who
actually broke the lock or why, and teaches agents to impersonate each
other.

Leases (a claim that stops protecting the ticket after a time to live,
unless renewed) and an audited forced release fix both problems without
changing the event-log model: they are new fields and kinds of append-only
events, folded deterministically like every other event.

## What Changes

- `claim <id> --ttl <duration>` records a lease on the `ticket.claim`
  event: its time to live and its expiry, the event's own hybrid wall time
  plus the ttl. Without `--ttl` a claim behaves exactly as today and
  writes the same bytes.
- `renew <id> --ttl <duration>` (new command, new event kind
  `ticket.renew`) lets the holder set a new expiry: the renew event's wall
  time plus the ttl. Renewing a claim without a lease gives it one.
- A ticket whose lease has expired (by more than a fixed clock skew
  tolerance of 60 seconds) is treated as unassigned for the purpose of a
  new `claim`. The new claim records, in its body, the lease it
  supersedes (previous holder, expiry, and the event that set it). The
  fold decides acceptance only from event timestamps, never from the
  local clock. Leases are advisory for claiming only: they never change a
  ticket's status, and an expired lease is not released until someone
  claims.
- `list` and `show` display the lease and its state (`live`, `expired`,
  `claimable`) computed from the local clock at read time; this is
  display only.
- `release <id> --force --reason <text>` lets an actor who is not the
  holder break the lock, recorded as a distinct event kind
  `ticket.release.force` carrying the holder it released and the reason.
  Inbox entries for it (and for a claim that superseded an expired lease)
  name the previous holder in a new `affects` field, and the human inbox
  output flags them for that holder. Forced release is not restricted to
  a configured set of actors (see design.md).
- MCP gains the same: `board_claim` takes `ttl`, `board_renew` is a new
  tool, `board_release` takes `force` and `reason`; all from the command
  registry.
- Agent guidance documents the lock pattern as a recipe, "Using a ticket
  as a mutex", in `help agents` and in the installed skill and AGENTS.md
  text (guidance version 2).

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `board-events`: `ticket.claim` body fields `lease` and `supersedes`;
  new kinds `ticket.renew` and `ticket.release.force`; lease and forced
  release fold rules; new rejection reason `holder-changed`.
- `board-cli`: `claim --ttl`, `renew`, `release --force --reason`, lease
  display, inbox `affects`, hints, the MCP tools.
- `board-cache`: lease columns in `tickets`; cache schema version bump.
- `board-concurrency`: an expired-lease claim race still has exactly one
  winner; crash recovery through lease expiry; convergence across
  replicas with skewed clocks.
- `board-agent-guidance`: the mutex recipe in the guide and in installed
  guidance.
- `board-view-model`: feed summaries for the new events.

## Non-Goals

- Automatic expiry: nothing is written when a lease runs out; the next
  claim does the takeover.
- Leases gating anything but `claim`: status moves, comments, hand-offs
  and closing ignore leases.
- Authentication or authorisation of actors (actors stay self-asserted).
- Lease controls in the web app, the TUI or `health` (a follow-up change
  can build on the ticket's `lease` field).
- A configurable skew tolerance (fixed at 60 seconds in this change).

## Impact

- `src/events/schema.ts`, `src/events/fold.ts`: new body fields and
  kinds, fold rules.
- `src/store/cache.ts`: lease columns, `CACHE_SCHEMA_VERSION` bump (the
  cache rebuilds itself on first open, cursors are dropped as today on a
  schema change and events are redelivered, never skipped).
- `src/board/tickets.ts` (claim, renew, release), `src/board/inbox.ts`
  (`affects`), `src/cli/registry.ts`, `src/cli/render.ts`,
  `src/guidance/*` (recipe, hints, `GUIDANCE_VERSION` 2),
  `src/view/*` (`describeEvent`).
- Compatibility: plain claims are unchanged. A claim with a lease, a
  renew or a forced release is not understood by agentboard versions
  without this change (they report the claim as malformed and the new
  kinds as unknown), so every machine sharing a board must upgrade before
  any actor uses `--ttl` or `--force`. Once upgraded, the preserved events
  fold correctly with no migration.
- README.md, a new ADR (claim leases and forced release), docs/STATUS.md,
  and this repository's own installed guidance (reinstalled at version 2).
- No new dependencies.
