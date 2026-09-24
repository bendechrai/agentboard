# Proposal

## Why

With `add-board-web` a human can watch the board but still has to switch
to a shell to act on what they see: answer a question in a ticket's
thread, unblock a ticket, take over a stale claim, hand work back to an
agent, or close a merged ticket with its decision recorded. Doing that
from the page they are reading is the natural next step, as long as it
goes through exactly the same rules as the CLI and cannot be triggered by
another web site.

## What Changes

- `agentboard serve --as <actor>` enables write actions in the web app, as
  that actor only; without `--as` the server stays read-only.
  `AGENTBOARD_ACTOR` never enables writes, so an agent's environment
  cannot turn a viewer into a writer by accident.
- `POST /api/actions/<action>` for `comment`, `move`, `claim`, `release`,
  `handoff`, `checklist-tick`, `checklist-untick`, `link` and `close`. Each
  takes the same arguments as the command's MCP tool, is converted and
  validated by the same code as an MCP call, and runs the command's own
  operation in its single `BEGIN IMMEDIATE` transaction. Refusals carry
  the same reason, message and hint as the CLI; secret-like text is still
  refused; `close` keeps the decision disposition rules, with decision
  paths relative to the working tree root.
- Protection against cross-site request forgery on top of the access
  token: `SameSite=Strict` cookie, an exact `Origin` check, a per-run CSRF
  token sent in a custom header, JSON bodies only, a body size limit.
- Action controls on the ticket detail, with refusals shown beside the
  control with their hint.

## Capabilities

### New Capabilities
- `board-web-actions`: write mode, the action endpoints, close rules from
  the browser, secret-like refusal, CSRF protection and the action
  controls.

### Modified Capabilities
- `board-web`: "Serve command" takes `--as`; "Read-only server" permits
  the action endpoints when writable; "JSON API" adds `csrf` to the
  session. Requires `add-board-web` to be archived first.
- `board-cli`: "Actor is explicit" states the `serve` exception (explicit
  `--as` only, `AGENTBOARD_ACTOR` ignored).

## Non-Goals

- Creating tickets (`new`), `import-change`, `close-merged`, `sync` or
  `rebuild` from the browser: they are orchestrator or maintenance
  operations, run from a shell.
- An override for secret-like text in the browser.
- Several actors per server, or choosing the actor per request.
- Any new event kind or schema change.

## Impact

- New source: `src/web/actions.ts` (routing, CSRF checks, mapping to the
  registry and the MCP argument conversion) and action components in
  `src/web/client/`. The MCP argument conversion (`toolArguments`) and the
  run-context building shared by the CLI and MCP are reused, not copied.
- No new dependency.
- New reasons with hints: `read-only`, `csrf-failed`, `body-too-large`.
- README section; ADR 0006 gains a section on write mode (or ADR 0009 if
  0006 has been accepted by then).
