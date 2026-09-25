## MODIFIED Requirements

### Requirement: Agent guide
`agentboard help agents` SHALL print a plain ASCII guide of at most 180
lines, stamped with the package version, containing these sections: what
the board is and is not (not a secret store, not the record of completion);
the actor rule; finding work (`inbox`, `list`); claiming before starting;
handing off and moving to `blocked` with a comment; the `DECISION:`
convention and why `close` needs a decision disposition; how tickets map to
planning tasks, including the OpenSpec flow (`import-change` after
proposing, claim the group's ticket before applying, tick `tasks.md` in the
implementing PR); mutex tickets (see "Mutex ticket recipe"); and using the
MCP tools instead of the shell when they
are available. `agentboard help agents --role <role>` SHALL print the guide
followed by a checklist for that role, where role is one of
`orchestrator`, `test-author`, `implementer` or `reviewer`. The
test-author, implementer and reviewer checklists SHALL include the worker
rules for mutex tickets, and the orchestrator checklist the queue-runner
rules (see "Mutex ticket recipe"). Every line of
guide output that begins with `agentboard ` SHALL parse successfully
against the command registry.

#### Scenario: Guide examples are valid commands
- **WHEN** every line beginning with `agentboard ` is extracted from the output of `help agents` and of `help agents --role` for each role and parsed against the registry
- **THEN** every line parses without an unknown command or flag error

#### Scenario: Unknown role
- **WHEN** `agentboard help agents --role tester` runs
- **THEN** it exits 1 and lists the four valid roles

#### Scenario: Guide contains the mutex recipe
- **WHEN** `agentboard help agents` and `help agents --role <role>` run for each role
- **THEN** the guide has a section titled `Mutex tickets`, each output is at most 180 lines, and each role checklist has its mutex lines

## ADDED Requirements

### Requirement: Mutex ticket recipe
The guide section `Mutex tickets` SHALL describe, with commands that
parse against the registry:
- what a mutex ticket is: one standing ad hoc ticket per lock, never
  closed while the lock is in use;
- acquiring: `claim <id> --ttl <duration>`, then `renew <id>` as the first
  action of real work (an unconfirmed claim lapses after the grace
  period), with a ttl longer than the critical section, renewing at about
  half the ttl and immediately before the critical step, and stopping if
  `renew` fails with `not-assignee` (the lock was lost);
- releasing with `release` when done, including on failure;
- worker rules: never wait on a mutex in a loop and never claim from a
  background process; either wait in the foreground with
  `claim <id> --ttl <duration> --wait --timeout <duration>` (CLI only) and
  renew on return, or report ready (a comment or a hand-off to the
  orchestrator) and stop; over MCP, `board_claim` with `wait` only joins
  the queue, and the grant arrives in `board_inbox`;
- orchestrator rules: for merge-style mutexes where agents cannot block,
  act as the single queue runner, dispatching one holder at a time and
  dispatching the next only when the ticket is released or its holder's
  lease lapses; set `queue.window` and `lease.grace` with `config set`
  when the defaults do not fit; handle stale holds by waiting for the
  lease to lapse, or with `release --force --reason` after checking the
  holder is gone, never by impersonating the holder with `--as`;
- that across machines the lock is only as strong as `sync` (sync before
  claiming and before the critical step), while within one machine it is
  exact.

The installed `claude` and `agents-md` guidance SHALL contain a short form
of the recipe (the worker rules, the claim, renew, wait and release
commands, and the pointer to `agentboard help agents`), the MCP server
`instructions` summary SHALL contain the worker rules in one or two
sentences while staying within 2000 characters, and the guidance version
SHALL be 2, so `agents check` reports version 1 installations as `stale`.

#### Scenario: Recipe commands parse
- **WHEN** every line beginning with `agentboard ` in the mutex section is parsed against the registry
- **THEN** each parses, and the section includes `claim` with `--ttl`, `renew`, `claim` with `--wait` and `--timeout`, `release`, `release` with `--force` and `--reason`, and `config set`

#### Scenario: Installed skill carries the recipe
- **WHEN** `agentboard agents install --target claude` runs with guidance version 2
- **THEN** `SKILL.md` contains a `Mutex tickets` section with the worker rules and the claim, renew, wait and release commands, and the version 2 marker

#### Scenario: MCP instructions carry the worker rule
- **WHEN** an MCP client connects to `agentboard mcp`
- **THEN** the server instructions say never to wait on a mutex in a loop or claim from a background process, and are at most 2000 characters

#### Scenario: Version 1 installs are stale
- **WHEN** `agents check` runs where the skill was installed with guidance version 1
- **THEN** it reports the `claude` target as `stale` and exits 1
