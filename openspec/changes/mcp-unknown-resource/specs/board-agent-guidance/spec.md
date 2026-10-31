## MODIFIED Requirements

### Requirement: Guide over MCP
The `mcp` server SHALL send, as its server `instructions`, a summary of the
agent guide of at most 2000 characters that ends by naming the resource
`agentboard://guide`, and SHALL expose the full output of
`agentboard help agents` as that resource with MIME type `text/plain`. It
SHALL also expose each role's checklist, the output of
`agentboard help agents --role <role>`, as `agentboard://guide/<role>`,
because `help` is not an MCP tool. Resource URIs SHALL match exactly, with
no normalisation. Reading any other URI SHALL fail with a JSON-RPC error
whose code is `-32602` (InvalidParams, the code the SDK's `McpServer` uses
for an unknown resource), whose `message` is exactly `unknown resource;
the resources are ` followed by every resource URI in `resources/list`
order joined with `, `, and which has no `data` member. The error SHALL
NOT repeat any part of the URI requested (board-cli "MCP protocol errors
never repeat the request"), SHALL write nothing to the server's stderr,
and SHALL leave the server serving.

#### Scenario: Client reads the guide
- **WHEN** an MCP client reads the resource `agentboard://guide`
- **THEN** its text is identical to the stdout of `agentboard help agents` for the same version

#### Scenario: A listed URI is read as before
- **WHEN** an MCP client reads `agentboard://guide/reviewer` after reading an unknown URI
- **THEN** it gets exactly one content item with that URI, MIME type `text/plain` and the stdout of `agentboard help agents --role reviewer`

#### Scenario: Unknown URI names the resources
- **WHEN** an MCP client reads `agentboard://nope`
- **THEN** the response is a JSON-RPC error with code `-32602`, message `unknown resource; the resources are agentboard://guide, agentboard://guide/orchestrator, agentboard://guide/test-author, agentboard://guide/implementer, agentboard://guide/reviewer` and no `data`, and the text `nope` appears nowhere in the response or in the server's stderr
