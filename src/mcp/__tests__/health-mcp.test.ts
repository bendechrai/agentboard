/**
 * `board_health` (board-cli: "MCP server" scenario "Health is a tool";
 * board-insights: "Health command" scenarios "Health over MCP" and
 * "Unplanned scope over MCP and JSON"): the tool is generated from the
 * registry with its four optional properties, and a call through the MCP
 * server returns the document `agentboard health --json` prints with the
 * same arguments.
 *
 * The clock is faked (`Date` only) so that both documents are computed at
 * the same `now`.
 */

import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cliEnv, oneJson, project, run } from '../../cli/__tests__/cli-helpers.js';
import { renderHint } from '../../guidance/hints.js';
import { P, T1, T2, ev, putEvent } from '../../store/__tests__/helpers.js';
import { createMcpServer, type BoardMcpServer } from '../server.js';
import { EXCLUDED_COMMANDS, findTool, toolDefinitions } from '../tools.js';
import { SPEC_TOOLS } from './mcp-helpers.js';

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const servers: BoardMcpServer[] = [];
const clients: Client[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(async () => {
  vi.useRealTimers();
  for (const client of clients.splice(0)) {
    await client.close();
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

/**
 * A board where T1 was claimed by impl 45 minutes ago (stale after 30m,
 * not after the default 2h) and T2 was claimed 3 hours ago.
 */
function seeded(): { root: string; boardDir: string } {
  const { root, boardDir } = project();
  const eventsDir = join(boardDir, 'events');
  putEvent(eventsDir, ev(P.create(T1, 'Recent'), 'orch', NOW - 60 * MINUTE));
  putEvent(eventsDir, ev(P.claim(T1), 'impl', NOW - 45 * MINUTE));
  putEvent(eventsDir, ev(P.create(T2, 'Old'), 'orch', NOW - 240 * MINUTE));
  putEvent(eventsDir, ev(P.claim(T2), 'impl2', NOW - 180 * MINUTE));
  return { root, boardDir };
}

function serve(root: string): BoardMcpServer {
  const server = createMcpServer({ cwd: root, env: cliEnv(), stderr: () => undefined });
  servers.push(server);
  return server;
}

async function connect(server: BoardMcpServer): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'agentboard-test', version: '0.0.0' });
  await client.connect(clientSide);
  clients.push(client);
  return client;
}

describe('scenario: Health is a tool', () => {
  it('lists board_health with the optional properties stale-after, blocked-after, unplanned-within and check', () => {
    expect(EXCLUDED_COMMANDS).not.toContain('health');
    const tool = findTool('board_health');
    expect(tool?.command.name).toBe('health');
    expect(tool?.inputSchema).toEqual({
      type: 'object',
      properties: {
        'stale-after': { type: 'string', description: expect.any(String) as string },
        'blocked-after': { type: 'string', description: expect.any(String) as string },
        'unplanned-within': { type: 'string', description: expect.any(String) as string },
        check: { type: 'boolean', description: expect.any(String) as string },
        as: { type: 'string', description: expect.any(String) as string },
      },
      required: [],
      additionalProperties: false,
    });
    expect(tool?.annotations).toEqual({ readOnlyHint: true });
  });

  it('is in the spec tool list and in tools/list over the protocol', async () => {
    expect(SPEC_TOOLS).toContain('board_health');
    expect(toolDefinitions().map((t) => t.name)).toContain('board_health');
    const client = await connect(serve(seeded().root));
    const listed = await client.listTools();
    const health = listed.tools.find((t) => t.name === 'board_health');
    expect(health?.inputSchema.properties).toHaveProperty('stale-after');
    expect(health?.inputSchema.properties).toHaveProperty('blocked-after');
    expect(health?.inputSchema.properties).toHaveProperty('unplanned-within');
    expect(health?.inputSchema.properties).toHaveProperty('check');
    expect(health?.inputSchema.required ?? []).toEqual([]);
  });
});

/**
 * A board where ad hoc ticket T1 was moved to `merged` with `--unplanned
 * "production hotfix"` 2 hours before `NOW` (the `ticket.unplanned` 2
 * hours and 1 second before, as the command writes it first).
 */
function unplannedBoard(): { root: string; boardDir: string } {
  const { root, boardDir } = project();
  const eventsDir = join(boardDir, 'events');
  const adhoc = { task: undefined, checklist: undefined, labels: undefined, adhoc: 'hotfix' };
  // `P.create` spreads `undefined` for the omitted fields; the file must not carry them.
  const create = JSON.parse(
    JSON.stringify(P.create(T1, 'Fix login redirect', adhoc)),
  ) as ReturnType<typeof P.create>;
  putEvent(eventsDir, ev(create, 'orch', NOW - DAY));
  putEvent(eventsDir, ev(P.move(T1, 'tests'), 'impl', NOW - DAY + 1000));
  putEvent(eventsDir, ev(P.move(T1, 'implementing'), 'impl', NOW - DAY + 2000));
  putEvent(eventsDir, ev(P.move(T1, 'review'), 'impl', NOW - DAY + 3000));
  putEvent(eventsDir, ev(P.unplanned(T1, 'production hotfix'), 'orch', NOW - 2 * HOUR - 1000));
  putEvent(eventsDir, ev(P.move(T1, 'merged'), 'orch', NOW - 2 * HOUR));
  return { root, boardDir };
}

describe('scenario: Unplanned scope over MCP and JSON', () => {
  it('board_health with unplanned-within 30d equals health --unplanned-within 30d --json', async () => {
    const { root } = unplannedBoard();
    const client = await connect(serve(root));
    const result = await client.callTool({
      name: 'board_health',
      arguments: { 'unplanned-within': '30d' },
    });
    expect(result.isError).toBeFalsy();
    const cli = oneJson(run(['health', '--unplanned-within', '30d', '--json'], root));
    expect(result.structuredContent).toEqual(cli);
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(cli) }]);
    const doc = cli as {
      thresholds: { unplannedWithin: number };
      unplannedScope: {
        total: number;
        tickets: { ticket: { id: string }; reason: string | null; outcome: string }[];
      };
    };
    expect(doc.thresholds.unplannedWithin).toBe(2_592_000_000);
    expect(doc.unplannedScope.total).toBe(1);
    expect(doc.unplannedScope.tickets).toHaveLength(1);
    expect(doc.unplannedScope.tickets[0]).toMatchObject({
      ticket: { id: T1 },
      reason: 'production hotfix',
      outcome: 'merged',
    });
  });

  it('with no window uses the default 7d, like the CLI', () => {
    const { root } = unplannedBoard();
    const server = serve(root);
    const result = server.callTool('board_health', {});
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(oneJson(run(['health', '--json'], root)));
    expect(result.structuredContent).toMatchObject({
      thresholds: { unplannedWithin: 7 * DAY },
      unplannedScope: { total: 1, tickets: [{ ticket: { id: T1 }, outcome: 'merged' }] },
    });
  });

  it('a window of 1h leaves the 2 hour old disposition out of the list but not the total', () => {
    const { root } = unplannedBoard();
    const server = serve(root);
    const result = server.callTool('board_health', { 'unplanned-within': '1h' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(
      oneJson(run(['health', '--unplanned-within', '1h', '--json'], root)),
    );
    expect(result.structuredContent).toMatchObject({
      thresholds: { unplannedWithin: HOUR },
      unplannedScope: { total: 1, tickets: [] },
    });
  });

  it('refuses a malformed unplanned-within as a tool error with exit 1 usage and the MCP hint', () => {
    const { root } = unplannedBoard();
    const server = serve(root);
    const result = server.callTool('board_health', { 'unplanned-within': '7days' });
    expect(result.isError).toBe(true);
    const error = result.structuredContent as {
      exitCode: number;
      reason: string;
      message: string;
      hint: string | null;
    };
    expect(error).toMatchObject({ exitCode: 1, reason: 'usage' });
    expect(error.message).toContain('--unplanned-within');
    expect(error.message).toContain('7days');
    expect(error.message).toContain('<n>d');
    expect(error.hint).toBe(renderHint('usage', { surface: 'mcp', command: 'health' }));
  });
});

describe('scenario: Health over MCP', () => {
  it('returns the document agentboard health --stale-after 30m --json prints', async () => {
    const { root } = seeded();
    const client = await connect(serve(root));
    const result = await client.callTool({
      name: 'board_health',
      arguments: { 'stale-after': '30m' },
    });
    expect(result.isError).toBeFalsy();
    const cli = oneJson(run(['health', '--stale-after', '30m', '--json'], root));
    expect(result.structuredContent).toEqual(cli);
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(cli) }]);
    expect(cli).toMatchObject({
      now: NOW,
      thresholds: { staleAfter: 30 * MINUTE },
      late: null,
      check: null,
    });
    const stale = (cli as { staleClaims: { ticket: { id: string } }[] }).staleClaims;
    expect(stale.map((s) => s.ticket.id)).toEqual([T2, T1]);
  });

  it('with no arguments uses the default thresholds, like agentboard health --json', async () => {
    const { root } = seeded();
    const server = serve(root);
    const result = server.callTool('board_health', {});
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(oneJson(run(['health', '--json'], root)));
    const stale = (result.structuredContent as { staleClaims: { ticket: { id: string } }[] })
      .staleClaims;
    expect(stale.map((s) => s.ticket.id)).toEqual([T2]);
  });

  it('runs the check when check is true, like --check', () => {
    const { root } = seeded();
    const server = serve(root);
    const result = server.callTool('board_health', { check: true, 'blocked-after': '2d' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(
      oneJson(run(['health', '--check', '--blocked-after', '2d', '--json'], root)),
    );
    expect(result.structuredContent).toMatchObject({
      check: { ranAt: NOW, matches: true, differingRows: 0 },
    });
  });

  it('needs no actor', () => {
    const { root } = seeded();
    const server = serve(root);
    expect(server.callTool('board_health', {}).isError).toBeUndefined();
    expect(server.callTool('board_health', { as: 'someone' }).isError).toBeUndefined();
  });

  it('refuses a malformed duration as a tool error with exit 1 usage and the MCP hint', () => {
    const { root } = seeded();
    const server = serve(root);
    const result = server.callTool('board_health', { 'stale-after': '2hours' });
    expect(result.isError).toBe(true);
    const error = result.structuredContent as {
      exitCode: number;
      reason: string;
      message: string;
      hint: string | null;
    };
    expect(error).toMatchObject({ exitCode: 1, reason: 'usage' });
    expect(error.message).toContain('--stale-after');
    expect(error.message).toContain('<n>m');
    expect(error.hint).toBe(renderHint('usage', { surface: 'mcp', command: 'health' }));
    expect(error.hint).toContain('board_health');
  });
});
