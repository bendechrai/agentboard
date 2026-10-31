# Design

## Context

An actor is self-asserted (README, "Forced release": a list of allowed
actors would only teach agents to pass `--as orchestrator`), so the board
has never constrained it beyond "non-empty" and the reserved `agentboard`
(add-claim-leases; board-events "Reserved system actor"). It reaches the
board on every event the caller writes (the envelope's `actor` and
`ts.actor`), and a `handoff` also records a second actor name, the new
assignee (`to`). Both are synced to every clone and can never be removed:
event files are named by their content hash, and the fold has no
redaction.

Free text has had a guard rail since add-board-core: `new`, `comment`,
`handoff` and the unplanned reason refuse text matching four secret
patterns (`src/board/secrets.ts`: `pem-private-key`, `aws-access-key-id`,
`github-token`, `generic-secret-assignment`) unless `--allow-secret-like`
is given. The actor was never passed to it. `no-echo-refusals` made every
refusal stop repeating the refused input, but excluded the actor, because
it was accepted input that a refusal may repeat (its design.md, "The
rule" and "Out of scope"). This change closes that gap from the other
side: an actor that could be a secret is no longer accepted, so it is
never written and never repeated.

## Goals / Non-goals

Goals:

- No new event carries an actor name that matches a secret pattern or
  is shaped unlike an actor, on any surface.
- The refusal never repeats the refused name, and no message or hint
  repeats an actor name that has not passed the check.
- Every actor in use on this repository's board and in the docs keeps
  working.

Non-goals:

- Changing existing events, or how they are folded, shown or synced.
- Redacting actors already on a board from `show`, `list`, the feed, the
  web app or the TUI. A name already written is already shared; the
  remedy for a leaked token is to rotate it.
- Changing the secret patterns, which free text shares; adding token
  formats to them is its own change.
- Authenticating actors.

## Decision

### The actor check

An actor name passes the actor check when both hold, tested in this
order:

1. It matches none of the secret patterns (`secretPatternsIn` returns
   nothing).
2. It has the actor form:
   `^[A-Za-z0-9][A-Za-z0-9._@-]{0,31}$`, that is 1 to 32 ASCII letters,
   digits, `.`, `_`, `-` or `@`, the first a letter or digit. Letters
   are compared as given (actors stay case-sensitive, as today), and
   the test is ASCII-only, with no Unicode case folding or
   normalisation.

The reserved actor rule is unchanged and separate: `agentboard` has the
actor form and matches no pattern, so it passes the check and is still
refused by `refuseReservedActor` (exit 1, `usage`) wherever it is today.

A name that fails is refused with exit 1 and reason `invalid-actor` (a
new reason; status 400 on the web, as for every exit 1), before the
board is opened, so nothing is written and no board is needed to be
refused. `--allow-secret-like` does not apply to it, on any command.

One reason for both failures, because both have the same remedy (choose
another name) and because a caller that reacts to `secret-like` by
retrying with `--allow-secret-like` would loop. The message tells them
apart.

### Messages

`<source>` names where the refused name came from: `--as`,
`AGENTBOARD_ACTOR` or `--to` on the CLI; `the argument as`,
`AGENTBOARD_ACTOR` or `the argument to` over MCP and on the web (whose
body properties are the MCP argument names). `<names>` is as in
`refuseSecretLike`: the matching pattern names in `SECRET_PATTERN_NAMES`
order, joined with `, `.

- Pattern: `refused: the actor name given with <source> matches the
  secret pattern(s) <names>; an actor name is recorded on every event and
  shared with the board, so choose another name (--allow-secret-like does
  not apply to actor names)`
- Form: `refused: the actor name given with <source> is not of the actor
  form: 1 to 32 ASCII letters, digits, dots, underscores, hyphens or @
  signs, the first a letter or digit, such as impl-1`

Neither contains any part of the name. The hint of `invalid-actor` says
to choose a name of the actor form, one stable name per role, and how to
pass it on that surface: on the CLI `--as <actor>` or `AGENTBOARD_ACTOR`
(and `--to <actor>` when the command is `handoff`), over MCP the `as`
argument or `agentboard mcp --as <actor>` (and the `to` argument for
`board_handoff`), on the web restarting the server with
`agentboard serve --as <actor>` (or the hand-off's `to`), always with the
placeholder `<actor>`. Its exact text is the implementer's, following the
existing hint templates (`src/guidance/hints.ts`), and is pinned by the
hint tests.

### No echo of an unchecked actor

The hint context (`HintContext.actor`) is filled only with an actor name
that has passed the check. Where a name has not been checked, or failed,
the hint writes `<actor>`:

- the refused name itself (every `invalid-actor` refusal);
- a failed parse, whose actor comes from the relaxed re-parse
  (`parsedActor`) or `AGENTBOARD_ACTOR` (no-echo-refusals review round
  1): it is checked first and used only when it passes;
- a command that needs no actor and ignores `AGENTBOARD_ACTOR`: the
  variable is not checked and not refused there (refusing `list` because
  of an unused variable would break read-only use), so it is never
  repeated.

Messages that name an actor as board data (the holder in
`already-assigned`, the assignee in `show`) are unchanged: board data may
be repeated (board-cli "Refusals never repeat the refused input"), and a
holder written before this change is no longer a value anyone can pass.

### Where the check runs

| Surface | Name | Checked | On failure |
|---|---|---|---|
| CLI, every command | `--as` when given | always, as `refuseReservedActor` is today (so `show T1 --as <token>` exits 1) | exit 1 `invalid-actor` |
| CLI, commands that write or track a cursor | `AGENTBOARD_ACTOR` when it is the actor | when `resolveActor` falls back to it | exit 1 `invalid-actor`, source `AGENTBOARD_ACTOR` |
| CLI, read commands | `AGENTBOARD_ACTOR` | never (ignored, never repeated) | - |
| CLI `handoff` | `--to` | always | exit 1 `invalid-actor`, source `--to` |
| `agentboard mcp --as` | the server's default actor | at start-up, as the `--as` of every command | exit 1, the server does not start |
| MCP tool call | the call's `as`; the server's `AGENTBOARD_ACTOR` when the call falls back to it; `to` of `board_handoff` | per call | tool error `exitCode` 1, `reason` `invalid-actor` |
| `agentboard serve --as` | the actor of the write actions | at start-up | exit 1, nothing served |
| Web `POST /api/actions/handoff` | `to` | per request | 400 `invalid-actor`, nothing written |
| `init` (all forms), `agents install`, `agents check`, `help`, `version` | none recorded | only a given `--as`, like every command | exit 1 `invalid-actor` |

`commandActor` (`src/cli/main.ts`), shared by the CLI and the MCP server,
becomes: refuse the reserved actor as given, check the given name, and,
for a command that needs one, resolve, refuse the reserved actor and
check the resolved name (the check is idempotent on a name already
checked). The `--to` check runs where the registry converts the
`handoff` arguments, which the CLI, MCP and the web share, so all three
refuse it with the same code. `serve` keeps its own rule that only an
explicit `--as` enables writes; that `--as` is already the given `--as`
of the `serve` command.

`list --assignee` is a filter, never written, and keeps accepting any
text, so the tickets of a name that can no longer be used can still be
found. `--to agentboard` is not newly refused: the reserved rule concerns
the event's actor, and this change does not widen it.

## Alternatives considered

- **The secret patterns with `--allow-secret-like`, as for free text.**
  Rejected. Free text sometimes has to quote something secret-shaped (a
  test fixture, a log line); an actor never does, and a false positive
  costs only a different name. An override for an identity would be
  passed habitually by scripts, and would cover the actor of every event
  the command writes, not one piece of text.
- **The secret patterns alone, no override.** Rejected as insufficient:
  the four patterns name GitHub and AWS formats and `key=...`
  assignments, but not Slack (`xoxb-...`), Stripe (`sk_live_...`),
  OpenAI or Anthropic keys, npm tokens, JWTs or a bare base64 or hex
  secret, which is what a mistyped variable most often holds.
- **The form alone.** Rejected as insufficient: an AWS access key id (20
  characters of `[0-9A-Z]`) has the form. The patterns cost nothing more
  and give the most specific message when a known secret is pasted.
- **A bound of 64 characters.** Rejected: it admits Slack bot tokens
  (about 55 characters) and 39- and 40-character keys (Google API keys,
  npm tokens) that no pattern names. 32 is twice the longest actor on
  this repository's board (15, `implementer-dm2`) and longer than every
  documented example; most token formats are longer than 32 and are
  refused by length alone.
- **Lowercase letters, digits and `-` only** (every actor on this board).
  Rejected: refusing `Ben`, `ben.dechrai`, `test_author` or `ben@laptop`
  buys nothing, since a token's case or `_` does not get it past the
  length bound or the patterns.
- **An entropy or "looks random" heuristic.** Rejected: it cannot be
  stated in a refusal so that the caller knows what to change, and it
  would refuse legitimate names such as `reviewer-a1b`.
- **Making a non-conforming actor malformed in the event schema.**
  Rejected: events already written would stop folding, a board's history
  would change under an upgrade, and events written by an older version
  to a shared board would fold differently in different clones.
- **Accepting a non-conforming name that already has events on the
  board.** Rejected: the check would need the board opened first, and a
  token already leaked would be repeated on every new event for good.

### Why this character set

Hints print commands meant to be copied and run, with the actor in them
(`agentboard inbox --as impl-1`). Every character of the form is safe
unquoted in a POSIX shell, and a first letter or digit means the name is
never read as a flag (`--as -x`), so a hint naming an accepted actor is
always a valid command. The set also excludes the separators `:` and
`=`, spaces, quotes, `/`, `+` and every control and non-ASCII character,
so no `generic-secret-assignment` text, no standard base64 secret of 32
or more characters and no terminal escape sequence can pass.

### Residual risk

A secret of at most 32 characters drawn from the allowed set and
matching no pattern still passes: 32 hexadecimal characters, a short
password of letters and digits. No rule tells such a string from an
actor name such as `a8f3c2e1` without refusing legitimate names, and
the risk is the same as for any text the board accepts. It is accepted.

## Existing boards and compatibility

- Events are not rewritten and stay valid whatever their actor
  (board-events "Event actors have no form"): they are folded, shown,
  synced and exported as today. A ticket held by a name that can no
  longer be passed is released by another actor with
  `release --force --reason`, or claimed once its lease is claimable;
  `list --assignee` still finds its tickets.
- An older agentboard writing to a shared board can still write any
  actor; newer clones fold those events. Sync never checks the form of a
  received event's actor.
- Per-actor `inbox` cursors (local cache state) of a refused name simply
  stop being used.
- This repository's board: 91 distinct actor names in 1032 events (every
  event's `actor` and every hand-off's `to`, counted after review round
  1; an earlier count of 82 in 950 events wrongly included five statuses
  from the `to` of move events, and was 77), all of `[a-z0-9-]`, the
  longest 15 characters, all of the form. The docs, the
  guide, the help examples and README use `orch`, `orchestrator`,
  `impl`, `impl-1`, `impl-2`, `reviewer`, `reviewer-1`, `reviewer-3-2`,
  `merger-1` to `merger-4`, `releaser-1`, `test-1`, `ben`, `a` and `x`,
  all of the form. Test fixtures that pass other actors (spaces, `/`,
  long names) are updated by the test author.
- The installed guidance text (`agents install`) names no form and is
  not changed, so its managed version does not move and `agents check`
  reports no new staleness.
- `--allow-secret-like` keeps its meaning for free text. Its help text
  gains nothing; the actor's refusal says it does not apply.
- Pre-1.0, a minor version may change commands; the release notes name
  the form.

## Testing approach

- The token fixtures and the no-echo assertion helper of
  `no-echo-refusals` (`src/__tests__/harness/secret-fixtures.ts`) are
  reused as refused actor names, plus names that fail only the form
  (33 characters, a space, `/`, a non-ASCII letter, a leading `-`, `.`
  or `_`, an ESC character) and an AWS-style key id (form valid,
  pattern refused).
- Accepted names: every actor of this repository's board listed above,
  plus `Ben`, `ben.dechrai`, `test_author`, `ben@laptop`, a 32-character
  name, `0`, and `agentboard` reaching the reserved refusal (`usage`,
  not `invalid-actor`).
- Every refusal is exercised on each surface (CLI in process and built,
  plain and `--json`; the built MCP server over a stdio client; the web
  server), asserting exit code, reason, the exact message, a hint with
  `<actor>`, no event file written, and the refused name absent from
  stdout, stderr, the tool result, the server's stderr and the response
  body.
- The reviewer recomputes the form decision for the accepted and refused
  tables with a throwaway program that does not import the code under
  review.

### Rulings of the group 1 test author

Points the spec left open, ruled when the group 1 tests were written
(each pinned by a test and posted as a `DECISION:` comment on the group 1
ticket):

- **The hint does not know the source.** A hint is a pure function of the
  reason and the hint context (`renderHint`), and the context does not
  carry which name was refused. So the `invalid-actor` hint always writes
  the placeholder `<actor>` and never a context actor or id (the
  context's actor is either the refused name or unchecked), and for
  `handoff` it names both ways: the actor first, then `, and the new
  assignee with --to <actor>` (over MCP the `as` and `to` arguments).
  Every hint names the word `form`. On the CLI it says `set
  AGENTBOARD_ACTOR` only for a command that uses the variable as its
  actor (one that writes or tracks a cursor), and no other command's hint
  names the variable (review round 1, F5).
- **An ignored AGENTBOARD_ACTOR is never repeated.** A hint names
  `AGENTBOARD_ACTOR`'s value only for a command that uses it as the actor,
  even when the value passes the check; for any other command (`top`,
  `list`, `show`, a read tool over MCP) the hint writes `<actor>`
  (reviewer-ac1-2 finding 1).
- **The actor before the new assignee.** When both the actor and `--to`
  (or `as` and `to`) fail, the refusal names the actor's source:
  `commandActor` runs before the command's arguments are converted, on
  the CLI and over MCP alike.
- **An empty name is not a given name.** An empty `--as`, `as` or
  `AGENTBOARD_ACTOR` is treated as absent, as `resolveActor` does today:
  it is not checked, a command that needs an actor falls back to the next
  source or refuses with `missing-actor`, and a read command ignores it.
  `checkActorName('')` itself refuses (the form needs one character), but
  no caller passes it an empty name.
- **Every command lists the reason.** Every command checks a given
  `--as`, so every registry command (`help`, `version`, `init` and
  `agents` included) lists exit 1 `invalid-actor` in its exit codes.
- **"States the form" in help.** The `--as` line of the text and the
  `--json` help of every command (`serve` and `mcp` included) says that a
  given name is checked and gives the form in the words `1 to 32 ASCII
  letters, digits, . _ - or @, the first a letter or digit`, and no
  longer says `Accepted and ignored by this command`; the `--to` summary
  gives the form in the same words (review round 1, F1). The rest of the
  wording is the implementer's.
- **Accepted secret-shaped fixtures.** The no-echo fixtures `CROCKFORD_26`,
  `CROCKFORD_26_SEVEN` and `TOTP_SEED`, and 32 hexadecimal characters,
  have the form and match no pattern, so they are accepted actor names
  (see "Residual risk"); they are in the accepted table, not the refused
  ones.
- **The no-echo source scan.** `checkActorName` may interpolate exactly
  the values `source` and `names` in its messages; the scan's allow-list
  has those two entries.

