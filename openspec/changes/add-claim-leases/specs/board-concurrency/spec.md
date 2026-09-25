## ADDED Requirements

### Requirement: Expired-lease claim race has exactly one winner
When N processes concurrently run `claim` on a ticket with no waiters whose
lease is claimable, the board SHALL end with exactly one new assignee,
exactly one process SHALL exit 0, and every other process SHALL exit 4
with reason `already-assigned` naming the winner. Exactly one takeover
SHALL be folded as effective; any others written SHALL be recorded as
rejected, never deleted. The same SHALL hold in the fold for any set of
takeover events naming the same lease, whatever their timestamps and read
order.

#### Scenario: Ten concurrent takeovers
- **WHEN** `holder` claimed T1 with `--ttl 30m` and never renewed, the children's clocks are advanced past the claimable time, and ten child processes run `claim T1 --as agent-<n>` started within the same millisecond
- **THEN** one exits 0, nine exit 4, `show T1` reports a single assignee other than `holder`, and `rebuild --check` reports no divergence

#### Scenario: Property: one effective takeover per lease
- **WHEN** a property test generates a lease and a random set of takeover, renew, release and forced release events with random walls and actors, and folds every permutation it samples
- **THEN** at most one takeover naming that lease is applied, the ticket has at most one assignee, and every permutation folds to byte-identical state

### Requirement: Queue grants are fair and single
Grants SHALL be made in join order: for any set of join, leave, release,
renew, forced release and grant events on one ticket, every applied grant
SHALL go to the waiter that joined earliest in fold order among those
still queued at the grant's position, no actor SHALL be granted the
ticket while an earlier-joined waiter still queued has not been granted,
and at no fold position SHALL the ticket have more than one assignee.
A grant that is not accepted within its window plus `LEASE_SKEW_MS` SHALL
pass to the next waiter.

#### Scenario: Concurrent joins and releases
- **WHEN** ten child processes run `claim T1 --ttl 30m --wait --timeout 5m` concurrently against a holder that then releases, and each granted process renews and releases in turn
- **THEN** every process is granted exactly once, in the fold order of its join event, and `rebuild --check` reports no divergence

#### Scenario: Property: grants follow join order
- **WHEN** a property test generates random joins, leaves, renews, releases and forced releases with random walls, derives and writes every due grant at random clock points, and folds sampled permutations
- **THEN** every permutation folds to byte-identical state, grants follow join order among remaining waiters, and no position has two assignees

#### Scenario: Reservation passes on non-acceptance
- **WHEN** waiters `a`, `b` and `c` are queued, the holder releases, and `a` never renews
- **THEN** after `a`'s window plus the tolerance the grant passes to `b`, and `a` is no longer queued

#### Scenario: Grace expiry without renew
- **WHEN** a child process claims T1 with `--ttl 30m`, never renews, and `b` is queued
- **THEN** the grant to `b` is due at the claim's wall plus 120000 plus 60000 plus 1, and no grant is due before it

### Requirement: Crashed holder recovery through lease expiry
When the process holding a leased claim or a grant dies without releasing,
the ticket SHALL pass to the next waiter, or become claimable when there
are none, without impersonating the holder and without any other action.

#### Scenario: Holder killed while holding the lock
- **WHEN** a child process claims T1 with `--ttl 30m`, renews, and is killed with SIGKILL, and a second actor runs `claim T1` first before and then after the claimable time (the child clocks are advanced by the test harness)
- **THEN** the first attempt exits 4 `already-assigned` naming the dead holder and the second exits 0 with a takeover naming its lease

#### Scenario: Waiter killed while waiting
- **WHEN** a process blocked in `claim --wait` is killed with SIGKILL and is then granted T1
- **THEN** the grant lapses after its window and passes to the next waiter

#### Scenario: Holder killed after the claim file is renamed
- **WHEN** a child process running `claim T1 --ttl 30m` is killed after its event file is renamed into place but before commit
- **THEN** the next command folds the claim with its grace lease, and a takeover after the claimable time succeeds

### Requirement: Lease and queue folds converge across replicas with skewed clocks
Two clones of a board whose machines' clocks differ by at most 60 seconds
SHALL, after both have synced, fold every lease, renew, takeover, queue,
grant and forced release event to byte-identical state, with no double
grant, and no takeover or grant after a lapse SHALL be applied whose wall
precedes the real lapse of the lease it names. Within one machine the
rules SHALL be exact: a takeover is accepted at and only at walls from
`expiresAt` plus 60000 on, and a grant exactly at its slot time.

#### Scenario: Skewed replicas converge
- **WHEN** clone A (clock 45 seconds fast) and clone B (clock correct) each write claims, renews, joins, leaves, releases and grants of the same ticket while disconnected, then both sync and A syncs again
- **THEN** both rebuilt caches are identical, identical grants written on both clones are one file, and no fold position has two assignees

#### Scenario: Fast clock inside tolerance cannot steal a live lease
- **WHEN** B holds T1 with a lease expiring at real time E, and A, whose clock is 59 seconds fast, attempts a takeover at real time E minus 1 second
- **THEN** the command refuses with `already-assigned`, and a takeover event crafted with that wall is rejected by the fold on both replicas

#### Scenario: Renew synced late still wins
- **WHEN** B renews T1 before expiry but syncs only after A has written a grant or takeover past the old lease's lapse
- **THEN** after both sync, T1 is held by B with the renewed lease and A's event is rejected (`stale-grant` or `already-assigned`) on both replicas
