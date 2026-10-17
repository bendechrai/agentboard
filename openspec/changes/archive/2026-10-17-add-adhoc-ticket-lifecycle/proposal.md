# Proposal

## Why

An ad hoc ticket (created with `--adhoc <reason>`) cannot move into
`implementing` until it is linked to a planned task (exit 4,
`needs-task-link`), and `review` and `merged` are reachable only through
`implementing`. In any project where some work is legitimately unplanned
(a bug found while using the product, a maintenance fix, a project whose
planning lives somewhere agentboard cannot see), every such ticket stays
in `todo` while the work is done, reviewed and merged elsewhere, and the
board stops reporting status: the tickets collect "ready for review"
comments instead of moving.

The gate also assures nothing. `link --task` accepts any
`<source>:<ref>#<item>` with a lowercase source, so `adhoc:fix#1` passes
it. Its only effect is to push agents to invent references, or to create
external artifacts (a public issue, a throwaway task file) just to satisfy
a move. What ADR 0004 actually wants is that merged work is traceable
either to a plan or to an explicit acknowledgement that it was not
planned. This change keeps that goal and moves the check to where it
means something: the point where work is merged or closed.

## What Changes

- **BREAKING (refusal removed):** ad hoc tickets move through `todo`,
  `tests`, `implementing` and `review` like any other ticket, and can be
  blocked and handed off. The `needs-task-link` refusal is removed from
  the fold, the CLI, MCP, the hints and the exit code tables. Clients
  that matched on that reason no longer see it.
- The check moves to the exit. Moving an ad hoc ticket to `merged`, or
  closing one, needs a **scope disposition**, given on the same command:
  - `--task <source>:<ref>#<item>` (or `--change <name> --group <n>`):
    link it now to planning that exists, validated exactly as `link`;
  - `--unplanned <reason>`: accept it as scope that was never planned.
  Without one the command is refused with exit 4 and the new reason
  `needs-scope-disposition`, whose hint names both flags. A ticket linked
  earlier with `link`, or one that already has an unplanned disposition,
  needs nothing more.
- A new event kind `ticket.unplanned` (`{reason}`) records the unplanned
  disposition; `--task` writes an ordinary `ticket.link`. The command
  writes the disposition event and then the `ticket.move` or
  `ticket.close` in one transaction, all or nothing. The fold refuses a
  move or hand-off of an undisposed ticket into `merged`
  (`needs-scope-disposition`) and refuses `ticket.unplanned` on a ticket
  that has a task reference (`already-linked`). The close rule is the
  CLI's check, as the decision-comment rule is, because boards written
  before this change may already contain closes of ad hoc tickets.
- Unplanned scope is visible, not blocked: `health` (text, `--json` and
  `board_health`) gains an `unplannedScope` section listing tickets
  merged or closed as unplanned with their reasons, within a new
  `--unplanned-within` window (default 7 days), plus the all-time count.
  It is information, never a failure. The web Health view shows the same
  section. `list` shows `[unplanned]` in place of `[adhoc]` once the
  disposition is recorded, and `show`, the web card and the ticket views
  show the reason.
- Guidance: the agent guide, the hints, the tick reminder, command help
  and the installed `claude` and `agents-md` text say to work an ad hoc
  ticket normally, to leave the link or the unplanned disposition to
  whoever merges or closes it, and never to create an issue, task file or
  task reference only to satisfy a move. The "cannot enter implementing
  until linked" text is removed. The guidance version goes up by one.
- The web app's move and close controls offer the two dispositions for an
  undisposed ad hoc ticket; the action endpoints accept them as they
  accept every registry argument.
- ADR 0013 records the decision and amends ADR 0004.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `board-openspec-integration`: "Tickets reference tasks" is removed
  (its `needs-task-link` gate) and restated as "Tickets reference tasks
  or are ad hoc" and "Ad hoc markers in list"; "Scope disposition at
  merge and close" is added; "Close merged" skips a merged ticket without
  a disposition.
- `board-events`: the `ticket.unplanned` kind, the fold rules
  (`needs-task-link` removed, `needs-scope-disposition` and
  `already-linked` added, a task link clears an unplanned disposition),
  and the `unplanned` field of the folded ticket.
- `board-cli`: `move` and `close` gain the disposition flags; `health`
  gains `--unplanned-within`; "Command surface", "MCP server", "Exit
  codes" and "No secrets on the board" restated; a new requirement for
  the scope disposition on the command line.
- `board-cache`: the `unplanned` column (cache schema version bump), and
  a command may write a disposition event and its move or close in one
  transaction.
- `board-insights`: the `unplannedScope` section of the health report,
  the `health` command and the web Health view.
- `board-agent-guidance`: the agent guide's ad hoc text, the hints, and
  the installed guidance rule.
- `board-view-model`: the card's unplanned marker and the feed summary of
  `ticket.unplanned`.
- `board-web-actions`: the move and close controls offer the disposition;
  the unplanned reason is checked for secrets.

## Impact

- `src/events/schema.ts` (the `ticket.unplanned` kind), `src/events/fold.ts`
  (`moveTo`, the `unplanned` field, the new reasons, `needs-task-link`
  removed), `src/store/transaction.ts` (an operation may propose a short
  sequence of events), `src/store/cache.ts` and the schema version.
- `src/board/actions.ts` (`moveTicket`, `closeTicket`),
  `src/board/merged.ts` (`close-merged` skip), `src/cli/registry.ts`,
  `src/cli/render.ts`, `src/mcp/*` (generated from the registry),
  `src/view/*` (`healthReport`, cards, `describeEvent`), `src/web/client/*`
  (Health view, move and close controls, ticket detail), `src/tui/frame.ts`
  (ticket detail), `src/guidance/*` (guide, hints, help, installed text,
  `GUIDANCE_VERSION`), `src/board/reminder.ts`.
- Compatibility: boards need no migration. Tickets already linked are
  unaffected, and an ad hoc ticket in `todo` or `tests` simply gains the
  ability to move. Older versions keep `ticket.unplanned` events as
  unknown kinds and fold everything else, but they still refuse an ad hoc
  ticket's move into `implementing`, so every machine sharing a board
  must upgrade before an ad hoc ticket is moved past `tests`.
- README.md, `adr/0013-unplanned-scope-is-disclosed-not-blocked.md`, the
  ADR index, STATUS.md, and this repository's installed guidance.
- No new dependencies.
