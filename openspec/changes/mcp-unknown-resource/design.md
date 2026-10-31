# Design

## Context

`agentboard mcp` installs its own handlers on the SDK's low-level
protocol server (`new McpServer(...).server`, `setRequestHandler`) for
`tools/list`, `tools/call`, `resources/list` and `resources/read`; it
never calls `McpServer.registerResource`, `registerPrompt` or
`registerTool`, so none of the SDK's `McpServer` handlers (and their
messages) are installed. The `resources/read` handler finds the URI in
`GUIDE_RESOURCES` by exact comparison and, for any other URI, throws
`new McpError(ErrorCode.InvalidParams, \`Resource ${uri} not found\`)`,
a copy of what `McpServer` throws (`@modelcontextprotocol/sdk` 1.30.1,
`dist/esm/server/mcp.js`). The protocol layer turns a thrown error into
`{code: error.code, message: error.message}` and `McpError` prefixes its
message with `MCP error <code>: `, so the wire error today is:

```
{"jsonrpc":"2.0","id":1,"error":{"code":-32602,
 "message":"MCP error -32602: Resource agentboard://<uri> not found"}}
```

and an SDK client raises `McpError` with message `MCP error -32602: MCP
error -32602: Resource <uri> not found` (the client adds the prefix
again).

## What "Guide over MCP" decided, and why

The requirement (from `add-agent-guidance`, archived 2026-09-24) serves
the guide and each role checklist as fixed `text/plain` resources and
says: "Reading any other URI SHALL fail with the MCP InvalidParams error
the SDK uses for an unknown resource." The server's design note adds
that URIs match exactly with no normalisation. The decision has three
parts:

1. The failure is a JSON-RPC protocol error, not a tool-style result:
   `resources/read` has no `isError` result shape, and a client that
   reads a resource expects either contents or an error.
2. Its code is `-32602` InvalidParams, the code the SDK's `McpServer`
   uses, so the server behaves like any SDK-built server and a later
   move to `registerResource` would change nothing visible.
3. Its text is the SDK's text.

Nothing in the archived change argues for part 3 on its own merits: the
text followed from copying the SDK's behaviour, at a time when no rule
about echoing refused input existed. `no-echo-refusals` then made that
rule for every refusal and listed this one as the only remaining echo.

This change keeps parts 1 and 2 and exact matching, and replaces part 3.
It is a narrow overturn of the requirement's wording ("the error the SDK
uses" pinned the text as well as the code) and consistent with its
intent (a conforming protocol error with the SDK's code). The
requirement is rewritten to say so explicitly, so no reader can take the
SDK's text as still required.

## The error

For a `resources/read` whose `uri` is a string that is not exactly one of
the listed URIs (including the empty string, a trailing slash, a query,
a fragment, a change of case, another scheme), the server answers:

```
{"jsonrpc":"2.0","id":<id>,"error":{"code":-32602,
 "message":"unknown resource; the resources are agentboard://guide, agentboard://guide/orchestrator, agentboard://guide/test-author, agentboard://guide/implementer, agentboard://guide/reviewer"}}
```

- The list is `GUIDE_RESOURCES` in `resources/list` order joined with
  `, `, built from the same constant, so a new role is listed without a
  second edit. It is registry data, never the request.
- The shape follows the MCP tool refusal `unknown tool; call tools/list
  for the tool names`: `unknown <thing>; ...`. Here the URIs are listed
  rather than pointing at `resources/list`, because there are five and
  listing them is what lets a model correct its call in one step; that
  is the "names the valid choices" half of the no-echo rule.
- No `data` member. The MCP specification's example error for a missing
  resource carries `data: {uri}`, which is exactly the echo this change
  removes.
- The wire `message` is exactly the text, without `MCP error -32602: `.
  The prefix is an SDK client's presentation of an error (its `McpError`
  adds it when raising the error response); sending it on the wire made
  SDK clients print it twice. The implementation throws an error whose
  `message` is the text and whose `code` is `ErrorCode.InvalidParams`
  (for example a small `Error` subclass with a numeric `code`, which the
  protocol layer serialises as it does `McpError`), or any other means
  that produces exactly this wire error; the tests pin the wire error,
  not the mechanism.
- Nothing is written to stderr, the read needs no board and no actor,
  and the server keeps serving, as today.

### Why keep -32602

The MCP specification (2025-11-25, server/resources, "Error Handling")
says servers SHOULD return `-32002` for "Resource not found". The SDK's
`ErrorCode` has no such member and its `McpServer` uses `-32602`, and
`-32602` is what this server has returned since it first served
resources. A client written
against the SDK, or against this server, branches on `-32602`; changing
the code would be a protocol-visible change that no echo concern
motivates. It is a separate decision (see "Out of scope").

## Why an added requirement

The no-echo rule lives in board-cli "Refusals never repeat the refused
input", whose surfaces are the CLI's output, the `--json` error document,
the MCP tool error, the web action error and the `agentboard: ` stderr
line. A JSON-RPC error of the MCP server is none of those. Modifying that
requirement would replace its whole text in this change's delta, and
`openspec/actor-secret-check` (proposed in parallel, about the actor that
requirement's "Out of scope" names) may modify it too; two MODIFIED
deltas of one requirement conflict at archive time. An ADDED board-cli
requirement, "MCP protocol errors never repeat the request", states the
same rule for the protocol surface without touching the existing text,
and refers to "Refusals never repeat the refused input" for the
definition. board-cli "MCP server" is also left alone: it describes tool
errors and does not mention resources.

Requirements this change touches: board-agent-guidance "Guide over MCP"
(MODIFIED); board-cli "MCP protocol errors never repeat the request"
(ADDED). No other.

## Audit

Every JSON-RPC error the server can send, found by reading the request
dispatch of the SDK's `Protocol` (`dist/esm/shared/protocol.js`
`_onrequest`, `setRequestHandler`), the `Server` overrides
(`dist/esm/server/index.js`: `initialize`, the `tools/call` wrapper,
capability checks), the stdio transport, and `src/mcp/server.ts`, and
confirmed by sending each request below over stdio to the built server
(0.3.0, SDK 1.30.1) with a GitHub-style token as the client-chosen
value. "Echoes" is what the wire error repeats.

| # | Request | Wire error today | Echoes | Disposition |
|---|---|---|---|---|
| 1 | `resources/read` with an unknown `uri` | `-32602`, `MCP error -32602: Resource <uri> not found` | the URI | changed: "The error" |
| 2 | `resources/read` with `uri` not a string, or missing | `-32603`, the SDK's schema issues as JSON (`expected string, received number`, path `params.uri`) | nothing (path and type only) | unchanged; pinned by a test |
| 3 | `resources/read` with an extra parameter | none: answered normally (schemas are not strict) | - | unchanged |
| 4 | `tools/call` with `name` not a string, or `arguments` not an object | `-32603`, schema issues (path `params.name` / `params.arguments`, expected type) | nothing | unchanged; pinned by a test |
| 5 | `tools/call` with an unknown tool name or argument | a tool error, not a protocol error (board-cli "Refusals never repeat the refused input") | nothing | already compliant |
| 6 | An unknown method (any text), including the methods of capabilities the server does not declare: `prompts/get`, `prompts/list`, `completion/complete`, `resources/subscribe`, `resources/templates/list`, `logging/setLevel`, `tasks/get` | `-32601`, `Method not found` | nothing | unchanged; pinned by a test |
| 7 | `tools/list`, `resources/list` with a `cursor` | none: answered with the full list, the cursor ignored | - | unchanged |
| 8 | `initialize` with an unsupported `protocolVersion` | none: answered with the server's own version | - | unchanged |
| 9 | A line that is not JSON | no response; nothing on stderr | - | unchanged |
| 10 | The JSON-RPC `id` of any request | echoed in every response | the id | excluded: JSON-RPC 2.0 requires the response to carry the request's id, and it is the client's correlation value, not refused input |
| 11 | A successful read's `contents[0].uri` | the URI, which is a listed one | - | not a refusal |

Rows 2 and 4 use `-32603` InternalError where JSON-RPC prescribes
`-32602` for invalid parameters; that is SDK behaviour, not an echo, and
is left alone (see "Out of scope"). The schema issue text names no value
for the types these schemas use (string, record, union); a test pins it
with a token so that an SDK or zod upgrade that starts quoting received
values fails.

Prompts: the server declares no `prompts` capability and registers no
prompt, so the SDK's `Prompt <name> not found` and `Invalid arguments for
prompt <name>` (which would echo) are unreachable: a `prompts/get` is
`Method not found` (row 6). The same holds for `Resource template <uri>
not found` (completion) and `Resource <uri> disabled`. Should the server
ever register prompts or resource templates through `McpServer`, those
SDK messages would echo; the added requirement covers every protocol
error, so such a change would have to replace them.

## Alternatives considered

- Point at `resources/list` instead of listing the URIs (`unknown
  resource; call resources/list for the resource URIs`). Rejected: one
  more round trip for five fixed URIs; the tool refusal points at
  `tools/list` only because there are eighteen tools with schemas.
- Install the handler with `McpServer.registerResource` and a fallback.
  Rejected: the SDK's handler text is the problem, and the server
  already owns the handler.
- Switch to `-32002` with this change. Rejected here: see "Why keep
  -32602".
- Keep the `MCP error -32602: ` prefix on the wire, for byte
  compatibility with the old message. Rejected: message text is not a
  stable interface before 1.0 (CONTRIBUTING.md), and the doubled prefix
  is noise in every client's transcript.

## Out of scope

- Changing the unknown-resource code to the specification's `-32002`.
- Changing the SDK's `-32603` for malformed parameters to `-32602`
  (rows 2 and 4): the server would have to validate every request before
  the SDK's schema parse, or patch the SDK.
- The JSON-RPC `id` (row 10).

## Compatibility

The code, the exact matching, the resource list and the read results are
unchanged. Only the error's message changes, and it loses its `MCP
error -32602: ` prefix on the wire. `src/mcp/__tests__/guide-mcp.test.ts`
asserts today that the message contains the URI; the test author
inverts that.

## Testing approach

Against the built server, with the SDK's `Client` over
`StdioClientTransport` (`mcpChild` in `src/mcp/__tests__/mcp-helpers.ts`),
and, for the wire-level checks (exact `message`, no `data`, rows 2, 4 and
6), with raw JSON-RPC lines written to the spawned server's stdin and its
stdout read line by line, since the SDK client rewrites the message and
validates parameters before sending. Each refused value is every fixture
of `src/__tests__/harness/secret-fixtures.ts` as the URI, the URI
`agentboard://guide/<fixture>`, and the fixture as a method name; the
leak check is `expectNoLeak` over the wire error, the client error and
the server's stderr. The in-process tests of `guide-mcp.test.ts` keep
their `UNKNOWN_URIS` list and assert the new message for each.
