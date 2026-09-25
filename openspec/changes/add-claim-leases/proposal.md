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

Real use in vaultfold showed three more problems:

- An agent's background polling loop won the mutex claim while the agent
  itself sat idle, so the merge lock was held for 41 minutes with nothing
  happening. A claim proves only that some process ran `claim`, not that
  anyone is about to do the work.
- Agents polling every 60 seconds repeatedly lost races to other
  claimers, so waiting was unfair: whoever polled at the right moment won,
  not whoever had waited longest.
- What finally worked was the orchestrator running the queue, with
  workers reporting "ready" and stopping instead of waiting in a loop.

Leases that must be confirmed by the holder, a fair waiting queue decided
by the fold, an audited forced release, and guidance for the mutex
pattern fix these without changing the event-log model: they are new
fields and kinds of append-only events, folded deterministically like
every other event.

## What Changes

- `claim <id> --ttl <duration>` records a lease on the `ticket.claim`
  event, but the lease starts as a short grace lease (the board's
  `lease.grace`, default 2 minutes). It extends to the requested ttl only
  when the holder runs `renew` (the first renew confirms the lease). An
  unconfirmed claim therefore lapses after the grace period. The pattern:
  claim, then renew as the first action of real work. Without `--ttl` a
  claim behaves exactly as today and writes the same bytes.
- `renew <id> [--ttl <duration>]` (new command, new event kind
  `ticket.renew`) lets the holder confirm the lease or set a new expiry.
- A lease that has expired (by more than a fixed clock skew tolerance of
  60 seconds) can be taken over: the new claim records the lease it
  supersedes. The fold decides this from event timestamps only, never
  from the local clock. Leases are advisory for claiming only; they never
  change a ticket's status.
- A fair waiting queue: `claim <id> --ttl <d> --wait` on a held ticket
  records a `ticket.queue.join` event; waiters are ordered by their join
  events in fold order. When the ticket is released, force-released, or
  its lease lapses, the ticket is granted to the head waiter by a
  `ticket.grant` event with a grace lease of the board's `queue.window`
  (default 2 minutes); the grantee accepts by renewing. If it does not,
  the grant passes to the next waiter. Grant events are derived from the
  log and the clock deterministically, carry the reserved actor
  `agentboard`, and are byte-identical whoever writes them, so every
  replica agrees and duplicates collapse by content address.
- On the CLI, `claim --wait --timeout <d>` blocks in the foreground (on
  the watch machinery) until granted or timed out, so an agent waits with
  one command and no loop. `unqueue <id>` leaves the queue. Over MCP,
  `board_claim` with `wait` never blocks: it returns `{queued, position}`
  and the grant arrives through `board_inbox` as a `ticket.grant` entry.
- `release <id> --force --reason <text>` lets an actor who is not the
  holder break the lock, recorded as a distinct event kind
  `ticket.release.force` with the holder it released and the reason,
  surfaced to that holder in their inbox. It is not restricted to a
  configured set of actors (see design.md).
- `config set <key> <value>` and `config get [<key>]` write and read the
  board settings `lease.grace` and `queue.window` (as `board.meta`
  events).
- `list` and `show` display the lease (grace or confirmed, and its state
  at read time), the queue order and any pending grant.
- Agent guidance (help agents, role checklists, the installed skill and
  AGENTS.md text, and the MCP instructions) gains a mutex ticket recipe:
  workers never wait on a mutex in a loop and never claim from a
  background process; they either `claim --wait --timeout` in the
  foreground or report ready and stop; the orchestrator runs the queue
  for merge-style mutexes when agents cannot block, and handles stale
  holds with leases and forced release.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `board-events`: `ticket.claim` body fields `lease` and `supersedes`;
  new kinds `ticket.renew`, `ticket.release.force`, `ticket.queue.join`,
  `ticket.queue.leave` and `ticket.grant`; the reserved actor
  `agentboard`; grace leases, the queue and grant fold rules; the
  settings `lease.grace` and `queue.window`; new rejection reasons.
- `board-cli`: `claim --ttl/--wait/--timeout`, `renew`, `unqueue`,
  `release --force --reason`, `config`, lease and queue display, inbox
  fields, hints, the MCP tools.
- `board-cache`: lease and queue state in the cache; grant
  materialisation during catch-up; cache schema version bump.
- `board-concurrency`: one winner for expired-lease races, fair and
  single grants under concurrency and across skewed replicas, crash
  recovery.
- `board-agent-guidance`: the mutex ticket recipe in the guide, the role
  checklists, installed guidance and the MCP instructions.
- `board-view-model`: feed summaries for the new events.

## Non-Goals

- A daemon or background process: grants are written by whichever
  command next runs on the board once they are due (including a waiting
  `claim --wait`, `inbox` and `watch`).
- Leases or the queue gating anything but `claim`.
- Authentication of actors, or a self-declared "foreground" flag (see
  design.md).
- Lease and queue controls in the web app, the TUI or `health`.
- A configurable skew tolerance (fixed at 60 seconds).

## Impact

- `src/events/schema.ts`, `src/events/fold.ts`: new body fields and
  kinds, fold rules, grant derivation shared by the fold and the writer.
- `src/store/*`: lease and queue columns, `CACHE_SCHEMA_VERSION` bump,
  grant materialisation in catch-up (a backdated event folded like a late
  sync arrival).
- `src/board/*` (claim, renew, unqueue, release, config, inbox fields,
  wait on the watch machinery), `src/cli/registry.ts`,
  `src/cli/render.ts`, `src/mcp/*`, `src/guidance/*` (recipe, hints,
  `GUIDANCE_VERSION` 2), `src/view/*` (`describeEvent`).
- Compatibility: plain claims are unchanged. Leased claims, the new
  kinds and the `agentboard` actor are not understood by versions without
  this change (they report the claim as malformed and the new kinds as
  unknown), so every machine sharing a board must upgrade before any
  actor uses `--ttl`, `--wait`, `--force` or `config set`. Once upgraded,
  the preserved events fold correctly with no migration.
- README.md, a new ADR, docs/STATUS.md, and this repository's own
  installed guidance (reinstalled at version 2).
- No new dependencies.
