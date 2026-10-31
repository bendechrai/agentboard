# Proposal

## Why

`add-claim-leases` ruled that the refusals it added (an unknown `config`
key, a refused `config set` value, `--ttl` and `--timeout`) never repeat
the refused input, because a token-shaped value (a secret pasted into the
wrong argument, or shifted into it by an unset shell variable) would
otherwise be copied into a terminal, a log, an MCP transcript or a CI log.
The ruling was scoped to that group (group 3 ticket, "review round 3"
DECISION, finding F6); the older refusals were left for their own ticket.

They still echo. `agentboard move <id> <token>` prints `unknown status
<token>; expected one of ...`, and the same habit runs through the parser
(unknown command, unknown flag, unexpected argument, non-integer value),
the value checks of the registry and the board (task references, change
names, groups, task filters, `health` durations, ticket ids, `inbox
--since`, decision paths, `import-change` targets), the guidance commands
(`help` subtopics, `--role`, `--target`), the MCP argument path (unknown
tool, unknown argument), the hints (which repeat the ticket id exactly as
given) and the `init --remote` refusals (which repeat the URL, credentials
included, and quote git's error about it). Every one of these reaches the
CLI's stderr, its `--json` error document, the MCP tool error and the MCP
server's stderr, and most of them reach the web app's action errors too.

Ticket 01M5X7EGBFRQA4BH7R0A35ZW50.

## What Changes

- One rule for every refusal on every surface: a refusal never repeats
  the refused input (the value, flag name, command word, tool name or
  tool argument name whose check failed). It names the argument instead
  (`--task`, `<status>`, the tool argument `id`, or the position of an
  unknown flag or extra argument) and the expected form or the valid
  choices. design.md "The rule" states it with its one exception.
- The exception: a ticket id or id prefix is repeated when it has the
  shape of one (1 to 26 Crockford base32 characters, case-insensitive,
  the first of them 0 as in every ULID until about the year 3084),
  because naming the id that matched nothing is useful and that shape
  cannot hold a typical token. An id of any other shape is not repeated,
  in the message or in a hint, which writes `<id>` for it.
- About 40 refusals change message text (design.md "Audit"). No exit
  code, reason token, JSON field or hint step changes, except that hints
  write `<id>` for an id that is not id-shaped.
- The unknown command and unknown flag messages (board-agent-guidance
  "Unknown command suggestions") keep their suggestions and stop naming
  the token; the unknown flag message names its argument position.
- `init --remote` refusals stop repeating the URL given, and the git
  error line they quote has the URL given replaced by `<url>` and any
  URL credentials replaced by `<redacted>`.
- The library entry points that refuse numbers (`config set` values,
  ttls and timeouts given in milliseconds) follow the same rule.

Not changed: refusals that name accepted input (an actor, a decision
path that passed its checks, a resolved ticket id), refusals that name
board data or configuration (matching ids of an ambiguous prefix, a
configured remote and its URL, the path the board was looked for at),
success output, and the secret-pattern refusals (which already name the
pattern, not the text). design.md "Out of scope" says why and what is
left for a follow-up.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `board-cli`: new requirements "Refusals never repeat the refused
  input" (the rule on every surface, with scenarios per refusal class on
  the CLI, `--json`, MCP and the web actions) and "Ticket ids in
  refusals" (the id-shape exception, in messages and hints); "Close
  requires a decision disposition" (a missing decision path is named by
  its flag, not its text); "Board in a separate repository" (`init
  --remote` refusals and the git line they quote).
- `board-agent-guidance`: "Unknown command suggestions" (the token is
  not named; the suggestions and the unknown flag's position are).

## Impact

- `src/cli/parse.ts` (unknown flag, unexpected argument, integer
  messages), `src/guidance/suggest.ts` (unknown command and flag
  messages), `src/cli/registry.ts` (status, `--change` of `list`,
  `health` durations), `src/board/resolve.ts` (ids, task references,
  change names, groups, task filters), `src/board/inbox.ts`,
  `src/board/paths.ts`, `src/board/actions.ts` (decision path, ttl),
  `src/board/wait.ts`, `src/board/config.ts`, `src/board/import.ts`,
  `src/board/openspec.ts`, `src/guidance/help.ts`, `src/guidance/guide.ts`,
  `src/guidance/install.ts`, `src/guidance/hints.ts` (the id
  substitution), `src/mcp/tools.ts` and `src/mcp/server.ts` (unknown
  argument and tool), `src/board/init-remote.ts` (URL refusals).
- Tests that pin the old messages are updated; new tests pass a
  token-shaped value through each refusal class on each surface and
  assert it appears nowhere in stdout, stderr, the `--json` document,
  the MCP tool result or the MCP server's stderr.
- No new command, flag, exit code, reason, JSON field or event.
- Independent of the open changes `guard-stale-temporary` (board-concurrency)
  and `keep-cursors-on-upgrade` (board-cache): neither modifies a
  requirement this change touches.
