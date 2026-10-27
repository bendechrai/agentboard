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

### Requirement: Command surface
The CLI SHALL provide: `init [--remote <url> | --into-host]`; `new <title> [--description] [--label]...
(--task <source>:<ref>#<item> | --change <name> --group <n> | --adhoc <reason>)
[--checklist <line>]...`; `show <id>`;
`list [--status] [--assignee] [--task <source>:<ref>[#<item>]] [--change <name>] [--label] [--closed]`;
`claim <id> --as <actor> [--ttl <duration>] [--wait --timeout <duration>]`;
`renew <id> --as <actor> [--ttl <duration>]`; `unqueue <id> --as <actor>`;
`release <id> --as <actor> [--force --reason <text>]`;
`move <id> <status> --as <actor> [--task <source>:<ref>#<item> | --change <name> --group <n> | --unplanned <reason>]`;
`comment <id> --as <actor> <text>`;
`handoff <id> --as <actor> --to <actor> --status <status> --note <text>`;
`link <id> --as <actor> (--task <source>:<ref>#<item> | --change <name> --group <n> | --pr <ref> | --decision <path>)`;
`checklist tick <id> <index> --as <actor>` and `checklist untick`;
`close <id> --as <actor> (--decision-recorded-in <path> | --no-decision) [--task <source>:<ref>#<item> | --change <name> --group <n> | --unplanned <reason>]`;
`inbox --as <actor> [--since <cursor>] [--peek]`; `watch --as <actor>`;
`rebuild [--check]`; `sync`; `remote`; `import-change <name> [--dry-run] [--force]`;
`close-merged`;
`config set <key> <value> --as <actor>` and `config get [<key>]`;
`serve [--port <port>] [--open | --no-open] [--as <actor>]`; `top`;
`health [--stale-after <duration>] [--blocked-after <duration>] [--unplanned-within <duration>] [--check]`;
`mcp`; and `version`. Every command SHALL
accept `--json`. An argument beginning with `--` is
always parsed as a flag; `--` on its own ends the flags, so free text that
begins with `-` (for example a comment) is given after it. Ticket ids MAY be
given as a unique prefix of at least 6 characters. `--change <name> --group
<n>` SHALL be exactly equivalent to `--task openspec:<name>#<n>`, and
`list --change <name>` to `list --task openspec:<name>`. Commands, their
arguments and flags SHALL be defined once, in a single command registry that
drives argument parsing and the MCP tool definitions, so the two surfaces
cannot drift; a flag the registry marks CLI-only (`claim --timeout`) is
parsed on the command line and left out of the tool definitions. `serve`
and `top` are streaming commands like `watch`:
`serve` runs until SIGINT or SIGTERM (see board-web), and `top` until the
user quits it or it receives SIGINT or SIGTERM (see board-tui). `claim
--wait` blocks in the foreground until it is granted the ticket, times out
or is interrupted (see "Waiting on the command line"). `init`, `sync` and
`remote` are the commands that run git on the board; they need no actor
(see "Initialising and joining a shared board").

#### Scenario: OpenSpec shorthand is the same task reference
- **WHEN** one ticket is created with `--change add-board-core --group 3` and another with `--task openspec:add-board-core#3`
- **THEN** both tickets carry the identical task reference `openspec:add-board-core#3`

#### Scenario: Malformed task reference
- **WHEN** `agentboard new "x" --task add-board-core-3 --as a` runs
- **THEN** the command exits 1 and shows the `<source>:<ref>#<item>` form

#### Scenario: Prefix resolves a ticket
- **WHEN** `agentboard show 01J9K3` runs and exactly one ticket id starts with `01J9K3`
- **THEN** that ticket is shown

#### Scenario: Ambiguous prefix is refused
- **WHEN** a prefix matches two tickets
- **THEN** the command exits 1 and lists both full ids

#### Scenario: Claim has help for leases and waiting
- **WHEN** `agentboard help claim` runs with no board and no actor
- **THEN** it prints the synopsis with `--ttl`, `--wait` and `--timeout`, the exit codes including 4 `already-assigned`, `queued`, `wait-timeout` and `wait-interrupted`, and an example that parses to `claim` with `--ttl`, and exits 0

#### Scenario: Renew, unqueue and config have help
- **WHEN** `agentboard help renew`, `agentboard help unqueue` and `agentboard help config` run with no board and no actor
- **THEN** each prints its synopsis and an example that parses to that command, and exits 0, and the `config` synopsis names `lease.grace` and `queue.window`

#### Scenario: Top has help
- **WHEN** `agentboard help top` runs with no board and no actor
- **THEN** it prints the synopsis, the exit codes including 1 `not-a-tty` and 2, and an example that parses to `top`, and exits 0

#### Scenario: Serve has help
- **WHEN** `agentboard help serve` runs with no board and no actor
- **THEN** it prints the synopsis with `--port`, `--open`, `--no-open` and `--as`, the exit codes including 1 `port-in-use` and 2, and an example that parses to `serve`, and exits 0

#### Scenario: Health has help
- **WHEN** `agentboard help health` runs with no board and no actor
- **THEN** it prints the synopsis with `--stale-after`, `--blocked-after`, `--unplanned-within` and `--check`, and an example that parses to `health`, and exits 0

#### Scenario: Move and close have help for the disposition
- **WHEN** `agentboard help move` and `agentboard help close` run with no board and no actor
- **THEN** each prints the synopsis with `--task`, `--change`, `--group` and `--unplanned`, the exit codes including 4 `needs-scope-disposition` and 4 `already-linked`, and an example with `--unplanned` that parses, and neither mentions `needs-task-link`

#### Scenario: Init has help for sharing
- **WHEN** `agentboard help init` runs with no board and no actor
- **THEN** it prints `--remote` and `--into-host`, says they are mutually exclusive, lists the exit codes including 1 `ambiguous-remote`, 3 `remote-unreachable` and 4 `unsynced`, and has an example for each flag that parses, and exits 0

#### Scenario: Remote has help
- **WHEN** `agentboard help remote` runs with no board and no actor
- **THEN** it prints the synopsis, says the command never contacts the network, lists exit code 2, has an example that parses to `remote`, and exits 0

### Requirement: MCP server
`agentboard mcp` SHALL serve an MCP server over stdio exposing one tool per
command in the registry except `init`, `watch`, `serve`, `top`, `rebuild`,
`sync`, `remote`, `config`, `mcp` and `version`, which are setup, streaming,
settings or maintenance commands run by a human or an orchestrator in a
shell. Tool names SHALL be the command name with
spaces and hyphens replaced by underscores and prefixed `board_` (for
example `board_claim`, `board_checklist_tick`, `board_import_change`). Each
tool's input schema SHALL be generated from the registry, with the same
required arguments and the same validation as the CLI, and without the
flags the registry marks CLI-only; `--json` is implied.
Writing tools SHALL take the actor as an `as` argument, falling back to the
actor given to the server as `agentboard mcp --as <actor>`, then to the
server process's `AGENTBOARD_ACTOR`, and SHALL fail exactly as the CLI does
when none is present. A successful call SHALL return the same JSON document
the CLI prints with `--json` as a text content item, and as structured
content: the document itself when it is an object, or `{items: <array>}`
when it is an array (MCP structured content must be an object). A call to an
unknown or excluded tool name SHALL return a tool error with `exitCode` 1
and `reason` `usage`, not a protocol error, and so SHALL a call that passes
an argument the tool's schema does not define, such as a CLI-only flag. A
failed call
SHALL return a tool error (`isError` true) whose structured content is
`{exitCode, reason, message}`, where `exitCode` is the code the CLI would
have exited with and `reason` is the rejection reason where one exists (for
example `already-assigned`). The server SHALL locate the board once at
start-up by the same discovery rules, and SHALL fail to start, exiting 2,
when no board is found. Every tool call SHALL run the same single-transaction
path as the CLI, so concurrent CLI and MCP writers obey the same guarantees.
No tool call SHALL block waiting on another actor (see "Lease and queue
tools over MCP").

#### Scenario: Tools are listed from the registry
- **WHEN** an MCP client connects and lists tools
- **THEN** the list contains `board_new`, `board_show`, `board_list`, `board_claim`, `board_renew`, `board_unqueue`, `board_release`, `board_move`, `board_comment`, `board_handoff`, `board_link`, `board_checklist_tick`, `board_checklist_untick`, `board_close`, `board_inbox`, `board_import_change`, `board_close_merged` and `board_health`, and no tool for `init`, `watch`, `serve`, `top`, `rebuild`, `sync`, `remote`, `config`, `mcp` or `version`

#### Scenario: Rejection maps to a tool error
- **WHEN** `board_claim` is called on a ticket assigned to `impl` with `as` set to `reviewer`
- **THEN** the call returns a tool error with `exitCode` 4, `reason` `already-assigned` and a message naming `impl`, and no event is written

#### Scenario: Round trip through the server
- **WHEN** a client calls `board_new`, `board_claim`, `board_handoff` and `board_show` in turn
- **THEN** `board_show` returns the same JSON that `agentboard show <id> --json` prints for that ticket

#### Scenario: No board at start-up
- **WHEN** `agentboard mcp` starts where discovery finds no board
- **THEN** it exits 2 naming the path it looked at, before serving any request

#### Scenario: Excluded serve tool
- **WHEN** an MCP client calls the tool `board_serve`
- **THEN** the call returns a tool error with `exitCode` 1 and `reason` `usage`

#### Scenario: Excluded top tool
- **WHEN** an MCP client calls the tool `board_top`
- **THEN** the call returns a tool error with `exitCode` 1 and `reason` `usage`

#### Scenario: Excluded remote tool
- **WHEN** an MCP client calls the tool `board_remote`
- **THEN** the call returns a tool error with `exitCode` 1 and `reason` `usage`

#### Scenario: Excluded config tool
- **WHEN** an MCP client calls the tool `board_config_set` or `board_config_get`
- **THEN** the call returns a tool error with `exitCode` 1 and `reason` `usage`, and no event is written

#### Scenario: CLI-only flag is refused over MCP
- **WHEN** `board_claim` is called with `ttl` `30m`, `wait` true and `timeout` `10m`
- **THEN** the call returns a tool error with `exitCode` 1 and `reason` `usage`, and no event is written

#### Scenario: Health is a tool
- **WHEN** an MCP client lists tools
- **THEN** `board_health` is listed with the optional properties `stale-after`, `blocked-after`, `unplanned-within` and `check`

#### Scenario: Disposition over MCP
- **WHEN** an MCP client lists tools, then calls `board_move` with `{"id": "<T1>", "status": "merged"}` for an undisposed ad hoc ticket T1 in `review`, then with `{"id": "<T1>", "status": "merged", "unplanned": "hotfix"}`
- **THEN** `board_move` and `board_close` list the optional properties `task`, `change`, `group` and `unplanned`; the first call returns a tool error with `exitCode` 4, `reason` `needs-scope-disposition` and a hint naming both `task` and `unplanned`; the second succeeds with T1 in `merged`, and its events are byte-identical in body to those the CLI writes for the same arguments and actor on a copy of the board

## ADDED Requirements

### Requirement: Leases on the command line
`claim <id> --as <actor> [--ttl <duration>]` SHALL write, with `--ttl`, a
`ticket.claim` whose `lease` has that ttl, the board's `lease.grace` as
`grace`, and an `expiresAt` equal to the event's `ts.wall` plus the smaller
of the two. `renew <id> --as <actor> [--ttl <duration>]` SHALL write a
`ticket.renew` with the given ttl, or the lease's requested ttl when
`--ttl` is omitted, and an `expiresAt` equal to its `ts.wall` plus that
ttl, only when the actor is the assignee. `renew` SHALL check the
assignee first: an actor that is not the ticket's assignee SHALL exit 4
with reason `not-assignee` and write nothing, whether or not a well-formed
`--ttl` is given and whether or not the ticket has a lease (a malformed
`--ttl` is refused with exit 1 `usage` first, because arguments are parsed
before the board is opened), so a former holder whose
lock was force-released or handed to another actor learns that it lost
the lock. Only `renew` by the assignee without `--ttl` on a ticket with no
lease SHALL exit 1 with reason `usage`. A ttl SHALL be 1 to 5 ASCII digits
followed by `s`, `m`, `h` or `d`, between 30 seconds and 7 days
inclusive. Any other value SHALL exit 1 with reason `usage` and the
message `invalid --ttl: a ttl is <n>s, <n>m, <n>h or <n>d with <n> of 1
to 5 digits, from 30s to 7d`, which names the form and never repeats the
value given, so a token pasted as a ttl never lands in a terminal or a
log. The command SHALL build the event's hybrid timestamp before
validating, inside the same transaction, and SHALL validate with the
fold's rules against that timestamp. A claim on a ticket held by another
actor with no waiters SHALL be written as a takeover, with `supersedes`
filled from the current lease, only when the new event's `ts.wall` and the
local clock both read at least the lease's `expiresAt` plus 60000;
otherwise it SHALL be refused without writing. Callers SHALL NOT supply
`supersedes`. A takeover SHALL carry its own lease: a claim without
`--ttl` that would otherwise be written as a takeover SHALL exit 1 with
reason `usage` naming `--ttl` and write nothing, so a holder that took a
lock over and then crashed loses it like any other. A successful `claim
--ttl` SHALL print that the lease must be confirmed with `agentboard
renew <id>` before the grace period ends, and when.

`show` SHALL read only applied event files: a rejected file and a file not
yet folded SHALL NOT appear in its lease, queue, grant, takeover or forced
release lines, in human or `--json` output. `show` SHALL display a
ticket's lease (expiry as an ISO 8601 UTC time,
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
- **WHEN** `merger-1` claimed T1 with `--ttl 30m` and never renewed, 181 seconds have passed, the queue is empty and `claim T1 --as merger-2 --ttl 30m` runs
- **THEN** it exits 0, T1 is assigned to `merger-2`, and the claim's `supersedes` names `merger-1`, the grace expiry and the claim that set it

#### Scenario: Takeover needs a ttl
- **WHEN** the lease `merger-1` holds on T1 is claimable, the queue is empty and `claim T1 --as merger-2` runs without `--ttl`
- **THEN** it exits 1 with reason `usage` naming `--ttl`, no event is written, and T1 stays assigned to `merger-1`

#### Scenario: Expired but not yet claimable
- **WHEN** a lease expired 20 seconds ago and another actor runs `claim`
- **THEN** it exits 4 with reason `already-assigned`, no event is written, and `list` shows `<holder>!expired`

#### Scenario: Renew by someone else
- **WHEN** `merger-2` runs `renew T1` on a ticket held by `merger-1`
- **THEN** it exits 4 with reason `not-assignee` and no event is written

#### Scenario: Renew after the lock was force-released
- **WHEN** `merger-1` held T1 with `--ttl 30m`, `orchestrator` ran `release T1 --force --reason stalled` with no waiters, and `merger-1` runs `renew T1`, then `renew T1 --ttl 30m`
- **THEN** both exit 4 with reason `not-assignee`, not 1 `usage`, no event is written, and the hint says the lock was lost and names `agentboard show T1`

#### Scenario: Renew by the assignee without a lease
- **WHEN** `impl` claimed T1 without `--ttl` and runs `renew T1 --as impl`
- **THEN** it exits 1 with reason `usage` and no event is written

#### Scenario: Malformed ttl
- **WHEN** `claim T1 --as a --ttl 10min` or `claim T1 --as a --ttl 5s` runs
- **THEN** the command exits 1 with reason `usage` naming the duration form and the 30s to 7d range

#### Scenario: A refused ttl is not repeated
- **WHEN** `claim T1 --as a --ttl <token>` runs with a token-shaped value, with and without `--json`
- **THEN** it exits 1 with reason `usage`, and the token appears nowhere in stdout or stderr

### Requirement: Waiting on the command line
`claim <id> --as <actor> --ttl <duration> --wait --timeout <duration>`
SHALL claim at once, as `claim --ttl`, when the ticket is unassigned with
no waiters, and SHALL then print exactly what `claim --ttl` prints.
Otherwise it SHALL write a `ticket.queue.join` with the ttl (unless the
actor is already queued), print the actor's position (the line `queued for
<id> at position <n>, held by <holder or ->`), and block in the foreground
on the watch machinery until the wait ends. `--wait` SHALL never take over
a lease: on a ticket held by another actor it SHALL join the queue even
when the holder's lease is already claimable, and the ticket then passes to
it through a grant from the queue, due at the join's wall plus 1 when the
lapse lies before the join (see board-events "Grants"). The same holds for
`board_claim` with `wait` over MCP. The deadline SHALL be a monotonic clock
read when the wait starts plus the timeout, and whether it has passed SHALL
be decided on that monotonic clock alone, so a wall clock stepped back or
forward neither delays nor advances it (the wall clock is still the clock
of every catch-up and event). While it blocks it SHALL wake only on a
change notification for the events directory, on the watch machinery's
polling interval, at exactly the cache's grant watermark (the next time a
grant is due, see board-cache "Cache schema"; never later than the
deadline), at the deadline, and on SIGINT or SIGTERM; each wake SHALL catch
up as any command does, so it writes the grants that are due itself, and
the number of catch-ups SHALL be bounded by the wakes, never a busy loop.
After each catch-up, the first of these that applies ends the wait:

1. a grant to the actor is the ticket's current lease: it SHALL exit 0,
   printing the `list` line of the ticket and then `accept the grant with
   'agentboard renew <id> --as <actor>' before <acceptBy>`, where
   `<acceptBy>` is the grant's lease expiry as an ISO 8601 UTC time;
2. the actor has otherwise become the assignee (a hand-off or assign to a
   waiter): it SHALL exit 0 as a retried claim does (`already claimed by
   <actor>`), writing nothing;
3. at the deadline, or on SIGINT or SIGTERM: it SHALL end with one more
   transaction that decides after its own catch-up, since that catch-up
   can write a grant to the actor, or fold a hand-off to it, that the
   wake did not see. When the actor is then the assignee, at the deadline
   it SHALL write nothing and end as in 1 or 2 (exit 0: it holds the
   ticket and must renew), and on a signal it SHALL write a plain
   `ticket.release` (so the next waiter is granted) and exit 4 with
   reason `wait-interrupted` and the message `the wait for ticket <id>
   was interrupted after the ticket was given to you; you released it,
   so it passes to the next waiter` (also in the `--json` error
   document). When the actor is still queued it SHALL write
   `ticket.queue.leave`, and otherwise (it left the queue elsewhere
   meanwhile) nothing, and exit 4 with reason `wait-timeout` at the
   deadline and `wait-interrupted` on a signal. A refused leave is never
   ignored. When that transaction fails with exit 5 `busy` it SHALL be
   attempted once more (the busy timeout and one retry), and when that
   fails too it SHALL exit 5 with reason `busy` and a message naming
   `agentboard unqueue <id> --as <actor>`, the actor still queued. Any
   other error of that transaction SHALL end the wait with that error
   after one attempt, writing nothing (the actor stays queued, and a
   grant it is later given lapses after its window). A
   grant due at the deadline itself is therefore written and wins. A wake
   that already sees the actor holding the ticket ends as in 1 or 2 even
   if a signal arrives in the same wake; only a hold found by the ending
   transaction is released on a signal. The
   wait never exits non-zero while the actor holds the ticket, and an
   interrupted wait never exits 0 unless it holds the ticket, because
   exit 0 means the actor holds it and a script may go on to the
   critical step. The signal handlers SHALL be in place before the join
   is written and removed when the command returns, and the wait SHALL
   leave no abort listener, timer or watcher behind;
4. the actor is neither queued nor the assignee and the ticket is
   unassigned with no waiters (its join was rejected because the ticket
   became free, for example a release from another machine with an
   earlier wall arrived through `sync`): it SHALL claim instead (and when
   that claim finds the ticket taken meanwhile and joins, the wait goes
   on), as `claim
   --ttl`, and exit 0;
5. the actor is neither queued nor the assignee otherwise (it left the
   queue from another command, or a grant to it lapsed and passed on): it
   SHALL exit 4 with reason `invalid-queue`, writing nothing.

With `--json` a waiting claim prints one JSON document per line, as
`watch --json` does: the queued document `{queued, position, holder,
ticket}` when it joins (or finds itself queued), then the final document:
the claim result when it claimed, `{queued: false, grant, acceptBy,
ticket}` when granted (`grant` the grant's hash, `acceptBy` its lease
expiry in milliseconds), or the error document. A claim that claims at
once prints the one document `claim --ttl --wait` prints. The synchronous
in-process entry point (`runCli`) and `board_claim` over MCP never block:
over MCP `wait` joins and returns at once (see "Lease and queue tools over
MCP"), and `runCli` refuses a `claim --wait --timeout` that passed
validation with exit 1 `streaming-command`.

`--wait` SHALL require `--ttl` and, on the CLI, `--timeout` (1 to 5
digits and `s`, `m`, `h` or `d`, at most 1 day), checked in the same
order on every path (`--ttl`, then `--timeout`, then `--wait` without
`--ttl`), so the same invalid arguments give the same first error from
the executable and from the in-process `runCli`; otherwise it SHALL exit 1 with reason `usage`. A refused `--timeout` SHALL
exit 1 with reason `usage` and the message `invalid --timeout: a timeout
is <n>s, <n>m, <n>h or <n>d with <n> of 1 to 5 digits, from 1s to 1d`,
which names the form and never repeats the value given. `unqueue <id> --as
<actor>` SHALL write `ticket.queue.leave`, and SHALL exit 4 with reason
`invalid-queue` when the actor is not queued.

#### Scenario: Waiter is granted on release
- **WHEN** `merger-1` holds T1, `claim T1 --as merger-2 --ttl 30m --wait --timeout 10m` is blocking, and `merger-1` runs `release T1`
- **THEN** the waiting command writes or observes the grant to `merger-2`, exits 0 within 3 seconds of the release, and names `agentboard renew T1`

#### Scenario: Wait on a lapsed lease joins instead of taking over
- **WHEN** `merger-1` claimed T1 with `--ttl 30m` and never renewed, the lease is claimable, the queue is empty, and `claim T1 --as merger-2 --ttl 30m --wait --timeout 10m` runs
- **THEN** it writes a `ticket.queue.join`, not a claim with `supersedes`, prints `queued for <T1> at position 1, held by merger-1`, then writes or observes the grant to `merger-2` whose `after` names `merger-1`'s lease and whose wall is the join's wall plus 1, and exits 0 naming `agentboard renew T1`

#### Scenario: Wait times out
- **WHEN** a waiter's `--timeout 30s` passes (on the fake clock) with the holder still holding T1
- **THEN** the command writes `ticket.queue.leave`, exits 4 with reason `wait-timeout`, and `show T1` no longer lists it in the queue

#### Scenario: Wait needs a timeout on the CLI
- **WHEN** `claim T1 --as a --ttl 30m --wait` runs without `--timeout`
- **THEN** it exits 1 with reason `usage` and writes nothing

#### Scenario: Leave the queue
- **WHEN** `merger-3` is queued on T1 and runs `unqueue T1 --as merger-3`
- **THEN** it exits 0 and `show T1` no longer lists `merger-3`

#### Scenario: Waiter wakes when a grant falls due
- **WHEN** `merger-1` claimed T1 with `--ttl 30m` and never renewed, `merger-2` is waiting on T1, and no other command runs
- **THEN** the waiting command writes the grant to itself at the grant's slot time (the claim's wall plus 120000 plus 60000 plus 1) and exits 0, and it has not exited one millisecond before that time

#### Scenario: Timeout at the boundary
- **WHEN** a waiter started with `--timeout 30s` at time t0 is still queued
- **THEN** it is still waiting at t0 plus 29999 milliseconds and has written nothing, and at t0 plus 30000 it writes `ticket.queue.leave` and exits 4 with reason `wait-timeout`; when a grant to it falls due at exactly t0 plus 30000 instead, it is granted and exits 0

#### Scenario: Interrupted wait leaves the queue
- **WHEN** a waiting `claim --wait` receives SIGINT or SIGTERM
- **THEN** it writes `ticket.queue.leave`, exits 4 with reason `wait-interrupted`, and `show T1` no longer lists it

#### Scenario: Killed waiter stays queued
- **WHEN** a waiting `claim --wait` is killed with SIGKILL
- **THEN** it stays in the queue of T1, and a grant to it after a release lapses after the window and passes to the next waiter

#### Scenario: Join rejected because the ticket became free
- **WHEN** `merger-2` is waiting on T1 and a release by the holder with a wall earlier than `merger-2`'s join arrives late, so the join is rejected and T1 is free with no waiters
- **THEN** the waiting command claims T1 with its ttl and exits 0

#### Scenario: Grant written by the leave at the deadline
- **WHEN** a waiter reaches its deadline still queued and the transaction that would leave the queue finds, after its own catch-up, a grant to the waiter (its slot time passed, or the holder released, in between)
- **THEN** it writes no leave and exits 0 granted, naming `agentboard renew T1` and the acceptance deadline

#### Scenario: Hand-off racing the deadline
- **WHEN** `merger-1` hands T1 to the waiting `merger-2` just as `merger-2`'s deadline passes, so only the ending transaction's catch-up sees it
- **THEN** `merger-2` writes nothing and exits 0 as a retried claim, holding T1

#### Scenario: Grant or hand-off racing an interrupt
- **WHEN** a waiter receives SIGINT or SIGTERM and the ending transaction's catch-up finds T1 granted or handed to it
- **THEN** it writes a `ticket.release` (so the next waiter is granted), exits 4 with reason `wait-interrupted`, and its message says it released the ticket it was given

#### Scenario: Unqueue racing the deadline
- **WHEN** the waiter's actor runs `unqueue T1` elsewhere just as the waiter's deadline passes
- **THEN** the waiter writes nothing more and exits 4 with reason `wait-timeout`

#### Scenario: Busy leave
- **WHEN** the transaction that ends a wait fails with exit 5 `busy`
- **THEN** it is attempted once more; when that succeeds the wait ends as usual, and when it fails too the command exits 5 with reason `busy`, the actor still queued, and the message names `agentboard unqueue T1 --as <actor>`

#### Scenario: Wall clock stepped during a wait
- **WHEN** the wall clock is stepped back or forward by an hour while a waiter with `--timeout 30s` waits
- **THEN** it times out 30 seconds after it started, by the monotonic clock

#### Scenario: Waiter no longer queued
- **WHEN** `merger-2` is waiting on T1, still held by `merger-1`, and `unqueue T1 --as merger-2` runs from another shell
- **THEN** the waiting command exits 4 with reason `invalid-queue` and writes nothing

### Requirement: Forced release on the command line
`release <id> --as <actor> --force --reason <text>` SHALL write a
`ticket.release.force` naming the current assignee as `holder` and the
reason, when the ticket is assigned to an actor other than the caller.
`--force` without a non-empty `--reason`, `--reason` without `--force`,
and `--force` by the assignee itself SHALL exit 1 with reason `usage`
and write nothing. `--force` on an unassigned ticket SHALL exit 4 with
reason `not-assignee`. The reason SHALL be refused like comment text when
it matches a secret pattern (see "No secrets on the board"), and that
check SHALL run before the board is opened, so a secret-like reason is
refused with exit 1 even where no board is found. Forced
release SHALL NOT be restricted to a configured set of actors. `show`
SHALL display a forced release with its actor, the previous holder and the
reason.

#### Scenario: Orchestrator breaks a stale lock
- **WHEN** `merger-1` holds T1 and `release T1 --as orchestrator --force --reason "merger-1 crashed"` runs
- **THEN** it exits 0, T1 has no assignee (or, with waiters, a grant to the head waiter is due), and the event is a `ticket.release.force` with actor `orchestrator`, holder `merger-1` and that reason

#### Scenario: Force without a reason
- **WHEN** `release T1 --as orchestrator --force` runs
- **THEN** it exits 1 with reason `usage` and no event is written

#### Scenario: Secret-like reason without a board
- **WHEN** `release T1 --as orchestrator --force --reason "gone <token>"` runs with a token-shaped reason where no board is found
- **THEN** it exits 1 with reason `secret-like`, not 2, and the token does not appear in its output

#### Scenario: Force by the holder
- **WHEN** `merger-1` holds T1 and runs `release T1 --as merger-1 --force --reason x`
- **THEN** it exits 1 with reason `usage` and names plain `release`

### Requirement: Board settings command
`config set <key> <value> --as <actor>` SHALL write a `board.meta` event
for the keys `lease.grace` and `queue.window`, with the value given as a
duration (1 to 5 digits and `s` or `m`, between 30 seconds and 10
minutes) and stored in milliseconds; any other key or value SHALL exit 1
with reason `usage`. The refusal SHALL never repeat the key or value
given, so a token pasted there never lands in a terminal or a log: an
unknown key is refused with exactly `config set takes <key> as one of
lease.grace, queue.window` (`config get` likewise), and a refused value
with exactly `invalid value: a setting is <n>s or <n>m with <n> of 1 to 5
digits, from 30s to 10m`. `config get [<key>]` SHALL print the effective value
of one or both keys, marking defaults. `config` SHALL NOT be an MCP tool.

#### Scenario: Set the acceptance window
- **WHEN** `config set queue.window 5m --as orchestrator` runs
- **THEN** a `board.meta` event with key `queue.window` and value 300000 is written, and `config get queue.window` prints `5m`

#### Scenario: Unknown key
- **WHEN** `config set columns x --as orchestrator` runs
- **THEN** it exits 1 with reason `usage` listing the two keys

#### Scenario: A refused setting is not repeated
- **WHEN** `config set queue.window <token> --as orchestrator` or `config set <token> 5m --as orchestrator` runs with a token-shaped argument, with and without `--json`
- **THEN** it exits 1 with reason `usage`, nothing is written, and the token appears nowhere in stdout or stderr

### Requirement: Due grants are written during catch-up
Every command that catches up (every command except `rebuild` and
`rebuild --check`) SHALL, within its catch-up and under the write lock,
write each grant that is due (its slot time at or before the local clock)
and not yet present, exactly as the fold derives it, and fold it like a
late-arriving event. A read-only command SHALL take the write lock only
when there is something to fold, reap or grant. Catch-up SHALL read event
files to derive grants only when the local clock has reached the cache's
grant watermark (see board-cache "Cache schema").

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
an applied grant after a lapse (its `after.lease.holder`), the assignee
for a forced `ticket.reconcile` (its `holder`, see
board-openspec-integration "Reconcile on re-import"), and null for every
other event. For `ticket.grant` the entry's `to` SHALL be the
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
`wait-interrupted` SHALL say the actor left the queue and name the same
`--wait` form to wait again. `busy` from `claim` SHALL say that a waiting
actor is still in the queue and name `agentboard unqueue <id> --as
<actor>`.

#### Scenario: Hint for a live lease
- **WHEN** `claim T1 --as merger-2` is refused because `merger-1` holds a live lease
- **THEN** stderr has a `hint: ` line naming the claimable time and `--wait`

### Requirement: Lease and queue tools over MCP
The command registry SHALL define `renew`, `unqueue` and the `--ttl`,
`--wait`, `--timeout`, `--force` and `--reason` flags, so that `agentboard
mcp` lists `board_renew` and `board_unqueue`, `board_claim` gains optional
`ttl` and `wait` and `board_release` gains optional `force` and `reason`,
validated as on the CLI. `--timeout` SHALL be a CLI-only flag, absent from
the tool schema. `board_claim` with `wait` SHALL never block: when the
ticket is unassigned with no waiters it SHALL return the ordinary claim
result with `queued` false; otherwise (a held ticket, including one whose
lease is claimable, or one with waiters) it SHALL write the join and return
`{queued: true, position, holder, ticket}` at once. The grant SHALL be
delivered only through `board_inbox` as a `ticket.grant` entry.

#### Scenario: MCP tool list includes renew and unqueue
- **WHEN** an MCP client lists tools
- **THEN** `board_renew` and `board_unqueue` are listed, `board_claim` has optional `ttl` and `wait` and no `timeout`, and `board_release` has optional `force` and `reason`

#### Scenario: MCP wait returns at once
- **WHEN** `board_claim` is called with `wait` true and `ttl` `30m` on a ticket held by `merger-1` with one waiter
- **THEN** the call returns within one second with structured content `{queued: true, position: 2, holder: "merger-1", ticket: <id>}` and a join event is written

#### Scenario: MCP forced release matches the CLI
- **WHEN** `board_release` is called with `force` true, a `reason` and `as` `orchestrator` on a ticket held by `merger-1`
- **THEN** the written event's body is byte-identical to the one `release --force` writes for the same arguments and actor on a copy of the board

### Requirement: Re-import markers in list and show
`list` SHALL mark a superseded ticket with `[superseded] ` before its
title, after the scope marker (`[adhoc] ` or `[unplanned] `) and the
`[closed] ` marker when those apply.
`show` SHALL print `superseded: <reason>` after the `closed:` line for a
superseded ticket, and nothing for one that is not. `show` SHALL print a
removed checklist line at its own index, with its done flag and text,
followed by ` (removed)`. The `--json` documents carry the ticket as
folded: `superseded` (the reason, or null) and `removed: true` on a
removed line.

#### Scenario: Superseded marker
- **WHEN** the ticket of a group deleted from tasks.md is superseded and `list` runs
- **THEN** its line ends with `[superseded] <title>`, and `show` prints `superseded: group removed from <tasks file>`

### Requirement: Removed checklist lines are inactive
A checklist line removed by a reconcile SHALL be inactive on every
surface. It SHALL be excluded from every checklist count and progress
figure (the board card's done and total counts, `top`'s ticket detail,
the web app's cards and ticket detail); `show`, `top` and the web ticket
detail SHALL show it only marked as removed, and SHALL offer no tick,
checkbox or action for it. The `checklist tick` reminder SHALL map a
checklist index to the tasks-file line by counting only the ticket's lines
that are not removed, so it names the task line the ticked line stands
for.

#### Scenario: Count after a removal
- **WHEN** a ticket with lines `1.1 A` (done), `1.2 B` and `1.3 C` is reconciled with `1.2 B` removed
- **THEN** its card counts 1 done of 2, and `top`'s detail shows `checklist: 1/2`

#### Scenario: Show marks the removed line
- **WHEN** `show` runs for that ticket
- **THEN** it prints `  [ ] 1 1.2 B (removed)` and the other lines at their own indices

#### Scenario: No tick offered for a removed line
- **WHEN** the web ticket detail of that ticket is open on a writable server
- **THEN** lines `1.1 A` and `1.3 C` have a checkbox, and `1.2 B` is shown marked as removed with no checkbox

#### Scenario: Reminder after a removal
- **WHEN** a group's lines `1.1 Alpha`, `1.2 Beta` and `1.3 Gamma` are imported, `1.1 Alpha` is deleted from tasks.md and the change re-imported, and `checklist tick <id> 1` ticks `1.2 Beta`
- **THEN** the reminder names the line of `1.2 Beta` in tasks.md (line 2 when the group heading is line 1), not the line of `1.3 Gamma`
