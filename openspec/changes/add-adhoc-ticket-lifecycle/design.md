# Design

## Context

See proposal.md for the motivation. The current mechanics this change
works with:

- The gate is a fold rule. `moveTo` in `src/events/fold.ts` rejects a move
  (and a hand-off, which uses the same checks) into `implementing` when
  `task` is null, with `needs-task-link`. Because `review` and `merged` are
  reachable only through `implementing`, no ad hoc ticket can be in
  `review` or `merged` on any board written so far. `todo -> blocked` is
  allowed, and `close` is allowed from `blocked`, so boards may already
  contain ad hoc tickets closed from `blocked` with no link.
- `close` already has a disposition of its own (`--decision-recorded-in`
  or `--no-decision`), and its decision-comment rule is a CLI check, not a
  fold rule ("The fold does not apply the decision-comment rule").
- A command proposes exactly one event to `runCommand`
  (`src/store/transaction.ts`), which folds it in memory, writes its file
  and commits, all under one `BEGIN IMMEDIATE`.
- Event bodies with extra fields are malformed, and a malformed file met
  where a command needs it is exit 5. An event of an unknown kind is
  preserved, reported as unknown and affects no ticket.
- The health report (`src/view/health.ts`) is pure, shared by `health`,
  `board_health` and the web Health view; closed tickets appear in no
  section today.

## Goals / Non-Goals

**Goals:**
- Ad hoc tickets report real status through the whole flow.
- Merged or closed work is always traceable to a task or to an explicit,
  recorded acknowledgement that it was unplanned (ADR 0004's goal).
- No event that any earlier version wrote changes outcome under the new
  fold, except one that only a hand-written event could produce (see
  Compatibility).
- Agents are never pushed to invent references or external artifacts.

**Non-Goals:**
- Validating that a `--task` reference points at real planned work. That
  stays as ADR 0004 left it: only an adapter can, and only
  `import-change` asks.
- A `list --unplanned` filter, a standalone `unplanned` command, or a way
  to retract an unplanned disposition other than linking a task.
- Recording a disposition retroactively on a ticket already closed.
- Any change to tickets created with a task reference.

## Decisions

### 1. Remove the gate at `implementing`

`moveTo` loses the `needs-task-link` branch, and the reason is removed from
`RejectionReason`, `HINT_REASONS`, the hint table, the registry's
`EXIT_TASK_LINK`, the guide's exit-code line and the README. There is no
alias or deprecation period: no event file stores a rejection reason (the
fold recomputes them), so nothing on disk names it, and until 1.0 a minor
version may change exit reasons (CONTRIBUTING.md, "Releasing"). The spec
records the removal as a REMOVED requirement with its migration
(board-openspec-integration).

Alternatives: keeping the reason as a never-produced alias (dead code that
the "every reason has a hint" test would have to special-case); keeping
the gate but making `link` stricter (still blocks legitimately unplanned
work, see ADR 0013).

### 2. The scope disposition, and what `merged` and `close` mean

`merged` means the ticket's work has landed; `close` means the ticket
leaves the board, from `merged` (done) or from `blocked` (abandoned or
superseded). Both are exits, so both require a scope disposition for a
ticket that has none: a task reference (`--task`, or `--change --group`)
or an unplanned disposition (`--unplanned <reason>`). In practice:

- `move <id> merged` on an undisposed ticket needs a flag.
- `close` of a ticket in `merged` never needs one, because it could only
  have entered `merged` with a disposition.
- `close` of an undisposed ticket in `blocked` needs one. For abandoned
  work `--unplanned "abandoned: ..."` is the honest record, and it keeps
  "no ad hoc ticket leaves the board undisclosed" a simple rule.
- A ticket linked with `link` earlier, or given an unplanned disposition
  earlier, needs nothing more.

The name "scope disposition" keeps it distinct from close's existing
"decision disposition" (and from the exit 1 reason `no-disposition`, which
is about the decision flags). The refusal reason is
`needs-scope-disposition`, exit 4 because it depends on board state.

### 3. Event design: a new kind `ticket.unplanned`, and `ticket.link` for `--task`

- `--task` writes an ordinary `ticket.link {task}`: it is exactly what
  `link` would write, so the result is indistinguishable from linking
  first, and older versions fold it.
- `--unplanned <reason>` writes a new kind, `ticket.unplanned {reason}`
  (`reason` a non-empty string, no other field). Fold: rejected
  `already-linked` when `task` is not null; otherwise sets
  `ticket.unplanned = {reason, actor, ts}` (replacing any earlier one) and
  changes nothing else. A task link clears it, as it clears `adhoc`.
  `adhoc` itself is kept, so the creation reason stays visible.
- `Ticket` gains `unplanned: {reason: string, actor: string, ts: Hlc} |
  null` (null at create); the cache `tickets` table gains an `unplanned`
  JSON column, and `CACHE_SCHEMA_VERSION` goes up by one so existing caches
  are rebuilt. `rebuild --check` compares it like any column.
- `describeEvent`: `recorded as unplanned: <reason>`.

Alternatives considered:
- **A `disposition` field on `ticket.move` and `ticket.close`.** One event
  per command, but an older version would find an extra body field,
  report the event malformed, never fold the merge or close, and exit 5
  on commands that need the file. Rejected.
- **An `unplanned` target on `ticket.link`.** Same malformed-on-older
  problem, and `link` is "exactly one target", which would then mix a
  planning link with its absence.
- **A combined `ticket.merge` kind.** Older versions would see an
  unknown kind and never learn the ticket merged; it also duplicates the
  state machine.

With a separate kind, an older version keeps the event as unknown and
folds the move or close normally; only the disclosure is invisible to it.

### 4. Two events, one transaction

`runCommand` accepts an operation that proposes an ordered list of one or
two events. Each is validated by folding it in memory against the state
the previous one left; any rejection refuses the whole command with that
event's reason, and nothing is written. Each gets the next hybrid
timestamp (wall, then counter + 1), so the disposition always sorts
before its move or close. Files are written in that order, then the cache
rows, the `folded` records and the commit. The returned hash is the last
event's; `--json` adds `events` with both hashes.

Crash consistency: dying after the disposition file is renamed but before
the move or close file leaves a ticket with a disposition and its old
status. That is a valid state (the next `move merged` needs no flag), so
no recovery logic is needed. The reverse order cannot happen.

Alternatives: two separate transactions (another writer can interleave,
and a refusal of the second leaves the first committed); a separate
`unplanned` command run before the move (one more step for every agent,
and the refusal could not be fixed on the spot).

### 5. Where each rule lives: fold for `merged`, CLI for `close`

- **Into `merged` (move and hand-off): a fold rule**, like the old gate.
  `moveTo` rejects `to === 'merged'` when `task` and `unplanned` are both
  null, with `needs-scope-disposition`. The fold is the source of truth,
  so the invariant "every ticket in `merged` has a task or an unplanned
  disposition" holds on every replica whatever wrote the events. No event
  written by an earlier version changes outcome under it, because no ad
  hoc ticket could reach `review` before.
- **Close: a CLI check in `closeTicket`**, like the decision-comment rule.
  Boards written before this change may hold closes of ad hoc tickets from
  `blocked`; a fold rule would reject them on the next rebuild and reopen
  those tickets. The health report lists them instead (see 7).

Check order for `close`: usage (both or neither decision flags; both
scope dispositions; malformed task reference; empty reason; secret-like
reason) before the board is opened; then the decision path checks; then
closability (exit 4 `invalid-transition`); then the scope disposition
(exit 4 `needs-scope-disposition` or `already-linked`); then the decision
guard (exit 1 `unpromoted-decision`). For `move`: usage (both flags; a
flag without the target `merged`, including the target-less return from
`blocked`), then the fold's own order over the two events (the
disposition event first, so `already-linked` before `invalid-transition`,
then `invalid-transition` before `needs-scope-disposition`).

### 6. Flags

- `move` and `close` gain `--task`, `--change`, `--group` and `--unplanned`
  through the existing `TASK_FLAGS` and an exclusive group `{task |
  change+group | unplanned}`, parsed with `taskRefFromArgs`, so the
  validation and messages are `link`'s. `move` and `close` also gain
  `--allow-secret-like`, which only affects `--unplanned`.
- `--task` on a ticket that is already linked is accepted and replaces the
  reference, exactly as `link` does.
- `--unplanned` on a ticket that is already unplanned records the new
  reason (a second `ticket.unplanned`).
- `handoff` gains no flags: a hand-off into `merged` is rare, and its hint
  points at `move <id> merged` with either flag. Its exit codes list
  `needs-scope-disposition` but not `already-linked`: a command lists
  every code it can produce, and a hand-off never writes a
  `ticket.unplanned`.
- The scope check of `close` applies to every closable status, `merged`
  included: a merged ticket with neither a task reference nor an unplanned
  disposition can only come from outside agentboard, and `close` refuses
  it with `needs-scope-disposition` like a blocked one (which is why
  `close-merged` lists it as skipped, below). When `close` is given a
  disposition, the section 5 order still holds: a ticket that is not
  closable gets only the `ticket.close` proposed, so it is
  `invalid-transition` whatever the flag; a closable linked ticket given
  `--unplanned` is `already-linked` before the decision guard, so an open
  `DECISION:` comment is reported only once the scope is settled.
- MCP and the web action bodies get `task`, `change`, `group` and
  `unplanned` from the registry with no extra code. The web server refuses
  a secret-like `unplanned` with no override, as for comments.
- `close-merged` passes no disposition; a merged ticket with none (only
  possible from a hand-written event) is skipped and listed with
  `needs-scope-disposition`.

### 7. Health: `unplannedScope`

A ticket is unplanned scope when it has an unplanned disposition and is
in `merged` or closed, or when it is closed with an ad hoc reason, no task
and no unplanned disposition (closed before this change, or closed by an
older version). The report gains:

```
thresholds.unplannedWithin: number            // ms, default 7 days
unplannedScope: {
  total: number,                              // all such tickets, any age
  tickets: Array<{
    ticket: Card,                             // as other sections
    adhoc: string | null,                     // the creation reason
    reason: string | null,                    // the unplanned reason; null for an undisclosed close
    outcome: 'merged' | 'closed',             // 'merged' if it ever reached merged
    since: HealthEventRef,                    // the applied ticket.unplanned, else the ticket.close
    ageMs: number,
  }>,                                         // since.ts.wall within the window, most recent first, then id
}
```

`unplannedWithin` is set with `--unplanned-within <duration>` (the same
duration grammar), the MCP property `unplanned-within`, and a third input
in the web view. A window rather than the full list keeps the text output
short on a long-lived board while `total` keeps the all-time count. There
is no severity: `health` always exits 0, and the web view styles the
section as information (neutral, like the cache check when it matches),
not like stale claims or stuck tickets. It is the one section that
includes closed tickets, because closed is where unplanned work ends up.

Decisions taken in task group 3:
- The window is exclusive: an entry is listed when `ageMs <
  unplannedWithin` (one exactly that old is counted in `total` but not
  listed), matching "less than `unplannedWithin` old"; `staleAfter` and
  `blockedAfter` stay inclusive ("at least").
- The `thresholds:` line of the text report is unchanged (stale after,
  blocked after); the window is shown in the unplanned scope heading.
- In the web view severity is a class: `warning` on the stale claims and
  stuck in blocked sections, `info` on the unplanned scope section, which
  never carries `warning`.
- `Card.unplanned` (section 8) is added with the health section, so every
  health list line shows `[unplanned]`; task 4.1 keeps the card scenario,
  the web card and `describeEvent`.

Text output, after the close-merged sections:

```
unplanned scope: 2 in the last 7d (5 in all)
01M3...  merged  reviewer-1  [unplanned] Fix login redirect  merged 2h ago, unplanned: production hotfix
01M3...  blocked  -  [adhoc] [closed] Try a new parser  closed 3d ago, no reason recorded (ad hoc: spike)
```

### 8. Presentation

- `list`: `[unplanned] ` replaces `[adhoc] ` when `unplanned` is set
  (`render.ts` `listLine`); a linked ticket shows neither.
- `show`: after the `adhoc: <reason>` line, `unplanned: <reason> (by
  <actor>)`. `--json` (show, list, writing commands) carries the
  `unplanned` object.
- View-model card: `unplanned: {reason} | null` beside `adhoc`; the web
  card shows "unplanned" in place of "ad hoc"; the web and TUI ticket
  detail show the reason.
- Web card: when the ticket has no task reference and `unplanned` is set,
  the marker `unplanned` (`span.task.unplanned`) followed by the reason
  (`span.unplanned-reason`), never `ad hoc`, because `Card.adhoc` carries
  no reason and the proposal says the web card shows one.
- Web ticket detail: an `Unplanned` field, `<reason> (by <actor>)`,
  right after `Task`; TUI ticket detail: the line `unplanned: <reason>
  (by <actor>)` right after `task:`. Both are the line `show` prints.
- Web move control and close form: for a ticket with neither a task
  reference nor an unplanned disposition, the move control (only while
  the chosen target is `merged`) and the close form add a `Scope` select
  (`unplanned reason`, then `task reference`) and a `Value` text input,
  and send the value as the `unplanned` or `task` property. `unplanned`
  is selected initially, because an undisposed ad hoc ticket at merge
  usually has no plan to link; the task option is one click away. The
  entries are kept while another target is chosen (that body carries
  only the status), on a refusal and across a detail reload.
- Secret-like reasons from the browser: the unplanned reason goes through
  the same check as comments and hand-off notes, and `allow-secret-like`
  stays refused with 400 `usage` on `move` and `close` as on every action
  (ADR 0009); a false positive is written with the CLI.

### 9. Guidance

- Guide, "Tickets and planning tasks": replace the three lines about
  `needs-task-link` with: an ad hoc ticket is worked like any other;
  whoever merges or closes it gives its scope, the task it delivers or why
  it was never planned, with `agentboard move <id> merged --unplanned
  "<reason>" --as <actor>` (or `--task`; `close` takes the same flags);
  never create an issue, task file or task reference only to move a
  ticket. The exit 4 line lists `needs-scope-disposition` and
  `already-linked`. The orchestrator checklist gains one line. The
  orchestrator output is 149 lines today, so the limit in "Agent guide"
  becomes 180, the same value `add-claim-leases` sets.
- Guide, "What the board is and is not": the "not a source of scope" line
  says every ticket names the planned task it delivers, or discloses that
  its work was unplanned before it is merged or closed (ADR 0013's
  amendment of ADR 0004), so it no longer contradicts the ad hoc text.
- Hints: `needs-scope-disposition` renders both forms of the refused
  command (`move <id> merged ...` or `close <id> <decision flag> ...`)
  and "do not create an issue or task only to satisfy this";
  `already-linked` names the linked reference and the command without
  `--unplanned`.
- The tick reminder for an ad hoc ticket adds that its link or unplanned
  disposition is given when it is merged or closed.
- Help: `move` and `close` descriptions and an `--unplanned` example;
  `new`'s `--adhoc` description says the ticket is worked normally.
- Installed text: a sixth rule; `GUIDANCE_VERSION` goes up by one from
  whatever it is when the guidance group lands (2 if `add-claim-leases`
  has not landed its guidance, 3 if it has). The MCP instructions summary
  must not mention the old gate and stays within 2000 characters. It
  need not state the ad hoc rule: the guide and the installed text carry
  it, and the `needs-scope-disposition` hint names both flags when a tool
  call is refused. Its text is unchanged by this change.
- Out of scope: the browser-facing secret-like message and hint (a
  follow-up from the group 4 review, ADR 0009) still say to pass
  `--allow-secret-like`. Telling the browser to shorten or redact the
  text instead needs a web hint surface and a board-web-actions delta, so
  it is left to a follow-up change.

### 10. Mutex tickets

The mutex tickets of `add-claim-leases` are standing ad hoc tickets that
are claimed and released and never merged or closed while in use, so no
command they use is affected. If one is ever retired, it is moved to
`blocked` and closed like any abandoned ad hoc ticket, with `--unplanned`
(for example "mutex retired"). This change touches no lease, queue or
grant rule.

## Risks / Trade-offs

- [Mixed versions on one board] An older version still rejects an ad hoc
  ticket's move into `implementing` (`needs-task-link`), so a board shared
  by old and new versions folds differently once an upgraded machine moves
  an ad hoc ticket past `tests`. -> README and the release notes say every
  machine sharing a board upgrades first, as `add-claim-leases` does for
  its new kinds. Older versions otherwise keep `ticket.unplanned` as an
  unknown kind and fold the merge and close.
- [Refold of a stored rejection] A `ticket.move` into `implementing` that
  an older fold rejected as `needs-task-link` would now apply. The CLI
  refuses before writing, and a link is never removed, so such an event
  can exist only if written outside agentboard. -> Accepted; recorded here.
- [`--unplanned` becomes the easy path] Agents might mark everything
  unplanned. -> It is disclosed with a reason in `health`, `list`, `show`
  and the web app, which is the point: visible, not blocked. The guide
  says to link when planning exists.
- [Two events per command] The transaction path gets a second shape. ->
  The concurrency and crash tests of the fold/event group cover it, and
  that group gets a second reviewer.

## Migration Plan

No data migration. The cache schema version bump rebuilds caches on first
use. Existing linked tickets and planned tickets are unaffected; ad hoc
tickets in `todo` or `tests` can now move. Upgrade every machine sharing
a board before moving ad hoc tickets past `tests`. Rollback: an older
version keeps reading the board (unplanned dispositions become unknown
events), but tickets that moved past `tests` without a link fold back to
`tests` there.

## Overlap with in-flight changes

- `add-claim-leases` restates board-cli "Command surface" and "MCP
  server" (adding `renew`, `unqueue`, `config` and claim flags),
  board-events "Event kinds" and "Fold semantics" (its text still names
  `needs-task-link`), board-cache "Cache schema" and "One command, one
  transaction", board-view-model "Activity feed entries" and
  board-agent-guidance "Agent guide" (also 180 lines). It also plans an
  ADR; this proposal ships ADR 0013, so that one takes the next free
  number.
- `add-board-sharing` restates board-cli "Command surface" and "MCP
  server" (adding `remote`).
- The draft `add-harness-integration` also restates "Command surface" and
  "MCP server".

This change's MODIFIED text restates the main specs as they are now.
Whichever change is archived later re-syncs each shared requirement with
the main spec first, keeping the other changes' additions (and, for
`add-claim-leases`, dropping `needs-task-link` from its fold text).
