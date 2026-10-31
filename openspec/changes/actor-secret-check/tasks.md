# Tasks

Requirements this change modifies: board-cli "Actor is explicit" (the
only MODIFIED requirement). It adds board-cli "Actor names are checked",
board-web-actions "Actor names from the server and the browser are
checked", board-events "Event actors have no form" and
board-agent-guidance "Guide states the actor form". If another open
change (for example `mcp-unknown-resource` or
`into-host-replaced-after-step-4`) also modifies "Actor is explicit",
whichever is archived second rebases its delta onto the first.

Each group is delivered by a test author, an implementer and a reviewer in
turn (see CONTRIBUTING.md), on its own branch cut from `origin/staging`.
Both groups are security-relevant (they decide what reaches a board that
is synced and kept forever), so each also needs a second reviewer on the
strongest model, reviewing independently. Group 2 starts after group 1 is
merged.

Tests reuse the token fixtures and the no-echo assertion helper of
`src/__tests__/harness/secret-fixtures.ts`, and add, in the same module,
the actor tables of design.md "Testing approach" (refused for the form
only, refused by a pattern, accepted). Each reviewer recomputes the
accept or refuse decision for every row of those tables with a throwaway
program that does not import the code under review, and runs the built
CLI and MCP server with each refused fixture, grepping the captured
output. Verification for every task includes `make check` passing with
coverage at or above 90 percent.

## 1. The actor check on the CLI and over MCP (`cli/actor-check`)

- [ ] 1.1 The check: one exported function beside `resolveActor` and `refuseReservedActor` in `src/cli/parse.ts` (for example `checkActorName(name, source)`) that tests the secret patterns (`secretPatternsIn`) and then the actor form, and throws `BoardError(1, 'invalid-actor', ...)` with the two exact messages of design.md "Messages"; `invalid-actor` added to the reasons, the exit code map (1) and the hint table, with a hint that writes `<actor>` and names the way to pass an actor on each surface. Doc comments state the contract. Verify: unit tests over the three actor tables (refused by pattern, refused by form, accepted), the pattern tested before the form (an AWS-style key id gets the pattern message; a GitHub token of 40 characters too, not the form message), the form tested on ASCII only (a long s or a fullwidth letter refused), `agentboard` passing the check; the messages contain no part of the name for every fixture; the hint completeness test green
- [ ] 1.2 The CLI: `commandActor` checks the given `--as` on every command and the resolved actor of a command that needs one (source `AGENTBOARD_ACTOR` when it came from the environment), after the reserved actor refusal; the `--to` of `handoff` checked where the registry converts its arguments; the hint context of a failure (`cliHintContext`, `parsedActor`) uses an actor only when it passes the check, else leaves it unknown so the hint writes `<actor>`; `AGENTBOARD_ACTOR` neither checked nor repeated by a command that needs no actor. Verify: board-cli scenarios "Read command with a refused actor", "Token as the actor of a write", "Token in the environment", "Read command ignores the environment actor", "Names outside the actor form", "Existing actor styles are accepted", "Reserved actor keeps its refusal", "Hand-off to a token" and "Failed parse names no unchecked actor", in process (`runCli`) and against the built CLI, plain and `--json`; no event file written by any refusal; `--allow-secret-like` changing nothing for an actor; `init` and `agents install` with a refused `--as` exiting 1 without touching the directory; the existing `missing-actor` and reserved actor tests unchanged and green
- [ ] 1.3 MCP: `agentboard mcp --as` refused at start-up (exit 1, nothing served); per call the call's `as`, the server's `AGENTBOARD_ACTOR` fallback and the `to` of `board_handoff` checked through the same `commandActor` and argument conversion, refused as tool errors with `exitCode` 1, `reason` `invalid-actor` and the MCP source names (`the argument as`, `AGENTBOARD_ACTOR`, `the argument to`), with the MCP form of the hint. Verify: board-cli scenarios "MCP server started with a token" and "Token as the actor over MCP" over a real stdio client against the built server, the token absent from the tool result (text and structured content) and the server's stderr; a valid call after a refused one on the same server succeeds; board-agent-guidance scenario "Hint for a refused actor" (CLI and MCP)
- [ ] 1.4 Existing events and documentation of the CLI surface: no change to the event schema or the fold; `help` of `--as` and `--to` states the form and every command that takes an actor lists exit 1 `invalid-actor` (registry); README's "The actor rule" states the form, the refusal and that `--allow-secret-like` does not apply, and how a ticket held by a name that can no longer be passed is handed on (`release --force --reason`); the no-echo source scan's allow-list updated if the new messages need an entry. Verify: board-events scenarios "Event with a token as its actor" and "Hand-off to a name outside the form" (event files written directly into a test board), board-cli scenario "Events from before the check"; board-agent-guidance scenario "Help lists the reason"; the help drift guard, `make ascii` and `make validate-specs` green; README and help searched for every actor example, all of the form

## 2. Web and the agent guide (`web/actor-check`)

- [ ] 2.1 The web app: `serve --as` refused at start-up before listening (it is the given `--as` of `serve`, so group 1 may already cover it; this task pins it), and the `to` of a hand-off action refused with 400 `invalid-actor` through the shared argument conversion, with the web form of the hint (`agentboard serve --as <actor>`, or the hand-off's `to`); the page shows the refusal like any other action error. Verify: board-web-actions scenarios "Serve started with a token", "Hand-off to a token from the browser" and "Hand-off to an existing actor style from the browser" against a real server; the token absent from the response body, stdout and stderr; no event file written; the existing web action tests green
- [ ] 2.2 The guide: the actor rule section of `src/guidance/guide.ts` states the form, `invalid-actor` and that `--allow-secret-like` does not apply, within the 180-line limit with and without `--role`; the installed guidance text (`src/guidance/installed-text.ts`) is left unchanged, so its managed version does not move. Verify: board-agent-guidance scenario "Guide names the form"; the guide example parse test and line-limit test green; `agents check` on this repository still reports `current`; `make ascii`, `make validate-specs`
