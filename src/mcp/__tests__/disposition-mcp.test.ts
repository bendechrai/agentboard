/**
 * The scope disposition over MCP (add-adhoc-ticket-lifecycle task 2.4;
 * board-cli: "MCP server", scenario "Disposition over MCP";
 * board-agent-guidance: "Error hints"): `board_move` and `board_close`
 * take `task`, `change`, `group`, `unplanned` and `allow-secret-like`
 * from the registry; a refused call is a tool error with `exitCode`,
 * `reason`, `message` and `hint` (golden for `needs-scope-disposition`
 * and `already-linked`); and the events a tool call writes are
 * byte-identical in body to those the CLI writes for the same arguments
 * and actor on a copy of the board. In process through `callTool`, and
 * the spec scenario through a spawned server.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { B64 } from '../../board/__tests__/helpers.js';
import { canonicalDecode, canonicalEncode } from '../../events/canonical.js';
import type { Ticket } from '../../events/fold.js';
import type { BoardEvent } from '../../events/schema.js';
import { renderHint } from '../../guidance/hints.js';
import { allNames, copyBoard, eventNames } from '../../store/__tests__/helpers.js';
import { cliEnv, oneJson, project, run } from '../../cli/__tests__/cli-helpers.js';
import { createMcpServer, type BoardMcpServer, type ToolCallResult } from '../server.js';
import { mcpChild } from './mcp-helpers.js';

const LOGIN = 'openspec:add-login#2';

const servers: BoardMcpServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

interface Failure {
  exitCode: number;
  reason: string | null;
  message: string;
  hint: string | null;
}

interface Harness {
  root: string;
  boardDir: string;
  eventsDir: string;
  server: BoardMcpServer;
}

/** A server on a fresh board, no default actor. */
function serve(): Harness {
  const { root, boardDir } = project();
  const server = createMcpServer({ cwd: root, env: cliEnv(), stderr: () => undefined });
  servers.push(server);
  return { root, boardDir, eventsDir: join(boardDir, 'events'), server };
}

function success(result: ToolCallResult): Record<string, unknown> {
  expect(result.isError, JSON.stringify(result)).toBeUndefined();
  return result.structuredContent as Record<string, unknown>;
}

/** The failure of a call, checking the text content carries the hint line. */
function failure(result: ToolCallResult): Failure {
  expect(result.isError, JSON.stringify(result)).toBe(true);
  const content = result.structuredContent as unknown as Failure;
  expect(result.content).toEqual([
    { type: 'text', text: `${content.message}\nhint: ${content.hint ?? ''}` },
  ]);
  return content;
}

/** An ad hoc ticket (reason `seen in production`) in `status`, through the server. */
function adhocIn(h: Harness, status: 'review' | 'blocked' | 'todo'): string {
  const created = success(
    h.server.callTool('board_new', { title: 'Hotfix', adhoc: 'seen in production', as: 'orch' }),
  );
  const id = (created.ticket as { id: string }).id;
  const path = {
    todo: [],
    review: ['tests', 'implementing', 'review'],
    blocked: ['tests', 'implementing', 'blocked'],
  }[status];
  for (const to of path) {
    success(h.server.callTool('board_move', { id, status: to, as: 'impl' }));
  }
  return id;
}

/** A planned ticket (task `LOGIN`) in review, through the server. */
function plannedInReview(h: Harness): string {
  const created = success(
    h.server.callTool('board_new', { title: 'Login form', task: LOGIN, as: 'orch' }),
  );
  const id = (created.ticket as { id: string }).id;
  for (const to of ['tests', 'implementing', 'review']) {
    success(h.server.callTool('board_move', { id, status: to, as: 'impl' }));
  }
  return id;
}

function show(h: Harness, id: string): Ticket {
  return success(h.server.callTool('board_show', { id })).ticket as Ticket;
}

/** The `kind`, `ticket`, `actor` and canonical body bytes of an event file. */
function bodyOf(eventsDir: string, name: string): {
  kind: string;
  ticket: string;
  actor: string;
  body: string;
} {
  const event = canonicalDecode(new Uint8Array(readFileSync(join(eventsDir, name)))) as unknown as BoardEvent;
  return {
    kind: event.kind,
    ticket: 'ticket' in event ? event.ticket : '',
    actor: event.actor,
    body: new TextDecoder().decode(canonicalEncode(event.body)),
  };
}

describe('board_move with a scope disposition', () => {
  it('golden: a refused merge is exitCode 4, reason needs-scope-disposition, with the message and hint', () => {
    const h = serve();
    const id = adhocIn(h, 'review');
    const names = allNames(h.eventsDir);
    const err = failure(h.server.callTool('board_move', { id, status: 'merged', as: 'orch' }));
    expect(err).toEqual({
      exitCode: 4,
      reason: 'needs-scope-disposition',
      message: `ticket.move on ticket ${id} refused: needs-scope-disposition`,
      hint: renderHint('needs-scope-disposition', {
        surface: 'mcp',
        command: 'move',
        id,
        actor: 'orch',
      }),
    });
    expect(err.hint).toContain(
      `board_move {"id":"${id}","status":"merged","task":"<source>:<ref>#<item>","as":"orch"}`,
    );
    expect(err.hint).toContain(`board_move {"id":"${id}","status":"merged","unplanned":"<reason>","as":"orch"}`);
    expect(err.hint).toContain('do not create an issue or task only to satisfy this');
    expect(err.hint).not.toContain("'agentboard move");
    expect(allNames(h.eventsDir)).toEqual(names);
    expect(show(h, id).status).toBe('review');
  });

  it('golden: unplanned on a linked ticket is exitCode 4, reason already-linked, naming the reference', () => {
    const h = serve();
    const id = plannedInReview(h);
    const names = allNames(h.eventsDir);
    const err = failure(
      h.server.callTool('board_move', { id, status: 'merged', unplanned: 'y', as: 'orch' }),
    );
    expect(err).toEqual({
      exitCode: 4,
      reason: 'already-linked',
      message: `ticket.unplanned on ticket ${id} refused: already-linked (it is linked to ${LOGIN})`,
      hint: renderHint('already-linked', { surface: 'mcp', command: 'move', id, actor: 'orch' }),
    });
    expect(err.hint).toContain(`board_move {"id":"${id}","status":"merged","as":"orch"}`);
    expect(err.hint).toContain('unplanned argument');
    expect(allNames(h.eventsDir)).toEqual(names);
    expect(show(h, id).status).toBe('review');
  });

  it('merges with unplanned, returning the writing document with both hashes', () => {
    const h = serve();
    const id = adhocIn(h, 'review');
    const doc = success(
      h.server.callTool('board_move', { id, status: 'merged', unplanned: 'hotfix', as: 'orch' }),
    );
    const events = doc.events as string[];
    expect(events).toHaveLength(2);
    expect(doc.hash).toBe(events[1]);
    expect(doc.ticket).toMatchObject({
      status: 'merged',
      adhoc: 'seen in production',
      unplanned: { reason: 'hotfix', actor: 'orch' },
    });
    expect(show(h, id)).toEqual(doc.ticket);
    expect(bodyOf(h.eventsDir, `${events[0] ?? ''}.json`)).toMatchObject({
      kind: 'ticket.unplanned',
      body: '{"reason":"hotfix"}',
    });
  });

  it('merges with task, and with change and group, exactly as the CLI shorthand', () => {
    const h = serve();
    const byTask = adhocIn(h, 'review');
    const byChange = adhocIn(h, 'review');
    const first = success(h.server.callTool('board_move', { id: byTask, status: 'merged', task: LOGIN, as: 'orch' }));
    const second = success(
      h.server.callTool('board_move', {
        id: byChange,
        status: 'merged',
        change: 'add-login',
        group: '2',
        as: 'orch',
      }),
    );
    for (const doc of [first, second]) {
      expect(doc.events).toHaveLength(2);
      expect(doc.ticket).toMatchObject({
        status: 'merged',
        task: { source: 'openspec', ref: 'add-login', item: '2' },
        adhoc: null,
      });
    }
  });

  it('refuses two dispositions, a disposition on another move and an empty reason as usage, writing nothing', () => {
    const h = serve();
    const id = adhocIn(h, 'review');
    const names = allNames(h.eventsDir);
    const both = failure(
      h.server.callTool('board_move', { id, status: 'merged', task: LOGIN, unplanned: 'y', as: 'orch' }),
    );
    expect(both).toMatchObject({ exitCode: 1, reason: 'usage' });
    expect(both.hint).toContain('board_move');
    const other = failure(
      h.server.callTool('board_move', { id, status: 'implementing', unplanned: 'y', as: 'orch' }),
    );
    expect(other).toMatchObject({ exitCode: 1, reason: 'usage' });
    expect(other.message).toContain('merged');
    const empty = failure(h.server.callTool('board_move', { id, status: 'merged', unplanned: '', as: 'orch' }));
    expect(empty).toMatchObject({ exitCode: 1, reason: 'usage' });
    const malformed = failure(
      h.server.callTool('board_move', { id, status: 'merged', task: 'add-login-2', as: 'orch' }),
    );
    expect(malformed).toMatchObject({ exitCode: 1, reason: 'malformed-task-ref' });
    expect(malformed.message).toContain('<source>:<ref>#<item>');
    expect(allNames(h.eventsDir)).toEqual(names);
  });

  it('refuses a secret-like reason naming the pattern unless allow-secret-like is true', () => {
    const h = serve();
    const id = adhocIn(h, 'review');
    const reason = `token: ${B64}`;
    const err = failure(h.server.callTool('board_move', { id, status: 'merged', unplanned: reason, as: 'orch' }));
    expect(err).toMatchObject({ exitCode: 1, reason: 'secret-like' });
    expect(err.message).toContain('generic-secret-assignment');
    expect(err.message).not.toContain(B64);
    expect(err.hint).toContain('allow-secret-like');
    const doc = success(
      h.server.callTool('board_move', {
        id,
        status: 'merged',
        unplanned: reason,
        'allow-secret-like': true,
        as: 'orch',
      }),
    );
    expect(doc.ticket).toMatchObject({ status: 'merged', unplanned: { reason } });
  });
});

describe('board_close with a scope disposition', () => {
  it('golden: close of an undisposed blocked ticket is needs-scope-disposition with the close hint', () => {
    const h = serve();
    const id = adhocIn(h, 'blocked');
    const names = allNames(h.eventsDir);
    const err = failure(h.server.callTool('board_close', { id, 'no-decision': true, as: 'orch' }));
    expect(err).toEqual({
      exitCode: 4,
      reason: 'needs-scope-disposition',
      message: expect.stringContaining(id) as string,
      hint: renderHint('needs-scope-disposition', {
        surface: 'mcp',
        command: 'close',
        id,
        actor: 'orch',
        closeDecision: { flag: 'no-decision' },
      }),
    });
    expect(err.hint).toContain(
      `board_close {"id":"${id}","no-decision":true,"task":"<source>:<ref>#<item>","as":"orch"}`,
    );
    expect(err.hint).toContain(`board_close {"id":"${id}","no-decision":true,"unplanned":"<reason>","as":"orch"}`);
    expect(allNames(h.eventsDir)).toEqual(names);
    expect(show(h, id).closed).toBe(false);
  });

  it('closes with unplanned and with task', () => {
    const h = serve();
    const a = adhocIn(h, 'blocked');
    const b = adhocIn(h, 'blocked');
    const closedA = success(
      h.server.callTool('board_close', { id: a, 'no-decision': true, unplanned: 'abandoned', as: 'orch' }),
    );
    expect(closedA.events).toHaveLength(2);
    expect(closedA.ticket).toMatchObject({ closed: true, unplanned: { reason: 'abandoned', actor: 'orch' } });
    const closedB = success(h.server.callTool('board_close', { id: b, 'no-decision': true, task: LOGIN, as: 'orch' }));
    expect(closedB.events).toHaveLength(2);
    expect(closedB.ticket).toMatchObject({
      closed: true,
      task: { source: 'openspec', ref: 'add-login', item: '2' },
    });
  });

  it('golden: unplanned on a linked ticket at close is already-linked with the close hint', () => {
    const h = serve();
    const id = plannedInReview(h);
    success(h.server.callTool('board_move', { id, status: 'blocked', as: 'impl' }));
    const err = failure(
      h.server.callTool('board_close', { id, 'no-decision': true, unplanned: 'y', as: 'orch' }),
    );
    expect(err).toEqual({
      exitCode: 4,
      reason: 'already-linked',
      message: `ticket.unplanned on ticket ${id} refused: already-linked (it is linked to ${LOGIN})`,
      hint: renderHint('already-linked', {
        surface: 'mcp',
        command: 'close',
        id,
        actor: 'orch',
        closeDecision: { flag: 'no-decision' },
      }),
    });
    expect(err.hint).toContain(`board_close {"id":"${id}","no-decision":true,"as":"orch"}`);
    expect(show(h, id).closed).toBe(false);
  });

  it('the check order holds over MCP: needs-scope-disposition, then unpromoted-decision', () => {
    const h = serve();
    const id = adhocIn(h, 'blocked');
    success(h.server.callTool('board_comment', { id, text: 'DECISION: drop it', as: 'impl' }));
    expect(failure(h.server.callTool('board_close', { id, 'no-decision': true, as: 'orch' }))).toMatchObject({
      exitCode: 4,
      reason: 'needs-scope-disposition',
    });
    expect(
      failure(h.server.callTool('board_close', { id, 'no-decision': true, unplanned: 'spike', as: 'orch' })),
    ).toMatchObject({ exitCode: 1, reason: 'unpromoted-decision' });
  });
});

describe('the events written over MCP are byte-identical in body to the CLI', () => {
  it.each([
    ['board_move with unplanned', { status: 'merged', unplanned: 'hotfix' }, ['move', 'merged', '--unplanned', 'hotfix']],
    ['board_move with task', { status: 'merged', task: LOGIN }, ['move', 'merged', '--task', LOGIN]],
  ] as const)('%s', (_name, args, cli) => {
    const h = serve();
    const id = adhocIn(h, 'review');
    const copy = copyBoard(h.eventsDir);
    const before = eventNames(h.eventsDir);

    const doc = success(h.server.callTool('board_move', { id, ...args, as: 'orch' }));
    const viaMcp = (doc.events as string[]).map((hash) => bodyOf(h.eventsDir, `${hash}.json`));

    const [command = '', ...rest] = cli;
    const out = run([command, id, ...rest, '--as', 'orch', '--json'], dirname(copy));
    expect(out.code, out.stderr).toBe(0);
    const cliDoc = oneJson(out) as { events: string[] };
    const viaCli = cliDoc.events.map((hash) => bodyOf(join(copy, 'events'), `${hash}.json`));

    expect(viaMcp).toHaveLength(2);
    expect(viaMcp).toEqual(viaCli);
    expect(eventNames(h.eventsDir)).toHaveLength(before.length + 2);
    expect(eventNames(join(copy, 'events'))).toHaveLength(before.length + 2);
  });

  it('board_close with unplanned', () => {
    const h = serve();
    const id = adhocIn(h, 'blocked');
    const copy = copyBoard(h.eventsDir);
    const doc = success(
      h.server.callTool('board_close', { id, 'no-decision': true, unplanned: 'abandoned', as: 'orch' }),
    );
    const viaMcp = (doc.events as string[]).map((hash) => bodyOf(h.eventsDir, `${hash}.json`));
    const out = run(
      ['close', id, '--no-decision', '--unplanned', 'abandoned', '--as', 'orch', '--json'],
      dirname(copy),
    );
    expect(out.code, out.stderr).toBe(0);
    const viaCli = (oneJson(out) as { events: string[] }).events.map((hash) =>
      bodyOf(join(copy, 'events'), `${hash}.json`),
    );
    expect(viaMcp).toEqual(viaCli);
    expect(viaMcp.map((e) => e.kind)).toEqual(['ticket.unplanned', 'ticket.close']);
  });
});

describe('scenario: disposition over MCP, through a spawned server', () => {
  it('lists the properties, refuses the first merge with a hint naming task and unplanned, then merges', async () => {
    const { root, boardDir } = project();
    const child = await mcpChild(root);
    const tools = (await child.client.listTools()).tools;
    for (const name of ['board_move', 'board_close']) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      const properties = Object.keys(
        (tool?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      );
      for (const property of ['task', 'change', 'group', 'unplanned']) {
        expect(properties, `${name}.${property}`).toContain(property);
      }
      expect((tool?.inputSchema as { required?: string[] }).required ?? []).not.toContain('unplanned');
    }

    const created = (await child.client.callTool({
      name: 'board_new',
      arguments: { title: 'Hotfix', adhoc: 'seen in production', as: 'orch' },
    })) as unknown as { structuredContent: { ticket: { id: string } } };
    const id = created.structuredContent.ticket.id;
    for (const status of ['tests', 'implementing', 'review']) {
      const moved = (await child.client.callTool({
        name: 'board_move',
        arguments: { id, status, as: 'impl' },
      })) as { isError?: boolean };
      expect(moved.isError).toBeFalsy();
    }
    const copy = copyBoard(join(boardDir, 'events'));

    const refused = (await child.client.callTool({
      name: 'board_move',
      arguments: { id, status: 'merged', as: 'orch' },
    })) as unknown as { isError?: boolean; structuredContent: Failure; content: { text: string }[] };
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ exitCode: 4, reason: 'needs-scope-disposition' });
    expect(refused.structuredContent.hint).toContain('"task"');
    expect(refused.structuredContent.hint).toContain('"unplanned"');
    expect(refused.content[0]?.text).toContain('\nhint: ');

    const merged = (await child.client.callTool({
      name: 'board_move',
      arguments: { id, status: 'merged', unplanned: 'hotfix', as: 'orch' },
    })) as unknown as { isError?: boolean; structuredContent: { events: string[]; ticket: Ticket } };
    expect(merged.isError).toBeFalsy();
    expect(merged.structuredContent.ticket).toMatchObject({
      status: 'merged',
      unplanned: { reason: 'hotfix', actor: 'orch' },
    });
    const viaMcp = merged.structuredContent.events.map((hash) =>
      bodyOf(join(boardDir, 'events'), `${hash}.json`),
    );

    const out = run(['move', id, 'merged', '--unplanned', 'hotfix', '--as', 'orch', '--json'], dirname(copy));
    expect(out.code, out.stderr).toBe(0);
    const viaCli = (oneJson(out) as { events: string[] }).events.map((hash) =>
      bodyOf(join(copy, 'events'), `${hash}.json`),
    );
    expect(viaMcp).toEqual(viaCli);
    expect(viaMcp.map((e) => e.kind)).toEqual(['ticket.unplanned', 'ticket.move']);
    await child.close();
  }, 30_000);
});
