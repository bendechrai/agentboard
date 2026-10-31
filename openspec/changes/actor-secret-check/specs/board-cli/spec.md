## MODIFIED Requirements

### Requirement: Actor is explicit
Every writing command SHALL require `--as <actor>` or the `AGENTBOARD_ACTOR`
environment variable; with neither, it SHALL exit 1 and explain. The actor
SHALL be recorded on the event and SHALL never be inferred from the OS user.
Every command SHALL accept `--as`; commands that neither write nor track a
per-actor cursor SHALL otherwise ignore it, so an agent can pass it
habitually, but every command SHALL refuse a given `--as` that is the
reserved actor `agentboard` or fails the actor check (see "Actor names are
checked"). The one exception is `serve`, which writes only through the
write actions of its web app: those are enabled only by an explicit
`--as <actor>` on the `serve` command line, `serve` SHALL ignore
`AGENTBOARD_ACTOR`, and every event written through it carries that `--as`
actor (see board-web-actions).

#### Scenario: Missing actor
- **WHEN** `agentboard comment T1 "hi"` runs with no `--as` and no `AGENTBOARD_ACTOR`
- **THEN** the command exits 1 and names both ways to supply an actor

#### Scenario: Serve ignores the environment actor
- **WHEN** `agentboard serve` runs with `AGENTBOARD_ACTOR` set and no `--as`
- **THEN** the server is read-only

#### Scenario: Read command with a refused actor
- **WHEN** `agentboard show T1 --as <token>` runs with a GitHub-style token
- **THEN** it exits 1 with reason `invalid-actor`, prints no ticket, and the token appears nowhere in stdout or stderr

## ADDED Requirements

### Requirement: Actor names are checked
An actor name supplied by the caller SHALL pass the actor check before
anything is written: the actor of a command (from `--as`, from
`AGENTBOARD_ACTOR` when the command falls back to it, from the MCP tool
argument `as`, or from the actor given to `agentboard mcp --as`), and
the new assignee of `handoff` (from `--to` or the tool argument `to`). A
name passes when it matches none of the secret patterns of "No secrets
on the board" and has the actor form: 1 to 32 characters, each an ASCII
letter, digit, `.`, `_`, `-` or `@`, the first a letter or digit
(`^[A-Za-z0-9][A-Za-z0-9._@-]{0,31}$`, tested on ASCII only, without
case folding or normalisation; actors stay case-sensitive).

A name that fails SHALL be refused with exit 1 and reason
`invalid-actor`, before the board is opened, writing nothing.
`--allow-secret-like` SHALL NOT bypass the check. The patterns are
tested first; a name that matches one SHALL be refused with exactly
`refused: the actor name given with <source> matches the secret
pattern(s) <names>; an actor name is recorded on every event and shared
with the board, so choose another name (--allow-secret-like does not
apply to actor names)`, and any other failing name with exactly
`refused: the actor name given with <source> is not of the actor form: 1
to 32 ASCII letters, digits, dots, underscores, hyphens or @ signs, the
first a letter or digit, such as impl-1`. `<names>` is the matching
pattern names in the order and form of "No secrets on the board", and
`<source>` is `--as`, `AGENTBOARD_ACTOR` or `--to` on the CLI and
`the argument as`, `AGENTBOARD_ACTOR` or `the argument to` over MCP.

The check SHALL apply on every command to a given `--as`, including
commands that need no actor, `agentboard mcp` (which then exits 1 and
does not start) and `agentboard serve`; to `AGENTBOARD_ACTOR` only when
it is the actor of a command that needs one (a command that needs no
actor SHALL neither check nor refuse it); and on every MCP tool call to
the call's `as`, to the server's `AGENTBOARD_ACTOR` when the call falls
back to it, and to the `to` of `board_handoff`, refused as a tool error
with `exitCode` 1 and `reason` `invalid-actor`. The reserved actor
`agentboard` passes the check and SHALL still be refused with reason
`usage` as before.

No refusal, message or hint SHALL repeat an actor name that has not
passed the check: an `invalid-actor` refusal names the source and not
the name, and wherever a hint would name an actor that is unchecked or
failed (the refused name, the actor of a call whose parsing failed, an
`AGENTBOARD_ACTOR` a command ignores) it SHALL write the placeholder
`<actor>`. The `invalid-actor` hint SHALL say to choose a name of the
actor form and how to pass it on that surface. Actor names recorded on
the board before this check, and names filtered by `list --assignee`,
are not checked.

#### Scenario: Token as the actor of a write
- **WHEN** `agentboard comment T1 "hi" --as <token>` runs with each token fixture (GitHub-style, AWS-style key id, 40 hexadecimal characters), with and without `--json`, and again with `--allow-secret-like`
- **THEN** each exits 1 with reason `invalid-actor`, the GitHub-style and AWS-style tokens get the pattern message naming `github-token` and `aws-access-key-id`, the hex string gets the form message, no event file is written, and the token appears nowhere in stdout or stderr

#### Scenario: Token in the environment
- **WHEN** `agentboard claim T1` runs with no `--as` and `AGENTBOARD_ACTOR` set to a GitHub-style token
- **THEN** it exits 1 with reason `invalid-actor`, the message says `the actor name given with AGENTBOARD_ACTOR matches the secret pattern(s) github-token`, the hint writes `<actor>`, no event is written, and the token appears nowhere in stdout or stderr

#### Scenario: Read command ignores the environment actor
- **WHEN** `agentboard list` and `agentboard show <unknown-id>` run with no `--as` and `AGENTBOARD_ACTOR` set to a token
- **THEN** `list` exits 0, `show` exits 4 with reason `unknown-ticket`, and neither output nor hint contains the token

#### Scenario: Ignored environment actor that passes the check
- **WHEN** `agentboard top` runs without a terminal, with no `--as` and `AGENTBOARD_ACTOR` set to 32 hexadecimal characters (a name that passes the check)
- **THEN** its hint writes `watch --as <actor>` and does not repeat the value, because `top` does not use the variable as its actor

#### Scenario: Names outside the actor form
- **WHEN** a writing command runs with `--as` set to a 33-character name, `impl 1`, `claude/opus`, `-impl`, `.impl`, `_impl`, a name holding a non-ASCII letter, and a name holding an ESC character
- **THEN** each exits 1 with reason `invalid-actor` and the form message, writes nothing, and the name appears nowhere in stdout or stderr

#### Scenario: Existing actor styles are accepted
- **WHEN** writing commands run with `--as` set to `orch`, `orchestrator`, `impl-1`, `reviewer-3-2`, `test-author-ne2`, `implementer-dm2`, `merger-2`, `ben`, `a`, `0`, `Ben`, `ben.dechrai`, `test_author`, `ben@laptop` and a 32-character name of the form
- **THEN** each is accepted and recorded exactly as given

#### Scenario: Reserved actor keeps its refusal
- **WHEN** `agentboard comment T1 "x" --as agentboard` runs
- **THEN** it exits 1 with reason `usage`, not `invalid-actor`, and writes nothing

#### Scenario: Hand-off to a token
- **WHEN** `agentboard handoff T1 --to <token> --status review --note "n" --as impl-1` runs
- **THEN** it exits 1 with reason `invalid-actor`, the message names `--to`, the ticket is unchanged, and the token appears nowhere in stdout or stderr

#### Scenario: Failed parse names no unchecked actor
- **WHEN** `agentboard close --unplanned --as <token>` and `agentboard close T1 --as <token>` (no disposition) run
- **THEN** each is refused, every hint writes `<actor>` where the actor goes, and the token appears in no output

#### Scenario: MCP server started with a token
- **WHEN** `agentboard mcp --as <token>` is started
- **THEN** it exits 1 with reason `invalid-actor` without serving, and the token appears nowhere in its stdout or stderr

#### Scenario: Token as the actor over MCP
- **WHEN** `board_comment` is called with `as` set to a token, `board_claim` is called with no `as` on a server whose `AGENTBOARD_ACTOR` is a token, and `board_handoff` is called with `to` set to a token and a valid `as`
- **THEN** each returns a tool error with `exitCode` 1 and `reason` `invalid-actor`, naming `the argument as`, `AGENTBOARD_ACTOR` and `the argument to` respectively, no event is written, and the token appears nowhere in the tool result (text or structured content) or in the server's stderr

#### Scenario: Events from before the check
- **WHEN** a board holds events whose actor is a GitHub-style token, written before this check or by an older version, and `agentboard show`, `list`, `inbox --as orch` and `rebuild --check` run
- **THEN** the events are folded as before and every command succeeds
