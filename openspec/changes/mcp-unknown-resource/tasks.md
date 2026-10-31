# Tasks

Independent of `actor-secret-check` and `into-host-replaced-after-step-4`
(proposed in parallel): this change modifies board-agent-guidance "Guide
over MCP" and adds board-cli "MCP protocol errors never repeat the
request", and modifies no other requirement, so the changes may be
archived in any order unless one of them also modifies "Guide over MCP".

The group is delivered by a test author, an implementer and a reviewer in
turn (see CONTRIBUTING.md), on one branch cut from `origin/staging`. The
production change is the unknown-URI error of the `resources/read`
handler and documentation only: no exit code, reason, tool, resource,
capability or JSON-RPC error code may change. MCP tests use a real stdio
client of the built server (`mcpChild` in
`src/mcp/__tests__/mcp-helpers.ts`), and the wire-level checks write raw
JSON-RPC lines to the spawned server's stdin and parse its stdout, since
the SDK client rewrites error messages and validates parameters before
sending. Token values come from `src/__tests__/harness/secret-fixtures.ts`
and leaks are checked with `expectNoLeak`. The reviewer recomputes the
expected unknown-resource message with a throwaway program that does not
import the code under review (from the role list in the spec), and runs
the built server by hand with at least two fixtures, grepping the
captured stdout and stderr. Verification for every task includes `make
check` passing with coverage at or above 90 percent.

## 1. Unknown resource URI names only the resources (`mcp/mcp-unknown-resource`)

- [ ] 1.1 Tests (test author). Update `expectUnknown` in `src/mcp/__tests__/guide-mcp.test.ts` to assert code `ErrorCode.InvalidParams` and the exact message for every entry of `UNKNOWN_URIS`, and that the message does not contain the URI; add `src/mcp/__tests__/unknown-resource-mcp.test.ts` covering the board-cli scenarios "Unknown resource URI holding a token", "Error code for an unknown resource", "Unknown method" and "Malformed parameters" and the board-agent-guidance scenarios "A listed URI is read as before" and "Unknown URI names the resources". Verify: against the unchanged server, the unknown-URI tests fail (the message names the URI and carries the `MCP error -32602: ` prefix on the wire) and the unknown-method and malformed-parameter tests pass, recorded in the PR; each fixture is used as the whole URI and as `agentboard://guide/<fixture>`; the wire tests assert `code` is the integer `-32602`, the `message` exactly, and no `data`; a listed URI read after an unknown one returns its CLI-identical text; the server's stderr is empty after the unknown reads
- [ ] 1.2 Implementation (implementer). In `src/mcp/server.ts`, refuse an unknown URI as design.md "The error" says: the message built from `GUIDE_RESOURCES` in list order, code `ErrorCode.InvalidParams`, no `data`, the wire message without the `MCP error <code>: ` prefix; update the module documentation and the `connect` doc comment (the design note naming the SDK's text becomes the new message and the reason it never repeats the URI). Verify: every test of 1.1 passes without editing the tests; `UNKNOWN_URIS` (empty string, trailing slash, query, fragment, case change, other scheme) all get the same message; a mutant check recorded in the PR (appending the URI to the message, and adding `data: {uri}`, each make a test fail; building the list from a hard-coded string that omits one role makes a test fail)
- [ ] 1.3 Review and documentation (reviewer, with STATUS.md updated by the implementer). Check every row of design.md "Audit" against the code and the built server (rows 2 to 11 still need no change), and that no `McpError` or thrown error under `src/mcp/` interpolates a request value. Update STATUS.md (the gap closed). Verify: `make ascii`, `make validate-specs` and `make check` pass; the reviewer's recomputed message equals the test's expectation; the hand run's captured output contains no fixture substring of eight or more characters
