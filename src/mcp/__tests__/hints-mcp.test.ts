/**
 * Error hints over MCP (board-agent-guidance: "Error hints"): a failed tool
 * call carries `hint` alongside `exitCode`, `reason` and `message`, also
 * as a `hint: ` line in its text content, and the hint is written for a
 * tool caller: tool calls instead of command lines, and the `as` argument
 * or `agentboard mcp --as <actor>` instead of `--as` and
 * `AGENTBOARD_ACTOR`. In process through `callTool`, plus one
 * scenario through a spawned server.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { cliEnv, project } from '../../cli/__tests__/cli-helpers.js';
import { renderHint } from '../../guidance/hints.js';
import { createMcpServer, type BoardMcpServer, type ToolCallResult } from '../server.js';
import { mcpChild } from './mcp-helpers.js';

const TASK = 'openspec:add-agent-guidance#2';

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

/** A server on a fresh board; `actor` is its `--as`; no AGENTBOARD_ACTOR unless given. */
function serve(actor?: string, env: Record<string, string | undefined> = {}): BoardMcpServer {
  const { root } = project();
  const server = createMcpServer({
    cwd: root,
    env: cliEnv(env),
    ...(actor === undefined ? {} : { actor }),
    stderr: () => undefined,
  });
  servers.push(server);
  return server;
}

function newId(server: BoardMcpServer, extra: Record<string, unknown> = { task: TASK }): string {
  const result = server.callTool('board_new', { title: 'A ticket', ...extra, as: 'orch' });
  expect(result.isError, JSON.stringify(result)).toBeUndefined();
  return (result.structuredContent.ticket as { id: string }).id;
}

/** The failure of a call, checking the text content carries the hint line. */
function failure(result: ToolCallResult): Failure {
  expect(result.isError, JSON.stringify(result)).toBe(true);
  const content = result.structuredContent as unknown as Failure;
  expect(typeof content.hint).toBe('string');
  expect(result.content).toEqual([
    { type: 'text', text: `${content.message}\nhint: ${content.hint ?? ''}` },
  ]);
  return content;
}

describe('scenario: claim race loser over MCP', () => {
  it('hints board_show and board_inbox tool calls for the caller', () => {
    const server = serve();
    const id = newId(server);
    expect(server.callTool('board_claim', { id, as: 'impl' }).isError).toBeUndefined();
    const err = failure(server.callTool('board_claim', { id, as: 'reviewer' }));
    expect(err).toMatchObject({ exitCode: 4, reason: 'already-assigned' });
    expect(err.message).toContain('impl');
    expect(err.hint).toContain(`board_show {"id":"${id}"}`);
    expect(err.hint).toContain('board_inbox {"as":"reviewer"}');
    expect(err.hint).toBe(
      renderHint('already-assigned', { surface: 'mcp', command: 'claim', id, actor: 'reviewer' }),
    );
  });

  it("takes the actor from the server's --as when the call has no as", () => {
    const server = serve('reviewer');
    const id = newId(server);
    expect(server.callTool('board_claim', { id, as: 'impl' }).isError).toBeUndefined();
    expect(failure(server.callTool('board_claim', { id })).hint).toContain(
      'board_inbox {"as":"reviewer"}',
    );
  });

  it("takes the actor from the server's AGENTBOARD_ACTOR last", () => {
    const server = serve(undefined, { AGENTBOARD_ACTOR: 'env-agent' });
    const id = newId(server);
    expect(server.callTool('board_claim', { id, as: 'impl' }).isError).toBeUndefined();
    expect(failure(server.callTool('board_claim', { id })).hint).toContain(
      'board_inbox {"as":"env-agent"}',
    );
  });
});

describe('scenario: missing actor over MCP', () => {
  it('hints the as argument and agentboard mcp --as, not AGENTBOARD_ACTOR', () => {
    const server = serve();
    const id = newId(server);
    const err = failure(server.callTool('board_comment', { id, text: 'hi' }));
    expect(err).toMatchObject({ exitCode: 1, reason: 'missing-actor' });
    expect(err.hint).toContain('as argument');
    expect(err.hint).toContain("'agentboard mcp --as <actor>'");
    expect(err.hint).not.toContain('AGENTBOARD_ACTOR');
  });
});

describe('scenario: needs-task-link over MCP', () => {
  it('hints a board_link tool call with a task reference', () => {
    const server = serve();
    const id = newId(server, { adhoc: 'found in CI' });
    expect(server.callTool('board_claim', { id, as: 'impl' }).isError).toBeUndefined();
    expect(
      server.callTool('board_move', { id, status: 'tests', as: 'impl' }).isError,
    ).toBeUndefined();
    const err = failure(server.callTool('board_move', { id, status: 'implementing', as: 'impl' }));
    expect(err).toMatchObject({ exitCode: 4, reason: 'needs-task-link' });
    expect(err.hint).toContain(
      `board_link {"id":"${id}","task":"<source>:<ref>#<item>","as":"impl"}`,
    );
  });
});

describe('scenario: the decision rule over MCP', () => {
  it('close with no disposition hints board_close with decision-recorded-in', () => {
    const server = serve();
    const id = newId(server);
    const err = failure(server.callTool('board_close', { id, as: 'orch' }));
    expect(err).toMatchObject({ exitCode: 1, reason: 'no-disposition' });
    expect(err.hint).toContain(
      `board_close {"id":"${id}","decision-recorded-in":"<path>","as":"orch"}`,
    );
    expect(err.hint).toContain(`board_close {"id":"${id}","no-decision":true,"as":"orch"}`);
  });
});

describe('usage errors over MCP', () => {
  it('an unknown argument names the tool and tools/list', () => {
    const server = serve();
    const err = failure(server.callTool('board_claim', { id: '01J9K3', bogus: 1, as: 'a' }));
    expect(err).toMatchObject({ exitCode: 1, reason: 'usage' });
    expect(err.hint).toContain('board_claim');
    expect(err.hint).toContain('tools/list');
  });

  it('an unknown or excluded tool names tools/list', () => {
    const server = serve();
    for (const name of ['board_nope', 'board_sync', 'board_help']) {
      const err = failure(server.callTool(name, {}));
      expect(err).toMatchObject({ exitCode: 1, reason: 'usage' });
      expect(err.hint, name).toContain('tools/list');
    }
  });
});

describe('through a spawned server', () => {
  it('scenario: the claim race loser gets the hint in the structured content and the text', async () => {
    const { root } = project();
    const child = await mcpChild(root);
    const created = (await child.client.callTool({
      name: 'board_new',
      arguments: { title: 'T', task: TASK, as: 'orch' },
    })) as unknown as { structuredContent: { ticket: { id: string } } };
    const id = created.structuredContent.ticket.id;
    await child.client.callTool({ name: 'board_claim', arguments: { id, as: 'impl' } });
    const refused = (await child.client.callTool({
      name: 'board_claim',
      arguments: { id, as: 'reviewer' },
    })) as unknown as {
      isError?: boolean;
      structuredContent: Failure;
      content: { text: string }[];
    };
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent.hint).toContain('board_inbox {"as":"reviewer"}');
    expect(refused.content[0]?.text).toContain('\nhint: ');
  }, 30_000);
});
