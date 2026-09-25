## MODIFIED Requirements

### Requirement: Claim, release and handoff
`claim` SHALL assign the ticket to the actor only if it is unassigned, or
if it is held by another actor under a lease that is claimable (see
"Leases on the command line"), and SHALL exit 4 with reason
`already-assigned` otherwise, naming the current assignee and, when the
ticket has a lease, its expiry and the time from which it can be claimed;
a `claim` by the current assignee SHALL exit 0, write no event (with or
without `--ttl`) and report that the actor already holds the ticket and
its current lease, so a retried claim is safe. `release` SHALL clear the
assignment only when the actor is the assignee, except with `--force`
(see "Forced release on the command line"). `handoff` SHALL, in one event,
set the assignee to `--to`, set the
status to `--status` (subject to the state machine), and add the note as a
comment attributed to the actor.

#### Scenario: Handoff to reviewer
- **WHEN** the implementer runs `handoff T1 --as impl --to reviewer --status review --note "green, 96%"`
- **THEN** T1 is assigned to `reviewer`, in status `review`, with a comment "green, 96%" by `impl`, and `show T1` lists one new event

#### Scenario: Handoff with an invalid status writes nothing
- **WHEN** `handoff` names a status the state machine does not permit from the current one
- **THEN** no event is written and the command exits 4

#### Scenario: Refusal names the lease
- **WHEN** `merger-1` holds T1 with a live lease and `claim T1 --as merger-2` runs
- **THEN** the command exits 4 with reason `already-assigned`, and the message names `merger-1`, the lease expiry and the time from which T1 can be claimed

## ADDED Requirements

### Requirement: Leases on the command line
`claim <id> --as <actor> [--ttl <duration>]` SHALL write, with `--ttl`, a
`ticket.claim` whose `lease` has that ttl and an `expiresAt` equal to the
event's `ts.wall` plus the ttl. `renew <id> --as <actor> --ttl <duration>`
SHALL write a `ticket.renew` the same way, only when the actor is the
assignee, and SHALL exit 4 with reason `not-assignee` otherwise. A
duration SHALL be 1 to 5 ASCII digits followed by `s`, `m`, `h` or `d`,
between 30 seconds and 7 days inclusive; any other value SHALL exit 1 with
reason `usage` naming the form. The command SHALL build the event's hybrid
timestamp before validating, inside the same transaction, and SHALL
validate with the fold's rules against that timestamp. A claim on a ticket
held by another actor SHALL be written as a takeover, with `supersedes`
filled from the current lease, only when the ticket has a lease, the new
event's `ts.wall` is at least its `expiresAt` plus 60000, and the local
clock also reads at least that time; otherwise it SHALL be refused as
`already-assigned` without writing. Callers SHALL NOT supply `supersedes`.

`show` SHALL display a ticket's lease (expiry as an ISO 8601 UTC time, ttl
and state) and, for a takeover, both the previous holder's expiry and the
takeover's wall time. The lease state SHALL be computed from the local
clock at read time: `live` before `expiresAt`, `expired` from `expiresAt`
until `expiresAt` plus 60000, and `claimable` from then on. In `--json`
output the ticket SHALL carry `lease`: null, or `{ttl, expiresAt, event,
state, claimableAt}`. In `list`, the assignee column SHALL stay one token:
`<actor>+<remaining>` for a live lease (for example `merger+9m`),
`<actor>!expired` or `<actor>!claimable`, and `<actor>` alone with no
lease. The state SHALL never be stored in the cache.

#### Scenario: Claim with a lease
- **WHEN** `claim T1 --as merger-1 --ttl 10m` runs on an unassigned ticket
- **THEN** it exits 0, the claim event's `lease.ttl` is 600000 and `lease.expiresAt` is its `ts.wall` plus 600000, and `list` shows `merger-1+10m`

#### Scenario: Takeover of a claimable lease
- **WHEN** `merger-1` claimed T1 with `--ttl 30s`, was killed, 91 seconds have passed and `claim T1 --as merger-2` runs
- **THEN** it exits 0, T1 is assigned to `merger-2`, and the claim event's `supersedes` names `merger-1`, the lease expiry and the event that set it

#### Scenario: Expired but not yet claimable
- **WHEN** a lease expired 20 seconds ago and another actor runs `claim`
- **THEN** it exits 4 with reason `already-assigned`, no event is written, and `list` shows `<holder>!expired`

#### Scenario: Renew by the holder
- **WHEN** `merger-1` holds T1 with a lease and runs `renew T1 --as merger-1 --ttl 10m`
- **THEN** it exits 0 and the lease expires 10 minutes after the renew event's wall time

#### Scenario: Renew by someone else
- **WHEN** `merger-2` runs `renew T1 --ttl 10m` on a ticket held by `merger-1`
- **THEN** it exits 4 with reason `not-assignee` and no event is written

#### Scenario: Malformed duration
- **WHEN** `claim T1 --as a --ttl 10min` or `claim T1 --as a --ttl 5s` runs
- **THEN** the command exits 1 with reason `usage` naming the duration form and the 30s to 7d range

#### Scenario: Holder re-claims with a ttl
- **WHEN** the holder of T1 runs `claim T1 --ttl 10m`
- **THEN** it exits 0, writes no event, reports its current lease and names `agentboard renew`

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
- **THEN** it exits 0, T1 has no assignee, and the event is a `ticket.release.force` with actor `orchestrator`, holder `merger-1` and that reason

#### Scenario: Force without a reason
- **WHEN** `release T1 --as orchestrator --force` runs
- **THEN** it exits 1 with reason `usage` and no event is written

#### Scenario: Force by the holder
- **WHEN** `merger-1` holds T1 and runs `release T1 --as merger-1 --force --reason x`
- **THEN** it exits 1 with reason `usage` and names plain `release`

### Requirement: Lease events in the inbox
Inbox entries (and `watch --json` lines) SHALL carry `affects`: the previous
holder for an applied `ticket.release.force` (its `holder`) and for an
applied claim that took over a lease (its `supersedes.holder`), and null
for every other event. For `ticket.release.force` the entry's `note`
SHALL be the reason. Human inbox output SHALL begin an entry's line with
`LOST: ` when its `affects` equals the reading actor.

#### Scenario: Previous holder is told
- **WHEN** `orchestrator` force-releases T1 from `merger-1` with reason `stalled` and `inbox --as merger-1` runs
- **THEN** the entry has `affects` `merger-1` and `note` `stalled`, and the human line begins with `LOST: `

### Requirement: Lease hints
The `already-assigned` hint on a ticket with a lease SHALL name the time
from which it can be claimed and `agentboard release <id> --force --reason
<text> --as <actor>` for a holder known to be gone. The `holder-changed`
reason SHALL hint `agentboard show <id>`. `not-assignee` from `renew` SHALL
hint `agentboard show <id>` and say the lock was lost.

#### Scenario: Hint for a live lease
- **WHEN** `claim T1 --as merger-2` is refused because `merger-1` holds a live lease
- **THEN** stderr has a `hint: ` line naming the claimable time and `release T1 --force`

### Requirement: Lease tools over MCP
The command registry SHALL define `renew` and the `--ttl`, `--force` and
`--reason` flags, so that `agentboard mcp` lists `board_renew` (with
required `id` and `ttl`), `board_claim` gains an optional `ttl` and
`board_release` gains optional `force` and `reason`, validated exactly as
on the CLI.

#### Scenario: MCP tool list includes renew
- **WHEN** an MCP client lists tools
- **THEN** `board_renew` is listed, `board_claim` has an optional `ttl` property and `board_release` has optional `force` and `reason` properties

#### Scenario: MCP forced release matches the CLI
- **WHEN** `board_release` is called with `force` true, a `reason` and `as` `orchestrator` on a ticket held by `merger-1`
- **THEN** the written event's body is byte-identical to the one `release --force` writes for the same arguments and actor on a copy of the board
