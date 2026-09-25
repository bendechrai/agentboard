# Design

## Context

ADR 0001 makes an append-only, content-addressed event log the source of
truth, folded in a total order of (`ts.wall`, `ts.counter`, `ts.actor`,
hash). ADR 0002 runs every writing command in one `BEGIN IMMEDIATE`
transaction: catch up, validate, build the hybrid timestamp, write the
event file, apply, commit. That is what makes `claim` atomic on one
machine, and the fold's "earlier claim wins, later one is rejected
`already-assigned`" rule is what makes it converge across machines that
sync the board over git.

A claim today never ends except by `release` (holder only), `handoff` or
`assign`. vaultfold uses a standing ticket as a merge lock; a crashed
holder stalls every lane, and recovery requires impersonating the holder.
This change adds leases and a forced release while keeping the fold a
pure function of the event set.

## Goals / Non-Goals

**Goals:**
- A lease expires without anyone writing anything, and the next claimer
  takes over atomically, with exactly one winner, on one machine and
  after sync across machines.
- The fold never reads the local clock: whether a takeover is valid is
  decided from the timestamps written in the events, so every replica
  folds the same set of events to the same state.
- A clock skew between machines within a stated tolerance never lets a
  lease be taken over before it has really expired.
- Breaking someone else's lock is possible without impersonation, is
  recorded with who and why, and is surfaced to the previous holder.
- Plain claims (no `--ttl`) are byte-for-byte unchanged.

**Non-Goals:**
- Writing an event when a lease expires, or a background process.
- Leases constraining anything but `claim`.
- Authenticating actors.
- Web, TUI and `health` lease views; a configurable skew tolerance.

## Decisions

### The lease lives on the claim event
`ticket.claim` gains an optional body field `lease`:
`{ttl: <ms>, expiresAt: <ms>}`, with `expiresAt` equal to
`ts.wall + ttl`. An event where that equation does not hold, or where
`ttl` is outside the permitted range, is malformed. `expiresAt` is
redundant but written anyway so that a human reading an event file (or
`show --raw`) sees the expiry without arithmetic, and so that a
`supersedes` reference can name it.

The ticket's folded state gains `lease`: null, or
`{ttl, expiresAt, event}` where `event` is the hash of the event that set
it (the claim or the latest renew).

Alternative considered: a new kind (`ticket.lease-claim`) so that older
versions see an unknown kind instead of a malformed claim. Rejected: an
older reader would then fold the ticket as unassigned and could let a
second actor claim it, a silent divergence; a malformed claim is at least
reported. Either way mixed versions cannot share a board once leases are
used, and on upgrade the preserved events fold correctly. The envelope
`v` stays 1 because plain claims are unchanged.

### Renew
`ticket.renew` has body `{ttl, expiresAt}` with the same rule. The fold
applies it only when the event's actor is the assignee (otherwise
`not-assignee`), replacing the lease with `{ttl, expiresAt, event}`. It
sets, not extends: the new expiry is the renew's wall plus ttl, so a
retried renew does not stack. A renew after the expiry is still accepted
if no takeover has happened before it in fold order: a lease only matters
when someone else claims. Renewing a claim that has no lease gives it one.

### Takeover rule, decided from event timestamps
A claim by actor `A` on a ticket held by `H` (with `H` not `A`) is
accepted only when its body carries
`supersedes: {holder, expiresAt, event}` and, at that point in fold
order:

1. the ticket's assignee is `supersedes.holder`;
2. the ticket has a lease whose `expiresAt` and `event` equal
   `supersedes.expiresAt` and `supersedes.event`; and
3. the claim's own `ts.wall` is at least `expiresAt + LEASE_SKEW_MS`
   (60000).

Otherwise it is rejected `already-assigned`, as any claim on an assigned
ticket is today. When accepted, the assignee becomes `A` and the lease
becomes the claim's own `lease` (or none). A claim on an unassigned
ticket is accepted as today; a `supersedes` it carries is then moot and
ignored (the lease it named was released, handed off or taken over
first).

Only event fields are compared: the claim's wall time is the claimer's
hybrid timestamp, written once, identical on every replica. No replica
reads its clock during the fold, so the fold stays a pure function of the
event set, and `rebuild` stays byte-identical.

Why `supersedes` names the lease's event and expiry rather than just
"expired": it pins the takeover to the exact lease generation the
claimer observed. If the holder renewed in time (a renew whose wall is
before the expiry sorts before any valid takeover, whose wall is at
least 60 seconds after it), the lease no longer matches and the takeover
is rejected. The holder who renews before expiry therefore always keeps
the lock, whatever order the events arrive in.

### Concurrent takeovers: one winner by the existing rule
Two claimers racing for the same expired lease both write a `supersedes`
naming the same lease. On one machine, `BEGIN IMMEDIATE` serialises them:
the second one's catch-up folds the first one's claim and validation
refuses it `already-assigned`, naming the new holder. Across machines,
both events may exist; the fold applies the earlier one in fold order,
after which the assignee is no longer `supersedes.holder` for the later
one, which is rejected `already-assigned`. This is the existing "earlier
claim wins" rule, so exactly one takeover is effective on every replica.

### Command-time validation matches the fold
To validate a claim with the fold's own rule, the command needs the new
event's timestamp before validating, so for `claim`, `renew` and
`release --force` the hybrid timestamp is built (step 3 of ADR 0002)
before validation (step 2). Both run under the same write lock, so this
changes nothing observable. The command additionally requires its own
clock to say `now >= expiresAt + LEASE_SKEW_MS`, so the writer's check is
never looser than the fold's (the hybrid wall can run ahead of the local
clock after a machine with a fast clock wrote events). The command fills
`supersedes` itself from the current lease; callers never pass it.

### Clock skew tolerance
`LEASE_SKEW_MS` is a constant of 60 seconds, part of the fold rules (a
board-level setting would have to be folded too, and there is no command
to write `board.meta` yet; a later change can add one).

- One machine: every event's wall comes from one clock, made monotonic
  by the hybrid timestamp. A lease is protected for exactly its ttl plus
  60 seconds and taken over no sooner; the result is exact and
  immediate, because validation and the write happen in one transaction.
- Several machines syncing the board: if every pair of clocks differs by
  at most 60 seconds, a takeover's wall at least 60 seconds after the
  expiry was written after the real expiry, so no live lease is taken
  over early. A skew larger than the tolerance can let a machine with a
  fast clock take over up to (skew - 60 s) early; `show` of the takeover
  displays both walls so the cause is visible.
- Across machines a takeover is only known to the others after `sync`,
  and a holder's renew written before expiry but synced late still wins
  (see above), retroactively rejecting a takeover the claimer believed
  had succeeded. The guidance therefore tells multi-machine users to run
  `sync` before claiming and again before acting on the lock, and to
  renew at half the ttl. Mutual exclusion across machines is only as
  strong as sync; within one machine (every worktree of a checkout shares
  one board) it is exact.

### Display is the only place the clock is read
`list` and `show` compute a lease state from the local clock at read
time: `live` (now < expiresAt), `expired` (expiresAt <= now <
expiresAt + LEASE_SKEW_MS: expired but not yet claimable) and
`claimable`. The state and `claimableAt` appear in `--json` output only,
never in the cache or the fold, so `rebuild --check` is unaffected. In
`list`, the assignee column stays one token: `merger+9m` for a live lease
with 9 minutes left, `merger!expired` or `merger!claimable`.

### Release, hand-off and assign clear the lease
A lease belongs to a holding. `release`, `release --force`, `handoff`,
`assign` and an accepted takeover end the holding, so they clear the
lease (a takeover may set its own). `move`, `comment`, `close` and the
checklist do not touch it. A claim by the current holder stays a no-op
that writes nothing, with or without `--ttl`; it reports the current
lease and points to `renew`, so "retrying a claim is safe" still holds.

### Forced release is a distinct kind, not a flag on release
`ticket.release.force` has body `{holder, reason}`. It is applied only
when the ticket's assignee is `holder` at that point in fold order;
otherwise it is rejected with the new reason `holder-changed`. Naming the
holder pins the forced release to the holding the actor saw, so a forced
release that races a legitimate takeover or hand-off (possible across
machines) never breaks the new holder's lock. It clears assignee and
lease and leaves status unchanged. A distinct kind makes forced releases
trivially queryable (`inbox`, feeds, `--kind` filters) and keeps
`ticket.release` "the holder gave it up".

`release --force` requires `--reason` (non-empty, refused by the secret
patterns like a comment), is a usage error without it, and is a usage
error when the actor is the holder (plain `release` is the honest
record). It does not require the lease to have expired: the main use is
a claim with no lease at all, or a holder known to be dead.

### Forced release is not restricted to configured actors
Decision: any actor may force a release; there is no allowlist in this
change.

- Actors are self-asserted (`--as`, `AGENTBOARD_ACTOR`); the board never
  authenticates. An allowlist of "orchestrator" actors would be bypassed
  by `--as orchestrator`, which is the same impersonation this change
  exists to remove, and would push recovery back to it.
- There is no command that writes `board.meta`, so an allowlist would
  need a new configuration command and, to stay deterministic, fold-time
  enforcement against the setting in effect at each event's position.
  That is a lot of surface for a guard rail that is not a boundary.
- The value is the audit trail: a distinct event naming actor, previous
  holder and reason; `show` displays it; the previous holder is told in
  their inbox; the guidance says forced release is for the orchestrator
  or a human, after checking the holder is gone.

A later change can add an advisory allowlist in `board.meta` if abuse by
confused agents appears in practice.

### Inbox: telling the previous holder
Inbox entries gain `affects`: the previous holder for an applied
`ticket.release.force` (`body.holder`) and for an applied claim that took
over a lease (`body.supersedes.holder`), null for every other event. For
a forced release `note` is the reason. The human inbox output prefixes
an entry whose `affects` is the reading actor with `LOST: `, so a holder
that comes back from a stall sees immediately that it no longer holds
the lock. Delivery itself is unchanged (every effective event already
reaches every actor).

### Durations
`--ttl` takes 1 to 5 ASCII digits and a unit `s`, `m`, `h` or `d`
(`90s`, `10m`, `2h`), between 30 seconds and 7 days inclusive; anything
else is a usage error naming the form. Seconds are allowed (unlike the
`health` thresholds) because merge locks are short. The fold accepts any
integer `ttl` in the same range, so the bounds hold for events written by
any tool.

## Interfaces (sketch)

- `LEASE_SKEW_MS = 60_000`, `TTL_MIN_MS = 30_000`,
  `TTL_MAX_MS = 604_800_000` exported from the events layer.
- `Lease = {ttl: number; expiresAt: number; event: string}`; `Ticket`
  gains `lease: Lease | null`.
- `parseTtl(text: string): number | null`.
- `leaseState(lease: Lease, now: number): 'live' | 'expired' | 'claimable'`.
- `claimTicket(board, actor, {id, ttl?})`, `renewTicket(board, actor,
  {id, ttl})`, `releaseTicket(board, actor, {id, force?, reason?})`.
- `InboxEntry.affects: string | null`.

The test author's stubs are authoritative (CONTRIBUTING.md).

## Risks / Trade-offs

- [Mixed versions] An older agentboard reports lease claims as malformed
  and the new kinds as unknown. Mitigation: documented as an upgrade
  requirement; plain claims are unaffected, and preserved events fold
  correctly after the upgrade.
- [Clock skew beyond 60 s] can shorten a lease across machines.
  Mitigation: stated bound, both walls visible in `show`, single-machine
  use exact.
- [Retroactive loss after sync] A cross-machine takeover can be undone
  when an earlier renew arrives. Mitigation: the recipe (sync, renew at
  half ttl); `affects` and `LOST: ` tell the loser.
- [Cache schema bump] drops cursors, so every actor's inbox redelivers
  once. Accepted, as for every schema change (redelivery, never loss).
- [Holder keeps working after losing the lock] Leases are advisory: a
  stalled holder that wakes up is not stopped by the board. Mitigation:
  the recipe tells the holder to `renew` (which fails `not-assignee` once
  taken over) immediately before the critical step.
