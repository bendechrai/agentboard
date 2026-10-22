# 13. Unplanned scope is disclosed, not blocked

Date: 2026-10-13

## Status

Accepted. Amends ADR 0004 (see Consequences).

## Context

ADR 0004 gave every ticket a task reference so that the board never
introduces scope of its own, and allowed a ticket without one only when it
is created with `--adhoc <reason>`. The board-openspec-integration spec
then refused to move an ad hoc ticket into `implementing` until it was
linked to a task (`needs-task-link`). Because `review` and `merged` are
reachable only through `implementing`, an ad hoc ticket could never get
further than `tests`.

Some work is legitimately unplanned: a bug found while using the product,
a maintenance fix, work in a project whose planning lives where agentboard
cannot see it. For such work the gate does not stop anything; the work is
done, reviewed and merged anyway, and the ticket stays in `todo`
collecting "ready for review" comments. The board stops reporting status
exactly where a supervisor needs it.

The gate also assures nothing. `link --task` accepts any well-formed
`<source>:<ref>#<item>`, so `adhoc:fix#1` satisfies it, and the schema
cannot check that a reference points at real work (ADR 0004,
Consequences). Its practical effect is to push agents to invent references
or to create external artifacts, such as a public issue or a throwaway
task file, solely to make a move succeed.

What ADR 0004 is for is traceability: merged work can be traced to a plan,
or to an explicit acknowledgement that it was not planned.

## Decision

- Ad hoc tickets move through `todo`, `tests`, `implementing` and `review`,
  and are blocked, handed off, claimed and released, like any other
  ticket. The `needs-task-link` refusal is removed.
- The check moves to the exit. Moving a ticket into `merged`, or closing
  it, requires a scope disposition when the ticket has none: either a task
  reference (`--task <source>:<ref>#<item>`, validated as `link` validates
  it) or an unplanned disposition (`--unplanned <reason>`), given on the
  same command. Without one the command is refused with exit 4,
  `needs-scope-disposition`. A ticket linked earlier needs nothing more.
- The unplanned disposition is an event of its own, `ticket.unplanned
  {reason}`, written in the same transaction as the move or close and
  before it. A task disposition is an ordinary `ticket.link`.
- The rule for `merged` is a fold rule, so every ticket in `merged` has a
  task or an unplanned disposition on every replica. The rule for `close`
  is the CLI's check, like the decision-comment rule, because boards
  written before this decision may contain closes of ad hoc tickets.
- Unplanned scope is shown, never treated as a failure: `health`,
  `board_health` and the web Health view list tickets merged or closed as
  unplanned with their reasons; `list`, `show` and the web cards mark
  them.
- Guidance tells agents to work an ad hoc ticket normally, to leave the
  link or the unplanned disposition to whoever merges or closes it, and
  never to create an issue, task file or task reference only to satisfy a
  move.

## Rationale

A check is worth having where it can be answered truthfully. At the start
of work, "which planned task is this?" often has no honest answer for
unplanned work, so the gate produced fabricated answers or stalled
tickets. At merge or close, "was this planned, and if so, where?" always
has an honest answer, and the person or agent merging is the one best
placed to give it. Recording the answer as data, rather than refusing,
turns unplanned scope into something a supervisor can see and count.

A separate event kind keeps older versions working: they preserve an
unknown kind and fold the move or close around it, where a new field on
`ticket.move` or `ticket.close` would make those events malformed to them.

## Consequences

- ADR 0004 is amended: "every ticket must reference the planned work it
  delivers, so that the board never introduces scope of its own" now
  reads as "every ticket that leaves the board's flow references the
  planned work it delivered, or discloses that it was unplanned".
  The task reference format, source adapters and shorthand are unchanged.
- A command may write two events (the disposition, then the move or
  close) in one transaction. A crash between them leaves a disposition
  without its move, which is a valid state.
- Older versions keep `ticket.unplanned` as an unknown kind, but still
  refuse an ad hoc ticket's move into `implementing`, so every machine
  sharing a board must upgrade before an ad hoc ticket moves past `tests`.
- Closed ad hoc tickets from before this decision have no recorded
  disposition; the health report lists them as unplanned scope with no
  reason instead of rejecting them.
- `--unplanned` is an easy path. That is accepted: it is visible, with a
  reason, wherever the ticket is shown.

## Alternatives considered

**Keep the gate at `implementing`.** It stalls legitimately unplanned work
and produces invented references, while assuring nothing, as described in
Context. Rejected.

**Require a synthetic `adhoc:` source.** Make ad hoc tickets link to
`adhoc:<something>#<n>` to pass the gate. That writes a lie into the task
reference (it names no planning tool and no planned work), pollutes
`list --task` and adapter lookups, and is the fabrication this decision
removes. Rejected.

**Allow a free-form task reference.** Let `--task` take any text so that
"no plan" can be written as a reference. ADR 0004 rejected free-form links
because nothing could route or filter them; it would also blur planned and
unplanned work in one field. Rejected in favour of a separate, explicit
unplanned disposition.

**Block merge entirely for unplanned work.** Refuse `merged` and `close`
for any ad hoc ticket without a real task. The work merges anyway, outside
the board, so the board would again stop reporting status, and the only
way through would be creating planning artifacts to satisfy the tool.
Rejected.
