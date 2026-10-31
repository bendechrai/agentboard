/**
 * The guide over MCP (board-agent-guidance: "Guide over MCP"): the server
 * `instructions` are the guide summary, and the resources
 * `agentboard://guide` and `agentboard://guide/<role>` serve exactly what `agentboard help agents
 * [--role <role>]` prints. In process over an in-memory transport, and
 * against `node dist/cli.js mcp` spawned with the SDK client, compared
 * byte for byte with the built CLI's stdout.
 */

import { rmSync } from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';

import { boardProject } from '../../__tests__/harness/processes.js';
import { cliEnv, project, run, spawnCli } from '../../cli/__tests__/cli-helpers.js';
import {
  ASCII_LINE,
  commandLines,
  parseLine,
  unservedTools,
} from '../../guidance/__tests__/guide-lines.js';
import {
  GUIDE_RESOURCE_URI,
  GUIDE_SUMMARY_MAX_CHARS,
  ROLES,
  renderGuide,
  renderGuideSummary,
  renderRoleChecklist,
} from '../../guidance/guide.js';
import { tempDir } from '../../store/__tests__/helpers.js';
import { VERSION } from '../../version.js';
import { createMcpServer, type BoardMcpServer } from '../server.js';
import {
  UNKNOWN_RESOURCE_CLIENT_MESSAGE,
  UNKNOWN_RESOURCE_MESSAGE,
  mcpChild,
} from './mcp-helpers.js';

const servers: BoardMcpServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close();
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

/** Every URI `resources/list` must return, in order. */
const URIS: readonly string[] = [
  GUIDE_RESOURCE_URI,
  ...ROLES.map((role) => `${GUIDE_RESOURCE_URI}/${role}`),
];

/** URIs that are not resources: near misses of the listed ones. */
const UNKNOWN_URIS: readonly string[] = [
  'agentboard://nope',
  'agentboard://guide/',
  'agentboard://guide/tester',
  'agentboard://GUIDE',
  'agentboard://guide?role=implementer',
  'agentboard://guide#top',
  'agentboard:guide',
  'file:///etc/passwd',
  '',
];

interface InProcess {
  client: Client;
  boardDir: string;
  stderr: () => string;
}

/** A server on a fresh board, with an SDK client connected in memory. */
async function inProcess(): Promise<InProcess> {
  const { root, boardDir } = project();
  let err = '';
  const server = createMcpServer({
    cwd: root,
    env: cliEnv(),
    stderr: (text) => {
      err += text;
    },
  });
  servers.push(server);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'agentboard-test', version: '0.0.0' });
  await client.connect(clientSide);
  clients.push(client);
  return { client, boardDir, stderr: () => err };
}

/** The single text content of a `resources/read` of `uri`. */
async function readText(client: Client, uri: string): Promise<string> {
  const result = await client.readResource({ uri });
  expect(result.contents).toHaveLength(1);
  const [content] = result.contents;
  expect(content).toEqual({ uri, mimeType: 'text/plain', text: expect.any(String) as string });
  return (content as { text: string }).text;
}

/**
 * Asserts that reading `uri` is refused with code InvalidParams, the
 * unknown-resource message (raised by the SDK client with its own
 * `MCP error -32602: ` prefix, once) and no `data`, and that the message
 * does not repeat the URI. A URI that is part of a listed one (the
 * trailing-slash near miss is the prefix of every role URI) is covered by
 * the exact message alone.
 */
async function expectUnknown(client: Client, uri: string): Promise<void> {
  const error: unknown = await client.readResource({ uri }).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, uri).toBeInstanceOf(McpError);
  const mcpError = error as McpError;
  expect(mcpError.code, uri).toBe(ErrorCode.InvalidParams);
  expect(mcpError.message, uri).toBe(UNKNOWN_RESOURCE_CLIENT_MESSAGE);
  expect(mcpError.data, uri).toBeUndefined();
  if (uri !== '' && !UNKNOWN_RESOURCE_MESSAGE.includes(uri)) {
    expect(mcpError.message, uri).not.toContain(uri);
  }
}

/** The instructions checks that hold for any build of this version. */
function expectInstructions(instructions: string | undefined): void {
  expect(instructions).toBeDefined();
  const text = instructions ?? '';
  expect(text.length).toBeLessThanOrEqual(GUIDE_SUMMARY_MAX_CHARS);
  for (const line of text.replace(/\n$/, '').split('\n')) {
    expect(line, JSON.stringify(line)).toMatch(ASCII_LINE);
  }
  expect(text.trimEnd().endsWith(`${GUIDE_RESOURCE_URI}.`)).toBe(true);
  for (const fragment of [
    'as argument',
    'AGENTBOARD_ACTOR',
    'board_claim',
    'board_handoff',
    'blocked',
    'DECISION:',
    'tasks.md',
  ]) {
    expect(text, fragment).toContain(fragment);
  }
  // The mutex worker rule (add-claim-leases task 6.1; board-agent-guidance
  // "Mutex ticket recipe", scenario "MCP instructions carry the worker
  // rule"), read with line breaks as spaces.
  const flat = text.replace(/\s+/g, ' ').toLowerCase();
  for (const fragment of [
    'never wait on a mutex',
    'in a loop',
    'background process',
    'only joins the queue',
  ]) {
    expect(flat, fragment).toContain(fragment);
  }
  for (const line of commandLines(text)) {
    expect(() => parseLine(line), line).not.toThrow();
  }
  expect(unservedTools(text)).toEqual([]);
  // The refusal ADR 0013 removed (add-adhoc-ticket-lifecycle task 5.1).
  expect(text).not.toContain('needs-task-link');
  expect(text).not.toMatch(/cannot enter implementing/i);
}

describe('guide over MCP, in process', () => {
  it('initialize carries the guide summary as instructions', async () => {
    const { client } = await inProcess();
    expect(client.getInstructions()).toBe(renderGuideSummary(VERSION));
    expectInstructions(client.getInstructions());
  });

  it('declares the resources capability without subscribe or listChanged, beside tools', async () => {
    const { client } = await inProcess();
    const capabilities = client.getServerCapabilities();
    expect(capabilities?.tools).toBeDefined();
    expect(capabilities?.resources).toEqual({});
  });

  it('lists the guide and each role checklist as text/plain resources, in order', async () => {
    const { client } = await inProcess();
    const { resources, nextCursor } = await client.listResources();
    expect(nextCursor).toBeUndefined();
    expect(resources.map((r) => r.uri)).toEqual(URIS);
    expect(resources.map((r) => r.name)).toEqual(['guide', ...ROLES.map((r) => `guide-${r}`)]);
    for (const resource of resources) {
      expect(resource.mimeType, resource.uri).toBe('text/plain');
      for (const field of [resource.title, resource.description]) {
        expect(typeof field, resource.uri).toBe('string');
        expect(field ?? '', resource.uri).toMatch(/^[\x20-\x7e]*[\x21-\x7e]$/);
      }
    }
  });

  it('scenario: reading agentboard://guide gives the stdout of help agents', async () => {
    const { client } = await inProcess();
    const text = await readText(client, GUIDE_RESOURCE_URI);
    const cli = run(['help', 'agents'], tempDir(), cliEnv());
    expect(cli.code).toBe(0);
    expect(text).toBe(cli.stdout);
    expect(text).toBe(renderGuide(VERSION));
  });

  it.each(ROLES)(
    'reading agentboard://guide/%s gives the stdout of help agents --role',
    async (role) => {
      const { client } = await inProcess();
      const text = await readText(client, `${GUIDE_RESOURCE_URI}/${role}`);
      const cli = run(['help', 'agents', '--role', role], tempDir(), cliEnv());
      expect(cli.code).toBe(0);
      expect(text).toBe(cli.stdout);
      expect(text).toBe(renderGuide(VERSION) + renderRoleChecklist(role));
    },
  );

  it.each(UNKNOWN_URIS)(
    'reading the unknown URI %j is an InvalidParams error naming the resources',
    async (uri) => {
      const { client } = await inProcess();
      await expectUnknown(client, uri);
    },
  );

  it('an unknown URI does not stop the server', async () => {
    const { client } = await inProcess();
    await expectUnknown(client, 'agentboard://nope');
    expect(await readText(client, GUIDE_RESOURCE_URI)).toBe(renderGuide(VERSION));
  });

  it('serves the resources with no actor, prints nothing, and needs no board after start-up', async () => {
    const { client, boardDir, stderr } = await inProcess();
    rmSync(boardDir, { recursive: true, force: true });
    await client.listResources();
    for (const uri of URIS) {
      await readText(client, uri);
    }
    expect(stderr()).toBe('');
  });

  it('help is still not a tool', async () => {
    const { client } = await inProcess();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('board_help');
  });
});

describe('guide over MCP, against the built server', () => {
  it('initialize carries the instructions: at most 2000 ASCII characters, naming the resource', async () => {
    const { root } = boardProject();
    const child = await mcpChild(root);
    const instructions = child.client.getInstructions();
    expectInstructions(instructions);
    expect(instructions).toBe(renderGuideSummary(VERSION));
    expect(child.errors).toEqual([]);
  }, 30_000);

  it('lists agentboard://guide as text/plain', async () => {
    const { root } = boardProject();
    const child = await mcpChild(root);
    const { resources } = await child.client.listResources();
    expect(resources.map((r) => r.uri)).toEqual(URIS);
    expect(resources[0]).toMatchObject({ uri: GUIDE_RESOURCE_URI, mimeType: 'text/plain' });
  }, 30_000);

  it('scenario: the guide resource text is byte-identical to help agents stdout of the same build', async () => {
    const { root } = boardProject();
    const child = await mcpChild(root);
    const cli = spawnCli(['help', 'agents'], tempDir(), cliEnv());
    expect(cli.code, cli.stderr).toBe(0);
    expect(cli.stdout.length).toBeGreaterThan(0);
    const text = await readText(child.client, GUIDE_RESOURCE_URI);
    expect(Buffer.from(text, 'utf8').equals(Buffer.from(cli.stdout, 'utf8'))).toBe(true);
    expect(child.stderr()).toBe('');
    expect(child.errors).toEqual([]);
  }, 30_000);

  it('each role resource is byte-identical to help agents --role stdout of the same build', async () => {
    const { root } = boardProject();
    const child = await mcpChild(root);
    for (const role of ROLES) {
      const cli = spawnCli(['help', 'agents', '--role', role], tempDir(), cliEnv());
      expect(cli.code, cli.stderr).toBe(0);
      expect(await readText(child.client, `${GUIDE_RESOURCE_URI}/${role}`), role).toBe(cli.stdout);
    }
  }, 60_000);

  it('an unknown resource URI is an InvalidParams error', async () => {
    const { root } = boardProject();
    const child = await mcpChild(root);
    await expectUnknown(child.client, 'agentboard://nope');
    await expectUnknown(child.client, 'agentboard://guide/tester');
    expect(await readText(child.client, GUIDE_RESOURCE_URI)).toBe(renderGuide(VERSION));
    expect(child.stderr()).toBe('');
    expect(child.errors).toEqual([]);
  }, 30_000);
});
