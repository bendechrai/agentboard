/**
 * Lease and queue tools over MCP (add-claim-leases task 3.3; board-cli:
 * "Lease and queue tools over MCP", "MCP server" scenarios "Tools are
 * listed from the registry", "Excluded config tool" and "CLI-only flag is
 * refused over MCP").
 *
 * In process through `callTool`, with the clock injected through vitest
 * fake timers (`Date` only). The golden results (`golden/lease-mcp.json`)
 * of a fixed call sequence (a leased claim, a renew, a queued claim, a
 * refused takeover, a grant seen through `board_inbox` and a forced
 * release) were derived from the spec formulas, the stub contracts and
 * the fold, not recorded from the implementation. Each event a tool call
 * writes is compared byte for byte with the one the CLI (or, for a join,
 * the library operation the CLI runs) writes for the same arguments and
 * actor on a copy of the board at the same clock.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { claimTicket } from '../../board/actions.js';
import { findCommand } from '../../cli/registry.js';
import { cliEnv, project, run } from '../../cli/__tests__/cli-helpers.js';
import { openBoard } from '../../store/board.js';
import { BoardError } from '../../store/errors.js';
import { allNames, copyBoard, ev, P, putEvent } from '../../store/__tests__/helpers.js';
import { createMcpServer, type BoardMcpServer, type ToolCallResult } from '../server.js';
import { findTool, toolArguments, toolDefinitions } from '../tools.js';
import { SPEC_TOOLS } from './mcp-helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));

interface GoldenCall {
  at: number;
  tool: string;
  args: Record<string, unknown>;
  structured?: Record<string, unknown>;
  error?: { exitCode: number; reason: string; message: string; hint: string };
}

interface Golden {
  clock: { t0: number; m1: string; m2: string };
  calls: Record<string, GoldenCall>;
  creates: unknown[];
}

const GOLDEN = JSON.parse(readFileSync(join(HERE, 'golden', 'lease-mcp.json'), 'utf8')) as Golden;

const servers: BoardMcpServer[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(GOLDEN.clock.t0);
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
  vi.useRealTimers();
});

/** A server on the board under `root`, no default actor. */
function serve(root: string): BoardMcpServer {
  const server = createMcpServer({ cwd: root, env: cliEnv(), stderr: () => undefined });
  servers.push(server);
  return server;
}

/** A project whose board holds the golden creates; its server. */
function goldenBoard(): { root: string; eventsDir: string; server: BoardMcpServer } {
  const { root, boardDir } = project();
  const eventsDir = join(boardDir, 'events');
  for (const event of GOLDEN.creates) {
    putEvent(eventsDir, event);
  }
  return { root, eventsDir, server: serve(root) };
}

function call(server: BoardMcpServer, c: GoldenCall): ToolCallResult {
  vi.setSystemTime(c.at);
  return server.callTool(c.tool, c.args);
}

function golden(name: string): GoldenCall {
  const c = GOLDEN.calls[name];
  if (c === undefined) {
    throw new Error(`no golden call ${name}`);
  }
  return c;
}

/** A successful result: one text item whose JSON is the structured content. */
function success(result: ToolCallResult): Record<string, unknown> {
  expect(result.isError, JSON.stringify(result)).toBeUndefined();
  expect(result.content).toHaveLength(1);
  const [item] = result.content;
  expect(item?.type).toBe('text');
  expect(JSON.parse(item?.text ?? '')).toEqual(result.structuredContent);
  return result.structuredContent;
}

/** A failed result: the text is the message and the hint line. */
function failure(result: ToolCallResult): Record<string, unknown> {
  expect(result.isError, JSON.stringify(result)).toBe(true);
  const content = result.structuredContent as { message: string; hint: string | null };
  expect(result.content).toEqual([
    {
      type: 'text',
      text: content.hint === null ? content.message : `${content.message}\nhint: ${content.hint}`,
    },
  ]);
  return result.structuredContent;
}

/** Runs the whole golden sequence, checking each result as it goes. */
function sequence(names: readonly string[]): void {
  const { server } = goldenBoard();
  for (const name of Object.keys(GOLDEN.calls)) {
    const c = golden(name);
    const result = call(server, c);
    if (!names.includes(name)) {
      expect(result.isError === true, `${name}: ${JSON.stringify(result)}`).toBe(
        c.error !== undefined,
      );
      continue;
    }
    if (c.error === undefined) {
      expect(success(result), name).toEqual(c.structured);
    } else {
      expect(failure(result), name).toEqual(c.error);
    }
  }
}

describe('golden MCP results', () => {
  it.each([
    ['a leased claim', 'leasedClaim'],
    ['a renew', 'renew'],
    ['a queued claim ({queued, position, holder, ticket})', 'queuedClaim'],
    ['a refused takeover (exitCode, reason, message and hint)', 'refusedTakeover'],
    ['a grant seen through board_inbox', 'grantInbox'],
    ['a forced release', 'forcedRelease'],
  ])('%s', (_label, name) => {
    sequence([name]);
  });

  it('the whole sequence, the first wait at position 1 included', () => {
    sequence(
      Object.keys(GOLDEN.calls).filter((name) => {
        const c = golden(name);
        return c.structured !== undefined || c.error !== undefined;
      }),
    );
  });
});

describe('scenario: MCP tool list includes renew and unqueue', () => {
  it('lists board_renew and board_unqueue; board_claim has optional ttl and wait and no timeout; board_release has optional force and reason', () => {
    const names = toolDefinitions().map((t) => t.name);
    expect(names).toContain('board_renew');
    expect(names).toContain('board_unqueue');
    const claim = findTool('board_claim');
    expect(Object.keys(claim?.inputSchema.properties ?? {})).toEqual(['id', 'ttl', 'wait', 'as']);
    expect(claim?.inputSchema.properties.ttl?.type).toBe('string');
    expect(claim?.inputSchema.properties.wait?.type).toBe('boolean');
    expect(claim?.inputSchema.required).toEqual(['id']);
    const release = findTool('board_release');
    expect(Object.keys(release?.inputSchema.properties ?? {})).toEqual([
      'id',
      'force',
      'reason',
      'allow-secret-like',
      'as',
    ]);
    expect(release?.inputSchema.required).toEqual(['id']);
    expect(Object.keys(findTool('board_renew')?.inputSchema.properties ?? {})).toEqual([
      'id',
      'ttl',
      'as',
    ]);
    expect(Object.keys(findTool('board_unqueue')?.inputSchema.properties ?? {})).toEqual([
      'id',
      'as',
    ]);
  });

  it('the descriptions: claim has no wait/timeout sentence, release says force with reason together', () => {
    expect(findTool('board_claim')?.description).toBe('Assign an unassigned ticket to yourself');
    expect(findTool('board_release')?.description).toBe(
      'Give up a ticket you hold. Give together: force with reason.',
    );
  });

  it('marks board_renew and board_unqueue as writing tools', () => {
    expect(findTool('board_renew')?.annotations).toEqual({ readOnlyHint: false });
    expect(findTool('board_unqueue')?.annotations).toEqual({ readOnlyHint: false });
  });
});

describe('scenario: tools are listed from the registry', () => {
  it('the tools are exactly the spec list, with no tool for config', () => {
    expect(
      toolDefinitions()
        .map((t) => t.name)
        .sort(),
    ).toEqual([...SPEC_TOOLS].sort());
    expect(SPEC_TOOLS).toContain('board_renew');
    expect(SPEC_TOOLS).toContain('board_unqueue');
    for (const name of ['board_config', 'board_config_set', 'board_config_get']) {
      expect(findTool(name), name).toBeUndefined();
    }
  });
});

describe('scenario: excluded config tool', () => {
  it.each(['board_config_set', 'board_config_get'])(
    '%s is a tool error with exitCode 1 and reason usage, and no event is written',
    (name) => {
      const { server, eventsDir } = goldenBoard();
      const before = allNames(eventsDir);
      const result = server.callTool(name, {
        key: 'queue.window',
        value: '5m',
        as: 'orchestrator',
      });
      expect(failure(result)).toMatchObject({ exitCode: 1, reason: 'usage' });
      expect(allNames(eventsDir)).toEqual(before);
    },
  );
});

describe('scenario: CLI-only flag is refused over MCP', () => {
  it('board_claim with ttl 30m, wait true and timeout 10m is a usage tool error and writes nothing', () => {
    const { server, eventsDir } = goldenBoard();
    success(server.callTool('board_claim', { id: GOLDEN.clock.m1, as: 'merger-1' }));
    const before = allNames(eventsDir);
    const result = server.callTool('board_claim', {
      id: GOLDEN.clock.m1,
      ttl: '30m',
      wait: true,
      timeout: '10m',
      as: 'merger-2',
    });
    expect(failure(result)).toMatchObject({ exitCode: 1, reason: 'usage' });
    expect(allNames(eventsDir)).toEqual(before);
  });

  it('toolArguments refuses timeout as an unknown argument and accepts wait alone', () => {
    const claim = findCommand('claim');
    expect(claim).toBeDefined();
    if (claim === undefined) {
      return;
    }
    let thrown: unknown;
    try {
      toolArguments(claim, { id: '01J9K3', timeout: '10m' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BoardError);
    expect(thrown instanceof BoardError ? thrown.reason : null).toBe('usage');
    expect(thrown instanceof BoardError ? thrown.message : '').toContain('timeout');
    expect(toolArguments(claim, { id: '01J9K3', ttl: '30m', wait: true })).toEqual({
      id: '01J9K3',
      ttl: '30m',
      wait: true,
    });
  });
});

describe('forced release of an unassigned ticket over MCP', () => {
  it('is a not-assignee tool error whose hint says there is nothing to force', () => {
    const { server, eventsDir } = goldenBoard();
    const before = allNames(eventsDir);
    const id = GOLDEN.clock.m1;
    const result = server.callTool('board_release', {
      id,
      force: true,
      reason: 'x',
      as: 'orchestrator',
    });
    expect(failure(result)).toMatchObject({
      exitCode: 4,
      reason: 'not-assignee',
      hint: `the ticket is not held, so there is nothing to force; see its holder and queue with board_show {"id":"${id}"}`,
    });
    expect(allNames(eventsDir)).toEqual(before);
  });
});

describe('scenario: MCP wait returns at once', () => {
  it('on a ticket held by merger-1 with one waiter: {queued: true, position: 2, holder, ticket} within a second, and a join written', () => {
    const { server, eventsDir } = goldenBoard();
    const id = GOLDEN.clock.m1;
    success(server.callTool('board_claim', { id, ttl: '30m', as: 'merger-1' }));
    success(server.callTool('board_claim', { id, ttl: '30m', wait: true, as: 'merger-2' }));
    const before = new Set(readdirSync(eventsDir));
    const started = performance.now();
    const result = server.callTool('board_claim', { id, ttl: '30m', wait: true, as: 'merger-3' });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(success(result)).toEqual({ queued: true, position: 2, holder: 'merger-1', ticket: id });
    const added = readdirSync(eventsDir).filter((name) => !before.has(name));
    expect(added).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(eventsDir, added[0] ?? ''), 'utf8')) as {
      kind: string;
      actor: string;
      body: unknown;
    };
    expect(event).toMatchObject({
      kind: 'ticket.queue.join',
      actor: 'merger-3',
      body: { ttl: 1_800_000 },
    });
  });

  it('on a free ticket returns the ordinary claim result with queued false', () => {
    const { server } = goldenBoard();
    const doc = success(
      server.callTool('board_claim', {
        id: GOLDEN.clock.m1,
        ttl: '30m',
        wait: true,
        as: 'merger-1',
      }),
    );
    expect(doc).toMatchObject({ queued: false, ticket: { assignee: 'merger-1' } });
    expect(typeof doc.hash).toBe('string');
  });

  it('validates as the CLI does: a malformed ttl and wait without ttl are usage errors', () => {
    const { server, eventsDir } = goldenBoard();
    const before = allNames(eventsDir);
    const bad = failure(
      server.callTool('board_claim', { id: GOLDEN.clock.m1, ttl: '10min', as: 'a' }),
    );
    expect(bad).toMatchObject({ exitCode: 1, reason: 'usage' });
    expect(String(bad.message)).toContain('from 30s to 7d');
    expect(
      failure(server.callTool('board_claim', { id: GOLDEN.clock.m1, wait: true, as: 'a' })),
    ).toMatchObject({
      exitCode: 1,
      reason: 'usage',
    });
    expect(allNames(eventsDir)).toEqual(before);
  });

  it('refuses the reserved actor as a usage error', () => {
    const { server, eventsDir } = goldenBoard();
    const before = allNames(eventsDir);
    expect(
      failure(server.callTool('board_claim', { id: GOLDEN.clock.m1, as: 'agentboard' })),
    ).toMatchObject({ exitCode: 1, reason: 'usage' });
    expect(
      failure(server.callTool('board_show', { id: GOLDEN.clock.m1, as: 'agentboard' })),
    ).toMatchObject({ exitCode: 1, reason: 'usage' });
    expect(allNames(eventsDir)).toEqual(before);
  });
});

/** Two copies of one board (the CLI's and the server's), both at the current clock. */
function twins(seed: (eventsDir: string) => void): {
  cli: string;
  mcp: BoardMcpServer;
  cliEvents: string;
  mcpEvents: string;
} {
  const base = project();
  const baseEvents = join(base.boardDir, 'events');
  seed(baseEvents);
  const cli = project();
  const cliEvents = join(cli.boardDir, 'events');
  for (const name of readdirSync(baseEvents)) {
    putEvent(cliEvents, JSON.parse(readFileSync(join(baseEvents, name), 'utf8')));
  }
  const copy = copyBoard(baseEvents);
  const mcpRoot = dirname(copy);
  return { cli: cli.root, mcp: serve(mcpRoot), cliEvents, mcpEvents: join(copy, 'events') };
}

/** The files added to `dir` since `before`, with their bytes. */
function added(dir: string, before: ReadonlySet<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).filter((n) => !before.has(n))) {
    out[name] = readFileSync(join(dir, name), 'utf8');
  }
  return out;
}

/** The new event of each twin after `act`, compared: same body bytes, kind, ticket and actor. */
function sameEvent(
  t: ReturnType<typeof twins>,
  cliArgv: readonly string[],
  tool: string,
  args: Record<string, unknown>,
): void {
  const beforeCli = new Set(readdirSync(t.cliEvents));
  const beforeMcp = new Set(readdirSync(t.mcpEvents));
  const out = run(cliArgv, t.cli);
  expect(out.code, out.stderr).toBe(0);
  success(t.mcp.callTool(tool, args));
  const cliFiles = added(t.cliEvents, beforeCli);
  const mcpFiles = added(t.mcpEvents, beforeMcp);
  expect(Object.keys(cliFiles)).toHaveLength(1);
  const body = (text: string): unknown => {
    const e = JSON.parse(text) as { kind: string; ticket: string; actor: string; body: unknown };
    return { kind: e.kind, ticket: e.ticket, actor: e.actor, body: JSON.stringify(e.body) };
  };
  expect(Object.values(mcpFiles).map(body)).toEqual(Object.values(cliFiles).map(body));
  // Same state and same clock: the whole event is the same file.
  expect(mcpFiles).toEqual(cliFiles);
}

const TX = Date.UTC(2026, 9, 26, 11, 0, 0);
const L = '01MD0000000000000000000001';

describe('each event written through MCP is byte-identical in body to the CLI one', () => {
  const create = (dir: string): void => {
    putEvent(
      dir,
      ev(
        { kind: 'ticket.create', ticket: L, body: { title: 'Lock', adhoc: 'lock' } },
        'orch',
        TX - 10_000,
      ),
    );
  };

  it('claim --ttl 30m', () => {
    vi.setSystemTime(TX);
    const t = twins(create);
    sameEvent(t, ['claim', L, '--ttl', '30m', '--as', 'merger-1'], 'board_claim', {
      id: L,
      ttl: '30m',
      as: 'merger-1',
    });
  });

  it('renew and renew --ttl 1h', () => {
    vi.setSystemTime(TX);
    const t = twins((dir) => {
      create(dir);
      putEvent(
        dir,
        ev(
          {
            kind: 'ticket.claim',
            ticket: L,
            body: { lease: { ttl: 1_800_000, grace: 120_000, expiresAt: TX - 5000 + 120_000 } },
          },
          'merger-1',
          TX - 5000,
        ),
      );
    });
    sameEvent(t, ['renew', L, '--as', 'merger-1'], 'board_renew', { id: L, as: 'merger-1' });
    vi.setSystemTime(TX + 1000);
    sameEvent(t, ['renew', L, '--ttl', '1h', '--as', 'merger-1'], 'board_renew', {
      id: L,
      ttl: '1h',
      as: 'merger-1',
    });
  });

  it('a takeover of a claimable lease', () => {
    vi.setSystemTime(TX);
    const t = twins((dir) => {
      create(dir);
      putEvent(
        dir,
        ev(
          {
            kind: 'ticket.claim',
            ticket: L,
            body: { lease: { ttl: 1_800_000, grace: 120_000, expiresAt: TX - 500_000 + 120_000 } },
          },
          'merger-1',
          TX - 500_000,
        ),
      );
    });
    sameEvent(t, ['claim', L, '--ttl', '10m', '--as', 'merger-2'], 'board_claim', {
      id: L,
      ttl: '10m',
      as: 'merger-2',
    });
  });

  it('unqueue', () => {
    vi.setSystemTime(TX);
    const t = twins((dir) => {
      create(dir);
      putEvent(dir, ev(P.claim(L), 'merger-1', TX - 5000));
      putEvent(
        dir,
        ev({ kind: 'ticket.queue.join', ticket: L, body: { ttl: 600_000 } }, 'merger-3', TX - 4000),
      );
    });
    sameEvent(t, ['unqueue', L, '--as', 'merger-3'], 'board_unqueue', { id: L, as: 'merger-3' });
  });

  it('scenario: MCP forced release matches the CLI', () => {
    vi.setSystemTime(TX);
    const t = twins((dir) => {
      create(dir);
      putEvent(dir, ev(P.claim(L), 'merger-1', TX - 5000));
    });
    sameEvent(
      t,
      ['release', L, '--force', '--reason', 'merger-1 crashed', '--as', 'orchestrator'],
      'board_release',
      { id: L, force: true, reason: 'merger-1 crashed', as: 'orchestrator' },
    );
  });

  it('a join through board_claim with wait equals the one the library operation writes', () => {
    vi.setSystemTime(TX);
    const t = twins((dir) => {
      create(dir);
      putEvent(dir, ev(P.claim(L), 'merger-1', TX - 5000));
    });
    const beforeCli = new Set(readdirSync(t.cliEvents));
    const beforeMcp = new Set(readdirSync(t.mcpEvents));
    const handle = openBoard(join(t.cli, '.board'));
    try {
      expect(claimTicket(handle, 'merger-2', { id: L, ttl: 1_800_000, wait: true })).toMatchObject({
        queued: true,
      });
    } finally {
      handle.close();
    }
    success(t.mcp.callTool('board_claim', { id: L, ttl: '30m', wait: true, as: 'merger-2' }));
    expect(added(t.mcpEvents, beforeMcp)).toEqual(added(t.cliEvents, beforeCli));
  });
});
