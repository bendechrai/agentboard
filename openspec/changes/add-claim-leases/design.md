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
`assign`. vaultfold uses a standing ticket as a merge lock and hit four
failures: a crashed holder stalls every lane; recovery requires
impersonating the holder; a background polling loop claimed the lock for
an idle agent and held it for 41 minutes; and 60-second pollers lost
races to luckier claimers, so waiting was unfair. What worked in the end
was the orchestrator running the queue while workers reported ready and
stopped.

This change adds grace leases, a fair waiting queue, a forced release and
mutex guidance, keeping the fold a pure function of the event set.

## Goals / Non-Goals

**Goals:**
- A lock is held only by an actor that shows it is acting (liveness),
  not by any process that happened to run `claim`.
- Waiters are served in the order they joined, one at a time, with
  exactly one holder at any point of the fold, on one machine and after
  sync across machines.
- The fold never reads the local clock. Clock-driven transitions (a
  lease lapsing, a grant passing on) are decided from timestamps written
  in events, and the events that record them are derived so that every
  writer produces the same bytes.
- Clock skew within a stated tolerance never shortens a lease or a
  grantee's acceptance window.
- Breaking someone else's lock needs no impersonation and is recorded
  with who and why.
- Plain claims (no `--ttl`) are byte-for-byte unchanged.

**Non-Goals:**
- A daemon, or any background writer.
- Leases or the queue constraining anything but `claim`.
- Authenticating actors; a self-declared "foreground" flag.
- Web, TUI and `health` views of leases and queues.

## Decisions

### Leases live on the claim, and start as a grace lease
`ticket.claim` gains an optional body field `lease`:
`{ttl, grace, expiresAt}` in milliseconds, with `expiresAt` equal to
`ts.wall + min(ttl, grace)`. `ttl` is what the claimer asked for; `grace`
is the board's `lease.grace` setting (default 2 minutes) when the claim
was written, recorded so the fold never depends on when a setting event
arrived. The folded lease is `{ttl, expiresAt, event, confirmed}` where
`event` is the hash of the event that set it and `confirmed` is false
until the holder's first `renew`.

`ticket.renew` has body `{ttl, expiresAt}` with `expiresAt = ts.wall +
ttl`. The fold applies it only when its actor is the assignee (otherwise
`not-assignee`); it sets (not extends) the lease and marks it confirmed.
The CLI fills `ttl` from the lease's requested ttl when `--ttl` is not
given, so the first action of real work is simply `renew <id>`. A renew
after expiry is still accepted when nothing has taken over before it in
fold order.

An event where `expiresAt` does not match, or where `ttl` is outside 30
seconds to 7 days or `grace` outside 30 seconds to 10 minutes, is
malformed. `expiresAt` is redundant but written so a human reading the
event sees it and so `supersedes` references can name it.

Alternative considered: a new kind for leased claims, so older versions
see an unknown kind. Rejected: an older reader would fold the ticket as
unassigned and could let a second actor claim it, a silent divergence; a
malformed claim is at least reported. The envelope `v` stays 1 because
plain claims are unchanged.

### Why liveness, and why no declared "foreground" flag
The 41-minute hold came from a background loop claiming on behalf of an
idle agent. A parameter such as `--intent act-now` or `--foreground`
would not have prevented it: actors and flags are self-asserted, the
loop would pass the same flag the agent would, and the board cannot
observe which process is in the foreground. Anything the board cannot
check is documentation, not enforcement.

Liveness can be checked: an unconfirmed claim protects the ticket only
for the grace period, and only a `renew` from the holder turns it into
the requested lease. The pattern "claim, then renew as the first action
of real work" means a loop that only claims loses the lock within two
minutes, and a crashed or idle holder loses it within its ttl. A loop
written to renew as well can defeat this, which no mechanism can prevent
without authentication; the guidance forbids claiming from a background
process, and the queue removes the reason to poll at all.

Decision on `--intent act-now`: not added. It would be a second,
unenforced way to say what the grace lease already enforces, and agents
would learn to pass it by habit, making it noise in every claim.

### Takeover rule, decided from event timestamps
A claim by actor `A` on a ticket held by `H` (with `H` not `A`) and an
empty queue is accepted only when its body carries
`supersedes: {holder, expiresAt, event}` and, at that point in fold
order: the assignee is `supersedes.holder`; the ticket's lease has that
`expiresAt` and `event`; and the claim's own `ts.wall` is at least
`expiresAt + LEASE_SKEW_MS` (60000). Otherwise it is rejected
`already-assigned` (or `queued` when there are waiters, see below). The
claim's wall is the claimer's hybrid timestamp, written once and
identical on every replica, so no replica reads its clock during the
fold. `supersedes` pins the takeover to the exact lease generation the
claimer saw: a renew written before the expiry sorts before any valid
takeover (at least 60 seconds after it) and changes the lease, so a
holder who renews in time always keeps the lock, whatever order the
events arrive in. Two racing takeovers name the same lease; the earlier
in fold order applies and the later no longer matches, which is the
existing earlier-claim-wins rule.

### Command-time validation matches the fold
For `claim`, `renew`, `release --force` and the queue commands the hybrid
timestamp is built before validation (both under the same write lock, so
nothing observable changes), and validation calls the fold's own rules
with that timestamp. A takeover additionally requires the local clock to
read at least `expiresAt + LEASE_SKEW_MS`, so the writer is never looser
than the fold. The command fills `supersedes` itself.

### The waiting queue
`claim --wait` on a ticket that is held (or granted, or free with
waiters) writes `ticket.queue.join` with body `{ttl}`, the lease the
waiter will ask for. The queue is the set of applied joins not yet
granted or left, ordered by fold order of the join event, that is by
(hybrid timestamp, then hash). `ticket.queue.leave` removes the actor.
A join by the assignee or by an actor already queued, a leave by an
actor not queued, and a join on a free ticket with an empty queue (claim
it instead) are rejected `invalid-queue`.

While the queue is not empty, a plain claim or a takeover by anyone on
that ticket is rejected `queued`: waiters have priority, and the only way
the ticket passes to a new holder is a grant (or a hand-off by the
holder, which the queue does not constrain).

### Grants: derived, backdated, identical from every writer
A grant is due when the queue is not empty and the ticket has become
available at time `F`:

- released or force-released: `F` is that event's wall;
- held under a lease that lapsed (a claim not confirmed within its
  grace, a confirmed lease not renewed, or a grant not accepted):
  `F = expiresAt + LEASE_SKEW_MS`.

Its slot time is `S = max(F, J) + 1`, where `J` is the wall of the head
waiter's join. The grant is the event
`{kind: ticket.grant, actor: "agentboard", ts: {wall: S, counter: 0,
actor: "agentboard"}, body: {to, ttl, window, after}}`, where `to` and
`ttl` come from the head waiter's join, `window` is the board's
`queue.window` (default 2 minutes) in effect at that fold position, and
`after` names what made the ticket available (`{released: <hash>}` or
`{lease: {holder, expiresAt, event}}`). Applied, it assigns `to`, removes
it from the queue, and gives it an unconfirmed lease of
`{ttl, expiresAt: S + window, event: <grant hash>}`. The grantee accepts
by renewing, exactly like confirming a grace lease. If it does not, that
lease lapses and the next grant is due `window + 60 s` after `S`: the
reservation passes to the next waiter.

Every field of a grant is a function of the folded state; the clock only
decides whether it is due yet (the writer's clock reads at least `S`).
So:

- any command that catches up (every command except `rebuild` and
  `rebuild --check`, including `list`, `show`, `inbox`, `watch` and a
  waiting `claim --wait`) writes the grants that are due, in the same
  transaction as its catch-up;
- two writers on one machine are serialised by the write lock, and the
  second finds the file already present (writing identical bytes is a
  no-op); two machines write identical files, so `sync` merges them as
  one;
- the fold accepts a `ticket.grant` only when its bytes equal the grant
  it derives at that position, and rejects it `stale-grant` otherwise
  (for example when a renew or a leave from another machine, with an
  earlier wall, arrives after the grant was written);
- `agentboard` is a reserved actor: commands refuse `--as agentboard`
  and the fold treats any other kind written by it, or a grant written
  by anyone else, as malformed.

A grant's wall is in the past when it is written, which ADR 0002 does
not otherwise allow for a command's own event. It is folded exactly like
an event that arrives late through `sync`: later events are refolded and
inbox cursors move back as board-concurrency already requires. There is
at most one assignee at every fold position, so no double grant can
exist on any replica.

Alternatives considered: a reservation that is only derived state (no
event), with the waiter claiming inside its window. Rejected: a waiter
over MCP cannot block, so it needs something to arrive in its inbox, and
a passed reservation would be invisible in history. Grants written by the
releasing command only: rejected, because lapses have no writer, which
is the case that matters most.

### Waiting on the CLI, never over MCP
`claim <id> --ttl <d> --wait --timeout <d>` claims at once when the
ticket is free with an empty queue. Otherwise it joins (unless already
queued) and blocks on the watch machinery, waking on new events and at
the next due grant time so that it writes due grants itself. It exits 0
when a grant to it is applied (printing that it must renew to accept, and
by when), or, on timeout, writes `ticket.queue.leave` and exits 4
`wait-timeout`. SIGINT and SIGTERM also leave the queue. A waiter killed
with SIGKILL stays queued; its grant then lapses after one window and
passes on, which is the liveness rule doing its job. `--timeout` is
required with `--wait` on the CLI (1 second to 1 day) so an agent's
command always returns.

MCP tool calls have client timeouts, so `board_claim` with `wait` never
blocks: it returns `{queued: true, position, holder}` (or the ordinary
claim result with `queued: false` when it claimed at once), and
`timeout` is not part of the tool schema. The grant arrives through
`board_inbox` as a `ticket.grant` entry with `to` set to the grantee.

### Forced release is a distinct kind, not restricted
`ticket.release.force` has body `{holder, reason}` and applies only when
the assignee at that position is `holder` (else `holder-changed`), so a
forced release that races a takeover or grant never breaks the new
holder's lock. It clears assignee and lease, leaves status unchanged,
and, with waiters, makes a grant due. `release --force` needs a
non-empty `--reason` (refused by the secret patterns like a comment) and
is a usage error for the holder itself.

Decision: any actor may force a release; no allowlist. Actors are
self-asserted, so an allowlist of orchestrator actors would be bypassed
by `--as orchestrator`, the impersonation this change removes. The value
is the audit trail: a distinct event naming actor, previous holder and
reason, shown by `show` and delivered to the previous holder's inbox.
The guidance reserves it for the orchestrator or a human, after checking
the holder is gone. A later change can add an advisory allowlist if
confused agents misuse it.

### Board settings
`lease.grace` and `queue.window` are `board.meta` values in
milliseconds, written by a new `config set <key> <value>` (duration
form, 30 seconds to 10 minutes) and read by `config get`. The claim
records its grace in its own body; a grant reads `queue.window` as folded
at its position, which every writer computes identically. `config` is a
setup command and not an MCP tool.

### Clock skew tolerance
`LEASE_SKEW_MS` is a constant of 60 seconds in the fold rules. On one
machine every wall comes from one monotonic hybrid clock, so leases,
takeovers and grants happen exactly at the stated times, never earlier,
and validation and write are one transaction. Across machines, if clocks
differ by at most 60 seconds, a takeover or a grant after a lapse is
never written before the lease really lapsed, and each grantee gets at
least its window of real time before the grant passes on. A larger skew
can shorten either by the excess; `show` displays the walls involved.
Mutual exclusion across machines is only as strong as `sync`: a renew
written in time but synced late still wins, retroactively rejecting a
takeover or grant another machine had applied. The guidance tells
multi-machine users to sync before claiming and before the critical
step.

### Display is the only other place the clock is read
`list` and `show` compute the lease state from the local clock: `live`,
`expired` (past `expiresAt`, not yet past the tolerance) and
`claimable`, plus `grace` when unconfirmed. `show` lists the queue in
order and a pending grant (to whom, accept by when). None of this is
stored in the cache or used by the fold.

### Inbox fields
Inbox entries gain `affects`: the previous holder for a forced release,
a takeover and a grant after a lapse. A grant's `to` is its grantee. The
human inbox output prefixes an entry with `GRANTED: ` when its `to` is
the reader and the kind is `ticket.grant`, and with `LOST: ` when its
`affects` is the reader.

## Interfaces (sketch)

- Constants: `LEASE_SKEW_MS = 60_000`, `TTL_MIN_MS`, `TTL_MAX_MS`,
  `GRACE_DEFAULT_MS = 120_000`, `WINDOW_DEFAULT_MS = 120_000`,
  `SYSTEM_ACTOR = 'agentboard'`.
- `Lease = {ttl; expiresAt; event; confirmed}`; `Ticket` gains
  `lease: Lease | null` and `queue: Waiter[]` (`{actor, ttl, joined}`).
- `dueGrant(ticket, meta): GrantEvent | null` (pure; used by the fold to
  validate and by catch-up to write).
- `parseDuration`-style parsers for ttl, grace/window and timeout.
- `claimTicket(board, actor, {id, ttl?, wait?})`, `waitForGrant(...)`,
  `renewTicket`, `unqueueTicket`, `releaseTicket(board, actor, {id,
  force?, reason?})`, `setConfig`, `getConfig`.
- `InboxEntry.affects: string | null`.

The test author's stubs are authoritative (CONTRIBUTING.md).

## Risks / Trade-offs

- [Backdated grant events] break the "own event sorts last" property of
  ADR 0002 for one kind. Mitigation: they reuse the late-arrival path
  already required for sync; property tests cover refolds.
- [Read commands now write] `list`, `show` and `inbox` may write a due
  grant. Mitigation: only under the existing catch-up write lock and only
  when one is due; otherwise reads stay lock-free.
- [Nobody runs a command] a due grant is written late when no command
  runs; the grant still carries its slot time, and the grantee's window
  starts at `S`, so a grant materialised late may already be lapsed.
  Mitigation: waiters on the CLI wake at due times; over MCP the
  orchestrator runs the queue.
- [Mixed versions] older versions reject lease claims and ignore the new
  kinds. Mitigation: upgrade requirement documented.
- [Skew beyond 60 s] shortens leases or windows across machines.
  Mitigation: stated bound; single machine exact.
- [Cache schema bump] redelivers inbox entries once.
