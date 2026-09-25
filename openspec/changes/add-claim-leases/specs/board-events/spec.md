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
object with `ttl`, `grace` and `expiresAt`, integers in milliseconds; optional
`supersedes`, an object with `holder` (actor), `expiresAt` (integer) and
`event` (a 64-character lowercase hex event hash); a claim with neither
field has an empty body, exactly as before leases existed);
`ticket.renew` (ttl and expiresAt, integers in milliseconds);
`ticket.release` (no body fields);
`ticket.release.force` (holder: actor, reason: non-empty string);
`ticket.queue.join` (ttl, integer in milliseconds);
`ticket.queue.leave` (no body fields);
`ticket.grant` (to: actor, ttl and window: integers in milliseconds,
after: an object with exactly one of `released`, an event hash, or
`lease`, an object with `holder`, `expiresAt` and `event`);
`ticket.handoff` (to: actor, status, note);
`ticket.link` (exactly one of: `task` reference, pr URL or number, decision path);
`ticket.close` (either `decision` path string or `noDecision` true);
`ticket.checklist` (index: integer, done: boolean);
`ticket.checklist.add` (items: non-empty array of objects with `text`, a
non-empty string, and `done`, a boolean; the fold appends them in order);
`ticket.reconcile` (optional `title`; `updated`, an array of objects with
`index`, `text` and `done`; `removed`, an array of indices; `added`, an
array of objects with `text` and `done`; `forced`, a boolean; `source`, a
string naming the tasks file and the SHA-256 of its bytes; at least one of
`title`, `updated`, `removed` and `added` non-empty);
`ticket.renumber` (from and to: non-empty item strings);
`ticket.supersede` (reason: non-empty string);
`board.meta` (key, value; board-level settings such as the default column
set). Bodies with extra fields SHALL be malformed. A `ttl` outside 30000
to 604800000 inclusive, or a `grace` or `window` outside 30000 to 600000
inclusive, SHALL be malformed. In `ticket.claim` a lease `expiresAt` not
equal to `ts.wall` plus the smaller of `ttl` and `grace`, and in
`ticket.renew` an `expiresAt` not equal to `ts.wall` plus `ttl`, SHALL be
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
- **WHEN** a `ticket.claim` has `ts.wall` 1000000 and `lease` `{ttl: 600000, grace: 120000, expiresAt: 1600000}`
- **THEN** the event is reported as malformed naming `lease.expiresAt` and is not folded

#### Scenario: Lease too short is malformed
- **WHEN** a `ticket.renew` has `ttl` 1000
- **THEN** the event is reported as malformed naming `ttl`

### Requirement: Fold semantics
Folding SHALL produce, per ticket: id, title, description, status, assignee,
lease (null, or its requested ttl, expiresAt, the hash of the event that set
it and whether it is confirmed), the waiting queue (in order, each waiter's
actor, requested ttl and join event), labels, task reference or ad hoc reason, checklist with done flags, ordered comments (each
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
lease (see "Claim leases"), and a claim or takeover while the ticket has
waiters SHALL be rejected with reason `queued` (see "Waiting queue"); a
`ticket.release` or `ticket.renew` by an actor
other than the assignee SHALL be rejected with reason `not-assignee`; a
`ticket.release.force` whose holder is not the assignee SHALL be rejected
with reason `holder-changed` (see "Forced release"); a queue event that
does not apply SHALL be rejected with reason `invalid-queue`; a
`ticket.grant` that differs from the derived grant SHALL be rejected with
reason `stale-grant` (see "Grants"); a
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
The fold SHALL NOT read the local clock: every lease, queue and grant
decision SHALL be made from the timestamps and bodies of the events alone.

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
its `expiresAt`, the claim's hash and `confirmed` false: the claim holds
the ticket only for its grace period until confirmed. A `ticket.renew` by
the assignee SHALL replace the lease with the renew's `ttl`, `expiresAt`
and hash and set `confirmed` true, whether or not the previous lease has
expired and whether or not the ticket had a lease. `ticket.release`,
`ticket.release.force`, `ticket.handoff` and `ticket.assign` SHALL clear
the lease when applied; `ticket.grant` SHALL replace it (see "Grants"); no
other kind SHALL change it. A lease SHALL never change a ticket's status.

The skew tolerance `LEASE_SKEW_MS` SHALL be 60000. A `ticket.claim` by an
actor other than the assignee of an assigned ticket with no waiters SHALL
be applied only when its body has `supersedes` and, at its position in
fold order, all of the following hold: the assignee equals
`supersedes.holder`; the ticket has a lease whose `expiresAt` equals
`supersedes.expiresAt` and whose event hash equals `supersedes.event`;
and the claim's `ts.wall` is at least that `expiresAt` plus
`LEASE_SKEW_MS`. When applied, the claim's actor SHALL become the
assignee and the lease SHALL become the claim's own `lease`, or null when
it has none. Otherwise the claim SHALL be rejected with reason
`already-assigned`. A claim on an unassigned ticket with no waiters SHALL
be applied as before, ignoring any `supersedes` it carries.

#### Scenario: Unconfirmed claim lapses after its grace
- **WHEN** `h` claims T1 at wall 1000000 with lease `{ttl: 1800000, grace: 120000, expiresAt: 1120000}`, never renews, and `c` claims at wall 1180000 with `supersedes` naming `h`, 1120000 and the claim's hash
- **THEN** T1 is assigned to `c`

#### Scenario: First renew confirms the requested ttl
- **WHEN** `h` claims T1 at wall 1000000 with ttl 1800000 and grace 120000, and renews at wall 1060000 with ttl 1800000
- **THEN** the lease is confirmed with expiresAt 2860000, and a takeover at wall 1180000 is rejected `already-assigned`

#### Scenario: Takeover inside the tolerance is rejected
- **WHEN** a lease expires at 1600000 and another actor's takeover has wall 1630000
- **THEN** it is rejected with reason `already-assigned`

#### Scenario: Renew before expiry beats a later takeover
- **WHEN** `h` renews T1 at wall 1500000 before its lease expiring at 1600000, and `c` has written a takeover at wall 1700000 naming the old lease
- **THEN** the renew is applied, the takeover is rejected `already-assigned`, and the result is the same whichever order the files are read in

#### Scenario: Claim without supersedes on an expired lease
- **WHEN** `c` claims T1 at a wall long after `h`'s lease expired, with no `supersedes` and no waiters
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

### Requirement: Waiting queue
A `ticket.queue.join` SHALL add its actor to the ticket's queue with its
`ttl`, when the ticket is assigned or already has waiters, and the actor
is neither the assignee nor already queued; otherwise it SHALL be rejected
with reason `invalid-queue`. Waiters SHALL be ordered by the fold order of
their join events (hybrid timestamp, then hash). A `ticket.queue.leave`
SHALL remove its actor from the queue, and SHALL be rejected with reason
`invalid-queue` when the actor is not queued. While the queue is not
empty, a `ticket.claim` by any actor SHALL be rejected with reason
`queued`, except a claim by the assignee, which is handled as before.
`ticket.handoff` SHALL NOT be constrained by the queue.

#### Scenario: Join order is fold order
- **WHEN** `a` joins at wall 1000 and `b` joins at wall 900, arriving in the order a then b
- **THEN** the queue is `b`, `a`

#### Scenario: Same wall ties break on the timestamp then the hash
- **WHEN** two joins by `a` and `b` have equal wall and counter
- **THEN** the queue orders them by actor and then by hash, the same on every replica

#### Scenario: Queue-jumping claim is refused
- **WHEN** T1 has waiters and `x`, not queued, writes a claim with a valid `supersedes` after the holder's lease lapsed
- **THEN** the claim is rejected with reason `queued`

#### Scenario: Join on a free ticket
- **WHEN** T1 is unassigned with no waiters and `a` writes a join
- **THEN** it is rejected with reason `invalid-queue`

### Requirement: Grants
A grant SHALL be due for a ticket whose queue is not empty when the ticket
has become available at time `F`: after an applied `ticket.release` or
`ticket.release.force`, `F` is that event's wall; for a ticket held
under a lease, `F` is the lease's `expiresAt` plus `LEASE_SKEW_MS` (a renew
applied before then replaces the lease and so moves `F`). A holder
without a lease never lapses. Its slot
time SHALL be `S` = the larger of `F` and the head waiter's join wall,
plus 1. The derived grant SHALL be the event with kind `ticket.grant`,
actor `agentboard`, `ts` `{wall: S, counter: 0, actor: "agentboard"}`,
and body `to` (the head waiter), `ttl` (from its join), `window` (the
board's `queue.window` at that fold position, see "Board lease
settings") and `after` (`{released: <hash>}` for a release or forced
release, or `{lease: {holder, expiresAt, event}}` naming the lapsed
lease). The fold SHALL apply a `ticket.grant` only when it is
byte-identical to the grant derived at its position, and otherwise SHALL
reject it with reason `stale-grant`. An applied grant SHALL assign `to`,
remove it from the queue, and set the lease to `{ttl, expiresAt: S +
window, event: <grant hash>, confirmed: false}`; the grantee accepts by
renewing, and a grant not accepted lapses under the same rule, making the
next grant due. A ticket freed while its queue is empty SHALL have no
grant due.

#### Scenario: Release grants to the head waiter
- **WHEN** `h` holds T1, `a` then `b` are queued, and `h` releases at wall 5000
- **THEN** the derived grant has wall 5001, actor `agentboard`, `to` `a`, and once applied T1 is assigned to `a` with an unconfirmed lease and the queue is `b`

#### Scenario: Reservation passes on non-acceptance
- **WHEN** `a` was granted T1 at slot time S with window 120000 and never renews
- **THEN** the next derived grant, to `b`, has wall S + 120000 + 60000 + 1 and names `a`'s lapsed lease in `after`

#### Scenario: Acceptance in time keeps the grant
- **WHEN** `a` renews T1 at a wall before S + 120000
- **THEN** its lease is confirmed and no grant to `b` is due until that lease lapses or `a` releases

#### Scenario: Stale grant after a late renew
- **WHEN** a grant to `b` was written, and a renew by `a` with a wall before the grant's slot time arrives later by sync
- **THEN** on every replica the renew is applied and the grant is rejected with reason `stale-grant`

#### Scenario: Identical grants from two writers
- **WHEN** two commands on different machines each write the due grant for T1
- **THEN** both files have the same name and bytes, and after sync exactly one grant event exists

### Requirement: Reserved system actor
The actor `agentboard` SHALL be reserved for `ticket.grant`. An event of
any other kind with actor `agentboard`, or a `ticket.grant` with any other
actor, SHALL be malformed.

#### Scenario: Grant forged by an agent
- **WHEN** a `ticket.grant` has actor `impl`
- **THEN** it is reported as malformed and not folded

### Requirement: Board lease settings
The `board.meta` keys `lease.grace` and `queue.window` SHALL hold integer
milliseconds between 30000 and 600000; a missing or out-of-range value
SHALL mean the default of 120000. `lease.grace` SHALL be used by commands
writing a leased claim (the claim records it); `queue.window` SHALL be
read by the fold, as folded at a grant's position, to derive that grant.

#### Scenario: Window changed by a setting
- **WHEN** a `board.meta` event sets `queue.window` to 300000 before a release
- **THEN** the derived grant after that release has window 300000

#### Scenario: Out-of-range setting is ignored
- **WHEN** `queue.window` is set to 5000
- **THEN** grants use the default window of 120000

### Requirement: Reconcile events
A `ticket.reconcile` SHALL be applied only when every index in `updated`
and `removed` names a checklist line of the ticket that is not already
removed, and no index appears twice; otherwise it SHALL be rejected with
reason `checklist-index` and the ticket SHALL be unchanged. When applied
it SHALL, in one step, set the title when `title` is present, replace the
text and done flag of each `updated` line, mark each `removed` line as
removed, and append the `added` lines in order. A removed line SHALL keep
its index, so earlier and later `ticket.checklist` events keep their
meaning, SHALL be excluded from the ticket's active checklist, and a
`ticket.checklist` naming it SHALL be rejected with reason
`checklist-index`. The ticket's checklist SHALL carry a `removed` flag per
line.

#### Scenario: Reconcile applies the whole diff in one event
- **WHEN** a ticket with lines 0 `1.1 A`, 1 `1.2 B` and 2 `1.3 C` folds a reconcile with title `New title`, `updated` `[{index: 1, text: "1.2 B revised", done: false}]`, `removed` `[2]` and `added` `[{text: "1.4 D", done: false}]`
- **THEN** the title is `New title`, the active checklist is `1.1 A`, `1.2 B revised`, `1.4 D`, line 2 is kept as removed, and the version increases by one

#### Scenario: Tick on a removed line
- **WHEN** a `ticket.checklist` names a line removed by an earlier reconcile
- **THEN** it is rejected with reason `checklist-index`

#### Scenario: Reconcile naming a removed line
- **WHEN** a reconcile's `removed` names a line already removed
- **THEN** it is rejected with reason `checklist-index` and nothing changes

### Requirement: Renumber and supersede events
A `ticket.renumber` SHALL be applied only when the ticket has a task
reference whose `item` equals `from` and the ticket is not superseded; it
SHALL set the item to `to` and replace the label `group:<from>` with
`group:<to>`, leaving every other field, the assignee, comments and
checklist unchanged. A `ticket.supersede` SHALL be applied only when the
ticket is not already superseded; it SHALL mark the ticket superseded
with its reason and change nothing else (status, assignee, checklist and
comments are kept). Otherwise either SHALL be rejected with reason
`stale-import`. A superseded ticket SHALL be shown with a `superseded`
marker by `list` and `show` and SHALL take no further part in
`import-change`.

#### Scenario: Renumber keeps the work with the ticket
- **WHEN** a ticket `openspec:add-x#5` held by `impl` with two comments and one ticked line folds a `ticket.renumber` from `5` to `6`
- **THEN** its task reference is `openspec:add-x#6`, its labels include `group:6` and not `group:5`, and its assignee, comments and checklist are unchanged

#### Scenario: Stale renumber
- **WHEN** a `ticket.renumber` from `5` to `6` folds for a ticket whose item is already `6`
- **THEN** it is rejected with reason `stale-import`

#### Scenario: Supersede keeps the record
- **WHEN** a ticket in `implementing` held by `impl` folds a `ticket.supersede` with reason `group removed from tasks.md`
- **THEN** it is marked superseded, still in `implementing`, still assigned to `impl`, with its checklist and comments unchanged
