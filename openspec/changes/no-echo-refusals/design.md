# Design

## Context

A refusal reaches the caller through several channels at once: the CLI
prints `agentboard: <message>` and `hint: <hint>` on stderr, or the
`--json` error document `{error: {exitCode, reason, message, hint}}` on
stdout; an MCP tool error carries `{exitCode, reason, message, hint}` and
the server also writes `agentboard: <message>` to its own stderr; the web
app's write actions return the same document in the response body. All
of them end up in places that are kept and shared: terminal scrollback,
shell logs, CI logs, agent transcripts sent to model providers.

`add-claim-leases` (archived 2026-10-27) made three refusals stop
repeating the refused input: an unknown `config` key (the generic choices
refusal of `parseArgs`, now `<command> takes <<name>> as one of ...`), a
refused `config set` value, and `--ttl` and `--timeout`. The reason
(orchestrator, review round 2 and round 3 DECISIONs on ticket
01M4KMNB5S53AY10YNG151NKPJ) was that a token-shaped value pasted into the
wrong argument would otherwise land in a terminal or a log. Finding F6 of
that review observed that the habit is CLI-wide; the ruling kept the
other refusals for this change.

Today most refusals pass the refused text through `asciiText` (so it is
printable ASCII on one line) and repeat it. A few repeat it raw: the
`agents install --target` refusal, the `inbox --since` refusal and the
MCP unknown tool refusal (through `JSON.stringify`).

## Goals / Non-Goals

Goals:

- No refusal on any surface repeats the input it refuses, with one
  stated exception whose shape cannot hold a typical secret.
- Every refusal stays useful: it names the argument it refuses and the
  expected form or the valid choices, so the caller can fix the call
  without seeing its own value repeated.
- Exit codes, reason tokens, JSON fields and hint steps stay as they
  are, so scripts and agents that branch on them are unaffected.

Non-Goals:

- Detecting secrets in accepted input. The board's secret-pattern check
  (board-cli "No secrets on the board") covers the free text it stores;
  whether more accepted values (the actor) need it is a separate
  question (see "Out of scope").
- Redacting success output, `show`, `list`, `remote` or `sync` output,
  which print board data and configuration.

## The rule

A refusal (its message, its hint, and every field of the CLI `--json`
error document, the MCP tool error and the web action error, and the
`agentboard: <message>` line the CLI and the MCP server write to stderr)
SHALL NOT contain any part of the refused input.

The refused input is the value, flag name, command word, tool name or
tool argument name whose check failed: it is unknown, malformed, out of
range, not one of the choices, or names nothing (no such ticket, event,
file or tasks file). Instead the refusal names the argument (`--task`,
`<status>`, the tool argument `id`, `--remote`), or, for an unknown flag
or an extra positional, its position among the arguments after the
program name (1-based), and the expected form or the valid choices.

The one exception is a ticket id. A ticket id argument (a positional
`<id>` or the tool argument `id`) whose text could be a ULID or a prefix
of one, 1 to 26 characters of Crockford base32 whose first character is
0 (`^0[0-9A-HJKMNP-TV-Z]{0,25}$`, ASCII letters compared without regard
to case and no Unicode upper-casing: digits and the letters other than
I, L, O and U), MAY be repeated in a refusal. An id of any other shape is not repeated
anywhere, including the hints, which write the placeholder `<id>` for it
as they do for an unknown id today.

Other input of the same call that is not refused may still be repeated:
the actor, a decision path that passed its checks before the refusal (the
`needs-scope-disposition` hint of `close` repeats `--decision-recorded-in
<path>`), and a ticket id resolved on the board (which is board data).

### Why the id exception, and why that shape

Naming the id is the one echo with real value that no other text can
replace: a script or orchestrator that passes several ids learns which
one matched nothing, and a prefix that is too short or ambiguous is
named next to the full ids it matched. The shape is the ULID alphabet
with the ULID length as its bound. Common token formats fall outside it:
GitHub (`ghp_`, `github_pat_`), Stripe (`sk_live_`) and Slack (`xoxb-`)
tokens contain `_` or `-`; AWS key ids (`AKIA...`) contain `I`; base64
and JWTs contain `+`, `/`, `.`, `=` or letters outside the alphabet in
almost every value of useful length; hex secrets (MD5 32, SHA-1 40,
SHA-256 64 characters) are longer than 26.

Base32 secrets are the class the alphabet alone does not exclude (review
rounds 1 and 2, finding F2): a TOTP seed (RFC 4648 base32, A to Z and 2
to 7, often 16 characters) is all Crockford base32 whenever it has no I,
L, O or U, about 12 percent of 16-character seeds; a 128-bit secret in
unpadded base32 is exactly 26 characters, about 3 percent of them
id-shaped by the alphabet; and a token encoded in Crockford base32
itself (ULID-like session ids and API keys) always is. So the shape also
constrains the first character, which in a ULID carries the top 3 bits
of the 48-bit time.

Review round 1 first required that character to be 0 to 7, the range of
every ULID. That still repeats a lot of random text: half of random hex
(8 of 16 first characters), a quarter of random Crockford base32, and
about 19 percent of standard base32 TOTP seeds (6 of the 32 RFC 4648
characters, 2 to 7, are digits 0 to 7; about 2.5 percent of 16-character
seeds are then wholly id-shaped). Review round 2 requires 0. A ULID
starts with 0 while its time is below 2^45 milliseconds, that is until
about the year 3084, so every id the board creates for the next thousand
years keeps being named, and the echo of random text falls to 1/16 of
hex and 1/32 of Crockford base32. A standard base32 TOTP seed is never
id-shaped, since the RFC 4648 alphabet has no 0. Requiring `01` instead,
the prefix of every id created from 2004 to about 2039 (time from 2^40
to 2^41 milliseconds), would cut random text to about 1 in 1000 (1/256
of hex, 1/1024 of Crockford base32), but ids created after about 2039
start with `02` and would stop being named, and a board that outlives
that date must keep naming its own ids; `0` costs a factor of about 16
to 32 in random text against `01` and has no such date within reach.

The check is an ASCII-only, case-insensitive test of the pattern, with
no Unicode upper-casing, so a character such as U+017F (upper-cases to
`S`) or U+FB06 (to `ST`) never makes text id-shaped (finding F3).

What remains is a secret that happens to start with 0 and use only those
32 characters: one in 16 short lowercase hex strings (at most 26
characters), a short password starting with 0 and without I, L, O or U,
and a Crockford base32 token of at most 26 characters that starts with 0
(a ULID-shaped token is indistinguishable from an id). That residual
risk is accepted for ids because of their value and because an id that
is not on the board is rarely a secret in practice.

### Why no exception for words

Commands, flags, statuses, setting keys, roles and targets are short
lowercase words, and a word shape (a lowercase letter followed by up to
23 lowercase letters, digits or hyphens) would admit most typos and few
tokens. It is not adopted:

- The `add-claim-leases` ruling already refuses an unknown setting key,
  which is exactly such a word, without repeating it. A word exception
  would contradict a recorded decision for the sake of a few messages.
- The value of the echo is carried by what replaces it: a choice
  argument lists every choice, and an unknown command or flag names up
  to three suggestions within edit distance 2 (the typo `clam` still
  gets `did you mean claim?`). The caller has its own command line.
- A short lowercase password or passphrase word fits the shape, and an
  argument shifted by an unset shell variable can put one there.

## Alternatives considered

- Truncate the value (first few characters and `...`). Rejected: the
  prefix is the part that identifies a token's kind and issuer (`ghp_`,
  `AKIA`, `sk_live_`), a truncated value is still part of the secret,
  and a truncated echo is less readable than naming the argument.
- Redact with the secret patterns (`src/board/secrets.ts`): repeat the
  value unless it matches a known secret pattern. Rejected: the patterns
  are for free text the board stores and recognise a handful of formats
  (PEM headers, AWS key ids, GitHub tokens, keyword-prefixed base64); a
  raw API key of any other format would still be echoed, and the rule
  would look safe while not being so.
- Mask the value (`<redacted>`, or its length). Rejected: it says no more
  than naming the argument does, and the length is itself a hint about
  what was pasted.
- A fingerprint (the first hex digits of a hash) so that a caller can
  correlate a refusal with its input. Rejected as unnecessary: the
  caller has its input; a fingerprint is unreadable to a human and adds
  surface to test.
- An opt-in to echo (`--verbose`, an environment variable). Rejected for
  now: it reintroduces the leak in exactly the CI and agent contexts that
  set such switches once and forget them.

The rule chosen (name the argument and the form; no partial value) is
the one `add-claim-leases` already applies, so the whole CLI ends up with
one convention.

## Audit

Every refusal that can include user-supplied text, found by reading every
`BoardError` construction under `src/` (and the message helpers they call)
whose message interpolates a value, and every hint template that
interpolates the hint context. "Raw" means the text has passed no shape
check when the message is built; "checked" means it has. "Useful" says
whether repeating it helps the caller beyond what the proposed message
says. Messages given in full are the proposed exact text; `<n>`, `<command>`,
`<root>`, `<dir>`, `<name>` and the like are filled from the registry, the
board or the working tree, never from the refused input.

### Parser and guidance (CLI and, through `toolArguments`, MCP)

| # | Refusal (where) | Reason | Echoes today | Shape when built | Useful? | Proposed message |
|---|---|---|---|---|---|---|
| 1 | Unknown command (`selectCommand`, `unknownCommandMessage`; also `help <topic>`) | `usage` | the first argument, or the first two for a two-word command | raw | low: the suggestions carry it | `unknown command; did you mean <list>? run 'agentboard help' to list the commands` (without suggestions: `unknown command; run 'agentboard help' to list the commands`) |
| 2 | Unknown flag (`unknownFlagMessage`) | `usage` | the flag name (before any `=`) | raw | low: suggestions and position carry it | `unknown flag at argument <n> for <command>; did you mean <list>? run 'agentboard help <command>' to list its flags` (without suggestions likewise, without the `did you mean` part) |
| 3 | Extra positional (`parseArgs`) | `usage` | the extra argument (often unquoted free text) | raw | no | `unexpected argument at position <n> for <command>; it takes <positionals>, and text with spaces must be quoted` where `<positionals>` is the synopsis of its positionals (`<id> <text>`); for a command with no positionals `unexpected argument at position <n> for <command>; it takes no positional arguments` (built by `unexpectedArgumentMessage`) |
| 4 | Integer expected (`parseInteger`: `checklist tick` index, `--port`) | `usage` | the value | raw | no | `--<name> must be an integer` for a flag, `<name> must be an integer` for a positional (the MCP form) |
| 5 | Not a choice (`parseArgs`, `config set`/`get` key) | `usage` | nothing (add-claim-leases) | - | - | unchanged: `<command> takes <<name>> as one of <choices>` |
| 6 | Help subtopic (`help.ts`) | `usage` | the subtopic word | raw | low | `<command> has no help subtopic of that name; run 'agentboard help <command>'` |
| 7 | Unknown role (`guide.ts`, `help agents --role`) | `usage` | the role | raw | no: the roles are listed | `unknown role given with --role; the roles are orchestrator, test-author, implementer, reviewer` |
| 8 | Unknown target (`install.ts`, `agents install --target`) | `usage` | the target, not even through `asciiText` | raw | no: targets are listed | `unknown target given with --target; expected one of claude, agents-md, openspec, mcp-json` |
| 9 | Boolean flag with a value, flag given twice, missing value, missing argument, exclusive groups | `usage` and group reasons | flag and argument names from the registry only | - | - | unchanged |

### Values checked by the registry and the board

| # | Refusal (where) | Reason | Echoes today | Shape when built | Useful? | Proposed message |
|---|---|---|---|---|---|---|
| 10 | Unknown status (`registry.ts status()`: `move <status>`, `handoff --status`, `list --status`) | `usage` | the status | raw | no: statuses are listed | `move takes <status> as one of todo, tests, implementing, review, merged, blocked`; `handoff takes --status as one of ...`; `list takes --status as one of ...` (built by `choicesMessage`, which the choices refusal of row 5 also uses) |
| 11 | `health` durations (`durationFlag`: `--stale-after`, `--blocked-after`, `--unplanned-within`) | `usage` | the value | raw | no | `invalid --<name>: a duration is <n>m, <n>h or <n>d with <n> a positive integer of at most 5 digits (for example 30m, 2h or 1d)` |
| 12 | Malformed task reference (`taskRefFromArgs`: `--task` of `new`, `link`, `move`, `close`) | `malformed-task-ref` | the reference | raw | no: the form is shown | `malformed task reference: --task expects <source>:<ref>#<item>, for example openspec:add-board-core#3` |
| 13 | Malformed change name (`taskRefFromArgs`; `listTaskFilter` in the registry) | `malformed-task-ref` | the name | raw | no | `malformed change name: --change must be non-empty and contain no #` |
| 14 | Malformed group (`taskRefFromArgs`) | `malformed-task-ref` | the group | raw | no | `malformed group: --group must be a positive decimal number such as 3` |
| 15 | Malformed task filter (`parseTaskFilter`, `list --task`) | `malformed-task-ref` | the filter | raw | no | `malformed task filter: --task expects <source>:<ref>[#<item>]` |
| 16 | Id too short (`resolveTicketId`) | `id-too-short` | the prefix | raw (shorter than 6) | yes, when id-shaped | id-shaped: unchanged (`ticket id prefix <text> is too short: give at least 6 characters`); otherwise `the ticket id given is too short: give at least 6 characters` |
| 17 | Unknown ticket (`resolveTicketId`) | `unknown-ticket` (exit 4) | the id or prefix | raw | yes, when id-shaped | id-shaped: unchanged (`no ticket matches <text>`); otherwise `no ticket matches the id given, which is not a ticket id: an id is 26 characters of Crockford base32 (digits and letters other than I, L, O and U) starting with 0, or a unique prefix of at least 6 of them` (review round 2) |
| 18 | Ambiguous prefix (`resolveTicketId`) | `ambiguous-id` | the prefix and the matching full ids | always id-shaped (a prefix of an id is) | yes | unchanged |
| 19 | Unknown cursor (`inbox --since`) | `unknown-cursor` | the cursor, not through `asciiText` | raw | no | `no event matches --since on this board` |
| 20 | Decision record missing (`closeTicket`) | `decision-path-missing` | the path as given | checked (inside the tree) but refused | low: the caller has it | `the decision record given with --decision-recorded-in does not exist` |
| 21 | Path outside the working tree (`treePath`: `close --decision-recorded-in`, `link --decision`) | `path-outside-tree` | the path and the tree root | raw | the root yes, the path no | `the path given is outside the working tree <root>` |
| 22 | `import-change` target names an item (`parseImportTarget`) | `malformed-task-ref` | the target | raw | no | `the change given to import-change names an item (it contains #); import-change takes a whole change or <source>:<ref>` |
| 23 | `import-change` source fails the source pattern (`parseImportTarget`) | `malformed-task-ref` | the source | raw | no | `the task source given to import-change must match /^[a-z][a-z0-9-]*$/` |
| 24 | `import-change` names no ref (`parseImportTarget`) | `usage` | the target | raw | no | `the change given to import-change names no ref after its source` |
| 25 | Unsupported source (`importChange`) | `unsupported-source` | the source | checked (`[a-z][a-z0-9-]*`, unbounded) | no: the adapters are listed | `the task source given has no adapter in this version; only openspec can be imported` (the adapter list from the registry) |
| 26 | Change name not a single directory name (`openspec.ts checkRef`) | `usage` | the name | raw | no | `the OpenSpec change name given is not a single directory name` |
| 27 | Tasks file not found (`openspec.ts`) | `tasks-not-found` | the tasks path, which contains the name, and the name | checked (a directory name) | low | `cannot read the tasks file of the change given: import-change reads openspec/changes/<name>/tasks.md; is the name an OpenSpec change?` |

### Library entry points (reached by callers of `src/index.ts`, not by the CLI, whose parsers refuse first)

| # | Refusal (where) | Reason | Echoes today | Proposed message |
|---|---|---|---|---|
| 28 | Unknown setting key (`config.ts settingKey`) | `usage` | the key | `unknown setting: the keys are lease.grace and queue.window` |
| 29 | Setting value out of range (`setConfig`) | `usage` | the number | `invalid value for <key>: a setting is a whole number of milliseconds from 30000 (30s) to 600000 (10m)` (the key is checked by then) |
| 30 | Ttl out of range (`actions.ts checkTtl`, `wait.ts`) | `usage` | the number | `invalid ttl: a ttl is a whole number of milliseconds from 30000 (30s) to 604800000 (7d)` |
| 31 | Timeout out of range (`wait.ts`) | `usage` | the number | `invalid timeout: a timeout is a whole number of milliseconds from 1000 (1s) to 86400000 (1d)` |

### MCP argument path

| # | Refusal (where) | Reason | Echoes today | Useful? | Proposed message |
|---|---|---|---|---|---|
| 32 | Unknown tool name (`server.ts`) | `usage` | the name, through `JSON.stringify` only | no: `tools/list` has them | `unknown tool; call tools/list for the tool names` |
| 33 | Unknown argument name (`toolArguments`) | `usage` | the argument name | no | `unknown argument for <tool>; its arguments are <names>` (the schema's property names in schema order, joined by `, `; built by `unknownArgumentMessage`) |
| 34 | Wrong type, missing argument, not an object | `usage` | registry names only | - | unchanged |
| 35 | Every value refusal above (statuses, references, ids, ...) | as above | as above | - | as above: `toolArguments` builds an argument list and runs `parseArgs` and the same command code |

### Hints (`src/guidance/hints.ts`)

| # | Refusal | Echoes today | Proposed |
|---|---|---|---|
| 36 | Every hint with a step naming `id` (`invalid-transition`, `no-disposition`, `needs-scope-disposition`, `already-linked`, `missing-status`, `checklist-index`, `holder-changed`, `invalid-queue`, `stale-grant`, `already-assigned`, `busy`, ...) | `HintContext.id`, the id exactly as given, filled by `cliHintContext` and `runTool` before it is resolved | the id when id-shaped, else the placeholder `<id>` |
| 37 | `usage` and the unknown tool hints | registry and tool names only | unchanged |
| 38 | `close` hints repeating `--decision-recorded-in <path>` | the path, accepted (it passed the tree and existence checks before the refusals that use it) | unchanged |
| 39 | Hints naming the actor | the actor, accepted | unchanged (see "Out of scope") |

### `init --remote` (`src/board/init-remote.ts`)

| # | Refusal | Reason | Echoes today | Proposed |
|---|---|---|---|---|
| 40 | Value starts with `-` | `usage` | the value | `... (--remote <url>): the value starts with -, which git would read as an option` |
| 41 | `file://` URL naming another host | `usage` | the value | `... (--remote <url>): the value is a file:// URL naming a host other than localhost, so it is no path on this machine` |
| 42 | Repository cannot be read (`ls-remote` fails) | `remote-unreachable` (exit 3) | the URL, credentials included, and git's first error line (which often repeats it) | `the repository given with --remote cannot be read (<git line>); create an empty repository there (for example on your git host) and check your access`, with the git line sanitized (below) |
| 43 | Clone fails after `ls-remote` | `remote-unreachable` | the URL and git's line | `the repository given with --remote could not be cloned (<git line>); ...`, sanitized |
| 44 | Not a board (branch cannot be checked out, or no `events/`) | `not-a-board` | the URL and the branch | `the repository given with --remote holds no board: ...`; the branch name (read from the remote) stays |
| 45 | Remote mismatch | `remote-mismatch` | the configured remote's name and URL, and the URL given, twice (once in the `git remote set-url` step) | the configured name and URL stay (configuration); the URL given is `the URL given` in the sentence and `<url>` in the step |

The git line is sanitized before it is quoted: every occurrence of the
value given is replaced by `<url>`, and the user information of every
URL in the line (`<scheme>://<userinfo>@`) by `<scheme>://<redacted>@`,
so a credential survives neither verbatim nor in the normalised form git
may print. A URL with credentials (`https://user:<token>@host/repo.git`)
is the most likely way a real secret reaches an argument, which is why
these refusals are in scope although the URL passed the form checks.

Audit size: 45 rows; 37 change message or hint text (rows 1-4, 6-8,
10-17, 19-33, 36, 40-45), 8 are already compliant and are listed to show
they were checked (rows 5, 9, 18, 34, 35 as a pointer, 37-39).

## Out of scope

- The actor. `--as`, `AGENTBOARD_ACTOR` and the `as` tool argument are
  repeated in messages (`already claimed by <actor>`) and in hints
  (`agentboard inbox --as <actor>`). The actor is accepted input that the
  board records verbatim on every event the caller writes, and it has no
  shape. Whether an actor should be checked against the secret patterns
  (refused like comment text) is a separate behaviour change; the
  orchestrator files a follow-up ticket for it.
- Configuration and environment. The configured remote's URL (in
  `remote-mismatch`, `remote`, `sync` failures), `agentboard.remote`, and
  the path the board was looked for at (board-events "Board directory per
  project", board-cli "No board at start-up") come from the user's own
  configuration, not from the refused argument, and the success paths
  print them anyway.
- Board data: full ids matched by an ambiguous prefix, holders, ticket
  ids after resolution, tasks file content in `import-change` refusals
  (`malformed-tasks` line numbers and group items), and the `DECISION:`
  comments `unpromoted-decision` quotes.
- The web API's `after` cursor refusal already names no value.

## Rulings during the tests (group 1)

The test author of group 1 ruled on these points (DECISION comments on
ticket 01M5YAB4P61Q911JF44AEKVQ30):

- The board-cli scenario "Unknown ticket id that is id-shaped" ran
  `show 01NOPE0000` and expected the message to name `01J9K3ZZZZ`. `O` is
  not a Crockford base32 letter, so `01NOPE0000` is not id-shaped and is
  not named; the scenario runs `show 01J9K3ZZZZ`, and a second scenario
  covers `01NOPE0000`. Existing tests that expected `no ticket matches
  01NOPE00` change accordingly.
- "Unknown inbox cursor": only 64 lowercase hex characters pass the form
  check of `--since` and reach `unknown-cursor`; the fixture for it is a
  64-character hex string. Any other value gets the unchanged `usage`
  refusal, which already names no value.
- The three new messages that are built from the registry are message
  builders with their own contracts, so that the source scan can allow
  them by name: `choicesMessage(command, argument, choices)`
  (`src/board/text.ts`, re-exported from `src/cli/parse.ts`; rows 5 and
  10), `unexpectedArgumentMessage(command, position)` (`src/cli/parse.ts`;
  row 3) and `unknownArgumentMessage(command)` (`src/mcp/tools.ts`; row
  33). `unknownFlagMessage` takes the flag's position as a new second
  parameter.
- Positions count every argument after the program name, including the
  command words, flags, flag values and a lone `--`.
- The web app's unknown body property is refused by the same
  `unknownArgumentMessage` as the MCP tool, so its list of arguments
  includes `as` and `allow-secret-like`, which the web app refuses with
  their own message; that is accepted, the list being the tool schema.
- The source scan (task 1.6) collects the message of every `new
  BoardError`, every `super(code, reason, message)` of a subclass and its
  construction sites, and every `usage(...)` call, splits it into the
  values it interpolates, and requires each to be allowed for its file
  and enclosing function, with a reason; the method is documented on the
  test (`src/__tests__/no-echo-source-scan.test.ts`). Hint templates are
  covered by a behavioural test instead (every reason, both surfaces,
  every command, every fixture as the id). `src/board/init-remote.ts` is
  left out of the scan on the group 1 branch because group 2 rewrites its
  refusals; whichever group merges second adds it.
- Review round 1 (orchestrator DECISION on the ticket): when argument
  parsing fails, the actor a hint or message names comes from the parsed
  values or `AGENTBOARD_ACTOR`, never from scanning the raw arguments for
  `--as` (finding F1: in `close --unplanned --as <token>` the flag takes
  `--as` as its value and the token is the `<id>`, which the hint used to
  repeat as the actor); the id shape requires a first character of 0 to 7
  (narrowed to 0 in review round 2) and is tested without Unicode
  upper-casing (F2, F3; "Why the id exception"); and configuration a refusal repeats, the `AGENTBOARD_DIR`
  directory in `board-not-found` included, is escaped with `asciiText`
  like other repeated text, so an ESC sequence in the variable never
  reaches a terminal raw. The value itself stays out of scope ("Out of
  scope": configuration).
- Review round 2 (orchestrator DECISION on the ticket): the id shape
  requires a first character of 0 (`^0[0-9A-HJKMNP-TV-Z]{0,25}$`), and
  `NOT_AN_ID_MESSAGE` states it: `no ticket matches the id given, which
  is not a ticket id: an id is 26 characters of Crockford base32 (digits
  and letters other than I, L, O and U) starting with 0, or a unique
  prefix of at least 6 of them`.
- Two echoes found by the scan or the review are out of scope here: the
  `port-in-use` refusal names the `--port` number, which passed the
  integer and range checks and cannot hold a token, and is allowed; and an
  MCP `resources/read` of an unknown URI is refused with the SDK's own
  text `Resource <uri> not found`, a JSON-RPC error rather than a tool
  error, which repeats the URI. The second is left for a follow-up
  ticket, since it changes a recorded decision (board-agent-guidance
  "Guide over MCP").
- The token fixtures (`src/__tests__/harness/secret-fixtures.ts`) add a
  64-character hex string to the five of "Testing approach", compare
  without regard to case, and apply the eight-character substring rule
  of the URL with credentials to its user information only, so that a
  message naming another URL's scheme or host does not count as a leak.

## Compatibility

Message text is not a stable interface (CONTRIBUTING.md: until 1.0 a
minor version may change output), and the reasons, exit codes and JSON
fields that scripts branch on are unchanged. Tests that pin the old
messages are updated by the test author. The board-agent-guidance
scenario "Misspelled command" changes from "names `clam`" to "does not
name `clam`, suggests `claim`".

## Testing approach

One token-shaped fixture set used across the suites: a GitHub-style
token (`ghp_` plus 36 alphanumerics), an AWS-style key id (`AKIA` plus 16
upper-case alphanumerics), a 40-character hex string, a URL with
credentials (`https://agent:<token>@git.example.com/x.git`) and a
token that contains no character outside `[a-z0-9-]` but is longer than
26 characters. For each refusal class, a test passes the token as the
refused input and asserts that no fixture string, and no substring of
eight or more of its characters, appears in stdout, stderr, the `--json`
document, the MCP tool result (text and structured content) or the MCP
server's stderr; that the reason and exit code are unchanged; and that
the message names the argument (and the form or the choices). The id
exception is tested both ways: an id-shaped unknown id is named, a
non-id-shaped one is not, in the message and in the hint (`<id>`). A
source scan test lists every `BoardError` construction and `usage(...)`
call under `src/` whose message interpolates a value, and fails when one
appears that is not in an allow-list of the compliant cases (registry
names, board data, accepted values, the id helper), so a new refusal
cannot reintroduce the echo unnoticed.
