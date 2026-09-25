## MODIFIED Requirements

### Requirement: Event kinds
The following kinds SHALL be defined with these bodies:
`ticket.create` (title, optional description, optional labels array, optional
`task` reference, optional `adhoc` reason string, optional checklist array
of strings; `task` and `adhoc` SHALL NOT both be present);
`ticket.comment` (text);
`ticket.move` (to: status);
`ticket.assign` (to: actor);
`ticket.claim` (the event's actor claims the ticket; optional `lease`, an
object with `ttl` and `expiresAt`, integers in milliseconds; optional
`supersedes`, an object with `holder` (actor), `expiresAt` (integer) and
`event` (a 64-character lowercase hex event hash); a claim with neither
field has an empty body, exactly as before leases existed);
`ticket.renew` (ttl and expiresAt, integers in milliseconds);
`ticket.release` (no body fields);
`ticket.release.force` (holder: actor, reason: non-empty string);
`ticket.handoff` (to: actor, status, note);
`ticket.link` (exactly one of: `task` reference, pr URL or number, decision path);
`ticket.close` (either `decision` path string or `noDecision` true);
`ticket.checklist` (index: integer, done: boolean);
`ticket.checklist.add` (items: non-empty array of objects with `text`, a
non-empty string, and `done`, a boolean; the fold appends them in order);
`board.meta` (key, value; board-level settings such as the default column
set). Bodies with extra fields SHALL be malformed. In `ticket.claim` and
`ticket.renew`, a `ttl` outside 30000 to 604800000 inclusive, or an
`expiresAt` not equal to the event's `ts.wall` plus its `ttl`, SHALL be
malformed.

#### Scenario: Handoff carries three effects
- **WHEN** a `ticket.handoff` event with to, status and note is folded
- **THEN** the ticket's assignee, status and comment list all reflect it, and no separate assign, move or comment event exists for it

#### Scenario: Checklist tick out of range
- **WHEN** a `ticket.checklist` event names an index beyond the ticket's checklist length
- **THEN** the event is reported as rejected with reason `checklist-index` and the ticket is unchanged

#### Scenario: Plain claim bytes are unchanged
- **WHEN** a claim is written without a lease on a ticket with no lease
- **THEN** its body is the empty object and its canonical bytes are those a version without leases writes for the same envelope

#### Scenario: Inconsistent lease expiry is malformed
- **WHEN** a `ticket.claim` has `ts.wall` 1000000 and `lease` `{ttl: 600000, expiresAt: 1700000}`
- **THEN** the event is reported as malformed naming `lease.expiresAt` and is not folded

#### Scenario: Lease too short is malformed
- **WHEN** a `ticket.renew` has `ttl` 1000
- **THEN** the event is reported as malformed naming `ttl`

### Requirement: Fold semantics
Folding SHALL produce, per ticket: id, title, description, status, assignee,
lease (null, or its ttl, expiresAt and the hash of the event that set it),
labels, task reference or ad hoc reason, checklist with done flags, ordered comments (each
with actor, timestamp and text), links, closed flag with its decision record
path or explicit no-decision marker, `version` (the count of folded events
that changed the ticket), and `updated_at` (the timestamp of the last such
event). A `ticket.create` SHALL be the first event for its id; any other event
for an unknown ticket id SHALL be reported as rejected with reason
`unknown-ticket` and held aside. A second `ticket.create` for an existing id
SHALL be rejected with reason `duplicate-create`. A `ticket.move` to a status
not permitted by the state machine (see board-cli) SHALL be rejected with
reason `invalid-transition`; a `ticket.claim` on an assigned ticket SHALL be
rejected with reason `already-assigned` unless it takes over an expired
lease (see "Claim leases"); a `ticket.release` or `ticket.renew` by an actor
other than the assignee SHALL be rejected with reason `not-assignee`; a
`ticket.release.force` whose holder is not the assignee SHALL be rejected
with reason `holder-changed` (see "Forced release"); a
`ticket.move` or `ticket.handoff` that would take a ticket with no task
reference into `implementing` SHALL be rejected with reason
`needs-task-link` (see board-openspec-integration). Rejected
events SHALL be listed in the fold report with hash, kind, ticket and reason
and SHALL never be deleted.

Where the requirements above leave a case open, the fold SHALL behave as
follows. A `ticket.close` on a ticket not in `merged` or `blocked`, or on an
already closed ticket, SHALL be rejected with reason `invalid-transition`.
Events after a close SHALL fold by their own rules (a comment on a closed
ticket is accepted; a move out of `merged` is still rejected). A task link
SHALL replace the ticket's task reference and clear its ad hoc reason; pr
and decision links SHALL be appended in fold order. `version` SHALL count
every applied event of a defined kind, including one that leaves the state
unchanged, such as ticking an already ticked checklist line. `board.meta`
events SHALL be stored in the board state's meta map and SHALL NOT change
the six statuses or the state machine. A ticket SHALL always be created in
`todo`; an import that needs another status writes the permitted moves.
The fold SHALL NOT read the local clock: every lease decision SHALL be made
from the timestamps and bodies of the events alone.

#### Scenario: Close from implementing is refused
- **WHEN** a `ticket.close` is folded for a ticket in `implementing`
- **THEN** it is rejected with reason `invalid-transition`

#### Scenario: Concurrent claims fold to one winner
- **WHEN** two `ticket.claim` events for the same unassigned ticket exist with different timestamps
- **THEN** the earlier one in fold order assigns the ticket and the later one is reported as rejected with reason `already-assigned`

#### Scenario: Comment on unknown ticket is held
- **WHEN** a `ticket.comment` names a ticket id with no `ticket.create` in the log
- **THEN** the fold report lists it as rejected with reason `unknown-ticket` and no ticket is created

#### Scenario: Version counts effective events
- **WHEN** a ticket has one create, two comments and one rejected move
- **THEN** its version is 3 and its updated_at equals the timestamp of the second comment

## ADDED Requirements

### Requirement: Claim leases
A `ticket.claim` with a `lease` SHALL set the ticket's lease to its `ttl`,
its `expiresAt` and the claim's hash. A `ticket.renew` by the assignee SHALL
replace the lease with the renew's `ttl`, `expiresAt` and hash, whether or
not the previous lease has expired and whether or not the ticket had a
lease. `ticket.release`, `ticket.release.force`, `ticket.handoff` and
`ticket.assign` SHALL clear the lease when applied; no other kind SHALL
change it. A lease SHALL never change a ticket's status.

The skew tolerance `LEASE_SKEW_MS` SHALL be 60000. A `ticket.claim` by an
actor other than the assignee of an assigned ticket SHALL be applied only
when its body has `supersedes` and, at its position in fold order, all of
the following hold: the assignee equals `supersedes.holder`; the ticket has
a lease whose `expiresAt` equals `supersedes.expiresAt` and whose event
hash equals `supersedes.event`; and the claim's `ts.wall` is at least that
`expiresAt` plus `LEASE_SKEW_MS`. When applied, the claim's actor SHALL
become the assignee and the lease SHALL become the claim's own `lease`, or
null when it has none. Otherwise the claim SHALL be rejected with reason
`already-assigned`. A claim on an unassigned ticket SHALL be applied as
before, ignoring any `supersedes` it carries.

#### Scenario: Takeover after expiry and tolerance
- **WHEN** `h` claims T1 at wall 1000000 with ttl 600000 (expiresAt 1600000), and `c` claims T1 at wall 1660000 with `supersedes` naming `h`, 1600000 and the first claim's hash
- **THEN** T1 is assigned to `c` and the second claim is applied

#### Scenario: Takeover inside the tolerance is rejected
- **WHEN** the same takeover claim has wall 1630000
- **THEN** it is rejected with reason `already-assigned` and T1 stays with `h`

#### Scenario: Renew before expiry beats a later takeover
- **WHEN** `h` claims T1 at wall 1000000 with ttl 600000, renews at wall 1500000 with ttl 600000, and `c` has written a takeover at wall 1700000 naming the first claim's lease
- **THEN** the renew is applied (expiresAt 2100000), the takeover is rejected `already-assigned`, and the result is the same whichever order the three files are read in

#### Scenario: Late renew still counts when nobody took over
- **WHEN** `h` claims T1 with a lease expiring at 1600000 and renews at wall 1900000 with no other claim in between
- **THEN** the renew is applied and the lease expires at 1900000 plus its ttl

#### Scenario: Claim without supersedes on an expired lease
- **WHEN** `c` claims T1 at a wall long after `h`'s lease expired, with no `supersedes`
- **THEN** it is rejected with reason `already-assigned`

#### Scenario: Renew by another actor
- **WHEN** `c` renews T1 held by `h`
- **THEN** it is rejected with reason `not-assignee`

#### Scenario: Hand-off clears the lease
- **WHEN** `h` holds T1 with a lease and hands it off to `r`
- **THEN** T1 is assigned to `r` with lease null

### Requirement: Forced release
A `ticket.release.force` SHALL be applied only when the ticket's assignee at
its position in fold order equals `body.holder`; it SHALL then clear the
assignee and the lease and leave the status unchanged. Otherwise it SHALL be
rejected with reason `holder-changed`. It SHALL be applied whether or not
the holder had a lease and whether or not the lease had expired.

#### Scenario: Forced release of a claim without a lease
- **WHEN** `h` holds T1 with no lease and `orch` writes a `ticket.release.force` naming holder `h` and reason `h crashed`
- **THEN** T1 has no assignee, its status is unchanged, and the event is applied

#### Scenario: Forced release after the holder changed
- **WHEN** `orch` writes a forced release naming holder `h`, but earlier in fold order `h` handed T1 off to `r`
- **THEN** the forced release is rejected with reason `holder-changed` and T1 stays with `r`
