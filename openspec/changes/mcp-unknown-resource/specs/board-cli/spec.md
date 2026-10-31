## ADDED Requirements

### Requirement: MCP protocol errors never repeat the request
A JSON-RPC error sent by `agentboard mcp` (an error response to an MCP
request, as opposed to a tool error) SHALL NOT contain any part of a value
the client chose in the request's method or parameters: not in its
`message` and not in a `data` member. This extends the rule of "Refusals
never repeat the refused input" to the protocol surface, with the same
definition of refused input and no ticket id exception. The error SHALL
name what it refuses (the resource, the method, the parameter path) and,
where the valid values are few and fixed, list them. The JSON-RPC `id` of
the request, which every response carries by the JSON-RPC protocol, is not
covered. Error codes are those the server sends today: `-32602` for an
unknown resource, `-32601` for an unknown method, and the SDK's code for a
request whose parameters fail its schema.

#### Scenario: Unknown resource URI holding a token
- **WHEN** an MCP client reads a resource whose URI is a token-shaped value, `agentboard://guide/<token>`, or a URL with credentials (`https://agent:<token>@git.example.com/x.git`), through a real stdio client of the built server and as a raw JSON-RPC request
- **THEN** each response is a JSON-RPC error with code `-32602` whose message is the "Guide over MCP" unknown-resource message, and the token appears nowhere in the response, in the error the client raises or in the server's stderr

#### Scenario: Error code for an unknown resource
- **WHEN** a raw JSON-RPC `resources/read` request names an unknown URI
- **THEN** the error's `code` is the integer `-32602`, its `message` does not begin with `MCP error`, and it has no `data` member

#### Scenario: Unknown method
- **WHEN** a raw JSON-RPC request has a token-shaped value as its method, and requests `prompts/get` with a token-shaped `name`
- **THEN** each response is a JSON-RPC error with code `-32601` and message `Method not found`, and the token appears nowhere in the response or in the server's stderr

#### Scenario: Malformed parameters
- **WHEN** raw JSON-RPC requests send `resources/read` with `uri` a number, `tools/call` with `name` a number, and `tools/call` with `arguments` a token-shaped string
- **THEN** each response is a JSON-RPC error, the server keeps serving, and the token appears nowhere in any response or in the server's stderr
