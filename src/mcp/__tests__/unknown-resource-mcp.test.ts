/**
 * MCP protocol errors repeat nothing the client chose (mcp-unknown-resource
 * task 1.1; board-cli "MCP protocol errors never repeat the request",
 * scenarios "Unknown resource URI holding a token", "Error code for an
 * unknown resource", "Unknown method" and "Malformed parameters";
 * board-agent-guidance "Guide over MCP", scenarios "A listed URI is read as
 * before" and "Unknown URI names the resources"; design.md "The error" and
 * "Audit").
 *
 * Every request goes to the built server (`node dist/cli.js mcp`, built by
 * `make check` before the tests), two ways:
 * - with the SDK's `Client` over stdio (`mcpChild`), which raises the
 *   error as an `McpError` whose message is the wire message with the
 *   client's own `MCP error <code>: ` prefix added once;
 * - as raw JSON-RPC lines on the server's stdin, with each response line
 *   parsed from its stdout (`rawMcpChild`), so that the wire error itself
 *   (the exact `message`, the integer `code`, the absence of `data`) is
 *   checked and the SDK client's rewriting of the message and its own
 *   parameter validation cannot hide what the server sends.
 *
 * Each refused value is every fixture of
 * `src/__tests__/harness/secret-fixtures.ts`, as the whole URI, as
 * `agentboard://guide/<fixture>` and as a method name; `expectNoLeak`
 * checks the response line, the error the client raises and the server's
 * stderr. The JSON-RPC ids are numbers chosen by the harness, never a
 * fixture (design.md "Audit" row 10: the id is echoed by protocol).
 */

import { rmSync } from 'node:fs';

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';

import { boardProject, cliEnv } from '../../__tests__/harness/processes.js';
import {
  GITHUB_TOKEN,
  SECRET_FIXTURES,
  expectNoLeak,
  type SecretFixture,
} from '../../__tests__/harness/secret-fixtures.js';
import { spawnCli } from '../../cli/__tests__/cli-helpers.js';
import { GUIDE_RESOURCE_URI, ROLES } from '../../guidance/guide.js';
import { tempDir } from '../../store/__tests__/helpers.js';
import {
  UNKNOWN_RESOURCE_CLIENT_MESSAGE,
  UNKNOWN_RESOURCE_MESSAGE,
  mcpChild,
  rawMcpChild,
  type RawMcpChild,
  type RawResponse,
} from './mcp-helpers.js';

// Machines under load: the fixture loops send many requests per server.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/** Every URI `resources/list` returns, in order. */
const URIS: readonly string[] = [
  GUIDE_RESOURCE_URI,
  ...ROLES.map((role) => `${GUIDE_RESOURCE_URI}/${role}`),
];

/** The two unknown URIs each fixture is read as (tasks.md 1.1 Verify). */
function unknownUris(f: SecretFixture): readonly string[] {
  return [f.value, `${GUIDE_RESOURCE_URI}/${f.value}`];
}

/**
 * Near misses of a listed URI: one character off, a trailing slash, a
 * change of case, a query, a fragment, another scheme, the empty string.
 */
const NEAR_MISSES: readonly string[] = [
  'agentboard://guide/reviewr',
  'agentboard://guide/reviewer/',
  'agentboard://guide/Reviewer',
  'agentboard://guide/reviewer?x=1',
  'agentboard://guide/reviewer#top',
  'agentboard:/guide/reviewer',
  'https://guide/reviewer',
  '',
];

/** The stdout of the built CLI's `help agents [--role <role>]`. */
function helpAgents(role?: string): string {
  const out = spawnCli(
    role === undefined ? ['help', 'agents'] : ['help', 'agents', '--role', role],
    tempDir(),
    cliEnv(),
  );
  expect(out.code, out.stderr).toBe(0);
  expect(out.stdout.length).toBeGreaterThan(0);
  return out.stdout;
}

/**
 * Asserts that `response` is exactly the unknown-resource error: the
 * request's id, code the integer -32602, the message with no
 * `MCP error` prefix, and no other member (so no `data`).
 */
function expectUnknownResourceWire(response: RawResponse, what: string): void {
  const { json } = response;
  expect(Object.keys(json).sort(), what).toEqual(['error', 'id', 'jsonrpc']);
  const error = json.error as Record<string, unknown>;
  expect(Object.keys(error).sort(), what).toEqual(['code', 'message']);
  expect(error.code, what).toBe(-32602);
  expect(Number.isInteger(error.code), what).toBe(true);
  expect(error.message, what).toBe(UNKNOWN_RESOURCE_MESSAGE);
  expect(String(error.message).startsWith('MCP error'), what).toBe(false);
  expect('data' in error, what).toBe(false);
}

/** Reads `uri` raw and returns the single text content, which must be the listed one. */
async function rawReadText(raw: RawMcpChild, uri: string): Promise<string> {
  const response = await raw.request('resources/read', { uri });
  expect(response.json.error, response.line).toBeUndefined();
  const result = response.json.result as { contents: unknown[] };
  expect(result.contents).toHaveLength(1);
  expect(result.contents[0]).toEqual({
    uri,
    mimeType: 'text/plain',
    text: expect.any(String) as string,
  });
  return (result.contents[0] as { text: string }).text;
}

/** The error an SDK client's `readResource` of `uri` raises, or undefined. */
async function clientError(
  read: (uri: string) => Promise<unknown>,
  uri: string,
): Promise<McpError | undefined> {
  const error: unknown = await read(uri).then(
    () => undefined,
    (e: unknown) => e,
  );
  if (error === undefined) {
    return undefined;
  }
  expect(error, uri).toBeInstanceOf(McpError);
  return error as McpError;
}

/** Every part of a raised client error that a transcript could show. */
function errorParts(error: McpError | undefined): unknown[] {
  return error === undefined
    ? []
    : [error.message, error.code, error.data ?? null, String(error), error.stack ?? ''];
}

describe('the expected message', () => {
  it('lists the resources/list URIs of the built server, in order, joined with ", "', async () => {
    const { root } = boardProject();
    const child = await mcpChild(root);
    const { resources } = await child.client.listResources();
    expect(resources.map((r) => r.uri)).toEqual(URIS);
    expect(UNKNOWN_RESOURCE_MESSAGE).toBe(`unknown resource; the resources are ${URIS.join(', ')}`);
    expect(UNKNOWN_RESOURCE_CLIENT_MESSAGE).toBe(`MCP error -32602: ${UNKNOWN_RESOURCE_MESSAGE}`);
  });
});

describe('unknown resource URI, through a real stdio client', () => {
  it('scenario: unknown resource URI holding a token, every fixture as the URI and under agentboard://guide/', async () => {
    const { root } = boardProject();
    const child = await mcpChild(root);
    for (const f of SECRET_FIXTURES) {
      for (const uri of unknownUris(f)) {
        const error = await clientError((u) => child.client.readResource({ uri: u }), uri);
        expectNoLeak(`readResource ${f.name} error`, errorParts(error), [f]);
        expect(error, f.name).toBeDefined();
        expect(error?.code, f.name).toBe(ErrorCode.InvalidParams);
        expect(error?.message, f.name).toBe(UNKNOWN_RESOURCE_CLIENT_MESSAGE);
        expect(error?.data, f.name).toBeUndefined();
      }
    }
    expectNoLeak('server stderr', [child.stderr()]);
    expect(child.stderr()).toBe('');
    expect(child.errors).toEqual([]);
  });

  it('scenario: a listed URI is read as before after an unknown one', async () => {
    const { root } = boardProject();
    const child = await mcpChild(root);
    const error = await clientError(
      (u) => child.client.readResource({ uri: u }),
      `${GUIDE_RESOURCE_URI}/${GITHUB_TOKEN}`,
    );
    expect(error?.message).toBe(UNKNOWN_RESOURCE_CLIENT_MESSAGE);
    const uri = `${GUIDE_RESOURCE_URI}/reviewer`;
    const result = await child.client.readResource({ uri });
    expect(result.contents).toEqual([
      { uri, mimeType: 'text/plain', text: helpAgents('reviewer') },
    ]);
    expect(child.stderr()).toBe('');
    expect(child.errors).toEqual([]);
  });

  it.each(NEAR_MISSES)('the near miss %j gets the same message', async (uri) => {
    const { root } = boardProject();
    const child = await mcpChild(root);
    const error = await clientError((u) => child.client.readResource({ uri: u }), uri);
    expect(error?.code, uri).toBe(ErrorCode.InvalidParams);
    expect(error?.message, uri).toBe(UNKNOWN_RESOURCE_CLIENT_MESSAGE);
    expect(error?.data, uri).toBeUndefined();
    expect(child.stderr()).toBe('');
  });
});

describe('unknown resource URI, as raw JSON-RPC', () => {
  it('scenario: unknown resource URI holding a token, every fixture as the URI and under agentboard://guide/', async () => {
    const { root } = boardProject();
    const raw = await rawMcpChild(root);
    for (const f of SECRET_FIXTURES) {
      for (const uri of unknownUris(f)) {
        const response = await raw.request('resources/read', { uri });
        expectNoLeak(`resources/read ${f.name} response`, [response.line], [f]);
        expectUnknownResourceWire(response, `${f.name}: ${uri === f.value ? 'whole' : 'guide/'}`);
      }
    }
    expectNoLeak('server stderr', [raw.stderr()]);
    expect(raw.stderr()).toBe('');
  });

  it('scenario: error code for an unknown resource is the integer -32602, no MCP error prefix, no data', async () => {
    const { root } = boardProject();
    const raw = await rawMcpChild(root);
    const response = await raw.request('resources/read', { uri: 'agentboard://nope' });
    expectUnknownResourceWire(response, 'agentboard://nope');
    expect(response.line).toMatch(/"code":-32602[,}]/);
  });

  it('scenario: unknown URI names the resources, and nope appears nowhere', async () => {
    const { root } = boardProject();
    const raw = await rawMcpChild(root);
    const response = await raw.request('resources/read', { uri: 'agentboard://nope' });
    expectUnknownResourceWire(response, 'agentboard://nope');
    expect(response.line).not.toContain('nope');
    expect(raw.stderr()).not.toContain('nope');
    expect(raw.stderr()).toBe('');
  });

  it.each(NEAR_MISSES)('the near miss %j gets exactly the same wire error', async (uri) => {
    const { root } = boardProject();
    const raw = await rawMcpChild(root);
    expectUnknownResourceWire(await raw.request('resources/read', { uri }), uri);
    expect(raw.stderr()).toBe('');
  });

  it('scenario: a listed URI is read as before after an unknown one, and the server keeps serving', async () => {
    const { root } = boardProject();
    const raw = await rawMcpChild(root);
    for (const f of SECRET_FIXTURES) {
      expectUnknownResourceWire(
        await raw.request('resources/read', { uri: `${GUIDE_RESOURCE_URI}/${f.value}` }),
        f.name,
      );
    }
    expect(await rawReadText(raw, `${GUIDE_RESOURCE_URI}/reviewer`)).toBe(helpAgents('reviewer'));
    expect(await rawReadText(raw, GUIDE_RESOURCE_URI)).toBe(helpAgents());
    for (const role of ROLES) {
      expect(await rawReadText(raw, `${GUIDE_RESOURCE_URI}/${role}`), role).toBe(helpAgents(role));
    }
    const listed = await raw.request('resources/list', {});
    expect(
      (listed.json.result as { resources: { uri: string }[] }).resources.map((r) => r.uri),
    ).toEqual(URIS);
    expect(raw.stderr()).toBe('');
    expect(await raw.close()).toBe(0);
  });

  it('needs no actor and no board after start-up', async () => {
    const { root, boardDir } = boardProject();
    const env = cliEnv();
    expect(env.AGENTBOARD_ACTOR).toBeUndefined();
    const raw = await rawMcpChild(root, env);
    rmSync(boardDir, { recursive: true, force: true });
    expectUnknownResourceWire(
      await raw.request('resources/read', { uri: `${GUIDE_RESOURCE_URI}/${GITHUB_TOKEN}` }),
      'no board',
    );
    expect(await rawReadText(raw, `${GUIDE_RESOURCE_URI}/reviewer`)).toBe(helpAgents('reviewer'));
    expect(raw.stderr()).toBe('');
  });
});

/** Asserts that `response` is exactly the JSON-RPC `Method not found` error. */
function expectMethodNotFound(response: RawResponse, what: string): void {
  expect(response.json, what).toStrictEqual({
    jsonrpc: '2.0',
    id: response.json.id,
    error: { code: -32601, message: 'Method not found' },
  });
}

describe('scenario: unknown method (design.md "Audit" row 6)', () => {
  it('every fixture as the method is Method not found, repeating nothing', async () => {
    const { root } = boardProject();
    const raw = await rawMcpChild(root);
    for (const f of SECRET_FIXTURES) {
      const response = await raw.request(f.value, { value: f.value });
      expectNoLeak(`method ${f.name} response`, [response.line], [f]);
      expectMethodNotFound(response, f.name);
    }
    expectNoLeak('server stderr', [raw.stderr()]);
    expect(raw.stderr()).toBe('');
  });

  it('the methods of undeclared capabilities, with a token in their parameters, are Method not found', async () => {
    const { root } = boardProject();
    const raw = await rawMcpChild(root);
    const token = GITHUB_TOKEN;
    const requests: readonly [string, unknown][] = [
      ['prompts/get', { name: token, arguments: { value: token } }],
      ['prompts/list', { cursor: token }],
      [
        'completion/complete',
        {
          ref: { type: 'ref/resource', uri: `${GUIDE_RESOURCE_URI}/${token}` },
          argument: { name: token, value: token },
        },
      ],
      [
        'completion/complete',
        { ref: { type: 'ref/prompt', name: token }, argument: { name: token, value: token } },
      ],
      ['resources/subscribe', { uri: `${GUIDE_RESOURCE_URI}/${token}` }],
      ['resources/unsubscribe', { uri: token }],
      ['resources/templates/list', { cursor: token }],
      ['logging/setLevel', { level: token }],
      ['tasks/get', { taskId: token }],
    ];
    for (const [method, params] of requests) {
      const response = await raw.request(method, params);
      expectNoLeak(`${method} response`, [response.line]);
      expectMethodNotFound(response, method);
    }
    expectNoLeak('server stderr', [raw.stderr()]);
    expect(raw.stderr()).toBe('');
    expect(await rawReadText(raw, GUIDE_RESOURCE_URI)).toBe(helpAgents());
  });
});

describe('scenario: malformed parameters (design.md "Audit" rows 2 and 4)', () => {
  // The SDK's code for parameters that fail its schema: -32603 today
  // (design.md "Audit", rows 2 and 4, left alone), -32602 if an SDK
  // upgrade corrects it. Either keeps the requirement; any other code is a
  // protocol-visible change.
  const SCHEMA_CODES: readonly number[] = [ErrorCode.InternalError, ErrorCode.InvalidParams];
  const token = GITHUB_TOKEN;
  const requests: readonly { method: string; params: unknown; path: string }[] = [
    { method: 'resources/read', params: { uri: 42 }, path: 'uri' },
    { method: 'resources/read', params: { uri: [token] }, path: 'uri' },
    { method: 'resources/read', params: { uri: { value: token } }, path: 'uri' },
    { method: 'resources/read', params: { value: token }, path: 'uri' },
    { method: 'tools/call', params: { name: 42 }, path: 'name' },
    { method: 'tools/call', params: { name: [token] }, path: 'name' },
    { method: 'tools/call', params: { name: 'board_show', arguments: token }, path: 'arguments' },
    { method: 'tools/call', params: { name: token, arguments: [token] }, path: 'arguments' },
  ];

  it('each is a JSON-RPC error naming the parameter, repeating no token, and the server keeps serving', async () => {
    const { root } = boardProject();
    const raw = await rawMcpChild(root);
    for (const { method, params, path } of requests) {
      const what = `${method} ${JSON.stringify(params).replace(token, '<token>')}`;
      const response = await raw.request(method, params);
      expectNoLeak(`${what} response`, [response.line]);
      expect(response.json.result, what).toBeUndefined();
      const error = response.json.error as Record<string, unknown> | undefined;
      expect(error, what).toBeDefined();
      expect(SCHEMA_CODES, what).toContain(error?.code);
      expect(String(error?.message), what).toContain(`"${path}"`);
      expect(error !== undefined && 'data' in error, what).toBe(false);
    }
    expectNoLeak('server stderr', [raw.stderr()]);
    expect(raw.stderr()).toBe('');
    expect(await rawReadText(raw, GUIDE_RESOURCE_URI)).toBe(helpAgents());
    const listed = await raw.request('tools/list', {});
    expect(listed.json.error, listed.line).toBeUndefined();
    expect(await raw.close()).toBe(0);
  });

  it('every fixture inside a malformed uri or tool name repeats nothing', async () => {
    const { root } = boardProject();
    const raw = await rawMcpChild(root);
    for (const f of SECRET_FIXTURES) {
      for (const [method, params] of [
        ['resources/read', { uri: [f.value] }],
        ['tools/call', { name: { value: f.value } }],
        ['tools/call', { name: 'board_show', arguments: f.value }],
      ] as const) {
        const response = await raw.request(method, params);
        expectNoLeak(`${method} ${f.name} response`, [response.line], [f]);
        expect(response.json.error, `${method} ${f.name}`).toBeDefined();
      }
    }
    expectNoLeak('server stderr', [raw.stderr()]);
    expect(raw.stderr()).toBe('');
  });
});
