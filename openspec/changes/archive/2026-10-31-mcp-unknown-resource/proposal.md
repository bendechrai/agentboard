# Proposal

## Why

`no-echo-refusals` (archived 2026-10-31) made every refusal stop
repeating the input it refuses, on every surface, so that a token pasted
into the wrong argument never lands in a terminal, a log or an agent
transcript. One refusal was left out: an MCP `resources/read` of an
unknown URI. The server answers it with the text the SDK's own
`McpServer` uses, `Resource <uri> not found`, which repeats the URI
verbatim (on the wire, `MCP error -32602: Resource <uri> not found`).
That text was chosen on purpose by board-agent-guidance "Guide over MCP"
("the MCP InvalidParams error the SDK uses for an unknown resource"),
so changing it changes a recorded decision and was split off into its
own change (design.md of `no-echo-refusals`, "Rulings during the tests
(group 1)").

An MCP client is an agent whose whole session, requests and errors
included, is a transcript sent to a model provider and often kept. A URI
is free text the client chose; a credentialed URL or a token pasted into
it is repeated back today.

Ticket 01M5YD930V39N0203HTTMQHYMW.

## What Changes

- `resources/read` of a URI that is not one of the listed resources is
  refused with the server's own message, which names the resource URIs
  the server serves and never the URI requested:
  `unknown resource; the resources are agentboard://guide,
  agentboard://guide/orchestrator, agentboard://guide/test-author,
  agentboard://guide/implementer, agentboard://guide/reviewer` (built
  from the resource list, in `resources/list` order).
- The JSON-RPC error code stays `-32602` (InvalidParams), the code the
  server returns today and the SDK's `McpServer` uses for an unknown
  resource, so a client that branches on it is unaffected. The error has
  no `data` member. The wire `message` is exactly the text above, without
  the `MCP error -32602: ` prefix the SDK's `McpError` adds (an SDK
  client adds that prefix itself when it raises the error).
- URI matching stays exact, the read still needs no board and no actor,
  and an unknown URI still writes nothing to the server's stderr and does
  not stop the server.
- The other protocol errors the server can send were audited for echoes
  of client input (design.md "Audit"). None repeats client input today
  (an unknown method is `Method not found`; malformed parameters are the
  SDK's schema issues, which name the parameter path and the expected
  type only); a test pins each so that an SDK upgrade cannot bring an
  echo back unnoticed. The JSON-RPC `id` of the request is echoed in
  every response, as JSON-RPC requires, and is out of scope.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `board-agent-guidance`: "Guide over MCP" (MODIFIED) refuses an unknown
  URI with the server's own message naming the resource URIs, keeping the
  InvalidParams code, instead of the SDK's text.
- `board-cli`: "MCP protocol errors never repeat the request" (ADDED)
  extends the no-echo rule to the JSON-RPC errors of the MCP server, with
  scenarios for an unknown resource URI, an unknown method and malformed
  parameters.

No other requirement is modified. In particular board-cli "Refusals
never repeat the refused input" and "MCP server" are left as they are
(design.md "Why an added requirement").

## Impact

- `src/mcp/server.ts`: the `resources/read` handler's unknown-URI error
  and the module documentation (the design note naming the SDK's text).
- `src/mcp/__tests__/guide-mcp.test.ts` (`expectUnknown` asserts the new
  message instead of the URI) and a new no-echo test over a real stdio
  client of the built server.
- STATUS.md (the gap closed). README.md and the guide name no unknown-URI
  text, so neither changes.
- No new command, flag, exit code, reason, JSON field, tool, resource or
  capability; no change to the JSON-RPC error code.
