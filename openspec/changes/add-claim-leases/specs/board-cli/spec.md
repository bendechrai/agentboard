## MODIFIED Requirements

### Requirement: Claim, release and handoff
`claim` SHALL assign the ticket to the actor only if it is unassigned with
no waiters, or if it is held by another actor under a lease that is
claimable and has no waiters (see "Leases on the command line"), and SHALL
exit 4 with reason `already-assigned` otherwise (or `queued` when the
ticket has waiters), naming the current assignee and, when the ticket has
a lease, its expiry and the time from which it can be claimed; a `claim`
by the current assignee SHALL exit 0, write no event (with or without
`--ttl` or `--wait`) and report that the actor already holds the ticket
and its current lease, so a retried claim is safe. `release` SHALL clear
the assignment only when the actor is the assignee, except with `--force`
(see "Forced release on the command line"). `handoff` SHALL, in one event,
set the assignee to `--to`, set the
status to `--status` (subject to the state machine), and add the note as a
comment attributed to the actor. Every command SHALL refuse the actor
`agentboard` with exit 1 and reason `usage`.

#### Scenario: Handoff to reviewer
- **WHEN** the implementer runs `handoff T1 --as impl --to reviewer --status review --note "green, 96%"`
- **THEN** T1 is assigned to `reviewer`, in status `review`, with a comment "green, 96%" by `impl`, and `show T1` lists one new event

#### Scenario: Handoff with an invalid status writes nothing
- **WHEN** `handoff` names a status the state machine does not permit from the current one
- **THEN** no event is written and the command exits 4

#### Scenario: Refusal names the lease
- **WHEN** `merger-1` holds T1 with a live lease and `claim T1 --as merger-2` runs
- **THEN** the command exits 4 with reason `already-assigned`, and the message names `merger-1`, the lease expiry and the time from which T1 can be claimed

#### Scenario: Reserved actor
- **WHEN** `comment T1 --as agentboard "x"` runs
- **THEN** it exits 1 with reason `usage` and writes nothing

## ADDED Requirements

### Requirement: Leases on the command line
`claim <id> --as <actor> [--ttl <duration>]` SHALL write, with `--ttl`, a
`ticket.claim` whose `lease` has that ttl, the board's `lease.grace` as
`grace`, and an `expiresAt` equal to the event's `ts.wall` plus the smaller
of the two. `renew <id> --as <actor> [--ttl <duration>]` SHALL write a
`ticket.renew` with the given ttl, or the lease's requested ttl when
`--ttl` is omitted, and an `expiresAt` equal to its `ts.wall` plus that
ttl, only when the actor is the assignee; otherwise it SHALL exit 4 with
reason `not-assignee`. `renew` without `--ttl` on a ticket with no lease
SHALL exit 1 with reason `usage`. A ttl SHALL be 1 to 5 ASCII digits
followed by `s`, `m`, `h` or `d`, between 30 seconds and 7 days
inclusive; any other value SHALL exit 1 with reason `usage` naming the
form. The command SHALL build the event's hybrid timestamp before
validating, inside the same transaction, and SHALL validate with the
fold's rules against that timestamp. A claim on a ticket held by another
actor with no waiters SHALL be written as a takeover, with `supersedes`
filled from the current lease, only when the new event's `ts.wall` and the
local clock both read at least the lease's `expiresAt` plus 60000;
otherwise it SHALL be refused without writing. Callers SHALL NOT supply
`supersedes`. A successful `claim --ttl` SHALL print that the lease must
be confirmed with `agentboard renew <id>` before the grace period ends,
and when.

`show` SHALL display a ticket's lease (expiry as an ISO 8601 UTC time,
requested ttl, `grace` while unconfirmed, and state), its queue in order
with each waiter's join time, a pending or applied grant (to whom and the
time by which it must be accepted), and for a takeover both the previous
holder's expiry and the takeover's wall time. The lease state SHALL be
computed from the local clock at read time: `live` before `expiresAt`,
`expired` from `expiresAt` until `expiresAt` plus 60000, and `claimable`
from then on. In `--json` output the ticket SHALL carry `lease`: null, or
`{ttl, expiresAt, event, confirmed, state, claimableAt}`, and `queue`: an
array of `{actor, ttl, joined}` in order. In `list`, the assignee column
SHALL stay one token: the actor, then `*` when the lease is unconfirmed,
then `+<remaining>` for a live lease or `!expired` or `!claimable`, then
`^<n>` when `n` actors are waiting (for example `merger-1*+2m^3`). The
state SHALL never be stored in the cache.

#### Scenario: Claim with a lease starts in grace
- **WHEN** `claim T1 --as merger-1 --ttl 30m` runs on an unassigned ticket on a board with the default grace
- **THEN** it exits 0, the claim's lease is `{ttl: 1800000, grace: 120000, expiresAt: <ts.wall + 120000>}`, `list` shows `merger-1*+2m`, and the output names `agentboard renew`

#### Scenario: Renew confirms with the requested ttl
- **WHEN** `merger-1` holds T1 under an unconfirmed lease with ttl 30m and runs `renew T1 --as merger-1`
- **THEN** it exits 0, the renew's ttl is 1800000, and `list` shows `merger-1+30m`

#### Scenario: Takeover of a claimable lease
- **WHEN** `merger-1` claimed T1 with `--ttl 30m` and never renewed, 181 seconds have passed, the queue is empty and `claim T1 --as merger-2` runs
- **THEN** it exits 0, T1 is assigned to `merger-2`, and the claim's `supersedes` names `merger-1`, the grace expiry and the claim that set it

#### Scenario: Expired but not yet claimable
- **WHEN** a lease expired 20 seconds ago and another actor runs `claim`
- **THEN** it exits 4 with reason `already-assigned`, no event is written, and `list` shows `<holder>!expired`

#### Scenario: Renew by someone else
- **WHEN** `merger-2` runs `renew T1` on a ticket held by `merger-1`
- **THEN** it exits 4 with reason `not-assignee` and no event is written

#### Scenario: Malformed ttl
- **WHEN** `claim T1 --as a --ttl 10min` or `claim T1 --as a --ttl 5s` runs
- **THEN** the command exits 1 with reason `usage` naming the duration form and the 30s to 7d range

### Requirement: Waiting on the command line
`claim <id> --as <actor> --ttl <duration> --wait --timeout <duration>`
SHALL claim at once, as `claim --ttl`, when the ticket is unassigned with
no waiters. Otherwise it SHALL write a `ticket.queue.join` with the ttl
(unless the actor is already queued), print the actor's position, and
block in the foreground on the watch machinery, waking on new events and
at the next time a grant is due so that it writes due grants itself,
until a grant to the actor is applied; it SHALL then exit 0, printing
that the actor must run `agentboard renew <id>` to accept and by when.
When the timeout passes first it SHALL write `ticket.queue.leave` and
exit 4 with reason `wait-timeout`; on SIGINT or SIGTERM it SHALL write
`ticket.queue.leave` and exit with the watch command's signal behaviour.
When its join is rejected because the ticket became free with no waiters,
it SHALL claim instead. `--wait` SHALL require `--ttl` and, on the CLI,
`--timeout` (1 to 5 digits and `s`, `m`, `h` or `d`, at most 1 day);
otherwise it SHALL exit 1 with reason `usage`. `unqueue <id> --as
<actor>` SHALL write `ticket.queue.leave`, and SHALL exit 4 with reason
`invalid-queue` when the actor is not queued.

#### Scenario: Waiter is granted on release
- **WHEN** `merger-1` holds T1, `claim T1 --as merger-2 --ttl 30m --wait --timeout 10m` is blocking, and `merger-1` runs `release T1`
- **THEN** the waiting command writes or observes the grant to `merger-2`, exits 0 within 3 seconds of the release, and names `agentboard renew T1`

#### Scenario: Wait times out
- **WHEN** a waiter's `--timeout 30s` passes (on the fake clock) with the holder still holding T1
- **THEN** the command writes `ticket.queue.leave`, exits 4 with reason `wait-timeout`, and `show T1` no longer lists it in the queue

#### Scenario: Wait needs a timeout on the CLI
- **WHEN** `claim T1 --as a --ttl 30m --wait` runs without `--timeout`
- **THEN** it exits 1 with reason `usage` and writes nothing

#### Scenario: Leave the queue
- **WHEN** `merger-3` is queued on T1 and runs `unqueue T1 --as merger-3`
- **THEN** it exits 0 and `show T1` no longer lists `merger-3`

### Requirement: Forced release on the command line
`release <id> --as <actor> --force --reason <text>` SHALL write a
`ticket.release.force` naming the current assignee as `holder` and the
reason, when the ticket is assigned to an actor other than the caller.
`--force` without a non-empty `--reason`, `--reason` without `--force`,
and `--force` by the assignee itself SHALL exit 1 with reason `usage`
and write nothing. `--force` on an unassigned ticket SHALL exit 4 with
reason `not-assignee`. The reason SHALL be refused like comment text when
it matches a secret pattern (see "No secrets on the board"). Forced
release SHALL NOT be restricted to a configured set of actors. `show`
SHALL display a forced release with its actor, the previous holder and the
reason.

#### Scenario: Orchestrator breaks a stale lock
- **WHEN** `merger-1` holds T1 and `release T1 --as orchestrator --force --reason "merger-1 crashed"` runs
- **THEN** it exits 0, T1 has no assignee (or, with waiters, a grant to the head waiter is due), and the event is a `ticket.release.force` with actor `orchestrator`, holder `merger-1` and that reason

#### Scenario: Force without a reason
- **WHEN** `release T1 --as orchestrator --force` runs
- **THEN** it exits 1 with reason `usage` and no event is written

#### Scenario: Force by the holder
- **WHEN** `merger-1` holds T1 and runs `release T1 --as merger-1 --force --reason x`
- **THEN** it exits 1 with reason `usage` and names plain `release`

### Requirement: Board settings command
`config set <key> <value> --as <actor>` SHALL write a `board.meta` event
for the keys `lease.grace` and `queue.window`, with the value given as a
duration (1 to 5 digits and `s` or `m`, between 30 seconds and 10
minutes) and stored in milliseconds; any other key or value SHALL exit 1
with reason `usage`. `config get [<key>]` SHALL print the effective value
of one or both keys, marking defaults. `config` SHALL NOT be an MCP tool.

#### Scenario: Set the acceptance window
- **WHEN** `config set queue.window 5m --as orchestrator` runs
- **THEN** a `board.meta` event with key `queue.window` and value 300000 is written, and `config get queue.window` prints `5m`

#### Scenario: Unknown key
- **WHEN** `config set columns x --as orchestrator` runs
- **THEN** it exits 1 with reason `usage` listing the two keys

### Requirement: Due grants are written during catch-up
Every command that catches up (every command except `rebuild` and
`rebuild --check`) SHALL, within its catch-up and under the write lock,
write each grant that is due (its slot time at or before the local clock)
and not yet present, exactly as the fold derives it, and fold it like a
late-arriving event. A read-only command SHALL take the write lock only
when there is something to fold, reap or grant.

#### Scenario: Inbox writes the due grant
- **WHEN** `merger-1` released T1 with `merger-2` queued, no other command has run, and `inbox --as merger-2` runs
- **THEN** the grant to `merger-2` is written and returned in that inbox call

#### Scenario: Grant written late is still exact
- **WHEN** no command runs for ten minutes after a release with a window of 2 minutes and waiters `a` and `b`
- **THEN** the next command writes the grant to `a` at its original slot time and then the grant to `b` after `a`'s lapse, and `rebuild` on another clone of the same events produces identical state

### Requirement: Lease and queue events in the inbox
Inbox entries (and `watch --json` lines) SHALL carry `affects`: the
previous holder for an applied `ticket.release.force` (its `holder`), for
an applied claim that took over a lease (its `supersedes.holder`) and for
an applied grant after a lapse (its `after.lease.holder`), and null for
every other event. For `ticket.grant` the entry's `to` SHALL be the
grantee, and for `ticket.release.force` its `note` SHALL be the reason.
Human inbox output SHALL begin an entry's line with `GRANTED: ` when it is
a grant to the reading actor, and with `LOST: ` when its `affects` equals
the reading actor.

#### Scenario: Previous holder is told
- **WHEN** `orchestrator` force-releases T1 from `merger-1` with reason `stalled` and `inbox --as merger-1` runs
- **THEN** the entry has `affects` `merger-1` and `note` `stalled`, and the human line begins with `LOST: `

#### Scenario: Grantee is told
- **WHEN** T1 is granted to `merger-2` and `inbox --as merger-2` runs
- **THEN** the entry is a `ticket.grant` with `to` `merger-2` and the human line begins with `GRANTED: `

### Requirement: Lease and queue hints
The `already-assigned` hint on a ticket with a lease SHALL name the time
from which it can be claimed and `agentboard claim <id> --ttl <duration>
--wait --timeout <duration> --as <actor>`. The `queued` hint SHALL name
the same `--wait` form. The `holder-changed`, `invalid-queue` and
`stale-grant` reasons SHALL hint `agentboard show <id>`. `not-assignee`
from `renew` SHALL hint `agentboard show <id>` and say the lock was lost.
`wait-timeout` SHALL hint `agentboard inbox --as <actor>`.

#### Scenario: Hint for a live lease
- **WHEN** `claim T1 --as merger-2` is refused because `merger-1` holds a live lease
- **THEN** stderr has a `hint: ` line naming the claimable time and `--wait`

### Requirement: Lease and queue tools over MCP
The command registry SHALL define `renew`, `unqueue` and the `--ttl`,
`--wait`, `--timeout`, `--force` and `--reason` flags, so that
`agentboard mcp` lists `board_renew` and `board_unqueue`, `board_claim`
gains optional `ttl` and `wait` and `board_release` gains optional `force`
and `reason`, validated as on the CLI. `--timeout` SHALL be a CLI-only
flag, absent from the tool schema. `board_claim` with `wait` SHALL never
block: when the ticket is claimable at once it SHALL return the ordinary
claim result with `queued` false; otherwise it SHALL write the join and
return `{queued: true, position, holder, ticket}` at once. The grant SHALL
be delivered only through `board_inbox` as a `ticket.grant` entry.

#### Scenario: MCP tool list includes renew and unqueue
- **WHEN** an MCP client lists tools
- **THEN** `board_renew` and `board_unqueue` are listed, `board_claim` has optional `ttl` and `wait` and no `timeout`, and `board_release` has optional `force` and `reason`

#### Scenario: MCP wait returns at once
- **WHEN** `board_claim` is called with `wait` true and `ttl` `30m` on a ticket held by `merger-1` with one waiter
- **THEN** the call returns within one second with structured content `{queued: true, position: 2, holder: "merger-1", ticket: <id>}` and a join event is written

#### Scenario: MCP forced release matches the CLI
- **WHEN** `board_release` is called with `force` true, a `reason` and `as` `orchestrator` on a ticket held by `merger-1`
- **THEN** the written event's body is byte-identical to the one `release --force` writes for the same arguments and actor on a copy of the board
