# Proposal

## Why

The actor (`--as`, `AGENTBOARD_ACTOR`, the MCP tool argument `as`, the
actor given to `agentboard mcp --as` and to `agentboard serve --as`) is
written into every event its caller creates, and those events are synced,
shared with every clone of the board and kept forever: an event file is
content-addressed, so nothing written can be rewritten. The actor is also
repeated in messages (`already claimed by <actor>`) and in hints
(`agentboard inbox --as <actor>`). Yet it is never checked against the
secret patterns that free text is (board-cli "No secrets on the board").
A token pasted as the actor, or substituted into it by a mistyped
variable (`AGENTBOARD_ACTOR=$GITHUB_TOKEN`, an MCP client configuration
that expands the wrong variable), is committed to the board permanently
and echoed in every hint that names the actor. The same holds for the
other actor name the caller supplies, the new assignee of `handoff --to`.

`no-echo-refusals` left the actor out of its rule on purpose, because it
is accepted input with no shape (its design.md, "Out of scope"), and filed
this follow-up. Ticket 01M5Y9MQB9E3969DZ29VX5MZD0.

## What Changes

- An actor name (the actor of a command, from `--as`, `AGENTBOARD_ACTOR`
  or the tool argument `as`, and the new assignee of `handoff`, from
  `--to` or the tool or body argument `to`) SHALL pass the actor check
  before anything is written: it matches none of the secret patterns, and
  it has the actor form, 1 to 32 ASCII letters, digits, `.`, `_`, `-` or
  `@`, the first a letter or digit. Every actor on this repository's own
  board (77 names in 950 events when proposed, 91 in 1032 by review, the
  longest 15 characters) and every
  example in the docs (`orch`, `impl-1`, `reviewer-3-2`, `merger-2`,
  `ben`) has that form.
- A name that fails is refused with exit 1 and the new reason
  `invalid-actor` (400 on the web), writing nothing. `--allow-secret-like`
  does not apply: an actor is an identity, not content, and a false
  positive is fixed by choosing another name.
- The refusal names where the actor came from (`--as`, `AGENTBOARD_ACTOR`,
  `--to`, the tool argument `as` or `to`) and never repeats the name, and
  no message or hint repeats an actor that has not passed the check (a
  read command's unchecked `AGENTBOARD_ACTOR`, the actor of a call whose
  parsing failed): it writes `<actor>` instead.
- Surfaces: every CLI command that accepts `--as` (as for the reserved
  actor today, a read command refuses a failing `--as` too); commands that
  need an actor check `AGENTBOARD_ACTOR` when they fall back to it;
  `agentboard mcp --as` and `agentboard serve --as` refuse to start; MCP
  tool calls check `as`, the server's fallbacks and `to`; the web app
  checks the `to` of a hand-off. No `init` or `agents install` path
  records an actor, so none gains a check beyond the `--as` every command
  checks.
- Existing events are unchanged and still folded whatever their actor:
  the actor form is a rule for writing, not for event validity, so no
  board's history becomes malformed and older versions writing to a
  shared board still converge.
- The agent guide, `help` for `--as` and `--to`, the exit codes of the
  commands that take an actor, and README's "The actor rule" state the
  form and the refusal.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `board-cli`: MODIFIED "Actor is explicit" (every command refuses an
  actor that fails the check, not only the reserved one); ADDED "Actor
  names are checked" (the form, the patterns, the reason, the sources,
  the MCP surface, no echo).
- `board-web-actions`: ADDED "Actor names from the server and the
  browser are checked" (`serve --as` and the hand-off `to`).
- `board-events`: ADDED "Event actors have no form" (existing and
  synced events are valid whatever their actor's form).
- `board-agent-guidance`: ADDED "Guide states the actor form" (the guide
  and the `invalid-actor` hint).

## Impact

- Code: `src/cli/parse.ts` (the check beside `resolveActor` and
  `refuseReservedActor`), `src/cli/main.ts` (`commandActor` and the hint
  context of a failure), `src/cli/registry.ts` (`--to`, the `--as` and
  `--to` summaries, exit codes), `src/mcp/server.ts` and `src/mcp/tools.ts`
  (the call's `as`, the fallbacks, `to`), `src/web/serve.ts`,
  `src/guidance/hints.ts`, `src/guidance/guide.ts`, README.md.
- Compatibility: an actor outside the form (a space, a `/`, a non-ASCII
  letter, more than 32 characters) is refused from the version that ships
  this; pre-1.0 a minor version may change commands. Such an actor's
  events stay on the board; its tickets are handed on by
  `release --force` or a claimable lease. `--allow-secret-like` keeps
  its meaning for free text.
- Security-relevant: each task group needs a second reviewer
  (CONTRIBUTING.md, "Three roles per task group").
