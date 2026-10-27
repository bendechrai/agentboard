# 14. Grace leases, derived grants and an unrestricted forced release

Date: 2026-10-27

## Status

Accepted. Extends ADR 0001 and makes one exception to ADR 0002 (see
Consequences).

## Context

A downstream project used a standing agentboard ticket as a merge lock: an
agent claimed it before merging into the integration branch and released
it afterwards. `claim` is atomic, so exactly one agent held the lock, but a
claim never ended except by `release` from the holder, a hand-off or an
assign. Four failures followed:

- A holder that crashed, was killed or forgot stalled every lane waiting on
  the lock.
- Only the holder could release, so recovery meant another actor running
  `release --as <holder>`: impersonation, with no record of who broke the
  lock or why.
- An agent's background polling loop won the claim while the agent sat
  idle, and the lock was held for 41 minutes with nothing happening. A
  claim proves that some process ran `claim`, not that anyone is about to
  do the work.
- Agents polling every 60 seconds lost races to luckier pollers, so
  waiting was unfair. What finally worked was the orchestrator running the
  queue, with workers reporting ready and stopping.

The fix had to keep the model of ADR 0001: an append-only,
content-addressed event log folded in a total order of (`ts.wall`,
`ts.counter`, `ts.actor`, hash), shared between machines by `sync`, with
the fold a pure function of the event set. Expiry is a function of time,
and every machine has its own clock.

## Decision

### Grace leases and liveness, not a declared intent flag

`claim --ttl <d>` records a lease on the `ticket.claim` event, but the
lease starts as a grace lease of the board's `lease.grace` (2 minutes by
default, recorded in the claim's body so the fold never depends on when a
setting arrived). Only the holder's `renew` (a new kind, `ticket.renew`)
confirms it and sets it to the requested ttl. An unconfirmed claim lapses
after the grace period; a confirmed one lapses when its ttl runs out
without a renew. The pattern taught to agents is "claim, then renew as the
first action of real work". A `renew` by anyone but the assignee is
refused `not-assignee`, which tells a holder that lost the lock to stop.

No flag such as `--intent act-now` or `--foreground` was added. Actors and
flags are self-asserted: the polling loop would pass the same flag the
agent would, and the board cannot observe which process is in the
foreground. A flag the board cannot check is documentation, not
enforcement, and agents would learn to pass it by habit. Liveness can be
checked: only a renew from the holder keeps the lock, so a loop that only
claims loses it within the grace period, and a crashed holder loses it
within its ttl. A loop written to renew as well defeats this, which no
mechanism can prevent without authentication; the guidance forbids
claiming from a background process, and the queue removes the reason to
poll.

### Takeover and grants decided from event timestamps, with a fixed 60 second tolerance

The fold never reads a clock. A claim on a ticket held by another actor,
with nobody waiting, is a takeover, accepted only when it names the lease
it supersedes (`supersedes: {holder, expiresAt, event}`), that lease is
still the ticket's lease at that position in fold order, and the claim's
own `ts.wall` is at least `expiresAt + LEASE_SKEW_MS`, a constant of
60000. A renew written before the expiry sorts before any valid takeover
and changes the lease, so a holder that renews in time keeps the lock
whatever order the events arrive in; of two racing takeovers, the first in
fold order applies and the second no longer names the current lease. The
command additionally requires its local clock to have reached the same
time, so a writer is never looser than the fold, and requires `--ttl` on a
takeover, so a hold taken over always lapses too.

On one machine every wall comes from one hybrid clock, so leases,
takeovers and grants happen exactly at the stated times. Across machines
whose clocks differ by at most 60 seconds, a takeover or a grant after a
lapse is never written before the lease really lapsed, and a grantee gets
at least its window of real time. The tolerance is fixed, not a setting:
a value that differed between machines would make them fold the same
events differently.

### Derived, backdated grant events written by the reserved actor

Waiters join a queue (`ticket.queue.join`, left with `ticket.queue.leave`),
ordered by the fold order of their joins. When the ticket becomes
available at time `F` (the wall of a release or forced release, or
`expiresAt + 60000` for a lapsed lease or an unaccepted grant), the head
waiter is due a grant with slot time `S = max(F, J) + 1`, where `J` is the
wall of its join. The grant is the event `ticket.grant` with actor
`agentboard`, timestamp `{wall: S, counter: 0, actor: "agentboard"}` and
body `{to, ttl, window, after}`, every field a function of the folded
state. Applied, it makes the waiter the holder under an unconfirmed lease
of the board's `queue.window`; the waiter accepts by renewing, and
otherwise the grant lapses and the next one is due.

There is no daemon. Every command that catches up (all but `rebuild`)
writes the grants whose slot time its clock has reached, in its catch-up
transaction. Because the bytes are derived, every writer on every machine
writes the identical file, and duplicates collapse by content address. The
fold accepts a grant only when it equals, field by field, the grant it
derives at that position, and rejects it `stale-grant` otherwise (for
example when a renew or leave with an earlier wall arrives later through
`sync`). The actor `agentboard` is reserved: commands refuse `--as
agentboard`, any other kind written by it is malformed, and so is a grant
written by anyone else.

### Forced release is a distinct kind, with no allowlist

`release --force --reason <text>` writes `ticket.release.force` with body
`{holder, reason}`, applied only when `holder` is still the assignee at
that position (else `holder-changed`), so a forced release racing a
takeover or a grant never breaks the new holder's lock. It is shown by
`show` and delivered to the previous holder's inbox with `affects` set to
that holder.

Any actor may force a release. Actors are self-asserted, so an allowlist
of orchestrator actors would be bypassed by `--as orchestrator`, which is
the impersonation this replaces. The value is the audit trail: a distinct
event naming who broke the lock, whose lock it was and why. The guidance
reserves it for the orchestrator or a human, after checking the holder is
gone.

## Rationale

Every clock-driven transition is decided from timestamps written once, in
events every replica holds, so the fold stays a pure function of the event
set and replicas converge after `sync`. The clock is read only to decide
whether something may be written yet (a takeover, a due grant) and to
display a lease's state, never to decide what an event means.

Writing grants as events, rather than leaving a reservation as derived
state, gives a waiter over MCP, which cannot block, something to receive in
its inbox, and leaves a passed reservation visible in history. Deriving
them, rather than having the releasing command write them, covers lapses,
which have no writer and are the case that matters most.

## Consequences

- ADR 0002's "a command's own event sorts last" no longer holds for
  grants: a grant's wall is its slot time, usually in the past when it is
  written. It is folded like an event arriving late through `sync`: later
  events are refolded and inbox cursors move back. A grant written late by
  a command that ran long after the slot may already have lapsed; the
  next grant then follows at once. A refused command still commits its
  catch-up, grants included.
- Read commands (`list`, `show`, `inbox`, `watch`) may write: they take
  the write lock, and write a grant, only when one is due. The cache keeps
  a grant watermark (the slot time of the next grant), so a warm read with
  nothing due opens no event file.
- Mutual exclusion across machines is only as strong as `sync`. A renew
  written in time but synced late still wins and retroactively rejects a
  takeover or grant another machine applied meanwhile; and a release
  synced late with an earlier wall can overturn a waiter's leave, granting
  the ticket to a waiter that has gone, which then lapses and passes on.
  Skew beyond 60 seconds can shorten a lease or a window by the excess.
  The guidance says to sync before claiming and before the critical step.
- Versions without this decision report a leased claim as malformed and
  the new kinds as unknown, so on such a machine a leased ticket looks
  unassigned. Every machine sharing a board must upgrade before anyone
  uses leases, the queue, forced release or board settings; the preserved
  events then fold correctly with no migration. Plain claims are
  byte-for-byte unchanged.
- Leases and the queue constrain only `claim`; they never change a
  ticket's status. A forced release is an easy path, accepted because it
  is visible, with its actor and reason, wherever the ticket is shown.

## Alternatives considered

**A declared intent flag (`--intent act-now`, `--foreground`).** Not
checkable, so not enforcement; it would become noise in every claim.
Rejected in favour of liveness through renew.

**A new kind for leased claims,** so older versions see an unknown kind.
An older reader would then fold the ticket as unassigned and let a second
actor claim it, a silent divergence; a malformed claim is at least
reported. Rejected.

**Deciding expiry from the local clock in the fold.** Replicas with
different clocks, or the same replica at different times, would fold the
same events differently. Rejected.

**A configurable skew tolerance.** Machines with different values would
diverge. Rejected; fixed at 60 seconds.

**A reservation that is only derived state,** with the waiter claiming
inside its window. A waiter over MCP cannot block, so it needs something
to arrive in its inbox, and a passed reservation would be invisible in
history. Rejected.

**Grants written only by the releasing command.** A lapse has no writer.
Rejected.

**A daemon that writes grants and expiries.** Contradicts a local, offline
board with no background process. Rejected; waiters on the CLI wake at due
times, and over MCP the orchestrator runs the queue.

**An allowlist for forced release.** Bypassed by `--as`, and it would
reintroduce the impersonation it was meant to remove. Rejected; a later
change may add an advisory allowlist if agents misuse the command.
