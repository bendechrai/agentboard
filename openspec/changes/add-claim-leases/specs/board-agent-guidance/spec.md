## MODIFIED Requirements

### Requirement: Agent guide
`agentboard help agents` SHALL print a plain ASCII guide of at most 170
lines, stamped with the package version, containing these sections: what
the board is and is not (not a secret store, not the record of completion);
the actor rule; finding work (`inbox`, `list`); claiming before starting;
handing off and moving to `blocked` with a comment; the `DECISION:`
convention and why `close` needs a decision disposition; how tickets map to
planning tasks, including the OpenSpec flow (`import-change` after
proposing, claim the group's ticket before applying, tick `tasks.md` in the
implementing PR); using a ticket as a mutex (see "Ticket-as-mutex
recipe"); and using the MCP tools instead of the shell when they
are available. `agentboard help agents --role <role>` SHALL print the guide
followed by a checklist for that role, where role is one of
`orchestrator`, `test-author`, `implementer` or `reviewer`. The
orchestrator checklist SHALL say that `release --force` is for the
orchestrator or a human, after checking the holder is gone, and never a
substitute for impersonating the holder with `--as`. Every line of
guide output that begins with `agentboard ` SHALL parse successfully
against the command registry.

#### Scenario: Guide examples are valid commands
- **WHEN** every line beginning with `agentboard ` is extracted from the output of `help agents` and of `help agents --role` for each role and parsed against the registry
- **THEN** every line parses without an unknown command or flag error

#### Scenario: Unknown role
- **WHEN** `agentboard help agents --role tester` runs
- **THEN** it exits 1 and lists the four valid roles

#### Scenario: Guide contains the mutex recipe
- **WHEN** `agentboard help agents` runs
- **THEN** its output has a section titled `Using a ticket as a mutex` and is at most 170 lines

## ADDED Requirements

### Requirement: Ticket-as-mutex recipe
The guide section `Using a ticket as a mutex` SHALL describe, with
commands that parse against the registry: creating one standing ticket per
lock (an ad hoc ticket that is never closed while the lock is in use);
acquiring with `claim <id> --ttl <duration>` and retrying on
`already-assigned` after the claimable time the refusal names; choosing a
ttl longer than the critical section; renewing with `renew` at about half
the ttl and immediately before the critical step, stopping if `renew`
fails with `not-assignee` (the lock was lost); releasing with `release`
when done, including on failure; recovery of a crashed holder by waiting
for the lease to become claimable, or by `release --force --reason` by the
orchestrator or a human; and that across machines the lock is only as
strong as `sync` (sync before claiming and before the critical step),
while within one machine it is exact. The installed `claude` and
`agents-md` guidance SHALL contain a short form of the recipe (the acquire,
renew and release commands and the pointer to `agentboard help agents`),
and the guidance version SHALL be 2, so `agents check` reports version 1
installations as `stale`.

#### Scenario: Recipe commands parse
- **WHEN** every line beginning with `agentboard ` in the mutex section is parsed against the registry
- **THEN** each parses, and the section includes `claim` with `--ttl`, `renew`, `release` and `release` with `--force` and `--reason`

#### Scenario: Installed skill carries the recipe
- **WHEN** `agentboard agents install --target claude` runs with guidance version 2
- **THEN** `SKILL.md` contains a `Using a ticket as a mutex` section with the acquire, renew and release commands and the version 2 marker

#### Scenario: Version 1 installs are stale
- **WHEN** `agents check` runs where the skill was installed with guidance version 1
- **THEN** it reports the `claude` target as `stale` and exits 1
