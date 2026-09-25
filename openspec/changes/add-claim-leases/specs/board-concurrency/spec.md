## ADDED Requirements

### Requirement: Expired-lease claim race has exactly one winner
When N processes concurrently run `claim` on a ticket whose lease is
claimable, the board SHALL end with exactly one new assignee, exactly one
process SHALL exit 0, and every other process SHALL exit 4 with reason
`already-assigned` naming the winner. Exactly one takeover SHALL be folded
as effective; any others written SHALL be recorded as rejected, never
deleted. The same SHALL hold in the fold for any set of takeover events
naming the same lease, whatever their timestamps and read order.

#### Scenario: Ten concurrent takeovers
- **WHEN** `holder` claimed T1 with `--ttl 30s`, the children's clocks are advanced past the claimable time, and ten child processes run `claim T1 --as agent-<n>` started within the same millisecond
- **THEN** one exits 0, nine exit 4, `show T1` reports a single assignee other than `holder`, and `rebuild --check` reports no divergence

#### Scenario: Property: one effective takeover per lease
- **WHEN** a property test generates a lease and a random set of takeover, renew, release and forced release events with random walls and actors, and folds every permutation it samples
- **THEN** at most one takeover naming that lease is applied, the ticket has at most one assignee, and every permutation folds to byte-identical state

### Requirement: Crashed holder recovery through lease expiry
When the process holding a leased claim dies without releasing, another
actor SHALL be able to claim the ticket once the lease is claimable,
without impersonating the holder and without any other action.

#### Scenario: Holder killed while holding the lock
- **WHEN** a child process claims T1 with `--ttl 30s` and is killed with SIGKILL, and a second actor runs `claim T1` first before and then after the claimable time (the child clocks are advanced by the test harness)
- **THEN** the first attempt exits 4 `already-assigned` naming the dead holder and the second exits 0 with a takeover naming its lease

#### Scenario: Holder killed after the claim file is renamed
- **WHEN** a child process running `claim T1 --ttl 30s` is killed after its event file is renamed into place but before commit
- **THEN** the next command folds the claim with its lease, and a takeover after the claimable time succeeds

### Requirement: Lease folds converge across replicas with skewed clocks
Two clones of a board whose machines' clocks differ by at most 60 seconds
SHALL, after both have synced, fold every lease, renew, takeover and
forced release event to byte-identical state, and no takeover SHALL be
applied whose wall time precedes the real expiry of the lease it names.
Within one machine the lease rules SHALL be exact: a takeover is accepted
at and only at walls from `expiresAt` plus 60000 on.

#### Scenario: Skewed replicas converge
- **WHEN** clone A (clock 45 seconds fast) and clone B (clock correct) each write claims, renews and takeovers of the same ticket while disconnected, then both sync and A syncs again
- **THEN** both rebuilt caches are identical and at most one takeover per lease is applied

#### Scenario: Fast clock inside tolerance cannot steal a live lease
- **WHEN** B holds T1 with a lease expiring at real time E, and A, whose clock is 59 seconds fast, attempts a takeover at real time E minus 1 second
- **THEN** the command refuses with `already-assigned`, and a takeover event crafted with that wall is rejected by the fold on both replicas

#### Scenario: Renew synced late still wins
- **WHEN** B renews T1 before expiry but syncs only after A has written a takeover past the claimable time of the old lease
- **THEN** after both sync, T1 is held by B with the renewed lease and A's takeover is rejected `already-assigned` on both replicas
